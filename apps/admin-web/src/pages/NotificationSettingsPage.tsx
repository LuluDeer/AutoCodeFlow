import { useState } from 'react';
import { Card, Form, Input, Switch, Button, Space, message, Tabs, Divider, Tag, Typography, Alert, Checkbox, Popconfirm, Table, Select, InputNumber, Tooltip } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, InfoCircleOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import type { ColumnsType } from 'antd/es/table';
import { client } from '../api/client';
import { silencesApi, type NotificationSilence, type CreateSilencePayload, type SilenceScope } from '../api/notifications';
import { getErrMsg } from '../utils/error';
import { useAuthStore, isAdminUser } from '../store/auth';
import PageHeader from '../components/PageHeader';
import StateError from '../components/StateError';

const { TextArea } = Input;
const { Text } = Typography;

interface NotificationChannel {
  key: string;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  description: string;
}

interface TestResult {
  success: boolean;
  message: string;
  channel?: string;
}

const notificationApi = {
  getChannels: () => client.get('/notification/channels') as Promise<NotificationChannel[]>,
  updateChannel: (key: string, data: Partial<NotificationChannel>) =>
    client.patch(`/notification/channels/${key}`, data) as Promise<NotificationChannel>,
  testChannel: (key: string, data: Record<string, string>) =>
    client.post(`/notification/channels/${key}/test`, data) as Promise<{ success: boolean; message: string }>,
  sendTestNotification: (data: { channels: string[]; title: string; content: string }) =>
    client.post('/notification/test', data) as Promise<{ success: boolean; message: string }>,
};

