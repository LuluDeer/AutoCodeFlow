/**
 * 工作台表单 + preview/commit 编排（从 pages/WorkbenchPage.tsx 外提）。
 * handlers、落盘锚点、确认记录与审批三态回退逐字保留；页面只做组装与
 * useWorkbenchSession 接线。onPreviewStart 是惰性转发：本 hook 先于会话
 * hook 调用（要先用 commitResult/result/submittedInput 算锚点），点击预览
 * 时才解引用页面转发的当前 session reset。
 */
import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import {
  previewPlan,
  commitPlan,
  type CommitResult,
  type PreviewPlanResult,
  type WorkbenchCadence,
} from '../api/workbench';
import { useAuthStore } from '../store/auth';
import {
  clearWorkbenchAnchor,
  clearWorkbenchCommit,
  persistWorkbenchAnchor,
  persistWorkbenchCommit,
  readWorkbenchCommit,
  sessionAnchor,
} from './useWorkbenchSession';

/**
 * 预览时真正提交给后端的入参。确认阶段必须复用它（而不是重新读表单），
 * 否则用户预览后又改了输入框，服务端重建的 hash 会与 expectedCardHash 不一致。
 */
export interface SubmittedInput {
  goal: string;
  cadence: WorkbenchCadence;
  params?: Record<string, string>;
}

export interface ConfirmRecord {
  cardHash: string;
  policyGeneration: string;
  at: string;
  user: string;
}

export interface UseWorkbenchFormOptions {
  /** 新一轮预览开始时清空会话面板（由页面转发 useWorkbenchSession.reset）。 */
  onPreviewStart?: () => void;
}

export interface UseWorkbenchFormResult {
  goal: string;
  setGoal: Dispatch<SetStateAction<string>>;
  cadence: WorkbenchCadence;
  setCadence: Dispatch<SetStateAction<WorkbenchCadence>>;
  paramText: string;
  setParamText: Dispatch<SetStateAction<string>>;
  result: PreviewPlanResult | null;
  submittedInput: SubmittedInput | null;
  error: string | null;
  previewing: boolean;
  committing: boolean;
  commitError: string | null;
  commitResult: CommitResult | null;
  records: ConfirmRecord[];
  hasFail: boolean;
  canConfirm: boolean;
  approvalKey: string;
  approvalStatus: CommitResult['approvalStatus'];
  isAdmin: boolean;
  handlePreview: () => Promise<void>;
  handleConfirm: () => Promise<void>;
}

/**
 * commit 失败时从后端响应体取业务文案：generation 失配的中文说明放在 detail，
 * 不能让固定兜底文案把它吃掉。client 拦截器 reject 的是响应体（带 __status 标），
 * 也可能是原始 Error；只认后端响应形态，避免把本地 Error 的 message 当成后端文案。
 */
function pickBackendErrorMessage(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const body = err as Record<string, unknown>;
  const nested = body.response;
  const nestedData =
    nested && typeof nested === 'object'
      ? (nested as Record<string, unknown>).data
      : undefined;
  const fromResponse =
    nestedData && typeof nestedData === 'object'
      ? (nestedData as Record<string, unknown>)
      : null;
  const looksLikeApiError =
    'detail' in body || 'errorCode' in body || '__status' in body || fromResponse !== null;
  if (!looksLikeApiError) return null;

  const asText = (value: unknown): string => {
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) {
      return value.filter((x): x is string => typeof x === 'string' && !!x.trim()).join('; ').trim();
    }
    return '';
  };
  for (const source of [body, fromResponse]) {
    if (!source) continue;
    const text = asText(source.detail) || asText(source.message) || asText(source.error);
    if (text) return text;
  }
  return null;
}

