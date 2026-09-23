"""ARCH-36（ADR-017 阶段 2）：执行器的**稳定唯一身份** deviceFingerprint。

node 侧同源实现：``apps/executor-node/src/device-identity.ts``——两端的指纹
算法、盐的作用域、失败姿态、字段缺省语义必须逐条对齐（ADR-005「同批发布」
纪律；一致性由本文件与 node spec 的双向用例钉住）。

── 为什么需要它 ──────────────────────────────────────────────────────────
``executors`` 的唯一键建在 ``address`` 上，而 ``address`` 是执行器**自报**的
局域网 IP + 端口。两台不同内网的机器只要网段相同（``192.168.1.100:8002``
极常见）就命中**同一行**：注册互相覆盖、共享同一条 pull 队列
（``acf:pull:`` / ``acf:cmd:``）、``startupId`` 抖动使双方互相把对方正在跑的
任务判成 EXECUTOR_RESTART、每次注册都 rotateToken 互废令牌。P0 已把「两个
进程生命并存」变成一条可见的 ERROR 告警（admin 侧
``executor-address-conflict.util.ts``）；本模块提供的是**判定依据**——一个
跨重启稳定、且不同安装必然不同的标识。

── 判据为什么比 startupId 强 ─────────────────────────────────────────────
``startupId`` 是**每进程**随机 UUID，只能在「被顶替者复活」这个时序上**间接**
推断并存。``deviceFingerprint`` 跨重启**不变**，于是：

- 「同一 address 上出现两个不同 fingerprint」= **直接证据**，不需时序，
  也不会把正常重启误判成冲突；
- 「同一 fingerprint 换成另一个 address」= **地址漂移**（机器换网/换 IP），
  属正常现象，不是冲突。

── 组成 ──────────────────────────────────────────────────────────────────
``deviceFingerprint = sha256(deviceId + ":" + installSalt)``，64 位小写十六进制。

- ``deviceId`` 标识**这台机器**（跨重启稳定）：Windows 注册表 MachineGuid /
  Linux ``/etc/machine-id``（回退 ``/var/lib/dbus/machine-id``）/ macOS
  IOPlatformUUID；三者皆不可得（容器镜像常被清空）时回退「首个非 loopback
  网卡 MAC + 主机名」的哈希。见 :func:`resolve_device_id`。
- ``installSalt`` 标识**这份安装**：首次启动生成随机 UUID 并持久化。作用域
  **含执行器 kind**（见 :func:`device_salt_path`），故同机同 work_dir 上并存的
  node 与 python 执行器是两个不同的安装实例、不会得出同一指纹——ADR-017 阶段 3
  以指纹为定位键时，这一点是必须的（否则两个逻辑执行器会被折叠成一行）。
- **只上报哈希，绝不上报原始 machineId**：原始值属主机敏感信息，哈希已足够
  做唯一性与冲突检测，且不可反查。

── 边界（如实） ──────────────────────────────────────────────────────────
- 指纹**不是防伪造凭据**——执行器可自报任意指纹（与今日 ``address`` 同等可
  伪造）。它解决唯一性与稳定性，不解决认证（认证由 per-executor token 承担）。
- 同一台机器上**同 kind 且共用同一个 work_dir** 的两个实例被视为同一安装
  实例。要区分它们必须给不同的 ``WORK_DIR``，或设 ``EXECUTOR_INSTANCE_KIND``。
- MAC 兜底无法与 node 侧做**逐字节**交叉验证：python 走 ``psutil`` 枚举网卡，
  node 走 ``os.networkInterfaces()``，两者都归一化为「小写冒号分隔 MAC」，
  但网卡枚举顺序/过滤口径由各自平台 API 决定。要求一致的是
  :func:`compute_device_fingerprint`（纯函数，同输入同输出）与**全部失败时的
  降级形态**（``fallback::<hostname>``），二者都有双端一致性用例。

── 纪律 ──────────────────────────────────────────────────────────────────
- **fail-open**：采集失败一律 ``None`` 并**只 warn 一次**——绝不阻断启动/注册。
- **零行为变更**：未上报（None）的执行器在中台侧列保持 NULL，行为与引入前
  逐字节一致（兼容性红线）。
- **零 IO 抖动、零定时器**：结果 memo 化，register 与 heartbeat 共享一次计算。
- **工作目录清扫保护**：盐文件位于 work_dir 顶层的 ``.device-identity/``，
  该名字必须留在 ``maintenance._PROTECTED_WORKDIR_NAMES`` 里——work_dir 顶层的
  一切（含文件）都会被 TTL 清扫按 mtime 删除，盐被删掉等于指纹每周静默漂移。
"""

