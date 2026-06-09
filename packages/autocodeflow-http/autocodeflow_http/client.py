"""AutoFlow HTTP client with retry, auth, and circuit breaker."""
from __future__ import annotations

import time
import logging
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx
from tenacity import (
    retry,
    stop_after_attempt,
    wait_exponential,
    retry_if_exception_type,
)

logger = logging.getLogger(__name__)


@dataclass
class RetryConfig:
    """Configuration for HTTP retry behavior."""
    max_retries: int = 3
    min_wait_sec: float = 1.0
    max_wait_sec: float = 30.0
    retryable_statuses: tuple[int, ...] = (429, 500, 502, 503, 504)


@dataclass
class CircuitBreaker:
    """
    Simple circuit breaker — opens after consecutive failures,
    stays open for `reset_timeout_sec`, then allows one probe request.
    """
    failure_threshold: int = 5
    reset_timeout_sec: float = 60.0

    _failure_count: int = field(default=0, init=False, repr=False)
    _last_failure_time: float = field(default=0.0, init=False, repr=False)
    _state: str = field(default="closed", init=False, repr=False)  # closed | open | half_open

    @property
    def is_open(self) -> bool:
        if self._state == "closed":
            return False
        if self._state == "open":
            if time.monotonic() - self._last_failure_time > self.reset_timeout_sec:
                self._state = "half_open"
                return False
            return True
        return False  # half_open — allow probe

    def success(self) -> None:
        self._failure_count = 0
        self._state = "closed"

    def failure(self) -> None:
        self._failure_count += 1
        self._last_failure_time = time.monotonic()
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

    def _build_headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers: dict[str, str] = {}
        if self._auth_token:
            headers["Authorization"] = f"Bearer {self._auth_token}"
        if extra:
            headers.update(extra)
        return headers

    async def _request(
        self, method: str, path: str, data: Any = None, headers: dict[str, str] | None = None
    ) -> httpx.Response:
        if self._breaker.is_open:
            raise RuntimeError("Circuit breaker is open — request blocked")

        url = f"{self.base_url}{path}" if self.base_url else path

        @retry(
            stop=stop_after_attempt(self._retry.max_retries + 1),
            wait=wait_exponential(multiplier=self._retry.min_wait_sec, max=self._retry.max_wait_sec),
            retry=retry_if_exception_type((httpx.HTTPStatusError, httpx.TimeoutException, httpx.ConnectError)),
            reraise=True,
        )
        async def _do() -> httpx.Response:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
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

        try:
            resp = await _do()
            self._breaker.success()
            return resp
        except Exception:
            self._breaker.failure()
            raise

    async def get(self, path: str, headers: dict[str, str] | None = None) -> httpx.Response:
        return await self._request("GET", path, headers=headers)

    async def post(self, path: str, data: Any = None, headers: dict[str, str] | None = None) -> httpx.Response:
        return await self._request("POST", path, data=data, headers=headers)

    async def put(self, path: str, data: Any = None, headers: dict[str, str] | None = None) -> httpx.Response:
        return await self._request("PUT", path, data=data, headers=headers)

    async def delete(self, path: str, headers: dict[str, str] | None = None) -> httpx.Response:
        return await self._request("DELETE", path, headers=headers)

    def set_auth_token(self, token: str) -> None:
        self._auth_token = token