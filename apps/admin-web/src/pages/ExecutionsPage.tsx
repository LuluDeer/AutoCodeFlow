import { useState, useEffect } from 'react';
import { Table,
  Typography,
  Badge,
  Button,
  Input,
  Select,
  Space,
  Empty,
  Tooltip,
  Popconfirm,
  DatePicker,
  Card,
  Switch } from 'antd';
import type { TablePaginationConfig } from 'antd';
import { message } from '../utils/toast';
import {
  SearchOutlined, FilterOutlined, ReloadOutlined, EyeOutlined, StopOutlined,
  SwapOutlined, DownloadOutlined, LeftOutlined, RightOutlined,
} from '@ant-design/icons';
import type { Dayjs } from 'dayjs';

import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { tasksApi } from '../api/tasks';
import type { TaskExecution } from '../api/tasks';
import { useExecutionsList, invalidateExecutionData } from '../api/queries';
import { useExecutionsStream } from '../hooks/useExecutionsStream';
import { showApiError } from '../utils/error';
import { useDebounce } from '../hooks/useDebounce';
// URL-SYNC-02（审计 P2）：双向 URL 同步（外部深链/前进后退真正生效）
import { useUrlStateSync } from '../hooks/useUrlStateSync';
import { formatDateTime, formatDuration, formatRelativeTime } from '../utils/timeFormat';
// ADR-017 阶段 3（决策 §7 读面富化）：执行器可读名解析（id 优先、地址回落）。
// 阶段 3 起 pull 允许同址多行并存，仅显示 IP:端口 无法回答「哪台机器」。
import { useExecutorNames } from '../hooks/useExecutorNames';
import { ExecutionCompareModal, COMPARE_MAX } from '../components/ExecutionCompare';
import PageHeader from '../components/PageHeader';
// UI-08：首屏数据未达时以 Skeleton 替代表格 Spin（ApplicationListPage 同款）
import PageSkeleton from '../components/PageSkeleton';
import StateError from '../components/StateError';
// MOBILE-CARD-01：≤768px 时表格 → 卡片列表（结构级降级，CSS 做不到）
import { useIsMobile } from '../hooks/useIsMobile';
// P1-17（UX 审计）：触发方式列此前直接输出后端裸 token（cron/manual/fixed_rate），
// 与同列相邻的中文状态 Badge 中英混排。收敛到 utils/trigger-label 唯一事实源，
// 与 TaskListPage/TaskDetailPage/ApplicationDetailPage 同一份映射。
import { triggerLabel } from '../utils/trigger-label';
// R5 角色门控：ADMIN-only 操作统一以此判断（本轮：全量导出端点 @Roles(ADMIN)）。
import { useAuthStore, isAdminUser } from '../store/auth';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../i18n';

const { Text } = Typography;
const { RangePicker } = DatePicker;

/** UI-08：首屏 Skeleton 渲染判据——初次加载（无数据）且未出错时以骨架屏替代表格 Spin */
function shouldShowSkeleton(loading: boolean, error: unknown, count: number): boolean {
  return loading && count === 0 && !error;
}

type BadgeStatus = 'success' | 'processing' | 'error' | 'default' | 'warning';
const STATUS_MAP = (t: (k: string) => string): Record<string, { badge: BadgeStatus; label: string }> => ({
  pending:   { badge: 'default',    label: t('execs.status.pending') },
  running:   { badge: 'processing', label: t('execs.status.running') },
  waiting:   { badge: 'warning',    label: t('execs.status.waiting') },
  success:   { badge: 'success',    label: t('execs.status.success') },
  failed:    { badge: 'error',      label: t('execs.status.failed') },
  timeout:   { badge: 'warning',    label: t('execs.status.timeout') },
  killed:    { badge: 'error',      label: t('execs.status.killed') },
  cancelled: { badge: 'default',    label: t('execs.status.cancelled') },
});

