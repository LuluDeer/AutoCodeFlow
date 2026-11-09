"""R59-W4：契约 `networkPolicy.metadataAddresses` 的「三端同读」在 **python 侧**钉死。

## 为什么需要这一份（而不是继续靠 `test_ssrf_guard.py` 的间接覆盖）

契约 `packages/executor-protocol/protocol.json` 的 `networkPolicy.metadataAddresses`
声明了**元数据恒拒表**（当前成员：阿里云 ECS `100.100.100.200/32`、Oracle Cloud
`192.0.0.192/32`），语义三条（契约 `$comment` + `enforcement`）：

1. 列出的地址在**任何 posture**（executor / webhook / git）× **任何开关状态**下都 DENY；
2. 判定必须在**风险分类之前**（`enforcement: deny-before-classification`）；
3. 其余 `addresses` 各类的语义**不变**（`privateIPv4` 仍受开关控制）。

admin / node 侧各有守卫（`ssrf-deny-matrix.spec.ts` / `ssrf-deny-parity.spec.ts`），
python 侧此前只有 `test_ssrf_guard.py::test_metadata_addresses_are_always_denied`
一条**间接**覆盖。它有两个缺口：

* 地址清单是**硬编码副本** ⇒ 契约加地址时它会悄悄落后（下一个漂移源）；
* 只打 `category_allowed(host_is_restricted_with_category(...))` 这两个纯函数，
  **不打**真实出站闸（packageUrl 首跳、逐跳重定向复检、gitRepo 地址闸）——
  而 R07 的缺陷正是「闸门按 posture 分组时元数据落进了可解锁的那组」。

⇒ 本文件把这两点补上：**地址清单逐字读契约**，断言落在**真实闸门**上。

## 一条设计红线：数据源必须是契约，不是副本

本文件**不出现任何元数据地址字面量**（含 IPv6 形态）。地址表在 import 期从
`protocol.json` 读出后参数化展开；`generated/protocol_metadata_addresses.py`
是**实现侧**的读取方，本文件是**第二条独立读法**——两者不一致即漂移，由
`test_test_data_source_matches_impl_table` 逐名点名。

## posture → python 落点（如实映射，不造抽象）

| 契约 posture | python 落点 | 备注 |
| --- | --- | --- |
| `webhook` | `classify_restricted_address` + `category_allowed` | python 侧**没有** webhook 出站面；这一行钉的是**共享的契约判定层**——admin 的 `assertSafeHttpUrl`（webhook 姿态）用的是同一套「类别 + 开关」判定，R07 缺陷正落在这里 |
| `executor` | `_assert_safe_package_url`（packageUrl 首跳闸，accept 期 400） | 开关只放行 `privateIPv4`；loopback 不随开关放行 |
| `executor`（逐跳） | `_package_url_host_denied`（重定向复检判据，Round6-P2-B） | 与首跳闸同源；该函数是唯一判据 |
| `git` | `_validate_git_repo_task`（gitRepo 地址闸） | 与 packageUrl 共用同一判据（Round6-P3-1） |

开关两态用 `settings.allow_private_network`（契约 `networkPolicy.switch.envVar`
`EXECUTOR_ALLOW_PRIVATE_NETWORK` 在 python 侧的唯一读点）钉住，**不打桩判定函数**
——否则测的是桩，不是闸。
"""
import ipaddress
import json
import pathlib

import pytest
from fastapi import HTTPException

from network_policy import (
    METADATA_ADDRESSES as IMPL_METADATA_ADDRESSES,
    category_allowed,
    classify_restricted_address,
    classify_restricted_ipv4,
    classify_restricted_ipv6,
    host_safety_verdict,
    is_metadata_address,
)
from routers import execute as execute_module
from routers.execute import (
    _assert_safe_package_url,
    _package_url_host_denied,
    _validate_git_repo_task,
)


# ---------------------------------------------------------------------------
# 契约读取（唯一数据源）
# ---------------------------------------------------------------------------


def _find_protocol() -> pathlib.Path:
    """向上找仓库根里的契约文件（硬编码 `../×N` 会随文件位置 silent 漂移）。"""
    here = pathlib.Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / 'packages' / 'executor-protocol' / 'protocol.json'
        if candidate.exists():
            return candidate
    raise AssertionError('packages/executor-protocol/protocol.json not found')


PROTOCOL_PATH = _find_protocol()
PROTOCOL = json.loads(PROTOCOL_PATH.read_text(encoding='utf-8'))
METADATA_SECTION = PROTOCOL['networkPolicy']['metadataAddresses']

