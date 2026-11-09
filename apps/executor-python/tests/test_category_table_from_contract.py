"""R90（ADR-034 步骤 3）：python 的类别表 / 开关语义**从契约生成物派生**。

## 背景

三端此前各抄一份类别与「哪些类别可被开关解锁」的规则：

- python 的 `category_allowed` 把 `"privateIPv4"` **硬编码在函数体里**；
- 契约要新增/改名一个类别，或调整「开关只解锁 privateIPv4」这条，
  三端要改多处，**漏一处不报错**（正是 ADR-034 要消掉的老问题）。

⇒ 本轮让 python 直接读契约生成物 `apps/executor-python/generated/protocol_categories.py`
（来源：契约 `networkPolicy.categories`）：

```python
from .generated.protocol_categories import ALLOWED_UNDER_PRIVATE, CATEGORY_ORDER
```

`category_allowed` 因此**不再含硬编码类别名**——它消费生成物的
`ALLOWED_UNDER_PRIVATE`，并对不在 `CATEGORY_ORDER` 里的未知类别 fail-closed。

## 本文件的判据（双向钉住）

1. **生成物 ≡ 契约**：`CATEGORY_ORDER` / `ALLOWED_UNDER_PRIVATE` 与
   `protocol.json` 的 `networkPolicy.categories` **逐字相同**（任一侧被改就红）；
2. **分类器只吐契约类别**：`classify_restricted_ipv4/ipv6` 的返回值必须落在
   `CATEGORY_ORDER` 里（反向：契约删了一个类别 ⇒ 红）；
3. **开关语义由表决定**：对每个契约类别，`category_allowed(cat, True)` 必须等于
   `cat ∈ ALLOWED_UNDER_PRIVATE`（而不是「等于 privateIPv4」这个字面量）；
4. **未知类别 fail-closed**：不在表里的标签一律拒。
"""
import json
import pathlib

import pytest

import network_policy


def _find_protocol() -> pathlib.Path:
    here = pathlib.Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / 'packages' / 'executor-protocol' / 'protocol.json'
        if candidate.exists():
            return candidate
    raise AssertionError('packages/executor-protocol/protocol.json not found')


PROTOCOL = json.loads(_find_protocol().read_text(encoding='utf-8'))
CONTRACT_CATEGORIES = PROTOCOL['networkPolicy']['categories']


# ---------------------------------------------------------------------------
# 判据 1：生成物 ≡ 契约（双向钉住）
# ---------------------------------------------------------------------------


def test_category_order_matches_contract():
    """`CATEGORY_ORDER` 必须与契约 `networkPolicy.categories.order` 逐字一致。"""
    assert list(network_policy.CATEGORY_ORDER) == list(CONTRACT_CATEGORIES['order']), (
        '类别顺序与契约不一致 —— 生成物过期（重跑 scripts/generate-executor-protocol.mjs）'
        '或有人手改了任一 Java侧'
    )


def test_allowed_under_private_matches_contract():
    """「开关可解锁的类别」必须与契约逐字一致（**不许再硬编码**）。"""
    assert set(network_policy.ALLOWED_UNDER_PRIVATE) == set(
        CONTRACT_CATEGORIES['allowedUnderPrivateNetwork']
    ), (
        'ALLOWED_UNDER_PRIVATE 与契约不一致：'
        f'实现 {sorted(network_policy.ALLOWED_UNDER_PRIVATE)} vs '
        f'契约 {sorted(CONTRACT_CATEGORIES["allowedUnderPrivateNetwork"])}'
    )


# ---------------------------------------------------------------------------
# 判据 2：分类器只吐契约类别
# ---------------------------------------------------------------------------

#: 每类挑一个代表性字面量（覆盖七类；`ipv4Mapped` 按内嵌 IPv4 判，不单列类别）。
REPRESENTATIVE = [
    ('127.0.0.1', 'loopback'),
    ('10.0.0.1', 'privateIPv4'),
    ('169.254.169.254', 'linkLocal'),
    ('100.64.0.1', 'cgnat'),
    ('0.0.0.0', 'unspecified'),
    ('224.0.0.1', 'multicast'),
    ('240.0.0.1', 'reserved'),
]


@pytest.mark.parametrize('addr,expected', REPRESENTATIVE, ids=[c[1] for c in REPRESENTATIVE])
def test_classifier_labels_are_contract_categories(addr, expected):
    category = network_policy.classify_restricted_address(addr)
    assert category == expected, f'{addr} 的分类应为 {expected}，实际 {category!r}'
    assert category in network_policy.CATEGORY_ORDER, (
        f'{addr} 的类别 {category!r} 不在契约 CATEGORY_ORDER 里 —— '
        '分类器吐了契约没有的标签'
    )


def test_every_contract_category_is_reachable_by_the_classifiers():
    """反向：契约里的每个类别都必须能被分类器覆盖（否则 CATEGORY_ORDER 有死条目）。"""
    labels = {network_policy.classify_restricted_address(addr) for addr, _ in REPRESENTATIVE}
    missing = set(network_policy.CATEGORY_ORDER) - labels
    assert missing == set(), f'契约类别 {sorted(missing)} 没有被任何代表性地址覆盖'


# ---------------------------------------------------------------------------
# 判据 3：开关语义**由表决定**（不是硬编码 privateIPv4）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('category', list(network_policy.CATEGORY_ORDER))
def test_switch_semantics_follow_the_generated_table(category):
    """开关开启时放行的类别 == 生成物的 `ALLOWED_UNDER_PRIVATE`（逐类）。"""
    expected_on = category in network_policy.ALLOWED_UNDER_PRIVATE
    assert network_policy.category_allowed(category, True) is expected_on, (
        f'{category} 在开关开启时的放行结论与生成物 ALLOWED_UNDER_PRIVATE 不符'
    )
    # 开关关闭时：任何受限类别都不放行（公网是 None，不在此列）。
    assert network_policy.category_allowed(category, False) is False


def test_public_is_allowed_in_both_states():
    assert network_policy.category_allowed(None, False) is True
    assert network_policy.category_allowed(None, True) is True


# ---------------------------------------------------------------------------
# 判据 4：未知类别 fail-closed
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('bogus', ['private-ipv4', 'PrivateIPv4', '', 'tailscale'])
def test_unknown_category_is_denied(bogus):
    """不在契约类别表里的标签一律拒（不能因「不在表里」而放行）。"""
    assert network_policy.category_allowed(bogus, True) is False
    assert network_policy.category_allowed(bogus, False) is False


# ---------------------------------------------------------------------------
# 判据 5：行为零变化（对外语义与 R90 之前逐条相同）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('addr', ['1.1.1.1', '10.0.0.1', '127.0.0.1',
                                 '169.254.169.254', '100.64.0.1', '0.0.0.0',
                                 '224.0.0.1', '240.0.0.1', '100.100.100.200'])
def test_verdict_semantics_unchanged(addr):
    """R90 只换「规则的来源」，不换规则：开关关闭时除公网外全拒；
    开启时只放行 `privateIPv4`（= 契约 `switch.semantics` 的字面承诺）。"""
    off = network_policy.verdict_for_address(addr, False)
    on = network_policy.verdict_for_address(addr, True)

    if on['category'] is None:                     # 公网
        assert off['allowed'] is True and on['allowed'] is True
        return
    assert off['allowed'] is False, f'{addr} 在开关关闭时被放行'
    expected_on = on['category'] in network_policy.ALLOWED_UNDER_PRIVATE
    assert on['allowed'] is expected_on, f'{addr} 在开关开启时的结论与契约类别表不符'
