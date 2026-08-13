import asyncio
import logging

import httpx

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
            async with httpx.AsyncClient(timeout=timeout_seconds) as client:
                response = await client.get(health_url)
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