import hashlib
import logging
import os
import platform
import re
import socket
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List, NamedTuple, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

#: 指纹的十六进制长度（sha256），与 admin 侧 ``varchar(64)`` 同源。
DEVICE_FINGERPRINT_HEX_LENGTH = 64

#: 安装实例盐所在目录名（work_dir 顶层的受保护基础设施条目）。
DEVICE_IDENTITY_DIR_NAME = '.device-identity'

#: 探测命令的超时（防止 ``ioreg`` 之类挂死拖住启动）。
DEVICE_PROBE_TIMEOUT_SECONDS = 2.0

#: 盐的合法形态：UUID（首次生成即 ``uuid4``，故此处严格匹配 UUID）。
SALT_RE = re.compile(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    re.IGNORECASE,
)


class DeviceId(NamedTuple):
    """deviceId 与其来源（来源仅用于日志/测试断言，不是协议字段）。"""

    id: str
    source: str


@dataclass
class DeviceIdentityProbe:
    """采集面（可注入）。生产用 :func:`default_probe`，测试注入假实现即可覆盖
    三平台分支与全部失败分支，不需要真的读注册表/网卡。"""

    system: str
    read_text_file: Callable[[str], str]
    run_command: Callable[[Sequence[str]], str]
    hostname: str
    list_nic_macs: Callable[[], List[str]]
    windows_machine_guid: Callable[[], str]


def _default_read_text_file(path: str) -> str:
    return Path(path).read_text(encoding='utf-8')


def _default_run_command(argv: Sequence[str]) -> str:
    completed = subprocess.run(  # noqa: S603 - argv 为内部常量，无用户输入
        list(argv),
        capture_output=True,
        text=True,
        timeout=DEVICE_PROBE_TIMEOUT_SECONDS,
        check=True,
    )
    return completed.stdout


def _default_list_nic_macs() -> List[str]:
    """首个可用网卡的 MAC（小写冒号分隔），枚举顺序按接口名排序以保证确定性。

    与 node 侧 ``os.networkInterfaces()`` 的口径对齐：跳过全零 MAC（loopback
    在各平台上就是全零），取**排序后第一个**可用接口。psutil 在 Windows 上
    返回 ``aa-bb-cc-dd-ee-ff``、在 Linux 上返回 ``aa:bb:cc:dd:ee:ff``，统一
    归一化为冒号小写以保证两端同形。
    """
    import psutil  # 延迟导入：仅兜底路径需要，模块 import 期不依赖

    macs: List[str] = []
    try:
        interfaces = psutil.net_if_addrs()
    except Exception:  # pragma: no cover - 平台异常，由调用方 fail-open
        return macs
    for name in sorted(interfaces):
        for addr in interfaces[name]:
            if addr.family != psutil.AF_LINK:
                continue
            candidate = str(addr.address or '').strip().lower().replace('-', ':')
            if not candidate or candidate == '00:00:00:00:00:00':
                continue
            macs.append(candidate)
            break
    return macs


def _default_windows_machine_guid() -> str:
    import winreg  # 延迟导入：仅 Windows 路径需要

    with winreg.OpenKey(
        winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Microsoft\Cryptography'
    ) as key:
        value, _ = winreg.QueryValueEx(key, 'MachineGuid')
    return str(value)


def default_probe() -> DeviceIdentityProbe:
    return DeviceIdentityProbe(
        system=platform.system(),
        read_text_file=_default_read_text_file,
        run_command=_default_run_command,
        hostname=socket.gethostname(),
        list_nic_macs=_default_list_nic_macs,
        windows_machine_guid=_default_windows_machine_guid,
    )


def _try_read(fn: Callable[[], str], label: str) -> Optional[str]:
    """包一层 try/except 的窄工具：探测失败返回 None 而不是把异常抛给调用方。"""
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 - 探测面任何异常都必须 fail-open
        logger.debug('device identity probe step "%s" failed: %s', label, exc)
        return None