const CHANNEL_CONFIG_FIELDS: Record<string, Array<{ key: string; label: string; placeholder?: string }>> = {
  email: [
    { key: 'host', label: 'SMTP Host', placeholder: 'smtp.example.com' },
    { key: 'port', label: 'SMTP Port', placeholder: '587' },
    { key: 'user', label: '用户名' },
    { key: 'password', label: '密码' },
    { key: 'from', label: '发件人', placeholder: 'noreply@example.com' },
    { key: 'to', label: '默认收件人', placeholder: 'admin@example.com' },
  ],
  slack: [
    { key: 'webhookUrl', label: 'Webhook URL', placeholder: 'https://hooks.slack.com/services/...' },
    { key: 'channel', label: '默认频道', placeholder: '#alerts' },
  ],
  dingtalk: [
    { key: 'webhookUrl', label: 'Webhook URL', placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=...' },
  ],
  wecom: [
    { key: 'webhookUrl', label: 'Webhook URL', placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...' },
  ],
};

// ─── FEAT-10: 渠道级通知模板 ────────────────────────────────────────────────
// 模板以 titleTemplate / contentTemplate 两个可选 config 键存储（与渠道其它
// 配置同走 PATCH /notification/channels/:key，零迁移）。留空 = 走系统固定
// 拼串（零破坏）。变量占位符 {{var}}，未知变量保留原文，输出上限 8KB。
const TEMPLATE_VAR_DOCS = [
  ['{{task}} / {{taskName}}', '任务名称'],
  ['{{executionId}}', '执行 ID'],
  ['{{failedReason}}', '失败原因/错误摘要'],
  ['{{logs}}', '日志摘要（失败路径）'],
  ['{{duration}}', '执行时长（毫秒，成功路径）'],
  ['{{runbook}}', '运行手册链接（若任务已配置）'],
  ['{{level}}', '通知级别（info/warning/error）'],
] as const;

function TemplateVarsTooltip() {
  return (
    <div>
      <div>可用变量（占位符替换，未知变量保留原文，输出上限 8KB）：</div>
      {TEMPLATE_VAR_DOCS.map(([v, d]) => (
        <div key={v}>
          <Typography.Text code style={{ fontSize: 12 }}>{v}</Typography.Text>
          {' '}
          <span>{d}</span>
        </div>
      ))}
    </div>
  );
}

/** FEAT-10: 渠道模板编辑区（可折叠，独立于基础连接配置的 Form） */
function ChannelTemplatePanel({
  channelKey,
  config,
  onSaved,
}: {
  channelKey: string;
  config: Record<string, string>;
  onSaved: () => void;
}) {
  const [form] = Form.useForm();
  const [collapsed, setCollapsed] = useState(
    !config.titleTemplate && !config.contentTemplate,
  );

  const { run: saveTemplate, loading: saving } = useRequest(
    async (values: { titleTemplate?: string; contentTemplate?: string }) => {
      // 折叠即视为不使用模板：显式提交空串（后端空串=未配置，走固定拼串）
      await notificationApi.updateChannel(channelKey, {
        config: {
          titleTemplate: values.titleTemplate ?? '',
          contentTemplate: values.contentTemplate ?? '',
        },
      });
    },
    // UI-15：模板保存失败反馈（ahooks useRequest manual onError）
    {
      manual: true,
      onSuccess: () => { message.success('模板已保存'); onSaved(); },
      onError: (err: unknown) => { message.error(getErrMsg(err, '保存模板失败')); },
    },
  );

  if (collapsed) {
    return (
      <Card
        type="inner"
        title="消息模板（可选）"
        style={{ marginTop: 16 }}
        extra={
          <Button type="link" size="small" onClick={() => setCollapsed(false)}>
            展开
          </Button>
        }
      >
        <Text type="secondary">未配置模板 — 使用系统默认内容格式。</Text>
      </Card>
    );
  }

  return (
    <Card
      type="inner"
      title={
        <Space>
          <span>消息模板（可选）</span>
          <Tooltip title={<TemplateVarsTooltip />}>
            <InfoCircleOutlined />
          </Tooltip>
        </Space>
      }
      style={{ marginTop: 16 }}
      extra={
        <Button type="link" size="small" onClick={() => setCollapsed(true)}>
          收起
        </Button>
      }
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          titleTemplate: config.titleTemplate ?? '',
          contentTemplate: config.contentTemplate ?? '',
        }}
        onFinish={saveTemplate}
      >
        <Form.Item
          name="titleTemplate"
          label={
            <Space>
              标题模板
              <Tooltip title={<TemplateVarsTooltip />}>
                <InfoCircleOutlined />
              </Tooltip>
            </Space>
          }
        >
          <TextArea
            rows={2}
            maxLength={500}
            placeholder={'例如：[{{level}}] 任务 {{taskName}} 执行失败'}
          />
        </Form.Item>
        <Form.Item name="contentTemplate" label="内容模板">
          <TextArea
            rows={4}
            maxLength={8000}
            placeholder={'例如：执行 {{executionId}} 失败：{{failedReason}}\n日志：{{logs}}'}
          />
        </Form.Item>
        <Form.Item style={{ marginBottom: 0 }}>
          <Button type="primary" htmlType="submit" loading={saving}>
            保存模板
          </Button>
        </Form.Item>
      </Form>
    </Card>
  );
}

