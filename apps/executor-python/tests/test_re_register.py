"""SEC-NEW-3 (port of executor-node N41/BUG-08, commit 313d203): register
失败/被拒后的补注册链 — token 链恢复（_fetch_token 成功 → on_token_acquired
钩子）触发 maybe_re_register，用与首次注册相同的富元数据修复 /token side
effect 重建行丢失的 type/capabilities/maxConcurrentTasks/version。

风暴防护三件套（node maybeReRegister 语义对等 + 退避增强）：
- 已注册短路（_register_succeeded）；
- in-flight 去重（asyncio.Lock，并发 verify_token 各自触发 hook 不叠加）；
- 失败退避 30s（admin 不可达时 verify_token 逐请求触发 hook 不空转）。
"""
import asyncio
import logging
from unittest.mock import AsyncMock, patch

import pytest

import auth as auth_module
import main as main_module
from main import maybe_re_register, register_executor


@pytest.fixture(autouse=True)
def _reset_re_register_state(monkeypatch):
    """SEC-NEW-3 模块状态归零：注册成功旗标/退避时间戳/锁不跨用例泄漏。"""
    monkeypatch.setattr(main_module, '_register_succeeded', False)
    monkeypatch.setattr(main_module, '_re_register_backoff_until', 0.0)
    monkeypatch.setattr(main_module, '_re_register_in_flight', asyncio.Lock())
    monkeypatch.setattr(auth_module, '_token_acquired_listener', None)
    yield


def _ok_register(mock_client):
    mock_client.post = AsyncMock(return_value=httpx_response(201, {'code': 0, 'message': 'ok', 'data': {}}))


def httpx_response(status_code, json_body=None, text=None):
    import httpx
    return httpx.Response(
        status_code,
        json=json_body if json_body is not None else {},
        text=text,
        request=httpx.Request('POST', 'http://admin.local/api/executors/register'),
    )


def _mock_client():
    client = AsyncMock()
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None
    return client


def _token_response(status_code, json_body=None, text=None):
    import httpx
    return httpx.Response(
        status_code,
        json=json_body if json_body is not None else {},
        text=text,
        request=httpx.Request('POST', 'http://admin.local/api/executors/token'),
    )


# ---------------------------------------------------------------------------
# hook wiring: _fetch_token 成功 → notify_token_acquired（auth 层）
# ---------------------------------------------------------------------------

