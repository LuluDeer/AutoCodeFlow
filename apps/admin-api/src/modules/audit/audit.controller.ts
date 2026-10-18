import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiOkResponse,
} from "@nestjs/swagger";
import { Response } from "express";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { UserRole } from "../users/entities/user.entity";
import { AuditService } from "./audit.service";
import { AuditQueryDto } from "./dto/audit-query.dto";
// ARCH-23 / N-12（2026-10-07 A1 批）：审计域响应契约。
import { PaginatedAuditLogsDto } from "./dto/audit-response.dto";

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
  @ApiOkResponse({ type: PaginatedAuditLogsDto })
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    description:
      "分页查询审计日志。PLAN-BACKEND-ARCHITECTURE §2.1（加性过渡，与 GET /tasks、GET /tasks/:id/executions、GET /tasks/executions/all 同款）：新增可选 `cursor` 参数——省略时走既有 OFFSET 分页，响应与之前**逐字节一致**（不含 nextCursor 键）；传入上一页响应的 `data.nextCursor` 时走 keyset 分页（(createdAt,id) 元组游标，行值比较，深翻页不再随 OFFSET 变慢），并在响应中**追加** `nextCursor`（null = 已到末页）。本端点排序恒为 createdAt DESC, id DESC，故游标可与全部过滤器（action/resource/resourceId/username/startTime/endTime/userId/result）自由组合——它们与游标条件取交集。非法游标返回 400（VALIDATION_FAILED），不会静默退回第一页。首次进入 keyset 模式请传空值 `?cursor=`。",
    summary: "分页查询审计日志（仅管理员）",
  })
  findAll(@Query() query: AuditQueryDto) {
    return this.svc.findAll({
      page: query.page,
      pageSize: query.pageSize,
      action: query.action,
      resource: query.resource,
      // AUTH-05: (resource, resourceId) pair filter — the scoped-down
      // replacement for the planned per-Project dimension (no Project entity
      // exists yet; AUTH-01 unclaimed).
      resourceId: query.resourceId,
      username: query.username,
      startTime: query.startTime,
      endTime: query.endTime,
      userId: query.userId,
      result: query.result,
      // §2.1：`undefined` = 走 OFFSET 分支（响应不含 nextCursor 键，逐字节不变）；
      // 传了才切 keyset。**不要**写成 `?? ""`——那会把每个不带游标的请求都推进
      // keyset 分支，直接破坏加性契约。
      cursor: query.cursor,
    });
  }

  @Get("export")
  @ApiOkResponse({
    description: "CSV 文本导出（Res 直传，最多 10 000 行）",
    content: { "text/csv": { schema: { type: "string" } } },
  })
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    description: "返回 CSV 文件附件。支持与列表接口相同的过滤条件。",
    summary: "导出审计日志为 CSV（最多 10 000 行，仅管理员）",
  })
  async exportCsv(@Query() query: AuditQueryDto, @Res() res?: Response) {
    const csv = await this.svc.exportCsv({
      action: query.action,
      resource: query.resource,
      resourceId: query.resourceId,
      username: query.username,
      startTime: query.startTime,
      endTime: query.endTime,
      userId: query.userId,
      result: query.result,
    });
    res!.setHeader("Content-Type", "text/csv; charset=utf-8");
    res!.setHeader(
      "Content-Disposition",
      'attachment; filename="audit-logs.csv"',
    );
    res!.send(csv);
  }
}
