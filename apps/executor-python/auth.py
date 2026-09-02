"""SEC-03: Executor token management with expiration and rotation support."""
import hmac
import os
from datetime import datetime, timedelta
from fastapi import Header, HTTPException, status
import httpx
from admin_api import build_admin_api_url, get_admin_api_base_url
from config import settings

def _get_static_token() -> str:
    """Read static token from env each call so test fixtures can override it."""
    return os.environ.get('EXECUTOR_SHARED_TOKEN') or os.environ.get('EXECUTOR_SECRET') or ''


def get_static_token() -> str | None:
    """Get the shared bootstrap token for initial executor registration."""
    return _get_static_token() or None

# Dynamic token storage (refreshed periodically)
_dynamic_token = None
_token_expires_at = None
_token_refresh_interval = 30 * 60  # 30 minutes


def _get_admin_api_url() -> str:
    """Get the appropriate Admin API base URL based on configuration."""
    return get_admin_api_base_url()


async def _fetch_token() -> str | None:
    """Fetch a fresh token from admin-api."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            # Issue1 fix: only add Authorization header when token is non-empty
            headers = {}
            static_token = _get_static_token()
            if static_token:
                headers['Authorization'] = f'Bearer {static_token}'
            
            response = await client.post(
                build_admin_api_url('/executors/token'),
                json={
                    'address': settings.executor_address_public or settings.executor_address,
                    'appName': settings.app_name,
                },
                headers=headers,
            )
            if response.status_code == 200:
                data = response.json()
                return data.get('token')
    except Exception as e:
        # Fall back to static token if dynamic token fetch fails
        import logging as _logging
        _logging.getLogger(__name__).warning("Dynamic token fetch failed (will use static): %s", e)
    return None


async def _refresh_token_if_needed() -> None:
    """Refresh token if expired or about to expire."""
    global _dynamic_token, _token_expires_at
    
    now = datetime.now()
    # Refresh if no token, expired, or within 5 minutes of expiration
    if _token_expires_at is None or now >= _token_expires_at - timedelta(minutes=5):
        new_token = await _fetch_token()
        if new_token:
            _dynamic_token = new_token
            _token_expires_at = now + timedelta(seconds=_token_refresh_interval)


def require_token_enabled() -> bool:
    """R4-C P2: REQUIRE_TOKEN=true makes an unconfigured token fail closed
    (503) instead of the dev-mode allow-all. Read from the environment at call
    time (same pattern as _get_static_token) so the live value is honored;
    falls back to the config-file default."""
    value = os.environ.get('REQUIRE_TOKEN', '').strip().lower()
    if value:
        return value in ('1', 'true', 'yes', 'on')
    return bool(getattr(settings, 'require_token', False))


async def verify_token(authorization: str = Header(default='')) -> None:
    """Dependency: validate Bearer token from dynamic token or fallback to static."""
    # Try to refresh token if needed (failure is non-fatal — fall back to static token)
    try:
        await _refresh_token_if_needed()
    except Exception:
        pass
    
    # Priority: dynamic token first, then static token
    valid_tokens = []
    if _dynamic_token:
        valid_tokens.append(_dynamic_token)
    static_token = _get_static_token()
    if static_token:
        valid_tokens.append(static_token)
    
    # If no tokens configured at all, allow all requests (dev mode)
    if not valid_tokens:
        # R4-C P2: dev-mode allow-all means the executor accepts arbitrary
        # code execution from anyone who can reach the port. When
        # REQUIRE_TOKEN=true is set, fail closed instead.
        if require_token_enabled():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail='No executor token is configured and REQUIRE_TOKEN=true; refusing unauthenticated execution',
            )
        import logging as _logging
        _logging.getLogger(__name__).warning(
            'No executor token configured — dev mode is allowing unauthenticated requests'
        )
        return
    
    scheme, _, token = authorization.partition(' ')
    token_valid = scheme.lower() == 'bearer' and any(
        hmac.compare_digest(token, vt) for vt in valid_tokens
    )
    if not token_valid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='Invalid or missing executor token',
            headers={'WWW-Authenticate': 'Bearer'},
        )


async def get_current_token() -> str | None:
    """Get the current valid token (for outgoing requests to admin-api)."""
    await _refresh_token_if_needed()
    return _dynamic_token or _get_static_token() or None