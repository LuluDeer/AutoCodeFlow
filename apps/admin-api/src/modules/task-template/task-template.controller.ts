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
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  ApiOkResponse,
} from "@nestjs/swagger";
import { TaskTemplateService } from "./task-template.service";
import { CreateTaskTemplateDto } from "./dto/create-task-template.dto";
// PK-19: instantiate 覆盖体 Swagger 文档 DTO（运行时 @Body() 仍为 Record<string, unknown>）。
import { InstantiateTaskOverlayDto } from "./dto/instantiate-task-overlay.dto";
// B-3: 契约空壳修复——响应改标带 @ApiProperty 的 DTO（实体只 emit
// {type:'object',properties:{}}，前端生成 Record<string, never>）。
import {
  InstantiateTaskResponseDto,
  TaskTemplateResponseDto,
} from "./dto/task-template-response.dto";
import { TaskTemplate } from "./entities/task-template.entity";
import { WriteGuard } from "../../common/decorators/write-guard.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AuthUser } from "../../common/interfaces/auth-user.interface";
// D3-B-P2-2: 模板删除审计落证。
import { AuditService } from "../audit/audit.service";
import { SimpleOkResponseDto } from "../auth/dto/misc-response.dto";

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
  constructor(
    private readonly svc: TaskTemplateService,
    // D3-B-P2-2: 模板删除审计落证。
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({
    description:
      "返回全部任务模板。官方预置模板（由迁移脚本写入，与 MCP 的 `TASK_TEMPLATES` 对齐）在前，用户创建的自定义模板在后。",
    summary: "列出任务模板（官方 + 自定义）",
  })
  @ApiResponse({
    status: 200,
    description: "模板列表",
    type: [TaskTemplateResponseDto],
  })
  list(): Promise<TaskTemplate[]> {
    return this.svc.findAll();
  }

  @Get(":id")
  @ApiOperation({
    description: "供创建任务表单预取模板的 `config` 用于预填。",
    summary: "获取单个任务模板",
  })
  @ApiParam({ name: "id", description: "模板 UUID" })
  @ApiResponse({
    status: 200,
    description: "模板",
    type: TaskTemplateResponseDto,
  })
  @ApiResponse({ status: 404, description: "模板不存在" })
  one(@Param("id", ParseUUIDPipe) id: string): Promise<TaskTemplate> {
    return this.svc.findOne(id);
  }

  @WriteGuard("task-template", { scope: "authenticated" })
  @Post()
  @ApiOperation({
    description:
      "持久化前会按 CreateTaskDto 语义校验 `config` 对象；出现多余或非法字段将以 400 拒绝。",
    summary: "创建自定义任务模板",
  })
  @ApiResponse({
    status: 201,
    description: "已创建的自定义模板",
    type: TaskTemplateResponseDto,
  })
  @ApiResponse({ status: 400, description: "config / key 非法" })
  @ApiResponse({ status: 409, description: "模板 key 已存在" })
  create(
    @Body() dto: CreateTaskTemplateDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TaskTemplate> {
    // R39-A1：记录创建人**身份**（service 落成 `user:<id>|<username>` 属主键）。
    // 此前这里传 user.username，属主判定按可回收的 username 键 → 删号后同名
    // 新号继承删除权。
    return this.svc.create(dto, { id: user.id, username: user.username });
  }

  @WriteGuard("task-template", { scope: "authenticated" })
  @Post(":id/instantiate")
  @ApiOperation({
    description:
      "把模板的 config 展开为默认值，再叠加请求体（显式字段优先；至少需要 `name`）。合并后的载荷按 CreateTaskDto 校验，并走标准任务创建路径落库。",
    summary: "从模板创建可运行任务（一键克隆）",
  })
  @ApiParam({ name: "id", description: "模板 UUID" })
  // B-3: instantiate 201 契约最小面（此前零 schema——前端只能手写或丢弃类型）。
  @ApiResponse({
    status: 201,
    description: "已创建的任务（最小字段面：标识/状态/触发字段）",
    type: InstantiateTaskResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: "缺少 name / 合并后的载荷非法",
  })
  @ApiResponse({ status: 404, description: "模板不存在" })
  // PK-19（DEEP_REVIEW 0ef3bbe）: 此前 instantiate 用 Record<string, unknown> 无
  // @ApiBody，openapi 缺 requestBody。补 @ApiBody({ type: InstantiateTaskOverlayDto })
  //（运行时 @Body() 类型不变，自由 overlay 不被 whitelist 拦截）。
  @ApiBody({
    type: InstantiateTaskOverlayDto,
    description: "模板覆盖体（自由字段，合并后校验 CreateTaskDto）",
  })
  instantiate(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: Record<string, unknown>,
    // 第二轮审计（A1）：实例化此前不注入请求方，TaskService.create 拿不到
    // user → 落库 ownerUserId 恒 null，非 ADMIN 创建者对自己建的任务写面 403
    // （assertCanWrite 对 NULL 属主仅放行 ADMIN）。与同文件 create 端点同款。
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.instantiate(id, body ?? {}, user);
  }

  @WriteGuard("task-template", { scope: "authenticated" })
  @Delete(":id")
  @ApiOperation({
    description: "官方模板不可删除（403）。",
    summary: "删除自定义任务模板",
  })
  @ApiParam({ name: "id", description: "模板 UUID" })
  @ApiResponse({
    status: 403,
    description: "官方模板不可删除",
  })
  @ApiResponse({ status: 404, description: "模板不存在" })
  @ApiOkResponse({ type: SimpleOkResponseDto })
  async remove(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ ok: true }> {
    // 属主或 ADMIN 才可删；NULL 历史行仅 ADMIN。
    // R39-A1：必须带上 user.id——属主判定按 id（历史行才回退比 username）。
    await this.svc.remove(id, {
      id: user.id,
      username: user.username,
      role: user.role,
    });
    // D3-B-P2-2: 删除落证。
    await this.audit.log({
      username: user.username,
      action: "task_template.delete",
      resource: "task_template",
      resourceId: id,
    });
    return { ok: true };
  }
}
