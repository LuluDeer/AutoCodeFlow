import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * MUTEX-01：互斥组读面响应 DTO（ARCH-23/N-12 纪律——实体无 @ApiProperty，
 * 直接标 type: MutexGroup 会 emit 空壳 schema，被 PK-15 闸打红）。
 */
export class MutexGroupResponseDto {
  @ApiProperty({ description: "组 id (uuid)" })
  id: string;

  @ApiProperty({ description: "组名（唯一）" })
  name: string;

  @ApiProperty({ description: "同设备内允许的并发执行数（≥1）" })
  maxConcurrentPerDevice: number;

  @ApiProperty({
    description:
      "组作用域：device=单点互斥（每台设备同时最多 N 条）；global=全局互斥（全平台同时最多 N 条）",
    enum: ["device", "global"],
  })
  scope: "device" | "global";

  @ApiPropertyOptional({ description: "组用途说明", nullable: true })
  description: string | null;

  @ApiPropertyOptional({ description: "当前挂在该组上的应用数" })
  applicationCount?: number;

  @ApiProperty({ description: "创建时间" })
  createdAt: Date;

  @ApiProperty({ description: "更新时间" })
  updatedAt: Date;
}
