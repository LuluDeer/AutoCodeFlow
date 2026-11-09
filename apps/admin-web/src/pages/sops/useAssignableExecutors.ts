/**
 * P3-1（SOP 指派弹窗）：可接指派执行器的**三态**取数（loading / ready / error）。
 *
 * ## 为什么抽出来
 *
 * 原实现（apps/admin-web/src/pages/SopsPage.tsx 的 openAssign）把「读取失败」
 * 与「读取成功但为空」压成同一个信号：`setAssignable([])` 先清场，随后请求
 * 失败时只留一条会消失的 toast —— 于是：
 *  ① 请求在途的 100–300ms 内，弹窗已经渲染出「没有可接指派的执行器——
 *     先在桌面端启用 Agent（能力租约 30 秒续报、2 分钟过期）」的**黄色警告**：
 *     首屏把「还没读到」谎报成「机群里没有可用机器」；
 *  ② 请求 500 / 网络失败时，那条**可执行但错误**的处置建议（去桌面端启用
 *     Agent）永久留在弹窗里，而真相是「后端读不出来」——用户被误导去排查
 *     机群能力租约。
 *
 * 这违反本仓反复点名的纪律「读取失败 ≠ 数据为空」。同仓 ExecutorPackagesPage.tsx
 * 的同类问题已修（页内原位报错 + 重试），本文件是同一修法在指派弹窗的落点。
 *
 * ## 三态语义
 *
 *  · `loading`：**不得**渲染空态警告（首屏不报空），只给一个轻量加载指示；
 *  · `ready`：列表为空时才渲染「没有可接指派的执行器」（**真空态**）；
 *  · `error`：渲染错误块 + 「重新加载」入口（读取失败的真相 + 可恢复路径）。
 *
 * ## 为什么带序号守卫
 *
 * 与列表页的 useRaceGuard 同款（utils/raceGuard.ts）：「重新加载」可以连点，
 * 慢的旧响应可能晚于新的到达 ⇒ 晚到者不得覆盖更新的状态。
 */
import { useCallback, useMemo, useState } from 'react';
import { sopsApi } from '../../api/sops';
import type { AssignableExecutor } from '../../api/sops';
import { useRaceGuard } from '../../utils/raceGuard';

/** 可接指派执行器取数的三态。 */
export type AssignableState = 'loading' | 'ready' | 'error';

export interface AssignableExecutors {
  /** 已成功读到的候选执行器（失败态恒为空数组：读失败时没有可信候选）。 */
  items: AssignableExecutor[];
  /** 三态；渲染层据此决定「空态警告 / 加载指示 / 错误块」。 */
  state: AssignableState;
  /** 失败时的原始错误对象（交给 StateError 呈现 + 复制）。 */
  error: unknown;
  /** 重新取数（打开弹窗时首取；错误块的「重新加载」按钮再取一次）。 */
  reload: () => void;
}

/**
 * 可接指派执行器的取数 hook（**不**在挂载时自动取数——只在打开指派弹窗时取）。
 */
export function useAssignableExecutors(): AssignableExecutors {
  const [items, setItems] = useState<AssignableExecutor[]>([]);
  const [state, setState] = useState<AssignableState>('loading');
  const [error, setError] = useState<unknown>(null);
  const guard = useRaceGuard();

  const reload = useCallback(() => {
    const seq = guard.next();
    // 每次取数先回到 loading：首屏不报空态、失败后重试也立刻回到「在读」。
    setState('loading');
    setError(null);
    void sopsApi
      .listAssignableExecutors()
      .then((list) => {
        if (!guard.isLatest(seq)) return; // 过期响应：丢弃
        setItems(list);
        setState('ready');
      })
      .catch((err: unknown) => {
        if (!guard.isLatest(seq)) return; // 过期响应：丢弃
        // 读失败时清空候选：读不出来 ≠ 有一台「可接指派但列表没列出来」的机器，
        // 留着旧候选会让人以为「读到了、只是没选」。
        setItems([]);
        setError(err);
        setState('error');
      });
  }, [guard]);

  // 整体 memo：页面把它放进 useCallback 依赖数组（openAssign），引用必须稳定，
  // 否则每次渲染都会重建 openAssign → 抽屉里的按钮每次渲染都换引用。
  return useMemo<AssignableExecutors>(
    () => ({ items, state, error, reload }),
    [items, state, error, reload],
  );
}
