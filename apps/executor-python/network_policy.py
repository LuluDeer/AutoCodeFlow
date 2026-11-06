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
    "host_safety_verdict",
    "host_denied_under_policy",
    "verdict_for_address",
    "validated_addresses",
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
    """localhost 同义词（契约 `addresses.loopback`）。**纯名字判定，不读 DNS**。

    契约 `networkPolicy.addresses.loopback.description` 列的是**名字**
    （`localhost` / `*.localhost` / `localhost.localdomain`），不是「解析结果」——
    所以这条判定必须**在任何 DNS 之前**命中，否则「回环专用名」的安全承诺就取决于
    外部 DNS 的善意。

    ## R81（ADR-036 同款旁路的 python 侧对称修复）：归一化必须**去尾点**

    `localhost.` / `foo.localhost.` / `localhost.localdomain.` 是 DNS 的
    **FQDN 绝对名**写法（resolver 语义与不带尾点完全等价），但旧的归一化只做
    `strip("[]").lower()` ⇒ 名字判定落空 ⇒ 掉进 **DNS 分支** ⇒ 解析到公网就被
    **放行**（实测：`_package_url_host_denied('localhost.')` 返回 `False`）。
    ADR-036 §1.1 把「`localhost.`（尾点绝对名）」点名列为要防的更糟形态，
    admin 侧已按「小写 + 去尾点 + 剥方括号」归一化修掉 ⇒ 本函数对齐同一口径
    （连续尾点也一并折掉：某些 resolver/库容忍 `localhost..`）。
    """
    name = (host or "").strip().strip("[]").lower()
    # FQDN 绝对名 → 相对名（含连续尾点）。
    name = name.rstrip(".")
    if not name:
        return False
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


def host_safety_verdict(
    host: str,
    resolver=None,
) -> tuple:
    """主机名 → (是否受限, 类别, **是否命中元数据恒拒表**)。闸门用的完整判定。

    **为什么需要第三个分量（R59-W4，ADR-029「判定先于风险分类」）**

    `routers/execute.py::_package_url_host_denied` 的开关语义是「开关开启 ⇒ 放行
    非 loopback 的受限地址」，而元数据地址的类别是 `reserved` ⇒ 只看前两个分量时，
    开关一开元数据就被放行（R07 的同一缺陷形态，只是落在执行器姿态上）。契约
    `metadataAddresses` 要求「任何 posture × 任何开关都 DENY」⇒ 闸门必须能**在拿到
    类别之外**知道「这个主机命中恒拒表」，才能把判别顺序摆正：

        metadata_hit → deny        # 恒拒，先于开关、先于 loopback 例外
        restricted   → switch      # 其余仍按既有姿态

    主机名形态按契约 `resolution.mode = "dns-resolve"` **真实解析后逐地址查表**
    （node 侧对解析结果同样逐个 `isRestrictedAddressForPolicy` 归类）；解析失败
    仍由调用方 fail-closed（本函数返回 `restricted=True`）。

    与 `host_is_restricted_with_category` 的关系：本函数是**超集**，后者只取前两
    个分量（既有公开契约不变）。
    """
    name = (host or "").strip().strip("[]").lower()
    if not name:
        return True, "reserved", False
    if is_localhost_synonym(name):
        return True, "loopback", False

    # IP 字面量：无需解析
    try:
        ip = ipaddress.ip_address(name)
    except ValueError:
        ip = None
    if ip is not None:
        category = classify_restricted_address(name)
        # 契约：映射形态**完全按内嵌 IPv4 判定** ⇒ 内嵌公网 ⇒ 不受限（放行），
        # 内嵌受限 ⇒ 那一类。⇒ 语义与标签由**同一个** category 决定。
        return (category is not None), category, is_metadata_address(name)

    # 主机名 → DNS 解析（契约 `resolution.mode = "dns-resolve"`）
    try:
        if resolver is not None:
            addresses = list(resolver(name))
        else:
            infos = socket.getaddrinfo(name, None)
            addresses = []
            for info in infos:
                sockaddr = info[4] if len(info) > 4 else None
                if not sockaddr:
                    return True, "reserved", False
                addresses.append(sockaddr[0])
    except Exception:
        # fail-closed：解析不出来 = 无法证明安全
        return True, "reserved", False
    if not addresses:
        return True, "reserved", False
    metadata_hit = False
    for address in addresses:
        if is_metadata_address(address):
            metadata_hit = True
        category = classify_restricted_address(address)
        if category is not None:
            # 任一地址受限 ⇒ 整体受限（契约 `resolution.onResolutionFailure` 的
            # 同款 fail-closed 取向）；恒拒表命中优先返回 `reserved`。
            return True, ("reserved" if metadata_hit else category), metadata_hit
    # 全部地址都不受限：仍在恒拒表里出现过的名字不因「同时解析到公网」而放行。
    return False, None, metadata_hit


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
    # 主体在 `host_safety_verdict`（它多返回一个「命中恒拒表」分量）；
    # 本函数保持既有公开契约：只返回前两个分量。
    restricted, category, _metadata_hit = host_safety_verdict(host, resolver=resolver)
    return restricted, category


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


