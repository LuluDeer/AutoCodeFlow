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
@Index(["applicationId", "version"])
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
