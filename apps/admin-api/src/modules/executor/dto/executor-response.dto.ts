import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * ARCH-23 / N-12（2026-10-07 批）：执行器域（tag "Executors"）响应体 DTO
 * ——14 端点此前 0 覆盖（register/heartbeat 之外的管理读面全是缺口）。
 *
 * 口径：
 * - ExecutorResponseDto 按 select:false 列**排除** agentCapabilities /
 *   agentCapabilitiesUpdatedAt / tokenHash 三个实体列——默认读面根本不加载
 *   它们（契约描述"实际返回"而非"实体全集"）；
 * - 机器面（heartbeat/pull/token）是凭据投递通道：heartbeat 响应带
 *   tokenHash（回调鉴权 secret，by-design——持 per-executor 令牌的机器才能
 *   读），对用户 JWT 面不可达，契约如实声明；
 * - POST 机器面端点带 @HttpCode(OK) 的按 200 声明；无 @HttpCode 的按 201。
 */

/** executors 行的响应形态（默认读面 = 实体减三个 select:false 列）。 */
export class ExecutorResponseDto {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty({ description: "执行器应用名（按进程的注册键）" })
  appName: string;

  @ApiProperty({ description: "http://host:port，全局唯一" })
  address: string;

  @ApiProperty({ enum: ["online", "offline"] })
  status: "online" | "offline";

  @ApiProperty({
    nullable: true,
    enum: ["manual", "stale_timeout"],
    description: "离线原因（在线时为 null）",
  })
  offlineReason: "manual" | "stale_timeout" | null;

  @ApiProperty({ description: "连续丢失/失败的心跳次数（失联清扫输入）" })
  consecutiveHeartbeatMisses: number;

  @ApiProperty({ enum: ["python", "node", "universal"] })
  type: "python" | "node" | "universal";

  @ApiProperty({
    nullable: true,
    description: "执行器自报的包版本",
  })
  executorVersion: string | null;

  @ApiProperty({
    nullable: true,
    description: "注册时协商的协议版本（pull 控制面门禁）",
  })
  protocolVersion: number | null;

  @ApiProperty({
    enum: ["push", "pull"],
    description: "push = 平台拨向执行器；pull = 执行器长轮询（受 NAT 约束）",
  })
  dispatchMode: "push" | "pull";

  @ApiProperty({
    nullable: true,
    type: [String],
    description: "声明的运行时能力域",
  })
  capabilities: string[] | null;

  @ApiProperty({
    nullable: true,
    description: "最近一次被接受的心跳",
  })
  lastHeartbeat: Date | null;

  @ApiProperty({
    nullable: true,
    description: "执行器进程启动时间（重启检测）",
  })
  executorStartedAt: Date | null;

  @ApiProperty({
    nullable: true,
    description: "按进程的实例 ID（幂等令牌签发）",
  })
  executorStartupId: string | null;

  @ApiProperty({
    description:
      "跨地址变更保持稳定的设备身份（= sha256(deviceId + ':' + installSalt)，64 位小写十六进制字符）。ADR-017 第三阶段：迁移 1790000000054 之后为 NOT NULL —— 从未上报过指纹的执行器会以服务端生成的 `legacy:{address}` 兜底键存储。",
  })
  deviceFingerprint: string;

  @ApiProperty({
    description: "当前运行中的任务数（含已预留但未领取的 pull 槽位）",
  })
  runningTaskCount: number;

  @ApiProperty({ nullable: true })
  cpuUsage: number | null;

  @ApiProperty({ nullable: true })
  memUsage: number | null;

  @ApiProperty({ nullable: true })
  diskUsage: number | null;

  @ApiProperty({
    nullable: true,
    description: "毫秒",
  })
  networkLatency: number | null;

  @ApiProperty()
  totalTaskCount: number;

  @ApiProperty()
  failedTaskCount: number;

  @ApiProperty({
    nullable: true,
    description: "派发门禁容量；null = 不限",
  })
  maxConcurrentTasks: number | null;

  @ApiProperty({
    nullable: true,
    type: [String],
    description: "该执行器当前已领取的执行 ID（E-01-RPT 存活上报）",
  })
  runningExecutionIds: string[] | null;

