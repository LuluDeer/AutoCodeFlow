"""R79：SSRF 主机闸（routers/execute.py::_host_is_restricted）——与 admin-api / executor-node 的拒绝矩阵对齐。

背景：本仓的 SSRF 拒绝判据存在**三份实现**（admin-api 的表驱动 SSRF_DENY_HOST_PATTERNS、
executor-node 的 lib/ssrf-guard.ts、本文件的 python 版）。R74-A1 实测 node 那份可被
[::ffff:127.0.0.1]（WHATWG 规范化为 [::ffff:7f00:1]）整条绕过 —— 也就是「同一道闸被实现了
两遍、其中一遍没跟上」。python 这份靠 ipaddress 的 is_global 兜底反而最强，但**此前没有任何
用例直接钉它**（tests/ 里只有 zip 通道间接提到过地址）。

本文件把 admin-api 的 18 条危险地址镜像过来，逐条断言受限；并补两组「必须放行」的对照
（公网 IPv4 / 公网 IPv4-mapped），防止把闸收成「一律拒绝」的假绿。

同步纪律：scripts/check-ssrf-deny-parity.mjs 会校验 admin-api 矩阵里的每个地址都出现在本文件 ——
往矩阵加危险段而忘了加到这里，CI 直接红。
"""
import pytest

from routers.execute import _host_is_restricted

# 与 apps/admin-api/src/common/utils/__tests__/ssrf-deny-matrix.spec.ts 的 addr 列一一对应。
DANGER_ADDRESSES = [
    "127.0.0.1",  # IPv4 loopback (loopback)
    "10.1.2.3",  # IPv4 RFC1918 10/8 (private-lan)
    "172.16.0.1",  # IPv4 RFC1918 172.16/12 (private-lan)
    "100.64.0.1",  # IPv4 CGNAT lower bound (restricted)
    "0.0.0.0",  # IPv4 unspecified (reserved)
    "224.0.0.1",  # IPv4 multicast (reserved)
    "240.0.0.1",  # IPv4 reserved 240/4 (reserved)
    "255.255.255.255",  # IPv4 broadcast (reserved)
    "::1",  # IPv6 loopback (loopback)
    "::",  # IPv6 unspecified (reserved)
    "fd00::1234",  # IPv6 ULA fd00::/8 (private-lan)
    "fc00::1",  # IPv6 ULA fc00:: (private-lan)
    "fe80::a1",  # IPv6 link-local fe80:: (link-local)
    "febf::ffff",  # IPv6 link-local febf:: (link-local)
    "ff02::1",  # IPv6 multicast (reserved)
    "::ffff:10.0.0.1",  # mapped private (private-lan)
    "::ffff:198.18.0.1",  # mapped benchmark (restricted)
    "::ffff:6440:5",  # mapped CGNAT (hex) (restricted)
]

# 规范化后的十六进制映射形态（URL 解析 IPv6 字面量时可能产出这种形状）。
MAPPED_FORMS = [
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
]


@pytest.mark.parametrize("host", DANGER_ADDRESSES)
def test_restricted_addresses_are_blocked(host):
    assert _host_is_restricted(host) is True, host + " 应判受限"


@pytest.mark.parametrize("host", MAPPED_FORMS)
def test_ipv4_mapped_forms_are_blocked(host):
    # ::ffff: 映射必须先折叠成内嵌 IPv4 再判 —— 这正是 node 侧漏掉的那条路。
    assert _host_is_restricted(host) is True, host + " 应判受限"


@pytest.mark.parametrize("host", ["8.8.8.8", "1.1.1.1", "::ffff:808:808"])
def test_public_addresses_are_allowed(host):
    # 对照组：闸不能收成「一律拒绝」（那会让一切外网下载失效，是假绿）。
    assert _host_is_restricted(host) is False, host + " 应放行"


def test_bracketed_and_zone_forms_normalize():
    # URL 里带方括号 / 带 zone id 的写法也要归一到同一判定。
    assert _host_is_restricted("[::1]") is True
    assert _host_is_restricted("fe80::1%eth0") is True
    assert _host_is_restricted("localhost") is True
