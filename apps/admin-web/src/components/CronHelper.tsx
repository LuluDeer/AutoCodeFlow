import React from 'react';
import { Tag, Typography, Space, Tooltip } from 'antd';
import { ClockCircleOutlined } from '@ant-design/icons';

const { Text } = Typography;

const PRESETS = [
  { label: '每分钟', value: '* * * * *', desc: '每分钟执行一次' },
  { label: '每5分钟', value: '*/5 * * * *', desc: '每5分钟执行一次' },
  { label: '每15分钟', value: '*/15 * * * *', desc: '每15分钟执行一次' },
  { label: '每小时', value: '0 * * * *', desc: '每小时整点执行' },
  { label: '每天凌晨', value: '0 0 * * *', desc: '每天凌晨0点执行' },
  { label: '每天早上', value: '0 8 * * *', desc: '每天早上8点执行' },
  { label: '每周一', value: '0 9 * * 1', desc: '每周一早上9点执行' },
  { label: '每月1日', value: '0 0 1 * *', desc: '每月1日凌晨执行' },
];

interface CronHelperProps {
  onChange?: (value: string) => void;
}

export default function CronHelper({ onChange }: CronHelperProps) {
  return (
    <div style={{ marginTop: 8 }}>
      <Space align="center" style={{ marginBottom: 6 }}>
        <ClockCircleOutlined style={{ color: '#1677ff' }} />
        <Text type="secondary" style={{ fontSize: 12 }}>常用预设：</Text>
      </Space>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {PRESETS.map((p) => (
          <Tooltip key={p.value} title={p.desc}>
            <Tag
              color="blue"
              style={{ cursor: 'pointer', userSelect: 'none' }}
              onClick={() => onChange?.(p.value)}
            >
              {p.label}
            </Tag>
          </Tooltip>
        ))}
      </div>
      <div style={{ marginTop: 8 }}>
        <Text type="secondary" style={{ fontSize: 11 }}>
          格式：分 时 日 月 周（例如 <code>0 8 * * 1-5</code> = 工作日早8点）
        </Text>
      </div>
    </div>
  );
}
