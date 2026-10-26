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
  ``httpx.TimeoutException``、``httpx.NetworkError``（父类，覆盖 ConnectError /
  ReadError / WriteError / CloseError）。其余异常（ValueError/业务错误）
  不重试、不计入熔断。
- **熔断**：网络类（上表 + ``httpx.ProtocolError``，即对端中途断连的
  RemoteProtocolError / LocalProtocolError）/ 5xx / 429 计入 ``CircuitBreaker``
  失败计数（见 ``_CIRCUIT_BREAKABLE_EXC``）；非网络异常不计。熔断 open 时请求
  直接抛 ``CircuitBreakerOpenError``（P3-5：RuntimeError 子类——既有
  ``except RuntimeError`` 调用方零改动，但可与之区分编程错误）。
- **响应体上限**（P3-6）：默认 ``max_response_bytes=50MB``，流式读取超限即中止
  并抛 ``ResponseTooLargeError``（rogue 对端防护）；设 None 关闭恢复全量进内存。

### 端间 parity 关系（2026-10-26 如实修订——旧文案声称"四端已对齐"，漂移）

- **本包 ↔ ``packages/autocodeflow-node-sdk`` 两端对齐**（B-4）：node 侧
  ``http-client.ts`` 已补齐同款指数退避重试 + ``CircuitBreaker``——
  ``CircuitBreakerOpenError``、half-open 探测、``Retry-After`` 解析与可重试
  状态码集合均与本契约同构。调用方可按本契约预期 **node SDK 侧**的退避与
  熔断语义，仅此两端。
- **其余两端不在本契约内**（各自 docstring 已有取舍理由，此处互指）：
  - ``packages/autoflow-sdk``（http.py 的 HttpClient / AsyncHttpClient，任务内
    通用通道）：**无重试、无熔断**——理由见其类 docstring（BUG-15 复审定调：
    幂等重试由任务代码自决）；
  - ``packages/acf-cli``（client.ts）：axios 单发 + 401 单飞刷新自愈（BUG-13），
    无重试/熔断——见其 ``getClient`` 头注；
  - ``packages/mcp-server``（api.ts）：仅请求超时（``REQUEST_TIMEOUT_MS``）+
    401 refresh 自愈（BUG-14），无重试/熔断。
  修订任何一端的重试/熔断面之前，请先互读其余各端注释，保持这份地图不失真。
