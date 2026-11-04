/**
 * MCP tool registrations for AutoCodeFlow.
 * Each `register*Tools(server, call)` keeps HTTP concerns in the injected
 * `call` function so routes/params/responses can be unit-tested with a mock.
 *
 * ## 结构（R6「工具清单化」第 2 批，2026-11-04）
 *
 * 本文件 = **共享件的再导出（对外 import 路径不变）+ 尚未搬走的工具组**。
 * 已经搬走的组在 `./tools/*.ts`，这里用 `export ... from` **再导出**，所以
 * `index.ts` 与 5 个 spec 的 `from "../tools"` 一个字都不用改。
 *
 * 已搬出：audit(1) / project(3) / executor(3) / task(21)。仍在本文件：
 * application(6) / mutex(4) / deployment(9) / observability(3) / sop(6)。
 * 搬迁纪律：`server.tool` 调用块**整块搬移、逐字节不改**（56 个工具的
 * name/description/schema 是对外契约，`tool-schema-fidelity.test.ts` 守着）。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  AGENT_SESSION_KIND,
  AGENT_SESSION_STATUS,
  ANALYZE_TIMEOUT_MS,
  JSON_CONTENT,
  JSON_ERROR,
  TASK_NAME_MAX_LENGTH,
  UUID_PATH_ID,
  deploymentEnvWithinLimits,
  rejectRedactionSentinel,
  textWithin,
} from "./tools/shared";
import type { ApiCall } from "./tools/shared";

// 共享件的**对外出口保持原路径**（消费方继续 `from "../tools"`），并且**只列拆分前
// 就已经公开的那 13 个名字** —— 不写 `export *`：否则 `JSON_CONTENT` / `UUID_PATH_ID` /
// 各 zod 枚举这些内部构件会顺着 "./tools" 漏成公开 API（多出来的出口没人用，
// 却是往后重构的隐形锁）。
export {
  ANALYZE_TIMEOUT_MS,
  DEPLOYMENT_ENV_MAX_KEYS,
  DEPLOYMENT_ENV_VALUE_MAX_BYTES,
  TASK_NAME_MAX_LENGTH,
  TASK_PARAMS_MAX_BYTES,
  codePointLength,
  extractToolErrorInfo,
  findRedactionSentinel,
  jsonByteLength,
  utf8ByteLength,
  withStructuredToolErrors,
} from "./tools/shared";
export type { ApiCall, ToolErrorStructuredContent } from "./tools/shared";

// 已搬出的工具组：同样再导出，`tools.ts` 仍是唯一的对外入口（S1 聚合出口）。
export { registerAuditTools } from "./tools/audit";
export { registerExecutorTools } from "./tools/executor";
export { registerProjectTools } from "./tools/project";

// task 组（21 个工具）的 6 个子域实现。**只在本文件里 import**（不 re-export）——
// 对外出口仍是下面那个 `registerTaskTools` 聚合器。
import { registerTaskDefinitionTools } from "./tools/task-definition";
import { registerTaskUpdateTools } from "./tools/task-update";
import { registerTaskVersionTools } from "./tools/task-version";
import { registerTaskExecutionTools } from "./tools/task-execution";
import { registerTaskOperationTools } from "./tools/task-operations";
import { registerTaskTemplateTools } from "./tools/task-template";

// ---------------------------------------------------------------------------
// Task templates (CORE-03: list_task_templates / create_task_from_template)
// The historical hardcoded TASK_TEMPLATES copy was removed: the admin-api
// seeds the SAME five official keys (scheduled_backup / health_check /
// data_sync / log_cleanup / webhook_ping) with the same config values
// (apps/admin-api/src/modules/task-template/task-template.constants.ts pins
// that alignment). Templates are now resolved server-side via
// GET /task-templates and instantiated via POST /task-templates/:id/instantiate
// so custom templates are usable too and the two template sources cannot
// drift. The historical `template` input keys keep resolving (by `key`).

// ---------------------------------------------------------------------------
// Tasks（21 个工具）—— **第 2 批已搬出**到 ./tools/task*.ts（6 个文件）
// ---------------------------------------------------------------------------
// 这里是**聚合器**：注册顺序与搬走前**逐字一致**（原 registerTaskTools 里的
// 工具顺序就是 task 组内部的顺序），所以「工具注册的先后」这一外部可见事实
// 不因拆文件而改变。
//
// 拆法（按子域，6 个文件）：
//   · task-definition.ts   list_tasks / get_task / trigger_task
//   · task-update.ts update_task（schema 声明提到模块级常量）
//   · task-version.ts      list_task_versions / rollback_task_version /
//                          compare_task_versions
//   · task-execution.ts    list_executions / get_execution / analyze_execution /
//                          get_execution_stats / suggest_schedule /
//                          get_execution_logs / kill_execution / retry_execution
//   · task-operations.ts   pause_task / resume_task / export_task / import_task
//   · task-template.ts     list_task_templates / create_task_from_template
//
// 搬迁纪律：**server.tool 块整块搬移、逐字节不改**（name / description /
// 入参 schema / 注解 / handler 一个字都没动）。
export function registerTaskTools(server: McpServer, call: ApiCall): void {
  registerTaskDefinitionTools(server, call);
  registerTaskUpdateTools(server, call);
  registerTaskVersionTools(server, call);
  registerTaskExecutionTools(server, call);
  registerTaskOperationTools(server, call);
  registerTaskTemplateTools(server, call);
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------
export function registerApplicationTools(
  server: McpServer,
  call: ApiCall,
): void {
  // ---- list_applications ----------------------------------------------------
  server.tool(
    "list_applications",
    "List all registered applications in AutoCodeFlow.",
    {}, { readOnlyHint: true, idempotentHint: true },
    async () => {
      const data = await call<unknown>("GET", "/applications");
      return JSON_CONTENT(data);
    },
  );

  // ---- get_application ------------------------------------------------------
  server.tool(
    "get_application",
    "Get full details of a registered application by ID, including version, git repo info, and runtime config.",
    {
      applicationId: UUID_PATH_ID.describe("Application ID"),
    }, { readOnlyHint: true },
    async ({ applicationId }) => {
      const data = await call<unknown>("GET", `/applications/${applicationId}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- create_application ---------------------------------------------------
  server.tool(
    "create_application",
    "ADMIN only. Register a new application (POST /applications is @Roles(ADMIN)). Required fields: name (unique, max 100 chars), version (e.g. 1.0.0), runtime (e.g. node/python).",
    {
      name: z.string().max(100).describe("Unique application name"),
      version: z.string().describe("Application version number, e.g. 1.0.0"),
      runtime: z.string().describe("Runtime type, e.g. node or python"),
      // R111-A1 上限出处：CreateApplicationDto.description 的 @MaxLength(500)
      // （apps/admin-api/src/modules/application/dto/application.dto.ts:27）。
      description: textWithin(500)
        .optional()
        .describe("Application description (max 500 chars)"),
      gitRepo: z.string().optional().describe("Git repository URL"),
      gitBranch: z.string().optional().describe("Git branch"),
      gitCommit: z.string().optional().describe("Git commit SHA"),
      manifest: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Application manifest object"),
      // R115：后端 env 上限 50 键 / 键值各 4096 UTF-8 字节（app-deployment.dto.ts:24-25）。
      env: deploymentEnvWithinLimits().optional().describe("Environment variables"),
      entrypoint: z.string().optional().describe("Entry point command"),
      packageUrl: z.string().optional().describe("Package download URL"),
      // F1（本轮审计）：漏字段 = 静默丢弃。MCP SDK 把工具的原始 shape 归一成
      // z.object(shape) 再 parse，zod 默认**剥掉未声明的键**——所以
      // `create_application{approvalRequired:true}` 曾经发出去的是
      // `{name,version,runtime}`，应用落库时审批门为 false，之后的部署全部直接
      // 下发、第二人审批被静默取消（安全语义丢失，且调用方看到的是"成功"）。
      approvalRequired: z
        .boolean()
        .optional()
        .describe(
          "DEP-04: require a second-person approval before each deploy (default false). Omit to keep the schema default.",
        ),
      mutexGroupId: z
        .string()
        .uuid()
        .nullable()
        .optional()
        .describe(
          "MUTEX-01: id of the application mutex group to join (null = not in any group). Use list_mutex_groups to discover ids.",
        ),
    }, { destructiveHint: false },
    async (args) => {
      const data = await call<unknown>("POST", "/applications", args);
      return JSON_CONTENT(data);
    },
  );

  // ---- update_application ---------------------------------------------------
  server.tool(
    "update_application",
    "ADMIN only. Update an existing application (PUT /applications/:id is @Roles(ADMIN)). NOTE: the backend UpdateApplicationDto has no `name` field — renaming is not supported.",
    {
      applicationId: UUID_PATH_ID.describe("Application ID"),
      // R111-A1 上限出处：UpdateApplicationDto 是 PartialType(CreateApplicationDto)
      // （application.dto.ts:85），继承 description 的 @MaxLength(500)（:27）。
      description: textWithin(500)
        .optional()
        .describe("Application description (max 500 chars)"),
      version: z.string().optional().describe("Application version number"),
      runtime: z.string().optional().describe("Runtime type"),
      status: z
        .string()
        .optional()
        .describe(
          "Application status: active | deploying | failed (ApplicationStatus enum)",
        ),
      gitRepo: z.string().optional().describe("Git repository URL"),
      gitBranch: z.string().optional().describe("Git branch"),
      gitCommit: z.string().optional().describe("Git commit SHA"),
      manifest: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Application manifest object"),
      // R115：后端 env 上限 50 键 / 键值各 4096 UTF-8 字节（app-deployment.dto.ts:24-25）。
      env: deploymentEnvWithinLimits().optional().describe("Environment variables"),
      entrypoint: z.string().optional().describe("Entry point command"),
      packageUrl: z.string().optional().describe("Package download URL"),
      // R111-A1 上限出处：UpdateApplicationDto.webhookSecret 的 @MaxLength(256)
      // （application.dto.ts:102）。
      webhookSecret: textWithin(256)
        .optional()
        .describe(
          "HMAC-SHA256 webhook secret (max 256 chars; empty string disables webhook auth)",
        ),
      // F1：`list_mutex_groups` 的描述逐字写着「用返回的 id 作为
      // update_application 的 mutexGroupId」，但本 shape 里没有这个键 ——
      // 照着工具描述操作必然空转（zod 剥键 → PUT body {} → 后端 200）。
      mutexGroupId: z
        .string()
        .uuid()
        .nullable()
        .optional()
        .describe(
          "MUTEX-01: id of the application mutex group to join (null = leave any group). Use list_mutex_groups to discover ids.",
        ),
      approvalRequired: z
        .boolean()
        .optional()
        .describe(
          "DEP-04: require a second-person approval before each deploy. Turning this off re-opens direct dispatch.",
        ),
    }, { destructiveHint: true, idempotentHint: true },
    async ({ applicationId, ...fields }) => {
      // Drop undefined fields — the global ValidationPipe with
      // forbidNonWhitelisted rejects unknown/extra properties, and explicit
      // undefined keys can serialize differently across transports.
      const body = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      );
      // 空 patch = 必然空转：后端对 `{}` 直接跳过写入并返回 200（还会落一条
      // application.update 审计）。这类"成功"会让 agent 以为改完了——宁可
      // 明确失败并告诉它哪些字段可写。
      if (Object.keys(body).length === 0) {
        return JSON_ERROR({
          error: "NO_UPDATABLE_FIELDS",
          message:
            "update_application received no updatable field, so nothing would change. " +
            "Pass at least one of: description, version, runtime, status, gitRepo, gitBranch, " +
            "gitCommit, manifest, env, entrypoint, packageUrl, webhookSecret, mutexGroupId, approvalRequired.",
        });
      }
      const redacted = rejectRedactionSentinel(body, "update_application");
      if (redacted) return redacted;
      const data = await call<unknown>(
        "PUT",
        `/applications/${applicationId}`,
        body,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- delete_application ---------------------------------------------------
  server.tool(
    "delete_application",
    "ADMIN only. Delete an application by ID (DELETE /applications/:id is @Roles(ADMIN)).",
    {
      applicationId: UUID_PATH_ID.describe("Application ID"),
    }, { destructiveHint: true },
    async ({ applicationId }) => {
      const data = await call<unknown>(
        "DELETE",
        `/applications/${applicationId}`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- analyze_application --------------------------------------------------
  server.tool(
    "analyze_application",
    "ADMIN only. Run AI health analysis on an application. Aggregates recent execution stats across all tasks and returns LLM-generated health assessment and recommendations.",
    {
      applicationId: UUID_PATH_ID.describe("Application ID"),
    }, { destructiveHint: false },
    async ({ applicationId }) => {
      const data = await call<unknown>(
        "POST",
        `/applications/${applicationId}/analyze`,
        undefined,
        ANALYZE_TIMEOUT_MS,
      );
      return JSON_CONTENT(data);
    },
  );
}

// ---------------------------------------------------------------------------
// Mutex groups (MUTEX-01): apps in one group never run concurrently per device
// ---------------------------------------------------------------------------
/**
 * MUTEX-01：应用互斥组。同一组内的应用在**同一台设备上**永不并发（组内并发数
 * 默认 1 = 串行）——典型场景是独占型资源：浏览器实例、单点登录账号（顶号）、
 * GPU 槽位。
 *
 * 为什么要单独成组注册：这四个端点（GET/POST/PUT/DELETE /mutex-groups）自
 * MUTEX-01 起就存在且中台在用，但 MCP 面此前**零接入**——agent 既看不到
 * 「有哪些互斥组可选」，也无法在挂应用前确认组的语义（device 单机串行 vs
 * global 全平台串行）。挂应用本身走 update_application 的 mutexGroupId。
 */