// ─── 单渠道配置面板（W1）────────────────────────────────────────────────────
// 每个渠道一个独立组件实例 → Form.useForm() 为该渠道私有，字段同名（如三个渠道的
// webhookUrl）也互不串写。antd Tabs 非激活面板默认保持挂载（removeOnLeave=false），
// 共用单个 form 实例时会发生跨渠道并集合并与 resetFields 串清，这里从根上消除。
function ChannelConfigForm({
  channelKey,
  config,
  description,
  onSaved,
}: {
  channelKey: string;
  config: Record<string, string>;
  description: string;
  onSaved: () => void;
}) {
  const [form] = Form.useForm();
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const { run: updateChannel, loading: updating } = useRequest(
    async (values: Record<string, string>) => {
      await notificationApi.updateChannel(channelKey, { config: values });
    },
    // UI-15：渠道配置保存失败反馈
    {
      manual: true,
      onSuccess: () => { message.success('保存成功'); onSaved(); },
      onError: (err: unknown) => { message.error(getErrMsg(err, '保存失败')); },
    },
  );

  const { run: testChannel, loading: testing } = useRequest(
    async (values: Record<string, string>) => {
      const result = await notificationApi.testChannel(channelKey, values);
      setTestResult({ success: result.success, message: result.message, channel: channelKey });
    },
    // UI-15：测试请求本身失败（网络/5xx）也要有可见反馈——业务失败
    // （success=false）走下方 testResult Alert 形态。
    {
      manual: true,
      onError: (err: unknown) => {
        message.error(getErrMsg(err, '发送测试请求失败'));
        setTestResult({ success: false, message: getErrMsg(err, '发送测试请求失败'), channel: channelKey });
      },
    },
  );

  const fields = CHANNEL_CONFIG_FIELDS[channelKey] || [];

  return (
    <div>
      <Text type="secondary">{description}</Text>
      <Divider />
      <Form
        form={form}
        layout="vertical"
        initialValues={config}
        onFinish={updateChannel}
      >
        {fields.map((f) => (
          <Form.Item
            key={f.key}
            name={f.key}
            label={f.label}
            rules={[
              f.key !== 'password'
                ? { required: true, whitespace: true, message: `请输入 ${f.label}` }
                : { required: false },
            ]}
          >
            {f.key === 'password' ? (
              <Input.Password placeholder={f.placeholder} />
            ) : (
              <Input placeholder={f.placeholder} />
            )}
          </Form.Item>
        ))}
        <Form.Item>
          <Space orientation="vertical" style={{ width: '100%' }}>
            <Space>
              <Button type="primary" htmlType="submit" loading={updating}>保存</Button>
              <Button
                onClick={() => {
                  setTestResult(null);
                  testChannel(form.getFieldsValue());
                }}
                loading={testing}
              >
                发送测试
              </Button>
            </Space>
            {testResult && (
              <Alert
                type={testResult.success ? 'success' : 'error'}
                icon={testResult.success
                  ? <CheckCircleFilled style={{ color: '#52c41a' }} />
                  : <CloseCircleFilled style={{ color: '#ff4d4f' }} />}
                showIcon
                title={
                  testResult.success
                    ? `${testResult.channel ?? channelKey} 测试消息发送成功`
                    : `测试失败：${testResult.message}`
                }
                closable
                onClose={() => setTestResult(null)}
              />
            )}
          </Space>
        </Form.Item>
      </Form>
    </div>
  );
}

// ─── FEAT-01: 静默规则面板 ───────────────────────────────────────────────────
// 后端端点（ADMIN-only，对齐 admin-api notification-config.controller.ts）：
//   GET/POST /notification/silences、DELETE /notification/silences/:id。
// 抑制语义（与后端 NotificationService.isSilenced 逐条对齐）：
//   生效窗口内（startTime<=now<=endTime），命中 taskId（为空=全部任务）与
//   level（为空=全部级别）的告警在发送前即被丢弃——全渠道抑制，不区分渠道；
//   scope=task/application 均以 taskId 判定，channelType 仅作范围记录。
const CHANNEL_LABELS: Record<string, string> = {
  email: '邮件',
  slack: 'Slack',
  dingtalk: '钉钉',
  wecom: '企业微信',
  webhook: 'Webhook',
};

function fmtEndTime(v: string | null): string {
  return v ? new Date(v).toLocaleString('zh-CN') : '不过期';
}

/** 剩余时间；已过期或无界（endTime 为空）返回 null */
function fmtRemaining(endTime: string | null): string | null {
  if (!endTime) return null;
  const mins = Math.floor((new Date(endTime).getTime() - Date.now()) / 60_000);
  if (mins <= 0) return null;
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}

