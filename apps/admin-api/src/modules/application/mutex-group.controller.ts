import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { UserRole } from "../users/entities/user.entity";
import { MutexGroupService } from "./mutex-group.service";
import {
  CreateMutexGroupDto,
  UpdateMutexGroupDto,
} from "./dto/mutex-group.dto";
import { MutexGroupResponseDto } from "./dto/mutex-group-response.dto";

/** MUTEX-01（应用互斥组）：组配置管理面（读面全登录用户，写面仅 ADMIN）。 */
@ApiTags("Application Management")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("mutex-groups")
export class MutexGroupController {
  constructor(private readonly mutexGroupService: MutexGroupService) {}

  @Get()
  @ApiOperation({ summary: "列出互斥组（供应用表单下拉与后台管理使用）" })
  @ApiOkResponse({ type: [MutexGroupResponseDto] })
  async findAll(): Promise<MutexGroupResponseDto[]> {
    return this.mutexGroupService.findAll();
  }

  @Post()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "创建互斥组" })
  @ApiCreatedResponse({ type: MutexGroupResponseDto })
  async create(
    @Body() dto: CreateMutexGroupDto,
  ): Promise<MutexGroupResponseDto> {
    return this.mutexGroupService.create(dto);
  }

  @Put(":id")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "更新互斥组（名称 / maxConcurrentPerDevice）" })
  @ApiOkResponse({ type: MutexGroupResponseDto })
  async update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateMutexGroupDto,
  ): Promise<MutexGroupResponseDto> {
    return this.mutexGroupService.update(id, dto);
  }

  @Delete(":id")
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "删除互斥组（已关联的应用会变为未分组）" })
  @ApiQuery({
    name: "force",
    required: false,
    type: Boolean,
    description: "组上仍挂应用时需显式 force=true 才允许删除",
  })
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: { ok: { type: "boolean", enum: [true] } },
      required: ["ok"],
    },
  })
  async remove(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("force") force?: string,
  ): Promise<{ ok: true }> {
    await this.mutexGroupService.remove(id, force === "true");
    return { ok: true };
  }
}
