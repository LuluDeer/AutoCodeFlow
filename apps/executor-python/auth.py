"""SEC-03: Executor token management with expiration and rotation support."""
import asyncio
import hmac
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

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


def has_dynamic_token() -> bool:
    # E-42（DEEP_REVIEW 0ef3bbe）：/health 探针需要区分「静态 bootstrap token 已配置」
    # 与「动态（/token 下发）token 当前是否持有」——旧 health 只读静态 env，动态链路
    # 坏掉时探针仍报 tokenValid=true，运维无法从探针发现 token 轮换/自愈故障。
    return bool(_dynamic_token)

# Dynamic token storage (refreshed periodically)
_dynamic_token = None
_token_expires_at = None
_token_refresh_interval = 30 * 60  # 30 minutes

# E-11 (parity with executor-node middleware/auth.ts TOKEN_FETCH_BACKOFF_MS):
# monotonic timestamp of the last failed /token fetch — inbound /api requests
# skip the refresh within _TOKEN_FETCH_BACKOFF_SECONDS so a down admin-api does
# not make every request block on a ~10s fetch timeout. Clock is monotonic
# (not wall-clock) to stay immune to system time changes.
_token_fetch_failed_at = 0.0  # type: float
_TOKEN_FETCH_BACKOFF_SECONDS = 30.0

# E-27（DEEP_REVIEW 0ef3bbe）：并发刷新去重——token 过期瞬间的一批并发
# verify_token/get_current_token 旧实现各自走 _refresh_token_if_needed，各自发一次
# POST /token。用模块级 asyncio.Lock 把「判定 + _fetch_token」串行化：第一个调用者
# 持锁刷新并更新 _token_expires_at，其余并发调用者排队进锁后重读 _token_expires_at
# 已在未来 30min 窗口内，直接 return，不再发请求。锁惰性创建（绑定到首次运行它的
# 事件循环，兼容 uvicorn 单 loop）。
_refresh_lock: Optional[asyncio.Lock] = None
# 5-1（audit-r4）：锁绑定的事件循环身份（id()）。生产 uvicorn 单 loop 无感；测试/
# 多 loop 场景（每用例新建 loop）下跨 loop 复用旧锁会抛 RuntimeError——loop 变化
# 即换新锁（锁只在 _refresh_token_if_needed 的 async with 内短暂持有，无泄漏）。
_refresh_lock_loop_id: Optional[int] = None


def _get_refresh_lock() -> asyncio.Lock:
    global _refresh_lock, _refresh_lock_loop_id
    try:
        loop = asyncio.get_running_loop()
        loop_id = id(loop)
    except RuntimeError:
        # 无运行 loop（罕见同步调用路径）：不绑定，复用/新建均可。
        if _refresh_lock is None:
            _refresh_lock = asyncio.Lock()
        return _refresh_lock
    if _refresh_lock is None or _refresh_lock_loop_id != loop_id:
        _refresh_lock = asyncio.Lock()
        _refresh_lock_loop_id = loop_id
    return _refresh_lock

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


# SEC-NEW-3 (N41/BUG-08 parity, executor-node middleware/auth.ts
# setOnTokenAcquired): fired (fire-and-forget) after every SUCCESSFUL
# _fetch_token. main.py mounts a hook that re-registers with rich metadata
# when the startup register failed — the /token endpoint's register side
# effect rebuilds the row WITHOUT type/capabilities/maxConcurrentTasks/
# version, and only a real register call restores them.
TokenAcquiredListener = Callable[[], Any]
_token_acquired_listener: Optional[TokenAcquiredListener] = None


def set_on_token_acquired(listener: Optional[TokenAcquiredListener]) -> None:
    """Install (or, with ``None``, remove) the token-acquired listener."""
    global _token_acquired_listener
    _token_acquired_listener = listener


def notify_token_acquired() -> None:
    """Fire the listener without touching the token/request path: any error
    (including a failed re-register) is swallowed here — the listener owns
    its retry semantics."""
    listener = _token_acquired_listener
    if listener is None:
        return
    try:
        result = listener()
        if asyncio.iscoroutine(result):
            # 常见挂法：lambda 里 create_task(maybe_re_register()) 返回 Task
            # （非协程，不会被二次调度）；这里兜底直挂协程的调用方——调度后
            # 吞掉异常，保证 fire-and-forget 语义。
            async def _run() -> None:
                try:
                    await result
                except Exception as exc:
                    logger.warning('[auth] onTokenAcquired listener failed: %s', exc)
            asyncio.get_running_loop().create_task(_run())
    except Exception as exc:
        logger.warning('[auth] onTokenAcquired listener failed: %s', exc)


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
        # 网络性能审计（2026-09-18）：改用 O-24 共享连接池（延迟导入避免
        # auth↔scheduler 模块级环）。token 刷新路径（启动、30min 轮换、
        # 401 self-heal）此前每次新建 AsyncClient，连接池随上下文退出即销毁。
        from scheduler import get_http_client
        client = get_http_client()
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
            # SEC-NEW-3 (N41 parity): a successful token fetch may have
            # healed the token chain after a failed startup register —
            # give main.py's re-register hook a fire-and-forget poke.
            notify_token_acquired()
            return token
    except Exception as e:
        # Fall back to static token if dynamic token fetch fails
        logger.warning("Dynamic token fetch failed (will use static): %s", e)
    return None


