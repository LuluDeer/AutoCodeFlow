/** P7c Linux GUI driver boundary checks; safe on headless/Wayland-only CI. */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { X11GuiDriver, type ToolOutcome } from './gui-x11';

interface Call {
  binary: string;
  args: readonly string[];
}

function harness(overrides?: {
  env?: NodeJS.ProcessEnv;
  respond?: (call: Call) => string | Error;
  tools?: Record<string, string | null>;
  comms?: Record<number, string>;
  platform?: NodeJS.Platform;
}) {
  const calls: Call[] = [];
  const tools = overrides?.tools ?? {
    xdotool: '/usr/bin/xdotool',
    import: '/usr/bin/import',
  };
  const driver = new X11GuiDriver({
    platform: overrides?.platform ?? 'linux',
    env: overrides?.env ?? { DISPLAY: ':0' },
    resolveTool: (name) => (name in tools ? tools[name] : null),
    readComm: (pid) => overrides?.comms?.[pid] ?? null,
    exec: async (binary, args) => {
      const call = { binary, args };
      calls.push(call);
      const response = overrides?.respond?.(call);
      if (response instanceof Error) {
        return { code: 1, stdout: '', stderr: response.message };
      }
      return { code: 0, stdout: response ?? '', stderr: '' } as ToolOutcome;
    },
  });
  return { driver, calls };
}

const OK: ToolOutcome = { code: 0, stdout: '', stderr: '' };

