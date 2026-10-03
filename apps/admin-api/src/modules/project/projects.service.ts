import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  Project,
  DEFAULT_PROJECT_ID,
  DEFAULT_PROJECT_NAME,
} from "./project.entity";
import { CreateProjectDto, UpdateProjectDto } from "./project.dto";

/**
 * AUTH-01（多租户 Project，第一批后端）：Projects CRUD。
 *
 * 默认项目保护：remove/update 均拒绝触碰 Default 行（种子 uuid
 * DEFAULT_PROJECT_ID）——迁移回填与「未分配 = 默认项目」语义都锚定这行，
 * 删掉/改名会让存量数据的归属永久悬空。非默认项目 remove 不做占用清空
 * （FK ON DELETE SET NULL 已由 DB 兜底），本批没有项目成员概念，删除
 * 无需级联清理。
 */
@Injectable()
export class ProjectsService {
  constructor(
    @InjectRepository(Project)
    private readonly repo: Repository<Project>,
  ) {}

  async create(dto: CreateProjectDto): Promise<Project> {
    const row = this.repo.create({
      name: dto.name,
      description: dto.description ?? null,
    });
    return this.repo.save(row);
  }

  // P3-1：项目表为小表（组织级通常 < 百行），服务层保持全表 find——**响应面**
  // 的分页收敛在 controller（可选 page/pageSize 信封，不传参数仍全量数组）。
  // 无界的是线上载荷而非这一次 DB 读；若未来项目数到达千级，再把切片下推
  // 到 QueryBuilder skip/take（届时 page@Max(10000) 纪律已在 controller 备好）。
  async findAll(): Promise<Project[]> {
    return this.repo.find({ order: { createdAt: "ASC" } });
  }

  async findOne(id: string): Promise<Project> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Project ${id} not found`);
    return row;
  }

  async update(id: string, dto: UpdateProjectDto): Promise<Project> {
    if (
      id === DEFAULT_PROJECT_ID &&
      dto.name &&
      dto.name !== DEFAULT_PROJECT_NAME
    ) {
      throw new NotFoundException(
        "The Default project cannot be renamed or deleted",
      );
    }
    const row = await this.findOne(id);
    if (dto.name !== undefined) row.name = dto.name;
    if (dto.description !== undefined) row.description = dto.description;
    return this.repo.save(row);
  }

  async remove(id: string): Promise<{ deleted: boolean }> {
    if (id === DEFAULT_PROJECT_ID) {
      throw new NotFoundException(
        "The Default project cannot be renamed or deleted",
      );
    }
    const row = await this.findOne(id);
    await this.repo.delete(row.id);
    return { deleted: true };
  }
}
