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
    private readonly taskService: TaskService,
  ) {}

  /** 列表：官方 + 自定义，官方在前、其余按创建时间倒序。 */
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

  async create(dto: CreateTaskTemplateDto): Promise<TaskTemplate> {
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
    });
    return this.repo.save(entity);
  }

  /**
   * 「从模板创建」：把模板 config 展开为默认值、请求体字段显式覆盖，落库前用
   * CreateTaskDto 语义校验，复用 TaskService.create 生成可运行任务。
   * body 至少含 `name`（新任务名），其余任意 CreateTaskDto 字段可选覆盖。
   * templateId 键从 body 剥离（由 :id 决定，防越权指定他模板）。
   */
  async instantiate(id: string, body: Record<string, unknown>): Promise<Task> {
    const tpl = await this.findOne(id);
    const overrides: Record<string, unknown> = { ...(body ?? {}) };
    delete overrides.templateId;
    const merged = expandTemplateConfigIntoTaskDto(tpl.config, overrides);
    const dto = await assertValidCreateTaskPayload(merged);
    return this.taskService.create(dto);
  }

  async remove(id: string): Promise<void> {
    const tpl = await this.findOne(id);
    if (tpl.isOfficial || OFFICIAL_TEMPLATE_KEYS.includes(tpl.key)) {
      throw new ForbiddenException("官方模板不可删除");
    }
    await this.repo.delete({ id });
  }
}
