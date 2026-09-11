from urllib.parse import urlsplit

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def validate_pypi_registry_url(value: str) -> str:
    """Validate the optional explicit PyPI index URL.

    The URL is passed as uv's ``--index-url`` argument. Credentials therefore
    must not be embedded in it: this setting has no credential transport and
    must never put a secret in argv, logs, or ``/proc``. A future controlled
    credentials mechanism can be added separately without changing this URL's
    semantics.
    """
    if not isinstance(value, str):
        raise ValueError('PYPI_REGISTRY_URL must be a valid http(s) URL')
    url = value.strip()
    if not url:
        return ''
    try:
        parsed = urlsplit(url)
        hostname = parsed.hostname
        # Accessing .port also rejects malformed ports before uv sees the URL.
        parsed.port
    except ValueError as exc:
        raise ValueError('PYPI_REGISTRY_URL must be a valid http(s) URL') from exc
    if parsed.scheme not in {'http', 'https'} or not parsed.netloc or not hostname:
        raise ValueError('PYPI_REGISTRY_URL must be a valid http(s) URL')
    if (
        parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(
            'PYPI_REGISTRY_URL must not contain userinfo, query, or fragment; '
            'provide registry credentials through a controlled credentials mechanism'
        )
    return url


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


settings = Settings()
