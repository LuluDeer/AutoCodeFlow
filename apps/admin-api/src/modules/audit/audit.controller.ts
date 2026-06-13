import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiQuery, ApiOperation } from "@nestjs/swagger";
import { Response } from "express";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuditService } from "./audit.service";
import { PaginationDto } from "../../common/dto/pagination.dto";

@ApiTags("audit")
@ApiBearerAuth("JWT")
@UseGuards(JwtAuthGuard)
@Controller("audit")
export class AuditController {
  constructor(private readonly svc: AuditService) {}

  @Get()
  @ApiOperation({ summary: "Query audit logs with pagination" })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "pageSize", required: false })
  @ApiQuery({ name: "action", required: false })
  @ApiQuery({ name: "resource", required: false })
  @ApiQuery({ name: "userId", required: false, type: Number })
  findAll(
    @Query() pagination: PaginationDto,
    @Query("action") action?: string,
    @Query("resource") resource?: string,
    @Query("userId") userId?: number,
  ) {
    return this.svc.findAll({
      page: pagination.page,
      pageSize: pagination.pageSize,
      action,
      resource,
      userId: userId ? Number(userId) : undefined,
    });
  }

  @Get("export")
  @ApiOperation({
    summary: "Export audit logs as CSV (max 10 000 rows)",
    description: "Returns a CSV file attachment. Supports the same filters as the list endpoint.",
  })
  @ApiQuery({ name: "action", required: false })
  @ApiQuery({ name: "resource", required: false })
  @ApiQuery({ name: "userId", required: false, type: Number })
  async exportCsv(
    @Query("action") action?: string,
    @Query("resource") resource?: string,
    @Query("userId") userId?: number,
    @Res() res?: Response,
  ) {
    const csv = await this.svc.exportCsv({
      action,
      resource,
      userId: userId ? Number(userId) : undefined,
    });
    res!.setHeader("Content-Type", "text/csv; charset=utf-8");
    res!.setHeader("Content-Disposition", 'attachment; filename="audit-logs.csv"');
    res!.send(csv);
  }
}
