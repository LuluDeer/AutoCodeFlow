import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

export enum ExecutorPackageType {
  NODE = "node",
  PYTHON = "python",
  UNIVERSAL = "universal",
}

export enum ExecutorPackageStatus {
  ACTIVE = "active",
  DEPRECATED = "deprecated",
  UPLOADING = "uploading",
}

@Entity("executor_packages")
@Index(["name", "version", "type"], { unique: true })
export class ExecutorPackage {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 255 })
  name: string;

  @Column({ type: "varchar", length: 64 })
  version: string;

  @Column({
    type: "enum",
    enum: ExecutorPackageType,
    default: ExecutorPackageType.UNIVERSAL,
  })
  type: ExecutorPackageType;

  @Column({ type: "varchar", length: 128, nullable: true })
  platform: string;

  /** Filename on disk (includes checksum prefix, unique) */
  @Column({ type: "varchar", length: 256, nullable: true })
  filename: string;

  /** Absolute file path on the server */
  @Column({ type: "varchar", length: 1024 })
  filePath: string;

  /** Original filename at upload time */
  @Column({ type: "varchar", length: 256, nullable: true })
  originalFilename: string;

  /** MIME type of the uploaded file */
  @Column({ type: "varchar", length: 128, nullable: true })
  mimeType: string;

  @Column({ type: "bigint", default: 0 })
  fileSize: number;

  @Column({ type: "varchar", length: 64, nullable: true })
  checksum: string;

  @Column({ type: "text", nullable: true })
  description: string;

  @Column({
    type: "enum",
    enum: ExecutorPackageStatus,
    default: ExecutorPackageStatus.ACTIVE,
  })
  status: ExecutorPackageStatus;

  @Column({ type: "varchar", length: 255, nullable: true })
  uploadedBy: string;

  /** Push history (appended on each executor push-result callback) */
  @Column({ type: "jsonb", default: [] })
  pushHistory: Array<{
    executorId: string;
    status: "downloaded" | "failed";
    version: string;
    error?: string;
    timestamp: string;
  }>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
