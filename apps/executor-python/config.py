import re
from urllib.parse import urlsplit

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# CONTRACT.md §1.1（D1）：任务声明的 Python 版本格式为 `X.Y`（主.次，无补丁号）。
# 该正则同时是执行器侧的命令注入闸门（NFR-03）：版本只有过白后才会拼进 uv argv。
RUNTIME_VERSION_PATTERN = re.compile(r'^\d+\.\d+$')


def _validate_credential_free_http_url(value: str, setting_name: str) -> str:
    """Shared rule for every setting that is handed to uv as a URL.

    Credentials must not be embedded in such a URL: these settings have no
    credential transport and must never put a secret in argv, logs, or
    ``/proc``. A future controlled credentials mechanism can be added
    separately without changing these URLs' semantics.
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

    # ---- 解释器缓存池（FR-07/13/14/15、NFR-02/10/12/13/15、D8/D9/D11/D12）----
    # 解释器缓存池根目录：uv 把 `uv python install` 下载的解释器放在
    # `<dir>/cpython-<完整版本>-<平台>-none/`（CONTRACT.md §0 命名约定）。
    # 默认值**必须独立于 work_dir**（NFR-15）：TTL 清扫只扫 work_dir，物理
    # 隔离是解释器层豁免回收的第一道保险。
    uv_python_install_dir: str = '/data/interpreters'
    # 可选内网镜像（D9/NFR-14）：非空时以 `uv python install --mirror <url>`
    # 走内网源。校验规则与 PYPI_REGISTRY_URL 同源（http(s)、无凭据）。
    uv_python_install_mirror: str = ''
    # D11/NFR-13：单次解释器下载的独立超时预算（与任务剩余超时取较小者生效）。
    interpreter_download_timeout_seconds: int = 300
    # D12/NFR-12/15：缓存池体积红线——单版本上限与总池上限，超限告警 + 回收
    # 最久未使用版本（maintenance 消费）。
    interpreter_single_version_mb: int = 250
    interpreter_total_gb: int = 4
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