/** CSV 单元格转义：逗号/引号/换行任一出现即整体加引号，内部引号翻倍（RFC 4180）。 */
function csvCell(value: string | number | null | undefined): string {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * §2.1 keyset 分页的前端状态：游标**栈** + 当前索引。
 *
 * 为什么是栈而不是单个游标：游标分页没有「跳到第 N 页」——后端只给了
 * 「下一页」令牌（`nextCursor`），**没有**「上一页」令牌。要支持「上一页」，
 * 客户端必须自己记住走过的路径。
 *
 * 约定：`items[0] === null` 恒为第 1 页的起点（不带任何游标的位置），
 * `items[i]` 是「要显示第 i+1 页时需要发给后端的 cursor」。故：
 *   · 第 i 页（0-based）请求 `items[i]`；`items[0] === null` → 不带 cursor 参数；
 *   · `index === 0` 时「上一页」禁用；
 *   · 翻到第 i 页拿到新的 `nextCursor === null` 时「下一页」禁用。
 *
 * 栈里存的是**不透明**令牌，前端一律原样回传，绝不解析、绝不拼接。
 */
type CursorStack = {
  /** stack[0] 恒为 null（= 不带 cursor 参数）；stack[i] 为第 i+1 页的游标。 */
  stack: (string | null)[];
  /** 当前页在栈中的下标（0-based）。 */
  index: number;
};

/**
 * 栈的初始形态。
 *
 * `firstPageCursor === undefined` → `stack = [null]`：第 1 页**不带** cursor 参数，
 * 后端走原 OFFSET 路径（关闭开关时的现有行为，逐字节不变）。
 * `firstPageCursor === ''` → `stack = ['']`：第 1 页带 `cursor=`（空串），
 * 后端走 keyset 分支的起点。
 *
 * 这两种形态必须在**状态层**就分开，而不是在渲染期用 `??` 归一——一旦糊成
 * 「空串也当没传」，keyset 起点就永远进不去（axios 会把 undefined 的键整个丢掉，
 * 把空串序列化成 `cursor=`，两者在网络层是可区分的，别在本地先毁掉这个区分）。
 */
const initialCursorStack = (
  firstPageCursor: string | undefined,
): CursorStack => ({ stack: [firstPageCursor ?? null], index: 0 });

/**
 * 审计 P2：执行记录 CSV 导出（纯客户端）。仅导出当前筛选结果的**当前页**——
 * 与服务端分页语义一致。
 *
 * ⚠️ 本函数**保持「当前页」语义不变**：全量导出走的是服务端流式端点
 * `GET /tasks/executions/export`（见下方 `handleExportAll`），是**并列的第二个
 * 按钮**，不是本函数的替代。把这里悄悄改成"导另一个东西"会让既有用户
 * （和本文件的回归用例）拿到与按钮文案不符的结果，故两个入口各自独立。
 *
 * 列取值与上方 Table columns 同源（同 dataIndex、同格式化函数 statusMap/
 * triggerLabel/formatDateTime/formatDuration），避免两处口径漂移；时间列导出
 * 可读的完整时刻（formatDateTime）而非表格里的相对时间。首行 BOM 保证 Excel
 * 以 UTF-8 解码中文不乱码。
 */
function buildExecutionsCsv(
  rows: TaskExecution[],
  t: (k: string) => string,
  /**
   * ADR-017 阶段 3（决策 §7）：执行器可读名解析（与表格列同源）。
   * 导出列与 Table 列**口径一致**是本文件既有纪律（见上方注释）；表格列已改成
   * 「名字 + 地址」，导出若只留地址就会与屏幕内容不符。
   *
   * 缺省（未传）时导出退回纯地址——保持该函数对旧调用方/测试的兼容。
   */
  nameOf?: (row: { executorId?: string | null; executorAddress?: string | null }) => string | null,
): string {
  const statusMap = STATUS_MAP(t);
  const header = [
    t('execs.col.task'),
    t('execs.col.status'),
    t('execs.col.trigger'),
    t('execs.col.executor'),
    t('execs.col.startTime'),
    t('execs.col.duration'),
    t('execs.col.error'),
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([
      r.taskName || r.taskId,
      statusMap[r.status]?.label ?? r.status,
      triggerLabel(r.triggerType, t),
      // 名字与地址**都**导出（名字供人读、地址供精确定位）——与表格的
      // 「主名 + 副地址」一致；解析不到则只写地址（绝不编造名字）。
      [nameOf?.(r) ?? null, r.executorAddress ?? null].filter(Boolean).join(' ') || '',
      r.startTime ? formatDateTime(r.startTime) : '',
      r.duration != null ? formatDuration(r.duration, t) : '',
      r.errorMessage ?? '',
    ].map(csvCell).join(','));
  }
  return `\ufeff${lines.join('\r\n')}`;
}

export default function ExecutionsPage() {
  const nav = useNavigate();
  const { t } = useTranslation();
  // MOBILE-CARD-01：≤768px 表格 → 卡片列表
  const isMobile = useIsMobile();
  // ARCH-26: 写后失效句柄（kill 后 invalidate 执行列表+Dashboard 汇总缓存）
  const queryClient = useQueryClient();
  // URL-SYNC-01：筛选/分页状态以 URL 查询参数为初始源并回写——修复两处体验缺口：
  // ① Dashboard「失败 Top 任务 → 全部失败」链到 /executions?status=failed，
  //    此前页面从不读 URL 参数，深链被静默丢弃；
  // ② 刷新/分享页面后筛选与页码全部丢失。
  // 时间范围不在 URL（Dayjs 序列化噪音大、深链价值低），仍仅存会话内。
  const [searchParams] = useSearchParams();
  const [page, setPage] = useState(() => {
    const p = Number(searchParams.get('page'));
    return Number.isInteger(p) && p > 0 ? p : 1;
  });
  const [pageSize, setPageSize] = useState(() => {
    const ps = Number(searchParams.get('pageSize'));
    return Number.isInteger(ps) && ps > 0 ? ps : 20;
  });
  const [statusFilter, setStatusFilter] = useState<string | undefined>(() => searchParams.get('status') || undefined);
  const [search, setSearch] = useState(() => searchParams.get('q') || '');
  const [executorFilter, setExecutorFilter] = useState(() => searchParams.get('executor') || '');
  const [timeRange, setTimeRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [killingId, setKillingId] = useState<string | null>(null);
  /** 全量导出的在途标记（流式下载可能几十秒，必须给反馈并防重复触发）。 */
  const [exportingAll, setExportingAll] = useState(false);
  // P1-5 同款口径：`GET /tasks/executions/export` 是 @Roles(ADMIN)——普通用户
  // 点了必然吃 403。故**禁用 + 提示**，不发起注定被拒的请求。
  // role 缺失（profile 尚未拉取）按非 ADMIN 处理（isAdminUser 的既有语义）。
  const isAdmin = isAdminUser(useAuthStore((s) => s.user));
  // FEAT-03: 多选对比——选中本页行后一键打开指标对比 modal
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  /**
   * §2.1「稳定翻页」开关——默认**关闭**。
   *
   * 关闭 = 完全走既有的 OFFSET 分页：请求里**不带** `cursor` 参数，后端走原
   * 路径、响应逐字节不变（连 `nextCursor` 这个键都不出现），页面行为与本轮改动
   * 之前完全一致。这是刻意保留的零风险默认值：keyset 是加性能力，不是默认切换。
   *
   * 打开 = 走 keyset 分页：列表底部换自绘的「上一页 / 下一页」+ 游标栈，
   * **不再提供页码跳转**（游标分页没有"第 N 页"这个概念，见 `CursorStack`）。
   */
  const [stablePaging, setStablePaging] = useState(false);
  /**
   * 游标栈（仅 keyset 模式有意义）。
   *
   * `stack[0]` 在关闭开关时是 `null`（第 1 页**不带** cursor 参数）；开关打开时
   * 由 `toggleStablePaging` 重置成 `''`（空串 = keyset 起点）。两种形态在状态里
   * 就是不同的值，不在渲染期用 `??` 糊成同一个——那样 keyset 起点永远进不去。
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
   * 当前请求应携带的游标。
   *
   * `undefined` = 不带该参数（axios 把键整个丢掉）→ 后端 OFFSET 分支；
   * `''`        = `?cursor=` → 后端 keyset 起点；
   * 非空串      = keyset 中途页。
   *
   * 关闭开关时恒为 `undefined`（外加把栈重置回 `[null]` 双保险）：默认路径的
   * 请求参数里**不可能**出现 cursor。
   */
  const activeCursor = stablePaging ? cursorState.stack[cursorState.index] ?? '' : undefined;

  /** 开关切换：两条路径的首页语义不同，必须重置栈，否则会带着上一模式的游标越界。 */
  const toggleStablePaging = (next: boolean) => {
    setStablePaging(next);
    resetCursorStack(next);
    // keyset 没有"第 N 页"的坐标系，切模式后页码回 1（关闭时也回 1，避免
    // 「页码 5 + 无游标」的自相矛盾组合）。
    setPage(1);
  };

  // 翻页/筛选变化后当前页数据会变，跨页选中行不再可见——清空选中防误比
  useEffect(() => {
    setSelectedIds([]);
  }, [page, pageSize, statusFilter, search, executorFilter, timeRange, cursorState]);

  const handleKill = async (r: TaskExecution) => {
    setKillingId(r.id);
    try {
      await tasksApi.killExecution(r.taskId, r.id);
      message.success(t('execs.kill.success'));
      // ARCH-26: 写后失效——执行列表 + Dashboard 汇总面（queryKey 前缀化，
      // 一处 invalidate 同时刷新两个示范页的缓存）。
      await invalidateExecutionData(queryClient);
      // §2.1：kill 会改行内容但**不改行位置**——理论上原地重取是对的。但
      // keyset 下"原地重取"依赖当前页游标仍指向一个存在的行：被 kill 的那行若
      // 恰好是游标行（本页最后一行）或被并发删除，后端会返回空页 + nextCursor
      // null（安全提前结束），用户会看到"当前页突然空了"。故 keyset 模式下
      // 一律回到栈首（第 1 页）重取——语义明确、不需要赌游标行还活着。
      // OFFSET 模式不受影响：保持原地重取（现有行为，不改）。
      if (stablePaging) resetCursorStack(true);
    } catch (err: unknown) {
      showApiError(err, t('execs.kill.fail'));
    } finally {
      setKillingId(null);
    }
  };

  // 搜索防抖：避免每击键发一次列表请求
  const debouncedSearch = useDebounce(search);

  // URL-SYNC-02（审计 P2）：双向同步——外部深链（通知铃铛「查看失败」、
  // Dashboard「全部失败」、浏览器前进后退）现在会真正改变列表。
  // 此前只有「初始值读 URL + 单向回写」：组件已挂载时改 URL 会被回写抹掉，
  // 地址栏闪过 ?status=failed 随即消失，列表仍是全量——深链形同失效。
  //
  // §2.1 补充：**外部导航改筛选时也必须重置游标栈**。深链（如
  // `/executions?status=failed`）会让 page 与若干筛选项一起变，但游标不在 URL
  // 里——若只改筛选而不清栈，keyset 模式下载第 3 页的游标会带着新的 status
  // 继续请求，结果是"从旧筛选某个不相干位置往后"的错乱数据。故这里给 URL→state
  // 的 setter 包一层：任何筛选/页码的外部写入都顺带把栈重置回起点。
  useUrlStateSync(
    {
      page,
      pageSize,
      status: statusFilter,
      q: debouncedSearch,
      executor: executorFilter,
    },
    { page: 1, pageSize: 20, status: undefined, q: '', executor: '' },
    {
      page: (v) => { setPage(v); resetCursorStack(stablePaging); },
      pageSize: (v) => { setPageSize(v); resetCursorStack(stablePaging); },
      status: (v) => { setStatusFilter(v); resetCursorStack(stablePaging); },
      q: (v) => { setSearch(v); resetCursorStack(stablePaging); },
      executor: (v) => { setExecutorFilter(v); resetCursorStack(stablePaging); },
    },
  );

  // ARCH-26: TanStack Query 改造——useRequest 轮询（15s）换 query hooks：
  // 筛选参数进 queryKey（参数变化自动重取，等价 refreshDeps）；
  // staleTime 全局 30s 兜底切页缓存。15s 轮询由下方 refetchInterval useEffect
  // 承担（可见性判定与原 pollingWhenHidden:false 一致）。
  const { data, isLoading: loading, error, refetch } = useExecutionsList({
    page,
    pageSize,
    status: statusFilter,
    taskName: debouncedSearch || undefined,
    executorAddress: executorFilter || undefined,
    startTime: timeRange?.[0]?.toISOString(),
    endTime: timeRange?.[1]?.toISOString(),
    // keyset 三态的**唯一**出口，落在下面这个三元里：
    //   · 关闭开关 → 整个 `cursor` 键都不出现（`{}`），请求与改动前完全一致；
    //   · 打开开关 → 空串（`?cursor=`，keyset 起点）或上一页返回的不透明游标。
    //
    // 为什么不是恒传 `{ cursor: activeCursor }` 让 axios 丢弃 undefined：键要
    // 不要在**我们**这一层就必须确定——"旧路径逐字节不变"是硬要求，把它押在
    // axios 的序列化细节上等于把风险外包给库版本。
    ...(activeCursor === undefined ? {} : { cursor: activeCursor }),
  });

  // FEAT-16: 执行终态推送流——SSE live 时终态事件即时 invalidate 列表+汇总
  // 缓存（<3s 刷新验收），断线时下方 15s 轮询兜底自动成为唯一新鲜度来源
  // （对齐 DashboardPage：SSE 推送与轮询互斥共存，staleTime 内 refetch 去重）。
  useExecutionsStream();

  // 15s 轮询兜底：运行中行需要及时看到终态（SSE 断线时的降级路径）。
  // 标签页不可见时跳过请求（定时器保留，回到前台后下一拍即恢复——
  // 等价 pollingWhenHidden:false）。
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refetch();
    }, 15_000);
    return () => clearInterval(timer);
  }, [refetch]);

  const executions: TaskExecution[] = data?.items ?? [];
  const total: number = data?.total ?? 0;

  // ADR-017 阶段 3（决策 §7 读面富化）：执行器可读名解析。
  //
  // 本页此前只渲染 `executorAddress`（如 192.168.4.54:8003）——用户给执行器起的
  // 名字在这些行里完全缺席，「这条执行跑在哪台机器」要靠背 IP 才能答上来；而
  // 阶段 3 起 pull 允许同址多行并存（ADR-017 §5），地址甚至**不再唯一**。
  // 解析口径复用 `useExecutorNames`（id 优先、地址回落、匹配不到返回 null 并
  // 如实显示地址，绝不编造名字）——与 AppDeploymentPage/ApplicationDetailPage
  // 同一实现，不新增第二套机制。
  //
  // 自拉一次清单（本页此前不加载执行器列表）；失败静默降级为只显示地址。
  const { nameOf } = useExecutorNames();

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

  const hasFilters = !!(search || statusFilter || executorFilter || timeRange);

  /**
   * 表格分页配置：keyset 模式 = `false`（页码器整体消失，改由下方自绘
   * 「上一页 / 下一页」承担），OFFSET 模式 = 原有配置（逐字节不变）。
   *
   * 为什么 keyset 下必须**删掉**而不是保留页码：游标分页没有"第 N 页"这个
   * 坐标系。保留页码会让用户点「第 5 页」时得到"还在第 1 页"（`total` 是真实
   * 总数，antd 会照着算出总页数并渲染出来），这是"页码还在但点第 5 页其实是
   * 第 2 页"式静默错乱。
   */
  const tablePagination: false | TablePaginationConfig = stablePaging
    ? false
    : {
        total,
        current: page,
        pageSize,
        // §2.1：pageSize 变更同样要重置游标栈——每页条数变了，旧的
        // (createdAt,id) 游标与新的切片边界不再对应。
        onChange: (p, ps) => {
          setPage(p);
          setPageSize(ps ?? 20);
          resetCursorStack(stablePaging);
        },
        showTotal: (t2) => t('execs.count', { count: t2 }),
        showSizeChanger: true,
      };

  const clearFilters = () => {
    setSearch('');
    setStatusFilter(undefined);
    setExecutorFilter('');
    setTimeRange(null);
    setPage(1);
    // §2.1：清除筛选 = 全新的结果集，游标必须一起归零（否则会带着旧筛选的
    // 游标去翻新结果集，得到错乱内容）。按当前模式重置到对应首页。
    resetCursorStack(stablePaging);
  };

  // 审计 P2：导出当前页 CSV——Blob + 临时 <a download> 触发下载。审计页 A-12
  // 走后端导出端点，本页数据已在客户端，无需再过网络；文件名带页码与日期便于归档。
  const handleExportCsv = () => {
    const blob = new Blob([buildExecutionsCsv(executions, t, nameOf)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `executions-page${page}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    message.success(t('execs.exportCsvSuccess', { count: executions.length }));
  };

  /**
   * 全量导出（服务端流式 CSV）。与上面「导出当前页」**并列的两个入口**：
   * 本按钮带的是**当前筛选**（不含分页），导出的是整个结果集。
   *
   * ## 筛选参数映射（逐字段对齐后端 ExportExecutionsQueryDto，不猜）
   *
   * | 页面 state        | 请求参数          | 后端语义                    |
   * |-------------------|-------------------|-----------------------------|
   * | `statusFilter`    | `status`          | 等值                        |
   * | `debouncedSearch` | `taskName`        | **模糊**匹配任务名          |
   * | `executorFilter`  | `executorAddress` | **模糊**匹配执行器地址      |
   * | `timeRange[0/1]`  | `startTime`/`endTime` | **createdAt** 范围（ISO 8601） |
   *
   * 三处易错点，都在这里钉死：
   * 1. **搜索框 → `taskName`**，不是 `search`/`q`/`name`——后端 DTO 只有
   *    `taskName`，写错会被 `forbidNonWhitelisted` 判 400。
   * 2. **执行器筛选 → `executorAddress`**，不是 `executorId`（页面上的输入框
   *    是地址子串，后端对该列做模糊匹配）。
   * 3. `startTime`/`endTime` 过滤的是**创建时间**，不是执行的 `startTime` 列
   *    （后端 DTO 明写，与列表端点同源）。故这里与列表请求用**同一个**
   *    `timeRange?.[0]?.toISOString()`，两个入口的口径不会漂移。
   *
   * ## 不分页
   *
   * **不传** `page`/`pageSize`：后端 DTO 没有这两个字段（传了会 400，这是刻意
   * 的——静默忽略分页参数正是 API-07 记录的那类缺陷）。`exportExecutions`
   * 内部也只按白名单装配参数，此处不可能泄漏进去。
   *
   * ## 非 ADMIN
   *
   * 按钮已 `disabled`，但 handler 里再挡一次：禁用态在某些无障碍工具/程序化
   * 调用下仍可能被触发，而这一发必然是 403——不如给一句准确的话。
   */
  const handleExportAll = async () => {
    if (exportingAll) return;
    if (!isAdmin) {
      message.warning(t('execs.exportAll.adminOnly'));
      return;
    }
    setExportingAll(true);
    const hide = message.loading(t('execs.exportAll.running'), 0);
    try {
      await tasksApi.exportExecutions({
        status: statusFilter || undefined,
        taskName: debouncedSearch || undefined,
        executorAddress: executorFilter || undefined,
        startTime: timeRange?.[0]?.toISOString(),
        endTime: timeRange?.[1]?.toISOString(),
      });
      message.success(t('execs.exportAll.success'));
    } catch (err: unknown) {
      // 拦截器已对 4xx/5xx 弹过 toast（打标去重），这里兜底网络/中断类失败。
      showApiError(err, t('execs.exportAll.fail'));
    } finally {
      hide();
      setExportingAll(false);
    }
  };

  // UI-09：375px 可用性——关键列=任务/状态/开始时间/错误/操作（值班首查项），
  // 触发方式/执行器/耗时为次要列窄屏收起（CSS 侧 .ui09-hide-mobile 双保险）；
  // scroll.x 兜底横向滚动。onHeaderCell/onCell 挂类供媒体查询隐藏次要列。
  const hideOnMobile = {
    onHeaderCell: () => ({ className: 'ui09-hide-mobile' }),
    onCell: () => ({ className: 'ui09-hide-mobile' }),
  } as const;
  const statusMap = STATUS_MAP(t);
  const columns = [
    {
      title: t('execs.col.task'),
      dataIndex: 'taskName',
      render: (name: string, r: TaskExecution) => (
        // F-33（DEEP_REVIEW 0ef3bbe）：原 <a onClick> 无 href，改 <Link>（键盘可达 + 真实 href）
        // UI 打磨：长任务名单行 ellipsis，不再整列换行撑高行
        <Link
          to={`/tasks/${r.taskId}`}
          title={name || r.taskId}
          style={{ fontWeight: 500, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {name || r.taskId}
        </Link>
      ),
    },
    {
      title: t('execs.col.status'),
      dataIndex: 'status',
      width: 90,
      render: (s: string) => {
        const cfg = statusMap[s] || { badge: 'default' as BadgeStatus, label: s };
        return <Badge status={cfg.badge} text={cfg.label} />;
      },
    },
    {
      title: t('execs.col.trigger'),
      dataIndex: 'triggerType',
      width: 90,
      ...hideOnMobile,
      // P1-17：走唯一事实源 triggerLabel（已知值本地化、未知值回退原 token），
      // 不再直接渲染 {v || '-'} 裸枚举。
      render: (v: string) => {
        const label = triggerLabel(v, t);
        return <Text type="secondary" style={{ fontSize: 12 }}>{label || '-'}</Text>;
      },
    },
    {
      title: t('execs.col.executor'),
      dataIndex: 'executorAddress',
      width: 160,
      ellipsis: true,
      ...hideOnMobile,
      // ADR-017 阶段 3（决策 §7）：主显可读名（员工给机器起的名字），地址降为
      // tooltip 副信息——地址仍是**诊断身份**（「到底哪台」），故不删除。
      // 解析不到名字时如实只显示地址（绝不编造），都没有则 '-'。
      render: (v: string, r: TaskExecution) => {
        const name = nameOf(r);
        const fallback = v || null;
        if (!name && !fallback) {
          return <Text type="secondary" style={{ fontSize: 12 }}>-</Text>;
        }
        return (
          <Tooltip title={fallback ?? name ?? ''}>
            <Text style={{ fontSize: 12 }}>{name ?? fallback}</Text>
          </Tooltip>
        );
      },
    },
    {
      title: t('execs.col.startTime'),
      dataIndex: 'startTime',
      width: 130,
      render: (v: string) => v ? (
        <Tooltip title={formatDateTime(v)}>
          <Text style={{ fontSize: 12 }}>{formatRelativeTime(v, t)}</Text>
        </Tooltip>
      ) : '-',
    },
    {
      title: t('execs.col.duration'),
      dataIndex: 'duration',
      width: 90,
      ...hideOnMobile,
      // UI-08：时长如「32分46秒」窄列会折成两行，nowrap 保证单行可扫读
      render: (v: number) => v != null ? <Text style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{formatDuration(v, t)}</Text> : '-',
    },
    {
      title: t('execs.col.error'),
      dataIndex: 'errorMessage',
      ellipsis: true,
      render: (v: string) => v ? <Text type="danger" style={{ fontSize: 12 }}>{v}</Text> : '-',
    },
    {
      title: t('execs.col.action'),
      key: 'action',
      // UI 打磨：详情 + 终止两个带文字链接实测 ~125px，100 宽在 running 行折行；
      // fixed right 让操作列在横向滚动时常驻
      width: 135,
      fixed: 'right' as const,
      render: (_: unknown, r: TaskExecution) => (
        <Space size={4}>
          <Button
            type="link" size="small" icon={<EyeOutlined />}
            onClick={() => nav(`/tasks/${r.taskId}/executions/${r.id}`)}
          >
            {t('execs.action.detail')}
          </Button>
          {(r.status === 'running' || r.status === 'waiting') && (
            // KILL-WAITING：互斥排队中的执行也走既有 killExecution——后端
            // OPEN_EXECUTION_STATUSES 已把 WAITING 列为打开态（MUTEX-01），
            // 前端此前只对 running 出按钮，排队中的执行只能等占用释放。
            <Popconfirm
              title={t('execs.killConfirm')}
              description={
                r.status === 'waiting' ? t('execs.killConfirmWaitingDesc') : undefined
              }
              onConfirm={() => handleKill(r)}
              okText={t('execs.action.kill')} okButtonProps={{ danger: true }}
            >
              <Button
                type="link" size="small" danger
                icon={<StopOutlined />}
                loading={killingId === r.id}
              >
                {t('execs.action.kill')}
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      {/* UI-03：页头标准化（原 Typography.Title 区块迁入 PageHeader，刷新进 extra） */}
      <PageHeader
        title={t('execs.title')}
        description={t('execs.description')}
        extra={
          <>
            {/* 审计 P2：导出当前筛选结果的当前页为 CSV（空页禁用，无可导内容）。
                ⚠️ 语义**保持不变**：仍只导这一页。全量导出是右边那个独立按钮。 */}
            <Button
              icon={<DownloadOutlined />}
              disabled={executions.length === 0}
              onClick={handleExportCsv}
            >
              {t('execs.exportCsv')}
            </Button>
            {/* 全量导出（GET /tasks/executions/export，@Roles(ADMIN)）。
                与「导出当前页」并列而非替换——两个按钮文案本身就写明了区别
                （一个带「当前页」语义在成功提示里，一个写「导出全部」）。
                非 ADMIN 禁用并在 Tooltip 里说明原因：点一个必然 403 的按钮
                只会让人以为系统坏了。 */}
            <Tooltip
              title={isAdmin ? t('execs.exportAll.hint') : t('execs.exportAll.adminOnly')}
            >
              {/* 禁用按钮不触发鼠标事件 → 包一层 span 让 Tooltip 仍能提示 */}
              <span>
                <Button
                  icon={<DownloadOutlined />}
                  loading={exportingAll}
                  disabled={!isAdmin || exportingAll}
                  onClick={() => void handleExportAll()}
                >
                  {t('execs.exportAll')}
                </Button>
              </span>
            </Tooltip>
            <Button icon={<ReloadOutlined />} onClick={() => void refetch()}>{t('execs.refresh')}</Button>
          </>
        }
      />

      {/* UI-09：筛选区 wrap 堆叠（Space wrap 已有），输入/选择窄屏自适应宽度 */}
      <Space style={{ marginBottom: 16 }} wrap className="ui09-filter-bar">
        {selectedIds.length > 0 && (
          <Button
            icon={<SwapOutlined />}
            type="primary"
            disabled={selectedIds.length < 2}
            onClick={() => {
              if (selectedIds.length > COMPARE_MAX) {
                message.warning(t('execs.compare.limit', { max: COMPARE_MAX }));
                return;
              }
              setCompareOpen(true);
            }}
          >
            {t('execs.compare', { count: selectedIds.length })}
          </Button>
        )}
        <Input
          placeholder={t('execs.searchPlaceholder')}
          prefix={<SearchOutlined />}
          value={search}
          // §2.1：筛选变化必须同时重置游标栈（原因见 resetCursorStack 注释）。
          onChange={e => { setSearch(e.target.value); setPage(1); resetCursorStack(stablePaging); }}
          allowClear
          style={{ width: 200, maxWidth: '100%' }}
        />
        <Select
          placeholder={t('execs.statusAll')}
          allowClear
          style={{ width: 120, maxWidth: '100%' }}
          value={statusFilter}
          onChange={v => { setStatusFilter(v); setPage(1); resetCursorStack(stablePaging); }}
          suffixIcon={<FilterOutlined />}
          options={[
            { value: 'pending',   label: t('execs.status.pending') },
            { value: 'running',   label: t('execs.status.running') },
            { value: 'waiting',   label: t('execs.status.waiting') },
            { value: 'success',   label: t('execs.status.success') },
            { value: 'failed',    label: t('execs.status.failed') },
            { value: 'timeout',   label: t('execs.status.timeout') },
            { value: 'killed',    label: t('execs.status.killed') },
            { value: 'cancelled', label: t('execs.status.cancelled') },
          ]}
        />
        <Input
          placeholder={t('execs.executorPlaceholder')}
          value={executorFilter}
          onChange={e => { setExecutorFilter(e.target.value); setPage(1); resetCursorStack(stablePaging); }}
          allowClear
          style={{ width: 180, maxWidth: '100%' }}
        />
        <RangePicker
          showTime
          format="MM-DD HH:mm"
          placeholder={[t('execs.timeStart'), t('execs.timeEnd')]}
          value={timeRange}
          onChange={val => { setTimeRange(val as [Dayjs, Dayjs] | null); setPage(1); resetCursorStack(stablePaging); }}
          style={{ width: 320, maxWidth: '100%' }}
        />
        {hasFilters && (
          <Button size="small" onClick={clearFilters}>{t('execs.clearFilters')}</Button>
        )}
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
            aria-label={t('execs.stablePaging.aria')}
          />
          <Tooltip title={t('execs.stablePaging.hint')}>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('execs.stablePaging')}</Text>
          </Tooltip>
        </Space>
      </Space>

      {/* UI-16：列表请求失败不再只弹 toast —— 页内原位呈现错误块 + 重试入口
          （写操作失败仍走 toast，语义不变） */}
      {error ? (
        <StateError
          error={error}
          title={t('execs.error.title')}
          onRetry={() => void refetch()}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      {isMobile ? (
        /* MOBILE-CARD-01：≤768px 卡片列表——此前 375px 下表格横向滚动，表头
           「任务名称」逐字竖排、操作列溢出。卡片按值班首查信息组织：状态 +
           任务名 / 触发·执行器 / 时间·耗时 / 错误 / 详情。 */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {executions.length === 0 ? (
            /* 空态区分：筛选无匹配给「清除筛选」出口；真空态如实提示
               （执行记录由任务触发产生，无直接创建入口可引导） */
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={hasFilters ? t('execs.empty.noMatch') : t('execs.empty')}>
              {hasFilters && (
                <Button type="link" size="small" onClick={clearFilters}>{t('execs.clearFilters')}</Button>
              )}
            </Empty>
          ) : (
            executions.map((r) => {
              const cfg = statusMap[r.status] || { badge: 'default' as BadgeStatus, label: r.status };
              return (
                <Card key={r.id} size="small">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <Link to={`/tasks/${r.taskId}`} style={{ fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.taskName || r.taskId}
                    </Link>
                    <Badge status={cfg.badge} text={cfg.label} />
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--chart-axis-text)' }}>
                    {/* ADR-017 阶段 3（决策 §7）：与表格列同口径——名字优先、
                        地址回落（移动端窄，故只显示一个；地址在桌面端可见）。 */}
                    {[triggerLabel(r.triggerType, t), nameOf(r) ?? r.executorAddress].filter(Boolean).join(' · ')}
                  </div>
                  <div style={{ marginTop: 4, fontSize: 12, color: 'var(--chart-axis-text)' }}>
                    {r.startTime ? `${formatRelativeTime(r.startTime, t)} · ${r.duration != null ? formatDuration(r.duration, t) : '-'}` : '-'}
                  </div>
                  {r.errorMessage && (
                    <Typography.Paragraph type="danger" style={{ marginTop: 6, marginBottom: 0, fontSize: 12 }} ellipsis={{ rows: 2, tooltip: r.errorMessage }}>
                      {r.errorMessage}
                    </Typography.Paragraph>
                  )}
                  <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 4 }}>
                    {(r.status === 'running' || r.status === 'waiting') && (
                      <Popconfirm
                        title={t('execs.killConfirm')}
                        description={
                          r.status === 'waiting' ? t('execs.killConfirmWaitingDesc') : undefined
                        }
                        onConfirm={() => handleKill(r)}
                        okText={t('execs.action.kill')} okButtonProps={{ danger: true }}
                      >
                        <Button size="small" danger icon={<StopOutlined />} loading={killingId === r.id}>
                          {t('execs.action.kill')}
                        </Button>
                      </Popconfirm>
                    )}
                    <Button size="small" icon={<EyeOutlined />} onClick={() => nav(`/tasks/${r.taskId}/executions/${r.id}`)}>
                      {t('execs.action.detail')}
                    </Button>
                  </div>
                </Card>
              );
            })
          )}
        </div>
      ) : (
      <Table
        rowKey="id"
        columns={columns}
        dataSource={executions}
        loading={loading}
        // UI-09：次要列窄屏收起（CSS 媒体查询 .ui09-hide-mobile）+ scroll.x 横向滚动兜底
        // UI 打磨：scroll.x 与列宽合计对齐（固定列 685 + 勾选 32 + 任务/错误两个弹性列
        // 最小各 ~160），原 640 < 合计，两个弹性列被压到勉强可读
        scroll={{ x: 1040 }}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys as string[]),
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
        locale={{
          // 空态区分（与移动端卡片同口径）：筛选无匹配 ≠ 从未有过执行——
          // 前者给「清除筛选」出口，避免用户把筛选打空误读成"执行记录丢了"。
          // UI-08：首屏（无数据未出错）以骨架屏替代 Spin；翻页/刷新仍走表格 loading。
          emptyText: shouldShowSkeleton(loading, error, executions.length) ? (
            <PageSkeleton variant="table" />
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={hasFilters ? t('execs.empty.noMatch') : t('execs.empty')}>
              {hasFilters && (
                <Button type="link" size="small" onClick={clearFilters}>{t('execs.clearFilters')}</Button>
              )}
            </Empty>
          ),
        }}
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
          <Text type="secondary" style={{ fontSize: 12 }}>{t('execs.count', { count: total })}</Text>
          <Button
            size="small"
            icon={<LeftOutlined />}
            // 栈首禁用：没有上一页可回（此时再点只会重复请求同一游标）
            disabled={cursorState.index === 0}
            onClick={goPrev}
          >
            {t('execs.pager.prev')}
          </Button>
          <Button
            size="small"
            // 后端说没有下一页（nextCursor === null，含"游标行被删"的提前结束）
            disabled={!canNext}
            onClick={goNext}
          >
            {t('execs.pager.next')}
            <RightOutlined />
          </Button>
        </div>
      ) : null}

      <ExecutionCompareModal
        open={compareOpen}
        onClose={() => setCompareOpen(false)}
        executions={executions}
        compareIds={selectedIds}
      />
    </div>
  );
}
