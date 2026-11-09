"""R81：`localhost` 系主机名必须 **DNS 前**拒绝（ADR-036 的 python 侧对称核查）。

## 背景

ADR-036（`56ad74f9`）在 admin 侧修掉了一条旁路：**对 `localhost` / `*.localhost`
的拒绝原先依赖 DNS 结果**——DNS 若把这些名字解析到公网地址，闸门就**放行**，
而契约 `networkPolicy.addresses.loopback` 列的是**名字**（`localhost` /
`*.localhost` / `localhost.localdomain`），不是「解析结果」。

admin 的修法是：在 `lookup(...)` **之前**用零依赖纯函数 `isLoopbackHostname`
短路拒绝（并做归一化：小写、**去尾点**、剥 IPv6 方括号）。

## python 侧的实测（本文件钉住的结论）

`network_policy.is_localhost_synonym`（`network_policy.py:76`）是**名字判定**
（不读 DNS），且在 `host_safety_verdict`（`:272`）、`host_denied_under_policy`
（`:386`）、`classify_restricted_address`（`:213`）里都**先于解析**执行 ⇒
对 `localhost` / `foo.localhost` / `LOCALHOST` / `localhost.localdomain` 这些形态
**已经 DNS 无关**。

**但尾点（FQDN 绝对名）形态漏了**：`localhost.` / `foo.localhost.` 归一化时没有
去尾点 ⇒ 名字判定落空 ⇒ 掉进 DNS 分支 ⇒ 解析到公网就被**放行**（实测：闸门
`_package_url_host_denied` 返回 `False`）。这正是 ADR-036 §1.1 点名要防的
「更糟的形态：`localhost.`（尾点绝对名）」。

⇒ 本文件按 ADR-036 同款修法钉住：**名字判定归一化必须含「去尾点」**，
且闸门在解析到公网时仍拒。

## 判据

1. `localhost` 系各形态 × 开关两态 × 「DNS 解析到公网」的注入替身 ⇒ **全部拒**；
2. 反向护栏：注入解析到**回环**时同样拒（不应该只对公网答案敏感）；
3. 正向护栏：真正的外部域名解析到公网 ⇒ **放行**（防「收成一律拒绝」）。
"""
import pytest

from network_policy import (
    host_denied_under_policy,
    host_safety_verdict,
    is_localhost_synonym,
)
from routers import execute as execute_module


#: 契约 `networkPolicy.addresses.loopback` 列的回环专用名（含大小写/尾点变体）。
#: 尾点 = DNS 的 FQDN 绝对名写法（`localhost.` 与 `localhost` 在 resolver 里等价），
#: 归一化必须把它们折成同一个名字 —— 否则名字判定落空、掉进 DNS 分支。
LOCALHOST_FORMS = [
    'localhost',
    'LOCALHOST',
    'LocalHost',
    'localhost.',
    'LOCALHOST.',
    'foo.localhost',
    'foo.localhost.',
    'sub.foo.localhost',
    'localhost.localdomain',
    'localhost.localdomain.',
    'localhost..',            # 连续尾点：某些 resolver/库会容忍
]

#: 注入式解析替身：把任何主机名解析到**公网**地址（ADR-036 的关键场景）。
PUBLIC_RESOLVER = lambda _name: ['93.184.216.34']   # noqa: E731
#: 对照：解析到回环（正常环境下的行为）。
LOOPBACK_RESOLVER = lambda _name: ['127.0.0.1']     # noqa: E731


@pytest.fixture
def public_dns(monkeypatch):
    """把 `socket.getaddrinfo` 换成「解析到公网」的替身（闸门走真实 DNS 分支）。"""
    monkeypatch.setattr(
        execute_module.socket, 'getaddrinfo',
        lambda *a, **k: [(2, 1, 6, '', ('93.184.216.34', 0))],
    )


# ---------------------------------------------------------------------------
# 判据 1：DNS 前短路 —— 解析到公网也必须拒
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('form', LOCALHOST_FORMS, ids=lambda f: repr(f))
def test_localhost_family_is_name_judged_without_dns(form):
    """名字判定必须命中（DNS 无关）—— 这是「DNS 前短路」的最小断言。"""
    assert is_localhost_synonym(form) is True, (
        f'{form!r} 是契约 `loopback` 段列的回环专用名，'
        '但名字判定没命中 ⇒ 它会掉进 DNS 分支（解析到公网就放行）'
    )


@pytest.mark.parametrize('form', LOCALHOST_FORMS, ids=lambda f: repr(f))
@pytest.mark.parametrize('allow_private', [False, True], ids=['switch-off', 'switch-on'])
def test_localhost_family_denied_even_when_dns_says_public(
        form, allow_private, monkeypatch, public_dns):
    """**关键判据**：DNS 把这些名字解析到**公网**时，判定层与闸门仍必须拒。

    ADR-036 §1.1：契约列的是**名字**，实现不能校验「解析结果」——
    否则「回环专用名」这条安全承诺就取决于外部 DNS 的善意。
    """
    # 判定层（注入解析替身，不碰真实 DNS）
    restricted, category, metadata_hit = host_safety_verdict(form, resolver=PUBLIC_RESOLVER)
    assert restricted is True, f'{form!r} 解析到公网后被判「不受限」—— DNS 旁路复现'
    assert category == 'loopback', f'{form!r} 的类别应为 loopback，实际 {category!r}'
    assert metadata_hit is False

    # 闸门口径（同一个名字判定 + 开关两态）
    assert host_denied_under_policy(form, allow_private, resolver=PUBLIC_RESOLVER) is True, (
        f'{form!r} 在 allow_private={allow_private} 下过了 host_denied_under_policy'
    )

    # 真实闸门（走 `socket.getaddrinfo` 分支，本用例已把它换成公网替身）
    monkeypatch.setattr(execute_module.settings, 'allow_private_network', allow_private)
    assert execute_module._package_url_host_denied(form) is True, (
        f'{form!r} 在 allow_private={allow_private} 下过了真实闸门 —— '
        'ADR-036 同款旁路（DNS 说公网就放行）'
    )


@pytest.mark.parametrize('form', LOCALHOST_FORMS, ids=lambda f: repr(f))
def test_localhost_family_denied_when_dns_says_loopback(form):
    """对照：DNS 解析到回环时当然也拒（避免「只对公网答案敏感」的实现误判）。"""
    assert host_denied_under_policy(form, False, resolver=LOOPBACK_RESOLVER) is True


# ---------------------------------------------------------------------------
# 判据 3：正向护栏（防「收成一律拒绝」）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('host', ['cdn.example.com', 'example.com'])
def test_public_hostnames_are_still_allowed(host, monkeypatch):
    """真正的外部域名 + 公网解析 ⇒ 放行。"""
    monkeypatch.setattr(
        execute_module.socket, 'getaddrinfo',
        lambda *a, **k: [(2, 1, 6, '', ('93.184.216.34', 0))],
    )
    monkeypatch.setattr(execute_module.settings, 'allow_private_network', False)
    assert execute_module._package_url_host_denied(host) is False, (
        f'{host} 解析到公网却被判拒 —— 闸被收成「一律拒绝」了'
    )