class TestTokenAcquiredHook:
    @pytest.mark.asyncio
    async def test_notify_fires_after_successful_fetch(self, monkeypatch):
        """对齐 node auth.spec『fires the listener after a successful token
        fetch』：_fetch_token 成功（真实函数体路径）必须触发钩子。"""
        fired = []
        monkeypatch.setattr(auth_module, '_token_acquired_listener', lambda: fired.append(1))
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.__aexit__.return_value = None
        client.post = AsyncMock(return_value=_token_response(201, {
            'code': 0, 'message': 'ok', 'data': {'token': 'fresh-token'},
        }))
        monkeypatch.setattr(auth_module.httpx, 'AsyncClient', lambda *a, **k: client)
        monkeypatch.setattr(auth_module, '_token_expires_at', None)
        monkeypatch.setattr(auth_module, '_dynamic_token', None)

        await auth_module.force_token_refresh()

        assert fired == [1]

    @pytest.mark.asyncio
    async def test_notify_skipped_when_fetch_fails(self, monkeypatch):
        """对齐 node auth.spec『does not fire the listener when the fetch
        fails』：token 没恢复就不该触发补注册。"""
        fired = []
        monkeypatch.setattr(auth_module, '_token_acquired_listener', lambda: fired.append(1))
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.__aexit__.return_value = None
        client.post = AsyncMock(return_value=_token_response(503, {'message': 'unavailable'}))
        monkeypatch.setattr(auth_module.httpx, 'AsyncClient', lambda *a, **k: client)
        monkeypatch.setattr(auth_module, '_token_expires_at', None)
        monkeypatch.setattr(auth_module, '_dynamic_token', None)

        await auth_module.force_token_refresh()

        assert fired == []
        assert auth_module._dynamic_token is None

    def test_listener_errors_swallowed(self, monkeypatch, caplog):
        """对齐 node auth.spec『listener errors are swallowed』：钩子抛错不得
        影响 token 主流程。"""
        def boom():
            raise RuntimeError('re-register boom')

        monkeypatch.setattr(auth_module, '_token_acquired_listener', boom)
        with caplog.at_level(logging.WARNING, logger='auth'):
            auth_module.notify_token_acquired()
        assert any('onTokenAcquired' in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# maybe_re_register 风暴防护
# ---------------------------------------------------------------------------

class TestMaybeReRegister:
    @pytest.mark.asyncio
    async def test_re_register_after_register_401_recovers_rich_metadata(self, monkeypatch):
        """401 触发→成功恢复：register 被拒（_register_succeeded=False）后，
        maybe_re_register 重新 POST register 且载荷与首次注册同源（富元数据）。"""
        client = _mock_client()
        client.post = AsyncMock(return_value=httpx_response(201, {'code': 0, 'data': {}}))
        monkeypatch.setattr(main_module.httpx, 'AsyncClient', lambda *a, **k: client)

        ok = await maybe_re_register()

        assert ok is True
        assert client.post.await_count == 1
        url = client.post.call_args.args[0]
        body = client.post.call_args.kwargs['json']
        assert url.endswith('/executors/register')
        # 富元数据从 _register_payload 单一来源恢复——/token fallback 重建行
        # 丢掉的 type/capabilities/maxConcurrentTasks/version 在这里补齐
        assert body == main_module._register_payload()
        assert body['type'] == 'python' and body['capabilities'] == ['python', 'shell']

    @pytest.mark.asyncio
    async def test_short_circuits_when_already_registered(self, monkeypatch):
        """去重短路：已注册成功（_register_succeeded=True）→ no-op，不叠加。"""
        monkeypatch.setattr(main_module, '_register_succeeded', True)
        register = AsyncMock()
        monkeypatch.setattr(main_module, 'register_executor', register)

        await maybe_re_register()

        register.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_dedupes_concurrent_re_register(self, monkeypatch):
        """in-flight 去重：并发触发的两个 maybe_re_register 只发起一次注册。"""
        first_gate = asyncio.Event()

        async def slow_register():
            await first_gate.wait()
            return True

        register = AsyncMock(side_effect=slow_register)
        monkeypatch.setattr(main_module, 'register_executor', register)

        t1 = asyncio.create_task(maybe_re_register())
        await asyncio.sleep(0)  # let t1 take the lock and park inside register
        t2 = asyncio.create_task(maybe_re_register())
        await asyncio.sleep(0)
        first_gate.set()
        await asyncio.gather(t1, t2)

        register.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_backoff_after_failed_re_register(self, monkeypatch):
        """退避上限：补注册失败后 30s 冷却窗内的再次触发直接跳过。"""
        register = AsyncMock(return_value=False)
        monkeypatch.setattr(main_module, 'register_executor', register)

        await maybe_re_register()
        assert register.await_count == 1
        assert main_module._re_register_backoff_until > 0

        await maybe_re_register()
        await maybe_re_register()
        assert register.await_count == 1, 'backoff window must suppress re-registrations'

    @pytest.mark.asyncio
    async def test_backoff_cleared_after_successful_re_register(self, monkeypatch):
        """成功恢复清退避：冷却窗过期后的首次触发成功 → 退避时间戳归零
        （而不是留着一个过期脏值），失败链路能重新武装。"""
        register = AsyncMock(return_value=True)
        monkeypatch.setattr(main_module, 'register_executor', register)
        # 已过期的冷却窗（30s 前武装、早已到期）——不应压制本次触发
        main_module._re_register_backoff_until = main_module.time.monotonic() - 1

        ok = await maybe_re_register()

        assert ok is True
        register.assert_awaited_once()
        assert main_module._re_register_backoff_until == 0.0


# ---------------------------------------------------------------------------
# register_executor 返回值契约（SEC-NEW-3 改造点）
# ---------------------------------------------------------------------------

class TestRegisterExecutorReturns:
    @pytest.mark.asyncio
    async def test_returns_true_on_2xx(self, monkeypatch):
        client = _mock_client()
        _ok_register(client)
        monkeypatch.setattr(main_module.httpx, 'AsyncClient', lambda *a, **k: client)
        assert await register_executor() is True

    @pytest.mark.asyncio
    async def test_returns_false_and_logs_on_401(self, monkeypatch, caplog):
        """401 触发源：被拒的 register 返回 False（供补注册链武装）。"""
        client = _mock_client()
        client.post = AsyncMock(return_value=httpx_response(401, text='{"code":401,"message":"Invalid executor token"}'))
        monkeypatch.setattr(main_module.httpx, 'AsyncClient', lambda *a, **k: client)
        with caplog.at_level(logging.ERROR, logger='main'):
            assert await register_executor() is False
        assert any('401' in r.getMessage() for r in caplog.records)

    @pytest.mark.asyncio
    async def test_returns_false_on_transport_error(self, monkeypatch):
        client = _mock_client()
        client.post = AsyncMock(side_effect=ConnectionError('admin unreachable'))
        monkeypatch.setattr(main_module.httpx, 'AsyncClient', lambda *a, **k: client)
        assert await register_executor() is False

    @pytest.mark.asyncio
    async def test_re_register_carries_same_payload_as_first_register(self, monkeypatch):
        """端到端语义：补注册走的 register 与 lifespan 首次注册共用
        _register_payload()——富元数据一致性由单一来源保证。"""
        client = _mock_client()
        _ok_register(client)
        monkeypatch.setattr(main_module.httpx, 'AsyncClient', lambda *a, **k: client)

        await register_executor()

        assert client.post.call_args.kwargs['json'] == main_module._register_payload()