function SilenceRulesPanel({ active }: { active: boolean }) {
  const [form] = Form.useForm();
  const scope: SilenceScope = Form.useWatch('scope', form) ?? 'global';

  // 仅在「静默规则」Tab 激活时拉取（useRequest ready），避免进入页面即发 ADMIN-only 请求
  const { data: silences, loading, refresh, error } = useRequest(silencesApi.list, { ready: active });

  const { run: createRule, loading: creating } = useRequest(
    async (payload: CreateSilencePayload) => {
      await silencesApi.create(payload);
    },
    // UI-15：新建失败反馈
    {
      manual: true,
      onSuccess: () => { message.success('静默规则已创建'); form.resetFields(); refresh(); },
      onError: (err: unknown) => { message.error(getErrMsg(err, '创建静默规则失败')); },
    },
  );

  const { run: removeRule } = useRequest(
    async (id: string) => {
      await silencesApi.remove(id);
    },
    // UI-15：删除失败反馈
    {
      manual: true,
      onSuccess: () => { message.success('静默规则已删除'); refresh(); },
      onError: (err: unknown) => { message.error(getErrMsg(err, '删除静默规则失败')); },
    },
  );

  const onFinish = (values: {
    scope: SilenceScope;
    taskId?: string;
    applicationId?: string;
    durationMinutes: number;
    reason?: string;
  }) => {
    const payload: CreateSilencePayload = {
      scope: values.scope,
      durationMinutes: values.durationMinutes,
    };
    if (values.reason?.trim()) payload.reason = values.reason.trim();
    if (values.scope === 'task') payload.taskId = values.taskId?.trim();
    if (values.scope === 'application') payload.applicationId = values.applicationId?.trim();
    createRule(payload);
  };

  const cols: ColumnsType<NotificationSilence> = [
    { title: '维度', dataIndex: 'scope', width: 220,
      render: (_: unknown, r: NotificationSilence) =>
        r.scope === 'global' ? (
          <Tag color="purple">全局</Tag>
        ) : r.scope === 'task' ? (
          <span>任务 <Typography.Text code style={{ fontSize: 12 }}>{r.taskId ?? '-'}</Typography.Text></span>
        ) : (
          <span>应用 <Typography.Text code style={{ fontSize: 12 }}>{r.applicationId ?? '-'}</Typography.Text></span>
        ) },
    { title: '渠道', dataIndex: 'channelType', width: 100,
      render: (v: string | null) => (v ? CHANNEL_LABELS[v] ?? v : '全部渠道') },
    { title: '有效期至', dataIndex: 'endTime', width: 170, render: fmtEndTime },
    { title: '剩余时间', dataIndex: 'endTime', width: 130,
      render: (v: string | null) => {
        const remain = fmtRemaining(v);
        if (remain) return remain;
        return v ? <Tag color="red">已过期</Tag> : <Typography.Text type="secondary">-</Typography.Text>;
      } },
    { title: '创建人', dataIndex: 'createdBy', width: 100,
      render: (v: string | null) => v ?? '-' },
    { title: '说明', dataIndex: 'reason', ellipsis: true,
      render: (v: string | null) => v ?? '-' },
    { title: '', width: 80,
      render: (_: unknown, r: NotificationSilence) => (
        // Popconfirm 删除，对齐 settings 页 SystemConfigTab 先例
        <Popconfirm
          title="确认删除此静默规则？"
          description="删除后对应告警将立即恢复推送。"
          okText="删除"
          okButtonProps={{ danger: true }}
          onConfirm={() => removeRule(r.id)}
        >
          <Button size="small" danger>删除</Button>
        </Popconfirm>
      ) },
  ];

  return (
    <div>
      <Alert
        type="info"
        showIcon
        title="静默生效期间，命中规则的告警将被抑制发送"
        description={
          '在有效期窗口内（生效中的规则在服务重启后仍保留），命中任务与级别的告警在发送前即被拦截、不会推送到任何通知渠道。' +
          '匹配逻辑与后端发送判定一致：未指定任务 = 全部任务，级别为全部级别；静默命中时全渠道抑制，渠道字段仅作范围记录。'
        }
      />
      <Card type="inner" title="新建静默规则" style={{ marginTop: 16 }}>
        <Form form={form} layout="vertical" initialValues={{ scope: 'global' }} onFinish={onFinish}>
          <Form.Item name="scope" label="静默维度" rules={[{ required: true, message: '请选择静默维度' }]}>
            <Select
              options={[
                { value: 'global', label: '全局（抑制所有任务的告警）' },
                { value: 'task', label: '指定任务' },
                { value: 'application', label: '指定应用' },
              ]}
            />
          </Form.Item>
          {scope === 'task' && (
            <Form.Item name="taskId" label="任务 ID" rules={[{ required: true, whitespace: true, message: '请输入任务 ID' }]}>
              <Input placeholder="任务 UUID（仅该任务的告警被静默）" />
            </Form.Item>
          )}
          {scope === 'application' && (
            <Form.Item name="applicationId" label="应用 ID" rules={[{ required: true, whitespace: true, message: '请输入应用 ID' }]}>
              <Input placeholder="应用 UUID（该应用下任务的告警被静默）" />
            </Form.Item>
          )}
          <Form.Item name="durationMinutes" label="静默时长" rules={[{ required: true, message: '请输入静默时长' }]}>
            <InputNumber min={1} precision={0} placeholder="如 30" addonAfter="分钟" style={{ width: 220 }} />
          </Form.Item>
          <Form.Item name="reason" label="说明（可选）">
            <TextArea rows={2} maxLength={255} placeholder="静默原因，如：发布窗口、线上维护" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={creating}>新建静默规则</Button>
          </Form.Item>
        </Form>
      </Card>
      <Card type="inner" title="静默规则列表" style={{ marginTop: 16 }}>
        {/* UI-16：列表请求失败 → 页内错误块（重试=refresh），不落「暂无静默规则」误导空态 */}
        {error ? (
          <StateError error={error} title="静默规则加载失败" onRetry={refresh} />
        ) : (
          <Table
            loading={loading}
            dataSource={silences ?? []}
            rowKey="id"
            columns={cols}
            size="small"
            pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }}
            locale={{ emptyText: '暂无静默规则' }}
          />
        )}
      </Card>
    </div>
  );
}

