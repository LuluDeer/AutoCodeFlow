/**
 * S2 正向验证（gui-x11，Xvfb 合成 WM 栈，2026-09-27）。
 *
 * GNOME Wayland 负向验证（scripts/gui-x11-s2-verify.mjs）证明能力被如实拒绝；
 * 本脚本在 **真 X 服务器（Xvfb）** 上验证正向全链：
 *   probe → focus → screenshot → click（点 OK 关窗 = 注入物理生效的确定性证据）
 *   → press ENTER（第二路物理证据）→ type → 越界点击拒绝。
 *
 * 环境事实（决定本脚本形态）：
 *  - Xvfb 无 Wayland 限制：XGetImage / XTEST 全可用；
 *  - 目标必须设 `_NET_WM_PID`（驱动按 /proc/<pid>/comm 核对属主）——老式
 *    xmessage 不设该属性会被驱动如实拒绝，故用 GTK 的 zenity（且本会话
 *    GDK_BACKEND=wayland，必须显式压回 x11 才落上 Xvfb）；
 *  - `_NET_ACTIVE_WINDOW` 本由 WM 维护——Xvfb 无 WM，用 xprop 手动维护该
 *    属性模拟 WM 职责。诚实记录：这是合成 WM，验证的是驱动逻辑端到端 +
 *    物理注入，不是真实 WM 生态（真实 X11 会话的生态验证属 S2 后续）。
 *
 * 用法：node scripts/gui-x11-s2-xvfb-verify.mjs   （自带 Xvfb 启停与清理）
 */
import { spawn, spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { X11GuiDriver } = require('../apps/executor-desktop/dist-selftest/agent/gui-x11.js');

const DISPLAY = ':97';
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sh = (cmd) => spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });

const dir = mkdtempSync(path.join(tmpdir(), 'acf-gui-s2x-'));

const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1024x768x24'], { stdio: 'ignore' });
const children = [];
let targetPid = null;

