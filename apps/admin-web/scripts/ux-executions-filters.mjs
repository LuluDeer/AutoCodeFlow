/**
 * P2-2 执行列表筛选补齐 · 证据采集探针。
 *
 * 复用 `ux-walkthrough.mjs` 的浏览器侧夹具（apiHandler / USER / EXECUTIONS /
 * filterExecutions），在 vite dev（默认 5176）上：
 *   1. 逐维度 + 两两组合计算命中行数与信封 total（夹具同源过滤真值）；
 *   2. 浏览器深链回读若干代表组合，核对页面渲染行数 / 「共 N 条」total 与夹具一致；
 *   3. 截 1280 桌面、375 窄屏、1280 组合筛选三张图，落 docs 证据目录 + combos.json。
 *
 * 用法（先起 dev server）：
 *   npm run dev            # 5176
 *   node scripts/ux-executions-filters.mjs
 *
 * 环境变量：WALKTHROUGH_BASE_URL（默认 http://localhost:5176）、
 *   EXEC_FILTERS_OUT（默认仓库根 docs/archive/.../executions-filters）。
 *
 * 注意：本脚本只在被直接执行时启动浏览器；被 import 不触发任何副作用。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  apiHandler,
  USER,
  TASKS,
  EXECUTIONS,
  filterExecutions,
} from './ux-walkthrough.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN_WEB_ROOT = join(__dirname, '..');
const REPO_ROOT = resolve(ADMIN_WEB_ROOT, '..', '..');
const BASE_URL = process.env.WALKTHROUGH_BASE_URL || 'http://localhost:5176';
const OUT_DIR =
  process.env.EXEC_FILTERS_OUT ||
  join(REPO_ROOT, 'docs', 'archive', 'audits', 'assets',
    'product-ui-remediation-2026-11-15', 'executions-filters');

const MIN = 60_000;
const now = Date.now();
const iso = (offsetMs) => new Date(now + offsetMs).toISOString();

const TASK_BY_ID = Object.fromEntries(TASKS.map((t) => [t.id, t]));

// ── 维度取值（与页面下拉 / 后端 DTO 同口径）─────────────────────────────────
const STATUS_VALUES = ['failed', 'success', 'running', 'timeout', 'killed'];
const RUNTIME_VALUES = ['python', 'node', 'shell'];
const TRIGGER_VALUES = ['cron', 'fixed_rate', 'manual', 'webhook'];
const PROJECT_VALUES = ['p-1000', 'p-1001', 'p-1002', 'default'];
const TASK_VALUES = ['t-1001', 't-1005'];
const TIME_RANGES = [
  { key: 'last1h', params: { startTime: iso(-3600e3), endTime: iso(0) } },
  { key: 'last6h', params: { startTime: iso(-6 * 3600e3), endTime: iso(0) } },
  { key: 'last24h', params: { startTime: iso(-24 * 3600e3), endTime: iso(0) } },
];

const DIM_VALUES = {
  status: STATUS_VALUES,
  runtime: RUNTIME_VALUES,
  triggerType: TRIGGER_VALUES,
  projectId: PROJECT_VALUES,
  taskId: TASK_VALUES,
};

/** 把过滤条件对象转成 URL 查询串（undefined / 空值不下发）。 */
function toQuery(filters) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  return sp.toString();
}

/** 夹具同源过滤：返回命中行（保序）。 */
function expectedRows(filters) {
  const q = new URLSearchParams(toQuery(filters));
  return filterExecutions(q);
}

