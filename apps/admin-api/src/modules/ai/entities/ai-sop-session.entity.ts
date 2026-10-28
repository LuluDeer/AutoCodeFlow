import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * 视频转 SOP（推理质量轮 · 交互式）：**编写会话**。
 *
 * 为什么需要落库而不是纯前端状态：
 *   · 一次会话要跨多轮（模型追问 → 用户补充文字/再传视频 → 再追问或出稿），
 *     每轮都要把**全部视频 + 完整历史**重发（无状态 API 没有跨轮记忆）；
 *   · 用户在等模型时刷新页面/换设备，会话必须能续——否则已问的问题重问一遍，
 *     而每问一轮就要重算一次全量视频（真金白银）。
 *
 * `messagesJson` 存**已发生的事实**（用户说了什么、模型问了/出了什么），
 * `draftJson` 存最近一次草稿（可被后续轮次覆盖），`mediaJson` 是按上传顺序的
 * 视频清单（顺序即提示里的编号，模型会引用"第 2 段"）。
 */
@Entity("ai_sop_sessions")
@Index("idx_ai_sop_sessions_createdAt", ["createdAt"])
export class AiSopSession {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** active（还在对话）/ drafted（已出稿）/ saved（已保存为 SOP 草稿）。 */
  @Column({ type: "varchar", length: 16, default: "active" })
  status: "active" | "drafted" | "saved";

  /** SopSessionMessage[]（见 ai-sop-session.protocol.ts）。 */
  @Column({ type: "jsonb", nullable: true })
  messagesJson: unknown[] | null;

  /** SopSessionMediaRef[]：本会话挂的所有视频（≤ MAX_SESSION_VIDEOS）。 */
  @Column({ type: "jsonb", nullable: true })
  mediaJson: unknown[] | null;

  /** SopSessionDraft | null：最近一次产出的草稿。 */
  @Column({ type: "jsonb", nullable: true })
  draftJson: Record<string, unknown> | null;

  /** 指定使用的 provider id（空 = 走 ai.routes.video）。 */
  @Column({ type: "varchar", length: 64, nullable: true })
  provider: string | null;

  /** 已追问次数（硬闸输入；落库以便续跑不重置预算）。 */
  @Column({ type: "int", default: 0 })
  questionsAsked: number;

  /**
   * 回合锁：非空 = 有 worker 正在跑这一轮（>5 分钟视为陈旧锁，可被抢占）。
   * 防"双击发送/刷新重发/两个标签页"并发跑两轮（每轮都是全量视频推理）。
   */
  @Column({ type: "timestamptz", nullable: true })
  turnLockedAt: Date | null;

  @Column({ type: "varchar", length: 128 })
  createdBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
