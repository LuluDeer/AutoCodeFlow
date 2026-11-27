/**
 * P7b self-check：浏览器工具的封闭动作枚举与域名白名单。
 * Run via: npm run test:main
 *
 * 两层：
 *   · **闸门逻辑**（全平台可测）：动作枚举、白名单为空 = 全禁、协议白名单、
 *     子域语义、未启动会话拒绝执行；
 *   · **替身单元级**：probe 依赖注入（模块在但 executable 缺失 → unavailable）、
 *     wait/extract_text/screenshot 动作后越界 → 会话终止（screenshot 越界产物同步清理）；
 *   · **真实浏览器**（条件执行）：playwright 模块 + Chromium executable 均通过探测时跑一轮
 *     「本地服务器 → navigate/extract_text/screenshot → close 落录屏」；
 *     未安装时**如实打印跳过**（不是假绿——跳过行显式可见）。
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AgentBrowserSession,
  BROWSER_ACTIONS,
  checkPostActionUrl,
  isNavigationAllowed,
  probePlaywright,
} from './browser';
import { filterAllowlistDomains, isValidAllowlistDomain } from './domain-allowlist';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) console.log(`  \u2714 ${name}`);
  else {
    failures++;
    console.error(`  \u2718 ${name}${extra ? ` \u2014 ${extra}` : ''}`);
  }
}

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-'));
}

/** 内存替身页：只实现封闭动作用到的最小面，绝不声称是真实浏览器级实测。 */
interface FakePage {
  currentUrl: string;
  goto: (url: string) => Promise<{ status: () => number }>;
  click: () => Promise<void>;
  fill: () => Promise<void>;
  press: () => Promise<void>;
  screenshot: () => Promise<Buffer>;
  textContent: () => Promise<string | null>;
  waitForTimeout: () => Promise<void>;
  url: () => string;
}

function makeFakePage(initialUrl: string): FakePage {
  const page: FakePage = {
    currentUrl: initialUrl,
    goto: async (url) => {
      page.currentUrl = url;
      return { status: () => 200 };
    },
    click: async () => undefined,
    fill: async () => undefined,
    press: async () => undefined,
    screenshot: async () => Buffer.from('fake-png'),
    textContent: () => Promise.resolve('fake text'),
    waitForTimeout: async () => undefined,
    url: () => page.currentUrl,
  };
  return page;
}

function attachFakePage(s: AgentBrowserSession, page: FakePage): void {
  (s as unknown as { page: unknown }).page = page;
}