  @ApiProperty({
    nullable: true,
    description:
      "已预留但尚未领取的 pull 槽位（仅供展示/告警 —— 不是派发门禁）",
  })
  reservedSlots: number | null;

  @ApiProperty({
    nullable: true,
    description: "滞留在死信队列中的控制面命令数",
  })
  deadLetterCount: number | null;

  @ApiProperty({
    nullable: true,
    type: "array",
    items: {
      type: "object",
      properties: {
        version: { type: "string" },
        path: { type: "string" },
        available: { type: "boolean" },
        discoveredAt: { type: "string" },
      },
      required: ["version"],
    },
    description: "执行器上报的解释器池（D5：null = 从未上报，[] = 上报为空）",
  })
  interpreters: Array<{
    version: string;
    path?: string;
    available?: boolean;
    discoveredAt?: string;
  }> | null;

  @ApiProperty({ nullable: true })
  groupName: string | null;

  @ApiProperty({ nullable: true, type: [String] })
  tags: string[] | null;

  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty({ nullable: true, format: "uuid" })
  projectId: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty({ description: "乐观锁 @VersionColumn（TypeORM 版本列）" })
  version: number;

  @ApiPropertyOptional({
    description:
      "仅 list 面（findAll）逐行附带：自报版本是否满足 EXECUTOR_MIN_VERSION 门禁",
  })
  versionCompliant?: boolean;
}

/** POST /executors/heartbeat —— 心跳回执 = 执行器行 + 回调凭据 + 版本门禁读数。 */
export class ExecutorHeartbeatResponseDto extends ExecutorResponseDto {
  @ApiProperty({
    description:
      "该执行器的回调鉴权 secret（机器面：持有令牌的一方可取回它来为执行回调签名）",
  })
  tokenHash: string;

  @ApiProperty({
    nullable: true,
    description: "EXECUTOR_MIN_VERSION 门禁值；'' = 门禁关闭",
  })
  minVersion: string | null;

  @ApiProperty({ description: "自报版本是否满足最低版本门禁" })
  versionCompliant: boolean;

  @ApiPropertyOptional({
    nullable: true,
    type: [String],
    description:
      "save() 回程把 select:false 列 hydrated 带出（R7 实测）；findOne/列表读取不含",
  })
  agentCapabilities?: string[] | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "同上——save() 回程出现性",
  })
  agentCapabilitiesUpdatedAt?: Date | null;
}

/** GET /executors/picker —— 指派对话框的轻量选项（刻意剥离能力快照）。 */
export class ExecutorPickerItemDto {
  @ApiProperty({ format: "uuid" })
  id: string;

  @ApiProperty()
  appName: string;

  @ApiProperty()
  address: string;

  @ApiProperty({ enum: ["online", "offline"] })
  status: "online" | "offline";

  @ApiProperty()
  runningTaskCount: number;

  @ApiProperty({ nullable: true })
  maxConcurrentTasks: number | null;
}

export class ExecutorPickerResponseDto {
  @ApiProperty({ type: [ExecutorPickerItemDto] })
  items: ExecutorPickerItemDto[];

  @ApiProperty({
    description: "达到上限时为 true —— items 只是前缀，total 才是真实总数",
  })
  truncated: boolean;

  @ApiProperty()
  total: number;

  @ApiProperty({ description: "实际生效的上限" })
  limit: number;
}

/** GET /executors/:id/removal-impact —— 删除影响面预览。 */
export class ExecutorRemovalImpactResponseDto {
  @ApiProperty()
  appName: string;

  @ApiProperty()
  address: string;

  @ApiProperty()
  status: string;

  @ApiProperty({
    description: "通过 task.executorId 绑定到该执行器的任务数（派发无回退）",
  })
  pinnedTasks: number;

  @ApiProperty({
    description:
      "通过 task.executorAppName 绑定的任务数（精确匹配，不会静默故障转移）",
  })
  appNameBoundTasks: number;

