"""AutoFlow HTTP client with retry, auth, and circuit breaker.

## 错误契约（PK-32，DEEP_REVIEW 0ef3bbe）

消费方据此预期行为，无需读实现即可知道哪些状态码会重试、哪些直接抛：

- **可重试状态码**（``RetryConfig.retryable_statuses``，默认 ``(429, 500, 502, 503, 504)``）：
  ``_do`` 收到这些状态码时**抛** ``httpx.HTTPStatusError``（不返回 resp），由 tenacity
  决定是否重试。其余状态码（含 4xx 业务错误）原样返回 resp，不抛、不重试。
- **安全方法 vs 非安全方法**（``RetryConfig.safe_methods_only``，默认 ``True``）：
  - 安全方法（GET/HEAD/OPTIONS，见 ``SAFE_METHODS``）：自动重试——tenacity 包装
    ``_do``，最多 ``max_retries + 1`` 次，指数退避并尊重 ``Retry-After`` 头。
  - 非安全方法（POST/PUT/PATCH/DELETE）：**默认只发一次，不自动重试**。即使收到
    429/503 这类可重试状态码，``HTTPStatusError`` 也立即抛给调用方——避免超时/5xx
    后服务端实际已提交导致重复副作用。需要重试 mutating 请求时显式设
    ``safe_methods_only=False``（仅当端点自带幂等键才合适）。
- **会重试的异常类型**：``httpx.HTTPStatusError``（可重试状态码）、
  ``httpx.TimeoutException``、``httpx.ConnectError``。其余异常（ValueError/业务错误）
  不重试、不计入熔断。
- **熔断**：仅上述网络类/5xx/429 计入 ``CircuitBreaker`` 失败计数（见
  ``_CIRCUIT_BREAKABLE_EXC``）；非网络异常不计。熔断 open 时请求直接抛
  ``RuntimeError("Circuit breaker is open ...")``。

### 与 node SDK 的 parity 关系

本包（Python）有上述重试 + 熔断契约；``packages/autocodeflow-node-sdk`` 的
``http-client.ts`` 是纯 axios 薄包装（``axios.create({timeout: 10_000})``，**无重试
拦截器、无熔断**）。两侧行为**不对齐**：调用方不能假设 node SDK 会按本契约重试。
"""
from __future__ import annotations

import asyncio
import time
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Optional

import httpx
from tenacity import (
    retry,
    stop_after_attempt,
    wait_exponential,
    retry_if_exception_type,
    RetryCallState,
)

logger = logging.getLogger(__name__)

# U4: RFC 9110 "safe" methods — retrying these can never cause duplicate
# side effects on the server, unlike POST/PUT/DELETE/PATCH.
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

# PK-09: circuit breaker 只统计网络类失败（连接错误/超时/5xx）。
# 非网络异常（ValueError/TypeError/业务逻辑错误）不计入熔断失败计数。
_CIRCUIT_BREAKABLE_EXC = (
    httpx.HTTPStatusError,  # 5xx / 429（_do 只对 retryable_statuses 抛）
    httpx.TimeoutException,
    httpx.ConnectError,
    httpx.NetworkError,
)


@dataclass
class RetryConfig:
    """Configuration for HTTP retry behavior."""
    max_retries: int = 3
    min_wait_sec: float = 1.0
    max_wait_sec: float = 30.0
    retryable_statuses: tuple[int, ...] = (429, 500, 502, 503, 504)
    #: U4: when True (default), only safe/idempotent methods (GET/HEAD/OPTIONS)
    #: are retried automatically. Mutating requests (POST/PUT/PATCH/DELETE) are
    #: attempted exactly once, because a retry after a timeout or a 5xx that
    #: actually committed would duplicate side effects on the external
    #: service. Set to False to restore the legacy retry-everything behaviour
    #: (only appropriate for endpoints whose payloads carry their own
    #: idempotency key).
    safe_methods_only: bool = True


