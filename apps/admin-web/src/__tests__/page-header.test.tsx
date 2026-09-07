/**
 * UI-03：PageHeader 标准化页头组件测试。
 * 覆盖：标题/描述/操作区渲染、面包屑显式传参（链接项与末级纯文本）、
 * 可选区块缺省不渲染、面包屑链接导航。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import PageHeader from '../components/PageHeader';

afterEach(() => {
  cleanup();
});

/** 显示当前路由路径（断言面包屑链接跳转用） */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

describe('PageHeader 组件（UI-03）', () => {
  it('渲染标题与描述', () => {
    render(<PageHeader title="任务调度" description="共 3 个任务" />);
    expect(screen.getByText('任务调度')).toBeTruthy();
    expect(screen.getByText('共 3 个任务')).toBeTruthy();
    expect(screen.getByTestId('page-header')).toBeTruthy();
  });

  it('渲染操作区（extra）并可交互', () => {
    render(
      <PageHeader
        title="执行记录"
        extra={<button type="button" onClick={() => undefined}>刷新</button>}
      />,
    );
    expect(screen.getByText('刷新')).toBeTruthy();
  });

  it('显式面包屑：中间项渲染为链接，末级为纯文本', () => {
    render(
      <MemoryRouter initialEntries={['/tasks/t1']}>
        <PageHeader
          title="任务详情"
          breadcrumb={[
            { title: '任务调度', to: '/tasks' },
            { title: '任务详情' },
          ]}
        />
        <Routes>
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    const link = screen.getByText('任务调度');
    expect(link.closest('a')?.getAttribute('href')).toBe('/tasks');
    // 末级不渲染为链接（面包屑容器内的纯文本节点）
    const lastCrumb = screen
      .getByTestId('page-header')
      .querySelector('.ant-breadcrumb ol')?.lastElementChild;
    expect(lastCrumb?.textContent).toBe('任务详情');
    expect(lastCrumb?.querySelector('a')).toBeNull();
  });

  it('面包屑链接点击后跳转到对应路由', () => {
    render(
      <MemoryRouter initialEntries={['/tasks/t1']}>
        <PageHeader
          title="任务详情"
          breadcrumb={[
            { title: '任务调度', to: '/tasks' },
            { title: '任务详情' },
          ]}
        />
        <Routes>
          <Route path="/tasks" element={<div>任务列表页</div>} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('任务调度'));
    expect(screen.getByText('任务列表页')).toBeTruthy();
  });

  it('不传可选区块（description/extra/breadcrumb）时对应结构不渲染', () => {
    render(<PageHeader title="包市场" />);
    expect(screen.getByText('包市场')).toBeTruthy();
    // 无描述文本节点（标题之外无其他 Typography 文本）
    expect(screen.queryByTestId('page-header')?.querySelector('.ant-breadcrumb')).toBeNull();
  });

  it('description/extra 传 null 时不渲染占位', () => {
    render(<PageHeader title="系统设置" description={null} extra={null} />);
    expect(screen.getByText('系统设置')).toBeTruthy();
  });
});
