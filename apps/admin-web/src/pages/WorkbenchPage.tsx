import { useRef, useState } from 'react';
import { Alert, Button, Card, Input, Select, Space, Tag, Typography } from 'antd';
import {
  previewPlan,
  commitPlan,
  type CommitResult,
  type PreviewPlanResult,
  type WorkbenchCadence,
} from '../api/workbench';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/auth';

interface ConfirmRecord {
  cardHash: string;
  policyGeneration: string;
  at: string;
  user: string;
}

/**
 * 预览时真正提交给后端的入参。确认阶段必须复用它（而不是重新读表单），
 * 否则用户预览后又改了输入框，服务端重建的 hash 会与 expectedCardHash 不一致。
 */
interface SubmittedInput {
  goal: string;
  cadence: WorkbenchCadence;
  params?: Record<string, string>;
}

type Translate = import('i18next').TFunction;

const cadenceOptions = (t: Translate): Array<{ value: WorkbenchCadence; label: string }> => [
  { value: 'daily', label: t('workbench.cadence.daily') },
  { value: 'weekly', label: t('workbench.cadence.weekly') },
  { value: 'monthly', label: t('workbench.cadence.monthly') },
];

function checkLabel(t: Translate, status: string): string {
  switch (status) {
    case 'ok':
      return t('workbench.check.ok');
    case 'warn':
      return t('workbench.check.warn');
    case 'fail':
      return t('workbench.check.fail');
    default:
      return status;
  }
}
const CHECK_COLOR = { ok: 'green', warn: 'orange', fail: 'red' } as const;

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

