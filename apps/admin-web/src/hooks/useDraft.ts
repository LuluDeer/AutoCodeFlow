/**
 * DRAFT-01：表单草稿的 localStorage 持久化（通用、防抖、SSR 安全、带版本号）。
 *
 * ## 为什么需要
 *
 * 任务表单是单页长表单（基本/触发/执行器/参数/Glue 五分区），填一份动辄
 * 几分钟。此前唯一的保护是 dirty 守卫（P1-4）：它拦得住「误点返回」，但拦不住
 * **崩溃、误关标签页、笔记本没电、OAuth 会话过期被踢**——这些场景下用户回来
 * 只看到一张空表单，全部输入归零。守卫只负责"问一句"，草稿负责"真的还在"。
 *
 * ## 设计要点（每条都是踩过的坑）
 *
 * 1. **版本化 key**：`key` + `DRAFT_SCHEMA_VERSION`。表单字段随迭代增删，
 *    旧草稿的形状可能已不合法——版本不符时**整体丢弃**而不是尝试兼容
 *    （半个旧草稿比没有草稿更危险：它会让用户以为"恢复成功了"）。
 *    调用方还应把「编辑哪个任务/用哪个模板」编进 key（见 `draftKey`），
 *    否则 A 任务的草稿会被恢复进 B 任务的表单。
 *
 * 2. **防抖**：`delay` 默认 800ms。表单 `onValuesChange` 是每次击键都触发，
 *    同步写 localStorage 会在长文本输入时明显卡顿（localStorage 是**同步**
 *    API，写几百 KB 的 JSON 会把主线程钉住）。卸载时强制 flush，
 *    保证"改完立刻关页"也不丢。
 *
 * 3. **quota 容错**：localStorage 会抛（隐私模式、配额满 ~5MB、Safari 的
 *    `SecurityError`）。写入失败一律**静默降级为"本次会话没有草稿"**，
 *    绝不冒泡——草稿是增强能力，不能因为它让表单不可用。读取失败同理
 *    （脏数据/版本不符/JSON 坏掉 → 视为无草稿）。
 *
 * 4. **SSR 安全**：模块加载期与 hook 调用期都不得假设 `window` 存在。
 *    所有存取都过 `getStorage()`，它在无 window / 存取抛错时返回 null。
 *
 * 5. **不复活已丢弃的草稿**：`clear()` 之后写 `null`，并且**同时取消挂起的
 *    防抖写入**——否则用户点了「丢弃草稿」后，之前排队的 setTimeout 会在
 *    800ms 后把草稿又写回去，下次进页面又"复活"了。
 *
 * 6. **不与 dirty 守卫冲突**：本 hook 只负责存取，是否恢复由调用方按既有
 *    语义决定（TaskFormPage：编辑态等任务回填完成、且表单未脏时才恢复）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** 草稿结构版本。字段增删导致旧草稿不合法时 +1（旧草稿整体丢弃）。 */
export const DRAFT_SCHEMA_VERSION = 1;

/** 默认防抖毫秒（localStorage 是同步 API，逐键同步写会卡输入） */
export const DRAFT_DEFAULT_DELAY_MS = 800;

/** 持久化信封：version 用于整体失效，savedAt 供 UI 展示「保存于…」 */
export interface DraftEnvelope<T> {
  version: number;
  savedAt: number;
  data: T;
}

/**
 * 构造草稿 key：`<ns>:v<schema>` + 可选作用域段。
 *
 * 作用域段是**必须**的：任务表单的草稿必须按「新建 / 编辑某 id / 模板某 id」
 * 隔离，否则编辑 A 任务时恢复的草稿会把 B 任务的内容填进去。
 * 分隔用 `::` 而非 `:`，避免 id 里出现冒号时与命名空间前缀混淆。
 */
export function draftKey(
  namespace: string,
  schemaVersion: number = DRAFT_SCHEMA_VERSION,
  scope?: string | readonly string[] | null,
): string {
  const base = `${namespace}:v${schemaVersion}`;
  if (scope == null) return base;
  const parts = (typeof scope === 'string' ? [scope] : scope).filter(
    (p) => typeof p === 'string' && p.length > 0,
  );
  return parts.length === 0 ? base : `${base}::${parts.join('::')}`;
}

/**
 * 取 localStorage；SSR / 无 window / 被策略禁用（隐私模式访问即抛）→ null。
 *
 * 注意 `window.localStorage` 的**读取本身**就可能抛（Safari 无痕模式抛
 * SecurityError），所以连属性访问都要包在 try 里。
 */
function getStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 解析持久化信封；任何异常（无值/坏 JSON/版本不符/形状不对）→ null */
export function parseDraft<T>(raw: string | null, version: number): DraftEnvelope<T> | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const env = parsed as Partial<DraftEnvelope<T>>;
    if (env.version !== version) return null;
    if (typeof env.savedAt !== 'number' || !Number.isFinite(env.savedAt)) return null;
    // data 允许为 null（某些表单的合法空态），但必须是显式存在的键
    if (!('data' in env)) return null;
    return { version: env.version, savedAt: env.savedAt, data: env.data as T };
  } catch {
    return null;
  }
}

