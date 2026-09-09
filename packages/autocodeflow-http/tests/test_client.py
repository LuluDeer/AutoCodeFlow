"""Unit tests for autocodeflow-http client."""
from __future__ import annotations

import pytest
import pytest_asyncio
import httpx
from unittest.mock import AsyncMock, MagicMock, patch

from autocodeflow_http import AutoFlowHttpClient, CircuitBreaker, RetryConfig, SAFE_METHODS


class TestCircuitBreaker:
    """Tests for the CircuitBreaker class."""

    def test_initially_closed(self):
        breaker = CircuitBreaker(failure_threshold=3)
        assert not breaker.is_open

    def test_opens_after_threshold(self):
        breaker = CircuitBreaker(failure_threshold=3, reset_timeout_sec=999)
        for _ in range(3):
            breaker.failure()
        assert breaker.is_open

    def test_resets_on_success(self):
        breaker = CircuitBreaker(failure_threshold=2, reset_timeout_sec=999)
        breaker.failure()
        breaker.failure()
        assert breaker.is_open
        breaker.success()
        assert not breaker.is_open

    def test_half_open_after_timeout(self, monkeypatch):
        import time
        breaker = CircuitBreaker(failure_threshold=1, reset_timeout_sec=1)
        breaker.failure()
        assert breaker.is_open
        # Simulate time passing beyond reset_timeout_sec
        monkeypatch.setattr(time, "monotonic", lambda: breaker._last_failure_time + 2)
        assert not breaker.is_open  # half_open => allows probe


class TestRetryConfig:
    """Tests for RetryConfig defaults."""

    def test_default_values(self):
        cfg = RetryConfig()
        assert cfg.max_retries == 3
        assert cfg.min_wait_sec == 1.0
        assert cfg.max_wait_sec == 30.0
        assert 500 in cfg.retryable_statuses
        assert 429 in cfg.retryable_statuses
        # U4: safe-methods-only retry is the safe default.
        assert cfg.safe_methods_only is True

    def test_custom_values(self):
        cfg = RetryConfig(max_retries=5, retryable_statuses=(503,))
        assert cfg.max_retries == 5
        assert cfg.retryable_statuses == (503,)

    def test_safe_methods_only_can_be_disabled(self):
        cfg = RetryConfig(safe_methods_only=False)
        assert cfg.safe_methods_only is False


class TestAutoFlowHttpClient:
    """Tests for AutoFlowHttpClient."""

    @pytest.mark.asyncio
    async def test_get_success(self, respx_mock):
        respx_mock.get("http://api.example.com/data").mock(
            return_value=httpx.Response(200, json={"key": "value"})
        )
        client = AutoFlowHttpClient(
            base_url="http://api.example.com",
            retry_config=RetryConfig(max_retries=0),
        )
        resp = await client.get("/data")
        assert resp.status_code == 200
        assert resp.json() == {"key": "value"}

    @pytest.mark.asyncio
    async def test_post_success(self, respx_mock):
        respx_mock.post("http://api.example.com/items").mock(
            return_value=httpx.Response(201, json={"id": "abc"})
        )
        client = AutoFlowHttpClient(
            base_url="http://api.example.com",
            retry_config=RetryConfig(max_retries=0),
        )
        resp = await client.post("/items", data={"name": "test"})
        assert resp.status_code == 201

    @pytest.mark.asyncio
    async def test_auth_header_added(self, respx_mock):
        route = respx_mock.get("http://api.example.com/secure").mock(
            return_value=httpx.Response(200, json={})
        )
        client = AutoFlowHttpClient(
            base_url="http://api.example.com",
            auth_token="my-token",
            retry_config=RetryConfig(max_retries=0),
        )
        await client.get("/secure")
        request = route.calls.last.request
        assert request.headers.get("authorization") == "Bearer my-token"

    @pytest.mark.asyncio
    async def test_circuit_breaker_blocks_request(self):
        breaker = CircuitBreaker(failure_threshold=1, reset_timeout_sec=999)
        breaker.failure()  # trip the breaker immediately
        client = AutoFlowHttpClient(
            base_url="http://api.example.com",
            circuit_breaker=breaker,
        )
        with pytest.raises(RuntimeError, match="Circuit breaker is open"):
            await client.get("/data")

    @pytest.mark.asyncio
    async def test_set_auth_token(self, respx_mock):
        route = respx_mock.get("http://api.example.com/x").mock(
            return_value=httpx.Response(200, json={})
        )
        client = AutoFlowHttpClient(
            base_url="http://api.example.com",
            retry_config=RetryConfig(max_retries=0),
        )
        client.set_auth_token("new-token")
        await client.get("/x")
        assert route.calls.last.request.headers.get("authorization") == "Bearer new-token"


