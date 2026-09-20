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
    model_config = ConfigDict(extra="allow", strict=True)
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
    runtimeVersion: str | None = Field(default=None)
    runtime_version: str | None = Field(default=None)
    codeSource: Literal["git", "glue", "application_zip"] | None = Field(default=None)
    code_source: Literal["git", "glue", "application_zip"] | None = Field(default=None)
    applicationId: str | None = Field(default=None)
    application_id: str | None = Field(default=None)
    packageUrl: str | None = Field(default=None)
    package_url: str | None = Field(default=None)
    glueSource: str | None = Field(default=None)
    glue_source: str | None = Field(default=None)
    glueLanguage: Literal["python", "javascript", "shell", "glue_python", "glue_node", "glue_shell"] | None = Field(default=None)
    glue_language: Literal["python", "javascript", "shell", "glue_python", "glue_node", "glue_shell"] | None = Field(default=None)


class ExecuteRequest(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)
    executionId: str = Field(pattern="^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
    task: TaskConfig
    params: dict[str, Any] | None = Field(default=None)


class ConfigReloadRequest(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)
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
    model_config = ConfigDict(extra="allow", strict=True)
    success: bool
    message: str
    updated_fields: list[str]
    ignored_fields: list[str]


class HealthReadyResponse(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)
    status: Literal["ready", "not_ready"]
    reason: str | None = Field(default=None)


class KillResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    ok: bool


class LogsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    lines: list[str]
    totalLines: int = Field(ge=0)
    hasMore: bool


class ControlCommand(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)
    commandId: str = Field(pattern="^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
    type: Literal["deploy", "app-stop", "app-uninstall", "config-reload", "kill-execution", "update-package"]
    payload: dict[str, Any] | None = Field(default=None)
    issuedAt: int | None = Field(default=None)
    schemaVersion: int | None = Field(default=None)


class CommandResult(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)
    commandId: str
    type: Literal["deploy", "app-stop", "app-uninstall", "config-reload", "kill-execution", "update-package"]
    ok: bool
    status: int | None = Field(default=None)
    error: str | None = Field(default=None)
    durationMs: int | None = Field(ge=0, default=None)
    address: str | None = Field(default=None)
