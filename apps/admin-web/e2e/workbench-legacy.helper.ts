import { expect, type Page } from '@playwright/test';

/**
 * 真浏览器 L4 / H4 与单测统一口径：WorkbenchPage 的 LegacyFlow 默认折叠
 * （legacyOpen=false）；Advanced/LegacyFlow 由 data-testid="workbench-legacy-toggle" 展开。
 *
 * goal 输入、执行频率、preview 方案卡、commit 结果、运行草稿与旧会话面板
 * 都位于 LegacyFlow 内。任何要操作/断言这些区域的 spec 必须先展开。
 * 对应单测 helper：apps/admin-web/src/__tests__/workbench-legacy-helper.tsx
 * 的 renderWorkbenchWithLegacy / openLegacyFlow。
 *
 * 幂等：已展开时不重复点击（再点一次会收起）；每次 goto / reload 后重新调用。
 */
export async function openLegacyFlow(page: Page): Promise<void> {
  const toggle = page.getByTestId('workbench-legacy-toggle');
  await expect(toggle, 'workbench legacy toggle must be visible').toBeVisible();

  // 产品 Button 未设置 aria-expanded，用 LegacyFlow 内始终渲染的 goal 输入框
  // 判断当前展开态；两个 spec 都在 addInitScript 中固定 zh，placeholder 文案稳定。
  const goalInput = page.getByPlaceholder('例如：每周汇总项目状态并生成报告');
  if (await goalInput.count() > 0) return;

  await toggle.click();
  await expect(goalInput, 'legacy form must be visible after expanding Advanced').toBeVisible();
}