def host_denied_under_policy(
    host: str,
    allow_private: bool,
    resolver=None,
) -> bool:
    """闸门口径（ADR-032）：该主机是否**拒绝**。恒拒表优先，其次「类别 + 开关」。

    这是 `routers/execute.py::_package_url_host_denied` 唯一消费的判定，逐条对齐
    契约 `networkPolicy`：

      * 恒拒表（`metadataAddresses`）⇒ 任何 posture、任何开关都拒（ADR-029）；
      * 其余交给 `category_allowed`：**开关的唯一效果是放行 privateIPv4**
        （linkLocal / cgnat / unspecified / multicast / reserved 一律仍拒）；
      * 主机名按契约 `resolution.mode = "dns-resolve"` **逐解析地址**判，任一地址
        不被放行即拒；解析失败 / 空表 fail-closed。

    **为什么不能复用 `host_safety_verdict` 的类别喂 `category_allowed`**：那个函数
    对主机名只返回**第一个**受限类别（`[10.0.0.5, 169.254.169.254]` 会返回
    `privateIPv4`），开关开启时会被放行；而 node 的 gitRepo 面对解析结果**逐地址**
    判、任一不过即拒（`apps/executor-node/src/git-repo-network-policy.ts` 的
    `assertGitRepoNetworkPolicyResolved`）。两侧必须同构。
    """
    name = (host or "").strip().strip("[]").lower()
    if not name:
        return True                      # fail-closed（与 host_safety_verdict 同口径）
    if is_localhost_synonym(name):
        return True                      # loopback：任何开关状态都拒

    # IP 字面量：无需解析
    try:
        ip = ipaddress.ip_address(name)
    except ValueError:
        ip = None
    if ip is not None:
        if is_metadata_address(name):
            return True
        return not category_allowed(classify_restricted_address(name), allow_private)

    # 主机名 → 解析后逐地址判（契约 `resolution.mode = "dns-resolve"`）
    try:
        if resolver is not None:
            addresses = [str(a) for a in resolver(name)]
        else:
            addresses = []
            for info in socket.getaddrinfo(name, None):
                sockaddr = info[4] if len(info) > 4 else None
                if not sockaddr:
                    return True          # fail-closed：拿不到地址
                addresses.append(sockaddr[0])
    except Exception:
        return True                      # fail-closed：解析不出来 = 无法证明安全
    if not addresses:
        return True
    for address in addresses:
        if is_metadata_address(address):
            return True                  # 任一答案命中恒拒表 ⇒ 整体拒
        if not category_allowed(classify_restricted_address(address), allow_private):
            return True
    return False


