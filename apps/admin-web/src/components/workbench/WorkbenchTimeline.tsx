/**
 * 主时间线：步骤、工具调用、审批卡、错误/等待提示统一在中间栏可读。
 *
 * ApprovalList 同时被 Timeline 与 Inspector 消费：主时间线内联是默认审批入口，
 * 移动端抽屉收起时也能直接批准/拒绝；Inspector 保留镜像供管理员对照产物。
 */
import { useState } from 'react';
import { Alert, Button, Collapse, Space, Tag, Typography } from 'antd';
import {
  DownOutlined,
  LoadingOutlined,
  RightOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import MarkdownView from '../MarkdownView';
import { clip, formatTime, statusTone } from '../../pages/workbench/format';
import {
  approvalStatusLabel,
  sessionStatusLabel,
  toolStatusLabel,
} from './statusLabel';
import type {
  WorkbenchApprovalDecision,
  WorkbenchApprovalItem,
  WorkbenchSessionDetail,
  WorkbenchStep,
  WorkbenchToolCall,
} from '../../pages/workbench/types-public';

const { Text } = Typography;

/** 后端契约尚未把 callId/argsRaw 写进共享 DTO：此处只读扩展字段，缺则静默降级。 */
type ApprovalWithCall = WorkbenchApprovalItem & { callId?: string | null };
type ToolCallWithRaw = WorkbenchToolCall & { callId?: string | null; argsRaw?: unknown };

function stepRoleLabel(t: (k: string) => string, role: string): string {
  switch (role) {
    case 'user': return t('workbench.role.user');
    case 'assistant': return t('workbench.role.assistant');
    case 'reasoning': return t('workbench.role.reasoning');
    case 'tool': return t('workbench.role.tool');
    case 'system': return t('workbench.role.system');
    default: return role;
  }
}

/**
 * 用 callId（不是数组序号、不是同名工具猜测）关联审批单与工具调用，
 * 从 argsRaw 抽出 shell command / terminal_send.text。解析失败返回 null，
 * 调用方不渲染任何占位垃圾。
 */
function approvalCommandOf(
  approval: WorkbenchApprovalItem,
  toolCalls: readonly WorkbenchToolCall[],
): string | null {
  const callId = (approval as ApprovalWithCall).callId;
  if (!callId) return null;
  const call = toolCalls.find((item) => (item as ToolCallWithRaw).callId === callId);
  if (!call) return null;
  let args: unknown = (call as ToolCallWithRaw).argsRaw;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const raw = args as Record<string, unknown>;
  const command = typeof raw.command === 'string' ? raw.command : null;
  const text = typeof raw.text === 'string' ? raw.text : null;
  const candidate = call.toolName === 'terminal_send' ? (text ?? command) : (command ?? text);
  if (!candidate || !candidate.trim()) return null;
  return clip(candidate.trim(), 200);
}

function toolDuration(call: WorkbenchToolCall): string | null {
  if (!call.createdAt || !call.stateChangedAt) return null;
  const start = new Date(call.createdAt).getTime();
  const end = new Date(call.stateChangedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const ms = end - start;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function StepCard({ step }: { step: WorkbenchStep }) {
  const { t } = useTranslation();
  const body = step.content || step.contentPreview || '';
  const isUser = step.role === 'user';
  return (
    <div
      data-testid="workbench-step"
      style={{
        padding: 10,
        borderRadius: 8,
        background: isUser ? 'rgba(22,119,255,0.055)' : 'rgba(127,127,127,0.055)',
        border: '1px solid rgba(127,127,127,0.12)',
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <Tag color={isUser ? 'blue' : 'default'} style={{ marginInlineEnd: 0 }}>
          {stepRoleLabel(t, step.role)}
        </Tag>
        <Text type="secondary" style={{ fontSize: 11 }}>#{step.seq}</Text>
        <Text type="secondary" style={{ fontSize: 11, marginLeft: 'auto' }}>
          {formatTime(step.createdAt)}
        </Text>
      </div>
      {body ? <MarkdownView source={body} /> : <Text type="secondary">{t('workbench.timeline.emptyStep')}</Text>}
    </div>
  );
}

function ToolCard({ call }: { call: WorkbenchToolCall }) {
  const { t } = useTranslation();
  const duration = toolDuration(call);
  return (
    <div data-testid="workbench-tool-card" style={{ border: '1px solid rgba(127,127,127,0.16)', borderRadius: 8 }}>
      <Collapse
        ghost
        items={[{
          key: 'tool',
          label: (
            <Space size={6} wrap>
              <Text strong style={{ fontSize: 13 }}>{call.toolName}</Text>
              <Tag color={statusTone(call.status)}>{toolStatusLabel(t, call.status)}</Tag>
              {duration ? <Text type="secondary" style={{ fontSize: 11 }}>{duration}</Text> : null}
              {call.errorSummary ? <Text type="danger" style={{ fontSize: 11 }}>{clip(call.errorSummary, 120)}</Text> : null}
            </Space>
          ),
          children: (
            <Space orientation="vertical" size={4} style={{ width: '100%' }}>
              <div>
                <Text type="secondary" style={{ fontSize: 11 }}>{t('workbench.tool.args')}</Text>
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}>
                  {call.argsPreview || t('workbench.timeline.none')}
                </pre>
              </div>
              <div>
                <Text type="secondary" style={{ fontSize: 11 }}>{t('workbench.tool.output')}</Text>
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}>
                  {call.outputPreview || t('workbench.timeline.none')}
                </pre>
              </div>
            </Space>
          ),
        }]}
      />
    </div>
  );
}

function ApprovalCard({
  item,
  command,
  acting,
  onDecide,
}: {
  item: WorkbenchApprovalItem;
  command: string | null;
  acting: boolean;
  onDecide: (key: string, decision: WorkbenchApprovalDecision) => void;
}) {
  const { t } = useTranslation();
  const showDigest = Boolean(item.argsDigest);
  return (
    <div
      data-testid="workbench-approval-card"
      style={{ border: '1px solid rgba(250,173,20,0.45)', borderRadius: 8, padding: 10 }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <Text strong style={{ fontSize: 13 }}>{item.toolName}</Text>
        <Tag color={statusTone(item.status)}>{approvalStatusLabel(t, item.status)}</Tag>
      </div>
      {command ? (
        <Text
          data-testid="workbench-approval-command"
          style={{ fontSize: 12, display: 'block', marginBottom: 6, wordBreak: 'break-all' }}
        >
          {t('workbench.approval.willRun', { command })}
        </Text>
      ) : null}
      {item.reason ? (
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
          {item.reason}
        </Text>
      ) : null}
      <Collapse
        ghost
        items={[{
          key: 'digest',
          label: <Text type="secondary" style={{ fontSize: 11 }}>{t('workbench.approval.digest')}</Text>,
          children: (
            <pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {showDigest ? item.argsDigest : t('workbench.approval.noDigest')}
            </pre>
          ),
        }]}
      />
      {item.status === 'pending' ? (
        <Space size={4} style={{ marginTop: 6 }} wrap>
          {item.canDecide ? (
            <>
              <Button size="small" type="primary" loading={acting} onClick={() => onDecide(item.approvalKey, 'grant')}>
                {t('workbench.approval.grant')}
              </Button>
              <Button size="small" danger loading={acting} onClick={() => onDecide(item.approvalKey, 'deny')}>
                {t('workbench.approval.deny')}
              </Button>
            </>
          ) : null}
          {item.canWithdraw ? (
            <Button size="small" loading={acting} onClick={() => onDecide(item.approvalKey, 'withdraw')}>
              {t('workbench.approval.withdraw')}
            </Button>
          ) : null}
          {!item.canDecide && !item.canWithdraw ? (
            <Text type="secondary" style={{ fontSize: 11 }}>{t('workbench.approval.noAction')}</Text>
          ) : null}
          {item.reviewUrl ? (
            <Button size="small" type="link" href={item.reviewUrl} target="_blank" rel="noreferrer">
              {t('workbench.approval.review')}
            </Button>
          ) : null}
        </Space>
      ) : (
        <Text type="secondary" style={{ fontSize: 11 }}>
          {item.decidedBy ? t('workbench.approval.decidedBy', { user: item.decidedBy }) : null}
        </Text>
      )}
    </div>
  );
}

export interface WorkbenchTimelineProps {
  detail: WorkbenchSessionDetail;
  live: boolean;
  actingKey: string | null;
  onDecide: (key: string, decision: WorkbenchApprovalDecision) => void;
  onRetry: (text: string) => void;
}

export default function WorkbenchTimeline({
  detail, live, actingKey, onDecide, onRetry,
}: WorkbenchTimelineProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const isTerminal = ['succeeded', 'completed', 'failed', 'cancelled'].includes(detail.status);
  const lastUserStep = [...detail.steps].reverse().find((s) => s.role === 'user');

  return (
    <div data-testid="workbench-timeline" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <Button
          type="text"
          size="small"
          onClick={() => setExpanded((v) => !v)}
          icon={expanded ? <DownOutlined aria-hidden /> : <RightOutlined aria-hidden />}
        >
          {expanded ? t('workbench.timeline.collapse') : t('workbench.timeline.expand')}
        </Button>
        <Tag color={statusTone(detail.status)}>{sessionStatusLabel(t, detail.status)}</Tag>
        {detail.phase ? <Tag>{detail.phase}</Tag> : null}
        {live ? (
          <Tag icon={<LoadingOutlined />} color="processing">{t('workbench.timeline.live')}</Tag>
        ) : null}
        <Text type="secondary" style={{ fontSize: 11, marginLeft: 'auto' }}>
          {t('workbench.timeline.steps', { count: detail.stepCount ?? detail.steps.length })}
        </Text>
      </div>

      {detail.errorMessage ? (
        <Alert
          type="error"
          showIcon
          title={detail.errorMessage}
          style={{ marginBottom: 10 }}
          action={lastUserStep?.content ? (
            <Button size="small" onClick={() => onRetry(lastUserStep.content || '')}>
              {t('workbench.action.retry')}
            </Button>
          ) : undefined}
        />
      ) : null}
      {detail.waitingFor ? (
        <Alert type="warning" showIcon title={detail.waitingFor} style={{ marginBottom: 10 }} />
      ) : null}
      {/* 默认审批入口：折叠抽屉/移动端也能处置，Inspector 只保留镜像。 */}
      <ApprovalList
        items={detail.approvalItems}
        toolCalls={detail.toolCalls}
        actingKey={actingKey}
        onDecide={onDecide}
      />
      {isTerminal && detail.conclusion ? (
        <Alert
          type="info"
          showIcon
          title={t('workbench.timeline.conclusion')}
          description={typeof detail.conclusion === 'string' ? detail.conclusion : JSON.stringify(detail.conclusion)}
          style={{ marginBottom: 10 }}
        />
      ) : null}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
        {expanded ? (
          <Space orientation="vertical" size={8} style={{ width: '100%' }}>
            {detail.steps.length === 0 ? (
              <Text type="secondary">{t('workbench.timeline.empty')}</Text>
            ) : detail.steps.map((step) => <StepCard key={step.seq} step={step} />)}
            {detail.toolCalls.length > 0 ? (
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('workbench.timeline.tools', { count: detail.toolCalls.length })}
                </Text>
                <Space orientation="vertical" size={6} style={{ width: '100%', marginTop: 6 }}>
                  {detail.toolCalls.map((call, idx) => (
                    <ToolCard key={call.id ?? `${call.toolName}-${idx}`} call={call} />
                  ))}
                </Space>
              </div>
            ) : null}
          </Space>
        ) : null}
      </div>
    </div>
  );
}

export function ApprovalList({
  items,
  toolCalls = [],
  actingKey,
  onDecide,
}: {
  items: WorkbenchApprovalItem[];
  toolCalls?: readonly WorkbenchToolCall[];
  actingKey: string | null;
  onDecide: (key: string, decision: WorkbenchApprovalDecision) => void;
}) {
  if (items.length === 0) return null;
  return (
    <Space orientation="vertical" size={8} style={{ width: '100%', marginBottom: 10 }}>
      {items.map((item) => (
        <ApprovalCard
          key={item.approvalKey}
          item={item}
          command={approvalCommandOf(item, toolCalls)}
          acting={actingKey === item.approvalKey}
          onDecide={onDecide}
        />
      ))}
    </Space>
  );
}
