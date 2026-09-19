import { useState, useEffect, useMemo, useRef } from 'react';
import {
  deriveExecutorMode,
  buildExecutorPayload,
  affinityFormValues,
  applyRequirementsPayload,
  // python_task_multiversion（FR-06/FR-18）：runtimeVersion 声明 + codeSource 互斥
  applyRuntimeVersionPayload,
  applyCodeSourcePayload,
  deriveCodeSourceFromTask,
  deriveRuntimeMismatch,
  normalizeRuntimeVersion,
  interpreterFleetAdvisory,
  runtimeVersionIsOfflineTier,
  configureRuntimeVersionConfig,
  type CodeSource,
  type ExecutorInterpreterCapability,
} from './executor-mode';
// PK-02（DEEP_REVIEW 0ef3bbe）：create/update 改用生成的 DTO 类型，
// payload 由 apply* 链组装后类型收窄为 Record<string, unknown>，调用点显式断言。
import type { components } from '../types/generated/api-types';
import {
  Card, Form, Input, Select, Button, Space, Typography,
  InputNumber, Radio, Alert, message, Divider, Tag, Tooltip, Anchor, theme, Modal, Grid,
} from 'antd';
import {
  ThunderboltOutlined, ArrowLeftOutlined,
  InfoCircleOutlined, ClusterOutlined, RocketOutlined, ApartmentOutlined, PushpinOutlined,
  PlusOutlined, DeleteOutlined, ToolOutlined, LockOutlined, SaveOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { configApi } from '../api/config';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';
import { taskTemplatesApi } from '../api/task-templates';
// TASK-PROJ-01: 归属项目候选（任务可归入某项目；不选 = 未分配）
import { projectsApi } from '../api/projects';
import { getErrMsg, isFormValidationError } from '../utils/error';
import { templateConfigFromFormValues } from '../utils/task-template-config-from-form';
import {
  templateConfigToFormValues,
  templateTriggerAndRuntime,
} from './task-template-prefill';
import { CronHelper } from '../components/CronHelper';
import { TASK_PRIORITY_OPTIONS, toPriorityValue } from '../utils/priority';
import ParamsEditor from '../components/ParamsEditor';
import GlueEditor from '../components/GlueEditor';
import AlarmConfig from '../components/AlarmConfig';
import PageSkeleton from '../components/PageSkeleton';
import TriggerPreview from '../components/task-form/TriggerPreview';
// python_task_multiversion（FR-06/AC-06a/AC-06b）：Python 版本组合框。
// 独立成组件的原因见其头注释（useWatch 必须在无条件渲染的组件内，否则
// TaskFormPage 的 loadingTask 早退会让 hook 数随分支变化）。
import RuntimeVersionField from '../components/task-form/RuntimeVersionField';
import {
  applyMaintenanceWindowsPayload,
  MAINTENANCE_WINDOWS_MAX,
} from './maintenance-windows';
import {
  applyTimeoutPolicyPayload,
  timeoutPolicyFormValues,
  TIMEOUT_WARN_RATIO_MAX,
  TIMEOUT_ACTION_OPTIONS,
} from './timeout-policy';
import {
  applyRetryableErrorsPayload,
  retryableErrorsFormValues,
  RETRYABLE_ERROR_OPTIONS,
} from './retry-policy';
import {
  applyDependenciesPayload,
  dependenciesFormValues,
} from './task-dependencies';
// F-28（DEEP_REVIEW 0ef3bbe）：fixed_rate 输入框的分钟/秒换算纯逻辑层
import { fixedRateToMinutesLabel, parseFixedRateSeconds } from './fixed-rate';
import PageHeader from '../components/PageHeader';
import { useTranslation } from 'react-i18next';
import '../i18n';

const { Text } = Typography;

const TRIGGER_OPTIONS = (t: (k: string) => string) => [
  { value: 'manual', label: t('taskForm.trigger.manual'), desc: t('taskForm.trigger.manualDesc') },
  { value: 'cron', label: t('taskForm.trigger.cron'), desc: t('taskForm.trigger.cronDesc') },
  { value: 'fixed_rate', label: t('taskForm.trigger.fixedRate'), desc: t('taskForm.trigger.fixedRateDesc') },
];

const RUNTIME_OPTIONS = [
  { value: 'python', label: 'Python' },
  { value: 'node', label: 'Node.js' },
  { value: 'shell', label: 'Shell' },
];

// Executor dispatch modes exposed to the user
const EXECUTOR_MODE_OPTIONS = (t: (k: string) => string) => [
  {
    value: 'auto',
    label: t('taskForm.executor.auto'),
    desc: t('taskForm.executor.autoDesc'),
    icon: <ClusterOutlined />,
  },
  {
    value: 'group',
    label: t('taskForm.executor.group'),
    desc: t('taskForm.executor.groupDesc'),
    icon: <ApartmentOutlined />,
  },
  {
    value: 'pinned',
    label: t('taskForm.executor.pinned'),
    desc: t('taskForm.executor.pinnedDesc'),
    icon: <PushpinOutlined />,
  },
  {
    value: 'broadcast',
    label: t('taskForm.executor.broadcast'),
    desc: t('taskForm.executor.broadcastDesc'),
    icon: <RocketOutlined />,
  },
];

// CORE-02/CORE-04/priority：外部工具文件的选项 label 为中文，这里按 value 映射翻译
const TIMEOUT_ACTION_LABELS = (t: (k: string) => string): Record<string, string> => ({
  kill: t('taskForm.timeoutAction.kill'),
  kill_retry: t('taskForm.timeoutAction.killRetry'),
  notify_only: t('taskForm.timeoutAction.notifyOnly'),
});

const PRIORITY_LABELS = (t: (k: string) => string): Record<string, string> => ({
  1: t('taskForm.priority.low'),
  2: t('taskForm.priority.normal'),
  3: t('taskForm.priority.high'),
  4: t('taskForm.priority.critical'),
});

// python_task_multiversion（FR-18/AC-17b）：代码来源三选一 → 表单控件。
// 与 executor-mode.CodeSource 一一对应；desc 说明「该来源下代码从哪来」，
// 因为这三个选项对用户而言差别只在"执行器去哪拿代码"。
const CODE_SOURCE_OPTIONS = (
  t: (k: string) => string,
): { value: CodeSource; label: string; desc: string }[] => [
  {
    value: 'git',
    label: t('taskForm.field.codeSource.git'),
    desc: t('taskForm.field.codeSource.gitDesc'),
  },
  {
    value: 'application_zip',
    label: t('taskForm.field.codeSource.applicationZip'),
    desc: t('taskForm.field.codeSource.applicationZipDesc'),
  },
  {
    value: 'glue',
    label: t('taskForm.field.codeSource.glue'),
    desc: t('taskForm.field.codeSource.glueDesc'),
  },
];

// UI-06: 单页分区锚点。全部 Form.Item 同时挂载，锚点条只负责滚动定位。
const SECTION_IDS = ['sec-basic', 'sec-trigger', 'sec-executor', 'sec-params', 'sec-glue'] as const;

export default function TaskFormPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { id: editId } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const appId = searchParams.get('applicationId');
  // CORE-03：创建态带 ?templateId= 时，拉取模板 config 预填表单（显式可改）。
  const templateId = searchParams.get('templateId');
  // F-04（DEEP_REVIEW @0ef3bbe）：详情页「应用建议 Cron」带 ?suggestCron= 跳转
  // 编辑页（此前全仓无消费方=死链）。
  const suggestCron = searchParams.get('suggestCron');
  const isEdit = !!editId;

  const [form] = Form.useForm();
  const [triggerType, setTriggerType] = useState('manual');
  // UI-12：校验失败的读屏播报（antd message 是浮层，读屏不会回读）
  const [validationAnnouncement, setValidationAnnouncement] = useState('');
  const [executorMode, setExecutorMode] = useState<'auto' | 'group' | 'pinned' | 'broadcast'>('auto');
  const [groups, setGroups] = useState<string[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [executors, setExecutors] = useState<{
    id: string;
    appName: string;
    address: string;
    status: string;
    // python_task_multiversion（P2-4）：缓存池清单供版本能力咨询使用。
    // null = 旧执行器未上报（与 [] 池空是相反两态，判据在 executor-mode）。
    interpreters?: ExecutorInterpreterCapability[] | null;
  }[]>([]);
  /**
   * python_task_multiversion（AC-19a）：候选应用带 **runtime**——zip 来源要求
   * 应用 runtime 与任务 runtime 一致，表单需就地提示（服务端仍权威校验）。
   * runtime 可缺省：列表读面未回传时归 ''，deriveRuntimeMismatch 对空串不判定
   * （宁可不提示，也不拿未就绪的数据误报）。
   */
  const [apps, setApps] = useState<{ id: string; name: string; runtime: string }[]>([]);
  // TASK-PROJ-01: 归属项目候选（不选 = 未分配，归默认项目视图）
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  // TASK-PROJ-01: Select 选项（含显式"未分配"语义：allowClear 即可，不额外造选项）
  const projectOptions = useMemo(
    () => projects.map((p) => ({ value: p.id, label: p.name })),
    [projects],
  );
  // NF-02: 上游依赖选择——候选任务列表 + 名称快照（提交时重建 dependencies 映射）
  const [taskOptions, setTaskOptions] = useState<{ id: string; name: string }[]>([]);
  const depNameSnapshotRef = useRef<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [loadingTask, setLoadingTask] = useState(isEdit);
  const [showCronHelper, setShowCronHelper] = useState(false);
  // Glue: createdTaskId is set after create so GlueEditor can save to the real task id
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);
  const [savedRuntime, setSavedRuntime] = useState('python');

  // python_task_multiversion（FR-06）：声明的 Python 主.次版本。null = 不声明
  // （宿主默认解释器）。**刻意不入 antd 字段树**——RuntimeVersionField 是
  // "可选可手输"的受控组合框，中间态（正在输入尚未确认的文本）不应污染表单值；
  // 提交时由 applyRuntimeVersionPayload 显式合成 payload.runtimeVersion。
  // 仍持有 useState 而非 ref：值参与渲染（3.7 警示、宿主默认提示）。
  const [runtimeVersion, setRuntimeVersion] = useState<string | null>(null);

  // python_task_multiversion（FR-18/AC-17b）：代码来源三选一（受控 state，同
  // 理由）。编辑态初值由 deriveCodeSourceFromTask 推导——优先后端已回填的
  // codeSource，否则按 gitRepo > glueSource > applicationId 的迁移回填序推断。
  // previousCodeSource 是 applyCodeSourcePayload 的"离开 zip 才清 applicationId"
  // 判据：必须记住**任务原本的**来源，而不是上一次渲染的 state（后者在
  // 重渲染/回填竞态下不可靠），故用 ref 固化加载期推导结果。
  const [codeSource, setCodeSource] = useState<CodeSource>('git');
  const previousCodeSourceRef = useRef<CodeSource>('git');

  // FEAT-13：「保存为模板」弹窗（表单校验通过后把当前值固化为自定义模板）
  const [tplModalOpen, setTplModalOpen] = useState(false);
  const [tplSaving, setTplSaving] = useState(false);
  const [tplForm] = Form.useForm<{ name: string; description?: string; category?: string }>();

  // UI-06 ③：pinning/broadcast 互斥（N17 语义前置到输入期）。触发方式/时区
  // 经 Form.useWatch 订阅供预览组件消费（保持 render 同步且不整表单重渲）。
  const cronExpression = Form.useWatch('cronExpression', form);
  const fixedRateWatch = Form.useWatch('fixedRate', form);
  const timezoneWatch = Form.useWatch('timezone', form);
  // python_task_multiversion：zip 来源的运行时一致性提示需要实时读取两处值——
  // runtime 来自字段树（useWatch），applicationId 也走 useWatch 以便在**选中的
  // 应用**里查 runtime。二者都是无条件 hook 调用。
  const runtimeWatch = Form.useWatch('runtime', form);
  const applicationIdWatch = Form.useWatch('applicationId', form);
  const { token } = theme.useToken();
  // G-4：锚点条显隐改由 antd Grid 断点决定（lg 及以上才显示），
  // 不再用内联 display:none 硬编码（会覆盖外部 CSS 媒体查询）。
  const screens = Grid.useBreakpoint();

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const run = <T,>(request: Promise<T>, onSuccess: (data: T) => void, warning: string) => {
      request
        .then((data) => {
          if (active && !controller.signal.aborted) onSuccess(data);
        })
        .catch(() => {
          if (active && !controller.signal.aborted) message.warning(warning);
        });
    };

    run(executorsApi.getGroups(controller.signal), setGroups, t('taskForm.load.groupFail'));
    run(executorsApi.getTags(controller.signal), setAllTags, t('taskForm.load.tagsFail'));
    run(
      executorsApi.list(controller.signal),
      (data) =>
        setExecutors(
          data.map((e) => ({
            id: e.id as string,
            appName: e.appName as string,
            address: e.address as string,
            status: e.status as string,
            // P2-4：透传缓存池清单（后端 findAll 一直返回，此前读模型没接）。
            interpreters: e.interpreters ?? null,
          })),
        ),
      t('taskForm.load.executorsFail'),
    );
    run(
      applicationsApi.list(controller.signal),
      (data) => setApps(data.map((a) => ({ id: a.id, name: a.name, runtime: a.runtime ?? '' }))),
      t('taskForm.load.appsFail'),
    );
    // TASK-PROJ-01: 归属项目候选。失败只 warn（不阻塞表单）——未分配仍是合法
    // 取值，故取不到列表时退回"仅能选未分配"，而不是让整个表单不可用。
    run(
      projectsApi.list(),
      (data) => setProjects(data.map((p) => ({ id: p.id, name: p.name }))),
      t('taskForm.load.projectsFail'),
    );
    // NF-02: 上游依赖候选（分页拉全，取 id+name；编辑态在任务加载后过滤自身）
    tasksApi
      .listAll({}, controller.signal)
      .then((data) => {
        if (active && !controller.signal.aborted) {
          const opts = data.items.map((t) => ({ id: t.id, name: t.name }));
          setTaskOptions(opts);
          // NF-02：名称快照顺带按候选列表播种。此前 depNameSnapshot 只在**编辑
          // 态**由 task.dependencies 填充，创建态恒为 {}——于是创建态提交的
          // dependencies 映射退化为 `{ id: id }`（buildDependenciesPayload 的
          // 兜底分支）。依赖名虽只用于展示，但"存为模板/克隆"等通路依赖它还原
          // 编排关系的可读形态；播种后创建态也能带上真实任务名。
          // 不覆盖已有键（编辑态回填的任务自带映射是权威值）。
          for (const o of opts) {
            if (!depNameSnapshotRef.current[o.id]) {
              depNameSnapshotRef.current[o.id] = o.name;
            }
          }
        }
      })
      .catch(() => {
        if (active && !controller.signal.aborted) {
          message.warning(t('taskForm.load.tasksFail'));
        }
      });
    // python_task_multiversion：`?applicationId=` 是应用详情页的「用此应用建任务」
    // 入口，语义就是"以该应用整包为代码来源"，故同时把来源切到 application_zip
    // （否则用户看到的是 git 来源，提交时 applicationId 会被普通绑定语义悄悄留下）。
    // 仅创建态显式覆盖：编辑态的 `?applicationId=` 不改变任务原有来源声明。
    if (appId) {
      form.setFieldValue('applicationId', appId);
      if (!editId) {
        setCodeSource('application_zip');
        previousCodeSourceRef.current = 'application_zip';
      }
    }

    return () => {
      active = false;
      controller.abort();
    };
  }, [appId, editId, form, t]);

  // Load existing task data when in edit mode
  useEffect(() => {
    if (!editId) return;
    let active = true;
    const controller = new AbortController();
    setLoadingTask(true);
    tasksApi.get(editId, controller.signal)
      .then((task) => {
        if (!active || controller.signal.aborted) return;
        const mode = deriveExecutorMode(task);
        setExecutorMode(mode);
        setTriggerType(task.triggerType || 'manual');
        setSavedRuntime(task.runtime || 'python');
        // python_task_multiversion（FR-06/AC-06b/AC-17b）：编辑态回填自持 state。
        // runtimeVersion 存的是归一后的值（库内脏值/超区间值一律显示为"未声明"，
        // 不把非法值塞进组合框）；非法值不会因此丢失——它本就不该存在于库里，
        // 且提交侧 normalizeRuntimeVersion 会把它归 null。
        setRuntimeVersion(normalizeRuntimeVersion(task.runtimeVersion));
        const derivedSource = deriveCodeSourceFromTask(task);
        setCodeSource(derivedSource);
        previousCodeSourceRef.current = derivedSource;
        form.setFieldsValue({
          name: task.name,
          description: task.description,
          runtime: task.runtime,
          entrypoint: task.entrypoint,
          requirements: task.requirements ?? [],
          applicationId: task.applicationId,
          // python_task_multiversion（FR-18）：git 来源两字段与 glueSource 必须
          // 挂载并回填——applyCodeSourcePayload 的"自证"判定读的就是载荷里的这两
          // 个键（glue 分支靠 glueSource 非空才敢声明 codeSource='glue'）。不回填
          // 会让编辑态保存把这些值判成"未提供"从而清掉代码来源声明。
          // glueSource 的唯一写方是 GlueEditor（tasksApi.updateGlue），此处写回
          // 原值是幂等 no-op；空值归一 undefined 以免提交空串。
          gitRepo: task.gitRepo ?? undefined,
          gitBranch: task.gitBranch ?? undefined,
          glueSource: task.glueSource ?? undefined,
          // TASK-PROJ-01: 编辑态回填归属项目（null = 未分配 → undefined 让
          // Select 显示占位符，而不是把 "null" 当值）
          projectId: task.projectId ?? undefined,
          triggerType: task.triggerType || 'manual',
          cronExpression: task.cronExpression,
          timezone: task.timezone,
          fixedRate: task.fixedRate,
          priority: toPriorityValue(task.priority),
          timeout: task.timeoutSeconds ?? task.timeout ?? 300,
          // CORE-04: 超时策略（timeoutAction 缺省 kill；预警阈值空态 undefined）
          ...timeoutPolicyFormValues(task),
          maxRetry: task.maxRetry ?? 3,
          retryDelay: task.retryDelay ?? 0,
          // CORE-02: 可重试错误类型白名单（null/缺省 → 空数组占位=全部可重试）
          ...retryableErrorsFormValues(task),
          executorId: task.executorId ?? undefined,
          executorGroup: task.executorGroup,
          executorTags: task.executorTags,
          // NF-04: affinity constraints must be mounted and hydrated in edit mode;
          // otherwise the form submission would normalize absent values to null and
          // silently clear constraints that were never shown to the user.
          ...affinityFormValues(task),
          params: task.params ?? {},
          // 告警配置（alarmEmail / alarmChannels）：两列是任务级失败通知的唯一
          // 来源（notification.service.notifyFailureWithConfig 直接读 task 实体
          // 的这两列）。此前编辑态**完全没有回填**——前端 Task 接口连字段都没
          // 声明，于是打开已有任务的编辑页时两项恒显示空态；用户只是改个超时
          // 就保存，也会把已配好的接收人与渠道清掉（"界面看着是空的、保存即
          // 删库"）。空态刻意回 undefined 而非 []：undefined 不进请求体，PATCH
          // 缺省=保留旧值，与"用户没碰过这个控件"同义；真正的清空由 Select 的
          // allowClear 产出 []，提交侧原样发送即清除。
          alarmEmail: task.alarmEmail ?? undefined,
          alarmChannels: Array.isArray(task.alarmChannels) ? task.alarmChannels : undefined,
          // FEAT-06: 维护窗口（null/缺省 → 空数组占位，添加行即编辑）
          maintenanceWindows: (task.maintenanceWindows ?? []).map((w) => ({ ...w })),
          // FEAT-11: markdown 运行手册
          runbook: task.runbook ?? '',
        });
        // NF-02: 上游依赖回填（映射 → Select 值 + 名称快照供提交重建映射）
        const dep = dependenciesFormValues(task.dependencies);
        form.setFieldValue('upstreamDependencies', dep.selected);
        depNameSnapshotRef.current = dep.nameSnapshot;
      })
      .catch(() => {
        if (active && !controller.signal.aborted) message.error(t('taskForm.load.taskFailed'));
      })
      .finally(() => {
        if (active && !controller.signal.aborted) setLoadingTask(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [editId, form, t]);

  // CORE-03：创建态带 ?templateId= 时拉取模板，config 预填表单（显式字段仍可改；
  // name 一律由用户填写——模板 name 常含中文，不满足任务名 [a-z0-9_-] 约束）。
  useEffect(() => {
    if (!templateId || isEdit) return;
    let cancelled = false;
    taskTemplatesApi
      .get(templateId)
      .then((tpl) => {
        if (cancelled) return;
        form.setFieldsValue(templateConfigToFormValues(tpl.config));
        if (tpl.description) form.setFieldValue('description', tpl.description);
        setTriggerType(templateTriggerAndRuntime(tpl).triggerType);
        // python_task_multiversion（FR-06/FR-18）：`runtimeVersion` 与 `codeSource`
        // **不在表单字段树里**（前者由 RuntimeVersionField 自持 state，后者由来源
        // 选择器自持 state），因此 `setFieldsValue` 对它们无效——必须像编辑态回填
        // （见下方 tasksApi.get 分支）那样显式同步到 state，否则"从模板建任务"会
        // 显示成默认来源/git 且版本为空，用户看不出模板里其实钉了 3.7。
        //
        // runtimeVersion 走 normalizeRuntimeVersion：模板可能来自旧版本或手工编辑，
        // 脏值/超区间值一律显示为"未声明"而不是塞进组合框（与编辑态同一判据）。
        setRuntimeVersion(normalizeRuntimeVersion(tpl.config.runtimeVersion));
        const tplSource = deriveCodeSourceFromTask(tpl.config);
        setCodeSource(tplSource);
        previousCodeSourceRef.current = tplSource;
      })
      .catch(() => message.warning(t('taskForm.load.templateFailed')));
    return () => {
      cancelled = true;
    };
  }, [templateId, isEdit, form, t]);

  // F-04（DEEP_REVIEW @0ef3bbe）：AI 建议 Cron 应用——编辑态必须等任务回填
  // 完成后再覆盖 cronExpression，否则任务加载 effect 会用库内旧值盖掉建议值；
  // 创建态挂载即应用。cron 值不再二次校验（服务层 WIKI-OPT-3 已校验）。
  // 应用后立即清除 URL 参数（replace 导航，不新增历史记录），防止刷新后重复应用。
  useEffect(() => {
    if (!suggestCron) return;
    if (isEdit && loadingTask) return;
    form.setFieldValue('cronExpression', suggestCron);
    message.info(t('taskForm.suggestCronApplied', { cron: suggestCron }));
    const next = new URLSearchParams(searchParams);
    next.delete('suggestCron');
    setSearchParams(next, { replace: true });
  }, [suggestCron, isEdit, loadingTask, form, searchParams, setSearchParams, t]);

  // P0 (R8) 兜底保留为双保险：单页全挂载后 validateFields() 天然覆盖全部字段，
  // 以下 missing 收集逻辑在正常情况下永远为空集，仅作为防线存在。
  const handleSubmit = async () => {
    try {
      await form.validateFields();
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'errorFields' in err) {
        // UI-12：antd 只在字段旁标红（读屏不主动播报），此处补一条可播报摘要。
        //
        // 但**只有**这条 aria-live 区域是不够的：它是 1×1px 的
        // screen-reader-only 元素（见下方 style），视力正常的用户提交失败后
        // 屏幕**毫无变化**——尤其当出错的字段在滚动视口之外时（本表单是单页
        // 多区块的长表单），用户会以为"按钮没反应"而反复点击。
        //
        // 故补两条可见反馈：一条浮层提示（与其它校验路径一致），以及滚到第一个
        // 出错字段。两者都不改判定逻辑，只是把已经发生的失败**显式呈现**出来。
        const fields = (err as { errorFields?: { errors?: string[]; name?: (string | number)[] }[] })
          .errorFields ?? [];
        const firstError = fields[0]?.errors?.[0];
        if (firstError) {
          setValidationAnnouncement(
            t('taskForm.validate.failed', {
              firstError,
              more: fields.length > 1 ? t('taskForm.validate.more', { count: fields.length }) : '',
            }),
          );
          message.error(
            t('taskForm.validate.failed', {
              firstError,
              more: fields.length > 1 ? t('taskForm.validate.more', { count: fields.length }) : '',
            }),
          );
          // 滚到第一个出错字段（antd 的 name 路径 → 该字段的 DOM 节点）。
          const namePath = fields[0]?.name;
          if (namePath && namePath.length > 0) {
            form.scrollToField(namePath, { behavior: 'smooth', block: 'center' });
          }
        } else {
          // 没有可读的字段级错误时也要给一条反馈，绝不静默 return。
          message.error(t('taskForm.validate.fail'));
        }
        return;
      }
      // UX-11（本轮体验审查）：此前手写 `err instanceof Error ? err.message : ...`。
      // 它比直接取 `e.message` 好，但仍绕过了全站归一：axios 错误的 `message`
      // 是 "Request failed with status code 400" 这类英文技术串，真正的业务
      // 原因在 `response.data.message` 里。getErrMsg 同时覆盖这两种形状，且
      // 本文件第 39 行本就导入了它（同页其它错误路径已在用）——同页两套文案
      // 才是问题所在。
      message.error(getErrMsg(err, t('taskForm.validate.fail')));
      return;
    }
    const values = form.getFieldsValue(true);
    const missing: { label: string; anchor: string }[] = [];
    if (!values.name) missing.push({ label: t('taskForm.field.name'), anchor: SECTION_IDS[0] });
    if (!values.runtime) missing.push({ label: t('taskForm.field.runtime'), anchor: SECTION_IDS[0] });
    if (!values.entrypoint) missing.push({ label: t('taskForm.field.entrypoint'), anchor: SECTION_IDS[0] });
    if (values.triggerType === 'cron' && !values.cronExpression) {
      missing.push({ label: t('taskForm.field.cron'), anchor: SECTION_IDS[1] });
    }
    if (values.triggerType === 'fixed_rate' && !values.fixedRate) {
      missing.push({ label: t('taskForm.field.fixedRate'), anchor: SECTION_IDS[1] });
    }
    if (executorMode === 'pinned' && !values.executorId) {
      missing.push({ label: t('taskForm.field.executorId'), anchor: SECTION_IDS[2] });
    }
    // python_task_multiversion（FR-18）：zip 来源必须关联应用。缺了它后端
    // assertCodeSourceConsistent 会 400，但那时用户只看到一条接口错误；
    // 在这里拦下并滚到字段旁，与其它必填项一致的体验。
    if (zipApplicationMissing) {
      missing.push({ label: t('taskForm.field.applicationId.zipRequired'), anchor: SECTION_IDS[0] });
    }
    if (missing.length > 0) {
      const missingList = missing.map((m) => m.label).join('、');
      message.error(t('taskForm.missing', { list: missingList }));
      // UI-12：同步播报到 role="status" 区域（视觉路径=浮层 + 锚点滚动）
      setValidationAnnouncement(t('taskForm.missingShort', { list: missingList }));
      scrollToSection(missing[0].anchor);
      return;
    }
    setValidationAnnouncement('');
    // G-2：离线层（3.7）+ 在线舰队无一台缓存 = 提交后必然 interpreter_unavailable。
    // 不阻断（服务端仍是权威，在线层本就"先下载后有"），但用 Modal.confirm 把
    // "提交即失败"显式化——避免用户忽略 warning 直接提交，到执行时才排障。
    if (fleetOfflineWillFail) {
      const go = await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: t('taskForm.submit.offlineFleetConfirm.title'),
          content: t('taskForm.submit.offlineFleetConfirm.content'),
          okText: t('taskForm.submit.offlineFleetConfirm.ok'),
          cancelText: t('taskForm.submit.offlineFleetConfirm.cancel'),
          okButtonProps: { danger: true },
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
      if (!go) return;
    }
    setSaving(true);
    try {
      // QA-01：applyDependenciesPayload 必须包在最外层——它把表单载体字段
      // upstreamDependencies（DTO 未声明，forbidNonWhitelisted 会判 400）转成
      // DTO 声明的 dependencies 映射并删除载体键，须保证没有任何后续步骤再把
      // 载体键带回请求体（内层 buildExecutorPayload 会整体展开 values）。
      //
      // python_task_multiversion：applyRuntimeVersionPayload / applyCodeSourcePayload
      // 紧贴 buildExecutorPayload（即仍是"最靠近表单原始值"的两层），原因：
      //  - 两者都按**表单原始值**判定——gitRepo/glueSource/applicationId 需原样
      //    读（缺失即视为"本表单未提供"），runtimeVersion 则不在字段树里（组合框
      //    自持 state），必须经第二参显式传入。往后放会让上游各步写入的显式 null
      //    被误读成用户输入，改变自证判定。
      // 顺序（内 → 外）：
      //   buildExecutorPayload（执行器策略基座，不动上述任一字段）
      //   → applyRuntimeVersionPayload（runtime!=='python' 时显式 null）
      //   → applyCodeSourcePayload（互斥三通道，不适用字段显式 null）
      //   → applyRequirementsPayload（依赖渠道，**必须**在来源归一之后——
      //     AC-18b 红线：切换代码来源不得清掉 requirements）
      //   → 维护窗口/超时/重试 → applyDependenciesPayload（载体键删除）
      const payload = applyDependenciesPayload(
        applyRetryableErrorsPayload(
          applyTimeoutPolicyPayload(
            applyMaintenanceWindowsPayload(
              applyRequirementsPayload(
                applyCodeSourcePayload(
                  applyRuntimeVersionPayload(
                    buildExecutorPayload(values, executorMode),
                    runtimeVersion,
                  ),
                  codeSource,
                  previousCodeSourceRef.current,
                ),
              ),
            ),
          ),
        ),
        depNameSnapshotRef.current,
      );
      if (isEdit && editId) {
        await tasksApi.update(editId, payload);
        message.success(t('taskForm.submit.updated'));
        nav(`/tasks/${editId}`);
      } else {
        const created = await tasksApi.create(
          payload as components["schemas"]["CreateTaskDto"],
        );
        message.success(t('taskForm.submit.created'));
        setSavedRuntime(
          typeof payload.runtime === 'string' ? payload.runtime : 'python',
        );
        setCreatedTaskId(created.id);
        // 创建成功后滚到 Glue 区块（原 step3 语义：创建后进入 Glue 编排）
        setTimeout(() => scrollToSection(SECTION_IDS[4]), 50);
      }
    } catch (err: unknown) {
      // client.ts 的错误拦截器 reject 的是**普通对象**（err.response?.data || err），
      // 不是 Error 实例——`err instanceof Error` 对后端 400 恒 false，于是
      // assertCodeSourceConsistent / assertRuntimeVersionValid 返回的可操作
      // 文案被泛化的「创建失败」吞掉。getErrMsg 同时覆盖两种形状（与本文件
      // 模板保存等兄弟 catch 同策）。
      message.error(
        getErrMsg(
          err,
          isEdit ? t('taskForm.submit.updateFail') : t('taskForm.submit.createFail'),
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  const scrollToSection = (id: string) => {
    // jsdom 无布局引擎，Element.scrollIntoView 未实现——守卫后调用，
    // 真浏览器生效；测试环境静默跳过（纯定位增强，无业务语义）。
    document.getElementById(id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };

  // FEAT-13：「保存为模板」——先跑一遍表单校验（同提交门），通过后把当前值
  // 映射为 CreateTaskDto 子集 config（POST /task-templates 后端再以
  // whitelist + forbidNonWhitelisted 复验），弹小 Modal 收模板元信息。
  const openSaveAsTemplate = async () => {
    try {
      await form.validateFields();
    } catch (err: unknown) {
      if (isFormValidationError(err)) return;
      // UX-11：同 openSaveAsTemplate——统一走 getErrMsg（见上方注释）。
      message.error(getErrMsg(err, t('taskForm.validate.fail')));
      return;
    }
    // F-28（DEEP_REVIEW 0ef3bbe）：原为 `name: cond ? undefined : undefined` 死三元
    // （两分支同值），整段删除——模板名一律留给用户填写（表单 name 是任务标识，
    // 常不满足模板命名习惯）；弹窗 destroyOnHidden 已保证每次打开都是空表单。
    setTplModalOpen(true);
  };

  const handleSaveAsTemplate = async () => {
    let meta: { name: string; description?: string; category?: string };
    try {
      meta = await tplForm.validateFields();
    } catch (err: unknown) {
      if (isFormValidationError(err)) return;
      message.error(getErrMsg(err, t('taskForm.tpl.saveFail')));
      return;
    }
    const values = form.getFieldsValue(true);
    setTplSaving(true);
    // python_task_multiversion（FR-06 / FR-18）：`runtimeVersion` 与 `codeSource`
    // **不在表单字段树里**（前者由 RuntimeVersionField 自持 state，后者由
    // CodeSource 选择器自持 state），因此 `values` 上读不到它们——必须像提交路径
    // 那样经 applyRuntimeVersionPayload / applyCodeSourcePayload 归一后显式注入，
    // 否则模板会静默丢掉"Python 版本钉定"与"代码来源"这两个用户显式做过的选择。
    //
    // 复用提交路径的同一组纯函数（而不是在这里另写一遍判定），是为了让模板里
    // 存下的 codeSource 与真实提交时的取值**逐字一致**：两者都遵循同一条
    // "载荷自证才声明"规则（见 executor-mode.ts），否则从模板建出的任务会因
    // 声明漂移被后端 400。
    const tplValues = applyCodeSourcePayload(
      applyRuntimeVersionPayload(values, runtimeVersion),
      codeSource,
      previousCodeSourceRef.current,
    );
    // NF-02：上游依赖必须与提交路径同样归一后再固化。`dependencies` 不在表单
    // 字段树里（表单载体是 `upstreamDependencies`，DTO 未声明该键），直接拿
    // values 会让"存模板"静默丢掉用户选好的依赖链——从模板建出的任务没有上游
    // 编排关系，而用户在模板里看到的参数却都在，属最易被误判为"模板功能正常"
    // 的丢字段。applyDependenciesPayload 同时完成映射重建与载体键删除，与提交
    // 路径逐字一致（载体键不删会让后端 forbidNonWhitelisted 判 400）。
    const tplPayload = applyDependenciesPayload(tplValues, depNameSnapshotRef.current);
    try {
      await taskTemplatesApi.create({
        name: meta.name.trim(),
        description: meta.description?.trim() || undefined,
        category: meta.category?.trim() || undefined,
        config: templateConfigFromFormValues(
          tplPayload,
          buildExecutorPayload(tplPayload, executorMode),
        ),
      });
      message.success(t('taskForm.tpl.saved', { name: meta.name.trim() }));
      setTplModalOpen(false);
    } catch (err: unknown) {
      // validateFields 的 reject 是带 errorFields 的校验对象，不是请求错误——
      // 仅对真正的请求失败弹 toast，表单校验错误由 Form 自带红字呈现。
      if (isFormValidationError(err)) return;
      message.error(getErrMsg(err, t('taskForm.tpl.saveFail')));
    } finally {
      setTplSaving(false);
    }
  };

  const glueTaskId = createdTaskId || (isEdit ? editId : null);

  /**
   * python_task_multiversion（AC-19a/FR-19）：zip 来源的 runtime 一致性。
   * 只在 application_zip 来源下判定——其余来源下 applicationId 可能只是**部署
   * 绑定**（部署清单自动注册的任务就是 applicationId + glueSource 并存，后端
   * NFR-05 明确放行），对绑定关系报"运行时不一致"是纯粹的误报噪声。
   * 应用无 runtime / 尚未选应用 / 列表未加载 → deriveRuntimeMismatch 返回
   * null（不判定），交给服务端权威校验。
   */
  const zipRuntimeMismatch = useMemo(() => {
    if (codeSource !== 'application_zip') return null;
    const app = apps.find((a) => a.id === applicationIdWatch);
    if (!app) return null;
    return deriveRuntimeMismatch(runtimeWatch, app.runtime);
  }, [codeSource, apps, applicationIdWatch, runtimeWatch]);

  /** zip 来源未选应用（后端会 400，此处前置到提交前拦截并给出可读文案） */
  const zipApplicationMissing = codeSource === 'application_zip' && !applicationIdWatch;

  /**
   * G-1：把后端版本契约注入 executor-mode 的可注入配置。
   *
   * 此前 min/max/onlineMin/legacyDefault 在前端硬编码，注释明言"改动需两侧同步"；
   * 而后端 min/max 支持 PYTHON_RUNTIME_VERSION_MIN/MAX env 覆盖，运维一改，前端
   * 的区间提示（RuntimeVersionField）与舰队能力咨询就静默漂移。这里在打开表单时
   * 拉一次权威值注入纯函数层——纯函数仍保持无 React 依赖、可单测（测试用
   * resetRuntimeVersionConfig() 复位）。
   *
   * 失败一律**静默**（旧后端无此端点 / 网络错误）：沿用前端默认常量，且异常在
   * 此消化、不冒泡到 axios 拦截器，旧后端上不会凭空弹「资源不存在」toast。
   * 注入后 bump revision：下列消费配置的 useMemo 与 RuntimeVersionField 的
   * render 期读取都是**读取时才取值**，需一次重渲染才能让新契约生效。
   */
  const [runtimeVersionRevision, setRuntimeVersionRevision] = useState(0);
  useEffect(() => {
    let active = true;
    configApi
      .getRuntimeVersion()
      .then((cfg) => {
        if (!active || !cfg) return;
        configureRuntimeVersionConfig({
          min: cfg.min,
          max: cfg.max,
          onlineMin: cfg.onlineMin,
          legacyDefaultInterpreter: cfg.legacyDefaultInterpreter,
        });
        setRuntimeVersionRevision((r) => r + 1);
      })
      .catch(() => {
        // 端点不可达 → 静默沿用前端默认常量（见上方注释）
      });
    return () => { active = false; };
  }, []);

  /**
   * python_task_multiversion（P2-4）：版本能力的**读面咨询**（非阻断）。
   *
   * 声明了 runtimeVersion 时，若当前在线舰队没有一台的缓存池满足它，给一条
   * warning——但**绝不阻止提交**：AC-06c「解释器先下载后有」，在线层（3.8+）
   * 执行时仍可按需下载；只有离线层（3.7）必须由部署方预填缓存卷。后端刻意
   * 不做舰队级写前预检（会把"先下载后有"退化成同步依赖），故这里只补读面信号。
   * 无在线执行器 / 列表未加载 → 'unknown'，不提示，避免误报。
   */
  const interpreterFleet = useMemo(
    () => interpreterFleetAdvisory(executors, runtimeVersion),
    // G-1：契约注入后需重算（内部 legacyDefault 兜底读的是可注入配置）
    [executors, runtimeVersion, runtimeVersionRevision],
  );

  /**
   * G-2：必失败情形——离线层（3.7，uv 无法在线下载）且在线舰队无一台缓存它。
   * 与单纯 `unsatisfied` 不同：在线层（3.8+）执行时可按需下载，warning 足够；
   * 但 3.7 离线层舰队无缓存时，提交后必然以 interpreter_unavailable 失败。
   * 这里不阻断（服务端仍是权威），但提交时弹二次确认，把"提交即失败"显式化。
   */
  const fleetOfflineWillFail = useMemo(
    () =>
      runtimeWatch === 'python' &&
      interpreterFleet === 'unsatisfied' &&
      runtimeVersionIsOfflineTier(runtimeVersion),
    // G-1：同上——离线层判定读的是可注入配置的 onlineMin
    [runtimeWatch, interpreterFleet, runtimeVersion, runtimeVersionRevision],
  );

  const anchorItems = useMemo(
    () => [
      { key: SECTION_IDS[0], href: `#${SECTION_IDS[0]}`, title: t('taskForm.section.basic') },
      { key: SECTION_IDS[1], href: `#${SECTION_IDS[1]}`, title: t('taskForm.section.trigger') },
      { key: SECTION_IDS[2], href: `#${SECTION_IDS[2]}`, title: t('taskForm.section.executor') },
      { key: SECTION_IDS[3], href: `#${SECTION_IDS[3]}`, title: t('taskForm.section.params') },
      ...(glueTaskId
        ? [{ key: SECTION_IDS[4], href: `#${SECTION_IDS[4]}`, title: t('taskForm.section.glue') }]
        : []),
    ],
    [glueTaskId, t],
  );

  if (loadingTask) {
    // UI-08：首屏骨架屏替代裸 Spin（仅此加载区块；表单结构不动）
    return <PageSkeleton variant="table" rows={6} style={{ padding: 24 }} />;
  }

  // UI-06 ③：互斥禁用态。broadcast 下 pinned 选择器禁用；pinned 下广播项禁用。
  // 数据层互斥由 deriveExecutorMode/buildExecutorPayload 保证（N17/N28），
  // 这里把冲突挡在输入期，不再等提交报错。
  const broadcastDisabledByPin = executorMode === 'pinned';
  const pinDisabledByBroadcast = executorMode === 'broadcast';

  const sectionTitleStyle = { margin: '0 0 4px' };

  return (
    // UI 打磨（用户反馈）：去掉 maxWidth 1080——上限在宽屏右侧留大片空白，
    // 与 settings 等整宽页不一致；表单改随内容区全宽伸缩
    <div>
      {/* UI-03：页头标准化（原 Typography.Title 区块迁入 PageHeader，面包屑语义=任务→新建/编辑；
          原返回按钮保留于 extra 首位，行为不变） */}
      <PageHeader
        title={isEdit ? t('taskForm.title.edit') : t('taskForm.title.create')}
        breadcrumb={[
          { title: t('taskForm.breadcrumb.tasks'), to: '/tasks' },
          { title: isEdit ? t('taskForm.breadcrumb.edit') : t('taskForm.breadcrumb.new') },
        ]}
        extra={
          <Button icon={<ArrowLeftOutlined />} type="text" onClick={() => nav(-1)}>
            {t('taskForm.back')}
          </Button>
        }
      />

      {/* UI-06: 分区单页——Steps 四步改锚点导航。全部 Form.Item 同时挂载，
          消除「分步渲染卸载字段 → validateFields 只见当前步」的 P0 缺陷土壤
          （第八轮兜底保留为双保险，见 handleSubmit 注释）。 */}
      <div
        style={{
          display: 'flex',
          gap: 24,
          alignItems: 'flex-start',
        }}
      >
        {/* 左侧锚点条（jsdom 无布局，Anchor 原生滚动监听依赖 getBoundingClientRect——
            测试环境只断言锚点渲染与点击可滚，不测监听） */}
        <nav
          data-testid="task-form-anchor"
          aria-label={t('taskForm.anchorAria')}
          style={{
            width: 160,
            flexShrink: 0,
            position: 'sticky',
            top: 88,
            // G-4：宽屏（≥lg）显示锚点条，窄屏隐藏。断点逻辑内联自洽，
            // 不再与外部 CSS 争夺 display 优先级（此前硬编码 none 会覆盖任何媒体查询）。
            display: screens.lg ? 'block' : 'none',
          }}
          className="task-form-anchor-rail"
        >
          <Anchor
            affix={false}
            items={anchorItems}
            onClick={(e) => {
              e.preventDefault();
            }}
          />
        </nav>
        {/* UI-12：校验失败播报通道（视觉隐藏；视觉反馈由 message + 锚点滚动承担） */}
        <div
          role="status"
          aria-live="polite"
          data-testid="task-form-validation-announcement"
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            overflow: 'hidden',
            clip: 'rect(0 0 0 0)',
            whiteSpace: 'nowrap',
          }}
        >
          {validationAnnouncement}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <Form
            form={form}
            layout="vertical"
            initialValues={{ triggerType: 'manual', runtime: 'python', timeout: 300, maxRetry: 3, retryDelay: 0, priority: 2, timeoutAction: 'kill' }}
            onValuesChange={(changed) => {
              if (changed.triggerType) setTriggerType(changed.triggerType);
            }}
          >
            {/* 分区一：基本配置（原 step 0） */}
            <div id={SECTION_IDS[0]} data-testid="section-basic" role="region" aria-label={t('taskForm.section.basic')} style={{ scrollMarginTop: 88 }}>
              <Typography.Title level={5} style={sectionTitleStyle}>{t('taskForm.section.basic')}</Typography.Title>
              <Card style={{ marginBottom: 20 }}>
                <Form.Item
                  name="name"
                  label={t('taskForm.field.name')}
                  rules={[
                    { required: true, message: t('taskForm.field.name.required') },
                    { pattern: /^[a-zA-Z0-9_-]+$/, message: t('taskForm.field.name.pattern') },
                  ]}
                  tooltip={{ title: isEdit ? t('taskForm.field.name.tooltipEdit') : t('taskForm.field.name.tooltip'), icon: <InfoCircleOutlined /> }}
                >
                  <Input placeholder="daily-report" disabled={isEdit} />
                </Form.Item>

                <Form.Item name="description" label={t('taskForm.field.description.optional')}>
                  <Input placeholder={t('taskForm.field.description.placeholder')} />
                </Form.Item>

                {/* TASK-PROJ-01：归属项目。
                    此前 tasks.projectId 无任何写入入口（迁移 1790000000008 的注释
                    即写明「新建任务在 DTO 未接 projectId 前一律落 NULL」），导致
                    「项目隔离」对所有新任务都塌缩到默认项目视图、形同虚设。
                    不选 = 未分配（归默认项目视图），与既有行为一致。
                    后端仅 ADMIN 或该项目的 editor/admin 可设置，故非管理员看到
                    的选项受限（后端仍会兜底校验）。 */}
                <Form.Item
                  name="projectId"
                  label={t('taskForm.field.projectId')}
                  tooltip={{ title: t('taskForm.field.projectId.tooltip'), icon: <InfoCircleOutlined /> }}
                >
                  <Select
                    allowClear
                    placeholder={t('taskForm.field.projectId.placeholder')}
                    options={projectOptions}
                    data-testid="task-project-select"
                  />
                </Form.Item>

                <Form.Item
                  name="runtime"
                  label={t('taskForm.field.runtime')}
                  rules={[{ required: true, message: t('taskForm.field.runtime.required') }]}
                  tooltip={{ title: t('taskForm.field.runtime.tooltip'), icon: <InfoCircleOutlined /> }}
                >
                  <Radio.Group optionType="button" buttonStyle="solid">
                    {RUNTIME_OPTIONS.map(o => (
                      <Radio.Button key={o.value} value={o.value}>{o.label}</Radio.Button>
                    ))}
                  </Radio.Group>
                </Form.Item>

                <Form.Item
                  name="entrypoint"
                  label={t('taskForm.field.entrypoint')}
                  rules={[{ required: true, message: t('taskForm.field.entrypoint.required') }]}
                  tooltip={{ title: t('taskForm.field.entrypoint.tooltip'), icon: <InfoCircleOutlined /> }}
                >
                  <Input placeholder="tasks/main.py" />
                </Form.Item>

                {/* python_task_multiversion（FR-06/AC-06a/AC-06b）：Python 版本声明。
                    RuntimeVersionField 内部以 Form.useWatch('runtime') 自我门控，
                    非 python 时返回 null——确保 node/shell 任务不会声明版本
                    （后端 NG-02 会拒绝），同时 hook 调用保持无条件。 */}
                <RuntimeVersionField
                  form={form}
                  value={runtimeVersion}
                  onChange={setRuntimeVersion}
                />

                {/* P2-4：舰队能力咨询（非阻断，见 interpreterFleetAdvisory 头注）。
                    只在 python + 已声明版本 + 在线舰队无一台满足时出现。 */}
                {runtimeWatch === 'python' && interpreterFleet === 'unsatisfied' && (
                  <Alert
                    type="warning"
                    showIcon
                    data-testid="runtime-version-capability-advisory"
                    style={{ marginBottom: 16 }}
                    title={t('taskForm.field.runtimeVersion.capabilityAdvisoryTitle', {
                      version: runtimeVersion ?? '-',
                    })}
                    description={t('taskForm.field.runtimeVersion.capabilityAdvisoryDesc')}
                  />
                )}

                {/* W-21: 依赖声明。python 任务由 executor-python 装进 per-task uv
                    venv，node 任务由 executor-node 安装；glue 脚本任务不生效。 */}
                <Form.Item
                  name="requirements"
                  label={t('taskForm.field.requirements')}
                  tooltip={{
                    title:
                      t('taskForm.field.requirements.tooltip'),
                    icon: <InfoCircleOutlined />,
                  }}
                >
                  <Select
                    mode="tags"
                    placeholder={t('taskForm.field.requirements.placeholder')}
                    open={false}
                    suffixIcon={null}
                    tokenSeparators={[]}
                  />
                </Form.Item>

                {/* python_task_multiversion（FR-18/AC-17b）：代码来源三选一。
                    选谁决定下面显示哪些输入；提交侧由 applyCodeSourcePayload 把
                    不适用字段统一发**显式 null**（PATCH 是 Object.assign 语义，
                    省略字段会保留旧值 → 任务静默带两个冲突来源）。 */}
                <Form.Item
                  label={t('taskForm.field.codeSource')}
                  required
                  tooltip={{ title: t('taskForm.field.codeSource.tooltip'), icon: <InfoCircleOutlined /> }}
                >
                  <Radio.Group
                    value={codeSource}
                    onChange={(e) => setCodeSource(e.target.value as CodeSource)}
                    data-testid="code-source-select"
                  >
                    <Space orientation="vertical" style={{ width: '100%' }}>
                      {CODE_SOURCE_OPTIONS(t).map((o) => (
                        <Radio key={o.value} value={o.value} data-testid={`code-source-${o.value}`}>
                          <Space>
                            <span style={{ fontWeight: 500 }}>{o.label}</span>
                            <Text type="secondary" style={{ fontSize: 12 }}>{o.desc}</Text>
                          </Space>
                        </Radio>
                      ))}
                    </Space>
                  </Radio.Group>
                </Form.Item>

                {/* git 来源：仓库地址 + 分支。两者都可留空——存量任务与部署清单
                    自动注册的任务都没有 gitRepo，NFR-05 要求零破坏（后端只在
                    codeSource='git' 显式声明时才强制其非空，而声明与否由
                    applyCodeSourcePayload 的"自证"规则决定）。 */}
                {codeSource === 'git' && (
                  <>
                    <Form.Item
                      name="gitRepo"
                      label={t('taskForm.field.gitRepo')}
                      tooltip={{ title: t('taskForm.field.gitRepo.tooltip'), icon: <InfoCircleOutlined /> }}
                    >
                      <Input placeholder={t('taskForm.field.gitRepo.placeholder')} />
                    </Form.Item>
                    <Form.Item name="gitBranch" label={t('taskForm.field.gitBranch')}>
                      <Input placeholder={t('taskForm.field.gitBranch.placeholder')} />
                    </Form.Item>
                  </>
                )}

                {/* application_zip 来源：applicationId 在此是**代码来源载体**（必填）。
                    与下面 glue 分支的同一控件共用 name="applicationId"——两条分支
                    互斥渲染，不会出现两个同名控件并存。 */}
                {codeSource === 'application_zip' && (
                  <>
                    <Form.Item
                      name="applicationId"
                      label={t('taskForm.field.applicationId.zipRequired')}
                      required
                      rules={[{ required: true, message: t('taskForm.field.codeSource.applicationRequired') }]}
                      tooltip={{ title: t('taskForm.field.applicationId.zipTooltip'), icon: <InfoCircleOutlined /> }}
                    >
                      <Select
                        placeholder={t('taskForm.field.applicationId.zipPlaceholder')}
                        showSearch
                        options={apps.map(a => ({ value: a.id, label: a.name }))}
                        filterOption={(input, opt) =>
                          (opt?.label as string)?.toLowerCase().includes(input.toLowerCase())
                        }
                      />
                    </Form.Item>
                    {/* AC-19a：应用 runtime 必须与任务 runtime 一致。只在两侧都有
                        值时才判定（deriveRuntimeMismatch 对缺失返回 null），避免
                        应用列表未就绪/应用无 runtime 时误报。 */}
                    {zipRuntimeMismatch && (
                      <Alert
                        type="error"
                        showIcon
                        data-testid="code-source-runtime-mismatch"
                        title={t('taskForm.field.codeSource.runtimeMismatch', {
                          task: runtimeWatch ?? '-',
                          app: apps.find(a => a.id === applicationIdWatch)?.runtime ?? '-',
                        })}
                        style={{ marginBottom: 16 }}
                      />
                    )}
                  </>
                )}

                {/* glue 来源：本表单没有脚本输入框（GlueEditor 在独立区块写
                    glueSource 并同时声明 codeSource='glue'）。此处只说明去哪编辑，
                    避免用户以为"选了 glue 却没地方写脚本"。 */}
                {codeSource === 'glue' && (
                  <Alert
                    type="info"
                    showIcon
                    data-testid="code-source-glue-hint"
                    title={t('taskForm.field.codeSource.glueHint')}
                    style={{ marginBottom: 16 }}
                  />
                )}

                {/* 部署绑定（非 zip 来源）：applicationId 在 git/glue 来源下仍有
                    意义——它是「任务 ↔ 应用」的部署绑定关系，与代码来源正交
                    （部署清单自动注册的任务即 applicationId + glueSource 并存，
                    后端 NFR-05 明确放行）。故此处必须保留一个入口，否则用户在
                    git 来源下根本无法查看/修改该绑定。 */}
                {codeSource !== 'application_zip' && (
                  <Form.Item
                    name="applicationId"
                    label={t('taskForm.field.applicationId')}
                    tooltip={{ title: t('taskForm.field.applicationId.tooltip'), icon: <InfoCircleOutlined /> }}
                    extra={
                      applicationIdWatch ? (
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {t('taskForm.field.applicationId.boundHint')}
                        </Text>
                      ) : undefined
                    }
                  >
                    <Select
                      placeholder={t('taskForm.field.applicationId.placeholder')}
                      allowClear
                      showSearch
                      options={apps.map(a => ({ value: a.id, label: a.name }))}
                      filterOption={(input, opt) =>
                        (opt?.label as string)?.toLowerCase().includes(input.toLowerCase())
                      }
                    />
                  </Form.Item>
                )}
              </Card>
            </div>

            {/* 分区二：触发与告警（原 step 1 上半 + step 2 告警/runbook/参数） */}
            <div id={SECTION_IDS[1]} data-testid="section-trigger" role="region" aria-label={t('taskForm.section.trigger')} style={{ scrollMarginTop: 88 }}>
              <Typography.Title level={5} style={sectionTitleStyle}>{t('taskForm.section.trigger')}</Typography.Title>
              <Card style={{ marginBottom: 20 }}>
                <Form.Item name="triggerType" label={t('taskForm.field.triggerType')}>
                  <Radio.Group>
                    <Space orientation="vertical">
                      {TRIGGER_OPTIONS(t).map(o => (
                        <Radio key={o.value} value={o.value}>
                          <Space>
                            <span style={{ fontWeight: 500 }}>{o.label}</span>
                            <Text type="secondary" style={{ fontSize: 12 }}>{o.desc}</Text>
                          </Space>
                        </Radio>
                      ))}
                    </Space>
                  </Radio.Group>
                </Form.Item>

                {triggerType === 'cron' && (
                  <Form.Item
                    name="cronExpression"
                    label={t('taskForm.field.cron')}
                    rules={[{ required: true, message: t('taskForm.field.cron.required') }]}
                    extra={
                      <Button type="link" size="small" onClick={() => setShowCronHelper(true)}>
                        {t('taskForm.field.cron.helper')}
                      </Button>
                    }
                  >
                    <Input placeholder={t('taskForm.field.cron.placeholder')} style={{ fontFamily: 'monospace' }} />
                  </Form.Item>
                )}

                {triggerType === 'cron' && (
                  <Form.Item
                    name="timezone"
                    label={t('taskForm.field.timezone')}
                    tooltip={{ title: t('taskForm.field.timezone.tooltip'), icon: <InfoCircleOutlined /> }}
                  >
                    <Input placeholder="Asia/Shanghai" />
                  </Form.Item>
                )}

                {triggerType === 'fixed_rate' && (
                  <Form.Item
                    name="fixedRate"
                    label={t('taskForm.field.fixedRate')}
                    rules={[{ required: true, message: t('taskForm.field.fixedRate.required') }]}
                  >
                    <InputNumber<number>
                      min={60}
                      step={60}
                      style={{ width: 200 }}
                      formatter={v => v ? t('taskForm.field.fixedRate.minutes', { n: fixedRateToMinutesLabel(Number(v)) }) : ''}
                      // F-28（DEEP_REVIEW 0ef3bbe）：原 parser 用 t('taskForm.field.fixedRate.minuteUnit')
                      // 的**翻译文本**做 String.replace 反解数字——文案一变（如英文 "minutes"）或
                      // 语序变化即解析成 NaN，属"解析依赖 i18n 文案"的坏味道。现改走
                      // pages/fixed-rate.ts 的与语言无关数字抽取（纯函数，已单测）。
                      //
                      // 本轮审计修复：额外把**当前表单值**传给 parser。输入框以分钟呈现
                      // 而表单值单位是秒，非 60 整数倍的值（90s/45s）向下取整后展示为
                      // 「1 分钟」；仅 parser(text) 会把展示文本回读成 60s，用户聚焦后
                      // 失焦（未改一个字符）就把 90s 静默改成 60s。传当前值后 parser 能
                      // 判定"是否跨分钟"——未改则原样保留精确秒值。
                      parser={(v) => parseFixedRateSeconds(v, form.getFieldValue('fixedRate'))}
                      placeholder={t('taskForm.field.fixedRate.placeholder')}
                    />
                  </Form.Item>
                )}

                {/* UI-06 ②：触发预览（cron/fixed_rate 未来 5 次，timezone 感知；
                    manual 不渲染）。纯展示，不影响校验/提交。 */}
                {(triggerType === 'cron' || triggerType === 'fixed_rate') && (
                  <TriggerPreview
                    triggerType={triggerType}
                    cronExpression={cronExpression}
                    fixedRate={fixedRateWatch}
                    timezone={timezoneWatch}
                  />
                )}

                {/* FEAT-06: 任务级维护窗口——发布冻结期跳过计划触发（手动触发不受限） */}
                <Divider style={{ margin: '16px 0' }} />
                <div style={{ marginBottom: 8 }}>
                  <Space size={4}>
                    <ToolOutlined />
                    <Typography.Text strong>{t('taskForm.window.title')}</Typography.Text>
                    <Tooltip title={t('taskForm.window.tooltip')}>
                      <InfoCircleOutlined style={{ color: token.colorPrimary }} />
                    </Tooltip>
                  </Space>
                </div>
                <Form.List name="maintenanceWindows">
                  {(fields, { add, remove }) => (
                    <>
                      {fields.map(field => (
                        <Space key={field.key} style={{ display: 'flex', marginBottom: 8 }} align="baseline" wrap>
                          <Form.Item
                            name={[field.name, 'start']}
                            noStyle
                            rules={[
                              { required: true, message: t('taskForm.window.startRequired') },
                              { pattern: /^(\*|([0-5]?\d))(\/(\d+))? (\*|([01]?\d|2[0-3]))(\/(\d+))? (\*|([012]?\d|3[01]))(\/(\d+))? (\*|(1[0-2]|0?[1-9]))(\/(\d+))? (\*|[0-7])(\/(\d+))?$/, message: t('taskForm.window.cronFormat') },
                            ]}
                          >
                            <Input placeholder={t('taskForm.window.startPlaceholder')} style={{ width: 200, fontFamily: 'monospace' }} />
                          </Form.Item>
                          <Form.Item
                            name={[field.name, 'end']}
                            noStyle
                            rules={[
                              { required: true, message: t('taskForm.window.endRequired') },
                              { pattern: /^(\*|([0-5]?\d))(\/(\d+))? (\*|([01]?\d|2[0-3]))(\/(\d+))? (\*|([012]?\d|3[01]))(\/(\d+))? (\*|(1[0-2]|0?[1-9]))(\/(\d+))? (\*|[0-7])(\/(\d+))?$/, message: t('taskForm.window.cronFormat') },
                            ]}
                          >
                            <Input placeholder={t('taskForm.window.endPlaceholder')} style={{ width: 200, fontFamily: 'monospace' }} />
                          </Form.Item>
                          <Form.Item name={[field.name, 'description']} noStyle>
                            <Input placeholder={t('taskForm.window.descPlaceholder')} style={{ width: 160 }} />
                          </Form.Item>
                          <Button
                            type="text"
                            danger
                            icon={<DeleteOutlined />}
                            aria-label={t('taskForm.window.deleteAria', { n: field.name + 1 })}
                            onClick={() => remove(field.name)}
                          />
                        </Space>
                      ))}
                      <Form.Item style={{ marginBottom: 0 }}>
                        <Button
                          type="dashed"
                          icon={<PlusOutlined />}
                          onClick={() => add()}
                          disabled={fields.length >= MAINTENANCE_WINDOWS_MAX}
                        >
                          {t('taskForm.window.add')}
                        </Button>
                      </Form.Item>
                    </>
                  )}
                </Form.List>

                <Divider style={{ margin: '20px 0 16px' }} />
                <div style={{ marginBottom: 8 }}>
                  <Typography.Text strong>{t('taskForm.alarm.title')}</Typography.Text>
                </div>
                <AlarmConfig />

                <Divider style={{ margin: '20px 0 16px' }} />
                <div style={{ marginBottom: 8 }}>
                  <Typography.Text strong>{t('taskForm.runbook.title')}</Typography.Text>
                </div>
                <Form.Item
                  name="runbook"
                  label={t('taskForm.runbook.label')}
                  tooltip={{ title: t('taskForm.runbook.tooltip'), icon: <InfoCircleOutlined /> }}
                >
                  <Input.TextArea
                    rows={6}
                    placeholder={t('taskForm.runbook.placeholder')}
                  />
                </Form.Item>
              </Card>
            </div>

            {/* 分区三：执行器策略与超时重试（原 step 1 下半） */}
            <div id={SECTION_IDS[2]} data-testid="section-executor" role="region" aria-label={t('taskForm.section.executor')} style={{ scrollMarginTop: 88 }}>
              <Typography.Title level={5} style={sectionTitleStyle}>{t('taskForm.section.executor')}</Typography.Title>
              <Card style={{ marginBottom: 20 }}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>{t('taskForm.executor.strategy')}</span>
                      {(broadcastDisabledByPin || pinDisabledByBroadcast) && (
                        <Tooltip title={t('taskForm.executor.mutexTooltip')}>
                          <LockOutlined style={{ color: token.colorWarning }} data-testid="executor-mutex-lock" />
                        </Tooltip>
                      )}
                    </Space>
                  }
                  required
                  tooltip={{ title: t('taskForm.executor.strategyTooltip'), icon: <InfoCircleOutlined /> }}
                >
                  <Radio.Group
                    value={executorMode}
                    onChange={e => setExecutorMode(e.target.value)}
                    style={{ width: '100%' }}
                  >
                    <Space orientation="vertical" style={{ width: '100%' }}>
                      {EXECUTOR_MODE_OPTIONS(t).map(o => (
                        <Radio
                          key={o.value}
                          value={o.value}
                          disabled={o.value === 'broadcast' && broadcastDisabledByPin}
                          style={{
                            border: `1px solid ${executorMode === o.value ? token.colorPrimary : token.colorBorder}`,
                            borderRadius: 8,
                            padding: '10px 14px',
                            width: '100%',
                            background: executorMode === o.value ? token.colorPrimaryBg : token.colorBgContainer,
                            transition: 'all 0.2s',
                          }}
                        >
                          <Space>
                            {o.icon}
                            <span style={{ fontWeight: 500 }}>{o.label}</span>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              {o.value === 'broadcast' && broadcastDisabledByPin
                                ? t('taskForm.executor.broadcastBlocked')
                                : o.desc}
                            </Text>
                          </Space>
                        </Radio>
                      ))}
                    </Space>
                  </Radio.Group>
                </Form.Item>

                {executorMode === 'pinned' && (
                  <Form.Item name="executorId" label={t('taskForm.field.executorId')} required
                    rules={[{ required: true, message: t('taskForm.field.executorId.required') }]}
                    tooltip={{ title: t('taskForm.field.executorId.tooltip'), icon: <InfoCircleOutlined /> }}>
                    <Select
                      placeholder={t('taskForm.field.executorId.placeholder')}
                      showSearch
                      optionFilterProp="label"
                      options={executors.map(e => ({
                        value: e.id,
                        label: `${e.appName}  (${e.address})${e.status === 'online' ? '' : ` ${t('taskForm.executor.offline')}`}`,
                      }))}
                    />
                  </Form.Item>
                )}

                {executorMode === 'group' && (
                  <>
                    <Form.Item name="executorGroup" label={t('taskForm.field.executorGroup')}
                      tooltip={{ title: t('taskForm.field.executorGroup.tooltip'), icon: <InfoCircleOutlined /> }}>
                      <Select placeholder={t('taskForm.field.executorGroup.placeholder')} allowClear
                        options={groups.map(g => ({ value: g, label: g }))} />
                    </Form.Item>
                    <Form.Item name="executorTags" label={t('taskForm.field.executorTags')}
                      tooltip={{ title: t('taskForm.field.executorTags.tooltip'), icon: <InfoCircleOutlined /> }}>
                      <Select
                        mode="multiple"
                        placeholder={t('taskForm.field.executorTags.placeholder')}
                        allowClear
                        options={allTags.map(t => ({ value: t, label: <Tag>{t}</Tag> }))}
                      />
                    </Form.Item>
                  </>
                )}

                {/* NF-04: affinity constraints are orthogonal to auto/group/broadcast
                    and remain mounted in every mode so edit/save cannot clear a
                    value merely because a mode-specific branch is not visible.
                    Pinned dispatch bypasses all tag filters, so these controls are
                    disabled there while their stored values are retained for a
                    later switch back to a filtering mode. */}
                <Form.Item
                  name="executorAffinityTags"
                  label={t('taskForm.field.affinityTags')}
                  tooltip={{
                    title: t('taskForm.field.affinityTags.tooltip'),
                    icon: <InfoCircleOutlined />,
                  }}
                >
                  <Select
                    mode="multiple"
                    allowClear
                    disabled={executorMode === 'pinned'}
                    placeholder={t('taskForm.field.affinityTags.placeholder')}
                    options={allTags.map(t => ({ value: t, label: <Tag>{t}</Tag> }))}
                  />
                </Form.Item>
                <Form.Item
                  name="executorAntiAffinityTags"
                  label={t('taskForm.field.antiAffinityTags')}
                  tooltip={{
                    title: t('taskForm.field.antiAffinityTags.tooltip'),
                    icon: <InfoCircleOutlined />,
                  }}
                >
                  <Select
                    mode="multiple"
                    allowClear
                    disabled={executorMode === 'pinned'}
                    placeholder={t('taskForm.field.antiAffinityTags.placeholder')}
                    options={allTags.map(t => ({ value: t, label: <Tag>{t}</Tag> }))}
                  />
                </Form.Item>
                {executorMode === 'pinned' && (
                  <Alert
                    type="info"
                    showIcon
                    title={t('taskForm.alert.pinnedAffinity')}
                    data-testid="pinned-affinity-disabled"
                    style={{ marginBottom: 16 }}
                  />
                )}

                {pinDisabledByBroadcast && (
                  <Alert
                    type="warning"
                    showIcon
                    data-testid="broadcast-pin-cleared"
                    title={t('taskForm.alert.broadcastPin')}
                    style={{ marginBottom: 16 }}
                  />
                )}

                <Divider style={{ margin: '16px 0' }} />

                <Form.Item name="timeout" label={<>{t('taskForm.field.timeout')} <Text type="secondary" style={{ fontSize: 12 }}>{t('taskForm.field.timeout.unit')}</Text></>}>
                  <InputNumber min={10} max={86400} style={{ width: 160 }} placeholder="300" />
                </Form.Item>

                {/* CORE-04: 超时策略分级——超时后动作三选一。kill 为既有树杀
                    语义；kill_retry 超时终态后按任务重试预算 re-enqueue 一次；
                    notify_only 仅保证超时告警（执行器自身硬超时仍在，进程仍会
                    被执行器杀掉——并非"永不超时"）。 */}
                <Form.Item
                  name="timeoutAction"
                  label={<>{t('taskForm.field.timeoutAction')} <Text type="secondary" style={{ fontSize: 12 }}>{t('taskForm.field.timeoutAction.hint')}</Text></>}
                  initialValue="kill"
                  tooltip={{ title: t('taskForm.field.timeoutAction.tooltip'), icon: <InfoCircleOutlined /> }}
                >
                  <Radio.Group optionType="button" buttonStyle="solid">
                    {TIMEOUT_ACTION_OPTIONS.map((o) => (
                      <Radio.Button key={o.value} value={o.value}>{TIMEOUT_ACTION_LABELS(t)[o.value] ?? o.label}</Radio.Button>
                    ))}
                  </Radio.Group>
                </Form.Item>

                {/* CORE-04: 超时预警——运行时长达到 超时时间×阈值% 时发一次
                    WARNING 通知（每个执行至多一次）。留空 = 不启用。 */}
                <Form.Item
                  name="timeoutWarnRatio"
                  label={<>{t('taskForm.field.timeoutWarnRatio')} <Text type="secondary" style={{ fontSize: 12 }}>{t('taskForm.field.timeoutWarnRatio.hint')}</Text></>}
                  tooltip={{ title: t('taskForm.field.timeoutWarnRatio.tooltip'), icon: <InfoCircleOutlined /> }}
                >
                  <InputNumber min={0} max={TIMEOUT_WARN_RATIO_MAX} style={{ width: 160 }} placeholder={t('taskForm.field.timeoutWarnRatio.placeholder')} />
                </Form.Item>

                <Form.Item name="maxRetry" label={<>{t('taskForm.field.maxRetry')} <Text type="secondary" style={{ fontSize: 12 }}>{t('taskForm.field.maxRetry.hint')}</Text></>}>
                  <InputNumber min={1} max={10} style={{ width: 120 }} />
                </Form.Item>

                <Form.Item name="retryDelay" label={<>{t('taskForm.field.retryDelay')} <Text type="secondary" style={{ fontSize: 12 }}>{t('taskForm.field.retryDelay.hint')}</Text></>}>
                  <InputNumber min={0} max={3600} style={{ width: 160 }} />
                </Form.Item>

                {/* CORE-02: 可重试错误类型白名单——留空 = 全部可重试（既有语义）；
                    勾选后仅白名单内的失败（错误消息子串或失败分类，大小写不敏感）
                    会重试。timeout 类失败另有防双派发守卫，永不自动重试。 */}
                <Form.Item
                  name="retryableErrors"
                  label={<>{t('taskForm.field.retryableErrors')} <Text type="secondary" style={{ fontSize: 12 }}>{t('taskForm.field.retryableErrors.hint')}</Text></>}
                  tooltip={{ title: t('taskForm.field.retryableErrors.tooltip'), icon: <InfoCircleOutlined /> }}
                >
                  <Select
                    mode="multiple"
                    allowClear
                    placeholder={t('taskForm.field.retryableErrors.placeholder')}
                    // P3-2：选项只携带 i18n 键，标签在此统一 t() 解析——
                    // 不再有硬编码中文兜底，英文界面不可能再漏出中文选项。
                    options={RETRYABLE_ERROR_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
                  />
                </Form.Item>

                <Form.Item name="priority" label={<>{t('taskForm.field.priority')} <Text type="secondary" style={{ fontSize: 12 }}>{t('taskForm.field.priority.hint')}</Text></>}>
                  <Select
                    style={{ width: 200 }}
                    options={TASK_PRIORITY_OPTIONS.map((o) => ({ value: o.value, label: PRIORITY_LABELS(t)[String(o.value)] ?? o.label }))}
                  />
                </Form.Item>

                {/* NF-02: 上游依赖（编排）。后端 tasks.dependencies jsonb =
                    Record<taskId, taskName>；上游全部最近执行 SUCCESS 时由
                    admin-api 自动扇出触发本任务（triggerDependentTasks，
                    环检测/深度上限在 create/update 侧强制）。 */}
                <Form.Item
                  name="upstreamDependencies"
                  label={t('taskForm.field.upstreamDependencies')}
                  tooltip={{
                    title:
                      t('taskForm.field.upstreamDependencies.tooltip'),
                    icon: <InfoCircleOutlined />,
                  }}
                >
                  <Select
                    mode="multiple"
                    showSearch
                    allowClear
                    placeholder={t('taskForm.field.upstreamDependencies.placeholder')}
                    options={taskOptions
                      .filter((t) => t.id !== editId)
                      .map((t) => ({ value: t.id, label: t.name }))}
                    filterOption={(input, opt) =>
                      (opt?.label as string)?.toLowerCase().includes(input.toLowerCase())
                    }
                  />
                </Form.Item>
              </Card>
            </div>

            {/* 分区四：参数配置（原 step 2 上半） */}
            <div id={SECTION_IDS[3]} data-testid="section-params" role="region" aria-label={t('taskForm.section.params')} style={{ scrollMarginTop: 88 }}>
              <Typography.Title level={5} style={sectionTitleStyle}>{t('taskForm.section.params')}</Typography.Title>
              <Card style={{ marginBottom: 20 }}>
                <Alert
                  type="info"
                  showIcon
                  title={t('taskForm.params.alertTitle')}
                  description={t('taskForm.params.alertDesc')}
                  style={{ marginBottom: 20 }}
                />
                <Form.Item name="params" label={t('taskForm.field.params')}>
                  <ParamsEditor />
                </Form.Item>
              </Card>
            </div>
          </Form>

          {/* 分区五：Glue 脚本（原 step 3——创建后才有 taskId，保持既有行为语义：
              创建态在提交成功前不渲染 GlueEditor；编辑态 taskId 已存在直接可编） */}
          <div id={SECTION_IDS[4]} data-testid="section-glue" role="region" aria-label={t('taskForm.section.glue')} style={{ scrollMarginTop: 88 }}>
            <Typography.Title level={5} style={sectionTitleStyle}>{t('taskForm.section.glueTitle')}</Typography.Title>
            {glueTaskId ? (
              <Card style={{ marginBottom: 20 }}>
                {!isEdit && createdTaskId && (
                  <Alert
                    type="success"
                    showIcon
                    title={t('taskForm.glue.createdTitle')}
                    description={t('taskForm.glue.createdDesc')}
                    style={{ marginBottom: 20 }}
                  />
                )}
                <GlueEditor
                  taskId={glueTaskId}
                  taskRuntime={savedRuntime}
                />
                <Divider />
                <Space>
                  <Button type="primary" onClick={() => nav(`/tasks/${glueTaskId}`)}>{t('taskForm.glue.done')}</Button>
                  {!isEdit && (
                    <Button onClick={() => nav('/tasks')}>{t('taskForm.glue.skip')}</Button>
                  )}
                </Space>
              </Card>
            ) : (
              <Card style={{ marginBottom: 20 }}>
                <Text type="secondary" data-testid="glue-locked-hint">
                  {t('taskForm.glue.lockedHint')}
                </Text>
              </Card>
            )}
          </div>

          {/* 提交条：单页常驻（不再依附任一步骤），语义与原 step 2 提交按钮一致 */}
          <div
            data-testid="task-form-submit-bar"
            style={{
              position: 'sticky',
              bottom: 0,
              padding: '12px 0',
              background: token.colorBgLayout,
              borderTop: `1px solid ${token.colorBorderSecondary}`,
              display: 'flex',
              justifyContent: 'flex-end',
              zIndex: 10,
            }}
          >
            <Space>
              {!isEdit && (
                <Button
                  icon={<SaveOutlined />}
                  data-testid="save-as-template"
                  onClick={openSaveAsTemplate}
                >
                  {t('taskForm.saveAsTemplate')}
                </Button>
              )}
              <Button type="primary" onClick={handleSubmit} loading={saving}
                icon={<ThunderboltOutlined />}>
                {isEdit ? t('taskForm.submit.saveChanges') : t('taskForm.submit.create')}
              </Button>
            </Space>
          </div>
        </div>
      </div>

      <CronHelper
        open={showCronHelper}
        onClose={() => setShowCronHelper(false)}
        onSelect={(expr) => {
          form.setFieldValue('cronExpression', expr);
          setShowCronHelper(false);
        }}
      />

      {/* FEAT-13：保存为自定义模板弹窗——config 由 templateConfigFromFormValues
          白名单抽取（CreateTaskDto 子集，后端 forbidNonWhitelisted 校验），
          此处只填模板元信息（name/描述/分类）。 */}
      <Modal
        title={<Space><SaveOutlined /> {t('taskForm.tpl.modalTitle')}</Space>}
        open={tplModalOpen}
        onCancel={() => setTplModalOpen(false)}
        onOk={handleSaveAsTemplate}
        okText={t('taskForm.tpl.save')}
        okButtonProps={{ loading: tplSaving, 'data-testid': 'tpl-save-confirm' }}
        cancelText={t('taskForm.tpl.cancel')}
        width={520}
        destroyOnHidden
      >
        <Form form={tplForm} layout="vertical">
          <Form.Item
            name="name"
            label={t('taskForm.tpl.name')}
            rules={[{ required: true, whitespace: true, message: t('taskForm.tpl.name.required') }]}
          >
            <Input placeholder={t('taskForm.tpl.name.placeholder')} maxLength={128} data-testid="tpl-name-input" />
          </Form.Item>
          <Form.Item name="description" label={t('taskForm.tpl.description')}>
            <Input.TextArea rows={2} placeholder={t('taskForm.tpl.description.placeholder')} maxLength={500} data-testid="tpl-desc-input" />
          </Form.Item>
          <Form.Item name="category" label={t('taskForm.tpl.category')}>
            <Input placeholder={t('taskForm.tpl.category.placeholder')} maxLength={32} data-testid="tpl-category-input" />
          </Form.Item>
        </Form>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('taskForm.tpl.hint')}
        </Typography.Text>
      </Modal>
    </div>
  );
}
