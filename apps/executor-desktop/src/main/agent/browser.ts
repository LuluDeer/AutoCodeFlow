/**
 * P7b（agent-and-deployment）：浏览器能力（Playwright）。
 *
 * ## 定位（07 §4 执行层 / §4.2「desktop 已有 Playwright，浏览器能力几乎免费」）
 * 执行器 Agent 在网页上操作时的执行层。与试跑沙箱同样的姿态：
 * **封闭动作枚举 + 平台代码强制边界，模型说什么都不算数**。
 *
 * ## 四道边界（全部代码层，不靠 prompt）
 * 1. **Playwright 可用性闸**：动态 require（`@playwright/test` 依赖链带的
 *    `playwright-core`）——不可用时**如实**返回 unavailable，绝不崩溃、绝不
 *    伪装成功。perception 的能力域自述据此不超前声明 `browser`。
 * 2. **动作封闭枚举**：navigate / click / type / press / screenshot /
 *    extract_text / wait 七个。LLM 想要 `exec` / `goto-file://` / 任意 JS
 *    注入（`page.evaluate`）——没有这个动作，就不存在。
 * 3. **导航域名白名单**（07 §4.1：「浏览器工具的域名白名单（代码层检查每次
 *    导航）」）：SOP `constraints.allowedDomains` ∪ 权限档位
 *    `allowedDomains`；**白名单为空 = 禁止一切导航**（安全默认）。
 *    白名单语义是精确主机（`erp.corp.com` 及其子域），不是 URL 前缀。
 * 4. **宿主隔离**：Playwright 启动的是**全新 Chromium 实例**（临时 profile，
 *    无用户登录态）——这不触碰 09 §2.3 的 `hostAccess`（那是「操作本机已
 *    登录软件」的档位）；每个动作有超时，会话有 `close()` 保证回收。
 *
 * ## 产物
 * 截图与录屏（`recordVideo`）都落**工作区**内（同沙箱纪律），文件路径返回
 * 给调用方供上传（collab-client.uploadMedia）与澄清 mediaRefs 引用。
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveWithinWorkspace } from './workspace';

/** 动作封闭枚举。 */
export const BROWSER_ACTIONS = [
  'navigate',
  'click',
  'type',
  'press',
  'screenshot',
  'extract_text',
  'wait',
] as const;
export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

/** 单个动作超时。 */
export const BROWSER_ACTION_TIMEOUT_MS = 20_000;
/** extract_text 的字符上限（防页面全文塞爆 LLM 上下文）。 */
export const EXTRACT_TEXT_MAX = 8_000;
/** 一次会话的动作数上限。 */
export const BROWSER_ACTIONS_MAX = 40;

export interface BrowserActionInput {
  action: string;
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  ms?: number;
}

export interface BrowserActionResult {
  ok: boolean;
  refusal?: string;
  /** extract_text 的页面文本（截断到 EXTRACT_TEXT_MAX）。 */
  text?: string;
  /** screenshot 的产物（工作区相对路径）。 */
  screenshotPath?: string;
  detail?: string;
}

