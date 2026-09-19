import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { PageQueryDto } from "../../../common/dto/pagination.dto";

/**
 * Query DTO for GET /config/history.
 *
 * R4 P1-1: the endpoint previously read `key` via a separate @Query("key")
 * param while validating the whole query object against PaginationDto.
 * With the global ValidationPipe (whitelist + forbidNonWhitelisted) any
 * request carrying `key` was rejected with 400 ("property key should not
 * exist"), so the settings-page history drawer always failed. `key` must be
 * declared on the DTO itself to pass the whitelist.
 *
 * API-07（本轮体验审查）：改继承 `PageQueryDto` 而非 `PaginationDto`。后者
 * 携带**任务专用**的 name/status/runtime 三个过滤字段，而本端点只按 `key`
 * 过滤——那三个参数既出现在契约参数表里又不生效，调用方传了会静默拿到未过滤
 * 结果且无从分辨。改基类后契约如实，运行时行为零变化（那些字段本就被忽略）。
 */
export class ConfigHistoryQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: "Filter history by config key" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  key?: string;
}
