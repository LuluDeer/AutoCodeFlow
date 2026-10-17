import { useState } from 'react';
import { Table, Select, Input, Button, Space, Tag, Typography, Tooltip, Modal, DatePicker, Empty, theme, Card, Switch } from 'antd';
import type { TablePaginationConfig } from 'antd';
import { SearchOutlined, ReloadOutlined, EyeOutlined, DownloadOutlined, LeftOutlined, RightOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
// A-12: 审计 CSV 导出（GET /audit/export，携带当前筛选，axios blob 下载）
// AUDIT-KEYSET: 列表请求也挪进 api 层——游标三态（undefined / '' / 非空）由
// buildAuditListQuery 一处把关，页面不再手拼 URLSearchParams。
import { exportAuditCsv, listAuditLogs } from '../../api/audit';
import type { AuditLog } from '../../api/audit';
// TOAST-01：走 utils/toast 出口（App 实例优先，暗色主题下 toast 样式正确）
import { message } from '../../utils/toast';
// 时间展示统一走共享 formatDateTime（locale 跟随 i18n 而非浏览器，见 utils/timeFormat）
import { formatDateTime } from '../../utils/timeFormat';
import dayjs, { type Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';
import PageHeader from '../../components/PageHeader';
import PageSkeleton from '../../components/PageSkeleton';
// UI-16：toast-only 页补齐页内错误态标准块（错误块 + 重试，对齐 UI-08 形态）
import StateError from '../../components/StateError';
// MOBILE-CARD-01：≤768px 表格 → 卡片列表（结构级降级，CSS 做不到）
import { useIsMobile } from '../../hooks/useIsMobile';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../../i18n';

const { Option } = Select;

/**
 * AUDIT-KEYSET：审计日志页的服务端分页大小。
 *
 * 提到模块级常量是因为它现在有**两个**消费方（请求参数 + antd 页码器配置），
 * 且 keyset 分支下「页大小变了游标就作废」这条纪律需要一个稳定的名义值——
 * 两处各写一个字面量 20，改一处忘另一处就是静默的切片错位。
 */
const AUDIT_PAGE_SIZE = 20;

/**
 * §2.1 keyset 分页的前端状态：游标**栈** + 当前索引（照 ExecutionsPage 范式）。
 *
 * 为什么是栈而不是单个游标：游标分页没有「跳到第 N 页」——后端只给了
 * 「下一页」令牌（`nextCursor`），**没有**「上一页」令牌。要支持「上一页」，
 * 客户端必须自己记住走过的路径。
 *
 * 约定：`stack[0]` 恒为第 1 页的起点（关闭开关时 `null` = 不带 cursor 参数；
 * 打开时 `''` = keyset 起点），`stack[i]` 是「要显示第 i+1 页时需要发给后端的
 * cursor」。故：
 *   · 第 i 页（0-based）请求 `stack[i]`；`stack[0] === null` → 不带 cursor 参数；
 *   · `index === 0` 时「上一页」禁用；
 *   · 翻到某页拿到 `nextCursor === null` 时「下一页」禁用。
 *
 * 栈里存的是**不透明**令牌，前端一律原样回传，绝不解析、绝不拼接。
 */
type CursorStack = {
  stack: (string | null)[];
  index: number;
};

/**
 * 栈的初始形态（与 ExecutionsPage 逐字同款）。
 *
 * `firstPageCursor === undefined` → `stack = [null]`：第 1 页**不带** cursor 参数，
 * 后端走原 OFFSET 路径（关闭开关时的现有行为，逐字节不变）。
 * `firstPageCursor === ''` → `stack = ['']`：第 1 页带 `cursor=`（空串），
 * 后端走 keyset 分支的起点。
 *
 * 这两种形态必须在**状态层**就分开，而不是在渲染期用 `??` 归一——一旦糊成
 * 「空串也当没传」，keyset 起点就永远进不去。
 */
const initialCursorStack = (firstPageCursor: string | undefined): CursorStack => ({
  stack: [firstPageCursor ?? null],
  index: 0,
});

const RESULT_COLOR: Record<string, string> = { success: 'green', failure: 'red' };

const RESULT_LABELS = (t: (k: string) => string): Record<string, string> => ({
  success: t('audit.result.success'),
  failure: t('audit.result.failure'),
});

/**
 * AUDIT-01：action 代码 → 本地化标签。键与 admin-api 全量审计写入点对齐；
 * 未知值回退原始代码——宁可露出 `some_new_action` 也不把可检索的审计信息
 * 抹成"未知操作"。
 */
const ACTION_LABEL_KEYS: Record<string, string> = {
  'auth.login': 'audit.action.auth_login',
  'auth.logout': 'audit.action.auth_logout',
  'auth.session.revoke': 'audit.action.auth_session_revoke',
  'auth.session.revoke_others': 'audit.action.auth_session_revoke_others',
  'apikey.create': 'audit.action.apikey_create',
  'apikey.revoke': 'audit.action.apikey_revoke',
  'apikey.used': 'audit.action.apikey_used',
  'apikey.auth_failure': 'audit.action.apikey_auth_failure',
  'application.create': 'audit.action.application_create',
  'application.update': 'audit.action.application_update',
  'application.delete': 'audit.action.application_delete',
  'application.deploy': 'audit.action.application_deploy',
  'deployment.approve': 'audit.action.deployment_approve',
  'deployment.reject': 'audit.action.deployment_reject',
  'deployment.rollback': 'audit.action.deployment_rollback',
  'deployment.stop': 'audit.action.deployment_stop',
  'deployment.delete': 'audit.action.deployment_delete',
  'executor.rotate_token': 'audit.action.executor_rotate_token',
  'task.create': 'audit.action.task_create',
  'task.update': 'audit.action.task_update',
  'task.delete': 'audit.action.task_delete',
  'task.trigger': 'audit.action.task_trigger',
  'task.trigger_api': 'audit.action.task_trigger_api',
  'task.trigger_dependency': 'audit.action.task_trigger_dependency',
  'task.batch_trigger': 'audit.action.task_batch_trigger',
  'task.batch_pause': 'audit.action.task_batch_pause',
  'task.batch_resume': 'audit.action.task_batch_resume',
  'task.batch_delete': 'audit.action.task_batch_delete',
  'task.pause': 'audit.action.task_pause',
  'task.resume': 'audit.action.task_resume',
  'task.killExecution': 'audit.action.task_killExecution',
  'task.updateGlue': 'audit.action.task_updateGlue',
  'task.analyzeExecution': 'audit.action.task_analyzeExecution',
  'task.rollback': 'audit.action.task_rollback',
  'task.rollbackToVersion': 'audit.action.task_rollbackToVersion',
  'task_template.delete': 'audit.action.task_template_delete',
  'user.create': 'audit.action.user_create',
  'user.update': 'audit.action.user_update',
  'user.delete': 'audit.action.user_delete',
  'project.create': 'audit.action.project_create',
  'project.update': 'audit.action.project_update',
  'project.delete': 'audit.action.project_delete',
  'member.grant': 'audit.action.member_grant',
  'member.update': 'audit.action.member_update',
  'member.revoke': 'audit.action.member_revoke',
  'notification.channel.update': 'audit.action.notification_channel_update',
  'notification.silence.create': 'audit.action.notification_silence_create',
  'notification.silence.delete': 'audit.action.notification_silence_delete',
  'registry.pypi.upload': 'audit.action.registry_pypi_upload',
  'subscription.create': 'audit.action.subscription_create',
  'subscription.update': 'audit.action.subscription_update',
  'subscription.delete': 'audit.action.subscription_delete',
  'subscription.deadLetter.delete': 'audit.action.subscription_deadLetter_delete',
};

/** 可跳转的资源类型 → 前端详情路由（其余类型无独立详情页，返回 null） */
function resourceIdHref(resource: string | undefined, id: string): string | null {
  if (!resource || !id) return null;
  if (resource === 'task') return `/tasks/${id}`;
  if (resource === 'application') return `/applications/${id}`;
  if (resource === 'executor') return `/executors/${id}`;
  return null;
}

export default function AuditLogPage() {
  const { t } = useTranslation();
  // MOBILE-CARD-01：≤768px 表格 → 卡片列表
  const isMobile = useIsMobile();
  // F-15（DEEP_REVIEW 0ef3bbe）：详情 pre 背景走 antd token，暗色主题自适应。
  const { token } = theme.useToken();
  const resultLabels = RESULT_LABELS(t);
  const [page, setPage] = useState(1);
  // AUTH-05: 新增 resourceId 精确筛选（与 resource 组成组合筛选）
  const [filters, setFilters] = useState({ action: '', resource: '', resourceId: '', username: '', result: '' as '' | 'success' | 'failure', startTime: undefined as string | undefined, endTime: undefined as string | undefined });
  const [pending, setPending] = useState({ action: '', resource: '', resourceId: '', username: '', result: '' as '' | 'success' | 'failure', startTime: undefined as string | undefined, endTime: undefined as string | undefined });
  const [detailModal, setDetailModal] = useState<{ open: boolean; data?: Record<string, unknown> }>({ open: false });
  /**
   * §2.1「稳定翻页」开关——默认**关闭**（照 ExecutionsPage 范式）。
   *
   * 关闭 = 完全走既有的 OFFSET 分页：请求里**不带** `cursor` 参数，后端走原
   * 路径、响应逐字节不变（连 `nextCursor` 这个键都不出现），页面行为与本次
   * 改动之前完全一致。keyset 是加性能力，不是默认切换。
   *
   * 打开 = 走 keyset 分页：表格底部换自绘的「上一页 / 下一页」+ 游标栈，
   * **不再提供页码跳转**（游标分页没有"第 N 页"这个概念，见 `CursorStack`）。
   */
  const [stablePaging, setStablePaging] = useState(false);
  /**
   * 游标栈（仅 keyset 模式有意义）。
   *
   * `stack[0]` 在关闭开关时是 `null`（第 1 页**不带** cursor 参数）；开关打开时
   * 由 `toggleStablePaging` 重置成 `''`（空串 = keyset 起点）。两种形态在状态里
   * 就是不同的值，不在渲染期用 `??` 归一——那样 keyset 起点永远进不去。
   */
  const [cursorState, setCursorState] = useState<CursorStack>(() => initialCursorStack(undefined));

  /**
   * 重置游标栈（回到第 1 页）。
   *
   * **所有会改变结果集的入口都必须调用它**：带着旧筛选的游标继续翻，游标里的
   * (createdAt, id) 与新的过滤条件毫无关系，后端的游标条件与过滤器取交集后会
   * 返回"从某条不相干的行往后"的错乱结果——不报错、不空白，只是内容错了。
   *
   * `keysetStart` 决定重置到哪条路径的首页：
   *   · `false` → `stack = [null]`（第 1 页不带 cursor 参数，OFFSET 路径）；
   *   · `true`  → `stack = ['']`（第 1 页带 `cursor=`，keyset 起点）。
   */
  const resetCursorStack = (keysetStart: boolean) => {
    setCursorState(initialCursorStack(keysetStart ? '' : undefined));
  };

  /**
   * 当前请求应携带的游标——**三态在此分开**。
   *
   * `undefined` = 不带该参数（键整个不出现）→ 后端 OFFSET 分支；
   * `''`        = `?cursor=` → 后端 keyset 起点；
   * 非空串      = keyset 中途页。
   *
   * 关闭开关时恒为 `undefined`（外加把栈重置回 `[null]` 双保险）：默认路径的
   * 请求参数里**不可能**出现 cursor，这是"旧路径零风险"的代码保证。
   */
  const activeCursor = stablePaging ? cursorState.stack[cursorState.index] ?? '' : undefined;

  const { data, isLoading, error, refetch } = useQuery({
    // AUDIT-KEYSET：`activeCursor` 必须进 queryKey——游标不同 = 不同的结果页，
    // 排除在外会让第 1/2/3 页共用同一个缓存条目（翻回上一页拿到的是别的页的
    // 数据，且不会有任何报错）。`undefined`（OFFSET）与 `''`（keyset 起点）在
    // queryKey 序列化里也是不同的值，不会互相命中。
    queryKey: ['audit', page, filters, activeCursor],
    // NETOPT-C P3: 长挂载页面的 useQuery 也接 AbortSignal——翻页/离开页面后
    // in-flight 请求被取消，失败 toast 不再打在已离开的页面。
    queryFn: ({ signal }) =>
      listAuditLogs(
        { page, pageSize: AUDIT_PAGE_SIZE, ...filters, cursor: activeCursor },
        signal,
      ),
  });

  /**
   * keyset 模式下本页是否还有下一页。
   *
   * 严谨区分三种来源（**不能**用 `!!nextCursor` 一句糊过去）：
   *   · 关闭开关 → 根本不是 keyset 模式，`nextCursor` 键不存在（undefined），
   *     这里恒为 `null`（不渲染自绘分页器）；
   *   · keyset 且 `nextCursor === null` → 后端明确说「已到末页」→ 禁用下一页；
   *   · keyset 且拿到了字符串 → 还有下一页。
   *
   * 取 `undefined` 视为"无法判断"→ 保守地按"没有下一页"处理（禁用一个凭空
   * 猜测的"下一页"比让用户点进一个必然报 400 的请求安全）。
   */
  const nextCursor: string | null = stablePaging ? (data?.nextCursor ?? null) : null;
  const canNext = stablePaging && nextCursor !== null;

  /**
   * 下一页：把刚拿到的游标压栈并前进一格（无游标或到末页时不动）。
   *
   * 连点安全：第二次点击时 `data` 仍是上一页的（TanStack 在新请求返回前保留旧
   * 数据），`nextCursor` 因此还是同一个令牌——下面「同一游标不重复压栈」的判据
   * 会把第二下变成空操作，不会在栈里堆出重复条目、也不会跳过一页。
   */
  const goNext = () => {
    if (!canNext || nextCursor === null) return;
    setCursorState((s) => {
      const stack = s.stack.slice(0, s.index + 1);
      if (stack[stack.length - 1] === nextCursor) return s;
      stack.push(nextCursor);
      return { stack, index: stack.length - 1 };
    });
  };

  /** 上一页：在栈内回退一格（栈首禁用）。 */
  const goPrev = () => {
    setCursorState((s) => (s.index > 0 ? { ...s, index: s.index - 1 } : s));
  };

  /** 开关切换：两条路径的首页语义不同，必须重置栈，否则会带着上一模式的游标越界。 */
  const toggleStablePaging = (next: boolean) => {
    setStablePaging(next);
    resetCursorStack(next);
    // keyset 没有"第 N 页"的坐标系，切模式后页码回 1（关闭时也回 1，避免
    // 「页码 5 + 无游标」的自相矛盾组合）。
    setPage(1);
  };

  // 审计页的筛选是「草稿（pending）+ 点搜索才应用（filters）」两段式，故重置点
  // 落在**应用**的瞬间：handleSearch / handleReset（见下）。四处输入框的
  // onChange 只改草稿，不触发结果集变化，在那里重置游标是空操作、且会让
  // "翻了页但没点搜索"时意外丢栈。
  const handleSearch = () => {
    setPage(1);
    setFilters(pending);
    resetCursorStack(stablePaging);
  };
  const handleReset = () => {
    const e = { action: '', resource: '', resourceId: '', username: '', result: '' as '' | 'success' | 'failure', startTime: undefined as string | undefined, endTime: undefined as string | undefined };
    setPending(e); setFilters(e); setPage(1);
    // §2.1：清除筛选 = 全新的结果集，游标必须一起归零（否则会带着旧筛选的
    // 游标去翻新结果集，得到错乱内容）。按当前模式重置到对应首页。
    resetCursorStack(stablePaging);
  };

  // A-12: 导出 CSV（携带当前已应用的 filters；失败 toast 由 client 拦截器统一弹）
  const [exporting, setExporting] = useState(false);
  const handleExport = async () => {
    setExporting(true);
    try {
      await exportAuditCsv(filters);
      message.success(t('audit.export.ok'));
    } catch {
      /* client 拦截器已弹错误 toast */
    } finally {
      setExporting(false);
    }
  };

  const rangePresets = [
    { label: t('audit.range.1d'), value: [dayjs().subtract(1, 'day'), dayjs()] as [Dayjs, Dayjs] },
    { label: t('audit.range.7d'), value: [dayjs().subtract(7, 'day'), dayjs()] as [Dayjs, Dayjs] },
    { label: t('audit.range.30d'), value: [dayjs().subtract(30, 'day'), dayjs()] as [Dayjs, Dayjs] },
  ];

  // AUDIT-HASFILTERS（审计 P2，2026-10-17）：判据必须读**已应用**的 filters，
  // 不能读 pending（表单里还没点「查询」的草稿值）。
  //
  // 缺陷现场：hasFilters 读 pending，而列表查询与 CSV 导出都用 filters。于是
  // 用户在输入框里敲了个用户名但没点查询时，「重置」按钮就出现了（列表其实
  // 没筛选），点重置只是清空草稿；更糟的是此时点导出，导出的仍是**无筛选**
  // 的全量数据，而按钮存在本身在暗示「当前有筛选」。反过来，应用筛选后若
  // 再改草稿回空，按钮消失但列表仍是筛选态。
  const hasFilters = !!(
    filters.action ||
    filters.resource ||
    filters.resourceId ||
    filters.username ||
    filters.result ||
    filters.startTime ||
    filters.endTime
  );

  /**
   * 表格分页配置：keyset 模式 = `false`（页码器整体消失，改由下方自绘
   * 「上一页 / 下一页」承担），OFFSET 模式 = 原有配置（逐字节不变）。
   *
   * 为什么 keyset 下必须**删掉**而不是保留页码：游标分页没有"第 N 页"这个
   * 坐标系。保留页码会让用户点「第 5 页」时得到"还在第 1 页"（`total` 是真实
   * 总数，antd 会照着算出总页数并渲染出来），这是"页码还在但点第 5 页其实是
   * 第 2 页"式静默错乱。
   *
   * 本页 pageSize 恒为 `AUDIT_PAGE_SIZE`（无 size changer 入口），故不存在
   * "换页大小 + 旧游标"的切片错位；即便如此仍显式重置栈，避免将来加了
   * size changer 时漏掉这条纪律。
   */
  const tablePagination: false | TablePaginationConfig = stablePaging
    ? false
    : {
        current: page,
        pageSize: AUDIT_PAGE_SIZE,
        total: data?.total,
        onChange: (p, ps) => {
          setPage(p);
          if (ps !== undefined && ps !== AUDIT_PAGE_SIZE) resetCursorStack(stablePaging);
        },
        showTotal: (totalCount: number) => t('audit.total', { count: totalCount }),
      };

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 70 },
    {
      title: t('audit.col.operator'),
      dataIndex: 'username',
      width: 120,
      // AUDIT-02：调度器/API 等系统行为无登录用户——空白单元格改为显式
      // 「系统」Tag，此前看起来像数据缺失
      render: (v: string, r: AuditLog) => (
        <Space orientation="vertical" size={0}>
          {v ? <Typography.Text strong>{v}</Typography.Text> : <Tag>{t('audit.operator.system')}</Tag>}
          {r.ip && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.ip}</Typography.Text>}
        </Space>
      ),
    },
    {
      title: t('audit.col.action'),
      dataIndex: 'action',
      width: 180,
      ellipsis: true,
      // AUDIT-01：已知 action 显示本地化标签，未知值回退原始代码（等宽字体
      // 保留可检索性）
      render: (v: string) => {
        const labelKey = ACTION_LABEL_KEYS[v];
        return labelKey ? (
          <Typography.Text>{t(labelKey)}</Typography.Text>
        ) : (
          <Typography.Text code style={{ fontSize: 12 }}>{v}</Typography.Text>
        );
      },
    },
    { title: t('audit.col.resource'), dataIndex: 'resource', width: 120, ellipsis: true },
    {
      title: t('audit.col.resourceId'),
      dataIndex: 'resourceId',
      width: 100,
      // AUDIT-03：task/application/executor 资源直接链接到详情页，审计 → 溯源
      // 一步到位（其余类型无详情路由，维持纯文本）
      render: (v: string, r: AuditLog) => {
        if (!v) return '-';
        const href = resourceIdHref(r.resource, v);
        const content = (
          <Typography.Text style={{ fontFamily: 'monospace', fontSize: 12 }}>
            {v.length > 8 ? v.slice(0, 8) + '…' : v}
          </Typography.Text>
        );
        return (
          <Tooltip title={href ? `${v}（${t('audit.resourceId.open')}）` : v}>
            {href ? <Link to={href}>{content}</Link> : content}
          </Tooltip>
        );
      },
    },
    {
      title: t('audit.col.result'),
      dataIndex: 'result',
      width: 80,
      render: (v: string) => (
        <Tag color={RESULT_COLOR[v] ?? 'default'}>{resultLabels[v] ?? v}</Tag>
      ),
    },
    {
      title: t('audit.col.detail'),
      dataIndex: 'detail',
      width: 80,
      render: (v: Record<string, unknown>) => v && Object.keys(v).length > 0 ? (
        <Button
          type="link"
          size="small"
          icon={<EyeOutlined />}
          onClick={() => setDetailModal({ open: true, data: v })}
        >
          {t('audit.action.view')}
        </Button>
      ) : '-',
    },
    {
      title: t('audit.col.time'),
      dataIndex: 'createdAt',
      width: 180,
      render: (v: string) => formatDateTime(v),
    },
  ];

  return (
    <div>
      {/* UI-03/UI-08：页头标准化（原 Typography.Title 区块迁入 PageHeader） */}
      <PageHeader title={t('audit.title')} description={t('audit.description')} />
      <Space style={{ marginBottom: 16 }} wrap>
        <Input
          placeholder={t('audit.filter.keyword')}
          value={pending.action}
          onChange={(e) => setPending((p) => ({ ...p, action: e.target.value }))}
          onPressEnter={handleSearch}
          style={{ width: 160 }}
          allowClear
          prefix={<SearchOutlined />}
        />
        <Input
          placeholder={t('audit.filter.operator')}
          value={pending.username}
          onChange={(e) => setPending((p) => ({ ...p, username: e.target.value }))}
          onPressEnter={handleSearch}
          style={{ width: 140 }}
          allowClear
        />
        <Select
          placeholder={t('audit.filter.resourceType')}
          value={pending.resource || undefined}
          onChange={(v) => setPending((p) => ({ ...p, resource: v ?? '' }))}
          allowClear
          style={{ width: 140 }}
        >
          <Option value="task">task</Option>
          <Option value="executor">executor</Option>
          <Option value="config">config</Option>
          <Option value="user">user</Option>
          <Option value="application">application</Option>
        </Select>
        {/* AUTH-05: resourceId 精确筛选（与资源类型组合） */}
        <Input
          placeholder={t('audit.filter.resourceId')}
          value={pending.resourceId}
          onChange={(e) => setPending((p) => ({ ...p, resourceId: e.target.value }))}
          onPressEnter={handleSearch}
          style={{ width: 160 }}
          allowClear
        />
        {/* result 筛选（成功/失败），列表与 CSV 导出同滤 */}
        <Select
          placeholder={t('audit.filter.result')}
          value={pending.result || undefined}
          onChange={(v) => setPending((p) => ({ ...p, result: v ?? '' }))}
          allowClear
          style={{ width: 120 }}
        >
          <Option value="success">{resultLabels.success}</Option>
          <Option value="failure">{resultLabels.failure}</Option>
        </Select>
        <DatePicker.RangePicker
          presets={rangePresets}
          onChange={(dates) => {
            setPending((p) => ({
              ...p,
              startTime: dates?.[0]?.toISOString() ?? undefined,
              endTime: dates?.[1]?.toISOString() ?? undefined,
            }));
          }}
        />
        <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>{t('audit.action.search')}</Button>
        {hasFilters && <Button icon={<ReloadOutlined />} onClick={handleReset}>{t('audit.action.reset')}</Button>}
        {/* A-12: 导出 CSV（后端 GET /audit/export 同滤，ADMIN-only） */}
        <Button icon={<DownloadOutlined />} loading={exporting} onClick={handleExport}>{t('audit.action.export')}</Button>
        {/* §2.1：稳定翻页开关（默认关闭）。
            用 antd Switch——它本身就是 role="switch" + 原生 button 语义，
            Tab 可聚焦、Space/Enter 可切换，无需再补键盘处理；aria-label 给出
            可访问名（开关没有可见文字标签时，纯靠旁边的文字不构成可访问名）。
            关闭时不发任何 cursor 参数，后端与页面行为都回到改动前。 */}
        <Space size={6} style={{ marginLeft: 'auto' }}>
          <Switch
            size="small"
            checked={stablePaging}
            onChange={toggleStablePaging}
            aria-label={t('audit.stablePaging.aria')}
          />
          <Tooltip title={t('audit.stablePaging.hint')}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('audit.stablePaging')}</Typography.Text>
          </Tooltip>
        </Space>
      </Space>
      {/* UI-16：请求失败渲染页内错误态标准块（StateError，重试=refetch），
          此前失败静默表现为「暂无审计记录」空态——查询失败与确无记录两种语义分离 */}
      {error && (
        <StateError
          error={error}
          onRetry={() => refetch()}
          title={t('audit.error.title')}
          style={{ marginBottom: 16 }}
        />
      )}
      {isMobile ? (
        /* MOBILE-CARD-01：≤768px 卡片列表——8 列定宽表格在 375px 需横向滚动，
           操作码/UUID 列完全不可读。卡片按首查信息组织：操作+结果 / 操作人·IP /
           资源+资源ID / 时间 / 详情。分页沿用表格的服务端分页（page/pageSize）。 */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(data?.data ?? []).length === 0 ? (
            isLoading
              ? <PageSkeleton variant="table" rows={3} />
              : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('audit.empty')} />
          ) : (
            (data?.data ?? []).map((r: AuditLog) => {
              const labelKey = ACTION_LABEL_KEYS[r.action];
              const href = resourceIdHref(r.resource, r.resourceId ?? '');
              return (
                <Card key={r.id} size="small">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    {labelKey ? (
                      <Typography.Text strong style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t(labelKey)}</Typography.Text>
                    ) : (
                      <Typography.Text code style={{ fontSize: 12, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.action}</Typography.Text>
                    )}
                    <Tag color={RESULT_COLOR[r.result] ?? 'default'} style={{ marginInlineEnd: 0 }}>{resultLabels[r.result] ?? r.result}</Tag>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--chart-axis-text)' }}>
                    {r.username ? r.username : t('audit.operator.system')}
                    {r.ip ? ` · ${r.ip}` : ''}
                  </div>
                  <div style={{ marginTop: 4, fontSize: 12, color: 'var(--chart-axis-text)' }}>
                    {r.resource}
                    {r.resourceId ? (
                      <>
                        {' · '}
                        {href ? <Link to={href}>{r.resourceId.slice(0, 8)}…</Link> : r.resourceId.slice(0, 8) + '…'}
                      </>
                    ) : null}
                  </div>
                  <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {formatDateTime(r.createdAt)}
                    </Typography.Text>
                    {r.detail && Object.keys(r.detail).length > 0 && (
                      <Button
                        type="link"
                        size="small"
                        icon={<EyeOutlined />}
                        onClick={() => setDetailModal({ open: true, data: r.detail })}
                      >
                        {t('audit.action.view')}
                      </Button>
                    )}
                  </div>
                </Card>
              );
            })
          )}
        </div>
      ) : (
      <Table
        rowKey="id"
        // UI 打磨（原 loading={isLoading ? false : undefined}）：首屏骨架由
        // locale.emptyText 的 PageSkeleton 承担（UI-08 契约不变），Table loading
        // 改回真实 isLoading——翻页/筛选重查时可见加载反馈，不再静默显示旧数据。
        loading={isLoading}
        columns={columns}
        // UI 打磨：定宽列合计 930（70+120+180+120+100+80+80+180）→ scroll.x 同值，
        // 窄屏横向滚动兜底（审查建议 1040，按「列宽合计与 scroll.x 必须一致」取 930）
        scroll={{ x: 930 }}
        dataSource={data?.data ?? []}
        locale={{
          emptyText: isLoading
            ? <PageSkeleton variant="table" rows={3} />
            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('audit.empty')} />,
        }}
        // §2.1：两种分页形态**互斥**——这是本页最关键的一处语义切换。
        //
        // keyset 模式（开关打开）下 `pagination={false}`：游标分页没有"第 N 页"
        // 这个概念，页码器必须**整体消失**而不是留在原地。若只禁用它、或保留
        // 页码却把 current 硬钉在 1，用户点「第 5 页」会被告知"在第 1 页"，
        // 或更糟——页码变了但列表没变（静默错乱）。宁可没有页码，也不能给一个
        // 骗人的页码。翻页改由表格下方自绘的「上一页 / 下一页」承担。
        //
        // OFFSET 模式（开关关闭）保持原样，逐字节不变。
        pagination={tablePagination}
      />
      )}

      {/* §2.1：keyset 模式的自绘分页器。
          游标分页只有「下一页」令牌，没有「上一页」令牌——上一页靠游标栈回退，
          故这里**只有两个按钮，没有页码、没有页码跳转**（见上方 pagination 注释）。
          表格与移动端卡片共用同一个分页器：两者是同一份数据的两种渲染。 */}
      {stablePaging ? (
        <div
          style={{
            marginTop: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 12,
          }}
        >
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('audit.total', { count: data?.total ?? 0 })}
          </Typography.Text>
          <Button
            size="small"
            icon={<LeftOutlined />}
            // 栈首禁用：没有上一页可回（此时再点只会重复请求同一游标）
            disabled={cursorState.index === 0}
            onClick={goPrev}
          >
            {t('audit.pager.prev')}
          </Button>
          <Button
            size="small"
            // 后端说没有下一页（nextCursor === null，含"游标行被删"的提前结束）
            disabled={!canNext}
            onClick={goNext}
          >
            {t('audit.pager.next')}
            <RightOutlined />
          </Button>
        </div>
      ) : null}

      <Modal
        title={t('audit.modal.detail')}
        open={detailModal.open}
        onCancel={() => setDetailModal({ open: false })}
        footer={null}
        width={600}
        destroyOnHidden
      >
        {/* UI 打磨：长 detail JSON 限高内滚，避免弹窗被撑出视口 */}
        <pre style={{ background: token.colorFillQuaternary, padding: 16, borderRadius: 4, fontSize: 13, overflowX: 'auto', maxHeight: 480, overflowY: 'auto' }}>
          {detailModal.data ? JSON.stringify(detailModal.data, null, 2) : ''}
        </pre>
      </Modal>
    </div>
  );
}
