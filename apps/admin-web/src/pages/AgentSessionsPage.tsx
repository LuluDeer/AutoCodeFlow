import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRaceGuard } from '../utils/raceGuard';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Card,
  Drawer,
  Empty,
  Pagination,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  theme,
} from 'antd';
import { message } from '../utils/toast';
import {
  DownloadOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
// URL-SYNC-01：筛选/分页同步 URL（对齐 TaskListPage/ExecutionsPage 先例）——
// 刷新、后退、分享链接不丢状态。

import PageHeader from '../components/PageHeader';
import AgentAttentionBadges from '../components/AgentAttentionBadges';
import { useAgentListUrlState } from '../hooks/useAgentListUrlState';
// UI-16：列表请求失败不再只弹 toast——页内原位错误块 + 重试入口
import StateError from '../components/StateError';
// UI-08：首屏数据未达时以骨架形态替代裸 spinner / 空态误报（见下方列表分支）
import PageSkeleton from '../components/PageSkeleton';
// UI-09 第三轮：≤768px 表格 → 卡片列表的结构级降级（对齐 TaskListPage/
// ApplicationListPage 的 MOBILE-CARD-01 先例；断点与 index.css ui09 媒体查询同值）
import { useIsMobile } from '../hooks/useIsMobile';
// A11Y-DRAWER-01：Drawer 打开后焦点移入内容、关闭归还触发按钮
import { useDrawerA11y } from '../hooks/useDrawerA11y';
import AgentSessionCreateModal from '../components/AgentSessionCreateModal';
import AgentSessionOutcome from '../components/AgentSessionOutcome';
import AgentStepProgress from '../components/AgentStepProgress';
import { useAgentSessionDetail } from '../hooks/useAgentSessionDetail';
import { isSessionPathSegment } from '../utils/agentSessionUrl';
import { agentApi } from '../api/agent';
import type { AgentSessionStreamStatus, AgentLiveState } from '../hooks/useAgentSessionLiveSession';
// SOPS-TIME-01：startedAt 列与 SopsPage 同走 formatDateTime（locale 感知 + 空值 '—'）
import { formatDateTime } from '../utils/timeFormat';
// UX-06：裸枚举收敛到共享词表（status/kind/工具状态/角色/层级 唯一事实源）
import {
  agentApprovalStatusLabel,
  agentKindLabel,
  agentStatusLabel,
  agentStepRoleLabel,
  agentToolStatusLabel,
} from '../utils/agent-label';
// P3 审计：Agent 会话/工具状态 → Tag color 映射收敛到单一事实源
import { AGENT_APPROVAL_STATUS_COLOR, AGENT_SESSION_STATUS_COLOR } from '../utils/status-color';
// A1 审批闭环：grant/deny 失败的兜底提示（__toastedByClient 去重，见 utils/error.ts）
import { showApiError } from '../utils/error';
// WEB-4：批准前的二次确认走 MODAL-01 出口（主题化/locale 化；JSX 形态的
// `<Modal>` 仍用 antd 组件，两者并存是本仓既有写法，见 SopsPage.tsx:11/26）
import { Modal as confirmModal } from '../utils/modal';
// WEB-4：审批行的入参结构化视图（只读键值列表，长值可折叠）
import ToolArgsView from '../components/ToolArgsView';
import { argsSummary } from '../utils/toolArgs';
// 工具调用表列定义已外提（本文件 size-caps 顶格）；结果列见该文件的诚实口径说明。
import { buildToolColumns } from './agent-sessions/ToolColumns';
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

// UX-06：状态 Tag 走共享词表（未知值回退原始 token，保留可诊断信息）
/** G4：把 createdBy 的机器形态翻成可读文本（用户 / 系统主体）。 */
function actorLabel(
  raw: string,
  t: import('i18next').TFunction,
): string {
  if (raw.startsWith('user:')) return raw.slice('user:'.length);
  if (raw.startsWith('system:')) {
    return t('agents.actorSystem', { name: raw.slice('system:'.length) });
  }
  return raw;
}

function statusTag(status: string, t: import('i18next').TFunction) {
  return (
    <Tag color={AGENT_SESSION_STATUS_COLOR[status] ?? 'default'}>{agentStatusLabel(status, t)}</Tag>
  );
}

/** SSE 流状态 → 复用已有 workbench/dashboard 流状态键（不改 locales）。 */
const STREAM_STATUS_T: Record<AgentSessionStreamStatus, string> = {
  live: 'dashboard.stream.live',
  reconnecting: 'dashboard.stream.reconnecting',
  polling: 'workbench.stream.fallback',
  connecting: 'dashboard.stream.connecting',
};
const STREAM_STATUS_COLOR: Record<AgentSessionStreamStatus, string> = {
  live: 'green', reconnecting: 'orange', polling: 'orange', connecting: 'blue',
};
const STREAM_DISCONNECTED = new Set<AgentSessionStreamStatus>(['reconnecting', 'polling']);

/** 实时横幅的一枚 chip；text 已按当前语言求值，页面只负责画。 */
interface LiveChip { key: string; text: string; color?: string }

/** 把 SSE 增量整理成 chips + 正文：数据驱动，页面不重复判定同一状态。 */
function liveBannerModel(status: AgentSessionStreamStatus, live: AgentLiveState, t: import('i18next').TFunction) {
  const chips: LiveChip[] = [
    { key: 'status', text: t(STREAM_STATUS_T[status]), color: STREAM_STATUS_COLOR[status] },
  ];
  if (STREAM_DISCONNECTED.has(status)) chips.push({ key: 'fallback', text: t('workbench.stream.fallback') });
  if (live.phase) chips.push({ key: 'phase', text: live.phase });
  if (live.truncated) chips.push({ key: 'truncated', text: 'truncated · hasMore' });
  if (live.toolCalls.length) {
    chips.push({ key: 'tool-count', text: t('agents.tab.tools', { count: live.toolCalls.length }) });
    for (const tc of live.toolCalls) {
      chips.push({ key: tc.key, text: `${tc.toolName} · ${tc.status ? agentToolStatusLabel(tc.status, t) : tc.status}` });
    }
  }
  if (live.approvals.length) {
    chips.push({ key: 'approval-count', text: t('agents.tab.approvals', { count: live.approvals.length }) });
    for (const a of live.approvals) {
      chips.push({ key: a.key, text: `${a.key} · ${a.status ? agentApprovalStatusLabel(a.status, t) : a.status}` });
    }
  }
  const role = t('agents.role.assistant');
  const body = [
    live.reasoning && `${role} · reasoning:\n${live.reasoning}`,
    live.content && `${role}:\n${live.content}`,
  ].filter(Boolean).join('\n');
  return { chips, body };
}

/** 实时状态横幅：把 SSE 增量（token/reasoning/phase、工具调用、审批）与连接状态
 * 折叠进详情抽屉顶部。所有文案复用既有 locale 键；权威表仍由 REST detail 渲染，
 * 这里只画「本刷新窗口之后」的增量，避免同一帧被渲染两遍。 */
function AgentSessionLiveBanner({ status, live, t }: {
  status: AgentSessionStreamStatus;
  live: AgentLiveState;
  t: import('i18next').TFunction;
}) {
  const { chips, body } = liveBannerModel(status, live, t);
  if (chips.length === 1 && !body) return null;
  return (
    <Paragraph style={{ marginBottom: 8 }}>
      <Space size={8} wrap>
        {chips.map(c => <Tag key={c.key} color={c.color} role={c.key === 'status' ? 'status' : undefined}>{c.text}</Tag>)}
      </Space>
      {body && (
        <pre style={{ maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12, padding: 8, borderRadius: 6, background: 'var(--color-fill-quaternary, rgba(127,127,127,0.08))', fontFamily: 'var(--font-mono)' }}>
          {body}
        </pre>
      )}
    </Paragraph>
  );
}

function usageOf(s: AgentSession, t: import('i18next').TFunction): string {
  return t('agents.usageSummary', {
    steps: s.totalSteps,
    tokens: s.totalTokensIn + s.totalTokensOut,
    tools: s.totalToolCalls,
  });
}

/**
 * S1-C3（审批信息完整性）：审批单**自带**的被批对象摘要与预览。
 *
 * 后端 `agent_approvals` 自迁移 `1790000000085` 起落两列（admin-api
 * `entities/agent-approval.entity.ts`）：
 *   · `argsDigest` = `sha256(规范化参数)`——与审批键同源，供事后对账「批的就是
 *     这次调用」（键只留 16 位前缀，不足以做校验）；
 *   · `preview` = **已脱敏 + 已截断（2KB）** 的 JSON 信封
 *     `{ truncated, omittedBytes?, args }`，`args` 是脱敏后参数的 JSON 文本。
 *
 * 这里只做**展示**（零可编辑控件，理由见 `components/ToolArgsView.tsx` 头注）。
 * 类型是本地扩展而不是改 `api/agent.ts`：新列是可选字段，旧后端/旧响应缺它们
 * 时页面必须照旧工作（灰度期前后端不同步）。
 */
type AgentApprovalWithExcerpt = AgentApproval & {
  argsDigest?: string | null;
  preview?: string | null;
};

interface ApprovalExcerpt {
  /** 信封里 args 解析出的结构化参数；被截断切断 JSON 时为 null。 */
  args: Record<string, unknown> | null;
  /** 信封里 args 的**未转义**原文：解析不出对象时直接展示（让人看到截到哪）。 */
  argsText: string | null;
  /** 服务端因超 2KB 截断过——必须显式告诉审批人「你看的不是全部」。 */
  truncated: boolean;
}

/** 解析审批单自带的 preview 信封；无预览返回 null（不臆造）。 */
function parseApprovalPreview(
  preview: string | null | undefined,
): ApprovalExcerpt | null {
  if (typeof preview !== 'string' || preview.length === 0) return null;
  try {
    const env = JSON.parse(preview) as { truncated?: unknown; args?: unknown };
    const argsText = typeof env.args === 'string' ? env.args : null;
    let args: Record<string, unknown> | null = null;
    if (argsText !== null) {
      try {
        const parsed = JSON.parse(argsText) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        // 截断会把 args 切成半个 JSON：这不是错误，是「部分可见」
        args = null;
      }
    }
    return { args, argsText, truncated: env.truncated === true };
  } catch {
    // 信封本身不可解析（未来格式变更）：原样展示，绝不吞掉
    return { args: null, argsText: preview, truncated: false };
  }
}

/**
 * 审批单「入参」列的单元格：优先展示审批单**自带的**预览（服务端落库的那一份，
 * 与批准键同源），旧单（本列上线前创建 / 后端尚未升级）回退到 approvalKey ↔
 * 工具调用行的关联视图。
 *
 * 为什么优先自带那份：工具调用行会被保留策略清理，链路长度也是问题——审批的
 * 决策依据不该依赖「另一次查询恰好还在」。
 */
function ApprovalArgsCell({
  approval,
  toolCallArgs,
}: {
  approval: AgentApprovalWithExcerpt;
  toolCallArgs: Record<string, unknown> | null | undefined;
}) {
  const { t } = useTranslation();
  const excerpt = parseApprovalPreview(approval.preview);
  const digest =
    typeof approval.argsDigest === 'string' && approval.argsDigest.length > 0
      ? approval.argsDigest
      : null;

  if (!excerpt) {
    return (
      <div>
        <ToolArgsView args={toolCallArgs} />
        <Text type="secondary" style={{ fontSize: 11 }}>
          {digest === null
            ? t('agents.approval.previewLegacy')
            : t('agents.approval.previewNoArgs')}
        </Text>
      </div>
    );
  }

  return (
    <div>
      {excerpt.args ? (
        <ToolArgsView args={excerpt.args} />
      ) : (
        <Paragraph
          type="secondary"
          style={{
            marginBottom: 0,
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
          ellipsis={{
            rows: 3,
            expandable: 'collapsible',
            symbol: (expanded) =>
              expanded ? t('agents.approval.collapse') : t('agents.approval.expand'),
          }}
        >
          {excerpt.argsText ?? t('agents.approval.argsEmpty')}
        </Paragraph>
      )}
      {excerpt.truncated && (
        <Tag color="orange" style={{ marginTop: 4 }}>
          {t('agents.approval.previewTruncated')}
        </Tag>
      )}
      {digest && (
        <div style={{ marginTop: 2 }}>
          {/* 全文放 title：16 位前缀只用于人眼比对，机器对账要用整串 */}
          <Text type="secondary" style={{ fontSize: 11, wordBreak: 'break-all' }} title={digest}>
            {t('agents.approval.argsDigest', { digest: `${digest.slice(0, 16)}…` })}
          </Text>
        </div>
      )}
    </div>
  );
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
  const { token } = theme.useToken();
  // UI-09 第三轮：≤768px 结构级降级开关（表格→卡片、抽屉满宽、筛选堆叠）
  const isMobile = useIsMobile();
  // A11Y-DRAWER-01：会话详情抽屉焦点管理（开→聚焦首个可交互元素；关→归还触发按钮）
  const drawerA11y = useDrawerA11y();
  const { page, pageSize, kindFilter, statusFilter, stalledOnly, sessionId, tab, approvalKey, paginate,
    filterKind, filterStatus, showStalled, clearStalled, clearFilters, selectSession, selectTab } = useAgentListUrlState();
  const [items, setItems] = useState<AgentSession[]>([]);
  const [total, setTotal] = useState(0);
  const [pendingRefreshToken, setPendingRefreshToken] = useState(0); // R198：待接管徽标的刷新信号
  const [loading, setLoading] = useState(false);
  // UI-16：非静默加载（首屏/手动刷新/筛选变化）失败时记录错误并原位呈现；
  // B-14 的静默轮询失败仍保持静默（列表保留旧数据，不弹错误块刷屏）。
  const [loadError, setLoadError] = useState<unknown>(null);
  const [budget, setBudget] = useState<AgentBudget | null>(null);
  const validId = sessionId !== null && isSessionPathSegment(sessionId) ? sessionId : null;
  const { detail: payload, approvals, detailState, detailError, approvalsState, refresh: refreshDetail,
    live, streamStatus } = useAgentSessionDetail(validId);
  const detail = payload?.session ?? items.find(s => s.id === validId) ?? null;
  const steps = payload?.steps ?? [];
  const toolCalls = payload?.toolCalls;
  const children = payload?.children ?? [];
  const [exporting, setExporting] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [decidingKey, setDecidingKey] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

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
      // R199：`stalled: 1` ⇒ 后端只列「running 且久无进展」的会话。
      const res = await agentApi.list({ kind: kindFilter, status: statusFilter, ...(stalledOnly ? { stalled: 1 } : {}), page, pageSize });
      if (!raceGuard.isLatest(seq)) return; // 过期响应：丢弃（不覆盖更新的筛选结果）
      setItems(res.items);
      setLoadError(null);
      setTotal(res.total);
      setPendingRefreshToken(n => n + 1);
    } catch (err: unknown) {
      if (!raceGuard.isLatest(seq)) return;
      // B-14：后台轮询失败静默——连续弹 message 是噪音，列表保留旧数据。
      // 非 silent（首屏/手动刷新）失败改为页内错误态（UI-16），不再只弹 toast。
      if (!opts?.silent) setLoadError(err ?? new Error('load failed'));
    } finally {
      if (raceGuard.isLatest(seq)) setLoading(false);
    }
  }, [kindFilter, statusFilter, stalledOnly, page, pageSize, raceGuard]);

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

  const resume = useCallback(async () => {
    if (!detail) return;
    setResuming(true);
    try {
      const r = await agentApi.resume(detail.id);
      if (r.ok) message.success(t('agents.resumeOk'));
      else message.warning(r.reason ?? t('agents.resumeFailed'));
      await refreshDetail(detail.id);
      await load({ silent: true });
    } catch (err) {
      showApiError(err, t('agents.resumeFailed'));
      await refreshDetail(detail.id);
    } finally {
      setResuming(false);
    }
  }, [detail, refreshDetail, load, t]);

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
      await refreshDetail(detail.id);
      await load({ silent: true });
    } catch (err: unknown) {
      showApiError(err, t('agents.approval.decideFailed', { key: approvalKey }));
      // 409 后到者也要刷新——审批单状态已被对方翻转，本侧列表如实跟进
      const status = (err as { __status?: unknown } | null)?.__status;
      if (status === 409) {
        await refreshDetail(detail.id);
        await load({ silent: true });
      }
    } finally {
      setDecidingKey(null);
    }
  }, [detail, refreshDetail, load, t]);

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
  /** G5：把会话完整转录下载为 JSON（排障/工单附件）。 */
  const exportTranscript = useCallback(async () => {
    if (!detail || exporting) return;
    setExporting(true);
    try {
      const data = await agentApi.exportSession(detail.id);
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `agent-session-${detail.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      showApiError(err, t('agents.exportFailed'));
    } finally {
      setExporting(false);
    }
  }, [detail, exporting, t]);

  const toolCallByApprovalKey = useMemo(() => {
    const map = new Map<string, AgentToolCall>();
    for (const c of toolCalls ?? []) {
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
    // S1-C3：确认框的参数摘要同样优先用审批单**自带**的预览（服务端脱敏 + 截断）——
    // 批准确认与审批单展示必须是同一份事实，否则「我确认的是这组参数」可能对不上。
    const args =
      parseApprovalPreview((a as AgentApprovalWithExcerpt).preview)?.args ??
      toolCallByApprovalKey.get(a.approvalKey)?.argsJson ??
      null;
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
            <Text type="secondary">{t('agents.col.tool_colon')}</Text>
            <Text code>{a.toolName}</Text>
          </Paragraph>
          <Paragraph style={{ marginBottom: 6 }}>
            <Text type="secondary">{t('agents.col.args_colon')}</Text>
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
    { title: t('agents.col.usage'), width: 200, render: (_, s) => <span style={{ whiteSpace: 'nowrap' }}>{usageOf(s, t)}</span> },
    { title: t('agents.col.startedAt'), dataIndex: 'startedAt', width: 170, render: (v: string | null) => formatDateTime(v) },
    {
      title: t('sops.col.actions'),
      width: 90,
      render: (_, s) => (
        <Button size="small" onClick={() => selectSession(s.id)}>
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

  // 工具调用表列定义（含「结果」列与全文入参/异常）见 pages/agent-sessions/ToolColumns.tsx。
  const toolColumns = buildToolColumns(t);

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
        <div>
          <Space size={4}>
            <Tag color={AGENT_APPROVAL_STATUS_COLOR[a.status] ?? 'default'}>
              {agentApprovalStatusLabel(a.status, t)}
            </Tag>
            <Text style={{ fontSize: 12 }}>{v}</Text>
          </Space>
          {/* ADR-045：发布审批单加一行四眼提示——批准 = 同意发布，执行者是系统代理，
              主管不得自批（服务端 release-four-eyes 强制）。判定只看工具名，
              grant/deny 流程与入参解析一行未动。 */}
          {v === 'sop_publish' ? (
            <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 2 }}>
              {t('agents.approval.fourEyesPublish')}
            </Text>
          ) : null}
        </div>
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
      //
      // S1-C3：优先用审批单**自带**的脱敏预览（服务端落库、随审批单返回）；
      // 旧单（本列上线前创建，两列 NULL = 「不知道」）回退到 approvalKey ↔ 工具
      // 调用行的关联视图——回退是降级，不是等价物（调用行可能已被保留策略清掉）。
      title: t('agents.col.args'),
      width: 300,
      render: (_, a) => (
        <ApprovalArgsCell
          approval={a as AgentApprovalWithExcerpt}
          toolCallArgs={toolCallByApprovalKey.get(a.approvalKey)?.argsJson}
        />
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
    { title: t('agents.col.usage'), width: 200, render: (_, s) => <span style={{ whiteSpace: 'nowrap' }}>{usageOf(s, t)}</span> },
    {
      title: t('sops.col.actions'),
      width: 90,
      render: (_, s) => (
        <Button size="small" onClick={() => selectSession(s.id)}>
          {t('sops.view')}
        </Button>
      ),
    },
  ];

  // B-8：running 不在可恢复集合——后端对 running 会话的 resume 返回 409
  //（重复入队会产生双份推理循环副作用），前端同步隐藏入口。
  // 观测审计 P3：budget_exceeded 同样要排除——后端固定回 ok:false
  //（预算是创建时快照，步数/令牌按会话累计），按钮只会产生一条失败提示。
  const resumable = detailState === 'ready' && detail !== null && approvalsState === 'ready' &&
    ['waiting_input', 'failed', 'pending'].includes(detail.status) && !approvals.some(a => a.status === 'pending');

  // A link from an approval item must never substitute another request, even in the same session.
  const visibleApprovals = approvalKey === null ? approvals : approvals.filter(a => a.approvalKey === approvalKey);
  const retryDetail = () => { if (validId) void refreshDetail(validId); };
  // R171（P2-1）：三页签共用兜底——读取中「读取中…」，失败「读取失败 + 重试」。
  const detailTabFallback = detailState === 'loading' ? (
    <Text type="secondary">{t('agents.detailLoading')}</Text>
  ) : (
    <Space size={8} wrap>
      <Text type="danger">{t('agents.detailReadFailed')}</Text>
      <Button size="small" onClick={retryDetail}>{t('agents.detailRetry')}</Button>
    </Space>
  );

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
      style={{ width: isMobile ? '100%' : 180 }}
      value={kindFilter}
      onChange={filterKind}
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
      style={{ width: isMobile ? '100%' : 180 }}
      value={statusFilter}
      onChange={filterStatus}
      options={Object.keys(AGENT_SESSION_STATUS_COLOR).map((s) => ({ value: s, label: agentStatusLabel(s, t) }))}
    />
  );
  // 图标按钮 a11y：图标随文字按钮（有可读文案），对读屏器纯装饰 → aria-hidden
  const refreshButton = (
    <Button icon={<ReloadOutlined aria-hidden />} onClick={() => void load()}>
      {t('sops.refresh')}
    </Button>
  );
  const hasFilters = Boolean(kindFilter || statusFilter || stalledOnly);
  // 空态区分（桌面表格 locale 与移动端卡片空态同源）：筛选无匹配给
  //「清除筛选」出口；真空态如实提示。
  const emptyNode = hasFilters ? (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('agents.empty.noMatch')}>
      <Button
        type="link"
        size="small"
        onClick={clearFilters}
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
          <Space wrap>
            {budgetNode}
            {refreshButton}
            <Button
              icon={<PlusOutlined />}
              type="primary"
              onClick={() => setCreateOpen(true)}
            >
              {t('agents.create')}
            </Button>
          </Space>
        ) : undefined}
      />
      {/* 独立筛选栏：桌面下沉为横向流式筛选条（徽标 + 类型/状态 Select 180px + 条件显示清除筛选）；移动端纵向堆叠 */}
      {isMobile ? (
        <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {budgetNode}
          <AgentAttentionBadges
            refreshToken={pendingRefreshToken}
            stalledOnly={stalledOnly}
            onShowPending={() => filterStatus('waiting_input')}
            onShowStalled={showStalled}
            onClearStalled={clearStalled}
          />
          {kindSelect}
          {statusSelect}
          <div>
            <Space wrap>
              <Button
                icon={<PlusOutlined />}
                type="primary"
                onClick={() => setCreateOpen(true)}
              >
                {t('agents.create')}
              </Button>
              {refreshButton}
              {hasFilters && (
                <Button size="small" onClick={clearFilters}>
                  {t('common.clearFilters')}
                </Button>
              )}
            </Space>
          </div>
        </div>
      ) : (
        <div style={{ marginBottom: 16, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <AgentAttentionBadges
            refreshToken={pendingRefreshToken}
            stalledOnly={stalledOnly}
            onShowPending={() => filterStatus('waiting_input')}
            onShowStalled={showStalled}
            onClearStalled={clearStalled}
          />
          {kindSelect}
          {statusSelect}
          {hasFilters && (
            <Button size="small" onClick={clearFilters}>
              {t('common.clearFilters')}
            </Button>
          )}
        </div>
      )}
      <AgentSessionCreateModal open={createOpen} onClose={() => setCreateOpen(false)}
        onCreated={(id) => { selectSession(id); void load(); }} />
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
                  {t('agents.col.startedAt_colon')}{formatDateTime(s.startedAt)}
                </div>
                <div style={{ marginTop: 8 }}>
                  <Button size="small" onClick={() => selectSession(s.id)}>
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
              onChange={paginate}
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
            // 真空态使用无数据提示，页头提供新建会话入口。
            emptyText: emptyNode,
          }}
          pagination={{ current: page, pageSize, total, showSizeChanger: true, onChange: paginate }}
          size="middle"
        />
      )}

      <Drawer
        title={detail ? (detail.title ?? `${agentKindLabel(detail.kind, t)} · ${detail.id.slice(0, 8)}`) : t('agents.detailHeading')}
        // antd 6：width 已并入 size（number|string|'large'|'default'）——
        // 窄屏 '100%' 满宽，桌面 920px 固定宽
        size={isMobile ? '100%' : 920}
        open={sessionId !== null}
        onClose={() => selectSession()}
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
          {sessionId !== null && !detail && (validId === null ? <Text type="danger" role="alert">{t('agents.invalidSessionLink')}</Text> :
            detailState === 'error' ? <StateError error={detailError} title={t('agents.detailFailed')} onRetry={retryDetail} /> :
            <Text type="secondary" role="status">{t('agents.detailLoading')}</Text>)}
          {detail && (
            <>
            <Paragraph>
              <Space size={8} wrap>
                {statusTag(detail.status, t)}
                <Tag>{agentKindLabel(detail.kind, t)}</Tag>
                <Tag>{detail.triggerSource}</Tag>
                {detail.createdBy && <Tag color="blue">{t('agents.createdBy', { actor: actorLabel(detail.createdBy, t) })}</Tag>}
                <Text type="secondary">{usageOf(detail, t)}</Text>
                <Button size="small" icon={<DownloadOutlined />} loading={exporting} onClick={() => void exportTranscript()}>{t('agents.exportTranscript')}</Button>
              </Space>
            </Paragraph>
            <AgentSessionLiveBanner status={streamStatus} live={live} t={t} />
            {/* R171 体量压缩：单文本 Paragraph 5 行折 1 行（等价；本文件基线只减不增）。 */}
            {detail.waitingFor && <Paragraph><Text type="warning">⏳ {detail.waitingFor}</Text></Paragraph>}
            {detail.errorMessage && <Paragraph><Text type="danger">{detail.errorMessage}</Text></Paragraph>}
            <AgentSessionOutcome session={detail} />
            {stalledOnly && detailState === 'ready' && <AgentStepProgress steps={steps} />}
            <Tabs
              activeKey={tab}
              onChange={selectTab}
              items={[
                {
                  key: 'steps',
                  // R171（P2-1）：非 ready 时计数显示「—」（未知），**不能**写 0。
                  label: t('agents.tab.steps', { count: detailState === 'ready' ? steps.length : '—' }),
                  children: detailState !== 'ready' ? detailTabFallback : (
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
                  label: t('agents.tab.tools', { count: detailState === 'ready' ? (toolCalls?.length ?? 0) : '—' }),
                  children: detailState !== 'ready' ? detailTabFallback : (
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
                  // W1：读取失败时计数显示「—」（未知），不能显示 0——0 会被读成
                  // 「没有待审批单」，而会话可能正卡在等审批。
                  key: 'approvals',
                  label: t('agents.tab.approvals', {
                    count: approvalsState === 'ready' ? visibleApprovals.length : '—',
                  }),
                  children:
                    approvalsState === 'error' ? (
                      // W1：失败态给明确出口（重试复用 openDetail——同一 seq 机制
                      // 保证连点/切会话时只有最新一发落地）。
                      <Space size={8} wrap>
                        <Text type="danger">{t('agents.approvalsLoadFailed')}</Text>
                        <Button size="small" onClick={retryDetail}>{t('agents.approvalsRetry')}</Button>
                      </Space>
                    ) : approvalsState === 'loading' ? (
                      <Text type="secondary">{t('agents.approvalsLoading')}</Text>
                    ) : <>
                      {approvalKey !== null && <Paragraph>
                        <Text>{visibleApprovals.length ? t('agents.approval.linked') : t('agents.approval.notFound')}</Text>{' '}
                        <Button type="link" size="small" onClick={() => selectTab('approvals')}>{t('agents.approval.showAll')}</Button>
                      </Paragraph>}
                      {visibleApprovals.length > 0 ? <Table<AgentApproval>
                        rowKey="id"
                        columns={approvalColumns}
                        dataSource={visibleApprovals}
                        pagination={false}
                        size="small"
                        // WEB-4：新增「入参」列后固定列合计 ~1110，抽屉 920 会挤压
                        // 弹性列（理由）——交给横向滚动，窄屏不塌陷（对齐本页列表 scroll.x 先例）
                        scroll={{ x: 1180 }}
                      /> : approvalKey === null && <Text type="secondary">{t('agents.approvalsEmpty')}</Text>}
                    </>,
                },
                {
                  key: 'children',
                  label: t('agents.tab.children', { count: detailState === 'ready' ? children.length : '—' }),
                  children: detailState !== 'ready' ? detailTabFallback : children.length > 0 ? (
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
                      <pre style={{ maxHeight: 200, overflow: 'auto', fontSize: 12, padding: 8, borderRadius: 6, background: token.colorFillTertiary, border: `1px solid ${token.colorBorderSecondary}`, fontFamily: 'var(--font-mono)' }}>
                        {JSON.stringify(detail.scopeJson ?? {}, null, 2)}
                      </pre>
                      <Paragraph>
                        <Text type="secondary">{t('agents.contextLabel')}</Text>
                      </Paragraph>
                      <pre style={{ maxHeight: 240, overflow: 'auto', fontSize: 12, padding: 8, borderRadius: 6, background: token.colorFillTertiary, border: `1px solid ${token.colorBorderSecondary}`, fontFamily: 'var(--font-mono)' }}>
                        {JSON.stringify(detail.contextJson ?? {}, null, 2)}
                      </pre>
                      {detail.resultJson && (
                        <>
                          <Paragraph>
                            <Text type="secondary">{t('agents.resultLabel')}</Text>
                          </Paragraph>
                          <pre style={{ maxHeight: 240, overflow: 'auto', fontSize: 12, padding: 8, borderRadius: 6, background: token.colorFillTertiary, border: `1px solid ${token.colorBorderSecondary}`, fontFamily: 'var(--font-mono)' }}>
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