export function registerMutexTools(server: McpServer, call: ApiCall): void {
  // ---- list_mutex_groups ----------------------------------------------------
  server.tool(
    "list_mutex_groups",
    "List application mutex groups. Apps in the same group never run concurrently on the same device (maxConcurrentPerDevice, default 1 = serial). scope=device serialises per device but allows cross-device concurrency; scope=global serialises platform-wide (e.g. single-sign-on takeover). Use the returned id as update_application's mutexGroupId to attach an app.",
    {}, { readOnlyHint: true, idempotentHint: true },
    async () => {
      const data = await call<unknown>("GET", "/mutex-groups");
      return JSON_CONTENT(data);
    },
  );

  // ---- create_mutex_group ---------------------------------------------------
  server.tool(
    "create_mutex_group",
    "ADMIN only. Create an application mutex group. Creating a group does not change the behaviour of any existing application — apps join a group only when their mutexGroupId is set (via update_application, also ADMIN only).",
    {
      name: z
        .string()
        .max(64)
        .describe("Unique group name (max 64 chars)"),
      maxConcurrentPerDevice: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe(
          "Concurrent runs allowed per device (1-100, default 1 = serial). With scope=global this becomes the platform-wide limit.",
        ),
      scope: z
        .enum(["device", "global"])
        .optional()
        .describe(
          "device (default) = serial per device, cross-device concurrent; global = serial platform-wide (single-sign-on takeover)",
        ),
      description: z
        .string()
        .max(500)
        .optional()
        .describe("What the group is for (max 500 chars)"),
    }, { destructiveHint: false },
    async (fields) => {
      // CreateMutexGroupDto 白名单：未提供的字段不能带 undefined 键
      //（全局 ValidationPipe forbidNonWhitelisted）。
      const body = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      );
      const data = await call<unknown>("POST", "/mutex-groups", body);
      return JSON_CONTENT(data);
    },
  );

  // ---- update_mutex_group ---------------------------------------------------
  server.tool(
    "update_mutex_group",
    "ADMIN only. Update a mutex group (name / maxConcurrentPerDevice / scope / description). Takes effect on the next dispatch. Tightening scope to global or lowering maxConcurrentPerDevice immediately restricts production concurrency; waiting executions are re-dispatched automatically.",
    {
      groupId: UUID_PATH_ID.describe("Mutex group ID"),
      name: z.string().max(64).optional().describe("New group name (unique)"),
      maxConcurrentPerDevice: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("New per-device concurrency (1-100)"),
      scope: z
        .enum(["device", "global"])
        .optional()
        .describe("New scope: device | global"),
      description: z
        .string()
        .max(500)
        .optional()
        .describe("New description (max 500 chars)"),
    }, { destructiveHint: true, idempotentHint: true },
    async ({ groupId, ...fields }) => {
      const body = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      );
      // 空 patch 必须**报错**而不是发出去：后端对空更新返回「成功但什么都没改」，
      // 调用方（agent）会把 200 读成「已生效」。CLI 的 `acf mutex update` 与
      // agent 闸门的 update_mutex_group 执行体同口径——三处必须一致，否则
      // 同一个 API 在三个消费面上语义不同。
      if (Object.keys(body).length === 0) {
        return JSON_ERROR({
          error: "nothing_to_update",
          message:
            "update_mutex_group requires at least one field to change " +
            "(name / maxConcurrentPerDevice / scope / description). " +
            "An empty patch would silently succeed without changing anything.",
          availableFields: ["name", "maxConcurrentPerDevice", "scope", "description"],
        });
      }
      const data = await call<unknown>("PUT", `/mutex-groups/${groupId}`, body);
      return JSON_CONTENT(data);
    },
  );

  // ---- delete_mutex_group ---------------------------------------------------
  server.tool(
    "delete_mutex_group",
    "ADMIN only. Delete a mutex group. Attached applications silently lose the mutual-exclusion constraint (the FK nulls their mutexGroupId) — mutually exclusive workloads can then run concurrently and collide. The backend refuses with 409 while apps are still attached unless force=true. In-flight executions keep the group snapshot they started with.",
    {
      groupId: UUID_PATH_ID.describe("Mutex group ID"),
      force: z
        .boolean()
        .optional()
        .describe(
          "Delete even when applications are still attached (they silently lose the constraint)",
        ),
    }, { destructiveHint: true },
    async ({ groupId, force }) => {
      // 查询串只在 force=true 时需要，且 apiRequest 只收 body（无 params 形参）。
      //
      // 两条约束同时成立才写成现在这样：
      //   ① scripts/check-consumer-routes.mjs 按 `?` 切分并归一路径——字面量
      //      必须是完整可解析的 `/mutex-groups/${groupId}?force=true`（归一后
      //      = `/mutex-groups/{}`，与 openapi 对齐）。**不能**在模板里放三元
      //      表达式（会捕获到残缺路径 `${opts.force ` 而误报「不在 openapi 中」）；
      //   ② 该守卫只识别**调用点直接内联的字面量**，把路径存进变量再传（如
      //      `const path = …; call(method, path)`）会让这条路由**完全不被扫描**
      //      ——静默失去覆盖。故此处用 if/else 各自内联完整字面量，不用变量。
      if (force === true) {
        const data = await call<unknown>(
          "DELETE",
          `/mutex-groups/${groupId}?force=true`,
          undefined,
        );
        return JSON_CONTENT(data);
      }
      const data = await call<unknown>(
        "DELETE",
        `/mutex-groups/${groupId}`,
        undefined,
      );
      return JSON_CONTENT(data);
    },
  );
}

