import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm";
import { Application } from "./application.entity";

@Entity("application_versions")
@Index(["applicationId"])
// DB-004: (applicationId, version) 唯一索引，防止并发创建时同一应用出现重复版本号
@Index(["applicationId", "version"], { unique: true })
@Index(["createdAt"])
@Index(["sourceDeploymentId"])
export class ApplicationVersion {
  @PrimaryGeneratedColumn("uuid") id: string;

  @Column() applicationId: string;

  @ManyToOne(() => Application, { onDelete: "CASCADE" })
  @JoinColumn({ name: "applicationId" })
  application: Application;

  @Column() version: string;

  @Column({ nullable: true }) gitCommit: string | null;

  @Column({ type: "jsonb" }) snapshot: Record<string, any>;

  @Column({ nullable: true }) sourceDeploymentId: string | null;

  @Column({ default: "released" }) status: string;

  @Column({ nullable: true }) createdBy: string | null;

  @Column({ type: "text", nullable: true }) description: string | null;

  @CreateDateColumn() createdAt: Date;
}
