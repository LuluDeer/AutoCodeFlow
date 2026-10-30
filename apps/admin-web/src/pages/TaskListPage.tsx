import { useState, useEffect } from 'react';
import { Table,
  Button,
  Tag,
  Space,
  Typography,
  Input,
  Select,
  Badge,
  Popconfirm,
  Tooltip,
  Empty,
  Switch,
  Modal,
  Form,
  Alert,
  Popover,
  Checkbox,
  theme,
  Card } from 'antd';
import { message } from '../utils/toast';
import {
  PlusOutlined, SearchOutlined, FilterOutlined, ThunderboltOutlined,
  CopyOutlined, DeleteOutlined, EyeOutlined, EditOutlined,
  CheckSquareOutlined, FileTextOutlined, ColumnWidthOutlined,
  LeftOutlined, RightOutlined,
} from '@ant-design/icons';
// PK-02（DEEP_REVIEW 0ef3bbe）：clone payload 经 Object.keys 删除 undefined 后
// 类型变宽，create 调用点显式断言为生成的 CreateTaskDto。
import type { components } from '../types/generated/api-types';
import { Trans, useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { tasksApi, Task, summarizeBatch, type BatchItemResult } from '../api/tasks';
import { useTasksList, invalidateTaskData, usePauseTask, useResumeTask } from '../api/queries';
import { showApiError } from '../utils/error';
import { useDebounce } from '../hooks/useDebounce';
// URL-SYNC-02（审计 P2）：双向 URL 同步（外部深链/前进后退真正生效）
import { useUrlStateSync } from '../hooks/useUrlStateSync';
import { useAuthStore, isAdminUser } from '../store/auth';
import { priorityTag } from '../utils/priority';
// D-P2-02a（设计审计）：运行时枚举本地化唯一事实源（与 status/priority 同范式）
import { runtimeLabel } from '../utils/runtime-label';
// P1-1/P1-2（UX-AUDIT-2026-09-21）：列表页显示真实的「下次执行」与「上次执行」
import { nextRunAt, formatFireTime, previewNeedsTimezoneWarning } from '../utils/trigger-preview';
import { formatDateTime, formatRelativeTime } from '../utils/timeFormat';
// CRON-DESC-01：Cron 表达式的人类可读描述（超出子集回退 null，只显示原表达式）
import { describeCron } from '../utils/cron-desc';
// MOBILE-CARD-01：≤768px 表格 → 卡片列表（结构级降级）
import { useIsMobile } from '../hooks/useIsMobile';
// COLSET-01：列显隐偏好（localStorage 持久化；只过滤显隐，列定义/列宽不动）
import {
  TASK_LIST_COLUMN_KEYS,
  readHiddenColumns,
  writeHiddenColumns,
  type TaskColumnKey,
} from '../utils/taskColumns';
import ParamsEditor from '../components/ParamsEditor';
import PageHeader from '../components/PageHeader';
// UI-08：首屏数据未达时以 Skeleton 替代表格 Spin（ApplicationListPage 同款）
import PageSkeleton from '../components/PageSkeleton';
import StateError from '../components/StateError';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../i18n';

const { Text } = Typography;

/** UI-08：首屏 Skeleton 渲染判据——初次加载（无数据）且未出错时以骨架屏替代表格 Spin */
function shouldShowSkeleton(loading: boolean, error: unknown, count: number): boolean {
  return loading && count === 0 && !error;
}

type BadgeStatus = 'success' | 'processing' | 'error' | 'default' | 'warning';
const STATUS_CONFIG = (t: (k: string) => string): Record<string, { badge: BadgeStatus; label: string; color: string }> => ({
  active: { badge: 'success', label: t('taskList.status.active'), color: 'green' },
  paused: { badge: 'warning', label: t('taskList.status.paused'), color: 'orange' },
  inactive: { badge: 'default', label: t('taskList.status.inactive'), color: 'default' },
  failed: { badge: 'error', label: t('taskList.status.failed'), color: 'red' },
});

const TRIGGER_LABEL = (t: (k: string) => string): Record<string, string> => ({
  manual: t('taskList.trigger.manual'), cron: t('taskList.trigger.cron'), fixed_rate: t('taskList.trigger.fixed_rate'), dependency: t('taskList.trigger.dependency'),
});

const TRIGGER_COLOR: Record<string, string> = {
  manual: 'default', cron: 'blue', fixed_rate: 'geekblue', dependency: 'purple',
};

// COLSET-01：列键 → i18n 键（复用既有 taskList.col.* 词条，标签与表头一致）
const COLUMN_LABEL_KEY: Record<TaskColumnKey, string> = {
  name: 'taskList.col.name',
  status: 'taskList.col.status',
  trigger: 'taskList.col.trigger',
  priority: 'taskList.col.priority',
  schedule: 'taskList.col.schedule',
  nextRun: 'taskList.col.nextRun',
  lastRun: 'taskList.col.lastRun',
  runtime: 'taskList.col.runtime',
  toggle: 'taskList.col.enabled',
  actions: 'taskList.col.actions',
};

/**
 * §2.1 keyset 分页的前端状态：游标**栈** + 当前索引。
 *
 * 照抄 ExecutionsPage / AuditLogPage / ExecutorPackagesPage 的同一套范式
 * （那三处已被用例钉死，不另造一套）：游标分页没有「跳到第 N 页」——后端只给
 * 「下一页」令牌（`nextCursor`），**没有**「上一页」令牌，要支持「上一页」
 * 客户端必须自己记住走过的路径。
 *
 * 约定：`stack[0]` 恒为第 1 页的起点，`stack[i]` 是「要显示第 i+1 页时要发给
 * 后端的 cursor」。栈里存的是**不透明**令牌，前端一律原样回传，绝不解析拼接。
 */
type CursorStack = {
  /** stack[0] 恒为 keyset 起点（空串）或 null（关闭开关时）；stack[i] 为第 i+1 页的游标。 */
  stack: (string | null)[];
  /** 当前页在栈中的下标（0-based）。 */
  index: number;
};

/**
 * 栈的初始形态（与 ExecutionsPage / AuditLogPage 逐字同款）。
 *
 * `firstPageCursor` 的三态语义**必须**在这里保留：
 *   · `undefined` → `stack = [null]`，第 1 页**不带** cursor 参数（OFFSET 路径）；
 *   · `''`        → `stack = ['']`，第 1 页带 `cursor=`（keyset 起点）。
 *
 * 若写成 `firstPageCursor ?? ''`，关闭开关时 stack 首项会变成空串——一旦渲染
 * 期再取 `stack[index] ?? ''`，"空串也当没传"的判据就永远分不开两种模式。
 */
const initialCursorStack = (
  firstPageCursor: string | undefined,
): CursorStack => ({ stack: [firstPageCursor ?? null], index: 0 });

export default function TaskListPage() {
  const nav = useNavigate();
  // MOBILE-CARD-01：≤768px 表格 → 卡片列表
  const isMobile = useIsMobile();
  // P1-5：写操作仅管理员可用（普通用户按钮禁用+提示，不发起会 403 的请求）。
  const isAdmin = isAdminUser(useAuthStore((s) => s.user));
  const { t } = useTranslation();
  // F-15（DEEP_REVIEW 0ef3bbe）：主色/淡色背景走 antd token，暗色主题自适应。
  const { token } = theme.useToken();
  // URL-SYNC-01：筛选/分页以 URL 查询参数为初始源并回写——刷新/分享不丢状态
  // （与 ExecutionsPage 同一约定：q/status/trigger/page/pageSize）。
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState(() => searchParams.get('q') || '');
  const [statusFilter, setStatusFilter] = useState<string | undefined>(() => searchParams.get('status') || undefined);
  const [triggerFilter, setTriggerFilter] = useState<string | undefined>(() => searchParams.get('trigger') || undefined);
  // P2-18（生产审查）：最近一次执行结果筛选——值班最常问"哪些任务上次跑挂了"。
  // 后端契约：GET /tasks 新增 lastStatus 查询参数（@IsEnum(ExecutionStatus)）。
  const [lastStatusFilter, setLastStatusFilter] = useState<string | undefined>(() => searchParams.get('lastStatus') || undefined);
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [triggerTarget, setTriggerTarget] = useState<{ id: string; name: string; defaultParams?: Record<string, unknown> } | null>(null);
  const [triggerParams, setTriggerParams] = useState<Record<string, unknown>>({});
  const [triggering, setTriggering] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  // COLSET-01：隐藏列集合（缺省空 = 全显，与既有渲染零行为差异；只过滤显隐不动列定义）
  const [hiddenColumns, setHiddenColumns] = useState<TaskColumnKey[]>(() => readHiddenColumns());

  const [page, setPage] = useState(() => {
    const p = Number(searchParams.get('page'));
    return Number.isInteger(p) && p > 0 ? p : 1;
  });
  const [pageSize, setPageSize] = useState(() => {
    const ps = Number(searchParams.get('pageSize'));
    return Number.isInteger(ps) && ps > 0 ? ps : 20;
  });

  // 搜索防抖：输入框即时回显 search，列表查询跟随 debounced 值，避免每击键发请求
  const debouncedSearch = useDebounce(search);

  /**
   * §2.1：稳定翻页（keyset / 游标分页）开关。
   *
   * **默认关闭** = 现有 OFFSET 行为逐字节不变（零风险）。打开后请求带 `cursor`
   * 参数走后端 keyset 分支，响应里才有 `nextCursor`。
   *
   * ## 本页为什么比 ExecutionsPage / AuditLogPage 复杂（两个后端硬约束）
   *
   * `apps/admin-api/src/modules/task/task.service.ts` 的
   * `assertCursorCompatibleWithQuery` 规定：请求同时带 `cursor` 与
   * `sortBy` **或** `lastStatus` → 直接 400 VALIDATION_FAILED。本页这两个都有：
   *
   *   · `lastStatus`：筛选区的「最近执行」下拉（P2-18，值班最常用的筛选）。
   *   · `sortBy`：本页**没有**排序 UI（名称列的 `sorter` 是纯客户端排序，
   *     不发 `sortBy`/`sortOrder`），故无需处理——但下面仍把它列进互斥判据的
   *     注释里，避免日后有人加排序下拉时漏掉这条后端约束。
   *
   * 处理办法不是"让用户选完再吃 400"，而是：**keyset 模式下禁用「最近执行」
   * 筛选并给出可见说明**，已有选择则不让打开开关（Tooltip 说明原因）。理由：
   * 二者在结果集语义上就冲突——keyset 绑死 `(createdAt, id) DESC` 且走关联
   * 子查询分支，后端明确不支持；禁用一个入口比放行后弹一句"参数不合法"诚实
   * 得多。
   */
  const [stablePaging, setStablePaging] = useState(false);

  /**
   * 游标栈（见 `CursorStack`）。初始 `[null]` = 关闭开关的形态：第 1 页不带
   * cursor 参数。由 `resetCursorStack` 在开关切换/结果集变化时重置成 `''`
   * （空串 = keyset 起点）或 `null`（OFFSET 路径）。两种形态在状态里就是不同
   * 的值，不在渲染期用 `??` 归一——那样 keyset 起点永远进不去。
   */
  const [cursorState, setCursorState] = useState<CursorStack>(() => initialCursorStack(undefined));

  /**
   * 重置游标栈（回到第 1 页）。
   *
   * `keysetStart` 取**当前模式**而不是"刚切到的模式"，两种首页语义不同：
   *   · `false` → `stack = [null]`（第 1 页不带 cursor 参数，OFFSET 路径）；
   *   · `true`  → `stack = ['']`（第 1 页带 `cursor=`，keyset 起点）。
   *
   * 为什么必须重置：游标是**筛选条件下的位置令牌**。带着旧筛选的游标去筛新
   * 结果集，后端会把游标条件与过滤器取交集，返回"从某条不相干的行往后"的
   * 错乱内容——不报错、不空白，只是数据错了。这是本类改动里最难被发现的
   * 缺陷形态，故每个改变结果集的入口都要调用它。
   */
  const resetCursorStack = (keysetStart: boolean) => {
    setCursorState(initialCursorStack(keysetStart ? '' : undefined));
  };

  /**
   * 当前请求应携带的游标——**三态在此分开**。
   *
   *   · `undefined` = 不带该参数（键整个不出现）→ 后端 OFFSET 分支；
   *   · `''`        = `?cursor=` → 后端 keyset 起点；
   *   · 非空串      = keyset 中途页。
   *
   * **两个模式与 lastStatus 的互斥在此落地**：keyset 模式下 lastStatus 恒不
   * 参与请求（见下方 `effectiveLastStatus`），从根上杜绝"cursor + lastStatus"
   * 这个后端必 400 的组合——而不是靠 UI 禁用了事（禁用只是可见性，代码保证
   * 才防得住绕过 UI 的路径，比如 URL 深链）。
   */
  const effectiveLastStatus = stablePaging ? undefined : lastStatusFilter;
  /**
   * keyset 模式下若用户之前已经选了「最近执行」，打开开关时栈首仍是 keyset
   * 起点，但那一维筛选被忽略——必须让用户看见，否则"我明明筛了失败任务，
   * 结果里却混着成功的"会是比 400 更难查的静默错乱。
   */
  const lastStatusIgnored = stablePaging && !!lastStatusFilter;

  /**
   * 当前请求游标（三态）。关闭开关时恒为 `undefined`——默认路径的请求参数里
   * **不可能**出现 cursor，这是"旧路径零风险"的代码保证（配合
   * `tasksApi.list` 里 `taskListRequestConfig` 的显式键构造双保险）。
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

  // URL-SYNC-02（审计 P2）：双向同步——外部深链/前进后退现在会真正生效。
  // 此前只有「初始值读 URL + 单向回写」：组件已挂载时改 URL 会被回写抹掉。
  //
  // §2.1 补充（本页独有重点）：**URL→state 方向也必须重置游标栈**。深链
  // （如 `/tasks?status=paused&lastStatus=failed`）会让若干筛选项一起变，但
  // 游标**不在 URL 里**（不透明令牌不该进地址栏，也无法从 URL 还原）。若只改
  // 筛选而不清栈，keyset 模式下载第 3 页的游标会带着新筛选继续请求，结果就是
  // "从旧筛选某个不相干位置往后"的错乱数据。
  //
  // 六个字段逐个处理（page/pageSize/status/q/trigger/lastStatus）——全部包一层
  // setter，任何外部写入都顺带把栈重置回起点。
  useUrlStateSync(
    {
      page,
      pageSize,
      status: statusFilter,
      q: debouncedSearch,
      trigger: triggerFilter,
      lastStatus: lastStatusFilter,
    },
    {
      page: 1,
      pageSize: 20,
      status: undefined,
      q: '',
      trigger: undefined,
      lastStatus: undefined,
    },
    {
      page: (v) => { setPage(v); resetCursorStack(stablePaging); },
      pageSize: (v) => { setPageSize(v); resetCursorStack(stablePaging); },
      status: (v) => { setStatusFilter(v); resetCursorStack(stablePaging); },
      q: (v) => { setSearch(v); resetCursorStack(stablePaging); },
      trigger: (v) => { setTriggerFilter(v); resetCursorStack(stablePaging); },
      lastStatus: (v) => { setLastStatusFilter(v); resetCursorStack(stablePaging); },
    },
  );

  const { data, isLoading: loading, error, refetch } = useTasksList({
    page,
    pageSize,
    // 搜索框承诺「搜索任务名、描述」→ 必须发 q（name OR description）。
    // 此前错发 name（只搜任务名），按描述搜索恒为空且不报错。
    q: debouncedSearch || undefined,
    status: statusFilter,
    triggerType: triggerFilter,
    // §2.1：keyset 模式下恒为 undefined（后端契约：cursor 与 lastStatus 互斥，
    // 同时带 = 400）。关闭开关时原样透传，行为不变。
    lastStatus: effectiveLastStatus,
    // keyset 三态的**唯一**出口，落在下面这个三元里：
    //   · 关闭开关 → 整个 `cursor` 键都不出现（`{}`），请求与改动前完全一致；
    //   · 打开开关 → 空串（`?cursor=`，keyset 起点）或上一页返回的不透明游标。
    //
    // 为什么不是恒传 `{ cursor: activeCursor }` 让 axios 丢弃 undefined：键要
    // 不要在**我们**这一层就必须确定——"旧路径逐字节不变"是硬要求，把它押在
    // axios 的序列化细节上等于把风险外包给库版本。
    ...(activeCursor === undefined ? {} : { cursor: activeCursor }),
  });
  // FEAT-17: 写后失效句柄（原 useRequest refresh → invalidate 面收口）
  const queryClient = useQueryClient();
  const refresh = () => void invalidateTaskData(queryClient);

  // OPTIMISTIC-01：任务暂停/恢复的乐观 mutation（全仓唯一两处 onMutate）。
  // 行内 Switch 点下去立刻翻态，失败自动回滚——见 api/queries.ts 的
  // usePauseTask / useResumeTask 与 OPTIMISTIC-01 段注释。
  const pauseMutation = usePauseTask();
  const resumeMutation = useResumeTask();

  const tasks: Task[] = data?.items ?? [];
  const total: number = data?.total ?? 0;

  const hasFilters = !!(search || statusFilter || triggerFilter || lastStatusFilter);

  /**
   * keyset 模式下本页是否还有下一页。
   *
   * 严谨区分三种来源（**不能**用 `!!nextCursor` 一句糊过去）：
   *   · 关闭开关 → 根本不是 keyset 模式，`nextCursor` 键不存在（undefined），
   *     这里恒为 `null`（不渲染自绘分页器）；
   *   · keyset 且 `nextCursor === null` → 后端明确说「已到末页」（含「游标行
   *     被删 → 空页 + null」的提前结束）→ 禁用下一页；
   *   · keyset 且拿到了字符串 → 还有下一页。
   *
   * 取 `undefined` 视为"无法判断"→ 保守地按"没有下一页"处理（禁用一个凭空
   * 猜测的「下一页」比让用户点进一个必然报 400 的请求安全）。
   */
  const nextCursor: string | null = stablePaging ? (data?.nextCursor ?? null) : null;
  const canNext = stablePaging && nextCursor !== null;

  /**
   * 下一页：把刚拿到的游标压栈并前进一格（无游标或到末页时不动）。
   *
   * 连点安全：第二次点击时 `data` 仍是上一页的（TanStack 在新请求返回前保留
   * 旧数据），`nextCursor` 因此还是同一个令牌——下面「同一游标不重复压栈」的
   * 判据会把第二下变成空操作，不会在栈里堆出重复条目、也不会跳过一页。
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

  // 翻页/筛选变化后当前页数据会变，跨页选中行不再可见——清空选中防误比
  // （与 ExecutionsPage 同一约定；旧实现只随批量操作清空，筛选后残留的
  // 选中 id 会把不可见行卷进批量触发/删除）。
  useEffect(() => {
    setSelectedRowKeys([]);
  }, [page, pageSize, statusFilter, triggerFilter, lastStatusFilter, debouncedSearch]);

  // UX-WALK 2026-10：显式声明勾选列宽（antd v6 默认不给 width）——否则勾选列与
  // 名称列同为无宽度列，在 table-layout:fixed 下平分剩余空间，名称列吃不满下限 220。
  const rowSelection = {
    selectedRowKeys,
    columnWidth: 32,
    onChange: (keys: React.Key[]) => setSelectedRowKeys(keys as string[]),
  };

  /**
   * 批量操作的部分失败必须如实呈现。
   *
   * 后端四个 batch 端点都回 HTTP 200 + 逐项 `{id, error?}`
   * （task.controller.ts 用 Promise.all(...catch(err => ({id, error})))），
   * 所以「整体成功」不等于「每一项都成功」。此前 UI 无条件弹
   * 「已处理 N 项」并清空选择，20 项里 7 项被拒时操作者完全无从知晓——
   * 对触发/暂停/删除这类写面是不可接受的静默失败。
   * 现在：全成功才报 success；有失败则报 warning 并列出前 3 条原因。
   */
  const reportBatch = (
    results: BatchItemResult[] | undefined | null,
    okKey: string,
  ) => {
    const { succeeded, failed, failures } = summarizeBatch(results);
    // 全失败：沿用原有的错误提示语义
    if (failed > 0 && succeeded === 0) {
      message.error(t('taskList.batchAllFailed', { count: failed }));
    } else if (failed > 0) {
      message.warning(
        `${t(okKey, { count: succeeded })} / ${t('taskList.batchPartialFailed', {
          count: failed,
          reasons: failures.map((f) => f.error).join(t('common.listSep.semicolon')),
        })}`,
      );
    } else {
      message.success(t(okKey, { count: succeeded }));
    }
    // 仍有失败项时不清空选择，便于操作者重试或排查（成功项已生效，
    // 重试对幂等端点无害；对 delete 而言失败项本就还在列表里）。
    if (failed === 0) setSelectedRowKeys([]);
    refresh();
  };

  const handleBatchTrigger = async () => {
    if (batchLoading) return;
    setBatchLoading(true);
    try { reportBatch(await tasksApi.batchTrigger(selectedRowKeys), 'taskList.batchTriggered'); }
    catch (err: unknown) { showApiError(err, t('taskList.batchTriggerFail')); }
    finally { setBatchLoading(false); }
  };
  const handleBatchPause = async () => {
    if (batchLoading) return;
    setBatchLoading(true);
    try { reportBatch(await tasksApi.batchPause(selectedRowKeys), 'taskList.batchPaused'); }
    catch (err: unknown) { showApiError(err, t('taskList.batchPauseFail')); }
    finally { setBatchLoading(false); }
  };
  const handleBatchResume = async () => {
    if (batchLoading) return;
    setBatchLoading(true);
    try { reportBatch(await tasksApi.batchResume(selectedRowKeys), 'taskList.batchResumed'); }
    catch (err: unknown) { showApiError(err, t('taskList.batchResumeFail')); }
    finally { setBatchLoading(false); }
  };
  const handleBatchDelete = async () => {
    if (batchLoading) return;
    setBatchLoading(true);
    try {
      const results = await tasksApi.batchDelete(selectedRowKeys);
      // 空页钳制：选中集恒为本页行（翻页/筛选即清空），整页行全部删除成功后
      // 当前页会变空——与单删同口径回退一页；部分失败时页面仍有剩余行，不钳制。
      clampPageAfterRemoval(summarizeBatch(results).succeeded);
      reportBatch(results, 'taskList.batchDeleted');
    }
    catch (err: unknown) { showApiError(err, t('taskList.batchDeleteFail')); }
    finally { setBatchLoading(false); }
  };

  const handleTrigger = (id: string, name: string, defaultParams?: Record<string, unknown>) => {
    // A-11R：默认参数**原样**回填，不再 String(v) 强制转换。
    //
    // 此前这里把每个值转成字符串，于是服务端存的是布尔 true、一进触发弹窗就
    // 变成字符串 "true"，提交后落库/注入都成了字符串——类型在 UI 这一跳被
    // 静默丢掉。ParamsEditor 现在按值推断类型（见 inferType），配合这里的
    // 原样传递，布尔/数字/JSON 能完整往返。
    setTriggerParams({ ...(defaultParams ?? {}) });
    setTriggerTarget({ id, name, defaultParams });
  };

  const handleTriggerConfirm = async () => {
    if (!triggerTarget) return;
    setTriggering(true);
    try {
      const params = Object.fromEntries(
        Object.entries(triggerParams).filter(([k]) => k.trim())
      );
      await tasksApi.trigger(triggerTarget.id, Object.keys(params).length > 0 ? params : undefined);
      message.success(t('taskList.triggered', { name: triggerTarget.name }));
      setTriggerTarget(null);
      setTimeout(refresh, 1000);
    } catch (err: unknown) {
      showApiError(err, t('taskList.triggerFail'));
    } finally {
      setTriggering(false);
    }
  };

  const handlePause = async (id: string) => {
    if (togglingId) return;
    setTogglingId(id);
    // OPTIMISTIC-01：pause 走带 onMutate 的 mutation——Switch 在**请求发出前**
    // 就翻到目标态（乐观值写进 tasks 缓存），失败由 onError 精确回滚，
    // onSettled 再失效任务面由服务端校正。语义细节见 api/queries.ts 的
    // OPTIMISTIC-01 段注释（含与 SSE invalidateExecutionData 的互操作）。
    try {
      await pauseMutation.mutateAsync(id);
      message.success(t('taskList.paused'));
    } catch (err: unknown) {
      showApiError(err, t('taskList.pauseFail'));
    } finally {
      setTogglingId(null);
    }
  };

  const handleResume = async (id: string) => {
    if (togglingId) return;
    setTogglingId(id);
    // OPTIMISTIC-01：与 handlePause 对称（目标态 active）。
    try {
      await resumeMutation.mutateAsync(id);
      message.success(t('taskList.resumed'));
    } catch (err: unknown) {
      showApiError(err, t('taskList.resumeFail'));
    } finally {
      setTogglingId(null);
    }
  };

  // 空页钳制（一致性）：服务端分页下删除当前页最后一条后，total 减小但本页的
  // page 状态不变，请求仍打在第 N 页——antd 只在渲染层钳制分页器显示，表格主体
  // 仍是第 N 页拉回的空列表，用户停在"看不见数据也不知道该翻回去"的空页。
  // 本页只剩一条且不在第 1 页时，删除成功后回退一页（page-1 必然是满页，
  // 因为服务端分页是稠密填充）。
  const clampPageAfterRemoval = (removedCount: number) => {
    if (removedCount >= tasks.length && page > 1) setPage(page - 1);
  };

  const handleDelete = async (id: string) => {
    try { await tasksApi.delete(id); message.success(t('taskList.deleted')); clampPageAfterRemoval(1); refresh(); }
    catch (err: unknown) { showApiError(err, t('taskList.deleteFail')); }
  };

  // CORE-03-lite：一键克隆——复制任务全部可编辑字段生成 "-copy-" 副本，
  // 服务端字段（id/createdAt/status 等）不回传；glue 源码一并复制。
  // F-03（DEEP_REVIEW @0ef3bbe）：补齐此前丢失的 6 类可编辑字段
  // （timeoutAction/timeoutWarnRatio/maintenanceWindows/runbook/
  // executorAffinityTags/executorAntiAffinityTags），undefined 由下方统一剔除。
  const [cloningId, setCloningId] = useState<string | null>(null);
  const handleClone = async (r: Task) => {
    if (cloningId) return;
    setCloningId(r.id);
    try {
      const src = await tasksApi.get(r.id);
      // 克隆名 = 原名 + 时间后缀。必须**截断原名**：任务名上限 255 字符
      // （与 DB varchar 列宽对齐，见 admin-api 的 TASK_NAME_MAX_LENGTH），
      // 一个接近上限的名字加后缀会直接 400。
      //
      // 截断按**码点**而非 UTF-16 码元：`String.prototype.slice` 以码元计，
      // 恰好切在 emoji（代理对）中间会留下一个孤立代理项，JSON 序列化后
      // PG 会以 "invalid byte sequence for encoding UTF8" 拒绝整条请求。
      // Array.from 按码点拆分，天然规避该形态。
      const suffix = `-copy-${String(Date.now()).slice(-4)}`;
      const budget = 255 - suffix.length;
      const head = Array.from(r.name).slice(0, budget).join('');
      const cloneName = `${head}${suffix}`;
      const payload: Record<string, unknown> = {
        name: cloneName,
        description: src.description,
        runtime: src.runtime,
        entrypoint: src.entrypoint,
        requirements: src.requirements ?? [],
        triggerType: src.triggerType,
        cronExpression: src.cronExpression,
        timezone: src.timezone,
        fixedRate: src.fixedRate,
        // 读面只有 `timeout`（秒）。此前写 `src.timeoutSeconds ?? src.timeout` 是
        // 对一个**后端从不返回**的字段做兜底（timeoutSeconds 只在请求 DTO /
        // 模板 config 里，落库前被 normalizeTaskDto 映射成 timeout）——死兜底。
        timeout: src.timeout,
        // CORE-04: 超时策略（F-03：此前克隆丢字段，副本静默退回默认 kill/无预警）
        timeoutAction: src.timeoutAction,
        timeoutWarnRatio: src.timeoutWarnRatio,
        maxRetry: src.maxRetry,
        retryDelay: src.retryDelay,
        retryableErrors: src.retryableErrors,
        priority: typeof src.priority === 'number' ? src.priority : undefined,
        params: src.params,
        // FEAT-06/FEAT-11: 维护窗口与运行手册（F-03：此前克隆丢字段）
        maintenanceWindows: src.maintenanceWindows,
        runbook: src.runbook,
        dependencies: src.dependencies,
        executeMode: src.executeMode,
        executorId: src.executorId,
        executorGroup: src.executorGroup,
        executorTags: src.executorTags,
        // NF-04: 软路由亲和/反亲和标签（F-03：此前克隆丢字段）
        executorAffinityTags: src.executorAffinityTags,
        executorAntiAffinityTags: src.executorAntiAffinityTags,
        gitRepo: src.gitRepo,
        gitBranch: src.gitBranch,
        gitCommit: src.gitCommit,
        glueSource: src.glueSource,
        glueLanguage: src.glueLanguage,
        applicationId: src.applicationId,
      };
      Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);
      const created = await tasksApi.create(
        payload as components["schemas"]["CreateTaskDto"],
      );
      message.success(t('taskList.cloned', { name: cloneName }));
      nav(`/tasks/${created.id}`);
    } catch (err: unknown) {
      showApiError(err, t('taskList.cloneFail'));
    } finally {
      setCloningId(null);
    }
  };

  // UI-09：375px 可用性——关键列=名称/状态/启用/操作（值班首查项），其余次要列
  // responsive: ['md'] 在窄屏收起（CSS 侧 .ui09-hide-mobile 双保险）；
  // scroll.x 兜底横向滚动。onHeaderCell/onCell 挂类供媒体查询隐藏次要列。
  const hideOnMobile = {
    onHeaderCell: () => ({ className: 'ui09-hide-mobile' }),
    onCell: () => ({ className: 'ui09-hide-mobile' }),
  } as const;
  const statusConfig = STATUS_CONFIG(t);
  const triggerLabel = TRIGGER_LABEL(t);
  const columns = [
    {
      title: t('taskList.col.name'),
      key: 'name',
      // 2026-10-27：删掉列头 sorter。它是**纯客户端**排序（只比较当前 dataSource），
      // 而本表是**服务端分页 + 游标（keyset）分页**——排出来的只是当页 20 行，
      // 用户以为按名称全局排序、翻页后顺序又变，属主动误导。
      // 后端确实支持 sortBy=name/sortOrder（list-tasks-query.dto.ts +
      // task.service 的 TASK_SORT_WHITELIST），但 assertCursorCompatibleWithQuery
      // 对 cursor+sortBy **直接 400**：服务端排序与游标分页在当前契约里互斥。
      // 要真正按名称排序需先在产品层二选一（取消游标分页 / 后端支持 cursor+sortBy），
      // 已登记 docs/OPEN-DECISIONS.md D6。
      render: (_: unknown, r: Task) => (
        // UI 打磨：名称/描述单行 ellipsis——此前双行均不断行，长描述把行高
        // 撑得忽高忽低；div minWidth:0 让弹性列内的省略号真正生效
        <div style={{ minWidth: 0 }}>
          {/* F-33（DEEP_REVIEW 0ef3bbe）：原 <a onClick> 无 href，改 <Link>（键盘可达 + 真实 href） */}
          <Link
            to={`/tasks/${r.id}`}
            title={r.name}
            style={{ fontWeight: 500, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {r.name}
          </Link>
          {r.description && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block' }} ellipsis={{ tooltip: r.description }}>
              {r.description}
            </Text>
          )}
        </div>
      ),
    },
    {
      title: t('taskList.col.status'),
      // COLSET-01：显式 key（原仅 dataIndex）——列显隐过滤按 key 匹配，渲染不变
      key: 'status',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => {
        const cfg = statusConfig[s] || { badge: 'default', label: s, color: 'default' };
        return <Badge status={cfg.badge} text={cfg.label} />;
      },
    },
    {
      title: t('taskList.col.trigger'),
      key: 'trigger',
      dataIndex: 'triggerType',
      width: 100,
      ...hideOnMobile,
      render: (v: string) => (
        <Tag color={TRIGGER_COLOR[v] || 'default'}>{triggerLabel[v] || v}</Tag>
      ),
    },
    {
      title: t('taskList.col.priority'),
      key: 'priority',
      width: 80,
      ...hideOnMobile,
      render: (_: unknown, r: Task) => {
        const t2 = priorityTag(r.priority, t);
        return <Tag color={t2.color}>{t2.label}</Tag>;
      },
    },
    {
      title: t('taskList.col.schedule'),
      key: 'schedule',
      width: 190,
      ...hideOnMobile,
      render: (_: unknown, r: Task) => {
        if (r.triggerType === 'cron' && r.cronExpression) {
          // CRON-DESC-01：裸表达式下补一行人类可读描述，用户不必心算
          const desc = describeCron(r.cronExpression, t);
          return (
            <div style={{ minWidth: 0 }}>
              <Text code style={{ fontSize: 12 }}>{r.cronExpression}</Text>
              {desc && (
                <Text type="secondary" style={{ fontSize: 11, display: 'block', whiteSpace: 'nowrap' }}>
                  {desc}
                </Text>
              )}
            </div>
          );
        }
        if (r.triggerType === 'fixed_rate' && r.fixedRate) {
          const secs = r.fixedRate;
          if (secs < 60) return <Text type="secondary" style={{ fontSize: 12 }}>{t('taskList.schedule.sec', { sec: secs })}</Text>;
          const mins = Math.floor(secs / 60);
          const rem = secs % 60;
          const label = rem > 0 ? t('taskList.schedule.minSec', { min: mins, sec: rem }) : t('taskList.schedule.min', { min: mins });
          // D-P1-1（设计审计）：≥60s 时 label 已是本地化的「N 分钟」/「N 分 M 秒」，
          // 不再外层套「每 {{sec}} 秒」模板——否则渲染出「每 2 分钟 秒」。
          return <Text type="secondary" style={{ fontSize: 12 }}>{label}</Text>;
        }
        return <Text type="secondary" style={{ fontSize: 12 }}>{t('taskList.nextRun.none')}</Text>;
      },
    },
    {
      title: t('taskList.col.nextRun'),
      key: 'nextRun',
      width: 170,
      ...hideOnMobile,
      render: (_: unknown, r: Task) => {
        // P1-1（UX-AUDIT-2026-09-21）：本列此前只渲染静态徽章（「Cron 计划中」
        // /「定时运行中」），而列题是「下次执行」、tooltip 写着「下次 Cron 触发
        // 时间」——承诺了时刻却从不给出时刻。用户因此无法回答"这任务下次什么
        // 时候跑、它到底还在不在跑"，静默不执行在上百个任务里根本发现不了。
        // 现按真实表达式算出最近一次触发时刻（复用详情页同一套纯函数）。
        if (r.status !== 'active') {
          return <Text type="secondary" style={{ fontSize: 12 }}>{t('taskList.nextRun.none')}</Text>;
        }
        const next = nextRunAt(r);
        if (next) {
          // 遗留 P1-3：tz 为空/非法时浏览器本地推算 ≠ 服务端进程时区，
          // tooltip 追加服务端时区注记（沿用 trigger-preview 警示文案）。
          const tzUnresolved = previewNeedsTimezoneWarning(r.timezone);
          return (
            <Tooltip
              title={tzUnresolved
                ? t('taskList.nextRun.cronTooltip') + '\n' + t('triggerPreview.tzUnresolved')
                : t('taskList.nextRun.cronTooltip')}
            >
              <Text style={{ fontSize: 12 }}>{formatFireTime(next, r.timezone)}</Text>
            </Tooltip>
          );
        }
        // 表达式存在但算不出（非法/超子集）——如实说"无法预估"，不编假时刻
        if (r.triggerType === 'cron' || r.triggerType === 'fixed_rate') {
          return (
            <Tooltip title={t('taskList.nextRun.unpredictableTooltip')}>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('taskList.nextRun.unpredictable')}</Text>
            </Tooltip>
          );
        }
        return <Text type="secondary" style={{ fontSize: 12 }}>{t('taskList.nextRun.manual')}</Text>;
      },
    },
    {
      // P1-2（UX-AUDIT-2026-09-21）：上次触发时刻。该列在 DB 里一直存在、
      // 后端也一直返回并支持排序，但界面从不显示——于是"任务其实早就不跑了"
      // 这种最该被发现的静默故障反而最不可见。
      title: t('taskList.col.lastRun'),
      key: 'lastRun',
      width: 150,
      ...hideOnMobile,
      render: (_: unknown, r: Task) => {
        if (!r.lastTriggerTime) {
          return (
            <Tooltip title={t('taskList.lastRun.neverTooltip')}>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('taskList.lastRun.never')}</Text>
            </Tooltip>
          );
        }
        // 此前是不带 locale 的裸 toLocaleString()——跟随**浏览器** locale，
        // 英文浏览器跑中文界面时显示 MM/DD/YYYY，与界面语言割裂。统一走
        // formatDateTime（locale 跟随 i18n），与相对时间文案同源。
        return (
          <Tooltip title={formatDateTime(r.lastTriggerTime)}>
            <Text style={{ fontSize: 12 }}>{formatRelativeTime(r.lastTriggerTime, t)}</Text>
          </Tooltip>
        );
      },
    },
    {
      title: t('taskList.col.runtime'),
      key: 'runtime',
      dataIndex: 'runtime',
      width: 80,
      ...hideOnMobile,
      render: (v: string) => v ? <Tag>{runtimeLabel(v, t)}</Tag> : '-',
    },
    {
      title: t('taskList.col.enabled'),
      key: 'toggle',
      width: 70,
      render: (_: unknown, r: Task) => (
        <Switch
          size="small"
          checked={r.status === 'active'}
          loading={togglingId === r.id}
          onChange={checked => checked ? handleResume(r.id) : handlePause(r.id)}
          disabled={r.status === 'failed' || r.status === 'inactive' || (!!togglingId && togglingId !== r.id)}
        />
      ),
    },
    {
      title: t('taskList.col.actions'),
      key: 'actions',
      // UI 打磨：5 个图标按钮实测 ~200px（移动端 .ant-btn-icon-only 还有
      // 40px 触控兜底），160 会裁按钮；fixed right 保证横向滚动时操作常驻
      width: 210,
      fixed: 'right' as const,
      render: (_: unknown, r: Task) => (
        <Space size={2}>
          {/* A11Y-ICON-01：纯图标按钮补中文 aria-label——此前读屏只能念出
              antd 图标自带的 aria-label（eye/edit/copy/thunderbolt/delete），
              中文界面下出现英文图标名，且与 Tooltip 文案不一致 */}
          <Tooltip title={t('taskList.action.detail')}>
            <Button type="text" size="small" icon={<EyeOutlined />} aria-label={t('taskList.action.detail')} onClick={() => nav(`/tasks/${r.id}`)} />
          </Tooltip>
          <Tooltip title={isAdmin ? t('taskList.action.edit') : t('taskList.adminOnly')}>
            <Button type="text" size="small" icon={<EditOutlined />} aria-label={isAdmin ? t('taskList.action.edit') : t('taskList.adminOnly')} disabled={!isAdmin} onClick={() => nav(`/tasks/${r.id}/edit`)} />
          </Tooltip>
          <Tooltip title={isAdmin ? t('taskList.action.clone') : t('taskList.adminOnly')}>
            <Button
              type="text" size="small" icon={<CopyOutlined />}
              aria-label={isAdmin ? t('taskList.action.clone') : t('taskList.adminOnly')}
              loading={cloningId === r.id}
              disabled={!isAdmin}
              onClick={() => handleClone(r)}
            />
          </Tooltip>
          <Tooltip title={isAdmin ? t('taskList.action.trigger') : t('taskList.adminOnly')}>
            <Button
              type="text" size="small" icon={<ThunderboltOutlined />}
              aria-label={isAdmin ? t('taskList.action.trigger') : t('taskList.adminOnly')}
              disabled={!isAdmin}
              onClick={() => handleTrigger(r.id, r.name, r.params)}
              style={{ color: token.colorPrimary }}
            />
          </Tooltip>
          <Popconfirm
            title={t('taskList.deleteConfirm')}
            description={t('taskList.deleteForceTerminateDesc')}
            onConfirm={() => handleDelete(r.id)}
            okText={t('taskList.ok')} okButtonProps={{ danger: true }}
          >
            <Tooltip title={isAdmin ? t('taskList.action.delete') : t('taskList.adminOnly')}>
              <Button type="text" size="small" icon={<DeleteOutlined />} danger aria-label={isAdmin ? t('taskList.action.delete') : t('taskList.adminOnly')} disabled={!isAdmin} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  // COLSET-01：显隐过滤——缺省（无隐藏列）直接复用原 columns 数组，零行为差异；
  // 列宽/scroll.x 契约（task-list-deep 钉住）不受影响：隐藏只会减少已声明列宽合计。
  // （columns 本就随 t() 每次渲染重建，无需 useMemo。）
  const visibleColumns =
    hiddenColumns.length === 0
      ? columns
      : columns.filter((c) => !hiddenColumns.includes(String(c.key) as TaskColumnKey));
  const visibleColumnKeys = TASK_LIST_COLUMN_KEYS.filter((k) => !hiddenColumns.includes(k));
  /** 勾选变化 → 反推隐藏集合并持久化（全部勾选 = 全显 = 存量默认行为） */
  const handleColumnVisibilityChange = (checked: TaskColumnKey[]) => {
    const checkedSet = new Set(checked);
    const next = TASK_LIST_COLUMN_KEYS.filter((k) => !checkedSet.has(k));
    setHiddenColumns(next);
    writeHiddenColumns(next);
  };

  return (
    <div>
      {/* UI-03：页头标准化（原 Typography.Title 区块迁入 PageHeader，操作按钮进 extra） */}
      <PageHeader
        title={t('taskList.title')}
        // F-44（UIUX 审计 P2-2）：请求失败 ≠ 空结果——错误态下「共 {{count}} 个任务」
        // 会把 total=0（data 为 undefined 的兜底值）当成事实渲染成「共 0 个任务」，
        // 用户误判数据丢失。失败时不再显示计数（错误详情与重试入口见下方 StateError）。
        description={error ? undefined : t('taskList.total', { count: total })}
        extra={
          <>
            {/* CORE-03: 任务模板入口——从预置/自定义模板一键克隆 config */}
            <Button icon={<FileTextOutlined />} onClick={() => nav('/task-templates')}>
              {t('taskList.templates')}
            </Button>
            <Tooltip title={isAdmin ? undefined : t('taskList.adminOnly')}>
            <Button type="primary" icon={<PlusOutlined />} disabled={!isAdmin} onClick={() => nav('/tasks/new')}>
              {t('taskList.create')}
            </Button>
            </Tooltip>
          </>
        }
      />

      {/* UI-09：筛选区 wrap 堆叠（Space wrap 已有），输入/选择窄屏自适应宽度 */}
      <Space style={{ marginBottom: 16 }} wrap className="ui09-filter-bar">
        <Input
          placeholder={t('taskList.searchPlaceholder')}
          prefix={<SearchOutlined />}
          value={search}
          // §2.1：任何改变结果集的入口都要重置游标栈（原因见 resetCursorStack
          // 注释）。本页筛选是"即时应用"式（无 pending/搜索按钮两段式），故重置
          // 点就在 onChange 里。
          onChange={e => { setSearch(e.target.value); setPage(1); resetCursorStack(stablePaging); }}
          allowClear
          style={{ width: 220, maxWidth: '100%' }}
        />
        <Select
          placeholder={t('taskList.statusAll')}
          allowClear
          style={{ width: 110, maxWidth: '100%' }}
          value={statusFilter}
          onChange={v => { setStatusFilter(v); setPage(1); resetCursorStack(stablePaging); }}
          suffixIcon={<FilterOutlined />}
          options={[
            { value: 'active', label: t('taskList.status.active') },
            { value: 'paused', label: t('taskList.status.paused') },
          ]}
        />
        <Select
          placeholder={t('taskList.triggerAll')}
          allowClear
          style={{ width: 120, maxWidth: '100%' }}
          value={triggerFilter}
          onChange={v => { setTriggerFilter(v); setPage(1); resetCursorStack(stablePaging); }}
          options={[
            { value: 'manual', label: t('taskList.trigger.manual') },
            { value: 'cron', label: t('taskList.trigger.cron') },
            { value: 'fixed_rate', label: t('taskList.trigger.fixed_rate') },
          ]}
        />
        {/* §2.1：**keyset 模式下禁用**。后端 assertCursorCompatibleWithQuery 明确
            拒绝 `cursor` + `lastStatus`（按最近执行状态过滤走独立的关联子查询分支，
            不支持游标分页），放行只会让用户选完再吃一次 400。

            禁用之外**必须**给出可见原因：给一个点不动又不说为什么的死控件，等
            于把「后端不支持」这个事实藏起来。这里刻意用**常驻可见文本**而不是
            只挂 Tooltip——Tooltip 需要悬停，键盘/读屏用户拿不到（本题要求里
            Tooltip 与提示文案都算，选能覆盖全部用户的后者）。 */}
        <Select
          placeholder={t('taskList.lastRunAll')}
          allowClear
          disabled={stablePaging}
          aria-label={t('taskList.lastRunAll')}
          aria-describedby={stablePaging ? 'tasklist-laststatus-note' : undefined}
          style={{ width: 110, maxWidth: '100%' }}
          value={lastStatusFilter}
          onChange={v => { setLastStatusFilter(v); setPage(1); resetCursorStack(stablePaging); }}
          options={[
            { value: 'success', label: t('execs.status.success') },
            { value: 'failed', label: t('execs.status.failed') },
            { value: 'timeout', label: t('execs.status.timeout') },
          ]}
        />
        {stablePaging && (
          // 已选过值时是"数据可能不符预期"（更严重，红色）；未选值时是"该入口
          // 为何不可用"（灰色说明）。两者都常驻可见，不依赖悬停。
          lastStatusIgnored ? (
            <Text type="danger" id="tasklist-laststatus-note" style={{ fontSize: 12 }} data-testid="tasklist-laststatus-ignored">
              {t('taskList.stablePaging.lastStatusIgnored')}
            </Text>
          ) : (
            <Text type="secondary" id="tasklist-laststatus-note" style={{ fontSize: 12 }} data-testid="tasklist-laststatus-disabled-note">
              {t('taskList.stablePaging.lastStatusDisabled')}
            </Text>
          )
        )}
        {hasFilters && (
          <Button size="small" onClick={() => { setSearch(''); setStatusFilter(undefined); setTriggerFilter(undefined); setLastStatusFilter(undefined); setPage(1); resetCursorStack(stablePaging); }}>
            {t('taskList.clearFilters')}
          </Button>
        )}
        {hasFilters && (
          <Text type="secondary" style={{ fontSize: 13 }}>
            {t('taskList.count', { count: total })}
          </Text>
        )}
        {/* COLSET-01：列设置入口——Popover 内 Checkbox.Group 收纳低频列显隐。
            移动端卡片视图无列概念，不渲染该入口。最后一个可见列不可取消勾选
            （避免全部隐藏后的空表死面）。 */}
        {!isMobile && (
          <Popover
            trigger="click"
            placement="bottomRight"
            content={
              <div style={{ maxWidth: 240 }}>
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
                  {t('taskList.columnSettings.desc')}
                </Text>
                <Checkbox.Group
                  className="tasklist-column-options"
                  value={visibleColumnKeys}
                  onChange={(vals) => handleColumnVisibilityChange(vals as TaskColumnKey[])}
                  options={TASK_LIST_COLUMN_KEYS.map((k) => ({
                    value: k,
                    label: t(COLUMN_LABEL_KEY[k]),
                    disabled: visibleColumnKeys.length === 1 && visibleColumnKeys[0] === k,
                  }))}
                />
              </div>
            }
          >
            <Button icon={<ColumnWidthOutlined />} data-testid="tasklist-column-settings">
              {t('taskList.columnSettings')}
            </Button>
          </Popover>
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
            aria-label={t('taskList.stablePaging.aria')}
          />
          <Tooltip title={t('taskList.stablePaging.hint')}>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('taskList.stablePaging')}</Text>
          </Tooltip>
        </Space>
      </Space>

      {selectedRowKeys.length > 0 && (
        <div style={{ background: token.colorPrimaryBg, border: `1px solid ${token.colorPrimaryBorder}`, borderRadius: 6, padding: '8px 16px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <CheckSquareOutlined style={{ color: token.colorPrimary }} />
          <Text><Trans i18nKey="taskList.selected" values={{ count: selectedRowKeys.length }}><strong>0</strong></Trans></Text>
          <Button size="small" icon={<ThunderboltOutlined />} loading={batchLoading} disabled={batchLoading || !isAdmin} onClick={handleBatchTrigger}>{t('taskList.batchTrigger')}</Button>
          <Button size="small" loading={batchLoading} disabled={batchLoading || !isAdmin} onClick={handleBatchPause}>{t('taskList.batchPause')}</Button>
          <Button size="small" loading={batchLoading} disabled={batchLoading || !isAdmin} onClick={handleBatchResume}>{t('taskList.batchResume')}</Button>
          <Popconfirm title={t('taskList.batchDelete.confirm', { count: selectedRowKeys.length })} onConfirm={handleBatchDelete} okText={t('taskList.ok')} okButtonProps={{ danger: true }}>
            <Button size="small" danger icon={<DeleteOutlined />} loading={batchLoading} disabled={batchLoading || !isAdmin}>{t('taskList.batchDelete')}</Button>
          </Popconfirm>
          <Button size="small" disabled={batchLoading} onClick={() => setSelectedRowKeys([])}>{t('taskList.cancelSelect')}</Button>
        </div>
      )}

      <Modal
        title={<Space><ThunderboltOutlined /> {t('taskList.triggerModal.title', { name: triggerTarget?.name })}</Space>}
        open={!!triggerTarget}
        onCancel={() => setTriggerTarget(null)}
        onOk={handleTriggerConfirm}
        okText={t('taskList.trigger')}
        okButtonProps={{ loading: triggering, icon: <ThunderboltOutlined /> }}
        cancelText={t('taskList.cancel')}
        width={520}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          title={t('taskList.triggerParams.title')}
          description={t('taskList.triggerParams.desc')}
          style={{ marginBottom: 16 }}
        />
        <Form layout="vertical">
          <Form.Item label={t('taskList.params.label')}>
            <ParamsEditor
              value={triggerParams}
              onChange={setTriggerParams}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* UI-16：列表请求失败不再只弹 toast —— 页内原位呈现错误块 + 重试入口
          （写操作失败仍走 toast，语义不变） */}
      {error && (
        <StateError
          error={error}
          title={t('taskList.error.title')}
          onRetry={() => void refetch()}
          style={{ marginBottom: 16 }}
        />
      )}

      {isMobile ? (
        /* MOBILE-CARD-01：≤768px 卡片列表——此前 375px 下 10 列表格横向滚动、
           表头逐字竖排。卡片按值班首查信息组织：名称/描述 → 状态+触发 →
           调度（含 CRON-DESC-01 可读描述） → 下次/上次执行 → 启用开关 + 操作。
           批量操作依赖行选择，移动端不提供（桌面保留）。 */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {tasks.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('taskList.empty.none')} />
          ) : (
            tasks.map((r) => {
              const cfg = statusConfig[r.status] || { badge: 'default' as BadgeStatus, label: r.status };
              const cronDesc = r.triggerType === 'cron' && r.cronExpression
                ? describeCron(r.cronExpression, t)
                : null;
              return (
                <Card key={r.id} size="small">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <Link to={`/tasks/${r.id}`} style={{ fontWeight: 500 }}>{r.name}</Link>
                      {r.description && (
                        <Text type="secondary" style={{ fontSize: 12, display: 'block' }} ellipsis={{ tooltip: r.description }}>
                          {r.description}
                        </Text>
                      )}
                    </div>
                    <Badge status={cfg.badge} text={cfg.label} />
                  </div>
                  <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    <Tag color={TRIGGER_COLOR[r.triggerType] || 'default'} style={{ marginInlineEnd: 0 }}>
                      {triggerLabel[r.triggerType] || r.triggerType}
                    </Tag>
                    <Tag style={{ marginInlineEnd: 0 }}>{runtimeLabel(r.runtime, t)}</Tag>
                  </div>
                  {r.triggerType === 'cron' && r.cronExpression && (
                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--chart-axis-text)' }}>
                      <Text code style={{ fontSize: 12 }}>{r.cronExpression}</Text>
                      {cronDesc && <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>{cronDesc}</Text>}
                    </div>
                  )}
                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--chart-axis-text)' }}>
                    {t('taskList.col.lastRun_colon')}{r.lastTriggerTime
                      ? formatRelativeTime(r.lastTriggerTime, t)
                      : t('taskList.lastRun.never')}
                  </div>
                  <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Switch
                      size="small"
                      checked={r.status === 'active'}
                      loading={togglingId === r.id}
                      onChange={checked => checked ? handleResume(r.id) : handlePause(r.id)}
                      disabled={r.status === 'failed' || r.status === 'inactive' || (!!togglingId && togglingId !== r.id) || !isAdmin}
                      aria-label={t('taskList.col.enabled')}
                    />
                    <Space size={2}>
                      <Tooltip title={t('taskList.action.detail')}>
                        <Button type="text" size="small" icon={<EyeOutlined />} aria-label={t('taskList.action.detail')} onClick={() => nav(`/tasks/${r.id}`)} />
                      </Tooltip>
                      <Tooltip title={isAdmin ? t('taskList.action.edit') : t('taskList.adminOnly')}>
                        <Button type="text" size="small" icon={<EditOutlined />} aria-label={isAdmin ? t('taskList.action.edit') : t('taskList.adminOnly')} disabled={!isAdmin} onClick={() => nav(`/tasks/${r.id}/edit`)} />
                      </Tooltip>
                      <Tooltip title={isAdmin ? t('taskList.action.trigger') : t('taskList.adminOnly')}>
                        <Button
                          type="text" size="small" icon={<ThunderboltOutlined />}
                          aria-label={isAdmin ? t('taskList.action.trigger') : t('taskList.adminOnly')}
                          disabled={!isAdmin}
                          onClick={() => handleTrigger(r.id, r.name, r.params)}
                          style={{ color: token.colorPrimary }}
                        />
                      </Tooltip>
                      <Popconfirm
                        title={t('taskList.deleteConfirm')}
                        onConfirm={() => handleDelete(r.id)}
                        okText={t('taskList.ok')} okButtonProps={{ danger: true }}
                      >
                        <Tooltip title={isAdmin ? t('taskList.action.delete') : t('taskList.adminOnly')}>
                          <Button type="text" size="small" icon={<DeleteOutlined />} danger aria-label={isAdmin ? t('taskList.action.delete') : t('taskList.adminOnly')} disabled={!isAdmin} />
                        </Tooltip>
                      </Popconfirm>
                    </Space>
                  </div>
                </Card>
              );
            })
          )}
        </div>
      ) : (
      <Table
        rowKey="id"
        rowSelection={rowSelection}
        columns={visibleColumns}
        dataSource={tasks}
        loading={loading}
        // UI-09：次要列窄屏收起（CSS 媒体查询 .ui09-hide-mobile）+ scroll.x 横向滚动兜底
        // UX-WALK 2026-10 回归修复：scroll.x 必须 ≥ 固定列宽合计（含勾选 32）+ 名称列
        // 弹性下限 220。此前 P1-1/P1-2 增列（下次/上次执行）后固定列合计已达 1172
        // （status90/trigger100/priority80/schedule190/nextRun170/lastRun150/runtime80/
        // enabled70/actions210 + 勾选32），追平旧 scroll.x=1140 → antd 宽度填充
        // （@rc-component/table useWidthColumns）把唯一无 width 的名称列压到 ~1px，
        // 1280×800 桌面首列逐字竖排不可读。新增/加宽固定列时必须同步上调 scroll.x
        // （task-list-deep 列宽契约测试钉住）。
        scroll={{ x: 1392 }}
        /* §2.1：keyset 模式 = `false`（页码器整体消失，改由下方自绘「上一页 /
           下一页」承担），OFFSET 模式 = 原有配置（逐字节不变）。

           为什么 keyset 下必须**删掉**而不是保留页码：游标分页没有"第 N 页"
           这个坐标系。保留页码会让用户点「第 5 页」时其实还在第 2 页（`total`
           是真实总数，antd 会照着算出总页数并渲染出来），这是"页码还在但点
           第 5 页其实是第 2 页"式静默错乱。

           pageSize 变更同样重置游标栈：keyset 下页大小变了，旧游标对应的切片
           边界就不成立了（本页有 size changer，这条是真会走到的路径）。 */
        pagination={stablePaging ? false : {
          total,
          current: page,
          pageSize,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps ?? 20);
            if (ps !== undefined && ps !== pageSize) resetCursorStack(stablePaging);
          },
          showTotal: (t2) => t('taskList.count', { count: t2 }),
          showSizeChanger: true,
        }}
        locale={{
          // UI-08：首屏（无数据未出错）以骨架屏替代 Spin；翻页/刷新仍走表格 loading
          emptyText: shouldShowSkeleton(loading, error, tasks.length)
            ? <PageSkeleton variant="table" />
            : (hasFilters
              ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('taskList.empty.noMatch')} />
              : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('taskList.empty.none')}>
                  <Button type="primary" onClick={() => nav('/tasks/new')}>{t('taskList.empty.createFirst')}</Button>
                </Empty>
              )),
        }}
      />
      )}
      {/* §2.1：keyset 模式的自绘分页器（桌面表格与移动端卡片**共用**——两者是
          同一份数据的两种渲染，分页器必须一致）。

          游标分页只有「下一页」令牌，没有「上一页」令牌——上一页靠游标栈回退，
          故这里只有两个按钮，没有页码、没有页码跳转（见上方 pagination 注释）。 */}
      {stablePaging && (
        <div
          style={{
            marginTop: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 12,
          }}
        >
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('taskList.count', { count: total })}
          </Text>
          <Button
            size="small"
            icon={<LeftOutlined />}
            // 栈首禁用：没有上一页可回（此时再点只会重复请求同一游标）
            disabled={cursorState.index === 0}
            onClick={goPrev}
          >
            {t('taskList.pager.prev')}
          </Button>
          <Button
            size="small"
            // 后端说没有下一页（nextCursor === null，含"游标行被删 → 空页"的
            // 提前结束）；首屏 data 未到时 nextCursor 视为 null，同样禁用。
            disabled={!canNext}
            onClick={goNext}
          >
            {t('taskList.pager.next')}
            <RightOutlined />
          </Button>
        </div>
      )}
    </div>
  );
}
