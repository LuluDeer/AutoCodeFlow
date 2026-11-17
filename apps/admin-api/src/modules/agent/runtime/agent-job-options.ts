import type { JobsOptions } from "bullmq";

/**
 * agent-jobs 的 job 选项（纯函数——可单测，不需要 Redis）。
 *
 * ## 为什么单独抽出来
 * BullMQ 有一条**只在 add 时校验**的规则：自定义 jobId 不能含 `:`，除非
 * 恰好切成 3 段（历史 repeatable job 兼容分支，见 bullmq
 * `classes/job.js` 的 `validateOptions`）。校验发生在写 Redis 之前，抛出的
 * 是普通 Error——调用方如果只 `catch` 记一条 warn，就会得到「代码看起来
 * 排了 job、实际永远排不进去」的静默失效。
 *
 * 本项目踩过：GAP-3 首版用 `auto-resume:${sessionId}`（1 个冒号 = 2 段），
 * 100% 被拒；而 controller 的 `${id}:resume:${Date.now()}` 恰好 3 段所以
 * 一直侥幸通过。规则是上游实现细节，不该靠「恰好段数对」来正确——
 * 这里统一生成**无冒号**的 id，并把选项做成纯函数供单测钉住。
 */
export function autoResumeJobId(sessionId: string): string {
  // 无冒号：不依赖 BullMQ 的 3 段兼容分支（该分支上游注释已标注下个大版本
  // 要换成 include(':')，即会直接拒绝一切含冒号的 id）。
  return `auto-resume-${sessionId}`;
}

/**
 * R215：**人工 / 审批恢复**的 jobId（可枚举，**不带时间戳**）。
 *
 * ## 为什么改掉 `${id}:resume:${Date.now()}`
 *
 * ① **它让「积压」判据误报**：积压对账的做法是 `queue.getJob(session.id)`（`jobId === session.id`，
 *    因为首跑就是这么入队的）。而 resume 用的是带时间戳的 id ⇒ `getJob(session.id)` 查不到
 *    ⇒ 一条「审批通过、正在正常等消费」的会话会被判成**积压** ⇒ 运营按提示「重新入队」
 *    ⇒ **同一会话跑两遍（双份副作用）**。
 * ② **时间戳的唯一作用是绕过去重**，而那条去重**本来该由业务保证**：resume 前已检查
 *    `status === "running"` ⇒ 409（B-8）。⇒ 固定 id 更诚实。
 *
 * ## 为什么不能写成 `${id}:resume`
 *
 * **实测**（`scripts/r215-jobid-live-probe.mjs`）：BullMQ 拒绝含冒号且非 3 段的 id ——
 * `${id}:resume` 是 2 段 ⇒ **`Custom Id cannot contain :`**。故用**无冒号**的 `resume-${id}`，
 * 与 `autoResumeJobId` 同款（无冒号 ⇒ 不依赖上游的 3 段兼容分支）。
 *
 * ⚠️ **去重语义已被用例钉住**：同一会话重复 resume 会命中**已存在的 job**（BullMQ 对相同 id 的
 * `add` 是**幂等 no-op**，实测 `before=4 after=4`）—— 这正是想要的（第二次 resume 不该产生第二个 job）。
 */
export function manualResumeJobId(sessionId: string): string {
  return `resume-${sessionId}`;
}

export interface AutoResumeJobData {
  sessionId: string;
  reason: string;
  /**
   * 期望的挂起原因（GAP-3 + RT-3）：补跑 job 只应唤醒还在
   * `auto_resume` 的会话。会话若在 60s 窗口里被人工 resume 并走到
   * 「等审批」，这个 job 必须让位——裸 sessionId 唤醒会把
   * waiting_input(审批) 翻成 running，审批门在模型眼里退化成拒绝。
   */
  expectWaitingFor?: string;
}

/**
 * 自动续跑 job 的选项。
 *
 * `removeOnComplete: true` 是必须的：jobId 固定时，补跑成功后若 job 还留在
 * completed 集合里，后续同 id 的 add 会命中已完成 job 而**静默 no-op**
 * （BullMQ 的去重不分状态）。
 */
export function autoResumeJobOptions(delayMs: number): JobsOptions {
  return {
    delay: delayMs,
    attempts: 1,
    removeOnComplete: true,
  };
}
