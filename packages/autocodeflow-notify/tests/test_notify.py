"""Unit tests for autocodeflow-notify."""
from __future__ import annotations

import pytest
import httpx
from unittest.mock import AsyncMock, patch, MagicMock

from autocodeflow_notify import NotifyClient, NotifyChannel


class TestNotifyChannel:
    def test_channel_values(self):
        assert NotifyChannel.EMAIL == "email"
        assert NotifyChannel.DINGTALK == "dingtalk"
        assert NotifyChannel.WECOM == "wecom"
        assert NotifyChannel.SLACK == "slack"


class TestNotifyClient:

    @pytest.mark.asyncio
    async def test_notify_success(self, respx_mock):
        route = respx_mock.post("http://localhost:3105/api/notifications/send").mock(
            return_value=httpx.Response(200, json={"ok": True})
        )
        client = NotifyClient(admin_api_url="http://localhost:3105")
        await client.notify("my-task", "all good", level="info")
        assert route.called
        payload = route.calls.last.request.content
        import json
        body = json.loads(payload)
        assert body["level"] == "info"
        assert "my-task" in body["title"]

    @pytest.mark.asyncio
    async def test_notify_with_channels(self, respx_mock):
        route = respx_mock.post("http://localhost:3105/api/notifications/send").mock(
            return_value=httpx.Response(200, json={})
        )
        client = NotifyClient(admin_api_url="http://localhost:3105")
        await client.notify(
            "my-task",
            "message",
            channels=[NotifyChannel.SLACK, NotifyChannel.EMAIL],
        )
        import json
        body = json.loads(route.calls.last.request.content)
        assert "slack" in body["channels"]
        assert "email" in body["channels"]

    @pytest.mark.asyncio
    async def test_notify_failure_does_not_raise(self, respx_mock):
        """Network errors should be caught and logged, not raised."""
        respx_mock.post("http://localhost:3105/api/notifications/send").mock(
            side_effect=httpx.ConnectError("refused")
        )
        client = NotifyClient(admin_api_url="http://localhost:3105")
        # Should not raise
        await client.notify("my-task", "msg")

    @pytest.mark.asyncio
    async def test_notify_failure_sends_error_level(self, respx_mock):
        route = respx_mock.post("http://localhost:3105/api/notifications/send").mock(
            return_value=httpx.Response(200, json={})
        )
        client = NotifyClient(admin_api_url="http://localhost:3105")
        await client.notify_failure("my-task", "DB connection refused", exec_id="ex-1")
        import json
        body = json.loads(route.calls.last.request.content)
        assert body["level"] == "error"
        assert "ex-1" in body["content"]

    @pytest.mark.asyncio
    async def test_notify_success_sends_info_level(self, respx_mock):
        route = respx_mock.post("http://localhost:3105/api/notifications/send").mock(
            return_value=httpx.Response(200, json={})
        )
        client = NotifyClient(admin_api_url="http://localhost:3105")
        await client.notify_success("my-task", duration_ms=1234)
        import json
        body = json.loads(route.calls.last.request.content)
        assert body["level"] == "info"
        assert "1234ms" in body["content"]

    @pytest.mark.asyncio
    async def test_auth_token_header(self, respx_mock):
        route = respx_mock.post("http://localhost:3105/api/notifications/send").mock(
            return_value=httpx.Response(200, json={})
        )
        client = NotifyClient(admin_api_url="http://localhost:3105", auth_token="tok-123")
        await client.notify("my-task", "msg")
        assert route.calls.last.request.headers.get("authorization") == "Bearer tok-123"
