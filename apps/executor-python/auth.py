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
    """Read static token each call so test fixtures can override it.

    真机冒烟（round-16）修复：pydantic-settings 从 .env 读入的值**不会**
    进 os.environ——Docker 部署（真环境变量）一直正常，但裸机只配 .env 时
    静态 token 静默为空，REQUIRE_TOKEN=true 下注册/心跳全 401。
    优先级：真环境变量（容器/fixture 覆盖语义不变）> settings（.env）> 空。
    """
    return (
        os.environ.get('EXECUTOR_SHARED_TOKEN')
        or settings.executor_shared_token
        or os.environ.get('EXECUTOR_SECRET')
        or settings.executor_secret
        or ''
    )


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


async def force_token_refresh() -> Optional[str]:
    """R11 (round-11, port of executor-node R10 gap #3 ``forceTokenRefresh``):
    force an immediate token re-fetch, bypassing the 30-minute refresh
    schedule.

    Used by :func:`request_with_self_heal` when an outbound admin-api request
    comes back 401: the stored per-executor token was rotated out from under
    this process (e.g. the admin-UI rotate-token button), and the only way to
    converge is to re-hit POST /token — which is authenticated with the STATIC
    (shared bootstrap) token and whose response ``_fetch_token`` already uses
    to adopt the matching tokenHash (R9/W3). So one call here heals BOTH the
    bearer credential and the N26 per-execution callback HMAC secret.

    Unlike executor-node there is no fetch-failure backoff to preserve: this
    module's ``_refresh_token_if_needed`` only sets ``_token_expires_at`` on a
    *successful* fetch, so a failed fetch leaves the schedule untouched and the
    next call retries — and ``request_with_self_heal`` only reaches here after
    admin-api actually answered (a 401 verdict, not a connect failure), so the
    re-fetch is against a reachable admin. Returns the current dynamic token
    (``None`` when the fetch failed, in which case the caller must NOT retry).
    """
    global _token_expires_at
    _token_expires_at = None
    await _refresh_token_if_needed()
    return _dynamic_token


async def request_with_self_heal(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    token: Optional[str] = None,
    headers: Optional[dict] = None,
    **kwargs: Any,
) -> httpx.Response:
    """Outbound admin-api request with R11 stale-credential self-heal.

    Sends ``method url`` with ``token`` as the Bearer credential (merged into
    ``headers``). If admin-api answers 401 — an auth verdict meaning our
    per-executor token was rotated out from under us — force an immediate
    re-fetch (:func:`force_token_refresh`) and retry the request EXACTLY ONCE,
    and only when the refreshed token actually differs from the one just sent.
    The raw 401 response is returned to the caller (no ``raise_for_status``
    here) so persistent failures propagate through the caller's own error
    handling.

    Storm guards (same posture as executor-node ``admin-client.request``):
    exactly one auth retry per request (a second 401 propagates);
    ``force_token_refresh`` returns ``None`` while admin is unreachable so no
    retry is issued; and admin-api's ``issueToken`` is idempotent per
    (address, startupId), so concurrent 401s converge on the SAME token
    instead of rotating.

    Static/bootstrap paths (register, POST /token itself) must NOT use this
    helper — a 401 there means the shared token is wrong and refreshing the
    dynamic token cannot fix it (parity with node's ``tokenMode === 'static'``
    requests, which skip the heal).
    """
    base_headers = dict(headers or {})
    if token:
        base_headers['Authorization'] = f'Bearer {token}'

    request = getattr(client, method.lower())
    response = await request(url, headers=base_headers, **kwargs)
    if response.status_code != 401:
        return response

    fresh = await force_token_refresh()
    if not fresh or fresh == token:
        # No usable heal (admin unreachable / token unchanged) — do not retry.
        return response

    retry_headers = dict(base_headers)
    retry_headers['Authorization'] = f'Bearer {fresh}'
    return await request(url, headers=retry_headers, **kwargs)