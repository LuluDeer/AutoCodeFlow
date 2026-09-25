import { useEffect, useRef, useState } from 'react';
import { Button, Input, Typography, Tooltip, theme } from 'antd';
import { PlusOutlined, DeleteOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import '../i18n';

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
 *
 * F-02（DEEP_REVIEW 0ef3bbe）半受控修复：value 此前只在 useState 初始化时
 * 消费，挂载后的外部注入（模板预填 setFieldsValue 等）不会反映到行。
 * 采用「最后外发值」ref 模式：自身 onChange 外发时记录产出值，外部 value
 * 与其不同（引用与内容均不同）才重建 rows——外部注入能同步进 rows，自身
 * 输入回流（含父层克隆回传）不重置行，避免光标/焦点跳动与更新循环。
 */
export default function ParamsEditor({ value, onChange }: ParamsEditorProps) {
  const { t } = useTranslation();
  // F-15（DEEP_REVIEW 0ef3bbe）：三级图标色走 antd token，暗色主题自适应。
  const { token } = theme.useToken();

  const toRows = (v?: Record<string, string>): ParamRow[] =>
    v ? Object.entries(v).map(([key, val]) => ({ key, value: String(val) })) : [];

  const [rows, setRows] = useState<ParamRow[]>(() => toRows(value));
  const lastEmittedRef = useRef<Record<string, string> | null>(null);

  const isEcho = (
    a?: Record<string, string>,
    b?: Record<string, string> | null,
  ) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  useEffect(() => {
    if (!isEcho(value, lastEmittedRef.current)) {
      setRows(toRows(value));
    }

  }, [value]);

  const emit = (updated: ParamRow[]) => {
    const result: Record<string, string> = {};
    for (const r of updated) {
      if (r.key.trim()) result[r.key.trim()] = r.value;
    }
    lastEmittedRef.current = result;
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
          {t('paramsEditor.empty')}
        </Text>
      )}
      {rows.map((row, idx) => (
        // UI 打磨：原 Space 不换行且两输入框定宽合计 380+，在 520px Modal 里
        // 刚好塞满、窄屏（≤768 Modal 收窄）整行溢出弹窗——改 wrap flex 布局，
        // 值输入框弹性收缩
        <div
          key={idx}
          style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}
        >
          <Input
            placeholder={t('paramsEditor.keyPlaceholder')}
            value={row.key}
            onChange={e => update(idx, 'key', e.target.value)}
            style={{ width: 160, maxWidth: '100%', fontFamily: 'monospace' }}
          />
          <Text type="secondary">=</Text>
          <Input
            placeholder={t('paramsEditor.valuePlaceholder')}
            value={row.value}
            onChange={e => update(idx, 'value', e.target.value)}
            style={{ flex: '1 1 180px', minWidth: 0 }}
          />
          <Button
            type="text"
            danger
            size="small"
            icon={<DeleteOutlined />}
            onClick={() => remove(idx)}
          />
        </div>
      ))}
      <Button
        type="dashed"
        size="small"
        icon={<PlusOutlined />}
        onClick={add}
        style={{ marginTop: 4 }}
      >
        {t('paramsEditor.add')}
      </Button>
      <Tooltip title={t('paramsEditor.tooltip')}>
        <InfoCircleOutlined style={{ marginLeft: 8, color: token.colorTextTertiary, fontSize: 12 }} />
      </Tooltip>
    </div>
  );
}
