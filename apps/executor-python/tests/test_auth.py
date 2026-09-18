import asyncio

import httpx
import pytest
from datetime import datetime, timedelta
from fastapi import HTTPException
from unittest.mock import AsyncMock

import auth as auth_module
from startup_identity import executor_startup_id


def test_no_token_returns_401(client):
    """POST /api/execute without Authorization header should return 401."""
    response = client.post('/api/execute', json={
        'executionId': 'test-exec-1',
        'task': {'name': 'test'},
    })
    assert response.status_code == 401


def test_wrong_token_returns_401(client):
    """POST /api/execute with wrong Bearer token should return 401."""
    response = client.post(
        '/api/execute',
        json={
            'executionId': 'test-exec-2',
            'task': {'name': 'test'},
        },
        headers={'Authorization': 'Bearer wrongtoken'},
    )
    assert response.status_code == 401


def test_correct_token_not_401(auth_client, monkeypatch):
    """POST /api/execute with correct token should pass auth (may return other errors for bad payload)."""
    # A valid token means the endpoint ACCEPTS the request and spawns the real
    # background execution task. Left running it spawns a subprocess and burns
    # callback retries against the fake admin URL, and the TestClient loop
    # teardown abandons it mid-flight — the orphaned subprocess transport then
    # GCs as a flaky "RuntimeError: Event loop is closed" unraisable warning
    # attributed to whichever test happens to be running. Stub create_task so
    # the coroutine never runs (same pattern as
    # test_execute_below_capacity_returns_accepted).
    from routers import execute as execute_module
    import scheduler as sched

    class FakeTaskHandle:
        def add_done_callback(self, cb):
            pass

    def fake_create_task(coro):
        coro.close()
        return FakeTaskHandle()

    original_count = sched.running_count
    monkeypatch.setattr(execute_module.asyncio, 'create_task', fake_create_task)
    try:
        response = auth_client.post(
            '/api/execute',
            json={
                'executionId': 'test-exec-3',
                'task': {'name': 'test'},
            },
            headers={'Authorization': 'Bearer testsecret'},
        )
    finally:
        # The background task normally decrements this in its finally; with
        # the coroutine closed it never runs.
        sched.running_count = original_count
    assert response.status_code != 401


# ---------------------------------------------------------------------------
# E-24（DEEP_REVIEW 0ef3bbe）：非 ASCII Bearer token 必须返回 401，不得因
# hmac.compare_digest(str, str) 对非 ASCII 抛 TypeError → 500。
# ---------------------------------------------------------------------------

class TestNonAsciiBearerE24:
    @pytest.mark.asyncio
    async def test_non_ascii_bearer_returns_401_not_500(self, monkeypatch):
        """E-24: Authorization: Bearer 含非 ASCII（如中文/Emoji）时，verify_token
        应判 401，而不是让 hmac.compare_digest 抛 TypeError 冒泡成 500。"""
        # 静态 token 走真 env（_get_static_token 读 env 优先）
        monkeypatch.setenv('EXECUTOR_SHARED_TOKEN', 'correct-secret')
        monkeypatch.setattr(auth_module, '_dynamic_token', None)
        # 跳过动态刷新（避免触网），直接进 Bearer 比对分支
        monkeypatch.setattr(auth_module, '_refresh_token_if_needed', AsyncMock(return_value=None))

        with pytest.raises(HTTPException) as exc:
            await auth_module.verify_token('Bearer 密码🔑')
        assert exc.value.status_code == 401

    @pytest.mark.asyncio
    async def test_ascii_bearer_still_works(self, monkeypatch):
        """回归：ASCII 正确 token 仍通过（bytes 改造不破坏既有路径）。"""
        monkeypatch.setenv('EXECUTOR_SHARED_TOKEN', 'correct-secret')
        monkeypatch.setattr(auth_module, '_dynamic_token', None)
        monkeypatch.setattr(auth_module, '_refresh_token_if_needed', AsyncMock(return_value=None))
        # 正确 token 不应抛
        await auth_module.verify_token('Bearer correct-secret')

    @pytest.mark.asyncio
    async def test_ascii_wrong_bearer_401(self, monkeypatch):
        """回归：ASCII 错误 token 仍 401。"""
        monkeypatch.setenv('EXECUTOR_SHARED_TOKEN', 'correct-secret')
        monkeypatch.setattr(auth_module, '_dynamic_token', None)
        monkeypatch.setattr(auth_module, '_refresh_token_if_needed', AsyncMock(return_value=None))
        with pytest.raises(HTTPException) as exc:
            await auth_module.verify_token('Bearer wrong-token')
        assert exc.value.status_code == 401


