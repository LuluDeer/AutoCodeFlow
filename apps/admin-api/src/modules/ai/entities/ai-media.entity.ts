import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * 视频转 SOP（推理质量轮）：中台自建媒体。
 *
 * 为什么不复用 `agent_media`：那张表的语义是「执行器在**某次指派**里回传的
 * 截图/录屏」（`assignmentId` 非空、保留期按指派整目录清理、下载面是
 * 执行器专属路由）。视频转 SOP 的输入是**管理员上传**的一次性素材，与指派
 * 无关；混进去会让两边的保留期与归属语义互相污染。
 *
 * 盘上结构：`uploads/ai-media/<id>/<uuid>-<name>`（按行 id 分目录，保留期可
 * 整目录删；半截文件不会出现在目录里——原子 rename 发布）。
 */
@Entity("ai_media")
// 保留期清理按时间扫（与其它保留任务同形）
@Index("idx_ai_media_createdAt", ["createdAt"])
export class AiMedia {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** 原始文件名（**已过安全字符闸**；下载路径以它结尾，见签名 URL 的扩展名要求）。 */
  @Column({ type: "varchar", length: 128 })
  name: string;

  @Column({ type: "varchar", length: 128, nullable: true })
  mime: string | null;

  @Column({ type: "int" })
  sizeBytes: number;

  /** 相对 `uploads/ai-media` 的路径（绝不存绝对路径——换部署目录即失效）。 */
  @Column({ type: "varchar", length: 512 })
  storedPath: string;

  /** `user:<id>` 形态（谁会看到这段视频是审计问题）。 */
  @Column({ type: "varchar", length: 128 })
  uploadedBy: string;

  @CreateDateColumn()
  createdAt: Date;
}
