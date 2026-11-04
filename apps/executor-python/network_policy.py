"""R2-1/P5：执行器出站地址的**网络策略**（networkPolicy）—— 纯标准库模块。

## 为什么要有这个模块（与 `js_json.py` 同款理由）

本模块是 **stdlib-only**（只 import `ipaddress` / `socket` / `re` / `typing`），
与仓内既有的 `js_json.py`（A-11R 的 JSON.stringify 对等物）**同款定位**：
「纯逻辑 + 无第三方依赖 ⇒ 可被独立进程直接跑」。

**为什么 P5 需要它**：`scripts/check-protocol-three-way.mjs` 要**真跑**两侧
实现来比对「同一份契约向量 ⇒ 同一结论」。python 侧的判定逻辑原先住在
`routers/execute.py` 里，而那个模块**顶层 import httpx / fastapi / pydantic**
⇒ 独立进程无法 import 它（需要 pip install ⇒ 守卫变成重任务，违反
「零依赖优先」的硬约束）。

⇒ 处置：把**纯判定逻辑**抽到本模块（**只搬不改**），`routers/execute.py`
改为调用它。抽完之后：
  · `routers/execute.py` 的行为**逐字节不变**（同一份实现被调用）；
  · P5 守卫可以用**裸 `python3`**（OS 自带，无第三方）真跑 python 侧。

## 本模块与契约的对应

`packages/executor-protocol/protocol.json` 的 `networkPolicy` 段：
`addresses`（七类）/ `switch`（开关只放行 privateIPv4）/ `resolution`
（dns-resolve + fail-closed）。

node 侧的对等物是 `apps/executor-node/src/git-repo-network-policy.ts`
（+ `src/lib/ssrf-guard.ts` 的按位判定）。两侧**都**按同一份契约实现。

## 与 node 侧的一处**有意**差异（如实记录，不是缺陷）

node 的 `lib/ssrf-guard.ts` 用**按位**判定（自己解析 IPv6 分组、逐段比对），
不依赖 stdlib 的分类表；python 用 `ipaddress` 的 `is_private` / `is_global` 等
**分类属性**。两者的**网段集合等价**（已由 `scripts/check-protocol-three-way.mjs`
逐向量对账），但**实现机制不同** ⇒ 未来 stdlib 改分类表时 python 侧可能漂移。
本模块的 `not ip.is_global` 兜底 + CGNAT 单列正是为了**不让分类表漂移传导到
安全判定**（见下方 `_restricted_ip` 注释）。
"""
from __future__ import annotations

import ipaddress
import re
import socket
from typing import Optional
# R08（2026-11-05，ADR-029）：元数据地址恒拒 —— 地址表来自契约生成物，三端同读。
try:  # 包内导入（`apps/executor-python` 作为包根时）
    from .generated.protocol_metadata_addresses import METADATA_ADDRESSES
except ImportError:  # 兼容以 `apps/executor-python` 为 sys.path 根的运行方式
    from generated.protocol_metadata_addresses import METADATA_ADDRESSES

__all__ = [
    "RestrictedCategory",
    "classify_restricted_ipv4",
    "classify_restricted_ipv6",
    "classify_restricted_address",
    "host_is_restricted",
    "host_is_restricted_with_category",
    "is_metadata_address",
    "category_allowed",
    "private_network_allowed",
    "git_repo_host",
    "is_localhost_synonym",
]

# 契约 `networkPolicy.addresses` 的七类（键名逐字对应 protocol.json）。
RestrictedCategory = str

# 契约 `networkPolicy.switch.envVar` —— 开关名（node 侧同一常量）。
PRIVATE_NETWORK_ENV_VAR = "EXECUTOR_ALLOW_PRIVATE_NETWORK"

# scp-like git 形态：git@host:path（没有 `//` 段，urlsplit 给不出 hostname）。
_GIT_REPO_SCP_RE = re.compile(r"^[A-Za-z0-9._-]+@([A-Za-z0-9.\-]+):")


def is_localhost_synonym(host: str) -> bool:
    """localhost 同义词（契约 `addresses.loopback`）。"""
    name = (host or "").strip().strip("[]").lower()
    return (
        name == "localhost"
        or name == "localhost.localdomain"
        or name.endswith(".localhost")
    )


def _restricted_ip(ip: "ipaddress._BaseAddress") -> bool:
    """该 IP 是否属于契约列出的受限类别之一。

    `not ip.is_global` 是**兜底**：CGNAT（100.64.0.0/10）在 Python 3.12 的
    `ipaddress` 里**既不是 private 也不是 reserved**（实测），但显然不该允许
    执行器去打。node 侧 ssrf-guard 显式列了 100.64/10，这里用"非全球可路由"
    一并覆盖，语义等价且不会随 stdlib 分类表漂移。
    multicast 单列：224.0.0.1 的 is_global 为 True，不兜底拦不住。
    """
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return bool(
        ip.is_loopback
        or ip.is_private
        or ip.is_link_local
        or ip.is_unspecified
        or ip.is_multicast
        or ip.is_reserved
        or not ip.is_global
    )