_PLATFORM_UUID_RE = re.compile(r'"IOPlatformUUID"\s*=\s*"([^"]+)"')


def resolve_device_id(probe: DeviceIdentityProbe) -> Optional[DeviceId]:
    """解析**这台机器**的稳定 deviceId；全部手段失败返回 None（fail-open）。

    顺序按「稳定性 x 可得性」排：注册表/文件优先（不含会变的网络信息），
    MAC + 主机名兜底（最弱——网卡增减或宿主改名都会变，但总比没有强）。
    """
    if probe.system == 'Windows':
        guid = _try_read(probe.windows_machine_guid, 'MachineGuid')
        if guid and guid.strip():
            return DeviceId(id=guid.strip(), source='windows-machine-guid')

    if probe.system == 'Linux':
        primary = _try_read(
            lambda: probe.read_text_file('/etc/machine-id'), '/etc/machine-id'
        )
        if primary and primary.strip():
            return DeviceId(id=primary.strip(), source='linux-machine-id')
        dbus = _try_read(
            lambda: probe.read_text_file('/var/lib/dbus/machine-id'),
            '/var/lib/dbus/machine-id',
        )
        if dbus and dbus.strip():
            return DeviceId(id=dbus.strip(), source='linux-dbus-machine-id')

    if probe.system == 'Darwin':
        out = _try_read(
            lambda: probe.run_command(
                ['ioreg', '-rd1', '-c', 'IOPlatformExpertDevice']
            ),
            'ioreg',
        )
        match = _PLATFORM_UUID_RE.search(out) if out else None
        if match and match.group(1):
            return DeviceId(id=match.group(1), source='darwin-platform-uuid')

    fallback = resolve_mac_hostname_id(probe)
    if fallback:
        return DeviceId(id=fallback, source='mac-hostname-fallback')
    return None


def resolve_mac_hostname_id(probe: DeviceIdentityProbe) -> Optional[str]:
    """兜底 deviceId：首个可用网卡的 MAC + 主机名的哈希（形态与 node 侧逐字节
    对齐：``sha256("fallback:{mac}:{hostname}")``，mac 缺失时为空串）。

    为什么带上主机名：容器/虚机常把 MAC 设成同一批固定值，单靠 MAC 会把不同
    宿主判成同一设备；主机名提供第二个维度。仍然很弱，故它是**最后**一个候选。
    """
    mac: Optional[str] = None
    try:
        candidates = probe.list_nic_macs() or []
    except Exception:  # noqa: BLE001 - 兜底路径不得抛
        candidates = []
    for candidate in candidates:
        normalized = str(candidate or '').strip().lower().replace('-', ':')
        if not normalized or normalized == '00:00:00:00:00:00':
            continue
        mac = normalized
        break

    hostname = (probe.hostname or '').strip()
    if not mac and not hostname:
        return None
    # 与 device_fingerprint 同款哈希：避免把 MAC/主机名原样带出机器。
    payload = 'fallback:{}:{}'.format(mac or '', hostname)
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def compute_device_fingerprint(device_id: str, install_salt: str) -> str:
    """``device_fingerprint = sha256(device_id + ":" + install_salt)``。

    纯函数、同输入同输出——这是三端一致性唯一可严格断言的一层（见模块头注
    「边界」）。
    """
    return hashlib.sha256(
        '{}:{}'.format(device_id, install_salt).encode('utf-8')
    ).hexdigest()


def device_salt_path(work_dir: str, kind: str) -> str:
    """盐文件路径：``<work_dir>/.device-identity/<kind>.salt``。

    放在**子目录**而非 work_dir 顶层裸文件：清扫只遍历顶层条目，保护一个目录名
    即可护住其中所有 kind；若按 kind 平铺成多个顶层文件，保护名单就要随 kind
    数量增长，漏加一个就是「指纹每周漂移」的静默故障。
    """
    return str(Path(work_dir) / DEVICE_IDENTITY_DIR_NAME / '{}.salt'.format(kind))


