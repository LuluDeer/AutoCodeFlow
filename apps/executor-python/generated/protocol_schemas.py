"""GENERATED — DO NOT EDIT.

来源：`packages/executor-protocol/protocol.json` 的 `schemas` 段（A3 完整形态，
DEEP_REVIEW 0ef3bbe §七）。由 `node scripts/generate-executor-protocol.mjs` 生成，
CI 的 executor-protocol-drift job 会重跑并 `git diff --exit-code` 兜底。

手改本文件会在下次生成时被覆盖，且不会让契约生效——要改请改 protocol.json。
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class TaskConfig(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str | None = Field(default=None)
    name: str | None = Field(default=None)
    runtime: str | None = Field(default=None)
    entrypoint: str | None = Field(default=None)
    timeout: int | None = Field(ge=0, le=86400, default=None)
    timeoutSeconds: int | None = Field(ge=0, le=86400, default=None)
    timeout_seconds: int | None = Field(default=None)
    requirements: list[str] | None = Field(default_factory=list)
    gitRepo: str | None = Field(default=None)
    gitBranch: str | None = Field(default=None)
    gitCommit: str | None = Field(default=None)


class ExecuteRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    executionId: str = Field(pattern="^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
    task: TaskConfig
    params: dict[str, Any] | None = Field(default=None)


class ConfigReloadRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    maxConcurrentTasks: int | None = Field(ge=1, default=None)
    taskTimeoutSeconds: int | None = Field(ge=1, default=None)
    heartbeatIntervalSeconds: int | None = Field(ge=5, default=None)
    adminApiUrl: str | None = Field(default=None)
    adminApiUrlInternal: str | None = Field(default=None)
    adminApiUrlExternal: str | None = Field(default=None)
    adminApiUrls: list[str] | None = Field(default=None)
    workDir: str | None = Field(default=None)
    WORK_DIR: str | None = Field(default=None)


class ConfigReloadResponse(BaseModel):
    model_config = ConfigDict(extra="allow")
    success: bool
    message: str
    updated_fields: list[str]
    ignored_fields: list[str]


class HealthReadyResponse(BaseModel):
    model_config = ConfigDict(extra="allow")
    status: Literal["ready", "not_ready"]
    reason: str | None = Field(default=None)


class KillResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ok: bool


class LogsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    lines: list[str]
    totalLines: int = Field(ge=0)
    hasMore: bool
