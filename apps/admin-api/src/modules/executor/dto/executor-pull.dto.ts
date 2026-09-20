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
    description: "执行器注册地址（与心跳一致）",
    example: "http://10.0.0.5:9100",
  })
  address: string;

  @ApiPropertyOptional({
    description:
      "客户端期望的长轮询等待窗口（毫秒）；服务端按 EXECUTOR_PULL_WAIT_MS 钳位（上限 55s）",
    example: 25000,
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
    description:
      "执行器当前空闲槽位数；0 = 满载（服务端只下发控制命令，不派任务）。缺省按有空槽处理",
    example: 2,
  })
  freeSlots?: number;
}
