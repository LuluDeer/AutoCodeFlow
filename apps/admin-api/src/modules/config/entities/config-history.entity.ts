import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from "typeorm";

@Entity("config_history")
@Index(["configKey"])
@Index(["configKey", "createdAt"])
export class ConfigHistory {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  configKey: string;

  @Column({ type: "text", nullable: true })
  oldValue: string;

  @Column({ type: "text", nullable: true })
  newValue: string;

  @Column({ nullable: true })
  description: string;

  // WIKI-OPT-2（迁移 1790000000018）：历史行的元数据快照。存量行为
  // NULL = 元数据不可知（迁移前只记录 value/description）——读面掩码与
  // 回滚对 NULL 行沿用旧推断（按当前配置行 isSecret / 默认值
  // "string"/false），不要把 NULL 当 false 处理。
  @Column({ nullable: true })
  valueType: string | null;

  @Column({ nullable: true })
  isSecret: boolean | null;

  // FEAT-08: 'rollback' marks entries written by the rollback endpoint itself
  // (one row per rollback, both for value-restore and create-entry deletion).
  // DB column is a plain VARCHAR (no CHECK constraint) — see migration
  // 1789000000001 — so the extra value needs no DDL change.
  @Column()
  action: "create" | "update" | "delete" | "rollback";

  // PK-21（DEEP_REVIEW 0ef3bbe）：与全库其余 userId（users.id / audit_logs /
  // project_members / api_keys / refresh_tokens 的 integer）对齐；DB 列由
  // 迁移 1790000000024 从 VARCHAR ALTER 为 integer。
  @Column({ nullable: true })
  userId: number | null;

  @Column({ nullable: true })
  username: string;

  @Column({ nullable: true })
  ipAddress: string;

  @CreateDateColumn()
  createdAt: Date;
}
