import { useState, useEffect, useMemo, useRef } from 'react';
import {
  deriveExecutorMode,
  buildExecutorPayload,
  affinityFormValues,
  applyRequirementsPayload,
} from './executor-mode';
import {
  Card, Form, Input, Select, Button, Space, Typography,
  InputNumber, Radio, Alert, message, Divider, Tag, Tooltip, Anchor, theme, Modal,
} from 'antd';
import {
  ThunderboltOutlined, ArrowLeftOutlined,
  InfoCircleOutlined, ClusterOutlined, RocketOutlined, ApartmentOutlined, PushpinOutlined,
  PlusOutlined, DeleteOutlined, ToolOutlined, LockOutlined, SaveOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';
import { taskTemplatesApi } from '../api/task-templates';
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

const RETRYABLE_ERROR_LABELS = (t: (k: string) => string): Record<string, string> => ({
  package_fetch_failed: t('taskForm.retryable.packageFetch'),
  dependency_install_failed: t('taskForm.retryable.dependencyInstall'),
  git_fetch_failed: t('taskForm.retryable.gitFetch'),
  runtime_missing: t('taskForm.retryable.runtimeMissing'),
  script_error: t('taskForm.retryable.scriptError'),
  timeout: t('taskForm.retryable.timeout'),
  executor_offline: t('taskForm.retryable.executorOffline'),
  executor_restart: t('taskForm.retryable.executorRestart'),
  unknown: t('taskForm.retryable.unknown'),
});

const PRIORITY_LABELS = (t: (k: string) => string): Record<string, string> => ({
  1: t('taskForm.priority.low'),
  2: t('taskForm.priority.normal'),
  3: t('taskForm.priority.high'),
  4: t('taskForm.priority.critical'),
});

// UI-06: 单页分区锚点。全部 Form.Item 同时挂载，锚点条只负责滚动定位。
const SECTION_IDS = ['sec-basic', 'sec-trigger', 'sec-executor', 'sec-params', 'sec-glue'] as const;

export default function TaskFormPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { id: editId } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const appId = searchParams.get('applicationId');
  // CORE-03：创建态带 ?templateId= 时，拉取模板 config 预填表单（显式可改）。
  const templateId = searchParams.get('templateId');
  const isEdit = !!editId;

  const [form] = Form.useForm();
  const [triggerType, setTriggerType] = useState('manual');
  // UI-12：校验失败的读屏播报（antd message 是浮层，读屏不会回读）
  const [validationAnnouncement, setValidationAnnouncement] = useState('');
  const [executorMode, setExecutorMode] = useState<'auto' | 'group' | 'pinned' | 'broadcast'>('auto');
  const [groups, setGroups] = useState<string[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [executors, setExecutors] = useState<{ id: string; appName: string; address: string; status: string }[]>([]);
  const [apps, setApps] = useState<{ id: string; name: string }[]>([]);
  // NF-02: 上游依赖选择——候选任务列表 + 名称快照（提交时重建 dependencies 映射）
  const [taskOptions, setTaskOptions] = useState<{ id: string; name: string }[]>([]);
  const depNameSnapshotRef = useRef<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [loadingTask, setLoadingTask] = useState(isEdit);
  const [showCronHelper, setShowCronHelper] = useState(false);
  // Glue: createdTaskId is set after create so GlueEditor can save to the real task id
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);
  const [savedRuntime, setSavedRuntime] = useState('python');

  // FEAT-13：「保存为模板」弹窗（表单校验通过后把当前值固化为自定义模板）
  const [tplModalOpen, setTplModalOpen] = useState(false);
  const [tplSaving, setTplSaving] = useState(false);
  const [tplForm] = Form.useForm<{ name: string; description?: string; category?: string }>();

  // UI-06 ③：pinning/broadcast 互斥（N17 语义前置到输入期）。触发方式/时区
  // 经 Form.useWatch 订阅供预览组件消费（保持 render 同步且不整表单重渲）。
  const cronExpression = Form.useWatch('cronExpression', form);
  const fixedRateWatch = Form.useWatch('fixedRate', form);
  const timezoneWatch = Form.useWatch('timezone', form);
  const { token } = theme.useToken();

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
      (data) => setExecutors(data.map((e) => ({ id: e.id as string, appName: e.appName as string, address: e.address as string, status: e.status as string }))),
      t('taskForm.load.executorsFail'),
    );
    run(
      applicationsApi.list(controller.signal),
      (data) => setApps(data.map((a) => ({ id: a.id, name: a.name }))),
      t('taskForm.load.appsFail'),
    );
    // NF-02: 上游依赖候选（分页拉全，取 id+name；编辑态在任务加载后过滤自身）
    tasksApi
      .listAll({}, controller.signal)
      .then((data) => {
        if (active && !controller.signal.aborted) {
          setTaskOptions(data.items.map((t) => ({ id: t.id, name: t.name })));
        }
      })
      .catch(() => {
        if (active && !controller.signal.aborted) {
          message.warning(t('taskForm.load.tasksFail'));
        }
      });
    if (appId) form.setFieldValue('applicationId', appId);

    return () => {
      active = false;
      controller.abort();
    };
  }, [appId, form, t]);

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
        form.setFieldsValue({
          name: task.name,
          description: task.description,
          runtime: task.runtime,
          entrypoint: task.entrypoint,
          requirements: task.requirements ?? [],
          applicationId: task.applicationId,
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
      })
      .catch(() => message.warning(t('taskForm.load.templateFailed')));
    return () => {
      cancelled = true;
    };
  }, [templateId, isEdit, form, t]);

  // P0 (R8) 兜底保留为双保险：单页全挂载后 validateFields() 天然覆盖全部字段，
  // 以下 missing 收集逻辑在正常情况下永远为空集，仅作为防线存在。
  const handleSubmit = async () => {
    try {
      await form.validateFields();
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'errorFields' in err) {
        // UI-12：antd 只在字段旁标红（读屏不主动播报），此处补一条可播报摘要
        const fields = (err as { errorFields?: { errors?: string[] }[] }).errorFields ?? [];
        const firstError = fields[0]?.errors?.[0];
        if (firstError) {
          setValidationAnnouncement(
            t('taskForm.validate.failed', {
              firstError,
              more: fields.length > 1 ? t('taskForm.validate.more', { count: fields.length }) : '',
            }),
          );
        }
        return;
      }
      message.error(err instanceof Error ? err.message : t('taskForm.validate.fail'));
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
    if (missing.length > 0) {
      const missingList = missing.map((m) => m.label).join('、');
      message.error(t('taskForm.missing', { list: missingList }));
      // UI-12：同步播报到 role="status" 区域（视觉路径=浮层 + 锚点滚动）
      setValidationAnnouncement(t('taskForm.missingShort', { list: missingList }));
      scrollToSection(missing[0].anchor);
      return;
    }
    setValidationAnnouncement('');
    setSaving(true);
    try {
      // QA-01：applyDependenciesPayload 必须包在最外层——它把表单载体字段
      // upstreamDependencies（DTO 未声明，forbidNonWhitelisted 会判 400）转成
      // DTO 声明的 dependencies 映射并删除载体键，须保证没有任何后续步骤再把
      // 载体键带回请求体（内层 buildExecutorPayload 会整体展开 values）。
      const payload = applyDependenciesPayload(
        applyRetryableErrorsPayload(
          applyTimeoutPolicyPayload(
            applyMaintenanceWindowsPayload(
              applyRequirementsPayload(buildExecutorPayload(values, executorMode)),
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
        const created = await tasksApi.create(payload);
        message.success(t('taskForm.submit.created'));
        setSavedRuntime(
          typeof payload.runtime === 'string' ? payload.runtime : 'python',
        );
        setCreatedTaskId(created.id);
        // 创建成功后滚到 Glue 区块（原 step3 语义：创建后进入 Glue 编排）
        setTimeout(() => scrollToSection(SECTION_IDS[4]), 50);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : (isEdit ? t('taskForm.submit.updateFail') : t('taskForm.submit.createFail'));
      message.error(msg);
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
      message.error(err instanceof Error ? err.message : t('taskForm.validate.fail'));
      return;
    }
    tplForm.setFieldsValue({
      name: form.getFieldValue('description')
        ? undefined
        : undefined, // name 由用户填写（表单 name 是任务标识，常不满足模板命名习惯）
    });
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
    try {
      await taskTemplatesApi.create({
        name: meta.name.trim(),
        description: meta.description?.trim() || undefined,
        category: meta.category?.trim() || undefined,
        config: templateConfigFromFormValues(values, buildExecutorPayload(values, executorMode)),
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
    return <PageSkeleton variant="table" rows={6} style={{ maxWidth: 720, padding: 24 }} />;
  }

  // UI-06 ③：互斥禁用态。broadcast 下 pinned 选择器禁用；pinned 下广播项禁用。
  // 数据层互斥由 deriveExecutorMode/buildExecutorPayload 保证（N17/N28），
  // 这里把冲突挡在输入期，不再等提交报错。
  const broadcastDisabledByPin = executorMode === 'pinned';
  const pinDisabledByBroadcast = executorMode === 'broadcast';

  const sectionTitleStyle = { margin: '0 0 4px' };

  return (
    <div style={{ maxWidth: 1080 }}>
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
            display: 'none',
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

        <div style={{ flex: 1, minWidth: 0, maxWidth: 880 }}>
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

                <Form.Item
                  name="applicationId"
                  label={t('taskForm.field.applicationId')}
                  tooltip={{ title: t('taskForm.field.applicationId.tooltip'), icon: <InfoCircleOutlined /> }}
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
                      formatter={v => v ? t('taskForm.field.fixedRate.minutes', { n: Math.floor(Number(v) / 60) }) : ''}
                      parser={v => v ? Number(v.replace(t('taskForm.field.fixedRate.minuteUnit'), '')) * 60 : 60}
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
                      <InfoCircleOutlined style={{ color: '#1677ff' }} />
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
                    options={RETRYABLE_ERROR_OPTIONS.map((o) => ({ value: o.value, label: RETRYABLE_ERROR_LABELS(t)[o.value] ?? o.label }))}
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
        okButtonProps={{ loading: tplSaving, 'data-testid': 'tpl-save-confirm' } as never}
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
