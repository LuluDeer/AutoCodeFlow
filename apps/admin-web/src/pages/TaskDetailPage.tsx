import { useEffect, useState, lazy, Suspense } from 'react';
import { Card,
  Descriptions,
  Tag,
  Typography,
  Button,
  Space,
  Table,
  Badge,
  Tabs,
  Empty,
  Popconfirm,
  Tooltip,
  Modal,
  Spin,
  Statistic,
  Row,
  Col,
  Form,
  Alert,
  Result,
  Input,
  Drawer,
  theme } from 'antd';
import { message } from '../utils/toast';
import {
  ApartmentOutlined,
  ApiOutlined,
  ArrowLeftOutlined, ThunderboltOutlined, PauseCircleOutlined,
  PlayCircleOutlined, DeleteOutlined, ReloadOutlined, EditOutlined,
  EyeOutlined, ClockCircleOutlined, StopOutlined, RobotOutlined, CodeOutlined,
  CheckCircleOutlined, CloseCircleOutlined, FieldTimeOutlined, SaveOutlined,
  SyncOutlined, InfoCircleOutlined, HistoryOutlined,
} from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { tasksApi, TaskExecution } from '../api/tasks';
import type {
  Task,
  TaskVersion,
} from '../api/tasks';
import {
  useTaskDetail,
  useTaskExecutions,
  useTaskStats,
  invalidateTaskData,
  queryKeys,
} from '../api/queries';
import { taskTemplatesApi } from '../api/task-templates';
import { getErrMsg, isNotFoundError, showApiError } from '../utils/error';
// UX-06：触发方式展示标签唯一事实源（此前直接渲染裸枚举）。
import { triggerLabel, TRIGGER_COLOR } from '../utils/trigger-label';
// D-P2-02a（设计审计）：运行时枚举本地化唯一事实源
import { runtimeLabel } from '../utils/runtime-label';
import { formatDateTime, formatDuration, formatRelativeTime } from '../utils/timeFormat';
// 2026-10-23：任务详情状态行改为**任务级**调度信息（此前误用全平台计数，
// 见下方渲染处的注释）。复用列表页同一套纯函数，保证两处口径一致。
import { nextRunAt, formatFireTime, previewNeedsTimezoneWarning } from '../utils/trigger-preview';
// CRON-DESC-01：Cron 表达式的人类可读描述（utils/cron-desc.ts）
import { describeCron } from '../utils/cron-desc';
// P3 审计：执行状态 → Badge status 映射收敛到单一事实源（原本地 STATUS_COLOR 迁出）
import { EXECUTION_BADGE_STATUS } from '../utils/status-color';
// ADR-017 阶段 3（决策 §7 读面富化）：执行器可读名解析（id 优先、地址回落）。
// 执行历史表的「执行器」列此前只渲染 IP:端口；阶段 3 起 pull 允许同址多行并存
// （ADR-017 §5），地址甚至不再唯一——只显示地址无法回答「哪台机器」。
import { useExecutorNames } from '../hooks/useExecutorNames';
// F-27（DEEP_REVIEW 0ef3bbe）：失败次数派生（纯函数，保证整数）
import { failedRunCount } from './task-stats';
// CORE-03 收尾：保存为自定义模板的 config 白名单抽取
import { extractTemplateConfigFromTask } from '../utils/task-template-extract';
// python_task_multiversion（P2-3）：旧任务没有 codeSource 列时按迁移同序推导展示
import { deriveCodeSourceFromTask } from './executor-mode';
import { useTranslation } from 'react-i18next';
import { useAuthStore, isAdminUser } from '../store/auth';
// UI-09 第三轮：≤768px 结构级降级（版本历史抽屉满宽；R5-A 先例：AgentSessions/
// Projects 同款迁移）——A11Y-DRAWER-01：抽屉焦点管理同在此接入
import { useIsMobile } from '../hooks/useIsMobile';
import { useDrawerA11y } from '../hooks/useDrawerA11y';
// R6（前端巨型组件拆分，切法 (a)）：把本页 24 个 useState 所在的**子域**逐个搬进
// 同目录自定义 hook——零共享 state 的几个先切，纯搬移。组件侧只做解构，JSX 与
// 交互时序不变；页面编排函数因此缩短，棘轮见 scripts/source-size-baseline.json。
//   刀 1：webhook 密钥 / AI 建议                  （2 个 state + 1 个 loader / 3 个 + 1 个）
//   刀 3-4：手动触发 / 版本回滚（本次）           （3 个 + 2 handler / 8 个 + 3 handler）
// ⚠️ 跨子域共享件（`refreshTask` / `refreshExecs` = `invalidateTaskData`）**不进任何
//    子域 hook**，由本页（Facade）持有并以参数注入 —— 判断与理由写在两个 hook 的头注。
import { useTaskAiSuggestion } from './task-detail/useTaskAiSuggestion';
import { useTaskWebhookSecret } from './task-detail/useTaskWebhookSecret';
import { useTaskTrigger } from './task-detail/useTaskTrigger';
import { useTaskVersionRollback } from './task-detail/useTaskVersionRollback';
import '../i18n';
// PERF（第四轮审计）：GlueEditor 拖带 monaco（约 2.5MB raw 的 lazy chunk）。
// 此前静态 import 让详情页 route chunk 与 GlueEditor chunk 产生**静态边**——
// 用户哪怕只看「任务配置」Tab，路由加载时也会整包预取编辑器。改 React.lazy：
// antd Tabs 非激活面板不渲染，动态 import 只在用户切到「Glue 脚本」Tab 时才
// 发起；Suspense 给 Spin 占位。monaco 不进首屏的构建面守卫见
// __tests__/first-paint-no-unused-vendor.test.ts（读 dist 产物断言）。
const GlueEditor = lazy(() => import('../components/GlueEditor'));
import TaskDependencyGraph from '../components/TaskDependencyGraph';
import { priorityTag } from '../utils/priority';
import ParamsEditor from '../components/ParamsEditor';
import ArtifactsList from '../components/ArtifactsList';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/PageSkeleton';
const { Text } = Typography;

/** CORE-02: retryableErrors 展示文案走 i18n（复用 taskForm.retryable.* 键，未知值原样兜底） */
const RETRYABLE_T_KEY: Record<string, string> = {
  package_fetch_failed: 'taskForm.retryable.packageFetch',
  dependency_install_failed: 'taskForm.retryable.dependencyInstall',
  git_fetch_failed: 'taskForm.retryable.gitFetch',
  runtime_missing: 'taskForm.retryable.runtimeMissing',
  // EXP-01（本轮体验审查）：沙箱配置不可用。详情页展示用户显式勾选的重试白名单
  // 时必须能译出该键，否则会原样露出 sandbox_unavailable 枚举 token。
  sandbox_unavailable: 'taskForm.retryable.sandboxUnavailable',
  script_error: 'taskForm.retryable.scriptError',
  timeout: 'taskForm.retryable.timeout',
  executor_offline: 'taskForm.retryable.executorOffline',
  executor_restart: 'taskForm.retryable.executorRestart',
  // python_task_multiversion：解释器不可用。详情页展示用户显式勾选的重试白名单时
  // 必须能译出该键，否则会原样露出 interpreter_unavailable 枚举 token。
  interpreter_unavailable: 'taskForm.retryable.interpreterUnavailable',
  unknown: 'taskForm.retryable.unknown',
};