def classify_restricted_ipv4(ip: str) -> Optional[RestrictedCategory]:
    """IPv4 地址 → 契约的类别（`None` = 不受限/公网）。

    **顺序即规格**（与 node 侧 `classifyRestrictedIpv4` 逐条对位）。
    """
    parts = (ip or "").split(".")
    if len(parts) != 4:
        return None
    octets = []
    for p in parts:
        try:
            v = int(p, 10)
        except ValueError:
            return None
        if v < 0 or v > 255:
            return None
        octets.append(v)
    a, b = octets[0], octets[1]

    if a == 127:
        return "loopback"          # 127.0.0.0/8
    if a == 10:
        return "privateIPv4"       # RFC1918
    if a == 172 and 16 <= b <= 31:
        return "privateIPv4"       # RFC1918 /12
    if a == 192 and b == 168:
        return "privateIPv4"       # RFC1918 /16
    if a == 169 and b == 254:
        return "linkLocal"         # 含云元数据 169.254.169.254
    if a == 0:
        return "unspecified"       # 0.0.0.0/8
    if a == 100 and 64 <= b <= 127:
        return "cgnat"             # 100.64/10
    if 224 <= a <= 239:
        return "multicast"         # 224.0.0.0/4
    if a == 198 and b in (18, 19):
        return "reserved"          # 198.18/15 benchmark
    if a >= 240:
        return "reserved"          # 240.0.0.0/4 + 255.255.255.255
    return None


def classify_restricted_ipv6(ipv6_raw: str) -> Optional[RestrictedCategory]:
    """IPv6 地址 → 契约的类别（`None` = 不受限/公网）。

    与 node 侧 `classifyRestrictedIpv6` 逐条对位：未指定 / 回环 / IPv4-mapped /
    IPv4-compatible / NAT64 / 6to4 / link-local(fe80::/10) / ULA(fc00::/7，含
    AWS IPv6 元数据 fd00:ec2::254) / 组播(ff00::/8)。
    """
    name = (ipv6_raw or "").strip().strip("[]").lower()
    if not name:
        return None
    try:
        ip = ipaddress.ip_address(name)
    except ValueError:
        return None
    if not isinstance(ip, ipaddress.IPv6Address):
        return None

    if ip.is_unspecified:
        return "unspecified"       # ::
    if ip.is_loopback:
        return "loopback"          # ::1
    if ip.ipv4_mapped is not None:
        # IPv4-mapped（::ffff:0:0/96）—— 契约 `networkPolicy.addresses.ipv4Mapped`：
        # **完全按内嵌 IPv4 判定**（Lead 裁定 Q-A ①）⇒ 内嵌公网 ⇒ 不受限（放行）。
        return classify_restricted_ipv4(str(ip.ipv4_mapped))
    if getattr(ip, "sixtofour", None) is not None:
        # 6to4（2002::/16）：内嵌 IPv4，同样按内嵌判
        return classify_restricted_ipv4(str(ip.sixtofour))
    if getattr(ip, "teredo", None) is not None:
        return "reserved"
    if ip.is_link_local:
        return "linkLocal"         # fe80::/10
    # ULA fc00::/7（含 AWS IPv6 元数据 fd00:ec2::254）—— 契约归 linkLocal
    if ip.is_private:
        return "linkLocal"
    if ip.is_multicast:
        return "multicast"
    return None


def is_metadata_address(host_raw: str) -> bool:
    """R08（ADR-029）：该主机是否在契约的元数据恒拒表里（任何 posture × 任何开关都 DENY）。"""
    host = (host_raw or "").strip().strip("[]").lower()
    if not host:
        return False
    return any(str(entry).split("/")[0].strip() == host for entry in METADATA_ADDRESSES)


def classify_restricted_address(host_raw: str) -> Optional[RestrictedCategory]:
    """统一入口：主机名或 IP 字面量 → 契约类别（`None` = 不受限或无法识别）。

    主机名需要 DNS 解析才能归类 ⇒ 返回 `None`，由 `host_is_restricted`
    （带解析）处理。

    R08/ADR-029：元数据地址**先判** ⇒ 归 `reserved`（该类在 `category_allowed`
    里任何开关状态都拒）——判定顺序必须在其它分类之前，否则开关仍能放行。
    """
    host = (host_raw or "").strip().strip("[]").lower()
    if not host:
        return None
    # R08/ADR-029：元数据恒拒（先于一切分类；`reserved` 在任何开关状态都拒）
    if is_metadata_address(host):
        return "reserved"
    if is_localhost_synonym(host):
        return "loopback"
    if ":" in host:
        return classify_restricted_ipv6(host)
    return classify_restricted_ipv4(host)


