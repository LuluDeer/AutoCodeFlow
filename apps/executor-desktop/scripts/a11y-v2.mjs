#!/usr/bin/env node
/**
 * V2 无障碍与键盘验收（真壳）。
 *
 *   npm run a11y:v2
 *
 * 覆盖：
 *   - axe-core（wcag2a + wcag2aa）跑 5 个页面 + 历史抽屉 + 卸载对话框 + 命令面板；
 *   - 键盘行为：Esc 关闭并把焦点还给触发元素、Ctrl+K 打开命令面板。
 *
 * axe 通过 `page.evaluate` 注入：页面 CSP 禁止内联 <script>（addScriptTag 会被拦），
 * 但 DevTools 上下文的 evaluate 不受页面 CSP 限制。
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('@playwright/test');
const AXE_SRC = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-a11y-'));
execFileSync(process.execPath, [path.join(appDir, 'scripts', 'seed-v2-harness.mjs'), userData], {
  stdio: 'ignore',
});

const failures = [];
const check = (label, ok, extra = '') => {
  if (ok) console.log(`  PASS  ${label}${extra ? ` — ${extra}` : ''}`);
  else {
    failures.push(label);
    console.error(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`);
  }
};

async function axe(page, label) {
  const violations = await page.evaluate(async (source) => {
    // eslint-disable-next-line no-eval
    (0, eval)(source);
    const result = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    });
    return result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
    }));
  }, AXE_SRC);

  const serious = violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  check(`axe ${label}`, serious.length === 0, serious.map((v) => `${v.id}(${v.targets.join(',')})`).join(' '));
}

const app = await electron.launch({
  args: ['.', '--no-sandbox'],
  cwd: appDir,
  executablePath: require('electron'),
  env: { ...process.env, ACF_OPEN_STATUS: '1', ELECTRON_USER_DATA_DIR: userData },
});

try {
  const page = await app.firstWindow();
  await page.waitForTimeout(1800);

  await axe(page, 'status');

  await page.locator('aside nav button').nth(1).click();
  await page.waitForTimeout(500);
  await axe(page, 'history');

  // 历史抽屉：Esc 关闭 + 焦点回到行按钮。
  const row = page.locator('main [data-history-row]').first();
  await row.click();
  await page.waitForTimeout(500);
  await axe(page, 'history sheet');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const sheetClosed = (await page.locator('[role="dialog"]').count()) === 0;
  const focusBackToRow = await page.evaluate(() => {
    const el = document.activeElement;
    return el?.tagName === 'BUTTON' && Boolean(el.closest('[data-history-row]'));
  });
  check('history sheet closes on Esc', sheetClosed);
  check('focus returns to history row', focusBackToRow);

  // 清空历史确认框（Dialog 语义 + 焦点归还）
  const clearTrigger = page.getByRole('button', { name: /^(清空历史|Clear history)$/ }).first();
  await clearTrigger.click();
  await page.waitForTimeout(400);
  await axe(page, 'history clear dialog');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const focusBackToClear = await page.evaluate(() => {
    const el = document.activeElement;
    return { tag: el?.tagName ?? '', text: (el?.textContent ?? '').trim() };
  });
  check(
    'focus returns to clear-history trigger',
    focusBackToClear.tag === 'BUTTON' && /清空历史|Clear history/.test(focusBackToClear.text),
    `${focusBackToClear.tag}:${focusBackToClear.text}`,
  );

  await page.locator('aside nav button').nth(2).click();
  await page.waitForTimeout(500);
  await axe(page, 'apps');

  await page.locator('aside nav button').nth(3).click();
  await page.waitForTimeout(500);
  await axe(page, 'config');

  // 命令面板
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(400);
  const paletteOpen = (await page.locator('[cmdk-root]').count()) > 0;
  check('Ctrl+K opens command palette', paletteOpen);
  await axe(page, 'command palette');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const paletteClosed = (await page.locator('[cmdk-root]').count()) === 0;
  check('command palette closes on Esc', paletteClosed);
} finally {
  await app.close();
}

// 独立向导窗口
const wizardUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-a11y-wizard-'));
fs.copyFileSync(path.join(userData, 'config.json'), path.join(wizardUserData, 'config.json'));
const wizardConfig = JSON.parse(fs.readFileSync(path.join(wizardUserData, 'config.json'), 'utf8'));
wizardConfig.configured = false;
fs.writeFileSync(path.join(wizardUserData, 'config.json'), JSON.stringify(wizardConfig, null, 2));

const wizardApp = await electron.launch({
  args: ['.', '--no-sandbox'],
  cwd: appDir,
  executablePath: require('electron'),
  env: { ...process.env, ELECTRON_USER_DATA_DIR: wizardUserData },
});

try {
  const page = await wizardApp.firstWindow();
  await page.waitForTimeout(1500);
  await axe(page, 'wizard');
} finally {
  await wizardApp.close();
  fs.rmSync(wizardUserData, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`[a11y:v2] ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('[a11y:v2] all checks passed');
