import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
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
// 清单导入端点（本轮）：请求体 = 一份 manifest.json（或 registry 里的一条）。
import { ImportTaskTemplateManifestDto } from "./dto/import-task-template-manifest.dto";
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
// F-52（UIAUDIT P2-1）：换 ParseUuidShapePipe（F-41 先例）——原生 ParseUUIDPipe
// 一是 400 裸英文（errorCode:null，与全站 INVALID_VALUE_FORMAT 封套漂移），
// 二是只认 RFC 9562 版本位（PROJECT-UUID-01 同款陷阱：任何版本位为 0 的合法
// 形态 id 都会被拒）。
import { ParseUuidShapePipe } from "../../common/pipes/parse-uuid-shape.pipe";

/**
 * CORE-03：任务模板端点（管理台，全部走全局 JwtAuthGuard）。
 *
 *  GET    /api/task-templates        列表（官方 + 自定义）
 *  GET    /api/task-templates/:id     单个（表单预填取 config）
 *  POST   /api/task-templates         新建自定义模板（config 经 CreateTaskDto 校验）
 *  POST   /api/task-templates/import  导入清单（manifest.json / registry 条目）落成模板行
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
  one(@Param("id", ParseUuidShapePipe) id: string): Promise<TaskTemplate> {
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

  /**
   * **清单导入**：把一份 `manifest.json`（或 `docs/skills/registry.json` 里的一条）
   * 校验后落成一行 `task_templates`。
   *
   * 这是契约文档 `docs/skills/manifest-contract.md` 的第四步（校验 → 导入 →
   * 落库 → 审计）；此前只做到「清单 + 守卫 + 生成式 registry」。
   *
   * ## 为什么它不是「插件装载」
   *
   * 清单是**声明式产物**：键集合封闭（多一个键即 400），**不携带可执行 hook**
   * ——`glueSource` 写进清单会被判成未知键。可执行内容走 `config`（请求体字段，
   * 或官方 key 对应的常量），落库进 `task_templates.config`。所以本端点做的全是
   * 「校验 / 解析 / 按 key 唯一落库」，没有一步会执行清单里的任何东西。
   *
   * ## 请求体为什么是「裸清单」而不是 `{ manifest: {...} }`
   *
   * `curl --data @docs/skills/templates/health_check/manifest.json` 与
   * `jq '.templates[0]' docs/skills/registry.json` 应当**原样可投**。
   *
   * 运行时用 `Record<string, unknown>` 收**原始体**（与同文件 instantiate 端点
   * 同一取舍，PK-19）：键集合封闭性由 service 层的清单解析器判定，它给出的错误
   * 文本带契约理由（"未知键 glueSource（清单是机器契约…）"），比全局管道那串
   * 字段路径更有用。OpenAPI 侧用 `@ApiBody({ type: ImportTaskTemplateManifestDto })`
   * 契约化（否则前端拿不到形状）。
   */
  @WriteGuard("task-template", { scope: "authenticated" })
  @Post("import")
  @ApiOperation({
    description:
      "校验一份清单（manifest.json，或 registry.json 里的一条）并落成一行任务模板。" +
      "清单键集合封闭：出现未知键（含 hook/command/glueSource 这类可执行片段）即 400；" +
      "config 走 CreateTaskDto 语义校验。key（= 清单的 name）已存在即 409，不覆盖既有行。",
    summary: "导入任务模板清单（manifest.json / registry 条目）",
  })
  @ApiBody({
    type: ImportTaskTemplateManifestDto,
    description: "一份清单（或 registry 里的一条），可另附 config",
  })
  @ApiResponse({
    status: 201,
    description: "已落库的任务模板",
    type: TaskTemplateResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: "清单结构非法 / config 非法 / 非官方 key 且未提供 config",
  })
  @ApiResponse({ status: 409, description: "模板 key 已存在（不复用既有行）" })
  async importTemplate(
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthUser,
  ): Promise<TaskTemplate> {
    const imported = await this.svc.importManifest(body ?? {}, {
      id: user.id,
      username: user.username,
    });
    // 导入落证：与删除端点同款（action 字面量，域=task_template）。
    // detail 只放事实（版本 / 内容锚 / config 来源 / 落库 key），不放正文。
    await this.audit.log({
      username: user.username,
      action: "task_template.import",
      resource: "task_template",
      resourceId: imported.template.id,
      detail: {
        key: imported.template.key,
        version: imported.manifest.version,
        contentHash: imported.contentHash,
        configSource: imported.configSource,
      },
    });
    return imported.template;
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
    @Param("id", ParseUuidShapePipe) id: string,
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
    @Param("id", ParseUuidShapePipe) id: string,
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
