import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * P7b（agent-and-deployment）：执行器 Agent 的媒体回传登记。
 *
 * 截图/录屏（澄清的 mediaRefs、SOP 证据）由执行器经
 * `POST /agent-collab/assignments/:id/media` 上传。本表是**登记**（元数据）；
 * 字节落本地盘 `<uploads>/agent-media/<assignmentId>/<uuid>-<name>`
 * （与 artifacts 同款根模式：`LOG_ARTIFACT_DIR` 式 env 覆盖 + uploads 目录）。
 *
 * ## 为什么不塞 artifacts 表
 * artifacts 行强制挂在 `task_execution`（verifyUploadAuth 校验执行行），
 * Agent 媒体的归属是**指派工单**——塞过去要么造假 execId、要么给
 * verifyUploadAuth 开特例，两害取其轻不如独立小表。保留策略：媒体属
 * 澄清证据，30 天清理（与 agent_steps 同档；10 §调整5 只约束 tool_calls
 * 对齐审计 180 天，媒体不在其列）。
 */

@Entity("agent_media")
@Index("idx_agent_media_assignmentId", ["assignmentId"])
export class AgentMedia {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  assignmentId: string;

  /** 原始文件名（已过封闭字符集校验，不承担路径语义）。 */
  @Column({ type: "varchar", length: 255 })
  name: string;

  @Column({ type: "varchar", length: 128, nullable: true })
  mime: string | null;

  @Column({ type: "int" })
  sizeBytes: number;

  /** 盘上路径（相对存储根；下载端点用它定位，绝不透传给客户端拼接）。 */
  @Column({ type: "varchar", length: 512 })
  storedPath: string;

  @Column({ type: "varchar", length: 128 })
  uploadedBy: string;

  @CreateDateColumn()
  createdAt: Date;
}
