/**
 * UX-AUDIT / Writer B：工作台受限起草会话的**状态编排**（创建 + 轮询 + 错误）。
 *
 * 从 WorkbenchPage 外提的原因：页面函数体是 check:size-caps 的度量单元
 * （单函数 > 300 行 ⇒ 红），会话编排（轮询 effect / 错误映射 / 创建 handler）
 * 属独立职责，与表单预览/提交正交。页面只消费本 hook 暴露的状态与 startSession。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createWorkbenchSession, getWorkbenchSession } from '../api/workbench';
import type { CommitResult } from '../api/workbench';
import { isTerminalSession, type WorkbenchSessionView } from '../components/workbench/WorkbenchSessionPanel';

/** 会话轮询间隔（毫秒）。终态或卸载即停止。 */
const SESSION_POLL_MS = 2000;

export interface UseWorkbenchSessionResult {
  sessionId: string | null;
  session: WorkbenchSessionView | null;
  error: string | null;
  starting: boolean;
  start: () => Promise<void>;
  reset: () => void;
}

/**
 * @param getAnchor 返回创建会话所需的 (sopId, goal, cardHash)；无锚点时返回 null。
 */
export function useWorkbenchSession(
  getAnchor: () => { sopId: string; goal: string; expectedCardHash: string } | null,
): UseWorkbenchSessionResult {
  const { t } = useTranslation();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<WorkbenchSessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);

  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await getWorkbenchSession(sessionId);
        if (!alive) return;
        setSession(next);
        if (isTerminalSession(next.status)) return; // 终态：不再排下一次
      } catch {
        // 轮询失败保留上一份快照（不把「读不到」谎报成「会话没了」）；下次继续。
        if (!alive) return;
      }
      if (alive) timer = setTimeout(poll, SESSION_POLL_MS);
    };
    void poll();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [sessionId]);

  const errorText = useCallback((err: unknown): string => {
    const status = err as { __status?: number; status?: number; response?: { status?: number } } | null;
    const code = status?.__status ?? status?.status ?? status?.response?.status;
    // 字面 t() 分支（动态 t(key) 会被 i18n 缺键守卫判不可判）。
    if (code === 403) return t('workbench.session.createFail.forbidden');
    if (code === 400) return t('workbench.session.createFail.notDraft');
    if (code === 404) return t('workbench.session.createFail.notFound');
    if (code === 503) return t('workbench.session.createFail.unavailable');
    return t('workbench.session.createFailed', { reason: t('common.operateFailed') });
  }, [t]);

  const start = useCallback(async () => {
    const anchor = getAnchor();
    if (!anchor || startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setError(null);
    try {
      const created = await createWorkbenchSession(anchor);
      setSessionId(created.sessionId);
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [getAnchor, errorText]);

  const reset = useCallback(() => {
    setSessionId(null);
    setSession(null);
    setError(null);
  }, []);

  return { sessionId, session, error, starting, start, reset };
}

/** 供页面判断锚点齐备（commitResult / result / submittedInput 三者齐全且已 submitted）。 */
export function sessionAnchor(
  commit: CommitResult | null,
  cardHash: string | undefined,
  goal: string | undefined,
): { sopId: string; goal: string; expectedCardHash: string } | null {
  if (!commit || !cardHash || !goal) return null;
  return { sopId: commit.sopId, goal, expectedCardHash: cardHash };
}
