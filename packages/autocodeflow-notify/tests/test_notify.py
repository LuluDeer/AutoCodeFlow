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
        assert NotifyChannel.WEBHOOK == "webhook"


class TestNotifyClient:

    @pytest.mark.asyncio
    async def test_notify_success(self, respx_mock):
        route = respx_mock.post("http://localhost:3105/api/notification/send").mock(
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
        route = respx_mock.post("http://localhost:3105/api/notification/send").mock(
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
        respx_mock.post("http://localhost:3105/api/notification/send").mock(
            side_effect=httpx.ConnectError("refused")
        )
        client = NotifyClient(admin_api_url="http://localhost:3105")
        # Should not raise
        await client.notify("my-task", "msg")

    @pytest.mark.asyncio
    async def test_notify_failure_sends_error_level(self, respx_mock):
        route = respx_mock.post("http://localhost:3105/api/notification/send").mock(
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
        route = respx_mock.post("http://localhost:3105/api/notification/send").mock(
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
        route = respx_mock.post("http://localhost:3105/api/notification/send").mock(
            return_value=httpx.Response(200, json={})
        )
        client = NotifyClient(admin_api_url="http://localhost:3105", auth_token="tok-123")
        await client.notify("my-task", "msg")
        assert route.calls.last.request.headers.get("authorization") == "Bearer tok-123"


class TestNotifyReturnBool:
    """R14a: notify() must distinguish success from rejection."""

    @pytest.mark.asyncio
    async def test_notify_returns_true_on_2xx(self, respx_mock):
        respx_mock.post("http://localhost:3105/api/notification/send").mock(
            return_value=httpx.Response(200, json={"success": True})
        )
        client = NotifyClient(admin_api_url="http://localhost:3105")
        assert await client.notify("my-task", "msg") is True

    @pytest.mark.asyncio
    async def test_notify_returns_false_on_401_invalid_token(self, respx_mock, caplog):
        respx_mock.post("http://localhost:3105/api/notification/send").mock(
            return_value=httpx.Response(401, json={"message": "Unauthorized"})
        )
        client = NotifyClient(admin_api_url="http://localhost:3105", auth_token="stale")
        with caplog.at_level("ERROR", logger="autocodeflow_notify.notify"):
            result = await client.notify("my-task", "msg")
        assert result is False
        assert any("401" in rec.message for rec in caplog.records)

    @pytest.mark.asyncio
    async def test_notify_returns_false_on_400_bad_level(self, respx_mock, caplog):
        respx_mock.post("http://localhost:3105/api/notification/send").mock(
            return_value=httpx.Response(
                400, json={"message": ["level must be a valid enum value"]}
            )
        )
        client = NotifyClient(admin_api_url="http://localhost:3105")
        with caplog.at_level("ERROR", logger="autocodeflow_notify.notify"):
            result = await client.notify("my-task", "msg", level="bogus")
        assert result is False
        assert any("400" in rec.message for rec in caplog.records)

    @pytest.mark.asyncio
    async def test_notify_logs_html_body_sanitized_and_truncated(self, respx_mock, caplog):
        """HTML error page: tags stripped, whitespace collapsed, bounded length."""
        html = "<html><head><title>Error</title></head><body><h1>502 Bad Gateway</h1>" + ("x" * 5000) + "</body></html>"
        respx_mock.post("http://localhost:3105/api/notification/send").mock(
            return_value=httpx.Response(502, text=html)
        )
        client = NotifyClient(admin_api_url="http://localhost:3105")
        with caplog.at_level("ERROR", logger="autocodeflow_notify.notify"):
            result = await client.notify("my-task", "msg")
        assert result is False
        msg = next(rec.message for rec in caplog.records if "502" in rec.message)
        assert "<html>" not in msg and "<h1>" not in msg
        assert "502 Bad Gateway" in msg
        assert len(msg) < 400  # body digest truncated, single-line log
        assert "\n" not in msg

    @pytest.mark.asyncio
    async def test_notify_returns_false_on_network_error(self, respx_mock):
        respx_mock.post("http://localhost:3105/api/notification/send").mock(
            side_effect=httpx.ConnectError("refused")
        )
        client = NotifyClient(admin_api_url="http://localhost:3105")
        assert await client.notify("my-task", "msg") is False

    @pytest.mark.asyncio
    async def test_notify_failure_helper_propagates_bool(self, respx_mock):
        respx_mock.post("http://localhost:3105/api/notification/send").mock(
            return_value=httpx.Response(500, text="boom")
        )
        client = NotifyClient(admin_api_url="http://localhost:3105")
        assert await client.notify_failure("my-task", "err") is False


class TestNotifyWebhookChannel:
    """R14b: per-request webhook channel + webhookUrl passthrough."""

    @pytest.mark.asyncio
    async def test_webhook_channel_in_enum_matches_server(self):
        # Server AlertChannel enum includes "webhook" (notification.service.ts).
        assert NotifyChannel.WEBHOOK.value == "webhook"

    @pytest.mark.asyncio
    async def test_webhook_channel_sends_webhook_url(self, respx_mock):
        route = respx_mock.post("http://localhost:3105/api/notification/send").mock(
            return_value=httpx.Response(200, json={"success": True})
        )
        client = NotifyClient(admin_api_url="http://localhost:3105")
        result = await client.notify(
            "my-task",
            "msg",
            channels=[NotifyChannel.WEBHOOK],
            webhook_url="https://example.com/hook",
        )
        assert result is True
        import json
        body = json.loads(route.calls.last.request.content)
        assert body["channels"] == ["webhook"]
        assert body["webhookUrl"] == "https://example.com/hook"

    @pytest.mark.asyncio
    async def test_webhook_url_alone_lets_server_fan_out(self, respx_mock):
        """Server adds the webhook channel when only webhookUrl is present."""
        route = respx_mock.post("http://localhost:3105/api/notification/send").mock(
            return_value=httpx.Response(200, json={"success": True})
        )
        client = NotifyClient(admin_api_url="http://localhost:3105")
        await client.notify("my-task", "msg", webhook_url="https://example.com/hook")
        import json
        body = json.loads(route.calls.last.request.content)
        assert "channels" not in body
        assert body["webhookUrl"] == "https://example.com/hook"

    @pytest.mark.asyncio
    async def test_webhook_url_omitted_from_payload_when_none(self, respx_mock):
        route = respx_mock.post("http://localhost:3105/api/notification/send").mock(
            return_value=httpx.Response(200, json={"success": True})
        )
        client = NotifyClient(admin_api_url="http://localhost:3105")
        await client.notify("my-task", "msg", channels=[NotifyChannel.SLACK])
        import json
        body = json.loads(route.calls.last.request.content)
        assert "webhookUrl" not in body

    @pytest.mark.asyncio
    async def test_notify_failure_webhook_passthrough(self, respx_mock):
        route = respx_mock.post("http://localhost:3105/api/notification/send").mock(
            return_value=httpx.Response(200, json={"success": True})
        )
        client = NotifyClient(admin_api_url="http://localhost:3105")
        assert await client.notify_failure(
            "my-task", "err", webhook_url="https://example.com/hook"
        ) is True
        import json
        body = json.loads(route.calls.last.request.content)
        assert body["webhookUrl"] == "https://example.com/hook"
        assert body["level"] == "error"