async function main(): Promise<void> {
  // ── platform/env guards ──
  assert.equal(await new X11GuiDriver({ platform: 'win32', env: { DISPLAY: ':0' } }).probe(), false);
  assert.equal((await new X11GuiDriver({ platform: 'win32' }).run({ action: 'focus', app: 'gedit' })).error,
    'x11_gui_unavailable');
  assert.equal(await harness({ env: {} }).driver.probe(), false, 'no DISPLAY — no GUI');
  assert.equal(await harness({ tools: {} }).driver.probe(), false, 'xdotool missing — no GUI');

  // ── probe: geometry is the availability anchor ──
  {
    const h = harness({ respond: (call) => (call.args[0] === 'getdisplaygeometry' ? '1920 1080' : '') });
    assert.equal(await h.driver.probe(), true);
    assert.deepEqual(h.calls.map((c) => c.args[0]), ['getdisplaygeometry']);
  }

  // ── invalid app / params never reach the tools ──
  {
    const h = harness();
    for (const app of ['../gedit', '/usr/bin/gedit', 'gedit.exe', 'gedit*', 'Gedit', '']) {
      assert.equal((await h.driver.run({ action: 'focus', app })).error, 'invalid_app_name', app);
    }
    const invalid = [
      { action: 'click' as const, app: 'gedit', x: -1, y: 0 },
      { action: 'click' as const, app: 'gedit', x: 1.5, y: 0 },
      { action: 'click' as const, app: 'gedit', x: 1 },
      { action: 'type' as const, app: 'gedit', text: '' },
      { action: 'type' as const, app: 'gedit', text: 'x'.repeat(1025) },
      { action: 'type' as const, app: 'gedit', text: 'line\nnext' },
      { action: 'press' as const, app: 'gedit', key: 'CTRL+V' },
      { action: 'screenshot' as const, app: 'gedit', screenshotPath: 'shot.png' },
      { action: 'screenshot' as const, app: 'gedit', screenshotPath: '/tmp/shot.jpg' },
    ];
    for (const input of invalid) assert.equal((await h.driver.run(input)).ok, false);
    assert.equal(h.calls.length, 0, 'invalid input never spawns a tool');
  }

  // ── focus: enumerate → pid/comm whitelist → activate → verify ──
  {
    // 真实 xdotool 的 search 打印十六进制 id、getactivewindow 打印十进制——
    // 假体按归一值判窗（与驱动的一致性语义对齐），不按文本形态。
    const W1 = '0x0a200002';
    const normId = (v: string) => String(parseInt(v.trim(), v.trim().startsWith('0x') ? 16 : 10));
    const h = harness({
      comms: { 4242: 'gedit', 5000: 'other' },
      respond: (call) => {
        const [sub] = call.args;
        if (sub === 'getactivewindow') return W1;
        if (sub === 'getwindowpid') {
          return normId(call.args[2] as string) === normId(W1) ? 'PID=4242' : 'PID=5000';
        }
        if (sub === 'search') return '0x0a200002\n0x0a200003';
        if (sub === 'windowactivate') return '';
        return '';
      },
    });
    const out = await h.driver.run({ action: 'focus', app: 'gedit' });
    assert.equal(out.ok, true, out.error);
    // search used an anchored class pattern — app dots cannot widen the match
    const search = h.calls.find((c) => c.args[0] === 'search');
    assert.equal(search?.args[3], '^(?:gedit)$');
    assert.equal(h.calls.some((c) => c.args[0] === 'windowactivate' && c.args[2] === '0x0a200002'), true);
  }
  {
    // Two distinct processes own visible windows of that class → ambiguous.
    const h = harness({
      comms: { 4242: 'gedit', 5001: 'gedit' },
      respond: (call) => {
        if (call.args[0] === 'search') return '0x0a200002\n0x0a200003';
        if (call.args[0] === 'getwindowpid' && call.args[2] === '0x0a200002') return 'PID=4242';
        return 'PID=5001';
      },
    });
    assert.equal((await h.driver.run({ action: 'focus', app: 'gedit' })).error, 'ambiguous_app_main_window');
  }
  {
    // Class matched but the process behind it is not the allowlisted app.
    const h = harness({
      comms: { 4242: 'other' },
      respond: (call) => (call.args[0] === 'search' ? '0x0a200002' : 'PID=4242'),
    });
    assert.equal((await h.driver.run({ action: 'focus', app: 'gedit' })).error, 'app_identity_mismatch');
  }
  {
    const h = harness({ respond: () => '' });
    assert.equal((await h.driver.run({ action: 'focus', app: 'gedit' })).error, 'app_main_window_not_found');
  }

  // ── foreground re-verification guards every non-focus action ──
  {
    const h = harness({
      respond: (call) => (call.args[0] === 'getdisplaygeometry' ? '1920 1080' : new Error('No window with focus')),
    });
    assert.equal((await h.driver.run({ action: 'click', app: 'gedit', x: 1, y: 1 })).error,
      'foreground_window_unavailable');
    assert.equal(h.calls.length > 0, true);
  }
  {
    const h = harness({ comms: { 4242: 'other' }, respond: () => '0x0a200002\nPID=4242' });
    assert.equal((await h.driver.run({ action: 'press', app: 'gedit', key: 'ENTER' })).error,
      'foreground_app_mismatch');
  }

  // ── click: bounds + relative→absolute + post-verify ──
  {
    const h = harness({
      comms: { 4242: 'gedit' },
      respond: (call) => {
        if (call.args[0] === 'getactivewindow') return '0x0a200002';
        if (call.args[0] === 'getwindowpid') return 'PID=4242';
        if (call.args[0] === 'getwindowgeometry') return 'X=100\nY=200\nWIDTH=800\nHEIGHT=600\nSCREEN=0';
        return '';
      },
    });
    assert.equal((await h.driver.run({ action: 'click', app: 'gedit', x: 800, y: 10 })).error,
      'click_outside_window');
    const ok = await h.driver.run({ action: 'click', app: 'gedit', x: 10, y: 20 });
    assert.equal(ok.ok, true, ok.error);
    const move = h.calls.find((c) => c.args[0] === 'mousemove');
    assert.deepEqual(move?.args, ['mousemove', '--sync', '110', '220']);
    assert.equal(h.calls.some((c) => c.args[0] === 'click' && c.args[1] === '1'), true);
  }

  // ── type: chunked with foreground re-checks between chunks ──
  {
    const h = harness({
      comms: { 4242: 'gedit' },
      respond: (call) => {
        if (call.args[0] === 'getactivewindow') return '0x0a200002';
        if (call.args[0] === 'getwindowpid') return 'PID=4242';
        return '';
      },
    });
    const ok = await h.driver.run({ action: 'type', app: 'gedit', text: 'x'.repeat(100) });
    assert.equal(ok.ok, true, ok.error);
    const typeCalls = h.calls.filter((c) => c.args[0] === 'type');
    assert.equal(typeCalls.length, 4, '100 chars / 32-char chunks = 4 spawns');
    assert.deepEqual(typeCalls[0].args, ['type', '--delay', '12', '--', 'x'.repeat(32)]);
    assert.equal(typeCalls[3].args[4], 'x'.repeat(4));
    const rechecks = h.calls.filter((c) => c.args[0] === 'getactivewindow').length;
    assert.equal(rechecks >= 4, true, 'foreground re-verified at least once per chunk');
  }

  // ── press: closed keysym table ──
  {
    const h = harness({
      comms: { 4242: 'gedit' },
      respond: (call) => {
        if (call.args[0] === 'getactivewindow') return '0x0a200002';
        if (call.args[0] === 'getwindowpid') return 'PID=4242';
        return '';
      },
    });
    assert.equal((await h.driver.run({ action: 'press', app: 'gedit', key: 'ENTER' })).ok, true);
    assert.deepEqual(h.calls.find((c) => c.args[0] === 'key')?.args, ['key', '--', 'Return']);
    assert.equal((await h.driver.run({ action: 'press', app: 'gedit', key: 'PAGEDOWN' })).ok, true);
    assert.deepEqual(h.calls.filter((c) => c.args[0] === 'key')[1].args, ['key', '--', 'Next']);
  }

  // ── screenshot: size guard, tmp+rename, honest missing tool ──
  {
    const h = harness({
      comms: { 4242: 'gedit' },
      respond: (call) => {
        if (call.args[0] === 'getactivewindow') return '0x0a200002';
        if (call.args[0] === 'getwindowpid') return 'PID=4242';
        if (call.args[0] === 'getwindowgeometry') return 'X=0\nY=0\nWIDTH=4096\nHEIGHT=4096\nSCREEN=0';
        if (call.binary.endsWith('import')) {
          fs.writeFileSync(call.args[2] as string, 'png');
          return '';
        }
        return '';
      },
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-gui-x11-'));
    try {
      const target = path.join(dir, 'shot.png');
      const out = await h.driver.run({ action: 'screenshot', app: 'gedit', screenshotPath: target });
      assert.equal(out.ok, true, out.error);
      assert.equal(fs.readFileSync(target, 'utf8'), 'png', 'capture renamed into place');
      assert.equal(fs.existsSync(`${target}.tmp-${process.pid}`), false, 'tmp cleaned up');
      const importCall = h.calls.find((c) => c.binary.endsWith('import'));
      assert.equal(importCall?.args[0], '-window');
      // getactivewindow 打印十进制 id——import 收到的就是该原样形态
      assert.equal(importCall?.args[1], String(parseInt('0x0a200002', 16)), 'window-scoped capture');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  {
    const h = harness({
      tools: { xdotool: '/usr/bin/xdotool', import: null },
      comms: { 4242: 'gedit' },
      respond: (call) => {
        if (call.args[0] === 'getactivewindow') return '0x0a200002';
        if (call.args[0] === 'getwindowpid') return 'PID=4242';
        if (call.args[0] === 'getwindowgeometry') return 'X=0\nY=0\nWIDTH=100\nHEIGHT=100\nSCREEN=0';
        return '';
      },
    });
    const out = await h.driver.run({
      action: 'screenshot',
      app: 'gedit',
      screenshotPath: path.join(os.tmpdir(), 'acf-no-shot.png'),
    });
    assert.equal(out.error, 'x11_tool_unavailable: import', 'missing import reported honestly');
  }

  // ── oversized capture refused before spawning import ──
  {
    const h = harness({
      comms: { 4242: 'gedit' },
      respond: (call) => {
        if (call.args[0] === 'getactivewindow') return '0x0a200002';
        if (call.args[0] === 'getwindowpid') return 'PID=4242';
        if (call.args[0] === 'getwindowgeometry') return 'X=0\nY=0\nWIDTH=8192\nHEIGHT=8192\nSCREEN=0';
        return '';
      },
    });
    assert.equal((await h.driver.run({
      action: 'screenshot',
      app: 'gedit',
      screenshotPath: path.join(os.tmpdir(), 'acf-big.png'),
    })).error, 'screenshot_too_large');
  }

  // ── real smoke (read-only): possible on X11 hosts with the toolchain present ──
  if (process.platform === 'linux' && process.env.DISPLAY) {
    const live = new X11GuiDriver();
    if (await live.probe()) {
      const denied = await live.run({ action: 'press', app: 'acf_gui_nonexistent_7c', key: 'ENTER' });
      assert.equal(denied.ok, false);
      assert.equal(denied.error, 'foreground_app_mismatch');
      const focus = await live.run({ action: 'focus', app: 'acf_gui_nonexistent_7c' });
      assert.ok(['app_main_window_not_found', 'app_identity_mismatch'].includes(focus.error ?? ''),
        `focus denied: ${focus.error}`);
      const file = path.join(os.tmpdir(), `acf-gui-x11-denied-${process.pid}.png`);
      const capture = await live.run({ action: 'screenshot', app: 'acf_gui_nonexistent_7c', screenshotPath: file });
      assert.equal(capture.ok, false);
      assert.equal(fs.existsSync(file), false, 'denied screenshot writes nothing');
      console.log('gui-x11 real smoke: input/focus/capture boundaries denied');
    } else {
      console.log('gui-x11 real smoke: skipped (xdotool/XWayland unavailable on this host)');
    }
  }
  console.log('gui-x11 selftest: all assertions passed');
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
