import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { TaskTemplateService } from "./task-template.service";
import { CreateTaskTemplateDto } from "./dto/create-task-template.dto";
import { TaskTemplate } from "./entities/task-template.entity";

/**
 * CORE-03：任务模板端点（管理台，全部走全局 JwtAuthGuard）。
 *
 *  GET    /api/task-templates        列表（官方 + 自定义）
 *  GET    /api/task-templates/:id     单个（表单预填取 config）
 *  POST   /api/task-templates         新建自定义模板（config 经 CreateTaskDto 校验）
 *  POST   /api/task-templates/:id/instantiate  从模板一键建任务（config 展开为默认、body 覆盖）
 *  DELETE /api/task-templates/:id     删除自定义模板（官方模板 403）
 *
 * 缩范围说明（见 PLAN-CLAIMS）：计划书 ② 原拟「POST /tasks 支持 body 带 templateId」，
 * 因 task.service.ts 为并行会话 003（ARCH-21）活跃足迹，为遵守避让纪律改由本独占
 * 端点承担同语义（模板 config 作默认、显式字段覆盖、复用 TaskService.create）。
 */
@ApiTags("Task Templates")
@ApiBearerAuth("JWT")
@Controller("task-templates")
export class TaskTemplateController {
  constructor(private readonly svc: TaskTemplateService) {}

  @Get()
  @ApiOperation({
    summary: "List task templates (official + custom)",
    description:
      "Returns all task templates. Official presets (seeded by migration, aligned " +
      "with the MCP `TASK_TEMPLATES`) come first; user-created custom templates follow.",
  })
  @ApiResponse({ status: 200, description: "Template list", type: [TaskTemplate] })
  list(): Promise<TaskTemplate[]> {
    return this.svc.findAll();
  }

  @Get(":id")
  @ApiOperation({
    summary: "Get one task template",
    description:
      "Used by the create-task form to prefetch a template's `config` for prefilling.",
  })
  @ApiParam({ name: "id", description: "Template UUID" })
  @ApiResponse({ status: 200, description: "Template", type: TaskTemplate })
  @ApiResponse({ status: 404, description: "Template not found" })
  one(@Param("id", ParseUUIDPipe) id: string): Promise<TaskTemplate> {
    return this.svc.findOne(id);
  }

  @Post()
  @ApiOperation({
    summary: "Create a custom task template",
    description:
      "The `config` object is validated against CreateTaskDto semantics before " +
      "persisting; a stray/invalid field is rejected with 400.",
  })
  @ApiResponse({ status: 201, description: "Created custom template", type: TaskTemplate })
  @ApiResponse({ status: 400, description: "Invalid config / key" })
  @ApiResponse({ status: 409, description: "Template key already exists" })
  create(@Body() dto: CreateTaskTemplateDto): Promise<TaskTemplate> {
    return this.svc.create(dto);
  }

  @Post(":id/instantiate")
  @ApiOperation({
    summary: "Create a runnable task from a template (one-click clone)",
    description:
      "Expands the template's config as defaults and overlays the request body " +
      "(explicit fields win; at least `name` is required). The merged payload is " +
      "validated against CreateTaskDto and created via the standard task path.",
  })
  @ApiParam({ name: "id", description: "Template UUID" })
  @ApiResponse({ status: 201, description: "Created task" })
  @ApiResponse({ status: 400, description: "Missing name / invalid merged payload" })
  @ApiResponse({ status: 404, description: "Template not found" })
  instantiate(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.svc.instantiate(id, body ?? {});
  }

  @Delete(":id")
  @ApiOperation({
    summary: "Delete a custom task template",
    description: "Official templates cannot be deleted (403).",
  })
  @ApiParam({ name: "id", description: "Template UUID" })
  @ApiResponse({ status: 200, description: "Deleted" })
  @ApiResponse({ status: 403, description: "Official template cannot be deleted" })
  @ApiResponse({ status: 404, description: "Template not found" })
  async remove(@Param("id", ParseUUIDPipe) id: string): Promise<{ ok: true }> {
    await this.svc.remove(id);
    return { ok: true };
  }
}