#: 契约里**逐字**的地址条目（含 `/32` 之类的前缀）。
CONTRACT_METADATA_CIDRS = tuple(str(entry).strip() for entry in METADATA_SECTION['addresses'])
#: 去掉前缀后的主机字面量（闸门吃的是 host，不是 CIDR）。
CONTRACT_METADATA_HOSTS = tuple(cidr.split('/')[0].strip() for cidr in CONTRACT_METADATA_CIDRS)

#: 对照组：一个**明确应放行**的公网地址（钉住「闸不能收成一律拒绝」的假绿）。
PUBLIC_CONTROL = '1.1.1.1'

#: 开关两态（契约 `networkPolicy.switch.semantics`：唯一效果是放行 privateIPv4）。
SWITCH_STATES = (False, True)


def _url_for(host: str, path: str = '/pkg.zip') -> str:
    """把主机字面量拼成 URL（IPv6 字面量必须加方括号，否则 urlsplit 解不出 hostname）。"""
    bracketed = f'[{host}]' if ':' in host else host
    return f'http://{bracketed}{path}'


# ---------------------------------------------------------------------------
# 真实闸门适配器：`(host, allow_private) -> 是否放行`
#
# 刻意**不**复用被测函数之外的任何自造判据：每个 posture 都打到 python 真实
# 出站路径上（见模块 docstring 的映射表）。
# ---------------------------------------------------------------------------


def _set_switch(monkeypatch, allow_private: bool) -> None:
    """钉住开关（`settings.allow_private_network` 是 python 侧唯一读点）。"""
    monkeypatch.setattr(
        execute_module.settings, 'allow_private_network', allow_private, raising=False
    )


def _webhook_allows(host: str, allow_private: bool) -> bool:
    """webhook 姿态 = 契约判定层：类别 → 开关（public 放行，其余只有 privateIPv4 随开关）。"""
    return category_allowed(
        classify_restricted_address(host), allow_private=allow_private
    )


def _package_url_allows(host: str, allow_private: bool) -> bool:
    """executor 姿态（首跳）：packageUrl 闸——拒绝即抛 HTTPException(400)。"""
    try:
        _assert_safe_package_url(_url_for(host))
    except HTTPException as exc:
        assert exc.status_code == 400, f'packageUrl 闸应给 400，实际 {exc.status_code}'
        return False
    return True


def _redirect_recheck_allows(host: str, allow_private: bool) -> bool:
    """executor 姿态（逐跳）：重定向复检判据——`True` 表示该跳被拒。"""
    return not _package_url_host_denied(host)


def _git_repo_allows(host: str, allow_private: bool) -> bool:
    """git 姿态：gitRepo 地址闸——拒绝即抛 HTTPException(400)。"""
    task = {
        'gitRepo': _url_for(host, '/repo.git'),
        'gitCommit': 'main',
        'gitBranch': 'main',
    }
    try:
        _validate_git_repo_task(task)
    except HTTPException as exc:
        assert exc.status_code == 400, f'gitRepo 闸应给 400，实际 {exc.status_code}'
        return False
    return True


#: 四条真实出站判定路径（posture 维度）。
SURFACES = {
    'webhook': _webhook_allows,
    'executor-packageUrl': _package_url_allows,
    'executor-redirect': _redirect_recheck_allows,
    'git': _git_repo_allows,
}

SURFACE_IDS = tuple(SURFACES)


# ---------------------------------------------------------------------------
# 数据源守卫
# ---------------------------------------------------------------------------


def test_contract_metadata_section_is_wellformed():
    """契约段自身形状：非空 + 条目不重复 + 形制合法 + enforcement 就是「先于分类」。

    空表 = 判据被关灯（ADR-029 §2）：地址表一旦被删空，下面所有参数化用例都会
    「零例通过」——那是最危险的假绿，故单列一条守卫。本断言读的是**线上那份文件**。
    """
    assert CONTRACT_METADATA_CIDRS, (
        f'{PROTOCOL_PATH} 的 networkPolicy.metadataAddresses.addresses 为空 —— 空表 = 判据被关灯'
    )
    assert len(set(CONTRACT_METADATA_CIDRS)) == len(CONTRACT_METADATA_CIDRS), (
        f'metadataAddresses 有重复条目：{CONTRACT_METADATA_CIDRS}'
    )
    for cidr in CONTRACT_METADATA_CIDRS:
        ipaddress.ip_network(cidr, strict=False)  # 非法字面量直接抛
    assert METADATA_SECTION['enforcement'] == 'deny-before-classification', (
        'metadataAddresses.enforcement = '
        f'{METADATA_SECTION["enforcement"]!r} —— 必须是 deny-before-classification'
        '（判定先于风险分类，否则开关仍能把它放行；见契约 $comment ②）'
    )


