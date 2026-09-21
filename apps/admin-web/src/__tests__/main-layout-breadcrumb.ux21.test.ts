/**
 * P1-21（UX 审计）：MainLayout 头部自动面包屑与页面自渲染语义面包屑的分工。
 *
 * 旧实现：头部按路径段对所有二级及更深路径都渲染面包屑；而详情/编辑/新建页
 * （PageHeader 的 breadcrumb prop）自身又渲染一层语义面包屑 → 双面包屑。
 * 修法：pageSelfRendersBreadcrumb() 列出"页面自渲染"的路由，头部只在页面
 * 不自渲染时显示自动面包屑。本文件钉死这套分工，防止误改。
 */
import { describe, it, expect } from 'vitest';
import { pageSelfRendersBreadcrumb } from '../layouts/MainLayout';

describe('P1-21 面包屑分工：pageSelfRendersBreadcrumb', () => {
  it('详情/编辑/新建/执行详情页自渲染面包屑 → 头部不再重复', () => {
    expect(pageSelfRendersBreadcrumb('/tasks/new')).toBe(true);
    expect(pageSelfRendersBreadcrumb('/tasks/abc-123')).toBe(true);
    expect(pageSelfRendersBreadcrumb('/tasks/abc-123/edit')).toBe(true);
    expect(pageSelfRendersBreadcrumb('/tasks/abc-123/executions/exec-9')).toBe(true);
    expect(pageSelfRendersBreadcrumb('/applications/app-1')).toBe(true);
    expect(pageSelfRendersBreadcrumb('/executors/install')).toBe(true);
  });

  it('列表/根级页面不自渲染 → 头部保留自动面包屑', () => {
    expect(pageSelfRendersBreadcrumb('/tasks')).toBe(false);
    expect(pageSelfRendersBreadcrumb('/executions')).toBe(false);
    expect(pageSelfRendersBreadcrumb('/executors')).toBe(false);
    expect(pageSelfRendersBreadcrumb('/dashboard')).toBe(false);
    expect(pageSelfRendersBreadcrumb('/audit')).toBe(false);
    expect(pageSelfRendersBreadcrumb('/users')).toBe(false);
  });

  it('ExecutorDetailPage（/executors/:id）不自带面包屑 → 头部仍显示', () => {
    expect(pageSelfRendersBreadcrumb('/executors/exec-1')).toBe(false);
  });

  it('末尾斜杠不影响判定', () => {
    expect(pageSelfRendersBreadcrumb('/tasks/abc/')).toBe(true);
    expect(pageSelfRendersBreadcrumb('/executors/install/')).toBe(true);
  });
});