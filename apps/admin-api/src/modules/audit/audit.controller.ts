import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiQuery } from "@nestjs/swagger";
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
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "pageSize", required: false })
  @ApiQuery({ name: "action", required: false })
  @ApiQuery({ name: "resource", required: false })
  findAll(
    @Query() pagination: PaginationDto,
    @Query("action") action?: string,
    @Query("resource") resource?: string,
  ) {
    return this.svc.findAll({
      page: pagination.page,
      pageSize: pagination.pageSize,
      action,
      resource,
    });
  }
}