# ---------------------------------------------------------------------------
# R4-C P2: unconfigured token must be able to fail closed (REQUIRE_TOKEN)
# ---------------------------------------------------------------------------

def _clear_all_tokens(monkeypatch):
    """Remove dynamic + static tokens so verify_token reaches the dev-mode branch."""
    monkeypatch.setattr(auth_module, '_dynamic_token', None)
    monkeypatch.delenv('EXECUTOR_SHARED_TOKEN', raising=False)
    monkeypatch.delenv('EXECUTOR_SECRET', raising=False)
    # round-16 修复后 _get_static_token 会回退到 settings（.env 值）——
    # 开发者本机 .env 的真实 token 也必须清掉，用例才能到达 dev-mode 分支
    from config import settings as _settings
    monkeypatch.setattr(_settings, 'executor_shared_token', '')
    monkeypatch.setattr(_settings, 'executor_secret', '')


def test_verify_token_dev_mode_allows_only_with_explicit_opt_in(monkeypatch):
    """S-3 (audit-r4): dev-mode allow-all 现在是**显式开关**——无 token 且未设
    EXECUTOR_ALLOW_NO_TOKEN 时默认 503；显式 opt-in 才放行未认证请求。"""
    _clear_all_tokens(monkeypatch)
    monkeypatch.delenv('REQUIRE_TOKEN', raising=False)
    from config import settings as _settings
    monkeypatch.setattr(_settings, 'require_token', False)
    # 默认（无 EXECUTOR_ALLOW_NO_TOKEN）：fail-closed
    with pytest.raises(HTTPException) as exc:
        asyncio.run(auth_module.verify_token(''))
    assert exc.value.status_code == 503
    # 显式 opt-in：dev-mode 放行
    monkeypatch.setenv('EXECUTOR_ALLOW_NO_TOKEN', 'true')
    asyncio.run(auth_module.verify_token(''))  # must not raise


def test_verify_token_require_token_fails_closed(monkeypatch):
    """P2: REQUIRE_TOKEN=true turns an unconfigured token into 503 instead of
    silently accepting arbitrary executions (legacy switch, still honored)."""
    _clear_all_tokens(monkeypatch)
    monkeypatch.setenv('REQUIRE_TOKEN', 'true')
    with pytest.raises(HTTPException) as exc:
        asyncio.run(auth_module.verify_token(''))
    assert exc.value.status_code == 503


def test_verify_token_require_token_passes_with_valid_token(monkeypatch):
    """REQUIRE_TOKEN=true must not affect properly configured executors."""
    _clear_all_tokens(monkeypatch)
    monkeypatch.setenv('EXECUTOR_SHARED_TOKEN', 'secret-x')
    monkeypatch.setenv('REQUIRE_TOKEN', 'true')
    asyncio.run(auth_module.verify_token('Bearer secret-x'))  # must not raise


def test_execute_endpoint_fails_closed_when_require_token(monkeypatch, client):
    """End to end: no token (with or without REQUIRE_TOKEN) -> 503 on /api/execute."""
    from routers import execute as execute_module  # noqa: F401  (app import side effects)
    _clear_all_tokens(monkeypatch)
    monkeypatch.setenv('REQUIRE_TOKEN', 'true')
    response = client.post('/api/execute', json={
        'executionId': 'exec-require-token',
        'task': {'name': 't'},
    })
    assert response.status_code == 503
    assert 'refusing unauthenticated execution' in response.json()['detail']


# ---------------------------------------------------------------------------
# R9 (round-9): _fetch_token must accept 2xx (Nest POST answers 201), unwrap
# the {code,message,data} envelope, send startupId, and adopt tokenHash.
# ---------------------------------------------------------------------------

def _make_response(status_code: int, payload) -> httpx.Response:
    """A real httpx.Response carrying a JSON body (so .json() works)."""
    request = httpx.Request('POST', 'http://admin.local/api/executors/token')
    return httpx.Response(status_code, json=payload, request=request)


def _patch_async_client(monkeypatch, response):
    """Replace the O-24 shared client (scheduler.get_http_client) with a mock
    returning `response` — _fetch_token 现经延迟导入取共享客户端。"""
    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=response)
    monkeypatch.setattr('scheduler.get_http_client', lambda: mock_client)
    return mock_client


