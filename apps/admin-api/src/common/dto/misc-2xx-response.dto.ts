import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * R7（2026-10-07）：example-only 伪覆盖曝光后的 22 处 2xx 补齐（守卫第二形态
 * 空壳硬化）——Auth 5 + Executors 9 + Execution Callback 2 + Health 6。
 * 全部按 service/controller 实际返回逐字段声明。
 */

// ── Auth（5）────────────────────────────────────────────────────────────────

/** login / refresh / totp/verify 三端点共享的双 token 形态（generateTokens 单点）。 */
export class AuthTokensDto {
  @ApiProperty({
    description: "JWT access token (15m default, sid claim present)",
  })
  accessToken: string;

  @ApiProperty({ description: "30d refresh token with unique jti" })
  refreshToken: string;
}

/** POST /auth/logout 回执。 */
export class AuthLogoutDto {
  @ApiProperty({ enum: [true] })
  success: true;
}

/** GET /auth/profile —— AuthUser 原样（validate() 透传 + sid）。 */
export class AuthProfileDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  username: string;

  @ApiProperty()
  email: string;

  @ApiProperty({ enum: ["admin", "user"] })
  role: "admin" | "user";

  @ApiProperty()
  isActive: boolean;

  @ApiPropertyOptional({
    description:
      "Refresh-token jti of this access token's session（旧令牌缺省）",
  })
  sid?: string;
}

// ── Executors（9）───────────────────────────────────────────────────────────

/** GET /executors/groups —— 有groupName的执行器去重清单。 */
export class ExecutorGroupsDto {
  @ApiProperty({ type: [String] })
  groups: string[];
}

/** GET /executors/tags —— 近 5000 台去重标签。 */
export class ExecutorTagsDto {
  @ApiProperty({ type: [String] })
  tags: string[];
}

/** GET /executors/runtime-config —— 心跳/离线判定的运行时配置快照。 */
export class ExecutorRuntimeConfigDto {
  @ApiProperty({ description: "Heartbeat interval ms" })
  heartbeatIntervalMs: number;

  @ApiProperty()
  heartbeatTimeoutMultiplier: number;

  @ApiProperty()
  heartbeatTimeoutMs: number;

  @ApiProperty()
  staleOfflineConfirmations: number;

  @ApiProperty({ description: "连续 N 次未确认后才判离线的折算毫秒" })
  effectiveOfflineAfterMs: number;

  @ApiProperty()
  listLimit: number;

  @ApiProperty()
  executorTotal: number;
}

/** GET /executors/install-cmd —— 一键安装命令（含共享凭据，DR-01）。 */
export class ExecutorInstallCmdDto {
  @ApiProperty({ description: "curl … | bash -s -- 全命令行（含 --secret）" })
  cmd: string;

  @ApiProperty({ description: "共享机器凭据（ADMIN-only 面下发）" })
  token: string;

  @ApiProperty()
  adminApiUrl: string;
}

/** POST /executors/{id}/rotate-token —— R-12 后的轮换回执。 */
export class ExecutorRotateTokenDto {
  @ApiProperty({ description: "新共享凭据（仅此一次回显）" })
  token: string;
}

/** POST /executors/offline —— 执行器自报下线回执。 */
export class ExecutorOfflineDto {
  @ApiProperty({ enum: [true] })
  success: true;
}

/** GET /executors/{id}/metrics —— 详情页七日指标卡一次性载荷。 */
export class ExecutorMetricsDto {
  @ApiProperty({
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      address: { type: "string" },
      status: { type: "string", enum: ["online", "offline"] },
    },
    required: ["id", "address", "status"],
  })
  executor: { id: string; address: string; status: string };

  @ApiProperty({
    type: "object",
    properties: {
      totalExecutions: { type: "number" },
      successful: { type: "number" },
      failed: { type: "number" },
    },
    required: ["totalExecutions", "successful", "failed"],
  })
  sevenDayStats: {
    totalExecutions: number;
    successful: number;
    failed: number;
  };

  @ApiProperty({
    type: "object",
    properties: {
      runningTaskCount: { type: "number" },
      reservedSlots: {
        type: "number",
        nullable: true,
        description: "null = 执行器未上报（旧版）→ 前端回落旧口径",
      },
      cpuUsage: { type: "number", nullable: true },
      memUsage: { type: "number", nullable: true },
      pendingPullItems: {
        type: "number",
        description: "pull 队列深度；push 恒 0；Redis 故障按 0 呈现",
      },
    },
    required: [
      "runningTaskCount",
      "reservedSlots",
      "cpuUsage",
      "memUsage",
      "pendingPullItems",
    ],
  })
  current: {
    runningTaskCount: number;
    reservedSlots: number | null;
    cpuUsage: number | null;
    memUsage: number | null;
    pendingPullItems: number;
  };

  @ApiProperty({
    type: "array",
    items: {
      type: "object",
      properties: {
        timestamp: { type: "string" },
        cpuUsage: { type: "number", nullable: true },
        memUsage: { type: "number", nullable: true },
        runningTaskCount: { type: "number" },
      },
      required: ["timestamp", "cpuUsage", "memUsage", "runningTaskCount"],
    },
  })
  history: Array<{
    timestamp: string;
    cpuUsage: number | null;
    memUsage: number | null;
    runningTaskCount: number;
  }>;
}

