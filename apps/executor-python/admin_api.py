import asyncio
import logging
from urllib.parse import urlparse

from config import settings

logger = logging.getLogger(__name__)


def _normalize_configured_url(url: str | None) -> str:
    return (url or '').strip().rstrip('/')


def get_admin_api_base_url() -> str:
    """Return the configured Admin API service URL without a trailing slash.

    Priority is external URL, then internal URL, then the default URL.
    """
    for url in (settings.admin_api_url_external, settings.admin_api_url_internal, settings.admin_api_url):
        normalized = _normalize_configured_url(url)
        if normalized:
            return normalized
    return ''


def build_admin_api_url(path: str) -> str:
    """Build a full Admin API endpoint URL.

    ``path`` should be the API path without the global ``/api`` prefix, for example
    ``/executors/heartbeat``. For backwards compatibility, if the configured base
    URL or path already includes ``/api`` we avoid appending the prefix twice.
    """
    base_url = get_admin_api_base_url()
    normalized_path = '/' + path.lstrip('/')
    if normalized_path == '/api':
        normalized_path = ''
    elif normalized_path.startswith('/api/'):
        normalized_path = normalized_path[4:]
    api_base = base_url if base_url.endswith('/api') else f'{base_url}/api'
    return f'{api_base}{normalized_path}'


async def check_admin_api_connectivity(
    attempts: int = 3,
    initial_delay_seconds: float = 1.0,
    timeout_seconds: float = 5.0,
) -> bool:
    """Probe Admin API health at startup and retry with exponential backoff."""
    health_url = build_admin_api_url('/health')
    delay = initial_delay_seconds

    for attempt in range(1, attempts + 1):
        try:
            # 网络性能审计（2026-09-18）：改用 O-24 共享连接池（延迟导入避免
            # admin_api↔scheduler 模块级环）。启动探测 3 次尝试复用同一池。
            from scheduler import get_http_client
            client = get_http_client()
            response = await client.get(health_url, timeout=timeout_seconds)
            response.raise_for_status()
            logger.info('Admin API connectivity check succeeded: %s', get_admin_api_base_url())
            return True
        except Exception as exc:
            logger.warning(
                'Admin API connectivity check failed for %s (attempt %s/%s): %s',
                get_admin_api_base_url(),
                attempt,
                attempts,
                exc,
            )

        if attempt < attempts:
            logger.warning('Admin API is not reachable yet; retrying in %.1fs', delay)
            await asyncio.sleep(delay)
            delay *= 2

    logger.warning(
        'Admin API connectivity check failed after startup retries; executor will continue and heartbeat will retry in the background.'
    )
    return False


def rewrite_package_url_to_admin_base(package_url: str) -> str:
    """把 admin 下发的 packageUrl 同源改写成本执行器自己配置的 admin 地址。

    2026-10-30 生产故障（与 node 侧 ``rewritePackageUrlToAdminBase`` 同源修复）：
    中台 ``API_BASE_URL`` 是**全局单一**值，一个中台同时服务局域网执行器与
    跨网执行器时必然二选一：
      · 填公网域名 → 局域网执行器每次下包都绕公网 + frp 隧道回来，TLS 握手中断
        概率被放大，表现为偶发 ``package_fetch_failed``；
      · 填内网地址 → 跨网执行器不可达。
    执行器自己知道「我怎么访问中台」（``ADMIN_API_URL*``，心跳/回调/pull 用的
    就是它），所以下载也走同一条路。

    改写条件（全部满足才改，否则原样返回）：
      1. package_url 是 http(s) 绝对 URL；
      2. 路径以 ``/uploads/`` 开头（只有这条路径由本中台托管）；
      3. 解析出的 origin 与 admin 基址 origin 不同（同源无需改写）；
      4. admin 基址非空且是 http(s)。
    只替换 scheme+host+port，**路径与查询串逐字节保留**（内容寻址路径含
    sha256，改一个字就 404）。
    """
    try:
        parsed = urlparse(package_url)
        if parsed.scheme not in ('http', 'https'):
            return package_url
        if not parsed.path.startswith('/uploads/'):
            return package_url

        base = get_admin_api_base_url()
        if not base:
            return package_url
        # 基址可能带 /api 后缀，与 build_admin_api_url 的兼容逻辑一致
        if base.endswith('/api'):
            base = base[: -len('/api')]
        base_parsed = urlparse(base)
        if base_parsed.scheme not in ('http', 'https'):
            return package_url
        if not base_parsed.netloc:
            return package_url

        target_origin = f'{parsed.scheme}://{parsed.netloc}'
        base_origin = f'{base_parsed.scheme}://{base_parsed.netloc}'
        if target_origin == base_origin:
            return package_url

        rewritten = f'{base_origin}{parsed.path}'
        if parsed.query:
            rewritten = f'{rewritten}?{parsed.query}'
        return rewritten
    except Exception:  # noqa: BLE001 - 改写失败一律回退原值，交给下游 SSRF 闸
        return package_url
