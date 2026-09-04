import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsISO8601, IsOptional, IsString } from "class-validator";
import { PaginationDto } from "../../../common/dto/pagination.dto";

/**
 * N7: GET /tasks/:id/executions previously typed @Query() with the TS
 * intersection `PaginationDto & { status?: string }`. emitDecoratorMetadata
 * compiles non-trivial intersection types to `Object`, so the global
 * ValidationPipe (whitelist + forbidNonWhitelisted) had no metatype to work
 * with and every undeclared query key passed straight through to the
 * service. An explicit DTO class restores the whitelist.
 */
export class TaskExecutionsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: "Filter by execution status" })
  @IsOptional()
  @IsString()
  status?: string;
}

/**
 * N7: same root cause as TaskExecutionsQueryDto — declares every filter
 * field actually consumed by TaskService.getAllExecutions. Date fields are
 * ISO 8601 strings (admin-web sends dayjs .toISOString()), matching the
 * AuditQueryDto convention.
 */
export class AllExecutionsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: "Filter by execution status" })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: "Filter by task id" })
  @IsOptional()
  @IsString()
  taskId?: string;

  @ApiPropertyOptional({ description: "Fuzzy search by task name" })
  @IsOptional()
  @IsString()
  taskName?: string;

  @ApiPropertyOptional({ description: "Fuzzy filter by executor address" })
  @IsOptional()
  @IsString()
  executorAddress?: string;

  /** ISO 8601 timestamp; admin-web sends dayjs .toISOString() values. */
  @ApiPropertyOptional({
    description: "Only executions created at/after this time (ISO 8601)",
  })
  @IsOptional()
  @IsISO8601()
  startTime?: string;

  /** ISO 8601 timestamp; admin-web sends dayjs .toISOString() values. */
  @ApiPropertyOptional({
    description: "Only executions created at/before this time (ISO 8601)",
  })
  @IsOptional()
  @IsISO8601()
  endTime?: string;
}
