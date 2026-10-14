import { useEffect, useRef, useState } from 'react';
import { Button, Input, Select, Typography, Tooltip, theme } from 'antd';
import { PlusOutlined, DeleteOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import '../i18n';

const { Text } = Typography;

/**
 * A-11R：参数值的**类型**。
 *
 * 为什么需要这个控件（这是 A-11 生产事故的中台半边根因）：
 * 本组件此前的契约是 `Record<string, string>` —— 控制台**只能**产出字符串。
 * 而执行器在 A-11 之后对所有值统一 JSON 序列化，于是每个经中台配置的参数都被
 * 加了一对首尾双引号（`{"region":"欧盟"}` → `AUTOFLOW_REGION='"欧盟"'`），
 * 按官方文档裸读的存量脚本直接 ValueError（生产实证：tk-ship-notify 静默停摆
 * 12 天）。
 *
 * 执行器侧已修（字符串回归裸值），但"控制台表达不了类型"这个根因还在：需要传
 * 真实布尔/数字/数组的用户没有任何入口，只能填一个看起来像 JSON 的字符串，
 * 而字符串与 JSON 字面量在 env 里长得一模一样、语义却完全不同。这个下拉把
 * 用户的意图**显式**表达出来，不再依赖对字符串做猜测性解析。
 */
type ParamType = 'text' | 'number' | 'boolean' | 'json';

interface ParamRow {
  key: string;
  /** 输入框里的原始文本（未按类型转换），保证键入过程不被规范化打断。 */
  raw: string;
  type: ParamType;
  /**
   * json 类型解析失败时的标记。该行**仍以原始字符串提交**（绝不静默丢弃用户
   * 填的参数），但界面必须给出可见提示——静默改值是本组件最不该犯的错。
   */
  invalid?: boolean;
}

interface ParamsEditorProps {
  /**
   * 参数映射。值可以是任意 JSON 类型：中台任务/触发参数的类型契约本就是
   * `Record<string, any>`（admin-api 的 Task.params 是 jsonb）。
   */
  value?: Record<string, unknown>;
  onChange?: (val: Record<string, unknown>) => void;
}

/** JS 值 → 类型：从服务端读回的值反推该用哪种输入形态。 */
function inferType(v: unknown): ParamType {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (v !== null && typeof v === 'object') return 'json';
  return 'text';
}

/** JS 值 → 输入框文本。字符串原样（不加引号）；其余按 JSON 呈现。 */
function toRaw(v: unknown, type: ParamType): string {
  if (type === 'text') return v === null || v === undefined ? '' : String(v);
  if (type === 'json') return JSON.stringify(v);
  return String(v);
}

/** 输入框文本 + 类型 → 提交值。解析失败时回落原始字符串（不丢参数）。 */
function toValue(raw: string, type: ParamType): { value: unknown; invalid: boolean } {
  switch (type) {
    case 'text':
      return { value: raw, invalid: false };
    case 'number': {
      // 空串保持空串：数字类型的空输入是"用户还没填完"，不是 0。
      if (raw.trim() === '') return { value: raw, invalid: false };
      const n = Number(raw);
      return Number.isFinite(n) ? { value: n, invalid: false } : { value: raw, invalid: true };
    }
    case 'boolean':
      return { value: raw === 'true', invalid: false };
    case 'json':
      if (raw.trim() === '') return { value: '', invalid: false };
      try {
        return { value: JSON.parse(raw), invalid: false };
      } catch {
        return { value: raw, invalid: true };
      }
  }
}

/**
 * Ant Design Form-compatible key-value editor for task default params.
 * Renders as a list of key / type / value input triples.
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

  const toRows = (v?: Record<string, unknown>): ParamRow[] =>
    v
      ? Object.entries(v).map(([key, val]) => {
          const type = inferType(val);
          return { key, raw: toRaw(val, type), type };
        })
      : [];

  const [rows, setRows] = useState<ParamRow[]>(() => toRows(value));
  const lastEmittedRef = useRef<Record<string, unknown> | null>(null);

  const isEcho = (
    a?: Record<string, unknown>,
    b?: Record<string, unknown> | null,
  ) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  useEffect(() => {
    if (!isEcho(value, lastEmittedRef.current)) {
      setRows(toRows(value));
    }

  }, [value]);

  const emit = (updated: ParamRow[]) => {
    const result: Record<string, unknown> = {};
    for (const r of updated) {
      if (r.key.trim()) result[r.key.trim()] = toValue(r.raw, r.type).value;
    }
    lastEmittedRef.current = result;
    onChange?.(result);
  };

  const update = (idx: number, patch: Partial<ParamRow>) => {
    const next = rows.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    // 类型/值变化都要重算 invalid 标记（切换类型可能让原本合法的文本变非法）
    const target = next[idx];
    next[idx] = { ...target, invalid: toValue(target.raw, target.type).invalid };
    setRows(next);
    emit(next);
  };

  const add = () => {
    const next = [...rows, { key: '', raw: '', type: 'text' as ParamType }];
    setRows(next);
  };

  const remove = (idx: number) => {
    const next = rows.filter((_, i) => i !== idx);
    setRows(next);
    emit(next);
  };

  const TYPE_OPTIONS: { value: ParamType; label: string }[] = [
    { value: 'text', label: t('paramsEditor.type.text') },
    { value: 'number', label: t('paramsEditor.type.number') },
    { value: 'boolean', label: t('paramsEditor.type.boolean') },
    { value: 'json', label: t('paramsEditor.type.json') },
  ];

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
        <div key={idx} style={{ marginBottom: 6 }}>
          <div
            style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}
          >
            <Input
              placeholder={t('paramsEditor.keyPlaceholder')}
              value={row.key}
              onChange={e => update(idx, { key: e.target.value })}
              style={{ width: 160, maxWidth: '100%', fontFamily: 'monospace' }}
            />
            <Text type="secondary">=</Text>
            {/* A-11R：类型选择器。默认「文本」——中台历史上只能产出字符串，
                默认值必须与既有行为一致，避免存量任务语义被静默改变。 */}
            <Select
              value={row.type}
              onChange={v => update(idx, { type: v })}
              options={TYPE_OPTIONS}
              style={{ width: 82 }}
              aria-label={t('paramsEditor.typeLabel')}
            />
            {row.type === 'boolean' ? (
              <Select
                value={row.raw === 'true'}
                onChange={v => update(idx, { raw: v ? 'true' : 'false' })}
                options={[
                  { value: true, label: 'true' },
                  { value: false, label: 'false' },
                ]}
                style={{ flex: '1 1 180px', minWidth: 0 }}
                aria-label={t('paramsEditor.valuePlaceholder')}
              />
            ) : (
              <Input
                placeholder={t('paramsEditor.valuePlaceholder')}
                value={row.raw}
                onChange={e => update(idx, { raw: e.target.value })}
                status={row.invalid ? 'error' : undefined}
                style={{ flex: '1 1 180px', minWidth: 0 }}
              />
            )}
            {/* A11Y-ICON-01：纯图标删除按钮无 Tooltip 包裹，此前对读屏器完全匿名 */}
            <Button
              type="text"
              danger
              size="small"
              icon={<DeleteOutlined />}
              aria-label={t('paramsEditor.remove')}
              onClick={() => remove(idx)}
            />
          </div>
          {row.invalid && (
            <Text type="danger" style={{ fontSize: 12 }}>
              {t('paramsEditor.invalidValue')}
            </Text>
          )}
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
