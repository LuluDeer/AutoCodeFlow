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

The client is ENABLED only when all three credentials are present. When
disabled, construction still succeeds (so ``ctx.callback.enabled`` can be
checked), but any report attempt raises :class:`CallbackDisabledError`
naming the missing variables — the same contract as the node SDK's
``HttpClient.disabledReason``.

Payload shape follows admin-api's ``CallbackItemDto``
(apps/admin-api/src/modules/task/dto/execution-callback.dto.ts):
``POST {admin_api_url}/api/executions/callback`` with
``Authorization: Bearer <token>`` and a JSON array body of
``{executionId, status, executorAddress, logs?, errorMessage?,
failureReason?, durationMs?}`` items.
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
    "killed",
    "unknown",
})


class CallbackDisabledError(RuntimeError):
    """Raised when a callback is attempted without full credentials."""


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

        missing = []
        if not self.admin_api_url:
            missing.append("AUTOFLOW_ADMIN_API_URL")
        if not self.token:
            missing.append("AUTOFLOW_CALLBACK_TOKEN")
        if not self.executor_address:
            missing.append("AUTOFLOW_EXECUTOR_ADDRESS")
        #: Whether all three callback credentials are present.
        self.enabled = not missing
        #: Reason for being disabled (populated only when ``enabled`` is False).
        self.disabled_reason: Optional[str] = None
        if not self.enabled:
            self.disabled_reason = (
                "CallbackClient is disabled: Admin API callback credentials are "
                "missing (" + ", ".join(missing) + " were not present in the "
                "environment; older executors never inject them, see SEC-01/N23). "
                "Provide them via TaskContext(callback_token=..., admin_api_url=..., "
                "executor_address=...) if callbacks are required."
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
        """POST a batch of CallbackItemDto dicts. Returns the parsed response.

        Raises CallbackDisabledError without credentials, httpx.HTTPStatusError
        on a non-2xx answer from the Admin API.
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
            resp.raise_for_status()
            return resp.json()

    def _with_defaults(self, item: Dict[str, Any]) -> Dict[str, Any]:
        """Fill executionId / executorAddress on items that omit them (N27)."""
        filled = dict(item)
        if not filled.get("executionId"):
            filled["executionId"] = self.execution_id
        if not filled.get("executorAddress"):
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
            "executorAddress": self.executor_address,
        }
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
            "executorAddress": self.executor_address,
            "errorMessage": str(error)[:ERROR_MESSAGE_MAX_LENGTH],
            "failureReason": failure_reason,
        }
        if summary:
            item["logs"] = summary[:LOGS_MAX_LENGTH]
        if duration_ms is not None:
            item["durationMs"] = duration_ms
        return self.report([item])