/** 读取草稿（无值/坏值/版本不符 → null）。不抛错。 */
export function readDraft<T>(
  key: string,
  version: number = DRAFT_SCHEMA_VERSION,
): DraftEnvelope<T> | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    return parseDraft<T>(storage.getItem(key), version);
  } catch {
    return null;
  }
}

/**
 * 写入草稿。返回是否真的写成功（quota 满 / 隐私模式 → false）。
 * 失败**不抛错**：调用方（hook）据此决定是否降级为"本次会话无草稿"。
 */
export function writeDraft<T>(
  key: string,
  data: T,
  version: number = DRAFT_SCHEMA_VERSION,
): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    const env: DraftEnvelope<T> = { version, savedAt: Date.now(), data };
    storage.setItem(key, JSON.stringify(env));
    return true;
  } catch {
    return false;
  }
}

/** 删除草稿。返回是否真的删掉了（storage 不可用 → false）。不抛错。 */
export function removeDraft(key: string): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export interface UseDraftOptions<T> {
  /**
   * 草稿 key（**必须已含作用域**，用 `draftKey()` 构造）。
   *
   * `null`/空串 = 当前上下文不应有草稿（如编辑态任务尚未加载完成）——
   * 此时本 hook 完全惰性：不读、不写、不清。
   */
  key: string | null;
  /** 草稿值；key 有效时随值变化防抖落盘 */
  value: T;
  /**
   * 是否启用自动落盘（默认 true）。表单尚未完成回填时应传 false，
   * 否则会把「空表单」当成用户输入写进草稿，覆盖掉真正的草稿。
   */
  enabled?: boolean;
  /** 防抖毫秒（默认 800） */
  delay?: number;
  /** 结构版本（默认 DRAFT_SCHEMA_VERSION） */
  version?: number;
}

export interface UseDraftResult<T> {
  /** 挂载时读到的草稿（无草稿/版本不符/读失败 → null）。**只读一次**，不随后续写入变化。 */
  restored: DraftEnvelope<T> | null;
  /** 最近一次成功落盘的时间戳；从未落盘 → null */
  savedAt: number | null;
  /** 落盘是否因 storage 不可用/quota 失败而降级（true = 草稿不会持久化） */
  unavailable: boolean;
  /** 立即落盘（取消防抖等待）。用于「保存前/卸载前」 */
  flush: () => void;
  /** 丢弃草稿：删除存储 + 取消挂起的防抖写入（防「丢弃后又复活」） */
  discard: () => void;
}

/**
 * 表单草稿 hook（DRAFT-01）。
 *
 * 语义要点：
 *  - `restored` 在**首次渲染时同步**从 localStorage 读出（用 useState 的惰性
 *    初始化，避免"先空渲染再闪现恢复"）——但 key 变化（如编辑态 id 就绪）
 *    时会重新读取；
 *  - 值变化 → 防抖落盘；`enabled=false` 时不写（也不取消已有草稿）；
 *  - 卸载时 flush 挂起的写入（"改完立刻关页"不丢）；
 *  - F-47（UIUX 审计 P2-5）：`beforeunload`/`pagehide` 同步 flush——直接关闭
 *    标签页/窗口时 React 卸载清理不会执行，防抖窗口内的最后一笔由这两个
 *    页面卸载事件同步写盘兜住；
 *  - `discard()` 之后 `restored` 置 null 并停止自动落盘，直到 key 变化。
 */
