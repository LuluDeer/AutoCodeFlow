import type { SopAssignment } from "./entities/sop-assignment.entity";

/**
 * P6（agent-and-deployment）：指派超时治理的**纯判定**（设计文档 11 §6）。
 *
 * 判定与执行分离：本模块只回答「哪些工单该标 failed / stalled」，
 * @Cron 的扫描、落库、通知由 SopService.sweepAssignmentTimeouts 执行。
 * 分离的理由与 loop/gates 同款——超时语义是安全相关的控制流，纯函数才能
 * 在 check 脚本里被完整断言（不依赖 DB/时钟/调度器）。
 *
 * ## 两个超时（11 §6 生命周期表）
 * | 场景 | 判据 | 处置 |
 * |---|---|---|
 * | 指派后无人领取 | `pulledAt IS NULL` 且 createdAt 超 claimTtl（默认 30min） | `failed`（outcome=unclaimed_timeout）+ 通知；中台可换机器重派 |
 * | 领取后失联 | `lastProgressAt`（回落 updatedAt）超 progressTtl（默认 10min） | `stalled` + 通知；中台决定等待或重派 |
 *
 * ## 为什么 blocked 不参与失联判定
 * blocked = 等**中台**澄清回复——失联的是执行器→中台方向的心跳停滞，
 * 责任在中台侧（复核会话可能还在跑）；对它扫 stalled 会把「正常等待」
 * 误判成执行器失联。澄清回复经 poll 游标投递后状态自动回 in_progress。
 *
 * 中台侧的责任由 evaluateStuckClarifications 兜底：复核会话终态/超时仍
 * 未答复的澄清由扫描转人工（escalated_to_human）——blocked 的等待因此
 * 一定有出口，不会无声死锁。
 */

/** 默认 TTL（11 §8 待确认项 4 的建议值：领取 30min / 进度 10min）。 */
export const CLAIM_TTL_DEFAULT_MS = 30 * 60 * 1000;
export const PROGRESS_TTL_DEFAULT_MS = 10 * 60 * 1000;

export interface AssignmentTimeoutTtls {
  claimTtlMs: number;
  progressTtlMs: number;
}

export interface TimeoutEvaluation {
  /** 派出去但没人接 → failed（可换机器重派）。 */
  unclaimed: SopAssignment[];
  /** 领了但进度心跳停滞 → stalled（等中台决定等待或重派）。 */
  stalled: SopAssignment[];
}

export function evaluateAssignmentTimeouts(
  rows: SopAssignment[],
  now: number,
  ttls: AssignmentTimeoutTtls,
): TimeoutEvaluation {
  const unclaimed: SopAssignment[] = [];
  const stalled: SopAssignment[] = [];
  for (const a of rows) {
    if (a.status === "assigned" && a.pulledAt === null) {
      const age = now - new Date(a.createdAt).getTime();
      if (age >= ttls.claimTtlMs) unclaimed.push(a);
      continue;
    }
    if (a.status === "in_progress") {
      const last = a.lastProgressAt ?? a.updatedAt;
      if (!last) continue;
      const idle = now - new Date(last).getTime();
      if (idle >= ttls.progressTtlMs) stalled.push(a);
    }
    // blocked（等中台澄清回复）与终态不参与超时判定——见模块头注
  }
  return { unclaimed, stalled };
}

// ── 澄清复核兜底（11 §6「澄清无人回 → 转人工」）──────────────────────────
//
// blocked 指派不参与失联判定的前提是「等中台回复的责任在中台侧」——这个
// 责任必须真的有人接：复核会话失败（LLM 不可用/预算触顶/进程崩溃）或模型
// 给出结论却没调 sop_reply_clarification 时，澄清行的 resolution 永远是
// NULL，指派永远 blocked，两个 Agent 的循环在这里无声死锁。本判定回答
// 「哪些澄清该由扫描兜底转人工」；扫描、落库、通知在 SopService。

/** 复核会话状态（agent_sessions.status 的只读投影）。null = 会话行不存在。 */
export type ReviewSessionStatus =
  | "pending"
  | "running"
  | "waiting_input"
  | "succeeded"
  | "failed"
  | "aborted"
  | "budget_exceeded";

export interface StuckClarificationInput {
  clarificationId: string;
  assignmentId: string;
  createdAt: Date;
  /** 关联复核会话的状态；null = 没有关联会话（创建即失败）。 */
  reviewSessionStatus: ReviewSessionStatus | null;
}

/** 复核会话的终态（未产出答复即兜底——succeeded 但没调答复工具也在内）。 */
export const REVIEW_TERMINAL_STATUSES: readonly ReviewSessionStatus[] = [
  "succeeded",
  "failed",
  "aborted",
  "budget_exceeded",
];

export function evaluateStuckClarifications(
  rows: StuckClarificationInput[],
  now: number,
  reviewTtlMs: number,
): StuckClarificationInput[] {
  return rows.filter((r) => {
    // 会话不存在/已终态 → 立即兜底（复核链路对这条澄清已经出局）
    if (r.reviewSessionStatus === null) return true;
    if (REVIEW_TERMINAL_STATUSES.includes(r.reviewSessionStatus)) return true;
    // 会话还在跑 → 超 TTL 兜底：agent-jobs 并发 2，积压 30 分钟说明复核
    // 链路已不健康——宁可转人工，不让执行器无限等
    return now - new Date(r.createdAt).getTime() >= reviewTtlMs;
  });
}
