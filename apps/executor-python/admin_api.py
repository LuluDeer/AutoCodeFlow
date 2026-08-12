from config import settings


def get_admin_api_base_url() -> str:
    """Return the configured Admin API service URL without a trailing slash.

    Priority is external URL, then internal URL, then the default URL.
    """
    return (settings.admin_api_url_external or settings.admin_api_url_internal or settings.admin_api_url).rstrip('/')


def build_admin_api_url(path: str) -> str:
    """Build a full Admin API endpoint URL.

    ``path`` should be the API path without the global ``/api`` prefix, for example
    ``/executors/heartbeat``. For backwards compatibility, if the configured base
    URL already ends with ``/api`` we avoid appending the prefix twice.
    """
    base_url = get_admin_api_base_url()
    normalized_path = '/' + path.lstrip('/')
    api_base = base_url if base_url.endswith('/api') else f'{base_url}/api'
    return f'{api_base}{normalized_path}'
