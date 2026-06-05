"""SEC-03: Executor token management with expiration and rotation support."""
import os
from datetime import datetime, timedelta
from fastapi import Header, HTTPException, status
import httpx
from config import settings

# Static token for backward compatibility (falls back if dynamic token not available)
_STATIC_TOKEN = os.environ.get('EXECUTOR_SHARED_TOKEN') or os.environ.get('EXECUTOR_SECRET') or ''

# Dynamic token storage (refreshed periodically)
_dynamic_token = None
_token_expires_at = None
_token_refresh_interval = 30 * 60  # 30 minutes


def _get_admin_api_url() -> str:
    """Get the appropriate admin API URL based on configuration."""
    # Priority: external URL if configured, then internal, then default
    if settings.admin_api_url_external:
        return settings.admin_api_url_external
    if settings.admin_api_url_internal:
        return settings.admin_api_url_internal
    return settings.admin_api_url


async def _fetch_token() -> str | None:
    """Fetch a fresh token from admin-api."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            # Issue1 fix: only add Authorization header when token is non-empty
            headers = {}
            if _STATIC_TOKEN:
                headers['Authorization'] = f'Bearer {_STATIC_TOKEN}'
            
            response = await client.post(
                f'{_get_admin_api_url()}/api/executors/token',
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
        pass
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


async def verify_token(authorization: str = Header(default='')) -> None:
    """Dependency: validate Bearer token from dynamic token or fallback to static."""
    # Try to refresh token if needed
    await _refresh_token_if_needed()
    
    # Priority: dynamic token first, then static token
    valid_tokens = []
    if _dynamic_token:
        valid_tokens.append(_dynamic_token)
    if _STATIC_TOKEN:
        valid_tokens.append(_STATIC_TOKEN)
    
    # If no tokens configured at all, allow all requests (dev mode)
    if not valid_tokens:
        return
    
    scheme, _, token = authorization.partition(' ')
    if scheme.lower() != 'bearer' or token not in valid_tokens:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='Invalid or missing executor token',
            headers={'WWW-Authenticate': 'Bearer'},
        )


async def get_current_token() -> str | None:
    """Get the current valid token (for outgoing requests to admin-api)."""
    await _refresh_token_if_needed()
    return _dynamic_token or _STATIC_TOKEN