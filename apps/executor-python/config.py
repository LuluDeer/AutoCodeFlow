import os
import re
from urllib.parse import urlsplit

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# CONTRACT.md §1.1（D1）：任务声明的 Python 版本格式为 `X.Y`（主.次，无补丁号）。
# 该正则同时是执行器侧的命令注入闸门（NFR-03）：版本只有过白后才会拼进 uv argv。
RUNTIME_VERSION_PATTERN = re.compile(r'^\d+\.\d+$')

# NETOPT-C P2-1：心跳体 runningExecutionIds 的封顶值，以及 max_concurrent_tasks
# 的上界。**三端同值**（executor-node scheduler.ts / admin-api
# executor.service.ts 的 MAX_RUNNING_EXECUTION_IDS 均为 10_000）——它是
# 「执行器上报面」与「中台采纳面」的公共上界，任一处不同值都会造成越界部分被
# 静默丢弃，进而让在跑执行失去 stale sweep 的活性宽限。
#
# 修的是 python 侧一个**真缺陷**：此处原先没有上界（只有 reload 端点的 >=1
# 下界），而 scheduler.py 的心跳体把 ids 截断到 **200**（注释还谎称 "node
# parity"——node 从来是 10000）。两个缺口叠加的效果：
#
#   1. 运维把 MAX_CONCURRENT_TASKS 设成 >200（无上界拦截，真的放行）；
#   2. 第 201+ 个在跑执行从心跳的 runningExecutionIds 里消失；
#   3. admin stale sweep 以「id 是否出现在该数组里」为**唯一**活性判据
#      （scheduler.service.ts recoverStaleExecutions），未命中即按 stale 判死；
#   4. 于是健康长跑的任务（prepare 期 git clone + venv 可达 ~600s）被提前恢复
#      成 FAILED——正是 E1 引入该字段要消灭的误判，只是触发条件从「0 个 id」
#      变成了「>200 个 id」。
#
# 为什么上界是 10000 而不是另取一个数：
# ① 与 admin 的 sanitizeRunningExecutionIds 截顶、E9 的 maxConcurrentTasks
#    采纳域 1..10000 同源（三处必须同值）；
# ② 心跳 body 体积可行：admin main.ts 只给 /api/executions/callback 开了
#    55mb，/api/executors/heartbeat 走全局 **1mb**。UUID 形态 id 的单个 JSON
#    字面量 38 字节 → 10000 个 + 逗号 + 方括号 = 390,001 字节 ≈ 381 KiB，
#    占 1mb 上限的 37%，跑满封顶仍留 2.6× 余量，不会把心跳打成 413（413 会让
#    中台把执行器判 OFFLINE，比少报 id 严重得多——故这个上界必须算过账）。
MAX_RUNNING_EXECUTION_IDS = 10_000


