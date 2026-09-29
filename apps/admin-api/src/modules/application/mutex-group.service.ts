import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { MutexGroup } from "./entities/mutex-group.entity";
import {
  CreateMutexGroupDto,
  UpdateMutexGroupDto,
} from "./dto/mutex-group.dto";

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
      description: dto.description?.trim() || null,
    });
    const saved = await this.repo.save(group);
    this.logger.log(
      `MUTEX-01: created mutex group "${saved.name}" (maxConcurrentPerDevice=${saved.maxConcurrentPerDevice})`,
    );
    return saved;
  }

  async findAll(): Promise<MutexGroup[]> {
    return this.repo.find({ order: { createdAt: "ASC" } });
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
    if (dto.description !== undefined) {
      group.description = dto.description?.trim() || null;
    }
    return this.repo.save(group);
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
