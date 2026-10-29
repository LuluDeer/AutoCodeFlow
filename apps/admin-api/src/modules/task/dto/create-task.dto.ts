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
  IsBoolean,
} from "class-validator";
import { Type } from "class-transformer";
import { IsUuidShape } from "../../../common/decorators/is-uuid-shape.decorator";
// SEC-02 续：secrets 键名的可注入性校验（给用户可读的 400，而非执行期静默丢弃）
import { IsSecretKeyMapConstraint } from "./secret-key-map.constraint";
// 任务名写面校验：任意语言 + 禁控制字符/首尾空白 + 长度上限
import { IsTaskName } from "./task-name.constraint";
// 5 字段 cron 合法性（与调度注册路径同源，取代此前写坏的手写正则）
import { IsCron5Field } from "./cron-expression.constraint";
// P2（时区审计）：IANA 时区写面校验（与调度侧/窗口评估同一 Intl 探针）
import { IsIanaTimezone } from "./timezone.constraint";
// B-9: params 体积门（与 webhook/trigger 面同一常量，params-size.util 单一出处）
import { TaskParamsMaxBytes } from "./params-size.constraint";
import { TaskParamsNoKeyCaseCollision } from "./param-key-collision.constraint";
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
// F-5（依赖链契约收口）：dependencies 每个 value 必须是任务 id（非空字符串）
import { IsDependencyValueMapConstraint } from "./dependency-map.constraint";

/**
 * F-3/F-6（调度域审计）：fixed_rate 周期上限（秒）。**双重约束取最小**：
 *   ① `tasks.fixedRate` 是 int4 列（F-6：超界值插入即 PG 22003 裸 500）；
 *   ② 调度侧把周期 ×1000 喂给 setInterval 与触发去重锁 TTL——Node 定时器
 *      delay 经 int32 强转，超过 2^31-1 ms 会回绕成负数 = 立即触发（1ms
 *      定时器风暴）；Redis PEXPIRE 同样只接受 int4 毫秒。
 * 2147483s × 1000 = 2_147_483_000 ms < 2^31-1 = 2_147_483_647 ms，同时
 * 远低于 int4 秒数上限（约 68 年），两个面都收口。PartialType 令
 * UpdateTaskDto（PATCH）继承同一约束；调度侧另有同款毫秒 clamp 兜底存量行
 * （scheduler.service.ts 的 MAX_TIMER_DELAY_MS）。
 */
export const TASK_FIXED_RATE_MAX_SECONDS = 2_147_483;

