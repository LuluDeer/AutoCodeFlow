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

  // PK-10（DEEP_REVIEW 0ef3bbe）: PG bigint（int8）经 node-pg 读回恒为 string
  // （`"12345"`），实体声明 fileSize: number 与 API JSON 实际形态漂移——消费方按
  // number 做比较/Content-Length 运算时 string 静默出错。列级 transformer 在 read
  // 边界 from 把 string→number 数值化（to 透传，写路径 number 原样绑定）。
  @Column({
    type: "bigint",
    default: 0,
    transformer: {
      to: (v?: number): number | undefined => v,
      from: (v?: string | number): number =>
        typeof v === "string" ? Number(v) : (v ?? 0),
    },
  })
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

  /**
   * AUTH-01（多租户 Project，第一批）：包归属项目（可空）。迁移
   * 1790000000009 加列 + FK ON DELETE SET NULL + 索引。存量行不回填——
   * 可空 = 未分配，语义上归默认项目视图。只加列不加关系。
   */
  @Column({ type: "uuid", nullable: true })
  projectId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