def _validate_credential_free_http_url(value: str, setting_name: str) -> str:
    """Shared rule for every setting that is handed to uv as a URL.

    Credentials must not be embedded in such a URL: these settings have no
    credential transport and must never put a secret in argv, logs, or
    ``/proc``. A future controlled credentials mechanism can be added
    separately without changing these URLs' semantics.

    NOTE（B-3 边界）：执行器侧这两个 URL 是**强制无凭据**的（userinfo/query/
    fragment 一律拒绝），不存在 token 明文上网的问题，因此这里**不**强制
    https——内网镜像（D9 私有化模式的 ``http://mirror.internal:…``）是文档化
    拓扑（test_config_interpreters.py 的契约）。带凭据的 registry URL 的
    https 强制在 admin 侧实施（NPM_REGISTRY_URL / REGISTRY_PASS 等）。
    解释器下载内容完整性由 F-2 的 SHA-256 pin 兜底，不依赖镜像协议。
    """
    if not isinstance(value, str):
        raise ValueError(f'{setting_name} must be a valid http(s) URL')
    url = value.strip()
    if not url:
        return ''
    try:
        parsed = urlsplit(url)
        hostname = parsed.hostname
        # Accessing .port also rejects malformed ports before uv sees the URL.
        parsed.port
    except ValueError as exc:
        raise ValueError(f'{setting_name} must be a valid http(s) URL') from exc
    if parsed.scheme not in {'http', 'https'} or not parsed.netloc or not hostname:
        raise ValueError(f'{setting_name} must be a valid http(s) URL')
    if (
        parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(
            f'{setting_name} must not contain userinfo, query, or fragment; '
            'provide registry credentials through a controlled credentials mechanism'
        )
    return url


def validate_pypi_registry_url(value: str) -> str:
    """Validate the optional explicit PyPI index URL.

    The URL is passed as uv's ``--index-url`` argument. Credentials therefore
    must not be embedded in it: this setting has no credential transport and
    must never put a secret in argv, logs, or ``/proc``. A future controlled
    credentials mechanism can be added separately without changing this URL's
    semantics.
    """
    return _validate_credential_free_http_url(value, 'PYPI_REGISTRY_URL')


def validate_uv_python_install_mirror(value: str) -> str:
    """Validate the optional uv Python install mirror (D9/NFR-14).

    Same rules as ``PYPI_REGISTRY_URL`` (CONTRACT.md §3.2): http(s) only, no
    userinfo / query / fragment — the value ends up in uv argv (``--mirror``)
    and in ``UV_PYTHON_INSTALL_MIRROR``, so it must stay credential-free.
    """
    return _validate_credential_free_http_url(value, 'UV_PYTHON_INSTALL_MIRROR')


def validate_runtime_version(value: str) -> str:
    """Validate a declared Python runtime version (`X.Y`, CONTRACT.md §1.1).

    WS4 (routers/execute.py) uses this for the task-declared ``runtimeVersion``
    so the executor rejects malformed input with the same rule the admin side
    applies — before the value can reach any uv argv.
    """
    if not isinstance(value, str) or not RUNTIME_VERSION_PATTERN.fullmatch(value.strip()):
        raise ValueError(
            'Python runtime version must be "X.Y" (major.minor, e.g. "3.7", "3.13")'
        )
    return value.strip()


def _version_key(value: str) -> tuple[int, int]:
    """`X.Y` → (X, Y) for numeric range comparison (never string compare)."""
    major, minor = value.split('.', 1)
    return int(major), int(minor)


class Settings(BaseSettings):
    # Do not echo rejected environment values: registry credentials must not
    # appear in startup errors or logs either.
    model_config = SettingsConfigDict(
        env_file='.env', extra='ignore', hide_input_in_errors=True
    )

    app_name: str = 'executor-python-1'
    port: int = 8001
    executor_address: str = 'executor-python:8001'
    executor_address_public: str = ''
    admin_api_url: str = 'http://admin-api:3105'
    admin_api_url_internal: str = ''
    admin_api_url_external: str = ''
    executor_shared_token: str = ''
    executor_secret: str = ''
    work_dir: str = '/tmp/autocodeflow/tasks'
    max_concurrent_tasks: int = 10

    @field_validator('max_concurrent_tasks')
    @classmethod
    def _validate_max_concurrent_tasks(cls, value: int) -> int:
        """钳到 1..MAX_RUNNING_EXECUTION_IDS（与 node 同域）。

        NETOPT-D P3-5（node config.ts）为同一问题在 node 侧做的钳制：
        `Math.min(Math.max(envInt('MAX_CONCURRENT_TASKS', 10), 1), 10_000)`，
        注释写明「否则设到 50000 时 accept 放行 50000 而心跳体截到 10000，
        容量账本与心跳申报永久脱节」。python 此前**只有下界**（reload 端点手检
        >=1），env 与 reload 都没有上界——于是 MAX_CONCURRENT_TASKS=500 可以
        真的放行 500 并发，而心跳体只报得出 MAX_RUNNING_EXECUTION_IDS 条 id，
        第 201+（旧）/第 10001+（今）个在跑执行失去 stale sweep 的活性宽限。

        这里对 env 取**钳制**而非报错（与 node 逐语义一致）：env 是运维启动
        参数，钳到边界比让执行器起不来更符合「活性优先」。reload 端点走
        **400 拒绝**（同样对齐 node routes/config.ts 的手检），因为那是交互式
        推送、报错能立刻反馈给推送方。
        """
        if value < 1:
            return 1
        if value > MAX_RUNNING_EXECUTION_IDS:
            return MAX_RUNNING_EXECUTION_IDS
        return value

    # ARCH-32（ADR-015）: pull 派发模式——true 时执行器不依赖入站可达（NAT 内
    # 部署），改经 POST /executors/pull 长轮询取件；register 自报 dispatchMode
    # 'pull'，admin 侧据此走队列传输分支。默认 False = push 行为逐字节不变。
    executor_pull_mode: bool = False
    task_timeout_seconds: int = 300  # Default task timeout (5 minutes)
    heartbeat_interval_seconds: int = 30  # Heartbeat interval
    pypi_registry_url: str = ''  # Optional credential-free private PyPI index URL

    @field_validator('pypi_registry_url')
    @classmethod
    def _validate_pypi_registry_url(cls, value: str) -> str:
        return validate_pypi_registry_url(value)
    # R4-C P2: when true, an executor without a configured token refuses
    # /api/* requests (503) instead of the dev-mode allow-all behavior.
    require_token: bool = False
    # E-25（DEEP_REVIEW 0ef3bbe）：默认绑定 127.0.0.1——裸机部署不再暴露
    # 0.0.0.0。容器场景由 docker-compose 显式设 BIND_ADDRESS=0.0.0.0。
    bind_address: str = '127.0.0.1'
    # SEC-NEW-2: S7 gitRepo SSRF 守卫的私网放行开关（与 admin-api 侧
    # EXECUTOR_ALLOW_PRIVATE_NETWORK 同名镜像——同一变量在两侧语义对齐，
    # 拓扑描述见 routers/execute.py S7 段 ADR 注释）。默认 False = 现状
    # 安全姿态零变化（私网/loopback gitRepo 一律拒绝）。
    allow_private_network: bool = False
    # E8: disk TTL reclamation (node file-logger.ts parity — there TTL days
    # = max(1, LOG_RETENTION_DAYS || 7) and the sweep runs every 6h; python
    # adds a deferred first sweep so a fresh boot doesn't scan+delete while
    # executions from the previous process may still be recovering).
    disk_cleanup_ttl_days: int = 7
    disk_cleanup_interval_seconds: int = 6 * 60 * 60
    disk_cleanup_initial_delay_seconds: int = 600
    # P2/L-2: 磁盘水位红线（对齐 node config.diskWarnPercent /
    # diskCriticalPercent）。TTL 清扫基于 mtime，磁盘在 TTL 窗口内被撑满时无
    # 主动应对：告警水位触发减半 TTL 的紧急清理；临界水位由 accept_execution
    # 拒新任务（429/503）。计量失败按"无压力"处理，不误拒任务。
    disk_warn_percent: int = 90
    disk_critical_percent: int = 95

    @field_validator('disk_warn_percent', 'disk_critical_percent')
    @classmethod
    def _validate_disk_percent(cls, value: int) -> int:
        # 钳到 [1, 100]：0/负值会让水位门永远不触发（形同拆除防线），
        # >100 无意义。
        if value < 1 or value > 100:
            raise ValueError('disk watermark percent must be in [1, 100]')
        return value

    @model_validator(mode='after')
    def _validate_disk_threshold_order(self) -> 'Settings':
        # 告警水位必须低于临界水位，否则两条防线语义重叠（紧急清理永不触发
        # 而拒新任务提前生效）。
        if self.disk_warn_percent >= self.disk_critical_percent:
            raise ValueError(
                'DISK_WARN_PERCENT must be < DISK_CRITICAL_PERCENT'
            )
        return self

    # P3 (lightweight configuration): the executor-side `git clone --bare`
    # timeout and the callback-payload log truncation were previously hardcoded
    # (120s and 10000 chars). Expose them as settings with defaults equal to the
    # previous hardcoded values so default behavior is byte-identical; only
    # deployments that need different bounds opt in via env vars.
    git_clone_timeout_seconds: int = 120
    callback_logs_max_chars: int = 10000

    # ---- 解释器缓存池（FR-07/13/14/15、NFR-02/10/12/13/15、D8/D9/D11/D12）----
    # 解释器缓存池根目录：uv 把 `uv python install` 下载的解释器放在
    # `<dir>/cpython-<完整版本>-<平台>-none/`（CONTRACT.md §0 命名约定）。
    # 默认值**必须独立于 work_dir**（NFR-15）：TTL 清扫只扫 work_dir，物理
    # 隔离是解释器层豁免回收的第一道保险。
    uv_python_install_dir: str = '/data/interpreters'
    # 可选内网镜像（D9/NFR-14）：非空时以 `uv python install --mirror <url>`
    # 走内网源。校验规则与 PYPI_REGISTRY_URL 同源（http(s)、无凭据）。
    uv_python_install_mirror: str = ''
    # D11/NFR-13：单次解释器下载的**独立**超时预算。
    # NETOPT-6⑧ 声明收敛：本预算**不与任务剩余超时联动**——三个调用点
    # （execute.py 的 venv/glue/无依赖 python 三条 _ensure_interpreter 路径）
    # 恒传 _interpreter_download_timeout()（缺省 300s，独立计时）。此前注释
    # 声称"与任务剩余超时取较小者生效"与实现不符，已按真实语义改写。
    # 若要实现 min 联动属行为变更（长任务与短任务的下载预算将不同），需先
    # 拍板再动代码。
    interpreter_download_timeout_seconds: int = 300
    # D12/NFR-12/15：缓存池体积红线——单版本上限与总池上限，超限告警 + 回收
    # 最久未使用版本（maintenance 消费）。
    interpreter_single_version_mb: int = 250
    interpreter_total_gb: int = 4
    # D13/NFR-16：解释器下载全局有界并发（默认 2；1 = 旧版全局单队列）。
    # 不同版本写池内不同目录，uv 的"同目录并发写不安全"不跨版本；同版本由
    # per-version 锁去重。部署方可按网络/磁盘调 [1, 8]（越界在读取处钳制）。
    interpreter_download_concurrency: int = 2
    # CONTRACT.md §1.1：可声明的 Python 版本区间（默认 3.7~3.14，部署方可收紧）。
    # 在线可下载下界固定为 3.8（见 ONLINE_DOWNLOAD_MIN），3.7 只能由部署方
    # 离线预填缓存卷获得。
    python_runtime_version_min: str = '3.7'
    python_runtime_version_max: str = '3.14'

    @field_validator('uv_python_install_mirror')
    @classmethod
    def _validate_uv_python_install_mirror(cls, value: str) -> str:
        return validate_uv_python_install_mirror(value)

    @field_validator('python_runtime_version_min', 'python_runtime_version_max')
    @classmethod
    def _validate_python_runtime_version_bound(cls, value: str) -> str:
        return validate_runtime_version(value)

    @field_validator('interpreter_download_timeout_seconds')
    @classmethod
    def _validate_interpreter_download_timeout(cls, value: int) -> int:
        # 下界 1s（0/负值会让每次下载立即超时）；上界对齐既有 timeout 语义上限，
        # 避免一次悬挂下载把执行槽钉死一整天以上。
        if value < 1 or value > 86400:
            raise ValueError('INTERPRETER_DOWNLOAD_TIMEOUT_SECONDS must be in [1, 86400]')
        return value

    @field_validator('interpreter_single_version_mb')
    @classmethod
    def _validate_interpreter_single_version_mb(cls, value: int) -> int:
        # pbs 单版本解压后 ≈57MB（CONTRACT.md §0）；小于 64MB 的红线会让任何
        # 真实解释器一入池即超限，视为配置错误而非合法收紧。
        if value < 64:
            raise ValueError('INTERPRETER_SINGLE_VERSION_MB must be >= 64')
        return value

    @field_validator('interpreter_total_gb')
    @classmethod
    def _validate_interpreter_total_gb(cls, value: int) -> int:
        if value < 1:
            raise ValueError('INTERPRETER_TOTAL_GB must be >= 1')
        return value

    @field_validator('git_clone_timeout_seconds', 'callback_logs_max_chars')
    @classmethod
    def _validate_positive_bound(cls, value: int) -> int:
        # Lower bound 1: 0/negative would make the clone time out instantly or
        # truncate every log payload to nothing. Mirrors the download-timeout
        # guard; execute.py additionally clamps defensively at read time.
        if value < 1:
            raise ValueError('this setting must be >= 1')
        return value

    # ---- 任务沙箱与资源限制（SEC-NEW: F-1/B-1）----
    # F-1: 任务代码沙箱。'' = 不启用（本地开发/测试保持既有行为）；
    # 'bwrap' = 用 bubblewrap 用户命名空间 + 只读根文件系统 + PrivateTmp 隔离
    # 任务进程（生产容器由 docker-compose 显式开启）。配置了 bwrap 但二进制
    # 缺失时任务**直接失败**（fail-closed），绝不静默降级为无沙箱运行。
    # bwrap 用户命名空间同时阻断任务读取执行器宿主进程的 /proc/<pid>/environ
    # （跨命名空间 uid 映射后 ptrace 访问被拒），这是 F-1 对
    # EXECUTOR_SECRET / EXECUTION_CALLBACK_SECRET 外泄的核心缓解。
    task_sandbox: str = ''
    # B-1: 单任务资源上限（POSIX RLIMIT_*，经 preexec_fn 施加于任务进程树；
    # Windows 无等价原语，该项在 win32 上跳过并记录 warning）。
    # memory 用 RLIMIT_AS（地址空间字节数）：`a=[0]*10**10` 类任务在**子进程**
    # 内 OOM，而不是拖垮执行器上所有并发任务。0 = 不设该限。
    task_memory_limit_mb: int = 2048
    # CPU 秒数上限；0 = 回落为「任务超时 + 60s 宽限」（任务超时本身会 kill，
    # 这里是防 timeout 未生效的第二道保险）。
    task_cpu_limit_seconds: int = 0
    # 单文件写上限（MB）；0 = 不设。防止任务把磁盘写爆（日志另有独立上限）。
    task_fsize_limit_mb: int = 4096
    # 打开文件描述符上限；0 = 不设。防止 fd 耗尽拖累同机其他进程。
    task_nofile_limit: int = 1024
    # 进程数上限（RLIMIT_NPROC，按真实 UID 计——任务与执行器同 UID 时同样
    # 约束执行器，故默认 0 = 不设，仅显式开启）；0 = 不设。
    task_nproc_limit: int = 0

    @field_validator('task_sandbox')
    @classmethod
    def _validate_task_sandbox(cls, value: str) -> str:
        if value not in ('', 'bwrap'):
            raise ValueError("TASK_SANDBOX must be '' or 'bwrap'")
        return value

    @field_validator('task_memory_limit_mb', 'task_cpu_limit_seconds',
                     'task_fsize_limit_mb', 'task_nofile_limit', 'task_nproc_limit')
    @classmethod
    def _validate_task_limit_non_negative(cls, value: int) -> int:
        if value < 0:
            raise ValueError('task resource limits must be >= 0 (0 disables the limit)')
        return value

    # ---- 解释器下载完整性（F-2）----
    # uv_python_sha256_pins: { '<major>.<minor>': '<sha256-hex>' }。部署方在
    # 首次从可信源安装解释器后记录（见 interpreters.py 的 pin 记录辅助函数），
    # 此后每次在线下载都会把池内 python 二进制的 SHA-256 与 pin 比对
    # （constant-time），不匹配 → 判定 corrupt（绝不运行）。未配置 pin 的版本
    # 只做「可执行 + --version 版本匹配」抽查，并在 pool_summary 中标记
    # integrity='unverified'。
    # 支持两种注入方式：JSON 环境变量 UV_PYTHON_SHA256_PINS='{"3.12":"<hex>"}'，
    # 或逐版本变量 UV_PYTHON_SHA256_3_12=<hex>（后者优先级更高，二者可混用）。
    uv_python_sha256_pins: dict[str, str] = {}

    @field_validator('uv_python_sha256_pins')
    @classmethod
    def _validate_sha256_pins(cls, value: dict[str, str]) -> dict[str, str]:
        hex_re = re.compile(r'^[0-9a-fA-F]{64}$')
        for version, digest in value.items():
            if not RUNTIME_VERSION_PATTERN.fullmatch(version):
                raise ValueError(
                    f'UV_PYTHON_SHA256_PINS key {version!r} must be "X.Y"'
                )
            if not isinstance(digest, str) or not hex_re.fullmatch(digest.strip()):
                raise ValueError(
                    f'UV_PYTHON_SHA256_PINS[{version!r}] must be a 64-char SHA-256 hex digest'
                )
        return {v: d.strip() for v, d in value.items()}

    @model_validator(mode='after')
    def _merge_sha256_pin_env(self) -> 'Settings':
        """把逐版本环境变量 UV_PYTHON_SHA256_<MAJ>_<MIN> 并入 pins（覆盖 JSON）。"""
        merged = dict(self.uv_python_sha256_pins)
        for key, value in os.environ.items():
            prefix = 'UV_PYTHON_SHA256_'
            if not key.upper().startswith(prefix):
                continue
            rest = key.upper()[len(prefix):]
            if '_' not in rest:
                continue
            major, minor = rest.split('_', 1)
            if not major.isdigit() or not minor.isdigit():
                continue
            version = f'{int(major)}.{int(minor)}'
            digest = value.strip()
            if not re.fullmatch(r'[0-9a-fA-F]{64}', digest):
                raise ValueError(
                    f'{key} must be a 64-char SHA-256 hex digest'
                )
            merged[version] = digest.lower()
        self.uv_python_sha256_pins = merged
        return self

    @model_validator(mode='after')
    def _validate_interpreter_settings(self) -> 'Settings':
        """跨字段校验：区间下界 ≤ 上界；单版本红线不得大于总池红线。"""
        if _version_key(self.python_runtime_version_min) > _version_key(
            self.python_runtime_version_max
        ):
            raise ValueError(
                'PYTHON_RUNTIME_VERSION_MIN must not be greater than PYTHON_RUNTIME_VERSION_MAX'
            )
        if self.interpreter_single_version_mb > self.interpreter_total_gb * 1024:
            raise ValueError(
                'INTERPRETER_SINGLE_VERSION_MB must not exceed INTERPRETER_TOTAL_GB * 1024'
            )
        return self


settings = Settings()

# CONTRACT.md §1.1 / §0.1：uv 0.8.17 的在线可下载区间为 **3.8 ~ 3.14**（实测）。
# `< 3.8`（即 3.7 / 3.6）在线下载必然失败（`uv python install 3.7` →
# `error: No download found for request: cpython-3.7-<platform>`），只能由部署方
# 离线预填解释器缓存卷获得（python-build-standalone 3.7.9 的
# `python/install/*` 放入 `<UV_PYTHON_INSTALL_DIR>/cpython-3.7.9-<uv平台三元组>-none/`
# 后 uv 即识别）。`interpreters.is_online_downloadable` 以此常量为界。
#
# ⚠ 平台三元组必须是 **uv 自己的词汇**（`linux-x86_64-gnu` / `windows-x86_64-none`
# / `macos-x86_64-none`），**不是** pbs 的发布名（`x86_64-unknown-linux-gnu` /
# `x86_64-pc-windows-msvc`）——实测 uv 对不匹配的目录名**静默忽略**（不报错，
# 只是永不出现在 `uv python list --only-installed` 里）。详见 CONTRACT.md §0.2。
ONLINE_DOWNLOAD_MIN = '3.8'

# EXE-VER-1: 执行器版本上报源（main._register_payload 与 scheduler 心跳共用，
# 单一定义处）。升级执行器 = 重新安装 / 重跑 install-cmd，版本随之跟进；
# 中心端 EXECUTOR_MIN_VERSION 门禁按此值判定（低于下限 register 403）。
# R5（python_task_multiversion）：1.0.0 → 2.0.0 —— 新增 interpreters 上报、
# 版本化 venv（--python）与 zip 整包渠道，属执行器能力变更，必须版本可见。
EXECUTOR_VERSION = '2.0.0'

# PROTOCOL-VER（B-3/U-2）：协议版本与实现版本（EXECUTOR_VERSION）**解耦**。
# 随 register 载荷上报，中台按兼容矩阵分支（低于 supportedMin 只 warn + 兜底，
# 不拒绝注册——与 EXECUTOR_MIN_VERSION 实现版本门禁是两套闸）。演进规则见
# packages/executor-protocol/protocol.json 的 `versioning` 段：新增可选字段时
# bump 此值；不向后兼容改动必须同时 bump $schemaVersion 与 PROTOCOL_VERSION。
# 两侧（executor-python / executor-node config.ts）必须同值。
#
# ARCH-33（ADR-016）：1 → 2。新增 pull 响应的可选 `commands` 数组与
# /api/executors/command-result 结果上报端点。中台必须能区分「该执行器认识
# commands」与「不认识」，否则会把控制命令发进一个被静默忽略的字段里。
# 中台侧门禁：PROTOCOL_CONTROL_PLANE_MIN = 2（protocol-compat.util.ts）。
# `supportedMinProtocolVersion` 保持 1——旧执行器照常注册，只是收不到命令。
#
# ARCH-36（ADR-017 阶段 2）：2 → 3。register/heartbeat 新增**可选**
# `deviceFingerprint`（device_identity.py）。中台据此区分「v3 执行器**应**上报
# 指纹」与「存量执行器从未上报」——前者缺失 = 采集失败，后者缺失 = 预期为空。
#
# E-01-RPT（生产实证：RPA5「当前运行任务 1/10、活性上报 0 条」）：3 → 4。
# heartbeat 新增**可选** `reservedSlots`——pull 长轮询「已预留但尚未认领」的
# 槽位数。E-01 让预留计入 runningTaskCount（防超卖），而 runningExecutionIds
# 来自另一个账本，故空闲执行器稳态上报「1 + []」，中台详情页恒亮「活性上报
# 0 条，与运行计数 1 不一致」。中台据此区分「v4 执行器上报了预留数（可换算
# 实际运行数）」与「旧执行器未上报（按已占槽位显示）」——没有这道区分，中台
# 只能猜，而猜错的方向（把预留当空闲）恰好会重开 E-01 要关闭的超卖竞态。
# 方向为**执行器→中台**，PROTOCOL_CONTROL_PLANE_MIN 仍为 2。
PROTOCOL_VERSION = 4

