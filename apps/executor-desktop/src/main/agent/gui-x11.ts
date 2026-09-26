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

export type ToolRunner = (binary: string, args: readonly string[]) => Promise<ToolOutcome>;
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

function defaultRun(binary: string, args: readonly string[]): Promise<ToolOutcome> {
  return new Promise((resolve) => {
    const child = spawn(binary, [...args], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
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

/** App names are matched as anchored ERE — escape the metachars our charset allows. */
function escapeEre(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    const outcome = await this.exec(binary, args);
    if (outcome.failed) throw new Error(outcome.failed);
    if (outcome.code !== 0) {
      throw new Error(outcome.stderr.trim().split('\n')[0] || `x11_tool_exit_${outcome.code}`);
    }
    return outcome.stdout;
  }

  async probe(): Promise<boolean> {
    try {
      if (!this.env.DISPLAY) return false;
      // Core availability: an X server that reports geometry. Focus-dependent
      // checks are deliberately not part of probe (a session without a focused
      // window is still automatable via focus first).
      await this.runTool('xdotool', ['getdisplaygeometry']);
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
    const vars = parseShellVars(await this.runTool('xdotool', ['getwindowpid', '--shell', windowId]));
    const pid = vars.PID;
    const comm = pid !== undefined ? this.readComm(pid) : null;
    if (!comm || comm !== app) throw new Error('foreground_app_mismatch');
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

  private async focus(app: string): Promise<{ ok: boolean; detail?: string }> {
    const anchored = `^(?:${escapeEre(app)})$`;
    // _NET_CLIENT_LIST is empty on GNOME Wayland's XWayland — enumerate via
    // xdotool's class walk instead of the root client list (recon doc §2.1).
    let ids: string[] = [];
    for (const criterion of ['--class', '--classname']) {
      const found = await this.runTool('xdotool', ['search', '--onlyvisible', criterion, anchored]);
      // Keep the ids exactly as xdotool printed them (hex or decimal) — the
      // original form is what we pass back to getwindowpid/windowactivate.
      // Normalization to decimal happens only for equality checks.
      ids = found.split('\n').map((v) => v.trim()).filter((v) => /^(?:0x[0-9a-fA-F]+|\d+)$/.test(v)).slice(0, MAX_SEARCH_RESULTS);
      if (ids.length > 0) break;
    }
    if (ids.length === 0) throw new Error('app_main_window_not_found');
    // Whitelist semantics = process-name exact match; WM_CLASS is only the
    // enumeration hint. A class hit whose process is not the app is refused.
    const owned: string[] = [];
    for (const id of ids) {
      const vars = parseShellVars(await this.runTool('xdotool', ['getwindowpid', '--shell', id]));
      if (vars.PID !== undefined && this.readComm(vars.PID) === app) owned.push(id);
    }
    if (owned.length === 0) throw new Error('app_identity_mismatch');
    const pids = new Set<number>();
    for (const id of owned) {
      const vars = parseShellVars(await this.runTool('xdotool', ['getwindowpid', '--shell', id]));
      pids.add(vars.PID);
    }
    if (pids.size > 1) throw new Error('ambiguous_app_main_window');
    const target = owned[0];
    await this.runTool('xdotool', ['windowactivate', '--sync', target]);
    const active = await this.activeWindowFor(app);
    if (active.id !== normalizeWindowId(target)) throw new Error('foreground_window_changed');
    return { ok: true, detail: 'focused' };
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
    const after = await this.activeWindowFor(input.app);
    if (after.id !== active.id) throw new Error('click_target_window_mismatch');
    return { ok: true, detail: 'clicked' };
  }

  private async type(input: GuiDriverInput): Promise<{ ok: boolean; detail?: string }> {
    const active = await this.activeWindowFor(input.app);
    const text = input.text as string;
    // Windows re-checks per character; a recheck per chunk keeps the same
    // "target still focused" guarantee with 1/32nd of the process spawns.
    let chunks = 0;
    for (let offset = 0; offset < text.length; offset += TYPE_CHUNK_CHARS) {
      const current = await this.activeWindowFor(input.app);
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
    const after = await this.activeWindowFor(input.app);
    if (after.id !== active.id) throw new Error('foreground_window_changed');
    return { ok: true, detail: 'pressed' };
  }

  private async screenshot(input: GuiDriverInput): Promise<{ ok: boolean; detail?: string }> {
    const active = await this.activeWindowFor(input.app);
    const rect = await this.geometry(active.id);
    if (rect.width * rect.height > MAX_CAPTURE_PIXELS) throw new Error('screenshot_too_large');
    const targetPath = input.screenshotPath as string;
    if (fs.existsSync(targetPath)) throw new Error('screenshot_path_exists');
    const binary = this.tool('import');
    if (!binary) throw new Error('x11_tool_unavailable: import');
    // Write beside the destination, then rename — the fs rename keeps the
    // no-overwrite guarantee atomic against the gate's randomized path.
    const tmpPath = `${targetPath}.tmp-${process.pid}`;
    try {
      const outcome = await this.exec(binary, ['-window', active.id, tmpPath]);
      if (outcome.failed || outcome.code !== 0) {
        throw new Error(outcome.failed || outcome.stderr.trim().split('\n')[0] || 'window_capture_failed');
      }
      const stat = fs.statSync(tmpPath);
      if (!stat.isFile() || stat.size === 0) throw new Error('window_capture_failed');
      if (fs.existsSync(targetPath)) throw new Error('screenshot_path_exists');
      fs.renameSync(tmpPath, targetPath);
    } catch (error) {
      try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
      throw error;
    }
    return { ok: true, detail: 'window_screenshot_saved' };
  }
}

function validAppName(app: unknown): app is string {
  return typeof app === 'string' && APP_NAME.test(app) && app === app.toLowerCase() &&
    !app.endsWith('.exe') && app.trim() === app;
}
