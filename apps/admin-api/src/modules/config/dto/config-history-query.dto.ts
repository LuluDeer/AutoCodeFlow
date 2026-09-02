import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { PaginationDto } from "../../../common/dto/pagination.dto";

/**
 * Query DTO for GET /config/history.
 *
 * R4 P1-1: the endpoint previously read `key` via a separate @Query("key")
 * param while validating the whole query object against PaginationDto.
 * With the global ValidationPipe (whitelist + forbidNonWhitelisted) any
 * request carrying `key` was rejected with 400 ("property key should not
 * exist"), so the settings-page history drawer always failed. `key` must be
 * declared on the DTO itself to pass the whitelist.
 */
export class ConfigHistoryQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: "Filter history by config key" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  key?: string;
}
