// visual-1280.mjs — P2-③ 1280 全站视觉回归测量（1280×800 / 1280×720 两档）
//
// 背景:ux-walkthrough.mjs 在 1280 视口只做「冒烟 + 列表容器横滚手量」,
// 没有对 1280 下的裁切 / 控件重叠 / 文字截断 / 字号档位 / 间距做可量化测量。
// 本脚本复用其 Playwright route 夹具(apiHandler / USER),在两个常见笔记本
// 高度(800 / 720)下对全站页面做几何与排版基线测量,输出机读 JSON 与视口截图。
//
// 判据全部可量化(px / 字号档位),候选偏差先落 JSON,人工复核后再决定修不修:
//   A clipped   内容被裁切:可见元素 bottom > 视口高,且 doc / Content / 祖先链
//               均无可纵向滚动容器(不可滚 = 真裁切,非合规纵向滚动)。
//   B overlap   控件重叠:两个可交互元素 rect 相交面积 > 4px²,且互不包含。
//   C truncate  文字截断:scrollWidth > clientWidth + 1,且容器为固定宽度 +
//               overflow hidden/ellipsis/nowrap。
//   D fontMismatch 同一层级标签(h1/h2/h3/h4/卡片标题)出现 ≥2 种 font-size。
//   E spacing   相邻内容块间距为 0,或相邻间距比值 > 2(离群,人工复核)。
//
// 复用:./ux-walkthrough.mjs 导出 apiHandler / USER(无后端,route 夹具供数)。
// 运行:先 `npm run dev`(5176),再 `node scripts/visual-1280.mjs [--shot-dir before|after]`
// 产物:默认写到 docs/.../visual-1280/ 下;截图 PNG 被根 .gitignore 的 *.png 规则忽略,
//       不入库;JSON / report.md 入库。

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiHandler, USER } from './ux-walkthrough.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(__dirname, '..');
const REPO_ROOT = resolve(WEB_ROOT, '..', '..');
const BASE_URL = process.env.WALKTHROUGH_BASE_URL || 'http://localhost:5176';
const EVIDENCE_DIR = join(
  REPO_ROOT,
  'docs', 'archive', 'audits', 'assets', 'product-ui-remediation-2026-11-15', 'visual-1280',
);