/** Playwright 可用性探测（同步、缓存——perception 与 browser 共用判定）。 */
let playwrightCache: { available: boolean; chromium?: unknown } | null = null;
export function probePlaywright(): { available: boolean; error?: string } {
  if (playwrightCache) return { available: playwrightCache.available, error: playwrightCache.available ? undefined : 'probed: unavailable' };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pw = require('playwright-core');
    playwrightCache = { available: true, chromium: pw.chromium };
    return { available: true };
  } catch (err) {
    playwrightCache = { available: false };
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 导航目标校验：裸域名白名单（SOP constraints ∪ 权限档位），空 = 全禁。
 * 白名单条目在 admin-api 侧已强校验为裸域名（无协议/路径/通配符）。
 */
export function isNavigationAllowed(url: string, allowedDomains: readonly string[]): boolean {
  if (allowedDomains.length === 0) return false;
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedDomains.some((d) => {
    const domain = d.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  });
}

/** 浏览器会话：一次指派一个，用完必须 close（回收 Chromium + 落录屏）。 */
export class AgentBrowserSession {
  private browser: { close: () => Promise<void>; newContext: (o: unknown) => Promise<unknown> } | null = null;
  private context: {
    close: () => Promise<void>;
    newPage: () => Promise<unknown>;
  } | null = null;
  private page: {
    goto: (url: string, o?: unknown) => Promise<{ status: () => number } | null>;
    click: (sel: string, o?: unknown) => Promise<void>;
    fill: (sel: string, text: string, o?: unknown) => Promise<void>;
    press: (sel: string, key: string, o?: unknown) => Promise<void>;
    screenshot: (o: unknown) => Promise<Buffer>;
    textContent: (sel: string, o?: unknown) => Promise<string | null>;
    waitForTimeout: (ms: number) => Promise<void>;
    url: () => string;
  } | null = null;

  constructor(
    private readonly workspaceRoot: string,
    private readonly allowedDomains: readonly string[],
  ) {}

  /**
   * 启动会话（Playwright Chromium，全新临时 profile）+ 录屏上下文。
   * 白名单为空时**拒绝启动**——没有边界的浏览器不该被打开。
   */
  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this.allowedDomains.length === 0) {
      return { ok: false, error: '域名白名单为空——禁止启动浏览器（安全默认：SOP constraints.allowedDomains 必须显式列出可达域）' };
    }
    const pw = probePlaywright();
    if (!pw.available) {
      return { ok: false, error: `Playwright 不可用（${pw.error ?? '未安装'}）——本机无浏览器自动化能力` };
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pwmod = require('playwright-core');
      const recordingDir = resolveWithinWorkspace(this.workspaceRoot, 'browser-recordings');
      if (!recordingDir.ok) return { ok: false, error: recordingDir.error };
      fs.mkdirSync(recordingDir.path, { recursive: true });
      this.browser = await pwmod.chromium.launch({ headless: true });
      this.context = (await this.browser!.newContext({
        recordVideo: { dir: recordingDir.path, size: { width: 1280, height: 720 } },
        // 全新 profile：无用户 cookie/登录态（hostAccess=none 也成立的前提）
        ignoreHTTPSErrors: false,
      })) as typeof this.context;
      this.page = (await (this.context as { newPage: () => Promise<unknown> }).newPage()) as typeof this.page;
      return { ok: true };
    } catch (err) {
      await this.close().catch(() => undefined);
      return { ok: false, error: `浏览器启动失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** 执行一个封闭枚举动作。失败收敛为 result，绝不抛。 */
  async run(input: BrowserActionInput): Promise<BrowserActionResult> {
    if (!(BROWSER_ACTIONS as readonly string[]).includes(input?.action)) {
      return { ok: false, refusal: `动作 ${String(input?.action).slice(0, 40)} 不在封闭枚举内（${BROWSER_ACTIONS.join('/')})` };
    }
    if (!this.page) {
      return { ok: false, refusal: '会话未启动（先 start）' };
    }
    try {
      switch (input.action as BrowserAction) {
        case 'navigate': {
          const url = input.url ?? '';
          if (!isNavigationAllowed(url, this.allowedDomains)) {
            return { ok: false, refusal: `导航被拒：${url.slice(0, 120)} 不在域名白名单内（每次导航都校验）` };
          }
          const resp = await this.page.goto(url, { timeout: BROWSER_ACTION_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
          return { ok: true, detail: `status=${resp ? resp.status() : 'null'} url=${this.page.url().slice(0, 200)}` };
        }
        case 'click': {
          if (typeof input.selector !== 'string' || !input.selector) return { ok: false, refusal: 'click 需要 selector' };
          await this.page.click(input.selector, { timeout: BROWSER_ACTION_TIMEOUT_MS });
          return { ok: true };
        }
        case 'type': {
          if (typeof input.selector !== 'string' || typeof input.text !== 'string') return { ok: false, refusal: 'type 需要 selector + text' };
          await this.page.fill(input.selector, input.text.slice(0, 2000), { timeout: BROWSER_ACTION_TIMEOUT_MS });
          return { ok: true };
        }
        case 'press': {
          if (typeof input.selector !== 'string' || typeof input.key !== 'string') return { ok: false, refusal: 'press 需要 selector + key' };
          await this.page.press(input.selector, input.key.slice(0, 32), { timeout: BROWSER_ACTION_TIMEOUT_MS });
          return { ok: true };
        }
        case 'screenshot': {
          const rel = `screenshots/shot-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`;
          const resolved = resolveWithinWorkspace(this.workspaceRoot, rel);
          if (!resolved.ok) return { ok: false, refusal: resolved.error };
          const buf = await this.page.screenshot({ timeout: BROWSER_ACTION_TIMEOUT_MS });
          fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
          fs.writeFileSync(resolved.path, buf);
          return { ok: true, screenshotPath: rel };
        }
        case 'extract_text': {
          const sel = typeof input.selector === 'string' && input.selector ? input.selector : 'body';
          const text = (await this.page.textContent(sel, { timeout: BROWSER_ACTION_TIMEOUT_MS })) ?? '';
          return { ok: true, text: text.slice(0, EXTRACT_TEXT_MAX) };
        }
        case 'wait': {
          const ms = Math.min(Math.max(Number(input.ms ?? 1000), 50), 10_000);
          await this.page.waitForTimeout(ms);
          return { ok: true, detail: `waited ${ms}ms` };
        }
      }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 收尾：关上下文（录屏文件在 close 时落盘）→ 关浏览器。
   * 返回录屏文件（工作区相对路径）；无录屏 = null。
   */
  async close(): Promise<{ videoPath: string | null }> {
    let videoPath: string | null = null;
    try {
      if (this.context) {
        const ctx = this.context as { close: () => Promise<void>; pages?: () => Array<{ video?: () => Promise<{ path: () => Promise<string> } | null> }> };
        // Playwright 的 video 对象在 page.video().path()，close 后才最终落盘
        try {
          const pages = ctx.pages?.() ?? [];
          for (const p of pages) {
            const v = (p as { video?: () => { path: () => Promise<string> } | null }).video?.();
            if (v) {
              const abs = await v.path();
              const rel = path.relative(this.workspaceRoot, abs).replace(/\\/g, '/');
              if (!rel.startsWith('..')) videoPath = rel;
            }
          }
        } catch {
          /* video 元信息拿不到不阻塞关闭 */
        }
        await ctx.close();
      }
      if (this.browser) await this.browser.close();
    } catch {
      /* 尽力而为：浏览器进程退出兜底靠进程生命周期 */
    } finally {
      this.page = null;
      this.context = null;
      this.browser = null;
    }
    return { videoPath };
  }
}
