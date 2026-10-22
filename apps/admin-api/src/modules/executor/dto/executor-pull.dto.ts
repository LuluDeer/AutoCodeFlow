import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * PK-19（DEEP_REVIEW 0ef3bbe）: POST /executors/pull 的请求体 Swagger 文档 DTO。
 *
 * 注意：本类**仅用于 openapi schema 生成**——控制器 @Body() 仍用内联类型
 * `{ address: string; waitMs?: number }`（metatype = Object，全局 ValidationPipe
 * 不对其做 whitelist 校验）。此处不挂 class-validator 装饰器，避免把 executor-node
 * 长轮询请求体误入 forbidNonWhitelisted 400 路径。
 */
export class ExecutorPullDto {
  @ApiProperty({
    example: "http://10.0.0.5:9100",
    description: "执行器注册地址（与心跳一致）",
  })
  address: string;

  @ApiPropertyOptional({
    example: 25000,
    description:
      "客户端期望的长轮询等待窗口（毫秒）；服务端按 EXECUTOR_PULL_WAIT_MS 钳位（上限 55s）",
  })
  waitMs?: number;

  /**
   * ARCH-33（ADR-016）：执行器当前空闲槽位数。
   *
   * 缺省 = 未上报（旧执行器）→ 服务端按「有空槽」处理，任务照常出队，行为
   * 与今日逐字节一致。显式上报 0 = 满载：服务端**不出队任务**，但仍下发
   * 控制面命令——否则执行器满载时部署/停止/热更新全部静默失效。
   */
  @ApiPropertyOptional({
    example: 2,
    description:
      "执行器当前空闲槽位数；0 = 满载（服务端只下发控制命令，不派任务）。缺省按有空槽处理",
  })
  freeSlots?: number;

  /**
   * ADR-017 阶段 3：稳定设备身份（协议 v3 起执行器上报）。
   *
   * pull 模式允许同地址多行并存（ADR-017 §5，不同内网同网段同 IP），此时
   * 服务端**必须**靠指纹才能唯一定位调用方的行——否则会拉到别人的
   * `acf:pull:` 队列。缺省 = 旧执行器/采集失败 → 服务端 legacy 兜底路径
   * （地址命中多行时 fail-closed 拒绝，不会猜错行）。
   */
  @ApiPropertyOptional({
    example: "f".repeat(64),
    description:
      "稳定设备指纹 sha256(deviceId + ':' + installSalt)，64 位小写十六进制（协议 v3+）。pull 同址多行时用于唯一定位本行",
  })
  deviceFingerprint?: string | null;

  /**
   * 工单 11（ADR-017 决策 §3 补全）：执行器自报的**行 id**（注册响应下发、
   * 执行器持久化后回传）。
   *
   * 只在「同址多行 + 无指纹」的**歧义态**下作为**候选行提示**使用，且必须
   * 该行的 per-executor 令牌校验通过才采纳——共享令牌一律不采纳（否则任何
   * 持共享令牌的机器都能声明别人的行、拉走别人的队列）。
   */
  @ApiPropertyOptional({
    example: "3f2a1c9d-8b7e-6f50-a132-4b5c6d7e8f90",
    description:
      "执行器自报的行 id（executors.id）。仅在地址歧义（同址多行且无指纹）时作为候选提示，须该行的 per-executor 令牌校验通过才采纳",
  })
  executorId?: string | null;
}
