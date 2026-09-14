import { Form, Input, Select, Space, Typography, Tooltip, theme } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import '../i18n';

const { Text } = Typography;

/**
 * A4（DEEP_REVIEW §七 A4）：告警渠道选项——必须与
 * `packages/contract-fixtures/contract.json` 的 `channelList` 一致，由
 * `src/__tests__/alarm-config-channels.test.tsx` 机检。
 *
 * 这里原先只有 5 项、**缺 feishu**：后端 `FeishuChannel` 与 `AlertChannel.FEISHU`
 * 都已就位、通知设置页也能配飞书，唯独任务表单的告警渠道选择器选不中飞书。
 * 三份手写清单漂移的第一次实证——故提升到模块级并导出，供契约测试直接断言
 * （顺带不再每次渲染重建数组）。
 */
export const ALARM_CHANNEL_OPTIONS = (t: (key: string) => string) => [
  { value: 'email', label: t('alarmConfig.channel.option.email') },
  { value: 'slack', label: t('alarmConfig.channel.option.slack') },
  { value: 'dingtalk', label: t('alarmConfig.channel.option.dingtalk') },
  { value: 'wecom', label: t('alarmConfig.channel.option.wecom') },
  { value: 'webhook', label: t('alarmConfig.channel.option.webhook') },
  { value: 'feishu', label: t('alarmConfig.channel.option.feishu') },
];

/**
 * Reusable alarm / notification config block for task forms.
 * Renders alarm email + alarm channels fields.
 * Must be used inside an Ant Design <Form>.
 */
export default function AlarmConfig() {
  const { t } = useTranslation();
  // F-15（DEEP_REVIEW 0ef3bbe）：三级图标色走 antd token，暗色主题自适应。
  const { token } = theme.useToken();

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
              <InfoCircleOutlined style={{ color: token.colorTextTertiary, fontSize: 12 }} />
            </Tooltip>
          </Space>
        }
      >
        <Select
          mode="multiple"
          placeholder={t('alarmConfig.channelPlaceholder')}
          allowClear
          options={ALARM_CHANNEL_OPTIONS(t)}
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