/** python_task_multiversion（P2-3）：代码来源展示文案（复用表单侧 i18n 键，
 *  未知值原样露出 token，与其它枚举映射同策）。 */
const CODE_SOURCE_T_KEY: Record<string, string> = {
  git: 'taskForm.field.codeSource.git',
  glue: 'taskForm.field.codeSource.glue',
  application_zip: 'taskForm.field.codeSource.applicationZip',
};

/**
 * A5（第二轮审计）：版本 diff 单元格值渲染。快照值既有标量也有 jsonb 结构
 * （dependencies / retryableErrors / alarmChannels…），标量原样、结构 JSON
 * 序列化；undefined（旧快照缺键）显示 "-"。
 */
const formatDiffValue = (v: unknown): string => {
  if (v === undefined) return '-';
  if (typeof v === 'string') return v;
  return JSON.stringify(v) ?? '-';
};

const STATUS_LABEL = (t: (k: string) => string): Record<string, string> => ({
  pending: t('taskDetail.status.pending'), running: t('taskDetail.status.running'), success: t('taskDetail.status.success'),
  failed: t('taskDetail.status.failed'), timeout: t('taskDetail.status.timeout'), killed: t('taskDetail.status.killed'), cancelled: t('taskDetail.status.cancelled'),
});

// D-P2-02a（设计审计）：任务级状态（active/paused/inactive/failed）复用 taskList.status.*
// 词表——此前 failed/inactive 在状态行 Badge 落裸英文 token。未知值回退原始值兜底。
const TASK_STATUS_LABEL = (t: (k: string) => string): Record<string, string> => ({
  active: t('taskList.status.active'),
  paused: t('taskList.status.paused'),
  inactive: t('taskList.status.inactive'),
  failed: t('taskList.status.failed'),
});

/**
 * 任务级调度标签（2026-10-23 口径修正）。
 *
 * 这里回答的是「**这个任务**下次什么时候跑、上次什么时候跑的」，与列表页
 * 「下次执行 / 上次执行」两列同源（`utils/trigger-preview` 的纯函数）。
 * 全平台调度器计数（活跃定时器/Cron/运行中）不属于任务详情——它此前被放在
 * 这里，导致 manual 任务也显示「活跃定时器 1」，见渲染处注释。
 */
function TaskScheduleTags({ task, isActive }: { task: Task; isActive: boolean }) {
  const { t } = useTranslation();
  const next = isActive ? nextRunAt(task) : null;
  const tzUnresolved = previewNeedsTimezoneWarning(task.timezone);
  return (
    <>
      {next ? (
        <Tooltip
          title={
            tzUnresolved
              ? `${t('taskDetail.stat.nextRunTooltip')}\n${t('triggerPreview.tzUnresolved')}`
              : t('taskDetail.stat.nextRunTooltip')
          }
        >
          <Tag color="processing" style={{ fontSize: 11 }}>
            {t('taskDetail.stat.nextRun', { time: formatFireTime(next, task.timezone) })}
          </Tag>
        </Tooltip>
      ) : (
        <Tag style={{ fontSize: 11 }}>{t('taskDetail.stat.nextRunNone')}</Tag>
      )}
      {task.lastTriggerTime && (
        <Tooltip title={formatDateTime(task.lastTriggerTime)}>
          <Tag style={{ fontSize: 11 }}>
            {t('taskDetail.stat.lastRun', { time: formatRelativeTime(task.lastTriggerTime, t) })}
          </Tag>
        </Tooltip>
      )}
    </>
  );
}

