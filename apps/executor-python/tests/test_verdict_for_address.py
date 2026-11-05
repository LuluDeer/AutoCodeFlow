"""R82：`network_policy.verdict_for_address` —— 跨端一致性判据的**同形出口**。

## 为什么要这个函数（W1 的实测阻塞）

建「契约 `networkPolicy` 24 个示例 × 开关两态 × 三端」的一致性判据时，python 端
没有可用出口：

- `host_safety_verdict(host, resolver=None)`（`network_policy.py:245`）**没有开关入参**
  —— 开关语义住在 `routers/execute.py::_package_url_host_denied`，而那是 FastAPI 层，
  **裸 `python3` import 不了**（顶层 import fastapi/pydantic）；
- `host_denied_under_policy(...)`（`:381`）有开关入参，但只返回布尔（丢类别/理由），
  且对**主机名**会真解析 DNS（探针不该做网络 I/O）。

⇒ 新增纯函数 `verdict_for_address(addr, allow_private_network) -> dict`
（`network_policy.py`，零第三方依赖、不读 env/文件、**不做 DNS**）。

## 本文件钉住的三件事

1. **裸 `python3` 可跑**（真起子进程，不靠 pytest 环境）；
2. **与现有闸等价**：契约全部示例（25 个 `addresses.*.examples` + 2 个恒拒表成员）
   × 开关两态，与 `_package_url_host_denied` **逐条同结论**；
3. **语义正确**：恒拒表优先 → 回环专用名 → 分类 → 开关只放行 `privateIPv4`。
"""
import json
import pathlib
import subprocess
import sys

import pytest

from network_policy import verdict_for_address
from routers import execute as execute_module


APP_DIR = pathlib.Path(__file__).resolve().parents[1]


def _find_protocol() -> pathlib.Path:
    here = pathlib.Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / 'packages' / 'executor-protocol' / 'protocol.json'
        if candidate.exists():
            return candidate
    raise AssertionError('packages/executor-protocol/protocol.json not found')


PROTOCOL = json.loads(_find_protocol().read_text(encoding='utf-8'))
NETWORK_POLICY = PROTOCOL['networkPolicy']

#: 契约全部示例 + 恒拒表成员（地址清单**逐字读契约**，不写副本）。
CONTRACT_EXAMPLES = [
    example
    for body in NETWORK_POLICY['addresses'].values()
    for example in body.get('examples', [])
]
METADATA_MEMBERS = [
    str(entry).split('/')[0] for entry in NETWORK_POLICY['metadataAddresses']['addresses']
]
ALL_ADDRESSES = CONTRACT_EXAMPLES + METADATA_MEMBERS


# ---------------------------------------------------------------------------
# 判据 1：裸 python3 可跑（真子进程）
# ---------------------------------------------------------------------------


