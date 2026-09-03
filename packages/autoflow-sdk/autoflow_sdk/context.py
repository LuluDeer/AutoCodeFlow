"""Task execution context — passed to every task handler."""
from dataclasses import dataclass, field
from typing import Any, Dict, Optional
import os

from .callback import CallbackClient

# R9 (round-9): AUTOFLOW_* keys that carry callback credentials / routing
# info (N23/N27 parity with executor-node). They are exposed as dedicated
# TaskContext fields and deliberately EXCLUDED from `params` — folding a
# one-shot HMAC token or a deployment address into user task parameters
# would pollute the parameter view and leak the credential into any code
# that dumps ctx.params.
_CALLBACK_ENV_KEYS = {
    "AUTOFLOW_CALLBACK_TOKEN": "callback_token",
    "AUTOFLOW_ADMIN_API_URL": "admin_api_url",
    "AUTOFLOW_EXECUTOR_ADDRESS": "executor_address",
}


@dataclass
class TaskContext:
    """Provides runtime metadata and helpers to a running task."""

    task_id: str
    execution_id: str
    task_name: str
    params: Dict[str, Any] = field(default_factory=dict)
    env: Dict[str, str] = field(default_factory=dict)

    # Callback credentials injected by the executor (N23/N27). All optional:
    # older executors never inject them, in which case `ctx.callback` (and
    # the `ctx.report_success` / `ctx.report_failure` shorthands) stay
    # disabled and raise a descriptive error when used.
    callback_token: Optional[str] = None
    admin_api_url: Optional[str] = None
    executor_address: Optional[str] = None

    # Runtime helpers — populated lazily
    _logger: Optional[Any] = field(default=None, repr=False)
    _callback_client: Optional[CallbackClient] = field(default=None, repr=False)

    def get_param(self, key: str, default: Any = None) -> Any:
        """Retrieve a task parameter by key."""
        return self.params.get(key, default)

    def get_env(self, key: str, default: str = "") -> str:
        """Retrieve an environment variable (task env first, then OS env)."""
        return self.env.get(key, os.environ.get(key, default))

    @property
    def log(self):
        if self._logger is None:
            from .logger import get_logger
            object.__setattr__(self, "_logger", get_logger(self.task_name))
        return self._logger

    @property
    def callback(self) -> CallbackClient:
        """Per-execution Admin API callback client (N23/N27 parity).

        Lazily built from the injected credentials; check
        ``ctx.callback.enabled`` before reporting (older executors do not
        inject the credentials). See :class:`autoflow_sdk.callback.CallbackClient`.
        """
        if self._callback_client is None:
            object.__setattr__(
                self,
                "_callback_client",
                CallbackClient(
                    admin_api_url=self.admin_api_url,
                    token=self.callback_token,
                    executor_address=self.executor_address,
                    execution_id=self.execution_id,
                ),
            )
        return self._callback_client

    def report_success(self, summary: Optional[str] = None, duration_ms: Optional[int] = None) -> Any:
        """Report this execution's success to the Admin API.

        Shorthand for ``ctx.callback.report_success(...)``; raises
        ``CallbackDisabledError`` when callback credentials are absent.
        """
        return self.callback.report_success(summary=summary, duration_ms=duration_ms)

    def report_failure(
        self,
        error: Any,
        summary: Optional[str] = None,
        duration_ms: Optional[int] = None,
        failure_reason: str = "script_error",
    ) -> Any:
        """Report this execution's failure to the Admin API.

        ``error`` is mapped to the callback item's ``errorMessage`` and
        ``failure_reason`` (default ``script_error``) to its structured
        ``failureReason``. Raises ``CallbackDisabledError`` when callback
        credentials are absent.
        """
        return self.callback.report_failure(
            error, summary=summary, duration_ms=duration_ms, failure_reason=failure_reason
        )

    @classmethod
    def from_env(cls) -> "TaskContext":
        """
        Create TaskContext from environment variables injected by the executor.

        Reads EXECUTION_ID, TASK_ID, TASK_NAME, and all AUTOFLOW_* vars as
        params — except the callback credential keys
        (``AUTOFLOW_CALLBACK_TOKEN``, ``AUTOFLOW_ADMIN_API_URL``,
        ``AUTOFLOW_EXECUTOR_ADDRESS``), which are exposed as dedicated
        fields and never leak into ``params``.

        Usage::

            from autoflow_sdk import TaskContext

            ctx = TaskContext.from_env()
            ctx.log.info(f"Task {ctx.task_id} started")
            date = ctx.get_param("date")
        """
        params: dict[str, Any] = {}
        callback_fields: dict[str, str] = {}
        for k, v in os.environ.items():
            if not k.startswith("AUTOFLOW_") or not v:
                continue
            if k in _CALLBACK_ENV_KEYS:
                callback_fields[_CALLBACK_ENV_KEYS[k]] = v
                continue
            params[k[len("AUTOFLOW_"):].lower()] = v

        return cls(
            task_id=os.environ.get("TASK_ID", "unknown"),
            execution_id=os.environ.get("EXECUTION_ID", "unknown"),
            task_name=os.environ.get("TASK_NAME", "unknown"),
            params=params,
            **callback_fields,
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "task_id": self.task_id,
            "execution_id": self.execution_id,
            "task_name": self.task_name,
            "params": self.params,
        }
