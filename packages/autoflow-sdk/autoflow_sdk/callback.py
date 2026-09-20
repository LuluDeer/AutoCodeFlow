"""Per-execution Admin API callback client (N23/N27 parity with node SDK).

Since round 7/8 the executors inject three variables into task subprocesses:

- ``AUTOFLOW_CALLBACK_TOKEN`` — a one-shot ``v1.<executionId>.<exp>.<hmac>``
  token bound to THIS execution (never the executor shared token, SEC-01);
- ``AUTOFLOW_ADMIN_API_URL`` — Admin API base URL (non-secret routing info);
- ``AUTOFLOW_EXECUTOR_ADDRESS`` — the address this executor registered with
  (N27), stamped onto callback items automatically.

Task code uses them via ``TaskContext``::

    ctx = TaskContext.from_env()
    if ctx.callback.enabled:
        ctx.report_success(summary="3 rows written")
    # or, on failure:
    ctx.report_failure(ValueError("upstream 503"))

The client is ENABLED when the Admin API URL and the callback token are
present — ``AUTOFLOW_EXECUTOR_ADDRESS`` is optional (N27 made it optional on
the admin-api's ``v1.`` per-execution callback path, and the node SDK has
always treated it as optional; U14 aligns python with that semantics). When
disabled, construction still succeeds (so ``ctx.callback.enabled`` can be
checked), but any report attempt raises :class:`CallbackDisabledError`
naming the missing variables — the same contract as the node SDK's
``HttpClient.disabledReason``.

Payload shape follows admin-api's ``CallbackItemDto``
(apps/admin-api/src/modules/task/dto/execution-callback.dto.ts):
``POST {admin_api_url}/api/executions/callback`` with
``Authorization: Bearer <token>`` and a JSON array body of
``{executionId, status, executorAddress?, logs?, errorMessage?,
failureReason?, durationMs?}`` items.

Responses arrive in admin-api's global ``{code, message, data}`` envelope
(ResponseInterceptor); :meth:`CallbackClient.report` unwraps it and returns
the inner ``data`` — for the callback endpoint that is ``{results: [...]}``.
"""
from typing import Any, Dict, List, Optional

import random
import time

import httpx

# CallbackItemDto field constraints (keep in sync with the admin DTO).
ERROR_MESSAGE_MAX_LENGTH = 4096
LOGS_MAX_LENGTH = 512_000

# NETOPT-10-1: bounded retry for report(). A single transient network blip
# previously lost the terminal callback entirely — the execution then sat
# RUNNING until admin's stale sweep "recovered" it as stale_recovered, and the
# real failureReason/errorMessage was lost forever (see executor-python's
# _send_callback_with_retry, O-20). Retries are safe because admin's
# transitionToTerminal is guarded by `status IN (open gate)`: a duplicate
# terminal callback affects 0 rows (idempotent).
CALLBACK_MAX_ATTEMPTS = 3
CALLBACK_RETRY_BASE_DELAY_S = 0.5
CALLBACK_RETRY_MAX_DELAY_S = 2.0
CALLBACK_RETRY_JITTER_S = 0.25

# ExecutionFailureReason enum values accepted by the DTO validation.
#
# A3（executor-protocol）：白名单收窄为**执行器可上报子集**——`stale_recovered`
# 是 admin 的 stale sweep 写入的溯源标记，语义上只有 admin 才该写，上报方无从
# 得知自己的执行是被谁终态化的。admin 的回调 DTO（@IsIn）已同步收窄，故此处
# 一并调整，否则 SDK 本地放行、admin 却 400（且一个非法取值会拒掉**整批**回调）。
#
# 单一事实源：packages/executor-protocol/protocol.json 的
# failureReason.executorReportable——tests/test_executor_protocol.py 逐值断言。
VALID_FAILURE_REASONS = frozenset({
    "package_fetch_failed",
    "script_error",
    "timeout",
    "executor_offline",
    "executor_restart",
    # BUG-10: 执行器侧细分分类（依赖安装 / Git 拉取 / 运行时缺失）
    "dependency_install_failed",
    "git_fetch_failed",
    "runtime_missing",
    # EXP-01（本轮体验审查）：沙箱已配置但不可用（bwrap 缺失 / 用户命名空间
    # 被禁 / 在 Windows 上启用）。python 执行器自 F-1 起就会产出该值，但四端
    # 枚举都没有它——admin 的 @IsIn 命中即 400，而执行器把 4xx 当不可重试、
    # **整批放弃**，导致该机所有任务的终态回调永久丢失。现补齐四端。
    "sandbox_unavailable",
    # python_task_multiversion: 任务声明的 Python 版本无法获取
    # （缓存池缺失且按需下载失败/下载源不可达）。明确失败语义——不回退宿主
    # 解释器（回退会静默掩盖版本不匹配）。
    "interpreter_unavailable",
    "killed",
    "unknown",
})


