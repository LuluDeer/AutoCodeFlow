import { useState } from 'react';
import { Button, Input, Space, Typography, Tooltip } from 'antd';
import { PlusOutlined, DeleteOutlined, InfoCircleOutlined } from '@ant-design/icons';

const { Text } = Typography;

interface ParamRow {
  key: string;
  value: string;
}

interface ParamsEditorProps {
  value?: Record<string, string>;
  onChange?: (val: Record<string, string>) => void;
}

/**
 * Ant Design Form-compatible key-value editor for task default params.
 * Renders as a list of key/value input pairs.
 */
export default function ParamsEditor({ value, onChange }: ParamsEditorProps) {
  const toRows = (v?: Record<string, string>): ParamRow[] =>
    v ? Object.entries(v).map(([key, val]) => ({ key, value: String(val) })) : [];

  const [rows, setRows] = useState<ParamRow[]>(() => toRows(value));

  const emit = (updated: ParamRow[]) => {
    const result: Record<string, string> = {};
    for (const r of updated) {
      if (r.key.trim()) result[r.key.trim()] = r.value;
    }
    onChange?.(result);
  };

  const update = (idx: number, field: 'key' | 'value', val: string) => {
    const next = rows.map((r, i) => i === idx ? { ...r, [field]: val } : r);
    setRows(next);
    emit(next);
  };

  const add = () => {
    const next = [...rows, { key: '', value: '' }];
    setRows(next);
  };

  const remove = (idx: number) => {
    const next = rows.filter((_, i) => i !== idx);
    setRows(next);
    emit(next);
  };

  return (
    <div>
      {rows.length === 0 && (
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
          暂无参数，点击下方添加
        </Text>
      )}
      {rows.map((row, idx) => (
        <Space key={idx} style={{ display: 'flex', marginBottom: 6 }} align="baseline">
          <Input
            placeholder="参数名"
            value={row.key}
            onChange={e => update(idx, 'key', e.target.value)}
            style={{ width: 160, fontFamily: 'monospace' }}
          />
          <Text type="secondary">=</Text>
          <Input
            placeholder="默认值"
            value={row.value}
            onChange={e => update(idx, 'value', e.target.value)}
            style={{ width: 220 }}
          />
          <Button
            type="text"
            danger
            size="small"
            icon={<DeleteOutlined />}
            onClick={() => remove(idx)}
          />
        </Space>
      ))}
      <Button
        type="dashed"
        size="small"
        icon={<PlusOutlined />}
        onClick={add}
        style={{ marginTop: 4 }}
      >
        添加参数
      </Button>
      <Tooltip title="任务运行时可通过环境变量 AUTOFLOW_<KEY> 读取这些参数，触发时也可以覆盖">
        <InfoCircleOutlined style={{ marginLeft: 8, color: '#8c8c8c', fontSize: 12 }} />
      </Tooltip>
    </div>
  );
}
