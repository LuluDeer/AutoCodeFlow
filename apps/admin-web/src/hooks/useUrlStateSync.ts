import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * URL-SYNC-02（审计 P2，2026-10-17）：列表页「筛选/分页 ⇄ URL」的**双向**同步。
 *
 * ## 修的是什么
 *
 * URL-SYNC-01 给三个列表页（ExecutionsPage / TaskListPage /
 * UserManagementPage）加了「以 URL 为初始源 + 状态回写 URL」，但它只做了
 * **单向**：state 的初始值读 URL，之后由回写 effect 单向覆盖 URL。
 *
 * 缺陷现场：组件**已挂载**时再从外部改 URL（通知铃铛的「查看失败」链到
 * `/executions?status=failed`、浏览器前进/后退、Dashboard 的「全部失败」
 * 深链），`searchParams` 变了，但 state 不跟着变；紧接着回写 effect 又把
 * URL 覆盖回旧 state。净效果是**深链完全失效**：地址栏闪过
 * `?status=failed` 随即被抹掉，列表仍显示全量数据——用户以为链接坏了。
 * （同一组件内直接点按钮改 state 是正常的，所以这个缺陷只在外部导航时出现，
 * 单页手测很难发现。）
 *
 * ## 怎么修的
 *
 * 「URL 与 state 互为投影，用序列化串做幂等判据」：
 *   · URL → state：`searchParams` 变化时解析并写回 state；
 *   · state → URL：state 变化时写回 URL（replace，不制造历史记录）；
 *   · `lastPushedRef` 记住「上一次由本 hook 写入的串」，两边都先比对——
 *     既打断「读 URL 写 state → state 变化又写 URL」的回环，也保证回写
 *     不会把外部深链覆盖掉（串相等即无操作）。
 *
 * ## 用法
 *
 * ```tsx
 * const [page, setPage] = useState(1);
 * const [status, setStatus] = useState<string | undefined>();
 * useUrlStateSync(
 *   { page, status },                    // 当前值
 *   { page: 1, status: undefined },      // 默认值（等于默认值不写入 URL）
 *   { page: setPage, status: setStatus },// 回写 setter（URL→state 方向需要）
 * );
 * ```
 *
 * 值类型只支持 `string | number | undefined`——列表页的筛选/分页就是这些。
 * 需要更复杂结构（如 Dayjs 区间）请自行序列化，或留在会话内状态（本仓库
 * 的时间范围就是这么处理的：序列化噪音大、深链价值低）。
 */
export type UrlStateValue = string | number | undefined;

export type UrlStateRecord = Record<string, UrlStateValue>;

/**
 * setter 形状：**非**可选入参。
 *
 * 为什么这样是安全的：`parseUrlState` 对 `defaults` 里声明的每个键**总是**
 * 返回一个具体值（URL 缺失/非法即回落默认值），所以 URL→state 方向永远不会
 * 用 `undefined` 去调 setter。把入参放宽成 `| undefined` 反而会让
 * `useState<string>` 的 setState 类型不兼容（TS 要求参数逆变），迫使每个调用
 * 点包一层无意义的适配器。
 *
 * 代价：`defaults` 必须为**每个** key 给出明确默认值（不能漏写）——这正是
 * 我们想要的约束（漏写默认值 = 该字段永远无法从 URL 清空）。
 */
export type UrlStateSetters<T extends UrlStateRecord> = {
  [K in keyof T]: (value: T[K]) => void;
};

/**
 * 把 state 序列化成 URLSearchParams。
 *
 * 规则：`undefined` / 空串 / 等于默认值的字段不写入——URL 只保留「偏离默认」
 * 的部分，深链更短可读（`/executions` 而不是 `/executions?page=1&status=`）。
 * 数字一律 String()。
 */
export function serializeUrlState(
  state: UrlStateRecord,
  defaults: UrlStateRecord = {},
): URLSearchParams {
  const next = new URLSearchParams();
  for (const [key, raw] of Object.entries(state)) {
    if (raw === undefined || raw === '') continue;
    const def = defaults[key];
    if (def !== undefined && String(raw) === String(def)) continue;
    next.set(key, String(raw));
  }
  return next;
}

