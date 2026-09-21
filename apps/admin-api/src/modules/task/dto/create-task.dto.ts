import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsInt,
  IsEmail,
  IsObject,
  Min,
  Max,
  IsArray,
  ArrayMaxSize,
  IsUUID,
  Matches,
  ValidateNested,
  Validate,
  IsIn,
} from "class-validator";
import { Type } from "class-transformer";
import { IsUuidShape } from "../../../common/decorators/is-uuid-shape.decorator";
// SEC-02 续：secrets 键名的可注入性校验（给用户可读的 400，而非执行期静默丢弃）
import { IsSecretKeyMapConstraint } from "./secret-key-map.constraint";
import { MaintenanceWindowDto } from "./maintenance-window.dto";
import {
  TaskStatus,
  TaskTriggerType,
  TaskRuntime,
  BlockStrategy,
  MisfireStrategy,
  TaskPriority,
  ExecuteMode,
  TaskCodeSource,
} from "../entities/task.entity";
import { TIMEOUT_ACTIONS, TimeoutAction } from "../timeout-policy.util";
import { RUNTIME_VERSION_PATTERN } from "../runtime-version.util";

export class CreateTaskDto {
  // R6: id 是 UUID 主键——客户端自带任意字符串会在插入时触发 PG 22P02/23505
  // 类 500，校验必须在 DTO 边界完成（非法 id → 400）。
  @ApiPropertyOptional() @IsUUID("4") @IsOptional() id?: string;
  @ApiProperty() @IsString() @IsNotEmpty() name: string;
  @ApiPropertyOptional() @IsString() @IsOptional() description?: string;
  @ApiPropertyOptional() @IsEnum(TaskStatus) @IsOptional() status?: TaskStatus;
  @ApiProperty() @IsEnum(TaskTriggerType) triggerType: TaskTriggerType;
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @Matches(
    /^(\*|([0-5]?\d))(\/(\d+))? (\*|([01]?\d|2[0-3]))(\/(\d+))? (\*|([012]?\d|3[01]))(\/(\d+))? (\*|(1[0-2]|0?[1-9]))(\/(\d+))? (\*|[0-7])(\/(\d+))?$/,
    {
      message:
        "cronExpression must be a valid cron expression (5 fields: min hour day month weekday)",
    },
  )
  cronExpression?: string;
  @ApiPropertyOptional({
    description: "IANA timezone for cron schedules, e.g. Asia/Shanghai",
  })
  @IsString()
  @IsOptional()
  timezone?: string;
  @ApiPropertyOptional() @IsInt() @Min(1) @IsOptional() fixedRate?: number;
  /**
   * FEAT-06: 任务级维护窗口。每条 { start, end, description? }，start/end
   * 均为 5 字段 cron——start 最近触达开窗、end 最近触达关窗（半开区间，
   * 语义见 maintenance-window.util.ts）。结构校验（≤10 条、cron 表达式
   * 结构合法）在 DTO 边界完成；窗口命中时的调度跳过在 scheduler.enqueue。
   * PATCH 语义（N28）：字段缺省 = 保留旧值；显式 null / [] = 清空。
   */
  @ApiPropertyOptional({
    description:
      "Task-level maintenance windows: scheduled triggers falling inside a window are skipped (manual/API triggers unaffected). Each entry {start, end, description?} with 5-field crons; the window opens at the latest start-cron touch and closes at the latest end-cron touch. Max 10 entries.",
    type: [MaintenanceWindowDto],
    maxItems: 10,
  })
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => MaintenanceWindowDto)
  @IsOptional()
  maintenanceWindows?: MaintenanceWindowDto[] | null;
  @ApiPropertyOptional()
  @IsEnum(TaskRuntime)
  @IsOptional()
  runtime?: TaskRuntime;
  /**
   * python_task_multiversion（FR-06 / AC-06b）：任务声明的 Python 解释器
   * **主.次版本**（如 `3.7` / `3.12`，无补丁号，D1）。
   *
   * 边界分工：DTO 只做**格式**校验（`^\d+\.\d+$`，与
   * task/runtime-version.util 的 RUNTIME_VERSION_PATTERN 同源）；**区间**
   * 校验与"非 python runtime 不得声明版本"在 task.service 写面完成——因为
   * PATCH 的 runtime 可能来自旧行（增量 DTO 看不到合并终态）。
   *
   * 刻意**不预检**执行器是否已缓存该版本（AC-06c）：解释器"先下载后有"，
   * 首跑获取失败在运行时体现（分因 interpreter_unavailable）。
   */
  @ApiPropertyOptional({
    description:
      'Python interpreter version the task requires, as "major.minor" (e.g. "3.7", "3.12"). Supported range defaults to 3.7–3.14; 3.7 is offline-provisioning only (uv cannot download it online). Only meaningful for runtime=python.',
  })
  @Matches(RUNTIME_VERSION_PATTERN, {
    message:
      'runtimeVersion must be a "major.minor" version string (e.g. 3.12)',
  })
  @IsString()
  @IsOptional()
  runtimeVersion?: string;
  /**
   * W-21: executor-side dependency specs. Structure validated at the DTO
   * boundary (array of non-empty bounded strings, ≤50); semantic enforcement
   * stays in the executors (python: option-like/blank specs rejected before
   * uv; node: npm naming rules S16) — plus the service-level leading-'-'
   * guard here mirrors their first check so bad specs 400 at create time
   * instead of burning a queued execution.
   */
  @ApiPropertyOptional({
    description:
      'Dependency specs installed by the executor before the task runs — pip requirements (python runtime, per-task uv venv) or npm packages (node runtime). Ignored by glue-script tasks. Example: ["requests>=2.31", "rich==13.7.1"]',
    type: [String],
  })
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @IsOptional()
  requirements?: string[];
  @ApiPropertyOptional({
    description: "Upstream task dependency map: { taskId: taskName }",
    type: "object",
    additionalProperties: { type: "string" },
    example: { "uuid-of-task-a": "task-a-name" },
  })
  @IsObject()
  @IsOptional()
  dependencies?: Record<string, string>;
  @ApiPropertyOptional() @IsString() @IsOptional() entrypoint?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() gitRepo?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() gitBranch?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() gitCommit?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() currentVersion?: string;
  @ApiPropertyOptional({
    description:
      "Task execution timeout in seconds (legacy field; prefer timeoutSeconds). 0 = no limit; bounded to the executor's 1..86400 window (executor-node rejects larger values with 400 on every attempt).",
  })
  @IsInt()
  @Min(0)
  @Max(86400)
  @IsOptional()
  timeout?: number;
  @ApiPropertyOptional({
    description:
      "Task execution timeout in seconds. 0 = no limit; bounded to the executor's 1..86400 window (normalized to `timeout`, which executor-node rejects above 86400 with 400).",
  })
  @IsInt()
  @Min(0)
  @Max(86400)
  @IsOptional()
  timeoutSeconds?: number;
  /**
   * CORE-04: 超时后动作。kill（缺省/null）= 既有树杀语义；kill_retry =
   * 树杀 + 按既有重试预算 re-enqueue；notify_only = admin 不额外下发终止
   * 指令、只保证超时告警（执行器自身硬超时仍在，进程仍会被执行器杀掉——
   * notify_only ≠ 不超时，语义边界见 timeout-policy.util.ts / 文档）。
   * PATCH 语义（N28 同源）：缺省 = 保留旧值；显式 null = 回到缺省 kill。
   */
  @ApiPropertyOptional({
    description:
      "CORE-04: what happens when the task times out. kill (default) = executor tree-kills the process (existing behavior); kill_retry = also kill, but admin re-enqueues a fresh execution using the task's retry budget; notify_only = admin sends the timeout alert and issues no extra kill command (the executor's own hard timeout still applies). Omit on PATCH to keep the current value; explicit null resets to kill.",
    enum: TIMEOUT_ACTIONS,
  })
  @IsIn(TIMEOUT_ACTIONS as unknown as string[])
  @IsOptional()
  timeoutAction?: TimeoutAction | null;
  /**
   * CORE-04: 超时预警阈值（占 timeout 的百分数，整数 0-90，可空）。
   * 运行时长达到 timeout×ratio/100 时发一次 WARNING 预警通知（每个执行
   * 至多一次）；null/缺省 = 未启用（存量任务零新通知）。
   */
  @ApiPropertyOptional({
    description:
      "CORE-04: timeout warning threshold as a percentage of the timeout (integer 0-90). A single WARNING notification is sent once the running time reaches timeout × ratio/100 (at most once per execution). Omit/null = disabled.",
  })
  @IsInt()
  @Min(0)
  @Max(90)
  @IsOptional()
  timeoutWarnRatio?: number | null;
  // TASK-02: cap retries to prevent runaway queue exhaustion
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  maxRetry?: number;
  @ApiPropertyOptional() @IsInt() @Min(0) @IsOptional() retryDelay?: number;
  /**
   * CORE-05: 预估执行时长（秒，可选整数 0..604800=7 天上限；0/缺省 = 未知）。
   * 任务侧属性——调度侧把它作为执行器 loadScore 的加权输入（长任务给
   * 执行器更重的「预期占用」评分，长短混布时倾向把长任务派给更空闲的
   * 执行器）；执行链路（心跳/超时/统计）不消费该字段。可空：显式 null
   * = 重置为未知（PATCH 语义对齐 timeoutWarnRatio 的 null 透传）。
   */
  @ApiPropertyOptional({
    description:
      "CORE-05: estimated execution duration in seconds (0 or omitted = unknown). Used only by scheduler-side executor load scoring (longer estimates penalize busy executors more); never consumed by the execution chain (heartbeat/timeout/stats). Explicit null on PATCH resets to unknown.",
  })
  @IsInt()
  @Min(0)
  @Max(604800)
  @IsOptional()
  estimatedDurationSec?: number | null;
  @ApiPropertyOptional() @IsArray() @IsOptional() retryableErrors?: string[];
  @ApiPropertyOptional()
  @IsEnum(TaskPriority)
  @IsOptional()
  priority?: TaskPriority;
  @ApiPropertyOptional()
  @IsEnum(ExecuteMode)
  @IsOptional()
  executeMode?: ExecuteMode;
  @ApiPropertyOptional()
  @IsEnum(BlockStrategy)
  @IsOptional()
  blockStrategy?: BlockStrategy;
  @ApiPropertyOptional()
  @IsEnum(MisfireStrategy)
  @IsOptional()
  misfireStrategy?: MisfireStrategy;
  @ApiPropertyOptional() @IsEmail() @IsOptional() alarmEmail?: string;
  @ApiPropertyOptional() @IsArray() @IsOptional() alarmChannels?: string[];
  @ApiPropertyOptional() @IsObject() @IsOptional() params?: Record<string, any>;
  /**
   * SEC-02: 任务级 secrets（凭据键值对，独立于 params 的普通运行参数）。
   * 服务端存储加密（AES-256-GCM，SEC_SECRETS_KEY；未配置降级明文并 warn），
   * API 读取永久脱敏（叶子值回 ******）。派发时解密后走**两条**通道：
   *   ① 与 params 合并（`AUTOFLOW_<KEY>`，旧执行器只认这条，兼容红线）；
   *   ② 单独作为载荷 `secrets` 字段下发，供执行器按**原名**注入子进程 env
   *      ——第三方 SDK 认规范名（AWS_ACCESS_KEY_ID / OPENAI_API_KEY），
   *      加前缀后脚本无法改写，凭据等于不可用（SEC-02 续，生产故障）。
   * PATCH（UpdateTaskDto）语义——**逐键合并**，不是整体替换：
   *   · 字段缺省            = 全部保留；
   *   · 显式 null           = 清空全部；
   *   · 对象里的某个键缺省  = 该键保留（用户没在控制台看到它就别无选择）；
   *   · 叶子值 = `******`   = 该键保留（读路径回给客户端的掩码，回传即"不改"）；
   *   · 叶子值 = null       = 删除该键；
   *   · 其它值              = 加密覆盖。
   * 为什么必须这样：读路径永久脱敏，控制台要显示既有键就必然持有掩码值——
   * 整体替换会把掩码当真实值落库（真实凭据不可逆损毁，而 UI 上键还在，任务
   * 却报"缺少凭据"，这是本次生产故障的形状）。
   */
  @ApiPropertyOptional({
    description:
      "Task-level secrets (credential key/value pairs, stored encrypted at rest with AES-256-GCM when SEC_SECRETS_KEY is configured; plaintext fallback with a warning otherwise). Read paths are always masked with the literal ******. Dispatched both merged into params (AUTOFLOW_<KEY>, legacy channel) and as a separate payload field so the executor injects them under their ORIGINAL names (required by third-party SDKs that read canonical names). On PATCH the object is merged per key: an omitted key or a ****** leaf keeps the stored value, a null leaf deletes the key, any other value overwrites it; an explicit null for the whole field clears every secret.",
    type: "object",
    additionalProperties: { type: "string" },
    example: { API_TOKEN: "sk-live-...", DB_PASSWORD: "hunter2" },
  })
  @IsObject()
  @IsOptional()
  @Validate(IsSecretKeyMapConstraint)
  secrets?: Record<string, unknown> | null;
  @ApiPropertyOptional() @IsString() @IsOptional() executorAppName?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() executorGroup?: string;
  @ApiPropertyOptional() @IsArray() @IsOptional() executorTags?: string[];
  /**
   * NF-04: 标签亲和（可空字符串数组，OR 语义——执行器持有任一标签即命中
   * 候选）。调度侧先按亲和/反亲和过滤候选、再按 CORE-05 loadScore 择优；
   * broadcast 模式下广播收窄为命中亲和标签的执行器子集。与 executorTags
   * （硬性能力 AND 子集）正交，可同配。校验对齐 executorTags（@IsArray +
   * @IsString each）。
   * PATCH 语义（N28）：缺省 = 保留旧值；显式 null / [] = 清除约束。
   */
  @ApiPropertyOptional({
    description:
      "NF-04: executor affinity tags (OR semantics — an executor holding ANY of these tags is an eligible candidate; loadScore then picks within the matched set). In broadcast mode the fan-out narrows to executors matching the affinity tags. Orthogonal to executorTags (hard AND-subset capability requirement). PATCH: omit = keep; explicit null/[] = clear.",
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  executorAffinityTags?: string[] | null;
  /**
   * NF-04: 标签反亲和（可空字符串数组，排除语义——执行器持有任一标签即被
   * 排除）。单发与 broadcast 均生效；与亲和组合时先取亲和命中集再剔除
   * 反亲和命中。PATCH 语义（N28）：缺省 = 保留旧值；显式 null / [] =
   * 清除约束。null 透传路径：UpdateTaskDto 显式 null 经 Object.assign 落
   * 实体列 → 调度侧 null = 无约束（见 update 注释）。
   */
  @ApiPropertyOptional({
    description:
      "NF-04: executor anti-affinity tags (exclusion semantics — an executor holding ANY of these tags is excluded). Applies to both single and broadcast dispatch; combined with affinity tags the matched set is filtered further. PATCH: omit = keep; explicit null/[] = clear.",
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  executorAntiAffinityTags?: string[] | null;
  @ApiPropertyOptional({
    description:
      "Pin the task to a specific executor: dispatch targets ONLY this executor (bypasses group/tags filtering); fails fast if it is offline. Mutually exclusive with executeMode=broadcast.",
  })
  @IsUUID()
  @IsOptional()
  executorId?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() glueSource?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() glueLanguage?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() applicationId?: string;
  /**
   * python_task_multiversion（FR-18 / AC-17b）：代码来源渠道显式声明。
   *
   * 可空——缺省（undefined）在 create 面表示"未声明"（存量语义：按
   * gitRepo/glueSource/applicationId 哪个非空隐式推断，NFR-05 零破坏）；
   * 在 PATCH 面 undefined = 保留旧值（N28 同款），**显式 null = 清除声明**
   * （回到隐式推断语义；`@IsOptional()` 对 null 短路，故 null 合法）。
   *
   * 互斥规则（三选一，**合并终态**判定，落在 task.service）：
   * `gitRepo` / `glueSource` / `codeSource='application_zip'`（配 applicationId）。
   * `requirements`（PyPI）属依赖型渠道，可与任一来源并存（AC-18b）。
   */
  @ApiPropertyOptional({
    description:
      "Code source channel. Exactly one of gitRepo / glueSource / codeSource=application_zip (with applicationId) may be set. Omit on PATCH to keep the current value; explicit null clears the declaration. requirements/PyPI is a dependency channel and may coexist with any code source.",
    enum: TaskCodeSource,
    nullable: true,
  })
  @IsIn(Object.values(TaskCodeSource))
  @IsOptional()
  codeSource?: TaskCodeSource | null;
  @ApiPropertyOptional({
    description:
      "FEAT-11: markdown runbook — troubleshooting knowledge shown on the task detail page and attached to failure notifications/alerts.",
  })
  @IsString()
  @IsOptional()
  runbook?: string;
  /**
   * AUTH-01/TASK-PROJ-01: 任务所属项目。
   *
   * 背景：迁移 1790000000008 给 tasks 加了 projectId 列并把**存量**任务回填到
   * 默认项目，但其注释写明「新建任务在 DTO 未接 projectId 前一律落 NULL」——
   * 即本字段的缺失是当时有意遗留的收尾项。后果是新建任务永远 projectId=NULL，
   * 而 project-access.service 把 NULL 按 DEFAULT_PROJECT_ID 判定，于是
   * 「项目隔离」对所有新任务都塌缩到默认项目、形同虚设。
   *
   * 语义：
   *   - 省略 / null = 未分配 → 读面归入默认项目视图（`IS NULL OR = 默认`），
   *     与既有行为逐字节一致，故本字段是**纯增量**，不填不影响任何现有调用方；
   *   - 传具体 UUID = 归入该项目，写面会校验该项目存在（TaskService.resolveProjectId）。
   *
   * 写面授权：设置 projectId 改变任务的归属与可见范围，故仅 ADMIN 或该项目的
   * editor/admin 可设置（见 TaskService.assertCanAssignProject）。
   *
   * 生产故障修复：校验器由 `@IsUUID()` 换成 `@IsUuidShape()`。前者拒绝
   * DEFAULT_PROJECT_ID（其版本位是 0，validator.js 只认 1–5），而
   * `GET /projects` 无条件返回默认项目行 —— 下拉框里唯一可选项恰好是唯一
   * 被拒项，选项目建任务必现 400 "projectId must be a UUID"。详见
   * common/decorators/is-uuid-shape.decorator.ts 的文件头注释。
   */
  @ApiPropertyOptional({
    description:
      "Owning project. Omit/null = unassigned (counts toward the Default project view; existing behaviour). Setting it requires ADMIN or editor/admin of that project.",
  })
  @IsUuidShape()
  @IsOptional()
  projectId?: string | null;
}
