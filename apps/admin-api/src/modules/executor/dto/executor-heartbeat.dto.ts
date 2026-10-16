import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * python_task_multiversion（WS2）：执行器上报的解释器缓存池清单条目。
 *
 * 只作 Swagger 文档用（内联 @Body() 仍是 Object，见类头注）。用 `type: () => [X]`
 * 让 swagger 生成**内联的 array-of-object**（不额外注册具名 schema），与
 * CONTRACT §2.2 的 jsonc 形状一一对应，且不动 openapi 的 schema 名集合。
 */
export class ExecutorInterpreterDto {
  @ApiProperty({
    example: "3.7.9",
    description: "在解释器池中发现的完整补丁版本",
  })
  version: string;

  @ApiPropertyOptional({
    example:
      "/data/interpreters/cpython-3.7.9-linux-x86_64-gnu-none/bin/python3",
    description: "池内的解释器绝对路径",
  })
  path?: string;

  @ApiPropertyOptional({
    example: true,
    description: "探测结果（可执行且 --version 成功）",
  })
  available?: boolean;

  @ApiPropertyOptional({
    example: "2026-09-16T10:00:00.000Z",
    description: "探测时间戳（ISO 8601）",
  })
  discoveredAt?: string;
}

/**
 * PK-03（DEEP_REVIEW 0ef3bbe）: POST /executors/heartbeat 的请求体 Swagger 文档 DTO。
 *
 * 注意：本类**仅用于 openapi schema 生成**——控制器 @Body() 仍用内联类型
 * （metatype = Object，全局 ValidationPipe 不对其做 whitelist 校验）。此处不挂
 * class-validator 装饰器，避免把 executor-node 心跳请求体误入
 * forbidNonWhitelisted 400 路径；指标白名单在 controller/service 侧显式裁剪。
 */
export class ExecutorHeartbeatDto {
  @ApiProperty({
    example: "192.168.1.100:3002",
    description: "执行器注册地址",
  })
  address: string;

  @ApiPropertyOptional({
    example: 45.5,
    description: "CPU 使用率百分比",
  })
  cpuUsage?: number;

  @ApiPropertyOptional({
    example: 62.3,
    description: "内存使用率百分比",
  })
  memUsage?: number;

  @ApiPropertyOptional({
    example: 70.0,
    description: "磁盘使用率百分比",
  })
  diskUsage?: number;

  @ApiPropertyOptional({
    example: 2,
    description: "网络延迟（毫秒）",
  })
  networkLatency?: number;

  @ApiPropertyOptional({
    example: 3,
    description: "当前运行中的任务数",
  })
  runningTaskCount?: number;

  @ApiPropertyOptional({
    example: 150,
    description: "累计执行的任务数",
  })
  totalTaskCount?: number;

  @ApiPropertyOptional({
    example: 5,
    description: "失败任务数",
  })
  failedTaskCount?: number;

  @ApiPropertyOptional({
    example: "2026-09-14T08:00:00.000Z",
    nullable: true,
    description: "重启时间戳（ISO 8601）",
  })
  restartedAt?: string | null;

  @ApiPropertyOptional({
    example: "uuid-of-this-executor-process-life",
    nullable: true,
    description: "启动 ID（进程生命周期标识）",
  })
  startupId?: string | null;

  @ApiPropertyOptional({
    type: [String],
    example: ["exec-uuid-1", "exec-uuid-2"],
    description: "CONSISTENCY-02：当前运行中的执行 ID",
  })
  runningExecutionIds?: string[];

  @ApiPropertyOptional({
    example: 1,
    minimum: 0,
    description:
      "E-01-RPT（协议 v4）：pull 长轮询已预留但尚未领取的槽位。runningTaskCount 统计的是已占用槽位（含本次预留，这正是 E-01 防超卖机制）；runningExecutionIds 只列出已领取的执行。因此详情页用 runningTaskCount - reservedSlots 展示实际运行数。仅供展示 —— 派发门禁从不读取该字段。总是发送（0 = 已上报且无预留）；缺失 = legacy 执行器。",
  })
  reservedSlots?: number;

  @ApiPropertyOptional({
    example: 0,
    description: "死信数量",
  })
  deadLetterCount?: number;

  @ApiPropertyOptional({
    example: 10,
    description: "E9：更新后的最大并发任务数（热更新容量）",
  })
  maxConcurrentTasks?: number;

  @ApiPropertyOptional({
    example: "1.0.0",
    description: "EXE-VER-1：执行器版本（用于最低版本门禁回显，不落库）",
  })
  version?: string;

  @ApiPropertyOptional({
    type: () => [ExecutorInterpreterDto],
    description:
      "python_task_multiversion：解释器缓存池清单。缺省 → 保留已存值；[] → 已上报且池为空；结构非法 → 整字段被拒绝。",
  })
  interpreters?: ExecutorInterpreterDto[];

  @ApiPropertyOptional({
    example: "3f2a1c9d8b7e6f504132a5b6c7d8e9f00a1b2c3d4e5f60718293a4b5c6d7e8f9",
    nullable: true,
    description:
      "ARCH-36（ADR-017 第二/三阶段）：稳定的安装身份 —— sha256(deviceId + ':' + installSalt)，64 位小写十六进制字符。ADR-017 第三阶段把它定为行查找键：register/heartbeat 先按指纹解析行，因此换了 IP 的机器会复用既有行，而不是新建幽灵行。缺省/非法 → 保留已存值（legacy 或采集失败的执行器绝不能把已存指纹清空），并回退到按地址查找。",
  })
  deviceFingerprint?: string | null;
}
