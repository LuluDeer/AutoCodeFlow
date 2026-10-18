/**
 * RACE-GUARD（审计 P2，2026-10-17）：列表页请求乱序的通用守卫。
 *
 * ## 为什么需要它
 *
 * 两个独立但同形的缺陷：
 *
 * 1) ApplicationDetailPage.ReleasesTab 分页竞态
 *    快速点「下一页→上一页」时两个请求并发在飞，先发的可能后到——旧页数据
 *    覆盖新页，用户看到上一页内容但页码显示当前页，必须再点一次才纠正。
 *
 * 2) AgentSessionsPage 轮询与筛选竞态
 *    15s 静默轮询与「筛选变化触发的 load」并发时没有先后判据——筛选后新请求
 *    已返回并渲染，而上一拍轮询（携带**旧**筛选）随后返回，把列表覆盖回旧
 *    结果。用户看到「筛选没生效」，必须等下一个 15s 拍或手动刷新才纠正。
 *
 * 共同形态：**并发请求 + 无「谁是最新」判据 = 后到者赢**，而「后到」与
 * 「更新」没有任何关系（网络抖动就足以让旧请求后到）。
 *
 * ## 怎么用
 *
 * ```ts
 * const guard = useRaceGuard();
 * const load = useCallback(async (p: number) => {
 *   const seq = guard.next();
 *   const res = await api.getPage(p);
 *   if (!guard.isLatest(seq)) return;   // 过期响应：丢弃
 *   setRows(res.data);
 * }, [guard]);
 * ```
 *
 * `isLatest(seq)` 是唯一判据；`next()` 每发一次请求递增一次。同一 guard 上
 * 所有并发请求共享序号空间——这正是需要的语义（「最近发出的那一个赢」），
 * 而不是「每个筛选维度各自有序号」（那样轮询仍可能盖掉手动刷新）。
 *
 * ## 为什么抽成 hook 而不是各页内联
 *
 * 内联写法（`const seq = useRef(0)` + 三处 `if (seq.current !== n) return`）
 * 容易漏掉某个 setter（例如忘了守 loading），且**无法单测**——只能靠脆弱的
 * DOM 时序测试。抽出来后判据本身是纯逻辑，可以直接断言。
 */
import { useMemo, useRef } from 'react';

export interface RaceGuard {
  /** 领取一个新序号（每发一次请求调一次）。 */
  next(): number;
  /** 该序号是否仍是最新的一发（否则应丢弃这次响应）。 */
  isLatest(seq: number): boolean;
  /** 当前最新序号（调试/测试用）。 */
  current(): number;
}

/**
 * 创建一个序号守卫（纯对象，不依赖 React——便于单测）。
 *
 * 组件里请用 `useRaceGuard()`（稳定引用）；这里导出纯工厂供测试与
 * 非 React 场景（如 worker / 工具函数）复用。
 */
export function createRaceGuard(): RaceGuard {
  // `latest` 从 0 起算（= 还没有任何请求发出），而 `isLatest` 额外要求
  // `seq > 0`——因此 0 / 负数在**任何**时刻都不是合法序号，杜绝「还没发过
  // 请求的组件把哨兵值当成有效序号」这类误判（调用方若用 `let seq = 0`
  // 初始化后忘了赋值就判 latest，会得到错误的「最新」结论）。
  let latest = 0;
  return {
    next: () => ++latest,
    isLatest: (seq: number) => seq > 0 && seq === latest,
    current: () => latest,
  };
}

/**
 * React 版：组件生命周期内稳定的序号守卫。
 *
 * 引用稳定（useMemo 空依赖）——放进 useCallback 依赖数组不会引起重建。
 */
export function useRaceGuard(): RaceGuard {
  const ref = useRef<RaceGuard | null>(null);
  if (ref.current === null) ref.current = createRaceGuard();
  // 空依赖：守卫本身是可变对象，身份恒定（不需要随渲染重建）。
  return useMemo(() => ref.current as RaceGuard, []);
}