class _WaitWithRetryAfter:
    """PK-09: tenacity wait strategy that respects the Retry-After header.

    Falls back to the base exponential backoff, but if the server returned
    a ``Retry-After`` header (either a delta-seconds integer or an HTTP-date),
    waits at least that long — taking the max of our backoff and the
    server-specified delay.
    """

    def __init__(self, base: wait_exponential):
        self._base = base

    def __call__(self, retry_state: RetryCallState) -> float:
        wait = self._base(retry_state)
        exc = retry_state.outcome.exception() if retry_state.outcome else None
        if isinstance(exc, httpx.HTTPStatusError):
            raw = exc.response.headers.get("Retry-After")
            if raw:
                parsed = self._parse_retry_after(raw)
                if parsed is not None:
                    wait = max(wait, parsed)
        return wait

    @staticmethod
    def _parse_retry_after(value: str) -> Optional[float]:
        """Parse Retry-After as delta-seconds or HTTP-date; None on failure."""
        value = value.strip()
        try:
            return float(value)
        except ValueError:
            pass
        try:
            dt = parsedate_to_datetime(value)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return max(0.0, (dt - datetime.now(timezone.utc)).total_seconds())
        except (TypeError, ValueError):
            logger.warning("Unparseable Retry-After header: %r", value)
            return None


@dataclass
class CircuitBreaker:
    """
    Simple circuit breaker — opens after consecutive failures,
    stays open for `reset_timeout_sec`, then allows one probe request.

    PK-09: half-open 态探测加并发上限——同时只允许 1 个探测请求在飞，
    其余请求在 half_open 期间被拒绝（is_open 返回 True），避免半开态
    并发打爆刚恢复的服务。
    """
    failure_threshold: int = 5
    reset_timeout_sec: float = 60.0

    _failure_count: int = field(default=0, init=False, repr=False)
    _last_failure_time: float = field(default=0.0, init=False, repr=False)
    _state: str = field(default="closed", init=False, repr=False)  # closed | open | half_open
    # PK-09: half_open 态探测在飞标志——并发上限 1。
    _probe_in_flight: bool = field(default=False, init=False, repr=False)

    @property
    def is_open(self) -> bool:
        if self._state == "closed":
            return False
        if self._state == "open":
            if time.monotonic() - self._last_failure_time > self.reset_timeout_sec:
                self._state = "half_open"
                return False
            return True
        # half_open: 已有探测在飞 → 拒绝新请求；否则允许一个探测。
        return self._probe_in_flight

    def acquire_probe(self) -> bool:
        """PK-09: 尝试占用 half-open 探测槽。True=获准探测。"""
        if self._state == "half_open" and not self._probe_in_flight:
            self._probe_in_flight = True
            return True
        return self._state == "closed"

    def release_probe(self) -> None:
        """PK-09: 探测结束（成功或失败）后释放探测槽。"""
        self._probe_in_flight = False

    def success(self) -> None:
        self._failure_count = 0
        self._state = "closed"
        self._probe_in_flight = False

    def failure(self) -> None:
        self._failure_count += 1
        self._last_failure_time = time.monotonic()
        self._probe_in_flight = False
        if self._failure_count >= self.failure_threshold:
            self._state = "open"
            logger.warning(f"Circuit breaker opened after {self._failure_count} failures")


