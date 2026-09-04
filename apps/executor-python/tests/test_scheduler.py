import asyncio

import pytest
import httpx
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch, MagicMock
from scheduler import _send_heartbeat, heartbeat_task


def create_mock_response(status_code: int = 200) -> httpx.Response:
    """Create a mock httpx.Response with a request object."""
    request = httpx.Request("POST", "http://test.com")
    return httpx.Response(status_code, request=request)


class TestHeartbeatRetry:
    """ERR-04: Test heartbeat retry mechanism with tenacity."""

    @pytest.mark.asyncio
    async def test_heartbeat_retries_on_connection_error(self):
        """Test that heartbeat retries on connection errors."""
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=[
            httpx.ConnectError("Connection refused"),
            httpx.ConnectError("Connection refused"),
            create_mock_response(200),
        ])

        await _send_heartbeat(mock_client, "test-token")

        # Should have retried 3 times (initial + 2 retries)
        assert mock_client.post.call_count == 3

    @pytest.mark.asyncio
    async def test_heartbeat_retries_on_timeout(self):
        """Test that heartbeat retries on timeout."""
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=[
            httpx.TimeoutException("Timed out"),
            create_mock_response(200),
        ])

        await _send_heartbeat(mock_client, "test-token")

        # Should have retried twice
        assert mock_client.post.call_count == 2

    @pytest.mark.asyncio
    async def test_heartbeat_stops_after_max_retries(self):
        """Test that heartbeat stops retrying after max attempts."""
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=[
            httpx.ConnectError("Connection refused"),
            httpx.ConnectError("Connection refused"),
            httpx.ConnectError("Connection refused"),
        ])

        # Patch asyncio.sleep so tenacity's wait_exponential doesn't slow tests
        with patch('asyncio.sleep', new_callable=AsyncMock):
            # reraise=False: tenacity swallows the error after exhausting retries
            await _send_heartbeat(mock_client, "test-token")

        # Should have tried exactly 3 times (stop_after_attempt(3))
        assert mock_client.post.call_count == 3

    @pytest.mark.asyncio
    async def test_heartbeat_success_on_first_attempt(self):
        """Test that heartbeat succeeds immediately when connection works."""
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=create_mock_response(200))

        await _send_heartbeat(mock_client, "test-token")

        # Should have been called only once
        assert mock_client.post.call_count == 1

    @pytest.mark.asyncio
    async def test_heartbeat_without_token(self):
        """Test that heartbeat works without authentication token."""
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=create_mock_response(200))

        await _send_heartbeat(mock_client, "")

        # Verify headers don't include Authorization
        call_args = mock_client.post.call_args
        headers = call_args.kwargs.get('headers', {})
        assert 'Authorization' not in headers

    @pytest.mark.asyncio
    async def test_heartbeat_task_uses_configured_interval(self, monkeypatch):
        """Test that heartbeat loop sleeps for the configured interval."""
        monkeypatch.setattr('scheduler.settings.heartbeat_interval_seconds', 7)
        sleep_mock = AsyncMock(side_effect=asyncio.CancelledError)

        with patch('scheduler.asyncio.sleep', sleep_mock):
            with pytest.raises(asyncio.CancelledError):
                await heartbeat_task()

        sleep_mock.assert_awaited_once_with(7)


class TestHeartbeatCpuSampling:
    """R4-C P3: cpu_percent(interval=1) blocked the event loop for a full
    second on every heartbeat; sampling now runs in a worker thread."""

    @pytest.mark.asyncio
    async def test_cpu_sampling_executed_with_interval_via_thread(self):
        with patch('scheduler.psutil.cpu_percent', return_value=42.0) as cpu_mock, \
             patch('scheduler.psutil.virtual_memory') as mem_mock:
            mem_mock.return_value = SimpleNamespace(percent=10.0)
            mock_client = AsyncMock()
            mock_client.post = AsyncMock(return_value=create_mock_response(200))

            await _send_heartbeat(mock_client, "test-token")

        # positional interval=1 — dispatched through asyncio.to_thread
        assert cpu_mock.call_args.args == (1,)


class TestHeartbeatSelfHeal:
    """R11 (round-11, port of executor-node R10 gap #3): a 401 on the
    heartbeat (admin rotated our per-executor token out from under us) must
    trigger ONE force_token_refresh + retry within the same attempt instead of
    waiting for the 30-minute scheduled refresh."""

    @pytest.mark.asyncio
    async def test_heartbeat_401_heals_and_retries_once(self, monkeypatch):
        import auth as auth_module
        monkeypatch.setattr(
            auth_module, 'force_token_refresh', AsyncMock(return_value='fresh-token')
        )
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=[
            create_mock_response(401),
            create_mock_response(200),
        ])
        with patch('scheduler.psutil.cpu_percent', return_value=1.0), \
             patch('scheduler.psutil.virtual_memory') as mem_mock:
            mem_mock.return_value = SimpleNamespace(percent=2.0)
            await _send_heartbeat(mock_client, 'stale-token')

        # exactly one auth retry: first attempt stale, second the healed token
        assert mock_client.post.call_count == 2
        first = mock_client.post.call_args_list[0].kwargs['headers']
        second = mock_client.post.call_args_list[1].kwargs['headers']
        assert first['Authorization'] == 'Bearer stale-token'
        assert second['Authorization'] == 'Bearer fresh-token'

    @pytest.mark.asyncio
    async def test_heartbeat_401_unchanged_token_adds_no_auth_retry(self, monkeypatch):
        # force_token_refresh yields the SAME token (admin unreachable /
        # idempotent reuse) — the helper adds no retry, so the only posts are
        # tenacity's own transient-failure attempts (3) on the persistent 401.
        import auth as auth_module
        monkeypatch.setattr(
            auth_module, 'force_token_refresh', AsyncMock(return_value='same-token')
        )
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=create_mock_response(401))
        with patch('scheduler.psutil.cpu_percent', return_value=1.0), \
             patch('scheduler.psutil.virtual_memory') as mem_mock, \
             patch('asyncio.sleep', new_callable=AsyncMock):
            mem_mock.return_value = SimpleNamespace(percent=2.0)
            # tenacity swallows the final HTTPStatusError via retry_error_callback
            await _send_heartbeat(mock_client, 'same-token')

        assert mock_client.post.call_count == 3


class TestHeartbeatTokenHashAdoption:
    """R9 (round-9, W3): heartbeat responses echo the stored tokenHash
    ({code,message,data:{tokenHash}}) — the executor must adopt it so the
    per-execution callback-token HMAC key follows admin-side rotations."""

    @pytest.mark.asyncio
    async def test_heartbeat_adopts_token_hash_from_envelope(self, monkeypatch):
        import auth as auth_module
        monkeypatch.setattr(auth_module, '_executor_token_hash', None)
        response = httpx.Response(
            200,
            json={'code': 0, 'message': 'ok', 'data': {'tokenHash': 'hb-hash'}},
            request=httpx.Request('POST', 'http://test.com'),
        )
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=response)

        await _send_heartbeat(mock_client, 'test-token')

        assert auth_module.get_executor_token_hash() == 'hb-hash'

    @pytest.mark.asyncio
    async def test_heartbeat_without_tokenhash_leaves_state(self, monkeypatch):
        import auth as auth_module
        monkeypatch.setattr(auth_module, '_executor_token_hash', 'keep-me')
        mock_client = AsyncMock()
        # Bare 200 response with no JSON body at all (as create_mock_response)
        mock_client.post = AsyncMock(return_value=create_mock_response(200))

        await _send_heartbeat(mock_client, 'test-token')

        assert auth_module.get_executor_token_hash() == 'keep-me'
