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

const { Text } = Typography;

const TRIGGER_OPTIONS = [
  { value: 'manual', label: '手动触发', desc: '只能通过界面或 API 手动触发' },
  { value: 'cron', label: 'Cron 定时', desc: '使用 Cron 表达式设置复杂调度' },
  { value: 'fixed_rate', label: '固定间隔', desc: '每隔固定时间自动执行一次' },
];

const RUNTIME_OPTIONS = [
  { value: 'python', label: 'Python' },
  { value: 'node', label: 'Node.js' },
  { value: 'shell', label: 'Shell' },
];

// Executor dispatch modes exposed to the user
const EXECUTOR_MODE_OPTIONS = [
  {
    value: 'auto',
    label: '自动调度',
    desc: '系统自动选择负载最低的在线执行器',
    icon: <ClusterOutlined />,
  },
  {
    value: 'group',
    label: '按分组/标签',
    desc: '限定在指定分组或标签的执行器中自动调度',
    icon: <ApartmentOutlined />,
  },
  {
    value: 'pinned',
    label: '指定执行器',
    desc: '固定到指定的执行器节点（按节点 ID 绑定）',
    icon: <PushpinOutlined />,
  },
  {
    value: 'broadcast',
    label: '广播（全部执行）',
    desc: '所有在线执行器同时运行此任务',
    icon: <RocketOutlined />,
  },
];

// UI-06: 单页分区锚点。全部 Form.Item 同时挂载，锚点条只负责滚动定位。
const SECTION_IDS = ['sec-basic', 'sec-trigger', 'sec-executor', 'sec-params', 'sec-glue'] as const;

