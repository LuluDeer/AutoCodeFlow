import { useState } from 'react';
import { Card, Form, Input, Switch, Button, Space, message, Tabs, Divider, Tag, Typography, Alert, Checkbox } from 'antd';
import { CheckCircleFilled, CloseCircleFilled } from '@ant-design/icons';
import { useRequest } from 'ahooks';
import { client } from '../api/client';

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

export default function NotificationSettingsPage() {
  const [activeTab, setActiveTab] = useState('email');
  const [form] = Form.useForm();
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [globalTestResult, setGlobalTestResult] = useState<TestResult | null>(null);

  const { data: channels, loading, refresh } = useRequest(notificationApi.getChannels);
  const channel = channels?.find((c) => c.key === activeTab);

  const { run: updateChannel, loading: updating } = useRequest(
    async (values: Record<string, string>) => {
      await notificationApi.updateChannel(activeTab, { config: values });
    },
    { manual: true, onSuccess: () => { message.success('保存成功'); refresh(); } },
  );

  const { run: testChannel, loading: testing } = useRequest(
    async (values: Record<string, string>) => {
      const result = await notificationApi.testChannel(activeTab, values);
      setTestResult({ success: result.success, message: result.message, channel: channel?.name });
    },
    { manual: true },
  );

  const { run: sendTest, loading: sending } = useRequest(
    async (data: { channels: string[]; title: string; content: string }) => {
      const result = await notificationApi.sendTestNotification(data);
      setGlobalTestResult({ success: result.success, message: result.message });
    },
    { manual: true },
  );

  const handleEnableChange = async (enabled: boolean) => {
    await notificationApi.updateChannel(activeTab, { enabled });
    refresh();
    message.success(`已${enabled ? '启用' : '禁用'} ${channel?.name}`);
  };

  const renderConfigFields = () => {
    const fields = CHANNEL_CONFIG_FIELDS[activeTab] || [];
    const config = channel?.config || {};

    return (
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
          <Space direction="vertical" style={{ width: '100%' }}>
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
                message={
                  testResult.success
                    ? `${testResult.channel ?? activeTab} 测试消息发送成功`
                    : `测试失败：${testResult.message}`
                }
                closable
                onClose={() => setTestResult(null)}
              />
            )}
          </Space>
        </Form.Item>
      </Form>
    );
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
          <>
            <Text type="secondary">{c.description}</Text>
            <Divider />
            {renderConfigFields()}
          </>
        ) : (
          <Alert message="此通知渠道已禁用，启用后可配置推送参数" type="info" showIcon />
        )}
      </div>
    ),
  })) ?? [];

  return (
    <div>
      <Typography.Title level={4} style={{ marginBottom: 16 }}>通知设置</Typography.Title>
      <Card loading={loading}>
        <Tabs
          activeKey={activeTab}
          onChange={(k) => { setActiveTab(k); form.resetFields(); setTestResult(null); }}
          items={tabItems}
        />
      </Card>

      <Card title="全局测试" style={{ marginTop: 16 }}>
        <Form
          layout="vertical"
          onFinish={(values) => { setGlobalTestResult(null); sendTest(values); }}
        >
          <Form.Item name="channels" label="选择渠道" rules={[{ required: true, message: '请选择至少一个渠道' }]}>
            <Checkbox.Group>
              <Space direction="vertical">
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
            <Space direction="vertical" style={{ width: '100%' }}>
              <Button type="primary" htmlType="submit" loading={sending}>发送测试通知</Button>
              {globalTestResult && (
                <Alert
                  type={globalTestResult.success ? 'success' : 'error'}
                  icon={globalTestResult.success
                    ? <CheckCircleFilled style={{ color: '#52c41a' }} />
                    : <CloseCircleFilled style={{ color: '#ff4d4f' }} />}
                  showIcon
                  message={
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
