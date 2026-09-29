import { DataSource, EntityManager } from "typeorm";

/**
 * MUTEX-01（应用互斥组）：调度侧共享的常量与工具。
 *
 * 语义单一事实源是 `MutexGroup` 实体头注与迁移 1790000000044；本文件只放
 * 跨模块（task ↔ executor ↔ scheduler）需要的三样东西：
 *
 * 1. `MUTEX_WAIT_TOKEN` / `MutexWaitError` —— dispatch 占坑发现「所有候选
 *    设备的同组占用已满」时抛出；task.processor 在分类链**最前面**识别该
 *    token（与 interpreter_unavailable 的 `[interpreter_unavailable]` token
 *    先例同款——消息前缀识别先于正则分类链，避免被误分类成 EXECUTOR_OFFLINE），
 *    把执行置为 WAITING 并正常结束 job（不 rethrow、不烧重试预算）。
 * 2. `resolveTaskMutexGroupId` —— 执行行创建时从 task→application 解析组
 *    快照。执行行存快照而非运行时 join：占用判定是热路径单表查询，且组被删
 *    后在途执行仍按创建时的组语义走完（无 FK）。
 *
 * 刻意不 import 任何实体类（只用 DataSource/EntityManager 裸查询）：本文件
 * 被 scheduler / executor / task 三个互相 forwardRef 的模块引用，必须保持
 * 零模块依赖（与 execution-terminal.ts 的纯函数纪律同款）。
 */

/** dispatch 抛出的互斥阻塞错误消息前缀（processor 分类链据此识别）。 */
export const MUTEX_WAIT_TOKEN = "[mutex_wait]";

/** dispatch 抛出的互斥阻塞错误。processor 捕获后把执行置为 WAITING。 */
export class MutexWaitError extends Error {
  constructor(message: string) {
    super(`${MUTEX_WAIT_TOKEN}${message}`);
    this.name = "MutexWaitError";
  }
}

/**
 * 解析任务当前挂的互斥组 id（执行行创建时调用）。
 *
 * 返回 null 的三种情形同语义（= 不参与互斥）：任务未挂应用 / 应用未挂组 /
 * 应用或组已不存在。组在执行创建之后被删除的，不影响已带快照的在途执行。
 *
 * 查询失败不抛：互斥是叠加约束而非派发前提，读失败降级为「不参与互斥」并
 * 由调用方 warn（与 ARCH-35 部署偏好的容错口径一致——绝不让调度优化升级成
 * 派发失败）。
 */
export async function resolveTaskMutexGroupId(
  db: DataSource | EntityManager,
  task: { id: string; applicationId: string | null },
): Promise<string | null> {
  if (!task.applicationId) return null;
  try {
    const rows: Array<{ mutexGroupId: string | null }> = await db.query(
      `SELECT "mutexGroupId" FROM "applications" WHERE "id" = $1 LIMIT 1`,
      [task.applicationId],
    );
    return rows[0]?.mutexGroupId ?? null;
  } catch {
    return null;
  }
}
