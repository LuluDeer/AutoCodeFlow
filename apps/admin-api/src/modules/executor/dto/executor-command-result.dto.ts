import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from "class-validator";

/**
 * P2-4（2026-10-26 第三轮审计）：POST /executors/command-result 的请求体 DTO。
 *
 * 此前该端点的 @Body() 是内联类型（metatype = Object，全局 ValidationPipe 的
 * whitelist/forbidNonWhitelisted 对其不生效），两个后果：
 *  - `error` 未限长原样进 `acf:cmdres` 结果键，deploy 失败时还会整体插值进
 *    app_deployments.statusMessage（text 列）并随列表读面回传——执行器上报面
 *    不可信，必须有长度闸（对齐 DeploymentHeartbeatDto.message 的 2KB 同口径）；
 *  - `commandId` 无形态校验——它是 Redis 键（acf:cmdres:{id} / acf:cmdmeta:{id}）
 *    的直接成分，畸形长 id 就是键空间写放大面。
 *
 * 换 class DTO 后恢复全局管道白名单。字段集合与 executor-node 的实际上报体
 * 逐字段对齐（ControlCommandResult {commandId, type, ok, status?, error?,
 * durationMs} + address + deviceFingerprint，见 executor-node pull.ts 的
 * command-result POST）——白名单外的字段会被 forbidNonWhitelisted 400，这是
 * 有意的协议面收敛（执行器只发这些字段，不存在兼容性破坏）。
 */
export class ExecutorCommandResultDto {
  @ApiProperty({
    description:
      "命令 id（中台入队时签发的 UUID v4，执行器原样回传；它同时是 acf:cmdres:/acf:cmdmeta: 键的成分）",
  })
  // 形态闸：中台签发的 commandId 恒为 UUID（randomUUID）；executor-node 协议
  // schema 的正则（[A-Za-z0-9][A-Za-z0-9._-]{0,127}）比这里宽——那是执行器侧
  // 对「队列可能被外部写入」的容错，中台侧只接受自己签发过的形态（更严不破坏
  // 协议：执行器只是回显）。
  @IsUUID()
  @MaxLength(128)
  commandId: string;

  @ApiProperty({
    example: "http://10.0.0.5:9100",
    description: "执行器注册地址",
  })
  @IsString()
  @MaxLength(255)
  address: string;

  @ApiProperty({
    example: "deploy",
    description:
      "命令类型（deploy / app-stop / app-uninstall / config-reload / kill-execution / update-package）",
  })
  @IsString()
  @MaxLength(64)
  type: string;

  @ApiProperty({ description: "命令是否执行成功" })
  @IsBoolean()
  ok: boolean;

  @ApiPropertyOptional({ description: "执行器本地路由的 HTTP 状态码" })
  @IsOptional()
  @IsInt()
  @Min(0)
  status?: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "失败原因（≤2000）。执行器侧自截 1000 字符，这里给双倍余量——闸的意义是" +
      "堵住非受信上报面的自由文本写放大，不是复刻执行器侧的截断行为",
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  error?: string | null;

  @ApiPropertyOptional({ description: "本地执行耗时（毫秒）" })
  @IsOptional()
  @IsInt()
  @Min(0)
  durationMs?: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "ADR-017 阶段 3：稳定设备指纹（可选；旧执行器不传）——上报行定位与归属比对用",
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  deviceFingerprint?: string | null;
}
