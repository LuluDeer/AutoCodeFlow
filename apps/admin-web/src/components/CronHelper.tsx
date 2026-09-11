import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import '../i18n';
import { Modal, Space, Typography, Tag, Button, Divider, Input, Alert } from 'antd';
import { ClockCircleOutlined } from '@ant-design/icons';

const { Text } = Typography;

/** 常用预设（文案走 i18n 键，组件内用 getPresets(t) 求值） */
const PRESET_KEYS = [
  { labelKey: 'cronHelper.preset.minutely.label', descKey: 'cronHelper.preset.minutely.desc', value: '* * * * *' },
  { labelKey: 'cronHelper.preset.every5m.label', descKey: 'cronHelper.preset.every5m.desc', value: '*/5 * * * *' },
  { labelKey: 'cronHelper.preset.every15m.label', descKey: 'cronHelper.preset.every15m.desc', value: '*/15 * * * *' },
  { labelKey: 'cronHelper.preset.hourly.label', descKey: 'cronHelper.preset.hourly.desc', value: '0 * * * *' },
  { labelKey: 'cronHelper.preset.daily8.label', descKey: 'cronHelper.preset.daily8.desc', value: '0 8 * * *' },
  { labelKey: 'cronHelper.preset.midnight.label', descKey: 'cronHelper.preset.midnight.desc', value: '0 0 * * *' },
  { labelKey: 'cronHelper.preset.weeklyMon8.label', descKey: 'cronHelper.preset.weeklyMon8.desc', value: '0 8 * * 1' },
  { labelKey: 'cronHelper.preset.weekday9.label', descKey: 'cronHelper.preset.weekday9.desc', value: '0 9 * * 1-5' },
  { labelKey: 'cronHelper.preset.monthly1.label', descKey: 'cronHelper.preset.monthly1.desc', value: '0 0 1 * *' },
];

const getPresets = (t: TFunction) =>
  PRESET_KEYS.map((p) => ({ label: t(p.labelKey), desc: t(p.descKey), value: p.value }));

interface CronHelperProps {
  open?: boolean;
  onClose?: () => void;
  onSelect?: (expr: string) => void;
}

export function CronHelper({ open, onClose, onSelect }: CronHelperProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string>('');
  const [custom, setCustom] = useState('');
  const presets = getPresets(t);
  const current = custom || selected;

  return (
    <Modal
      title={<Space><ClockCircleOutlined /> {t('cronHelper.title')}</Space>}
      open={open}
      onCancel={onClose}
      width={520}
      footer={
        <Space>
          <Button onClick={onClose}>{t('cronHelper.cancel')}</Button>
          <Button type="primary" disabled={!current} onClick={() => onSelect?.(current)}>
            {t('cronHelper.use')}
          </Button>
        </Space>
      }
    >
      <Text type="secondary" style={{ fontSize: 13 }}>{t('cronHelper.desc')}</Text>
      <div style={{ marginTop: 16, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {presets.map(p => (
          <Tag
            key={p.value}
            color={selected === p.value && !custom ? 'blue' : 'default'}
            style={{ cursor: 'pointer', padding: '4px 10px', fontSize: 13 }}
            onClick={() => { setSelected(p.value); setCustom(''); }}
          >
            {p.label}
          </Tag>
        ))}
      </div>
      {selected && !custom && (
        <Alert type="info" style={{ marginTop: 12 }}
          title={
            <Space>
              <Text code>{selected}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {presets.find(p => p.value === selected)?.desc}
              </Text>
            </Space>
          }
        />
      )}
      <Divider style={{ margin: '16px 0' }} />
      <div>
        <Text strong>{t('cronHelper.customTitle')}</Text>
        <Input
          style={{ marginTop: 8, fontFamily: 'monospace' }}
          placeholder={t('cronHelper.customPlaceholder')}
          value={custom}
          onChange={e => { setCustom(e.target.value); setSelected(''); }}
        />
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
          {t('cronHelper.format')}
        </Text>
      </div>
      {current && (
        <Alert type="success" style={{ marginTop: 12 }}
          title={<span>{t('cronHelper.usePrefix')}<Text code>{current}</Text></span>}
        />
      )}
    </Modal>
  );
}

// Legacy default export for inline use
export default CronHelper;
