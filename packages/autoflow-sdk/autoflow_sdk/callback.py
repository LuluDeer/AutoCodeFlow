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

import httpx

# CallbackItemDto field constraints (keep in sync with the admin DTO).
ERROR_MESSAGE_MAX_LENGTH = 4096
LOGS_MAX_LENGTH = 512_000

# ExecutionFailureReason enum values accepted by the DTO validation.
VALID_FAILURE_REASONS = frozenset({
    "package_fetch_failed",
    "script_error",
    "timeout",
    "executor_offline",
    "executor_restart",
    # BUG-15 复审: P2 起 admin 枚举新增 stale_recovered（sweep 赢家标记），
    # 白名单与 admin DTO（@IsIn(Object.values(ExecutionFailureReason))）保持同步
    "stale_recovered",
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
    """
    if (
        isinstance(payload, dict)
        and "code" in payload
        and "message" in payload
        and "data" in payload
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
        with httpx.Client(timeout=self.timeout, trust_env=False) as client:
            resp = client.post(
                self.callback_url,
                json=payload,
                headers={"Authorization": f"Bearer {self.token}"},
            )
            if resp.status_code >= 400:
                raise self._status_error(resp)
            return unwrap_envelope(resp.json())

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
