import React from 'react';
import Icon, { type IconName } from './Icon';

/**
 * 空态家族（V4-5 V-09 收口）：此前列表空态/向导 hero/日志行内小字三种
 * 「没有内容」各画一套——统一为一个组件两档尺寸：
 *  - page：页面级空态（虚线框 + 48px 图标底板 + 标题 + 说明 + 行动区），
 *    历史/应用页空态用这一档；
 *  - inline：留作后续行内空态接入（当前日志查看器空态保持原样，二期统一）。
 * 行动区（按钮）由调用方以 children 传入，顺序语义：标题 → 说明 → 提示 → 行动。
 */
interface EmptyStateProps {
  icon: IconName;
  title: string;
  children?: React.ReactNode;
  /** 补充类名（如需要覆盖 flex:1 的场景） */
  className?: string;
}

export default function EmptyState({ icon, title, children, className }: EmptyStateProps) {
  return (
    <div className={`empty-state${className ? ` ${className}` : ''}`}>
      <span className="empty-state-icon" aria-hidden="true"><Icon name={icon} /></span>
      <strong>{title}</strong>
      {children}
    </div>
  );
}
