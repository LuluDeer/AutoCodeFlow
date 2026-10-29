/** P7c Windows GUI driver boundary checks; safe on headless/non-Windows CI. */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { classifyProbeError, WindowsGuiDriver, type WindowsGuiInput } from './gui-windows';

async function main(): Promise<void> {
  const seen: Array<{ action: string; app?: string }> = [];
  const driver = new WindowsGuiDriver({
    platform: 'win32',
    invoke: async (request) => {
      seen.push(request);
      return { ok: true, detail: request.action };
    },
  });

  assert.equal(await new WindowsGuiDriver({ platform: 'linux', invoke: async () => {
    throw new Error('must not invoke');
  } }).probe(), false);
  assert.deepEqual(await new WindowsGuiDriver({ platform: 'linux' }).run({ action: 'focus', app: 'notepad' }), {
    ok: false, error: 'windows_gui_unavailable',
  });

  for (const app of ['../notepad', 'C:\\Windows\\notepad.exe', 'notepad.exe', 'note*', 'Notepad', '']) {
    assert.equal((await driver.run({ action: 'focus', app })).error, 'invalid_app_name', app);
  }
  assert.equal(seen.length, 0, 'invalid app never reaches PowerShell');

  const invalid: WindowsGuiInput[] = [
    { action: 'click', app: 'notepad', x: -1, y: 1 },
    { action: 'click', app: 'notepad', x: 1.5, y: 1 },
    { action: 'click', app: 'notepad', x: 1 },
    { action: 'type', app: 'notepad', text: '' },
    { action: 'type', app: 'notepad', text: 'x'.repeat(1025) },
    { action: 'type', app: 'notepad', text: 'line\nnext' },
    { action: 'press', app: 'notepad', key: 'CTRL+V' },
    { action: 'screenshot', app: 'notepad', screenshotPath: 'shot.png' },
    { action: 'screenshot', app: 'notepad', screenshotPath: 'C:\\shot.jpg' },
  ];
  for (const input of invalid) assert.equal((await driver.run(input)).ok, false);
  assert.equal(seen.length, 0, 'invalid action parameters never reach PowerShell');

  const winPath = path.win32.join('C:\\agent-workspace', 'screenshots', 'shot.png');
  for (const input of [
    { action: 'focus', app: 'notepad' },
    { action: 'click', app: 'notepad', x: 0, y: 0 },
    { action: 'type', app: 'notepad', text: '中文 A' },
    { action: 'press', app: 'notepad', key: 'ENTER' },
    { action: 'press', app: 'notepad', key: 'ESCAPE' },
    { action: 'screenshot', app: 'notepad', screenshotPath: winPath },
  ] as WindowsGuiInput[]) {
    assert.equal((await driver.run(input)).ok, true);
  }
  // D-03：旧断言把「每个动作前重探一次」写成了期望值
  // （probe, focus, probe, click, probe, type, …）。那不是契约而是缺陷：
  // 一次 probe = PowerShell 冷启动 + Add-Type 编译 C#，逐动作重探等于把
  // 每次点击/输入都额外叠上一条进程启动延迟，且探得的结果在同一会话内
  // 不可能变化（变化会由动作自身的 native 校验单独报错）。新期望：会话内
  // 只探一次，动作直接复用。
  assert.deepEqual(seen.map((item) => item.action), ['probe', 'focus', 'click', 'type', 'press', 'press', 'screenshot']);
  assert.equal(
    seen.filter((item) => item.action === 'probe').length,
    1,
    'D-03: 会话级 probe 只跑一次（不得每动作重探）',
  );
  assert.equal(seen[1].app, 'notepad', 'request is passed as data with exact app name');

  let attempted = 0;
  const unavailable = new WindowsGuiDriver({
    platform: 'win32',
    invoke: async () => { attempted++; return { ok: false, error: 'foreground_window_unavailable' }; },
  });
  // D-03：旧断言要求 probe 失败一律塌缩成 `windows_gui_unavailable`——同样是
  // 把缺陷写成契约：锁屏/服务会话（interactive_desktop_unavailable）与"平台
  // 不支持"同码，agent-host 据此静默摘掉 gui 能力、日志也没有线索。现在透传
  // native 错误码。
  assert.equal(
    (await unavailable.run({ action: 'press', app: 'notepad', key: 'ENTER' })).error,
    'foreground_window_unavailable',
  );
  assert.equal(attempted, 1, 'probe failure prevents input');
  // 失败**不缓存**：锁屏是临时状态，解锁后必须能重新探活（成功才缓存）。
  assert.equal(
    (await unavailable.run({ action: 'press', app: 'notepad', key: 'ENTER' })).error,
    'foreground_window_unavailable',
  );
  assert.equal(attempted, 2, 'D-03: probe 失败不得缓存（锁屏是临时状态）');

  // 锁屏/服务会话必须与"平台不支持"区分开：可恢复 ≠ 永久摘能力。
  const nonInteractive = new WindowsGuiDriver({
    platform: 'win32',
    invoke: async () => ({ ok: false, error: 'interactive_desktop_unavailable' }),
  });
  assert.equal(
    (await nonInteractive.run({ action: 'focus', app: 'notepad' })).error,
    'session_not_interactive',
  );
  assert.deepEqual(await new WindowsGuiDriver({ platform: 'linux' }).run({ action: 'focus', app: 'notepad' }), {
    ok: false, error: 'windows_gui_unavailable',
  });

  // 纯函数映射：native 码透传、交互桌面异常码归一、未知码回落不可用。
  assert.equal(classifyProbeError('interactive_desktop_unavailable'), 'session_not_interactive');
  assert.equal(classifyProbeError('foreground_window_unavailable'), 'foreground_window_unavailable');
  assert.equal(classifyProbeError(undefined), 'windows_gui_unavailable');
  assert.equal(classifyProbeError('   '), 'windows_gui_unavailable');

  // Real Win32 smoke is read-only: impossible process names can only be denied.
  if (process.platform === 'win32') {
    const live = new WindowsGuiDriver();
    if (await live.probe()) {
      const denied = await live.run({ action: 'press', app: 'acf_gui_nonexistent_7c', key: 'ENTER' });
      assert.equal(denied.ok, false);
      assert.equal(denied.error, 'foreground_app_mismatch');
      const focus = await live.run({ action: 'focus', app: 'acf_gui_nonexistent_7c' });
      assert.equal(focus.error, 'app_main_window_not_found');
      const file = path.win32.join(os.tmpdir(), `acf-gui-denied-${process.pid}.png`);
      const capture = await live.run({ action: 'screenshot', app: 'acf_gui_nonexistent_7c', screenshotPath: file });
      assert.equal(capture.error, 'foreground_app_mismatch');
      assert.equal(fs.existsSync(file), false, 'denied screenshot writes nothing');
      console.log('gui-windows real Win32 smoke: input/focus/capture boundaries denied');
    } else {
      console.log('gui-windows real Win32 smoke: skipped (interactive desktop unavailable)');
    }
  }
  console.log('gui-windows selftest: all assertions passed');
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
