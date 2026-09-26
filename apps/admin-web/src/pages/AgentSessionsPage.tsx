import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Drawer,
  message,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { PlayCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';

import PageHeader from '../components/PageHeader';
import { agentApi } from '../api/agent';
import type {
  AgentBudget,
  AgentSession,
  AgentStep,
  AgentToolCall,
} from '../api/agent';

/**
 * P2 遗留补齐：Agent 会话查看页（ADMIN-only，对齐 agent.controller.ts）。
 *
 * 会话是中台 Agent 的行为留痕：列表看「Agent 最近在干什么/烧了多少」，
 * 详情看「每一步谁答的、调了什么工具、被闸门拦了几次」。除 resume 外
 * 全部只读——会话的生命周期由运行时与闸门管理，人工只做「看」和「放行」。
 */

const { Text, Paragraph } = Typography;

const STATUS_COLORS: Record<string, string> = {
  pending: 'default',
  running: 'processing',
  waiting_input: 'orange',
  succeeded: 'green',
  failed: 'red',
  aborted: 'default',
  budget_exceeded: 'volcano',
};

const TOOL_STATUS_COLORS: Record<string, string> = {
  ok: 'green',
  denied: 'red',
  error: 'red',
  circuit_open: 'volcano',
  awaiting_approval: 'orange',
};

function statusTag(status: string) {
  return <Tag color={STATUS_COLORS[status] ?? 'default'}>{status}</Tag>;
}

function usageOf(s: AgentSession, t: (k: string, v?: Record<string, unknown>) => string): string {
  return t('agents.usageSummary', {
    steps: s.totalSteps,
    tokens: s.totalTokensIn + s.totalTokensOut,
    tools: s.totalToolCalls,
  });
}

export default function AgentSessionsPage() {
  const { t } = useTranslation();
  const [items, setItems] = useState<AgentSession[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [kindFilter, setKindFilter] = useState<string | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [budget, setBudget] = useState<AgentBudget | null>(null);
  const [detail, setDetail] = useState<AgentSession | null>(null);
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [toolCalls, setToolCalls] = useState<AgentToolCall[]>([]);
  const [children, setChildren] = useState<AgentSession[]>([]);
  const [resuming, setResuming] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await agentApi.list({ kind: kindFilter, status: statusFilter, page, pageSize });
      setItems(res.items);
      setTotal(res.total);
    } catch {
      message.error(t('agents.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [kindFilter, statusFilter, page, pageSize, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    agentApi
      .budget()
      .then(setBudget)
      .catch(() => undefined); // 预算行加载失败不影响列表
  }, []);

  const openDetail = useCallback(async (s: AgentSession) => {
    setDetail(s);
    setSteps([]);
    setToolCalls([]);
    setChildren([]);
    try {
      const d = await agentApi.detail(s.id);
      setDetail(d.session);
      setSteps(d.steps);
      setToolCalls(d.toolCalls);
      setChildren(d.children);
    } catch {
      message.error(t('agents.detailFailed'));
    }
  }, [t]);

  const resume = useCallback(async () => {
    if (!detail) return;
    setResuming(true);
    try {
      const r = await agentApi.resume(detail.id);
      if (r.ok) message.success(t('agents.resumeOk'));
      else message.warning(r.reason ?? t('agents.resumeFailed'));
      await openDetail(detail);
    } catch {
      message.error(t('agents.resumeFailed'));
    } finally {
      setResuming(false);
    }
  }, [detail, openDetail, t]);

  const sessionColumns: ColumnsType<AgentSession> = [
    {
      title: t('agents.col.title'),
      ellipsis: true,
      render: (_, s) => (
        <Space size={4}>
          {statusTag(s.status)}
          <Text strong>{s.title ?? s.kind}</Text>
        </Space>
      ),
    },
    { title: 'kind', dataIndex: 'kind', width: 130 },
    {
      title: t('agents.col.trigger'),
      dataIndex: 'triggerSource',
      width: 180,
      ellipsis: true,
    },
    { title: t('agents.col.usage'), width: 200, render: (_, s) => usageOf(s, t) },
    { title: t('agents.col.startedAt'), dataIndex: 'startedAt', width: 170, render: (v: string | null) => (v ? new Date(v).toLocaleString() : '—') },
    {
      title: t('sops.col.actions'),
      width: 90,
      render: (_, s) => (
        <Button size="small" onClick={() => void openDetail(s)}>
          {t('sops.view')}
        </Button>
      ),
    },
  ];

  const stepColumns: ColumnsType<AgentStep> = [
    { title: '#', dataIndex: 'seq', width: 56 },
    { title: 'role', dataIndex: 'role', width: 90 },
    {
      title: t('agents.col.content'),
      ellipsis: true,
      render: (_, s) => (
        <Text style={{ fontSize: 12 }}>{(s.summary ?? s.content ?? '').slice(0, 200)}</Text>
      ),
    },
    {
      title: t('agents.col.model'),
      width: 150,
      render: (_, s) => (s.model ? `${s.provider ?? ''}/${s.model}` : '—'),
    },
    { title: 'tok', width: 90, render: (_, s) => `${s.tokensIn}/${s.tokensOut}` },
    { title: 'ms', dataIndex: 'latencyMs', width: 80 },
  ];

  const toolColumns: ColumnsType<AgentToolCall> = [
    {
      title: t('agents.col.tool'),
      dataIndex: 'toolName',
      width: 180,
      render: (v: string, c) => (
        <Space size={4}>
          <Tag color={TOOL_STATUS_COLORS[c.status] ?? 'default'}>{c.status}</Tag>
          <Text style={{ fontSize: 12 }}>{v}</Text>
        </Space>
      ),
    },
    { title: 'tier', dataIndex: 'tier', width: 90 },
    {
      title: 'args',
      ellipsis: true,
      render: (_, c) => (
        <Text style={{ fontSize: 12 }} type="secondary">
          {JSON.stringify(c.argsJson ?? {}).slice(0, 160)}
        </Text>
      ),
    },
    { title: 'ms', dataIndex: 'durationMs', width: 80 },
    {
      title: t('agents.col.error'),
      ellipsis: true,
      render: (_, c) =>
        c.errorMessage ? (
          <Text style={{ fontSize: 12 }} type="danger">
            {c.errorMessage.slice(0, 160)}
          </Text>
        ) : null,
    },
  ];

  const childColumns: ColumnsType<AgentSession> = [
    {
      title: t('agents.col.title'),
      render: (_, s) => (
        <Space size={4}>
          {statusTag(s.status)}
          <Text strong>{s.title ?? s.kind}</Text>
        </Space>
      ),
    },
    { title: 'kind', dataIndex: 'kind', width: 120 },
    { title: t('agents.col.usage'), width: 200, render: (_, s) => usageOf(s, t) },
    {
      title: t('sops.col.actions'),
      width: 90,
      render: (_, s) => (
        <Button size="small" onClick={() => void openDetail(s)}>
          {t('sops.view')}
        </Button>
      ),
    },
  ];

  const resumable = detail !== null &&
    !['succeeded', 'aborted'].includes(detail.status) &&
    ['waiting_input', 'failed', 'budget_exceeded', 'pending', 'running'].includes(detail.status);

  return (
    <div>
      <PageHeader
        title={t('agents.title')}
        description={t('agents.description')}
        extra={
          <Space>
            {budget && (
              <Text type="secondary">
                {t('agents.budgetLabel', {
                  steps: budget.maxSteps,
                  tokens: budget.maxTokens,
                  tools: budget.maxToolCalls,
                })}
              </Text>
            )}
            <Select
              allowClear
              placeholder={t('agents.filter.kind')}
              style={{ width: 160 }}
              value={kindFilter}
              onChange={setKindFilter}
              options={['ops_watch', 'incident', 'sop_authoring', 'sop_review', 'app_scaffold', 'chat'].map((k) => ({
                value: k,
                label: k,
              }))}
            />
            <Select
              allowClear
              placeholder={t('agents.filter.status')}
              style={{ width: 160 }}
              value={statusFilter}
              onChange={setStatusFilter}
              options={Object.keys(STATUS_COLORS).map((s) => ({ value: s, label: s }))}
            />
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              {t('sops.refresh')}
            </Button>
          </Space>
        }
      />
      <Table<AgentSession>
        rowKey="id"
        loading={loading}
        columns={sessionColumns}
        dataSource={items}
        pagination={{ current: page, pageSize, total, showSizeChanger: true, onChange: (p, ps) => { setPage(p); setPageSize(ps); } }}
        size="middle"
      />

      <Drawer
        title={detail ? (detail.title ?? `${detail.kind} · ${detail.id.slice(0, 8)}`) : ''}
        width={920}
        open={detail !== null}
        onClose={() => setDetail(null)}
        destroyOnClose
        extra={
          resumable ? (
            <Button
              type="primary"
              size="small"
              icon={<PlayCircleOutlined />}
              loading={resuming}
              onClick={() => void resume()}
            >
              {t('agents.resume')}
            </Button>
          ) : null
        }
      >
        {detail && (
          <>
            <Paragraph>
              <Space size={8} wrap>
                {statusTag(detail.status)}
                <Tag>{detail.kind}</Tag>
                <Tag>{detail.triggerSource}</Tag>
                <Text type="secondary">{usageOf(detail, t)}</Text>
              </Space>
            </Paragraph>
            {detail.waitingFor && (
              <Paragraph>
                <Text type="warning">⏳ {detail.waitingFor}</Text>
              </Paragraph>
            )}
            {detail.errorMessage && (
              <Paragraph>
                <Text type="danger">{detail.errorMessage}</Text>
              </Paragraph>
            )}
            {detail.summary && (
              <Paragraph>
                <Text type="secondary">{detail.summary}</Text>
              </Paragraph>
            )}
            <Tabs
              items={[
                {
                  key: 'steps',
                  label: t('agents.tab.steps', { count: steps.length }),
                  children: (
                    <Table<AgentStep>
                      rowKey="id"
                      columns={stepColumns}
                      dataSource={steps}
                      pagination={false}
                      size="small"
                    />
                  ),
                },
                {
                  key: 'tools',
                  label: t('agents.tab.tools', { count: toolCalls.length }),
                  children: (
                    <Table<AgentToolCall>
                      rowKey="id"
                      columns={toolColumns}
                      dataSource={toolCalls}
                      pagination={false}
                      size="small"
                    />
                  ),
                },
                {
                  key: 'children',
                  label: t('agents.tab.children', { count: children.length }),
                  children:
                    children.length > 0 ? (
                      <Table<AgentSession>
                        rowKey="id"
                        columns={childColumns}
                        dataSource={children}
                        pagination={false}
                        size="small"
                      />
                    ) : (
                      <Text type="secondary">{t('agents.childrenEmpty')}</Text>
                    ),
                },
                {
                  key: 'meta',
                  label: t('agents.tab.meta'),
                  children: (
                    <>
                      <Paragraph>
                        <Text type="secondary">{t('agents.scopeLabel')}</Text>
                      </Paragraph>
                      <pre style={{ maxHeight: 200, overflow: 'auto', fontSize: 12 }}>
                        {JSON.stringify(detail.scopeJson ?? {}, null, 2)}
                      </pre>
                      <Paragraph>
                        <Text type="secondary">{t('agents.contextLabel')}</Text>
                      </Paragraph>
                      <pre style={{ maxHeight: 240, overflow: 'auto', fontSize: 12 }}>
                        {JSON.stringify(detail.contextJson ?? {}, null, 2)}
                      </pre>
                      {detail.resultJson && (
                        <>
                          <Paragraph>
                            <Text type="secondary">{t('agents.resultLabel')}</Text>
                          </Paragraph>
                          <pre style={{ maxHeight: 240, overflow: 'auto', fontSize: 12 }}>
                            {JSON.stringify(detail.resultJson, null, 2)}
                          </pre>
                        </>
                      )}
                    </>
                  ),
                },
              ]}
            />
          </>
        )}
      </Drawer>
    </div>
  );
}