export default function WorkbenchPage() {
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
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);
  const [records, setRecords] = useState<ConfirmRecord[]>([]);
  const user = useAuthStore((s) => s.user);
  // 真正的互斥锁：state 更新在同一 tick 的两次点击之间可能还没生效，用 ref 兜住防重复提交。
  const committingRef = useRef(false);

  const hasFail = result?.checks.some((c) => c.status === 'fail') ?? false;
  const canConfirm = Boolean(result?.eligible) && !hasFail;
  // ADR-045：发布审批单标识（仅 submitted 时有；空串按缺席处理）。
  const approvalKey = commitResult?.approvalKey?.trim() ?? '';
  // 三态稳定码驱动界面：后端必填；老后端未回带时按 key 保守回退，绝不冒充「已提交」。
  const approvalStatus: CommitResult['approvalStatus'] =
    commitResult?.approvalStatus ?? (approvalKey ? 'submitted' : 'not_requested');

  async function handlePreview() {
    if (!goal.trim()) {
      setError(t('workbench.goalRequired'));
      return;
    }
    setPreviewing(true);
    setError(null);
    setResult(null);
    setSubmittedInput(null);
    setCommitResult(null);
    setCommitError(null);
    try {
      const params = parseParams(paramText);
      const input: SubmittedInput = {
        goal: goal.trim(),
        cadence,
        ...(Object.keys(params).length > 0 ? { params } : {}),
      };
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

  return (
    <div data-testid="workbench-page">
      <Typography.Title level={3}>{t('workbench.page.title')}</Typography.Title>
      <Typography.Paragraph type="secondary">
        {t('workbench.page.desc')}
      </Typography.Paragraph>

      <Card title={t('workbench.card.business')} style={{ marginBottom: 16 }}>
        <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
          <div>
            <div style={{ marginBottom: 4 }}>{t('workbench.field.goal')}</div>
            <Input
              placeholder={t('workbench.goal.placeholder')}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>{t('workbench.field.cadence')}</div>
            <Select<WorkbenchCadence>
              value={cadence}
              onChange={setCadence}
              options={cadenceOptions(t)}
              style={{ width: 200 }}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>{t('workbench.field.params')}</div>
            <Input
              placeholder={t('workbench.params.placeholder')}
              value={paramText}
              onChange={(e) => setParamText(e.target.value)}
            />
          </div>
          <Button type="primary" loading={previewing} onClick={() => void handlePreview()}>
            {t('workbench.preview.action')}
          </Button>
        </Space>
      </Card>

      {error ? <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} /> : null}

      {result ? (
        <Card title={t('workbench.preview.title')} style={{ marginBottom: 16 }}>
          <Typography.Title level={4}>{result.card.title}</Typography.Title>
          <p>{t('workbench.card.trigger', { text: result.card.triggerText })}</p>
          <div style={{ marginBottom: 8 }}>
            {t('workbench.card.hints')}
            {result.card.capabilityHints.map((hint, i) => (
              <Tag key={`${hint}-${i}`} color="blue">{hint}</Tag>
            ))}
          </div>
          <p>{t('workbench.card.acceptance', { text: result.card.acceptanceText })}</p>
          <p>{t('workbench.card.budget', { max: result.card.budget.maxTurns })}</p>
          <div style={{ marginBottom: 8 }}>
            {t('workbench.card.checks')}
            {result.checks.map((check, i) => (
              <Tag key={`${check.field}-${i}`} color={CHECK_COLOR[check.status]}>
                {checkLabel(t, check.status)} · {check.field} · {check.message}
              </Tag>
            ))}
          </div>
          {!result.eligible ? (
            <Alert
              type="warning"
              showIcon
              title={t('workbench.notEligible')}
              style={{ marginBottom: 12 }}
            />
          ) : null}
          <Button
            type="primary"
            loading={committing}
            disabled={!canConfirm || committing}
            onClick={() => void handleConfirm()}
          >
            {t('workbench.confirm.action')}
          </Button>
          {!canConfirm && result.eligible ? (
            <Typography.Text type="secondary" style={{ marginLeft: 12 }}>
              {t('workbench.hasFail')}
            </Typography.Text>
          ) : null}
          {commitError ? (
            <Alert type="error" showIcon title={commitError} style={{ marginTop: 12 }} />
          ) : null}
        </Card>
      ) : null}

      {commitResult ? (
        <Card title={t('workbench.confirm.title')} data-testid="workbench-commit-success" style={{ marginBottom: 16 }}>
          {approvalStatus === 'failed' ? (
            <Alert
              type="warning"
              showIcon
              title={t('workbench.commit.approvalFailed')}
              style={{ marginBottom: 12 }}
            />
          ) : approvalStatus === 'not_requested' ? (
            <Alert
              type="info"
              showIcon
              title={t('workbench.commit.approvalNotRequested')}
              style={{ marginBottom: 12 }}
            />
          ) : approvalStatus === 'submitted' ? (
            <Alert
              type="success"
              showIcon
              title={t('workbench.confirm.success')}
              style={{ marginBottom: 12 }}
            />
          ) : (
            <Alert
              type="warning"
              showIcon
              title={t('workbench.commit.approvalUnknown')}
              style={{ marginBottom: 12 }}
            />
          )}
          <Space orientation="vertical" size="small">
            <div>
              <Typography.Text type="secondary">{t('workbench.status.label')}</Typography.Text>
              <Tag color="orange">{t('workbench.status.draft')}</Tag>
            </div>
            <div>{t('workbench.sopId', { id: commitResult.sopId })}</div>
            <div data-testid="workbench-commit-slug">{t('workbench.slug', { slug: commitResult.slug })}</div>
            {approvalStatus === 'submitted' ? (
              <div>{t('workbench.approval.submittedNext')}</div>
            ) : null}
            {approvalStatus === 'submitted' ? (
              <a href={`/sops?sop=${encodeURIComponent(commitResult.sopId)}`}>{t('workbench.sopLink')}</a>
            ) : approvalStatus === 'failed' ? (
              <div>{t('workbench.approval.failedNoSopLink')}</div>
            ) : (
              <div>{t('workbench.sopLink.textOnly')}</div>
            )}
            {approvalStatus === 'submitted' && approvalKey ? (
              <div data-testid="workbench-commit-approval" style={{ marginTop: 4 }}>
                <Alert
                  type="info"
                  showIcon
                  title={t('workbench.approval.alert')}
                  style={{ marginBottom: 8 }}
                />
                <div data-testid="workbench-approval-status">{t('workbench.approval.status')}</div>
                <div>
                  {t('workbench.approval.keyLabel')}
                  <Typography.Text code data-testid="workbench-approval-key">
                    {approvalKey}
                  </Typography.Text>
                </div>
                <a data-testid="workbench-approval-link" href="/inbox">
                  {t('workbench.approval.link')}
                </a>
              </div>
            ) : null}
          </Space>
        </Card>
      ) : null}

      {records.length > 0 ? (
        <Card title={t('workbench.history.title')}>
          <Space orientation="vertical">
            {records.map((record, i) => (
              <div
                key={`${record.cardHash}-${i}`}
                data-testid="workbench-confirm-record"
                data-generation={record.policyGeneration}
              >
                <span>{t('workbench.history.note')}</span>
                <span>{t('workbench.history.cardHash', { hash: record.cardHash })}</span>
                <span>{t('workbench.history.generation', { generation: record.policyGeneration.slice(0, 8) })}</span>
                <span>{t('workbench.history.time', { time: record.at })}</span>
                <span>{t('workbench.history.user', { user: record.user })}</span>
              </div>
            ))}
          </Space>
        </Card>
      ) : null}
    </div>
  );
}
