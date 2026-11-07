/**
 * R169：「重试链」Tab 的**次查询**聚合（任务详情 + 兄弟执行列表）。
 *
 * ## 为什么把这三件事捆成一个 hook（修的是一个**假事实**，不是为了好看）
 *
 * 「重试链」面板的**预算 Tag** 与「手动重试」卡都挂在 `taskMaxRetry > 0` 上，而它来自
 * `useTaskDetail`；重试链列表来自 `useExecutionRetryChain`。此前这两个查询的 `error`
 * **从未被解构** ⇒ 失败时 `taskData` / `siblingPage` 都是 `undefined`
 * ⇒ `taskMaxRetry` 落到 **0**、`retryChain` 落到**空数组**
 * ⇒ 面板渲染成「**这个任务没有重试额度、也没有重试记录**」。
 *
 * 而真相是「**我们没读到**」。**「没有」与「没读到」方向相反**：
 * 前者意味着**不必再抢救**，后者应当**重试或报障** —— 而这个页面恰恰是排障最常落地的地方
 * ⇒ 这条假事实的代价很高（它会让人放弃本该继续追的线索）。
 *
 * ## 为什么捆在一起而不是在两个调用点各解构一次
 *
 * ① **两个错误必须合并成一个「面板是否可信」的信号**：任一失败 ⇒ 预算与列表都不可信；
 * ② 页内体量棘轮（`check:size-caps`）对 `ExecutionDetailPage` 是**只减不增**的，
 *    把四行解构 + 一个合并表达式 + 一个重试闭包搬进来，页面反而**变小**了；
 * ③ 组合逻辑有**一处**可测的地方（本文件的 selftest 用例在
 *    `__tests__/execution-retry-chain-load-error.test.tsx` 覆盖面板侧行为）。
 *
 * ## 调用方须知
 *
 * `retryPanelRetry` 同时重拉两个查询 —— **只重拉一个是不够的**：任一查询的旧错误仍会让
 * `retryPanelLoadError` 非空，面板会继续显示错误块（用户会以为「点了没反应」）。
 */
import type { UseQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { Task } from '../api/tasks';

/** `useExecutionRetryChain` 的返回形状（只取本 hook 需要的部分）。 */
interface SiblingPage<Row> {
  items?: Row[];
}

type QueryLike<T> = UseQueryResult<T>;

/**
 * @param taskId 任务 id
 * @param useTaskDetailQ 注入的查询 hook（默认由调用方传入，便于测试替身）
 * @param useRetryChainQ 注入的查询 hook
 */
export function useRetryPanelData<T, S>(
  taskId: string | undefined,
  useTaskDetailQ: (id: string | undefined) => QueryLike<T>,
  useRetryChainQ: (id: string | undefined) => QueryLike<SiblingPage<S>>,
): {
  taskData: T | undefined;
  siblings: S[];
  /** 任一查询失败即非 null —— 面板据此渲染错误块而**不**推「没有额度」。 */
  retryPanelLoadError: unknown;
  /** 同时重拉两个查询（只重拉一个会让面板继续显示错误块）。 */
  retryPanelRetry: () => void;
} {
  const taskQ = useTaskDetailQ(taskId);
  const siblingQ = useRetryChainQ(taskId);
  const siblings = useMemo(() => {
    return siblingQ.data?.items ?? [];
  }, [siblingQ.data]);
  return {
    taskData: taskQ.data as T | undefined,
    siblings,
    retryPanelLoadError: taskQ.error ?? siblingQ.error ?? null,
    retryPanelRetry: () => {
      void taskQ.refetch();
      void siblingQ.refetch();
    },
  };
}

/** 便于页面侧标注 `taskData` 的类型（不变更运行时行为）。 */
export type RetryPanelTask = Task | undefined;
