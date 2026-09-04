import { useState, useEffect } from 'react';
import {
  deriveExecutorMode,
  buildExecutorPayload,
} from './executor-mode';
import {
  Card, Form, Input, Select, Button, Steps, Space, Typography,
  InputNumber, Radio, Alert, message, Divider, Tag, Spin,
} from 'antd';
import {
  ThunderboltOutlined, ClockCircleOutlined, ArrowLeftOutlined,
  InfoCircleOutlined, ClusterOutlined, RocketOutlined, ApartmentOutlined, PushpinOutlined,
  CodeOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { tasksApi } from '../api/tasks';
import { executorsApi } from '../api/executors';
import { applicationsApi } from '../api/applications';
import { CronHelper } from '../components/CronHelper';
import ParamsEditor from '../components/ParamsEditor';
import GlueEditor from '../components/GlueEditor';
import AlarmConfig from '../components/AlarmConfig';

const { Title, Text } = Typography;

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

export default function TaskFormPage() {
  const nav = useNavigate();
  const { id: editId } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const appId = searchParams.get('applicationId');
  const isEdit = !!editId;

  const [step, setStep] = useState(0);
  const [form] = Form.useForm();
  const [triggerType, setTriggerType] = useState('manual');
  const [executorMode, setExecutorMode] = useState<'auto' | 'group' | 'pinned' | 'broadcast'>('auto');
  const [groups, setGroups] = useState<string[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [executors, setExecutors] = useState<{ id: string; appName: string; address: string; status: string }[]>([]);
  const [apps, setApps] = useState<{ id: string; name: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [loadingTask, setLoadingTask] = useState(isEdit);
  const [showCronHelper, setShowCronHelper] = useState(false);
  // Glue: createdTaskId is set after create so GlueEditor can save to the real task id
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);
  const [savedRuntime, setSavedRuntime] = useState('python');

  useEffect(() => {
    executorsApi.getGroups().then(setGroups).catch(() => message.warning('获取执行器分组失败'));
    executorsApi.getTags().then(setAllTags).catch(() => message.warning('获取标签失败'));
    executorsApi.list().then((data) =>
      setExecutors(data.map((e) => ({ id: e.id as string, appName: e.appName as string, address: e.address as string, status: e.status as string })))
    ).catch(() => message.warning('获取执行器列表失败'));
    applicationsApi.list().then((data) =>
      setApps(data.map((a) => ({ id: a.id as string, name: a.name as string })))
    ).catch(() => message.warning('获取应用列表失败'));
    if (appId) form.setFieldValue('applicationId', appId);
  }, [appId, form]);

  // Load existing task data when in edit mode
  useEffect(() => {
    if (!editId) return;
    setLoadingTask(true);
    tasksApi.get(editId)
      .then((task) => {
        const mode = deriveExecutorMode(task);
        setExecutorMode(mode);
        setTriggerType(task.triggerType || 'manual');
        setSavedRuntime(task.runtime || 'python');
        form.setFieldsValue({
          name: task.name,
          description: task.description,
          runtime: task.runtime,
          entrypoint: task.entrypoint,
          applicationId: task.applicationId,
          triggerType: task.triggerType || 'manual',
          cronExpression: task.cronExpression,
          timezone: task.timezone,
          fixedRate: task.fixedRate,
          timeout: task.timeoutSeconds ?? task.timeout ?? 300,
          maxRetry: task.maxRetry ?? 3,
          retryDelay: task.retryDelay ?? 0,
          executorId: task.executorId ?? undefined,
          executorGroup: task.executorGroup,
          executorTags: task.executorTags,
          params: task.params ?? {},
        });
      })
      .catch(() => message.error('加载任务失败'))
      .finally(() => setLoadingTask(false));
  }, [editId, form]);

  const handleStep0Next = async () => {
    try {
      await form.validateFields(['name', 'runtime', 'entrypoint']);
      setStep(1);
    } catch {
      return;
    }
  };

  const handleStep1Next = async () => {
    try {
      const fields = ['triggerType'];
      if (triggerType === 'cron') fields.push('cronExpression');
      if (triggerType === 'fixed_rate') fields.push('fixedRate');
      if (executorMode === 'pinned') fields.push('executorId');
      await form.validateFields(fields);
      setStep(2);
    } catch {
      return;
    }
  };

  // P0 (R8): 分步渲染会卸载 step 0/1 的 Form.Item，而 validateFields() 只
  // 校验并返回**当前挂载**的字段——step 2 提交时 name/runtime/entrypoint 等
  // 全部丢失（POST payload 缺 name → 400，创建流程完全不可用）。antd Form
  // 默认 preserve=true，卸载字段的值仍留在 store 里，因此提交改用
  // getFieldsValue(true) 取全量值；核心必填字段因表单项已卸载、规则不再参与
  // validateFields，这里做最终手动兜底校验，缺失时回退到对应步骤并报错。
  const handleSubmit = async () => {
    try {
      // 当前挂载步骤（step 2：params/alarm 等）的正常校验。
      await form.validateFields();
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      message.error(err instanceof Error ? err.message : '表单校验失败');
      return;
    }
    const values = form.getFieldsValue(true);
    const missing: { label: string; step: number }[] = [];
    if (!values.name) missing.push({ label: '任务名称', step: 0 });
    if (!values.runtime) missing.push({ label: '运行时', step: 0 });
    if (!values.entrypoint) missing.push({ label: '入口文件', step: 0 });
    if (values.triggerType === 'cron' && !values.cronExpression) {
      missing.push({ label: 'Cron 表达式', step: 1 });
    }
    if (values.triggerType === 'fixed_rate' && !values.fixedRate) {
      missing.push({ label: '执行间隔', step: 1 });
    }
    if (executorMode === 'pinned' && !values.executorId) {
      missing.push({ label: '指定执行器', step: 1 });
    }
    if (missing.length > 0) {
      message.error(`必填项缺失：${missing.map((m) => m.label).join('、')}，请补全后重试`);
      setStep(missing[0].step);
      return;
    }
    setSaving(true);
    try {
      const payload = buildExecutorPayload(values, executorMode);
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
        setStep(3);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : (isEdit ? '更新失败' : '创建失败');
      message.error(msg);
    } finally {
      setSaving(false);
    }
  };

  if (loadingTask) {
    return <div style={{ display: 'flex', justifyContent: 'center', marginTop: 100 }}><Spin size="large" tip="加载任务数据..." /></div>;
  }

  const glueTaskId = createdTaskId || (isEdit ? editId : null);

  return (
    <div style={{ maxWidth: 720 }}>
      <Space style={{ marginBottom: 20 }}>
        <Button icon={<ArrowLeftOutlined />} type="text" onClick={() => nav(-1)} />
        <Title level={4} style={{ margin: 0 }}>{isEdit ? '编辑任务' : '创建任务'}</Title>
      </Space>

      <Steps
        current={step}
        style={{ marginBottom: 28 }}
        items={[
          { title: '基本配置', icon: <ThunderboltOutlined /> },
          { title: '触发 & 执行器', icon: <ClockCircleOutlined /> },
          { title: '参数配置', icon: <ApartmentOutlined /> },
          { title: 'Glue 脚本', icon: <CodeOutlined />, content: '可选' },
        ]}
      />

      <Form
        form={form}
        layout="vertical"
        initialValues={{ triggerType: 'manual', runtime: 'python', timeout: 300, maxRetry: 3, retryDelay: 0 }}
        onValuesChange={(changed) => {
          if (changed.triggerType) setTriggerType(changed.triggerType);
        }}
      >
        {/* Step 0: 基本配置 */}
        {step === 0 && (
          <Card>
            <Form.Item
              name="name"
              label="任务名称"
              rules={[
                { required: true, message: '请输入任务名称' },
                { pattern: /^[a-zA-Z0-9_-]+$/, message: '只允许字母、数字、下划线、连字符' },
              ]}
              tooltip={{ title: isEdit ? '任务名称创建后不可更改' : '唯一标识，建议使用英文，如 daily-report', icon: <InfoCircleOutlined /> }}
            >
              <Input placeholder="daily-report" autoFocus disabled={isEdit} />
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

            <Divider />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button type="primary" onClick={handleStep0Next}>下一步：调度配置</Button>
            </div>
          </Card>
        )}

        {/* Step 1: 触发 & 执行器 */}
        {step === 1 && (
          <Card>
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

            <Divider style={{ margin: '16px 0' }} />

            <Form.Item label="执行器策略" required
              tooltip={{ title: '控制任务如何分配到执行器节点', icon: <InfoCircleOutlined /> }}>
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
                      style={{
                        border: `1px solid ${executorMode === o.value ? '#1677ff' : '#d9d9d9'}`,
                        borderRadius: 8,
                        padding: '10px 14px',
                        width: '100%',
                        background: executorMode === o.value ? '#e6f4ff' : '#fff',
                        transition: 'all 0.2s',
                      }}
                    >
                      <Space>
                        {o.icon}
                        <span style={{ fontWeight: 500 }}>{o.label}</span>
                        <Text type="secondary" style={{ fontSize: 12 }}>{o.desc}</Text>
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

            <Divider style={{ margin: '16px 0' }} />

            <Form.Item name="timeout" label={<>超时时间 <Text type="secondary" style={{ fontSize: 12 }}>（秒）</Text></>}>
              <InputNumber min={10} max={86400} style={{ width: 160 }} placeholder="300" />
            </Form.Item>

            <Form.Item name="maxRetry" label={<>最大尝试次数 <Text type="secondary" style={{ fontSize: 12 }}>（1 = 不重试）</Text></>}>
              <InputNumber min={1} max={10} style={{ width: 120 }} />
            </Form.Item>

            <Form.Item name="retryDelay" label={<>重试延迟 <Text type="secondary" style={{ fontSize: 12 }}>（秒，0 = 不延迟）</Text></>}>
              <InputNumber min={0} max={3600} style={{ width: 160 }} />
            </Form.Item>

            <Divider />
            <Space>
              <Button onClick={() => setStep(0)}>上一步</Button>
              <Button type="primary" onClick={handleStep1Next}>下一步：参数配置</Button>
            </Space>
          </Card>
        )}

        {/* Step 2: 参数配置 */}
        {step === 2 && (
          <Card>
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

            <Divider style={{ margin: '20px 0 16px' }} />
            <div style={{ marginBottom: 8 }}>
              <Typography.Text strong>告警配置</Typography.Text>
            </div>
            <AlarmConfig />

            <Divider />
            <Space>
              <Button onClick={() => setStep(1)}>上一步</Button>
              <Button type="primary" onClick={handleSubmit} loading={saving}
                icon={<ThunderboltOutlined />}>
                {isEdit ? '保存更改' : '创建任务'}
              </Button>
            </Space>
          </Card>
        )}

        {/* Step 3: Glue 脚本（创建后可选） */}
        {step === 3 && glueTaskId && (
          <Card>
            <Alert
              type="success"
              showIcon
              title="任务已创建成功！"
              description="你可以在下方编写 Glue 脚本（可选）。Glue 脚本是一段在执行器节点上直接运行的代码，无需关联代码仓库。"
              style={{ marginBottom: 20 }}
            />
            <GlueEditor
              taskId={glueTaskId}
              taskRuntime={savedRuntime}
            />
            <Divider />
            <Space>
              <Button type="primary" onClick={() => nav(`/tasks/${glueTaskId}`)}>完成，前往任务详情</Button>
              <Button onClick={() => nav('/tasks')}>跳过，返回任务列表</Button>
            </Space>
          </Card>
        )}
      </Form>

      <CronHelper
        open={showCronHelper}
        onClose={() => setShowCronHelper(false)}
        onSelect={(expr) => {
          form.setFieldValue('cronExpression', expr);
          setShowCronHelper(false);
        }}
      />
    </div>
  );
}
