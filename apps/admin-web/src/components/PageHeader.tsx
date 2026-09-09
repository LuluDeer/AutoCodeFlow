import type { ReactNode } from 'react';
import { Typography, Breadcrumb, Space } from 'antd';
import { Link } from 'react-router-dom';
import { useThemeStore, selectResolvedTheme } from '../theme/store';
import { LIGHT_TOKENS, DARK_TOKENS } from '../theme/tokens';

const { Title, Text } = Typography;

/** UI-03：面包屑项——title 支持字符串或自定义节点；to 提供时渲染为路由链接 */
export interface PageHeaderCrumb {
  title: ReactNode;
  to?: string;
}

export interface PageHeaderProps {
  /** 页面主标题（原各页 Typography.Title level=4 的统一收口） */
  title: ReactNode;
  /** 可选描述行（原页头下方的 secondary Text） */
  description?: ReactNode;
  /** 右侧操作区（原页头行内按钮整体迁入） */
  extra?: ReactNode;
  /**
   * 面包屑：显式传参（选实现简单的方案——MainLayout 头部已有路径自动面包屑，
   * 页内面包屑只在二级/三级页面（详情/编辑/新建）由页面自行声明层级语义）。
   * 不传则不渲染面包屑行。
   */
  breadcrumb?: PageHeaderCrumb[];
}

/**
 * UI-03：页头标准化组件（计划书 §6.1③）。
 * 统一各页「标题 / 描述 / 操作区 / 面包屑」的排版结构，样式消费 UI-01 主题
 * 分面令牌（亮暗面跟随 theme store），替代各页硬编码的 Typography.Title 区块。
 */
export default function PageHeader({ title, description, extra, breadcrumb }: PageHeaderProps) {
  const dark = useThemeStore(selectResolvedTheme) === 'dark';
  const borderColor = dark ? DARK_TOKENS.border : LIGHT_TOKENS.border;

  const crumbItems = breadcrumb?.map((c, i) => {
    const isLast = i === breadcrumb.length - 1;
    if (!isLast && c.to) return { title: <Link to={c.to}>{c.title}</Link> };
    return { title: c.title };
  });

  return (
    <div data-testid="page-header" style={{ marginBottom: 16 }}>
      {crumbItems && crumbItems.length > 0 && (
        <Breadcrumb items={crumbItems} style={{ marginBottom: 8, fontSize: 13 }} />
      )}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <Title level={4} style={{ margin: 0 }}>
            {title}
          </Title>
          {description != null && (
            <Text type="secondary" style={{ fontSize: 13 }}>
              {description}
            </Text>
          )}
        </div>
        {extra != null && <Space wrap>{extra}</Space>}
      </div>
      {/* 分隔线：亮暗面边框色来自 tokens（双主题对齐 MainLayout 壳层观感） */}
      <div style={{ height: 1, background: borderColor, marginTop: 12 }} />
    </div>
  );
}
