import { useEffect, useState, useCallback, lazy, Suspense } from 'react';
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
  TaskVersion,
  VersionDiff,
  TaskWebhookSecretIssued,
  TaskWebhookStatus,
} from '../api/tasks';
import {
  useSchedulerStats,
  useTaskDetail,
  useTaskExecutions,
  useTaskStats,
  invalidateTaskData,
  queryKeys,
} from '../api/queries';
import { taskTemplatesApi } from '../api/task-templates';
import { aiApi, ScheduleSuggestion } from '../api/ai';
import { getErrMsg, showApiError } from '../utils/error';
// UX-06：触发方式展示标签唯一事实源（此前直接渲染裸枚举）。
import { triggerLabel, TRIGGER_COLOR } from '../utils/trigger-label';
// D-P2-02a（设计审计）：运行时枚举本地化唯一事实源
import { runtimeLabel } from '../utils/runtime-label';
import { formatDateTime, formatDuration, formatRelativeTime } from '../utils/timeFormat';
// CRON-DESC-01：Cron 表达式的人类可读描述（utils/cron-desc.ts）
import { describeCron } from '../utils/cron-desc';
// F-27（DEEP_REVIEW 0ef3bbe）：失败次数派生（纯函数，保证整数）
import { failedRunCount } from './task-stats';
// CORE-03 收尾：保存为自定义模板的 config 白名单抽取
import { extractTemplateConfigFromTask } from '../utils/task-template-extract';
// python_task_multiversion（P2-3）：旧任务没有 codeSource 列时按迁移同序推导展示
import { deriveCodeSourceFromTask } from './executor-mode';
import { useTranslation } from 'react-i18next';
import { useAuthStore, isAdminUser } from '../store/auth';
import '../i18n';
// PERF（第四轮审计）：GlueEditor 拖带 monaco（约 2.5MB raw 的 lazy chunk）。
// 此前静态 import 让详情页 route chunk 与 GlueEditor chunk 产生**静态边**——
// 用户哪怕只看「任务配置」Tab，路由加载时也会整包预取编辑器。改 React.lazy：
// antd Tabs 非激活面板不渲染，动态 import 只在用户切到「Glue 脚本」Tab 时才
// 发起；Suspense 给 Spin 占位。monaco 不进首屏的构建面守卫见
// __tests__/monaco-first-paint.perf01.test.ts（读 dist 产物断言）。
const GlueEditor = lazy(() => import('../components/GlueEditor'));
import TaskDependencyGraph from '../components/TaskDependencyGraph';
import { priorityTag } from '../utils/priority';
import ParamsEditor from '../components/ParamsEditor';
import ArtifactsList from '../components/ArtifactsList';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/PageSkeleton';
// 版本历史抽屉窄屏满宽（R5-A 先例：AgentSessions/Projects 同款迁移）
import { useIsMobile } from '../hooks/useIsMobile';

const { Text } = Typography;

/**
 * O-4：触发执行后延迟多久刷新执行列表。
 *
 * 触发接口返回只代表「已入队」，执行记录由调度器异步落库——立即 invalidate
 * 大概率拿到「还没有新记录」的旧列表。此处给一个缓冲期再 invalidate，使新执行
 * 有机会出现在列表里。抽常量并注释依据，避免魔法数字散落（AppDeploymentPage
 * 同处亦用相近量级）。后续若后端触发接口改为同步返回 executionId，可直接
 * invalidate 并按 id 聚焦，无需再等待。
 */
const TRIGGER_REFRESH_DELAY_MS = 1500;

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

