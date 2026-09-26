/**
 * Linux desktop GUI driver (X11/XWayland). Model supplied values travel only
 * as argv to a fixed set of X11 tools resolved from system paths — there is no
 * shell, no script, and no interpolation. The active window is re-verified
 * against the allowlisted process name before every operation (per chunk when
 * typing). Design recon: docs/design/agent-and-deployment/12-executor-gui-linux.md.
 *
 * Known deviation from the Windows backend (recorded in the recon doc): X11 has
 * no WindowFromPoint equivalent, so the click hit-test is "bounds check + the
 * click must have left the target window active", not a per-point hit test.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';

import type { GuiDriver, GuiDriverInput } from './gui';

// Keep this identical to permission-profile.normalizeAllowedApp's output.
const APP_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_TYPE_LENGTH = 1024;
const MAX_TOOL_OUTPUT = 16 * 1024;
const TOOL_TIMEOUT_MS = 15_000;
/** Same as the Windows backend: refuse captures above 4096x4096-ish. */
const MAX_CAPTURE_PIXELS = 16_777_216;
/** Foreground is re-verified between typing chunks (Windows re-checks per char). */
const TYPE_CHUNK_CHARS = 32;
/** Search may return many windows; cap the pid walk. */
const MAX_SEARCH_RESULTS = 64;

/** xdotool keysym per supported press key (gate layer uppercases). */
const X11_KEYSYMS: Record<string, string> = {
  ENTER: 'Return', TAB: 'Tab', ESCAPE: 'Escape', BACKSPACE: 'BackSpace',
  DELETE: 'Delete', UP: 'Up', DOWN: 'Down', LEFT: 'Left', RIGHT: 'Right',
  HOME: 'Home', END: 'End', PAGEUP: 'Prior', PAGEDOWN: 'Next',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
  F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
};

export const X11_GUI_KEYS = Object.keys(X11_KEYSYMS) as readonly string[];

export interface ToolOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  failed?: string;
}

export type ToolRunner = (
  binary: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
) => Promise<ToolOutcome>;
export type ToolResolver = (name: string) => string | null;
export type CommReader = (pid: number) => string | null;

export interface X11GuiDriverOptions {
  /** Test seam; production always uses process.platform. */
  platform?: NodeJS.Platform;
  /** Test seam; production reads process.env. */
  env?: NodeJS.ProcessEnv;
  /** Test seam; production spawns the resolved tool with shell disabled. */
  exec?: ToolRunner;
  /** Test seam; production probes fixed system directories. */
  resolveTool?: ToolResolver;
  /** Test seam; production reads /proc/<pid>/comm. */
  readComm?: CommReader;
}

const TOOL_DIRS = ['/usr/bin', '/usr/local/bin', '/bin', '/usr/sbin', '/sbin'];

/** Fixed system paths only — a same-named tool in workDir/PATH cannot be used.
 *  Non-root-owned tools are refused (a writable tool could bypass the closed
 *  argv set). Weaker than the Windows absolute-path resolution, acceptable
 *  because workDir is never on PATH here. */
function resolveSystemTool(name: string): string | null {
  for (const dir of TOOL_DIRS) {
    const candidate = path.join(dir, name);
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile() || stat.uid !== 0) return null;
      return candidate;
    } catch {
      /* not here — keep scanning */
    }
  }
  return null;
}

function defaultRun(binary: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<ToolOutcome> {
  return new Promise((resolve) => {
    const child = spawn(binary, [...args], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      // DISPLAY 等环境必须来自驱动配置（X11GuiDriverOptions.env）而非进程继承
      // ——测试/托管环境可能把工具指到不同的 X server。
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    let stdout = '';
    let stderr = '';
    let expired = false;
    let overflow = false;
    let spawnError: string | null = null;
    const timer = setTimeout(() => { expired = true; child.kill(); }, TOOL_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_TOOL_OUTPUT) { overflow = true; child.kill(); }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > MAX_TOOL_OUTPUT) { overflow = true; child.kill(); }
    });
    child.on('error', (error) => { spawnError = error.message; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (expired) { resolve({ code, stdout, stderr, failed: 'x11_tool_timeout' }); return; }
      if (overflow) { resolve({ code, stdout, stderr, failed: 'x11_tool_output_too_large' }); return; }
      if (spawnError) { resolve({ code, stdout, stderr, failed: `x11_tool_failed: ${spawnError}` }); return; }
      resolve({ code, stdout, stderr });
    });
  });
}

