/**
 * T2：运行中时长的共享时钟（两页同一只 ticker）。
 *
 * 问题：历史页 / 状态页用 `Date.now()` 在 render 时算 running 时长，但这两页
 * 只有 history:changed 推送 + 60s 兜底拉数据会触发 render ⇒ 面板可见时「已运行
 * X」最长冻结 60s。这里让**面板可见且确有 running 行**时每秒推进一个 now，
 * 页面时长格式化只吃这个 now；隐藏窗口（document.hidden）不空转，沿用两页
 * 既有的 document.hidden 门控，不新增 IPC。
 *
 * shouldTickRunning 是可直接单测的纯判定：数据里没有 running 行就不该 tick，
 * 距上次 tick 不足一秒也不该推进（定时器漂移时不重复 setNow）。
 */
import { useEffect, useRef, useState } from 'react';

/** 页面记录中判定 running 所需的最小字段（不绑具体页面记录类型）。 */
export interface RunningLike {
  status?: string;
  startTime?: number;
  endTime?: number;
}

export function hasRunningRecord(
  records: ReadonlyArray<RunningLike> | null | undefined,
): boolean {
  if (!records) return false;
  return records.some((r) => r?.status === 'running' && Number.isFinite(r.startTime));
}

/** 纯判定：有 running 行且距上次 tick ≥1s 才推进时钟。 */
export function shouldTickRunning(
  records: ReadonlyArray<RunningLike> | null | undefined,
  nowMs: number,
  lastTickMs: number,
): boolean {
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastTickMs)) return false;
  return hasRunningRecord(records) && nowMs - lastTickMs >= 1000;
}

/**
 * 共享时钟 hook。active = 该 tab 面板可见；records = 两页各自的历史记录。
 * 返回单调推进的 now（毫秒），面板不可见 / 无 running 行时保持上一次的值。
 */
export function useNowTicker(
  active: boolean,
  records: ReadonlyArray<RunningLike> | null,
): number {
  const [now, setNow] = useState(() => Date.now());
  const lastTick = useRef(now);

  useEffect(() => {
    if (!active || !hasRunningRecord(records)) return;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const next = Date.now();
      if (!shouldTickRunning(records, next, lastTick.current)) return;
      lastTick.current = next;
      setNow(next);
    }, 1000);
    return () => clearInterval(timer);
  }, [active, records]);

  return now;
}