type BadgeStatus = 'success' | 'processing' | 'error' | 'default' | 'warning';
const STATUS_COLOR: Record<string, BadgeStatus> = {
  pending: 'default', running: 'processing', success: 'success',
  failed: 'error', timeout: 'warning', killed: 'error', cancelled: 'default',
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
  const [execPage, setExecPage] = useState(1);
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<ScheduleSuggestion | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [triggerModalOpen, setTriggerModalOpen] = useState(false);

  // FEAT-21: 任务 webhook 管理。secret 只在 enable/rotate 响应中一次性出现，
  // 关闭弹窗即丢弃——后端读面永不回传。
  const [webhookStatus, setWebhookStatus] = useState<TaskWebhookStatus | null>(null);
  const [issuedSecret, setIssuedSecret] = useState<TaskWebhookSecretIssued | null>(null);

  // 防重复提交（排查清单 #2）：webhook 三个写操作此前无任何 in-flight 标记，
  // 双击「启用/轮换」会连发两次请求——rotate 尤其有害：每次调用都吊销旧密钥并
  // 签发新密钥，第一发的明文弹窗会被第二发覆盖，用户保存的密钥其实已失效。
  // 互斥串行（任一在途即禁用全部三个按钮），与 killingId/togglingId 同款纪律。
  const [webhookBusy, setWebhookBusy] = useState<null | 'enable' | 'rotate' | 'disable'>(null);

  const loadWebhookStatus = useCallback(() => {
    if (!id) return;
    tasksApi.webhookStatus(id)
      .then(setWebhookStatus)
      .catch(() => setWebhookStatus(null));
  }, [id]);

  useEffect(() => {
    loadWebhookStatus();
  }, [loadWebhookStatus]);

  const handleWebhookEnable = async () => {
    if (!id || webhookBusy) return;
    setWebhookBusy('enable');
    try {
      setIssuedSecret(await tasksApi.webhookEnable(id));
      loadWebhookStatus();
    } catch (err) {
      showApiError(err, t('taskDetail.webhook.title'));
    } finally {
      setWebhookBusy(null);
    }
  };

  const handleWebhookRotate = async () => {
    if (!id || webhookBusy) return;
    setWebhookBusy('rotate');
    try {
      setIssuedSecret(await tasksApi.webhookRotate(id));
      loadWebhookStatus();
    } catch (err) {
      showApiError(err, t('taskDetail.webhook.title'));
    } finally {
      setWebhookBusy(null);
    }
  };

  const handleWebhookDisable = async () => {
    if (!id || webhookBusy) return;
    setWebhookBusy('disable');
    try {
      await tasksApi.webhookDisable(id);
      setWebhookStatus((prev) => (prev ? { ...prev, enabled: false } : prev));
    } catch (err) {
      showApiError(err, t('taskDetail.webhook.title'));
    } finally {
      setWebhookBusy(null);
    }
  };
  const [triggerParams, setTriggerParams] = useState<Record<string, string>>({});
  const [triggering, setTriggering] = useState(false);
  const [killingId, setKillingId] = useState<string | null>(null);
  const [toggleLoading, setToggleLoading] = useState(false);
  // CORE-03 收尾：保存为自定义模板 Modal
  const [tplModalOpen, setTplModalOpen] = useState(false);
  const [tplForm] = Form.useForm<{ name: string; description?: string; category?: string }>();
  const [tplSaving, setTplSaving] = useState(false);
  // GLUE-DIRTY-01：Glue 脚本编辑器有未保存改动时拦截浏览器关闭/刷新——
  // 详情页没有表单 dirty 语义，beforeunload 是唯一守卫层。
  const [glueDirty, setGlueDirty] = useState(false);
  // A5（第二轮审计）：版本历史 Drawer——后端 versions / rollbackToVersion /
  // compareVersions 三端点此前前端零调用（功能空洞）。装配：
  //   列表（版本号/时间/创建者）→ 勾选两个版本 compareVersions 出 diff 键值表
  //   → 每行「回滚到此版本」带确认 Modal（说明覆盖影响）→ 成功后刷新任务+列表。
  const [versionDrawerOpen, setVersionDrawerOpen] = useState(false);
  const [versions, setVersions] = useState<TaskVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  // 最多勾两个：超出时保留最近两次勾选（rowSelection onChange 里裁剪）。
  const [pickedVersionIds, setPickedVersionIds] = useState<string[]>([]);
  const [versionDiff, setVersionDiff] = useState<VersionDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  // 回滚确认弹窗的目标版本（null = 关闭）。
  const [rollbackTarget, setRollbackTarget] = useState<TaskVersion | null>(null);
  const [rollingBack, setRollingBack] = useState(false);

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

  const handleAiSuggest = async () => {
    if (!id) return;
    setAiLoading(true);
    setAiModalOpen(true);
    try {
      const result = await aiApi.suggestSchedule(id);
      setAiSuggestion(result);
    } catch (err: unknown) {
      showApiError(err, t('taskDetail.aiAnalyzeFail'));
      setAiModalOpen(false);
    } finally {
      setAiLoading(false);
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
  // 直接走 tasksApi + 本地 state（与上方 webhookStatus 同款模式）：queries.ts
  // 未提供版本 hooks，且版本数据只在 Drawer 打开时需要。
  const loadVersions = useCallback(() => {
    if (!id) return;
    setVersionsLoading(true);
    tasksApi.versions(id)
      .then(setVersions)
      .catch((err: unknown) => {
        setVersions([]);
        showApiError(err, t('taskDetail.version.loadFail'));
      })
      .finally(() => setVersionsLoading(false));
  }, [id, t]);

  useEffect(() => {
    if (versionDrawerOpen) {
      // 每次打开重置上次会话的勾选与 diff，避免跨任务/跨会话串数据。
      setPickedVersionIds([]);
      setVersionDiff(null);
      loadVersions();
    }
  }, [versionDrawerOpen, loadVersions]);

  const handleCompareVersions = async () => {
    if (!id || pickedVersionIds.length !== 2) return;
    setDiffLoading(true);
    try {
      setVersionDiff(
        await tasksApi.compareVersions(id, pickedVersionIds[0], pickedVersionIds[1]),
      );
    } catch (err: unknown) {
      showApiError(err, t('taskDetail.version.diffFail'));
    } finally {
      setDiffLoading(false);
    }
  };

  const handleRollbackConfirm = async () => {
    if (!id || !rollbackTarget) return;
    setRollingBack(true);
    try {
      await tasksApi.rollbackToVersion(id, rollbackTarget.id);
      message.success(
        t('taskDetail.version.rollbackSuccess', { version: rollbackTarget.version }),
      );
      setRollbackTarget(null);
      setVersionDiff(null);
      setPickedVersionIds([]);
      // 回滚改写任务配置并追加新版本——任务面 + 版本列表双刷新。
      refreshTask();
      loadVersions();
    } catch (err: unknown) {
      showApiError(err, t('taskDetail.version.rollbackFail'));
    } finally {
      setRollingBack(false);
    }
  };

  const { data: schedulerStats } = useSchedulerStats();

  const { data: task, isLoading: taskLoading, error: taskError } = useTaskDetail(id);

  const { data: execData, isLoading: execLoading } = useTaskExecutions(id, {
    page: execPage,
    pageSize: 20,
  });

  const { data: taskStats } = useTaskStats(id);

  const executions: TaskExecution[] = execData?.items ?? [];
  const execTotal: number = execData?.total ?? 0;

  const handleTrigger = () => {
    // 预填默认参数，让用户可以按需覆盖
    setTriggerParams(
      Object.fromEntries(
        Object.entries(task?.params ?? {}).map(([k, v]) => [k, String(v)])
      )
    );
    setTriggerModalOpen(true);
  };

  const handleTriggerConfirm = async () => {
    setTriggering(true);
    try {
      // 只传非空参数
      const params = Object.fromEntries(
        Object.entries(triggerParams).filter(([k]) => k.trim())
      );
      await tasksApi.trigger(id!, Object.keys(params).length > 0 ? params : undefined);
      message.success(t('taskDetail.triggerSuccess'));
      setTriggerModalOpen(false);
      setTimeout(refreshExecs, TRIGGER_REFRESH_DELAY_MS);
    } catch (err: unknown) {
      showApiError(err, t('taskDetail.triggerFail'));
    } finally {
      setTriggering(false);
    }
  };

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

  // UI-08：首屏骨架屏替代裸 Spin
  if (taskLoading && !task) return <PageSkeleton variant="table" rows={6} style={{ padding: 24 }} />;
  // U7: 请求失败 ≠ 任务不存在——错误态给重试入口，数据确空才显示 Empty
  if (!task && taskError) {
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
      render: (s: string) => <Badge status={STATUS_COLOR[s] ?? 'default'} text={statusLabels[s] || s} />,
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
      render: (v: string) => v ? (
        <Tooltip title={v}>
          <Text style={{ fontSize: 11, fontFamily: 'monospace' }}>{v}</Text>
        </Tooltip>
      ) : <Text type="secondary">-</Text>,
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
                <Button type="text" size="small" danger icon={<StopOutlined />}
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
          {schedulerStats && (
            <>
              <Tag style={{ fontSize: 11 }}>{t('taskDetail.stat.activeTimers', { count: schedulerStats.activeTimers })}</Tag>
              <Tag style={{ fontSize: 11 }}>{t('taskDetail.stat.activeCron', { count: schedulerStats.activeCronTasks })}</Tag>
              <Tag color="processing" style={{ fontSize: 11 }}>{t('taskDetail.stat.running', { count: schedulerStats.runningTaskCount })}</Tag>
            </>
          )}
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
                    <Tag color={webhookStatus?.enabled ? 'success' : 'default'}>
                      {webhookStatus?.enabled ? t('taskDetail.webhook.enabled') : t('taskDetail.webhook.disabled')}
                    </Tag>
                  </Space>
                }
              >
                {webhookStatus?.enabled ? (
                  <>
                    <Typography.Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 12 }}>
                      {t('taskDetail.webhook.desc')}
                    </Typography.Paragraph>
                    <Typography.Paragraph style={{ marginBottom: 8 }}>
                      <Text type="secondary">{t('taskDetail.webhook.url')}：</Text>
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
              <Text type="secondary">{t('taskDetail.webhook.url')}：</Text>
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
        destroyOnHidden
      >
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
              <Button type="text" size="small" onClick={() => setVersionDiff(null)} icon={<CloseCircleOutlined />} />
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