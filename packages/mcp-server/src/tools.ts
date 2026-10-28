/**
 * MCP tool registrations for AutoCodeFlow.
 * Each `register*Tools(server, call)` keeps HTTP concerns in the injected
 * `call` function so routes/params/responses can be unit-tested with a mock.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// R110：出参凭据剥除（防御纵深）。
import { redactSensitive } from "./redact.js";
import { z } from "zod";

export type ApiCall = <T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number,
) => Promise<T>;

/**
 * NETOPT-6④：analyze/suggest 类工具的 per-call 超时预算。
 *
 * admin 侧同步 AI 预算是 60s×2（两次 LLM 往返），而 apiRequest 默认
 * REQUEST_TIMEOUT_MS=30s 结构性小于服务端预算——AI 恰好跑满预算成功返回时，
 * 客户端早已放弃。analyze_execution / suggest_schedule / analyze_application
 * 这三个同步 AI 端点用 120s 覆盖（> 服务端 60s×2），其余端点维持 30s 默认。
 */
export const ANALYZE_TIMEOUT_MS = 120_000;

/**
 * R110（SEC-MCP-REDACT）：所有工具出参都经 `redactSensitive` 剥一层敏感键。
 *
 * 上游（admin-api）当前是干净的（`select:false` + 响应 DTO 排除 + `maskReadSurface`，R107-A1 逐项核过），
 * 但那是**三处彼此独立的约定**；任何一处新增面时漏一次，凭据就会经这里**直接进 LLM 上下文**。
 * 这一层不替代上游，只保证「上游漏了也还在本地被拦住」。
 */
const JSON_CONTENT = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(redactSensitive(data), null, 2) }],
});

/**
 * 错误面统一口径：HTTP 失败由 apiRequest 抛错、MCP SDK 转成
 * isError:true + error.message；而「参数可解析但语义无效」的用法错误
 * （未知模板/未知应用名/缺二选一 id）发生在 handler 内部——也必须带
 * isError:true，否则 MCP 客户端会把失败当成功。结构化 JSON 负载保留
 * （如 available 列表），让 agent 同时拿到失败信号与下一步可用的取值。
 */
const JSON_ERROR = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(redactSensitive(data), null, 2) }],
  isError: true as const,
});

/**
 * R31-E2: 工具错误的结构化面。
 *
 * admin-api 的错误体是 `{ code, message, errorCode, params }`——MCP 侧此前只把
 * `message` 转成文本给 agent，稳定码与插值参数全丢。现在 api.ts 把这两个字段挂到
 * 抛出的 Error 上（只读、可枚举、有值才挂），本文件的注册包装器再把它们放进
 * **structuredContent**：既有 text 逐字节不变，机读面新增。
 */
export interface ToolErrorStructuredContent {
  /** 服务端稳定错误码（如 `TASK_NOT_FOUND`）；无码时该键不存在。 */
  errorCode?: string;
  /** 错误码的插值参数；无参 / 非普通对象时该键不存在。 */
  params?: Record<string, unknown>;
}

/**
 * 从任意抛出的错误上抽 errorCode / params；两者都没有 → `null`
 * （= 该错误没有机读面，按原样抛给 MCP SDK，行为逐字节不变）。
 */
export function extractToolErrorInfo(
  err: unknown,
): ToolErrorStructuredContent | null {
  if (err === null || typeof err !== "object") return null;
  const { errorCode, params } = err as {
    errorCode?: unknown;
    params?: unknown;
  };
  const info: ToolErrorStructuredContent = {};
  if (typeof errorCode === "string" && errorCode.length > 0) {
    info.errorCode = errorCode;
  }
  if (params !== null && typeof params === "object" && !Array.isArray(params)) {
    info.params = params as Record<string, unknown>;
  }
  return Object.keys(info).length > 0 ? info : null;
}

/**
 * R31-E2: 在**注册边界**给每个工具错误补上 structuredContent。
 *
 * 为什么不改 handler 内部：既有约 20 个用例钉住「HTTP 错误 -> handler 抛错 ->
 * `.rejects.toThrow(/API error \(4xx\)/)`」这条行为（src/__tests__/tools.test.ts），
 * 改成 return 会让它们全红。用 Proxy 包一层 server.tool 后：
 *
 * - 带 errorCode / params 的错 → 返回 `{ content: [原文本], isError: true,
 *   structuredContent }`，text 仍是 `err.message`（与 MCP SDK 的默认转换逐字节
 *   一致），客户端读 structuredContent 就能按码分支；
 * - 不带码的错 → 原样 rethrow，交给 MCP SDK 走既有路径（完全无变化）。
 */
export function withStructuredToolErrors(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop !== "tool" || typeof value !== "function") return value;
      const register = value as (...a: unknown[]) => unknown;
      return (...args: unknown[]) => {
        const handler = args[args.length - 1];
        if (typeof handler !== "function") {
          // 兼容未来可能出现的非函数 handler 形态：不改变注册行为。
          return register.apply(target, args);
        }
        args[args.length - 1] = async (...handlerArgs: unknown[]) => {
          try {
            return await (handler as (...a: unknown[]) => unknown)(...handlerArgs);
          } catch (err) {
            const info = extractToolErrorInfo(err);
            if (!info) throw err;
            return {
              content: [
                {
                  type: "text" as const,
                  // 与 MCP SDK 的默认错误转换同款文案，只在此之上附加机读面。
                  text: err instanceof Error ? err.message : String(err),
                },
              ],
              isError: true as const,
              structuredContent: info as Record<string, unknown>,
            };
          }
        };
        return register.apply(target, args);
      };
    },
  });
}

/**
 * D1-P2-2: 路径插值 id 的入站白名单。后端 task/task-version/task-execution/
 * application/app-deployment/executor/project 主键均为 @PrimaryGeneratedColumn("uuid")。
 * 此前裸 z.string() 直接拼进 /tasks/:id 路径，畸形值（../、斜杠、编码穿越）可造成
 * 路径穿越；统一收窄为 UUID，非法值在 MCP SDK 入站校验层即拒（不到网络层）。
 */
const UUID_PATH_ID = z.string().uuid();

/**
 * R107-A1（MCP 输入面审计）：**枚举型入参的入站白名单**。
 *
 * 这些字段此前是裸 `z.string()` + 只把枚举写进描述里 —— 值域实际只有后端
 * DTO 的 @IsEnum 把关。agent 的入参来自 LLM，大小写/拼写漂移（"Active"、
 * "running "、"both"）是常态：旧形状下它要先跑一趟网络才吃 400，而 NestJS 的
 * 400 文案只有 "status must be a valid enum value"，**不告诉调用方合法值**。
 * 收窄后非法值在 MCP SDK 的入站校验层即被拒，zod 的报错自带完整值域
 * （"Invalid enum value. Expected 'active' | 'paused' | 'deleted'"），
 * 同时与 get_execution_logs.level / deploy_application.runMode 的既有做法一致。
 *
 * 值域出处（逐字对齐，不增不减——收窄越过 @IsEnum 会拒掉后端合法值）：
 *  - TaskStatus       apps/admin-api/src/modules/task/entities/task.entity.ts:14
 *  - ExecutionStatus  .../task/entities/task-execution.entity.ts:13
 *  - TaskTriggerType  .../task/entities/task.entity.ts:84
 *  - TaskRuntime      .../task/entities/task.entity.ts:90
 *  - ExecuteMode      .../task/entities/task.entity.ts:76
 *  - AGENT_SESSION_*  .../agent/entities/agent-session.entity.ts:31,54
 * 校验侧：list-tasks-query.dto.ts:120/135/143；create-task.dto.ts:71/72/114/269
 * （UpdateTaskDto = PartialType(CreateTaskDto)，继承同一批 @IsEnum）。
 *
 * 刻意**不**收紧的两处（收紧即造缺陷）：
 *  - `sop_list.status`：后端是裸 `@Query("status") status?: string`
 *    （apps/admin-api/src/modules/sop/sop.controller.ts:224），没有枚举可对齐；
 *  - `update_application.status`：PUT 透传语义已由 tools.test.ts 钉死
 *    （"INACTIVE" 原样转发）。
 */
