import { useState } from 'react';
import { Modal, Space, Typography, Tag, Button, Divider, Input, Alert } from 'antd';
import { ClockCircleOutlined } from '@ant-design/icons';

const { Text } = Typography;

const PRESETS = [
  { label: '每分钟', value: '* * * * *', desc: '每分钟执行一次' },
  { label: '每5分钟', value: '*/5 * * * *', desc: '每5分钟执行一次' },
  { label: '每15分钟', value: '*/15 * * * *', desc: '每15分钟执行一次' },
  { label: '每小时', value: '0 * * * *', desc: '每小时整点执行' },
  { label: '每天早8点', value: '0 8 * * *', desc: '每天早上8点执行' },
  { label: '每天零点', value: '0 0 * * *', desc: '每天凌晨0点执行' },
  { label: '每周一早8点', value: '0 8 * * 1', desc: '每周一早上8点执行' },
  { label: '工作日早9点', value: '0 9 * * 1-5', desc: '周一到周五早上9点执行' },
  { label: '每月1号', value: '0 0 1 * *', desc: '每月1日零点执行' },
];

interface CronHelperProps {
  open?: boolean;
  onClose?: () => void;
  onSelect?: (expr: string) => void;
}

export function CronHelper({ open, onClose, onSelect }: CronHelperProps) {
  const [selected, setSelected] = useState<string>('');
  const [custom, setCustom] = useState('');
  const current = custom || selected;

  return (
    <Modal
      title={<Space><ClockCircleOutlined /> Cron 表达式辅助</Space>}
      open={open}
      onCancel={onClose}
      width={520}
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" disabled={!current} onClick={() => onSelect?.(current)}>
            使用此表达式
          </Button>
        </Space>
      }
    >
      <Text type="secondary" style={{ fontSize: 13 }}>选择常用预设，或在下方输入自定义表达式。</Text>
      <div style={{ marginTop: 16, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {PRESETS.map(p => (
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
          message={
            <Space>
              <Text code>{selected}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {PRESETS.find(p => p.value === selected)?.desc}
              </Text>
            </Space>
          }
        />
      )}
      <Divider style={{ margin: '16px 0' }} />
      <div>
        <Text strong>自定义表达式</Text>
        <Input
          style={{ marginTop: 8, fontFamily: 'monospace' }}
          placeholder="如：0 10 * * 1-5"
          value={custom}
          onChange={e => { setCustom(e.target.value); setSelected(''); }}
        />
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
          格式：分 时 日 月 周（0-59 0-23 1-31 1-12 0-7）
        </Text>
      </div>
      {current && (
        <Alert type="success" style={{ marginTop: 12 }}
          message={<span>将使用：<Text code>{current}</Text></span>}
        />
      )}
    </Modal>
  );
}

// Legacy default export for inline use
export default CronHelper;
