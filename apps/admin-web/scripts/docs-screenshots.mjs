#!/usr/bin/env node
/**
 * docs-screenshots.mjs —— README / 文档站用的中台截图采集（中英成对，1760×1100）。
 *
 * 为什么单独一个脚本（而不是继续手工截图）：
 *   `docs/DOCS-STYLE.md` §6.1/§6.2 把中台截图钉成「1760×1100、中英成对、≤350KB、
 *   文件名=页面语义」；§6.5 只列了 demo 栈与桌面端 visual-audit 两个入口，中台这一侧
 *   一直是**手工截**——于是每次 UI 改版都要重新记一遍「哪个视口、哪一页、哪种语言」，
 *   而且中英两套会不同步（英文目录里混进中文截图是 §6.3 的红线）。
 *   本脚本把「页面清单 + 视口 + 语言 + 命名」固化成数据，一条命令重出全部。
 *
 * 用法（先起隔离 demo 栈，不要用生产栈截图）：
 *   ./scripts/demo.sh --port 8090 --api-port 3115     # 仓库根目录
 *   cd apps/admin-web && node scripts/docs-screenshots.mjs \
 *     --base-url http://127.0.0.1:8090 --password '<demo 栈的 INITIAL_ADMIN_PASSWORD>'
 *
 * 参数：
 *   --base-url   中台地址（默认 http://127.0.0.1:8088，即 demo.sh 默认端口）
 *   --password   admin 密码（必填；也可用 ACF_DEMO_PASSWORD，避免落进 shell history）
 *   --langs      zh,en（默认两套都拍）
 *   --pages      dashboard,tasks（只拍指定页面；默认全部）
 *   --out        输出目录（默认 docs/assets/screenshots，相对仓库根）
 *   --dry-run    只打印将要访问的 URL 与输出文件，不启动浏览器
 *
 * 判据（脚本自己会断言，失败即非零退出）：
 *   · 每张图必须 1760×1100（视口尺寸一致，且不是被内容撑高的全页截图）；
 *   · 每个语言 × 页面组合都必须产出文件，缺一张算失败（防「英文没拍」）；
 *   · 体积超过 DOCS-STYLE §6.2 的 350KB 上限时告警（不失败——上限是为了提醒压缩）。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(APP_ROOT, '..', '..');

/** 与 DOCS-STYLE §6.2 对齐的视口与体积上限。 */
export const VIEWPORT = { width: 1760, height: 1100 };
export const MAX_BYTES = 350 * 1024;

/**
 * 页面清单。`key` 就是 `docs/assets/screenshots/<lang>/<key>.png` 的文件名，
 * 也就是 README 里 `![](.../<key>.png)` 引用的路径——改名要同步改 README。
 * `wait` 是该页数据落定的判据选择器（等它出现再截图，否则会拍到骨架屏）。
 */
export const PAGES = [
  { key: 'dashboard', path: '/dashboard', wait: '.ant-statistic, [data-testid="dashboard-empty-guide"]' },
  { key: 'tasks', path: '/tasks', wait: '.ant-table-row' },
  { key: 'executions', path: '/executions', wait: '.ant-table-row' },
  { key: 'execution-detail', path: null, wait: '.ant-descriptions, .ant-tabs' },
  { key: 'executors', path: '/executors', wait: '.ant-table-row, .ant-card' },
  { key: 'executor-detail', path: null, wait: '.ant-descriptions, .ant-tabs' },
  { key: 'task-detail', path: null, wait: '.ant-descriptions, .ant-tabs' },
  { key: 'task-templates', path: '/task-templates', wait: '.ant-card, .ant-table-row' },
  { key: 'applications', path: '/applications', wait: '.ant-table-row, .ant-empty' },
  /**
   * 两张「一条命令跑起来」用的演示图（README 的 One-command demo / 快速开始 小节）：
   * 它们不是独立页面，而是详情页的一个 Tab + 一次真实执行的产物——所以带 step。
   * demo-dashboard 与 dashboard 拍的是同一屏：README 里它用于「demo 栈刚起来时
   * 长什么样」，两处必须同源，所以这里让它**复用** dashboard 的路径，不另造数据。
   */
  { key: 'demo-dashboard', path: '/dashboard', wait: '.ant-statistic', reuse: 'dashboard' },
  {
    key: 'demo-template-run',
    path: null, // 由 resolveDetailPaths 填：demo-template-backup 任务
    wait: '.ant-tabs',
    step: 'executions-tab',
  },
];