def test_test_data_source_matches_impl_table():
    """第二条独立读法 vs 实现侧读取方：两者不一致即漂移（本文件的「数据源」判据）。

    本文件逐字读 `protocol.json`；实现读生成物 `generated/protocol_metadata_addresses.py`
    （`scripts/generate-executor-protocol.mjs` 产出）。生成物**不参与本文件的参数化**
    ——它只在这里被对账。⇒ 生成器漂移 / 有人手改生成物 / 契约加地址忘了重新生成，
    三种情况都红在这里。
    """
    contract_hosts = {cidr.split('/')[0].strip() for cidr in CONTRACT_METADATA_CIDRS}
    impl_hosts = {str(entry).split('/')[0].strip() for entry in IMPL_METADATA_ADDRESSES}
    assert impl_hosts == contract_hosts, (
        '实现侧恒拒表与契约不一致：'
        f'契约独有 {sorted(contract_hosts - impl_hosts)}；实现独有 {sorted(impl_hosts - contract_hosts)}'
        '（生成物可能过期——重跑 scripts/generate-executor-protocol.mjs）'
    )


# ---------------------------------------------------------------------------
# 主判据：每一个契约地址 × 每个姿态 × 开关两态 ⇒ 全 DENY
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('surface', SURFACE_IDS)
@pytest.mark.parametrize('allow_private', SWITCH_STATES, ids=['switch-off', 'switch-on'])
@pytest.mark.parametrize('host', CONTRACT_METADATA_HOSTS)
def test_every_contract_address_is_denied_everywhere(host, allow_private, surface, monkeypatch):
    """ADR-029 主判据：元数据地址在**任何 posture** × **任何开关状态**下都 DENY。

    参数化维度全部来自契约（地址逐字读 `protocol.json`）⇒ 契约加一个地址，
    这里自动多出 `len(SURFACES)`×2 条用例，不需要改测试。
    """
    _set_switch(monkeypatch, allow_private)
    assert SURFACES[surface](host, allow_private) is False, (
        f'{host} 在 posture={surface} / allow_private={allow_private} 下被**放行**了 —— '
        '违反契约 networkPolicy.metadataAddresses（任何 posture × 任何开关都 DENY）'
    )


# ---------------------------------------------------------------------------
# 正向对照：闸没有收成「一律拒绝」
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('surface', SURFACE_IDS)
@pytest.mark.parametrize('allow_private', SWITCH_STATES, ids=['switch-off', 'switch-on'])
def test_public_control_is_allowed_everywhere(allow_private, surface, monkeypatch):
    """对照组：公网地址 `1.1.1.1` 在四条判定路径 × 两态下都应**放行**。

    没有这一条，把闸改成一律 deny 也能让上面全绿——那是假绿（一切外网下载失效）。
    """
    _set_switch(monkeypatch, allow_private)
    assert SURFACES[surface](PUBLIC_CONTROL, allow_private) is True, (
        f'{PUBLIC_CONTROL} 在 posture={surface} / allow_private={allow_private} 下被判拒 —— '
        '闸被收成「一律拒绝」了'
    )


# ---------------------------------------------------------------------------
# 判定顺序：先元数据、后风险分类（`enforcement: deny-before-classification`）
# ---------------------------------------------------------------------------


def _risk_classification(host: str):
    """**纯风险分类**（不含元数据前置判定）给出的类别。"""
    return classify_restricted_ipv6(host) if ':' in host else classify_restricted_ipv4(host)