def _restricted_ip_bool(ip: "ipaddress._BaseAddress") -> bool:
    """该 IP 是否受限（**逐字节对齐** `routers/execute.py` 的原实现）。

    ⚠️ **R2-1/R5（2026-11-04）**：本函数原先与 `classify_restricted_address`
    存在一处**故意的**差异（IPv4-mapped 形态：python 按内嵌 IPv4 判 ⇒ 公网映射
    放行；node 一律归 `reserved` ⇒ 拒）。那是**契约沉默**导致的真实漂移，
    已在 `networkPolicy.addresses` 新增 **`ipv4Mapped`** 类后**收敛**：
    契约取「**完全按内嵌 IPv4 判定**」，两侧都按它实现 ⇒ **标签 == 语义**。

    ⇒ 本函数保留（它表达的是「这个 IP 是否受限」），但**不再有任何「故意不同」
    的语义** —— 判定完全由内嵌 IPv4 的类别决定。
    """
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return bool(
        ip.is_loopback
        or ip.is_private
        or ip.is_link_local
        or ip.is_unspecified
        or ip.is_multicast
        or ip.is_reserved
        or not ip.is_global
    )


def host_is_restricted_with_category(
    host: str,
    resolver=None,
) -> tuple:
    """主机名 → (是否受限, 类别)。**真实 DNS 解析**（契约 `resolution.mode`）。

    `resolver` 可注入（测试用）：`resolver(host) -> list[str]`（解析出的地址表）。
    缺省用 `socket.getaddrinfo`。

    **fail-closed**：解析失败 / 空地址表 / 任一地址受限 ⇒ 一律判受限
    （契约 `resolution.onResolutionFailure = "deny"`）。

    ✅ **R2-1/R5**：第一个返回值（运行时语义）与第二个返回值（契约类别标签）
    现在**完全一致** —— 两侧都按契约的 `networkPolicy` 实现，**标签 == 语义**。
    （此前 IPv4-mapped 形态上两者「故意不同」，那是契约沉默期的过渡形态，
    随 `ipv4Mapped` 类落地**已删除**。）
    """
    name = (host or "").strip().strip("[]").lower()
    if not name:
        return True, "reserved"
    if is_localhost_synonym(name):
        return True, "loopback"

    # IP 字面量：无需解析
    try:
        ip = ipaddress.ip_address(name)
    except ValueError:
        ip = None
    if ip is not None:
        category = classify_restricted_address(name)
        # 契约：映射形态**完全按内嵌 IPv4 判定** ⇒ 内嵌公网 ⇒ 不受限（放行），
        # 内嵌受限 ⇒ 那一类。⇒ 语义与标签由**同一个** category 决定。
        restricted = category is not None
        return restricted, category

    # 主机名 → DNS 解析
    try:
        if resolver is not None:
            addresses = list(resolver(name))
        else:
            infos = socket.getaddrinfo(name, None)
            addresses = []
            for info in infos:
                sockaddr = info[4] if len(info) > 4 else None
                if not sockaddr:
                    return True, "reserved"
                addresses.append(sockaddr[0])
    except Exception:
        # fail-closed：解析不出来 = 无法证明安全
        return True, "reserved"
    if not addresses:
        return True, "reserved"
    for address in addresses:
        category = classify_restricted_address(address)
        if category is not None:
            return True, category
    return False, None


def host_is_restricted(host: str, resolver=None) -> bool:
    """主机名是否指向受限地址（契约 `networkPolicy` 的判定）。

    **只搬不改**：这是 `routers/execute.py` 里 `_host_is_restricted` 的
    同源实现（原实现已迁到本模块，调用点改为调用本函数）。
    """
    return host_is_restricted_with_category(host, resolver=resolver)[0]


def category_allowed(category: Optional[RestrictedCategory], allow_private: bool) -> bool:
    """按契约 `networkPolicy.switch` 决定该类别能否放行。

    **开关的唯一效果是放行 `privateIPv4`**；其余六类（loopback / linkLocal /
    cgnat / unspecified / multicast / reserved）**在任何开关状态下都拒**。
    """
    if category is None:
        return True   # 公网地址
    if category == "privateIPv4":
        return allow_private
    return False


def private_network_allowed(env: Optional[dict] = None) -> bool:
    """开关当前是否开启（契约 `networkPolicy.switch.envVar`）。"""
    import os

    source = env if env is not None else os.environ
    raw = source.get(PRIVATE_NETWORK_ENV_VAR, "")
    return str(raw).strip().lower() in ("true", "1")


def git_repo_host(raw: str) -> str:
    """从 gitRepo 三种合法形态里取出主机名（空串 = 取不到）。"""
    text = (raw or "").strip()
    if not text:
        return ""
    if "://" not in text:
        m = _GIT_REPO_SCP_RE.match(text)
        return m.group(1).lower() if m else ""
    try:
        from urllib.parse import urlsplit

        u = urlsplit(text)
        return (u.hostname or "").strip("[]").lower()
    except ValueError:
        m = _GIT_REPO_SCP_RE.match(text)
        return m.group(1).lower() if m else ""