/** 组合清单：单维过滤 + 两两组合。 */
function buildCases() {
  const cases = [];
  const push = (dimension, filters, label) => {
    const rows = expectedRows(filters);
    cases.push({
      dimension,
      label,
      filters,
      query: toQuery(filters),
      expected: { count: rows.length, total: rows.length, ids: rows.map((r) => r.id) },
    });
  };

  // 单维
  for (const [dim, values] of Object.entries(DIM_VALUES)) {
    for (const v of values) {
      push('single', { [dim]: v }, `${dim}=${v}`);
    }
  }
  for (const range of TIME_RANGES) {
    push('single', range.params, `timeRange=${range.key}`);
  }

  // 两两组合
  const pairs = [
    ['status', 'runtime'], ['status', 'triggerType'], ['status', 'projectId'],
    ['status', 'taskId'], ['status', 'timeRange'],
    ['runtime', 'triggerType'], ['runtime', 'projectId'], ['runtime', 'taskId'],
    ['runtime', 'timeRange'],
    ['triggerType', 'projectId'], ['triggerType', 'taskId'], ['triggerType', 'timeRange'],
    ['projectId', 'taskId'], ['projectId', 'timeRange'], ['taskId', 'timeRange'],
  ];
  const valueOf = (dim, val) => (dim === 'timeRange' ? val.params : { [dim]: val });

  for (const [a, b] of pairs) {
    const va = a === 'timeRange' ? TIME_RANGES : DIM_VALUES[a];
    const vb = b === 'timeRange' ? TIME_RANGES : DIM_VALUES[b];
    for (const x of va) {
      for (const y of vb) {
        const filters = { ...valueOf(a, x), ...valueOf(b, y) };
        const label = `${a}=${a === 'timeRange' ? x.key : x} × ${b}=${b === 'timeRange' ? y.key : y}`;
        push('pair', filters, label);
      }
    }
  }
  return cases;
}

// ── 浏览器回读 ──────────────────────────────────────────────────────────────

/** 代表组合：浏览器深链回读，核对渲染行数与信封 total。 */
const READBACK = [
  { label: 'unfiltered', filters: {} },
  { label: 'runtime=python', filters: { runtime: 'python' } },
  { label: 'triggerType=cron', filters: { triggerType: 'cron' } },
  { label: 'runtime=python&triggerType=cron', filters: { runtime: 'python', triggerType: 'cron' } },
  { label: 'status=success', filters: { status: 'success' } },
  // 项目上下文走 MainLayout 全局 `?project=` 键（useProjectFilter），非 UUID 合成 id
  // 会被 normalize 回落 all；夹具 p-10xx 不是 UUID，浏览器侧无法驱动项目作用域。
  // projectId 过滤真值由后端 spec + 夹具 filterExecutions 覆盖（见 combos.json cases）。
  {
    label: 'projectId=p-1002',
    filters: { projectId: 'p-1002' },
    skipped: true,
    skipReason: '项目上下文经 ?project= 归一化（非 UUID 回落 all）；夹具 p-10xx 为合成 id，浏览器侧不可驱动，仅记录夹具真值。',
  },
  { label: 'timeRange=last1h', filters: TIME_RANGES[0].params },
  { label: 'status=success&timeRange=last1h', filters: { status: 'success', ...TIME_RANGES[0].params } },
];

const TOTAL_RE = /共\s*(\d+)\s*条/;

async function openPage(browser, filters, viewport) {
  const context = await browser.newContext({ viewport: { width: viewport.w, height: viewport.h } });
  await context.addInitScript(([auth]) => {
    localStorage.setItem('autoflow-auth', auth);
    localStorage.setItem('autoflow-lang', 'zh');
  }, [JSON.stringify({ state: { token: 'mock-access-token', refreshToken: 'mock-refresh-token', user: USER }, version: 0 })]);
  await context.route('**/api/**', apiHandler);

  const page = await context.newPage();
  const query = toQuery(filters);
  await page.goto(`${BASE_URL}/executions${query ? `?${query}` : ''}`, { waitUntil: 'load', timeout: 45000 });

  // 等表格行出现，或空态 / 越界文案落定（避免读到骨架屏）。
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll('.ant-table-tbody tr[data-row-key]');
    const empty = document.querySelector('.ant-empty-description');
    const total = document.querySelector('.ant-pagination-total-text');
    return rows.length > 0 || (empty && empty.textContent) || (total && /共\s*\d+\s*条/.test(total.textContent));
  }, { timeout: 15000 }).catch(() => {});

  return { context, page };
}

