/**
 * Left rail: new session, prompt starters, search/filter, real session list.
 * Collapses on narrow screens; the parent owns the collapse state so the same
 * rail can be shown as a drawer on mobile.
 */
import { useMemo, useState } from 'react';
import { Button, Empty, Input, Select, Space, Tag, Tooltip, Typography } from 'antd';
import {
  PlusOutlined,
  MessageOutlined,
  FileTextOutlined,
  BulbOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { ComposerCadence, WorkbenchSessionListItem } from '../../pages/workbench/types-public';
import { formatSessionTime, sessionFallbackTitle, statusTone } from '../../pages/workbench/format';

const { Text } = Typography;

interface Starter {
  key: string;
  labelKey: string;
  promptKey: string;
  kind: 'chat' | 'sop_authoring' | 'plan';
  cadence: ComposerCadence;
}

// Keys are literal strings so the i18n orphan detector sees them as used.
const STARTERS: Starter[] = [
  {
    key: 'summarize',
    labelKey: 'workbench.starter.summarize.label',
    promptKey: 'workbench.starter.summarize.prompt',
    kind: 'chat',
    cadence: 'once',
  },
  {
    key: 'sop',
    labelKey: 'workbench.starter.sop.label',
    promptKey: 'workbench.starter.sop.prompt',
    kind: 'sop_authoring',
    cadence: 'once',
  },
  {
    key: 'plan',
    labelKey: 'workbench.starter.plan.label',
    promptKey: 'workbench.starter.plan.prompt',
    kind: 'plan',
    cadence: 'once',
  },
];

const STATUS_FILTERS = ['all', 'running', 'waiting_input', 'succeeded', 'failed'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const KIND_FILTERS = ['all', 'chat', 'sop_authoring', 'plan'] as const;
type KindFilter = (typeof KIND_FILTERS)[number];

function statusLabel(t: (k: string) => string, status: string): string {
  switch (status) {
    case 'pending': return t('workbench.session.status.pending');
    case 'running': return t('workbench.session.status.running');
    case 'succeeded':
    case 'completed': return t('workbench.session.status.succeeded');
    case 'failed': return t('workbench.session.status.failed');
    case 'waiting_input': return t('workbench.session.status.waiting_input');
    case 'cancelled': return t('workbench.session.status.cancelled');
    default: return status;
  }
}

function kindLabel(t: (k: string) => string, kind: string): string {
  switch (kind) {
    case 'chat': return t('workbench.kind.chat');
    case 'sop_authoring': return t('workbench.kind.sop');
    case 'plan': return t('workbench.kind.plan');
    default: return kind;
  }
}

export interface WorkbenchSessionRailProps {
  sessions: WorkbenchSessionListItem[];
  state: string;
  error: string | null;
  activeId: string | null;
  onNew: () => void;
  onStarter: (starter: { prompt: string; kind: Starter['kind']; cadence: ComposerCadence }) => void;
  onRestore: (id: string) => void;
  onReload: () => void;
}

export default function WorkbenchSessionRail({
  sessions, state, error, activeId, onNew, onStarter, onRestore, onReload,
}: WorkbenchSessionRailProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [kind, setKind] = useState<KindFilter>('all');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions.filter((item) => {
      if (status !== 'all' && item.status !== status) return false;
      if (kind !== 'all' && (item.kind ?? '') !== kind) return false;
      if (!needle) return true;
      return (
        sessionFallbackTitle(item).toLowerCase().includes(needle)
        || item.sessionId.toLowerCase().includes(needle)
      );
    });
  }, [sessions, query, status, kind]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }} data-testid="workbench-rail">
      <Button
        type="primary"
        block
        icon={<PlusOutlined aria-hidden />}
        data-testid="workbench-new-session"
        onClick={onNew}
      >
        {t('workbench.session.new')}
      </Button>

      <div>
        <Text type="secondary" style={{ fontSize: 12 }}>{t('workbench.starter.title')}</Text>
        <Space orientation="vertical" size={4} style={{ width: '100%', marginTop: 6 }}>
          {STARTERS.map((starter) => {
            const icon = starter.kind === 'sop_authoring'
              ? <FileTextOutlined aria-hidden />
              : starter.kind === 'plan' ? <BulbOutlined aria-hidden /> : <MessageOutlined aria-hidden />;
            return (
              <Tooltip key={starter.key} title={t(starter.promptKey)} placement="right">
                <Button
                  type="text"
                  block
                  style={{ textAlign: 'left' }}
                  icon={icon}
                  data-testid={`workbench-starter-${starter.key}`}
                  onClick={() => onStarter({
                    prompt: t(starter.promptKey),
                    kind: starter.kind,
                    cadence: starter.cadence,
                  })}
                >
                  {t(starter.labelKey)}
                </Button>
              </Tooltip>
            );
          })}
        </Space>
      </div>

      <div style={{ borderTop: '1px solid rgba(127,127,127,0.18)', paddingTop: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <Text strong style={{ fontSize: 13 }}>{t('workbench.session.recent')}</Text>
          <Button
            type="text"
            size="small"
            icon={<ReloadOutlined aria-hidden />}
            aria-label={t('workbench.session.reload')}
            onClick={onReload}
          />
        </div>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('workbench.session.search')}
          allowClear
          size="small"
        />
        <Space size={4} style={{ marginTop: 8, width: '100%' }} wrap>
          <Select<StatusFilter>
            size="small"
            value={status}
            onChange={setStatus}
            style={{ width: 118 }}
            aria-label={t('workbench.session.filter.status')}
            options={STATUS_FILTERS.map((value) => ({
              value,
              label: value === 'all' ? t('workbench.filter.all') : statusLabel(t, value),
            }))}
          />
          <Select<KindFilter>
            size="small"
            value={kind}
            onChange={setKind}
            style={{ width: 118 }}
            aria-label={t('workbench.session.filter.kind')}
            options={KIND_FILTERS.map((value) => ({
              value,
              label: value === 'all' ? t('workbench.filter.all') : kindLabel(t, value),
            }))}
          />
        </Space>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 4 }}>
        {error ? <Text type="danger" style={{ fontSize: 12 }}>{error}</Text> : null}
        {filtered.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={state === 'loading' ? t('workbench.session.loading') : t('workbench.session.empty')}
            style={{ marginTop: 24 }}
          />
        ) : (
          <Space orientation="vertical" size={2} style={{ width: '100%' }}>
            {filtered.map((item) => {
              const tone = statusTone(item.status);
              return (
                <button
                  key={item.sessionId}
                  type="button"
                  data-testid="workbench-rail-session"
                  aria-current={item.sessionId === activeId ? 'true' : undefined}
                  onClick={() => onRestore(item.sessionId)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    border: item.sessionId === activeId ? '1px solid rgba(22,119,255,0.45)' : '1px solid transparent',
                    background: item.sessionId === activeId ? 'rgba(22,119,255,0.06)' : 'transparent',
                    borderRadius: 8,
                    padding: '8px 10px',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Tag color={tone} style={{ marginInlineEnd: 0, minWidth: 8, height: 8, padding: 0, borderRadius: 4 }} />
                    <Text strong ellipsis style={{ flex: 1, fontSize: 13 }}>
                      {sessionFallbackTitle(item)}
                    </Text>
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 4, paddingLeft: 14 }}>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {kindLabel(t, item.kind ?? 'chat')}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {statusLabel(t, item.status)}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 11, marginLeft: 'auto' }}>
                      {formatSessionTime(item.createdAt)}
                    </Text>
                  </div>
                </button>
              );
            })}
          </Space>
        )}
      </div>
    </div>
  );
}
