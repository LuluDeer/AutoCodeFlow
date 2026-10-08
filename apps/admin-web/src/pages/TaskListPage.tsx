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
} from '@ant-design/icons';
// PK-02（DEEP_REVIEW 0ef3bbe）：clone payload 经 Object.keys 删除 undefined 后
// 类型变宽，create 调用点显式断言为生成的 CreateTaskDto。
import type { components } from '../types/generated/api-types';
import { Trans, useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { tasksApi, Task, summarizeBatch, type BatchItemResult } from '../api/tasks';
import { useTasksList, invalidateTaskData } from '../api/queries';
import { showApiError } from '../utils/error';
import { useDebounce } from '../hooks/useDebounce';
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
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState(() => searchParams.get('q') || '');
  const [statusFilter, setStatusFilter] = useState<string | undefined>(() => searchParams.get('status') || undefined);
  const [triggerFilter, setTriggerFilter] = useState<string | undefined>(() => searchParams.get('trigger') || undefined);
  // P2-18（生产审查）：最近一次执行结果筛选——值班最常问"哪些任务上次跑挂了"。
  // 后端契约：GET /tasks 新增 lastStatus 查询参数（@IsEnum(ExecutionStatus)）。
  const [lastStatusFilter, setLastStatusFilter] = useState<string | undefined>(() => searchParams.get('lastStatus') || undefined);
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [triggerTarget, setTriggerTarget] = useState<{ id: string; name: string; defaultParams?: Record<string, unknown> } | null>(null);
  const [triggerParams, setTriggerParams] = useState<Record<string, string>>({});
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

  // URL-SYNC-01：状态→URL 回写（replace 不制造历史记录；空值不写入）
  useEffect(() => {
    const next = new URLSearchParams();
    if (page !== 1) next.set('page', String(page));
    if (pageSize !== 20) next.set('pageSize', String(pageSize));
    if (statusFilter) next.set('status', statusFilter);
    if (debouncedSearch) next.set('q', debouncedSearch);
    if (triggerFilter) next.set('trigger', triggerFilter);
    if (lastStatusFilter) next.set('lastStatus', lastStatusFilter);
    setSearchParams(next, { replace: true });
  }, [page, pageSize, statusFilter, debouncedSearch, triggerFilter, lastStatusFilter, setSearchParams]);

  const { data, isLoading: loading, error, refetch } = useTasksList({
    page,
    pageSize,
    // 搜索框承诺「搜索任务名、描述」→ 必须发 q（name OR description）。
    // 此前错发 name（只搜任务名），按描述搜索恒为空且不报错。
    q: debouncedSearch || undefined,
    status: statusFilter,
    triggerType: triggerFilter,
    lastStatus: lastStatusFilter,
  });
  // FEAT-17: 写后失效句柄（原 useRequest refresh → invalidate 面收口）
  const queryClient = useQueryClient();
  const refresh = () => void invalidateTaskData(queryClient);

  const tasks: Task[] = data?.items ?? [];
  const total: number = data?.total ?? 0;

  const hasFilters = !!(search || statusFilter || triggerFilter || lastStatusFilter);

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
          reasons: failures.map((f) => f.error).join('；'),
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
    setTriggerParams(
      Object.fromEntries(Object.entries(defaultParams ?? {}).map(([k, v]) => [k, String(v)]))
    );
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
    try { await tasksApi.pause(id); message.success(t('taskList.paused')); refresh(); }
    catch (err: unknown) { showApiError(err, t('taskList.pauseFail')); }
    finally { setTogglingId(null); }
  };

  const handleResume = async (id: string) => {
    if (togglingId) return;
    setTogglingId(id);
    try { await tasksApi.resume(id); message.success(t('taskList.resumed')); refresh(); }
    catch (err: unknown) { showApiError(err, t('taskList.resumeFail')); }
    finally { setTogglingId(null); }
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
        timeout: src.timeoutSeconds ?? src.timeout,
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
      sorter: (a: Task, b: Task) => a.name.localeCompare(b.name),
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
        description={t('taskList.total', { count: total })}
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
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          allowClear
          style={{ width: 220, maxWidth: '100%' }}
        />
        <Select
          placeholder={t('taskList.statusAll')}
          allowClear
          style={{ width: 110, maxWidth: '100%' }}
          value={statusFilter}
          onChange={v => { setStatusFilter(v); setPage(1); }}
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
          onChange={v => { setTriggerFilter(v); setPage(1); }}
          options={[
            { value: 'manual', label: t('taskList.trigger.manual') },
            { value: 'cron', label: t('taskList.trigger.cron') },
            { value: 'fixed_rate', label: t('taskList.trigger.fixed_rate') },
          ]}
        />
        {/* P2-18（生产审查）：「最近执行」筛选——任务实体 status 只有 active/paused，
            失败在执行维度；后端 GET /tasks 以 lastStatus（@IsEnum(ExecutionStatus)）
            支持按最近一次执行结果筛任务。值班最常用三档：success/failed/timeout
            （label 复用既有执行状态 key execs.status.*）。 */}
        <Select
          placeholder={t('taskList.lastRunAll')}
          allowClear
          style={{ width: 110, maxWidth: '100%' }}
          value={lastStatusFilter}
          onChange={v => { setLastStatusFilter(v); setPage(1); }}
          options={[
            { value: 'success', label: t('execs.status.success') },
            { value: 'failed', label: t('execs.status.failed') },
            { value: 'timeout', label: t('execs.status.timeout') },
          ]}
        />
        {hasFilters && (
          <Button size="small" onClick={() => { setSearch(''); setStatusFilter(undefined); setTriggerFilter(undefined); setLastStatusFilter(undefined); setPage(1); }}>
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
                    {t('taskList.col.lastRun')}：{r.lastTriggerTime
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
        pagination={{
          total,
          current: page,
          pageSize,
          onChange: (p, ps) => { setPage(p); setPageSize(ps ?? 20); },
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
    </div>
  );
}
