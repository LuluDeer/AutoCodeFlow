import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { TaskService } from "../task/task.service";
import { Task } from "../task/entities/task.entity";
import { TaskTemplate } from "./entities/task-template.entity";
import { CreateTaskTemplateDto } from "./dto/create-task-template.dto";
import {
  assertValidCreateTaskPayload,
  assertValidTaskTemplateConfig,
  expandTemplateConfigIntoTaskDto,
  suggestTemplateKey,
} from "./task-template.util";
import { OFFICIAL_TEMPLATE_KEYS } from "./task-template.constants";
import { UserRole } from "../users/entities/user.entity";

/** E-P2-S1：删除模板时的请求方身份（属主/管理员判定用）。 */
export interface TemplateRequester {
  username: string;
  role: UserRole;
}

/**
 * CORE-03：任务模板 CRUD。官方模板（迁移 seed，isOfficial=true）只读；
 * 自定义模板由已登录用户创建、仅自定义可删。config 落库前用 CreateTaskDto
 * 语义校验（见 task-template.util）。
 */
@Injectable()
export class TaskTemplateService {
  constructor(
    @InjectRepository(TaskTemplate)
    private readonly repo: Repository<TaskTemplate>,
    // A2（第二轮审计）：同名任务查重需要 Task repo——task.name 列无唯一
    // 约束，TaskService.create 只对显式自带 id 的载荷查重（R6）。
    @InjectRepository(Task)
    private readonly taskRepo: Repository<Task>,
    private readonly taskService: TaskService,
  ) {}

  /** 列表：官方 + 自定义，官方在前、其余按创建时间倒序。 */
  // P3-1：任务模板为小表（官方模板 + 每用户少量自定义），全表 find 无需分页——
  // 刻意保持现状。
  async findAll(): Promise<TaskTemplate[]> {
    return this.repo.find({
      order: { isOfficial: "DESC", createdAt: "DESC" },
    });
  }

  async findOne(id: string): Promise<TaskTemplate> {
    const tpl = await this.repo.findOne({ where: { id } });
    if (!tpl) throw new NotFoundException("任务模板不存在");
    return tpl;
  }

  /** 供 task.service 展开用：按 uuid 取 config（不存在 404）。 */
  async getTemplateConfig(id: string): Promise<Record<string, unknown>> {
    const tpl = await this.findOne(id);
    return tpl.config;
  }

  async create(
    dto: CreateTaskTemplateDto,
    createdBy?: string,
  ): Promise<TaskTemplate> {
    // config 合法性：CreateTaskDto 语义校验，脏模板 400（不落库）。
    await assertValidTaskTemplateConfig(dto.config);

    const key = (dto.key && dto.key.trim()) || suggestTemplateKey(dto.name);
    const existing = await this.repo.findOne({ where: { key } });
    if (existing) {
      throw new ConflictException(`模板 key「${key}」已存在`);
    }

    const entity = this.repo.create({
      key,
      name: dto.name,
      description: dto.description ?? null,
      category: dto.category ?? null,
      config: dto.config,
      // 永远由本端点创建为自定义模板；官方仅由迁移 seed 产生。
      isOfficial: false,
      // E-P2-S1：记录创建人 username（供删除属主校验）。
      createdBy: createdBy ?? null,
    });
    return this.repo.save(entity);
  }

  /**
   * 「从模板创建」：把模板 config 展开为默认值、请求体字段显式覆盖，落库前用
   * CreateTaskDto 语义校验，复用 TaskService.create 生成可运行任务。
   * body 至少含 `name`（新任务名），其余任意 CreateTaskDto 字段可选覆盖。
   * templateId 键从 body 剥离（由 :id 决定，防越权指定他模板）。
   *
   * A1（第二轮审计）：透传请求方 user → TaskService.create 落 ownerUserId。
   * 此前恒缺省，实例化产物全部无主（ownerUserId=null），非 ADMIN 创建者
   * 对自己刚建的任务连改配置都会 403。user 为 undefined（内部调用/MCP 经
   * API-Key）时保持旧行为（create 内部落 null）。
   */
  async instantiate(
    id: string,
    body: Record<string, unknown>,
    user?: { id: number } | null,
  ): Promise<Task> {
    const tpl = await this.findOne(id);
    const overrides: Record<string, unknown> = { ...(body ?? {}) };
    delete overrides.templateId;
    const merged = expandTemplateConfigIntoTaskDto(tpl.config, overrides);
    const dto = await assertValidCreateTaskPayload(merged);
    // A2（第二轮审计）：实例化防重。name 列无唯一约束，连续「一键实例化」
    // 会产出任意多个同构任务（仅名字相同），且无任何拦截。落库前 best-effort
    // 预检查：同 name 任务已存在即 409，错误信息含任务名（前端可直接展示）。
    // 软删除行不拦（findOne 默认过滤 deleted）——回收站里的同名任务不挡新建。
    // 并发窗口下仍可能双写（name 无唯一索引、无 23505 兜底，与 R6 预检查
    // 同属尽力而为），可接受：该入口语义是「一键克隆」，本就不该并发连点。
    const duplicated = await this.taskRepo.findOne({
      where: { name: dto.name },
    });
    if (duplicated) {
      throw new ConflictException(
        `已存在同名任务「${dto.name}」（id=${duplicated.id}）；如需再次实例化，请在覆盖体中提供新的 name`,
      );
    }
    return this.taskService.create(dto, user);
  }

  async remove(id: string, requester: TemplateRequester): Promise<void> {
    const tpl = await this.findOne(id);
    if (tpl.isOfficial || OFFICIAL_TEMPLATE_KEYS.includes(tpl.key)) {
      throw new ForbiddenException("官方模板不可删除");
    }
    // E-P2-S1：属主或 ADMIN 才可删。历史行 createdBy=NULL 安全回退——仅 ADMIN。
    const isAdmin = requester.role === UserRole.ADMIN;
    if (tpl.createdBy == null) {
      if (!isAdmin) {
        throw new ForbiddenException("历史模板仅管理员可删除");
      }
    } else if (tpl.createdBy !== requester.username && !isAdmin) {
      throw new ForbiddenException("仅属主或管理员可删除该模板");
    }
    await this.repo.delete({ id });
  }
}
