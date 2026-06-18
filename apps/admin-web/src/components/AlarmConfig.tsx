import { Form, Input, Select, Space, Typography, Tooltip } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';

const { Text } = Typography;

const ALARM_CHANNEL_OPTIONS = [
  { value: 'email', label: '邮件' },
  { value: 'slack', label: 'Slack' },
  { value: 'dingtalk', label: '钉钉' },
  { value: 'wecom', label: '企业微信' },
  { value: 'webhook', label: 'Webhook' },
];

/**
 * Reusable alarm / notification config block for task forms.
 * Renders alarm email + alarm channels fields.
 * Must be used inside an Ant Design <Form>.
 */
export default function AlarmConfig() {
  return (
    <Space orientation="vertical" style={{ width: '100%' }} size={0}>
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
        任务失败时自动发送告警通知。未配置则使用系统全局通知设置。
      </Text>

      <Form.Item
        name="alarmChannels"
        label={
          <Space size={4}>
            告警渠道
            <Tooltip title="选择要接收告警的渠道；未选择时将广播到所有已启用的全局渠道">
              <InfoCircleOutlined style={{ color: '#8c8c8c', fontSize: 12 }} />
            </Tooltip>
          </Space>
        }
      >
        <Select
          mode="multiple"
          placeholder="不限（使用全局配置）"
          allowClear
          options={ALARM_CHANNEL_OPTIONS}
          style={{ width: '100%' }}
        />
      </Form.Item>

      <Form.Item
        name="alarmEmail"
        label="告警邮件接收人"
        rules={[{ type: 'email', message: '请输入有效的邮件地址' }]}
        tooltip={{ title: '指定接收告警邮件的地址，覆盖全局邮件设置中的默认收件人', icon: <InfoCircleOutlined /> }}
      >
        <Input placeholder="oncall@example.com" />
      </Form.Item>
    </Space>
  );
}
