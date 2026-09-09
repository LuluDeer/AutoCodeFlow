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

  // FEAT-08: 'rollback' marks entries written by the rollback endpoint itself
  // (one row per rollback, both for value-restore and create-entry deletion).
  // DB column is a plain VARCHAR (no CHECK constraint) — see migration
  // 1789000000001 — so the extra value needs no DDL change.
  @Column()
  action: "create" | "update" | "delete" | "rollback";

  @Column({ nullable: true })
  userId: string;

  @Column({ nullable: true })
  username: string;

  @Column({ nullable: true })
  ipAddress: string;

  @CreateDateColumn()
  createdAt: Date;
}
