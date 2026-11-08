import { Not, type FindOperator } from "typeorm";
import { TaskStatus } from "../task/entities/task.entity";

/**
 * 执行器删除影响面的**判据与口径**（B0 拆分第 3 步）。
 *
 * ## 背景（DEEP-AUDIT B·1.1）
 *
 * 旧实现删除执行器（手动 `removeById` / 自动 `cleanupOfflineExecutors`）对
 * `task.executorId` / `task.executorAppName` 的引用**零感知**——钉定任务在
 * 删除后派发即抛 "Pinned executor not found" 且分类 UNKNOWN 无重试，等于
 * **静默制造必失败任务**。
 *
 * 「破坏面」的口径被**两处**消费：
 * - `describeRemovalImpact()`：删除前的影响面预览（给确认框看）；
 * - `cleanupOfflineExecutors()`：自动清理的跳过判定（被钉定的行跳过并 warn）。
 *
 * 两处必须**同口径**（否则预览说"无影响"、清理却删掉 ⇒ 预览失去意义）。
 *
 * ## 为什么抽的是「where 构造」而不是「计数」
 *
 * 计数本身是 DB 侧的聚合（`repo.count`），把它搬进 util 就得让 util 依赖
 * Repository ⇒ 那不是纯函数，也就把 IO 与规则又搅在一起。
 * 而**规则**恰恰是容易被复制漂移的那一半：「哪些 task 行算被绑定」「软删除
 * 行算不算」。本文件把这两条规则做成**纯的 where 构造器**：
 *
 * - 钉定维度：`task.executorId === executor.id`；
 * - 名字绑定维度：`task.executorAppName === executor.appName`；
 * - 两者都**排除软删除行**（`status = DELETED`）——软删除的任务不会再被派发，
 *   不算破坏面。
 *
 * 规则只有一份实现，两个调用点不会各写一遍后漂移；而 count 查询本身留在
 * service（IO 该留在 IO 层）。
 */

/**
 * 钉定维度（`task.executorId`）的 where 构造（**纯函数**）。
 *
 * @param executorId 目标执行器 id
 */
export function buildPinnedTaskCountWhere(executorId: string): {
  executorId: string;
  status: FindOperator<TaskStatus>;
} {
  return {
    executorId,
    status: Not(TaskStatus.DELETED),
  };
}

/**
 * 名字绑定维度（`task.executorAppName`）的 where 构造（**纯函数**）。
 *
 * ⚠️ **精确匹配，不静默换机**：dispatch 的 appName 匹配是**等值**的，
 * 所以这里也必须是等值——用 `includes`/`startsWith` 会把 `web-1` 误算成
 * `web-10` 的绑定面。
 *
 * @param appName 目标执行器的 appName
 */
export function buildAppNameBoundTaskCountWhere(appName: string): {
  executorAppName: string;
  status: FindOperator<TaskStatus>;
} {
  return {
    executorAppName: appName,
    status: Not(TaskStatus.DELETED),
  };
}

/**
 * 名字绑定判据（**纯函数**）：一行任务行是否算「被该执行器按名字绑定」。
 *
 * 与 `buildAppNameBoundTaskCountWhere` 同口径（等值匹配），供不查库的
 * 判定场景（如批量清理前的候选筛选）复用。
 */
export function isBoundToExecutorAppName(
  taskExecutorAppName: string | null | undefined,
  executorAppName: string,
): boolean {
  return taskExecutorAppName === executorAppName;
}

/**
 * 钉定判据（**纯函数**）：一行任务行是否算「被该执行器钉定」。
 */
export function isPinnedToExecutor(
  taskExecutorId: string | null | undefined,
  executorId: string,
): boolean {
  return taskExecutorId === executorId;
}
