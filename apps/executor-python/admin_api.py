from config import settings


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
