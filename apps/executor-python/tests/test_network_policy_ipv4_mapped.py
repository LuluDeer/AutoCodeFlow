"""R2-1/R5：IPv4-mapped 形态按**内嵌 IPv4** 判定（契约 `networkPolicy.ipv4Mapped`）。

## 契约（Lead 裁定 Q-A ①）

契约取「**完全按内嵌 IPv4 判定**」：把 `::ffff:<IPv4>` 的内嵌 IPv4 取出来，
按 `addresses` 里那七类的规则判 ⇒ 内嵌公网（`::ffff:8.8.8.8`）**放行**，
内嵌受限（`::ffff:169.254.169.254` / `::ffff:127.0.0.1` / `::ffff:100.64.0.1`）
**拒**。

## 为什么这条值得单独钉

此前该形态是**契约沉默区** ⇒ 两侧各自解释：

- **node**：`classifyRestrictedIpv6` 把映射形态**一律归 `reserved`** ⇒ 连内嵌公网也拒；
- **python**：按 `ipaddress` 的 `ipv4_mapped` **还原成 IPv4 后按 IPv4 属性判**
  ⇒ 内嵌公网**放行**。

⇒ **两侧对同一形态给出相反结论**，且攻击者可用映射形态（`::ffff:169.254.169.254`）
绕过整张地址表。契约补齐后两侧按同一口径实现，**标签 == 语义**。

## 与 `routers/execute.py` 运行时判定的关系

`network_policy.host_is_restricted` 是 `routers/execute.py` 的 `_host_is_restricted`
的**唯一实现**（P5 的纯搬家）⇒ 本文件的断言**同时**钉住运行时行为。
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import network_policy as np  # noqa: E402


# (内嵌形态, 期望类别, 期望是否受限, 说明)
MAPPED_CASES = [
    ("::ffff:169.254.169.254", "linkLocal", True, "内嵌云元数据 ⇒ 拒"),
    ("::ffff:127.0.0.1", "loopback", True, "内嵌回环 ⇒ 拒"),
    ("::ffff:100.64.0.1", "cgnat", True, "内嵌 CGNAT ⇒ 拒"),
    ("::ffff:0.0.0.0", "unspecified", True, "内嵌未指定 ⇒ 拒"),
    ("::ffff:10.0.0.1", "privateIPv4", True, "内嵌私网 ⇒ 属 privateIPv4（开关开启时放行）"),
    ("::ffff:8.8.8.8", None, False, "内嵌**公网** ⇒ 放行"),
]


@pytest.mark.parametrize(
    "host,category,restricted,note",
    MAPPED_CASES,
    ids=[c[0] for c in MAPPED_CASES],
)
def test_ipv4_mapped_classified_by_embedded_ipv4(host, category, restricted, note):
    """映射形态按内嵌 IPv4 归类（**标签 == 语义**）。

    反证：把 `classify_restricted_ipv6` 的映射分支改回「一律 reserved」⇒
    `::ffff:8.8.8.8` 与 `::ffff:8.8.8.8` 的公网那两条会转红。
    """
    got_category = np.classify_restricted_address(host)
    assert got_category == category, f"{host}（{note}）：类别应为 {category}，实际 {got_category}"


@pytest.mark.parametrize(
    "host,category,restricted,note",
    MAPPED_CASES,
    ids=[c[0] for c in MAPPED_CASES],
)
def test_ipv4_mapped_runtime_semantics_match_category(host, category, restricted, note):
    """运行时语义与类别标签**必须一致**（R5 删掉了「故意不同」的分支）。

    这是 R5 的核心不变量：此前该形态上两者**故意不等价**（node 拒 / python 放行），
    契约补齐后**必须完全一致** —— 否则「标签」就是假的。

    反证：把 `host_is_restricted_with_category` 的 IP 字面量分支改回
    `_restricted_ip_bool(ip)`（旧实现）⇒ `::ffff:8.8.8.8` 那条转红
    （标签 None 但语义 True）。
    """
    got_restricted, got_category = np.host_is_restricted_with_category(host)
    assert got_restricted == restricted, f"{host}（{note}）"
    assert got_category == category, f"{host}（{note}）"
    # **标签 == 语义**：有受限类别 ⇒ 受限；无类别 ⇒ 不受限
    assert got_restricted == (got_category is not None), (
        f"{host}: 标签({got_category}) 与语义({got_restricted}) 不一致 —— "
        "R5 要求两者恒等"
    )


def test_ipv4_mapped_private_respects_switch():
    """内嵌私网：按 `privateIPv4` 档 ⇒ 开关开启放行 / 关闭拒绝（与裸 `10.0.0.1` 同档）。"""
    host = "::ffff:10.0.0.1"
    category = np.classify_restricted_address(host)
    assert category == "privateIPv4"
    assert np.category_allowed(category, allow_private=True) is True
    assert np.category_allowed(category, allow_private=False) is False


def test_ipv4_mapped_public_is_allowed_under_both_switch_states():
    """内嵌公网在**任何**开关状态下都放行（契约裁定）。

    ⚠️ 这是 **node 侧的行为变更**（改前 node 一律归 `reserved` ⇒ 拒）。
    python 侧本来就是「按内嵌 IPv4 判」⇒ **python 运行时行为不变**。
    """
    host = "::ffff:8.8.8.8"
    category = np.classify_restricted_address(host)
    assert category is None
    assert np.category_allowed(category, allow_private=True) is True
    assert np.category_allowed(category, allow_private=False) is True
    assert np.host_is_restricted(host) is False


def test_plain_ipv4_unchanged():
    """非映射形态不受影响（回归锁：裸 IPv4 的判定逐条不变）。"""
    for host, category, restricted in [
        ("169.254.169.254", "linkLocal", True),
        ("127.0.0.1", "loopback", True),
        ("10.0.0.1", "privateIPv4", True),
        ("100.64.0.1", "cgnat", True),
        ("0.0.0.0", "unspecified", True),
        ("224.0.0.1", "multicast", True),
        ("240.0.0.1", "reserved", True),
        ("8.8.8.8", None, False),
        ("1.1.1.1", None, False),
    ]:
        got = np.classify_restricted_address(host)
        assert got == category, f"{host}: 类别应为 {category}，实际 {got}"
        assert np.host_is_restricted(host) is restricted, f"{host}: 受限判定变了"


def test_no_deliberate_divergence_branch_remains():
    """**结构性**断言：模块里不得再有「运行时语义 vs 契约标签故意不同」的分支。

    R5 的五步之一是「删掉那个分支」。本用例防止它被重新引入：
    若有人把 IP 字面量分支改回 `_restricted_ip_bool(ip)`（旧实现），
    映射形态上标签与语义就会重新分叉 ⇒ 本用例通过**源码形态**检查抓住
    （`_restricted_ip_bool` 不应再出现在 `host_is_restricted_with_category` 里）。

    反证：把 IP 字面量分支改回 `_restricted_ip_bool(ip)` ⇒ 本用例转红。
    """
    import inspect

    src = inspect.getsource(np.host_is_restricted_with_category)
    assert "_restricted_ip_bool" not in src, (
        "host_is_restricted_with_category 里不得再用 _restricted_ip_bool —— "
        "R5 已删除「标签 vs 语义故意不同」的分支，两者必须恒等"
    )
    # 且 helper 本身仍在（它表达「这个 IP 是否受限」，被分类函数复用）
    assert hasattr(np, "_restricted_ip_bool")