/**
 * 从 URLSearchParams 解析出 state。
 *
 * 解析不出合法值的字段回落默认值（不抛错、不空屏）：数字字段的 `?page=abc`
 * 或负数一律回落——与三个页面此前「非法深链值回落默认」的既有语义一致。
 */
export function parseUrlState<T extends UrlStateRecord>(
  params: URLSearchParams,
  defaults: T,
): T {
  const out: Record<string, UrlStateValue> = {};
  for (const [key, def] of Object.entries(defaults)) {
    const raw = params.get(key);
    if (raw === null || raw === '') {
      out[key] = def;
      continue;
    }
    if (typeof def === 'number') {
      const n = Number(raw);
      // 页码/页大小语义：正整数；否则回落
      out[key] = Number.isInteger(n) && n > 0 ? n : def;
      continue;
    }
    out[key] = raw;
  }
  return out as T;
}

/**
 * 双向同步 hook。见文件头注。
 *
 * 三个参数刻意都是显式记录（而不是靠模块级注册表）——同名的 key 在不同页面
 * 之间不会串味，卸载即失效，也没有跨页面共享的可变状态。
 */
export function useUrlStateSync<T extends UrlStateRecord>(
  state: T,
  defaults: T,
  setters: UrlStateSetters<T>,
): void {
  const [searchParams, setSearchParams] = useSearchParams();
  // 上一次由本 hook 写入 URL 的序列化串——用于打断「URL→state→URL」回环，
  // 同时保证外部深链不会被回写覆盖（相等即无操作）。
  const lastPushedRef = useRef<string | null>(null);
  // setter 逐次刷新到 ref：effect 的依赖里不放 setters（调用方常在渲染期新建
  // 对象字面量，放进去会让 effect 每次都跑）。
  const settersRef = useRef(setters);
  settersRef.current = setters;
  // 同上：当前值与默认值也走 ref，避免把整个 state 放进 URL→state 的依赖。
  const stateRef = useRef(state);
  stateRef.current = state;
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;

  // ── URL → state ─────────────────────────────────────────────────────────
  useEffect(() => {
    const incoming = searchParams.toString();
    // 本 hook 自己刚写进去的那一发：跳过（否则会用同一份值再 setState 一次）
    if (lastPushedRef.current === incoming) return;

    const parsed = parseUrlState(searchParams, defaultsRef.current);
    for (const [key, value] of Object.entries(parsed)) {
      if (stateRef.current[key] === value) continue;
      // 逐字段调用 setter：只在确有差异时写，避免无谓的重渲染与请求重发。
      (settersRef.current as Record<string, (v: UrlStateValue) => void>)[key]?.(
        value,
      );
    }
  }, [searchParams]);

  // ── state → URL ─────────────────────────────────────────────────────────
  useEffect(() => {
    // F-20（UIAUDIT P3-13）：回写以**当前查询串为底改写受控键**，不再用
    // serializeUrlState(state) 整体替换。外部深链携带的 state 之外参数（未来
    // 埋点/分享参数）此前会被任一 state 变化静默抹掉；现在逐个受控键
    // set/delete，非受控参数原样保留（位次与编码随 URLSearchParams 拷贝不变）。
    // 受控键自身的清理语义与旧实现一致：偏离默认才保留，等于默认/空即删除。
    const desired = serializeUrlState(state, defaults);
    const next = new URLSearchParams(searchParams);
    for (const key of Object.keys(state)) {
      const v = desired.get(key);
      if (v === null) next.delete(key);
      else if (next.get(key) !== v) next.set(key, v);
    }
    const nextStr = next.toString();
    if (nextStr === searchParams.toString()) return; // 已一致：不动 URL
    lastPushedRef.current = nextStr;
    setSearchParams(next, { replace: true });
  }, [state, defaults, searchParams, setSearchParams]);
}
