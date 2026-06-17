import pytest
import httpx
from unittest.mock import AsyncMock, patch, MagicMock
from scheduler import _send_heartbeat


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