class TestUnwrapEnvelope:
    def test_envelope_returns_inner_data(self):
        payload = {'code': 0, 'message': 'ok', 'data': {'token': 'abc'}}
        assert auth_module._unwrap_envelope(payload) == {'token': 'abc'}

    def test_bare_payload_returned_unchanged(self):
        payload = {'token': 'abc'}
        assert auth_module._unwrap_envelope(payload) == {'token': 'abc'}

    def test_non_dict_returned_unchanged(self):
        assert auth_module._unwrap_envelope(None) is None
        assert auth_module._unwrap_envelope('x') == 'x'


class TestAdoptTokenHash:
    def test_adopts_from_envelope(self, monkeypatch):
        monkeypatch.setattr(auth_module, '_executor_token_hash', None)
        auth_module.adopt_executor_token_hash(
            {'code': 0, 'message': 'ok', 'data': {'tokenHash': 'hash-1'}}
        )
        assert auth_module.get_executor_token_hash() == 'hash-1'

    def test_adopts_from_bare_shape(self, monkeypatch):
        monkeypatch.setattr(auth_module, '_executor_token_hash', None)
        auth_module.adopt_executor_token_hash({'tokenHash': 'hash-2'})
        assert auth_module.get_executor_token_hash() == 'hash-2'

    def test_noop_when_absent(self, monkeypatch):
        monkeypatch.setattr(auth_module, '_executor_token_hash', 'keep-me')
        auth_module.adopt_executor_token_hash({'code': 0, 'data': {'other': 1}})
        auth_module.adopt_executor_token_hash(None)
        auth_module.adopt_executor_token_hash({'tokenHash': ''})
        assert auth_module.get_executor_token_hash() == 'keep-me'


class TestFetchToken:
    def test_envelope_201_returns_token_and_adopts_hash(self, monkeypatch):
        """Nest POST /token answers 201 with the {code,message,data} envelope."""
        monkeypatch.setattr(auth_module, '_executor_token_hash', None)
        _patch_async_client(monkeypatch, _make_response(201, {
            'code': 0, 'message': 'ok',
            'data': {'token': 'dyn-token', 'tokenHash': 'hash-9'},
        }))
        token = asyncio.run(auth_module._fetch_token())
        assert token == 'dyn-token'
        assert auth_module.get_executor_token_hash() == 'hash-9'

    def test_bare_200_returns_token(self, monkeypatch):
        """Backwards-compat: a bare (non-enveloped) 200 payload still works."""
        monkeypatch.setattr(auth_module, '_executor_token_hash', None)
        _patch_async_client(monkeypatch, _make_response(200, {'token': 'bare-token'}))
        assert asyncio.run(auth_module._fetch_token()) == 'bare-token'

    def test_non_2xx_returns_none(self, monkeypatch):
        _patch_async_client(monkeypatch, _make_response(401, {'message': 'nope'}))
        assert asyncio.run(auth_module._fetch_token()) is None

    def test_envelope_without_token_returns_none(self, monkeypatch):
        _patch_async_client(monkeypatch, _make_response(201, {
            'code': 0, 'message': 'ok', 'data': None,
        }))
        assert asyncio.run(auth_module._fetch_token()) is None

    def test_request_body_carries_startup_id(self, monkeypatch):
        mock_client = _patch_async_client(monkeypatch, _make_response(201, {
            'code': 0, 'data': {'token': 't'},
        }))
        asyncio.run(auth_module._fetch_token())
        body = mock_client.post.call_args.kwargs['json']
        assert body['startupId'] == executor_startup_id
        assert 'address' in body and 'appName' in body

    def test_transport_error_returns_none(self, monkeypatch):
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=httpx.ConnectError('refused'))
        monkeypatch.setattr('scheduler.get_http_client', lambda: mock_client)
        assert asyncio.run(auth_module._fetch_token()) is None


# ---------------------------------------------------------------------------
# R11 (round-11, port of executor-node R10 gap #3): force_token_refresh +
# request_with_self_heal — a 401 on an outbound dynamic-token request heals
# the stale bearer within one round-trip instead of waiting for the 30-minute
# scheduled refresh (during which the heartbeat would 401 and the executor be
# marked OFFLINE).
# ---------------------------------------------------------------------------


def _resp(status_code: int) -> httpx.Response:
    return httpx.Response(
        status_code, request=httpx.Request('POST', 'http://admin.local/api/x')
    )


