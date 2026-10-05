import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Card,
  Drawer,
  Empty,
  message,
  Pagination,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { PlayCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
// URL-SYNC-01：筛选/分页同步 URL（对齐 TaskListPage/ExecutionsPage 先例）——
// 刷新、后退、分享链接不丢状态。
import { useSearchParams } from 'react-router-dom';

import PageHeader from '../components/PageHeader';
// UI-16：列表请求失败不再只弹 toast——页内原位错误块 + 重试入口
import StateError from '../components/StateError';
// UI-09 第三轮：≤768px 表格 → 卡片列表的结构级降级（对齐 TaskListPage/
// ApplicationListPage 的 MOBILE-CARD-01 先例；断点与 index.css ui09 媒体查询同值）
import { useIsMobile } from '../hooks/useIsMobile';
// A11Y-DRAWER-01：Drawer 打开后焦点移入内容、关闭归还触发按钮
import { useDrawerA11y } from '../hooks/useDrawerA11y';
import { agentApi } from '../api/agent';
// SOPS-TIME-01：startedAt 列与 SopsPage 同走 formatDateTime（locale 感知 + 空值 '—'）
import { formatDateTime } from '../utils/timeFormat';
// UX-06：裸枚举收敛到共享词表（status/kind/工具状态/角色/层级 唯一事实源）
import {
  agentKindLabel,
  agentStatusLabel,
  agentStepRoleLabel,
  agentToolStatusLabel,
  agentToolTierLabel,
} from '../utils/agent-label';
// P3 审计：Agent 会话/工具状态 → Tag color 映射收敛到单一事实源
import { AGENT_SESSION_STATUS_COLOR, AGENT_TOOL_STATUS_COLOR } from '../utils/status-color';
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

// UX-06：状态 Tag 走共享词表（未知值回退原始 token，保留可诊断信息）
function statusTag(status: string, t: (k: string, v?: Record<string, unknown>) => string) {
  return (
    <Tag color={AGENT_SESSION_STATUS_COLOR[status] ?? 'default'}>{agentStatusLabel(status, t)}</Tag>
  );
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
  // UI-09 第三轮：≤768px 结构级降级开关（表格→卡片、抽屉满宽、筛选堆叠）
  const isMobile = useIsMobile();
  // A11Y-DRAWER-01：会话详情抽屉焦点管理（开→聚焦首个可交互元素；关→归还触发按钮）
  const drawerA11y = useDrawerA11y();
  // URL-SYNC-01：筛选/分页以 URL 查询参数为初始源并回写；非法深链值
  // （?page=abc、负数、浮点）回落默认值，不空屏不报错。
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<AgentSession[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(() => {
    const p = Number(searchParams.get('page'));
    return Number.isInteger(p) && p > 0 ? p : 1;
  });
  const [pageSize, setPageSize] = useState(() => {
    const ps = Number(searchParams.get('pageSize'));
    return Number.isInteger(ps) && ps > 0 ? ps : 20;
  });
  const [kindFilter, setKindFilter] = useState<string | undefined>(() => searchParams.get('kind') || undefined);
  const [statusFilter, setStatusFilter] = useState<string | undefined>(() => searchParams.get('status') || undefined);
  const [loading, setLoading] = useState(false);
  // UI-16：非静默加载（首屏/手动刷新/筛选变化）失败时记录错误并原位呈现；
  // B-14 的静默轮询失败仍保持静默（列表保留旧数据，不弹错误块刷屏）。
  const [loadError, setLoadError] = useState<unknown>(null);
  const [budget, setBudget] = useState<AgentBudget | null>(null);
  const [detail, setDetail] = useState<AgentSession | null>(null);
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [toolCalls, setToolCalls] = useState<AgentToolCall[]>([]);
  const [children, setChildren] = useState<AgentSession[]>([]);
  const [resuming, setResuming] = useState(false);

  // B-14：silent 轮询不闪 loading（对齐 SopsPage 同款处理）
  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) { setLoading(true); setLoadError(null); }
    try {
      const res = await agentApi.list({ kind: kindFilter, status: statusFilter, page, pageSize });
      setItems(res.items);
      setTotal(res.total);
    } catch (err: unknown) {
      // B-14：后台轮询失败静默——连续弹 message 是噪音，列表保留旧数据。
      // 非 silent（首屏/手动刷新）失败改为页内错误态（UI-16），不再只弹 toast。
      if (!opts?.silent) setLoadError(err ?? new Error('load failed'));
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [kindFilter, statusFilter, page, pageSize]);

  // URL-SYNC-01：状态→URL 回写（replace 不制造历史记录；默认值不写入）
  useEffect(() => {
    const next = new URLSearchParams();
    if (page !== 1) next.set('page', String(page));
    if (pageSize !== 20) next.set('pageSize', String(pageSize));
    if (kindFilter) next.set('kind', kindFilter);
    if (statusFilter) next.set('status', statusFilter);
    setSearchParams(next, { replace: true });
  }, [page, pageSize, kindFilter, statusFilter, setSearchParams]);

  useEffect(() => {
    void load();
  }, [load]);

  // B-14：15s 轮询自动刷新（失焦暂停，回前台下一拍恢复——对齐
  // ExecutionsPage 先例）。会话状态（running/waiting_input/终态）变化频繁，
  // 人工不刷新就看不到挂起与预算触顶。
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load({ silent: true });
    }, 15_000);
    return () => clearInterval(timer);
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
          {statusTag(s.status, t)}
          <Text strong>{s.title ?? agentKindLabel(s.kind, t)}</Text>
        </Space>
      ),
    },
    {
      title: t('agents.col.kind'),
      dataIndex: 'kind',
      width: 130,
      render: (v: string) => agentKindLabel(v, t),
    },
    {
      title: t('agents.col.trigger'),
      dataIndex: 'triggerSource',
      width: 180,
      ellipsis: true,
    },
    { title: t('agents.col.usage'), width: 200, render: (_, s) => usageOf(s, t) },
    { title: t('agents.col.startedAt'), dataIndex: 'startedAt', width: 170, render: (v: string | null) => formatDateTime(v) },
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
    {
      title: t('agents.col.role'),
      dataIndex: 'role',
      width: 90,
      render: (v: string) => agentStepRoleLabel(v, t),
    },
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
    { title: t('agents.col.tok'), width: 90, render: (_, s) => `${s.tokensIn}/${s.tokensOut}` },
    { title: t('agents.col.latency'), dataIndex: 'latencyMs', width: 80 },
  ];

  const toolColumns: ColumnsType<AgentToolCall> = [
    {
      title: t('agents.col.tool'),
      dataIndex: 'toolName',
      width: 180,
      render: (v: string, c) => (
        <Space size={4}>
          <Tag color={AGENT_TOOL_STATUS_COLOR[c.status] ?? 'default'}>
            {agentToolStatusLabel(c.status, t)}
          </Tag>
          <Text style={{ fontSize: 12 }}>{v}</Text>
        </Space>
      ),
    },
    {
      title: t('agents.col.tier'),
      dataIndex: 'tier',
      width: 90,
      render: (v: string) => agentToolTierLabel(v, t),
    },
    {
      title: t('agents.col.args'),
      ellipsis: true,
      render: (_, c) => (
        <Text style={{ fontSize: 12 }} type="secondary">
          {JSON.stringify(c.argsJson ?? {}).slice(0, 160)}
        </Text>
      ),
    },
    { title: t('agents.col.duration'), dataIndex: 'durationMs', width: 80 },
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
          {statusTag(s.status, t)}
          <Text strong>{s.title ?? agentKindLabel(s.kind, t)}</Text>
        </Space>
      ),
    },
    {
      title: t('agents.col.kind'),
      dataIndex: 'kind',
      width: 120,
      render: (v: string) => agentKindLabel(v, t),
    },
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

  // B-8：running 不在可恢复集合——后端对 running 会话的 resume 返回 409
  //（重复入队会产生双份推理循环副作用），前端同步隐藏入口。
  const resumable = detail !== null &&
    ['waiting_input', 'failed', 'budget_exceeded', 'pending'].includes(detail.status);

  // UI-09 第三轮：筛选/刷新/预算节点在桌面（页头 extra 一行）与移动端
  //（页头下方纵向堆叠）两处复用——Select 窄屏放满整行，避免固定 160px
  // 与长预算文案在 375px 视口里横向挤压。
  const budgetNode = budget ? (
    <Text type="secondary" style={isMobile ? { fontSize: 12 } : undefined}>
      {t('agents.budgetLabel', {
        steps: budget.maxSteps,
        tokens: budget.maxTokens,
        tools: budget.maxToolCalls,
      })}
    </Text>
  ) : null;
  const kindSelect = (
    <Select
      allowClear
      placeholder={t('agents.filter.kind')}
      style={{ width: isMobile ? '100%' : 160 }}
      value={kindFilter}
      onChange={v => { setKindFilter(v); setPage(1); }}
      options={['ops_watch', 'incident', 'sop_authoring', 'sop_review', 'app_scaffold', 'chat'].map((k) => ({
        value: k,
        label: agentKindLabel(k, t),
      }))}
    />
  );
  const statusSelect = (
    <Select
      allowClear
      placeholder={t('agents.filter.status')}
      style={{ width: isMobile ? '100%' : 160 }}
      value={statusFilter}
      onChange={v => { setStatusFilter(v); setPage(1); }}
      options={Object.keys(AGENT_SESSION_STATUS_COLOR).map((s) => ({ value: s, label: agentStatusLabel(s, t) }))}
    />
  );
  // 图标按钮 a11y：图标随文字按钮（有可读文案），对读屏器纯装饰 → aria-hidden
  const refreshButton = (
    <Button icon={<ReloadOutlined aria-hidden />} onClick={() => void load()}>
      {t('sops.refresh')}
    </Button>
  );
  // 空态区分（桌面表格 locale 与移动端卡片空态同源）：筛选无匹配给
  //「清除筛选」出口；真空态如实提示。
  const emptyNode = (kindFilter || statusFilter) ? (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('agents.empty.noMatch')}>
      <Button
        type="link"
        size="small"
        onClick={() => { setKindFilter(undefined); setStatusFilter(undefined); setPage(1); }}
      >
        {t('agents.clearFilters')}
      </Button>
    </Empty>
  ) : (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('agents.empty')} />
  );

  return (
    <div>
      <PageHeader
        title={t('agents.title')}
        description={t('agents.description')}
        extra={!isMobile ? (
          <Space>
            {budgetNode}
            {kindSelect}
            {statusSelect}
            {refreshButton}
          </Space>
        ) : undefined}
      />
      {/* 移动端：页头操作行收进下方纵向堆叠的筛选栏（Select 各占满一行） */}
      {isMobile && (
        <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {budgetNode}
          {kindSelect}
          {statusSelect}
          <div>{refreshButton}</div>
        </div>
      )}
      {/* UI-16：非静默加载失败 → 页内原位错误块 + 重试（轮询失败仍静默，B-14 语义不变） */}
      {loadError ? (
        <StateError
          error={loadError}
          title={t('agents.loadFailed')}
          onRetry={() => void load()}
          style={{ marginBottom: 16 }}
        />
      ) : null}
      {/* UI-09 第三轮：≤768px 卡片列表（MOBILE-CARD-01 同款结构级降级）——
          会话卡按首查信息组织：状态+标题 → 类型+触发来源 → 用量 → 开始时间 →
          操作；桌面保留 6 列表格。 */}
      {isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.length === 0 ? (
            emptyNode
          ) : (
            items.map((s) => (
              <Card key={s.id} size="small">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <Text strong ellipsis style={{ flex: 1, minWidth: 0 }}>
                    {s.title ?? agentKindLabel(s.kind, t)}
                  </Text>
                  {statusTag(s.status, t)}
                </div>
                <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  <Tag style={{ marginInlineEnd: 0 }}>{agentKindLabel(s.kind, t)}</Tag>
                  {s.triggerSource && <Tag style={{ marginInlineEnd: 0 }}>{s.triggerSource}</Tag>}
                </div>
                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--chart-axis-text)' }}>{usageOf(s, t)}</div>
                <div style={{ marginTop: 4, fontSize: 12, color: 'var(--chart-axis-text)' }}>
                  {t('agents.col.startedAt')}：{formatDateTime(s.startedAt)}
                </div>
                <div style={{ marginTop: 8 }}>
                  <Button size="small" onClick={() => void openDetail(s)}>
                    {t('sops.view')}
                  </Button>
                </div>
              </Card>
            ))
          )}
          {items.length > 0 && (
            <Pagination
              size="small"
              current={page}
              pageSize={pageSize}
              total={total}
              showSizeChanger={false}
              onChange={(p, ps) => { setPage(p); setPageSize(ps); }}
              style={{ alignSelf: 'flex-end' }}
            />
          )}
        </div>
      ) : (
        <Table<AgentSession>
          rowKey="id"
          loading={loading}
          columns={sessionColumns}
          dataSource={items}
          locale={{
            // 空态区分：筛选无匹配给「清除筛选」出口（避免用户以为会话真没了）；
            // 真空态如实提示（会话由运行时产生，无人工入口可引导）。
            emptyText: emptyNode,
          }}
          pagination={{ current: page, pageSize, total, showSizeChanger: true, onChange: (p, ps) => { setPage(p); setPageSize(ps); } }}
          size="middle"
        />
      )}

      <Drawer
        title={detail ? (detail.title ?? `${agentKindLabel(detail.kind, t)} · ${detail.id.slice(0, 8)}`) : ''}
        // antd 6：width 已并入 size（number|string|'large'|'default'）——
        // 窄屏 '100%' 满宽，桌面 920px 固定宽
        size={isMobile ? '100%' : 920}
        open={detail !== null}
        onClose={() => setDetail(null)}
        afterOpenChange={drawerA11y.afterOpenChange}
        destroyOnHidden
        extra={
          resumable ? (
            <Button
              type="primary"
              size="small"
              icon={<PlayCircleOutlined aria-hidden />}
              loading={resuming}
              onClick={() => void resume()}
            >
              {t('agents.resume')}
            </Button>
          ) : null
        }
      >
        {/* A11Y-DRAWER-01：内容包一层 ref 定位容器——焦点首站查询收窄到本抽屉 */}
        <div ref={drawerA11y.contentRef}>
          {detail && (
            <>
            <Paragraph>
              <Space size={8} wrap>
                {statusTag(detail.status, t)}
                <Tag>{agentKindLabel(detail.kind, t)}</Tag>
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
        </div>
      </Drawer>
    </div>
  );
}
