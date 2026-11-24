/**
 * 列设置弹层（显隐 + 顺序 + 重置默认），任务 / 执行列表复用。
 *
 * 纯展示 + 回调：偏好状态与持久化在 useColumnPrefs；本组件只负责
 * 勾选显隐、上移 / 下移、恢复默认三个交互入口。
 * 顺序序列 = prefs.order；行内上移 / 下移交换相邻项；边界按钮禁用。
 * 最后一个可见列不可隐藏由模型层守卫，本组件不做死面判定。
 */
import { Button, Checkbox, Popover, Tooltip, Typography } from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  ColumnWidthOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { ColumnPrefs } from '../../utils/columnPrefs';

const { Text } = Typography;

export interface ColumnOption {
  key: string;
  label: string;
}

export interface ColumnSettingsPopoverProps {
  buttonTestId: string;
  buttonLabel: string;
  options: ColumnOption[];
  prefs: ColumnPrefs;
  hidden: Set<string>;
  onToggle: (key: string) => void;
  onMove: (key: string, dir: -1 | 1) => void;
  onReset: () => void;
}

export default function ColumnSettingsPopover({
  buttonTestId,
  buttonLabel,
  options,
  prefs,
  hidden,
  onToggle,
  onMove,
  onReset,
}: ColumnSettingsPopoverProps) {
  const { t } = useTranslation();
  const optionByKey = new Map(options.map((o) => [o.key, o]));
  const rows = prefs.order
    .filter((k) => optionByKey.has(k))
    .map((key, idx) => ({ key, idx, label: optionByKey.get(key)!.label }));

  return (
    <Popover
      trigger="click"
      placement="bottomRight"
      content={
        <div style={{ maxWidth: 260 }}>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
            {t('columns.settings.desc')}
          </Text>
          <div role="listbox" aria-label={buttonLabel}>
            {rows.map(({ key, idx, label }) => (
              <div
                key={key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '3px 0',
                }}
              >
                <Checkbox
                  checked={!hidden.has(key)}
                  onChange={() => onToggle(key)}
                >
                  {label}
                </Checkbox>
                <span style={{ flex: 1 }} />
                <Tooltip title={t('columns.moveUp')}>
                  <Button
                    type="text"
                    size="small"
                    aria-label={t('columns.moveUp')}
                    disabled={idx === 0}
                    icon={<ArrowUpOutlined />}
                    onClick={() => onMove(key, -1)}
                  />
                </Tooltip>
                <Tooltip title={t('columns.moveDown')}>
                  <Button
                    type="text"
                    size="small"
                    aria-label={t('columns.moveDown')}
                    disabled={idx === rows.length - 1}
                    icon={<ArrowDownOutlined />}
                    onClick={() => onMove(key, 1)}
                  />
                </Tooltip>
              </div>
            ))}
          </div>
          <div style={{ borderTop: '1px solid rgba(0,0,0,0.08)', marginTop: 8, paddingTop: 8 }}>
            <Button size="small" icon={<ReloadOutlined />} onClick={onReset}>
              {t('columns.reset')}
            </Button>
          </div>
        </div>
      }
    >
      <Button icon={<ColumnWidthOutlined />} data-testid={buttonTestId}>
        {buttonLabel}
      </Button>
    </Popover>
  );
}
