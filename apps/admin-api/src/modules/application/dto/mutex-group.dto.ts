import { PartialType, ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsNotEmpty,
  IsInt,
  IsOptional,
  Max,
  Min,
  MaxLength,
} from "class-validator";

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

  @ApiPropertyOptional({ description: "组用途说明", maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class UpdateMutexGroupDto extends PartialType(CreateMutexGroupDto) {}
