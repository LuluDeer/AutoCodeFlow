import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { resolveWithinWorkspace } from './workspace';
import { normalizeAllowedApp } from './permission-profile';

/** P7c: GUI 动作只接受这组封闭操作；应用名必须逐次命中本机白名单。 */
export const GUI_ACTIONS = ['focus', 'click', 'type', 'press', 'screenshot', 'wait'] as const;
export const GUI_ACTIONS_MAX = 40;
export const GUI_PRESS_KEYS = [
  'enter', 'tab', 'escape', 'backspace', 'delete', 'up', 'down', 'left', 'right',
] as const;

export type GuiDriverAction = Exclude<(typeof GUI_ACTIONS)[number], 'wait'>;

export interface GuiDriverInput {
  action: GuiDriverAction;
  /** 小写进程名，不含 .exe、路径或通配符。 */
  app: string;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  /** 已通过工作区路径域校验的绝对路径。 */
  screenshotPath?: string;
}

export interface GuiDriver {
  probe(): Promise<boolean>;
  run(input: GuiDriverInput): Promise<{ ok: boolean; error?: string; detail?: string }>;
}

export interface GuiActionResult {
  ok: boolean;
  refusal?: string;
  detail?: string;
  screenshotPath?: string;
}

/**
 * 纯闸门在 native driver 外层：任何被模型提到的应用都要逐次核对 hostAccess、
 * SOP 能力声明和应用白名单。driver 还会在动作发生前重新核对前台进程。
 */
export class AgentGuiSession {
  private readonly allowedApps: Set<string>;
  private readonly declared: boolean;
  private readonly access: string;
  private readonly driver: GuiDriver;
  private readonly isAppStillAllowed: (app: string) => boolean;
  private ready = false;

  constructor(input: {
    workspaceRoot: string;
    allowedApps: readonly string[];
    sopCapabilities: readonly string[];
    hostAccess: string;
    driver: GuiDriver;
    /** 配置保存可随时收紧权限；动作前必须重新读取当前授权。 */
    isAppStillAllowed?: (app: string) => boolean;
  }) {
    this.workspaceRoot = input.workspaceRoot;
    this.allowedApps = new Set(input.allowedApps.map(normalizeAllowedApp).filter((v): v is string => v !== null));
    this.declared = input.sopCapabilities.includes('gui');
    this.access = input.hostAccess;
    this.driver = input.driver;
    this.isAppStillAllowed = input.isAppStillAllowed ?? (() => true);
  }

  private readonly workspaceRoot: string;

  async start(): Promise<{ ok: boolean; error?: string }> {
    if (!this.declared) return { ok: false, error: 'SOP 未声明 gui 能力域' };
    if (this.access !== 'app-scoped') return { ok: false, error: 'hostAccess 未开启 app-scoped' };
    if (this.allowedApps.size === 0) return { ok: false, error: '应用白名单为空' };
    try {
      if (!(await this.driver.probe())) return { ok: false, error: '本机 GUI 后端不可用' };
    } catch {
      return { ok: false, error: '本机 GUI 后端探测失败' };
    }
    this.ready = true;
    return { ok: true };
  }

  async run(raw: unknown): Promise<GuiActionResult> {
    if (!this.ready) return { ok: false, refusal: 'GUI 会话未通过启动闸门' };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, refusal: 'GUI 动作必须是对象' };
    }
    const input = raw as Record<string, unknown>;
    if (typeof input.action !== 'string' || !(GUI_ACTIONS as readonly string[]).includes(input.action)) {
      return { ok: false, refusal: `GUI 动作 ${String(input.action).slice(0, 40)} 不在封闭枚举内` };
    }
    const app = normalizeAllowedApp(input.app);
    if (!app || !this.allowedApps.has(app)) {
      return { ok: false, refusal: `应用 ${String(input.app).slice(0, 64)} 未在本机白名单` };
    }
    if (!this.isAppStillAllowed(app)) {
      return { ok: false, refusal: `应用 ${app} 的当前授权已撤销` };
    }
    if (!this.declared || this.access !== 'app-scoped') {
      return { ok: false, refusal: 'SOP gui 声明或 hostAccess 档位不满足' };
    }

    if (input.action === 'wait') {
      const ms = Number(input.ms);
      if (!Number.isInteger(ms) || ms < 50 || ms > 5000) {
        return { ok: false, refusal: 'wait.ms 必须是 50..5000 的整数' };
      }
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { ok: true, detail: `waited ${ms}ms` };
    }

    const request: GuiDriverInput = { action: input.action as GuiDriverAction, app };
    if (request.action === 'click') {
      if (!Number.isInteger(input.x) || !Number.isInteger(input.y) ||
          (input.x as number) < 0 || (input.y as number) < 0 ||
          (input.x as number) > 16384 || (input.y as number) > 16384) {
        return { ok: false, refusal: 'click 需要窗口内的整数 x/y 坐标' };
      }
      request.x = input.x as number;
      request.y = input.y as number;
    } else if (request.action === 'type') {
      if (typeof input.text !== 'string' || input.text.length < 1 || input.text.length > 1024) {
        return { ok: false, refusal: 'type.text 必须是 1..1024 字符的文本' };
      }
      request.text = input.text;
    } else if (request.action === 'press') {
      if (typeof input.key !== 'string' || !(GUI_PRESS_KEYS as readonly string[]).includes(input.key.toLowerCase())) {
        return { ok: false, refusal: `press.key 仅支持 ${GUI_PRESS_KEYS.join('/')}` };
      }
      request.key = input.key.toUpperCase();
    } else if (request.action === 'screenshot') {
      const relative = `screenshots/gui-${randomUUID()}.png`;
      const resolved = resolveWithinWorkspace(this.workspaceRoot, relative);
      if (!resolved.ok) return { ok: false, refusal: resolved.error };
      try {
        fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
      } catch (err) {
        return { ok: false, refusal: `GUI 截图目录不可写：${err instanceof Error ? err.message : String(err)}` };
      }
      request.screenshotPath = resolved.path;
    }

    try {
      const result = await this.driver.run(request);
      if (!result.ok) return { ok: false, refusal: result.error ?? 'GUI 后端拒绝动作' };
      if (request.action === 'screenshot' && request.screenshotPath) {
        const stat = fs.statSync(request.screenshotPath);
        if (!stat.isFile() || stat.size === 0 || stat.size > 10 * 1024 * 1024) {
          return { ok: false, refusal: 'GUI 截图为空或超过 10MB 上限' };
        }
        return { ok: true, screenshotPath: path.relative(this.workspaceRoot, request.screenshotPath).replace(/\\/g, '/'), detail: result.detail };
      }
      return { ok: true, detail: result.detail };
    } catch (err) {
      return { ok: false, refusal: err instanceof Error ? err.message : String(err) };
    }
  }
}
