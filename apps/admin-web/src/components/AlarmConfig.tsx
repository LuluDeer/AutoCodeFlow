import { Form, Input, Select, Space, Typography, Tooltip } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import '../i18n';

const { Text } = Typography;

/**
 * Reusable alarm / notification config block for task forms.
 * Renders alarm email + alarm channels fields.
 * Must be used inside an Ant Design <Form>.
 */
export default function AlarmConfig() {
  const { t } = useTranslation();

  const ALARM_CHANNEL_OPTIONS = [
    { value: 'email', label: t('alarmConfig.channel.option.email') },
    { value: 'slack', label: t('alarmConfig.channel.option.slack') },
    { value: 'dingtalk', label: t('alarmConfig.channel.option.dingtalk') },
    { value: 'wecom', label: t('alarmConfig.channel.option.wecom') },
    { value: 'webhook', label: t('alarmConfig.channel.option.webhook') },
  ];

  return (
    <Space orientation="vertical" style={{ width: '100%' }} size={0}>
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
        {t('alarmConfig.hint')}
      </Text>

      <Form.Item
        name="alarmChannels"
        label={
          <Space size={4}>
            {t('alarmConfig.field.channels')}
            <Tooltip title={t('alarmConfig.channelTooltip')}>
              <InfoCircleOutlined style={{ color: '#8c8c8c', fontSize: 12 }} />
            </Tooltip>
          </Space>
        }
      >
        <Select
          mode="multiple"
          placeholder={t('alarmConfig.channelPlaceholder')}
          allowClear
          options={ALARM_CHANNEL_OPTIONS}
          style={{ width: '100%' }}
        />
      </Form.Item>

      <Form.Item
        name="alarmEmail"
        label={t('alarmConfig.field.emails')}
        rules={[{ type: 'email', message: t('alarmConfig.emailRule') }]}
        tooltip={{ title: t('alarmConfig.emailTooltip'), icon: <InfoCircleOutlined /> }}
      >
        <Input placeholder="oncall@example.com" />
      </Form.Item>
    </Space>
  );
}