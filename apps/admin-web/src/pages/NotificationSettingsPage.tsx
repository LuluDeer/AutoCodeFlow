import { useState } from 'react';
import { Card, Form, Input, Switch, Button, Space, message, Tabs, Divider, Tag, Typography, Alert, Checkbox, Popconfirm, Table, Select, InputNumber, Tooltip } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, InfoCircleOutlined } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import type { ColumnsType } from 'antd/es/table';
import { client } from '../api/client';
import { silencesApi, type NotificationSilence, type CreateSilencePayload, type SilenceScope } from '../api/notifications';
import { getErrMsg } from '../utils/error';
import { useTranslation } from 'react-i18next';
import { useAuthStore, isAdminUser } from '../store/auth';
// UI-10：导入 i18n 实例（模块副作用完成初始化；树内用 useTranslation 读 key）
import '../i18n';
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

const CHANNEL_CONFIG_FIELDS = (t: (k: string) => string): Record<string, Array<{ key: string; label: string; placeholder?: string }>> => ({
  email: [
    { key: 'host', label: 'SMTP Host', placeholder: 'smtp.example.com' },
    { key: 'port', label: 'SMTP Port', placeholder: '587' },
    { key: 'user', label: t('notif.channel.field.user') },
    { key: 'password', label: t('notif.channel.field.password') },
    { key: 'from', label: t('notif.channel.field.from'), placeholder: 'noreply@example.com' },
    { key: 'to', label: t('notif.channel.field.to'), placeholder: 'admin@example.com' },
  ],
  slack: [
    { key: 'webhookUrl', label: 'Webhook URL', placeholder: 'https://hooks.slack.com/services/...' },
    { key: 'channel', label: t('notif.channel.field.channel'), placeholder: '#alerts' },
  ],
  dingtalk: [
    { key: 'webhookUrl', label: 'Webhook URL', placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=...' },
  ],
  wecom: [
    { key: 'webhookUrl', label: 'Webhook URL', placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...' },
  ],
});

// ─── FEAT-10: 渠道级通知模板 ────────────────────────────────────────────────
// 模板以 titleTemplate / contentTemplate 两个可选 config 键存储（与渠道其它
// 配置同走 PATCH /notification/channels/:key，零迁移）。留空 = 走系统固定
// 拼串（零破坏）。变量占位符 {{var}}，未知变量保留原文，输出上限 8KB。
const TEMPLATE_VAR_DOCS = (t: (k: string) => string): Array<readonly [string, string]> => [
  ['{{task}} / {{taskName}}', t('notif.template.var.taskName')],
  ['{{executionId}}', t('notif.template.var.executionId')],
  ['{{failedReason}}', t('notif.template.var.failedReason')],
  ['{{logs}}', t('notif.template.var.logs')],
  ['{{duration}}', t('notif.template.var.duration')],
  ['{{runbook}}', t('notif.template.var.runbook')],
  ['{{level}}', t('notif.template.var.level')],
];

function TemplateVarsTooltip() {
  const { t } = useTranslation();
  return (
    <div>
      <div>{t('notif.template.varsTooltip')}</div>
      {TEMPLATE_VAR_DOCS(t).map(([v, d]) => (
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
  const { t } = useTranslation();
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
      onSuccess: () => { message.success(t('notif.template.saved')); onSaved(); },
      onError: (err: unknown) => { message.error(getErrMsg(err, t('notif.template.saveFail'))); },
    },
  );

  if (collapsed) {
    return (
      <Card
        type="inner"
        title={t('notif.template.title')}
        style={{ marginTop: 16 }}
        extra={
          <Button type="link" size="small" onClick={() => setCollapsed(false)}>
            {t('notif.template.expand')}
          </Button>
        }
      >
        <Text type="secondary">{t('notif.template.notConfigured')}</Text>
      </Card>
    );
  }

  return (
    <Card
      type="inner"
      title={
        <Space>
          <span>{t('notif.template.title')}</span>
          <Tooltip title={<TemplateVarsTooltip />}>
            <InfoCircleOutlined />
          </Tooltip>
        </Space>
      }
      style={{ marginTop: 16 }}
      extra={
        <Button type="link" size="small" onClick={() => setCollapsed(true)}>
          {t('notif.template.collapse')}
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
              {t('notif.template.titleLabel')}
              <Tooltip title={<TemplateVarsTooltip />}>
                <InfoCircleOutlined />
              </Tooltip>
            </Space>
          }
        >
          <TextArea
            rows={2}
            maxLength={500}
            placeholder={t('notif.template.titlePlaceholder')}
          />
        </Form.Item>
        <Form.Item name="contentTemplate" label={t('notif.template.contentLabel')}>
          <TextArea
            rows={4}
            maxLength={8000}
            placeholder={t('notif.template.contentPlaceholder')}
          />
        </Form.Item>
        <Form.Item style={{ marginBottom: 0 }}>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t('notif.template.save')}
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
  const { t } = useTranslation();
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const { run: updateChannel, loading: updating } = useRequest(
    async (values: Record<string, string>) => {
      await notificationApi.updateChannel(channelKey, { config: values });
    },
    // UI-15：渠道配置保存失败反馈
    {
      manual: true,
      onSuccess: () => { message.success(t('notif.channel.saved')); onSaved(); },
      onError: (err: unknown) => { message.error(getErrMsg(err, t('notif.channel.saveFail'))); },
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
        message.error(getErrMsg(err, t('notif.channel.testFail')));
        setTestResult({ success: false, message: getErrMsg(err, t('notif.channel.testFail')), channel: channelKey });
      },
    },
  );

  const fields = CHANNEL_CONFIG_FIELDS(t)[channelKey] || [];

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
                ? { required: true, whitespace: true, message: t('notif.channel.requiredValue', { label: f.label }) }
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
              <Button type="primary" htmlType="submit" loading={updating}>{t('notif.channel.save')}</Button>
              <Button
                onClick={() => {
                  setTestResult(null);
                  testChannel(form.getFieldsValue());
                }}
                loading={testing}
              >
                {t('notif.channel.test')}
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
                    ? t('notif.channel.testSuccess', { channel: testResult.channel ?? channelKey })
                    : t('notif.channel.testError', { msg: testResult.message })
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
const CHANNEL_LABELS = (t: (k: string) => string): Record<string, string> => ({
  email: t('notif.channel.email'),
  slack: 'Slack',
  dingtalk: t('notif.channel.dingtalk'),
  wecom: t('notif.channel.wecom'),
  webhook: 'Webhook',
});

function SilenceRulesPanel({ active }: { active: boolean }) {
  const [form] = Form.useForm();
  const { t } = useTranslation();
  const scope: SilenceScope = Form.useWatch('scope', form) ?? 'global';

  const fmtEndTime = (v: string | null): string =>
    v ? new Date(v).toLocaleString('zh-CN') : t('notif.silence.never');

  /** 剩余时间；已过期或无界（endTime 为空）返回 null */
  const fmtRemaining = (endTime: string | null): string | null => {
    if (!endTime) return null;
    const mins = Math.floor((new Date(endTime).getTime() - Date.now()) / 60_000);
    if (mins <= 0) return null;
    const d = Math.floor(mins / 1440);
    const h = Math.floor((mins % 1440) / 60);
    const m = mins % 60;
    if (d > 0) return t('notif.silence.remain.dayHour', { d, h });
    if (h > 0) return t('notif.silence.remain.hourMin', { h, m });
    return t('notif.silence.remain.min', { m });
  };

  // 仅在「静默规则」Tab 激活时拉取（useRequest ready），避免进入页面即发 ADMIN-only 请求
  const { data: silences, loading, refresh, error } = useRequest(silencesApi.list, { ready: active });

  const { run: createRule, loading: creating } = useRequest(
    async (payload: CreateSilencePayload) => {
      await silencesApi.create(payload);
    },
    // UI-15：新建失败反馈
    {
      manual: true,
      onSuccess: () => { message.success(t('notif.silence.created')); form.resetFields(); refresh(); },
      onError: (err: unknown) => { message.error(getErrMsg(err, t('notif.silence.createFail'))); },
    },
  );

  const { run: removeRule } = useRequest(
    async (id: string) => {
      await silencesApi.remove(id);
    },
    // UI-15：删除失败反馈
    {
      manual: true,
      onSuccess: () => { message.success(t('notif.silence.deleted')); refresh(); },
      onError: (err: unknown) => { message.error(getErrMsg(err, t('notif.silence.deleteFail'))); },
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
    { title: t('notif.silence.col.dimension'), dataIndex: 'scope', width: 220,
      render: (_: unknown, r: NotificationSilence) =>
        r.scope === 'global' ? (
          <Tag color="purple">{t('notif.silence.scope.global')}</Tag>
        ) : r.scope === 'task' ? (
          <span>{t('notif.silence.scope.task')} <Typography.Text code style={{ fontSize: 12 }}>{r.taskId ?? '-'}</Typography.Text></span>
        ) : (
          <span>{t('notif.silence.scope.application')} <Typography.Text code style={{ fontSize: 12 }}>{r.applicationId ?? '-'}</Typography.Text></span>
        ) },
    { title: t('notif.silence.col.channel'), dataIndex: 'channelType', width: 100,
      render: (v: string | null) => (v ? CHANNEL_LABELS(t)[v] ?? v : t('notif.silence.channel.all')) },
    { title: t('notif.silence.col.endTime'), dataIndex: 'endTime', width: 170, render: fmtEndTime },
    { title: t('notif.silence.col.remaining'), dataIndex: 'endTime', width: 130,
      render: (v: string | null) => {
        const remain = fmtRemaining(v);
        if (remain) return remain;
        return v ? <Tag color="red">{t('notif.silence.expired')}</Tag> : <Typography.Text type="secondary">-</Typography.Text>;
      } },
    { title: t('notif.silence.col.createdBy'), dataIndex: 'createdBy', width: 100,
      render: (v: string | null) => v ?? '-' },
    { title: t('notif.silence.col.reason'), dataIndex: 'reason', ellipsis: true,
      render: (v: string | null) => v ?? '-' },
    { title: '', width: 80,
      render: (_: unknown, r: NotificationSilence) => (
        // Popconfirm 删除，对齐 settings 页 SystemConfigTab 先例
        <Popconfirm
          title={t('notif.silence.deleteConfirm')}
          description={t('notif.silence.deleteConfirmDesc')}
          okText={t('notif.silence.delete')}
          okButtonProps={{ danger: true }}
          onConfirm={() => removeRule(r.id)}
        >
          <Button size="small" danger>{t('notif.silence.delete')}</Button>
        </Popconfirm>
      ) },
  ];

  return (
    <div>
      <Alert
        type="info"
        showIcon
        title={t('notif.silence.alertTitle')}
        description={t('notif.silence.alertDesc')}
      />
      <Card type="inner" title={t('notif.silence.createTitle')} style={{ marginTop: 16 }}>
        <Form form={form} layout="vertical" initialValues={{ scope: 'global' }} onFinish={onFinish}>
          <Form.Item name="scope" label={t('notif.silence.scope.label')} rules={[{ required: true, message: t('notif.silence.scope.required') }]}>
            <Select
              options={[
                { value: 'global', label: t('notif.silence.scope.globalOption') },
                { value: 'task', label: t('notif.silence.scope.taskOption') },
                { value: 'application', label: t('notif.silence.scope.applicationOption') },
              ]}
            />
          </Form.Item>
          {scope === 'task' && (
            <Form.Item name="taskId" label={t('notif.silence.taskId')} rules={[{ required: true, whitespace: true, message: t('notif.silence.taskId.required') }]}>
              <Input placeholder={t('notif.silence.taskIdPlaceholder')} />
            </Form.Item>
          )}
          {scope === 'application' && (
            <Form.Item name="applicationId" label={t('notif.silence.applicationId')} rules={[{ required: true, whitespace: true, message: t('notif.silence.applicationId.required') }]}>
              <Input placeholder={t('notif.silence.applicationIdPlaceholder')} />
            </Form.Item>
          )}
          <Form.Item name="durationMinutes" label={t('notif.silence.duration')} rules={[{ required: true, message: t('notif.silence.duration.required') }]}>
            <InputNumber min={1} precision={0} placeholder={t('notif.silence.durationPlaceholder')} addonAfter={t('notif.silence.minutes')} style={{ width: 220 }} />
          </Form.Item>
          <Form.Item name="reason" label={t('notif.silence.reason')}>
            <TextArea rows={2} maxLength={255} placeholder={t('notif.silence.reasonPlaceholder')} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={creating}>{t('notif.silence.create')}</Button>
          </Form.Item>
        </Form>
      </Card>
      <Card type="inner" title={t('notif.silence.listTitle')} style={{ marginTop: 16 }}>
        {/* UI-16：列表请求失败 → 页内错误块（重试=refresh），不落「暂无静默规则」误导空态 */}
        {error ? (
          <StateError error={error} title={t('notif.silence.loadFail')} onRetry={refresh} />
        ) : (
          <Table
            loading={loading}
            dataSource={silences ?? []}
            rowKey="id"
            columns={cols}
            size="small"
            pagination={{ pageSize: 10, showTotal: (n) => t('notif.silence.count', { count: n }) }}
            locale={{ emptyText: t('notif.silence.empty') }}
          />
        )}
      </Card>
    </div>
  );
}

export default function NotificationSettingsPage() {
  const [activeTab, setActiveTab] = useState('email');
  const [globalTestResult, setGlobalTestResult] = useState<TestResult | null>(null);
  const { t } = useTranslation();
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
        setGlobalTestResult({ success: false, message: getErrMsg(err, t('notif.test.fail')) });
      },
    },
  );

  const handleEnableChange = async (enabled: boolean) => {
    try {
      await notificationApi.updateChannel(activeTab, { enabled });
    } catch (err: unknown) {
      // UI-15：渠道启停失败反馈（此前失败静默，Switch 视觉状态与后端不一致且无提示）
      message.error(getErrMsg(err, t('notif.channel.updateFail')));
      return;
    }
    refresh();
    message.success(
      enabled
        ? t('notif.channel.enabled', { name: channel?.name })
        : t('notif.channel.disabled', { name: channel?.name }),
    );
  };

  const tabItems = channels?.map((c: NotificationChannel) => ({
    key: c.key,
    label: (
      <span>
        {c.name}
        {c.enabled ? <Tag color="green" style={{ marginLeft: 8 }}>{t('notif.status.enabled')}</Tag> : <Tag style={{ marginLeft: 8 }}>{t('notif.status.disabled')}</Tag>}
      </span>
    ),
    children: (
      <div>
        <Space style={{ marginBottom: 16 }}>
          <Text>{t('notif.channel.enablePrompt')}</Text>
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
          <Alert title={t('notif.channel.disabledAlert')} type="info" showIcon />
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
          label: t('notif.silence.tabLabel'),
          children: <SilenceRulesPanel active={activeTab === 'silences'} />,
        }]
      : []),
  ];

  return (
    <div>
      {/* UI-03/UI-08：页头标准化（原 Typography.Title 区块迁入 PageHeader） */}
      <PageHeader
        title={t('notif.title')}
        description={t('notif.description')}
      />
      {/* UI-16：渠道列表请求失败且无任何缓存数据 → 页内错误块（重试=refresh）；
          此前失败会停在 Card loading 后的空白，用户既看不到原因也无重试入口。
          已有缓存时（如刷新失败）保持展示旧数据，不打断阅读。 */}
      {channelsError && !channels ? (
        <StateError error={channelsError} title={t('notif.channel.loadFail')} onRetry={refresh} />
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

      <Card title={t('notif.test.title')} style={{ marginTop: 16 }}>
        <Form
          layout="vertical"
          onFinish={(values) => { setGlobalTestResult(null); sendTest(values); }}
        >
          <Form.Item name="channels" label={t('notif.test.channels')} rules={[{ required: true, message: t('notif.test.channelsRequired') }]}>
            <Checkbox.Group>
              <Space orientation="vertical">
                <Checkbox value="email">{t('notif.channel.email')}</Checkbox>
                <Checkbox value="slack">Slack</Checkbox>
                <Checkbox value="dingtalk">{t('notif.channel.dingtalk')}</Checkbox>
                <Checkbox value="wecom">{t('notif.channel.wecom')}</Checkbox>
                <Checkbox value="webhook">Webhook</Checkbox>
              </Space>
            </Checkbox.Group>
          </Form.Item>
          <Form.Item name="title" label={t('notif.test.titleLabel')} rules={[{ required: true }]}>
            <Input placeholder={t('notif.test.titlePlaceholder')} />
          </Form.Item>
          <Form.Item name="content" label={t('notif.test.contentLabel')} rules={[{ required: true }]}>
            <TextArea rows={3} placeholder={t('notif.test.contentPlaceholder')} />
          </Form.Item>
          <Form.Item>
            <Space orientation="vertical" style={{ width: '100%' }}>
              <Button type="primary" htmlType="submit" loading={sending}>{t('notif.test.send')}</Button>
              {globalTestResult && (
                <Alert
                  type={globalTestResult.success ? 'success' : 'error'}
                  icon={globalTestResult.success
                    ? <CheckCircleFilled style={{ color: '#52c41a' }} />
                    : <CloseCircleFilled style={{ color: '#ff4d4f' }} />}
                  showIcon
                  title={
                    globalTestResult.success
                      ? t('notif.test.sent')
                      : t('notif.test.error', { msg: globalTestResult.message })
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
