import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * AUTH-01（多租户 Project，第一批后端）：
 *
 * 单默认项目起步（用户已拍板）：迁移 1790000000007 种子一行
 * name='Default'、id=DEFAULT_PROJECT_ID；存量 tasks 由迁移 1790000000008
 * 回填到该行，applications/executors/executor_packages 保持 NULL（可空 =
 * 未分配，语义上归默认项目视图，见各 findAll 过滤面）。
 *
 * ProjectStatus（active/archived 等）本批不做——第一批只做实体 + CRUD +
 * 列表过滤面，状态机留给 Wave2 项目级角色（AUTH-02）一起演进。
 */
export const DEFAULT_PROJECT_ID = "00000000-0000-0000-0000-000000000001";
export const DEFAULT_PROJECT_NAME = "Default";

@Entity("projects")
@Index("UQ_projects_name", ["name"], { unique: true })
export class Project {
  @PrimaryGeneratedColumn("uuid") id: string;

  @Column() name: string;

  @Column({ nullable: true }) description: string;

  @CreateDateColumn() createdAt: Date;

  @UpdateDateColumn() updatedAt: Date;
}
