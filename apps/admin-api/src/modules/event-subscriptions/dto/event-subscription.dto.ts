import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SUBSCRIBABLE_EVENTS } from "../event-subscription.util";

/**
 * FEAT-07: 出站事件订阅 CRUD DTO。
 * url 校验分两层：class-validator 的 http(s) 形状检查（@IsUrl，快速拒绝）+
 * service 写入前 assertSafeHttpUrl 的 SSRF 深校验（DNS 解析逐地址判内网，
 * 红线：拒内网/环回/链路本地/云元数据）。
 */
export class CreateEventSubscriptionDto {
  @ApiProperty({
    description:
      "Callback URL (public http(s) endpoint; private networks rejected)",
    example: "https://ci.example.com/hooks/autoflow",
  })
  @IsUrl({ require_tld: false, protocols: ["http", "https"] })
  @MaxLength(2048)
  url: string;

  @ApiProperty({
    description: "Event names to subscribe",
    enum: SUBSCRIBABLE_EVENTS,
    isArray: true,
    example: ["execution.failed"],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsIn(SUBSCRIBABLE_EVENTS as unknown as string[], { each: true })
  eventTypes: string[];

  @ApiPropertyOptional({
    description:
      "HMAC signing secret. Omit to let the server generate a 32-byte hex secret " +
      "(returned once in the create response, never shown again).",
  })
  @IsString()
  @MinLength(16)
  @MaxLength(256)
  @IsOptional()
  secret?: string;
}

export class UpdateEventSubscriptionDto {
  @ApiPropertyOptional({ description: "Enable/disable delivery" })
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @ApiPropertyOptional({ description: "New callback URL" })
  @IsUrl({ require_tld: false, protocols: ["http", "https"] })
  @MaxLength(2048)
  @IsOptional()
  url?: string;

  @ApiPropertyOptional({ description: "Replace the subscribed event set" })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsIn(SUBSCRIBABLE_EVENTS as unknown as string[], { each: true })
  @IsOptional()
  eventTypes?: string[];

  @ApiPropertyOptional({ description: "Rotate the signing secret" })
  @IsString()
  @MinLength(16)
  @MaxLength(256)
  @IsOptional()
  secret?: string;
}

/** 死信列表分页（默认 20，上限 100——防大表拖库）。 */
export class ListDeadLettersQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @Type(() => Number)
  @IsOptional()
  limit?: number = 20;
}