"""
from __future__ import annotations

import random
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

# P3-6: 响应体默认上限（字节）。量级参照 admin-api S3 日志存储的
# MAX_LOG_BYTES（100MB 解压硬帽）；本客户端是任务进程的通用 HTTP 出站，
# 取更保守的 50MB——rogue 对端（配置错误的服务 / 被劫持的代理）一次吐几 GB
# 时，任务进程不至于把整机内存吃穿。构造时传 None 可显式关闭（不推荐）。
DEFAULT_MAX_RESPONSE_BYTES = 50 * 1024 * 1024

# P3-7: 退避加性抖动上限（秒）。对齐 autoflow-sdk callback.py 的
# CALLBACK_RETRY_JITTER_S = 0.25（同形态：最终延迟 + random.uniform(0, JITTER)）。
# 实际加的抖动还会被 min(JITTER, 本轮等待) 封顶——生产形态（min_wait=1s）下
# 与 callback.py 一致，测试用极短退避时抖动不至于反客为主。
BACKOFF_JITTER_SEC = 0.25

# PK-09: circuit breaker 只统计网络类失败（连接错误/超时/5xx）。
# 非网络异常（ValueError/TypeError/业务逻辑错误）不计入熔断失败计数。
_CIRCUIT_BREAKABLE_EXC = (
    httpx.HTTPStatusError,  # 5xx / 429（_do 只对 retryable_statuses 抛）
    httpx.TimeoutException,
    httpx.NetworkError,     # 父类：ConnectError / ReadError / WriteError / CloseError
    # P3-7 评估（2026-10-26）：ProtocolError 计入熔断但**不进重试集**（见下方
    # tenacity retry= 元组），评估结论=保持现状。理由：可重试的瞬时故障形态已
    # 被其余三条覆盖——5xx/429 走 HTTPStatusError、连接拒绝/读写断走
    # NetworkError、慢走 TimeoutException；落到 ProtocolError 意味着对端在协议
    # 层**明确违规**（中途断流/畸形帧），十有八九是确定性缺陷而非瞬时抖动
    # （真正的瞬时形态——503、连接被拒、超时——都不会以 ProtocolError 呈现），
    # 对幂等 GET 重试大概率同错，只烧退避预算。正确处置正是本行的选择：计入
    # 熔断失败计数 → 快速失败 + half-open 探测自愈。
    httpx.ProtocolError,    # RemoteProtocolError / LocalProtocolError（对端中途断连）
)


def _extract_error_body(response: Any) -> Optional[dict[str, Any]]:
    """R31-E2: 从 httpx 响应里取出 admin-api 的错误体（非 JSON / 非对象 → None）。

    防御式解析：响应体可能为空（204/网关错误页）、已流式消费（ResponseNotRead）
    或根本不是 JSON。任何异常都吞掉——错误码透出绝不能让「本来能抛出的异常」
    变成解析异常。
    """
    if response is None:
        return None
    try:
        body = response.json()
    except Exception:  # noqa: BLE001 - 非 JSON 体是常态，不是错误
        return None
    return body if isinstance(body, dict) else None


class ApiHttpStatusError(httpx.HTTPStatusError):
    """R31-E2: 带稳定错误码面的 httpx.HTTPStatusError 子类。

    向后兼容的**子类**：str(exc) / exc.request / exc.response 与基类逐字节/
    逐引用一致，except httpx.HTTPStatusError 与 tenacity 的
    retry_if_exception_type 全部仍然命中（重试与熔断语义不变）。新增的只有
    两个只读面：

    - error_code: admin-api 错误体里的 errorCode（如 TASK_NOT_FOUND）；
      无码 / 非字符串 / 空串 → None（不抛、不编造）。
    - params: 同一错误体里的 params 插值参数；缺失或非对象 → {}（恒为 dict，
      调用方可直接展开）。

    错误体形如 { code: <数字HTTP状态>, message: <中文兜底>,
    errorCode: '<稳定码>', params: {...} }；code 不重复透出——HTTP 状态已在
    response.status_code 上。
    """

    @property
    def error_body(self) -> Optional[dict[str, Any]]:
        """解析出的错误体（无则 None）。每次访问重新解析，异常对象不持有状态。"""
        return _extract_error_body(getattr(self, "response", None))

    @property
    def error_code(self) -> Optional[str]:
        body = self.error_body
        if not body:
            return None
        code = body.get("errorCode")
        return code if isinstance(code, str) and code else None

    @property
    def params(self) -> dict[str, Any]:
        body = self.error_body
        if not body:
            return {}
        params = body.get("params")
        return params if isinstance(params, dict) else {}


class CircuitBreakerOpenError(RuntimeError):
    """P3-5: 熔断 open 时快速失败抛出的**有类型**错误（对齐 node-sdk B-4 形态）。

    node 侧同构类型见 ``packages/autocodeflow-node-sdk`` http-client.ts 的
    ``CircuitBreakerOpenError``（类型名即 ``name``/类名，文案同形；本包是通用
    客户端，文案不指名 Admin API）。刻意继承 ``RuntimeError``：模块 docstring
    的 PK-32 契约与既有调用方/测试钉死的 ``except RuntimeError`` 语义不变——
    旧的裸 ``RuntimeError`` raise 只是换成更可判别的子类，行为零漂移。
    """

    def __init__(self, message: str = (
        "Circuit breaker is open — request blocked "
        "(failing fast until the reset timeout elapses)"
    )) -> None:
        super().__init__(message)


class ResponseTooLargeError(RuntimeError):
    """P3-6: 响应体超过 ``max_response_bytes`` 上限（rogue 对端防护）。

    流式读取在超限的当口**中止**（累计到帽即抛，连接随之关闭），不再把全量
    响应灌进内存。刻意**不**继承 httpx 异常族：这不是传输层故障——十有八九
    是对端就是要吐这么大，重试大概率同错；也不计入熔断（
    ``_CIRCUIT_BREAKABLE_EXC`` 不含本类），是否当作"故障"由调用方裁定。
    """


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
    #: R134-A1: optional ceiling for a **server-directed** wait (the
    #: Retry-After header). None (default) keeps the historical behaviour --
    #: the header is honoured verbatim even if it asks for hours;
    #: max_wait_sec only caps our own exponential backoff, so a proxy
    #: returning "Retry-After: 3600" used to park the task process for an
    #: hour and blow through the execution budget. Set this when the caller
    #: must stay inside its own scheduling budget; the server-directed wait
    #: is then clamped and a warning is logged.
    max_retry_after_sec: Optional[float] = None


class _WaitWithRetryAfter:
    """PK-09: tenacity wait strategy that respects the Retry-After header.

    Falls back to the base exponential backoff, but if the server returned
    a ``Retry-After`` header (either a delta-seconds integer or an HTTP-date),
    waits at least that long — taking the max of our backoff and the
    server-specified delay.

    R134-A1: max_retry_after_sec 可选地对"服务端指定"的等待时间设上限
    （None = 不设上限，即历史行为）。没有上限时一个 Retry-After: 3600 就能
    把任务进程停一小时——max_wait_sec 从来不管这条路径。

    P3-7: 最终等待时间加**加性均匀抖动**（上限 ``BACKOFF_JITTER_SEC``，实际
    幅度再被 min(JITTER, 本轮等待) 封顶）——对照 autoflow-sdk callback.py:422
    的 ``delay + random.uniform(0, CALLBACK_RETRY_JITTER_S)`` 形态。动机：
    N 个任务进程同时打同一端点时，无抖动的指数退避会让重试波次完全同步
    （雷群效应）；抖动只加不减，不破坏"至少等这么久"的 Retry-After 语义，
    也不顶穿 max_wait / max_retry_after 的量级。
    """

    def __init__(
        self,
        base: wait_exponential,
        max_retry_after_sec: Optional[float] = None,
        jitter_sec: float = BACKOFF_JITTER_SEC,
    ):
        self._base = base
        self._max_retry_after = max_retry_after_sec
        self._jitter_sec = max(0.0, float(jitter_sec))

    def __call__(self, retry_state: RetryCallState) -> float:
        wait = self._base(retry_state)
        exc = retry_state.outcome.exception() if retry_state.outcome else None
        if isinstance(exc, httpx.HTTPStatusError):
            raw = exc.response.headers.get("Retry-After")
            if raw:
                parsed = self._parse_retry_after(raw)
                if parsed is not None:
                    if self._max_retry_after is not None and parsed > self._max_retry_after:
                        logger.warning(
                            "Retry-After %.1fs exceeds RetryConfig.max_retry_after_sec "
                            "%.1fs - clamped",
                            parsed,
                            self._max_retry_after,
                        )
                        parsed = self._max_retry_after
                    wait = max(wait, parsed)
        # P3-7: 抖动加在（含 Retry-After 的）最终延迟之上，与 callback.py:422
        # 同形态；min(JITTER, wait) 让极短退避（测试形态）不被抖动支配。
        if self._jitter_sec > 0 and wait > 0:
            wait += random.uniform(0, min(self._jitter_sec, wait))
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

    P3-6: 响应体默认按 ``max_response_bytes``（50MB，见
    ``DEFAULT_MAX_RESPONSE_BYTES``）流式封顶，超限中止读取并抛
    ``ResponseTooLargeError``；传 ``None`` 恢复"全量进内存"的旧行为。

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
        max_response_bytes: Optional[int] = DEFAULT_MAX_RESPONSE_BYTES,
    ):
        self.base_url = base_url.rstrip("/")
        self._auth_token = auth_token
        self._timeout = timeout_sec
        self._retry = retry_config or RetryConfig()
        self._breaker = circuit_breaker or CircuitBreaker()
        self._max_response_bytes = max_response_bytes
        # PK-09(1): 实例级 AsyncClient 单例（lazy init），实现连接池复用。
        # 此前每请求新建 AsyncClient → 零连接复用。初始化是 check-then-set，
        # 在 asyncio 单线程事件循环内原子（无需锁；见 _get_client）。
        self._client: Optional[httpx.AsyncClient] = None

    def _get_client(self) -> httpx.AsyncClient:
        """PK-09: lazy-init 实例级 AsyncClient，复用连接池。

        NETOPT-C P3: trust_env=False 与 autoflow-sdk（callback/http.py）、
        autocodeflow-notify 对齐——任务进程的 HTTP 出站一律不读代理 env，
        避免回调绕过代理而本客户端走代理的策略分裂。
        NETOPT-E P3-3（反向交叉引用）: 唯一的例外是 autocodeflow-ai 的
        AI 外发出站（analyzer.py）——它走外部/公网端点，**刻意保留**代理与
        自定义 CA（见其 NETOPT-D P2-6 定调注释）。内部通道与外部通道是两种
        不同的刻意策略，不是漏设。
        """
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=self._timeout, trust_env=False)
        return self._client

    async def aclose(self) -> None:
        """显式关闭底层 AsyncClient（连接池释放）。"""
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    # NETOPT-C P3: async context manager 兜底——任务作者忘调 aclose 时
    # `async with AutoFlowHttpClient(...) as client:` 保证连接池释放。
    async def __aenter__(self) -> "AutoFlowHttpClient":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

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

    async def _read_capped(
        self,
        client: httpx.AsyncClient,
        method: str,
        url: str,
        data: Any,
        headers: dict[str, str] | None,
    ) -> httpx.Response:
        """P3-6: 流式读取响应体，超过 ``_max_response_bytes`` 立即中止并抛
        ``ResponseTooLargeError``（rogue 对端防护，理由见该类 docstring）。

        返回值与 ``client.request`` 的非流式 Response 逐面兼容——
        status / headers / reason_phrase / text / json / request 全部可用，
        上层（可重试状态码判定、Retry-After 解析、错误体提取）无感。
        注意字节数按 ``iter_bytes`` 的**解码后**内容计（gzip 等传输编码已解），
        与"进程内存实际占用"对齐。
        """
        cap = self._max_response_bytes
        assert cap is not None  # 调用方 _do 已判空；仅防御重构
        async with client.stream(
            method, url, json=data, headers=self._build_headers(headers),
        ) as raw:
            # 先看声明：Content-Length 已超帽 → 一个字节都不必读，直接中止。
            # 声明可伪造也可缺失——不可信/缺失时回落到逐块累计检查。
            declared = raw.headers.get("content-length")
            if declared is not None:
                try:
                    declared_bytes = int(declared)
                except ValueError:
                    declared_bytes = None
                if declared_bytes is not None and declared_bytes > cap:
                    raise ResponseTooLargeError(
                        f"declared content-length {declared_bytes} exceeds "
                        f"max_response_bytes={cap} - read aborted before body"
                    )
            buf = bytearray()
            # 注意是 aiter_bytes（AsyncClient 流的异步迭代器；iter_bytes 是同步形态）。
            async for chunk in raw.aiter_bytes():
                buf.extend(chunk)
                if len(buf) > cap:
                    raise ResponseTooLargeError(
                        f"response body exceeded max_response_bytes={cap} - "
                        f"read aborted (rogue-peer protection)"
                    )
            # 以既有非流式形态返回：同 status/headers/request + 已读 content。
            return httpx.Response(
                raw.status_code,
                headers=raw.headers,
                content=bytes(buf),
                request=raw.request,
            )

    async def _request(
        self, method: str, path: str, data: Any = None, headers: dict[str, str] | None = None
    ) -> httpx.Response:
        """执行一次 HTTP 请求（带重试 + 熔断）。

        PK-32 错误契约详见模块 docstring。要点：
        - 可重试状态码（429/5xx 默认）抛 ``HTTPStatusError``；
        - 安全方法自动重试，非安全方法默认只发一次（``safe_methods_only``）；
        - 熔断 open 时直接抛 ``CircuitBreakerOpenError``（RuntimeError 子类），
          不发起网络请求；
        - 响应体超过 ``max_response_bytes`` 抛 ``ResponseTooLargeError``（P3-6）。
        """
        if self._breaker.is_open:
            raise CircuitBreakerOpenError()

        url = f"{self.base_url}{path}" if self.base_url else path

        async def _do() -> httpx.Response:
            # PK-09(1): 复用实例级 AsyncClient（连接池）。
            client = self._get_client()
            if self._max_response_bytes is not None:
                # P3-6: 有帽走流式读取——超限在读取途中中止，全量响应不再
                # 无界进内存；无帽（None）保持 ``client.request`` 一次到位。
                resp = await self._read_capped(client, method, url, data, headers)
            else:
                resp = await client.request(
                    method, url, json=data, headers=self._build_headers(headers),
                )
            if resp.status_code in self._retry.retryable_statuses:
                # R31-E2: 抛子类而非裸 HTTPStatusError——message/request/response
                # 逐字节不变（PK-32 契约不动），额外提供 error_code / params。
                raise ApiHttpStatusError(
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
                    wait_exponential(multiplier=self._retry.min_wait_sec, max=self._retry.max_wait_sec),
                    # R134-A1: 服务器指定的等待时间可选上限（None = 旧行为）。
                    self._retry.max_retry_after_sec,
                ),
                # P3-7: ProtocolError 刻意不在重试集——评估结论与理由见
                # _CIRCUIT_BREAKABLE_EXC 定义处的注释（计入熔断，不重试）。
                retry=retry_if_exception_type((httpx.HTTPStatusError, httpx.TimeoutException, httpx.NetworkError)),
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
