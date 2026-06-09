"""Task execution context — passed to every task handler."""
from dataclasses import dataclass, field
from typing import Any, Dict, Optional
import os


@dataclass
class TaskContext:
    """Provides runtime metadata and helpers to a running task."""

    task_id: str
    execution_id: str
    task_name: str
    params: Dict[str, Any] = field(default_factory=dict)
    env: Dict[str, str] = field(default_factory=dict)

    # Runtime helpers — populated lazily
    _logger: Optional[Any] = field(default=None, repr=False)

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

    @classmethod
    def from_env(cls) -> "TaskContext":
        """
        Create TaskContext from environment variables injected by the executor.

        Reads EXECUTION_ID, TASK_ID, TASK_NAME, and all AUTOFLOW_* vars as params.
        This is the recommended way to initialize context in task code.

        Usage::

            from autoflow_sdk import TaskContext

            ctx = TaskContext.from_env()
            ctx.log.info(f"Task {ctx.task_id} started")
            date = ctx.get_param("date")
        """
        params: dict[str, Any] = {}
        for k, v in os.environ.items():
            if k.startswith("AUTOFLOW_") and v:
                params[k[len("AUTOFLOW_"):].lower()] = v

        return cls(
            task_id=os.environ.get("TASK_ID", "unknown"),
            execution_id=os.environ.get("EXECUTION_ID", "unknown"),
            task_name=os.environ.get("TASK_NAME", "unknown"),
            params=params,
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "task_id": self.task_id,
            "execution_id": self.execution_id,
            "task_name": self.task_name,
            "params": self.params,
        }
