"""Shared Pydantic models for autocodeflow-sdk <-> executor HTTP protocol.

Using these models in both the executor and any consumer ensures that
field renames / type changes are caught at import time rather than at runtime.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, model_validator


class TaskConfig(BaseModel):
    """Describes the task to be executed.

    Timeout fields (PK-23 declaration — the model validator below keeps
    all three in sync):
    - ``timeoutSeconds`` is the canonical wire field (camelCase, matches
      the admin-api/executor protocol);
    - ``timeout`` (legacy default-carrying) and ``timeout_seconds``
      (snake_case alias) are **deprecated** — kept for backward
      compatibility, normalized into ``timeoutSeconds`` on construction.
    """
    id: Optional[str] = None
    name: Optional[str] = None
    runtime: str = 'python'
    entrypoint: Optional[str] = None
    timeout: int = 300  # deprecated: legacy fallback, see class docstring
    timeoutSeconds: Optional[int] = None  # canonical timeout field (seconds)
    timeout_seconds: Optional[int] = None  # deprecated: snake_case alias
    timezone: Optional[str] = None
    maxRetry: Optional[int] = None
    max_retry: Optional[int] = None
    retryDelay: Optional[int] = None
    retry_delay: Optional[int] = None
    requirements: List[str] = Field(default_factory=list)
    gitRepo: Optional[str] = None
    gitBranch: Optional[str] = 'main'
    gitCommit: Optional[str] = None
    # PK-23: admin 值域是小写（serial/discard/cover_early），默认值必须
    # 是有效枚举形态——'SERIAL' 大写形态执行器按字面透传会错配。
    blockStrategy: Optional[str] = 'serial'
    alarmEmail: Optional[str] = None
    alarmChannels: List[str] = Field(default_factory=list)

    model_config = {'extra': 'allow'}  # forward-compatible: unknown fields are preserved

    @model_validator(mode='after')
    def normalize_policy_fields(self) -> 'TaskConfig':
        effective_timeout = self.timeout
        if self.timeout_seconds is not None:
            effective_timeout = self.timeout_seconds
        if self.timeoutSeconds is not None:
            effective_timeout = self.timeoutSeconds
        self.timeout = effective_timeout
        self.timeoutSeconds = effective_timeout
        if self.maxRetry is None and self.max_retry is not None:
            self.maxRetry = self.max_retry
        if self.retryDelay is None and self.retry_delay is not None:
            self.retryDelay = self.retry_delay
        return self


class ExecuteRequest(BaseModel):
    """Payload sent by admin-api to an executor's POST /api/execute endpoint."""
    executionId: str
    task: TaskConfig
    params: Optional[Dict[str, Any]] = None


class ExecuteResult(BaseModel):
    """Response returned by an executor after task completion."""
    success: bool
    logs: str = ''
    exitCode: int = 0
    error: Optional[str] = None
