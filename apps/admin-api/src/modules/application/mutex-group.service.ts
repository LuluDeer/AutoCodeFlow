import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { QueryFailedError, Repository } from "typeorm";
import { MutexGroup } from "./entities/mutex-group.entity";
import {
  CreateMutexGroupDto,
  UpdateMutexGroupDto,
} from "./dto/mutex-group.dto";
import { MutexGroupResponseDto } from "./dto/mutex-group-response.dto";

/**
 * R6（对齐 task.service 同名先例）：PG 唯一约束冲突（SQLSTATE 23505
 * unique_violation）。create/update 的同名预检查是 check-then-act，并发
 * 同名时两个请求都过检查、后落库者撞 unique(name)——不拦截会经全局过滤器
 * 裸 500，识别后统一转 409 ConflictException。
 */
function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err as QueryFailedError & { code?: string }).code === "23505"
  );
}

/**
 * MUTEX-01（应用互斥组）：组配置 CRUD。
 *
 * 读面供应用表单的下拉与组管理页消费；写面仅 ADMIN（控制器 @Roles 门）。
 * 删除组是低风险动作（applications.mutexGroupId FK ON DELETE SET NULL，
 * 应用自动回到「不参与互斥」；在途执行按创建时的组快照走完，调度侧消费的
 * 是 task_executions.mutexGroupId，无 FK、不受删除影响）——但组上仍挂着
 * 应用时给出冲突提示，避免用户在无感知的情况下解除一批应用的互斥约束
 * （显式传 force=true 才允许，删除后由 FK SET NULL 兜底）。
 */
@Injectable()
export class MutexGroupService {
  private readonly logger = new Logger(MutexGroupService.name);

  constructor(
    @InjectRepository(MutexGroup)
    private readonly repo: Repository<MutexGroup>,
  ) {}

  async create(dto: CreateMutexGroupDto): Promise<MutexGroup> {
    const name = dto.name.trim();
    const exists = await this.repo.findOne({ where: { name } });
    if (exists) {
      throw new ConflictException(`互斥组 "${name}" 已存在`);
    }
    const group = this.repo.create({
      name,
      maxConcurrentPerDevice: dto.maxConcurrentPerDevice ?? 1,
      // N-15：作用域默认 device（存量行为）
      scope: dto.scope ?? "device",
      description: dto.description?.trim() || null,
    });
    try {
      const saved = await this.repo.save(group);
      this.logger.log(
        `MUTEX-01: created mutex group "${saved.name}" (maxConcurrentPerDevice=${saved.maxConcurrentPerDevice})`,
      );
      return saved;
    } catch (err) {
      // 并发同名 TOCTOU：预检查之后撞 unique(name) → 409（不再裸 500）。
      if (isUniqueViolation(err)) {
        throw new ConflictException(`互斥组 "${name}" 已存在`);
      }
      throw err;
    }
  }

  /**
   * MUTEX-01：组列表。附带每组当前挂载的应用数。
   *
   * 为什么在服务层补 applicationCount（该字段自 MUTEX-01 起就在
   * MutexGroupResponseDto 里声明，但 findAll 一直返回裸实体 → 该字段恒
   * undefined，读面契约与实现脱节）：消费方（中台组管理页、`acf mutex list`）
   * 要靠它判断「删这个组会不会影响应用」——正是 remove() 里 409 那条规则所
   * 依赖的信息，用户在删之前就该看见。
   *
   * 单条 GROUP BY 聚合而非 N+1 逐组 COUNT：组数量虽小，但读面在列表页/CLI
   * 每次调用都会走，聚合成一次查询是零成本的正确形态。
   */
  async findAll(): Promise<MutexGroupResponseDto[]> {
    const groups = await this.repo.find({ order: { createdAt: "ASC" } });
    if (groups.length === 0) return [];
    const rows: Array<{ mutexGroupId: string; count: number }> =
      await this.repo.manager.query(
        `SELECT "mutexGroupId", COUNT(*)::int AS count
           FROM "applications"
          WHERE "mutexGroupId" IS NOT NULL
          GROUP BY "mutexGroupId"`,
      );
    const counts = new Map(rows.map((r) => [r.mutexGroupId, r.count]));
    return groups.map((g) => ({
      ...g,
      applicationCount: counts.get(g.id) ?? 0,
    }));
  }

  async update(id: string, dto: UpdateMutexGroupDto): Promise<MutexGroup> {
    const group = await this.repo.findOne({ where: { id } });
    if (!group) throw new NotFoundException(`互斥组 ${id} 不存在`);
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      const clash = await this.repo.findOne({ where: { name } });
      if (clash && clash.id !== id) {
        throw new ConflictException(`互斥组 "${name}" 已存在`);
      }
      group.name = name;
    }
    if (dto.maxConcurrentPerDevice !== undefined) {
      group.maxConcurrentPerDevice = dto.maxConcurrentPerDevice;
    }
    // N-15：作用域可改（改 global 即时收紧派发，改回 device 释放跨设备约束；
    // 在途 WAITING 由 sweep 重派自愈，无额外迁移动作）
    if (dto.scope !== undefined) {
      group.scope = dto.scope;
    }
    if (dto.description !== undefined) {
      group.description = dto.description?.trim() || null;
    }
    try {
      return await this.repo.save(group);
    } catch (err) {
      // 更名并发 TOCTOU：预检查已排除自身 id（clash.id !== id），且同名落本行
      // 自身不构成唯一冲突——此处 23505 只可能来自与其他行的并发同名 → 409。
      if (isUniqueViolation(err)) {
        throw new ConflictException(`互斥组 "${group.name}" 已存在`);
      }
      throw err;
    }
  }

  async remove(id: string, force = false): Promise<void> {
    const group = await this.repo.findOne({ where: { id } });
    if (!group) throw new NotFoundException(`互斥组 ${id} 不存在`);
    const attached = await this.repo.manager.query(
      `SELECT COUNT(*)::int AS count FROM "applications" WHERE "mutexGroupId" = $1`,
      [id],
    );
    const count = attached[0]?.count ?? 0;
    if (count > 0 && !force) {
      throw new ConflictException(
        `仍有 ${count} 个应用挂在该组上；删除将解除它们的互斥约束，请确认后带 force=true 重试`,
      );
    }
    await this.repo.remove(group);
    this.logger.warn(
      `MUTEX-01: mutex group "${group.name}" (${id}) deleted — ${count} attached application(s) ungrouped via FK SET NULL`,
    );
  }
}