def test_runs_under_bare_python3():
    """`python3 -c "import network_policy as np; ..."` ⇒ exit 0 且输出正确。

    这是 W1 的**阻塞点本身**：探针只能用裸 `python3`（仓库守卫的零依赖纪律），
    fastapi/pydantic 一律不可 import。
    """
    code = (
        'import json, network_policy as np;'
        "print(json.dumps(np.verdict_for_address('169.254.169.254', True)))"
    )
    proc = subprocess.run(
        [sys.executable, '-c', code],
        cwd=str(APP_DIR), capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 0, (
        f'裸 python3 跑 verdict_for_address 失败（exit {proc.returncode}）：{proc.stderr[:400]}'
    )
    payload = json.loads(proc.stdout.strip().splitlines()[-1])
    assert payload['allowed'] is False
    assert payload['category'] == 'linkLocal'


def test_module_does_not_import_web_frameworks():
    """守卫：零依赖纪律 —— `network_policy` 不得 import fastapi/pydantic/httpx。"""
    code = (
        'import sys, network_policy;'
        "bad=[m for m in ('fastapi','pydantic','httpx','starlette') if m in sys.modules];"
        "print(','.join(bad))"
    )
    proc = subprocess.run(
        [sys.executable, '-c', code],
        cwd=str(APP_DIR), capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 0, proc.stderr[:400]
    assert proc.stdout.strip() == '', f'network_policy 间接引入了 Web 框架：{proc.stdout.strip()}'


# ---------------------------------------------------------------------------
# 判据 2：与现有闸等价（契约全部地址 × 两态）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('allow_private', [False, True], ids=['switch-off', 'switch-on'])
@pytest.mark.parametrize('addr', ALL_ADDRESSES, ids=lambda a: str(a))
def test_matches_gate_verdict(addr, allow_private, monkeypatch):
    """同形出口与**真实闸门**逐条同结论（`allowed` ⇔ `not denied`）。"""
    monkeypatch.setattr(execute_module.settings, 'allow_private_network', allow_private)
    # 闸门对回环专用名是名字判定（不做 DNS）；其它示例都是 IP 字面量 ⇒ 全程无 DNS。
    monkeypatch.setattr(
        execute_module.socket, 'getaddrinfo',
        lambda *a, **k: [(2, 1, 6, '', ('93.184.216.34', 0))],
    )

    gate_denied = execute_module._package_url_host_denied(addr)
    verdict = verdict_for_address(addr, allow_private)

    assert verdict['allowed'] is (not gate_denied), (
        f'{addr} @ allow_private={allow_private}: 同形出口 allowed={verdict["allowed"]} '
        f'但闸门 denied={gate_denied}（{verdict["reason"]}）'
    )


def test_example_count_is_contract_scale():
    """守卫：判据面没塌（契约示例 >= 20、恒拒表非空），否则上面的参数化会退化。"""
    assert len(CONTRACT_EXAMPLES) >= 20, f'契约示例只有 {len(CONTRACT_EXAMPLES)} 条'
    assert METADATA_MEMBERS, '恒拒表为空 —— 判据被关灯'
    assert len(ALL_ADDRESSES) >= 10


# ---------------------------------------------------------------------------
# 判据 3：语义正确（逐类真值表）
# ---------------------------------------------------------------------------


def test_metadata_members_always_denied():
    """恒拒表：任何开关都拒，且标 metadata=True（ADR-029 先于一切分类）。"""
    for host in METADATA_MEMBERS:
        for allow in (False, True):
            v = verdict_for_address(host, allow)
            assert v['allowed'] is False
            assert v['metadata'] is True
            assert v['reason'] == 'metadata-table'
            assert v['category'] == 'reserved'


@pytest.mark.parametrize('form', ['localhost', 'foo.localhost', 'LOCALHOST',
                                  'localhost.', 'localhost.localdomain',
                                  'foo.localhost.'])
def test_localhost_family_denied_by_name_only(form):
    """回环专用名（含**尾点**）：名字判定即拒，与 DNS 无关（ADR-036 口径）。"""
    for allow in (False, True):
        v = verdict_for_address(form, allow)
        assert v['allowed'] is False, f'{form} 被放行'
        assert v['category'] == 'loopback'
        assert v['reason'] == 'loopback-name'


def test_private_ipv4_is_the_only_switch_unlocked_class():
    """开关的**唯一**效果：放行 `privateIPv4`。"""
    assert verdict_for_address('10.0.0.1', False)['allowed'] is False
    assert verdict_for_address('10.0.0.1', True)['allowed'] is True
    for host in ['127.0.0.1', '169.254.169.254', '100.64.0.1',
                 '0.0.0.0', '224.0.0.1', '240.0.0.1']:
        assert verdict_for_address(host, True)['allowed'] is False, (
            f'{host} 在开关开启时被放行 —— 开关越权'
        )


def test_public_address_allowed_in_both_states():
    assert verdict_for_address('1.1.1.1', False)['allowed'] is True
    assert verdict_for_address('1.1.1.1', True)['allowed'] is True


def test_unresolvable_hostname_is_fail_closed():
    """不认识的**主机名**：本函数不做 DNS ⇒ fail-closed（探针口径，不猜）。"""
    v = verdict_for_address('evil.example.com', True)
    assert v['allowed'] is False
    assert v['reason'] == 'dns-required'


def test_return_shape_is_stable():
    """返回键稳定（跨端比对靠它）。"""
    v = verdict_for_address('10.0.0.1', True)
    assert set(v) == {'allowed', 'category', 'metadata', 'reason'}
    assert isinstance(v['allowed'], bool)
    assert isinstance(v['metadata'], bool)
    assert isinstance(v['reason'], str)
