/**
 * R284-LOGPURGE-01：日志区为空时的三态判定（**已清理 / 真没输出 / 无法判定**）。
 *
 * ## 为什么这需要一次额外请求
 *
 * 日志行留 `logRetention.days`（默认 30 天），执行行留 90 天 ⇒ 翻 31~90 天前的
 * 执行详情，日志区是空的。执行详情实体（`data.logs`）里没有、也不该有清理
 * 判定：它是**日志行表**的事实，只能由日志读面回答（后端 `logsPurged`）。
 * 没有它，空日志区就只能"按时间猜"——而 30 天前也可能本来就一个字都没输出，
 * 猜就是把一种误导换成另一种。
 *
 * ## 为什么单独成 hook
 *
 * 判定有 4 个 trigging 条件、3 个分支结局和一条时序守卫，塞在组件里会把
 * 渲染函数推过体量上限（check:size-caps 的 functionLines 棘轮），而它与渲染
 * 毫无关系——它只是"问服务端一个问题并把答案收成三态"。
 *
 * ## `null` ≠ `'unknown'`（R278 的 null≠0 纪律在此的同型）
 *
 * · 返回 `null`      = **尚未/无需判定**（有日志、未终态、切执行重置中）；
 * · 返回 `'unknown'` = **判定过了但判不出来**（后端无该字段 / 保留期不可读 /
 *   读失败）。
 * 两者混用会让任何有日志的页面都挂一条「无法判定原因」。
 */
import { useEffect, useRef, useState } from 'react';
import { tasksApi } from '../api/tasks';

/**
 * 开放态执行（日志为空属正常态，不做空态判定）。
 *
 * 与后端 `OPEN_EXECUTION_STATUSES` 同一口径（pending/running/waiting）：
 * 运行中没有日志是「还没输出」，不是「没有输出」，提前挂结论就是假断言。
 */
const OPEN_STATUSES: readonly string[] = ['pending', 'running', 'waiting'];

/** 三态结论（`null` = 尚未/无需判定，见文件头）。 */
export type EmptyLogsVerdict =
  | null
  | { state: 'purged'; at: string | null }
  | { state: 'empty' }
  | { state: 'unknown' };

export interface UseEmptyLogsVerdictArgs {
  taskId: string;
  execId: string;
  /** 执行状态（运行中不做判定） */
  status: string | undefined;
  /** 当前展示的日志文本（非空 ⇒ 不判定） */
  displayLogs: string;
}

export function useEmptyLogsVerdict({
  taskId,
  execId,
  status,
  displayLogs,
}: UseEmptyLogsVerdictArgs): EmptyLogsVerdict {
  const [verdict, setVerdict] = useState<EmptyLogsVerdict>(null);
  /**
   * 时序守卫（与 levelFetchSeq / fullLogsFetchSeq 同型）：切执行时旧执行的晚到
   * 探测结果不得改写新执行的三态结论。结论性文案串页比视图串页更糟——用户会
   * 把「上一条已清理」当成这一条的执行证据。
   */
  const seqRef = useRef(0);

  // 切执行 ⇒ 序号自增使在途探测整体失效，并复位结论（避免两帧内沿用旧结论）。
  useEffect(() => {
    seqRef.current += 1;
    setVerdict(null);
  }, [execId]);

  useEffect(() => {
    if (displayLogs) {
      setVerdict(null);
      return;
    }
    // 未终态：日志为空是运行中的正常态，不判定。
    if (!status || OPEN_STATUSES.includes(status)) {
      setVerdict(null);
      return;
    }
    const seq = ++seqRef.current;
    setVerdict(null);
    // 只取 1 行：判据只需要「有没有行」+ 服务端的清理标记。
    tasksApi
      .executionLogs(taskId, execId, { fromLine: 0, limit: 1 })
      .then((resp) => {
        if (seqRef.current !== seq) return;
        // 探到了行 ⇒ 确实有日志（可能只是 SSE 尚未渲染），不挂空态结论。
        if (Array.isArray(resp?.lines) && resp.lines.length > 0) {
          setVerdict(null);
          return;
        }
        if (resp?.logsPurged === true) {
          setVerdict({ state: 'purged', at: resp.logsPurgedAt ?? null });
        } else if (resp?.logsPurged === false) {
          setVerdict({ state: 'empty' });
        } else {
          // `null`（后端判不出）与 `undefined`（旧后端无该字段）都是**未知**。
          setVerdict({ state: 'unknown' });
        }
      })
      .catch(() => {
        // 读失败不能变成一条关于证据的事实（「读不到」≠「是 0」）。
        if (seqRef.current !== seq) return;
        setVerdict({ state: 'unknown' });
      });
  }, [displayLogs, status, taskId, execId]);

  return verdict;
}