async function readback(page) {
  const rows = await page.$$eval('.ant-table-tbody tr[data-row-key]', (els) => els.map((e) => e.getAttribute('data-row-key')));
  const totalText = await page.$eval('.ant-pagination-total-text', (el) => el?.textContent ?? '').catch(() => '');
  const m = TOTAL_RE.exec(totalText);
  return { renderedRows: rows, renderedTotal: m ? Number(m[1]) : null, totalText };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const cases = buildCases();

  let exe = join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
  let browser;
  try {
    browser = await chromium.launch({ executablePath: exe });
  } catch (err) {
    console.error(`[exec-filters] explicit launch failed, fallback default registry: ${err.message}`);
    browser = await chromium.launch();
  }

  const readbackResults = [];
  const screenshots = [];

  // 浏览器回读代表组合（1280 桌面）
  for (const item of READBACK) {
    const expected = expectedRows(item.filters);
    if (item.skipped) {
      readbackResults.push({
        label: item.label,
        query: toQuery(item.filters),
        expectedCount: expected.length,
        expectedTotal: expected.length,
        skipped: true,
        skipReason: item.skipReason,
        match: null,
      });
      continue;
    }
    const { context, page } = await openPage(browser, item.filters, { w: 1280, h: 800 });
    const rendered = await readback(page);
    readbackResults.push({
      label: item.label,
      query: toQuery(item.filters),
      expectedCount: expected.length,
      expectedTotal: expected.length,
      ...rendered,
      match: rendered.renderedTotal === expected.length && rendered.renderedRows.length === expected.length,
    });
    await context.close();
  }

  // 三张证据截图
  // 1) 1280 桌面 · 未筛选
  {
    const { context, page } = await openPage(browser, {}, { w: 1280, h: 800 });
    const file = 'executions-filters-1280.png';
    await page.screenshot({ path: join(OUT_DIR, file), fullPage: false });
    screenshots.push({ file, viewport: 1280, query: '', purpose: '桌面端未筛选全量列表，四个筛选控件可见' });
    await context.close();
  }
  // 2) 375 窄屏 · 未筛选
  {
    const { context, page } = await openPage(browser, {}, { w: 375, h: 812 });
    const file = 'executions-filters-375.png';
    await page.screenshot({ path: join(OUT_DIR, file), fullPage: false });
    screenshots.push({ file, viewport: 375, query: '', purpose: '窄屏卡片列表 + 筛选区堆叠' });
    await context.close();
  }
  // 3) 1280 桌面 · 组合筛选深链
  {
    const filters = { runtime: 'python', triggerType: 'cron' };
    const { context, page } = await openPage(browser, filters, { w: 1280, h: 800 });
    const file = 'executions-filters-combo-1280.png';
    await page.screenshot({ path: join(OUT_DIR, file), fullPage: false });
    screenshots.push({ file, viewport: 1280, query: toQuery(filters), purpose: 'runtime=python 且 triggerType=cron 组合筛选（深链可复现）' });
    await context.close();
  }

  await browser.close();

  const fixturePool = EXECUTIONS.map((r) => {
    const task = TASK_BY_ID[r.taskId];
    return { id: r.id, taskId: r.taskId, runtime: task?.runtime ?? null, projectId: task?.projectId ?? null, status: r.status, triggerType: r.triggerType, createdAt: r.createdAt };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    fixture: { poolSize: fixturePool.length, rows: fixturePool },
    dimensions: {
      status: STATUS_VALUES, runtime: RUNTIME_VALUES, triggerType: TRIGGER_VALUES,
      projectId: PROJECT_VALUES, taskId: TASK_VALUES,
      timeRange: TIME_RANGES.map((t) => ({ key: t.key, ...t.params })),
    },
    cases,
    browserReadback: readbackResults,
    screenshots,
  };

  writeFileSync(join(OUT_DIR, 'combos.json'), JSON.stringify(report, null, 2), 'utf8');

  const mismatches = readbackResults.filter((r) => r.match === false);
  process.stdout.write(`[exec-filters] cases=${cases.length} readback=${readbackResults.length} mismatch=${mismatches.length}\n`);
  for (const r of readbackResults) {
    if (r.skipped) {
      process.stdout.write(`  skip ${r.label}: expected=${r.expectedTotal} (浏览器侧不驱动项目上下文)\n`);
      continue;
    }
    process.stdout.write(`  ${r.match ? 'ok  ' : 'FAIL'} ${r.label}: expected=${r.expectedTotal} renderedTotal=${r.renderedTotal} rows=${r.renderedRows.length}\n`);
  }
  process.stdout.write(`[exec-filters] combos.json + screenshots → ${OUT_DIR}\n`);
  if (mismatches.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[exec-filters] fatal:', err);
  process.exit(1);
});
