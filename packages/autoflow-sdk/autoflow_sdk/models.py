"""Shared Pydantic models for autoflow-sdk <-> executor HTTP protocol.

Using these models in both the executor and any consumer ensures that
field renames / type changes are caught at import time rather than at runtime.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class TaskConfig(BaseModel):
    """Describes the task to be executed."""
    id: Optional[str] = None
    name: Optional[str] = None
    runtime: str = 'python'
    entrypoint: Optional[str] = None
    timeout: int = 300
    requirements: List[str] = Field(default_factory=list)
    gitRepo: Optional[str] = None
    gitBranch: Optional[str] = 'main'
    gitCommit: Optional[str] = None
    blockStrategy: Optional[str] = 'SERIAL'
    alarmEmail: Optional[str] = None
    alarmChannels: List[str] = Field(default_factory=list)

    class Config:
        extra = 'allow'  # forward-compatible: unknown fields are preserved


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