class CallbackDisabledError(RuntimeError):
    """Raised when a callback is attempted without the required credentials."""


def unwrap_envelope(payload: Any) -> Any:
    """Strip admin-api's global ``{code, message, data}`` response envelope.

    The ResponseInterceptor in apps/admin-api wraps every successful body;
    without this the caller's ``result["results"]`` lookup would hit the
    envelope and see nothing (U14). Bodies that do not look like the
    envelope (proxies, tests, future non-enveloped endpoints) are returned
    unchanged.

    PK-06 (DEEP_REVIEW 0ef3bbe): criterion unified with acf-cli /
    mcp-server / node-sdk — "payload is a dict, has a ``data`` key, and
    ``code`` is a number". The interceptor's ``code`` is always numeric
    (``response.statusCode ?? 200``), so a numeric ``code`` identifies the
    envelope precisely; the presence of ``message`` is no longer part of
    the test. A string-``code`` payload (e.g. ``{"code":"200","message":"x",
    "data":{...}}`` — a third-party body that merely carries the three keys)
    is passed through unchanged instead of being unwrapped, so the same
    payload now behaves identically on all four client ends.
    """
    if (
        isinstance(payload, dict)
        and "data" in payload
        and isinstance(payload.get("code"), int)
        and not isinstance(payload.get("code"), bool)
    ):
        return payload["data"]
    return payload


