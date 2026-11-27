/**
 * Center timeline: markdown steps, collapsible tool cards, live delta
 * indicators, phase/status chips, and inline approval decisions.
 */
import { useState } from 'react';
import { Alert, Button, Collapse, Space, Tag, Typography } from 'antd';
import { DownOutlined, LoadingOutlined, RightOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import MarkdownView from '../MarkdownView';
import type {
  WorkbenchApprovalItem,
  WorkbenchApprovalDecision,
  WorkbenchSessionDetail,
  WorkbenchStep,
  WorkbenchToolCall,
} from '../../pages/workbench/types-public';
import { clip, formatTime, statusTone } from '../../pages/workbench/format';

const { Text } = Typography;

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

function toolStatusLabel(t: (k: string) => string, status: string): string {
  switch (status) {
    case 'ok':
    case 'success':
    case 'succeeded':
    case 'completed': return t('workbench.tool.status.ok');
    case 'running':
    case 'pending': return t('workbench.tool.status.running');
    case 'error':
    case 'failed': return t('workbench.tool.status.error');
    default: return status;
  }
}

function approvalStatusLabel(t: (k: string) => string, status: string): string {
  switch (status) {
    case 'pending': return t('workbench.approval.status.pending');
    case 'granted':
    case 'approved': return t('workbench.approval.status.granted');
    case 'denied': return t('workbench.approval.status.denied');
    case 'consumed': return t('workbench.approval.status.consumed');
    case 'expired': return t('workbench.approval.status.expired');
    default: return status;
  }
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
  acting,
  onDecide,
}: {
  item: WorkbenchApprovalItem;
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
  detail, live, onRetry,
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
        <Tag color={statusTone(detail.status)}>{detail.status}</Tag>
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
  actingKey,
  onDecide,
}: {
  items: WorkbenchApprovalItem[];
  actingKey: string | null;
  onDecide: (key: string, decision: WorkbenchApprovalDecision) => void;
}) {
  if (items.length === 0) return null;
  return (
    <Space orientation="vertical" size={8} style={{ width: '100%' }}>
      {items.map((item) => (
        <ApprovalCard
          key={item.approvalKey}
          item={item}
          acting={actingKey === item.approvalKey}
          onDecide={onDecide}
        />
      ))}
    </Space>
  );
}
