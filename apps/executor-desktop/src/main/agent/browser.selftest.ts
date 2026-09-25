/**
 * P7b self-check：浏览器工具的封闭动作枚举与域名白名单。
 * Run via: npm run test:main
 *
 * 两层：
 *   · **闸门逻辑**（全平台可测）：动作枚举、白名单为空 = 全禁、协议白名单、
 *     子域语义、未启动会话拒绝执行；
 *   · **真实浏览器**（条件执行）：playwright 浏览器二进制已安装时跑一轮
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
  isNavigationAllowed,
  probePlaywright,
} from './browser';

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

  console.log('-- 5. 真实浏览器（条件执行）--');
  {
    const pw = probePlaywright();
    if (!pw.available) {
      console.log('  (跳过：playwright-core 不可用——本机无浏览器自动化能力，如实跳过而非假绿)');
    } else {
      // 本地服务器当"目标站点"，白名单放行 localhost
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h1 id="t">报表系统首页</h1><button id="b">导出</button></body></html>');
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as { port: number }).port;
      const ws = makeWorkspace();
      const s = new AgentBrowserSession(ws, ['localhost']);
      const started = await s.start();
      if (!started.ok) {
        console.log(`  (跳过：浏览器二进制未安装——${(started.error ?? '').slice(0, 80)}。运行 npx playwright install chromium 后本节可跑)`);
      } else {
        const nav = await s.run({ action: 'navigate', url: `http://localhost:${port}/` });
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
    }
  }

  assert.ok(true);
  console.log(failures ? `\n=== ${failures} 项失败 ===\n` : '\n=== browser selftest 全部通过 ===\n');
  process.exit(failures ? 1 : 0);
}

void main();