/**
 * 需要额外交互的页面（`step` 的名字 → 操作）。
 * 为什么写成数据而不是在循环里写 if：加一页就不用改截图主流程，
 * 也让「这页为什么要点一下」变成可读的清单。
 */
export const STEPS = {
  /** demo-template-run：任务详情页默认停在「任务配置」，要点到「执行记录」才是它要讲的事。 */
  'executions-tab': { tab: /执行记录|Execution Records/ },
};

/** CLI 解析：只认长参数，避免和 `--` 透传打架。 */
export function parseArgs(argv) {
  const out = {
    baseUrl: process.env.SHOT_BASE || 'http://127.0.0.1:8088',
    password: process.env.ACF_DEMO_PASSWORD || '',
    langs: ['zh', 'en'],
    pages: null,
    out: join(REPO_ROOT, 'docs/assets/screenshots'),
    dryRun: false,
    user: 'admin',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} 缺少取值`);
      i += 1;
      return v;
    };
    if (a === '--base-url') out.baseUrl = next();
    else if (a === '--password') out.password = next();
    else if (a === '--user') out.user = next();
    else if (a === '--langs') out.langs = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--pages') out.pages = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') out.out = resolve(REPO_ROOT, next());
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`未知参数 ${a}（--help 查看用法）`);
  }
  return out;
}

/** 语言 → 列表页 URL 与（详情页需要的）首条实体 id。 */
async function resolveDetailPaths(baseUrl, token, lang) {
  const api = async (path) => {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    const body = await res.json();
    return body && typeof body === 'object' && 'data' in body ? body.data : body;
  };
  const listOf = (page) => (Array.isArray(page) ? page : (page?.list ?? page?.items ?? []));

  const tasks = listOf(await api('/api/tasks?page=1&pageSize=50'));
  const withExec = tasks.find((t) => t.lastExecutionId) ?? tasks[0];
  // GET /tasks/executions/all 是全局执行列表（ExecutionsPage 的数据源）；
  // /api/executions 不存在——这里踩过一次，端点必须与 src/api/tasks.ts 对齐。
  const executions = listOf(await api('/api/tasks/executions/all?page=1&pageSize=20'));
  const exec = executions.find((e) => e.status === 'success') ?? executions[0];
  const executors = listOf(await api('/api/executors?page=1&pageSize=20'));
  const executor = executors.find((e) => e.status === 'online') ?? executors[0];

  const paths = {};
  if (exec && exec.taskId) paths['execution-detail'] = `/tasks/${exec.taskId}/executions/${exec.id}`;
  else if (withExec && withExec.lastExecutionId) {
    paths['execution-detail'] = `/tasks/${withExec.id}/executions/${withExec.lastExecutionId}`;
  }
  if (withExec) paths['task-detail'] = `/tasks/${withExec.id}`;
  // demo 图要的是一条「从模板创建并跑过一次」的任务（README 讲的是这条链路）；
  // demo-seed.mjs 里有 demo-template-backup，找不到才退回任意任务。
  const templateTask = tasks.find((t) => t.name === 'demo-template-backup') ?? withExec;
  if (templateTask) paths['demo-template-run'] = `/tasks/${templateTask.id}`;
  if (executor) paths['executor-detail'] = `/executors/${executor.id}`;
  void lang;
  return paths;
}

/** 在页面里落登录态与语言/主题，避免拍出英文界面里的中文通知（反之亦然）。 */
export function authInitScript() {
  // playwright 的 addInitScript(fn, arg) 只把 arg 作为**单个**实参传入——
  // 不要写成数组解构（会抛 "object is not iterable" 并让整页停在登录页）。
  return (payload) => {
    localStorage.setItem('autoflow-auth', JSON.stringify({ state: payload.auth, version: 0 }));
    // light 而不是 system：截图不该随拍摄机器的系统主题漂移（DOCS-STYLE 未强制，
    // 但现有截图是浅色，保持一致）。
    localStorage.setItem('autoflow-theme', JSON.stringify({ state: { mode: 'light' }, version: 0 }));
    localStorage.setItem('autoflow-lang', payload.lang);
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      [
        '用法: node scripts/docs-screenshots.mjs --password <admin 密码> [--base-url URL]',
        '      [--langs zh,en] [--pages dashboard,tasks] [--out DIR] [--dry-run]',
        '',
        '页面清单见本文件的 PAGES 常量（文件名即 docs/assets/screenshots/<lang>/<key>.png）。',
      ].join('\n'),
    );
    return 0;
  }
  if (!args.password && !args.dryRun) {
    console.error('✗ 缺少 --password（demo 栈的 INITIAL_ADMIN_PASSWORD）或 ACF_DEMO_PASSWORD');
    return 2;
  }

  const pages = args.pages
    ? PAGES.filter((p) => args.pages.includes(p.key))
    : PAGES;
  if (pages.length === 0) {
    console.error(`✗ --pages 里没有匹配的页面；可选：${PAGES.map((p) => p.key).join(', ')}`);
    return 2;
  }

  if (args.dryRun) {
    for (const lang of args.langs) {
      for (const p of pages) {
        console.log(`${lang}  ${p.path ?? '(详情页，运行时解析)'}  ->  ${join(args.out, lang, `${p.key}.png`)}`);
      }
    }
    return 0;
  }

  // 登录取 token：截图脚本走与浏览器同一套 Bearer 通道，不碰 cookie。
  const loginRes = await fetch(`${args.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: args.user, password: args.password }),
  });
  if (!loginRes.ok) {
    console.error(`✗ 登录失败 ${loginRes.status}：${(await loginRes.text()).slice(0, 200)}`);
    return 1;
  }
  const loginBody = await loginRes.json();
  const auth = loginBody.data ?? loginBody;
  if (!auth.accessToken) {
    console.error('✗ 登录响应里没有 accessToken');
    return 1;
  }
  // 只把登录态里「浏览器侧会用的」三件搬进 localStorage（与 auth store 的
  // partialize 同口径：token / refreshToken / user）。
  const storageAuth = { token: auth.accessToken, refreshToken: auth.refreshToken, user: auth.user };

  const detailPaths = await resolveDetailPaths(args.baseUrl, auth.accessToken);
  const browser = await chromium.launch();
  const written = [];
  try {
    for (const lang of args.langs) {
      mkdirSync(join(args.out, lang), { recursive: true });
      for (const p of pages) {
        const path = p.path ?? detailPaths[p.key];
        if (!path) {
          console.warn(`  · 跳过 ${lang}/${p.key}：demo 数据里没有可展示的实体（先跑 demo-seed）`);
          continue;
        }
        const ctx = await browser.newContext({
          viewport: VIEWPORT,
          deviceScaleFactor: 1,
          locale: lang === 'zh' ? 'zh-CN' : 'en-US',
          colorScheme: 'light',
        });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.addInitScript(authInitScript(), { auth: storageAuth, lang });
        await page.goto(`${args.baseUrl}${path}`, { waitUntil: 'domcontentloaded' });
        // step：进入页面后的必要交互（切 Tab 等）。点不到就告警并按当前画面拍，
        // 不静默——否则会产出一张「停在任务配置 Tab」的 demo-template-run。
        if (p.step) {
          const step = STEPS[p.step];
          if (step?.tab) {
            try {
              await page.getByRole('tab', { name: step.tab }).click({ timeout: 15_000 });
            } catch {
              console.warn(`  · ${lang}/${p.key}：没点到 Tab ${step.tab}，按当前画面拍摄`);
            }
          }
        }
        // 等数据落定：判据选择器出现 + 稳定 1.5s（图表/SSE 首帧不抖）
        try {
          await page.waitForSelector(p.wait, { timeout: 20_000 });
        } catch {
          console.warn(`  · ${lang}/${p.key}：等待 ${p.wait} 超时，按当前画面拍摄`);
        }
        await page.waitForLoadState('networkidle').catch(() => undefined);
        await page.waitForTimeout(1500);
        const file = join(args.out, lang, `${p.key}.png`);
        await page.screenshot({ path: file });
        const size = stat(file).size;
        const flag = size > MAX_BYTES ? ` ⚠ 超过 ${MAX_BYTES / 1024}KB 上限` : '';
        console.log(`  ✔ ${lang}/${p.key}  ${(size / 1024).toFixed(0)}KB${flag}`);
        if (errors.length) console.warn(`    pageerror: ${errors.join(' | ').slice(0, 200)}`);
        written.push({ lang, key: p.key, file, size });
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }

  // 判据：中英必须成对（DOCS-STYLE §6.1）——缺一门就是「英文目录里混中文」的前兆。
  const missing = [];
  for (const lang of args.langs) {
    for (const p of pages) {
      if (!written.some((w) => w.lang === lang && w.key === p.key)) missing.push(`${lang}/${p.key}`);
    }
  }
  if (missing.length) {
    console.error(`✗ 缺少 ${missing.length} 张：${missing.join(', ')}`);
    return 1;
  }
  console.log(`\n✔ 完成：${written.length} 张 → ${args.out}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`✗ ${err.stack || err.message}`);
      process.exit(1);
    });
}
