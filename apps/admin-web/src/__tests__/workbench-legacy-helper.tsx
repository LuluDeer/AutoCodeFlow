import type { ReactElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

/**
 * 新 IA：WorkbenchPage 的 LegacyFlow 默认折叠（legacyOpen=false），
 * Advanced/LegacyFlow 通过 data-testid="workbench-legacy-toggle" 展开。
 *
 * 旧表单、预览方案卡、commit 结果、审批三态卡、运行草稿与会话恢复面板
 * 都位于 LegacyFlow 内；任何要操作/断言这些区域的测试都必须先展开。
 * 统一封装在此，避免每个用例散落点击导致漏改。
 */
export function renderWorkbenchWithLegacy(page: ReactElement): void {
  render(page);
  fireEvent.click(screen.getByTestId('workbench-legacy-toggle'));
}

/**
 * 已渲染的页面需要再次确认展开态时调用（幂等由用例控制，勿重复点击）。
 */
export function openLegacyFlow(): void {
  fireEvent.click(screen.getByTestId('workbench-legacy-toggle'));
}
