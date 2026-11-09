/**
 * 部署面（3 个工具）：list_deployments / deploy_application / deploy_app。
 *
 * R6「工具清单化」第 3 批（2026-11-04）从 `tools.ts` 的 `registerDeploymentTools`
 * **整体搬出**：`server.tool` 调用块逐字节未改（name / description / 入参 schema /
 * 注解 / handler 都保持原样），只是换了个文件。搬迁纪律：**块逐字节搬移**，
 * 不重排、不改写、不「顺手优化」。
 *
 * ## ⚠️ DEP-04 审批语义链（跨两个文件 —— 读一边必须读另一边）
 *
 * 本域 9 个工具里 **6 个属于 DEP-04 同一条语义链**，拆成两个文件时没有拆散语义，
 * 但**读代码时必须两边一起看**：
 *   · **产生侧（本文件）**：`deploy_application` / `deploy_app` —— 应用开了
 *     `approvalRequired` 时后端返回 `approvalStatus=pending_approval` 的**冻结行**，
 *     一个字节都不下发；这两个 handler 都把它显式改写成 `dispatched:false` + note，
 *     而不是返回一个长得像 200 的载荷（否则调用方以为已经部署了）。
 *   · **闭环侧（`./deployment-approval.ts`）**：`list_pending_approvals` /
 *     `approve_deployment` / `reject_deployment` / `cancel_deployment` ——
 *     审批队列 + `POST /app-deployments/:id/approval/{approve,reject,cancel}`；
 *     **第二人规则**（审批人 ≠ 发起人）由后端强制；cancel 路由是 `@Roles(ADMIN)`，
 *     非管理员的发起人无法撤回。
 * 两侧共用同一组 `approvalStatus` 字符串与 `/approval/*` 路由 ⇒ **改任一侧前先读另一侧**。
 *
 * 另一条跨工具判决也落在这里：`executorId` 收窄为 **uuid**（旧 `z.string()` 会把
 * 拼错/已删除的 id 原样发出去，而后端**静默改投**另一台机器，只 warn 一句）⇒
 * handler 用 `executorReassigned` + requested/actual 把这次替换说出来。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  JSON_CONTENT,
  JSON_ERROR,
  UUID_PATH_ID,
  deploymentEnvWithinLimits,
  textWithin,
} from "./shared";
import type { ApiCall } from "./shared";

export function registerDeploymentDeployTools(
  server: McpServer,
  call: ApiCall,
): void {
  // ---- list_deployments ----------------------------------------------------
  server.tool(
    "list_deployments",
    "List application deployments with optional filtering by application ID and pagination.",
    {
      applicationId: UUID_PATH_ID.optional().describe("Filter by application ID"),
      page: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe("Page number (default 1)"),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Items per page (default 20)"),
    }, { readOnlyHint: true, idempotentHint: true },
    async ({ applicationId, page, pageSize }) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ...(applicationId ? { applicationId } : {}),
      });
      const data = await call<unknown>("GET", `/app-deployments?${params}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- deploy_application --------------------------------------------------
  // DEP-04: applications with approvalRequired=true return a frozen
  // pending_approval row (no dispatch) — the response's approvalStatus field
  // surfaces that; polling/next steps live in the tool description.
  server.tool(
    "deploy_application",
    "Deploy an application to an executor. runMode defaults to `scheduled` (deploy-only — nothing starts until a task/cron triggers it); pass once/daemon only if you intend the entry script to start at deploy. Leave executorId empty to auto-select the online executor with lowest load. Optionally override env vars and start command. NOTE (DEP-04): if the application has deployment approval enabled, the response returns approvalStatus=pending_approval and NOTHING is dispatched — the deployment waits for a second-person approval (POST /app-deployments/:id/approval/approve|reject, or /approval/cancel by the requester). A 409 means the application already has an in-progress deployment.",
    {
      applicationId: UUID_PATH_ID.describe("Application ID"),
      // F4（本轮审计）：收窄为 uuid。旧实现 z.string() 会把 "MY-LAPTOP" 这类
      // 非 id 原样发给后端，而后端在 executor 不存在时**静默改投**最低负载的
      // 另一台（app-deployment.service.ts:1339-1358 只 warn 一句）——代码被装到
      // 用户没想到的机器上，响应里只有一个陌生 id，很容易被当成"正常自动选择"。
      executorId: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Target executor ID (uuid). Omit to auto-select the lowest-load online executor. If the id no longer exists the backend re-selects another executor — the response then carries executorReassigned=true.",
        ),
      runMode: z
        .enum(["once", "daemon", "scheduled"])
        .optional()
        .describe(
          "Run mode. OMIT for the safe default: scheduled = deploy-only, nothing starts until a task/cron triggers it. once = start the entry script immediately (no restart). daemon = start immediately AND auto-restart on crash — only for resident services.",
        ),
      // R115：后端 env 上限 50 键 / 键值各 4096 UTF-8 字节。
      env: deploymentEnvWithinLimits().optional().describe("Environment variable overrides"),
      // R111-A1 上限出处：CreateDeploymentDto.startCommand 的 @MaxLength(2000)
      // （apps/admin-api/src/modules/application/dto/app-deployment.dto.ts:84）。
      // deploy_application 与 deploy_app 共用同一 POST /app-deployments/.../deploy 体。
      startCommand: textWithin(2000)
        .optional()
        .describe("Startup command override (max 2000 chars)"),
    }, { destructiveHint: true },
    async ({ applicationId, executorId, runMode, env, startCommand }) => {
      // P0 (MCP-AGENT-UX-AUDIT): never let an omitted runMode fall through to the
      // backend default. CreateDeploymentDto declares `default: RunMode.DAEMON`,
      // and DAEMON starts the entry script AT DEPLOY — so a plain "deploy this
      // app" would silently execute it, double-running against any later
      // task/cron trigger. Mirror the CLI fix (acf app deploy) and send
      // `scheduled` explicitly when the caller did not choose a mode.
      const effectiveRunMode = runMode ?? "scheduled";
      const body = Object.fromEntries(
        Object.entries({
          executorId,
          runMode: effectiveRunMode,
          env,
          startCommand,
        }).filter(([, v]) => v !== undefined),
      );
      const data = await call<Record<string, unknown>>(
        "POST",
        `/app-deployments/applications/${applicationId}/deploy`,
        body,
      );
      // DEP-04: pending_approval rows are frozen (not dispatched) — make that
      // state impossible to miss instead of returning a look-alike 200 payload.
      if (data?.approvalStatus === "pending_approval") {
        return JSON_CONTENT({
          ...data,
          dispatched: false,
          note: "Deployment is frozen pending approval (DEP-04): nothing was dispatched to the executor. A second person must approve POST /app-deployments/" +
            String(data.id ?? ":id") +
            "/approval/approve (or the requester cancels via /approval/cancel).",
        });
      }
      // F4：后端在目标 executor 不存在时会静默改投另一台（只 warn 一句），
      // 而调用方从响应里读不出这个替换 —— 必须在结构化面上说出来。
      const actualExecutorId = data?.executorId;
      if (
        executorId !== undefined &&
        typeof actualExecutorId === "string" &&
        actualExecutorId !== executorId
      ) {
        return JSON_CONTENT({
          ...data,
          executorReassigned: true,
          requestedExecutorId: executorId,
          actualExecutorId,
          note:
            "The requested executor no longer exists (or is not addressable), so the backend " +
            "re-selected the least-loaded online executor: the code was deployed to " +
            actualExecutorId +
            ", NOT to " +
            executorId +
            ". Re-deploy with a valid executorId (list_executors) if that is the wrong machine.",
        });
      }
      // once/daemon really do start the entry script now — say so structurally
      // instead of leaving it to the caller's reading of runMode semantics.
      if (effectiveRunMode === "once" || effectiveRunMode === "daemon") {
        return JSON_CONTENT({
          ...data,
          runMode: effectiveRunMode,
          startsImmediately: true,
          note:
            `runMode="${effectiveRunMode}" starts the entry script immediately at deploy` +
            (effectiveRunMode === "daemon"
              ? " and auto-restarts it on crash."
              : " (it will not restart).") +
            " If you meant deploy-only (a task/cron triggers it later), omit runMode or pass scheduled.",
        });
      }
      return JSON_CONTENT(data);
    },
  );

  // ---- deploy_app (NF-06) ---------------------------------------------------
  // Thin variant over the same POST /app-deployments/applications/:id/deploy
  // route for users who identify the application by name: resolves
  // name → applicationId via GET /applications first. The backend accepts the
  // appName+version form of the brief only through the application record
  // itself (CreateDeploymentDto carries executorId/runMode/env/startCommand —
  // no appName/version fields, forbidNonWhitelisted would 400 on them).
  server.tool(
    "deploy_app",
    "Deploy an application by NAME (resolved via GET /applications). runMode defaults to `scheduled` (deploy-only — nothing starts until a task/cron triggers it); pass once/daemon only if you intend the entry script to start at deploy. Shares the deploy_application route and DEP-04 approval semantics: applications with approval enabled return approvalStatus=pending_approval and are not dispatched until a second person approves.",
    {
      appName: z.string().describe("Application name (unique)"),
      // F4（本轮审计）：收窄为 uuid。旧实现 z.string() 会把 "MY-LAPTOP" 这类
      // 非 id 原样发给后端，而后端在 executor 不存在时**静默改投**最低负载的
      // 另一台（app-deployment.service.ts:1339-1358 只 warn 一句）——代码被装到
      // 用户没想到的机器上，响应里只有一个陌生 id，很容易被当成"正常自动选择"。
      executorId: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Target executor ID (uuid). Omit to auto-select the lowest-load online executor. If the id no longer exists the backend re-selects another executor — the response then carries executorReassigned=true.",
        ),
      runMode: z
        .enum(["once", "daemon", "scheduled"])
        .optional()
        .describe(
          "Run mode. OMIT for the safe default: scheduled = deploy-only, nothing starts until a task/cron triggers it. once = start the entry script immediately (no restart). daemon = start immediately AND auto-restart on crash — only for resident services.",
        ),
      // R115：后端 env 上限 50 键 / 键值各 4096 UTF-8 字节。
      env: deploymentEnvWithinLimits().optional().describe("Environment variable overrides"),
      // R111-A1 上限出处：CreateDeploymentDto.startCommand 的 @MaxLength(2000)
      // （apps/admin-api/src/modules/application/dto/app-deployment.dto.ts:84）。
      // deploy_application 与 deploy_app 共用同一 POST /app-deployments/.../deploy 体。
      startCommand: textWithin(2000)
        .optional()
        .describe("Startup command override (max 2000 chars)"),
    }, { destructiveHint: true },
    async ({ appName, executorId, runMode, env, startCommand }) => {
      const apps = await call<
        | Array<{ id?: string; name?: string; version?: string }>
        | { list?: Array<{ id?: string; name?: string; version?: string }> }
      >("GET", "/applications");
      const rows = Array.isArray(apps) ? apps : (apps?.list ?? []);
      const app = rows.find((a) => a?.name === appName);
      if (!app?.id) {
        return JSON_ERROR({
          error: `Application "${appName}" not found`,
          available: rows.map((a) => a?.name).filter(Boolean),
        });
      }
      const effectiveRunMode = runMode ?? "scheduled";
      const body = Object.fromEntries(
        Object.entries({
          executorId,
          runMode: effectiveRunMode,
          env,
          startCommand,
        }).filter(([, v]) => v !== undefined),
      );
      const data = await call<Record<string, unknown>>(
        "POST",
        `/app-deployments/applications/${app.id}/deploy`,
        body,
      );
      if (data?.approvalStatus === "pending_approval") {
        return JSON_CONTENT({
          ...data,
          dispatched: false,
          note: "Deployment is frozen pending approval (DEP-04): nothing was dispatched to the executor. A second person must approve POST /app-deployments/" +
            String(data.id ?? ":id") +
            "/approval/approve (or the requester cancels via /approval/cancel).",
        });
      }
      // F4：与 deploy_application 同一条判据——目标机不存在时后端静默改投，
      // 必须在结构化面上说出来（否则调用方以为装在自己指定的机器上）。
      const actualExecutorId = data?.executorId;
      if (
        executorId !== undefined &&
        typeof actualExecutorId === "string" &&
        actualExecutorId !== executorId
      ) {
        return JSON_CONTENT({
          ...data,
          executorReassigned: true,
          requestedExecutorId: executorId,
          actualExecutorId,
          note:
            "The requested executor no longer exists (or is not addressable), so the backend " +
            "re-selected the least-loaded online executor: the code was deployed to " +
            actualExecutorId +
            ", NOT to " +
            executorId +
            ". Re-deploy with a valid executorId (list_executors) if that is the wrong machine.",
        });
      }
      // Same startsImmediately signalling as deploy_application (see comment there).
      if (effectiveRunMode === "once" || effectiveRunMode === "daemon") {
        return JSON_CONTENT({
          ...data,
          runMode: effectiveRunMode,
          startsImmediately: true,
          note:
            `runMode="${effectiveRunMode}" starts the entry script immediately at deploy` +
            (effectiveRunMode === "daemon"
              ? " and auto-restarts it on crash."
              : " (it will not restart).") +
            " If you meant deploy-only (a task/cron triggers it later), omit runMode or pass scheduled.",
        });
      }
      return JSON_CONTENT(data);
    },
  );
}
