/**
 * CORE-02: 执行详情页「重试链路」段的纯逻辑层（与 timeout-policy.ts /
 * retry-policy.ts 同层次，独立成文件以满足 react-refresh 只导出组件的
 * 限制并便于单测）。
 *
 * 数据模型：重试链 = 同一任务下 retryCount 递增的兄弟执行行。
 *  - attempt 0：原始执行（retryCount=0）；
 *  - attempt N（N>=1）：第 N 次重试的载体执行行（由 executor_restart /
 *    stale_recovery / timeout_retry 等 re-enqueue 路径创建）；
 *  - BullMQ 同执行行内的 job 级自动重试（attempts/backoff）不产生新行，
 *    不在此链上——链上可见的是"中台重建执行行"粒度的重试。
 */

import type { TaskExecution } from '../api/tasks';

/** 重试链上一行的形状（含派生的展示字段） */
export interface RetryChainLink {
  /** 执行行自身 ID（路由跳转用） */
  execId: string;
  /** 链内序号：retryCount（0 = 原始尝试） */
  retryCount: number;
  status: string;
  triggerType?: string | null;
  executorAddress?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  /** 执行行自报耗时（毫秒，后端 duration 列） */
  duration?: number | null;
  failureReason?: string | null;
  errorMessage?: string | null;
}

/** 每次重试间隔 = 下一行 startTime - 上一行 endTime（毫秒）；不可算为 null */
export function retryGapMs(
  prevEnd: string | null | undefined,
  nextStart: string | null | undefined,
): number | null {
  if (!prevEnd || !nextStart) return null;
  const end = new Date(prevEnd).getTime();
  const start = new Date(nextStart).getTime();
  if (!Number.isFinite(end) || !Number.isFinite(start) || start < end) return null;
  return start - end;
}

/**
 * 从同任务的兄弟执行行拼装重试链。
 *
 * 输入为 GET /tasks/:id/executions（按 taskId 查询，零新端点）的多页累积
 * 结果（可能包含与链无关的普通执行行）。规则：
 *  - 以当前行 anchor 的 retryCount 为中心，向上收集 retryCount 递减到 0 的
 *    连续前驱（每级取 createdAt 最早的一行，容错同 retryCount 的并发重复行）；
 *  - 向下收集 retryCount = anchor.retryCount + 1 起连续递增的后继；
 *  - 链按 retryCount 升序输出；缺失的中间档（如 0→2）在间断处截断。
 */
export function buildRetryChain(
  siblings: TaskExecution[],
  anchor: Pick<TaskExecution, 'id' | 'retryCount'>,
): RetryChainLink[] {
  const currentRetry = typeof anchor.retryCount === 'number' && anchor.retryCount >= 0 ? anchor.retryCount : 0;

  const toLink = (e: TaskExecution): RetryChainLink => ({
    execId: e.id,
    retryCount: typeof e.retryCount === 'number' && e.retryCount >= 0 ? e.retryCount : 0,
    status: e.status,
    triggerType: e.triggerType ?? null,
    executorAddress: e.executorAddress ?? null,
    startTime: e.startTime ?? null,
    endTime: e.endTime ?? null,
    duration: e.duration ?? null,
    failureReason: e.failureReason ?? null,
    errorMessage: e.errorMessage ?? null,
  });

  // 按 retryCount 分桶，桶内按 createdAt 最早优先（同档并发重复行取第一行）
  const buckets = new Map<number, TaskExecution[]>();
  for (const e of siblings) {
    const rc = typeof e.retryCount === 'number' && e.retryCount >= 0 ? e.retryCount : 0;
    if (rc > currentRetry + 50) continue; // 防御异常大值
    const list = buckets.get(rc) ?? [];
    list.push(e);
    buckets.set(rc, list);
  }
  const earliestOf = (rc: number): TaskExecution | undefined => {
    const list = buckets.get(rc);
    if (!list || list.length === 0) return undefined;
    return [...list].sort(
      (a, b) =>
        new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime(),
    )[0];
  };

  // 向上：retryCount-1 … 0 连续收集
  const upLinks: RetryChainLink[] = [];
  for (let rc = currentRetry - 1; rc >= 0; rc--) {
    const found = earliestOf(rc);
    if (!found) break; // 中间档缺失 → 截断（不猜测补位）
    upLinks.unshift(toLink(found));
  }

  // 向下：retryCount+1 … 连续收集
  const downLinks: RetryChainLink[] = [];
  for (let rc = currentRetry + 1; ; rc++) {
    const found = earliestOf(rc);
    if (!found) break;
    downLinks.push(toLink(found));
    if (downLinks.length > 50) break; // 防御上限
  }

  const anchorLink = toLink({ ...(siblings.find((e) => e.id === anchor.id) ?? { id: anchor.id }), retryCount: currentRetry } as TaskExecution);
  return [...upLinks, anchorLink, ...downLinks];
}

/**
 * 「下次重试时间」：链上存在 PENDING 行且其 startTime 未知（尚未开跑）时，
 * 无法从行内数据精确推出 BullMQ delayed job 的到期时刻——我们以该行
 * createdAt（创建即入队）+ 上一行 endTime 与其间隔近似展示"最早开跑时间"。
 * 若链上无 PENDING 行则返回 null（无可等待的重试）。
 */
export function nextPendingRetryAt(chain: RetryChainLink[]): RetryChainLink | null {
  const pending = chain.find((l) => l.status === 'pending');
  return pending ?? null;
}
