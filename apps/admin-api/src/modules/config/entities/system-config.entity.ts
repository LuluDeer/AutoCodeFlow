import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";

@Entity("system_configs")
export class SystemConfig {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  key: string;

  // DB-007: value 可能存 JSON（valueType=json）、AI 提示词等长文本，
  // 必须保持显式 text（无长度上限），勿改回 varchar 以免静默截断。
  @Column({ type: "text", nullable: true })
  value: string;

  @Column({ nullable: true })
  description: string;

  @Column({ default: "string" })
  valueType: string; // 'string' | 'number' | 'boolean' | 'json'

  @Column({ default: false })
  isSecret: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
