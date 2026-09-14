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


# PK-09（DEEP_REVIEW 0ef3bbe）: http client 四项修复回归测试。
class TestPk09ConnectionReuse:
    """PK-09(1): AsyncClient 实例级单例，不每请求新建。"""

    @pytest.mark.asyncio
    async def test_async_client_reused_across_requests(self, respx_mock):
        respx_mock.get("http://api.example.com/a").mock(
            return_value=httpx.Response(200, json={})
        )
        respx_mock.get("http://api.example.com/b").mock(
            return_value=httpx.Response(200, json={})
        )
        client = AutoFlowHttpClient(
            base_url="http://api.example.com",
            retry_config=RetryConfig(max_retries=0),
        )
        await client.get("/a")
        first_client = client._client
        await client.get("/b")
        # 第二次请求复用同一个 AsyncClient 实例（连接池）
        assert client._client is first_client
        assert not client._client.is_closed
        await client.aclose()


class TestPk09HalfOpenConcurrency:
    """PK-09(2): half-open 探测同时只允许 1 个在飞。"""

    def test_half_open_allows_one_probe_then_blocks(self):
        breaker = CircuitBreaker(failure_threshold=1, reset_timeout_sec=1)
        breaker.failure()  # trip → open
        # 模拟时间流逝 → half_open
        import time
        monkeypatch = pytest.MonkeyPatch()
        monkeypatch.setattr(time, "monotonic", lambda: breaker._last_failure_time + 2)

        # 第一次 is_open → 转入 half_open，允许探测
        assert not breaker.is_open
        # acquire_probe 成功
        assert breaker.acquire_probe() is True
        # 第二个请求 is_open → 探测在飞 → 拒绝
        assert breaker.is_open is True
        monkeypatch.undo()

    def test_probe_success_closes_breaker(self):
        breaker = CircuitBreaker(failure_threshold=1, reset_timeout_sec=1)
        breaker.failure()
        import time
        monkeypatch = pytest.MonkeyPatch()
        monkeypatch.setattr(time, "monotonic", lambda: breaker._last_failure_time + 2)
        # 先调 is_open 触发 open→half_open 状态迁移
        assert not breaker.is_open
        assert breaker.acquire_probe() is True
        breaker.success()
        assert breaker._state == "closed"
        assert breaker._probe_in_flight is False
        monkeypatch.undo()


class TestPk09RetryAfter:
    """PK-09(3): 重试时尊重 Retry-After header。"""

    FAST = dict(max_retries=1, min_wait_sec=0.001, max_wait_sec=0.002)

    @pytest.mark.asyncio
    async def test_retry_after_header_influences_wait(self, respx_mock):
        # 第一次返回 429 + Retry-After: 5（秒），第二次 200
        route = respx_mock.get("http://api.example.com/data").mock(
            side_effect=[
                httpx.Response(429, headers={"Retry-After": "0.1"}),
                httpx.Response(200, json={"ok": True}),
            ]
        )
        client = AutoFlowHttpClient(
            base_url="http://api.example.com",
            retry_config=RetryConfig(**self.FAST),
        )
        # 应该成功（retry-after=0.1s 可接受，不超 max_wait 太多但 ≥ base）
        import time
        start = time.monotonic()
        resp = await client.get("/data")
        elapsed = time.monotonic() - start
        assert resp.status_code == 200
        assert route.call_count == 2
        # Retry-After=0.1s 应被尊重（至少等了 ~0.1s）
        assert elapsed >= 0.08

    @pytest.mark.asyncio
    async def test_retry_after_absent_falls_back_to_exponential(self, respx_mock):
        route = respx_mock.get("http://api.example.com/data").mock(
            side_effect=[
                httpx.Response(503),
                httpx.Response(200, json={"ok": True}),
            ]
        )
        client = AutoFlowHttpClient(
            base_url="http://api.example.com",
            retry_config=RetryConfig(**self.FAST),
        )
        resp = await client.get("/data")
        assert resp.status_code == 200
        assert route.call_count == 2


class TestPk09CircuitBreakerExceptionFilter:
    """PK-09(4): 非网络异常不计入熔断失败计数。"""

    @pytest.mark.asyncio
    async def test_non_network_exception_does_not_open_breaker(self, respx_mock):
        breaker = CircuitBreaker(failure_threshold=2, reset_timeout_sec=999)
        client = AutoFlowHttpClient(
            base_url="http://api.example.com",
            circuit_breaker=breaker,
            retry_config=RetryConfig(max_retries=0),
        )
        # _do 抛 ValueError（非网络异常）→ 不计熔断
        respx_mock.get("http://api.example.com/data").mock(
            side_effect=ValueError("business logic error")
        )
        with pytest.raises(ValueError):
            await client.get("/data")
        # failure_count 仍为 0（非网络异常不计入）
        assert breaker._failure_count == 0
        assert not breaker.is_open

    @pytest.mark.asyncio
    async def test_network_exception_counts_toward_breaker(self, respx_mock):
        breaker = CircuitBreaker(failure_threshold=2, reset_timeout_sec=999)
        client = AutoFlowHttpClient(
            base_url="http://api.example.com",
            circuit_breaker=breaker,
            retry_config=RetryConfig(max_retries=0),
        )
        respx_mock.get("http://api.example.com/data").mock(
            side_effect=httpx.ConnectError("boom")
        )
        with pytest.raises(httpx.ConnectError):
            await client.get("/data")
        # 网络异常计入 failure_count
        assert breaker._failure_count == 1
        # 再失败一次 → 熔断打开
        with pytest.raises(httpx.ConnectError):
            await client.get("/data")
        assert breaker._failure_count == 2
        assert breaker.is_open
