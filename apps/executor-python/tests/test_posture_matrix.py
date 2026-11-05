# posture-addresses: 25
"""R68：python 端的**姿态矩阵表驱动 spec**（`networkPolicy` 逐类 × 开关两态）。

// posture-addresses: 25
（上面这行是给机器守卫 `scripts/check-posture-matrix-tables.mjs` 读的计数标记：
它的正则只认 C 系的 `//` 注释形式；python 的注释是 `#`，故首行给人类读的
`# posture-addresses: 25`、docstring 内给守卫读的 `// posture-addresses: 25`，
两处同数，契约变了要一起改。）

## 为什么有这一份

契约 `packages/executor-protocol/protocol.json` 的 `networkPolicy` 声明了
七类受限地址（各带 `examples` 与 `allowedUnderPrivateNetwork`）外加一段
`metadataAddresses` 恒拒表。三端闸层**调用形态不同**（admin 走 `policy`/env、
node 走 `categoryAllowed(...)`、python 走 `host_safety_verdict(...)`），
所以「真跑」必须发生在**各端自己的 runner** 里；仓内元守卫
`scripts/check-posture-matrix-tables.mjs` 只保证「三端各有一张同源同量的表」
（本文件首行的 `posture-addresses: 25` 就是它读条数的机器可读标记）。

## 本文件的纪律

- **地址清单逐字从契约读**（`networkPolicy.addresses.*.examples` +
  `metadataAddresses.addresses`），文件里**不出现任何地址字面量**——
  硬编码副本就是下一个漂移源（元守卫也会逐行抓）。
- 断言打的是**真实闸层**：`host_safety_verdict`（判定层）+
  `_package_url_host_denied`（出站闸，与 packageUrl 首跳 / 逐跳重定向复检 /
  gitRepo 地址闸**同源**）。
- 期望值来自契约字段本身（`allowedUnderPrivateNetwork`），不写死「哪类该放行」。
"""
import ipaddress
import json
import pathlib

import pytest

from network_policy import category_allowed, host_safety_verdict
from routers import execute as execute_module
from routers.execute import _package_url_host_denied


def _find_protocol() -> pathlib.Path:
    """向上找契约文件（硬编码 `../×N` 会随文件位置 silent 漂移）。"""
    here = pathlib.Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / 'packages' / 'executor-protocol' / 'protocol.json'
        if candidate.exists():
            return candidate
    raise AssertionError('packages/executor-protocol/protocol.json not found')


PROTOCOL_PATH = _find_protocol()
PROTOCOL = json.loads(PROTOCOL_PATH.read_text(encoding='utf-8'))
NETWORK_POLICY = PROTOCOL['networkPolicy']

#: 契约七类：类别名 → (示例地址表, allowedUnderPrivateNetwork)
CONTRACT_CLASSES = {
    name: (list(body.get('examples', [])), bool(body.get('allowedUnderPrivateNetwork')))
    for name, body in NETWORK_POLICY['addresses'].items()
}

#: 契约恒拒表（任何 posture × 任何开关都 DENY，判定先于风险分类）。
CONTRACT_METADATA = [str(e) for e in NETWORK_POLICY['metadataAddresses']['addresses']]

#: 断言条数与契约实测一致（守卫也按这个数比对三端）。
EXAMPLE_COUNT = sum(len(v[0]) for v in CONTRACT_CLASSES.values())

#: 契约示例 → 契约类别（用于解析 ipv4Mapped 的内嵌 IPv4 落在哪一类）。
EXAMPLE_TO_CLASS = {
    example: class_name
    for class_name, (examples, _) in CONTRACT_CLASSES.items()
    if class_name != 'ipv4Mapped'
    for example in examples
}


def _is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host.split('/')[0])
    except ValueError:
        return False
    return True


def _inner_ipv4(mapped: str) -> str:
    """映射形态的内嵌 IPv4 字面量（契约 ipv4Mapped 的规则）。"""
    try:
        return str(ipaddress.IPv6Address(mapped).ipv4_mapped)
    except (ValueError, ipaddress.AddressValueError):
        return ''


def _expected(class_name: str, example: str):
    """该示例**应当**得到的 (类别, 开关下是否放行) —— 全部由契约推导。

    `ipv4Mapped` 例外：契约写「**完全按内嵌 IPv4 判定**」⇒ 它的示例的期望类别
    是**内嵌 IPv4 所属的类**（映射形态的内嵌私网 ⇒ `privateIPv4`，故开关开启时放行），
    而不是 `ipv4Mapped` 这个标签本身。内嵌 IPv4 不在任何类的 examples 里 ⇒ 公网。
    """
    if class_name == 'ipv4Mapped':
        inner = _inner_ipv4(example)
        inner_class = EXAMPLE_TO_CLASS.get(inner)
        if inner_class is None:
            return None, False          # 内嵌公网 ⇒ 不受限
        return inner_class, CONTRACT_CLASSES[inner_class][1]
    return class_name, CONTRACT_CLASSES[class_name][1]