def verdict_for_address(addr: str, allow_private_network: bool) -> dict:
    """**单个地址 / 回环专用名的契约判决**（纯函数，**裸 `python3` 可跑**）。

    R82：给跨端一致性判据（契约 `networkPolicy` 的 24 个示例 × 开关两态 × 三端）
    提供一个**同形出口** —— 此前 python 侧只有两个入口，都不好用：

      · `host_safety_verdict(host, resolver=None)` **没有开关入参**（开关语义住在
        `routers/execute.py::_package_url_host_denied`，那是 FastAPI 层，裸
        `python3` import 不了）；
      · `host_denied_under_policy(...)` 有开关入参，但返回布尔（没有类别/理由），
        且对**主机名**会真解析 DNS（探针不该做网络 I/O）。

    本函数把三件事一次说清：**开关 + 类别 + 恒拒 + 理由**，且**不做 DNS、不读
    env、不读文件**（`ipaddress` / `re` 是标准库；恒拒表是模块级常量
    `METADATA_ADDRESSES`，来源 = 契约 `networkPolicy.metadataAddresses` 的生成物
    `apps/executor-python/generated/protocol_metadata_addresses.py`）。

    语义与闸门**逐字一致**（`host_denied_under_policy`，判定顺序也一致）：

      ① 恒拒表（ADR-029）⇒ 拒，`category="reserved"`、`metadata=True`
         —— 任何开关状态都拒；
      ② 回环专用名（`localhost` / `*.localhost` / `localhost.localdomain`，含
         大小写与**尾点**变体）⇒ 拒，`category="loopback"` —— 名字判定，DNS 无关；
      ③ 其余按 `classify_restricted_address` 分类（`ipv4Mapped` 按内嵌 IPv4 判）；
      ④ `category_allowed`：**开关只放行 `privateIPv4`**。

    **不做 DNS**：契约 `addresses.*.examples` 里的主机名只有回环专用名（名字判定
    即够）。其它主机名返回 `allowed=False / reason="dns-required"` —— 这是
    **fail-closed 的探针口径**（探针不该把「解析不出来」当成「放行」，也不该做
    网络 I/O）；生产闸门对这类名字走 `host_denied_under_policy` 的真实解析。

    返回 dict（键稳定，便于跨端比对）：

    ```python
    {"allowed": bool, "category": str | None, "metadata": bool, "reason": str}
    ```

    `reason` 取值：`metadata-table` / `loopback-name` / `public` /
    `restricted-class` / `allowed-private-ipv4` / `empty-host` / `dns-required`。
    """
    raw = (addr or "").strip()
    name = raw.strip("[]").strip()
    if not name:
        return {"allowed": False, "category": None, "metadata": False,
                "reason": "empty-host"}

    # ① 恒拒表优先（ADR-029：任何 posture × 任何开关都 DENY）
    if is_metadata_address(name):
        return {"allowed": False, "category": "reserved", "metadata": True,
                "reason": "metadata-table"}

    # ② 回环专用名（纯名字判定，DNS 无关 —— ADR-036 同款口径）
    if is_localhost_synonym(name):
        return {"allowed": False, "category": "loopback", "metadata": False,
                "reason": "loopback-name"}

    # ③ IP 字面量才分类；主机名不做 DNS（见 docstring 的 fail-closed 说明）
    try:
        ipaddress.ip_address(name)
    except ValueError:
        return {"allowed": False, "category": None, "metadata": False,
                "reason": "dns-required"}

    category = classify_restricted_address(name)
    if category is None:
        return {"allowed": True, "category": None, "metadata": False,
                "reason": "public"}

    allowed = category_allowed(category, allow_private_network)
    reason = "allowed-private-ipv4" if allowed else "restricted-class"
    return {"allowed": allowed, "category": category, "metadata": False,
            "reason": reason}


def validated_addresses(
    host: str,
    allow_private: bool,
    resolver=None,
) -> list:
    """主机名 → **已通过契约判定**的地址表（空表 = 拒）。用于把 IP **钉住**。

    R85：与 node `createPinnedLookup` 同义 —— **校验与建连必须用同一份解析答案**。
    判据与 `host_denied_under_policy` **完全一致**（恒拒表 → 回环专用名 → 分类 →
    开关只放行 privateIPv4），区别只在于它**把判定时看到的那份答案返回**给调用方：
    调用方据此把 URL 的 host 换成已校验 IP 建连 ⇒ 不给攻击者「第二次解析」的机会
    （DNS rebinding 的窗口正是「判定解析一次、建连再解析一次」）。

    返回 `[]`（= 拒，fail-closed）的情形：空主机名 / 回环专用名 / 恒拒表 /
    解析失败 / 空答案表 / **任一答案**不被放行。
    """
    name = (host or "").strip().strip("[]").lower()
    if not name:
        return []
    if is_localhost_synonym(name):
        return []                      # 回环专用名：任何开关都拒（DNS 无关）
    try:
        ip = ipaddress.ip_address(name)
    except ValueError:
        ip = None
    if ip is not None:
        if is_metadata_address(name):
            return []
        if not category_allowed(classify_restricted_address(name), allow_private):
            return []
        return [name]

    # 主机名：**只解析一次**，逐地址判；任一不过 ⇒ 整个名字拒
    try:
        if resolver is not None:
            addresses = [str(a) for a in resolver(name)]
        else:
            addresses = []
            for info in socket.getaddrinfo(name, None):
                sockaddr = info[4] if len(info) > 4 else None
                if not sockaddr:
                    return []
                addresses.append(sockaddr[0])
    except Exception:
        return []
    if not addresses:
        return []
    validated = []
    for address in addresses:
        if is_metadata_address(address):
            return []
        if not category_allowed(classify_restricted_address(address), allow_private):
            return []
        validated.append(address)
    return validated


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