export class CreateTaskDto {
  // R6: id 是 UUID 主键——客户端自带任意字符串会在插入时触发 PG 22P02/23505
  // 类 500，校验必须在 DTO 边界完成（非法 id → 400）。
  @ApiPropertyOptional() @IsUUID("4") @IsOptional() id?: string;
  /**
   * 任务名：**允许任意语言**（中文/日文/emoji 均可），只禁控制字符与首尾空白，
   * 长度 ≤255（与 DB 列宽对齐）。
   *
   * 此前"任务名只能英文"是**前端**一条 `/^[a-zA-Z0-9_-]+$/` 造成的，后端一直
   * 只要求非空字符串。前端限制已同步放开，判据收敛到本约束器（单一事实源，
   * 见 task-name.constraint.ts）。
   *
   * 注意 name 上有**全局唯一索引**（含软删除行）——改名撞已有名字由
   * TaskService.update 的 23505 分支转成可读 409。
   */
  @ApiProperty({
    example: "每日备份",
    description:
      "任务名称——允许任意语言（含中文/日文/emoji）。拒绝控制字符与首尾空白；长度上限 255 字符。全部任务（含软删除行）内全局唯一。",
  })
  @IsString()
  @IsNotEmpty()
  @IsTaskName()
  name: string;
  @ApiPropertyOptional() @IsString() @IsOptional() description?: string;
  @ApiPropertyOptional() @IsEnum(TaskStatus) @IsOptional() status?: TaskStatus;
  @ApiProperty() @IsEnum(TaskTriggerType) triggerType: TaskTriggerType;
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  // 此前是一条手写的 @Matches 正则，且写坏了——它没有逗号列表与范围分支，
  // 于是 `0 12,18 * * *`、`0 9-17 * * *` 这类合法表达式在保存时被 400 拦死，
  // 而前端预览器（parseCronExpression）与调度器（nodeCron.validate）都接受
  // 它们，用户看到"能预览、存不进去"。现改为与调度器注册路径**同一个**校验器，
  // 详见 cron-expression.constraint.ts。
  @IsCron5Field()
  cronExpression?: string;
  @ApiPropertyOptional({
    description: "cron 调度使用的 IANA 时区，例如 Asia/Shanghai",
  })
  @IsString()
  // P2：非法时区此前静默降级为服务器时区调度（getCronOptions warn 后放行）
  // ——写面直接 400，探针与调度/窗口评估同一实现（timezone.constraint.ts）。
  // 空串/纯空白 = 未设置（对齐调度侧 trim 空行为），照常放行。
  @IsIanaTimezone()
  @IsOptional()
  timezone?: string;
  // F-3/F-6：上限见 TASK_FIXED_RATE_MAX_SECONDS 的双重约束注释。
  @ApiPropertyOptional()
  @IsInt()
  @Min(1)
  @Max(TASK_FIXED_RATE_MAX_SECONDS)
  @IsOptional()
  fixedRate?: number;
  /**
   * FEAT-06: 任务级维护窗口。每条 { start, end, description? }，start/end
   * 均为 5 字段 cron——start 最近触达开窗、end 最近触达关窗（半开区间，
   * 语义见 maintenance-window.util.ts）。结构校验（≤10 条、cron 表达式
   * 结构合法）在 DTO 边界完成；窗口命中时的调度跳过在 scheduler.enqueue。
   * PATCH 语义（N28）：字段缺省 = 保留旧值；显式 null / [] = 清空。
   */
  @ApiPropertyOptional({
    type: [MaintenanceWindowDto],
    maxItems: 10,
    description:
      "任务级维护窗口：落在窗口内的定时触发会被跳过（手动/API 触发不受影响）。每项为 {start, end, description?}，start/end 均为 5 字段 cron；窗口在最近一次 start-cron 触达时开启、在最近一次 end-cron 触达时关闭。最多 10 条。",
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
      '任务所需的 Python 解释器版本，格式为 \\"major.minor\\"（例如 \\"3.7\\"、\\"3.12\\"）。支持区间默认 3.7–3.14；3.7 仅支持离线预置（uv 无法在线下载）。仅在 runtime=python 时有意义。',
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
    type: [String],
    description:
      '任务运行前由执行器安装的依赖声明——pip 依赖（python runtime，每任务独立 uv venv）或 npm 包（node runtime）。GLUE 脚本任务忽略该字段。示例：[\\"requests>=2.31\\", \\"rich==13.7.1\\"]',
  })
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @IsOptional()
  requirements?: string[];
  /**
   * FIX-1.1（依赖链契约，2026-09-30 定死）：上游任务依赖映射 =
   * **Record<显示名快照, 上游任务id>**——**value 才是依赖任务 id**。
   * 消费方（环检测 checkCircularDependency、依赖满足 checkDependencies、
   * 上游 SUCCESS 扇出 triggerDependentTasks、前端 dag-layout）全部读
   * **value**；key 仅作展示别名。写面校验：每个 value 必须是存在的任务 id
   * （assertDependencyValuesExist），自依赖/环由 checkCircularDependency
   * 拦截（value=id 后既有代码生效）。存量 {uuid→name} 行由迁移
   * 1790000000048 幂等翻转。
   */
  @ApiPropertyOptional({
    type: "object",
    additionalProperties: { type: "string" },
    example: { "task-a-name": "uuid-of-task-a" },
    description:
      "上游任务依赖映射：{ 显示名: 上游任务id }——**value 才是依赖任务 id**（环检测、依赖满足、扇出匹配等所有消费方都读 value）。每个 value 必须是已存在的任务 id；自依赖与循环在写面即被拒绝。",
  })
  @IsObject()
  // F-5（依赖值类型收口）：@IsObject 只拦「不是对象」，拦不住 value=123/true
  // 这类非字符串——它们会一路穿到 assertDependencyValuesExist 的 In([...])
  // 查 uuid 列，PG 42883 → 裸 500。自定义约束器在 DTO 边界把每个 value 收口
  // 为非空字符串，文案说明「依赖值必须是任务 id」。
  @Validate(IsDependencyValueMapConstraint)
  @IsOptional()
  dependencies?: Record<string, string>;
  /**
   * G6：失败边（默认 false）。true = 任一上游依赖进入失败终态时也触发本任务
   * （补偿/清理链）；依赖闸门同时接受「上游最新执行是失败终态」。
   */
  @ApiPropertyOptional({
    description:
      "失败边：上游依赖进入失败终态（FAILED/TIMEOUT/KILLED/CANCELLED）时也触发本任务（默认 false）",
  })
  @IsBoolean()
  @IsOptional()
  runOnUpstreamFailure?: boolean;
  @ApiPropertyOptional() @IsString() @IsOptional() entrypoint?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() gitRepo?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() gitBranch?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() gitCommit?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() currentVersion?: string;
  @ApiPropertyOptional({
    description:
      "任务执行超时秒数（遗留字段；建议使用 timeoutSeconds）。0 = 不限制；上限为执行器的 1..86400 窗口（executor-node 每次尝试都会以 400 拒绝更大的值）。",
  })
  @IsInt()
  @Min(0)
  @Max(86400)
  @IsOptional()
  timeout?: number;
  @ApiPropertyOptional({
    description:
      "任务执行超时秒数。0 = 不限制；上限为执行器的 1..86400 窗口（会归一化到 `timeout`，executor-node 对超过 86400 的值以 400 拒绝）。",
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
    enum: TIMEOUT_ACTIONS,
    description:
      "CORE-04：任务超时后的动作。kill（缺省）= 执行器按既有语义树杀进程；kill_retry = 同样树杀，但 admin 按任务的重试预算重新入队一次执行；notify_only = admin 只下发超时告警、不额外下发终止指令（执行器自身的硬超时仍然生效）。PATCH 时缺省 = 保留当前值；显式 null = 重置回 kill。",
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
      "CORE-04：超时预警阈值，取 timeout 的百分数（整数 0-90）。运行时长达到 timeout × ratio/100 时发送一次 WARNING 预警通知（每个执行至多一次）。缺省/null = 未启用。",
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
  /**
   * F-3：重试延迟上限对齐 timeout 的 1..86400 语义——此前仅 @Min(0)，一个
   * 2^31 量级的值会把指数退避 delay 顶到 BullMQ/Node 定时器的 int32 毫秒
   * 溢出线（约 68 年重试延迟）。PartialType 令 PATCH 继承同一约束。
   */
  @ApiPropertyOptional()
  @IsInt()
  @Min(0)
  @Max(86400)
  @IsOptional()
  retryDelay?: number;
  /**
   * CORE-05: 预估执行时长（秒，可选整数 0..604800=7 天上限；0/缺省 = 未知）。
   * 任务侧属性——调度侧把它作为执行器 loadScore 的加权输入（长任务给
   * 执行器更重的「预期占用」评分，长短混布时倾向把长任务派给更空闲的
   * 执行器）；执行链路（心跳/超时/统计）不消费该字段。可空：显式 null
   * = 重置为未知（PATCH 语义对齐 timeoutWarnRatio 的 null 透传）。
   */
  @ApiPropertyOptional({
    description:
      "CORE-05：预估执行时长（秒；0 或缺省 = 未知）。仅用于调度侧的 executor 负载评分（预估越长，对繁忙执行器的惩罚越大）；执行链路（心跳/超时/统计）从不消费该字段。PATCH 时显式 null = 重置为未知。",
  })
  @IsInt()
  @Min(0)
  @Max(604800)
  @IsOptional()
  estimatedDurationSec?: number | null;
  /**
   * F-7（simple-array 落库形态）：retryableErrors 是 simple-array 列——
   * TypeORM 以逗号 join 落库，元素含逗号会在读回时被静默劈裂成两条。
   * DTO 边界禁逗号（@IsString each 收紧此前的无元素类型校验）。
   */
  @ApiPropertyOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(/^[^,]*$/, { each: true })
  @IsOptional()
  retryableErrors?: string[];
  @ApiPropertyOptional()
  @IsEnum(TaskPriority)
  @IsOptional()
  priority?: TaskPriority;
  /**
   * A-1（执行器域审计）：broadcast 与互斥组互斥——绑定应用的
   * applications.mutexGroupId 非空时，broadcast 任务在写面 400 拒绝
   * （广播不执行互斥占坑，见 TaskService.assertBroadcastMutexCompatible）。
   */
  @ApiPropertyOptional({
    description:
      "派发模式：single（在符合条件的执行器中选择负载最低的一台，缺省）或 broadcast（扇出到所有符合条件的在线执行器）。与 executorId 钉定互斥；当绑定应用带有互斥组时以 400 拒绝（broadcast 无法遵守组内并发上限）。",
  })
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
  /**
   * F-7（simple-array 落库形态）：同 retryableErrors——simple-array 以逗号
   * join 落库，元素含逗号读回即被劈裂。
   */
  @ApiPropertyOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(/^[^,]*$/, { each: true })
  @IsOptional()
  alarmChannels?: string[];
  @ApiPropertyOptional({
    description:
      "任务默认参数；序列化后体积不得超过 65536 字节（与 trigger/webhook 面同一上限）。",
  })
  @IsObject()
  @IsOptional()
  // B-9: 任务默认 params 此前无体积上限（仅 webhook 触发面 64KB）——统一
  // 同一常量；PartialType 令 UpdateTaskDto（PATCH）继承同一约束。
  @TaskParamsMaxBytes()
  @TaskParamsNoKeyCaseCollision()
  params?: Record<string, any>;
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
    type: "object",
    additionalProperties: { type: "string" },
    example: { API_TOKEN: "sk-live-", DB_PASSWORD: "hunter2" },
    description:
      "任务级 secrets（凭据键值对，独立于 params 的普通运行参数；配置了 SEC_SECRETS_KEY 时以 AES-256-GCM 加密落库，未配置则降级明文并告警）。读路径一律以字面量 ****** 掩码。派发时走两条通道：合并进 params（AUTOFLOW_<KEY>，旧执行器通道）并作为独立载荷字段下发，使执行器按**原名**注入（第三方 SDK 要求规范名）。PATCH 时按**逐键合并**：键缺省或叶子值为 ****** 时保留已存值，叶子值为 null 时删除该键，其它值覆盖；整个字段显式 null 时清空全部 secret。",
  })
  @IsObject()
  @IsOptional()
  @Validate(IsSecretKeyMapConstraint)
  secrets?: Record<string, unknown> | null;
  @ApiPropertyOptional({
    enum: ["strict", "prefer"],
    nullable: true,
    description:
      "FEAT-22：任务级部署派发策略覆盖。'strict' 把候选收窄为显式部署了绑定应用的设备集合（running/stopped/upgrading）；当其中没有任何设备可承接该执行时，执行会以 WAITING 排队，而不是静默派发到别处。'prefer' 保留 ARCH-35 的软偏好（优先尝试已部署且运行中的设备，否则回落到全集群）。缺省/null = 跟随全局 executor.deploymentPolicy（EXECUTOR_DEPLOYMENT_POLICY）。优先级：executorId 钉定 > executorAppName > 部署约束 > 全集群；总开关 executor.preferDeployedExecutor=false 会彻底关闭部署感知。PATCH：缺省 = 保留；显式 null = 跟随全局。",
  })
  @IsIn(["strict", "prefer"])
  @IsOptional()
  deploymentPolicy?: "strict" | "prefer" | null;
  @ApiPropertyOptional() @IsString() @IsOptional() executorAppName?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() executorGroup?: string;
  /**
   * F-7（simple-array 落库形态）：executorTags 是 simple-array 列——元素含
   * 逗号会在读回时被静默劈裂（"gpu,a100" → ["gpu","a100"]），调度侧按标签
   * AND 子集匹配时永远匹配不到。DTO 边界禁逗号。
   */
  @ApiPropertyOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(/^[^,]*$/, { each: true })
  @IsOptional()
  executorTags?: string[];
  /**
   * NF-04: 标签亲和（可空字符串数组，OR 语义——执行器持有任一标签即命中
   * 候选）。调度侧先按亲和/反亲和过滤候选、再按 CORE-05 loadScore 择优；
   * broadcast 模式下广播收窄为命中亲和标签的执行器子集。与 executorTags
   * （硬性能力 AND 子集）正交，可同配。校验对齐 executorTags（@IsArray +
   * @IsString each）。
   * PATCH 语义（N28）：缺省 = 保留旧值；显式 null / [] = 清除约束。
   */
  @ApiPropertyOptional({
    type: [String],
    description:
      "NF-04：执行器标签亲和（OR 语义——持有其中**任一**标签的执行器即为候选；随后在命中集合内按 loadScore 择优）。broadcast 模式下扇出收窄为命中亲和标签的执行器子集。与 executorTags（硬性 AND 子集能力要求）正交。PATCH：缺省 = 保留；显式 null/[] = 清除。",
  })
  @IsArray()
  @IsString({ each: true })
  // F-7：simple-array 列禁逗号（劈裂形态见 executorTags 注释）。
  @Matches(/^[^,]*$/, { each: true })
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
    type: [String],
    description:
      "NF-04：执行器标签反亲和（排除语义——持有其中**任一**标签的执行器即被排除）。单发与 broadcast 均生效；与亲和标签组合时，先取亲和命中集再在其上剔除。PATCH：缺省 = 保留；显式 null/[] = 清除。",
  })
  @IsArray()
  @IsString({ each: true })
  // F-7：simple-array 列禁逗号（劈裂形态见 executorTags 注释）。
  @Matches(/^[^,]*$/, { each: true })
  @IsOptional()
  executorAntiAffinityTags?: string[] | null;
  @ApiPropertyOptional({
    description:
      "把任务钉定到指定执行器：派发**只**发往该执行器（绕过分组/标签过滤）；它离线时快速失败。与 executeMode=broadcast 互斥。",
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
    enum: TaskCodeSource,
    nullable: true,
    description:
      "代码来源渠道。gitRepo / glueSource / codeSource=application_zip（需配 applicationId）三者中只能设置一个。PATCH 时缺省 = 保留当前值；显式 null = 清除声明。requirements/PyPI 属于依赖型渠道，可与任一代码来源并存。",
  })
  @IsIn(Object.values(TaskCodeSource))
  @IsOptional()
  codeSource?: TaskCodeSource | null;
  @ApiPropertyOptional({
    description:
      "FEAT-11：markdown 运维手册——展示在任务详情页，并随失败通知/告警一并附上。",
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
      "所属项目。缺省/null = 未分配（计入默认项目视图；与既有行为一致）。设置它需要 ADMIN 或该项目的 editor/admin。",
  })
  @IsUuidShape()
  @IsOptional()
  projectId?: string | null;
}