export default function TaskFormPage() {
  const nav = useNavigate();
  const { id: editId } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const appId = searchParams.get('applicationId');
  // CORE-03：创建态带 ?templateId= 时，拉取模板 config 预填表单（显式可改）。
  const templateId = searchParams.get('templateId');
  const isEdit = !!editId;

  const [form] = Form.useForm();
  const [triggerType, setTriggerType] = useState('manual');
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

    run(executorsApi.getGroups(controller.signal), setGroups, '获取执行器分组失败');
    run(executorsApi.getTags(controller.signal), setAllTags, '获取标签失败');
    run(
      executorsApi.list(controller.signal),
      (data) => setExecutors(data.map((e) => ({ id: e.id as string, appName: e.appName as string, address: e.address as string, status: e.status as string }))),
      '获取执行器列表失败',
    );
    run(
      applicationsApi.list(controller.signal),
      (data) => setApps(data.map((a) => ({ id: a.id, name: a.name }))),
      '获取应用列表失败',
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
          message.warning('获取任务列表失败，上游依赖暂不可选');
        }
      });
    if (appId) form.setFieldValue('applicationId', appId);

    return () => {
      active = false;
      controller.abort();
    };
  }, [appId, form]);

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
        if (active && !controller.signal.aborted) message.error('加载任务失败');
      })
      .finally(() => {
        if (active && !controller.signal.aborted) setLoadingTask(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [editId, form]);

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
      .catch(() => message.warning('加载任务模板失败，已使用空白表单'));
    return () => {
      cancelled = true;
    };
  }, [templateId, isEdit, form]);

  // P0 (R8) 兜底保留为双保险：单页全挂载后 validateFields() 天然覆盖全部字段，
  // 以下 missing 收集逻辑在正常情况下永远为空集，仅作为防线存在。
  const handleSubmit = async () => {
    try {
      await form.validateFields();
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      message.error(err instanceof Error ? err.message : '表单校验失败');
      return;
    }
    const values = form.getFieldsValue(true);
    const missing: { label: string; anchor: string }[] = [];
    if (!values.name) missing.push({ label: '任务名称', anchor: SECTION_IDS[0] });
    if (!values.runtime) missing.push({ label: '运行时', anchor: SECTION_IDS[0] });
    if (!values.entrypoint) missing.push({ label: '入口文件', anchor: SECTION_IDS[0] });
    if (values.triggerType === 'cron' && !values.cronExpression) {
      missing.push({ label: 'Cron 表达式', anchor: SECTION_IDS[1] });
    }
    if (values.triggerType === 'fixed_rate' && !values.fixedRate) {
      missing.push({ label: '执行间隔', anchor: SECTION_IDS[1] });
    }
    if (executorMode === 'pinned' && !values.executorId) {
      missing.push({ label: '指定执行器', anchor: SECTION_IDS[2] });
    }
    if (missing.length > 0) {
      message.error(`必填项缺失：${missing.map((m) => m.label).join('、')}，请补全后重试`);
      scrollToSection(missing[0].anchor);
      return;
    }
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
        message.success('任务更新成功');
        nav(`/tasks/${editId}`);
      } else {
        const created = await tasksApi.create(payload);
        message.success('任务创建成功，可在下方编辑 Glue 脚本（可选）');
        setSavedRuntime(
          typeof payload.runtime === 'string' ? payload.runtime : 'python',
        );
        setCreatedTaskId(created.id);
        // 创建成功后滚到 Glue 区块（原 step3 语义：创建后进入 Glue 编排）
        setTimeout(() => scrollToSection(SECTION_IDS[4]), 50);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : (isEdit ? '更新失败' : '创建失败');
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
      message.error(err instanceof Error ? err.message : '表单校验失败');
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
      message.error(getErrMsg(err, '保存模板失败'));
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
      message.success(`已保存为模板「${meta.name.trim()}」，可在任务模板页查看`);
      setTplModalOpen(false);
    } catch (err: unknown) {
      // validateFields 的 reject 是带 errorFields 的校验对象，不是请求错误——
      // 仅对真正的请求失败弹 toast，表单校验错误由 Form 自带红字呈现。
      if (isFormValidationError(err)) return;
      message.error(getErrMsg(err, '保存模板失败'));
    } finally {
      setTplSaving(false);
    }
  };

  const glueTaskId = createdTaskId || (isEdit ? editId : null);

  const anchorItems = useMemo(
    () => [
      { key: SECTION_IDS[0], href: `#${SECTION_IDS[0]}`, title: '基本配置' },
      { key: SECTION_IDS[1], href: `#${SECTION_IDS[1]}`, title: '触发与告警' },
      { key: SECTION_IDS[2], href: `#${SECTION_IDS[2]}`, title: '执行器策略' },
      { key: SECTION_IDS[3], href: `#${SECTION_IDS[3]}`, title: '参数与运行手册' },
      ...(glueTaskId
        ? [{ key: SECTION_IDS[4], href: `#${SECTION_IDS[4]}`, title: 'Glue 脚本' }]
        : []),
    ],
    [glueTaskId],
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
        title={isEdit ? '编辑任务' : '创建任务'}
        breadcrumb={[
          { title: '任务调度', to: '/tasks' },
          { title: isEdit ? '编辑任务' : '新建任务' },
        ]}
        extra={
          <Button icon={<ArrowLeftOutlined />} type="text" onClick={() => nav(-1)}>
            返回
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
        <div
          data-testid="task-form-anchor"
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
            <div id={SECTION_IDS[0]} data-testid="section-basic" style={{ scrollMarginTop: 88 }}>
              <Typography.Title level={5} style={sectionTitleStyle}>基本配置</Typography.Title>
              <Card style={{ marginBottom: 20 }}>
                <Form.Item
                  name="name"
                  label="任务名称"
                  rules={[
                    { required: true, message: '请输入任务名称' },
                    { pattern: /^[a-zA-Z0-9_-]+$/, message: '只允许字母、数字、下划线、连字符' },
                  ]}
                  tooltip={{ title: isEdit ? '任务名称创建后不可更改' : '唯一标识，建议使用英文，如 daily-report', icon: <InfoCircleOutlined /> }}
                >
                  <Input placeholder="daily-report" disabled={isEdit} />
                </Form.Item>

                <Form.Item name="description" label="描述（可选）">
                  <Input placeholder="简单说明这个任务做什么" />
                </Form.Item>

                <Form.Item
                  name="runtime"
                  label="运行时"
                  rules={[{ required: true, message: '请选择运行时' }]}
                  tooltip={{ title: '执行器节点需安装对应运行时', icon: <InfoCircleOutlined /> }}
                >
                  <Radio.Group optionType="button" buttonStyle="solid">
                    {RUNTIME_OPTIONS.map(o => (
                      <Radio.Button key={o.value} value={o.value}>{o.label}</Radio.Button>
                    ))}
                  </Radio.Group>
                </Form.Item>

                <Form.Item
                  name="entrypoint"
                  label="入口文件"
                  rules={[{ required: true, message: '请输入入口文件路径' }]}
                  tooltip={{ title: '相对于仓库根目录的文件路径，如 tasks/main.py', icon: <InfoCircleOutlined /> }}
                >
                  <Input placeholder="tasks/main.py" />
                </Form.Item>

                {/* W-21: 依赖声明。python 任务由 executor-python 装进 per-task uv
                    venv，node 任务由 executor-node 安装；glue 脚本任务不生效。 */}
                <Form.Item
                  name="requirements"
                  label="依赖包（可选）"
                  tooltip={{
                    title:
                      '执行器运行前安装的依赖，回车逐条添加。python 运行时形如 requests>=2.31（per-task venv），node 运行时形如 left-pad@2.1.0；glue 脚本任务忽略此项',
                    icon: <InfoCircleOutlined />,
                  }}
                >
                  <Select
                    mode="tags"
                    placeholder="requests>=2.31，回车添加"
                    open={false}
                    suffixIcon={null}
                    tokenSeparators={[]}
                  />
                </Form.Item>

                <Form.Item
                  name="applicationId"
                  label="关联应用（可选）"
                  tooltip={{ title: '关联后可继承应用的代码仓库和配置', icon: <InfoCircleOutlined /> }}
                >
                  <Select
                    placeholder="选择应用（可不关联）"
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
            <div id={SECTION_IDS[1]} data-testid="section-trigger" style={{ scrollMarginTop: 88 }}>
              <Typography.Title level={5} style={sectionTitleStyle}>触发与告警</Typography.Title>
              <Card style={{ marginBottom: 20 }}>
                <Form.Item name="triggerType" label="触发方式">
                  <Radio.Group>
                    <Space orientation="vertical">
                      {TRIGGER_OPTIONS.map(o => (
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
                    label="Cron 表达式"
                    rules={[{ required: true, message: '请输入 Cron 表达式' }]}
                    extra={
                      <Button type="link" size="small" onClick={() => setShowCronHelper(true)}>
                        不会写？点击使用 Cron 辅助工具
                      </Button>
                    }
                  >
                    <Input placeholder="0 8 * * 1-5  (每周一至周五早8点)" style={{ fontFamily: 'monospace' }} />
                  </Form.Item>
                )}

                {triggerType === 'cron' && (
                  <Form.Item
                    name="timezone"
                    label="时区"
                    tooltip={{ title: 'IANA 时区名称，例如 Asia/Shanghai；留空则使用服务端默认时区', icon: <InfoCircleOutlined /> }}
                  >
                    <Input placeholder="Asia/Shanghai" />
                  </Form.Item>
                )}

                {triggerType === 'fixed_rate' && (
                  <Form.Item
                    name="fixedRate"
                    label="执行间隔"
                    rules={[{ required: true, message: '请设置间隔时间' }]}
                  >
                    <InputNumber<number>
                      min={60}
                      step={60}
                      style={{ width: 200 }}
                      formatter={v => v ? `${Math.floor(Number(v) / 60)} 分钟` : ''}
                      parser={v => v ? Number(v.replace('分钟', '')) * 60 : 60}
                      placeholder="60（秒）"
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
                    <Typography.Text strong>维护窗口（可选）</Typography.Text>
                    <Tooltip title="发布/停机时段保护：窗口内的计划触发（Cron、固定间隔、错失补偿）会被跳过并计入调度指标；手动触发不受影响。窗口在『开始 Cron』触达时刻开启、『结束 Cron』触达时刻关闭（半开区间）；窗口 Cron 按服务端本地时间评估。最多 10 条。">
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
                              { required: true, message: '开始 Cron 必填' },
                              { pattern: /^(\*|([0-5]?\d))(\/(\d+))? (\*|([01]?\d|2[0-3]))(\/(\d+))? (\*|([012]?\d|3[01]))(\/(\d+))? (\*|(1[0-2]|0?[1-9]))(\/(\d+))? (\*|[0-7])(\/(\d+))?$/, message: '需 5 字段 Cron（分 时 日 月 周）' },
                            ]}
                          >
                            <Input placeholder="开始 Cron，如 30 2 * * *" style={{ width: 200, fontFamily: 'monospace' }} />
                          </Form.Item>
                          <Form.Item
                            name={[field.name, 'end']}
                            noStyle
                            rules={[
                              { required: true, message: '结束 Cron 必填' },
                              { pattern: /^(\*|([0-5]?\d))(\/(\d+))? (\*|([01]?\d|2[0-3]))(\/(\d+))? (\*|([012]?\d|3[01]))(\/(\d+))? (\*|(1[0-2]|0?[1-9]))(\/(\d+))? (\*|[0-7])(\/(\d+))?$/, message: '需 5 字段 Cron（分 时 日 月 周）' },
                            ]}
                          >
                            <Input placeholder="结束 Cron，如 0 4 * * *" style={{ width: 200, fontFamily: 'monospace' }} />
                          </Form.Item>
                          <Form.Item name={[field.name, 'description']} noStyle>
                            <Input placeholder="说明（可选）" style={{ width: 160 }} />
                          </Form.Item>
                          <Button
                            type="text"
                            danger
                            icon={<DeleteOutlined />}
                            aria-label={`删除维护窗口 ${field.name + 1}`}
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
                          添加维护窗口
                        </Button>
                      </Form.Item>
                    </>
                  )}
                </Form.List>

                <Divider style={{ margin: '20px 0 16px' }} />
                <div style={{ marginBottom: 8 }}>
                  <Typography.Text strong>告警配置</Typography.Text>
                </div>
                <AlarmConfig />

                <Divider style={{ margin: '20px 0 16px' }} />
                <div style={{ marginBottom: 8 }}>
                  <Typography.Text strong>运行手册（可选）</Typography.Text>
                </div>
                <Form.Item
                  name="runbook"
                  label="Runbook（markdown）"
                  tooltip={{ title: '失败时的排障知识：详情页展示，失败通知附带；支持 markdown', icon: <InfoCircleOutlined /> }}
                >
                  <Input.TextArea
                    rows={6}
                    placeholder={'## 排障步骤\n1. 检查依赖服务连通性\n2. 查看上游数据是否就绪\n## 升级路径\n值班群：@xxx'}
                  />
                </Form.Item>
              </Card>
            </div>

            {/* 分区三：执行器策略与超时重试（原 step 1 下半） */}
            <div id={SECTION_IDS[2]} data-testid="section-executor" style={{ scrollMarginTop: 88 }}>
              <Typography.Title level={5} style={sectionTitleStyle}>执行器策略</Typography.Title>
              <Card style={{ marginBottom: 20 }}>
                <Form.Item
                  label={
                    <Space size={4}>
                      <span>执行器策略</span>
                      {(broadcastDisabledByPin || pinDisabledByBroadcast) && (
                        <Tooltip title="N17 互斥：广播与指定执行器不能同时生效，切换模式后另一侧恢复可用">
                          <LockOutlined style={{ color: token.colorWarning }} data-testid="executor-mutex-lock" />
                        </Tooltip>
                      )}
                    </Space>
                  }
                  required
                  tooltip={{ title: '控制任务如何分配到执行器节点', icon: <InfoCircleOutlined /> }}
                >
                  <Radio.Group
                    value={executorMode}
                    onChange={e => setExecutorMode(e.target.value)}
                    style={{ width: '100%' }}
                  >
                    <Space orientation="vertical" style={{ width: '100%' }}>
                      {EXECUTOR_MODE_OPTIONS.map(o => (
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
                                ? '与「指定执行器」互斥（N17），切回自动调度后可选'
                                : o.desc}
                            </Text>
                          </Space>
                        </Radio>
                      ))}
                    </Space>
                  </Radio.Group>
                </Form.Item>

                {executorMode === 'pinned' && (
                  <Form.Item name="executorId" label="指定执行器" required
                    rules={[{ required: true, message: '请选择执行器' }]}
                    tooltip={{ title: '任务只会派发到该执行器（按节点 ID 固定）；离线时执行将直接失败，不回退到其他节点', icon: <InfoCircleOutlined /> }}>
                    <Select
                      placeholder="选择执行器节点"
                      showSearch
                      optionFilterProp="label"
                      options={executors.map(e => ({
                        value: e.id,
                        label: `${e.appName}  (${e.address})${e.status === 'online' ? '' : ' [离线]'}`,
                      }))}
                    />
                  </Form.Item>
                )}

                {executorMode === 'group' && (
                  <>
                    <Form.Item name="executorGroup" label="执行器分组"
                      tooltip={{ title: '只有该分组内的执行器才会被选中', icon: <InfoCircleOutlined /> }}>
                      <Select placeholder="选择分组（可选）" allowClear
                        options={groups.map(g => ({ value: g, label: g }))} />
                    </Form.Item>
                    <Form.Item name="executorTags" label="执行器标签"
                      tooltip={{ title: '执行器必须拥有所有选中标签才会被选中', icon: <InfoCircleOutlined /> }}>
                      <Select
                        mode="multiple"
                        placeholder="选择标签（可选，多选表示AND关系）"
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
                  label="亲和标签"
                  tooltip={{
                    title: '执行器拥有任一标签即可命中；可与分组/执行器标签同时使用。自动调度与广播均生效。指定执行器模式不使用此约束。',
                    icon: <InfoCircleOutlined />,
                  }}
                >
                  <Select
                    mode="multiple"
                    allowClear
                    disabled={executorMode === 'pinned'}
                    placeholder="选择亲和标签（可选，OR 关系）"
                    options={allTags.map(t => ({ value: t, label: <Tag>{t}</Tag> }))}
                  />
                </Form.Item>
                <Form.Item
                  name="executorAntiAffinityTags"
                  label="反亲和标签"
                  tooltip={{
                    title: '执行器拥有任一标签即排除；可与亲和标签同时使用。自动调度与广播均生效。指定执行器模式不使用此约束。',
                    icon: <InfoCircleOutlined />,
                  }}
                >
                  <Select
                    mode="multiple"
                    allowClear
                    disabled={executorMode === 'pinned'}
                    placeholder="选择反亲和标签（可选，排除关系）"
                    options={allTags.map(t => ({ value: t, label: <Tag>{t}</Tag> }))}
                  />
                </Form.Item>
                {executorMode === 'pinned' && (
                  <Alert
                    type="info"
                    showIcon
                    title="指定执行器模式不使用亲和/反亲和约束；配置会保留，切回自动调度、分组或广播后继续生效"
                    data-testid="pinned-affinity-disabled"
                    style={{ marginBottom: 16 }}
                  />
                )}

                {pinDisabledByBroadcast && (
                  <Alert
                    type="warning"
                    showIcon
                    data-testid="broadcast-pin-cleared"
                    title="已切换到广播模式：此前选定的执行器将在提交时清空（互斥语义）"
                    style={{ marginBottom: 16 }}
                  />
                )}

                <Divider style={{ margin: '16px 0' }} />

                <Form.Item name="timeout" label={<>超时时间 <Text type="secondary" style={{ fontSize: 12 }}>（秒）</Text></>}>
                  <InputNumber min={10} max={86400} style={{ width: 160 }} placeholder="300" />
                </Form.Item>

                {/* CORE-04: 超时策略分级——超时后动作三选一。kill 为既有树杀
                    语义；kill_retry 超时终态后按任务重试预算 re-enqueue 一次；
                    notify_only 仅保证超时告警（执行器自身硬超时仍在，进程仍会
                    被执行器杀掉——并非"永不超时"）。 */}
                <Form.Item
                  name="timeoutAction"
                  label={<>超时动作 <Text type="secondary" style={{ fontSize: 12 }}>（到时后的处理方式）</Text></>}
                  initialValue="kill"
                  tooltip={{ title: '终止：执行器杀掉进程树（默认）。终止并重试：杀掉后按最大尝试次数重新排队一次。仅通知：不额外下发终止指令，只发超时告警——进程仍会被执行器的硬超时终止。', icon: <InfoCircleOutlined /> }}
                >
                  <Radio.Group optionType="button" buttonStyle="solid">
                    {TIMEOUT_ACTION_OPTIONS.map((o) => (
                      <Radio.Button key={o.value} value={o.value}>{o.label}</Radio.Button>
                    ))}
                  </Radio.Group>
                </Form.Item>

                {/* CORE-04: 超时预警——运行时长达到 超时时间×阈值% 时发一次
                    WARNING 通知（每个执行至多一次）。留空 = 不启用。 */}
                <Form.Item
                  name="timeoutWarnRatio"
                  label={<>超时预警阈值 <Text type="secondary" style={{ fontSize: 12 }}>（占超时时间的百分比，0-90；留空不预警）</Text></>}
                  tooltip={{ title: '例如超时 600 秒、阈值 80：运行到 480 秒时发送一次超时预警通知，便于在硬超时前介入。', icon: <InfoCircleOutlined /> }}
                >
                  <InputNumber min={0} max={TIMEOUT_WARN_RATIO_MAX} style={{ width: 160 }} placeholder="如 80，留空不预警" />
                </Form.Item>

                <Form.Item name="maxRetry" label={<>最大尝试次数 <Text type="secondary" style={{ fontSize: 12 }}>（1 = 不重试）</Text></>}>
                  <InputNumber min={1} max={10} style={{ width: 120 }} />
                </Form.Item>

                <Form.Item name="retryDelay" label={<>重试延迟 <Text type="secondary" style={{ fontSize: 12 }}>（秒，0 = 不延迟；实际延迟带 ±20% 抖动以摊开重试洪峰）</Text></>}>
                  <InputNumber min={0} max={3600} style={{ width: 160 }} />
                </Form.Item>

                {/* CORE-02: 可重试错误类型白名单——留空 = 全部可重试（既有语义）；
                    勾选后仅白名单内的失败（错误消息子串或失败分类，大小写不敏感）
                    会重试。timeout 类失败另有防双派发守卫，永不自动重试。 */}
                <Form.Item
                  name="retryableErrors"
                  label={<>可重试错误类型 <Text type="secondary" style={{ fontSize: 12 }}>（留空 = 全部可重试）</Text></>}
                  tooltip={{ title: '仅勾选的错误类型会被自动重试（匹配错误消息或失败分类）。例如只勾选"执行器离线"，脚本错误将在第一次失败后直接终态，不再烧尽重试预算。', icon: <InfoCircleOutlined /> }}
                >
                  <Select
                    mode="multiple"
                    allowClear
                    placeholder="不选择 = 任何失败都按重试预算自动重试"
                    options={RETRYABLE_ERROR_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                  />
                </Form.Item>

                <Form.Item name="priority" label={<>调度优先级 <Text type="secondary" style={{ fontSize: 12 }}>（BullMQ 队列优先出队；多任务拥塞时高优先行）</Text></>}>
                  <Select
                    style={{ width: 200 }}
                    options={TASK_PRIORITY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                  />
                </Form.Item>

                {/* NF-02: 上游依赖（编排）。后端 tasks.dependencies jsonb =
                    Record<taskId, taskName>；上游全部最近执行 SUCCESS 时由
                    admin-api 自动扇出触发本任务（triggerDependentTasks，
                    环检测/深度上限在 create/update 侧强制）。 */}
                <Form.Item
                  name="upstreamDependencies"
                  label="上游依赖（可选）"
                  tooltip={{
                    title:
                      '选择上游任务后，本任务会在所有上游最近一次执行全部成功时被自动触发（链式编排）。保存时校验循环依赖与链深（上限 10）。手动触发不受依赖约束。',
                    icon: <InfoCircleOutlined />,
                  }}
                >
                  <Select
                    mode="multiple"
                    showSearch
                    allowClear
                    placeholder="选择上游任务（可多选，全部成功后自动触发本任务）"
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
            <div id={SECTION_IDS[3]} data-testid="section-params" style={{ scrollMarginTop: 88 }}>
              <Typography.Title level={5} style={sectionTitleStyle}>参数与运行手册</Typography.Title>
              <Card style={{ marginBottom: 20 }}>
                <Alert
                  type="info"
                  showIcon
                  title="任务默认参数"
                  description="以下参数会在每次执行时以环境变量 AUTOFLOW_<KEY> 的形式注入到任务中。触发时可传入同名参数覆盖默认值。"
                  style={{ marginBottom: 20 }}
                />
                <Form.Item name="params" label="默认参数">
                  <ParamsEditor />
                </Form.Item>
              </Card>
            </div>
          </Form>

          {/* 分区五：Glue 脚本（原 step 3——创建后才有 taskId，保持既有行为语义：
              创建态在提交成功前不渲染 GlueEditor；编辑态 taskId 已存在直接可编） */}
          <div id={SECTION_IDS[4]} data-testid="section-glue" style={{ scrollMarginTop: 88 }}>
            <Typography.Title level={5} style={sectionTitleStyle}>Glue 脚本（可选）</Typography.Title>
            {glueTaskId ? (
              <Card style={{ marginBottom: 20 }}>
                {!isEdit && createdTaskId && (
                  <Alert
                    type="success"
                    showIcon
                    title="任务已创建成功！"
                    description="你可以在下方编写 Glue 脚本（可选）。Glue 脚本是一段在执行器节点上直接运行的代码，无需关联代码仓库。"
                    style={{ marginBottom: 20 }}
                  />
                )}
                <GlueEditor
                  taskId={glueTaskId}
                  taskRuntime={savedRuntime}
                />
                <Divider />
                <Space>
                  <Button type="primary" onClick={() => nav(`/tasks/${glueTaskId}`)}>完成，前往任务详情</Button>
                  {!isEdit && (
                    <Button onClick={() => nav('/tasks')}>跳过，返回任务列表</Button>
                  )}
                </Space>
              </Card>
            ) : (
              <Card style={{ marginBottom: 20 }}>
                <Text type="secondary" data-testid="glue-locked-hint">
                  Glue 脚本是一段在执行器节点上直接运行的代码，无需关联代码仓库。
                  创建任务后即可在此编写。
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
                  保存为模板
                </Button>
              )}
              <Button type="primary" onClick={handleSubmit} loading={saving}
                icon={<ThunderboltOutlined />}>
                {isEdit ? '保存更改' : '创建任务'}
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
        title={<Space><SaveOutlined /> 保存为自定义模板</Space>}
        open={tplModalOpen}
        onCancel={() => setTplModalOpen(false)}
        onOk={handleSaveAsTemplate}
        okText="保存模板"
        okButtonProps={{ loading: tplSaving, 'data-testid': 'tpl-save-confirm' } as never}
        cancelText="取消"
        width={520}
        destroyOnHidden
      >
        <Form form={tplForm} layout="vertical">
          <Form.Item
            name="name"
            label="模板名称"
            rules={[{ required: true, whitespace: true, message: '请输入模板名称' }]}
          >
            <Input placeholder="如：每日报表生成" maxLength={128} data-testid="tpl-name-input" />
          </Form.Item>
          <Form.Item name="description" label="描述（可选）">
            <Input.TextArea rows={2} placeholder="模板用途说明" maxLength={500} data-testid="tpl-desc-input" />
          </Form.Item>
          <Form.Item name="category" label="分类（可选）">
            <Input placeholder="如：备份 / 巡检 / 同步" maxLength={32} data-testid="tpl-category-input" />
          </Form.Item>
        </Form>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          将以当前表单值保存模板配置（触发方式/运行时/超时/重试/参数等，不含关联应用）；
          保存后可在「任务模板」页一键复用。
        </Typography.Text>
      </Modal>
    </div>
  );
}