// ---------------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------------
export function registerDeploymentTools(
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

  // ---- upgrade_deployment --------------------------------------------------
  server.tool(
    "upgrade_deployment",
    "ADMIN only. Trigger an overlay upgrade for a running deployment so it pulls the latest application version.",
    {
      deploymentId: UUID_PATH_ID.describe("Deployment ID to upgrade"),
    }, { destructiveHint: true },
    async ({ deploymentId }) => {
      const data = await call<unknown>(
        "POST",
        `/app-deployments/${deploymentId}/upgrade`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- stop_deployment -----------------------------------------------------
  server.tool(
    "stop_deployment",
    "ADMIN only. Stop a running application deployment.",
    {
      deploymentId: UUID_PATH_ID.describe("Deployment ID to stop"),
    }, { destructiveHint: true, idempotentHint: true },
    async ({ deploymentId }) => {
      const data = await call<unknown>(
        "POST",
        `/app-deployments/${deploymentId}/stop`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- DEP-04 approval workflow --------------------------------------------
  // deploy_application/deploy_app can freeze a deployment at
  // approvalStatus=pending_approval (nothing dispatched). These tools close
  // the loop so an MCP user can list the queue and act on a pending row
  // without leaving the agent (second-person rule enforced server-side).

  server.tool(
    "list_pending_approvals",
    "List deployments awaiting approval (DEP-04 queue, ADMIN only). Returns rows with approvalStatus=pending_approval; each row's id feeds approve_deployment / reject_deployment / cancel_deployment.",
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
    }, { readOnlyHint: true },
    async ({ applicationId, page, pageSize }) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ...(applicationId ? { applicationId } : {}),
      });
      const data = await call<unknown>(
        "GET",
        `/app-deployments/approvals/pending?${params}`,
      );
      return JSON_CONTENT(data);
    },
  );

  server.tool(
    "approve_deployment",
    "ADMIN only. Approve a pending deployment (DEP-04). Approving dispatches it to the executor. Second-person rule: the approver must differ from the requester, otherwise the API returns an error.",
    {
      deploymentId: UUID_PATH_ID.describe("Pending deployment ID to approve"),
      reason: z
        .string()
        .max(200)
        .optional()
        .describe("Optional decision reason (≤200 chars), recorded in audit"),
    }, { destructiveHint: true },
    async ({ deploymentId, reason }) => {
      const body = reason !== undefined ? { reason } : undefined;
      const data = await call<unknown>(
        "POST",
        `/app-deployments/${deploymentId}/approval/approve`,
        body,
      );
      return JSON_CONTENT(data);
    },
  );

  server.tool(
    "reject_deployment",
    "ADMIN only. Reject a pending deployment (DEP-04). The deployment is never dispatched. Second-person rule applies.",
    {
      deploymentId: UUID_PATH_ID.describe("Pending deployment ID to reject"),
      reason: z
        .string()
        .max(200)
        .optional()
        .describe("Optional decision reason (≤200 chars), recorded in audit"),
    }, { destructiveHint: true },
    async ({ deploymentId, reason }) => {
      const body = reason !== undefined ? { reason } : undefined;
      const data = await call<unknown>(
        "POST",
        `/app-deployments/${deploymentId}/approval/reject`,
        body,
      );
      return JSON_CONTENT(data);
    },
  );

  server.tool(
    "cancel_deployment",
    "ADMIN only. Cancel own pending deployment request (DEP-04). Requester-only exit: the user who triggered the deployment may withdraw it before anyone approves — note the backend route POST /app-deployments/:id/approval/cancel is @Roles(ADMIN), so a non-admin requester cannot withdraw it through this endpoint.",
    {
      deploymentId: UUID_PATH_ID.describe("Pending deployment ID to cancel"),
    }, { destructiveHint: true },
    async ({ deploymentId }) => {
      const data = await call<unknown>(
        "POST",
        `/app-deployments/${deploymentId}/approval/cancel`,
      );
      return JSON_CONTENT(data);
    },
  );
}


// ---------------------------------------------------------------------------
// Observability (ECO-03): execution timeline / scheduler health
// ---------------------------------------------------------------------------

/** failureReason → first troubleshooting action (mirrors BUG-10 taxonomy). */
export const FAILURE_RUNBOOK: Record<string, string> = {
  package_fetch_failed:
    "Check package URL / registry availability; verify the private registry token if requirements point at it.",
  dependency_install_failed:
    "Inspect install logs (pip/uv/npm); pin versions and re-run. Offline executors need a reachable index.",
  git_fetch_failed:
    "Check gitRepo URL, branch and credentials; private-network git needs EXECUTOR_ALLOW_PRIVATE_NETWORK on the executor.",
  runtime_missing:
    "The executor lacks the runtime binary (node/python/shell). Install it or dispatch to another executor.",
  sandbox_unavailable:
    "The executor has TASK_SANDBOX=bwrap enabled but the sandbox is unusable (bwrap not installed / user namespaces disabled / enabled on Windows). Install bubblewrap and restart the executor, or unset TASK_SANDBOX. The executor deliberately refuses to run tasks unsandboxed — retrying will not help.",
  script_error:
    "Read the log tail around the first stack frame; run analyze_execution for an AI root cause.",
  timeout:
    "Raise timeoutSeconds, split the workload, or check for blocking I/O; repeated timeouts hint at a hung dependency.",
  executor_offline:
    "Check executor connectivity/registration; see list_dead_letters for callback backlog while it was gone.",
  executor_restart:
    "Transient — the sweep re-enqueued the run. Watch the retry chain; no action if the retry succeeded.",
  stale_recovered:
    "Worker crash or lost worker — the sweep terminated and re-enqueued. Inspect the executor host logs.",
  killed:
    "Manually killed (or block-strategy kill). Verify with the operator / audit log.",
  interpreter_unavailable:
    "The executor could not obtain the Python version the task declares. Verify uv is installed and the Python download source is reachable; 3.7 cannot be downloaded online and needs the operator to pre-provision the interpreter cache volume (or declare 3.8+ and re-trigger). The host interpreter is deliberately NOT used as a fallback — retrying without fixing the environment will not help.",
  unknown: "No reason reported — read the full logs and run analyze_execution.",
};

interface RawExecution {
  id?: string;
  taskId?: string;
  taskName?: string;
  status?: string;
  triggerType?: string;
  retryCount?: number;
  failureReason?: string | null;
  errorMessage?: string | null;
  exitCode?: number | null;
  startTime?: string | null;
  endTime?: string | null;
  createdAt?: string;
  duration?: number | null;
  aiAnalysis?: string | null;
  executorAddress?: string | null;
  [k: string]: unknown;
}

/**
 * Pure mapper: execution row → OBS-04 timeline. Kept exported (no fetch) so
 * the timestamps-vs-DB-consistency contract is unit-testable.
 */
export function buildExecutionTimeline(e: RawExecution): {
  executionId: string;
  taskId?: string;
  taskName?: string;
  status?: string;
  triggerType?: string;
  retryCount?: number;
  timeline: Array<{ at: string | null; phase: string; detail?: string }>;
  duration?: number | null;
  failure?: {
    reason: string;
    suggestion: string;
    errorMessage?: string;
    exitCode?: number | null;
  };
  aiAnalysis?: string;
} {
  const timeline: Array<{ at: string | null; phase: string; detail?: string }> =
    [
      {
        at: e.createdAt ?? null,
        phase: "created",
        detail: `trigger=${e.triggerType ?? "unknown"}`,
      },
      {
        at: e.startTime ?? null,
        phase: "started",
        detail: e.executorAddress ? `executor=${e.executorAddress}` : undefined,
      },
      {
        at: e.endTime ?? null,
        phase: "finished",
        detail: `status=${e.status ?? "unknown"}`,
      },
    ];
  const failure =
    e.status === "failed" || e.status === "timeout"
      ? {
          reason: e.failureReason ?? "unknown",
          suggestion:
            FAILURE_RUNBOOK[e.failureReason ?? ""] ?? FAILURE_RUNBOOK.unknown,
          ...(e.errorMessage ? { errorMessage: e.errorMessage } : {}),
          exitCode: e.exitCode ?? null,
        }
      : undefined;
  return {
    executionId: String(e.id ?? ""),
    taskId: e.taskId,
    taskName: e.taskName,
    status: e.status,
    triggerType: e.triggerType,
    retryCount: e.retryCount,
    timeline,
    duration: e.duration,
    ...(failure ? { failure } : {}),
    ...(e.aiAnalysis ? { aiAnalysis: e.aiAnalysis } : {}),
  };
}

export function registerObservabilityTools(
  server: McpServer,
  call: ApiCall,
): void {
  // ---- get_execution_timeline ----------------------------------------------
  server.tool(
    "get_execution_timeline",
    'OBS-04 timeline for one execution: created → started → finished timestamps plus a failure triage card (reason → suggested first action, from the failureReason taxonomy) and the AI analysis when present. Use it to answer "where did this run stall and why".',
    {
      executionId: UUID_PATH_ID.describe("Execution ID"),
    }, { readOnlyHint: true },
    async ({ executionId }) => {
      const data = await call<unknown>(
        "GET",
        `/tasks/executions/${executionId}`,
      );
      // R112：空载荷不再拼一个 `executionId: ""` 的成功载荷 —— 那看起来像「查询成功但执行没有 ID」，
      // 而真相是「没查到」。
      if (data === null || data === undefined) {
        return JSON_ERROR({
          error: "Execution not found (the API returned an empty payload)",
          errorCode: "EXECUTION_NOT_FOUND",
          executionId,
        });
      }
      return JSON_CONTENT(buildExecutionTimeline(data as RawExecution));
    },
  );

  // ---- list_dead_letters ----------------------------------------------------
  server.tool(
    "list_dead_letters",
    "Callback dead-letter backlog per executor: each executor reports how many failed callback payloads sit in its local dead-letter directory (replayed with backoff; moved to dead-letter after 5 rounds). A persistently high count means the executor could not reach admin-api for a while — inspect the executor host and replay/inspect its dead-letter files.",
    {}, { readOnlyHint: true },
    async () => {
      const data = await call<
        | { data?: Array<Record<string, unknown>> }
        | Array<Record<string, unknown>>
      >("GET", "/executors");
      // R114：**形状漂移不能变成「全清」**。旧写法 `data?.data ?? []` 在响应形状变了（比如后端从
      // `{data:[...]}` 改成裸数组之外的形态）时会得到空数组 ⇒ `totalDeadLetters: 0` ⇒ agent 以为
      // 「所有执行器的死信都清空了」。这是最危险的一种假成功：**把「读不懂」说成「没问题」**。
      const rows = Array.isArray(data)
        ? data
        : Array.isArray((data as { data?: unknown })?.data)
          ? ((data as { data: Array<Record<string, unknown>> }).data)
          : null;
      if (rows === null) {
        return JSON_ERROR({
          error:
            "Unexpected response shape from GET /executors (expected an array or { data: [...] })",
          errorCode: "UNEXPECTED_RESPONSE_SHAPE",
        });
      }
      const summary = rows
        .map((r) => {
          const deadLetterCount = r["deadLetterCount"];
          return {
            executorId: String(r["id"] ?? ""),
            // PK-18: 执行器实体字段是 appName（无 name），旧代码读
            // r["name"] 恒为 undefined——工具输出 name 永远为空。
            name: r["appName"],
            address: r["address"],
            status: r["status"],
            deadLetterCount:
              typeof deadLetterCount === "number" ? deadLetterCount : null,
          };
        })
        .sort((a, b) => (b.deadLetterCount ?? 0) - (a.deadLetterCount ?? 0));
      return JSON_CONTENT({
        totalDeadLetters: summary.reduce(
          (acc, s) => acc + (s.deadLetterCount ?? 0),
          0,
        ),
        executors: summary,
        note: "Counts are executor-side callback payloads awaiting replay (last heartbeat value). Files live in <work_dir>/callbacks/dead-letter on each executor host.",
      });
    },
  );

  // ---- get_scheduler_health -------------------------------------------------
  server.tool(
    "get_scheduler_health",
    "Scheduler health snapshot: leader identity + election state, BullMQ queue depths (waiting/active/delayed/failed — null means Redis unreachable, in which case healthy=false and a degraded note explains why), tick rate, trigger counters and the P99 trigger latency distribution. First stop when triggers stop firing or pile up.",
    {}, { readOnlyHint: true },
    async () => {
      const data = await call<Record<string, unknown>>(
        "GET",
        "/metrics/scheduler",
      );
      const m = (data ?? {}) as Record<string, unknown>;
      const counters = (m.counters ?? {}) as Record<string, unknown>;
      const derived = (m.derived ?? {}) as Record<string, unknown>;
      const queue = (m.queue ?? {}) as Record<string, unknown>;
      // PK-05: 缺数值（null/undefined，即 Redis 不可达）不能默认健康——
      // 显式判 false 并带 degraded 说明；failed<100 才算健康。
      const failedDepth =
        typeof queue.failed === "number" ? queue.failed : null;
      const healthy = failedDepth !== null && failedDepth < 100;
      return JSON_CONTENT({
        healthy,
        ...(failedDepth === null
          ? {
              degraded:
                "queue metrics unavailable (Redis unreachable?) — cannot assess queue depth health",
            }
          : {}),
        leader: m.scheduler ?? null,
        instance: m.instance ?? null,
        queue,
        triggerLatency: {
          count: counters.triggerLatencyCount ?? 0,
          avgMs: derived.avgTriggerLatencyMs ?? 0,
          p99Ms: derived.p99TriggerLatencyMs ?? 0,
          lastMs: counters.lastTriggerLatencyMs ?? 0,
        },
        counters,
        derived,
      });
    },
  );
}


// ---------------------------------------------------------------------------
// SOP / Agent sessions (P5/P6 admin-side minimal loop: browse SOPs, see
// pending assignments + escalations, watch agent sessions, reply to
// clarifications — all over the existing ADMIN-only sop/agent endpoints)
// ---------------------------------------------------------------------------

/** 非终态指派（「待办」口径）；completed/failed/cancelled 为终态不入列。 */
export const SOP_PENDING_STATUSES = [
  "assigned",
  "in_progress",
  "blocked",
  "stalled",
] as const;

export function registerSopTools(server: McpServer, call: ApiCall): void {
  // ---- sop_list -------------------------------------------------------------
  server.tool(
    "sop_list",
    "ADMIN only. List SOP definitions (versioned procedure documents: front-matter capabilities/acceptance + markdown body). Returns { items, total }.",
    {
      status: z
        .string()
        .optional()
        .describe("Filter by SOP status (e.g. draft | published)"),
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
    }, { readOnlyHint: true },
    async ({ status, page, pageSize }) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ...(status ? { status } : {}),
      });
      const data = await call<unknown>("GET", `/sop?${params}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- sop_get --------------------------------------------------------------
  server.tool(
    "sop_get",
    "ADMIN only. Get one SOP by ID: metadata, current version, front-matter and markdown body. Use sop_list to resolve IDs.",
    {
      sopId: UUID_PATH_ID.describe("SOP ID (UUID)"),
    }, { readOnlyHint: true },
    async ({ sopId }) => {
      const data = await call<unknown>("GET", `/sop/${sopId}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- sop_assignments_pending ----------------------------------------------
  // 两种读形态对齐既有端点：sopId → GET /sop/:id/assignments（客户端按非终态
  // 过滤）；assignmentId → GET /sop/assignments/:id（含澄清对话全量，供
  // sop_clarification_reply 拿 clarificationId）。
  server.tool(
    "sop_assignments_pending",
    "ADMIN only. Inspect pending SOP work. Pass sopId to list that SOP's non-terminal assignments (assigned/in_progress/blocked/stalled — completed/failed/cancelled are excluded), or pass assignmentId to fetch one assignment's full detail including its clarification conversation (the clarification ids feed sop_clarification_reply).",
    {
      sopId: UUID_PATH_ID.optional().describe(
        "List non-terminal assignments of this SOP",
      ),
      assignmentId: UUID_PATH_ID.optional().describe(
        "Return this assignment's full detail (includes clarifications)",
      ),
    }, { readOnlyHint: true },
    async ({ sopId, assignmentId }) => {
      if (assignmentId) {
        const data = await call<unknown>(
          "GET",
          `/sop/assignments/${assignmentId}`,
        );
        return JSON_CONTENT(data);
      }
      if (sopId) {
        const rows = await call<Array<{ status?: string }>>(
          "GET",
          `/sop/${sopId}/assignments`,
        );
        const items = (Array.isArray(rows) ? rows : []).filter((r) =>
          (SOP_PENDING_STATUSES as readonly string[]).includes(r?.status ?? ""),
        );
        return JSON_CONTENT({
          sopId,
          pendingCount: items.length,
          items,
          note: "Terminal statuses (completed/failed/cancelled) are filtered out. Pass assignmentId to see one assignment's clarifications.",
        });
      }
      return JSON_ERROR({
        error: "Provide sopId (list pending assignments) or assignmentId (full detail)",
      });
    },
  );

  // ---- agent_session_list ----------------------------------------------------
  // kind/status 取值枚举对齐后端 AGENT_SESSION_KINDS / AGENT_SESSION_STATUSES
  // （此前漏了 sop_review / app_scaffold / chat 与 budget_exceeded——agent 传
  // 后端合法的值会因描述漂移被劝退）。
  server.tool(
    "agent_session_list",
    "ADMIN only. List agent sessions (ops_watch / incident / sop_authoring / sop_review / app_scaffold / chat runs) newest first. Sessions in waiting_input are paused waiting on a human decision (approval or SOP clarification) — use agent_session_get for their reasoning steps and tool calls.",
    {
      kind: AGENT_SESSION_KIND.optional().describe(
        "Filter by kind: ops_watch | incident | sop_authoring | sop_review | app_scaffold | chat",
      ),
      status: AGENT_SESSION_STATUS.optional().describe(
        "Filter by status: pending | running | waiting_input | succeeded | failed | aborted | budget_exceeded",
      ),
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
    }, { readOnlyHint: true },
    async ({ kind, status, page, pageSize }) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ...(kind ? { kind } : {}),
        ...(status ? { status } : {}),
      });
      const data = await call<unknown>("GET", `/agent/sessions?${params}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- agent_session_get ------------------------------------------------------
  server.tool(
    "agent_session_get",
    "ADMIN only. Get one agent session with its full reasoning steps, tool calls and child sessions — the audit trail for what the agent did and why.",
    {
      sessionId: UUID_PATH_ID.describe("Agent session ID (UUID)"),
    }, { readOnlyHint: true },
    async ({ sessionId }) => {
      const data = await call<unknown>("GET", `/agent/sessions/${sessionId}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- sop_clarification_reply ------------------------------------------------
  server.tool(
    "sop_clarification_reply",
    "ADMIN only. Answer an escalated SOP clarification (human-in-the-loop). resolution=answered replies with text; resolution=sop_amended additionally ships an amended SOP (front-matter YAML / body markdown) that the executor continues against (contentHash rebases on the amended version). Find pending clarifications via sop_assignments_pending with assignmentId.",
    {
      assignmentId: UUID_PATH_ID.describe(
        "SOP assignment that raised the clarification",
      ),
      clarificationId: UUID_PATH_ID.describe("Clarification to answer"),
      resolution: z
        .enum(["answered", "sop_amended"])
        .describe("answered = text reply; sop_amended = reply + amended SOP"),
      answer: z
        .string()
        .max(8000)
        .describe("Reply text shown to the executor (max 8000 chars)"),
      amendedFrontMatterYaml: z
        .string()
        .max(100_000)
        .optional()
        .describe("Amended front-matter YAML (sop_amended only)"),
      amendedBodyMarkdown: z
        .string()
        .max(500_000)
        .optional()
        .describe("Amended markdown body (sop_amended only)"),
      changelog: z
        .string()
        .max(2000)
        .optional()
        .describe("Short amendment changelog (max 2000 chars)"),
    }, { destructiveHint: true },
    async ({ assignmentId, clarificationId, ...fields }) => {
      // HumanReplyDto 白名单：未提供的修订字段不能带 undefined 键。
      const body = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      );
      const data = await call<unknown>(
        "POST",
        `/sop/assignments/${assignmentId}/clarifications/${clarificationId}/reply`,
        body,
      );
      return JSON_CONTENT(data);
    },
  );
}