# 参数化表：契约里的每个示例地址 × 契约类别。
# （metadataAddresses 的成员单列 —— 它们不是某个类别的 example，而是恒拒表。）
PARAM_CASES = [
    (class_name, example)
    for class_name, (examples, _) in CONTRACT_CLASSES.items()
    for example in examples
]


def test_case_count_matches_contract():
    """守卫：条数与契约实测一致（否则下面的参数化是「少跑了几条」）。"""
    assert EXAMPLE_COUNT == 25, (
        f'契约 networkPolicy.addresses.*.examples 实测 {EXAMPLE_COUNT} 条，'
        '与首行声明的 posture-addresses 不符 —— 契约变了要同步声明与本用例'
    )


@pytest.mark.parametrize('allow_private', [False, True], ids=['switch-off', 'switch-on'])
@pytest.mark.parametrize('class_name,example', PARAM_CASES)
def test_contract_example_classification(
        class_name, example, allow_private, monkeypatch):
    """每个契约示例：类别标签必须与契约一致，且放行与否由契约字段决定。"""
    expected_category, allowed_under_switch = _expected(class_name, example)
    restricted, category, metadata_hit = host_safety_verdict(example)

    # 恒拒表优先于一切分类（ADR-029 / enforcement=deny-before-classification）。
    assert metadata_hit is False, (
        f'{example} 命中了契约恒拒表 —— 它不该同时出现在类别的 examples 里'
    )
    # 类别标签必须与契约推导的一致（ipv4Mapped 按内嵌 IPv4 判）。
    assert category == expected_category, (
        f'{example} 属于契约类 {class_name}，分类结果却是 {category!r}'
        f'（期望 {expected_category!r}）'
    )
    # `None` = 不受限（公网）；其余必须是契约里登记过的类别名。
    assert category is None or category in CONTRACT_CLASSES, (
        f'{example} 的类别 {category!r} 不在契约 networkPolicy.addresses 的类名集合里'
    )
    # 放行与否：**只**由契约的 allowedUnderPrivateNetwork 决定（开关只解锁 privateIPv4）。
    expected_allowed = (
        True if category is None else (allowed_under_switch if allow_private else False)
    )
    assert category_allowed(category, allow_private) is expected_allowed, (
        f'{example}（类别 {category!r}）在 allow_private={allow_private} 时的放行结论'
        '与契约 allowedUnderPrivateNetwork 不符'
    )
    # 真实闸层与判定层必须同结论（闸是判定层唯一的消费方）—— 闸读的是全局开关，
    # 这里必须同步钉住，否则测的是「闸读到别的开关状态」。
    if _is_ip_literal(example):
        monkeypatch.setattr(execute_module.settings, 'allow_private_network', allow_private)
        assert _package_url_host_denied(example) is (not expected_allowed), (
            f'{example} 的闸门结论与契约判定层不一致（allow_private={allow_private}）'
        )


@pytest.mark.parametrize('allow_private', [False, True], ids=['switch-off', 'switch-on'])
@pytest.mark.parametrize('entry', CONTRACT_METADATA)
def test_contract_metadata_always_denied(entry, allow_private, monkeypatch):
    """契约恒拒表的每个成员：任何开关状态都拒，且分类为 reserved（先于风险分类）。"""
    host = str(entry).split('/')[0]
    restricted, category, metadata_hit = host_safety_verdict(host)
    assert restricted is True, f'恒拒表成员 {host} 未被判受限'
    assert metadata_hit is True, f'恒拒表成员 {host} 未被标为恒拒命中'
    assert category == 'reserved', f'恒拒表成员 {host} 的类别应为 reserved，实际 {category!r}'
    assert category_allowed(category, allow_private) is False, (
        f'恒拒表成员 {host} 在 allow_private={allow_private} 下被放行'
    )
    if _is_ip_literal(host):
        monkeypatch.setattr(execute_module.settings, 'allow_private_network', allow_private)
        assert _package_url_host_denied(host) is True, (
            f'恒拒表成员 {host} 在 allow_private={allow_private} 下过了闸'
        )


@pytest.mark.parametrize('allow_private', [False, True], ids=['switch-off', 'switch-on'])
def test_metadata_members_are_not_in_class_examples(allow_private):
    """恒拒表成员**不得**同时是某类的 example（否则那类的开关语义会把它放行）。"""
    example_set = {e for examples, _ in CONTRACT_CLASSES.values() for e in examples}
    for entry in CONTRACT_METADATA:
        host = str(entry).split('/')[0]
        assert host not in example_set, (
            f'恒拒表成员 {host} 同时出现在某个类别的 examples 里 —— '
            '该类的 allowedUnderPrivateNetwork 会把它放行（契约登记矛盾）'
        )


def test_classification_matches_contract_for_ip_literals():
    """反向：每个**字面 IP**示例的分类结果必须落在契约给它定的类里。"""
    for class_name, (examples, _) in CONTRACT_CLASSES.items():
        for example in examples:
            if not _is_ip_literal(example):
                continue
            expected_category, _ = _expected(class_name, example)
            _, category, _ = host_safety_verdict(example)
            assert category == expected_category, (
                f'{example} 属于契约类 {class_name}，但分类结果是 {category!r}'
                f'（期望 {expected_category!r}）'
            )
