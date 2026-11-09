"""R67（ADR-032 Step 5）：回收灰度阀 `PY_EXECUTOR_SWITCH_POSTURE_STRICT`。

## 处置判断：**回收，不保留回滚开关**

ADR-032 决策 4 给的到期条件是「逃生阀必须回收」。本轮判定**不**把它改名成永久回滚开关，
理由三条：

1. **三端已同口径**（R63 把 python、R66 把 node 下载面与 admin webhook 面都收紧到契约口径）
   ⇒ 契约里不再存在「第二种可解释」，留一个运行时可切换的第二姿态等于把
   「三端两种承诺」重新装回去 —— 那正是 ADR-032 要消掉的成因。
2. **回滚手段仍然在**，且更可靠：`git revert` / 回退镜像。运行期开关不是唯一退路，
   而它会让「当前姿态」变成随部署而异的隐藏状态。
3. **没人测的姿态就是死代码**：本文件签署后，没有任何用例再断言旧宽松姿态；
   留着它 = 一条永不执行的灰色分支，且会持续误导下一个读者。

## 本文件的判据（把「回收」钉死，而不是只删代码）

1. 代码**不再消费**该键（源码扫描命中数 = 0；测试目录自身不计）；
2. `Settings` 不再声明该字段（pydantic 字段表是 env 键的事实来源，见
   `scripts/check-env-drift.mjs` 怎么读它）；
3. **回收后默认姿态 = 收紧后的新姿态**（开关开启只放行 `privateIPv4`）——
   这条最重要：回收一旦把默认分支写错，用户会被静默打回旧行为；
4. 恒拒表（ADR-029）仍然**先于**开关。
"""
import ipaddress
import json
import pathlib

import pytest

from config import Settings
from network_policy import category_allowed, classify_restricted_address
from routers import execute as execute_module
from routers.execute import _package_url_host_denied


#: 已回收的键（字符串只出现在本文件里；扫描时排除 tests/）。
RETIRED_ENV_KEY = 'PY_EXECUTOR_SWITCH_POSTURE_STRICT'
RETIRED_SETTING = 'py_executor_switch_posture_strict'

APP_DIR = pathlib.Path(__file__).resolve().parents[1]
SCAN_EXCLUDE_PARTS = {'.venv', '__pycache__', 'tests'}

#: 契约里「任何开关状态都拒」的六类（`allowedUnderPrivateNetwork=false`）。
ALWAYS_DENY_CLASSES = (
    'loopback',
    'linkLocal',
    'cgnat',
    'unspecified',
    'multicast',
    'reserved',
)


def _find_protocol() -> pathlib.Path:
    here = pathlib.Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / 'packages' / 'executor-protocol' / 'protocol.json'
        if candidate.exists():
            return candidate
    raise AssertionError('packages/executor-protocol/protocol.json not found')


PROTOCOL = json.loads(_find_protocol().read_text(encoding='utf-8'))
ADDRESS_CLASSES = PROTOCOL['networkPolicy']['addresses']


def _source_files():
    for path in sorted(APP_DIR.rglob('*.py')):
        if any(part in SCAN_EXCLUDE_PARTS for part in path.relative_to(APP_DIR).parts):
            continue
        yield path


# ---------------------------------------------------------------------------
# 判据 1/2：代码不再消费该键
# ---------------------------------------------------------------------------


def test_flag_is_not_consumed_by_application_code():
    """回收判据：应用源码里该键/该字段的命中数必须是 0。

    红→绿锚点：回收前 `config.py` 与 `routers/execute.py` 各有两处命中（键名 + 字段名），
    本断言给出逐条 `文件:行号`，回收后清零。
    """
    hits = []
    for path in _source_files():
        for lineno, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
            if RETIRED_ENV_KEY in line or RETIRED_SETTING in line:
                hits.append(f'{path.relative_to(APP_DIR.parent)}:{lineno}: {line.strip()}')
    assert hits == [], (
        f'灰度阀 {RETIRED_ENV_KEY} 应已回收，但代码仍在消费它：\n  ' + '\n  '.join(hits)
    )


def test_settings_no_longer_declares_the_flag():
    """pydantic 字段表是 env 键的事实来源（`scripts/check-env-drift.mjs` 读它）——
    字段还在，键就还在被「消费」。"""
    assert RETIRED_SETTING not in Settings.model_fields, (
        f'Settings 仍声明 {RETIRED_SETTING} —— 回收不彻底（它是 .env 键的事实来源）'
    )