export default function TaskDetailPage() {
  const { t } = useTranslation();
  // P1-5：任务写操作仅管理员可用。
  const isAdmin = isAdminUser(useAuthStore((s) => s.user));
  // F-15（DEEP_REVIEW 0ef3bbe）：成功率语义色走 antd token，暗色主题自适应。
  const { token } = theme.useToken();
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  // 版本历史抽屉：≤768px 满宽（桌面保持 720px 语义不变）
  const isMobile = useIsMobile();
  // A11Y-DRAWER-01：版本抽屉焦点管理（开→聚焦首个可交互元素；关→归还触发按钮）
  const drawerA11y = useDrawerA11y();
  const [execPage, setExecPage] = useState(1);

  // R6 子域切法 (a)：AI 建议 / webhook 两个零共享 state 子域的 state + handler
  // 已迁到 pages/task-detail/ 下（纯搬移，页面只做解构）。另两刀（手动触发 /
  // 版本回滚）见文件头的 import 段说明与下方各自的调用点注释。
  const { aiModalOpen, setAiModalOpen, aiSuggestion, aiLoading, handleAiSuggest } =
    useTaskAiSuggestion(id);
  const {
    webhookStatus,
    webhookStatusError,
    issuedSecret,
    setIssuedSecret,
    webhookBusy,
    loadWebhookStatus,
    handleWebhookEnable,
    handleWebhookRotate,
    handleWebhookDisable,
  } = useTaskWebhookSecret(id);
  const [killingId, setKillingId] = useState<string | null>(null);
  const [toggleLoading, setToggleLoading] = useState(false);
  // CORE-03 收尾：保存为自定义模板 Modal
  const [tplModalOpen, setTplModalOpen] = useState(false);
  const [tplForm] = Form.useForm<{ name: string; description?: string; category?: string }>();
  const [tplSaving, setTplSaving] = useState(false);
  // GLUE-DIRTY-01：Glue 脚本编辑器有未保存改动时拦截浏览器关闭/刷新——
  // 详情页没有表单 dirty 语义，beforeunload 是唯一守卫层。
  const [glueDirty, setGlueDirty] = useState(false);

  useEffect(() => {
    if (!glueDirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [glueDirty]);

  const statusLabels = STATUS_LABEL(t);
  const taskStatusLabels = TASK_STATUS_LABEL(t);

  const handleSaveAsTemplate = async () => {
    if (!task) return;
    try {
      const values = await tplForm.validateFields();
      setTplSaving(true);
      await taskTemplatesApi.create({
        name: values.name.trim(),
        description: values.description?.trim() || undefined,
        category: values.category?.trim() || undefined,
        config: extractTemplateConfigFromTask(task),
      });
      message.success(t('taskDetail.savedAsTemplate', { name: values.name.trim() }));
      setTplModalOpen(false);
      // NETOPT-D P2-D6: 保存为模板是 task-templates 写——不失效则列表页
      // staleTime 30s 内跳转看不到新模板（TaskTemplatesPage 无写后触发）。
      void queryClient.invalidateQueries({
        queryKey: queryKeys.taskTemplates.list,
      });
    } catch (err: unknown) {
      // validateFields 的 reject 是带 errorFields 的校验对象，不是请求错误——
      // 仅对真正的请求失败弹 toast，表单校验错误由 Form 自带红字呈现。
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      showApiError(err, t('taskDetail.saveAsTemplateFail'));
    } finally {
      setTplSaving(false);
    }
  };

  // FEAT-17: TanStack Query 改造——四个 useRequest 换 queries.ts hooks：
  // - schedulerStats：30s 轮询语义由 refetchInterval 承担（queries.ts 内声明）；
  // - task/execs/stats：queryKey 带 id/分页参数（等价 ready+refreshDeps）；
  // - 写后失效：refreshTask/refreshExecs 收口为 invalidateTaskData（任务面 +
  //   执行面 + Dashboard 汇总联动，一处 invalidate 全站一致）。
  const queryClient = useQueryClient();
  const refreshTask = () => void invalidateTaskData(queryClient);
  const refreshExecs = () => void invalidateTaskData(queryClient);

  // ── A5（第二轮审计）：版本历史 ──────────────────────────────────────────
  // R6 刀 4：整个子域（8 state + 3 handler + 1 effect）已迁到
  // pages/task-detail/useTaskVersionRollback.ts（纯搬移，页面只做解构）。
  // ⚠️ 调用点**刻意停在这里**（不与其他子域 hook 归拢到文件头）：本 hook 内含
  // 一个 effect，挪到文件头会让它跑到 glueDirty 的 beforeunload 之前 —— 首帧两者
  // 都空转，但「副作用顺序变了」是拆分不该引入的风险面。`refreshTask` 是本页
  // （Facade）持有、跨四个域共享的失效函数，**注入**给它而非塞进 hook（理由见该
  // 文件头注「Facade 持共享、协作者拿引用」）。
  const {
    versionDrawerOpen,
    setVersionDrawerOpen,
    versions,
    versionsLoading,
    pickedVersionIds,
    setPickedVersionIds,
    versionDiff,
    setVersionDiff,
    diffLoading,
    rollbackTarget,
    setRollbackTarget,
    rollingBack,
    loadVersions,
    handleCompareVersions,
    handleRollbackConfirm,
  } = useTaskVersionRollback(id, refreshTask);

  // 2026-10-23：本页**不再**消费 useSchedulerStats——它是全平台计数，放在
  // 任务详情里会被读成"这个任务的调度器"（manual 任务也显示「活跃定时器 1」）。
  // 任务级调度信息由 TaskScheduleTags 用 nextRunAt/lastTriggerTime 计算；
  // 平台健康度在 Dashboard 的调度延迟卡上。若将来需要，请在页头明确标注
  // 「全平台」后再引回。

  const { data: task, isLoading: taskLoading, error: taskError } = useTaskDetail(id);

  const { data: execData, isLoading: execLoading } = useTaskExecutions(id, {
    page: execPage,
    pageSize: 20,
  });

  const { data: taskStats } = useTaskStats(id);

  const executions: TaskExecution[] = execData?.items ?? [];
  const execTotal: number = execData?.total ?? 0;

  // R6 刀 3：手动触发子域（3 state + 2 handler）已迁到
  // pages/task-detail/useTaskTrigger.ts（纯搬移，页面只做解构）。
  // 调用点必须落在 `useTaskDetail(id)` 之后：hook 需要页面已拿到的 `task?.params`
  // 作为弹窗预填源（不让 hook 自己再读一次同一份 query，见该文件头注）。
  // `refreshExecs` 同样是本页持有、跨域共享的失效函数 ⇒ 注入。
  const {
    triggerModalOpen,
    setTriggerModalOpen,
    triggerParams,
    setTriggerParams,
    triggering,
    handleTrigger,
    handleTriggerConfirm,
  } = useTaskTrigger(id, task?.params, refreshExecs);

  const handlePause = async () => {
    if (toggleLoading) return;
    setToggleLoading(true);
    try { await tasksApi.pause(id!); message.success(t('taskDetail.paused')); refreshTask(); }
    catch (err: unknown) { showApiError(err, t('taskDetail.pauseFail')); }
    finally { setToggleLoading(false); }
  };

  const handleResume = async () => {
    if (toggleLoading) return;
    setToggleLoading(true);
    try { await tasksApi.resume(id!); message.success(t('taskDetail.resumed')); refreshTask(); }
    catch (err: unknown) { showApiError(err, t('taskDetail.resumeFail')); }
    finally { setToggleLoading(false); }
  };

  const handleDelete = async () => {
    try { await tasksApi.delete(id!); message.success(t('taskDetail.deleted')); nav('/tasks'); }
    catch (err: unknown) { showApiError(err, t('taskDetail.deleteFail')); }
  };

  const handleEdit = () => {
    nav(`/tasks/${id}/edit`);
  };

  const handleKill = async (execId: string) => {
    if (killingId) return;
    setKillingId(execId);
    try {
      await tasksApi.killExecution(id!, execId);
      message.success(t('taskDetail.killed'));
      refreshExecs();
    } catch (err: unknown) { showApiError(err, t('taskDetail.killFail')); }
    finally { setKillingId(null); }
  };

  // ADR-017 阶段 3（决策 §7 读面富化）：执行历史表的执行器可读名解析。
  // 本页此前不加载执行器清单，故由 hook 自拉一次；失败静默降级为只显示地址。
  //
  // ⚠️ 必须在**下方所有 early return 之前**调用（Rules of Hooks）：本组件有
  // 「骨架屏 / 加载失败 / 任务不存在」三个提前 return 分支，若把本 hook 放在
  // 它们之后，首帧走早退分支（hook 未执行）、次帧走正常分支（hook 执行）→
  // React 报 "Rendered more hooks than during the previous render" 并整页崩溃。
  // 这正是 task-detail-maintenance.test.tsx 抓到的形态。
  const { nameOf } = useExecutorNames();

  // UI-08：首屏骨架屏替代裸 Spin
  if (taskLoading && !task) return <PageSkeleton variant="table" rows={6} style={{ padding: 24 }} />;
  // U7: 请求失败 ≠ 任务不存在——错误态给重试入口，数据确空才显示 Empty
  if (!task && taskError) {
    // F-41（UIUX 审计 P1-2）：确定性 404（id 不存在/已删除）与 5xx 分流——
    // 404 走「任务不存在」空态（复用下方 notFound 组件与出口；重试不可能
    // 成功，不该渲染「加载失败 + 重试」）；5xx/网络错误维持错误态 + 重试。
    if (isNotFoundError(taskError)) {
      return (
        <Empty description={t('taskDetail.notFound')} style={{ padding: 80 }}>
          <Button onClick={() => nav('/tasks')}>{t('taskDetail.backToList')}</Button>
        </Empty>
      );
    }
    return (
      <Result
        status="error"
        title={t('taskDetail.loadErrorTitle')}
        subTitle={getErrMsg(taskError, t('taskDetail.loadErrorDesc'))}
        extra={
          <Space>
            <Button onClick={() => nav('/tasks')}>{t('taskDetail.backToList')}</Button>
            <Button type="primary" icon={<ReloadOutlined />} onClick={refreshTask}>{t('taskDetail.retry')}</Button>
          </Space>
        }
      />
    );
  }
  if (!task) {
    // 排查清单 #4：任务不存在（id 非法/已在别处删除且查询被禁用）时不能只给一句
    // Empty——补「回任务列表」出口，避免报错死胡同（上方 error 分支已有同款出口）。
    return (
      <Empty description={t('taskDetail.notFound')} style={{ padding: 80 }}>
        <Button onClick={() => nav('/tasks')}>{t('taskDetail.backToList')}</Button>
      </Empty>
    );
  }

  // UI-09：375px 可用性——关键列=状态/开始时间/错误/操作；触发/执行器/耗时为
  // 次要列窄屏收起（CSS 侧 .ui09-hide-mobile 双保险），scroll.x 横向滚动兜底。
  const hideOnMobile = {
    onHeaderCell: () => ({ className: 'ui09-hide-mobile' }),
    onCell: () => ({ className: 'ui09-hide-mobile' }),
  } as const;
  const execColumns = [
    {
      title: t('taskDetail.col.status'), dataIndex: 'status', width: 90,
      render: (s: string) => <Badge status={EXECUTION_BADGE_STATUS[s] ?? 'default'} text={statusLabels[s] || s} />,
    },
    {
      title: t('taskDetail.col.trigger'), dataIndex: 'triggerType', width: 80,
      ...hideOnMobile,
      // UX-06：此前渲染裸枚举（cron / fixed_rate / manual）。
      render: (v: string) => <Text type="secondary" style={{ fontSize: 12 }}>{triggerLabel(v, t) || '-'}</Text>,
    },
    {
      title: t('taskDetail.col.executor'), dataIndex: 'executorAddress', width: 140, ellipsis: true,
      responsive: ['md'] as import('antd/es/_util/responsiveObserver').Breakpoint[],
      // ADR-017 阶段 3（决策 §7）：主显可读名（员工给机器起的名字），地址降为
      // tooltip 副信息——地址仍是**诊断身份**（「到底哪台」），故不删除。
      // 解析不到名字时如实只显示地址（绝不编造），都没有则 '-'。
      render: (v: string, r: TaskExecution) => {
        const name = nameOf(r);
        const fallback = v || null;
        if (!name && !fallback) return <Text type="secondary">-</Text>;
        return (
          <Tooltip title={fallback ?? name ?? ''}>
            <Text style={{ fontSize: 11, fontFamily: name ? undefined : 'monospace' }}>
              {name ?? fallback}
            </Text>
          </Tooltip>
        );
      },
    },
    {
      title: t('taskDetail.col.startTime'), dataIndex: 'startTime', width: 140,
      render: (v: string) => v ? (
        <Tooltip title={formatDateTime(v)}>
          <Text style={{ fontSize: 12 }}>{formatRelativeTime(v, t)}</Text>
        </Tooltip>
      ) : '-',
    },
    {
      title: t('taskDetail.col.duration'), dataIndex: 'duration', width: 80,
      ...hideOnMobile,
      render: (v: number) => v != null ? <Text style={{ fontSize: 12 }}>{formatDuration(v, t)}</Text> : '-',
    },
    {
      title: t('taskDetail.col.error'), dataIndex: 'errorMessage', ellipsis: true, minWidth: 330,
      render: (v: string) => v ? <Text type="danger" style={{ fontSize: 12 }}>{v}</Text> : '-',
    },
    {
      title: '', key: 'actions', width: 100,
      render: (_: unknown, r: TaskExecution) => (
        <Space size={2}>
          {r.status === 'running' && (
            <Popconfirm
              title={t('taskDetail.killConfirmTitle')}
              description={t('taskDetail.killConfirmDesc')}
              onConfirm={() => handleKill(r.id)}
              okText={t('taskDetail.kill')} okButtonProps={{ danger: true }}
            >
              <Tooltip title={t('taskDetail.kill')}>
                {/* A11Y-ICON-01：纯图标按钮补 aria-label（与 Tooltip 同键，读屏可播报） */}
                <Button type="text" size="small" danger icon={<StopOutlined />} aria-label={t('taskDetail.kill')}
                  loading={killingId === r.id} />
              </Tooltip>
            </Popconfirm>
          )}
          <Button type="link" size="small" icon={<EyeOutlined />}
            onClick={() => nav(`/tasks/${id}/executions/${r.id}`)}>{t('taskDetail.detail')}</Button>
        </Space>
      ),
    },
  ];

  const isActive = task.status === 'active';
  const isPaused = task.status === 'paused';

  // A5：版本历史 Drawer 的列表列（版本号/时间/创建者/操作）与 diff 键值行。
  const versionColumns = [
    {
      title: t('taskDetail.version.col.version'),
      dataIndex: 'version',
      width: 130,
      render: (v: string, r: TaskVersion) => (
        <Space size={4}>
          <Text code>{v}</Text>
          {r.gitCommit && (
            <Tooltip title={`${t('taskDetail.version.gitCommit')}: ${r.gitCommit}`}>
              <Text type="secondary" style={{ fontSize: 11, fontFamily: 'monospace' }}>
                {r.gitCommit.slice(0, 7)}
              </Text>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: t('taskDetail.version.col.time'),
      dataIndex: 'createdAt',
      width: 150,
      render: (v: string) => v ? (
        <Tooltip title={formatDateTime(v)}>
          <Text style={{ fontSize: 12 }}>{formatRelativeTime(v, t)}</Text>
        </Tooltip>
      ) : '-',
    },
    {
      title: t('taskDetail.version.col.creator'),
      dataIndex: 'createdBy',
      width: 110,
      ellipsis: true,
      render: (v: string | null) => v || <Text type="secondary">-</Text>,
    },
    {
      title: t('taskDetail.version.col.action'),
      key: 'actions',
      width: 150,
      render: (_: unknown, r: TaskVersion) => (
        <Tooltip title={isAdmin ? undefined : t('taskList.adminOnly')}>
          <Button
            size="small"
            data-testid={`version-rollback-${r.version}`}
            disabled={!isAdmin}
            onClick={() => setRollbackTarget(r)}
          >
            {t('taskDetail.version.rollback')}
          </Button>
        </Tooltip>
      ),
    },
  ];
  const diffRows = versionDiff
    ? Object.entries(versionDiff).map(([key, d]) => ({ key, old: d.old, new: d.new }))
    : [];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/tasks')}>{t('taskDetail.back')}</Button>
      </Space>

      {/* UI-03：页头标准化（原 Typography.Title 区块迁入 PageHeader，面包屑语义=任务→详情（≤2 跳），
          操作按钮整体进 extra；返回按钮与状态 Badge/调度 Tag 原样保留） */}
      <PageHeader
        title={task.name}
        description={task.description}
        breadcrumb={[
          { title: t('taskDetail.breadcrumb.scheduler'), to: '/tasks' },
          { title: task.name },
        ]}
        extra={
          <>
            <Tooltip title={isAdmin ? undefined : t('taskList.adminOnly')}><Button icon={<ThunderboltOutlined />} type="primary" disabled={!isAdmin} onClick={handleTrigger}>{t('taskDetail.triggerNow')}</Button></Tooltip>
            {isActive && <Tooltip title={isAdmin ? undefined : t('taskList.adminOnly')}><Button icon={<PauseCircleOutlined />} loading={toggleLoading} disabled={toggleLoading || !isAdmin} onClick={handlePause}>{t('taskDetail.pause')}</Button></Tooltip>}
            {isPaused && <Tooltip title={isAdmin ? undefined : t('taskList.adminOnly')}><Button icon={<PlayCircleOutlined />} type="primary" loading={toggleLoading} disabled={toggleLoading || !isAdmin} onClick={handleResume}>{t('taskDetail.resume')}</Button></Tooltip>}
            <Tooltip title={isAdmin ? undefined : t('taskList.adminOnly')}><Button icon={<RobotOutlined />} onClick={handleAiSuggest} loading={aiLoading} disabled={!isAdmin}>{t('taskDetail.aiSuggestion')}</Button></Tooltip>
            {/* CORE-03 收尾：把当前任务配置固化为自定义模板（POST /task-templates） */}
            <Tooltip title={isAdmin ? undefined : t('taskList.adminOnly')}>
            <Button
              icon={<SaveOutlined />}
              data-testid="save-as-template"
              onClick={() => { tplForm.setFieldsValue({ name: t('taskDetail.templateNameFormat', { name: task.name }) }); setTplModalOpen(true); }}
              disabled={!isAdmin}
            >
              {t('taskDetail.saveAsTemplate')}
            </Button>
          </Tooltip>
            {/* A5（第二轮审计）：版本历史入口（列表 / 两版对比 / 回滚） */}
            <Button
              icon={<HistoryOutlined />}
              data-testid="version-history"
              onClick={() => setVersionDrawerOpen(true)}
            >
              {t('taskDetail.version.title')}
            </Button>
            <Tooltip title={isAdmin ? undefined : t('taskList.adminOnly')}><Button icon={<EditOutlined />} disabled={!isAdmin} onClick={handleEdit}>{t('taskDetail.edit')}</Button></Tooltip>
            <Popconfirm title={t('taskDetail.confirmDelete')} description={t('taskDetail.deleteForceTerminateDesc')} onConfirm={handleDelete} okText={t('taskDetail.delete')} okButtonProps={{ danger: true }}>
              <Tooltip title={isAdmin ? undefined : t('taskList.adminOnly')}><Button icon={<DeleteOutlined />} danger disabled={!isAdmin}>{t('taskDetail.delete')}</Button></Tooltip>
            </Popconfirm>
          </>
        }
      />
      {/* UI-09：状态行 Tag 群窄屏换行（Space wrap） */}
      <div style={{ marginBottom: 16 }}>
        <Space wrap>
          <Badge
            status={isActive ? 'success' : isPaused ? 'warning' : 'default'}
            text={isActive ? t('taskDetail.state.running') : isPaused ? t('taskDetail.state.paused') : (taskStatusLabels[task.status] ?? task.status)}
          />
          {/* 2026-10-23 口径修正：这里此前渲染 `schedulerStats` 的三个计数，
              而那是**全平台调度器**的内存态（timers.size / cronTasks.size /
              runningTasks.size，见 scheduler.service.getStats）。后果是
              `demo-fragile`（manual 任务，根本没有定时器）也显示「活跃定时器 1
              · Cron 1」——用户会以为这个任务挂了两个调度器。
              现在只显示**本任务**的调度事实：下次执行时刻 + 上次触发时刻；
              全平台健康度归 Dashboard（那边有独立的「调度延迟/健康」卡）。 */}
          {task && <TaskScheduleTags task={task} isActive={isActive} />}
        </Space>
      </div>

      {/* Stats row */}
      {taskStats && (
        <Row gutter={[16, 12]} style={{ marginBottom: 16 }}>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title={t('taskDetail.stats.totalRuns')}
                value={taskStats.totalRuns ?? 0}
                prefix={<FieldTimeOutlined />}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              {/* FIX-5.1（统计口径收口）：successRate 现为后端 GROUP BY 的**全量**
              口径（旧实现是近 20 次窗口），与 totalRuns 同窗——卡片必须标注口径，
              否则用户仍按「近 20 次」理解。最近 20 次成功率由 recentSuccessRate
              提供，收进同一提示。 */}
              <Statistic
                title={(
                  <Space size={4}>
                    {t('taskDetail.stats.successRate')}
                    <Tooltip title={t('taskDetail.stats.caliberHint', { recent: (taskStats.recentSuccessRate ?? 0).toFixed(1) })}>
                      <InfoCircleOutlined style={{ color: token.colorTextSecondary }} />
                    </Tooltip>
                  </Space>
                )}
                value={(taskStats.successRate ?? 0).toFixed(1)}
                suffix="%"
                styles={{ content: { color: (taskStats.successRate ?? 0) >= 95 ? token.colorSuccess : (taskStats.successRate ?? 0) >= 80 ? token.colorWarning : token.colorError } }}
                prefix={<CheckCircleOutlined />}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              {/* FIX-5.1：失败次数直接消费后端全量 failed 计数（= FAILED +
              TIMEOUT），不再用 totalRuns × (1 − successRate/100) 派生——旧派生
              把全量 totalRuns 与近窗 successRate 两个口径混算（历史 500 败 +
              最近 20 全成 → 显示「失败 0 次」）。归一逻辑见 pages/task-stats.ts。 */}
              <Statistic
                title={t('taskDetail.stats.failed')}
                value={failedRunCount(taskStats)}
                styles={failedRunCount(taskStats) > 0 ? { content: { color: token.colorError } } : undefined}
                prefix={<CloseCircleOutlined />}
              />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title={t('taskDetail.stats.avgDuration')}
                value={taskStats.avgDuration ? (taskStats.avgDuration / 1000).toFixed(1) : '-'}
                suffix={taskStats.avgDuration ? 's' : ''}
                prefix={<FieldTimeOutlined />}
              />
            </Card>
          </Col>
        </Row>
      )}

      <Tabs
        items={[
          {
            key: 'info',
            label: t('taskDetail.tab.info'),
            children: (
              <>
              <Card>
                <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }}>
                  <Descriptions.Item label={t('taskDetail.field.runtime')}><Tag>{runtimeLabel(task.runtime, t)}</Tag></Descriptions.Item>
                  {/* python_task_multiversion（P2-3）：版本声明的读面——此前只能开
                      编辑表单才能确认任务钉了哪个解释器。非 python 任务后端强制
                      runtimeVersion=null，不展示该行。 */}
                  {task.runtime === 'python' && (
                    <Descriptions.Item label={t('taskDetail.field.runtimeVersion')}>
                      {task.runtimeVersion ? (
                        <Tag color="blue">{task.runtimeVersion}</Tag>
                      ) : (
                        <Text type="secondary">{t('taskForm.field.runtimeVersion.hostDefault')}</Text>
                      )}
                    </Descriptions.Item>
                  )}
                  {/* 代码来源读面：优先后端回填的 codeSource，旧任务按迁移同序推导
                      （deriveCodeSourceFromTask），保证存量任务也能看出通道。 */}
                  <Descriptions.Item label={t('taskDetail.field.codeSource')}>
                    <Tag>
                      {(() => {
                        const source = task.codeSource ?? deriveCodeSourceFromTask(task);
                        return CODE_SOURCE_T_KEY[source] ? t(CODE_SOURCE_T_KEY[source]) : source;
                      })()}
                    </Tag>
                  </Descriptions.Item>
                  {/* UX-06：此前 <Tag>{task.triggerType}</Tag> 渲染裸枚举。 */}
                  <Descriptions.Item label={t('taskDetail.field.triggerType')}>
                    <Tag color={TRIGGER_COLOR[task.triggerType] || 'default'}>
                      {triggerLabel(task.triggerType, t) || '-'}
                    </Tag>
                  </Descriptions.Item>
                  {task.cronExpression && (() => {
                    // CRON-DESC-01：表达式旁附人类可读描述（超出子集只显示原表达式）
                    const cronDesc = describeCron(task.cronExpression, t);
                    return (
                      <Descriptions.Item label={t('taskDetail.field.cron')}>
                        <div>
                          <Text code>{task.cronExpression}</Text>
                          {cronDesc && (
                            <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                              {cronDesc}
                            </Text>
                          )}
                        </div>
                      </Descriptions.Item>
                    );
                  })()}
                  {task.fixedRate && (
                    <Descriptions.Item label={t('taskDetail.field.interval')}>
                      {task.fixedRate >= 3600
                        ? t('taskDetail.unit.hour', { n: (task.fixedRate / 3600).toFixed(1).replace(/\.0$/, '') })
                        : task.fixedRate >= 60
                          ? t('taskDetail.unit.minute', { n: (task.fixedRate / 60).toFixed(1).replace(/\.0$/, '') })
                          : t('taskDetail.unit.second', { n: task.fixedRate })}
                    </Descriptions.Item>
                  )}
                  {/* FEAT-06: 任务级维护窗口（命中时调度计划触发被跳过） */}
                  {task.maintenanceWindows && task.maintenanceWindows.length > 0 && (
                    <Descriptions.Item label={t('taskDetail.field.maintenance')} span="filled">
                      <Space size={[4, 4]} wrap>
                        {task.maintenanceWindows.map((w, i) => (
                          <Tag key={i} color="orange" style={{ fontFamily: 'monospace' }}>
                            {`${w.start} → ${w.end}${w.description ? t('taskDetail.maintenance.descFmt', { desc: w.description }) : ''}`}
                          </Tag>
                        ))}
                      </Space>
                    </Descriptions.Item>
                  )}
                  <Descriptions.Item label={t('taskDetail.field.entrypoint')}>{task.entrypoint || '-'}</Descriptions.Item>
                  {task.requirements && task.requirements.length > 0 && (
                    <Descriptions.Item label={t('taskDetail.field.requirements')}>
                      <Space size={[4, 4]} wrap>
                        {task.requirements.map((r) => <Tag key={r} color="blue">{r}</Tag>)}
                      </Space>
                    </Descriptions.Item>
                  )}
                  {/* FEAT-11: 运行手册（markdown 排障知识） */}
                  {task.runbook && (
                    <Descriptions.Item label={t('taskDetail.field.runbook')} span="filled">
                      {/* UI 打磨：代码样式长手册限高内滚，避免描述区被单条目撑爆 */}
                      <Typography.Paragraph
                        style={{
                          marginBottom: 0,
                          whiteSpace: 'pre-wrap',
                          fontFamily: 'monospace',
                          fontSize: 12,
                          maxHeight: 320,
                          overflowY: 'auto',
                        }}
                      >
                        {task.runbook}
                      </Typography.Paragraph>
                    </Descriptions.Item>
                  )}
                  <Descriptions.Item label={t('taskDetail.field.timeout')}>{task.timeout ? t('taskDetail.unit.second', { n: task.timeout }) : t('taskDetail.timeout.notLimited')}</Descriptions.Item>
                  {/* CORE-04: 超时策略分级展示 */}
                  <Descriptions.Item label={t('taskDetail.field.timeoutAction')}>
                    {task.timeoutAction === 'kill_retry'
                      ? t('taskDetail.timeoutAction.killRetry')
                      : task.timeoutAction === 'notify_only'
                        ? t('taskDetail.timeoutAction.notifyOnly')
                        : t('taskDetail.timeoutAction.terminate')}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('taskDetail.field.timeoutWarn')}>
                    {typeof task.timeoutWarnRatio === 'number'
                      ? t('taskDetail.timeoutWarn.format', { pct: task.timeoutWarnRatio })
                      : t('taskDetail.notEnabled')}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('taskDetail.field.maxRetry')}>{t('taskDetail.countTimes', { count: task.maxRetry ?? 0 })}</Descriptions.Item>
                  {/* CORE-02: 可重试错误类型白名单展示（null/[] = 全部可重试） */}
                  <Descriptions.Item label={t('taskDetail.field.retryableErrors')} span="filled">
                    {task.retryableErrors && task.retryableErrors.length > 0 ? (
                      <Space size={[4, 4]} wrap>
                        {task.retryableErrors.map((r) => (
                          <Tag key={r} color="orange">
                            {RETRYABLE_T_KEY[r] ? t(RETRYABLE_T_KEY[r]) : r}
                          </Tag>
                        ))}
                      </Space>
                    ) : (
                      <Text type="secondary">{t('taskDetail.allRetryable')}</Text>
                    )}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('taskDetail.field.priority')}>
                    <Tag color={priorityTag(task.priority, t).color}>{priorityTag(task.priority, t).label}</Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label={t('taskDetail.field.executeMode')}>
                    {task.executeMode === 'broadcast' ? t('taskDetail.executeMode.broadcast') : task.executeMode === 'single' ? t('taskDetail.executeMode.single') : task.executeMode || t('taskDetail.executeMode.auto')}
                  </Descriptions.Item>
                  {task.executorAppName && (
                    <Descriptions.Item label={t('taskDetail.field.executorApp')}>{task.executorAppName}</Descriptions.Item>
                  )}
                  <Descriptions.Item label={t('taskDetail.field.executorGroup')}>{task.executorGroup || t('taskDetail.any')}</Descriptions.Item>
                </Descriptions>
                {task.params && Object.keys(task.params).length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <Typography.Text strong style={{ fontSize: 13 }}>{t('taskDetail.defaultParams')}</Typography.Text>
                    <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {Object.entries(task.params).map(([k, v]) => (
                        <Tag key={k} style={{ fontFamily: 'monospace', fontSize: 12 }}>
                          {k} = {String(v)}
                        </Tag>
                      ))}
                    </div>
                  </div>
                )}
              </Card>
              {/* FEAT-21: 任务 webhook 入站触发卡片。管理按钮仅管理员（P1-5 同口径，
                  后端 assertCanOperate 兜底）；secret 一次性回显，读面永不回传。
                  viewer 调状态接口会 403——非管理员且状态未取到时整卡隐藏，
                  避免"未启用"的误导性展示。 */}
              {(isAdmin || webhookStatus !== null) && (
              <Card
                size="small"
                style={{ marginTop: 16 }}
                title={
                  <Space>
                    <ApiOutlined />
                    {t('taskDetail.webhook.title')}
                    {/* 三态：已启用 / 未启用 / **未知**（读取失败）。未知绝不能
                        显示成「未启用」——那会把一次网络抖动变成一次误操作的机会。 */}
                    <Tag color={webhookStatusError ? 'warning' : webhookStatus?.enabled ? 'success' : 'default'}>
                      {webhookStatusError
                        ? t('taskDetail.webhook.statusUnknownTag')
                        : webhookStatus?.enabled
                          ? t('taskDetail.webhook.enabled')
                          : t('taskDetail.webhook.disabled')}
                    </Tag>
                  </Space>
                }
              >
                {webhookStatusError ? (
                  <Space direction="vertical" size={8}>
                    <Text type="danger">{t('taskDetail.webhook.statusUnknown')}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {t('taskDetail.webhook.statusUnknownHint')}
                    </Text>
                    <Button size="small" onClick={loadWebhookStatus}>{t('taskDetail.webhook.retry')}</Button>
                  </Space>
                ) : webhookStatus?.enabled ? (
                  <>
                    <Typography.Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 12 }}>
                      {t('taskDetail.webhook.desc')}
                    </Typography.Paragraph>
                    <Typography.Paragraph style={{ marginBottom: 8 }}>
                      <Text type="secondary">{t('taskDetail.webhook.url')}</Text>
                      <Typography.Text code copyable style={{ fontSize: 12 }}>
                        {webhookStatus.url}
                      </Typography.Text>
                    </Typography.Paragraph>
                    <Space style={{ marginBottom: 8 }}>
                      <Popconfirm title={t('taskDetail.webhook.rotateConfirm')} onConfirm={handleWebhookRotate}>
                        <Button size="small" icon={<SyncOutlined />} disabled={!isAdmin || webhookBusy !== null} loading={webhookBusy === 'rotate'}>{t('taskDetail.webhook.rotate')}</Button>
                      </Popconfirm>
                      <Popconfirm title={t('taskDetail.webhook.disableConfirm')} onConfirm={handleWebhookDisable}>
                        <Button size="small" danger disabled={!isAdmin || webhookBusy !== null} loading={webhookBusy === 'disable'}>{t('taskDetail.webhook.disable')}</Button>
                      </Popconfirm>
                    </Space>
                    <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
                      {t('taskDetail.webhook.waitHint')}
                    </Typography.Paragraph>
                  </>
                ) : (
                  <Tooltip title={isAdmin ? undefined : t('taskList.adminOnly')}>
                    <Button size="small" type="primary" disabled={!isAdmin || webhookBusy !== null} loading={webhookBusy === 'enable'} onClick={handleWebhookEnable}>
                      {t('taskDetail.webhook.enable')}
                    </Button>
                  </Tooltip>
                )}
              </Card>
              )}
              </>
            ),
          },
          {
            key: 'glue',
            label: (
              <span><CodeOutlined /> {t('taskDetail.tab.glue')}</span>
            ),
            children: (
              <Card>
                {/* GLUE-HINT-01：代码来源不是内嵌脚本时（zip 应用/Git 仓库），编辑器
                    空白且「保存脚本」禁用，用户无从判断"这里的代码跑不跑"。补一条
                    说明横幅，讲清楚内嵌脚本与当前来源的关系。 */}
                {(() => {
                  const source = task.codeSource ?? deriveCodeSourceFromTask(task);
                  return source !== 'glue' ? (
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginBottom: 12 }}
                      title={t('taskDetail.glue.notGlueTitle')}
                      description={t('taskDetail.glue.notGlueDesc')}
                    />
                  ) : null;
                })()}
                {/* PERF（第四轮审计）：lazy chunk 下载/解析期间的占位（Spin），
                    chunk 到位后编辑器整体挂载。 */}
                <Suspense
                  fallback={
                    <div style={{ textAlign: 'center', padding: 48 }} data-testid="glue-editor-fallback">
                      <Spin />
                    </div>
                  }
                >
                  <GlueEditor
                    taskId={id!}
                    initialSource={task.glueSource ?? undefined}
                    initialLanguage={task.glueLanguage ?? undefined}
                    taskRuntime={task.runtime}
                    onDirtyChange={setGlueDirty}
                  />
                </Suspense>
              </Card>
            ),
          },
          {
            key: 'deps',
            label: (
              <span><ApartmentOutlined /> {t('taskDetail.tab.deps')}</span>
            ),
            children: (
              <Card>
                <TaskDependencyGraph taskId={id!} />
              </Card>
            ),
          },
          {
            key: 'executions',
            label: (
              <span>
                <ClockCircleOutlined /> {t('taskDetail.tab.executions')}
              </span>
            ),
            children: (
              <Card
                extra={
                  <Space>
                    <Button size="small" icon={<ReloadOutlined />} onClick={refreshExecs}>{t('taskDetail.refresh')}</Button>
                    <Button size="small" type="primary" icon={<ThunderboltOutlined />} onClick={handleTrigger}>{t('taskDetail.manualTrigger')}</Button>
                  </Space>
                }
              >
                {/* FEAT-05（UI 半场）：最近一次执行的产物列表；无产物时组件返回 null，整段不渲染 */}
                {executions.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <ArtifactsList execId={executions[0].id} />
                  </div>
                )}
                <Table<TaskExecution>
                  rowKey="id"
                  columns={execColumns}
                  dataSource={executions}
                  loading={execLoading}
                  size="small"
                  // UI-09：次要列窄屏收起（CSS 媒体查询 .ui09-hide-mobile）+ 横向滚动兜底（值班手机看失败原因）
                  // UI 打磨：scroll.x 与列宽合计校准——定宽列 90+80+140+140+80+100=630，
                  // 加错误摘要弹性列最小宽 330 → 960（原 620 小于定宽合计，窄屏挤压折行）
                  scroll={{ x: 960 }}
                  pagination={{
                    total: execTotal,
                    pageSize: 20,
                    current: execPage,
                    onChange: setExecPage,
                    showTotal: (count) => t('taskDetail.countTotal', { count }),
                  }}
                  locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('taskDetail.noExecutions')} /> }}
                />
              </Card>
            ),
          },
        ]}
      />

      {/* FEAT-21: webhook 密钥一次性回显弹窗——enable/rotate 响应中的明文
          密钥只在本弹窗可见，关闭即丢弃（后端只存加密信封，无法再取）。 */}
      <Modal
        title={<Space><ApiOutlined /> {t('taskDetail.webhook.secretTitle')}</Space>}
        open={!!issuedSecret}
        footer={null}
        onCancel={() => setIssuedSecret(null)}
        width={560}
        destroyOnHidden
      >
        <Alert type="warning" showIcon title={t('taskDetail.webhook.secretDesc')} style={{ marginBottom: 12 }} />
        {issuedSecret && (
          <>
            <Typography.Paragraph style={{ marginBottom: 8 }}>
              <Text type="secondary">{t('taskDetail.webhook.url')}</Text>
              <Typography.Text code copyable style={{ fontSize: 12 }}>
                {issuedSecret.url}
              </Typography.Text>
            </Typography.Paragraph>
            <Typography.Text code copyable style={{ fontSize: 12, wordBreak: 'break-all' }}>
              {issuedSecret.secret}
            </Typography.Text>
          </>
        )}
      </Modal>

      {/* 触发弹窗 */}
      <Modal
        title={<Space><ThunderboltOutlined /> {t('taskDetail.triggerTitle')}</Space>}
        open={triggerModalOpen}
        onCancel={() => setTriggerModalOpen(false)}
        onOk={handleTriggerConfirm}
        okText={t('taskDetail.trigger')}
        okButtonProps={{ loading: triggering, icon: <ThunderboltOutlined /> }}
        cancelText={t('taskDetail.cancel')}
        width={520}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          title={t('taskDetail.runtimeParamsTitle')}
          description={t('taskDetail.runtimeParamsDesc')}
          style={{ marginBottom: 16 }}
        />
        <Form layout="vertical">
          <Form.Item label={t('taskDetail.field.execParams')}>
            <ParamsEditor
              value={triggerParams}
              onChange={setTriggerParams}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* AI 调度建议弹窗 */}
      <Modal
        title={<Space><RobotOutlined /> {t('taskDetail.aiSuggestion')}</Space>}
        open={aiModalOpen}
        onCancel={() => setAiModalOpen(false)}
        footer={[
          aiSuggestion?.suggestedCron && (
            <Button key="apply" type="primary" onClick={() => {
              nav(`/tasks/${id}/edit?suggestCron=${encodeURIComponent(aiSuggestion.suggestedCron)}`);
              setAiModalOpen(false);
            }}>{t('taskDetail.applyCron')}</Button>
          ),
          <Button key="close" onClick={() => setAiModalOpen(false)}>{t('taskDetail.close')}</Button>,
        ]}
        width={560}
      >
        {aiLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><PageSkeleton variant="table" rows={2} /></div>
        ) : aiSuggestion ? (
          <div>
            <Descriptions size="small" column={1} bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label={t('taskDetail.ai.successRate')}>{(aiSuggestion.successRate * 100).toFixed(1)}%</Descriptions.Item>
              <Descriptions.Item label={t('taskDetail.ai.p95')}>{aiSuggestion.p95Duration ? `${(aiSuggestion.p95Duration / 1000).toFixed(1)}s` : '-'}</Descriptions.Item>
              <Descriptions.Item label={t('taskDetail.ai.currentCron')}>{aiSuggestion.currentCron || t('taskDetail.ai.none')}</Descriptions.Item>
              <Descriptions.Item label={t('taskDetail.ai.suggestedCron')}><Text code style={{ color: token.colorSuccess }}>{aiSuggestion.suggestedCron || t('taskDetail.ai.noSuggestion')}</Text></Descriptions.Item>
            </Descriptions>
            {aiSuggestion.reasoning && (
              <Card size="small" title={t('taskDetail.ai.analysisTitle')}>
                <Text style={{ whiteSpace: 'pre-wrap' }}>{aiSuggestion.reasoning}</Text>
              </Card>
            )}
          </div>
        ) : null}
      </Modal>

      {/* CORE-03 收尾：保存为自定义模板弹窗——config 由 extractTemplateConfigFromTask
          白名单抽取（CreateTaskDto 子集，后端 forbidNonWhitelisted 校验），此处只填模板元信息 */}
      <Modal
        title={<Space><SaveOutlined /> {t('taskDetail.tpl.title')}</Space>}
        open={tplModalOpen}
        onCancel={() => setTplModalOpen(false)}
        onOk={handleSaveAsTemplate}
        okText={t('taskDetail.tpl.ok')}
        okButtonProps={{ loading: tplSaving, 'data-testid': 'tpl-save-confirm' }}
        cancelText={t('taskDetail.cancel')}
        width={520}
        destroyOnHidden
      >
        <Form form={tplForm} layout="vertical">
          <Form.Item
            name="name"
            label={t('taskDetail.tpl.name')}
            rules={[{ required: true, whitespace: true, message: t('taskDetail.tpl.nameRequired') }]}
          >
            <Input placeholder={t('taskDetail.tpl.namePlaceholder')} maxLength={128} data-testid="tpl-name-input" />
          </Form.Item>
          <Form.Item name="description" label={t('taskDetail.tpl.description')}>
            <Input.TextArea rows={2} placeholder={t('taskDetail.tpl.descriptionPlaceholder')} maxLength={500} data-testid="tpl-desc-input" />
          </Form.Item>
          <Form.Item name="category" label={t('taskDetail.tpl.category')}>
            <Input placeholder={t('taskDetail.tpl.categoryPlaceholder')} maxLength={32} data-testid="tpl-category-input" />
          </Form.Item>
        </Form>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('taskDetail.tpl.note')}
        </Typography.Text>
      </Modal>

      {/* A5（第二轮审计）：版本历史 Drawer——版本列表（勾选两个可对比）+ diff
          键值表 + 回滚确认弹窗（见下方 Modal）。刷新按钮复用 taskDetail.refresh。 */}
      <Drawer
        title={<Space><HistoryOutlined /> {t('taskDetail.version.title')}</Space>}
        placement="right"
        // antd 6：width 已并入 size（number|string|'large'|'default'）——
        // 窄屏 '100%' 满宽，桌面 720px 固定宽（R5-A 先例同款迁移）
        size={isMobile ? '100%' : 720}
        open={versionDrawerOpen}
        onClose={() => setVersionDrawerOpen(false)}
        afterOpenChange={drawerA11y.afterOpenChange}
        destroyOnHidden
      >
        {/* A11Y-DRAWER-01：内容包一层 ref 定位容器——焦点首站查询收窄到本抽屉 */}
        <div ref={drawerA11y.contentRef}>
        <Space style={{ marginBottom: 12 }} wrap>
          <Button size="small" icon={<ReloadOutlined />} loading={versionsLoading} onClick={loadVersions}>
            {t('taskDetail.refresh')}
          </Button>
          <Tooltip title={pickedVersionIds.length === 2 ? undefined : t('taskDetail.version.compareHint')}>
            <Button
              size="small"
              type="primary"
              data-testid="version-compare"
              disabled={pickedVersionIds.length !== 2}
              loading={diffLoading}
              onClick={handleCompareVersions}
            >
              {t('taskDetail.version.compare')}
            </Button>
          </Tooltip>
        </Space>
        {versionDiff && (
          <Card
            size="small"
            title={t('taskDetail.version.diff.title')}
            style={{ marginBottom: 16 }}
            extra={
              // A11Y-ICON-01：纯图标「收起差异」按钮补可访问名（无 Tooltip 包裹，
              // 此前对读屏器完全匿名）
              <Button
                type="text" size="small" icon={<CloseCircleOutlined />}
                aria-label={t('taskDetail.version.diff.close')}
                onClick={() => setVersionDiff(null)}
              />
            }
          >
            {diffRows.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('taskDetail.version.diff.empty')} />
            ) : (
              <Table
                rowKey="key"
                size="small"
                pagination={false}
                dataSource={diffRows}
                scroll={{ x: 560 }}
                columns={[
                  {
                    title: t('taskDetail.version.diff.key'),
                    dataIndex: 'key',
                    width: 170,
                    render: (k: string) => <Text code style={{ fontSize: 12 }}>{k}</Text>,
                  },
                  {
                    title: t('taskDetail.version.diff.old'),
                    dataIndex: 'old',
                    render: (v: unknown) => (
                      <Text type="danger" style={{ fontSize: 12, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                        {formatDiffValue(v)}
                      </Text>
                    ),
                  },
                  {
                    title: t('taskDetail.version.diff.new'),
                    dataIndex: 'new',
                    render: (v: unknown) => (
                      <Text style={{ fontSize: 12, fontFamily: 'monospace', wordBreak: 'break-all', color: token.colorSuccess }}>
                        {formatDiffValue(v)}
                      </Text>
                    ),
                  },
                ]}
              />
            )}
          </Card>
        )}
        <Table<TaskVersion>
          rowKey="id"
          size="small"
          loading={versionsLoading}
          dataSource={versions}
          columns={versionColumns}
          pagination={false}
          rowSelection={{
            selectedRowKeys: pickedVersionIds,
            // 最多勾两个：超出时保留最近两次勾选（对比恰好取这两个）。
            onChange: (keys) => setPickedVersionIds(keys.slice(-2).map(String)),
          }}
          locale={{
            emptyText: (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('taskDetail.version.empty')} />
            ),
          }}
        />
        </div>
      </Drawer>

      {/* A5：回滚确认弹窗——明确告知覆盖影响（当前配置被快照整体覆盖、追加新
          版本记录、运行中执行不受影响），防误触。 */}
      <Modal
        title={t('taskDetail.version.rollbackTitle', { version: rollbackTarget?.version ?? '' })}
        open={!!rollbackTarget}
        onOk={handleRollbackConfirm}
        okText={t('taskDetail.version.rollback')}
        okButtonProps={{ danger: true, loading: rollingBack, 'data-testid': 'version-rollback-confirm' }}
        cancelText={t('taskDetail.cancel')}
        onCancel={() => setRollbackTarget(null)}
        width={520}
        destroyOnHidden
      >
        <Alert type="warning" showIcon title={t('taskDetail.version.rollbackDesc')} />
      </Modal>
    </div>
  );
}