class CallbackClient:
    """Synchronous client for ``POST /api/executions/callback``."""

    def __init__(
        self,
        admin_api_url: Optional[str] = None,
        token: Optional[str] = None,
        executor_address: Optional[str] = None,
        execution_id: Optional[str] = None,
        timeout: float = 10.0,
    ) -> None:
        self.admin_api_url = (admin_api_url or "").rstrip("/")
        self.token = token or ""
        self.executor_address = executor_address or ""
        self.execution_id = execution_id or ""
        self.timeout = timeout

        # U14: enabled semantics aligned with the node SDK — only url+token
        # are required. AUTOFLOW_EXECUTOR_ADDRESS is optional since N27: the
        # admin-api `v1.` per-execution callback path does not require
        # executorAddress on items (the token is already execution-bound),
        # so a N23-era executor that never injects it must not disable
        # callbacks. When present, it is still auto-stamped on items (N27).
        missing = []
        if not self.admin_api_url:
            missing.append("AUTOFLOW_ADMIN_API_URL")
        if not self.token:
            missing.append("AUTOFLOW_CALLBACK_TOKEN")
        #: Whether the Admin API URL and callback token are both present.
        self.enabled = not missing
        #: Reason for being disabled (populated only when ``enabled`` is False).
        self.disabled_reason: Optional[str] = None
        if not self.enabled:
            self.disabled_reason = (
                "CallbackClient is disabled: Admin API callback credentials are "
                "missing (" + ", ".join(missing) + " were not present in the "
                "environment; older executors never inject them, see SEC-01/N23). "
                "Provide them via TaskContext(callback_token=..., admin_api_url=...) "
                "if callbacks are required (AUTOFLOW_EXECUTOR_ADDRESS is optional "
                "and only used to auto-stamp callback items, N27)."
            )

    # ------------------------------------------------------------------ url

    @property
    def callback_url(self) -> str:
        """Full callback endpoint URL; tolerates a base that already ends in /api."""
        if self.admin_api_url.endswith("/api"):
            return f"{self.admin_api_url}/executions/callback"
        return f"{self.admin_api_url}/api/executions/callback"

    # ------------------------------------------------------------------ core

    def report(self, items: List[Dict[str, Any]]) -> Any:
        """POST a batch of CallbackItemDto dicts.

        Returns the unwrapped payload: admin-api wraps every response in a
        ``{code, message, data}`` envelope (global ResponseInterceptor) and
        the callback endpoint's ``data`` is ``{results: [{executionId,
        success, error?}, ...]}`` — callers get that inner object directly.
        Non-enveloped bodies are passed through unchanged.

        Raises CallbackDisabledError without credentials, httpx.HTTPStatusError
        on a non-2xx answer from the Admin API (the message is enriched with
        the envelope's ``message`` field when present).
        """
        if not self.enabled:
            raise CallbackDisabledError(self.disabled_reason)
        payload = [self._with_defaults(item) for item in items]
        # NETOPT-10-1: retry network-layer failures and 5xx/429 with bounded
        # exponential backoff + jitter. Non-retryable 4xx keep single-shot
        # semantics (a rejected batch is a contract violation — validation
        # errors won't heal on retry, and burning attempts only delays the
        # caller's own fallback).
        #
        # NETOPT-C P3: 与 executor 侧回调通道的重试差异是**有意的**——executor
        # (apps/executor-python/routers/execute.py) 对 401/408 做有限重试且有
        # 落盘重放兜底；SDK 是无状态任务代码的同步通道，4xx 一律单发即抛
        # （含 408），任务作者须自行处理终态上报。若要对等加 408 重试，必须
        # 同时补磁盘重放，否则只是放大重复回调（admin 终态幂等靠
        # status IN (open gate) 条件 UPDATE，不是万能）。
        #
        # NETOPT-D P3（跨包交叉引用）: 与 autocodeflow-http 的策略差异同样
        # **有意**——该包是通用任务出站通道，4xx 不抛（透传响应体）且对
        # ProtocolError 不重试（对端中途断连重试收益低）；本包与 autocodeflow-ai
        # 则重试 ProtocolError（有界）并对 4xx 抛异常（回调=契约、AI=可降级
        # 分类）。改任何一端的重试集前，先读对端 docstring 对齐语义。
        last_error: Optional[Exception] = None
        for attempt in range(1, CALLBACK_MAX_ATTEMPTS + 1):
            try:
                with httpx.Client(timeout=self.timeout, trust_env=False) as client:
                    resp = client.post(
                        self.callback_url,
                        json=payload,
                        headers={"Authorization": f"Bearer {self.token}"},
                    )
                if resp.status_code >= 500 or resp.status_code == 429:
                    last_error = self._status_error(resp)
                    if attempt < CALLBACK_MAX_ATTEMPTS:
                        self._sleep_before_retry(attempt)
                        continue
                    raise last_error
                if resp.status_code >= 400:
                    raise self._status_error(resp)
                try:
                    body = resp.json()
                except ValueError:
                    # NETOPT-C P3: 2xx 但 body 非 JSON = 服务端契约违约。按
                    # docstring 承诺的类型契约统一抛 HTTPStatusError（原先裸
                    # ValueError 不在契约内，调用方 catch HTTPStatusError 会漏）。
                    body_preview = resp.text[:200].replace("\n", " ")
                    # NETOPT-D P3: 消息带 body 摘要（前 200 字符），排障有信息量。
                    raise httpx.HTTPStatusError(
                        "Admin API returned non-JSON body on 2xx callback response: "
                        f"{body_preview!r}",
                        request=resp.request,
                        response=resp,
                    ) from None
                return unwrap_envelope(body)
            except httpx.TransportError as exc:
                # Transport-level failure (connect/read/write/timeout/protocol
                # reset). After the final attempt the original exception type
                # is re-raised so callers can still catch httpx.ReadTimeout & co.
                last_error = exc
                if attempt < CALLBACK_MAX_ATTEMPTS:
                    self._sleep_before_retry(attempt)
                    continue
                raise
        raise last_error  # pragma: no cover - loop always returns or raises

    @staticmethod
    def _sleep_before_retry(attempt: int) -> None:
        """Exponential backoff with jitter between retry attempts."""
        delay = min(
            CALLBACK_RETRY_BASE_DELAY_S * (2 ** (attempt - 1)),
            CALLBACK_RETRY_MAX_DELAY_S,
        )
        time.sleep(delay + random.uniform(0, CALLBACK_RETRY_JITTER_S))

    @staticmethod
    def _status_error(resp: httpx.Response) -> httpx.HTTPStatusError:
        """HTTPStatusError whose message carries admin-api's envelope detail.

        ``raise_for_status`` alone would only say "401 Client Error", hiding
        the server-side reason ("Invalid or expired execution callback
        token", validation messages, ...). Keep the exception type unchanged
        so callers can still catch httpx.HTTPStatusError.
        """
        detail = ""
        try:
            body = resp.json()
        except ValueError:
            body = None
        if isinstance(body, dict):
            message = body.get("message")
            if isinstance(message, str) and message:
                detail = f": {message}"
            elif isinstance(message, list) and message:
                detail = ": " + "; ".join(str(m) for m in message)
        return httpx.HTTPStatusError(
            f"Client error {resp.status_code} for {resp.request.method} "
            f"{resp.request.url}{detail}",
            request=resp.request,
            response=resp,
        )

    def _with_defaults(self, item: Dict[str, Any]) -> Dict[str, Any]:
        """Fill executionId / executorAddress on items that omit them (N27).

        executorAddress is only stamped when this client knows the address —
        the admin-api `v1.` callback path treats it as optional, so an
        executor that never injected AUTOFLOW_EXECUTOR_ADDRESS must not send
        an empty one.
        """
        filled = dict(item)
        if not filled.get("executionId"):
            filled["executionId"] = self.execution_id
        if not filled.get("executorAddress") and self.executor_address:
            filled["executorAddress"] = self.executor_address
        return filled

    # ------------------------------------------------------- convenience

    def report_success(
        self,
        summary: Optional[str] = None,
        duration_ms: Optional[int] = None,
    ) -> Any:
        """Report status=success for this client's execution."""
        item: Dict[str, Any] = {
            "executionId": self.execution_id,
            "status": "success",
        }
        if self.executor_address:
            item["executorAddress"] = self.executor_address
        if summary:
            item["logs"] = summary[:LOGS_MAX_LENGTH]
        if duration_ms is not None:
            item["durationMs"] = duration_ms
        return self.report([item])

    def report_failure(
        self,
        error: Any,
        summary: Optional[str] = None,
        duration_ms: Optional[int] = None,
        failure_reason: str = "script_error",
    ) -> Any:
        """Report status=failed for this client's execution.

        ``error`` (any object) is stringified into ``errorMessage`` and
        truncated to the DTO's 4 KB cap; ``failure_reason`` must be one of
        admin-api's ExecutionFailureReason values (default ``script_error``).
        """
        if failure_reason not in VALID_FAILURE_REASONS:
            raise ValueError(
                f"invalid failure_reason {failure_reason!r}; expected one of "
                + ", ".join(sorted(VALID_FAILURE_REASONS))
            )
        item: Dict[str, Any] = {
            "executionId": self.execution_id,
            "status": "failed",
            "errorMessage": str(error)[:ERROR_MESSAGE_MAX_LENGTH],
            "failureReason": failure_reason,
        }
        if self.executor_address:
            item["executorAddress"] = self.executor_address
        if summary:
            item["logs"] = summary[:LOGS_MAX_LENGTH]
        if duration_ms is not None:
            item["durationMs"] = duration_ms
        return self.report([item])