class TestForceTokenRefresh:
    @pytest.mark.asyncio
    async def test_clears_expiry_and_returns_refreshed_token(self, monkeypatch):
        # A future expiry would normally suppress a refresh for ~30min; the
        # forced path must bypass it and re-fetch.
        monkeypatch.setattr(auth_module, '_token_expires_at', datetime.now() + timedelta(minutes=29))
        monkeypatch.setattr(auth_module, '_dynamic_token', 'stale-token')
        monkeypatch.setattr(auth_module, '_fetch_token', AsyncMock(return_value='fresh-token'))

        result = await auth_module.force_token_refresh()

        assert result == 'fresh-token'
        assert auth_module._dynamic_token == 'fresh-token'
        # expiry re-armed by the successful refresh
        assert auth_module._token_expires_at is not None

    @pytest.mark.asyncio
    async def test_returns_none_when_fetch_fails(self, monkeypatch):
        monkeypatch.setattr(auth_module, '_token_expires_at', datetime.now() + timedelta(minutes=29))
        monkeypatch.setattr(auth_module, '_dynamic_token', None)
        monkeypatch.setattr(auth_module, '_fetch_token', AsyncMock(return_value=None))

        assert await auth_module.force_token_refresh() is None


class TestRequestWithSelfHeal:
    @pytest.mark.asyncio
    async def test_401_refreshes_and_retries_once_with_new_token(self, monkeypatch):
        monkeypatch.setattr(
            auth_module, 'force_token_refresh', AsyncMock(return_value='fresh-token')
        )
        client = AsyncMock()
        client.post = AsyncMock(side_effect=[_resp(401), _resp(200)])

        response = await auth_module.request_with_self_heal(
            client, 'post', 'http://admin.local/api/executors/heartbeat',
            token='stale-token', json={'a': 1},
        )

        assert response.status_code == 200
        assert client.post.call_count == 2
        # first attempt carried the stale bearer, retry the healed one
        first_auth = client.post.call_args_list[0].kwargs['headers']['Authorization']
        second_auth = client.post.call_args_list[1].kwargs['headers']['Authorization']
        assert first_auth == 'Bearer stale-token'
        assert second_auth == 'Bearer fresh-token'

    @pytest.mark.asyncio
    async def test_no_retry_when_token_unchanged(self, monkeypatch):
        # Admin unreachable / idempotent reuse returns the SAME token we just
        # sent — retrying would only re-401, so the helper must not.
        monkeypatch.setattr(
            auth_module, 'force_token_refresh', AsyncMock(return_value='same-token')
        )
        client = AsyncMock()
        client.post = AsyncMock(return_value=_resp(401))

        response = await auth_module.request_with_self_heal(
            client, 'post', 'http://admin.local/api/x', token='same-token',
        )

        assert response.status_code == 401
        assert client.post.call_count == 1

    @pytest.mark.asyncio
    async def test_no_retry_when_refresh_returns_none(self, monkeypatch):
        monkeypatch.setattr(auth_module, 'force_token_refresh', AsyncMock(return_value=None))
        client = AsyncMock()
        client.post = AsyncMock(return_value=_resp(401))

        response = await auth_module.request_with_self_heal(
            client, 'post', 'http://admin.local/api/x', token='stale',
        )

        assert response.status_code == 401
        assert client.post.call_count == 1

    @pytest.mark.asyncio
    async def test_non_401_does_not_trigger_refresh(self, monkeypatch):
        refresh = AsyncMock()
        monkeypatch.setattr(auth_module, 'force_token_refresh', refresh)
        client = AsyncMock()
        client.post = AsyncMock(return_value=_resp(500))

        response = await auth_module.request_with_self_heal(
            client, 'post', 'http://admin.local/api/x', token='t',
        )

        assert response.status_code == 500
        assert client.post.call_count == 1
        refresh.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_success_passthrough_without_auth_header(self, monkeypatch):
        refresh = AsyncMock()
        monkeypatch.setattr(auth_module, 'force_token_refresh', refresh)
        client = AsyncMock()
        client.post = AsyncMock(return_value=_resp(200))

        response = await auth_module.request_with_self_heal(
            client, 'post', 'http://admin.local/api/x', token=None,
            headers={'X-Trace-Id': 'trace-1'},
        )

        assert response.status_code == 200
        headers = client.post.call_args.kwargs['headers']
        assert 'Authorization' not in headers
        assert headers['X-Trace-Id'] == 'trace-1'
        refresh.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_static_bootstrap_path_never_self_heals(self, monkeypatch):
        # _fetch_token (the register/token bootstrap, authenticated with the
        # STATIC shared token) must NOT recurse into the heal: a 401 there
        # means the shared token is wrong, which refreshing cannot fix.
        refresh = AsyncMock()
        monkeypatch.setattr(auth_module, 'force_token_refresh', refresh)
        _patch_async_client(monkeypatch, _make_response(401, {'message': 'nope'}))

        assert await auth_module._fetch_token() is None
        refresh.assert_not_awaited()


