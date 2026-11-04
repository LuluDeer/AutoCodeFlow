/**
 * MCP 工具的**共享构件**（R6「工具清单化」第 1 批，2026-11-04）。
 *
 * 为什么必须单独成文件：`tools.ts` 已从「唯一的实现文件」变成「聚合出口 + 尚未搬走的
 * 工具组」，而每个 `tools/*.ts` 工具组都要用这里的入站 schema 构件、错误面/脱敏/长度闸。
 * 这些若留在 `tools.ts` 里让各组反向 import，就成 `tools.ts → tools/audit.ts → tools.ts`
 * 的环。⇒ 共享件下沉到本文件，`tools.ts` 与各组都**只单向依赖**本文件。
 *
 * 内容**逐字节**搬自原 `tools.ts` 行 1-498（工具注册调用一个字符都没动，
 * 本文件本来也不含工具注册）；只有两处机械改动：
 *   ① `import ... from "./redact.js"` → `"../redact.js"`（多了一层目录）；
 *   ② 顶层声明补 `export`（原来是模块私有，现在要给 `tools.ts` 与各工具组用）。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// R110：出参凭据剥除（防御纵深）。
import { redactSensitive } from "../redact.js";
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
export const JSON_CONTENT = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(redactSensitive(data), null, 2) }],
});

/**
 * 错误面统一口径：HTTP 失败由 apiRequest 抛错、MCP SDK 转成
 * isError:true + error.message；而「参数可解析但语义无效」的用法错误
 * （未知模板/未知应用名/缺二选一 id）发生在 handler 内部——也必须带
 * isError:true，否则 MCP 客户端会把失败当成功。结构化 JSON 负载保留
 * （如 available 列表），让 agent 同时拿到失败信号与下一步可用的取值。
 */
export const JSON_ERROR = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(redactSensitive(data), null, 2) }],
  isError: true as const,
});

/**
 * F3（本轮审计）：出参脱敏的哨兵 **回传即污染**。
 *
 * 读路径把敏感值写成 `[redacted]`（见 redact.ts），而 agent 的典型工作流是
 * 「`get_task` 读到参数 → 改一个字段 → `update_task` 把参数原样带回」。后端对
 * `params` **没有任何掩码语义**（只有 `secrets` 的叶子 `******` 表示"保留"），
 * 于是 `params.API_KEY = "[redacted]"` 会被当成真实值写进 `tasks.params`，
 * 下次执行拿字面量 `[redacted]` 去认证 —— 失败原因与真实配置毫无关系。
 * 对 `secrets` 更糟：`[redacted]` 不是保留哨兵（那是 `******`），会**覆盖**掉
 * 真实密钥。
 *
 * 因此写面统一拒绝这个哨兵：宁可明确失败并告诉调用方「重新读一遍、或别传这个
 * 字段」，也不接受一个确定会破坏配置的写入。
 */
export const REDACTION_SENTINEL = '[redacted]';

/** 在任意嵌套结构里找 `[redacted]`，返回首个命中路径（无命中 → null）。 */
export function findRedactionSentinel(
  value: unknown,
  path = '$',
  depth = 0,
): string | null {
  if (depth > 12) return null;
  if (typeof value === 'string') {
    return value.includes(REDACTION_SENTINEL) ? path : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findRedactionSentinel(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const hit = findRedactionSentinel(v, `${path}.${k}`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  return null;
}

/**
 * 写面统一守卫：载荷里出现脱敏哨兵 → 明确失败（见 `findRedactionSentinel`）。
 * `secrets` 是唯一例外：其叶子 `******` 是后端「保留原值」的合法约定，
 * 但 `[redacted]` 依然是污染（会覆盖真实密钥）。
 */
export function rejectRedactionSentinel(
  body: Record<string, unknown>,
  toolName: string,
): { content: Array<{ type: "text"; text: string }>; isError: true } | null {
  const hit = findRedactionSentinel(body);
  if (!hit) return null;
  return JSON_ERROR({
    error: "REDACTION_SENTINEL_IN_PAYLOAD",
    field: hit,
    message:
      `${toolName} refused the write: ${hit} still contains the redaction sentinel ` +
      `"${REDACTION_SENTINEL}" from a previous read. Writing it back would store the ` +
      "sentinel as if it were the real value (for secrets it would overwrite the stored " +
      "credential). Re-read the resource, change only the fields you mean to change, and " +
      "omit the masked ones — or pass null to clear them.",
  });
}

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
export const UUID_PATH_ID = z.string().uuid();

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
export const TASK_STATUS = z.enum(["active", "paused", "deleted"]);
export const EXECUTION_STATUS = z.enum([
  "pending",
  "running",
  "waiting",
  "success",
  "failed",
  "timeout",
  "killed",
  "cancelled",
]);
export const TASK_TRIGGER_TYPE = z.enum(["cron", "fixed_rate", "api", "manual"]);
export const TASK_RUNTIME = z.enum(["python", "node", "shell"]);
export const EXECUTE_MODE = z.enum(["single", "broadcast"]);
export const AGENT_SESSION_KIND = z.enum([
  "ops_watch",
  "incident",
  "sop_authoring",
  "sop_review",
  "app_scaffold",
  "chat",
]);
export const AGENT_SESSION_STATUS = z.enum([
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
export const BLOCK_STRATEGY = z.enum(["serial", "discard", "cover_early"]);
/** MisfireStrategy（task.entity.ts:80；DTO @IsEnum，create-task.dto.ts:277）。 */
export const MISFIRE_STRATEGY = z.enum(["ignore", "fire_once"]);
/** TimeoutAction（timeout-policy.util.ts TIMEOUT_ACTIONS；DTO 用 @IsIn）。 */
export const TIMEOUT_ACTION = z.enum(["kill", "kill_retry", "notify_only"]);

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
export const TASK_PRIORITY = z.union([
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
export const MAINTENANCE_WINDOW_ITEM = z
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
export const RESERVED_SECRET_NAMES = new Set(
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
export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const taskSecretsMap = () =>
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
export function textWithin(max: number, message?: string) {
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
export function deploymentEnvWithinLimits() {
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
export function taskParamsWithinLimits() {
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