async def _refresh_token_if_needed() -> None:
    """Refresh token if expired or about to expire."""
    global _dynamic_token, _token_expires_at, _token_fetch_failed_at
    # E-27: 整段「判定 + _fetch_token」持锁执行——并发调用者串行进锁，第一个
    # 刷新后 _token_expires_at 落到未来 30min，后续进锁者重读后直接 return。
    async with _get_refresh_lock():
        # E-11 (parity with executor-node middleware/auth.ts TOKEN_FETCH_BACKOFF_MS):
        # after a failed /token fetch, back off for 30s so admin-api being
        # unreachable does not make every inbound /api request block on a ~10s
        # fetch timeout. Clock is monotonic (not wall-clock) — immune to system
        # time changes.
        now_mono = time.monotonic()
        if _token_fetch_failed_at and (now_mono - _token_fetch_failed_at) < _TOKEN_FETCH_BACKOFF_SECONDS:
            return
        now = datetime.now(timezone.utc)
        # Refresh if no token, expired, or within 5 minutes of expiration
        if _token_expires_at is None or now >= _token_expires_at - timedelta(minutes=5):
            new_token = await _fetch_token()
            if new_token:
                _dynamic_token = new_token
                _token_expires_at = now + timedelta(seconds=_token_refresh_interval)
                _token_fetch_failed_at = 0.0  # E-11: 成功重置退避计时
            else:
                # E-11: 失败计时——退避期内 inbound 请求跳过刷新，避免每请求一发
                # 10s 超时炮灰（admin 不可达时 verify_token 每请求走 refresh 链）。
                _token_fetch_failed_at = now_mono


def require_token_enabled() -> bool:
    """R4-C P2: REQUIRE_TOKEN=true makes an unconfigured token fail closed
    (503) instead of the dev-mode allow-all. Read from the environment at call
    time (same pattern as _get_static_token) so the live value is honored;
    falls back to the config-file default."""
    value = os.environ.get('REQUIRE_TOKEN', '').strip().lower()
    if value:
        return value in ('1', 'true', 'yes', 'on')
    return bool(getattr(settings, 'require_token', False))


def _allow_no_token_dev_mode() -> bool:
    """S-3（audit-r4）：无 token 时 dev-mode allow-all 的**显式开关**。

    fail-closed 现在是默认姿态；仅当 EXECUTOR_ALLOW_NO_TOKEN=true（或
    config.allow_no_token=true，覆盖 .env 部署）才放行未认证请求。读取时机与
    REQUIRE_TOKEN 同款（每次调用读 env，测试可 monkeypatch）。"""
    value = os.environ.get('EXECUTOR_ALLOW_NO_TOKEN', '').strip().lower()
    if value:
        return value in ('1', 'true', 'yes', 'on')
    return bool(getattr(settings, 'allow_no_token', False))


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
        # S-3（audit-r4）：fail-closed 是默认姿态——裸部署的执行器接受任意
        # 代码执行的风险高于本地开发便利。dev-mode allow-all 必须显式
        # EXECUTOR_ALLOW_NO_TOKEN=true 开启；REQUIRE_TOKEN=true 是更早的
        # 强制 fail-closed 开关，两者任一触发即 503。
        if require_token_enabled() or not _allow_no_token_dev_mode():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=(
                    'No executor token is configured; refusing unauthenticated '
                    'execution (set EXECUTOR_ALLOW_NO_TOKEN=true only for local dev)'
                ),
            )
        import logging as _logging
        _logging.getLogger(__name__).warning(
            'No executor token configured — EXECUTOR_ALLOW_NO_TOKEN=true: '
            'dev mode is allowing unauthenticated requests'
        )
        return
    
    scheme, _, token = authorization.partition(' ')
    # E-24（DEEP_REVIEW 0ef3bbe）：hmac.compare_digest 对 str/str 要求纯 ASCII，
    # 非 ASCII Bearer（如 "Bearer 密码"）会抛 TypeError → FastAPI 500，污染错误率
    # 指标（应为 401）。统一改 bytes 比较：非 ASCII token 自然编码后比对不上即 401，
    # 不再抛异常。与 node middleware/auth.ts 的 Buffer + timingSafeEqual 口径对齐。
    token_bytes = token.encode('utf-8')
    token_valid = scheme.lower() == 'bearer' and any(
        hmac.compare_digest(token_bytes, vt.encode('utf-8')) for vt in valid_tokens
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

    E-11 (parity with executor-node middleware/auth.ts TOKEN_FETCH_BACKOFF_MS):
    this module's ``_refresh_token_if_needed`` now applies a 30s fetch-failure
    backoff (the original had none) so a down admin-api does not make every
    inbound request block on the ~10s fetch timeout. A failed fetch records
    ``_token_fetch_failed_at`` (monotonic) and the next call within the window
    returns early; ``request_with_self_heal`` still only reaches here after
    admin-api actually answered (a 401 verdict, not a connect failure). Returns
    the current dynamic token
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