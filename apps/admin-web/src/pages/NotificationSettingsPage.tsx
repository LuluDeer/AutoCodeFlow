import { useState } from 'react';
import { Card, Form, Input, Switch, Button, Space, message, Tabs, Divider, List, Tag, Typography, Alert, Checkbox } from 'antd';
import { useRequest } from 'ahooks';
import { client } from '../../api/client';

const { TextArea } = Input;
const { Text } = Typography;

interface NotificationChannel {
  key: string;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  description: string;
}

const notificationApi = {
  getChannels: () => client.get<any, NotificationChannel[]>('/notification/channels'),
  updateChannel: (key: string, data: Partial<NotificationChannel>) =>
    client.patch<any, NotificationChannel>(`/notification/channels/${key}`, data),
  testChannel: (key: string, data: Record<string, string>) =>
    client.post<any, { success: boolean; message: string }>(`/notification/channels/${key}/test`, data),
  sendTestNotification: (data: { channels: string[]; title: string; content: string }) =>
    client.post<any, { success: boolean; message: string }>('/notification/test', data),
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
      if (result.success) message.success('测试消息发送成功');
      else message.error(`测试失败: ${result.message}`);
    },
    { manual: true },
  );

  const { run: sendTest, loading: sending } = useRequest(
    async (data: { channels: string[]; title: string; content: string }) => {
      const result = await notificationApi.sendTestNotification(data);
      if (result.success) message.success('测试消息发送成功');
      else message.error(`测试失败: ${result.message}`);
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
          <Form.Item key={f.key} name={f.key} label={f.label}>
            <Input.Password
              type={f.key === 'webhookUrl' ? 'text' : undefined}
              placeholder={f.placeholder}
            />
          </Form.Item>
        ))}
        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={updating}>保存</Button>
            <Button onClick={() => testChannel(form.getFieldsValue())} loading={testing}>发送测试</Button>
          </Space>
        </Form.Item>
      </Form>
    );
  };

  const tabItems = channels?.map((c) => ({
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
          <Alert message="此通知渠道已禁用" type="info" showIcon />
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
          onChange={(k) => { setActiveTab(k); form.resetFields(); }}
          items={tabItems}
        />
      </Card>

      <Card title="全局测试" style={{ marginTop: 16 }}>
        <Form
          layout="vertical"
          onFinish={(values) => sendTest(values)}
        >
          <Form.Item name="channels" label="选择渠道" rules={[{ required: true, message: '请选择至少一个渠道' }]}>
            <Checkbox.Group>
              <Space direction="vertical">
                <Checkbox value="email">邮件</Checkbox>
                <Checkbox value="slack">Slack</Checkbox>
                <Checkbox value="dingtalk">钉钉</Checkbox>
                <Checkbox value="wecom">企业微信</Checkbox>
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
            <Button type="primary" htmlType="submit" loading={sending}>发送测试通知</Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
