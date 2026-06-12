"""Unit tests for autocodeflow-http client."""
from __future__ import annotations

import pytest
import pytest_asyncio
import httpx
from unittest.mock import AsyncMock, MagicMock, patch

from autocodeflow_http import AutoFlowHttpClient, CircuitBreaker, RetryConfig


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

    def test_custom_values(self):
        cfg = RetryConfig(max_retries=5, retryable_statuses=(503,))
        assert cfg.max_retries == 5
        assert cfg.retryable_statuses == (503,)


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