const TASK_STATUS = z.enum(["active", "paused", "deleted"]);
const EXECUTION_STATUS = z.enum([
  "pending",
  "running",
  "waiting",
  "success",
  "failed",
  "timeout",
  "killed",
  "cancelled",
]);
const TASK_TRIGGER_TYPE = z.enum(["cron", "fixed_rate", "api", "manual"]);
const TASK_RUNTIME = z.enum(["python", "node", "shell"]);
const EXECUTE_MODE = z.enum(["single", "broadcast"]);
const AGENT_SESSION_KIND = z.enum([
  "ops_watch",
  "incident",
  "sop_authoring",
  "sop_review",
  "app_scaffold",
  "chat",
]);
const AGENT_SESSION_STATUS = z.enum([
  "pending",
  "running",
  "waiting_input",
  "succeeded",
  "failed",
  "aborted",
  "budget_exceeded",
]);

/**
 * MCP-DTO-ALIGN（2026-10-25）：update_task 参数面对齐 UpdateTaskDto（=
 * PartialType(CreateTaskDto)）——上轮巡查登记 17 个落后字段，本批补齐
 * agent 高价值子集 15 个（secrets/维护窗口/priority/timeout 系/
 * requirements/dependencies/blockStrategy/misfireStrategy/亲和×2/
 * deploymentPolicy/estimatedDurationSec/expectedUpdatedAt +
 * timeoutSeconds 补 max(86400)），登记 2 个（runtimeVersion/codeSource，
 * 理由见任务报告）。值域/上限逐字对齐后端事实源（出处逐条标注），不在
 * MCP 侧发明私有语义：收窄不得越过 @IsEnum/@Max 的值域（否则拒掉后端
 * 接受的合法值），放宽不得越过 @Min 的下界。
 *
 * admin-api 源文件（本包**不可 import**：mcp-server tsconfig rootDir=./src
 * 且 exclude 测试，跨树相对导入违反 TS6059——约束在此**重述**，语义由
 * tools.test.ts 的值域断言钉住，与 secret-key-map.constraint.spec.ts 的
 * 两侧对等性测试同一先例）：
 *  · CreateTaskDto     apps/admin-api/src/modules/task/dto/create-task.dto.ts
 *  · 枚举值域          apps/admin-api/src/modules/task/entities/task.entity.ts
 *  · TIMEOUT_ACTIONS   apps/admin-api/src/modules/task/timeout-policy.util.ts
 *  · secret 键名规则   apps/admin-api/src/modules/task/dto/secret-key-map.constraint.ts
 */
/** BlockStrategy（task.entity.ts:25；DTO @IsEnum，create-task.dto.ts:273）。 */
const BLOCK_STRATEGY = z.enum(["serial", "discard", "cover_early"]);
/** MisfireStrategy（task.entity.ts:80；DTO @IsEnum，create-task.dto.ts:277）。 */
const MISFIRE_STRATEGY = z.enum(["ignore", "fire_once"]);
/** TimeoutAction（timeout-policy.util.ts TIMEOUT_ACTIONS；DTO 用 @IsIn）。 */
const TIMEOUT_ACTION = z.enum(["kill", "kill_retry", "notify_only"]);

/**
 * priority：@IsEnum(TaskPriority)（create-task.dto.ts:256-259）。
 *
 * TaskPriority 是 TS 数字枚举（LOW=1..CRITICAL=4，task.entity.ts:31），
 * 运行时 Object.values = [1,2,3,4,"LOW","NORMAL","HIGH","CRITICAL"]（数字
 * 枚举自带反向映射，大写 label 也在 values 里）——class-validator 0.14 实测
 * 接受数字 1-4 与大写 label；**小写 label 与 "1"/"2" 数字串被 400 拒绝**
 * （tools.test.ts 有用例钉住该经验事实）。落库前实体列 transformer 把数字
 * 转小写 PG label（task.entity.ts:199），agent 侧无需关心。
 */
const TASK_PRIORITY = z.union([
  z.int().min(1).max(4),
  z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]),
]);

/**
 * maintenanceWindows 单条（MaintenanceWindowDto + @ValidateNested(each)）：
 *   · start/end：非空 5 字段 cron（@IsCron5Field，与主 cron 同一门）；
 *   · description：非空、≤200 码点（@MaxLength(200)，validator.js 按码点计）。
 * MCP 侧只复述**结构**边界（5 字段 = 空格分隔的 5 个非空 token；条数 ≤10
 * 由外层 .max(10) 对齐 @ArrayMaxSize(10)）；cron 语义合法性交给后端同源
 * 校验器（IsCron5Field = 调度器注册路径同一实现），不在客户端重写解析器。
 */
const MAINTENANCE_WINDOW_ITEM = z
  .object({
    start: z
      .string()
      .refine((v) => v.trim().length > 0 && v.trim().split(/\s+/).length === 5, {
        message: "start must be a 5-field cron expression (minute hour day month weekday)",
      })
      .describe("窗口开启 cron（5 字段：分 时 日 月 周；结构外语义校验在后端 IsCron5Field）"),
    end: z
      .string()
      .refine((v) => v.trim().length > 0 && v.trim().split(/\s+/).length === 5, {
        message: "end must be a 5-field cron expression (minute hour day month weekday)",
      })
      .describe("窗口关闭 cron（5 字段；start 最近触达开窗、end 最近触达关窗，半开区间）"),
    description: textWithin(200)
      .optional()
      .describe("窗口用途说明（≤200 码点，展示/日志用）"),
  })
  .strict();

/**
 * secrets：DTO = @IsObject + @Validate(IsSecretKeyMapConstraint)。
 *
 * 值形态刻意宽（unknown：叶子允许 null=删除该键 / "******"=保留 / 字符串=
 * 覆盖），因为**逐键合并语义在后端**（task.service.ts:2288-2299 applyPatch）
 * ——MCP 若在客户端替后端合并，必须先拿到明文旧值，而读路径永久脱敏
 * （叶子恒 ******），客户端合并必然错。键名规则逐字复述
 * secret-key-map.constraint.ts（合法环境变量名 + 保留名黑名单 +
 * AUTOFLOW_/PYTHON 前缀禁用），把后端的 400 提前到入站层。
 */
const RESERVED_SECRET_NAMES = new Set(
  [
    "EXECUTION_ID", "TASK_ID", "TASK_NAME", "NODE_PATH",
    "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    "npm_config_cache", "npm_config_prefix",
    "TMPDIR", "TEMP", "TMP", "USER", "LOGNAME", "SHELL",
    "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE",
    "HOMEDRIVE", "HOMEPATH", "USERNAME", "APPDATA", "LOCALAPPDATA",
    "ProgramData",
    "EXECUTOR_SHARED_TOKEN", "EXECUTOR_SECRET", "EXECUTION_CALLBACK_SECRET",
  ].map((n) => n.toUpperCase()),
);
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const taskSecretsMap = () =>
  z.record(z.string(), z.unknown()).superRefine((secrets, ctx) => {
    for (const key of Object.keys(secrets)) {
      const upper = key.toUpperCase();
      let problem: string | null = null;
      if (!SECRET_NAME_RE.test(key)) {
        problem = `secret key "${key}" is not a valid environment variable name (must match [A-Za-z_][A-Za-z0-9_]*)`;
      } else if (RESERVED_SECRET_NAMES.has(upper)) {
        problem = `secret key "${key}" is a platform-reserved environment variable name`;
      } else if (upper.startsWith("AUTOFLOW_")) {
        problem = `secret key "${key}" uses the AUTOFLOW_ prefix (reserved for task params)`;
      } else if (upper.startsWith("PYTHON")) {
        problem = `secret key "${key}" uses the PYTHON prefix (interpreter behavior switches)`;
      }
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }
  });

