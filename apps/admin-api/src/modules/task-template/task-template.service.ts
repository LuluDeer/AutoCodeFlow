import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
// LANG-ERR-01：用户可见失败抛稳定码 + 参数（文案由前端按用户语言翻译）。
import { AppError } from "../../common/errors/app-error";
import { TaskService } from "../task/task.service";
import { Task } from "../task/entities/task.entity";
import { TaskTemplate } from "./entities/task-template.entity";
import { CreateTaskTemplateDto } from "./dto/create-task-template.dto";
import {
  assertValidCreateTaskPayload,
  assertValidTaskTemplateConfig,
  buildTemplateOwnerKey,
  expandTemplateConfigIntoTaskDto,
  isTemplateOwner,
  suggestTemplateKey,
  type TemplateOwnerRef,
} from "./task-template.util";
import {
  parseTemplateImportRequest,
  resolveImportConfig,
  resolveImportDisplay,
  templateManifestContentHash,
  type NormalizedTemplateManifest,
} from "./task-template.manifest";
import { OFFICIAL_TEMPLATE_KEYS } from "./task-template.constants";
import { UserRole } from "../users/entities/user.entity";

/**
 * 「清单导入」的结果：落库行 + 本次导入的**事实**（审计用）。
 *
 * 为什么不只返回实体：审计要记「导的是哪个版本、内容锚是什么、config 从哪来」，
 * 这三件事只有解析层知道（哈希口径见 `task-template.manifest.ts`）。把事实随
 * 结果一起回传，胜过在控制器里再解析一遍请求体。
 */
export interface ImportedTaskTemplate {
  template: TaskTemplate;
  manifest: NormalizedTemplateManifest;
  /** config 来源：请求体显式提供，还是按 key 取官方模板常量。 */
  configSource: "request" | "official";
  /** 清单内容锚（sha256，口径与 `docs/skills/registry.json` 的 contentHash 一致）。 */
  contentHash: string;
}

/**
 * 删除模板时的请求方身份（属主/管理员判定用）。
 *
 * R39-A1：`id` 现在是**必填**——属主判定按 user id（见 `isTemplateOwner`），
 * username 只用于历史行（裸 username）兼容。请求方缺 id 时判定恒为「非属主」
 * （fail-closed），绝不回退到比名字。
 */