class AutoFlowHttpClient:
    """
    HTTP client with built-in retry, authentication, and circuit breaker.

    Usage::

        client = AutoFlowHttpClient(base_url="https://api.example.com", auth_token="xxx")
        resp = await client.get("/data")
    """

    def __init__(
        self,
        base_url: str = "",
        auth_token: Optional[str] = None,
        timeout_sec: float = 30.0,
        retry_config: Optional[RetryConfig] = None,
        circuit_breaker: Optional[CircuitBreaker] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self._auth_token = auth_token
        self._timeout = timeout_sec
        self._retry = retry_config or RetryConfig()
        self._breaker = circuit_breaker or CircuitBreaker()
        # PK-09(1): 实例级 AsyncClient 单例（lazy init），实现连接池复用。
        # 此前每请求新建 AsyncClient → 零连接复用。
        self._client: Optional[httpx.AsyncClient] = None
        self._client_lock = asyncio.Lock()

    def _get_client(self) -> httpx.AsyncClient:
        """PK-09: lazy-init 实例级 AsyncClient，复用连接池。"""
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=self._timeout)
        return self._client

    async def aclose(self) -> None:
        """显式关闭底层 AsyncClient（连接池释放）。"""
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    def _build_headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers: dict[str, str] = {}
        if self._auth_token:
            headers["Authorization"] = f"Bearer {self._auth_token}"
        if extra:
            headers.update(extra)
        return headers

    def _should_retry(self, method: str) -> bool:
        """U4: auto-retry is limited to safe methods unless explicitly opted out."""
        if not self._retry.safe_methods_only:
            return True
        return method.upper() in SAFE_METHODS

    async def _request(
        self, method: str, path: str, data: Any = None, headers: dict[str, str] | None = None
    ) -> httpx.Response:
        """执行一次 HTTP 请求（带重试 + 熔断）。

        PK-32 错误契约详见模块 docstring。要点：
        - 可重试状态码（429/5xx 默认）抛 ``HTTPStatusError``；
        - 安全方法自动重试，非安全方法默认只发一次（``safe_methods_only``）；
        - 熔断 open 时直接抛 ``RuntimeError``，不发起网络请求。
        """
        if self._breaker.is_open:
            raise RuntimeError("Circuit breaker is open — request blocked")

        url = f"{self.base_url}{path}" if self.base_url else path

        async def _do() -> httpx.Response:
            # PK-09(1): 复用实例级 AsyncClient（连接池）。
            client = self._get_client()
            resp = await client.request(
                method, url, json=data, headers=self._build_headers(headers),
            )
            if resp.status_code in self._retry.retryable_statuses:
                raise httpx.HTTPStatusError(
                    f"{resp.status_code} {resp.reason_phrase}",
                    request=resp.request,
                    response=resp,
                )
            return resp

        # U4: mutating methods (POST/PUT/PATCH/DELETE) are attempted exactly
        # once by default — a blind retry after a timeout/5xx can duplicate
        # the side effect server-side. Only safe methods get the tenacity
        # wrapper unless RetryConfig.safe_methods_only is disabled.
        if self._should_retry(method):
            # PK-09(3): wait strategy 解析 Retry-After header（与自身退避取大）。
            _do = retry(
                stop=stop_after_attempt(self._retry.max_retries + 1),
                wait=_WaitWithRetryAfter(
                    wait_exponential(multiplier=self._retry.min_wait_sec, max=self._retry.max_wait_sec)
                ),
                retry=retry_if_exception_type((httpx.HTTPStatusError, httpx.TimeoutException, httpx.ConnectError)),
                reraise=True,
            )(_do)

        # PK-09(2): half-open 探测并发上限——尝试占用探测槽。
        probe_acquired = self._breaker.acquire_probe()
        try:
            resp = await _do()
            self._breaker.success()
            return resp
        except _CIRCUIT_BREAKABLE_EXC:
            # PK-09(4): 仅网络异常/超时/5xx 计入熔断失败计数。
            self._breaker.failure()
            raise
        finally:
            if probe_acquired:
                self._breaker.release_probe()

    async def get(self, path: str, headers: dict[str, str] | None = None) -> httpx.Response:
        """GET（安全方法）：可重试状态码/网络错误自动重试。错误契约见模块 docstring。"""
        return await self._request("GET", path, headers=headers)

    async def post(self, path: str, data: Any = None, headers: dict[str, str] | None = None) -> httpx.Response:
        """POST（非安全方法）：**默认只发一次不重试**——即使收到 429/503 也立即抛
        ``HTTPStatusError`` 给调用方，避免重复副作用。需要重试请设
        ``RetryConfig(safe_methods_only=False)``（仅幂等端点合适）。错误契约见模块 docstring。"""
        return await self._request("POST", path, data=data, headers=headers)

    async def put(self, path: str, data: Any = None, headers: dict[str, str] | None = None) -> httpx.Response:
        """PUT（非安全方法）：同 post——默认只发一次不重试。错误契约见模块 docstring。"""
        return await self._request("PUT", path, data=data, headers=headers)

    async def delete(self, path: str, headers: dict[str, str] | None = None) -> httpx.Response:
        """DELETE（非安全方法）：同 post——默认只发一次不重试。错误契约见模块 docstring。"""
        return await self._request("DELETE", path, headers=headers)

    def set_auth_token(self, token: str) -> None:
        self._auth_token = token