function spawnTarget(label) {
  const child = spawn('zenity', ['--info', '--no-wrap', `--text=S2 ${label}`], {
    env: { ...process.env, DISPLAY, GDK_BACKEND: 'x11' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  children.push(child);
  return child;
}

/** 找 targetPid 名下、面积最大的窗口（与驱动的主窗启发式一致）。 */
function targetWindowId() {
  const ids = sh(
    `DISPLAY=${DISPLAY} xdotool search --class '^[zZ][eE][nN][iI][tT][yY]$'`,
  ).stdout.trim().split('\n').filter(Boolean);
  let best = null;
  let bestArea = -1;
  for (const id of ids) {
    const pid = Number(sh(`DISPLAY=${DISPLAY} xdotool getwindowpid ${id}`).stdout.trim());
    if (pid !== targetPid) continue;
    const geo = sh(`DISPLAY=${DISPLAY} xdotool getwindowgeometry --shell ${id}`).stdout;
    const vars = Object.fromEntries(geo.trim().split('\n').map((l) => l.split('=')));
    const area = (Number(vars.WIDTH) || 0) * (Number(vars.HEIGHT) || 0);
    if (area > bestArea) { bestArea = area; best = id; }
  }
  return best;
}

function setActive(id) {
  // 合成 WM 两件事：①声明支持位（xdotool 3.2016 会先读 _NET_SUPPORTED，多原子
  // 逗号清单实测解析失败，单原子即可）；②把活动窗口指到目标。
  sh(`DISPLAY=${DISPLAY} xprop -root -f _NET_SUPPORTED 32a -set _NET_SUPPORTED "_NET_ACTIVE_WINDOW"`);
  sh(`DISPLAY=${DISPLAY} xprop -root -f _NET_ACTIVE_WINDOW 32x -set _NET_ACTIVE_WINDOW ${id}`);
}

async function waitWindow(label) {
  const child = spawnTarget(label);
  targetPid = child.pid;
  // 等**大面积主窗**出现（zenity 会先映射一个 1x1 的辅助窗，主窗随后才 map）
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const id = targetWindowId();
    if (!id) continue;
    const geo = sh(`DISPLAY=${DISPLAY} xdotool getwindowgeometry --shell ${id}`).stdout;
    const vars = Object.fromEntries(geo.trim().split('\n').map((l) => l.split('=')));
    if ((Number(vars.WIDTH) || 0) * (Number(vars.HEIGHT) || 0) >= 10000) {
      setActive(id);
      return { child, id };
    }
  }
  throw new Error(`target window not found (${label})`);
}

try {
  await new Promise((resolve) => {
    const t = setInterval(() => {
      if (sh(`DISPLAY=${DISPLAY} xdotool getdisplaygeometry 2>/dev/null`).status === 0) {
        clearInterval(t); resolve(null);
      }
    }, 100);
  });
  const driver = new X11GuiDriver({ env: { ...process.env, DISPLAY } });

  // ── 目标窗口 + 合成 WM 活动窗口属性（probe 的 EWMH 基座）──
  const first = await waitWindow('focus/screenshot/click');
  const target = first.id;

  record('probe（几何 + EWMH 活动窗口基座）', (await driver.probe()) === true);

  // focus
  const focused = await driver.run({ action: 'focus', app: 'zenity' });
  record('focus(zenity)', focused.ok === true, focused.error ?? focused.detail);

  // screenshot（Xvfb 上 XGetImage 可用）
  const shot = path.join(dir, 'zenity.png');
  const captured = await driver.run({ action: 'screenshot', app: 'zenity', screenshotPath: shot });
  const size = captured.ok ? statSync(shot).size : 0;
  record(
    'screenshot 窗口级',
    captured.ok === true && size > 0,
    captured.ok ? `${size} bytes` : captured.error,
  );

  // click OK → 对话框关闭 = 注入物理生效
  const geo = sh(`DISPLAY=${DISPLAY} xdotool getwindowgeometry --shell ${target}`).stdout;
  const vars = Object.fromEntries(geo.trim().split('\n').map((l) => l.split('=')));
  const clickX = Math.floor(Number(vars.WIDTH) / 2);
  const clickY = Number(vars.HEIGHT) - 20; // OK 按钮位于底部
  const clicked = await driver.run({ action: 'click', app: 'zenity', x: clickX, y: clickY });
  await new Promise((r) => setTimeout(r, 800));
  const goneAfterClick = targetWindowId() === null;
  record(
    `click OK@(${clickX},${clickY}) 物理生效（对话框关闭）`,
    clicked.ok === true && goneAfterClick,
    `clicked=${clicked.ok}, closed=${goneAfterClick}, err=${clicked.error ?? '-'}`,
  );

  // press ENTER → 第二个对话框关闭（键盘注入物理证据）
  const second = await waitWindow('press');
  setActive(second.id);
  const pressed = await driver.run({ action: 'press', app: 'zenity', key: 'ENTER' });
  await new Promise((r) => setTimeout(r, 800));
  const goneAfterPress = targetWindowId() === null;
  record(
    'press ENTER 物理生效（对话框关闭）',
    pressed.ok === true && goneAfterPress,
    `pressed=${pressed.ok}, closed=${goneAfterPress}, err=${pressed.error ?? '-'}`,
  );

  // type（对无文本域对话框注入是 inert 的——验证的是链路与复核）
  const third = await waitWindow('type');
  setActive(third.id);
  const typed = await driver.run({ action: 'type', app: 'zenity', text: 's2-typed' });
  record('type（XTEST + 逐块前台复核）', typed.ok === true, typed.error ?? typed.detail);

  // 越界点击拒绝
  setActive(third.id);
  const outside = await driver.run({ action: 'click', app: 'zenity', x: 99999, y: 99999 });
  record(
    '拒绝：点击越出窗口边界',
    outside.ok === false && outside.error === 'click_outside_window',
    outside.error,
  );
} finally {
  try { children.forEach((c) => c.kill()); } catch { /* gone */ }
  try { execSync('pkill -x zenity 2>/dev/null; true', { shell: '/bin/bash' }); } catch { /* none */ }
  try { xvfb.kill(); } catch { /* gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n══ S2 正向（Xvfb）汇总：${passed}/${results.length} 通过 ══`);
process.exitCode = passed === results.length ? 0 : 1;