@pytest.mark.parametrize('host', CONTRACT_METADATA_HOSTS)
def test_metadata_deny_precedes_risk_classification(host):
    """「先元数据、后分类」的机器判据：类别标签只能来自前置判定。

    `classify_restricted_ipv4/ipv6`（纯风险分类）**从不产出** `reserved`——
    它给出的可能是 `cgnat`（阿里云 `100.100.100.200` 落在 100.64/10）或
    `None`（Oracle `192.0.0.192` 在分类表里是「公网」）。而统一入口
    `classify_restricted_address` 对同一地址给出 `reserved`
    ⇒ 这个标签**只可能**来自元数据前置判定。若把前置判定短路，本断言立刻红。
    """
    raw = _risk_classification(host)
    assert raw != 'reserved', (
        f'{host} 的风险分类本身就是 reserved —— 该地址不再能证明「前置判定」生效，'
        '契约扩展规则②要求收录的是分类层看不见的元数据端点，请复核 ADR-029'
    )
    assert is_metadata_address(host) is True, f'{host} 不在恒拒表里（生成物与契约不一致？）'
    assert classify_restricted_address(host) == 'reserved', (
        f'{host} 统一分类 = {classify_restricted_address(host)!r}，应为 "reserved"'
        '（reserved 在任何开关状态都拒；落到 privateIPv4 就意味着开关能解锁元数据）'
    )
    # 恒拒类的开关无关性（R07 的裁决点）：两态都必须拒。
    for allow_private in SWITCH_STATES:
        assert category_allowed(classify_restricted_address(host), allow_private=allow_private) is False, (
            f'{host} 在 allow_private={allow_private} 下可放行 —— 开关解锁了元数据地址'
        )


@pytest.mark.parametrize('host', CONTRACT_METADATA_HOSTS)
def test_metadata_denied_when_classification_alone_would_allow(host, monkeypatch):
    """顺序判据的**非空转**证明：分类层会放行的地址，必须由前置判定拦住。

    例：`192.0.0.192` 在风险分类里是 `None`（= 公网）⇒ 只看分类、开关开启时
    **本应放行**。实际所有真实出站闸都必须拒 —— 这就是「判定先于风险分类」。
    （分类层本就判拒的地址在本用例里自动跳过，不是漏测：它们已由主判据覆盖。）
    """
    raw = _risk_classification(host)
    if not category_allowed(raw, allow_private=True):
        pytest.skip(f'{host} 的分类结果 {raw!r} 在开关开启时本就判拒 —— 由主判据覆盖')
    for allow_private in SWITCH_STATES:
        _set_switch(monkeypatch, allow_private)
        for name, surface in SURFACES.items():
            assert surface(host, allow_private) is False, (
                f'{host} 分类层判为 {raw!r}（开关开启时会放行），但 posture={name} 也没拦住 —— '
                '元数据前置判定没有生效'
            )


# ---------------------------------------------------------------------------
# 解析路径：主机名解析到恒拒表成员 ⇒ 一样命中（契约 resolution.mode = dns-resolve）
# ---------------------------------------------------------------------------


def test_metadata_hit_survives_dns_resolution():
    """主机名**解析结果**命中恒拒表 ⇒ 同样恒拒（否则开关仍能从域名绕过去）。

    注入解析器 ⇒ 不碰网络；解析答案取自契约，测试里没有地址字面量。
    """
    host = CONTRACT_METADATA_HOSTS[0]
    restricted, category, metadata_hit = host_safety_verdict(
        'metadata.example', resolver=lambda _name: [host]
    )
    assert restricted is True, '解析到恒拒表成员应判受限'
    assert metadata_hit is True, '解析结果命中恒拒表却没被标出来 ⇒ 闸门会按开关放行'
    assert category == 'reserved', '恒拒表成员必须归 reserved（任何开关都拒）'


def test_metadata_hit_not_masked_by_public_answer():
    """多答案（公网 + 恒拒表）⇒ 仍算命中：任一答案落在恒拒表就不放行（fail-closed）。"""
    host = CONTRACT_METADATA_HOSTS[0]
    restricted, _category, metadata_hit = host_safety_verdict(
        'mixed.example', resolver=lambda _name: [PUBLIC_CONTROL, host]
    )
    assert restricted is True
    assert metadata_hit is True, '同一名字既有公网又有恒拒表答案时，命中标记不能被公网答案盖掉'


def test_at_least_one_contract_address_is_invisible_to_risk_classification():
    """判据未失活的守卫：契约里必须至少有一个地址是**分类层看不见**的。

    ADR-029 §2 扩展规则②就是为了收录这类端点（`192.0.0.192` 修前被判 public ⇒
    四姿态全放行）。若某天契约只剩分类层本就能拦的地址，「前置判定」就再没有被
    测到的面 —— 本断言红，提示复核契约成员，而不是悄悄退化成空转。
    """
    invisible = [
        host for host in CONTRACT_METADATA_HOSTS
        if category_allowed(_risk_classification(host), allow_private=True)
    ]
    assert invisible, (
        '契约 metadataAddresses 里的每个地址都被风险分类判拒 —— '
        '元数据前置判定（deny-before-classification）已无可测面，请复核 ADR-029 扩展规则'
    )