function defaultReadComm(pid: number): string | null {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return null;
  }
}

/** getwindowpid output across xdotool versions (实测 Ubuntu 24.04 = 3.2016
 *  成功时裸数字、失败时 "window N has no pid" 散文；新版 --shell 的 PID= 形态；
 *  另有 "Window N has pid M" 散文）。严格按形态解析——绝不能把失败文案里的
 *  窗口 id 当成 pid（那会让属主校验读到错误的 /proc 条目）。 */
function parsePid(stdout: string): number | undefined {
  const trimmed = stdout.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const hasPid = /\bhas pid (\d+)/.exec(stdout);
  if (hasPid) return parseInt(hasPid[1], 10);
  const vars = parseShellVars(stdout);
  if (vars.PID !== undefined) return vars.PID;
  return undefined;
}

/** xdotool prints ids in hex or decimal depending on subcommand — normalize. */
function normalizeWindowId(raw: string): string {
  const trimmed = raw.trim();
  const parsed = parseInt(trimmed, trimmed.startsWith('0x') ? 16 : 10);
  return Number.isSafeInteger(parsed) ? String(parsed) : '';
}

function parseShellVars(stdout: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of stdout.split('\n')) {
    const match = /^([A-Z]+)=(.*)$/.exec(line.trim());
    if (match && /^-?\d+$/.test(match[2])) out[match[1]] = parseInt(match[2], 10);
  }
  return out;
}

/** App names are matched as anchored POSIX ERE — escape the metachars our charset
 *  allows and case-fold each letter into [xX] classes: WM_CLASS 实测常带大写
 *  （影刀 = class "ShadowBot"），而白名单 token 恒为小写；POSIX ERE 没有
 *  内联忽略大小写 flag，xdotool 也不支持 (?i)。xdotool rejects PCRE-isms
 *  like (?:...) with exit 13 (实测). */
function escapeEre(value: string): string {
  return value
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
}

/** xdotool search exits 1 with empty output when nothing matches (实测) —
 *  that is "no windows", not a tool failure. Anything with stderr is real. */
async function searchWindowIds(
  runTool: (name: string, args: readonly string[]) => Promise<string>,
  criterion: string,
  anchored: string,
): Promise<string[]> {
  try {
    const found = await runTool('xdotool', ['search', criterion, anchored]);
    return found.split('\n').map((v) => v.trim()).filter((v) => /^(?:0x[0-9a-fA-F]+|\d+)$/.test(v)).slice(0, MAX_SEARCH_RESULTS);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Failed to compile regex')) throw err; // 编译失败是真错误，如实上抛
    return [];
  }
}

interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ActiveWindow {
  id: string;
  comm: string;
}

/** A small, closed API. Permission profile / allowlist checks stay above it. */
export class X11GuiDriver implements GuiDriver {
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly exec: ToolRunner;
  private readonly resolveTool: ToolResolver;
  private readonly readComm: CommReader;

  constructor(options: X11GuiDriverOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.exec = options.exec ?? defaultRun;
    this.resolveTool = options.resolveTool ?? resolveSystemTool;
    this.readComm = options.readComm ?? defaultReadComm;
  }

  private tool(name: string): string | null {
    if (this.platform !== 'linux') return null;
    return this.resolveTool(name);
  }

  private async runTool(name: string, args: readonly string[]): Promise<string> {
    const binary = this.tool(name);
    if (!binary) throw new Error(`x11_tool_unavailable: ${name}`);
    const outcome = await this.exec(binary, args, this.env);
    if (outcome.failed) throw new Error(outcome.failed);
    if (outcome.code !== 0) {
      throw new Error(outcome.stderr.trim().split('\n')[0] || `x11_tool_exit_${outcome.code}`);
    }
    return outcome.stdout;
  }

  async probe(): Promise<boolean> {
    try {
      if (!this.env.DISPLAY) return false;
      await this.runTool('xdotool', ['getdisplaygeometry']);
      // 逐动作前台身份验证的基座是 EWMH `_NET_ACTIVE_WINDOW`。实测（2026-09-27,
      // Ubuntu 24.04 GNOME Wayland）：XWayland 下该属性恒空（0x0/查询失败）、
      // `import -window` 被 XGetImage 拒绝（资源暂时不可用）——此栈上无法验证
      // 「前台 == 白名单应用」也无法截窗，物理注入成了盲注入。按「宁可如实
      // 不支持，不做假闸门」：probe 额外要求 getactivewindow 可读，GNOME
      // Wayland 会话如实不报 gui 能力（改用 Xorg/X11 会话则完整可用）。
      // 代价：X11 会话登录初期无聚焦窗口时 probe 短暂 false，下个能力周期自愈。
      await this.runTool('xdotool', ['getactivewindow']);
      return true;
    } catch {
      return false;
    }
  }

