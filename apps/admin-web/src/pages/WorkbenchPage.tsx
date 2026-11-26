import { useRef, useState } from 'react';
import { Alert, Button, Card, Input, Select, Space, Tag, Typography } from 'antd';
import {
  previewPlan,
  commitPlan,
  type CommitResult,
  type PreviewPlanResult,
  type WorkbenchCadence,
} from '../api/workbench';
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

const CADENCE_OPTIONS: Array<{ value: WorkbenchCadence; label: string }> = [
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
];

const CHECK_LABEL = { ok: '通过', warn: '提醒', fail: '未通过' } as const;
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

  async function handlePreview() {
    if (!goal.trim()) {
      setError('请先填写业务目标。');
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
      setError('方案预览失败，请稍后重试。');
    } finally {
      setPreviewing(false);
    }
  }

  async function handleConfirm() {
    if (!result || !canConfirm || committingRef.current) return;
    // 没有 cardHash / policyGeneration 就没有校验锚点：绝不发写请求，给出可操作的提示。
    if (!result.cardHash || !result.policyGeneration || !submittedInput) {
      setCommitError('方案缺少标识，请重新预览后再确认。');
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
          user: user?.username ?? '当前用户',
        },
        ...prev,
      ]);
    } catch (err: unknown) {
      // generation 失配等后端业务错误把中文原因写在 detail，内联 Alert 必须透出。
      const detail = pickBackendErrorMessage(err);
      setCommitError(
        detail ? `确认失败：${detail}` : '确认失败，方案未能保存为草稿，请稍后重试。',
      );
    } finally {
      committingRef.current = false;
      setCommitting(false);
    }
  }

  return (
    <div data-testid="workbench-page">
      <Typography.Title level={3}>工作台 · 最小验证</Typography.Title>
      <Typography.Paragraph type="secondary">
        填写业务信息，预览方案后确认即可存为草稿；审阅发布后才会执行。
      </Typography.Paragraph>

      <Card title="业务信息" style={{ marginBottom: 16 }}>
        <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
          <div>
            <div style={{ marginBottom: 4 }}>业务目标</div>
            <Input
              placeholder="例如：每周汇总项目状态并生成报告"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>执行频率</div>
            <Select<WorkbenchCadence>
              value={cadence}
              onChange={setCadence}
              options={CADENCE_OPTIONS}
              style={{ width: 200 }}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>可选参数</div>
            <Input
              placeholder="键=值，多个用逗号分隔"
              value={paramText}
              onChange={(e) => setParamText(e.target.value)}
            />
          </div>
          <Button type="primary" loading={previewing} onClick={() => void handlePreview()}>
            预览方案
          </Button>
        </Space>
      </Card>

      {error ? <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} /> : null}

      {result ? (
        <Card title="方案预览" style={{ marginBottom: 16 }}>
          <Typography.Title level={4}>{result.card.title}</Typography.Title>
          <p>触发节奏：{result.card.triggerText}</p>
          <div style={{ marginBottom: 8 }}>
            能力提示：
            {result.card.capabilityHints.map((hint, i) => (
              <Tag key={`${hint}-${i}`} color="blue">{hint}</Tag>
            ))}
          </div>
          <p>验收标准：{result.card.acceptanceText}</p>
          <p>预算上限：最多 {result.card.budget.maxTurns} 轮</p>
          <div style={{ marginBottom: 8 }}>
            核查结果：
            {result.checks.map((check, i) => (
              <Tag key={`${check.field}-${i}`} color={CHECK_COLOR[check.status]}>
                {CHECK_LABEL[check.status]} · {check.field} · {check.message}
              </Tag>
            ))}
          </div>
          {!result.eligible ? (
            <Alert
              type="warning"
              showIcon
              title="当前方案尚不满足执行条件，请调整业务信息后重新预览。"
              style={{ marginBottom: 12 }}
            />
          ) : null}
          <Button
            type="primary"
            loading={committing}
            disabled={!canConfirm || committing}
            onClick={() => void handleConfirm()}
          >
            确认方案
          </Button>
          {!canConfirm && result.eligible ? (
            <Typography.Text type="secondary" style={{ marginLeft: 12 }}>
              存在未通过的核查项，暂不能确认。
            </Typography.Text>
          ) : null}
          {commitError ? (
            <Alert type="error" showIcon title={commitError} style={{ marginTop: 12 }} />
          ) : null}
        </Card>
      ) : null}

      {commitResult ? (
        <Card title="确认结果" data-testid="workbench-commit-success" style={{ marginBottom: 16 }}>
          <Alert
            type="success"
            showIcon
            title="已存为草稿，需在 SOP 页审阅发布后才执行；当前未执行。"
            style={{ marginBottom: 12 }}
          />
          <Space orientation="vertical" size="small">
            <div>
              <Typography.Text type="secondary">状态：</Typography.Text>
              <Tag color="orange">草稿</Tag>
            </div>
            <div>SOP 编号：{commitResult.sopId}</div>
            <div data-testid="workbench-commit-slug">标识名：{commitResult.slug}</div>
            <div>后续步骤：{commitResult.next}</div>
            <a href={`/sops?sop=${encodeURIComponent(commitResult.sopId)}`}>去 SOP 页审阅</a>
          </Space>
        </Card>
      ) : null}

      {records.length > 0 ? (
        <Card title="确认留痕">
          <Space orientation="vertical">
            {records.map((record, i) => (
              <div
                key={`${record.cardHash}-${i}`}
                data-testid="workbench-confirm-record"
                data-generation={record.policyGeneration}
              >
                <span>已确认并留痕，方案已存为草稿，审阅发布后才会执行</span>
                <span>方案标识：{record.cardHash}</span>
                <span>策略代际：{record.policyGeneration.slice(0, 8)}</span>
                <span>时间：{record.at}</span>
                <span>操作人：{record.user}</span>
              </div>
            ))}
          </Space>
        </Card>
      ) : null}
    </div>
  );
}