def load_or_create_install_salt(salt_path: str) -> 'tuple[str, bool]':
    """读取或首次生成安装实例盐。

    文件缺失/为空/形态非法（被截断、被别的程序写过）一律**重新生成**——盐的
    唯一要求是「本实例内稳定」，无法校验来源时重建比采信垃圾值安全。

    :returns: ``(salt, created)``；``created=True`` 表示本次新生成（供日志区分
        「复用既有安装身份」与「首次生成」）。
    """
    existing = _try_read(
        lambda: Path(salt_path).read_text(encoding='utf-8'), salt_path
    )
    trimmed = existing.strip() if existing else ''
    if trimmed and SALT_RE.match(trimmed):
        return trimmed, False

    salt = str(uuid.uuid4())
    target = Path(salt_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(salt, encoding='utf-8')
    try:
        # 与 node 侧 mode 0o600 对齐：盐本身不敏感（只上报哈希），但不给同机
        # 其他用户改写的机会——盐被换等于身份被顶替。
        target.chmod(0o600)
    except OSError:  # pragma: no cover - Windows 上 chmod 语义有限
        pass
    return salt, True


def resolve_instance_kind() -> str:
    """解析本执行器实例的执行器种类（盐的分域键）。

    python 执行器恒为 ``python``。``EXECUTOR_INSTANCE_KIND`` 可显式覆盖（运维
    在同一 work_dir 上跑多实例时用它分域）；node 侧同名变量，保持两端一致。
    """
    override = (__import__('os').environ.get('EXECUTOR_INSTANCE_KIND') or '').strip()
    if override:
        return override
    return 'python'


class DeviceIdentityResolver:
    """指纹解析器（**实例**，非模块级单例）。

    这样测试可直接构造并注入假探测面，天然不共享状态——模块级可变状态会跨测试
    文件泄漏（仓库已有此类前科）。
    """

    def __init__(
        self,
        work_dir: Callable[[], str],
        kind: Optional[str] = None,
        probe: Optional[DeviceIdentityProbe] = None,
    ) -> None:
        self._work_dir = work_dir
        self._kind = (kind or '').strip() or resolve_instance_kind()
        self._probe = probe if probe is not None else default_probe()
        self._cached: Optional[str] = None
        self._resolved = False
        self._warned = False

    def resolve(self) -> Optional[str]:
        """解析本实例的 device_fingerprint；**任何**失败都返回 None 且不抛。"""
        if self._resolved:
            return self._cached
        try:
            device_id = resolve_device_id(self._probe)
            if device_id is None:
                self._warn_once(
                    'device identity unavailable: no MachineGuid / machine-id / '
                    'IOPlatformUUID and no usable NIC MAC — deviceFingerprint '
                    'will be reported as absent (executor still registers normally)'
                )
                self._cached = None
                self._resolved = True
                return None

            salt_path = device_salt_path(self._work_dir(), self._kind)
            salt, created = load_or_create_install_salt(salt_path)
            if created:
                logger.info(
                    'Generated install salt for device identity (kind=%s): %s',
                    self._kind,
                    salt_path,
                )
            self._cached = compute_device_fingerprint(device_id.id, salt)
            logger.info(
                'Device identity resolved (deviceId source: %s, kind: %s)',
                device_id.source,
                self._kind,
            )
            self._resolved = True
            return self._cached
        except Exception as exc:  # noqa: BLE001 - fail-open 是硬约束
            self._warn_once(
                'device identity probe failed, reporting no deviceFingerprint: %s',
                exc,
            )
            self._cached = None
            self._resolved = True
            return None

    def _warn_once(self, message: str, *args: object) -> None:
        if self._warned:
            return
        self._warned = True
        logger.warning(message, *args)


_default_resolver: Optional[DeviceIdentityResolver] = None


def get_device_fingerprint() -> Optional[str]:
    """本进程的 device_fingerprint；未采集则采集一次并记住。

    register 与 heartbeat 共用（一次采集，纯内存后续读取）。
    """
    global _default_resolver
    if _default_resolver is None:
        from config import settings

        _default_resolver = DeviceIdentityResolver(
            work_dir=lambda: settings.work_dir
        )
    return _default_resolver.resolve()


def _reset_default_for_test() -> None:
    """测试出口：丢弃进程级默认解析器（含 memo 与 warn-once 状态）。"""
    global _default_resolver
    _default_resolver = None
