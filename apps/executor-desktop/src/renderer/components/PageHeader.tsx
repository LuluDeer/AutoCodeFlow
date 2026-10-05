import React from 'react';

/**
 * 统一页头（2026-10 审计 A-01：页面标题四页四套字号收口为一套）。
 *
 * 结构语义：图标 20px + 标题 --fs-xl(20px)/700 + 次级信息（text3）+ 右侧动作区，
 * 样式见 components.css「PageHeader（统一页头）」节。历史/应用/配置三页共用；
 * 状态页 hero 的「状态变体」由后续阶段接入（本轮不动）。
 *
 * - 标题默认渲染 h1（每个面板一个；页面常驻挂载 + hidden 显隐架构下，
 *   面板隐藏时标题不进入读屏树，不产生多 h1 干扰）。配置页分区标题
 *   保持既有 h2 层级，传 headingLevel="h2" 即可，样式走同一套类。
 * - meta 是标题右侧的次级信息（如「30 次执行 · 9 个任务」）；
 *   说明性长段落（配置页 subtitle）由 pages.css 在配置页放宽为可换行。
 * - icon 只传 <Icon name="..."/>，尺寸由 .page-header-icon 统一约束为 20px。
 */
interface PageHeaderProps {
  icon: React.ReactNode;      // 已包好尺寸的 <Icon/>
  title: string;
  meta?: React.ReactNode;     // 标题右侧次级信息（如「30 次执行 · 9 个任务」）
  actions?: React.ReactNode;  // 右侧动作区
  headingLevel?: 'h1' | 'h2';
}

export default function PageHeader({ icon, title, meta, actions, headingLevel = 'h1' }: PageHeaderProps) {
  const Heading = headingLevel;
  return (
    <div className="page-header">
      <span className="page-header-icon" aria-hidden="true">{icon}</span>
      <Heading className="page-header-title">{title}</Heading>
      {meta != null && <span className="page-header-meta">{meta}</span>}
      {actions != null && <div className="page-header-actions">{actions}</div>}
    </div>
  );
}