export default function NotificationSettingsPage() {
  const [activeTab, setActiveTab] = useState('email');
  const [globalTestResult, setGlobalTestResult] = useState<TestResult | null>(null);
  // FEAT-01: 静默规则 CRUD 端点为 ADMIN-only，非管理员不渲染 Tab（零入口，
  // 对齐 settings 页 useIsAdmin 先例——不做无谓的 403 请求）
  const user = useAuthStore((s) => s.user);
  const isAdmin = isAdminUser(user);

  const { data: channels, loading, refresh, error: channelsError } = useRequest(notificationApi.getChannels);
  const channel = channels?.find((c) => c.key === activeTab);

  const { run: sendTest, loading: sending } = useRequest(
    async (data: { channels: string[]; title: string; content: string }) => {
      const result = await notificationApi.sendTestNotification(data);
      setGlobalTestResult({ success: result.success, message: result.message });
    },
    // UI-15：测试发送请求本身失败（网络/5xx）也要有可见反馈——业务失败
    // （success=false）走下方 globalTestResult Alert 形态。
    {
      manual: true,
      onError: (err: unknown) => {
        setGlobalTestResult({ success: false, message: getErrMsg(err, '发送测试通知失败') });
      },
    },
  );

  const handleEnableChange = async (enabled: boolean) => {
    try {
      await notificationApi.updateChannel(activeTab, { enabled });
    } catch (err: unknown) {
      // UI-15：渠道启停失败反馈（此前失败静默，Switch 视觉状态与后端不一致且无提示）
      message.error(getErrMsg(err, '更新渠道状态失败'));
      return;
    }
    refresh();
    message.success(`已${enabled ? '启用' : '禁用'} ${channel?.name}`);
  };

  const tabItems = channels?.map((c: NotificationChannel) => ({
    key: c.key,
    label: (
      <span>
        {c.name}
        {c.enabled ? <Tag color="green" style={{ marginLeft: 8 }}>已启用</Tag> : <Tag style={{ marginLeft: 8 }}>已禁用</Tag>}
      </span>
    ),
    children: (
      <div>
        <Space style={{ marginBottom: 16 }}>
          <Text>启用此通知渠道：</Text>
          <Switch checked={c.enabled} onChange={handleEnableChange} />
        </Space>
        <Divider />
        {c.enabled ? (
          // W1：渠道级独立组件——每渠道私有 form 实例，面板间字段与保存互不影响
          <>
            <ChannelConfigForm
              key={c.key}
              channelKey={c.key}
              config={c.config || {}}
              description={c.description}
              onSaved={refresh}
            />
            {/* FEAT-10: 渠道级消息模板（titleTemplate/contentTemplate，可折叠） */}
            <ChannelTemplatePanel
              key={`${c.key}-template`}
              channelKey={c.key}
              config={c.config || {}}
              onSaved={refresh}
            />
          </>
        ) : (
          <Alert title="此通知渠道已禁用，启用后可配置推送参数" type="info" showIcon />
        )}
      </div>
    ),
  })) ?? [];

  // FEAT-01: 增量追加「静默规则」Tab（不影响既有渠道 Tab 的组织方式）；
  // 面板仅在激活时拉取列表（ready: active）。
  const tabItems2 = [
    ...tabItems,
    ...(isAdmin
      ? [{
          key: 'silences',
          label: '静默规则',
          children: <SilenceRulesPanel active={activeTab === 'silences'} />,
        }]
      : []),
  ];

  return (
    <div>
      {/* UI-03/UI-08：页头标准化（原 Typography.Title 区块迁入 PageHeader） */}
      <PageHeader
        title="通知设置"
        description="配置告警通知渠道（邮件/Slack/钉钉/企业微信）、静默规则与全局测试发送。"
      />
      {/* UI-16：渠道列表请求失败且无任何缓存数据 → 页内错误块（重试=refresh）；
          此前失败会停在 Card loading 后的空白，用户既看不到原因也无重试入口。
          已有缓存时（如刷新失败）保持展示旧数据，不打断阅读。 */}
      {channelsError && !channels ? (
        <StateError error={channelsError} title="通知渠道加载失败" onRetry={refresh} />
      ) : (
        <Card loading={loading}>
          {/* W1：ChannelConfigForm 自带渠道私有 form 与测试状态，切 Tab 无需 resetFields */}
          <Tabs
            activeKey={activeTab}
            onChange={(k) => { setActiveTab(k); }}
            items={tabItems2}
          />
        </Card>
      )}

      <Card title="全局测试" style={{ marginTop: 16 }}>
        <Form
          layout="vertical"
          onFinish={(values) => { setGlobalTestResult(null); sendTest(values); }}
        >
          <Form.Item name="channels" label="选择渠道" rules={[{ required: true, message: '请选择至少一个渠道' }]}>
            <Checkbox.Group>
              <Space orientation="vertical">
                <Checkbox value="email">邮件</Checkbox>
                <Checkbox value="slack">Slack</Checkbox>
                <Checkbox value="dingtalk">钉钉</Checkbox>
                <Checkbox value="wecom">企业微信</Checkbox>
                <Checkbox value="webhook">Webhook</Checkbox>
              </Space>
            </Checkbox.Group>
          </Form.Item>
          <Form.Item name="title" label="标题" rules={[{ required: true }]}>
            <Input placeholder="测试通知" />
          </Form.Item>
          <Form.Item name="content" label="内容" rules={[{ required: true }]}>
            <TextArea rows={3} placeholder="这是一条测试通知..." />
          </Form.Item>
          <Form.Item>
            <Space orientation="vertical" style={{ width: '100%' }}>
              <Button type="primary" htmlType="submit" loading={sending}>发送测试通知</Button>
              {globalTestResult && (
                <Alert
                  type={globalTestResult.success ? 'success' : 'error'}
                  icon={globalTestResult.success
                    ? <CheckCircleFilled style={{ color: '#52c41a' }} />
                    : <CloseCircleFilled style={{ color: '#ff4d4f' }} />}
                  showIcon
                  title={
                    globalTestResult.success
                      ? '测试通知已发送到所选渠道'
                      : `发送失败：${globalTestResult.message}`
                  }
                  closable
                  onClose={() => setGlobalTestResult(null)}
                />
              )}
            </Space>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