// close() 在页面挂着 SSE / 长轮询时可能不返回;包一层超时兜底,避免整轮被单个 context 卡死。
const withCloseTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout`)), ms))]).catch(() => {});

// 任务要求覆盖的页面(key 对齐 ux-walkthrough PAGES,path 取自 router.tsx)。
const PAGES = [
  { key: 'login', path: '/login', auth: false },
  { key: 'dashboard', path: '/dashboard' },
  { key: 'tasks', path: '/tasks' },
  { key: 'task-detail', path: '/tasks/t-1001' },
  { key: 'task-templates', path: '/task-templates' },
  { key: 'executions', path: '/executions' },
  { key: 'applications', path: '/applications' },
  { key: 'app-detail', path: '/applications/app-2001' },
  { key: 'executors', path: '/executors' },
  { key: 'executor-detail', path: '/executors/ex-3001' },
  { key: 'executor-packages', path: '/executor-packages' },
  { key: 'projects', path: '/projects' },
  { key: 'project-detail', path: '/projects/p-1001' },
  { key: 'artifacts', path: '/artifacts' },
  { key: 'inbox', path: '/inbox' },
  { key: 'sops', path: '/sops' },
  { key: 'agent-sessions', path: '/agent-sessions' },
  { key: 'audit', path: '/audit' },
  { key: 'settings', path: '/settings' },
  { key: 'registry', path: '/registry' },
];

const VIEWPORTS_DEFAULT = [
  { w: 1280, h: 800, label: '1280x800' },
  { w: 1280, h: 720, label: '1280x720' },
];

// ── CLI 参数 ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argVal = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const SHOT_DIR = argVal('shot-dir', 'before');          // before | after
const DARK = argv.includes('--dark');
const ONLY_PAGES = argVal('pages', '').split(',').filter(Boolean);
const outJson = argVal('out-json', join(EVIDENCE_DIR, 'visual-report.json'));
// 可选 --width/--height 覆盖为单视口（用于 375 移动端抽查等），标签取 WxH。
const ovW = Number(argVal('width', ''));
const ovH = Number(argVal('height', ''));
const VIEWPORTS = Number.isFinite(ovW) && Number.isFinite(ovH) && ovW > 0 && ovH > 0
  ? [{ w: ovW, h: ovH, label: `${ovW}x${ovH}` }]
  : VIEWPORTS_DEFAULT;

const shotRoot = join(EVIDENCE_DIR, SHOT_DIR);
mkdirSync(shotRoot, { recursive: true });
mkdirSync(dirname(outJson), { recursive: true });

// ── 页面内测量(全部在浏览器上下文执行)─────────────────────────────────────
function measureInPage() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const doc = document.documentElement;

  const docSw = Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0);
  const docSh = Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0);
  const body = document.body;
  const bodySw = body ? body.scrollWidth : 0;
  const bodySh = body ? body.scrollHeight : 0;

  const headerEl = document.querySelector('header');
  const header = headerEl
    ? (() => { const r = headerEl.getBoundingClientRect(); return { top: Math.round(r.top), height: Math.round(r.height), bottom: Math.round(r.bottom) }; })()
    : null;

  const content = document.getElementById('main-content');
  let contentGeom = null;
  let firstBlock = null;
  if (content) {
    const cr = content.getBoundingClientRect();
    contentGeom = {
      top: Math.round(cr.top),
      bottom: Math.round(cr.bottom),
      clientWidth: content.clientWidth,
      clientHeight: content.clientHeight,
      scrollWidth: content.scrollWidth,
      scrollHeight: content.scrollHeight,
      scrollableY: content.scrollHeight > content.clientHeight + 1,
      scrollableX: content.scrollWidth > content.clientWidth + 1,
    };
    // 首个可见内容块(卡片 / 列表 / 工具栏),跳过空容器与装饰分隔线
    const kids = [...content.children].flatMap((el) =>
      el.matches('.ant-row, .ant-space, div') ? [el, ...el.children] : [el],
    );
    for (const el of content.querySelectorAll('.ant-card, .ant-list, table, [data-testid="page-header"]')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        firstBlock = {
          sel: `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`,
          top: Math.round(r.top), bottom: Math.round(r.bottom),
          height: Math.round(r.height),
        };
        break;
      }
    }
  }

  // 表格首屏可见行数
  let tableRows = null;
  const tables = [...document.querySelectorAll('.ant-table-tbody')];
  if (tables.length) {
    const rows = [...tables[0].querySelectorAll('tr')];
    const visible = rows.filter((tr) => {
      const r = tr.getBoundingClientRect();
      return r.height > 0 && r.top >= -1 && r.top < vh;
    });
    const first = visible[0]?.getBoundingClientRect();
    tableRows = {
      total: rows.length,
      visibleInViewport: visible.length,
      firstRowTop: first ? Math.round(first.top) : null,
      firstRowBottom: first ? Math.round(first.bottom) : null,
    };
  }

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
    return true;
  };
  const clsOf = (el) => (typeof el.className === 'string' && el.className
    ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : el.tagName.toLowerCase());

  // 祖先链是否存在可滚动容器(纵向 / 横向分别)
  const ancestorScroll = (el, axis) => {
    let p = el.parentElement;
    for (let i = 0; p && i < 25; i++) {
      const cs = getComputedStyle(p);
      const overflowY = cs.overflowY;
      const overflowX = cs.overflowX;
      const scrollable = axis === 'y'
        ? (overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight + 1
        : (overflowX === 'auto' || overflowX === 'scroll') && p.scrollWidth > p.clientWidth + 1;
      if (scrollable) return { sel: clsOf(p), axis };
      p = p.parentElement;
    }
    return null;
  };

  // ── A. 纵向裁切:bottom 越界且无处可滚 ──
  // 排除:SVG 装饰子树(背景出血图案)、浏览器扩展注入的 fixed 节点、纯装饰无文本无交互容器。
  const SVG_TAGS = new Set(['svg', 'g', 'ellipse', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'defs', 'text', 'tspan', 'use', 'stop', 'lineargradient', 'radialgradient', 'clippath', 'mask']);
  const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea']);
  const hasDirectText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const clipped = [];
  const docScrollableY = docSh > vh + 1;
  const contentScrollableY = content ? content.scrollHeight > content.clientHeight + 1 : false;
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    if (SVG_TAGS.has(el.tagName.toLowerCase())) continue;
    if (el.closest('svg')) continue;
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed') continue; // 固定弹层/扩展注入单独在 fixedOverlays 观察
    const r = el.getBoundingClientRect();
    if (r.bottom > vh + 1 && r.right <= vw + 1) {
      const anc = ancestorScroll(el, 'y');
      if (!anc && !docScrollableY && !contentScrollableY) {
        const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
        const isInteractive = INTERACTIVE_TAGS.has(el.tagName.toLowerCase()) || el.matches('[role="button"], .ant-select, .ant-btn');
        // 只保留承载内容的节点:有直接文本 / 可交互 / 卡片列表容器;纯空装饰块不报。
        const isContainer = el.matches('.ant-card, .ant-list, .ant-row, section, .ant-form');
        if (!hasDirectText(el) && !isInteractive && !isContainer) continue;
        clipped.push({
          sel: `${el.tagName.toLowerCase()}.${clsOf(el)}`,
          text: text.slice(0, 40),
          bottom: Math.round(r.bottom), overBy: Math.round(r.bottom - vh),
          top: Math.round(r.top), height: Math.round(r.height),
          kind: isInteractive ? 'control' : isContainer ? 'container' : 'text',
        });
      }
    }
  }
  // 去重(父子同超界只留最深层)
  const clipSeen = new Set();
  const clippedUnique = clipped.filter((c) => {
    const k = `${c.sel}|${c.text}|${c.bottom}`;
    if (clipSeen.has(k)) return false;
    clipSeen.add(k);
    return true;
  }).slice(0, 10);

  // ── B. 可交互控件重叠 ──
  // 排除 TanStack Query Devtools 右下角浮标(.tsqd-parent-container 子树,开发期工具,非产品 UI),
  // 以及 antd 自定义框内视觉隐藏的原生 checkbox/radio input。
  const INTERACTIVE = 'button, a[href], input, select, textarea, .ant-select, .ant-btn, [role="button"], .ant-radio-button-wrapper, .ant-checkbox-wrapper, .ant-picker';
  const controls = [...document.querySelectorAll(INTERACTIVE)].filter((el) => {
    if (!visible(el)) return false;
    if (el.closest('.tsqd-parent-container')) return false;
    const cs = getComputedStyle(el);
    if (el.tagName.toLowerCase() === 'input' && (cs.opacity === '0' || cs.position === 'absolute')) return false;
    return true;
  });
  const overlapPairs = [];
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i], b = controls[j];
      if (a.contains(b) || b.contains(a)) continue;
      // 表格选择列相邻行的 checkbox-wrapper:antd 行高下 label 边界纵向轻微相叠,
      // 实际 16px 方框不重叠,属误报;同类 checkbox 之间互不判重叠。
      if (a.classList.contains('ant-checkbox-wrapper') && b.classList.contains('ant-checkbox-wrapper')) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const ix = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left));
      const iy = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
      if (ix > 2 && iy > 2) {
        overlapPairs.push({
          a: `${a.tagName.toLowerCase()}.${clsOf(a)}`, aText: (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24),
          b: `${b.tagName.toLowerCase()}.${clsOf(b)}`, bText: (b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24),
          ix: Math.round(ix), iy: Math.round(iy),
        });
      }
    }
  }

  // ── C. 文字截断:固定宽度容器内 scrollWidth > clientWidth ──
  // antd ellipsis(typography-ellipsis / table-cell-ellipsis,textOverflow=ellipsis)是设计内
  // 省略号 + hover tooltip,合规;单列参考 truncatedEllipsis,不计入偏差。只把无 ellipsis 的
  // 硬截断(overflow hidden 文字被切且无省略号)计入 truncated。
  const truncated = [];
  const truncatedEllipsis = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    const cs = getComputedStyle(el);
    // ox=auto/scroll 的元素本身是可滚动容器,内部内容可横向滚出,合规,不报截断。
    const scrollContainer = ['auto', 'scroll'].includes(cs.overflowX);
    if (scrollContainer) continue;
    const hardClip = ['hidden', 'clip'].includes(cs.overflowX);
    const squeezed = hardClip || cs.textOverflow === 'ellipsis' || el.classList.contains('ant-typography-ellipsis') || el.classList.contains('ant-table-cell-ellipsis');
    if (!squeezed) continue;
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
    if (!text) continue;
    const isEllipsis = cs.textOverflow === 'ellipsis'
      || el.classList.contains('ant-typography-ellipsis')
      || el.classList.contains('ant-table-cell-ellipsis');
    const entry = {
      sel: `${el.tagName.toLowerCase()}.${clsOf(el)}`,
      text: text.slice(0, 48),
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
      whiteSpace: cs.whiteSpace, overflowX: cs.overflowX, textOverflow: cs.textOverflow,
      width: cs.width,
    };
    (isEllipsis ? truncatedEllipsis : truncated).push(entry);
  }
  // 只留最深层(父级也超宽时不重复上报)
  const dedupeDeep = (list) => list.filter((t) => {
    const childDup = list.some((o) => o !== t && o.sel !== t.sel && t.text.includes(o.text) && o.text.length > 0);
    return !childDup;
  });
  const truncUnique = dedupeDeep(truncated).slice(0, 12);
  const ellipsisUnique = dedupeDeep(truncatedEllipsis).slice(0, 12);

  // ── D. 字号档位一致性:同语义层级分组收集 font-size ──
  // 注意:不能用泛 .ant-typography 混组——标题/副标题/标签/辅助文本本就是不同层级。
  const FONT_GROUPS = ['h1', 'h2', 'h3', 'h4', '.ant-card-head-title', '.ant-form-item-label label'];
  const fontMismatch = [];
  for (const sel of FONT_GROUPS) {
    const els = [...document.querySelectorAll(sel)].filter(visible);
    if (els.length < 2) continue;
    const sizes = new Set(els.map((e) => getComputedStyle(e).fontSize));
    if (sizes.size >= 2) {
      const bySize = {};
      for (const e of els) {
        const fs = getComputedStyle(e).fontSize;
        (bySize[fs] ||= []).push((e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24));
      }
      fontMismatch.push({ selector: sel, sizes: [...sizes], samples: bySize });
    }
  }

  // ── E. 间距异常:内容块相邻间距为 0 或 >2 倍中位数 ──
  const spacing = [];
  const blockEls = [...(content ? content.querySelectorAll('.ant-card, .ant-list, .ant-row, section') : [])].filter(visible);
  const gaps = [];
  for (let i = 1; i < blockEls.length; i++) {
    const pa = blockEls[i - 1].getBoundingClientRect();
    const pb = blockEls[i].getBoundingClientRect();
    // 仅记录纵向相邻(左右不算)
    if (Math.abs(pa.left - pb.left) < pa.width * 0.5 && pb.top >= pa.top) {
      gaps.push({ top: Math.round(pb.top), gap: Math.round(pb.top - pa.bottom) });
    }
  }
  const gapVals = gaps.map((g) => g.gap).sort((a, b) => a - b);
  const median = gapVals.length ? gapVals[Math.floor(gapVals.length / 2)] : null;
  for (const g of gaps) {
    if (g.gap === 0) spacing.push({ kind: 'zero-gap', top: g.top, gap: 0, median });
    else if (median && median > 0 && g.gap > median * 2) spacing.push({ kind: 'gap-outlier', top: g.top, gap: g.gap, median });
  }

  // ── 固定/弹层遮挡参考 ──
  const fixed = [...document.querySelectorAll('body *')].filter((el) => {
    if (!visible(el)) return false;
    const cs = getComputedStyle(el);
    return cs.position === 'fixed' && el.getBoundingClientRect().width > 0;
  }).map((el) => {
    const r = el.getBoundingClientRect();
    return { sel: `${el.tagName.toLowerCase()}.${clsOf(el)}`, top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), zIndex: getComputedStyle(el).zIndex };
  }).slice(0, 8);

  return {
    viewport: { width: vw, height: vh },
    doc: { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, scrollHeight: docSh, clientHeight: doc.clientHeight },
    body: { scrollWidth: bodySw, scrollHeight: bodySh },
    bodyHOverflow: docSw > vw + 1 || bodySw > vw + 1,
    bodyVOverflow: docSh > vh + 1,
    header,
    content: contentGeom,
    firstBlock,
    tableRows,
    fixedOverlays: fixed,
    findings: {
      clipped: clippedUnique,
      overlapPairs,
      truncated: truncUnique,
      truncatedEllipsis: ellipsisUnique,
      fontMismatch,
      spacing: spacing.slice(0, 10),
    },
  };
}

async function visitAndMeasure(pageDef, viewport, opts = {}) {
  // 每个视口独立浏览器实例:宿主 MCE 不稳定,共享 browser 的第二个 context 偶发挂起,
  // 单实例隔离后单页崩溃不会拖垮整轮。
  const browser = await launchBrowser();
  const dark = !!opts.dark;
  let context;
  try {
    context = await withCloseTimeout(browser.newContext({ viewport: { width: viewport.w, height: viewport.h } }), 8000, 'newContext');
  } catch (err) {
    await withCloseTimeout(browser.close(), 5000, 'browser.close');
    return { key: pageDef.key, path: pageDef.path, viewport: viewport.label, dark, gotoError: `newContext failed: ${String(err && err.message || err).slice(0, 200)}`, metrics: null, pageErrors: [], consoleErrors: [], shot: '' };
  }
  await context.route('**/api/**', apiHandler);
  if (pageDef.auth !== false) {
    await context.addInitScript(([auth]) => {
      localStorage.setItem('autoflow-auth', auth);
      localStorage.setItem('autoflow-lang', 'zh');
    }, [JSON.stringify({ state: { token: 'mock-access-token', refreshToken: 'mock-refresh-token', user: USER }, version: 0 })]);
  } else {
    await context.addInitScript(() => localStorage.setItem('autoflow-lang', 'zh'));
  }
  if (dark) {
    await context.addInitScript(([theme]) => localStorage.setItem('autoflow-theme', theme),
      [JSON.stringify({ state: { mode: 'dark' }, version: 0 })]);
  }

  const consoleErrors = [];
  const pageErrors = [];
  const page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300)); });
  page.on('pageerror', (err) => pageErrors.push(String(err && err.stack || err).slice(0, 500)));

  let gotoError = null;
  try {
    await page.goto(BASE_URL + pageDef.path, { waitUntil: 'load', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1400);
  } catch (err) {
    gotoError = String(err && err.message || err).slice(0, 300);
  }

  let metrics = null;
  try { metrics = await page.evaluate(measureInPage); } catch (err) { metrics = { evaluateError: String(err && err.message || err).slice(0, 300) }; }

  const shot = join(shotRoot, `${pageDef.key}-${viewport.label}${dark ? '-dark' : ''}.png`);
  try { await page.screenshot({ path: shot, fullPage: false }); } catch (err) { consoleErrors.push(`[screenshot] ${err.message}`); }

  await withCloseTimeout(context.close(), 5000, 'context.close');
  await withCloseTimeout(browser.close(), 5000, 'browser.close');
  return {
    key: pageDef.key, path: pageDef.path, viewport: viewport.label, dark, gotoError,
    metrics, pageErrors, consoleErrors, shot: shot.split(/[\\/]/).pop(),
  };
}

async function launchBrowser() {
  const exe = join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
  try { return await chromium.launch({ executablePath: exe }); }
  catch (err) { console.error(`[visual-1280] explicit launch failed: ${err.message}, fallback default`); return chromium.launch(); }
}

async function main() {
  const pages = ONLY_PAGES.length ? PAGES.filter((p) => ONLY_PAGES.includes(p.key)) : PAGES;
  const MERGE = argv.includes('--merge');

  // 既有结果(merge 模式下按 page+viewport 覆盖,其余保留)——支持分批跑降低单 browser 内存压力。
  let existingPages = {};
  if (MERGE) {
    try { existingPages = JSON.parse(readFileSync(outJson, 'utf8')).pages || {}; } catch { /* 首跑无既有 */ }
  }

  const results = [];
  for (const pageDef of pages) {
    for (const vp of VIEWPORTS) {
      const r = await visitAndMeasure(pageDef, vp, { dark: DARK });
      results.push(r);
      const f = r.metrics?.findings;
      const nF = f ? f.clipped.length + f.overlapPairs.length + f.truncated.length + f.fontMismatch.length + f.spacing.length : 0;
      process.stdout.write(`[${r.key} @${vp.label}] ${r.pageErrors.length ? 'JS-ERR' : 'ok'} findings=${nF}` +
        (r.metrics?.bodyHOverflow ? ` H-OVERFLOW sw=${r.metrics.doc.scrollWidth}` : '') + '\n');
    }
  }

  // 合并既有结果
  const byKey = { ...existingPages };
  for (const r of results) {
    (byKey[r.key] ||= { path: r.path, viewports: {} });
    byKey[r.key].path = r.path;
    byKey[r.key].viewports[r.viewport] = {
      dark: r.dark, gotoError: r.gotoError, shot: r.shot,
      pageErrors: r.pageErrors, consoleErrors: r.consoleErrors,
      metrics: r.metrics,
    };
  }

  // 汇总基于合并后的全量结果重算
  const allRuns = Object.entries(byKey).flatMap(([key, entry]) =>
    Object.entries(entry.viewports).map(([vp, v]) => ({ key, viewport: vp, ...v })));
  const summary = {
    pages: Object.keys(byKey).length,
    viewports: VIEWPORTS.map((v) => v.label),
    totalRuns: allRuns.length,
    pageerrorPages: allRuns.filter((r) => r.pageErrors?.length).map((r) => `${r.key}@${r.viewport}`),
    hOverflowPages: allRuns.filter((r) => r.metrics?.bodyHOverflow).map((r) => `${r.key}@${r.viewport}`),
    findingCounts: {
      clipped: allRuns.reduce((n, r) => n + (r.metrics?.findings?.clipped.length || 0), 0),
      overlap: allRuns.reduce((n, r) => n + (r.metrics?.findings?.overlapPairs.length || 0), 0),
      truncated: allRuns.reduce((n, r) => n + (r.metrics?.findings?.truncated.length || 0), 0),
      truncatedEllipsis: allRuns.reduce((n, r) => n + (r.metrics?.findings?.truncatedEllipsis.length || 0), 0),
      fontMismatch: allRuns.reduce((n, r) => n + (r.metrics?.findings?.fontMismatch.length || 0), 0),
      spacing: allRuns.reduce((n, r) => n + (r.metrics?.findings?.spacing.length || 0), 0),
    },
  };

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      shotDir: SHOT_DIR,
      dark: DARK,
      evidenceDir: EVIDENCE_DIR,
      viewports: VIEWPORTS,
      criteria: {
        clipped: 'bottom > 视口高+1 且 doc/Content/祖先链均无可纵向滚动容器',
        overlap: '两个可交互元素 rect 相交 >2px 且互不包含',
        truncated: 'scrollWidth > clientWidth+1 且 overflow hidden/ellipsis/nowrap;无 ellipsis 的硬截断计入偏差,ellipsis 省略号单列参考',
        fontMismatch: '同一层级标签出现 ≥2 种 computed font-size',
        spacing: '相邻块间距为 0 或 >2 倍中位数',
      },
    },
    summary,
    pages: byKey,
  };
  writeFileSync(outJson, JSON.stringify(report, null, 2), 'utf8');
  process.stdout.write(`\n[visual-1280] JSON -> ${outJson}\n`);
  process.stdout.write(`[visual-1280] 汇总: ${JSON.stringify(summary.findingCounts)} pageerror=${summary.pageerrorPages.length} hOverflow=${summary.hOverflowPages.length}\n`);
}

main().catch((err) => { console.error('[visual-1280] fatal:', err); process.exit(1); });
