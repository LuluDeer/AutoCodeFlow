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
 * R3-A（部署模型评审 2026-10-23 §4.3）：心跳上报的单条**设备级应用版本事实**
 * （apps/<appId>/ 目录扫描所得，executor-node 侧 app-inventory 同源）。
 *
 * 与 ExecutorInterpreterDto 同款式：只作 Swagger 文档用（内联 @Body() 仍是
 * Object），结构校验在 service 侧（deployed-apps.util.ts）。
 */
export class DeployedAppDto {
  @ApiProperty({
    example: "5f8a3c2e-9b41-4d6a-a1b2-c3d4e5f6a7b8",
    description: "部署时的 applicationId",
  })
  appId: string;

  @ApiPropertyOptional({
    example: "1.2.0",
    nullable: true,
    description: "设备 current 软链指向的版本；无 current（未部署成功）为 null",
  })
  currentVersion?: string | null;

  @ApiPropertyOptional({
    example: "1.2.0-3f9d2b7a-deploy-8t4",
    nullable: true,
    description: "current 软链指向的 release 目录名",
  })
  currentReleaseKey?: string | null;

  @ApiPropertyOptional({
    type: [String],
    example: ["1.2.0", "1.1.0"],
    description: "设备 releases/ 下仍保留的版本集合（prune 后快照）",
  })
  retainedVersions?: string[];

  @ApiPropertyOptional({
    example: "daemon",
    nullable: true,
    enum: ["once", "daemon", "scheduled"],
    description: "部署/升级时选择的运行模式；设备侧无记录为 null",
  })
  runMode?: "once" | "daemon" | "scheduled" | null;

  @ApiPropertyOptional({
    example: "2026-10-24T08:00:00.000Z",
    nullable: true,
    description: "最近一次部署完成时刻（ISO 8601）；无记录为 null",
  })
  lastDeployedAt?: string | null;
}

/**
 * R3-A（§4.3 / P10 收敛）：心跳上报的单条已安装执行器包
 * （executor_packages 的设备侧事实）。
 */
export class InstalledPackageDto {
  @ApiProperty({ example: "python-runtime" })
  name: string;

  @ApiProperty({ example: "uv" })
  type: string;

  @ApiProperty({ example: "0.7.12" })
  version: string;
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

  @ApiPropertyOptional({
    type: () => [DeployedAppDto],
    description:
      "R3-A（§4.3）：设备级应用版本事实（apps/ 目录扫描）。缺省 → 中台完全不动既有事实行（旧执行器）；[] → 设备上没有任何已部署应用（整替 = 全部既有行删除）；结构非法/超 50 项/同一 appId 重复 → 整字段拒绝采纳。落库语义：整替该执行器全部 executor_app_versions 行（数组外的应用 = 设备已卸载）。",
  })
  deployedApps?: DeployedAppDto[];

  @ApiPropertyOptional({
    type: () => [InstalledPackageDto],
    description:
      "R3-A（§4.3/P10）：设备已安装的执行器包清单。三态语义与 interpreters 同款：缺省 → 保留 DB 旧值；[] → 已上报且无安装包；结构非法/超 100 项 → 整字段拒绝采纳。",
  })
  installedPackages?: InstalledPackageDto[];

  @ApiPropertyOptional({
    example: false,
    description:
      "方案 b（协议 v8，接管自愈死锁修复）：执行器的 /token 409 慢性冲突自报——自最近一次 409 起持续至成功取回 token。三态：缺席 = 未上报（旧执行器/python，中台按旧语义不动活性判定）；false = 已上报且当前无冲突（executor-node 恒发送，含 false）；true = 冲突中——中台消费判据：true 且心跳指纹与行已存真实指纹错位 → 活性四列（status/offlineReason/consecutiveHeartbeatMisses/lastHeartbeat）不登记，心跳不再把冲突行保持 ONLINE（sweep 判死 → 接管窗 → E-1 CAS 收敛）。仅文档用：本类不挂 class-validator（内联 body 元类型 = Object），实际采纳在 controller F-7 白名单与 service 侧判据。",
  })
  registrationConflict?: boolean;
}
