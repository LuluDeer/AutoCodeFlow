/**
 * R189（P3-4）· 历史会话列表的**三态读取**（与同页 `useVideoProviders` 配对）。
 *
 * ## 为什么需要它（这不是「多写一个 hook」）
 *
 * 旧实现是 `useEffect` 里 `try { setSessions(...) } catch { /* 忽略 *\/ }`，
 * 而渲染处是 **`sessions.length > 0 ? <Select/> : null`** ⇒
 * **读失败时整个下拉控件不渲染** ⇒ 用户**连「这里本该有个历史会话入口」都不知道**，
 * 更没有任何线索去重试。
 *
 * 而本页的 Provider 列表**早已**做足了三态（`useVideoProviders` 的
 * `loading | ready | error` + `ProviderStatusAlert`），其头注明写
 * 「『未知』绝不当作『没有』」——**同一页两套对待「读不到」的方式**，是本条的实质。
 *
 * ## 后果（为什么值得修）
 *
 * 视频解析要**调模型、要时间**。失败后下拉消失 ⇒ 用户的自然反应是
 * 「**草稿丢了**」⇒ **重跑一遍** ⇒ **重复花钱**（模型调用费 + 用户的等待）。
 * 「以为白干了一场」比「看不见一行摘要」更伤。
 *
 * ## 判据（消费方不得再用「数组长度」推断）
 *
 * · `state === 'loading'` → 尚无事实（**不得**当作「没有历史会话」）；
 * · `state === 'ready'`   → **真的读到且为空** ⇒ 这才是「没有历史会话」；
 * · `state === 'error'`   → **没读到** ⇒ 必须呈现「失败 + 重试」。
 */
import { useCallback, useEffect, useState } from 'react';
import { aiApi } from '../../api/ai';

/** 读取状态：唯一的事实源。 */
export type SopSessionsState = 'loading' | 'ready' | 'error';

export interface SopSessionListItem {
  id: string;
  status: string;
  updatedAt: string;
  title: string | null;
}

export interface SopSessionsResult {
  sessions: SopSessionListItem[];
  state: SopSessionsState;
  /** 失败时的原始错误（交给 `StateError` 做本地化展示）。 */
  error: unknown;
  /** 重新拉取——失败态唯一的重试入口。 */
  reload: () => void;
}

/**
 * 拉取历史会话（每页 20 条）。
 *
 * `alive` 守卫与同页 `useVideoProviders` 同纪律：卸载后不再 setState
 * （也避免 StrictMode 双跑时后到的旧响应覆盖新状态）。
 */
export function useSopSessions(): SopSessionsResult {
  const [sessions, setSessions] = useState<SopSessionListItem[]>([]);
  const [state, setState] = useState<SopSessionsState>('loading');
  const [error, setError] = useState<unknown>(null);
  // 重试序号：点「重试」只是 +1，effect 重跑；不把 reload 做成命令式请求，
  // 免得与首载两条路径各自维护 loading/error（同 `useVideoProviders`）。
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setState('loading');
    setError(null);
    void (async () => {
      try {
        const list = await aiApi.listSopSessions({ pageSize: 20 });
        if (!alive) return;
        setSessions(list.items);
        setState('ready');
      } catch (err: unknown) {
        if (!alive) return;
        // R189：不再静默吞掉——**「没读到」与「没有」必须分开**（见头注）。
        setError(err);
        setState('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  return { sessions, state, error, reload };
}