export interface TemplateRequester extends TemplateOwnerRef {
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
    if (!tpl) throw new AppError("TASK_TEMPLATE_NOT_FOUND");
    return tpl;
  }

  /** 供 task.service 展开用：按 uuid 取 config（不存在 404）。 */
  async getTemplateConfig(id: string): Promise<Record<string, unknown>> {
    const tpl = await this.findOne(id);
    return tpl.config;
  }

  /**
   * 新建自定义模板。
   *
   * R39-A1：`creator` 收**身份对象**（id 权威、username 仅可读），落库为
   * `user:<id>|<username>` 属主键。此前收裸 username 字符串，导致删号后同名
   * 新号继承归属——编码规则见 `buildTemplateOwnerKey`。缺省（内部/系统调用）
   * 仍落 NULL（历史行语义：仅 ADMIN 可删）。
   */
  async create(
    dto: CreateTaskTemplateDto,
    creator?: TemplateOwnerRef,
  ): Promise<TaskTemplate> {
    // config 合法性：CreateTaskDto 语义校验，脏模板 400（不落库）。
    await assertValidTaskTemplateConfig(dto.config);

    const key = (dto.key && dto.key.trim()) || suggestTemplateKey(dto.name);
    const existing = await this.repo.findOne({ where: { key } });
    if (existing) {
      throw new AppError("TASK_TEMPLATE_KEY_EXISTS", { key });
    }

    const entity = this.repo.create({
      key,
      name: dto.name,
      description: dto.description ?? null,
      category: dto.category ?? null,
      config: dto.config,
      // 永远由本端点创建为自定义模板；官方仅由迁移 seed 产生。
      isOfficial: false,
      // R39-A1：属主键 = `user:<id>|<username>`（id 权威）。不再存裸 username：
      // username 可变（改名即失属主）且可回收（硬删后同名新号继承归属）。
      createdBy: creator ? buildTemplateOwnerKey(creator) : null,
    });
    return this.repo.save(entity);
  }

  /**
   * **清单导入**：把一份 `manifest.json`（或 registry 里的一条）落成
   * `task_templates` 行。
   *
   * 这是契约文档 `docs/skills/manifest-contract.md` 里**最后一步**的落库路径
   * （校验 → 导入 → 落库 → 审计），此前只做到「清单 + 守卫」。
   *
   * ## 为什么这里是「导入」而不是「插件装载」
   *
   * 清单不携带可执行 hook（封闭键集合，`glueSource` 写进清单就是 400），可执行
   * 内容走 `config`（请求体字段，或官方 key 对应的常量）。于是本方法做的三件事
   * 全是声明式的：**校验形状**、**解析可执行内容**、**按 key 唯一落库**——
   * 没有一步会执行清单里的任何东西。
   *
   * ## 为什么不需要迁移
   *
   * 落库字段全部是既有列（key/name/description/category/config/isOfficial/
   * createdBy，见 `entities/task-template.entity.ts`）。清单的 version /
   * capabilities / params / entrypoints 是**声明元数据**，本表没有列、也刻意
   * 不塞进 `config`（config 走的是 CreateTaskDto 白名单，塞进去会被 400）——
   * 它们的事实源就是 `docs/skills/registry.json`，落库侧只留内容锚（审计 detail
   * 的 contentHash）供对账。要「无损保存整份清单」才需要加列，那是另一件事。
   *
   * key 冲突即拒（409，复用既有 `TASK_TEMPLATE_KEY_EXISTS`）：导入是**幂等语义
   * 的创建**，不是 upsert——覆盖既有行会静默改掉别人正在用的模板。并发窗口里
   * 仍是 `uq_task_templates_key` 唯一索引兜底（与 create 同款：本方法不额外
   * 映射 23505，撞上即为真并发，行为与既有 create 一致）。
   */
  async importManifest(
    raw: unknown,
    creator?: TemplateOwnerRef,
  ): Promise<ImportedTaskTemplate> {
    // ① 清单形状（封闭键集合 + 各字段判据）：不合法即 400，且此刻还没碰 DB。
    const { manifest, explicitConfig } = parseTemplateImportRequest(raw);

    // ② 可执行内容：显式 config 优先，否则按 key 取官方常量；两处都没有 ⇒ 400
    //    （没有 config 的模板即使落库也跑不起来，不留"看起来能用"的死模板）。
    const { config, source } = resolveImportConfig(manifest, explicitConfig);
    // ③ 与 create 端点同源的 CreateTaskDto 语义校验（脏 config 400，不落库）。
    await assertValidTaskTemplateConfig(config);

    const key = manifest.name;
    const existing = await this.repo.findOne({ where: { key } });
    if (existing) {
      throw new AppError("TASK_TEMPLATE_KEY_EXISTS", { key });
    }

    const display = resolveImportDisplay(manifest);
    const entity = this.repo.create({
      key,
      name: display.name,
      description: manifest.description,
      category: display.category,
      config,
      // 与 create 一致：官方标记只由迁移 seed 产生，导入的永远是自定义行。
      isOfficial: false,
      createdBy: creator ? buildTemplateOwnerKey(creator) : null,
    });
    const template = await this.repo.save(entity);

    return {
      template,
      manifest,
      configSource: source,
      contentHash: templateManifestContentHash(manifest),
    };
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
    // A2（第二轮审计）：实例化防重。落库前 best-effort 预检查：同 name 任务
    // 已存在即 409，错误信息含任务名（前端可直接展示）。
    // 软删除行不拦（findOne 默认过滤 deleted）——**语义变化（技术债 A 组
    // 2026-10-01）**：迁移 1790000000050 起 tasks.name 有全局唯一索引（含
    // 软删除行），回收站里的同名任务不再挡预检查，但并发窗口外的落库会撞
    // idx_tasks_name_unique——TaskService.create 的 23505 兜底已按约束名转
    // 409（「Task with name ... already exists」），防重从 best-effort 升级
    // 为 DB 强保证；本预检查保留是为了拿更友好的中文文案。
    const duplicated = await this.taskRepo.findOne({
      where: { name: dto.name },
    });
    if (duplicated) {
      throw new AppError("TASK_TEMPLATE_INSTANTIATE_NAME_TAKEN", {
        name: dto.name,
        taskId: duplicated.id,
      });
    }
    return this.taskService.create(dto, user);
  }

  async remove(id: string, requester: TemplateRequester): Promise<void> {
    const tpl = await this.findOne(id);
    if (tpl.isOfficial || OFFICIAL_TEMPLATE_KEYS.includes(tpl.key)) {
      throw new AppError("TASK_TEMPLATE_OFFICIAL_READONLY");
    }
    // 属主或 ADMIN 才可删。createdBy=NULL（迁移 seed / 无主体写入）安全回退——仅 ADMIN。
    const isAdmin = requester.role === UserRole.ADMIN;
    if (tpl.createdBy == null) {
      if (!isAdmin) {
        throw new AppError("TASK_TEMPLATE_LEGACY_ADMIN_ONLY");
      }
    } else if (!isAdmin && !isTemplateOwner(tpl.createdBy, requester)) {
      // R39-A1：判定改走 `isTemplateOwner`——新键按 user id（删号后同名新号
      // id 不同 ⇒ 403），历史行（裸 username）仍按 username 比对（兼容路径，
      // 去掉它历史模板就会变成「谁都删不掉」）。
      throw new AppError("TASK_TEMPLATE_NOT_OWNER");
    }
    await this.repo.delete({ id });
  }
}
