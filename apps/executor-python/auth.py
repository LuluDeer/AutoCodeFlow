"""SEC-03: Executor token management with expiration and rotation support."""
import hmac
import logging
import os
from datetime import datetime, timedelta
from typing import Any, Optional

from fastapi import Header, HTTPException, status
import httpx
from admin_api import build_admin_api_url, get_admin_api_base_url
from config import settings
from startup_identity import executor_startup_id

logger = logging.getLogger(__name__)

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

# R9 (round-9, W3 parity with executor-node admin-envelope.ts): the
# executor's CURRENT stored tokenHash, as echoed by admin-api on register,
# POST /token and heartbeat responses. Keeping it in sync with the admin
# side is the N26 invariant for per-execution callback tokens (the HMAC
# source secret must equal whatever the admin will verify against). This
# round only stores + debug-logs it; a future executor-python callback-token
# signer (N23 parity) will consume it via get_executor_token_hash().
_executor_token_hash: Optional[str] = None


def _unwrap_envelope(payload: Any) -> Any:
    """R9: strip admin-api's global ``{code, message, data}`` response
    envelope (see apps/admin-api/src/common/interceptors/response.interceptor.ts).

    Mirrors executor-node's ``unwrapAdminResponseData`` and acf-cli's
    ``unwrap()``: when the payload carries the envelope markers (a ``data``
    key plus ``code``/``message``), return the inner ``data``; bare
    (non-enveloped) payloads — older admins, direct service calls, unit-test
    fixtures — are returned unchanged so callers can read fields from either
    shape.
    """
    if (
        isinstance(payload, dict)
        and 'data' in payload
        and ('code' in payload or 'message' in payload)
    ):
        return payload.get('data')
    return payload


def get_executor_token_hash() -> Optional[str]:
    """Return the tokenHash most recently adopted from an admin-api response."""
    return _executor_token_hash


def adopt_executor_token_hash(raw: Any) -> None:
    """Adopt ``tokenHash`` from an admin-api response payload.

    Accepts both the enveloped ``{code,message,data:{tokenHash}}`` and the
    bare ``{tokenHash}`` shape. No-op when the field is absent, empty, or
    not a string; logs at debug level when the value actually changes.
    """
    global _executor_token_hash
    payload = _unwrap_envelope(raw)
    token_hash = payload.get('tokenHash') if isinstance(payload, dict) else None
    if isinstance(token_hash, str) and token_hash and token_hash != _executor_token_hash:
        _executor_token_hash = token_hash
        logger.debug('Adopted executor tokenHash from admin-api response')


def _get_admin_api_url() -> str:
    """Get the appropriate Admin API base URL based on configuration."""
    return get_admin_api_base_url()


async def _fetch_token() -> Optional[str]:
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
                    # R9 (round-9, W2 parity with executor-node): the
                    # process-life identity lets admin-api make this endpoint
                    # idempotent — a same-startupId re-fetch returns the
                    # CURRENT token instead of rotating (N4 register
                    # semantics). Without it the admin falls back to the
                    # legacy 60s rotation window.
                    'startupId': executor_startup_id,
                },
                headers=headers,
            )
            # R9: the token endpoint is a Nest POST — it answers 201, not 200.
            # The old `== 200` check silently dropped every success.
            if 200 <= response.status_code < 300:
                # R9 (root fix): admin-api's global ResponseInterceptor wraps
                # the payload in {code,message,data}; reading `token` off the
                # raw body yielded None forever, so the dynamic token never
                # worked and every caller fell back to the static token.
                payload = _unwrap_envelope(response.json())
                token = payload.get('token') if isinstance(payload, dict) else None
                if not (isinstance(token, str) and token):
                    logger.warning('_fetch_token: admin response carried no token')
                    return None
                # R9 (W3): adopt the tokenHash that matches this token so the
                # callback-token HMAC key stays in sync with admin-api.
                adopt_executor_token_hash(response.json())
                return token
    except Exception as e:
        # Fall back to static token if dynamic token fetch fails
        logger.warning("Dynamic token fetch failed (will use static): %s", e)
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