/** 可选参数：一行「键=值」，中英文逗号均可分隔；解析失败的分段静默忽略。 */
function parseParams(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const part of raw.split(/[,，]/)) {
    const pair = part.trim();
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    params[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return params;
}

export function useWorkbenchForm(
  { onPreviewStart }: UseWorkbenchFormOptions = {},
): UseWorkbenchFormResult {
  const { t } = useTranslation();
  const [goal, setGoal] = useState('');
  const [cadence, setCadence] = useState<WorkbenchCadence>('daily');
  const [paramText, setParamText] = useState('');
  const [result, setResult] = useState<PreviewPlanResult | null>(null);
  const [submittedInput, setSubmittedInput] = useState<SubmittedInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitResult, setCommitResult] = useState<CommitResult | null>(() => readWorkbenchCommit());
  const [records, setRecords] = useState<ConfirmRecord[]>([]);
  const user = useAuthStore((s) => s.user);
  // UX-AUDIT：/sops 为 ADMIN-only。业务用户提交后不得被引导到 403 墙——
  // 用一句诚实的话说明「已提交审阅、草稿未运行、等待通知」，管理员保留原链接。
  const isAdmin = user?.role === 'admin';
  // 真正的互斥锁：state 更新在同一 tick 的两次点击之间可能还没生效，用 ref 兜住防重复提交。
  const committingRef = useRef(false);
  const onPreviewStartRef = useRef(onPreviewStart);
  onPreviewStartRef.current = onPreviewStart;

  const hasFail = result?.checks.some((c) => c.status === 'fail') ?? false;
  const canConfirm = Boolean(result?.eligible) && !hasFail;
  // ADR-045：发布审批单标识（仅 submitted 时有；空串按缺席处理）。
  const approvalKey = commitResult?.approvalKey?.trim() ?? '';
  // 三态稳定码驱动界面：后端必填；老后端未回带时按 key 保守回退，绝不冒充「已提交」。
  const approvalStatus: CommitResult['approvalStatus'] =
    commitResult?.approvalStatus ?? (approvalKey ? 'submitted' : 'not_requested');

  async function handlePreview() {
    if (!goal.trim()) { setError(t('workbench.goalRequired')); return; }
    setPreviewing(true);
    setError(null);
    setResult(null);
    setSubmittedInput(null);
    setCommitResult(null);
    setCommitError(null);
    clearWorkbenchCommit();
    clearWorkbenchAnchor();
    // Writer B：新一轮预览清空上一轮会话面板，避免展示过期草稿的会话。
    onPreviewStartRef.current?.();
    try {
      const params = parseParams(paramText);
      const input: SubmittedInput = { goal: goal.trim(), cadence, ...(Object.keys(params).length > 0 ? { params } : {}) };
      const data = await previewPlan(input);
      setResult(data);
      setSubmittedInput(input);
    } catch {
      setError(t('workbench.previewFailed'));
    } finally {
      setPreviewing(false);
    }
  }

  async function handleConfirm() {
    if (!result || !canConfirm || committingRef.current) return;
    // 没有 cardHash / policyGeneration 就没有校验锚点：绝不发写请求，给出可操作的提示。
    if (!result.cardHash || !result.policyGeneration || !submittedInput) {
      setCommitError(t('workbench.missingIds'));
      return;
    }
    committingRef.current = true;
    setCommitting(true);
    setCommitError(null);
    setCommitResult(null);
    // 与 cardHash 同源：都取 preview 时的 result + submittedInput，表单后来被改也不会误提交。
    const { cardHash, policyGeneration } = result;
    try {
      const saved = await commitPlan({
        ...submittedInput,
        expectedCardHash: cardHash,
        expectedPolicyGeneration: policyGeneration,
      });
      setCommitResult(saved);
      persistWorkbenchCommit(saved);
      const committedAnchor = sessionAnchor(saved, cardHash, submittedInput.goal);
      if (committedAnchor) persistWorkbenchAnchor(committedAnchor);
      // 确认记录锚定本次实际放行的策略代际：优先取 commit 回带值（第三闸已校验），
      // 缺省时回退 preview 值以兼容旧后端；即便与 preview 不同也只记值、不报错，
      // 因为提交已成功落库，不能制造「成功却报错」的矛盾。
      const recordedGeneration = saved.policyGeneration ?? policyGeneration;
      // 本地确认记录仅作 UX 反馈；真正的落库结果是上面的 commitResult。
      setRecords((prev) => [
        {
          cardHash,
          policyGeneration: recordedGeneration,
          at: new Date().toISOString(),
          user: user?.username ?? t('workbench.currentUser'),
        },
        ...prev,
      ]);
    } catch (err: unknown) {
      // generation 失配等后端业务错误把中文原因写在 detail，内联 Alert 必须透出。
      const detail = pickBackendErrorMessage(err);
      setCommitError(
        detail
          ? t('workbench.confirmFailedDetail', { detail })
          : t('workbench.confirmFailed'),
      );
    } finally {
      committingRef.current = false;
      setCommitting(false);
    }
  }

  return {
    goal, setGoal,
    cadence, setCadence,
    paramText, setParamText,
    result, submittedInput,
    error, previewing,
    committing, commitError, commitResult,
    records,
    hasFail, canConfirm,
    approvalKey, approvalStatus,
    isAdmin,
    handlePreview, handleConfirm,
  };
}
