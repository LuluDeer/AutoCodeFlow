import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Put,
  Param,
  Delete,
  Query,
  UseGuards,
  Req,
  Res,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { Response } from "express";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiExtraModels,
  ApiParam,
  ApiQuery,
  ApiBody,
} from "@nestjs/swagger";
import { Request } from "express";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { UserRole } from "../users/entities/user.entity";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
// F-41（UIUX 审计 P1-2）：读面路由参数的 ID 形态校验——非 UUID 深链在进
// service/DB 前就被 400（第一道防线；全局 22P02 兜底映射见
// http-exception.filter）。projects.controller 同款管道先例。
import { ParseUuidShapePipe } from "../../common/pipes/parse-uuid-shape.pipe";
import {
  AuthUser,
  isApiKeyUser,
} from "../../common/interfaces/auth-user.interface";
import { TaskService } from "./task.service";
import { TaskWebhookService } from "./task-webhook.service";
import { CreateTaskDto } from "./dto/create-task.dto";
import { UpdateTaskDto } from "./dto/update-task.dto";
import { TriggerTaskDto } from "./dto/trigger-task.dto";
import { RollbackTaskDto } from "./dto/rollback-task.dto";
import { BatchTaskIdsDto } from "./dto/batch-task.dto";
import { ListTasksQueryDto } from "./dto/list-tasks-query.dto";
// E-1: 任务定义导入/导出（契约 DTO 与运行时请求体）
import { TaskExportPayloadDto } from "./dto/task-definition-export.dto";
import {
  ImportTaskDto,
  TaskImportResultDto,
} from "./dto/task-definition-import.dto";
// ARCH-23 / N-12: 任务域响应契约 DTO——把 31 个此前"只有 description 没有
// schema"的 2xx 补成具名 schema（前端 gen:api-types 的瓶颈在后端注解覆盖）。
// 注意 POST 端点无 @HttpCode 的实际状态是 201（历史声明 200 是漂移，本批按
// 实际状态落契约）；字段与 service 返回逐一对齐的口径见 task-response.dto.ts 头注。
import {
  BatchErrorItemDto,
  batchArrayOf,
  DeleteTaskResponseDto,
  ExecutionListItemDto,
  ExecutionLogsPageResponseDto,
  ExecutionReportResponseDto,
  ExecutionStatsResponseDto,
  ExecutionTimelineEntryDto,
  ExecutionReportSummaryDto,
  GitRollbackResponseDto,
  KillExecutionResponseDto,
  PaginatedExecutionListDto,
  PaginatedTaskListDto,
  SchedulerStatsResponseDto,
  SuggestScheduleResponseDto,
  TaskExecutionResponseDto,
  TaskResponseDto,
  TaskVersionDto,
  VersionDiffEntryDto,
  VersionDiffResponseSchema,
  WebhookDisableResponseDto,
  WebhookSecretResponseDto,
  WebhookStatusResponseDto,
} from "./dto/task-response.dto";
// P2-18: lastStatus @ApiQuery 的值域（与 TaskExecution.status 列共用口径）
import { ExecutionStatus } from "./entities/task-execution.entity";
import {
  AllExecutionsQueryDto,
  ExecutionLogsQueryDto,
  ExportExecutionsQueryDto,
  TaskExecutionsQueryDto,
} from "./dto/execution-query.dto";
import { SkipTimeout } from "../../common/decorators/skip-timeout.decorator";
import { AuditService } from "../audit/audit.service";
// OBS-03: level 查询参数的值域常量（与实体列/迁移/DTO 共用口径）
import { LOG_LEVEL_VALUES, type LogLevel } from "./log-level.util";
// SEC-09: 限流分域——中档 OPS_THROTTLE（触发/执行干预写面）与 SSE 豁免
// @SkipThrottle。装饰器求值期读取属 ARCH-27 显式豁免（W-22 同款，见
// src/config/throttle-profiles.ts 头注）。
import { SkipThrottle, Throttle } from "@nestjs/throttler";
import { OPS_THROTTLE } from "../../config/throttle-profiles";
import { WriteGuard } from "../../common/decorators/write-guard.decorator";

/**
 * OBS-03: level 查询参数的运行态兜底归一化（HTTP 边界已由全局
 * ValidationPipe 对 ExecutionLogsQueryDto.level 的 @IsIn 枚举校验拦截
 * 非法值为 400，且枚举严格大写；这里只为兼容大小写变体/防编程式调用方
 * 把脏值送进 SQL）。非法值返回 undefined（= 不过滤），与"未传 level"
 * 同一语义，绝不产生错误过滤结果。
 */
function parseLevelParam(level?: string): LogLevel | undefined {
  if (!level) return undefined;
  const normalized = level.toUpperCase();
  return (LOG_LEVEL_VALUES as readonly string[]).includes(normalized)
    ? (normalized as LogLevel)
    : undefined;
}

@ApiTags("Task Management")
@ApiBearerAuth("JWT")
// ApiExtraModels：batchArrayOf / VersionDiffResponseSchema 走 getSchemaPath
// 裸 $ref，引用的类不会被 type 直引路径自动注册，必须在此显式登记。
@ApiExtraModels(
  TaskResponseDto,
  TaskExecutionResponseDto,
  ExecutionListItemDto,
  BatchErrorItemDto,
  VersionDiffEntryDto,
  ExecutionTimelineEntryDto,
  ExecutionReportSummaryDto,
)
@UseGuards(JwtAuthGuard)
@Controller("tasks")
export class TaskController {
  constructor(
    private readonly taskService: TaskService,
    // FEAT-21: 任务 webhook 管理（enable/rotate/disable/status）——公开触发
    // 端点本体在 TaskWebhookController（/webhooks/tasks/:taskId，@Public）。
    private readonly taskWebhookService: TaskWebhookService,
    private readonly audit: AuditService,
  ) {}

