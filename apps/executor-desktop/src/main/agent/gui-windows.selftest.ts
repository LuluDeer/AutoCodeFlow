/** P7c Windows GUI driver boundary checks; safe on headless/non-Windows CI. */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { WindowsGuiDriver, type WindowsGuiInput } from './gui-windows';

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
  assert.deepEqual(seen.map((item) => item.action), [
    'probe', 'focus', 'probe', 'click', 'probe', 'type', 'probe', 'press', 'probe', 'press', 'probe', 'screenshot',
  ]);
  assert.equal(seen[11].app, 'notepad', 'request is passed as data with exact app name');

  let attempted = 0;
  const unavailable = new WindowsGuiDriver({
    platform: 'win32',
    invoke: async () => { attempted++; return { ok: false, error: 'foreground_window_unavailable' }; },
  });
  assert.equal((await unavailable.run({ action: 'press', app: 'notepad', key: 'ENTER' })).error, 'windows_gui_unavailable');
  assert.equal(attempted, 1, 'probe failure prevents input');

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