class TestRetryMethodSafety:
    """U4: auto-retry must stay on safe methods only by default.

    Retrying a POST/PUT/DELETE after a timeout or a 5xx that already
    committed duplicates the side effect on the external service, so
    mutating methods are attempted exactly once unless the caller
    explicitly opts back in via RetryConfig(safe_methods_only=False).
    """

    FAST = dict(max_retries=3, min_wait_sec=0.001, max_wait_sec=0.002)

    @pytest.mark.asyncio
    async def test_safe_methods_constant(self):
        assert SAFE_METHODS == frozenset({"GET", "HEAD", "OPTIONS"})

    @pytest.mark.asyncio
    async def test_post_retryable_status_not_retried_by_default(self, respx_mock):
        route = respx_mock.post("http://api.example.com/items").mock(
            return_value=httpx.Response(503)
        )
        client = AutoFlowHttpClient(
            base_url="http://api.example.com",
            retry_config=RetryConfig(**self.FAST),
        )
        with pytest.raises(httpx.HTTPStatusError):
            await client.post("/items", data={"name": "x"})
        assert route.call_count == 1  # single attempt — no duplicate side effect

    @pytest.mark.asyncio
    async def test_post_connect_error_not_retried_by_default(self, respx_mock):
        route = respx_mock.put("http://api.example.com/items/1").mock(
            side_effect=httpx.ConnectError("boom")
        )
        client = AutoFlowHttpClient(
            base_url="http://api.example.com",
            retry_config=RetryConfig(**self.FAST),
        )
        with pytest.raises(httpx.ConnectError):
            await client.put("/items/1", data={"name": "x"})
        assert route.call_count == 1

    @pytest.mark.asyncio
    async def test_get_retryable_status_is_retried(self, respx_mock):
        route = respx_mock.get("http://api.example.com/data").mock(
            side_effect=[httpx.Response(503), httpx.Response(200, json={"ok": True})]
        )
        client = AutoFlowHttpClient(
            base_url="http://api.example.com",
            retry_config=RetryConfig(**self.FAST),
        )
        resp = await client.get("/data")
        assert resp.status_code == 200
        assert route.call_count == 2  # 503 → one retry → 200

    @pytest.mark.asyncio
    async def test_delete_not_retried_by_default(self, respx_mock):
        route = respx_mock.delete("http://api.example.com/items/1").mock(
            return_value=httpx.Response(429)
        )
        client = AutoFlowHttpClient(
            base_url="http://api.example.com",
            retry_config=RetryConfig(**self.FAST),
        )
        with pytest.raises(httpx.HTTPStatusError):
            await client.delete("/items/1")
        assert route.call_count == 1

    @pytest.mark.asyncio
    async def test_post_retried_when_explicitly_enabled(self, respx_mock):
        route = respx_mock.post("http://api.example.com/items").mock(
            side_effect=[httpx.Response(503), httpx.Response(201, json={"id": "abc"})]
        )
        client = AutoFlowHttpClient(
            base_url="http://api.example.com",
            retry_config=RetryConfig(safe_methods_only=False, **self.FAST),
        )
        resp = await client.post("/items", data={"name": "x"})
        assert resp.status_code == 201
        assert route.call_count == 2  # opt-in restores legacy retry-everything

    @pytest.mark.asyncio
    async def test_401_and_403_are_not_retried_and_return_response(self, respx_mock):
        route = respx_mock.get("http://api.example.com/secure").mock(
            side_effect=[httpx.Response(401), httpx.Response(403)]
        )
        client = AutoFlowHttpClient(
            base_url="http://api.example.com",
            retry_config=RetryConfig(**self.FAST),
        )

        assert (await client.get("/secure")).status_code == 401
        assert (await client.get("/secure")).status_code == 403
        assert route.call_count == 2

    @pytest.mark.asyncio
    async def test_get_exhausts_retry_budget_as_max_retries_plus_one_attempts(self, respx_mock):
        route = respx_mock.get("http://api.example.com/data").mock(
            return_value=httpx.Response(503)
        )
        client = AutoFlowHttpClient(
            base_url="http://api.example.com",
            retry_config=RetryConfig(max_retries=3, min_wait_sec=0.001, max_wait_sec=0.002),
        )

        with pytest.raises(httpx.HTTPStatusError):
            await client.get("/data")
        assert route.call_count == 4

    @pytest.mark.asyncio
    async def test_get_timeout_is_retried_but_post_timeout_is_not(self, respx_mock):
        get_route = respx_mock.get("http://api.example.com/data").mock(
            side_effect=[httpx.ReadTimeout("slow"), httpx.Response(200, json={"ok": True})]
        )
        post_route = respx_mock.post("http://api.example.com/items").mock(
            side_effect=httpx.ReadTimeout("slow")
        )
        client = AutoFlowHttpClient(
            base_url="http://api.example.com",
            retry_config=RetryConfig(**self.FAST),
        )

        assert (await client.get("/data")).status_code == 200
        with pytest.raises(httpx.ReadTimeout):
            await client.post("/items", data={"name": "x"})
        assert get_route.call_count == 2
        assert post_route.call_count == 1