// ── Execution Callback（2）──────────────────────────────────────────────────

/** POST /executions/callback 的逐项受理结果（handleCallback 单点产出）。 */
export class CallbackItemResultDto {
  @ApiProperty({ format: "uuid" })
  executionId: string;

  @ApiProperty({
    description:
      "false = 该项未受理（执行不存在/未派发/地址不符/内部异常），error 说明原因",
  })
  success: boolean;

  @ApiPropertyOptional({ description: "success=false 时的原因" })
  error?: string;
}

/** POST /executions/{id}/logs —— 日志分片入账回执。 */
export class LogChunkAckDto {
  @ApiProperty({ description: "落账行数" })
  count: number;
}

// ── Health（6）──────────────────────────────────────────────────────────────

/** GET /health —— 公开面只给 status+timestamp（R-25 收敛）。 */
export class PublicHealthDto {
  @ApiProperty({ enum: ["healthy", "degraded", "unhealthy"] })
  status: "healthy" | "degraded" | "unhealthy";

  @ApiProperty()
  timestamp: string;
}

/** 组件健康行（services/detailed 共用元素形态）。 */
export class HealthComponentDto {
  @ApiProperty({ enum: ["healthy", "degraded", "unhealthy"] })
  status: "healthy" | "degraded" | "unhealthy";

  @ApiPropertyOptional()
  details?: string;
}

/** GET /health/detailed —— 五组件详情 + 指标（FullHealthReport）。 */
export class DetailedHealthDto {
  @ApiProperty({ enum: ["healthy", "degraded", "unhealthy"] })
  status: "healthy" | "degraded" | "unhealthy";

  @ApiProperty()
  timestamp: string;

  @ApiProperty({
    description: "五组件健康（结构同 GET /health/services 的同名键）",
  })
  services: {
    database: { status: "healthy" | "unhealthy"; details?: string };
    redis: { status: "healthy" | "unhealthy"; details?: string };
    queue: {
      status: "healthy" | "degraded" | "unhealthy";
      details?: string;
      size?: number;
    };
    executors: {
      status: "healthy" | "degraded" | "unhealthy";
      details?: string;
      onlineCount?: number;
      totalCount?: number;
    };
    tasks: { status: "healthy" | "degraded" | "unhealthy"; details?: string };
    scheduler: { status: "healthy" | "unhealthy"; details?: string };
  };

  @ApiProperty({
    type: "object",
    properties: {
      totalTasks: { type: "number" },
      activeTasks: { type: "number" },
      runningExecutions: { type: "number" },
      totalExecutors: { type: "number" },
      onlineExecutors: { type: "number" },
      queueSize: { type: "number" },
    },
    required: [
      "totalTasks",
      "activeTasks",
      "runningExecutions",
      "totalExecutors",
      "onlineExecutors",
      "queueSize",
    ],
  })
  metrics: {
    totalTasks: number;
    activeTasks: number;
    runningExecutions: number;
    totalExecutors: number;
    onlineExecutors: number;
    queueSize: number;
  };

  @ApiProperty({
    description: "组件扁平清单",
    type: "array",
    items: {
      type: "object",
      properties: {
        name: { type: "string" },
        status: { type: "string", enum: ["healthy", "degraded", "unhealthy"] },
        message: { type: "string" },
      },
      required: ["name", "status"],
    },
  })
  components: Array<{
    name: string;
    status: "healthy" | "degraded" | "unhealthy";
    message?: string;
  }>;
}

/** GET /health/services —— 五组件并列快照。 */
export class HealthServicesDto {
  @ApiProperty({ type: HealthComponentDto })
  database: { status: "healthy" | "unhealthy"; details?: string };

  @ApiProperty({ type: HealthComponentDto })
  redis: { status: "healthy" | "unhealthy"; details?: string };

  @ApiProperty({ description: "healthy/degraded/unhealthy + size" })
  queue: {
    status: "healthy" | "degraded" | "unhealthy";
    details?: string;
    size?: number;
  };

  @ApiProperty({
    description: "healthy/degraded/unhealthy + onlineCount/totalCount",
  })
  executors: {
    status: "healthy" | "degraded" | "unhealthy";
    details?: string;
    onlineCount?: number;
    totalCount?: number;
  };

  @ApiProperty({ type: HealthComponentDto })
  scheduler: { status: "healthy" | "unhealthy"; details?: string };
}

/** GET /health/metrics —— 指标面摘录（totalExecutors/onlineExecutors/queueSize）。 */
export class HealthMetricsDto {
  @ApiProperty()
  totalExecutors: number;

  @ApiProperty()
  onlineExecutors: number;

  @ApiProperty()
  queueSize: number;
}
