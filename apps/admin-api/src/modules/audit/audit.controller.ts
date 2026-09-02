import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { Response } from "express";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { UserRole } from "../users/entities/user.entity";
import { AuditService } from "./audit.service";
import { AuditQueryDto } from "./dto/audit-query.dto";

@ApiTags("audit")
@ApiBearerAuth("JWT")
@UseGuards(JwtAuthGuard)
@Controller("audit")
export class AuditController {
  constructor(private readonly svc: AuditService) {}

  // R4 P1-2: filters (action/resource/username/startTime/endTime) are declared
  // on AuditQueryDto; the previous split of @Query() PaginationDto + separate
  // @Query("...") params made every filtered request fail the
  // forbidNonWhitelisted check with 400.
  //
  // R5: audit logs contain sensitive operational data (usernames, IPs,
  // resource identifiers) — both list and export are ADMIN-only. The global
  // RolesGuard reads this metadata; no extra @UseGuards entry is needed.
  @Get()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Query audit logs with pagination (admin only)" })
  findAll(@Query() query: AuditQueryDto) {
    return this.svc.findAll({
      page: query.page,
      pageSize: query.pageSize,
      action: query.action,
      resource: query.resource,
      username: query.username,
      startTime: query.startTime,
      endTime: query.endTime,
      userId: query.userId,
    });
  }

  @Get("export")
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "Export audit logs as CSV (max 10 000 rows, admin only)",
    description:
      "Returns a CSV file attachment. Supports the same filters as the list endpoint.",
  })
  async exportCsv(@Query() query: AuditQueryDto, @Res() res?: Response) {
    const csv = await this.svc.exportCsv({
      action: query.action,
      resource: query.resource,
      username: query.username,
      startTime: query.startTime,
      endTime: query.endTime,
      userId: query.userId,
    });
    res!.setHeader("Content-Type", "text/csv; charset=utf-8");
    res!.setHeader(
      "Content-Disposition",
      'attachment; filename="audit-logs.csv"',
    );
    res!.send(csv);
  }
}