# ---------------------------------------------------------------------------
# E-11: _refresh_token_if_needed 失败退避——admin 不可达时不要每请求一发 10s 超时
# ---------------------------------------------------------------------------

class TestTokenRefreshBackoffE11:
    @pytest.mark.asyncio
    async def test_no_refresh_within_backoff_after_failure(self, monkeypatch):
        """E-11: _fetch_token 失败后 30s 退避窗内，_refresh_token_if_needed 不再
        尝试刷新（避免 admin 不可达时每 inbound 请求都阻塞在 ~10s 取 token 超时）。"""
        fetch = AsyncMock(return_value=None)  # 失败
        monkeypatch.setattr(auth_module, '_fetch_token', fetch)
        monkeypatch.setattr(auth_module, '_token_expires_at', None)
        monkeypatch.setattr(auth_module, '_dynamic_token', None)
        monkeypatch.setattr(auth_module, '_token_fetch_failed_at', 0.0)
        # 冻结单调时钟，使窗内两次调用时间戳相同
        fixed = 1000.0
        monkeypatch.setattr(auth_module.time, 'monotonic', lambda: fixed)

        await auth_module._refresh_token_if_needed()
        assert fetch.await_count == 1  # 首次失败 → 记录退避时间戳
        assert auth_module._token_fetch_failed_at > 0

        # 退避窗内（时钟未变）→ 直接 return，不再调用 _fetch_token
        await auth_module._refresh_token_if_needed()
        assert fetch.await_count == 1, 'backoff window must skip the refresh'

    @pytest.mark.asyncio
    async def test_success_clears_backoff(self, monkeypatch):
        """E-11: 刷新成功重置退避时间戳，后续窗口到期后才能重试。"""
        fetch = AsyncMock(return_value='new-token')
        monkeypatch.setattr(auth_module, '_fetch_token', fetch)
        monkeypatch.setattr(auth_module, '_token_expires_at', None)
        monkeypatch.setattr(auth_module, '_dynamic_token', None)
        monkeypatch.setattr(auth_module, '_token_fetch_failed_at', 500.0)
        fixed = 1000.0
        monkeypatch.setattr(auth_module.time, 'monotonic', lambda: fixed)

        await auth_module._refresh_token_if_needed()
        assert fetch.await_count == 1
        assert auth_module._token_fetch_failed_at == 0.0, 'success must reset backoff'


# ---------------------------------------------------------------------------
# E-45（DEEP_REVIEW 0ef3bbe）：token 轮换自愈关键路径的并发去重回归——
# 旧 E-27 前，token 过期瞬间一批并发 verify_token 各自发一次 POST /token。
# 这里直接对「并发刷新只发一次 /token」这个行为级不变量做断言。
# ---------------------------------------------------------------------------

class TestConcurrentRefreshDedupE45:
    @pytest.mark.asyncio
    async def test_concurrent_refresh_fetches_only_once(self, monkeypatch):
        """E-45/E-27: N 个并发 _refresh_token_if_needed 只触发一次 _fetch_token。"""
        fetch = AsyncMock(return_value='dyn-token')
        monkeypatch.setattr(auth_module, '_fetch_token', fetch)
        monkeypatch.setattr(auth_module, '_token_expires_at', None)
        monkeypatch.setattr(auth_module, '_dynamic_token', None)
        monkeypatch.setattr(auth_module, '_token_fetch_failed_at', 0.0)

        # 并发触发 10 个刷新（模拟 token 过期瞬间一批并发回调/心跳）
        await asyncio.gather(*[auth_module._refresh_token_if_needed() for _ in range(10)])

        assert fetch.await_count == 1, f'concurrent refresh must dedup to one fetch, got {fetch.await_count}'
        assert auth_module._dynamic_token == 'dyn-token'
        assert auth_module._token_expires_at is not None

    @pytest.mark.asyncio
    async def test_subsequent_refresh_after_window_skips(self, monkeypatch):
        """E-45: 已刷新后（expiry 在未来 30min 窗口内）再调用不重复 fetch。"""
        fetch = AsyncMock(return_value='dyn-token')
        monkeypatch.setattr(auth_module, '_fetch_token', fetch)
        monkeypatch.setattr(auth_module, '_token_expires_at', None)
        monkeypatch.setattr(auth_module, '_dynamic_token', None)
        monkeypatch.setattr(auth_module, '_token_fetch_failed_at', 0.0)

        await auth_module._refresh_token_if_needed()
        await auth_module._refresh_token_if_needed()
        await auth_module._refresh_token_if_needed()
        assert fetch.await_count == 1
