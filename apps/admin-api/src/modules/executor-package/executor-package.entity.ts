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

  /** 磁盘上存储的文件名（含校验和前缀，唯一） */
  @Column({ type: "varchar", length: 256, nullable: true })
  filename: string;

  /** 文件在服务器上的绝对路径 */
  @Column({ type: "varchar", length: 1024 })
  filePath: string;

  /** 上传时的原始文件名 */
  @Column({ type: "varchar", length: 256, nullable: true })
  originalFilename: string;

  /** 上传文件的 MIME 类型 */
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

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