# ---------------------------------------------------------------------------
# 判据 3：回收后的默认姿态 = 收紧后的新姿态（不是旧姿态）
# ---------------------------------------------------------------------------


def _contract_examples(class_name: str):
    return ADDRESS_CLASSES[class_name]['examples']


@pytest.mark.parametrize('class_name', ALWAYS_DENY_CLASSES)
def test_default_posture_denies_always_deny_classes_under_switch_on(
        class_name, monkeypatch):
    """**默认**（不设任何灰度阀、开关开启）⇒ 六类仍全拒。

    这是「回收不许把用户打回旧行为」的机器判据：旧姿态在开关开启时会放行
    linkLocal/cgnat/unspecified/multicast/reserved —— 这里逐类钉住拒绝。
    期望值来自契约字段本身（`allowedUnderPrivateNetwork=false`），不写死地址。
    """
    assert ADDRESS_CLASSES[class_name]['allowedUnderPrivateNetwork'] is False, (
        f'契约 {class_name}.allowedUnderPrivateNetwork 变了 —— 本用例的期望值需要重算'
    )
    monkeypatch.setattr(execute_module.settings, 'allow_private_network', True)
    for example in _contract_examples(class_name):
        if '%' in example:      # IPv6 zone id（契约没有，防御性跳过）
            continue
        assert _package_url_host_denied(example) is True, (
            f'{class_name} 的契约示例 {example} 在开关开启时被放行了 —— 默认姿态退回旧行为'
        )


def test_default_posture_allows_private_ipv4_under_switch_on(monkeypatch):
    """正向对照：`privateIPv4`（契约唯一 `allowedUnderPrivateNetwork=true` 的类）
    在开关开启时**必须放行** —— 否则回收顺手把闸收成了「一律拒绝」。"""
    assert ADDRESS_CLASSES['privateIPv4']['allowedUnderPrivateNetwork'] is True
    monkeypatch.setattr(execute_module.settings, 'allow_private_network', True)
    for example in _contract_examples('privateIPv4'):
        assert _package_url_host_denied(example) is False, (
            f'privateIPv4 的契约示例 {example} 在开关开启时被判拒 —— 闸被收过头了'
        )


def test_default_posture_denies_everything_under_switch_off(monkeypatch):
    """开关关闭（默认部署）：除公网外全拒。旧新姿态在这一档一致，回收不应改变它。

    `ipv4Mapped` 类**不参与**本断言：契约对它的规则是「完全按内嵌 IPv4 判定」，
    所以 `::ffff:8.8.8.8`（内嵌公网）在这一档**应当放行**。该类的语义由
    `tests/test_network_policy_ipv4_mapped.py` 单独钉住。
    """
    monkeypatch.setattr(execute_module.settings, 'allow_private_network', False)
    for class_name, body in ADDRESS_CLASSES.items():
        if class_name == 'ipv4Mapped':
            continue
        for example in body['examples']:
            if '%' in example:
                continue
            try:
                ipaddress.ip_address(example.split('/')[0])
            except ValueError:
                continue        # 主机名形态（localhost / foo.localhost）同样全拒
            assert _package_url_host_denied(example) is True, (
                f'{class_name} 的示例 {example} 在开关关闭时被放行'
            )


# ---------------------------------------------------------------------------
# 判据 4：恒拒表仍先于开关（回收不许顺带改掉 ADR-029）
# ---------------------------------------------------------------------------


def test_metadata_table_still_wins_over_switch(monkeypatch):
    """契约恒拒表的成员在开关开启时仍拒 —— 回收只删灰度阀，不动 ADR-029 的优先级。"""
    metadata = PROTOCOL['networkPolicy']['metadataAddresses']['addresses']
    assert metadata, '契约恒拒表为空 —— 判据被关灯'
    monkeypatch.setattr(execute_module.settings, 'allow_private_network', True)
    for entry in metadata:
        host = str(entry).split('/')[0]
        assert classify_restricted_address(host) == 'reserved'
        assert category_allowed(classify_restricted_address(host), True) is False
        assert _package_url_host_denied(host) is True, (
            f'恒拒表成员 {host} 在开关开启时被放行 —— 判定顺序被回收改坏了'
        )
