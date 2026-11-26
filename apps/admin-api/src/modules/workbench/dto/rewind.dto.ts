/**
 * N18 rewind 端点入参 / 出参 DTO。
 *
 * 纪律：代际（generation / policyGeneration）**不作为客户端入参出现**。
 * 围栏判定只读服务端 PolicyGenerationService 的运行时代际；客户端只能给会话
 * 标识与可选的 Part 过滤，杜绝旧代写入方伪造同代 token 绕过作废。
 */
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsArray, IsOptional, IsString, MaxLength } from "class-validator";

/** POST /api/workbench/rewind 入参。 */
export class RewindRequestDto {
  @ApiProperty({
    description: "目标 workbench 会话 id（服务端据此取 Parts 与在途异步写入）",
  })
  @IsString()
  @MaxLength(128)
  sessionId: string;

  @ApiPropertyOptional({
    description:
      "可选 Part id 过滤；省略则覆盖该会话的全部在途写入。仅缩小范围，不参与代际判定",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  partIds?: string[];
}

/** rewind 执行结果：计数与执行清单，代际仅作回显，不供客户端回传复用。 */
export class RewindResultDto {
  @ApiProperty({ description: "围栏放行的异步写入数" })
  allowedCount: number;

  @ApiProperty({
    description: "作废的异步写入数（与审计 detail.invalidatedCount 同值）",
  })
  invalidatedCount: number;

  @ApiProperty({ description: "实际执行（落盘 + 通知扇出）的写入 id" })
  executedWriteIds: string[];

  @ApiProperty({
    description:
      "本次判定采用的运行时代际（16 位十六进制）；null = 当前代不可知，全部作废",
    nullable: true,
  })
  generation: string | null;

  @ApiProperty({
    description: "本次 rewind 的资源 id（与审计 resourceId 一致）",
  })
  resourceId: string;
}