export function useDraft<T>({
  key,
  value,
  enabled = true,
  delay = DRAFT_DEFAULT_DELAY_MS,
  version = DRAFT_SCHEMA_VERSION,
}: UseDraftOptions<T>): UseDraftResult<T> {
  // restored：按 key 惰性读取。用 key 作为"身份"，key 变化时重读。
  const [restored, setRestored] = useState<DraftEnvelope<T> | null>(() =>
    key ? readDraft<T>(key, version) : null,
  );
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // discard 之后置 false：阻止自动落盘把刚丢掉的草稿又写回去。
  const [active, setActive] = useState(true);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * 是否有「已改动但尚未落盘」的待写入。
   *
   * 不能只看 timerRef：卸载时 React 按 effect **声明顺序**跑 cleanup，防抖
   * effect 的 cleanup（clearTimer）先于下方卸载 flush effect 执行，等 flush
   * 跑到时 timerRef 已是 null——只看它就会漏掉"改完立刻关页"的最后一笔。
   */
  const pendingRef = useRef(false);
  // 最新值放 ref：flush 在卸载/事件回调里调用，不能读闭包里的旧 value。
  const valueRef = useRef(value);
  valueRef.current = value;
  const keyRef = useRef(key);
  keyRef.current = key;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** 真正落盘（同步）。返回是否成功。 */
  const persist = useCallback((): boolean => {
    const k = keyRef.current;
    pendingRef.current = false;
    if (!k) return false;
    const ok = writeDraft(k, valueRef.current, version);
    if (ok) {
      setSavedAt(Date.now());
      setUnavailable(false);
    } else {
      // quota 满 / 隐私模式：降级为"本次会话无草稿"，绝不冒泡到 UI 之外
      setUnavailable(true);
    }
    return ok;
  }, [version]);

  const flush = useCallback(() => {
    clearTimer();
    if (!active || !enabled) return;
    persist();
  }, [active, enabled, persist, clearTimer]);

  const discard = useCallback(() => {
    // 顺序要紧：先取消挂起的写入，再删存储——否则排队的 setTimeout 会把
    // 刚删掉的草稿又写回去（用户下次进页面看到"已丢弃"的草稿复活）。
    //
    // 两道保险各自的必要性（有反证用例，勿删）：
    //   · `clearTimer()` 其实是冗余的——防抖 effect 依赖含 `active`，
    //     `setActive(false)` 会让它重跑并执行上一轮 cleanup（return clearTimer）。
    //     留着是显式意图，删掉不会红。
    //   · `pendingRef.current = false` **不可删**：卸载 flush 的判据就是它，
    //     少了这行，「丢弃 → 立刻切页」会把草稿原样写回（use-draft.test 的
    //     「discard 后立即卸载」用例专钉这条）。
    clearTimer();
    pendingRef.current = false;
    const k = keyRef.current;
    if (k) removeDraft(k);
    setRestored(null);
    setSavedAt(null);
    setActive(false);
  }, [clearTimer]);

  // 卸载时 flush 挂起的写入（"改完立刻关页"不丢）。**必须声明在防抖 effect
  // 之前**，这样它的 cleanup 在 clearTimer 之后执行（cleanup 按声明顺序），
  // 才能看到 pendingRef 里"还有一笔没写"的事实。
  const versionRef = useRef(version);
  versionRef.current = version;
  useEffect(() => {
    return () => {
      if (!pendingRef.current) return;
      const k = keyRef.current;
      pendingRef.current = false;
      if (!k) return;
      // 直接写，不经过 persist（卸载期 setState 会告警）
      writeDraft(k, valueRef.current, versionRef.current);
    };
  }, []);

  // F-47（UIUX 审计 P2-5）：beforeunload/pagehide 同步 flush——「改完立刻关页」
  // 不丢的第三条路径。上面的卸载 flush 只覆盖 React 组件卸载（SPA 站内导航/
  // 分区替换）；**直接关闭标签页、窗口或浏览器刷新**时整个 JS 上下文被销毁，
  // React 的 effect cleanup 不会执行，防抖窗口（默认 800ms）内的最后一笔只能
  // 靠这两个页面卸载事件同步写盘（localStorage 是同步 API，事件回调里的
  // setItem 能在页面销毁前落盘）。pagehide 兜底 beforeunload 在移动端 Safari
  // /bfcache 路径下不触发的情况；两个事件都到时写两遍同值，幂等。
  // 判据与 flush() 一致（pending + enabled + active）：discard 后 pendingRef
  // 已清零，不会把用户明确丢弃的草稿写回（上方「丢弃后卸载」用例的卸载事件
  // 姊妹形态，同样被 pendingRef 判据挡住）。
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    const flushOnUnload = () => {
      if (!pendingRef.current) return;
      const k = keyRef.current;
      if (!k || !enabledRef.current || !activeRef.current) return;
      pendingRef.current = false;
      // 直接写，不经过 persist（页面卸载事件里 setState 无意义）
      writeDraft(k, valueRef.current, versionRef.current);
    };
    window.addEventListener('beforeunload', flushOnUnload);
    window.addEventListener('pagehide', flushOnUnload);
    return () => {
      window.removeEventListener('beforeunload', flushOnUnload);
      window.removeEventListener('pagehide', flushOnUnload);
    };
  }, []);

  // key 变化（编辑态 id 就绪 / 切换模板）：重读草稿并恢复自动落盘。
  // 首次挂载跳过——useState 惰性初始化已读过，避免多一次渲染。
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    clearTimer();
    pendingRef.current = false;
    setRestored(key ? readDraft<T>(key, version) : null);
    setSavedAt(null);
    setActive(true);
  }, [key, version, clearTimer]);

  // 值变化 → 防抖落盘
  useEffect(() => {
    if (!key || !enabled || !active) return;
    clearTimer();
    pendingRef.current = true;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      persist();
    }, delay);
    return clearTimer;
  }, [value, key, enabled, active, delay, persist, clearTimer]);

  return useMemo(
    () => ({ restored, savedAt, unavailable, flush, discard }),
    [restored, savedAt, unavailable, flush, discard],
  );
}

export default useDraft;
