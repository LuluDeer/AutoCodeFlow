/**
 * Agent 实时事件流的前端可见帧契约（后端为唯一事实源）。
 *
 * 这些类型刻意独立于 controller：controller 只透传 `StreamSessionOptions`，
 * 帧形状由本文件约束，前端按字段做增量合并与 mid-stream 快照补回。
 */

/** `synced.snapshot`：mid-stream 刷新时一次补回累计的文本/推理/阶段。 */
export interface StreamSnapshotPayload {
  content?: string;
  reasoning?: string;
  phase?: string;
}

/** `synced` 帧：重放结束的实时边界标记。 */
export interface AgentStreamSyncedPayload {
  sessionId: string;
  lastSeq: number;
  status: string;
  /** 兼容旧前端：是否仍在活跃流窗口内。 */
  activeStream: boolean;
  /** 当前累计快照；无活跃流时缺省。 */
  snapshot?: StreamSnapshotPayload;
  /** 本次重放是否还有未拉取的历史（LIMIT 5000 截断）。 */
  hasMore?: boolean;
  /** 与 hasMore 同义，便于客户端直接提示「历史被截断」。 */
  truncated?: boolean;
}

/** `replay()` 的结构化结果；保留数字返回值语义时取 `.lastSeq`。 */
export interface AgentStreamReplayResult {
  lastSeq: number;
  hasMore: boolean;
  truncated: boolean;
  count: number;
}

/** `replay()` 可选第四参：在 synced 发出前拿到截断标志。 */
export interface AgentStreamReplayMeta {
  hasMore: boolean;
  truncated: boolean;
  count: number;
}
