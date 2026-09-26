/**
 * S2 真机三动作验收（gui-x11，2026-09-27）：focus → screenshot → click 走真实
 * XWayland 客户端（影刀 RPA / shadowbot），外加 Wayland 原生窗口与未知应用的
 * 拒绝用例。点击点由验收人看过截图后以 CLI 参数给定（安全选点，不盲点）。
 *
 * 用法：node scripts/gui-x11-s2-verify.mjs <clickX> <clickY>
 *   （坐标相对目标窗口左上角；不给则只跑 focus/screenshot/拒绝用例）
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { X11GuiDriver } = require('../apps/executor-desktop/dist-selftest/agent/gui-x11.js');

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const TARGET_APP = process.argv[2] || 'shadowbot';
const clickX = process.argv[3] !== undefined ? Number(process.argv[3]) : null;
const clickY = process.argv[4] !== undefined ? Number(process.argv[4]) : null;

const driver = new X11GuiDriver();
const dir = mkdtempSync(path.join(tmpdir(), 'acf-gui-s2-'));
const shot = path.join(dir, 'window.png');

// 0. probe
const probed = await driver.probe();
record('probe（DISPLAY + 工具链 + 几何）', probed === true);

// 1. focus 真实 XWayland 客户端
const focused = await driver.run({ action: 'focus', app: TARGET_APP });
record(`focus(${TARGET_APP})`, focused.ok === true, focused.error ?? focused.detail);

// 2. 窗口级截图
const captured = await driver.run({ action: 'screenshot', app: TARGET_APP, screenshotPath: shot });
const size = captured.ok ? statSync(shot).size : 0;
record(
  `screenshot(${TARGET_APP}) 窗口级`,
  captured.ok === true && size > 0,
  captured.ok ? `${shot}（${size} bytes）` : captured.error,
);

// 3. 点击（坐标由验收人看过截图后给定）
if (clickX !== null && clickY !== null && Number.isInteger(clickX) && Number.isInteger(clickY)) {
  const clicked = await driver.run({ action: 'click', app: TARGET_APP, x: clickX, y: clickY });
  record(`click(${TARGET_APP} @ ${clickX},${clickY})`, clicked.ok === true, clicked.error ?? clicked.detail);
} else {
  console.log('… 未给点击坐标，跳过 click（看过截图后传 x y 重跑）');
}

// 4. Wayland 原生窗口不可达：GNOME Shell 是 Wayland 原生，XWayland 枚举不到
const nativeFocus = await driver.run({ action: 'focus', app: 'gnome-shell' });
record(
  '拒绝：Wayland 原生窗口（gnome-shell）不可达',
  nativeFocus.ok === false,
  nativeFocus.error,
);

// 5. 未知应用拒绝
const bogus = await driver.run({ action: 'focus', app: 'acf_gui_nonexistent_7c' });
record('拒绝：未知应用', bogus.ok === false, bogus.error);

// 6. 未授权应用点击拒绝（前台是 shadowbot，但请求的是别的名字 → 前台复核拦截）
if (clickX !== null && focused.ok) {
  const wrongApp = await driver.run({ action: 'press', app: 'another_app', key: 'ENTER' });
  record(
    '拒绝：非白名单应用（前台进程名不匹配）',
    wrongApp.ok === false,
    wrongApp.error,
  );
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n══ S2 汇总：${passed}/${results.length} 通过 ══`);
process.exitCode = passed === results.length ? 0 : 1;
