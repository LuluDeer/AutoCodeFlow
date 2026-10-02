import { PartialType, ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsNotEmpty,
  IsInt,
  IsOptional,
  IsIn,
  Max,
  Min,
  MaxLength,
} from "class-validator";

/** N-15：组作用域——device=单点互斥（同设备×同组串行，存量行为）；
 *  global=全局互斥（组内跨设备串行，单点登录顶号类场景）。 */
export const MUTEX_GROUP_SCOPES = ["device", "global"] as const;
export type MutexGroupScope = (typeof MUTEX_GROUP_SCOPES)[number];

/** MUTEX-01（应用互斥组）：组内并发数上界。设备级 maxConcurrentTasks 的
 *  采纳域是 1..10000，组内并发数理应远小于设备槽数（它是「同组应用在**一台**
 *  设备上的并发」），100 的上界足以覆盖任何合理场景并挡住误配。 */
export const MUTEX_GROUP_MAX_CONCURRENT_CEILING = 100;

export class CreateMutexGroupDto {
  @ApiProperty({
    description: "互斥组名（唯一），如 ziniao-browser",
    maxLength: 64,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name: string;

  @ApiPropertyOptional({
    description: "同一台设备上该组允许的并发执行数（≥1，默认 1 = 组内串行）",
    minimum: 1,
    maximum: MUTEX_GROUP_MAX_CONCURRENT_CEILING,
    default: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MUTEX_GROUP_MAX_CONCURRENT_CEILING)
  maxConcurrentPerDevice?: number;

  @ApiPropertyOptional({
    description:
      "组作用域：device=单点互斥（每台设备同时最多 N 条，跨设备并发）；global=全局互斥（全平台同时最多 N 条，单点登录顶号类场景）。默认 device",
    enum: MUTEX_GROUP_SCOPES,
    default: "device",
  })
  @IsOptional()
  @IsIn(MUTEX_GROUP_SCOPES)
  scope?: MutexGroupScope;

  @ApiPropertyOptional({ description: "组用途说明", maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class UpdateMutexGroupDto extends PartialType(CreateMutexGroupDto) {}
