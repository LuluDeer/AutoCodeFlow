import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from "typeorm";

@Entity("config_history")
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

  @Column()
  action: "create" | "update" | "delete";

  @Column({ nullable: true })
  userId: string;

  @Column({ nullable: true })
  username: string;

  @Column({ nullable: true })
  ipAddress: string;

  @CreateDateColumn()
  createdAt: Date;
}
