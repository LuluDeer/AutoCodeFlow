import { Switch, Tooltip, Typography, theme } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';

const { Text } = Typography;

export interface StablePagingSwitchProps {
  /** 受控开关状态 */
  checked: boolean;
  /** 切换回调 */
  onChange: (checked: boolean) => void;
  /** 开关旁标签文字 */
  label: string;
  /** 悬停提示文案 */
  hint: string;
  /** 读屏无障碍标签 */
  ariaLabel: string;
  /** 可选禁用态 */
  disabled?: boolean;
  /** 可选测试锚点 */
  testId?: string;
}

/**
 * 公共「稳定翻页（游标分页）」受控开关组件：
 * 用单个 Tooltip 包裹开关、文字与信息图标，悬停任意区域均有说明提示。
 */
export function StablePagingSwitch({
  checked,
  onChange,
  label,
  hint,
  ariaLabel,
  disabled,
  testId,
}: StablePagingSwitchProps) {
  const { token } = theme.useToken();
  return (
    <Tooltip title={hint}>
      <span
        data-testid={testId}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'help' }}
      >
        <Switch
          size="small"
          checked={checked}
          disabled={disabled}
          onChange={onChange}
          aria-label={ariaLabel}
        />
        <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          {label}
        </Text>
        <InfoCircleOutlined
          aria-hidden="true"
          style={{ fontSize: 12, color: token.colorTextSecondary }}
        />
      </span>
    </Tooltip>
  );
}

export default StablePagingSwitch;