async function main(): Promise<void> {
  console.log('\n=== browser selftest ===\n');

  console.log('-- 1. 导航白名单（纯逻辑）--');
  {
    // 空白名单 = 全禁（安全默认）
    check('空白名单禁一切导航', isNavigationAllowed('https://erp.corp.com/x', []) === false);
    const wl = ['erp.corp.com', 'crm.corp.com'];
    check('白名单域放行', isNavigationAllowed('https://erp.corp.com/login', wl) === true);
    check('子域放行', isNavigationAllowed('https://api.erp.corp.com/v1', wl) === true);
    check('非白名单域拒绝', isNavigationAllowed('https://evil.example.com', wl) === false);
    // 前缀混淆不算子域（attacker-corp.com 不是 corp.com）
    check('前缀混淆拒绝', isNavigationAllowed('https://erp.corp.com.evil.io', ['corp.com']) === false);
    check('协议白名单（data:/file: 拒）', isNavigationAllowed('file:///C:/Windows/system32/config', wl) === false && isNavigationAllowed('javascript:alert(1)', wl) === false);
    check('非法 URL 拒', isNavigationAllowed('not a url', wl) === false);
  }

  console.log('-- 1b. P2-2 单标签条目字形闸（"com" 不得放大成 *.com）--');
  {
    // 核心反证：白名单里的 "com" 在 endsWith 匹配下放行一切 *.com
    check("单标签 'com' 条目不得放行 evil.com", isNavigationAllowed('https://evil.com/x', ['com']) === false);
    check("单标签 'com' 条目不得放行 anything.corp.com 等任意 *.com", isNavigationAllowed('https://anything.com', ['com']) === false);
    check("'example.com' 合法且放行", isValidAllowlistDomain('example.com') === true && isNavigationAllowed('https://example.com/', ['example.com']) === true);
    check("'example.com' 子域仍放行", isNavigationAllowed('https://api.example.com/v1', ['example.com']) === true);
    // 字形规则
    for (const bad of ['com', '.com', 'com.', 'a..com', '-a.com', 'a-.com', 'a b.com', 'a_com', '*.com', 'https://a.com', 'a.com/path', 'x'.repeat(254), '']) {
      check(`非法条目 ${JSON.stringify(bad.length > 20 ? `${bad.slice(0, 12)}…(${bad.length})` : bad)} 被拒`, isValidAllowlistDomain(bad) === false);
    }
    check('大小写归一（Example.COM 合法）', isValidAllowlistDomain('Example.COM') === true);
    check('非字符串拒', isValidAllowlistDomain(42) === false && isValidAllowlistDomain(null) === false);
    // 过滤 helper：合法保留 + 非法上报（供 runtime 并集 warn / config 消毒）
    const filtered = filterAllowlistDomains(['OK.Example.com', 'com', 'ok.example.com', 'ok.example.com', '', 42, 'a..b']);
    check(
      'filterAllowlistDomains：去重 + 剔除非法 + 上报非法清单',
      JSON.stringify(filtered.valid) === JSON.stringify(['ok.example.com']) &&
        filtered.invalid.includes('com') && filtered.invalid.includes('a..b'),
      JSON.stringify(filtered),
    );
    // 过滤后白名单为空 = 全禁（与会话层 start 的空白名单拒绝同语义）
    check('全非法条目 → 过滤后全禁', isNavigationAllowed('https://anything.com', ['com', 'localhost']) === false);
    // P2-3 纯函数锚点：动作后落点复核
    const wl2 = ['erp.corp.com', 'crm.corp.com'];
    check('checkPostActionUrl：在界落点 ok', checkPostActionUrl('https://erp.corp.com/after', wl2).ok === true);
    const bad = checkPostActionUrl('https://evil.example.com/redirected', wl2);
    check('checkPostActionUrl：越界落点报违例', bad.ok === false && !bad.ok && bad.url.includes('evil.example.com'));
  }

  console.log('-- 2. 动作封闭枚举 --');
  {
    const ws = makeWorkspace();
    const s = new AgentBrowserSession(ws, ['erp.corp.com']);
    for (const evil of ['exec', 'evaluate', 'goto_file', 'delete_files', '']) {
      const r = await s.run({ action: evil });
      check(`动作 ${JSON.stringify(evil)} 被拒（枚举外）`, r.ok === false && r.refusal !== undefined && r.refusal.includes('封闭枚举'));
    }
    check('枚举全集 = 7 个动作', BROWSER_ACTIONS.length === 7);
    await s.close();
    fs.rmSync(ws, { recursive: true, force: true });
  }

  console.log('-- 3. 白名单为空拒绝启动 --');
  {
    const ws = makeWorkspace();
    const s = new AgentBrowserSession(ws, []);
    const r = await s.start();
    check('空白名单 → 拒绝启动（没边界的浏览器不该打开）', r.ok === false && (r.error ?? '').includes('白名单为空'));
    await s.close();
    fs.rmSync(ws, { recursive: true, force: true });
  }

  console.log('-- 4. 未启动会话拒绝执行动作 --');
  {
    const ws = makeWorkspace();
    const s = new AgentBrowserSession(ws, ['erp.corp.com']);
    const r = await s.run({ action: 'navigate', url: 'https://erp.corp.com' });
    check('未 start 的会话拒绝动作', r.ok === false && (r.refusal ?? '').includes('未启动'));
    fs.rmSync(ws, { recursive: true, force: true });
  }

  console.log('-- 4b. Playwright 能力探测（可注入替身，单元级，非浏览器实测）--');
  {
    const missingExe = probePlaywright({
      deps: {
        load: () => ({ chromium: { executablePath: () => '/fixture/missing/chrome' } }),
        exists: (p) => p !== '/fixture/missing/chrome',
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '/fixture/browsers' },
      },
    });
    check(
      '模块存在但 Chromium executable 缺失 → unavailable（不向中心报 browser）',
      missingExe.available === false && (missingExe.error ?? '').includes('Chromium executable 不存在'),
      JSON.stringify(missingExe),
    );

    const presentExe = probePlaywright({
      deps: {
        load: () => ({ chromium: { executablePath: () => '/fixture/browsers/chromium-999/chrome-linux/chrome' } }),
        exists: () => true,
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '/fixture/browsers' },
      },
    });
    check('executable 存在 → available', presentExe.available === true, JSON.stringify(presentExe));

    const noExeApi = probePlaywright({
      deps: { load: () => ({ chromium: {} }), exists: () => true, env: process.env },
    });
    check('模块无 executablePath → unavailable', noExeApi.available === false);

    const loadThrows = probePlaywright({
      deps: {
        load: () => {
          throw new Error('module boom');
        },
        exists: () => true,
        env: process.env,
      },
    });
    check('require 失败仍收敛为 unavailable', loadThrows.available === false && (loadThrows.error ?? '').includes('module boom'));
  }

  console.log('-- 4c. 观察动作后越界复核（内存替身，非浏览器实测）--');
  {
    const allowed = 'https://erp.corp.com/ok';
    const evil = 'https://evil.example.com/landing';

    {
      const ws = makeWorkspace();
      const s = new AgentBrowserSession(ws, ['erp.corp.com']);
      const page = makeFakePage(allowed);
      page.waitForTimeout = async () => {
        page.currentUrl = evil;
      };
      attachFakePage(s, page);
      const r = await s.run({ action: 'wait', ms: 50 });
      check(
        'wait 后越界 → sessionClosed / 边界终止',
        r.ok === false && r.sessionClosed === true && (r.refusal ?? '').includes('白名单外'),
        JSON.stringify(r),
      );
      const next = await s.run({ action: 'extract_text' });
      check('wait 越界后会话拒绝后续动作', next.ok === false && (next.refusal ?? '').includes('终止'));
      fs.rmSync(ws, { recursive: true, force: true });
    }

    {
      const ws = makeWorkspace();
      const s = new AgentBrowserSession(ws, ['erp.corp.com']);
      const page = makeFakePage(allowed);
      page.textContent = async () => {
        page.currentUrl = evil;
        return 'SECRET';
      };
      attachFakePage(s, page);
      const r = await s.run({ action: 'extract_text', selector: '#t' });
      check(
        'extract_text 后越界 → sessionClosed 且不回传页面文本',
        r.ok === false && r.sessionClosed === true && r.text === undefined,
        JSON.stringify(r),
      );
      const next = await s.run({ action: 'wait', ms: 50 });
      check('extract_text 越界后会话拒绝后续动作', next.ok === false && (next.refusal ?? '').includes('终止'));
      fs.rmSync(ws, { recursive: true, force: true });
    }

    {
      const ws = makeWorkspace();
      const s = new AgentBrowserSession(ws, ['erp.corp.com']);
      const page = makeFakePage(allowed);
      page.screenshot = async () => {
        page.currentUrl = evil;
        return Buffer.from('fake-png');
      };
      attachFakePage(s, page);
      const r = await s.run({ action: 'screenshot' });
      const shotDir = path.join(ws, 'screenshots');
      const shots = fs.existsSync(shotDir) ? fs.readdirSync(shotDir) : [];
      check(
        'screenshot 后越界 → 越界截图已清理且 sessionClosed',
        r.ok === false && r.sessionClosed === true && shots.length === 0,
        JSON.stringify({ ...r, shots: shots.length }),
      );
      const next = await s.run({ action: 'extract_text' });
      check('screenshot 越界后会话拒绝后续动作', next.ok === false && (next.refusal ?? '').includes('终止'));
      fs.rmSync(ws, { recursive: true, force: true });
    }

    {
      const ws = makeWorkspace();
      const s = new AgentBrowserSession(ws, ['erp.corp.com']);
      attachFakePage(s, makeFakePage(allowed));
      const wait = await s.run({ action: 'wait', ms: 50 });
      const text = await s.run({ action: 'extract_text', selector: '#t' });
      const shot = await s.run({ action: 'screenshot' });
      check('同域 wait 不受影响（保留 detail）', wait.ok === true && (wait.detail ?? '').includes('waited'));
      check('同域 extract_text 不受影响（保留 text）', text.ok === true && text.text === 'fake text');
      check(
        '同域 screenshot 不受影响（保留 screenshotPath）',
        shot.ok === true && shot.screenshotPath !== undefined && fs.existsSync(path.join(ws, shot.screenshotPath ?? 'x')),
      );
      const after = await s.run({ action: 'wait', ms: 50 });
      check('同域复核后会话仍可继续执行', after.ok === true && after.sessionClosed === undefined);
      await s.close();
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }

  console.log('-- 5. 真实浏览器（条件执行）--');
  {
    const pw = probePlaywright();
    if (!pw.available) {
      console.log('  (跳过：Playwright 能力探测未通过——模块或 Chromium executable 不可用，如实跳过而非假绿)');
    } else {
      // 本地服务器当"目标站点"，白名单放行 localhost
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h1 id="t">报表系统首页</h1><button id="b">导出</button></body></html>');
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as { port: number }).port;
      const ws = makeWorkspace();
      // P2-2：白名单条目必须含点——Chromium 按 RFC 6761 把 *.localhost 解析到
      // 本机回环，`sub.localhost` 因此是合法（含点）且可达的回环名。
      const s = new AgentBrowserSession(ws, ['sub.localhost']);
      const started = await s.start();
      if (!started.ok) {
        console.log(`  (跳过：浏览器二进制未安装——${(started.error ?? '').slice(0, 80)}。运行 npx playwright install chromium 后本节可跑)`);
      } else {
        const nav = await s.run({ action: 'navigate', url: `http://sub.localhost:${port}/` });
        check('navigate 放行', nav.ok === true, nav.refusal ?? nav.detail ?? '');
        const evil = await s.run({ action: 'navigate', url: `http://evil.example.com/` });
        check('白名单外导航在会话内仍被拒（每次导航都校验）', evil.ok === false && (evil.refusal ?? '').includes('白名单'));
        const text = await s.run({ action: 'extract_text', selector: '#t' });
        check('extract_text 取到页面文本', text.ok === true && (text.text ?? '').includes('报表系统首页'));
        const shot = await s.run({ action: 'screenshot' });
        check('screenshot 落工作区', shot.ok === true && shot.screenshotPath !== undefined && fs.existsSync(path.join(ws, shot.screenshotPath ?? 'x')));
        const closed = await s.close();
        check('close 返回录屏（recordVideo）', closed.videoPath !== null && fs.existsSync(path.join(ws, closed.videoPath ?? 'x')), `videoPath=${closed.videoPath ?? 'null'}`);
      }
      await s.close();
      server.close();
      fs.rmSync(ws, { recursive: true, force: true });

      // ── P2-3：click 后落点越界 → 会话终止（302 重定向形态）────────────
      const evilServer = http.createServer((req, res) => {
        if (req.url === '/bounce') {
          // 白名单内入口 → 302 到白名单外（真实站点的开放重定向形态）
          res.writeHead(302, { Location: 'http://evil.example.com/landing' });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><a id="go" href="/bounce">go</a></body></html>');
      });
      await new Promise<void>((r) => evilServer.listen(0, '127.0.0.1', () => r()));
      const evilPort = (evilServer.address() as { port: number }).port;
      const ws2 = makeWorkspace();
      const s2 = new AgentBrowserSession(ws2, ['sub.localhost']);
      const started2 = await s2.start();
      if (!started2.ok) {
        console.log(`  (跳过：浏览器二进制未安装——${(started2.error ?? '').slice(0, 80)})`);
      } else {
        const nav = await s2.run({ action: 'navigate', url: `http://sub.localhost:${evilPort}/` });
        check('P2-3 前置：入口页导航放行', nav.ok === true, nav.refusal ?? nav.detail ?? '');
        const click = await s2.run({ action: 'click', selector: '#go' });
        check(
          'P2-3：click 触发的 302 落到白名单外 → 动作失败且 sessionClosed',
          click.ok === false && click.sessionClosed === true && (click.refusal ?? '').includes('白名单外'),
          JSON.stringify({ ok: click.ok, closed: click.sessionClosed, refusal: click.refusal?.slice(0, 80) }),
        );
        const next = await s2.run({ action: 'extract_text' });
        check('P2-3：终止后的会话拒绝后续动作', next.ok === false && (next.refusal ?? '').includes('终止'));
      }
      await s2.close();
      evilServer.close();
      fs.rmSync(ws2, { recursive: true, force: true });
    }
  }

  assert.ok(true);
  console.log(failures ? `\n=== ${failures} 项失败 ===\n` : '\n=== browser selftest 全部通过 ===\n');
  process.exit(failures ? 1 : 0);
}

void main();