/**
 * R111-A1（MCP 入参**字符串长度**审计）：按**码点**计数的字符串上限。
 *
 * 为什么不用 `z.string().max(N)`：zod 的 `.max()` 数的是 **UTF-16 码元**
 * （`String.prototype.length`），而后端所有 `@MaxLength(N)` 都走
 * class-validator → validator.js `isLength`——它减掉代理对后按**码点**计数
 * （与 PG `varchar(N)` 口径一致）。对 emoji 等增补平面字符两者差一倍：
 * 128 个 emoji = 128 码点 = 256 码元，**后端接受**，`.max(255)` 会拒。
 * 上限一旦比后端更严，就是「拒掉后端接受的合法值」——与收窄枚举时
 * 「不越过 @IsEnum」是同一条红线（见上面 R107-A1 的说明）。
 *
 * 本轮每一处上限都**逐个**有出处（同时写在调用点旁），汇总：
 *  - `255` 任务名：task-name.constraint.ts:43 `TASK_NAME_MAX_LENGTH`
 *    （同文件 :52-54 / :77 明确「按码点计，与 PG varchar(255) 一致」），
 *    由 CreateTaskDto.name 的 `@IsTaskName()` 施加（create-task.dto.ts:66-69）；
 *    UpdateTaskDto = PartialType(CreateTaskDto)，PATCH 继承同一约束。
 *  - `500` 应用描述：application.dto.ts:27 `@MaxLength(500)`
 *    （UpdateApplicationDto :85 是 PartialType，继承同一上限）。
 *  - `256` webhookSecret：application.dto.ts:102 `@MaxLength(256)`。
 *  - `2000` startCommand：app-deployment.dto.ts:84 `@MaxLength(2000)`。
 *  - `2000` 任务描述：**后端无约束**（create-task.dto.ts:70 只有
 *    `@IsString() @IsOptional()`，无 `@MaxLength`；DB 列也无长度，
 *    task.entity.ts:136）。**此处是客户端保护，不是与后端对齐**；取 2000 是
 *    因为本仓对「随行落库并进读面的大文本」已有同款 2KB 闸先例
 *    （PublishSopDto.changelog / DeploymentHeartbeatDto.message 的 @MaxLength(2000)）。
 *
 * 刻意**不**设上限的字段及原因见 R111 报告表「待定」段：后端只有**截断**
 * 而非拒绝（audit action/username 的 slice(0,100)），或只有**格式**约束而无
 * 长度契约（cronExpression / timezone）；给这些拍一个数字会与后端语义分叉。
 */
export function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** 任务名上限，逐字对齐 admin-api（task-name.constraint.ts:43）。 */
export const TASK_NAME_MAX_LENGTH = 255;

/** 有码点数上限的字符串；上限出处见上方汇总表（每个调用点也各带一行注释）。 */
function textWithin(max: number, message?: string) {
  return z.string().refine((v) => codePointLength(v) <= max, {
    message:
      message ??
      `String must contain at most ${max} characters (counted as code points)`,
  });
}

// ---------------------------------------------------------------------------
// R115：**字节**口径的上限（与 R111 的「码点」口径区分开）
//
// 后端有两处约束是按 **UTF-8 字节**算的，不是字符数：
//   · `DEPLOYMENT_ENV_MAX_KEYS=50` / `DEPLOYMENT_ENV_VALUE_MAX_BYTES=4096`
//     （app-deployment.dto.ts:24-25；键**和**值各算字节，见 :39-40）；
//   · `TASK_PARAMS_MAX_BYTES=65_536`（task/params-size.util.ts:15，
//     用 `Buffer.byteLength(JSON.stringify(params))` 算，见 :21-27）。
//
// 所以这里**不能**用 `z.string().max(...)` 或 `JSON.stringify(x).length`：
// 前者数码元、后者数 UTF-16 单元，中文/emoji 场景下都与字节数差一截 ——
// 用错口径要么放过后端必拒的载荷（agent 白跑一趟），要么拒掉后端接受的载荷。
// ---------------------------------------------------------------------------

/** 部署 env 的上限（逐字对齐 admin-api app-deployment.dto.ts:24-25）。 */
export const DEPLOYMENT_ENV_MAX_KEYS = 50;
export const DEPLOYMENT_ENV_VALUE_MAX_BYTES = 4096;

/** 任务 params 的序列化体积上限（逐字对齐 task/params-size.util.ts:15）。 */
export const TASK_PARAMS_MAX_BYTES = 65_536;

/** `str` 的 UTF-8 字节数（与后端 `Buffer.byteLength(s, "utf8")` 同口径）。 */
export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * params 序列化后的字节数；**不可序列化（循环引用等）返回 null** ——
 * 后端对此的处理是「按超限算」（params-size.util.ts:18-19），调用方也照此 fail-closed。
 */
export function jsonByteLength(value: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return null;
  }
}

/** 部署 env：≤50 键，且每个键/值 UTF-8 字节 ≤4096。 */
function deploymentEnvWithinLimits() {
  return z.record(z.string(), z.string()).refine(
    (env) => {
      const entries = Object.entries(env);
      if (entries.length > DEPLOYMENT_ENV_MAX_KEYS) return false;
      return entries.every(
        ([key, val]) =>
          utf8ByteLength(key) <= DEPLOYMENT_ENV_VALUE_MAX_BYTES &&
          utf8ByteLength(val) <= DEPLOYMENT_ENV_VALUE_MAX_BYTES,
      );
    },
    {
      message:
        `env must have at most ${DEPLOYMENT_ENV_MAX_KEYS} keys, and every key/value ` +
        `string must be at most ${DEPLOYMENT_ENV_VALUE_MAX_BYTES} UTF-8 bytes`,
    },
  );
}

