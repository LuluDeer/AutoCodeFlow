import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRaceGuard } from '../utils/raceGuard';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Input,
  message,
  Modal,
  Pagination,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { PlayCircleOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
// URL-SYNC-01：筛选/分页同步 URL（对齐 TaskListPage/ExecutionsPage 先例）——
// 刷新、后退、分享链接不丢状态。
import { useSearchParams } from 'react-router-dom';

import PageHeader from '../components/PageHeader';
// UI-16：列表请求失败不再只弹 toast——页内原位错误块 + 重试入口
import StateError from '../components/StateError';
// UI-08：首屏数据未达时以骨架形态替代裸 spinner / 空态误报（见下方列表分支）
import PageSkeleton from '../components/PageSkeleton';
// UI-09 第三轮：≤768px 表格 → 卡片列表的结构级降级（对齐 TaskListPage/
// ApplicationListPage 的 MOBILE-CARD-01 先例；断点与 index.css ui09 媒体查询同值）
import { useIsMobile } from '../hooks/useIsMobile';
// A11Y-DRAWER-01：Drawer 打开后焦点移入内容、关闭归还触发按钮
import { useDrawerA11y } from '../hooks/useDrawerA11y';
// A11Y-MODAL-01（WEB-6）：Modal 打开后焦点进入首个可交互控件、关闭归还触发按钮
import { useModalA11y } from '../hooks/useModalA11y';
import { agentApi } from '../api/agent';
// SOPS-TIME-01：startedAt 列与 SopsPage 同走 formatDateTime（locale 感知 + 空值 '—'）
import { formatDateTime } from '../utils/timeFormat';
// UX-06：裸枚举收敛到共享词表（status/kind/工具状态/角色/层级 唯一事实源）
import {
  agentApprovalStatusLabel,
  agentKindLabel,
  agentStatusLabel,
  agentStepRoleLabel,
  agentToolStatusLabel,
  agentToolTierLabel,
} from '../utils/agent-label';
// P3 审计：Agent 会话/工具状态 → Tag color 映射收敛到单一事实源
import { AGENT_APPROVAL_STATUS_COLOR, AGENT_SESSION_STATUS_COLOR, AGENT_TOOL_STATUS_COLOR } from '../utils/status-color';
// A1 审批闭环：grant/deny 失败的兜底提示（__toastedByClient 去重，见 utils/error.ts）
import { showApiError } from '../utils/error';
// WEB-4：批准前的二次确认走 MODAL-01 出口（主题化/locale 化；JSX 形态的
// `<Modal>` 仍用 antd 组件，两者并存是本仓既有写法，见 SopsPage.tsx:11/26）
import { Modal as confirmModal } from '../utils/modal';
// WEB-4：审批行的入参结构化视图（只读键值列表，长值可折叠）
import ToolArgsView from '../components/ToolArgsView';
import { argsSummary } from '../utils/toolArgs';
import type {
  AgentApproval,
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
 *
 * A1 审批闭环（实施轮 #12 前端半边）：详情抽屉新增「审批单」页签——
 * pending 单给批准/拒绝操作，grant 且会话 waiting_input 时服务端自动
 * resume；409（并发已处置）如实提示并刷新。waiting_input 行叠加
 * 「等待审批」徽标（approval 区块存在 pending 单或 waitingFor 提到审批）。
 */

const { Text, Paragraph } = Typography;

/**
 * WEB-6（2026-10-29 第三轮 UX 审计 P3）：新建会话弹窗的字段 id。
 *
 * 弹窗此前把字段名渲染成 `<Text type="secondary">`（纯视觉文本），三个控件
 * 既无 `id` 也无 `htmlFor`/`aria-label`——读屏只报「组合框 / 编辑框」，且
 * axe/lhci 扫不到未打开的 Modal，门禁因此假绿。
 *
 * 现在 `<Form.Item label htmlFor={…}>` 渲染 `<label for>`、控件吃同一个 `id`：
 * **可见标签与可访问名同源**（同一个 `t()` 词条、同一个 DOM 节点），不用
 * `aria-label`（那会让读屏与视觉用户读到两份可能漂移的文案）。
 * id 集中在此常量，改一处漏一处就会让测试的 `getByLabelText` 立刻转红。
 */
const CREATE_FIELD_ID = {
  kind: 'agents-create-kind',
  title: 'agents-create-title',
  context: 'agents-create-context',
} as const;

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

/**
 * A1 审批闭环：waiting_input 行的「等待审批」徽标。
 *
 * 口径按任务要求取**宽**判据：waiting_input 即挂徽标。当前运行时里会话
 * 挂起在 waiting_input 的唯一路径就是审批（tool-executor requestApproval →
 * markWaiting「等待审批 <approvalKey>」），将来若出现其他人工输入场景，
 * 抽屉里的 waitingFor 文案仍会如实区分。
 */
function needsApprovalBadge(s: AgentSession): boolean {
  return s.status === 'waiting_input';
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
  // A1 审批闭环：详情抽屉的审批单列表 + 处置中状态（按 approvalKey 记，
  // 允许逐单 loading，避免一张单转圈全部按钮禁用）
  const [approvals, setApprovals] = useState<AgentApproval[]>([]);
  const [decidingKey, setDecidingKey] = useState<string | null>(null);
  // 观测审计 P2：设计文档承诺「人工触发 = Admin Web 对话」，但客户端一直没有
  // create——`chat` 类型只能 curl/脚本创建、其指标恒 0。这里补最小入口。
  const [createOpen, setCreateOpen] = useState(false);
  const [createKind, setCreateKind] = useState('chat');
  const [createTitle, setCreateTitle] = useState('');
  const [createContext, setCreateContext] = useState('');
  const [creating, setCreating] = useState(false);
  // A11Y-MODAL-01（WEB-6）：新建会话弹窗的焦点管理（开→首个控件；关→触发按钮）
  const createModalA11y = useModalA11y(createOpen);

  // B-14：silent 轮询不闪 loading（对齐 SopsPage 同款处理）
  //
  // RACE-POLL（审计 P2，2026-10-17）：请求序列号守卫。
  //
  // 缺陷现场：15s 静默轮询与「筛选变化触发的 load」并发在飞时没有先后判据
  // ——筛选后新请求已返回并渲染，而上一拍轮询（携带**旧** kind/status）随后
  // 返回，把列表覆盖回旧筛选的结果。用户看到「筛选没生效」，必须等下一个
  // 15s 拍或手动刷新才纠正。
  //
  // 现在每次 load 领取自增序号，只有最新一发能写 items/total/错误态/loading；
  // 过期响应一律丢弃。序号同时覆盖 silent 与非 silent 两种调用（二者共用同一
  // 条「谁是最新」的判据，否则轮询仍可能盖掉手动刷新）。
  // 判据抽在 utils/raceGuard（纯逻辑、可单测；见 race-guard.test.ts）。
  const raceGuard = useRaceGuard();
  const load = useCallback(async (opts?: { silent?: boolean }) => {
    const seq = raceGuard.next();
    if (!opts?.silent) { setLoading(true); setLoadError(null); }
    try {
      const res = await agentApi.list({ kind: kindFilter, status: statusFilter, page, pageSize });
      if (!raceGuard.isLatest(seq)) return; // 过期响应：丢弃（不覆盖更新的筛选结果）
      setItems(res.items);
      setTotal(res.total);
    } catch (err: unknown) {
      if (!raceGuard.isLatest(seq)) return;
      // B-14：后台轮询失败静默——连续弹 message 是噪音，列表保留旧数据。
      // 非 silent（首屏/手动刷新）失败改为页内错误态（UI-16），不再只弹 toast。
      if (!opts?.silent) setLoadError(err ?? new Error('load failed'));
    } finally {
      if (raceGuard.isLatest(seq) && !opts?.silent) setLoading(false);
    }
  }, [kindFilter, statusFilter, page, pageSize, raceGuard]);

  /**
   * 提交「新建会话」。
   *
   * context 是自由 JSON（会话上下文会作为**数据**注入 system prompt，见
   * runtime rebuildMessages）——前端只做「是对象」的形状校验，字段语义由
   * 运行时各自的 kind 消费，不在这里猜。
   */
  const submitCreate = useCallback(async () => {
    let context: Record<string, unknown> | undefined;
    const raw = createContext.trim();
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('context must be an object');
        }
        context = parsed as Record<string, unknown>;
      } catch {
        message.error(t('agents.createInvalidContext'));
        return;
      }
    }
    setCreating(true);
    try {
      await agentApi.create({
        kind: createKind,
        ...(createTitle.trim() ? { title: createTitle.trim() } : {}),
        ...(context ? { context } : {}),
      });
      message.success(t('agents.createOk'));
      setCreateOpen(false);
      setCreateTitle('');
      setCreateContext('');
      void load();
    } catch {
      message.error(t('agents.createFailed'));
    } finally {
      setCreating(false);
    }
  }, [createKind, createTitle, createContext, t, load]);

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

  // UIUX-F-2（审计 P2-1，同型 SOPS-RACE-01，对齐 SopsPage.detailSeq 同款修法）：
  // openDetail 此前无「谁是最新」判据——快速先点会话 A 再点 B（或 A 响应慢于
  // B）时，A 的旧响应晚到会把 B 抽屉的 steps/toolCalls/children 整个覆盖成
  // A 的数据（标题是 B、内容是 A）；resume() 成功后复用 openDetail 同一路径，
  // 也会把旧响应写回。每次调用自增序号，仅最新一发允许 setState。
  const detailSeq = useRef(0);

  const openDetail = useCallback(async (s: AgentSession) => {
    const seq = ++detailSeq.current;
    setDetail(s);
    setSteps([]);
    setToolCalls([]);
    setChildren([]);
    setApprovals([]); // A1 审批闭环：切会话先清旧审批单，防串页
    try {
      const d = await agentApi.detail(s.id);
      if (seq !== detailSeq.current) return; // 过期响应：丢弃（新选中的行不被旧数据覆盖）
      setDetail(d.session);
      setSteps(d.steps);
      setToolCalls(d.toolCalls);
      setChildren(d.children);
    } catch {
      if (seq !== detailSeq.current) return; // 过期失败同样静默（错误提示只属于最新一次）
      message.error(t('agents.detailFailed'));
    }
    // 审批单列表独立请求：挂了不影响 steps/toolCalls/children 的呈现
    // （同款语义：预算行失败不影响列表）。过期响应同样丢弃。
    try {
      const a = await agentApi.listApprovals(s.id);
      if (seq !== detailSeq.current) return;
      setApprovals(a);
    } catch {
      if (seq !== detailSeq.current) return;
      setApprovals([]);
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

  // A1 审批闭环（实施轮 #12 前端半边）：审批单处置。
  //
  //   · 成功 → 按 resumed 如实提示（grant 且会话 waiting_input 时服务端已
  //     自动重新入队），随后刷新详情（审批单列表随 openDetail 一并重拉）
  //     与列表（会话状态可能已从 waiting_input 翻转）。
  //   · 409（AGENT_APPROVAL_ALREADY_DECIDED，并发处置后到者）→ 拦截器已按
  //     err.* 词条弹过具体提示；这里只刷新，让状态如实回到 granted/denied。
  //     __toastedByClient 缺失（老后端/非拦截器路径）时兜底补一条。
  //   · 其余失败 → 兜底提示；页面状态保持可重试（单据仍在列表里）。
  const decideApproval = useCallback(async (approvalKey: string, decision: 'grant' | 'deny') => {
    if (!detail) return;
    setDecidingKey(approvalKey);
    try {
      const r = decision === 'grant'
        ? await agentApi.grantApproval(detail.id, approvalKey)
        : await agentApi.denyApproval(detail.id, approvalKey);
      // 文案按 decision × resumed 四态**逐一写字面量键**（模板串
      // t(`agents.approval.${decision}Ok`) 对缺键守卫是动态键：静态不可判，
      // 只能整文件进基线豁免）。四态本来就只有四种，写全字面量能让「键是否
      // 存在」继续被 i18n-key-check 静态验证，不为一行省事放宽基线。
      const okMessage = decision === 'grant'
        ? r.resumed
          ? t('agents.approval.grantOk.resumed', { key: approvalKey })
          : t('agents.approval.grantOk', { key: approvalKey })
        : r.resumed
          ? t('agents.approval.denyOk.resumed', { key: approvalKey })
          : t('agents.approval.denyOk', { key: approvalKey });
      message.success(okMessage);
      await openDetail(detail);
      await load({ silent: true });
    } catch (err: unknown) {
      showApiError(err, t('agents.approval.decideFailed', { key: approvalKey }));
      // 409 后到者也要刷新——审批单状态已被对方翻转，本侧列表如实跟进
      const status = (err as { __status?: unknown } | null)?.__status;
      if (status === 409) {
        await openDetail(detail);
        await load({ silent: true });
      }
    } finally {
      setDecidingKey(null);
    }
  }, [detail, openDetail, load, t]);

  /**
   * WEB-4：审批单 → 触发它的那次工具调用（决策依据的**唯一**来源）。
   *
   * 关联键：`agent_tool_calls.approvalId` 里存的就是 approvalKey 本身——
   * tool-executor.service.ts 的 `requestApproval` 第一行 `const approvalId =
   * approvalKey;`，随后 `persist({ status:'awaiting_approval', approvalId, args })`
   * 把**同一组参数**连同审批键一起落库。两者同源，故用 approvalKey 直接匹配
   * （同名工具的多次调用也能各自对上自己那张单）。
   *
   * 取不到就是历史数据/被保留策略清掉的行：下游如实显示「未记录入参」，不猜。
   */
  const toolCallByApprovalKey = useMemo(() => {
    const map = new Map<string, AgentToolCall>();
    for (const c of toolCalls) {
      if (c.approvalId) map.set(c.approvalId, c);
    }
    return map;
  }, [toolCalls]);

  /**
   * WEB-4：批准前的二次确认。
   *
   * 为什么批准需要而拒绝不需要：grant 在服务端是**有副作用且不可撤销**的一步
   * （granted → 自动 resume 会话 → 重放该次调用 → 真正执行写工具 → 记 consumed；
   * 一张单只能领一次，执行后没有回滚入口）。deny 相反：它只是让闸门继续关着，
   * 无副作用、错了可以重新发起，所以保持单击（多余确认只会训练用户盲点「确定」）。
   *
   * 正文三件套对齐「盲签」这一缺陷本体：要动什么（工具名）、拿什么动（参数摘要）、
   * 以及代价（立即执行且不可撤销）。
   */
  const confirmGrant = useCallback((a: AgentApproval) => {
    const args = toolCallByApprovalKey.get(a.approvalKey)?.argsJson ?? null;
    const { pairs, rest } = argsSummary(args, 3);
    const summaryText = pairs.length === 0
      ? t('agents.approval.argsEmpty')
      : `${pairs.join(t('agents.approval.confirmSep'))}${
        rest > 0 ? t('agents.approval.confirmMore', { count: rest }) : ''
      }`;
    confirmModal.confirm({
      title: t('agents.approval.confirmTitle', { tool: a.toolName }),
      content: (
        <div style={{ fontSize: 12 }}>
          <Paragraph style={{ marginBottom: 6 }}>
            <Text type="secondary">{t('agents.col.tool')}：</Text>
            <Text code>{a.toolName}</Text>
          </Paragraph>
          <Paragraph style={{ marginBottom: 6 }}>
            <Text type="secondary">{t('agents.col.args')}：</Text>
            <Text>{summaryText}</Text>
          </Paragraph>
          <Paragraph style={{ marginBottom: 0 }}>
            <Text type="danger">{t('agents.approval.confirmIrreversible')}</Text>
          </Paragraph>
        </div>
      ),
      okText: t('agents.approval.confirmOk'),
      cancelText: t('agents.approval.confirmCancel'),
      // onOk 返回 Promise：antd 在等待期间给确认键转圈，避免连点发出两次 grant
      onOk: () => decideApproval(a.approvalKey, 'grant'),
    });
  }, [toolCallByApprovalKey, decideApproval, t]);

  const sessionColumns: ColumnsType<AgentSession> = [
    {
      title: t('agents.col.title'),
      ellipsis: true,
      render: (_, s) => (
        <Space size={4} wrap>
          {statusTag(s.status, t)}
          {/* A1 审批闭环：waiting_input（当前唯一挂起场景 = 审批）叠加提醒徽标 */}
          {needsApprovalBadge(s) && <Tag color="orange">{t('agents.approvalBadge')}</Tag>}
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

  // A1 审批闭环：审批单表列（详情抽屉「审批单」页签）。
  //
  // WEB-4（P2，2026-10-29 web-ux）：审批的全部价值是「人替系统看一眼这次要做什么」，
  // 而此前这一页恰恰看不到要做什么——reason 在**数据层**被 `.slice(0, 160)` 截断
  // （rc-table 的 ellipsis title 取自同一串，hover 也读不到全文），入参完全缺席。
  // 现在 reason 走 Typography 的三行折叠（全文留在 DOM、可展开），并新增「入参」列
  // 按 approvalKey ↔ 工具调用行关联出该次调用的 argsJson（只读结构化视图）。
  const approvalColumns: ColumnsType<AgentApproval> = [
    {
      title: t('agents.col.tool'),
      dataIndex: 'toolName',
      width: 180,
      render: (v: string, a) => (
        <Space size={4}>
          <Tag color={AGENT_APPROVAL_STATUS_COLOR[a.status] ?? 'default'}>
            {agentApprovalStatusLabel(a.status, t)}
          </Tag>
          <Text style={{ fontSize: 12 }}>{v}</Text>
        </Space>
      ),
    },
    {
      // 三行折叠 + 展开：理由属「审批人必须能读全」的文本，不能截断（WEB-4 主诉之一）。
      // 不设 ellipsis:true——rc-table 的 ellipsis 只在 hover 给 title，而 title 又是
      // 同一串 children，等于什么都没多给。
      title: t('agents.col.reason'),
      render: (_, a) => (
        <Paragraph
          type="secondary"
          style={{ marginBottom: 0, fontSize: 12, maxWidth: 420 }}
          ellipsis={{
            rows: 3,
            expandable: 'collapsible',
            symbol: (expanded) =>
              expanded ? t('agents.approval.collapse') : t('agents.approval.expand'),
          }}
        >
          {a.reason}
        </Paragraph>
      ),
    },
    {
      // 决策依据的本体：这次调用到底要动什么（只读——批准的是当时落库的那组参数）
      title: t('agents.col.args'),
      width: 300,
      render: (_, a) => (
        <ToolArgsView args={toolCallByApprovalKey.get(a.approvalKey)?.argsJson} />
      ),
    },
    {
      title: t('agents.col.decidedBy'),
      width: 140,
      render: (_, a) => (a.decidedBy ?? <Text type="secondary">—</Text>),
    },
    {
      title: t('agents.col.decidedAt'),
      dataIndex: 'decidedAt',
      width: 170,
      render: (v: string | null) => formatDateTime(v),
    },
    {
      // 审批可追溯（实施轮 #15）：批准之后到底有没有真的执行、什么时候执行的。
      // 与 decidedAt 分开列：批准人与执行者不是同一主体，中间可能隔很久；
      // 「批准了但从未执行」（granted 卡住）这一行会在这里显示「—」，正是要看的东西。
      title: t('agents.col.consumedAt'),
      dataIndex: 'consumedAt',
      width: 170,
      render: (v: string | null) => formatDateTime(v),
    },
    {
      title: t('sops.col.actions'),
      width: 150,
      render: (_, a) =>
        a.status === 'pending' ? (
          <Space size={4}>
            <Button
              size="small"
              type="primary"
              loading={decidingKey === a.approvalKey}
              disabled={decidingKey !== null && decidingKey !== a.approvalKey}
              // WEB-4：单击即执行 → 二次确认（正文列出工具名/参数摘要/不可撤销，见 confirmGrant）
              onClick={() => confirmGrant(a)}
            >
              {t('agents.approval.grant')}
            </Button>
            {/* 拒绝保持单击：无副作用，多一步确认只会训练用户盲点「确定」 */}
            <Button
              size="small"
              danger
              disabled={decidingKey !== null && decidingKey !== a.approvalKey}
              onClick={() => void decideApproval(a.approvalKey, 'deny')}
            >
              {t('agents.approval.deny')}
            </Button>
          </Space>
        ) : null,
    },
  ];

  const childColumns: ColumnsType<AgentSession> = [
    {
      title: t('agents.col.title'),
      render: (_, s) => (
        <Space size={4} wrap>
          {statusTag(s.status, t)}
          {needsApprovalBadge(s) && <Tag color="orange">{t('agents.approvalBadge')}</Tag>}
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
  // 观测审计 P3：budget_exceeded 同样要排除——后端固定回 ok:false
  //（预算是创建时快照，步数/令牌按会话累计），按钮只会产生一条失败提示。
  const resumable = detail !== null &&
    ['waiting_input', 'failed', 'pending'].includes(detail.status);

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
            <Button
              icon={<PlusOutlined />}
              type="primary"
              onClick={() => setCreateOpen(true)}
            >
              {t('agents.create')}
            </Button>
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
          <div>
            <Space>
              <Button
                icon={<PlusOutlined />}
                type="primary"
                onClick={() => setCreateOpen(true)}
              >
                {t('agents.create')}
              </Button>
              {refreshButton}
            </Space>
          </div>
        </div>
      )}
      <Modal
        open={createOpen}
        title={t('agents.createDialogTitle')}
        okText={t('agents.create')}
        cancelText={t('agents.createCancel')}
        confirmLoading={creating}
        onOk={() => void submitCreate()}
        onCancel={() => setCreateOpen(false)}
        // antd 6：destroyOnClose 改名 destroyOnHidden（同一语义：关闭后卸载字段子树）
        destroyOnHidden
        // keyboard / mask.closable 均保持 antd 默认（Esc 关闭、点遮罩关闭），
        // 未在此禁用：Esc 是本弹窗唯一的键盘退出路径，关掉等于把键盘用户锁在
        // 弹窗里等鼠标（焦点陷阱此时反而是负担）。焦点陷阱默认开启。
      >
        {/* WEB-6：字段名走 Form.Item label（渲染 label[for]）+ 控件 id，可见标签与
            可访问名同源；A11Y-MODAL-01：contentRef 收窄「首个可交互元素」的查询 */}
        <div ref={createModalA11y.contentRef}>
          <Form layout="vertical" component={false}>
            <Form.Item
              label={t('agents.createKind')}
              htmlFor={CREATE_FIELD_ID.kind}
              // 间距对齐改造前的 Space size="middle"（16px），只换标签语义不重排布局
              style={{ marginBottom: 16 }}
            >
              <Select
                id={CREATE_FIELD_ID.kind}
                style={{ width: '100%' }}
                value={createKind}
                onChange={setCreateKind}
                options={['chat', 'ops_watch', 'incident', 'sop_authoring', 'sop_review', 'app_scaffold'].map((k) => ({
                  value: k,
                  label: agentKindLabel(k, t),
                }))}
              />
            </Form.Item>
            <Form.Item
              label={t('agents.createTitle')}
              htmlFor={CREATE_FIELD_ID.title}
              style={{ marginBottom: 16 }}
            >
              <Input
                id={CREATE_FIELD_ID.title}
                value={createTitle}
                maxLength={255}
                onChange={(e) => setCreateTitle(e.target.value)}
                placeholder={t('agents.createTitlePlaceholder')}
              />
            </Form.Item>
            {/* 末项不留尾部间距：弹窗 body 自带 padding，避免多出一段空白 */}
            <Form.Item
              label={t('agents.createContext')}
              htmlFor={CREATE_FIELD_ID.context}
              style={{ marginBottom: 0 }}
            >
              <Input.TextArea
                id={CREATE_FIELD_ID.context}
                rows={5}
                value={createContext}
                onChange={(e) => setCreateContext(e.target.value)}
                placeholder={t('agents.createContextPlaceholder')}
              />
            </Form.Item>
          </Form>
        </div>
      </Modal>
      {/* UI-16：非静默加载失败 → 页内原位错误块 + 重试（轮询失败仍静默，B-14 语义不变） */}
      {loadError ? (
        <StateError
          error={loadError}
          title={t('agents.loadFailed')}
          onRetry={() => void load()}
          style={{ marginBottom: 16 }}
        />
      ) : null}
      {/* UI-08：首屏（数据未达、未出错、加载中）以骨架替代两形态——此前移动端
          卡片分支在 items=[] 时直接渲染 Empty「暂无 Agent 会话」，把「加载中」
          误报成「没有数据」；桌面表格只有内建 spinner，与全站列表页骨架形态
          不一致。数据到达后（含轮询拍）不再进此分支，筛选/空态语义不变。 */}
      {loading && loadError === null && items.length === 0 ? (
        <PageSkeleton variant="table" rows={6} />
      ) : isMobile ? (
        // UI-09 第三轮：≤768px 卡片列表（MOBILE-CARD-01 同款结构级降级）——
        // 会话卡按首查信息组织：状态+标题 → 类型+触发来源 → 用量 → 开始时间 →
        // 操作；桌面保留 6 列表格。
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
                  <Space size={4} wrap>
                    {needsApprovalBadge(s) && <Tag color="orange">{t('agents.approvalBadge')}</Tag>}
                    {statusTag(s.status, t)}
                  </Space>
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
          // 2026-10-23：此前无 scroll——固定列合计 770（kind 130 + trigger 180 +
          // usage 200 + startedAt 170 + 操作 90）+ 标题弹性列最小 160 ≈ 930。
          // 窄屏下 antd 会把固定列压到比内容窄（「运行中 · 1 步 · 0 令牌 · 0 工具调用」
          // 首当其冲），补 scroll.x 让横向滚动接管。
          scroll={{ x: 960 }}
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
                  // A1 审批闭环：pending 单给批准/拒绝操作；处置后详情与列表
                  // 自动刷新（见 decideApproval）。空态与其他页签一致。
                  key: 'approvals',
                  label: t('agents.tab.approvals', { count: approvals.length }),
                  children:
                    approvals.length > 0 ? (
                      <Table<AgentApproval>
                        rowKey="id"
                        columns={approvalColumns}
                        dataSource={approvals}
                        pagination={false}
                        size="small"
                        // WEB-4：新增「入参」列后固定列合计 ~1110，抽屉 920 会挤压
                        // 弹性列（理由）——交给横向滚动，窄屏不塌陷（对齐本页列表 scroll.x 先例）
                        scroll={{ x: 1180 }}
                      />
                    ) : (
                      <Text type="secondary">{t('agents.approvalsEmpty')}</Text>
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
