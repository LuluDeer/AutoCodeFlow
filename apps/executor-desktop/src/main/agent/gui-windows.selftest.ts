/** P7c Windows GUI driver boundary checks; safe on headless/non-Windows CI. */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { classifyProbeError, WindowsGuiDriver, type WindowsGuiInput } from './gui-windows';

// ───────────────────────── 脚本文本断言（第二半） ─────────────────────────
// 为什么要有这一段：本文件把 `invoke` 整体 mock 掉，**没有一行触到那段 ~230 行的
// PowerShell**。于是「130 行自检全绿」与「脚本少一个括号」可以同时成立 —— 语法错
// 只会在真机 Windows 打到那一步时才炸，现场表现成 `invalid_powershell_response`，
// 从日志里看不出是脚本坏了。这里至少钉住脚本的**形状**：解析得出来、必需结构在、
// 没有 JS 插值残留、括号/引号/here-string 平衡。
// 更完整的静态校验在 `scripts/check-windows-gui-script.mjs`（判据⑦ 会核对这一段，
// 删掉下面的断言 = 自检又变回「什么都没验」，守卫会红）。
// [script-assert:begin]
const GUI_WINDOWS_SOURCE_CANDIDATES = [
  // dist-selftest/agent/*.js → <pkg>/src/main/agent/gui-windows.ts
  path.join(__dirname, '..', '..', 'src', 'main', 'agent', 'gui-windows.ts'),
  path.join(__dirname, '..', 'src', 'main', 'agent', 'gui-windows.ts'),
  path.join(__dirname, 'gui-windows.ts'),
];

function readGuiWindowsSource(): string {
  const found = GUI_WINDOWS_SOURCE_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  // 取不到源码 = 判据瞎了（文件改名/目录结构变了）。不许静默跳过：
  // 跳过会让这个文件的其余断言看起来仍然「验了脚本」，实际一条都没验。
  assert.ok(found, `判据瞎了：找不到 gui-windows.ts（试过 ${GUI_WINDOWS_SOURCE_CANDIDATES.join(' | ')}）`);
  return fs.readFileSync(found as string, 'utf8');
}

/** 只取 `String.raw` 模板体：**解析**而不是手抄一份脚本（副本必然与源码漂移）。 */
function extractWindowsGuiScript(source: string): string {
  const match = /const\s+WINDOWS_GUI_SCRIPT\s*=\s*String\.raw`([\s\S]*?)`;/.exec(source);
  assert.ok(match, '判据瞎了：源码里找不到 `const WINDOWS_GUI_SCRIPT = String.raw` 模板（常量改名？）');
  return (match as RegExpExecArray)[1];
}

/**
 * 把 PowerShell 的字符串/here-string/注释抹成空白（保留换行）。
 * 必须先剥再数括号：`DllImport("user32.dll")`、here-string 里的 C#、`'{'` 都会误报。
 */
function stripPowerShellLiterals(script: string): { stripped: string; hereStrings: number } {
  const out = script.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  let hereStrings = 0;
  let i = 0;
  while (i < script.length) {
    const ch = script[i];
    if (ch === '#') {
      const nl = script.indexOf('\n', i);
      const end = nl < 0 ? script.length : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '@' && (script[i + 1] === "'" || script[i + 1] === '"')) {
      const term = `${script[i + 1]}@`;
      let at = -1;
      let lineStart = i + 2;
      while (lineStart <= script.length) {
        const nl = script.indexOf('\n', lineStart);
        const line = script.slice(lineStart, nl < 0 ? script.length : nl);
        if (line.trimStart().startsWith(term)) { at = lineStart; break; }
        if (nl < 0) break;
        lineStart = nl + 1;
      }
      assert.ok(at >= 0, `here-string（@${script[i + 1]} … ${term}）未闭合`);
      const lead = (/^[ \t]*/.exec(script.slice(at, at + 8)) ?? [''])[0].length;
      blank(i, at);
      blank(at, at + lead + term.length);
      hereStrings += 1;
      i = at + lead + term.length;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < script.length) {
        if (ch === '"' && script[j] === '`') { j += 2; continue; }
        if (script[j] === ch) {
          if (script[j + 1] === ch) { j += 2; continue; }
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      assert.ok(closed, `${ch === "'" ? '单' : '双'}引号字符串未闭合（第 ${i} 字符起）`);
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === '`') { i += 2; continue; }
    i += 1;
  }
  return { stripped: out.join(''), hereStrings };
}

function assertWindowsGuiScriptText(): void {
  const script = extractWindowsGuiScript(readGuiWindowsSource());

  // ① 规模下界：脚本塌了（提取错了模板 / 被掏空）必须红，而不是「少几行也无所谓」。
  const nonEmpty = script.split('\n').filter((line) => line.trim() !== '').length;
  assert.ok(nonEmpty >= 50, `脚本只剩 ${nonEmpty} 个非空行（下界 50）——提取面抓错了对象？`);

  // ② 回话协议与序列化：node 侧只认 stdout 上的一行 JSON。
  assert.match(script, /function\s+Reply\b/, '脚本必须定义 Reply（JSON 回话协议）');
  assert.match(script, /ConvertTo-Json/, '脚本必须用 ConvertTo-Json 回话');
  assert.match(script, /\btry\s*\{/);
  assert.match(script, /\bcatch\s*\{/);

  // ③ 设计上不接收任何插值：值只走 stdin 的 JSON。出现 `${` 说明有人塞了 JS 表达式。
  assert.equal(script.includes('${'), false, '脚本里不得出现 ${（JS 模板插值残留）');

  // ④ 剥掉字符串/注释后括号必须平衡（含 here-string 闭合）。
  const { stripped, hereStrings } = stripPowerShellLiterals(script);
  assert.ok(hereStrings >= 1, '脚本必须仍有一段 here-string（注入的 C# 定义）');
  for (const [open, close] of [['{', '}'], ['(', ')'], ['[', ']']] as const) {
    let depth = 0;
    let min = 0;
    for (const ch of stripped) {
      if (ch === open) depth += 1;
      if (ch === close) { depth -= 1; if (depth < min) min = depth; }
    }
    assert.equal(min, 0, `括号 ${open}${close} 出现「先闭后开」（最少深度 ${min}）`);
    assert.equal(depth, 0, `括号 ${open}${close} 不平衡（净差 ${depth}）`);
  }
}
// [script-assert:end]

async function main(): Promise<void> {
  // 先验脚本形状：mock 掉的 invoke 永远看不到它。
  assertWindowsGuiScriptText();
  console.log('gui-windows selftest: 脚本文本断言通过（解析提取 / 必需结构 / 无插值 / 括号平衡）');

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