/** 任务 params：序列化后 UTF-8 字节 ≤65536（不可序列化按超限处理）。 */
function taskParamsWithinLimits() {
  return z.record(z.string(), z.unknown()).refine(
    (params) => {
      const bytes = jsonByteLength(params);
      return bytes !== null && bytes <= TASK_PARAMS_MAX_BYTES;
    },
    {
      message:
        `params must serialize to at most ${TASK_PARAMS_MAX_BYTES} UTF-8 bytes ` +
        `(and must be JSON-serializable)`,
    },
  );
}
// ---------------------------------------------------------------------------
// Task templates (CORE-03: list_task_templates / create_task_from_template)
// ---------------------------------------------------------------------------
// The historical hardcoded TASK_TEMPLATES copy was removed: the admin-api
// seeds the SAME five official keys (scheduled_backup / health_check /
// data_sync / log_cleanup / webhook_ping) with the same config values
// (apps/admin-api/src/modules/task-template/task-template.constants.ts pins
// that alignment). Templates are now resolved server-side via
// GET /task-templates and instantiated via POST /task-templates/:id/instantiate
// so custom templates are usable too and the two template sources cannot
// drift. The historical `template` input keys keep resolving (by `key`).

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
export function registerTaskTools(server: McpServer, call: ApiCall): void {
  // ---- list_tasks ----------------------------------------------------------
  server.tool(
    "list_tasks",
    "List tasks defined in AutoCodeFlow with optional status/name filtering. Returns the backend paginated envelope { list, items, total, page, pageSize, totalPages } (list and items carry the same rows); each row has id, name, status, trigger config (cron or fixed rate), and last trigger time.",
    {
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
      status: TASK_STATUS.optional().describe(
        "Filter by task status: active | paused | deleted (deleted = soft-deleted rows)",
      ),
      name: z
        .string()
        .optional()
        .describe(
          "Filter by task name (fuzzy match, backend ListTasksQueryDto field)",
        ),
    }, { readOnlyHint: true, idempotentHint: true },
    async ({ page, pageSize, status, name }) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ...(status ? { status } : {}),
        ...(name ? { name } : {}),
      });
      const data = await call<unknown>("GET", `/tasks?${params}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- get_task ------------------------------------------------------------
  server.tool(
    "get_task",
    "Get full details of a specific task by its ID, including script source, cron, timeout, and dependencies.",
    {
      taskId: UUID_PATH_ID.describe("Task ID"),
    }, { readOnlyHint: true, idempotentHint: true },
    async ({ taskId }) => {
      const data = await call<unknown>("GET", `/tasks/${taskId}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- trigger_task --------------------------------------------------------
  server.tool(
    "trigger_task",
    "Manually trigger a task to run immediately. Returns the execution ID that can be polled with get_execution.",
    {
      taskId: UUID_PATH_ID.describe("Task ID to trigger"),
      // R115：后端 `@TaskParamsMaxBytes()` = 65536 字节（task/params-size.util.ts:15）——
      // 超限的 params 会被后端 400，agent 白跑一趟网络。
      params: taskParamsWithinLimits()
        .optional()
        .describe(
          "Optional runtime parameters to pass to the task. Merged as a WHOLE override, not per-key: an empty object ({}) is treated as 'no override' (= use the task's configured default params), never as 'run with zero params'",
        ),
      // NOTE: no executorId parameter here — TriggerTaskDto only accepts
      // `params`, and the backend's global ValidationPipe runs with
      // forbidNonWhitelisted, so a per-trigger pin would be rejected with 400.
      // Executor pinning IS supported by the backend, but as a task-level
      // field (tasks.executorId, set via create/update — see the update_task
      // tool), not a per-run override.
    }, { destructiveHint: false },
    async ({ taskId, params }) => {
      // R107-A1: 空对象 ≠ 覆盖。后端是
      // `const effectiveParams = dto.params ?? task.params`
      // （apps/admin-api/src/modules/task/task.service.ts:2730）——`{}` 不是
      // nullish，所以 `params: {}` 会把任务的默认参数**整组清空**。agent 说
      // 「不加参数直接跑一次」时最容易发 `{}`，而响应仍是成功，于是它就在
      // 「参数被清空」的假数据上继续动作（真实执行的输入与它以为的不一致）。
      // 契约：空对象按「无覆盖」处理（省略 body 才等价于任务默认参数）。
      const hasParams = params !== undefined && Object.keys(params).length > 0;
      const data = await call<unknown>(
        "POST",
        `/tasks/${taskId}/trigger`,
        hasParams ? { params } : {},
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- update_task ---------------------------------------------------------
  server.tool(
    "update_task",
    'Update an existing task via PATCH (only the fields you pass are changed; explicit null clears nullable fields). Supports executor pinning: set executorId to pin the task to one executor (fails fast if it is offline), or pass executorId: null to clear the pin. executorId is mutually exclusive with executeMode="broadcast" — the backend rejects that combination with 400. Also supports task-level secrets (per-key merge; leaf "******" keeps the stored value, null deletes the key), maintenance windows, priority (1-4), timeout policy (timeoutSeconds/timeoutAction/timeoutWarnRatio), dependency requirements, upstream task dependencies (map display-name → upstream task id), block/misfire strategies, executor affinity tags, deployment policy, and expectedUpdatedAt optimistic locking (409 on conflict).',
    {
      taskId: UUID_PATH_ID.describe("Task ID to update"),
      // R111-A1 上限出处：CreateTaskDto.name 的 @IsTaskName()
      // （apps/admin-api/src/modules/task/dto/create-task.dto.ts:66-69）→
      // TASK_NAME_MAX_LENGTH=255（同目录 task-name.constraint.ts:43，按**码点**计）。
      // UpdateTaskDto 是 PartialType(CreateTaskDto)，PATCH 继承同一 255。
      name: textWithin(TASK_NAME_MAX_LENGTH).optional().describe(
        "New task name (max 255 chars — the backend's IsTaskName limit)",
      ),
      // R111-A1：**后端无约束**（create-task.dto.ts:70 只有 @IsString/@IsOptional，
      // tasks.description 列也无长度，task.entity.ts:136）——2000 是本侧**客户端保护**，
      // 刻意不假称与后端对齐（口径取本仓既有 2KB 文本闸：PublishSopDto.changelog）。
      description: textWithin(2000).optional().describe(
        "New task description (max 2000 chars — client-side cap; the backend imposes none)",
      ),
      status: TASK_STATUS.optional().describe(
        "Task status: active | paused | deleted",
      ),
      triggerType: TASK_TRIGGER_TYPE.optional().describe(
        "Trigger type: cron | fixed_rate | api | manual",
      ),
      cronExpression: z
        .string()
        .optional()
        .describe("Cron expression (5 fields) for cron triggers"),
      timezone: z
        .string()
        .optional()
        .describe("IANA timezone for cron schedules, e.g. Asia/Shanghai"),
      fixedRate: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Fixed interval in seconds for fixed_rate triggers"),
      runtime: TASK_RUNTIME.optional().describe(
        "Runtime type: python | node | shell (backend enum — other values are rejected with 400)",
      ),
      entrypoint: z
        .string()
        .optional()
        .describe("Entry point file path relative to the repo root"),
      // MCP-DTO-ALIGN：timeout（遗留字段，create-task.dto.ts:184-192）此前
      // 整体缺失——@IsInt @Min(0) @Max(86400)，0 = 不限制；与 timeoutSeconds
      // 同值域（后端把 timeoutSeconds 归一化到 timeout）。
      timeout: z
        .number()
        .int()
        .min(0)
        .max(86400)
        .optional()
        .describe(
          "Execution timeout in seconds (legacy field — prefer timeoutSeconds; 0 = no limit; backend accepts 0-86400)",
        ),
      // MCP-DTO-ALIGN：timeoutSeconds 补上界 max(86400)（此前只写 min(0)，
      // 缺失的 .max 让 >86400 的值原样上送、被后端 @Max(86400) 400——与描述
      // 文案"backend accepts 0-86400"不符）。对齐 create-task.dto.ts:197-201。
      timeoutSeconds: z
        .number()
        .int()
        .min(0)
        .max(86400)
        .optional()
        .describe(
          "Execution timeout in seconds (0 = no limit; backend accepts 0-86400)",
        ),
      // CORE-04（create-task.dto.ts:209-216）：null/缺省 = kill；显式 null 重置。
      timeoutAction: TIMEOUT_ACTION
        .nullable()
        .optional()
        .describe(
          'Timeout action: kill (default — executor kills the process tree) | kill_retry (kill + re-enqueue once within retry budget) | notify_only (admin only notifies, executor-side hard timeout still applies). Omit = keep current value; explicit null = reset to kill.',
        ),
      // CORE-04（create-task.dto.ts:226-230）：百分数 0-90；null = 未启用。
      timeoutWarnRatio: z
        .number()
        .int()
        .min(0)
        .max(90)
        .nullable()
        .optional()
        .describe(
          "Timeout early-warning threshold: integer percent (0-90) of timeout. One WARNING notification fires when runtime reaches timeout×ratio/100 (at most once per execution). Omit = keep; explicit null = disable.",
        ),
      // CORE-05（create-task.dto.ts:246-254）：0/缺省 = 未知；null = 重置为未知。
      estimatedDurationSec: z
        .number()
        .int()
        .min(0)
        .max(604800)
        .nullable()
        .optional()
        .describe(
          "Estimated execution duration in seconds (0/omitted = unknown; 0-604800). Only feeds scheduler executor load scoring — never consumed by the execution path. Explicit null = reset to unknown.",
        ),
      maxRetry: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("Max retry attempts (0-10)"),
      // A4 乐观锁（update-task.dto.ts:22-29）：透传 + 409 语义写在 description。
      expectedUpdatedAt: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Optimistic lock: the task's updatedAt (ISO timestamp) you read before editing. When present, the backend rejects the update with 409 TASK_UPDATE_STALE if the stored row moved (someone else updated first); re-fetch via get_task and retry. Omitted/null = skip the check (last write wins).",
        ),
      executeMode: EXECUTE_MODE.optional().describe(
        "Dispatch mode: single | broadcast. broadcast fans out to all online executors and cannot be combined with executorId.",
      ),
      // A4（第三轮审计·中）/ N-14（create-task.dto.ts:260-279 语义）。
      blockStrategy: BLOCK_STRATEGY
        .nullable()
        .optional()
        .describe(
          'Re-trigger policy while a same-params run is active: serial (queue, default) | discard (skip this trigger) | cover_early (cancel the running execution and rerun). null = legacy rows default to serial.',
        ),
      misfireStrategy: MISFIRE_STRATEGY
        .nullable()
        .optional()
        .describe(
          "Misfire policy when the scheduler was down at fire time: ignore (skip, default) | fire_once (fire once on recovery).",
        ),
      // CORE-01：数字 1-4 或大写 label（@IsEnum 的经验接受面，见 TASK_PRIORITY 注释）。
      priority: TASK_PRIORITY.optional().describe(
        "Task priority: 1 (LOW) | 2 (NORMAL, default) | 3 (HIGH) | 4 (CRITICAL) — integers, or the uppercase labels LOW/NORMAL/HIGH/CRITICAL. Lowercase labels and numeric strings are rejected (backend @IsEnum).",
      ),
      executorId: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Pin the task to this executor ID (uuid). Pass null to remove an existing pin. Mutually exclusive with executeMode=broadcast.",
        ),
      executorGroup: z
        .string()
        .optional()
        .describe("Restrict auto-dispatch to executors in this group"),
      executorTags: z
        .array(z.string())
        .optional()
        .describe(
          "Restrict auto-dispatch to executors carrying all these tags",
        ),
      // R115：同 trigger_task —— 后端 65536 字节上限。
      params: taskParamsWithinLimits().optional().describe("Default runtime parameters"),
      applicationId: z
        .string()
        .optional()
        .describe("Associated application ID"),
      // ---------------------------------------------------------------------------
      // MCP-DTO-ALIGN（2026-10-25）：以下 9 个字段上轮登记缺失，值域逐字对齐
      // CreateTaskDto（PartialType 传播到 UpdateTaskDto）。null 语义照抄 DTO：
      // 可空列显式 null = 清除/重置，缺省 = 保留旧值（N28）。
      // ---------------------------------------------------------------------------
      // SEC-02（create-task.dto.ts:292-321）：逐键合并语义在后端，这里只校键名。
      secrets: taskSecretsMap()
        .nullable()
        .optional()
        .describe(
          'Task-level secrets (credential key/value pairs, separate from params; stored encrypted, read back masked as "******"). Per-key merge on PATCH: omit a key or keep its "******" value to preserve it, null a key to delete it, any other value overwrites; the whole field as explicit null clears all secrets. Dispatched both merged into params as AUTOFLOW_<KEY> (legacy channel) and as a standalone secrets payload injected under the original key names.',
        ),
      // FEAT-06（create-task.dto.ts:94-112）：≤10 条；null/[] = 清空窗口。
      maintenanceWindows: z
        .array(MAINTENANCE_WINDOW_ITEM)
        .max(10)
        .nullable()
        .optional()
        .describe(
          "Task-level maintenance windows: scheduled triggers falling inside a window are skipped (manual/API triggers unaffected). Each item {start, end, description?} uses 5-field cron; the window opens at the latest start-cron fire and closes at the latest end-cron fire (half-open). At most 10 items; explicit null or [] clears all windows.",
        ),
      // W-21（create-task.dto.ts:148-158）：≤50 条非空；服务层拒前导 '-'。
      requirements: z
        .array(z.string().min(1))
        .max(50)
        .nullable()
        .optional()
        .describe(
          'Dependency specs the executor installs before running (python: per-task uv venv; node: npm packages), e.g. ["requests>=2.31", "rich==13.7.1"]. Ignored for GLUE tasks. At most 50 non-empty strings; specs with a leading "-" are rejected. Explicit null = clear.',
        ),
      // FIX-1.1（create-task.dto.ts:159-178）：value 才是依赖任务 id。
      dependencies: z
        .record(z.string(), z.string())
        .nullable()
        .optional()
        .describe(
          "Upstream task dependencies: { display-name: upstream-task-id } — the VALUE is the dependency task id (consumed by cycle detection / dependency fan-out). Every value must be an existing task id; self-dependency and cycles are rejected. Explicit null = clear.",
        ),
      // NF-04（create-task.dto.ts:334-350）：OR 亲和；null/[] = 清除。
      executorAffinityTags: z
        .array(z.string())
        .nullable()
        .optional()
        .describe(
          "Executor tag affinity (OR semantics — executors holding ANY of these tags are candidates, then load-scored). Orthogonal to executorTags (hard AND capability requirement). Explicit null/[] clears.",
        ),
      // NF-04（create-task.dto.ts:351-366）：排除语义；null/[] = 清除。
      executorAntiAffinityTags: z
        .array(z.string())
        .nullable()
        .optional()
        .describe(
          "Executor tag anti-affinity (exclusion — executors holding ANY of these tags are excluded). Applies to single and broadcast dispatch; combined with affinity, anti-affinity subtracts from the affinity hit set. Explicit null/[] clears.",
        ),
      // FEAT-22（create-task.dto.ts:322-330）：strict/prefer；null = 跟随全局。
      deploymentPolicy: z
        .enum(["strict", "prefer"])
        .nullable()
        .optional()
        .describe(
          "Task-level dispatch deployment override: strict restricts candidates to executors explicitly deployed with the bound app (queues as WAITING when none can take it); prefer keeps the soft preference. null/omitted = follow the global executor.deploymentPolicy. Priority chain: executorId pin > executorAppName > deployment constraint > whole cluster.",
        ),
      // F1（本轮审计）：CreateTaskDto 有、而本 shape 缺的 7 个字段 —— PATCH 是
      // 本包唯一的任务写入口（连 create_task 都没有），缺一个就等于那件事
      // "调了、成功了、没发生"。逐个对齐 DTO 的约束：
      //   runtimeVersion: /^\d+\.\d+$/（仅 runtime=python 有意义）
      //   retryDelay: 整数 0..86400（更大值会把指数退避顶到 int32 毫秒溢出线）
      //   retryableErrors / alarmChannels: 字符串数组，**元素不得含逗号**
      //     （simple-array 列以逗号 join 落库，含逗号会在读回时被劈成两条）
      //   codeSource: git | glue | application_zip；显式 null = 清除声明
      //   runbook: markdown 运维手册（随失败通知一并附上）
      //   projectId: uuid 或 null（null = 未分配；设置它会改任务归属与可见范围）
      runtimeVersion: z
        .string()
        .regex(/^\d+\.\d+$/, 'must be "major.minor" (e.g. 3.12)')
        .optional()
        .describe(
          "Python interpreter version as major.minor (e.g. 3.12). Only meaningful when runtime=python.",
        ),
      retryDelay: z
        .number()
        .int()
        .min(0)
        .max(86_400)
        .optional()
        .describe("Delay before a retry, in seconds (0..86400)."),
      retryableErrors: z
        .array(z.string().regex(/^[^,]*$/, "must not contain a comma"))
        .optional()
        .describe(
          "Substrings that mark a failure as retryable. Elements must not contain commas (simple-array storage splits on commas).",
        ),
      alarmChannels: z
        .array(z.string().regex(/^[^,]*$/, "must not contain a comma"))
        .optional()
        .describe(
          "Alarm channels notified on failure. Elements must not contain commas.",
        ),
      codeSource: z
        .enum(["git", "glue", "application_zip"])
        .nullable()
        .optional()
        .describe(
          "Code source channel: git | glue | application_zip (application_zip also needs applicationId). Mutually exclusive with gitRepo/glueSource. Explicit null clears the declaration.",
        ),
      runbook: z
        .string()
        .optional()
        .describe(
          "Markdown runbook shown on the task page and attached to failure notifications.",
        ),
      projectId: z
        .string()
        .uuid()
        .nullable()
        .optional()
        .describe(
          "Owning project id (null = unassigned). Changing it changes the task's visibility and write authorisation scope.",
        ),
    }, { destructiveHint: true, idempotentHint: true },
    async ({ taskId, ...fields }) => {
      // Drop undefined fields so PATCH only touches what the caller supplied;
      // keep explicit nulls (e.g. executorId: null) so a pin can be cleared.
      const body = Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      );
      // 空 patch = 必然空转（后端对 `{}` 返回 200 并落一条 task.update 审计）。
      // 与其让 agent 以为改完了，不如明确失败并列出可写字段。
      if (Object.keys(body).length === 0) {
        return JSON_ERROR({
          error: "NO_UPDATABLE_FIELDS",
          message:
            "update_task received no updatable field, so nothing would change. " +
            "Pass at least one of: name, cronExpression, timezone, fixedRate, maintenanceWindows, " +
            "runtime, runtimeVersion, requirements, dependencies, timeout, timeoutSeconds, " +
            "timeoutAction, timeoutWarnRatio, maxRetry, retryDelay, estimatedDurationSec, " +
            "retryableErrors, priority, executeMode, blockStrategy, misfireStrategy, alarmChannels, " +
            "params, secrets, deploymentPolicy, executorTags, executorAffinityTags, " +
            "executorAntiAffinityTags, executorId, codeSource, runbook, projectId, status.",
        });
      }
      const data = await call<unknown>("PATCH", `/tasks/${taskId}`, body);
      return JSON_CONTENT(data);
    },
  );

  // ---- list_task_versions --------------------------------------------------
  server.tool(
    "list_task_versions",
    "List the historical configuration versions of a task (newest first). Use with rollback_task_version / compare_task_versions.",
    {
      taskId: UUID_PATH_ID.describe("Task ID"),
    }, { readOnlyHint: true },
    async ({ taskId }) => {
      const data = await call<unknown>("GET", `/tasks/${taskId}/versions`);
      return JSON_CONTENT(data);
    },
  );

  // ---- rollback_task_version ----------------------------------------------
  server.tool(
    "rollback_task_version",
    "Roll a task back to a specific historical version snapshot. Returns the updated task.",
    {
      taskId: UUID_PATH_ID.describe("Task ID"),
      versionId: UUID_PATH_ID.describe("Version ID to roll back to (from list_task_versions)"),
    }, { destructiveHint: true },
    async ({ taskId, versionId }) => {
      const data = await call<unknown>(
        "POST",
        `/tasks/${taskId}/versions/${versionId}/rollback`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- compare_task_versions ----------------------------------------------
  server.tool(
    "compare_task_versions",
    "Diff two task versions. Returns a map of changed fields with their old and new values.",
    {
      taskId: UUID_PATH_ID.describe("Task ID"),
      versionId1: UUID_PATH_ID.describe("First version ID"),
      versionId2: UUID_PATH_ID.describe("Second version ID"),
    }, { readOnlyHint: true },
    async ({ taskId, versionId1, versionId2 }) => {
      const data = await call<unknown>(
        "GET",
        `/tasks/${taskId}/versions/${versionId1}/compare/${versionId2}`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- list_executions ------------------------------------------------------
  // 分页参数与其余 list_* 工具统一口径（default 20 / max 100，对齐后端
  // PageQueryDto 契约）；此前 default 10 / max 50 是无出处的独头部形状。
  server.tool(
    "list_executions",
    "List recent task executions (newest first). Optionally filter by taskId and status.",
    {
      taskId: UUID_PATH_ID.optional().describe("Filter by task ID"),
      status: EXECUTION_STATUS.optional().describe(
        "Filter by status: pending | running | waiting | success | failed | timeout | killed | cancelled",
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
        .describe("Items per page, max 100 (default 20)"),
    }, { readOnlyHint: true, idempotentHint: true },
    async ({ taskId, status, page, pageSize }) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ...(taskId ? { taskId } : {}),
        ...(status ? { status } : {}),
      });
      const data = await call<unknown>(
        "GET",
        `/tasks/executions/all?${params}`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- get_execution --------------------------------------------------------
  // 大输出治理（对齐 admin-api PERF-03 的同一决策）：GET /tasks/executions/:id
  // 的 compat alias 原样回传实体行，其中 logs 是 text 列、单条上限 512_000
  // 字符——后端已把列表/详情/统计读面的日志全部迁到独立分页端点
  // GET .../logs（本包的 get_execution_logs 工具）。这里如实剥离并在响应里
  // 说明去向（而不是静默丢弃或把 512KB 塞进 agent 上下文）。
  server.tool(
    "get_execution",
    "Get the details of a specific execution by ID: status, duration, result, runtime params, error info, and AI analysis if available. The full log payload is stripped from this response (single rows can reach 512 KB) — page through logs with get_execution_logs.",
    {
      executionId: UUID_PATH_ID.describe("Execution ID"),
    }, { readOnlyHint: true },
    async ({ executionId }) => {
      const data = await call<Record<string, unknown>>(
        "GET",
        `/tasks/executions/${executionId}`,
      );
      // R112：**空载荷不是成功**。此前 `JSON_CONTENT(null)` 会让 agent 拿到一个「成功但内容为 null」
      // 的响应，它没有任何办法区分「执行不存在」与「执行存在但字段全空」——于是继续在假数据上动作。
      // （正常路径下后端 404 会抛错；这里兜的是 200 + 空体/空载荷的形态。）
      if (data === null || data === undefined) {
        return JSON_ERROR({
          error: "Execution not found (the API returned an empty payload)",
          errorCode: "EXECUTION_NOT_FOUND",
          executionId,
        });
      }
      if (data && typeof data === "object" && "logs" in data) {
        const { logs: _logs, ...rest } = data;
        return JSON_CONTENT({
          ...rest,
          logsStripped: true,
          note: "The full log payload was stripped from this response (it can reach 512 KB). Page through it with get_execution_logs (fromLine/limit).",
        });
      }
      return JSON_CONTENT(data);
    },
  );

  // ---- analyze_execution ----------------------------------------------------
  server.tool(
    "analyze_execution",
    "Trigger AI analysis on a failed execution. Returns the AI-generated root cause and fix suggestion.",
    {
      taskId: UUID_PATH_ID.describe("Task ID"),
      // 后端 analyzeExecution 不按 status 硬闸（任何执行都可分析），只是
      // failed/timeout 之外的分析没有输入也没有意义——按「预期用途」表述，
      // 不谎称前置校验。
      executionId: UUID_PATH_ID.describe(
        "Execution ID (intended for failed/timeout executions)",
      ),
    }, { destructiveHint: false },
    async ({ taskId, executionId }) => {
      const data = await call<unknown>(
        "POST",
        `/tasks/${taskId}/executions/${executionId}/analyze`,
        undefined,
        ANALYZE_TIMEOUT_MS,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- get_execution_stats --------------------------------------------------
  server.tool(
    "get_execution_stats",
    "Get execution statistics for a task: success rate, average duration, and last 20 executions.",
    {
      taskId: UUID_PATH_ID.describe("Task ID"),
    }, { readOnlyHint: true },
    async ({ taskId }) => {
      const data = await call<unknown>("GET", `/tasks/${taskId}/stats`);
      return JSON_CONTENT(data);
    },
  );

  // ---- suggest_schedule -----------------------------------------------------
  server.tool(
    "suggest_schedule",
    "Ask AI to suggest an optimal cron schedule for a task based on its execution history (success rate, avg duration, failure patterns).",
    {
      taskId: UUID_PATH_ID.describe("Task ID"),
    }, { destructiveHint: false },
    async ({ taskId }) => {
      const data = await call<unknown>(
        "POST",
        `/tasks/${taskId}/suggest-schedule`,
        undefined,
        ANALYZE_TIMEOUT_MS,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- get_execution_logs --------------------------------------------------
  // OBS-03: `level` filters at the SQL layer (strict uppercase enum, WARNING
  // is already normalized to WARN server-side at write time). With a level
  // set, fromLine becomes an offset into the FILTERED sequence and
  // totalLines/hasMore count only matching rows (unknown-level rows are
  // excluded); without it, behavior is unchanged (physical line cursor).
  server.tool(
    "get_execution_logs",
    "Fetch paginated execution logs for a given execution ID. Use fromLine + limit to page through large outputs, and the optional level filter (ERROR/WARN/INFO/DEBUG) to cut the noise.",
    {
      executionId: UUID_PATH_ID.describe("Execution ID"),
      fromLine: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Start line (0-based, default 0)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .default(500)
        .describe("Lines to return (max 2000, default 500)"),
      level: z
        .enum(["ERROR", "WARN", "INFO", "DEBUG"])
        .optional()
        .describe(
          "Filter by inferred log level (exact uppercase enum). When set, fromLine becomes an offset into the filtered sequence and totalLines/hasMore count only matching rows; rows with no inferable level are excluded. Omit to keep the legacy physical-line paging behavior",
        ),
    }, { readOnlyHint: true },
    async ({ executionId, fromLine, limit, level }) => {
      const params = new URLSearchParams({
        fromLine: String(fromLine),
        limit: String(limit),
        ...(level ? { level } : {}),
      });
      const data = await call<unknown>(
        "GET",
        `/tasks/executions/${executionId}/logs?${params}`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- kill_execution ------------------------------------------------------
  server.tool(
    "kill_execution",
    "Force-cancel a running or pending execution by ID. Requires task ID because the underlying route is task-scoped.",
    {
      taskId: UUID_PATH_ID.describe("Task ID that owns the execution"),
      executionId: UUID_PATH_ID.describe("Execution ID to cancel"),
    }, { destructiveHint: true },
    async ({ taskId, executionId }) => {
      const data = await call<unknown>(
        "POST",
        `/tasks/${taskId}/executions/${executionId}/kill`,
      );
      return JSON_CONTENT(data);
    },
  );

  // ---- retry_execution ------------------------------------------------------
  // NF-06: the admin API has NO native retry endpoint (grep task.controller/
  // task.service/docs — only BullMQ-side auto retry exists). Re-running a past
  // execution therefore goes through the ordinary manual-trigger path, which
  // creates a NEW execution row; the original row's params are replayed here
  // (fetched via the by-execId compat alias) so the rerun matches what the
  // failed run actually received, not today's task defaults.
  server.tool(
    "retry_execution",
    "Re-run a past execution: creates a NEW execution of the same task via the manual-trigger path (the admin API has no native retry endpoint — this is a fresh run, not a continuation of the original attempt counter). The original execution's runtime params are replayed automatically; pass params to override them. Returns the new execution (id) — poll it with get_execution.",
    {
      taskId: UUID_PATH_ID.describe("Task ID that owns the execution"),
      executionId: UUID_PATH_ID.describe("Execution ID to re-run (from list_executions / get_execution)"),
      // R115：同 trigger_task —— 后端 65536 字节上限。
      params: taskParamsWithinLimits()
        .optional()
        .describe(
          "Override the replayed runtime parameters (when absent — or when an empty object — the original execution's params are reused; if it had none, the task's current defaults apply)",
        ),
    }, { destructiveHint: false },
    async ({ taskId, executionId, params }) => {
      let body: Record<string, unknown> = {};
      // R107-A1: 与 trigger_task 同一口径——`params: {}` 是「不加覆盖」，
      // 不是「用空参数重跑」。后者会同时丢掉原执行的参数**和**任务默认参数
      // （后端 task.service.ts:2730），而响应仍是成功。
      // 注意：原执行行上真实存在的 `params: {}` 仍被逐字回放（faithful
      // replay）——它记录的正是「当时确实以空参数运行」，语义不同。
      const hasParams = params !== undefined && Object.keys(params).length > 0;
      if (hasParams) {
        body = { params };
      } else {
        const prev = await call<{ params?: Record<string, unknown> | null }>(
          "GET",
          `/tasks/executions/${executionId}`,
        );
        if (prev?.params) body = { params: prev.params };
      }
      const data = await call<Record<string, unknown>>(
        "POST",
        `/tasks/${taskId}/trigger`,
        body,
      );
      return JSON_CONTENT({ retriedFrom: executionId, ...data });
    },
  );

  // ---- pause_task -----------------------------------------------------------
  server.tool(
    "pause_task",
    "Pause a task — stops scheduled triggers. In-progress executions are not affected.",
    {
      taskId: UUID_PATH_ID.describe("Task ID to pause"),
    }, { destructiveHint: true, idempotentHint: true },
    async ({ taskId }) => {
      const data = await call<unknown>("POST", `/tasks/${taskId}/pause`);
      return JSON_CONTENT(data);
    },
  );

  // ---- resume_task ----------------------------------------------------------
  server.tool(
    "resume_task",
    "Resume a previously paused task.",
    {
      taskId: UUID_PATH_ID.describe("Task ID to resume"),
    }, { destructiveHint: false, idempotentHint: true },
    async ({ taskId }) => {
      const data = await call<unknown>("POST", `/tasks/${taskId}/resume`);
      return JSON_CONTENT(data);
    },
  );

  // ---- export_task / import_task (E-1) ---------------------------------------
  // Cross-environment task-definition transfer. The export payload IS the
  // import body (two endpoints are symmetric per docs/api-reference.md), so
  // export_task returns the payload VERBATIM — wrapping it in extra keys
  // (note/links/…) would break the round-trip because POST /tasks/import
  // runs with forbidNonWhitelisted (unknown keys → 400). The "save the file
  // yourself" hint lives in the description: MCP tool outputs are agent
  // context, not a file-write surface.
  server.tool(
    "export_task",
    "Export a task definition as a portable JSON payload ({ schemaVersion: \"1\", exportedAt, task }) for cross-environment transfer. Secrets are NEVER part of the export (SEC-02 red line). The returned JSON text is the verbatim POST /tasks/import body: save it to a file yourself (MCP tool output is not written to disk), or pass it straight back to import_task.",
    {
      taskId: UUID_PATH_ID.describe("Task ID to export"),
    }, { readOnlyHint: true },
    async ({ taskId }) => {
      const data = await call<unknown>("GET", `/tasks/${taskId}/export`);
      return JSON_CONTENT(data);
    },
  );

  server.tool(
    "import_task",
    "Create a task from an export_task payload (POST /tasks/import). Name conflicts are never overwritten — an ' (imported)' suffix (then 2, 3, …) is appended; the new task starts paused and without secrets, so review the response's warnings before running it. Accepts the export JSON text verbatim or the equivalent object.",
    {
      payload: z
        .union([z.string(), z.record(z.string(), z.unknown())])
        .describe(
          'Export payload produced by export_task: pass the JSON text verbatim, or the equivalent object with "schemaVersion" and "task" keys',
        ),
    }, { destructiveHint: false },
    async ({ payload }) => {
      let body: unknown;
      if (typeof payload === "string") {
        try {
          body = JSON.parse(payload);
        } catch (err) {
          return JSON_ERROR({
            error: `payload is not valid JSON (${
              err instanceof Error ? err.message : String(err)
            }) — pass the export_task output verbatim`,
          });
        }
      } else {
        body = payload;
      }
      // Light pre-flight guard: the backend would 400 anyway, but catching
      // the common "passed only the task object" mistake locally avoids a
      // network round trip and points straight at the fix.
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        !("task" in body) ||
        !("schemaVersion" in body)
      ) {
        return JSON_ERROR({
          error:
            'Invalid export payload: expected an object with "schemaVersion" and "task" keys — pass the verbatim export_task output (JSON text or object)',
        });
      }
      const data = await call<unknown>("POST", "/tasks/import", body);
      return JSON_CONTENT(data);
    },
  );

  // ---- list_task_templates (CORE-03) -----------------------------------------
  server.tool(
    "list_task_templates",
    "List task templates available for create_task_from_template (GET /task-templates): official presets (scheduled_backup, health_check, data_sync, log_cleanup, webhook_ping) come first, custom templates follow. Each row has id (uuid), key (stable identifier), name, description, category, config (CreateTaskDto defaults without name) and isOfficial.",
    {}, { readOnlyHint: true },
    async () => {
      const data = await call<unknown>("GET", "/task-templates");
      return JSON_CONTENT(data);
    },
  );

  // ---- create_task_from_template (CORE-03) -----------------------------------
  // Reworked from expanding a hardcoded local TASK_TEMPLATES copy onto
  // POST /tasks to the server-side template endpoints: the template is
  // resolved via GET /task-templates (by `key` — the historical input — or
  // by uuid) and created via POST /task-templates/:id/instantiate, so
  // server-defined templates (official + custom) are authoritative and the
  // local copy can no longer drift. Precedence kept from the old tool:
  // name > overrides > explicit description > template description.
  server.tool(
    "create_task_from_template",
    "Create a runnable task from a task template (server-side POST /task-templates/:id/instantiate — the template config expands as defaults, the overrides win per field; name is always required). Create-side required set (differs from update_task's all-optional PATCH): name, plus triggerType which must come from the template config or the overrides — the backend validates the merged payload against CreateTaskDto and rejects with 400 otherwise; every other field is optional with backend defaults, and update-only fields (expectedUpdatedAt) are not part of the create face. Pass template as its key (official presets: scheduled_backup | health_check | data_sync | log_cleanup | webhook_ping) or its uuid — browse all templates including custom ones with list_task_templates. Returns the created task — trigger it with trigger_task.",
    {
      template: z
        .string()
        .describe(
          "Template key or uuid (resolve with list_task_templates; official keys: scheduled_backup | health_check | data_sync | log_cleanup | webhook_ping)",
        ),
      // R111-A1 上限出处：与 update_task.name 同一字段、同一 DTO 约束
      // （CreateTaskDto.name 的 @IsTaskName() → task-name.constraint.ts:43，255 码点）。
      name: textWithin(TASK_NAME_MAX_LENGTH).describe(
        "Unique task name for the new task (max 255 chars — the backend's IsTaskName limit)",
      ),
      // R111-A1：**后端无约束**（create-task.dto.ts:70），2000 为客户端保护，同 update_task。
      description: textWithin(2000)
        .optional()
        .describe(
          "Task description (max 2000 chars — client-side cap; the backend imposes none; defaults to the template's description)",
        ),
      // R115：overrides 会并进 CreateTaskDto 的 params 一路落库 —— 同 65536 字节口径。
      overrides: taskParamsWithinLimits()
        .optional()
        .describe(
          "Field overrides applied on top of the template config (any CreateTaskDto field, e.g. cronExpression, fixedRate, timeoutSeconds, params, executorGroup, secrets, maintenanceWindows, priority, timeoutAction/timeoutWarnRatio, estimatedDurationSec, requirements, dependencies, blockStrategy, misfireStrategy, executorAffinityTags/executorAntiAffinityTags, deploymentPolicy, executorId, projectId, runbook. NOTE: template instantiate merges then validates the WHOLE payload against CreateTaskDto — triggerType must be set by the template config or the overrides or the backend rejects with 400; expectedUpdatedAt is update-only and never accepted here)",
        ),
    }, { destructiveHint: false },
    async ({ template, name, description, overrides }) => {
      const rows = await call<
        Array<{ id?: string; key?: string; description?: string | null }>
      >("GET", "/task-templates");
      const list = Array.isArray(rows) ? rows : [];
      const tpl = list.find((r) => r?.key === template || r?.id === template);
      if (!tpl?.id) {
        return JSON_ERROR({
          error: `Unknown template "${template}" — list the available template keys/uuids with list_task_templates`,
          available: list.map((r) => r?.key).filter(Boolean),
        });
      }
      const body = {
        ...(tpl.description ? { description: tpl.description } : {}),
        ...(description ? { description } : {}),
        ...(overrides ?? {}),
        name,
      };
      const data = await call<unknown>(
        "POST",
        `/task-templates/${tpl.id}/instantiate`,
        body,
      );
      return JSON_CONTENT(data);
    },
  );
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
    "Register a new application. Required fields: name (unique, max 100 chars), version (e.g. 1.0.0), runtime (e.g. node/python).",
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
    "Update an existing application. NOTE: the backend UpdateApplicationDto has no `name` field — renaming is not supported.",
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
    "Delete an application by ID.",
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
    "Run AI health analysis on an application. Aggregates recent execution stats across all tasks and returns LLM-generated health assessment and recommendations.",
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
    "Create an application mutex group. Creating a group does not change the behaviour of any existing application — apps join a group only when their mutexGroupId is set (via update_application).",
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
    "Update a mutex group (name / maxConcurrentPerDevice / scope / description). Takes effect on the next dispatch. Tightening scope to global or lowering maxConcurrentPerDevice immediately restricts production concurrency; waiting executions are re-dispatched automatically.",
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
    "Delete a mutex group. Attached applications silently lose the mutual-exclusion constraint (the FK nulls their mutexGroupId) — mutually exclusive workloads can then run concurrently and collide. The backend refuses with 409 while apps are still attached unless force=true. In-flight executions keep the group snapshot they started with.",
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
    "Trigger an overlay upgrade for a running deployment so it pulls the latest application version.",
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
    "Stop a running application deployment.",
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
    "Approve a pending deployment (DEP-04). Approving dispatches it to the executor. Second-person rule: the approver must differ from the requester, otherwise the API returns an error. ADMIN only.",
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
    "Reject a pending deployment (DEP-04). The deployment is never dispatched. Second-person rule applies; ADMIN only.",
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
    "Cancel own pending deployment request (DEP-04). Requester-only exit: the user who triggered the deployment may withdraw it before anyone approves.",
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
// Executors
// ---------------------------------------------------------------------------
export function registerExecutorTools(server: McpServer, call: ApiCall): void {
  // ---- list_executors -------------------------------------------------------
  server.tool(
    "list_executors",
    "List all registered executors and their status (online/offline, last heartbeat, current load).",
    {}, { readOnlyHint: true, idempotentHint: true },
    async () => {
      const data = await call<unknown>("GET", "/executors");
      return JSON_CONTENT(data);
    },
  );

  // ---- get_executor ---------------------------------------------------------
  server.tool(
    "get_executor",
    // U12: the old description promised "performance metrics" but this only
    // hits GET /executors/:id (entity fields: config, status, resource
    // usage, heartbeat-reported running executions). Metrics live on
    // GET /executors/:id/metrics — exposed as get_executor_metrics below.
    "Get detailed info for a single executor by ID: config, status, group/tags, CPU & memory usage, task counters, and the execution ids it reported running on its last heartbeat. Does NOT include 7-day statistics — use get_executor_metrics for those.",
    {
      executorId: UUID_PATH_ID.describe("Executor ID"),
    }, { readOnlyHint: true },
    async ({ executorId }) => {
      const data = await call<unknown>("GET", `/executors/${executorId}`);
      return JSON_CONTENT(data);
    },
  );

  // ---- get_executor_metrics -------------------------------------------------
  server.tool(
    "get_executor_metrics",
    // FEAT-04: 响应还带 history——最近 24h 的 executor_metrics_history 采样,
    // 聚合为 15 分钟 AVG 桶（≤96 个点,升序;每点 {timestamp, cpuUsage,
    // memUsage, runningTaskCount},无上报值的桶 cpu/mem 为 null）。
    "Get performance metrics for a single executor: { executor, sevenDayStats (totalExecutions/successful/failed/successRate/averageDurationMs over the last 7 days), current (runningTaskCount/cpuUsage/memUsage), history (last 24h of resource samples in 15-minute average buckets, <=96 ascending points; empty when no samples) }. Backed by GET /executors/:id/metrics.",
    {
      executorId: UUID_PATH_ID.describe("Executor ID"),
    }, { readOnlyHint: true },
    async ({ executorId }) => {
      const data = await call<unknown>(
        "GET",
        `/executors/${executorId}/metrics`,
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
// Audit
// ---------------------------------------------------------------------------
export function registerAuditTools(server: McpServer, call: ApiCall): void {
  // ---- list_audit_logs ------------------------------------------------------
  server.tool(
    "list_audit_logs",
    "Query the audit log with pagination and optional filters. Returns { data, total }. Filters use the backend AuditQueryDto whitelist — any other query field is rejected with 400.",
    {
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
        .describe("Items per page, max 100 (default 20)"),
      action: z
        .string()
        .optional()
        .describe("Filter by action, fuzzy match (e.g. task.trigger)"),
      resource: z
        .string()
        .optional()
        .describe("Filter by exact resource type (e.g. task)"),
      userId: z
        .number()
        .int()
        .optional()
        .describe("Filter by operator user id"),
      username: z
        .string()
        .optional()
        .describe("Filter by operator username (fuzzy match)"),
      startTime: z
        .string()
        .optional()
        .describe("Only entries created at/after this ISO 8601 time"),
      endTime: z
        .string()
        .optional()
        .describe("Only entries created at/before this ISO 8601 time"),
    }, { readOnlyHint: true, idempotentHint: true },
    async ({
      page,
      pageSize,
      action,
      resource,
      userId,
      username,
      startTime,
      endTime,
    }) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        ...(action ? { action } : {}),
        ...(resource ? { resource } : {}),
        ...(userId !== undefined ? { userId: String(userId) } : {}),
        ...(username ? { username } : {}),
        ...(startTime ? { startTime } : {}),
        ...(endTime ? { endTime } : {}),
      });
      const data = await call<unknown>("GET", `/audit?${params}`);
      return JSON_CONTENT(data);
    },
  );
}

// ---------------------------------------------------------------------------
// Projects (AUTH-02-B read-side): list/members/my-roles
// ---------------------------------------------------------------------------

/**
 * AUTH-02-B（R18）：项目域只读工具组。GET /projects 为按主体过滤的读面
 * （ADMIN 全量；普通用户「默认项目 ∪ 成员项目」，每行带 myRole）；成员
 * 读面要求成员身份；成员写面为 ADMIN-only 且不在自动化工具面暴露——
 * 避免自动化链路误改授权（需要时走管理台/REST 显式操作）。
 */
export function registerProjectTools(server: McpServer, call: ApiCall): void {
  // ---- list_projects --------------------------------------------------------
  server.tool(
    "list_projects",
    "List projects visible to the current credential. Admins see all projects; other credentials see the default project plus projects they are a member of. Each row carries myRole (viewer/editor/admin or null) for capability checks before writes.",
    {}, { readOnlyHint: true, idempotentHint: true },
    async () => {
      const data = await call<unknown>("GET", "/projects");
      return JSON_CONTENT(data);
    },
  );

  // ---- get_project_members --------------------------------------------------
  server.tool(
    "get_project_members",
    "List members (userId + role) of one project. Admins can read any project; other credentials only projects they belong to (the default project is always readable).",
    {
      projectId: UUID_PATH_ID.describe("Project ID (UUID); use list_projects to resolve"),
    }, { readOnlyHint: true },
    async ({ projectId }) => {
      const data = await call<unknown>("GET", `/projects/${projectId}/members`);
      return JSON_CONTENT(data);
    },
  );

  // ---- get_my_project_roles -------------------------------------------------
  server.tool(
    "get_my_project_roles",
    "Return the caller's project memberships: { userId, isAdmin, memberships: [{ projectId, role }] }. Use it to plan capability-aware automation (e.g. skip writes on projects where myRole is viewer).",
    {}, { readOnlyHint: true },
    async () => {
      const data = await call<unknown>("GET", "/projects/me/roles");
      return JSON_CONTENT(data);
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

