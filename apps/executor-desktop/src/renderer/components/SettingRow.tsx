import React from 'react';

/**
 * UI V5：设置工作台的一行。
 *
 * 左侧固定 180px 标签列，右侧控件列（max 420px），hint / 校验提示放在控件
 * 下方。短字段可放进 `.cfgx-row-pair` 两列并排（此时行内改为标签在上、
 * 控件在下，避免 180px 标签挤掉控件）。
 *
 * `field` 会渲染成 `data-cfgx-field`，供左侧搜索定位/滚动使用——不改变任何
 * 表单语义（控件的 value/onChange 仍由调用方持有）。
 */
export default function SettingRow({
  label,
  field,
  hint,
  error,
  compact = false,
  children,
}: {
  label: React.ReactNode;
  field?: string;
  hint?: React.ReactNode;
  error?: string;
  compact?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`cfgx-row${compact ? ' cfgx-row-compact' : ''}`} data-cfgx-field={field}>
      <div className="cfgx-row-label">{label}</div>
      <div className="cfgx-row-control">
        {children}
        {error ? <span className="cfgx-error" role="alert">{error}</span> : null}
        {hint ? <div className="cfgx-hint">{hint}</div> : null}
      </div>
    </div>
  );
}