  @WriteGuard("task", { scope: "authenticated" })
  @Post()
  @ApiOperation({
    description:
      "创建新的自动化任务。支持 cron、webhook 与事件三种触发方式。任务创建后处于暂停状态。",
    summary: "创建任务",
  })
  @ApiCreatedResponse({
    type: TaskResponseDto,
    description: "任务创建成功（初始为暂停状态）",
  })
  async create(
    @Body() dto: CreateTaskDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const result = await this.taskService.create(dto, user);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.create",
      resource: "task",
      resourceId: result.id,
      ip: req.ip,
    });
    return result;
  }

  // ── E-1: 任务定义导入/导出 ──────────────────────────────────────────────
  // 权限口径不新增语义：导出沿用任务读面（类级 JwtAuthGuard，同 GET /tasks/:id）；
  // 导入沿用任务创建面（WriteGuard authenticated + service.create 内既有校验
  // 链，与 POST /tasks 完全同档）。secrets 红线见 docs/api-reference.md 任务节。
  @WriteGuard("task", { scope: "authenticated" })
  @Post("import")
  @ApiOperation({
    description:
      "E-1：用 GET /tasks/:id/export 的载荷创建任务。校验走完整的 POST /tasks 创建链路。名称冲突绝不覆盖：追加 ' (imported)'，再依次尝试 ' (imported) 2'、' (imported) 3'……直到找到可用名称。密钥绝不参与传输（SEC-02 红线）：载荷中携带的 secrets 键会被忽略，导入的任务在无密钥状态下启动——warnings 中始终包含重新配置的提示。新任务初始为暂停状态。",
    summary: "导入任务定义（JSON 导出载荷）",
  })
  @ApiBody({ type: ImportTaskDto })
  @ApiCreatedResponse({
    type: TaskImportResultDto,
    description:
      "任务已导入（暂停状态）。warnings 中始终包含重新配置密钥的提示。",
  })
  @ApiResponse({
    status: 400,
    description:
      "载荷非法（缺少必填键、params 超大、未知字段（全局白名单）、cron/时区/枚举非法等）",
  })
  @ApiResponse({
    status: 403,
    description:
      "载荷指定的项目调用者无权写入（需要 ADMIN，或该项目的 editor/admin 角色）",
  })
  @ApiResponse({
    status: 409,
    description: "所有候选名称都与已有任务冲突（或其他唯一性冲突）",
  })
  async importDefinition(
    @Body() dto: ImportTaskDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const result = await this.taskService.importDefinition(dto, user);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.import",
      resource: "task",
      resourceId: result.taskId,
      detail: { name: result.name },
      ip: req.ip,
    });
    return result;
  }

  @Get()
  @ApiOperation({
    description:
      "获取任务列表，支持分页与搜索。可按状态过滤。PLAN-BACKEND-ARCHITECTURE §2.1（加性过渡，与 GET /tasks/:id/executions 同款）：新增可选 `cursor` 参数——省略时走既有 OFFSET 分页，响应与之前**逐字节一致**（不含 nextCursor 键）；传入上一页响应的 `data.nextCursor` 时走 keyset 分页（(createdAt,id) 元组游标，深翻页不再随 OFFSET 变慢），并在响应中**追加** `nextCursor`（null = 已到末页）。游标绑定默认排序 createdAt DESC, id DESC，故与 `sortBy` 或 `lastStatus` 同时给出会返回 400（不静默错乱）；非法游标同样 400（VALIDATION_FAILED），不会静默退回第一页。首次进入 keyset 模式请传空值 `?cursor=`。",
    summary: "列出任务",
  })
  @ApiQuery({
    name: "page",
    required: false,
    description: "页码，默认 1",
  })
  @ApiQuery({
    name: "pageSize",
    required: false,
    description: "每页条数，默认 20",
  })
  @ApiQuery({
    name: "status",
    required: false,
    description: "按状态过滤（active/paused/inactive）",
  })
  // P2-18: 最近一次执行状态过滤——对齐上方 status 块风格；值域与
  // TaskExecution.status 列一致（ExecutionStatus）。
  @ApiQuery({
    name: "lastStatus",
    required: false,
    enum: ExecutionStatus,
    description:
      "P2-18：过滤「最近一次执行」处于该状态的任务（每个任务取最新一行 task_executions：createdAt DESC、id DESC）。取值：pending/running/waiting/success/failed/timeout/killed/cancelled。最近一次执行仍在进行中（pending/running）时按原样匹配。以 EXISTS 子查询实现——可与其他列表过滤条件组合。",
  })
  @ApiQuery({
    name: "name",
    required: false,
    description:
      "仅按任务名称模糊搜索（向后兼容通道；CLI/MCP 使用它）。控制台搜索框改用 `q`，因为其占位符承诺搜索名称或描述。",
  })
  // FEAT-TASK-SEARCH: 控制台搜索框的关键字通道（name OR description）。
  // 与上面 `name` 的分工见 ListTasksQueryDto 的字段注释。
  @ApiQuery({
    name: "q",
    required: false,
    description:
      "同时按任务名称与描述做关键字搜索。LIKE 元字符（% 与 _）按字面匹配，因此搜索 `daily_report` 不会同时命中 `dailyXreport`。可与其他所有列表过滤条件组合。",
  })
  @ApiQuery({
    name: "runtime",
    required: false,
    description: "按运行时过滤（python/node/shell）",
  })
  @ApiQuery({
    name: "fields",
    required: false,
    description:
      "F-10：逗号分隔的投影白名单（例如 'id,name'）。只查询白名单内的轻量列——跳过 params/secrets/glueSource 等重型列。非法字段 → 400。",
  })
  // §2.1：keyset 游标（与 executions 端点同款参数）。显式声明以便契约里出现
  // ——虽然 ListTasksQueryDto 已带 @ApiPropertyOptional，但本端点的其余 query
  // 参数都在控制器侧以 @ApiQuery 逐一列出（历史风格），保持一致。
  @ApiQuery({
    name: "cursor",
    required: false,
    description:
      "不透明的 keyset 游标（上一页响应的 data.nextCursor）。省略时走原有 OFFSET 分页，响应与之前完全一致；传入时走 keyset 分支并追加 nextCursor。首次进入 keyset 模式传空值（?cursor=）。仅与默认排序组合——与 sortBy 或 lastStatus 同时给出返回 400。非法游标返回 400（VALIDATION_FAILED），不会静默退回第一页。",
  })
  @ApiOkResponse({
    type: PaginatedTaskListDto,
    description:
      "分页列表（list/items 双键，R-21）。默认投影 = 完整实体但密钥已掩码；?fields= 会裁剪 items（F-10）。带 cursor 时额外含 nextCursor。",
  })
  findAll(@Query() p: ListTasksQueryDto) {
    return this.taskService.findAll(p);
  }

  // SEC-09: 中档限流（触发/执行干预写面，OPS_THROTTLE 默认 30/min）
  // PK-20（DEEP_REVIEW 0ef3bbe）: /tasks/batch/* 为批量能力的 canonical 主路由
  // （与 task 资源 RESTful 风格一致）。并存的 /tasks-batch/*（TaskBatchController）
  // 已标记 deprecated——两套实现调用同一 TaskService 方法、同 body/响应/审计，
  // 无逻辑漂移；待前端/SDK 全量切换后删除 deprecated 控制器。
  @Throttle({ default: OPS_THROTTLE })
  @WriteGuard("task", {
    scope: "project-role",
    reason:
      "只做项目角色校验（assertCanOperate 仅显式拒绝 viewer），属主收紧待 ADR-013 产品拍板",
  })
  @Post("batch/trigger")
  @ApiOperation({
    description: "触发多个任务。部分失败不影响其他任务。",
    summary: "批量触发任务",
  })
  @ApiCreatedResponse({
    description:
      "各任务的触发结果（成功项 = 完整执行记录；失败项 = {id, error}）",
    schema: batchArrayOf(TaskExecutionResponseDto),
  })
  @ApiBody({
    description: "批量触发参数",
    schema: {
      example: {
        taskIds: ["task1", "task2", "task3"],
      },
    },
  })
  async batchTrigger(
    @Body() body: BatchTaskIdsDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const results = await Promise.all(
      body.taskIds.map((id) =>
        this.taskService
          .trigger(id, {}, user)
          .catch((err) => ({ id, error: err.message })),
      ),
    );
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.batch_trigger",
      resource: "task",
      detail: { taskIds: body.taskIds },
      ip: req.ip,
    });
    return results;
  }

  // R-17（DEEP_REVIEW 0ef3bbe）: 与 batch/trigger 同档补 OPS_THROTTLE 分域限流——
  // pause/resume/delete 同为「触发/执行干预写面」，SEC-09 分域矩阵归中档 30/min，
  // 此前三端点漏挂导致批量写面脱离限流窗口。
  @Throttle({ default: OPS_THROTTLE })
  @WriteGuard("task", {
    scope: "project-role",
    reason:
      "只做项目角色校验（assertCanOperate 仅显式拒绝 viewer），属主收紧待 ADR-013 产品拍板",
  })
  @Post("batch/pause")
  @ApiOperation({
    description: "暂停多个任务。部分失败不影响其他任务。",
    summary: "批量暂停任务",
  })
  @ApiCreatedResponse({
    description: "各任务的暂停结果（成功项 = 完整任务；失败项 = {id, error}）",
    schema: batchArrayOf(TaskResponseDto),
  })
  @ApiBody({
    description: "批量暂停参数",
    schema: {
      example: {
        taskIds: ["task1", "task2", "task3"],
      },
    },
  })
  async batchPause(
    @Body() body: BatchTaskIdsDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const results = await Promise.all(
      body.taskIds.map((id) =>
        this.taskService
          .pause(id, user)
          .catch((err) => ({ id, error: err.message })),
      ),
    );
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.batch_pause",
      resource: "task",
      detail: { taskIds: body.taskIds },
      ip: req.ip,
    });
    return results;
  }

  // R-17（DEEP_REVIEW 0ef3bbe）: 同 batch/pause——批量 resume 补 OPS_THROTTLE 分域限流。
  @Throttle({ default: OPS_THROTTLE })
  @WriteGuard("task", {
    scope: "project-role",
    reason:
      "只做项目角色校验（assertCanOperate 仅显式拒绝 viewer），属主收紧待 ADR-013 产品拍板",
  })
  @Post("batch/resume")
  @ApiOperation({
    description: "恢复多个任务。部分失败不影响其他任务。",
    summary: "批量恢复任务",
  })
  @ApiCreatedResponse({
    description: "各任务的恢复结果（成功项 = 完整任务；失败项 = {id, error}）",
    schema: batchArrayOf(TaskResponseDto),
  })
  @ApiBody({
    description: "批量恢复参数",
    schema: {
      example: {
        taskIds: ["task1", "task2", "task3"],
      },
    },
  })
  async batchResume(
    @Body() body: BatchTaskIdsDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const results = await Promise.all(
      body.taskIds.map((id) =>
        this.taskService
          .resume(id, user)
          .catch((err) => ({ id, error: err.message })),
      ),
    );
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.batch_resume",
      resource: "task",
      detail: { taskIds: body.taskIds },
      ip: req.ip,
    });
    return results;
  }

  // R-17（DEEP_REVIEW 0ef3bbe）: 同 batch/pause——批量 delete 补 OPS_THROTTLE 分域限流。
  @Throttle({ default: OPS_THROTTLE })
  @WriteGuard("task", { scope: "ownership" })
  @Post("batch/delete")
  @ApiOperation({
    description: "删除多个任务。部分失败不影响其他任务。",
    summary: "批量删除任务",
  })
  @ApiCreatedResponse({
    description:
      "各任务的删除结果（成功项 = {deleted: true}；失败项 = {id, error}）",
    schema: batchArrayOf(DeleteTaskResponseDto),
  })
  @ApiBody({
    description: "批量删除参数",
    schema: {
      example: {
        taskIds: ["task1", "task2", "task3"],
      },
    },
  })
  async batchDelete(
    @Body() body: BatchTaskIdsDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const results = await Promise.all(
      body.taskIds.map((id) =>
        // R-02: 透传 user——漏传时 assertCanWrite 的 ADMIN/属主判定双双
        // 不成立，批量删除对所有人恒 403（错误被 .catch 吞成 {id,error}）。
        this.taskService
          .remove(id, user)
          .catch((err) => ({ id, error: err.message })),
      ),
    );
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.batch_delete",
      resource: "task",
      detail: { taskIds: body.taskIds },
      ip: req.ip,
    });
    return results;
  }

  @Get("executions/all")
  @ApiOperation({
    description:
      "全局执行记录（跨任务）。PLAN-BACKEND-ARCHITECTURE §2.1（加性过渡，与 GET /tasks、GET /tasks/:id/executions 同款）：新增可选 `cursor` 参数——省略时走既有 OFFSET 分页，响应与之前**逐字节一致**（不含 nextCursor 键）；传入上一页响应的 `data.nextCursor` 时走 keyset 分页（(createdAt,id) 元组游标，行值比较，深翻页不再随 OFFSET 变慢），并在响应中**追加** `nextCursor`（null = 已到末页）。本端点排序恒为 createdAt DESC, id DESC，故游标可与全部过滤器（status/taskId/taskName/executorAddress/startTime/endTime）自由组合——它们与游标条件取交集。非法游标返回 400（VALIDATION_FAILED），不会静默退回第一页。首次进入 keyset 模式请传空值 `?cursor=`。",
    summary: "全局执行记录",
  })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "pageSize", required: false })
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "taskId", required: false })
  @ApiQuery({ name: "taskName", required: false })
  @ApiQuery({ name: "executorAddress", required: false })
  @ApiQuery({ name: "startTime", required: false })
  @ApiQuery({ name: "endTime", required: false })
  // §2.1：keyset 游标（与 GET /tasks、GET /tasks/:id/executions 同款参数）。
  // 显式声明是为了与本端点其余 query 参数的历史风格一致；DTO 侧
  // AllExecutionsQueryDto 也已带 @ApiPropertyOptional（白名单必需）。
  @ApiQuery({
    name: "cursor",
    required: false,
    description:
      "不透明的 keyset 游标（上一页响应的 data.nextCursor）。省略时走原有 OFFSET 分页，响应与之前完全一致；传入时走 keyset 分支并追加 nextCursor。首次进入 keyset 模式传空值（?cursor=）。可与全部过滤器组合，非法游标返回 400（VALIDATION_FAILED），不会静默退回第一页。",
  })
  @ApiOkResponse({
    type: PaginatedExecutionListDto,
    description: "全局执行记录（已排除大文本列）",
  })
  allExecutions(@Query() p: AllExecutionsQueryDto) {
    return this.taskService.getAllExecutions(p);
  }

  /**
   * 执行记录 CSV 导出（**流式**，`@Res()` library mode）。
   *
   * ## 路由顺序（本仓踩过的那类坑）
   *
   * `@Get("executions/export")` 必须声明在**所有 `:id/...` 路由之前**——
   * 同一控制器内 Nest/Express 按**声明顺序**注册，`:id/executions` 出现在前面
   * 时 `GET /tasks/executions/export` 仍能匹配它（`id="executions"` 且第二段
   * 须为 `executions`，此处第二段是 `export`，实际上不会误配）；真正会误配的
   * 是 `@Get(":id")`——它会把 `/tasks/executions` 整个当成任务 id。本端点与
   * `executions/all` 同处于 `:id` 之前（见上方 `@Get(":id")` 在 603 行），
   * 顺序沿用既有布局：所有 "executions/*" 字面量路由集中在中段。
   *
   * ## 为什么排除 @SkipTimeout 也不排除
   *
   * 5 万行 × 每页 1000 行的往返，实测（本机真 PG）总耗时在秒级；全局 30s
   * 预算对正常导出足够，而**保留**超时反而是必要的护栏——一个因为连接池排队/
   * 大 `errorMessage` 而卡住的导出不该永久占住一个连接。故这里**不加**
   * `@SkipTimeout`：真超时交由全局 408 处理（此时响应头可能已发出，客户端看到
   * 的是截断的 CSV——这比"假装成功"诚实，且截断点之后没有截断注释行，
   * 调用方用行数即可识别）。
   *
   * ## 鉴权
   *
   * `@Roles(UserRole.ADMIN)`：执行记录含 `errorMessage`（执行器上报的任意文本，
   * 可能带内部路径/凭据片段）、`executorAddress`、失败原因等敏感面。与
   * `GET /audit/export` 的收紧口径一致；列表端点 `GET /tasks/executions/all`
   * 保持全员可读（它是排障面），导出则是"把整张表带走"的批量外流面。
   */
  @Get("executions/export")
  @ApiOperation({
    description:
      "导出执行记录为 CSV 文件（UTF-8，RFC 4180）。支持与 GET /tasks/executions/all 完全相同的过滤条件（status/taskId/taskName/executorAddress/startTime/endTime）——两处共用同一份过滤装配。**流式输出**：按 (createdAt DESC, id DESC) 逐页拉取并分块写出，不把全量结果拼进内存。行数达上限（默认硬顶 5 万行，可用 limit 调小）时在文件末尾追加 `# truncated at N rows` 注释行，便于识别截断。单元格做 CSV 公式注入防护（以 = + - @ 制表符 回车 开头的值前缀单引号）。列：id/taskId/taskName/status/triggerType/executorId/executorAddress/createdAt/startTime/endTime/durationMs/retryCount/exitCode/failureReason/errorMessage。",
    summary: "导出执行记录为 CSV（流式，仅管理员）",
  })
  @ApiQuery({
    name: "status",
    required: false,
    description: "按执行状态过滤（同列表端点）",
  })
  @ApiQuery({ name: "taskId", required: false, description: "按任务 id 过滤" })
  @ApiQuery({
    name: "taskName",
    required: false,
    description: "按任务名模糊搜索（命中执行行自身或 tasks.name）",
  })
  @ApiQuery({
    name: "executorAddress",
    required: false,
    description: "按执行器地址模糊过滤",
  })
  @ApiQuery({
    name: "startTime",
    required: false,
    description: "仅返回在该时刻及之后创建的执行（ISO 8601）",
  })
  @ApiQuery({
    name: "endTime",
    required: false,
    description: "仅返回在该时刻及之前创建的执行（ISO 8601）",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description:
      "本次导出的行数上限（安全阀，不是分页）。可调小；超过硬顶（50000）按硬顶处理，达上限时 CSV 末尾追加截断注释行。",
  })
  // ARCH-23：非 JSON 成功载荷也必须声明 schema——`text/csv` 的内容是一个
  // 字符串，与 audit export 逐字同形（check:response-schema 按首个 content
  // 取 schema，缺了会被计成"未声明"）。
  @ApiOkResponse({
    description: "CSV 文本导出（Res 直传，流动写出，最多 50 000 行）",
    content: { "text/csv": { schema: { type: "string" } } },
  })
  @Roles(UserRole.ADMIN)
  async exportExecutions(
    @Query() query: ExportExecutionsQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="task-executions.csv"',
    );
    // 不缓冲：边拉边发给反代/浏览器（nginx 的 proxy_buffering 仍可能攒包，
    // 但应用侧不主动攒——X-Accel-Buffering 是给 nginx 的显式放行信号）。
    res.setHeader("X-Accel-Buffering", "no");

    // 客户端取消（关闭标签页/取消下载）→ 立刻停止拉库，不空跑剩下的页。
    const ac = new AbortController();
    res.on("close", () => ac.abort());

    /**
     * 背压处理：`res.write()` 返回 false = 内核发送缓冲已满。此时**必须**等
     * `drain` 再写下一块，否则后续数据全部堆进进程内存——那正是"流式"退化成
     * "更慢的全量拼接"的形态（也是 OOM 的真实成因）。`writableEnded` 守卫防
     * 止对已结束的响应写入（客户端中途断开后 Node 会抛 ERR_STREAM_WRITE_AFTER_END）。
     */
    const write = (chunk: string): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        if (res.writableEnded) {
          resolve();
          return;
        }
        const onError = (err: Error) => {
          res.off("drain", onDrain);
          reject(err);
        };
        const onDrain = () => {
          res.off("error", onError);
          resolve();
        };
        if (res.write(chunk)) {
          resolve();
          return;
        }
        res.once("drain", onDrain);
        res.once("error", onError);
      });

    try {
      await this.taskService.streamExecutionsCsv(
        {
          status: query.status,
          taskId: query.taskId,
          taskName: query.taskName,
          executorAddress: query.executorAddress,
          startTime: query.startTime,
          endTime: query.endTime,
        },
        write,
        // limit 只在"调小"方向生效——归一逻辑在 service，此处原样透传。
        { limit: query.limit, signal: ac.signal },
      );
    } finally {
      // 双保险：无论服务内部怎么收尾，响应都在这里关闭。已 end 过则幂等。
      if (!res.writableEnded) res.end();
    }
  }

  // ---- Compat aliases (by execution ID only) — used by acf-cli & mcp-server ----
  @Get("executions/:execId/logs")
  @ApiOperation({
    description:
      "GET /tasks/:id/executions/:execId/logs 的兼容别名——无需知道任务 ID，直接按执行自身的 ID 定位。acf-cli 与 mcp-server 使用它。",
    summary: "执行日志（按执行 ID）",
  })
  @ApiParam({ name: "execId", description: "执行记录 ID" })
  @ApiQuery({
    name: "fromLine",
    required: false,
    description: "起始行号，默认 0",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "每页行数，默认 500，最多 2000",
  })
  @ApiQuery({
    name: "level",
    required: false,
    enum: LOG_LEVEL_VALUES,
    description:
      "按推断出的日志级别过滤（在 SQL 层完成）；级别未知（NULL）的行会被排除。指定 level 时，fromLine 是过滤后序列内的偏移，totalLines 是过滤后的条数。",
  })
  @ApiOkResponse({ type: ExecutionLogsPageResponseDto })
  executionLogsByExecId(
    @Param("execId", ParseUuidShapePipe) execId: string,
    @Query() query: ExecutionLogsQueryDto,
  ) {
    return this.taskService.getExecutionLogs(
      execId,
      query.fromLine ? parseInt(query.fromLine, 10) || 0 : 0,
      query.limit ? Math.min(parseInt(query.limit, 10) || 500, 2000) : 500,
      parseLevelParam(query.level),
    );
  }

  @Get("executions/:execId")
  @ApiOperation({
    description:
      "GET /tasks/:id/executions/:execId 的兼容别名——无需知道任务 ID，直接按执行自身的 ID 定位。acf-cli 与 mcp-server 使用它。",
    summary: "执行详情（按执行 ID）",
  })
  @ApiParam({ name: "execId", description: "执行记录 ID" })
  @ApiOkResponse({ type: TaskExecutionResponseDto })
  executionByExecId(@Param("execId", ParseUuidShapePipe) execId: string) {
    return this.taskService.getExecution(execId);
  }

  @Get("scheduler/stats")
  @ApiOperation({ summary: "调度器状态" })
  @ApiOkResponse({ type: SchedulerStatsResponseDto })
  async schedulerStats() {
    return this.taskService.getSchedulerStats();
  }

  @Get(":id/stats")
  @ApiOperation({
    description: "获取任务的执行统计：成功率、平均耗时与最近 20 次执行。",
    summary: "任务执行统计",
  })
  @ApiParam({ name: "id", description: "任务 ID" })
  @ApiOkResponse({
    type: ExecutionStatsResponseDto,
    description:
      "FIX-5.1 起 successRate/succeeded/failed 均为全量执行口径；recentSuccessRate 仍保留最近 20 次窗口",
  })
  getStats(@Param("id", ParseUuidShapePipe) id: string) {
    return this.taskService.getExecutionStats(id);
  }

  @WriteGuard("task", { scope: "ownership" })
  @Post(":id/suggest-schedule")
  @ApiOperation({
    description: "分析执行历史并返回 AI 推荐的 cron 表达式及推理说明",
    summary: "AI 调度建议",
  })
  @ApiParam({ name: "id", description: "任务 ID" })
  // A2-B: 透传 user——本端点声明 scope='ownership'，属主校验现由 service 执行。
  @ApiCreatedResponse({
    type: SuggestScheduleResponseDto,
    description: "AI 推荐结果；fallback=true 表示走了启发式降级路径",
  })
  async suggestSchedule(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.taskService.suggestSchedule(id, user);
  }

  @Get(":id")
  @ApiOperation({
    description: "获取单个任务的详细信息，包括配置、状态与执行统计。",
    summary: "任务详情",
  })
  @ApiParam({ name: "id", description: "任务 ID" })
  @ApiOkResponse({
    type: TaskResponseDto,
    description: "完整任务实体，密钥已掩码",
  })
  @ApiResponse({ status: 404, description: "任务不存在" })
  findOne(@Param("id", ParseUuidShapePipe) id: string) {
    return this.taskService.findOne(id);
  }

  // E-1: 任务定义导出——读面权限同 GET /tasks/:id（类级 JwtAuthGuard），
  // 走 @Res() library mode 直写附件（同 audit export 先例，绕过响应 envelope）。
  @Get(":id/export")
  @ApiOperation({
    description:
      'E-1：以附件形式返回任务定义快照（name/description/runtime + 解释器版本/GLUE 脚本/params/超时与重试/依赖/部署约束/维护窗口/触发配置/git 源/应用与项目键），并带 schemaVersion \\"1\\" 与 exportedAt。SEC-02 红线：密钥绝不进入导出内容（整个键都被剔除——值与键名一并不保留）。该载荷可被 POST /tasks/import 原样接受。读取权限与 GET /tasks/:id 一致。',
    summary: "将任务定义导出为可下载的 JSON 文件",
  })
  @ApiParam({ name: "id", description: "任务 ID" })
  @ApiOkResponse({
    type: TaskExportPayloadDto,
    description: "任务定义导出载荷（与 POST /tasks/import 的请求体同形态）",
  })
  @ApiResponse({ status: 404, description: "任务不存在" })
  async exportDefinition(
    @Param("id", ParseUuidShapePipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { filename, payload } = await this.taskService.exportDefinition(id);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(JSON.stringify(payload, null, 2));
  }

  @WriteGuard("task", { scope: "ownership" })
  @Patch(":id")
  @ApiOperation({
    description: "更新任务配置。注意：正在运行的任务不会立即受影响。",
    summary: "更新任务",
  })
  @ApiParam({ name: "id", description: "任务 ID" })
  @ApiOkResponse({
    type: TaskResponseDto,
    description: "更新成功（密钥已掩码）",
  })
  @ApiResponse({ status: 404, description: "任务不存在" })
  async update(
    @Param("id") id: string,
    @Body() dto: UpdateTaskDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const result = await this.taskService.update(id, dto, user);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.update",
      resource: "task",
      resourceId: id,
      ip: req.ip,
    });
    return result;
  }

  @WriteGuard("task", { scope: "ownership" })
  @Put(":id/glue")
  @ApiOperation({
    description: "更新 GLUE 脚本源码，用于在线编辑执行逻辑。",
    summary: "更新 GLUE 脚本",
  })
  @ApiParam({ name: "id", description: "任务 ID" })
  @ApiOkResponse({ type: TaskResponseDto, description: "脚本已更新" })
  @ApiResponse({ status: 404, description: "任务不存在" })
  @ApiBody({
    schema: {
      type: "object",
      properties: { source: { type: "string" }, language: { type: "string" } },
    },
  })
  async updateGlue(
    @Param("id") id: string,
    @Body() body: { source: string; language?: string },
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    // R-03: 透传 user——updateGlue 属配置/代码写面，service 侧做归属守卫
    const result = await this.taskService.updateGlue(
      id,
      body.source,
      body.language,
      user,
    );
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.updateGlue",
      resource: "task",
      resourceId: id,
      ip: req.ip,
    });
    return result;
  }

  @WriteGuard("task", { scope: "ownership" })
  @Delete(":id")
  @ApiOperation({
    description: "删除任务。正在运行的执行会被强制终止。",
    summary: "删除任务",
  })
  @ApiParam({ name: "id", description: "任务 ID" })
  @ApiOkResponse({
    type: DeleteTaskResponseDto,
    description: "已软删除（status=deleted + deletedAt）",
  })
  @ApiResponse({ status: 404, description: "任务不存在" })
  async remove(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const result = await this.taskService.remove(id, user);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.delete",
      resource: "task",
      resourceId: id,
      ip: req.ip,
    });
    return result;
  }

  // SEC-09: 中档限流（触发/执行干预写面，OPS_THROTTLE 默认 30/min）
  @Throttle({ default: OPS_THROTTLE })
  @WriteGuard("task", {
    scope: "project-role",
    reason:
      "只做项目角色校验（assertCanOperate 仅显式拒绝 viewer），属主收紧待 ADR-013 产品拍板",
  })
  @Post(":id/trigger")
  @ApiOperation({
    description:
      "手动触发任务执行。自定义 params 可覆盖任务默认值。NF-01: 双凭据面——用户 JWT 或携带 task:trigger 扩展域的 API Key （Authorization: Bearer acf_，guard 分流见 jwt-auth.guard/api-key-auth.helper）；响应契约与 JWT 面完全一致。",
    summary: "手动触发",
  })
  @ApiParam({ name: "id", description: "任务 ID" })
  // N-12: 实际返回完整 execution 行（201，POST 无 @HttpCode）——历史 inline
  // 示例 {taskId, executionId, status} 是旧契约漂移，按现行为落 schema。
  @ApiCreatedResponse({
    type: TaskExecutionResponseDto,
    description: "已创建执行记录并已入队",
  })
  @ApiResponse({
    // N-14：blockStrategy=discard 且存在同参数在跑/排队执行时拒绝触发
    //（闸门比较维度=任务+参数，异参不受影响）。
    status: 409,
    description:
      "触发被拒绝：已存在参数相同的活跃执行（blockStrategy=discard）",
  })
  async trigger(
    @Param("id") id: string,
    @Body() dto: TriggerTaskDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const result = await this.taskService.trigger(id, dto, user);
    // NF-01: API-Key 主体（CI/脚本免登录触发）——execution 行 triggerType
    // 已由 service 固定 manual；审计以 task.trigger_api 区分机器触发。
    if (isApiKeyUser(user)) {
      await this.audit.log({
        userId: user.userId,
        username: `api-key:${user.keyPrefix}`,
        action: "task.trigger_api",
        resource: "task",
        resourceId: id,
        detail: { apiKeyId: user.apiKeyId, taskId: id, scope: user.scope },
        ip: req.ip,
      });
      return result;
    }
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.trigger",
      resource: "task",
      resourceId: id,
      ip: req.ip,
    });
    return result;
  }

  // ── FEAT-21: 任务 webhook 管理 ──────────────────────────────────────────
  // secret 永不回传：status 只给 enabled+url；明文仅在 enable/rotate 响应中
  // 一次性回显（API Key create 的 plaintext-once 纪律）。权限与触发同口径
  // （service 内 assertCanOperate：viewer 拒、TASK-SCOPE-01 owner 档生效）。

  @Get(":id/webhook")
  @ApiOperation({
    description: "返回 `{ enabled, url }`。密钥从不返回。",
    summary: "获取任务 Webhook 状态",
  })
  @ApiOkResponse({
    type: WebhookStatusResponseDto,
    description: "Webhook 状态（密钥从不返回）",
  })
  webhookStatus(
    @Param("id", ParseUuidShapePipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.taskWebhookService.getStatus(id, user);
  }

  @WriteGuard("task", {
    scope: "project-role",
    reason:
      "webhook 启用属触发面干预写面（与 trigger 同 assertCanOperate 口径），属主收紧待 ADR-013 产品拍板",
  })
  @Post(":id/webhook/enable")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    description:
      "签发新的 Webhook 密钥，仅在 `secret` 中返回一次。对已启用的任务再次启用会轮换密钥。",
    summary: "启用任务 Webhook",
  })
  @ApiOkResponse({
    type: WebhookSecretResponseDto,
    description: "Webhook URL + 一次性密钥",
  })
  webhookEnable(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.taskWebhookService.enable(id, user, req.ip);
  }

  @WriteGuard("task", {
    scope: "project-role",
    reason:
      "webhook 密钥轮换属触发面干预写面（与 trigger 同 assertCanOperate 口径），属主收紧待 ADR-013 产品拍板",
  })
  @Post(":id/webhook/rotate")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    description: "旧密钥立即失效；新密钥只展示一次。",
    summary: "轮换任务 Webhook 密钥",
  })
  @ApiOkResponse({
    type: WebhookSecretResponseDto,
    description: "Webhook URL + 一次性密钥",
  })
  webhookRotate(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.taskWebhookService.rotate(id, user, req.ip);
  }

  @WriteGuard("task", {
    scope: "project-role",
    reason:
      "webhook 停用属触发面干预写面（与 trigger 同 assertCanOperate 口径），属主收紧待 ADR-013 产品拍板",
  })
  @Post(":id/webhook/disable")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    description: "清除密钥；此后带签名的调用会返回 401。",
    summary: "停用任务 Webhook",
  })
  @ApiOkResponse({
    type: WebhookDisableResponseDto,
    description: "停用后的响应：`{ enabled: false }`",
  })
  webhookDisable(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    return this.taskWebhookService.disable(id, user, req.ip);
  }

  @Get(":id/executions")
  @ApiOperation({
    description:
      "获取任务的执行历史列表。PLAN-BACKEND-ARCHITECTURE §2.1（加性过渡）：新增可选 `cursor` 参数——省略时走既有 OFFSET 分页，响应与之前**逐字节一致**（不含 nextCursor 键）；传入上一页响应的 `data.nextCursor` 时走 keyset 分页（(createdAt,id) 元组游标，深翻页不再随 OFFSET 变慢），并在响应中**追加** `nextCursor`（null = 已到末页）。非法游标返回 400（VALIDATION_FAILED），不会静默退回第一页。",
    summary: "执行记录",
  })
  @ApiParam({ name: "id", description: "任务 ID" })
  @ApiQuery({ name: "page", required: false, description: "页码" })
  @ApiQuery({ name: "limit", required: false, description: "每页条数" })
  @ApiQuery({
    name: "status",
    required: false,
    description: "按执行状态过滤",
  })
  @ApiQuery({
    name: "cursor",
    required: false,
    description:
      "不透明的 keyset 游标（上一页响应的 data.nextCursor）。省略时行为与引入该参数前完全一致。",
  })
  @ApiOkResponse({
    type: PaginatedExecutionListDto,
    description: "执行历史（已排除大文本列）",
  })
  executions(
    @Param("id", ParseUuidShapePipe) id: string,
    @Query() p: TaskExecutionsQueryDto,
  ) {
    return this.taskService.getExecutions(id, p);
  }

  @Get(":id/executions/:execId")
  @ApiOperation({
    description: "获取单次执行的详细信息，包括时间、状态与输出。",
    summary: "执行详情",
  })
  @ApiParam({ name: "id", description: "任务 ID" })
  @ApiParam({ name: "execId", description: "执行记录 ID" })
  @ApiOkResponse({
    type: TaskExecutionResponseDto,
    description: "完整执行行（包含 logs/aiAnalysis）",
  })
  @ApiResponse({ status: 404, description: "执行记录不存在" })
  execution(
    @Param("id", ParseUuidShapePipe) id: string,
    @Param("execId", ParseUuidShapePipe) execId: string,
  ) {
    return this.taskService.getExecution(execId, id);
  }

  @Get(":id/executions/:execId/report")
  @ApiOperation({
    description:
      "OBS-04：供执行详情页「分析报告 / 时间线」页签一次性取数的载荷。返回执行行（其时间戳驱动时间线）、由这些数据库时间戳映射出的 created→started→finished 时间线，以及该执行所在日期的 execution_reports 日聚合行（不存在时 report=null——前端做优雅降级）。",
    summary: "执行报告 + 时间线",
  })
  @ApiParam({ name: "id", description: "任务 ID" })
  @ApiParam({ name: "execId", description: "执行记录 ID" })
  @ApiOkResponse({ type: ExecutionReportResponseDto })
  @ApiResponse({ status: 404, description: "执行记录不存在" })
  executionReport(
    @Param("id", ParseUuidShapePipe) id: string,
    @Param("execId", ParseUuidShapePipe) execId: string,
  ) {
    return this.taskService.getExecutionReport(execId, id);
  }

  @Get(":id/executions/:execId/logs")
  @ApiOperation({
    description: "获取执行日志，按行分页以避免内存过载。",
    summary: "执行日志",
  })
  @ApiParam({ name: "id", description: "任务 ID" })
  @ApiParam({ name: "execId", description: "执行记录 ID" })
  @ApiQuery({
    name: "fromLine",
    required: false,
    description: "起始行号，默认 0",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "每页行数，默认 500，最多 2000",
  })
  @ApiQuery({
    name: "level",
    required: false,
    enum: LOG_LEVEL_VALUES,
    description:
      "按推断出的日志级别过滤（在 SQL 层完成）；级别未知（NULL）的行会被排除。指定 level 时，fromLine 是过滤后序列内的偏移，totalLines 是过滤后的条数。",
  })
  @ApiOkResponse({ type: ExecutionLogsPageResponseDto })
  async executionLogs(
    @Param("id", ParseUuidShapePipe) id: string,
    @Param("execId", ParseUuidShapePipe) execId: string,
    @Query() query: ExecutionLogsQueryDto,
  ) {
    await this.taskService.getExecution(execId, id);
    return this.taskService.getExecutionLogs(
      execId,
      query.fromLine ? parseInt(query.fromLine, 10) || 0 : 0,
      query.limit ? Math.min(parseInt(query.limit, 10) || 500, 2000) : 500,
      parseLevelParam(query.level),
    );
  }

  // SEC-09: SSE 长连接豁免限流——建连不进计数窗口，防 Dashboard 自动重连被误杀（N8 流语义不变）
  @SkipThrottle()
  @Get(":id/executions/:execId/logs/stream")
  @ApiOperation({
    description:
      "通过 Server-Sent Events 流式推送执行日志。完成时发送 [DONE] 事件。",
    summary: "执行日志 SSE 流",
  })
  @ApiParam({ name: "id", description: "任务 ID" })
  @ApiParam({ name: "execId", description: "执行记录 ID" })
  // N8: SSE 流的挂起时长等于任务剩余运行时长，必须豁免全局 30s 请求超时，
  // 否则 timeout() 会以 TimeoutError 掐断长任务日志流，且 HttpExceptionFilter
  // 会对已写出 SSE 头的响应再 status(408).json() 产出非法混合响应。
  // 同时本处理器走 @Res() library mode（Nest 不再接管返回值/不序列化），
  // 全局 ResponseInterceptor 的 envelope map 因此不会写入流——新增 SSE 类
  // 路由若改为 @Sse()/return Observable 则会破坏流，必须保持 @Res() 直写。
  @ApiResponse({
    status: 200,
    description: "SSE 流（Res 直传）",
    content: { "text/event-stream": { schema: { type: "string" } } },
  })
  @SkipTimeout()
  async streamLogs(
    @Param("id", ParseUuidShapePipe) id: string,
    @Param("execId", ParseUuidShapePipe) execId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // 任务作用域必须在写出 SSE 响应头前校验，避免跨任务 execution 流泄露。
    await this.taskService.getExecution(execId, id);
    // TASK-008: 在写出任何 SSE 响应头之前先占用并发槽位——超限时抛出的
    // ServiceUnavailableException 会被全局异常过滤器渲染为真正的 503，
    // 而不是半开的 SSE 流。
    const releaseSlot = this.taskService.acquireSseSlot(execId);

    try {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
      res.flushHeaders();

      const ac = new AbortController();
      req.on("close", () => ac.abort());

      const send = (line: string) => {
        res.write(`data: ${JSON.stringify(line)}\n\n`);
      };
      // QA3: idle keep-alive sink — a raw SSE comment frame (": ping\n\n").
      // Per the SSE spec clients ignore comment lines, so EventSource parsing
      // in admin-web is unaffected; the frame just keeps proxies whose
      // proxy_read_timeout is shorter than a silent execution from reaping
      // the stream. Shares the raw socket with `send`, so it must not run
      // after `done()` ends the response — the service only pings inside the
      // polling loop, which exits before `done` is invoked.
      const ping = () => {
        if (res.writableEnded) return;
        res.write(`: ping\n\n`);
      };
      const done = () => {
        res.write(`event: done\ndata: [DONE]\n\n`);
        res.end();
      };

      try {
        await this.taskService.streamExecutionLogs(
          execId,
          send,
          done,
          ac.signal,
          releaseSlot,
          ping,
        );
      } catch {
        res.write(`event: error\ndata: stream error\n\n`);
        res.end();
      }
    } finally {
      // TASK-008: 双保险释放——streamExecutionLogs 内部 finally 已释放，
      // 此处兜底防泄漏（release 幂等）。
      releaseSlot();
    }
  }

  // SEC-09: 中档限流（触发/执行干预写面，OPS_THROTTLE 默认 30/min）
  // PK-31（DEEP_REVIEW 0ef3bbe）: 与 rollbackToVersion（:id/versions/:versionId/rollback，
  // 快照回滚）语义不同——本端点回滚到指定 gitCommit（**代码版本**），仅 Git 类任务。
  // 两端点语义对照表见 docs/rollback-semantics.md。
  @Throttle({ default: OPS_THROTTLE })
  @WriteGuard("task", { scope: "ownership" })
  @Post(":id/rollback")
  @ApiOperation({
    description:
      "把任务回滚到指定 gitCommit 指向的**代码版本**（仅 Git 类任务适用）。与 /tasks/:id/versions/:versionId/rollback（按任务配置快照回滚）本质不同：本端点动的是仓库代码 checkout 到该 commit，非任务配置。对照表见 docs/rollback-semantics.md。",
    summary: "Git 回滚（按 commit SHA）",
  })
  @ApiParam({ name: "id", description: "任务 ID" })
  @ApiBody({
    description: "回滚参数",
    schema: {
      example: {
        gitCommit: "abc123",
        message: "Rollback to stable version",
      },
    },
  })
  @ApiCreatedResponse({
    type: GitRollbackResponseDto,
    description: "已在目标 commit 上派发新的执行（POST 默认 201）",
  })
  @ApiResponse({
    status: 400,
    description: "非 Git 任务不支持回滚",
  })
  async rollback(
    @Param("id") id: string,
    @Body() dto: RollbackTaskDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    // R-03: 透传 user——rollback 属配置写面（并触发执行），service 侧做归属守卫
    const result = await this.taskService.rollback(id, dto, user);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.rollback",
      resource: "task",
      resourceId: id,
      detail: { gitCommit: dto.gitCommit },
      ip: req.ip,
    });
    return result;
  }

  // SEC-09: 中档限流（触发/执行干预写面，OPS_THROTTLE 默认 30/min）
  // PK-31（DEEP_REVIEW 0ef3bbe）: 与 rollback（:id/rollback，gitCommit 代码回滚）
  // 语义不同——本端点回滚到指定任务配置**快照**（历史版本），不动仓库代码。
  // 两端点语义对照表见 docs/rollback-semantics.md。
  @Throttle({ default: OPS_THROTTLE })
  @WriteGuard("task", { scope: "ownership" })
  @Post(":id/versions/:versionId/rollback")
  @ApiOperation({
    description:
      "把任务**配置**整体回滚到指定历史版本快照（:versionId 路径参数）。与 /tasks/:id/rollback（按 gitCommit 回滚代码）本质不同：本端点动的是任务配置快照，不 checkout 仓库代码。对照表见 docs/rollback-semantics.md。",
    summary: "版本回滚（按任务配置快照）",
  })
  @ApiParam({ name: "id", description: "任务 ID" })
  @ApiParam({ name: "versionId", description: "版本 ID" })
  @ApiCreatedResponse({
    type: TaskResponseDto,
    description: "任务配置已回滚到该快照（POST 默认 201）",
  })
  @ApiResponse({ status: 404, description: "任务或版本不存在" })
  // PK-19（DEEP_REVIEW 0ef3bbe）: 本端点无请求体（回滚目标即 :versionId 路径参
  // 数）——显式 @ApiBody({ required: false }) 在 openapi 中钉住"无 body"语义，
  // 避免被误判为遗漏 requestBody。与 /tasks/:id/rollback（gitCommit）的区别见
  // docs/rollback-semantics.md（PK-31）。
  @ApiBody({
    required: false,
    description: "无请求体——回滚目标即 :versionId 路径参数",
  })
  async rollbackToVersion(
    @Param("id") id: string,
    @Param("versionId") versionId: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    // R-03: 透传 user——rollbackToVersion 整体覆盖任务配置，service 侧做归属守卫
    const result = await this.taskService.rollbackToVersion(
      id,
      versionId,
      user,
    );
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.rollbackToVersion",
      resource: "task",
      resourceId: id,
      detail: { versionId },
      ip: req.ip,
    });
    return result;
  }

  @Get(":id/versions")
  @ApiOperation({
    description: "获取任务的历史版本列表。",
    summary: "版本列表",
  })
  @ApiParam({ name: "id", description: "任务 ID" })
  @ApiOkResponse({
    type: [TaskVersionDto],
    description: "最近 100 个快照",
  })
  getVersions(@Param("id", ParseUuidShapePipe) id: string) {
    return this.taskService.getVersions(id);
  }

  @Get(":id/versions/:versionId1/compare/:versionId2")
  @ApiOperation({
    description: "比较两个版本之间的差异。",
    summary: "版本差异",
  })
  @ApiParam({ name: "id", description: "任务 ID" })
  @ApiParam({ name: "versionId1", description: "版本 ID 1" })
  @ApiParam({ name: "versionId2", description: "版本 ID 2" })
  @ApiOkResponse({
    description: "按字段键组织的差异——仅包含发生变化的字段，每项为 {old, new}",
    schema: VersionDiffResponseSchema,
  })
  @ApiResponse({ status: 404, description: "任务或版本不存在" })
  async compareVersions(
    @Param("id", ParseUuidShapePipe) id: string,
    @Param("versionId1") versionId1: string,
    @Param("versionId2") versionId2: string,
  ) {
    return this.taskService.compareVersions(id, versionId1, versionId2);
  }

  // SEC-09: 中档限流（触发/执行干预写面，OPS_THROTTLE 默认 30/min）
  @Throttle({ default: OPS_THROTTLE })
  @WriteGuard("task", {
    scope: "project-role",
    reason:
      "只做项目角色校验（assertCanOperate 仅显式拒绝 viewer），属主收紧待 ADR-013 产品拍板",
  })
  @Post(":id/pause")
  @ApiOperation({
    description: "暂停任务的调度执行。正在进行的执行不受影响。",
    summary: "暂停任务",
  })
  @ApiParam({ name: "id", description: "任务 ID" })
  @ApiCreatedResponse({
    type: TaskResponseDto,
    description: "已暂停（POST 默认 201）",
  })
  @ApiResponse({ status: 400, description: "任务已处于暂停状态" })
  @ApiResponse({ status: 404, description: "任务不存在" })
  async pause(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const result = await this.taskService.pause(id, user);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.pause",
      resource: "task",
      resourceId: id,
      ip: req.ip,
    });
    return result;
  }

  // SEC-09: 中档限流（触发/执行干预写面，OPS_THROTTLE 默认 30/min）
  @Throttle({ default: OPS_THROTTLE })
  @WriteGuard("task", {
    scope: "project-role",
    reason:
      "只做项目角色校验（assertCanOperate 仅显式拒绝 viewer），属主收紧待 ADR-013 产品拍板",
  })
  @Post(":id/resume")
  @ApiOperation({ description: "恢复任务的调度执行。", summary: "恢复任务" })
  @ApiParam({ name: "id", description: "任务 ID" })
  @ApiCreatedResponse({
    type: TaskResponseDto,
    description: "已恢复（POST 默认 201）",
  })
  @ApiResponse({ status: 400, description: "任务已在运行中" })
  @ApiResponse({ status: 404, description: "任务不存在" })
  async resume(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const result = await this.taskService.resume(id, user);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.resume",
      resource: "task",
      resourceId: id,
      ip: req.ip,
    });
    return result;
  }

  @WriteGuard("task", { scope: "ownership" })
  @Post(":id/executions/:execId/analyze")
  @ApiOperation({
    description: "对某次执行触发按需 AI 分析。结果会落库并返回。",
    summary: "AI 分析执行",
  })
  @ApiParam({ name: "id", description: "任务 ID" })
  @ApiParam({ name: "execId", description: "执行记录 ID" })
  @ApiCreatedResponse({
    type: TaskExecutionResponseDto,
    description: "已更新执行记录并持久化 aiAnalysis（POST 默认 201）",
  })
  async analyzeExecution(
    @Param("id") id: string,
    @Param("execId") execId: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    await this.taskService.getExecution(execId, id);
    // A2-B: 透传 user（此前未传，属主校验无从执行）。
    const result = await this.taskService.analyzeExecution(execId, user);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.analyzeExecution",
      resource: "task_execution",
      resourceId: execId,
      ip: req.ip,
    });
    return result;
  }

  // SEC-09: 中档限流（触发/执行干预写面，OPS_THROTTLE 默认 30/min）
  @Throttle({ default: OPS_THROTTLE })
  @WriteGuard("task", { scope: "ownership" })
  @Post(":id/executions/:execId/kill")
  @ApiOperation({
    description: "强制取消正在运行或等待中的执行记录。",
    summary: "取消执行",
  })
  @ApiParam({ name: "id", description: "任务 ID" })
  @ApiParam({ name: "execId", description: "执行记录 ID" })
  @ApiCreatedResponse({
    type: KillExecutionResponseDto,
    description: "已取消（POST 默认 201）",
  })
  @ApiResponse({
    status: 400,
    description: "执行当前状态不可取消",
  })
  @ApiResponse({ status: 404, description: "执行记录不存在" })
  async killExecution(
    @Param("id") id: string,
    @Param("execId") execId: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    await this.taskService.getExecution(execId, id);
    // A2-B: 透传 user（此前未传，属主校验无从执行）。
    const result = await this.taskService.killExecution(execId, user);
    await this.audit.log({
      userId: user?.id,
      username: user?.username,
      action: "task.killExecution",
      resource: "task_execution",
      resourceId: execId,
      ip: req.ip,
    });
    return result;
  }
}
