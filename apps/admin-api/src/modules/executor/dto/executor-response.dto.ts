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

  @ApiProperty({
    description: "Executor app name (per-process registration key)",
  })
  appName: string;

  @ApiProperty({ description: "http://host:port, globally unique" })
  address: string;

  @ApiProperty({ enum: ["online", "offline"] })
  status: "online" | "offline";

  @ApiProperty({
    description: "Why it went offline (null while online)",
    nullable: true,
    enum: ["manual", "stale_timeout"],
  })
  offlineReason: "manual" | "stale_timeout" | null;

  @ApiProperty({
    description: "Consecutive missed/failed heartbeats (stale sweep input)",
  })
  consecutiveHeartbeatMisses: number;

  @ApiProperty({ enum: ["python", "node", "universal"] })
  type: "python" | "node" | "universal";

  @ApiProperty({
    description: "Self-reported executor package version",
    nullable: true,
  })
  executorVersion: string | null;

  @ApiProperty({
    description:
      "Protocol version negotiated at register (pull control-plane gate)",
    nullable: true,
  })
  protocolVersion: number | null;

  @ApiProperty({
    description:
      "push = platform dials the executor; pull = executor long-polls (NAT-bound)",
    enum: ["push", "pull"],
  })
  dispatchMode: "push" | "pull";

  @ApiProperty({
    description: "Declared runtime capability domains",
    nullable: true,
    type: [String],
  })
  capabilities: string[] | null;

  @ApiProperty({ description: "Last accepted heartbeat", nullable: true })
  lastHeartbeat: Date | null;

  @ApiProperty({
    description: "Executor process start time (restart detection)",
    nullable: true,
  })
  executorStartedAt: Date | null;

  @ApiProperty({
    description: "Per-process instance id (idempotent token issuance)",
    nullable: true,
  })
  executorStartupId: string | null;

  @ApiProperty({
    description: "Stable device identity across address changes",
    nullable: true,
  })
  deviceFingerprint: string | null;

  @ApiProperty({
    description:
      "Currently running tasks (includes reserved-but-unclaimed pull slots)",
  })
  runningTaskCount: number;

  @ApiProperty({ nullable: true })
  cpuUsage: number | null;

  @ApiProperty({ nullable: true })
  memUsage: number | null;

  @ApiProperty({ nullable: true })
  diskUsage: number | null;

  @ApiProperty({ description: "ms", nullable: true })
  networkLatency: number | null;

  @ApiProperty()
  totalTaskCount: number;

  @ApiProperty()
  failedTaskCount: number;

  @ApiProperty({
    description: "Dispatch gate capacity; null = unlimited",
    nullable: true,
  })
  maxConcurrentTasks: number | null;

  @ApiProperty({
    description:
      "Execution ids currently claimed by this executor (E-01-RPT liveness report)",
    nullable: true,
    type: [String],
  })
  runningExecutionIds: string[] | null;

  @ApiProperty({
    description:
      "Pull slots reserved but not yet claimed (display/alert only — NOT a dispatch gate)",
    nullable: true,
  })
  reservedSlots: number | null;

  @ApiProperty({
    description: "Control-plane commands parked in the dead-letter queue",
    nullable: true,
  })
  deadLetterCount: number | null;

  @ApiProperty({
    description:
      "Interpreter pool reported by the executor (D5: null = never reported, [] = reported empty)",
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
}

/** POST /executors/heartbeat —— 心跳回执 = 执行器行 + 回调凭据 + 版本门禁读数。 */
export class ExecutorHeartbeatResponseDto extends ExecutorResponseDto {
  @ApiProperty({
    description:
      "Callback-auth secret for this executor (machine face: the token-authed holder fetches it to sign execution callbacks)",
  })
  tokenHash: string;

  @ApiProperty({
    description: "EXECUTOR_MIN_VERSION gate value; '' = gate disabled",
    nullable: true,
  })
  minVersion: string | null;

  @ApiProperty({
    description:
      "Whether the self-reported version satisfies the min-version gate",
  })
  versionCompliant: boolean;
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
    description:
      "True when the cap hit — items are a prefix, total is the real count",
  })
  truncated: boolean;

  @ApiProperty()
  total: number;

  @ApiProperty({ description: "The applied cap" })
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
    description:
      "Tasks pinned to this executor via task.executorId (dispatch has no fallback)",
  })
  pinnedTasks: number;

  @ApiProperty({
    description:
      "Tasks bound via task.executorAppName (exact match, no silent failover)",
  })
  appNameBoundTasks: number;

  @ApiProperty({
    description:
      "Pull queue depth (acf:pull:{id} LLEN); non-zero only for pull-mode executors",
  })
  pendingPullItems: number;
}

/** GET /executors/:id/executions —— 裸 {total,items} 分页（无页元数据）。 */
export class ExecutorExecutionsResponseDto {
  @ApiProperty()
  total: number;

  @ApiProperty({
    type: "array",
    description:
      "TaskExecution rows, newest first (heavy text columns NOT excluded on this face)",
  })
  items: Array<Record<string, unknown>>;
}

/** POST /executors/:id/reload-config —— 双形态：pull 排队回执 / push 透传执行器响应。 */
export class ExecutorReloadConfigResponseDto {
  @ApiPropertyOptional({
    description: "true = pull-mode: queued, applied on next poll (~1s)",
  })
  queued?: boolean;

  @ApiPropertyOptional({ format: "uuid" })
  commandId?: string;

  @ApiPropertyOptional()
  message?: string;

  @ApiPropertyOptional({
    description:
      "push-mode: the executor's own api/config/reload response body, passed through verbatim",
    additionalProperties: true,
  })
  executorResponse?: unknown;
}

/** POST /executors/token —— 动态令牌签发（R9 幂等语义）。 */
export class ExecutorTokenResponseDto {
  @ApiProperty({
    description: "Plaintext token (shown per fetch; rotation rules per R9)",
  })
  token: string;

  @ApiProperty({ description: "Stored bcrypt/sha hash for verification" })
  tokenHash: string | null;
}

/** POST /executors/command-result —— pull 控制命令执行结果入账回执。 */
export class ExecutorCommandResultResponseDto {
  @ApiProperty({ enum: [true] })
  ok: true;
}

/** GET /executors/config —— pull 热更新的执行器侧配置载荷。 */
export class ExecutorConfigPayloadResponseDto {
  @ApiProperty({
    description: "Per-executor capacity from the entity; null = unlimited",
  })
  maxConcurrentTasks: number | null;

  @ApiProperty({
    description:
      "Heartbeat interval in seconds (executor.heartbeatInterval/1000, min 1)",
  })
  heartbeatIntervalSeconds: number;

  @ApiPropertyOptional({
    description: "Present only when app.adminApiUrl is configured",
  })
  adminApiUrl?: string;
}

/** POST /executors/pull —— 长轮询取件载荷（task 为动态派发载荷，自由对象）。 */
export class ExecutorPullResponseDto {
  @ApiProperty({
    description:
      "Dispatch payload (ExecuteRequest shape built by the pull service) or null when nothing queued",
    nullable: true,
    additionalProperties: true,
  })
  task: Record<string, unknown> | null;

  @ApiProperty({ enum: ["push", "pull"] })
  dispatchMode: "push" | "pull";

  @ApiPropertyOptional({
    description:
      "Only on pull-mode executors with control-plane protocol support (ARCH-33)",
    type: "array",
    items: { type: "object", additionalProperties: true },
  })
  commands?: Array<Record<string, unknown>>;
}
