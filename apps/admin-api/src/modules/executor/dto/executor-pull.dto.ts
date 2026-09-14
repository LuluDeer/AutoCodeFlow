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
}