  async run(input: GuiDriverInput): Promise<{ ok: boolean; error?: string; detail?: string }> {
    if (this.platform !== 'linux') return { ok: false, error: 'x11_gui_unavailable' };
    if (!input || !validAppName(input.app)) return { ok: false, error: 'invalid_app_name' };
    if (!['focus', 'click', 'type', 'press', 'screenshot'].includes(input.action)) {
      return { ok: false, error: 'unsupported_action' };
    }
    if (input.action === 'click' && (!Number.isSafeInteger(input.x) || !Number.isSafeInteger(input.y) ||
      (input.x as number) < 0 || (input.y as number) < 0)) {
      return { ok: false, error: 'invalid_click_coordinates' };
    }
    if (input.action === 'type' && (typeof input.text !== 'string' ||
      input.text.length < 1 || input.text.length > MAX_TYPE_LENGTH || /[\x00-\x1F\x7F]/.test(input.text))) {
      return { ok: false, error: 'invalid_text' };
    }
    if (input.action === 'press' && !X11_GUI_KEYS.includes(input.key as string)) {
      return { ok: false, error: 'unsupported_key' };
    }
    if (input.action === 'screenshot' && (typeof input.screenshotPath !== 'string' ||
      !path.isAbsolute(input.screenshotPath) || path.extname(input.screenshotPath).toLowerCase() !== '.png')) {
      return { ok: false, error: 'invalid_screenshot_path' };
    }
    try {
      if (!(await this.probe())) return { ok: false, error: 'x11_gui_unavailable' };
    } catch {
      return { ok: false, error: 'x11_gui_unavailable' };
    }
    try {
      switch (input.action) {
        case 'focus': return await this.focus(input.app);
        case 'click': return await this.click(input);
        case 'type': return await this.type(input);
        case 'press': return await this.press(input);
        case 'screenshot': return await this.screenshot(input);
        default: return { ok: false, error: 'unsupported_action' };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The active window must belong to a process whose comm equals the app name. */
  private async activeWindowFor(app: string): Promise<ActiveWindow> {
    let raw: string;
    try {
      raw = await this.runTool('xdotool', ['getactivewindow']);
    } catch {
      // No focused window / WM quirks — one honest code, not raw tool stderr.
      throw new Error('foreground_window_unavailable');
    }
    const id = normalizeWindowId(raw);
    if (!id) throw new Error('foreground_window_unavailable');
    return { id, comm: await this.commOf(id, app) };
  }

  private async commOf(windowId: string, app: string): Promise<string> {
    const pid = parsePid(await this.runTool('xdotool', ['getwindowpid', windowId]));
    const comm = pid !== undefined ? this.readComm(pid) : null;
    // 大小写不敏感对齐 Windows 驱动（OrdinalIgnoreCase）——/proc comm 实测可能
    // 带大写（如 Telegram），白名单 token 恒为小写。
    if (!comm || comm.toLowerCase() !== app.toLowerCase()) {
      throw new Error('foreground_app_mismatch');
    }
    return comm;
  }

  private async geometry(windowId: string): Promise<Geometry> {
    const vars = parseShellVars(await this.runTool('xdotool', ['getwindowgeometry', '--shell', windowId]));
    if (vars.WIDTH === undefined || vars.HEIGHT === undefined || vars.X === undefined || vars.Y === undefined ||
        vars.WIDTH <= 0 || vars.HEIGHT <= 0) {
      throw new Error('invalid_window_bounds');
    }
    return { x: vars.X, y: vars.Y, width: vars.WIDTH, height: vars.HEIGHT };
  }

  /** 目标窗口是否已不存在（被动作自身关闭等）。geometry 读不到即视为 gone。 */
  private async isWindowGone(windowId: string): Promise<boolean> {
    try {
      await this.geometry(windowId);
      return false;
    } catch {
      return true;
    }
  }

  private async focus(app: string): Promise<{ ok: boolean; detail?: string }> {
    const anchored = `^${escapeEre(app)}$`;
    // _NET_CLIENT_LIST is empty on GNOME Wayland's XWayland — enumerate via
    // xdotool's class walk instead of the root client list (recon doc §2.1).
    let ids: string[] = [];
    for (const criterion of ['--class', '--classname']) {
      // Keep the ids exactly as xdotool printed them (hex or decimal) — the
      // original form is what we pass back to getwindowpid/windowactivate.
      // Normalization to decimal happens only for equality checks.
      // 无 --onlyvisible：GNOME Wayland 下 XWayland 窗口的可见位不可靠
      // （实测带过滤全空、窗口真实在屏），可见性由 windowactivate 提升 +
      // 激活后的前台复核兜底。
      ids = await searchWindowIds(this.runTool.bind(this), criterion, anchored);
      if (ids.length > 0) break;
    }
    if (ids.length === 0) throw new Error('app_main_window_not_found');
    // Whitelist semantics = process-name exact match; WM_CLASS is only the
    // enumeration hint. A class hit whose process is not the app is refused.
    const owned: string[] = [];
    for (const id of ids) {
      const pid = parsePid(await this.runTool('xdotool', ['getwindowpid', id]));
      const comm = pid !== undefined ? this.readComm(pid) : null;
      if (comm && comm.toLowerCase() === app.toLowerCase()) owned.push(id);
    }
    if (owned.length === 0) throw new Error('app_identity_mismatch');
    const pids = new Set<number>();
    for (const id of owned) {
      const pid = parsePid(await this.runTool('xdotool', ['getwindowpid', id]));
      if (pid !== undefined) pids.add(pid);
    }
    if (pids.size > 1) throw new Error('ambiguous_app_main_window');
    // 同进程多窗口 → 取面积最大者（主窗口启发式；并列取 id 最小，确定性）。
    let target = owned[0];
    let bestArea = -1;
    for (const id of owned) {
      try {
        const rect = await this.geometry(id);
        const area = rect.width * rect.height;
        if (area > bestArea) {
          bestArea = area;
          target = id;
        }
      } catch {
        /* geometry 读不到的窗口（ withdrawing 等）不参与主窗候选 */
      }
    }
    // 不用 --sync：它等的是 EWMH 活动通知，无 WM 环境（合成栈/裸 X）会永久
    // 等到超时。激活请求本身是异步的——改为有界轮询 getactivewindow 确认。
    await this.runTool('xdotool', ['windowactivate', target]);
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const active = await this.activeWindowFor(app);
      if (active.id === normalizeWindowId(target)) return { ok: true, detail: 'focused' };
    }
    throw new Error('foreground_window_changed');
  }

  private async click(input: GuiDriverInput): Promise<{ ok: boolean; detail?: string }> {
    const active = await this.activeWindowFor(input.app);
    const rect = await this.geometry(active.id);
    const x = input.x as number;
    const y = input.y as number;
    if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) {
      throw new Error('click_outside_window');
    }
    await this.activeWindowFor(input.app); // re-verify right before the pointer move
    await this.runTool('xdotool', ['mousemove', '--sync', String(rect.x + x), String(rect.y + y)]);
    await this.runTool('xdotool', ['click', '1']);
    // 事后校验：确认注入未被劫持。目标因动作自身而关闭（点了关闭按钮）时
    // 活动窗口无从读起——目标不存在即不存在被劫持面，如实标注成功。
    try {
      const after = await this.activeWindowFor(input.app);
      if (after.id !== active.id) throw new Error('click_target_window_mismatch');
      return { ok: true, detail: 'clicked' };
    } catch (err) {
      if (await this.isWindowGone(active.id)) {
        return { ok: true, detail: 'clicked (target closed by action)' };
      }
      throw err;
    }
  }

  private async type(input: GuiDriverInput): Promise<{ ok: boolean; detail?: string }> {
    const active = await this.activeWindowFor(input.app);
    const text = input.text as string;
    // Windows re-checks per character; a recheck per chunk keeps the same
    // "target still focused" guarantee with 1/32nd of the process spawns.
    let chunks = 0;
    for (let offset = 0; offset < text.length; offset += TYPE_CHUNK_CHARS) {
      let current: ActiveWindow;
      try {
        current = await this.activeWindowFor(input.app);
      } catch (err) {
        // 焦点读不到：目标被（前几块的输入触发的）动作关闭时如实截断——
        // 绝不把剩余块盲注到一个未经验证的前台上。
        if (await this.isWindowGone(active.id)) {
          return { ok: true, detail: `typed ${chunks} chunk(s), target closed mid-type` };
        }
        throw err;
      }
      if (current.id !== active.id) throw new Error('foreground_window_changed');
      await this.runTool('xdotool', ['type', '--delay', '12', '--', text.slice(offset, offset + TYPE_CHUNK_CHARS)]);
      chunks += 1;
    }
    return { ok: true, detail: `typed ${chunks} chunk(s)` };
  }

  private async press(input: GuiDriverInput): Promise<{ ok: boolean; detail?: string }> {
    const active = await this.activeWindowFor(input.app);
    const keysym = X11_KEYSYMS[(input.key as string).toUpperCase()];
    if (!keysym) throw new Error('unsupported_key');
    await this.runTool('xdotool', ['key', '--', keysym]);
    try {
      const after = await this.activeWindowFor(input.app);
      if (after.id !== active.id) throw new Error('foreground_window_changed');
      return { ok: true, detail: 'pressed' };
    } catch (err) {
      if (await this.isWindowGone(active.id)) {
        return { ok: true, detail: 'pressed (target closed by action)' };
      }
      throw err;
    }
  }

  private async screenshot(input: GuiDriverInput): Promise<{ ok: boolean; detail?: string }> {
    const active = await this.activeWindowFor(input.app);
    const rect = await this.geometry(active.id);
    if (rect.width * rect.height > MAX_CAPTURE_PIXELS) throw new Error('screenshot_too_large');
    const targetPath = input.screenshotPath as string;
    if (fs.existsSync(targetPath)) throw new Error('screenshot_path_exists');

    // 捕获后端（实测 2026-09-27，Ubuntu 24.04）：
    //  · ffmpeg x11grab —— 唯一可用路径（Xvfb 与真实会话均验证）；
    //  · import（ImageMagick）—— IM6 的 XGetImage 在本机栈上 EAGAIN
    //    （真桌面与 Xvfb 同样失败），保留为其他栈的后备。
    // 语义注记：区域抓取捕获的是目标窗口矩形内的**合成画面**（遮挡含入），
    // 等价于 Windows 后端 PrintWindow 的窗口范围但不剔除遮挡——与点击命中
    // 校验的弱化同族，已在设计文档登记。
    const display = this.env.DISPLAY ?? ':0';
    const attempts: Array<{ binary: string; args: string[] }> = [];
    const ffmpeg = this.tool('ffmpeg');
    if (ffmpeg) {
      attempts.push({
        binary: ffmpeg,
        args: [
          '-loglevel', 'error',
          '-f', 'x11grab',
          '-video_size', `${rect.width}x${rect.height}`,
          '-i', `${display}.0+${rect.x},${rect.y}`,
          '-frames:v', '1',
          '-y', '', // 输出路径在下方填入
        ],
      });
    }
    const imagemagick = this.tool('import');
    if (imagemagick) {
      attempts.push({ binary: imagemagick, args: ['-window', active.id, ''] });
    }
    if (attempts.length === 0) {
      throw new Error('x11_tool_unavailable: ffmpeg/import (capture backend)');
    }

    // Write beside the destination, then rename — the fs rename keeps the
    // no-overwrite guarantee atomic against the gate's randomized path.
    const tmpPath = `${targetPath}.tmp-${process.pid}`;
    try {
      let lastError = 'window_capture_failed';
      for (const attempt of attempts) {
        const args = [...attempt.args];
        args[args.length - 1] = tmpPath;
        const outcome = await this.exec(attempt.binary, args, this.env);
        if (outcome.failed || outcome.code !== 0) {
          lastError = outcome.failed
            || outcome.stderr.trim().split('\n')[0]
            || 'window_capture_failed';
          continue;
        }
        const stat = fs.statSync(tmpPath);
        if (!stat.isFile() || stat.size === 0) {
          lastError = 'window_capture_failed';
          continue;
        }
        if (fs.existsSync(targetPath)) throw new Error('screenshot_path_exists');
        fs.renameSync(tmpPath, targetPath);
        return { ok: true, detail: 'window_screenshot_saved' };
      }
      throw new Error(lastError);
    } catch (error) {
      try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
      throw error;
    }
  }
}

function validAppName(app: unknown): app is string {
  return typeof app === 'string' && APP_NAME.test(app) && app === app.toLowerCase() &&
    !app.endsWith('.exe') && app.trim() === app;
}
