/**
 * GENERATED — DO NOT EDIT.
 *
 * 来源：`packages/executor-protocol/protocol.json` 的 `schemas` 段（A3 完整形态，
 * DEEP_REVIEW 0ef3bbe §七）。由 `node scripts/generate-executor-protocol.mjs` 生成，
 * CI 的 executor-protocol-drift job 会重跑并 `git diff --exit-code` 兜底。
 *
 * 手改本文件会在下次生成时被覆盖，且不会让契约生效——要改请改 protocol.json。
 */
import { z } from "zod";

export const TaskConfigSchema = z.object({
  "id": z.string().nullable().optional(),
  "name": z.string().nullable().optional(),
  "runtime": z.string().nullable().optional(),
  "entrypoint": z.string().nullable().optional(),
  "timeout": z.number().int().min(0).max(86400).nullable().optional(),
  "timeoutSeconds": z.number().int().min(0).max(86400).nullable().optional(),
  "timeout_seconds": z.number().int().nullable().optional(),
  "requirements": z.array(z.string()).nullable().default([]),
  "gitRepo": z.string().nullable().optional(),
  "gitBranch": z.string().nullable().optional(),
  "gitCommit": z.string().nullable().optional(),
}).passthrough();
export type TaskConfig = z.infer<typeof TaskConfigSchema>;

export const ExecuteRequestSchema = z.object({
  "executionId": z.string().regex(new RegExp("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")),
  "task": TaskConfigSchema,
  "params": z.record(z.unknown()).nullable().optional(),
}).passthrough();
export type ExecuteRequest = z.infer<typeof ExecuteRequestSchema>;

export const ConfigReloadRequestSchema = z.object({
  "maxConcurrentTasks": z.number().int().min(1).optional(),
  "taskTimeoutSeconds": z.number().int().min(1).optional(),
  "heartbeatIntervalSeconds": z.number().int().min(5).optional(),
  "adminApiUrl": z.string().optional(),
  "adminApiUrlInternal": z.string().optional(),
  "adminApiUrlExternal": z.string().optional(),
  "adminApiUrls": z.array(z.string()).optional(),
  "workDir": z.string().optional(),
  "WORK_DIR": z.string().optional(),
}).passthrough();
export type ConfigReloadRequest = z.infer<typeof ConfigReloadRequestSchema>;

export const ConfigReloadResponseSchema = z.object({
  "success": z.boolean(),
  "message": z.string(),
  "updated_fields": z.array(z.string()),
  "ignored_fields": z.array(z.string()),
}).passthrough();
export type ConfigReloadResponse = z.infer<typeof ConfigReloadResponseSchema>;

export const HealthReadyResponseSchema = z.object({
  "status": z.enum(["ready", "not_ready"]),
  "reason": z.string().optional(),
}).passthrough();
export type HealthReadyResponse = z.infer<typeof HealthReadyResponseSchema>;

export const KillResponseSchema = z.object({
  "ok": z.boolean(),
}).strict();
export type KillResponse = z.infer<typeof KillResponseSchema>;

export const LogsResponseSchema = z.object({
  "lines": z.array(z.string()),
  "totalLines": z.number().int().min(0),
  "hasMore": z.boolean(),
}).strict();
export type LogsResponse = z.infer<typeof LogsResponseSchema>;