  @ApiProperty({
    description:
      "pull 队列深度（acf:pull:{id} 的 LLEN）；仅 pull 模式执行器可能非零",
  })
  pendingPullItems: number;
}

/** GET /executors/:id/executions —— 裸 {total,items} 分页（无页元数据）。 */
export class ExecutorExecutionsResponseDto {
  @ApiProperty()
  total: number;

  @ApiProperty({
    type: "array",
    description: "TaskExecution 行，按最新在前（本读面未排除大文本列）",
  })
  items: Array<Record<string, unknown>>;
}

/** POST /executors/:id/reload-config —— 双形态：pull 排队回执 / push 透传执行器响应。 */
export class ExecutorReloadConfigResponseDto {
  @ApiPropertyOptional({
    description: "true = pull 模式：已入队，在下次轮询（约 1 秒）时生效",
  })
  queued?: boolean;

  @ApiPropertyOptional({ format: "uuid" })
  commandId?: string;

  @ApiPropertyOptional()
  message?: string;

  @ApiPropertyOptional({
    additionalProperties: true,
    description: "push 模式：执行器自身 api/config/reload 的响应体，原样透传",
  })
  executorResponse?: unknown;
}

/** POST /executors/token —— 动态令牌签发（R9 幂等语义）。 */
export class ExecutorTokenResponseDto {
  @ApiProperty({ description: "明文令牌（每次取回时展示；轮换规则见 R9）" })
  token: string;

  @ApiProperty({ description: "存储的 bcrypt/sha 哈希，用于校验" })
  tokenHash: string | null;
}

/** POST /executors/command-result —— pull 控制命令执行结果入账回执。 */
export class ExecutorCommandResultResponseDto {
  @ApiProperty({ enum: [true] })
  ok: true;
}

/** GET /executors/config —— pull 热更新的执行器侧配置载荷。 */
export class ExecutorConfigPayloadResponseDto {
  @ApiProperty({ description: "取自实体的按执行器容量；null = 不限" })
  maxConcurrentTasks: number | null;

  @ApiProperty({
    description: "心跳间隔（秒，取自 executor.heartbeatInterval/1000，最小 1）",
  })
  heartbeatIntervalSeconds: number;

  @ApiPropertyOptional({ description: "仅在配置了 app.adminApiUrl 时出现" })
  adminApiUrl?: string;
}

/** POST /executors/pull —— 长轮询取件载荷（task 为动态派发载荷，自由对象）。 */
export class ExecutorPullResponseDto {
  @ApiProperty({
    nullable: true,
    additionalProperties: true,
    description:
      "派发载荷（由 pull 服务构建的 ExecuteRequest 形状），无排队内容时为 null",
  })
  task: Record<string, unknown> | null;

  @ApiProperty({ enum: ["push", "pull"] })
  dispatchMode: "push" | "pull";

  @ApiPropertyOptional({
    type: "array",
    items: { type: "object", additionalProperties: true },
    description: "仅在支持控制面协议的 pull 模式执行器上出现（ARCH-33）",
  })
  commands?: Array<Record<string, unknown>>;
}

/** POST /executors/register —— 注册回执：executor 行 + 注册期一次性 token 语义。 */
export class ExecutorRegisterResponseDto extends ExecutorResponseDto {
  @ApiPropertyOptional({
    nullable: true,
    description:
      "R9 幂等语义：同 (address, startupId) 重注册返回 null（不轮换）；首次注册/真实重启才发新 token",
  })
  perExecutorToken?: string | null;

  @ApiProperty({ description: "回调鉴权 secret（HMAC 源），执行器侧持久化" })
  tokenHash: string;

  @ApiProperty({
    description: "协议版本是否 ≥ PROTOCOL_SUPPORTED_MIN（仅回显，不拒绝注册）",
  })
  protocolCompliant: boolean;

  @ApiPropertyOptional({
    nullable: true,
    type: [String],
    description: "save() 回程 hydrated（R7 实测）",
  })
  agentCapabilities?: string[] | null;

  @ApiPropertyOptional({
    nullable: true,
    description: "save() 回程 hydrated（R7 实测）",
  })
  agentCapabilitiesUpdatedAt?: Date | null;
}
