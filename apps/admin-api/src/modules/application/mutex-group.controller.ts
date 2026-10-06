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
  @ApiOperation({
    summary: "List mutex groups (for app form dropdown & admin)",
  })
  @ApiOkResponse({ type: [MutexGroupResponseDto] })
  async findAll(): Promise<MutexGroupResponseDto[]> {
    return this.mutexGroupService.findAll();
  }

  @Post()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: "Create a mutex group" })
  @ApiCreatedResponse({ type: MutexGroupResponseDto })
  async create(
    @Body() dto: CreateMutexGroupDto,
  ): Promise<MutexGroupResponseDto> {
    return this.mutexGroupService.create(dto);
  }

  @Put(":id")
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "Update a mutex group (name / maxConcurrentPerDevice)",
  })
  @ApiOkResponse({ type: MutexGroupResponseDto })
  async update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateMutexGroupDto,
  ): Promise<MutexGroupResponseDto> {
    return this.mutexGroupService.update(id, dto);
  }

  @Delete(":id")
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: "Delete a mutex group (attached apps become ungrouped)",
  })
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
