// UI 深度扫描：在真实 Electron 窗口里遍历全部页面状态，逐元素量「挤压 / 溢出 /
// 遮挡 / 裁切 / 原生控件残留」，并在断点宽度上做连续缩放扫描。
//
// 与既有工具的分工：
//   ui-metrics.cjs   单状态「设计指标」（coverage/density/typography/边界层级）
//   ui-audit.cjs     全页面「规则体检」（触控目标/文本裁切/对比度/重复 id）
//   ui-deep-scan.cjs 内容填充与窗口伸缩下的「几何破坏」（本文件）：
//     · clipped-text     文本被裁掉且无省略号（用户看不到内容）
//     · content-cut      容器 overflow:hidden 且子内容纵向溢出（内容不可达）
//     · spill            子元素画出父容器/视口之外且无滚动可达路径
//     · squeeze          flex/grid 子项被压到可用宽度以下（控件挤成一团）
//     · overlap          同级静态元素矩形重叠（文字压文字）
//     · occluded         可交互元素中心被别的元素盖住（点不到）
//     · row-misalign     行内 label 与控件垂直中心错位
//     · ellipsis-no-title 省略号截断但没有 title/aria 全文（无从上手看全）
//     · long-token       超长不可断词撑破容器
//     · tiny-target      可交互目标 < 24px（WCAG 2.5.8）
//     · native-control   未重置 appearance 的原生 input/select/textarea
//     · drag-region-hit  -webkit-app-region:drag 里含可点击控件（点不动）
//     · nested-scroll    滚动容器套滚动容器（滚轮陷阱）
//     · doc-overflow     页面级横向溢出（整窗左右晃）
//     · gap-variance     同容器相邻间距离散（视觉节奏乱）
//     · row-height-variance 同类重复行高度不一（列表锯齿）
//     · contrast         文本对比度 < 4.5
//
// 三种内容样本（--fixture）：
//   rich    常规长度混合（含超长中文名、失败长错误）
//   stress  极端填充（60 字中文名 / 超长英文 token / emoji / 12 位数字 / 空值）
//   sparse  空数据（应用空态、历史空态）
//
// 用法：
//   node e2e/ui-deep-scan.cjs
//   node e2e/ui-deep-scan.cjs --fixture=all --sweep=1 --shots=1
//   node e2e/ui-deep-scan.cjs --sizes=760x560,900x600,1440x900 --states=core
//
// 输出（e2e/.deep-scan/）：
//   deep.json          每条状态一行：issues + 关键容器几何 + 统计
//   deep-report.txt    人读摘要（按严重度/类型聚合）
//   shots/*.png        带问题框标注的截图（--shots=1）
const { _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_ENTRY = path.join(__dirname, '..', 'dist', 'main', 'index.js');
const ELECTRON_BIN = require('electron');
const OUT = path.join(__dirname, '.deep-scan');
const SHOT_DIR = path.join(OUT, 'shots');

const argv = process.argv.slice(2);
const argOf = (k, d = null) => {
  const hit = argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const flag = (k) => argv.includes('--' + k) || argOf(k) === '1' || argOf(k) === 'true';

const FIXTURES = (argOf('fixture', 'rich') === 'all'
  ? ['rich', 'stress', 'sparse']
  : [argOf('fixture', 'rich')]);
const SIZES = argOf('sizes', '760x560,900x600,1024x700,1280x800,1440x900,1920x1080,2048x1152')
  .split(',')
  .map((s) => {
    const [w, h] = s.split('x').map(Number);
    return { w, h, name: s };
  });
const DO_SWEEP = flag('sweep');
const DO_SHOTS = flag('shots') || argOf('shots') === 'all';
const SHOTS_ALL = argOf('shots') === 'all'; // 有问题没问题都截，供人工看版式
const SELFTEST = flag('selftest');
// --fail-on=err|warn：作为门禁运行时按阈值返回非零退出码（默认只看报告，不拦）。
const FAIL_ON = argOf('fail-on', 'none');
const STATES = argOf('states', 'all'); // all | core | <comma list>
const ZOOM = Number(argOf('zoom', '1')) || 1;
// 界面语言：英文文案普遍比中文长 30–50%，是「内容填充撑破布局」的高发面。
// 走同一个状态计划，只换文案定位串。
const LANG = argOf('lang', 'zh');
const L = LANG === 'en'
  ? {
    welcome: 'Welcome', logTitle: 'Run logs', start: 'Start setup', next: 'Next',
    tabs: { status: 'Status', history: 'History', apps: 'Apps', config: 'Settings' },
    viewLogs: 'View logs', all: 'All', failed: 'Failed', appLog: 'App log',
    sections: ['Connection & identity', 'Network', 'Python Runtime', 'Agent (experimental)', 'About & updates'],
  }
  : {
    welcome: '欢迎使用', logTitle: '运行日志', start: '开始配置', next: '下一步',
    tabs: { status: '状态监控', history: '历史', apps: '应用', config: '配置' },
    viewLogs: '查看日志', all: '全部', failed: '失败', appLog: '应用日志',
    sections: ['连接与身份', '网络地址', 'Python 运行环境', 'Agent（实验性）', '关于与更新'],
  };

// ── 样本数据 ────────────────────────────────────────────────────────────────
const MIN = 60_000;

const RICH_NAMES = [
  '每日报表生成与汇总推送',
  '跨境电商订单对账与发票归档批处理（华东节点）',
  '库存系统定时对账',
  '客户资料增量同步（CRM → 数据仓库）',
  '夜间全量索引重建',
  '财务凭证同步',
  '邮件通知派发',
  '舆情监控采集',
  '数据库备份校验',
];
const STRESS_NAMES = [
  '跨境电商订单对账与发票归档批处理任务-华东生产集群-高峰期全量重算-含多币种结算与税务口径校验-v2',
  // token 值用占位符形态（<your-token> 语义）——gitleaks 的 generic-api-key
  // 规则会把 32 位 hex token 误当真凭据（CI secret-scan 实测红）。
  'https://admin.example.internal:3001/api/v1/executions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/artifacts/download?token=PLACEHOLDER-TEST-TOKEN-NOT-A-SECRET',
  '🚀🚀 Emoji 前缀任务 ✅ 完成态 🧪 实验分支（多字节宽字符测试）',
  '超长数字 123456789012345678901234567890 与路径 /var/lib/autocodeflow/workspaces/executor-01/releases/2026.10.27-0f9e8d7c6b5a4321/artifacts/report-final-v3.csv',
  '供应商结算单生成',
  '风控指标计算',
];
const LONG_ERROR = 'python: No module named pandas —— 解释器 3.11 准备失败：下载超时（registry.npmmirror.com 连接被重置），请检查网络或改用离线包；已尝试镜像 https://pypi.tuna.tsinghua.edu.cn/simple/ 与 https://mirrors.aliyun.com/pypi/simple/';
const LONG_ERROR_EN = 'HTTP 502 Bad Gateway: upstream connect error or disconnect/reset before headers. reset reason: connection timeout while reading response header from upstream, client: 10.0.0.12, server: admin-api.internal';

function buildFixture(kind) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-deep-'));
  const metaDir = path.join(root, 'meta');
  fs.mkdirSync(metaDir, { recursive: true });
  const now = Date.now();
  const names = kind === 'stress' ? STRESS_NAMES : RICH_NAMES;
  const count = kind === 'sparse' ? 0 : kind === 'stress' ? 60 : 34;

  const records = [];
  for (let i = 0; i < count; i++) {
    const task = names[i % names.length];
    const status = i === 3 ? 'running' : i % 7 === 0 ? 'failed' : i % 11 === 0 ? 'running' : 'success';
    const start = now - i * 43 * MIN - (i % 3) * 3 * 60 * MIN;
    const err = status !== 'failed'
      ? undefined
      : kind === 'stress'
        ? (i % 2 === 0 ? LONG_ERROR : LONG_ERROR_EN)
        : (i % 2 === 0 ? LONG_ERROR : 'HTTP 502 Bad Gateway: upstream connect error or disconnect/reset before headers');
    records.push({
      executionId: `${kind === 'stress' ? 'a'.repeat(24) : 'e' + String(i).padStart(3, '0')}-a2b3-c7d8-4e5f-9a01-234567890abc`,
      taskId: `t-${1001 + (i % names.length)}`,
      taskName: task,
      startTime: i === 5 && kind === 'stress' ? undefined : start,
      endTime: status === 'running' ? undefined : start + (2 + (i % 17)) * MIN,
      status,
      exitCode: status === 'failed' ? (i % 3) : status === 'success' ? 0 : undefined,
      errorMessage: err,
    });
  }
  if (count > 0) {
    records.push({ executionId: 'stale-a2b3-c7d8-4e5f-9a01-234567890abc', taskId: 't-9001', taskName: '月度经营分析报表', startTime: now - 7 * 60 * MIN, status: 'running' });
    records.push({ executionId: 'old0-a2b3-c7d8-4e5f-9a01-234567890abc', taskId: 't-9002', taskName: kind === 'stress' ? STRESS_NAMES[0] : '供应商结算单生成', startTime: now - 5 * 24 * 60 * MIN, endTime: now - 5 * 24 * 60 * MIN + 40 * 1000, status: 'failed', exitCode: 1 });
  }
  records.forEach((r, i) => fs.writeFileSync(path.join(metaDir, `meta-${String(i).padStart(4, '0')}.json`), JSON.stringify(r)));

  // 日志分片（历史页「查看日志」浮层要有真内容）
  const logsBase = path.join(root, 'logs');
  const pad = (n) => String(n).padStart(2, '0');
  for (const r of records) {
    if (!r.startTime) continue;
    const d = new Date(r.startTime);
    const dateDir = path.join(logsBase, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    fs.mkdirSync(dateDir, { recursive: true });
    const lines = Array.from({ length: 80 }, (_, j) => {
      const level = j === 20 ? 'WARN' : j === 40 ? 'ERROR' : 'INFO';
      const tail = kind === 'stress' && j % 9 === 0
        ? `payload={"orderId":"0123456789abcdef0123456789abcdef","items":[${Array.from({ length: 8 }, (_, k) => `{"sku":"SKU-${k}-${'X'.repeat(24)}","qty":${k + 1}}`).join(',')}]}`
        : `step ${j} rows=${100 + j} elapsed=${120 + j}ms`;
      return `${new Date(r.startTime + j * 1000).toISOString()} [${level}] [23fb6898] ${r.taskName} ${tail}`;
    });
    fs.writeFileSync(path.join(dateDir, `${r.executionId}.log`), lines.join('\n'));
  }

  const log = Array.from({ length: 60 }, (_, i) => `2026-10-20T06:12:${String(i % 60).padStart(2, '0')}.000Z [INFO] [23fb6898] sync batch #${i} done`);
  const defs = kind === 'sparse'
    ? []
    : kind === 'stress'
      ? [
        { id: 'a1b2c3d4-0000-4000-8000-000000000001', name: STRESS_NAMES[0], runMode: 'daemon', versions: 3, log: true, current: true },
        { id: 'b1b2c3d4-0000-4000-8000-000000000002', name: STRESS_NAMES[1], runMode: 'cron', versions: 2, log: false, current: false },
        { id: 'c1b2c3d4-0000-4000-8000-000000000003', name: STRESS_NAMES[2], runMode: 'daemon', versions: 1, log: false, current: false },
        { id: 'd1b2c3d4-0000-4000-8000-000000000004', name: null, runMode: null, versions: 1, log: false, current: false },
        { id: 'e1b2c3d4-0000-4000-8000-000000000005', name: STRESS_NAMES[3], runMode: 'scheduled', versions: 4, log: false, current: false },
        { id: 'f1b2c3d4-0000-4000-8000-000000000006', name: '风控指标计算', runMode: 'daemon', versions: 2, log: true, current: true },
        { id: 'g1b2c3d4-0000-4000-8000-000000000007', name: STRESS_NAMES[4], runMode: 'manual', versions: 1, log: false, current: false },
        { id: 'h1b2c3d4-0000-4000-8000-000000000008', name: '', runMode: 'daemon', versions: 6, log: false, current: false },
      ]
      : [
        { id: 'a1b2c3d4-0000-4000-8000-000000000001', name: '数据同步机器人', runMode: 'daemon', versions: 3, log: true, current: true },
        { id: 'b1b2c3d4-0000-4000-8000-000000000002', name: RICH_NAMES[1], runMode: 'cron', versions: 2, log: false, current: false },
        { id: 'c1b2c3d4-0000-4000-8000-000000000003', name: '报表生成服务', runMode: 'daemon', versions: 1, log: false, current: false },
        { id: 'd1b2c3d4-0000-4000-8000-000000000004', name: null, runMode: null, versions: 1, log: false, current: false },
        { id: 'e1b2c3d4-0000-4000-8000-000000000005', name: '数据库备份校验', runMode: 'scheduled', versions: 4, log: false, current: false },
        { id: 'f1b2c3d4-0000-4000-8000-000000000006', name: '风控指标计算', runMode: 'daemon', versions: 2, log: true, current: true },
      ];
  for (const d of defs) {
    const appDir = path.join(root, 'apps', d.id);
    const versions = [];
    for (let v = 0; v < d.versions; v++) {
      const key = `1.${v}.0-3fa1b2c3-0000-4000-8000-${String(v).padStart(12, '0')}`;
      const dir = path.join(appDir, 'releases', key);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ appName: d.name ?? undefined, runMode: d.runMode ?? undefined }));
      if (d.log && v === d.versions - 1) fs.writeFileSync(path.join(dir, 'app.log'), log.join('\n'));
      versions.push(key);
    }
    if (d.name || d.runMode) fs.writeFileSync(path.join(appDir, 'app.json'), JSON.stringify({ appName: d.name ?? undefined, runMode: d.runMode ?? undefined }));
    if (d.current) {
      try {
        fs.symlinkSync(path.join(appDir, 'releases', versions[versions.length - 1]), path.join(appDir, 'current'), process.platform === 'win32' ? 'junction' : 'dir');
      } catch { /* current 软链失败不阻断扫描 */ }
    }
  }
  return root;
}

// ── 页面内探针 ──────────────────────────────────────────────────────────────
// 纯函数，Playwright 会把它序列化后在渲染进程执行；不得引用外部作用域。
function deepProbe(opts) {
  const O = Object.assign({
    scope: null,
    contrast: true,
    occlusion: true,
    focus: false,
    maxPerKind: 40,
    rowSelectors: ['.cfgx-row', '.appx-detail-row', '.appx-release-row', '.historyx-fact', '.appx-row', '.historyx-run-row'],
  }, opts || {});

  const winW = window.innerWidth;
  const winH = window.innerHeight;
  const scope = (O.scope && document.querySelector(O.scope)) || document.querySelector('.tab-panel.is-active') || document.body;
  const scopeRect = scope.getBoundingClientRect();

  const issues = [];
  const counters = {};
  const seen = new Set();
  const push = (kind, sev, el, detail, extra) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const key = kind + '|' + cls(el) + '|' + Math.round(r.x) + ',' + Math.round(r.y) + ',' + Math.round(r.width) + ',' + Math.round(r.height) + '|' + String(detail).slice(0, 60);
    if (seen.has(key)) return;
    seen.add(key);
    counters[kind] = (counters[kind] || 0) + 1;
    if (counters[kind] > O.maxPerKind) return;
    issues.push({
      kind,
      sev,
      cls: cls(el),
      path: pathOf(el),
      text: textOf(el).slice(0, 60),
      detail,
      rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      ...(extra || {}),
    });
  };

  function cls(el) {
    if (!el || !el.tagName) return '?';
    const c = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + (c ? '.' + c : '');
  }
  function pathOf(el) {
    const parts = [];
    let n = el;
    for (let i = 0; i < 4 && n && n !== document.body; i++) {
      parts.unshift(cls(n));
      n = n.parentElement;
    }
    return parts.join(' > ');
  }
  function textOf(el) {
    return ((el.textContent || '').replace(/\s+/g, ' ').trim());
  }
  function isVisible(el) {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    if (Number(cs.opacity) <= 0.04) return false;
    if (el.closest('[hidden],[inert]')) return false;
    // 关闭的 <details>：Chromium 仍保留子节点布局盒，但不绘制——几何量会假阳。
    // 例外：该 details 自己的 <summary>（标题始终可见）。
    const closed = el.closest('details:not([open])');
    if (closed) {
      const summary = el.closest('summary');
      if (!summary || summary.parentElement !== closed) return false;
    }
    return true;
  }
  function pointerTransparent(el) {
    let p = el;
    while (p && p !== document.body) {
      if (getComputedStyle(p).pointerEvents === 'none') return true;
      p = p.parentElement;
    }
    return false;
  }
  function isScrollable(el) {
    const cs = getComputedStyle(el);
    return ['auto', 'scroll', 'overlay'].includes(cs.overflowX) || ['auto', 'scroll', 'overlay'].includes(cs.overflowY);
  }
  function scrollAncestor(el) {
    let p = el.parentElement;
    while (p && p !== document.documentElement) {
      if (isScrollable(p)) return p;
      p = p.parentElement;
    }
    return null;
  }
  function clipAncestors(el) {
    const list = [];
    let p = el.parentElement;
    while (p && p !== document.documentElement) {
      const cs = getComputedStyle(p);
      if (['hidden', 'clip'].includes(cs.overflowX) || ['hidden', 'clip'].includes(cs.overflowY)) list.push(p);
      p = p.parentElement;
    }
    return list;
  }
  function hasTextNode(el) {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) return true;
    return false;
  }
  function firstClass(el) {
    return typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] || '' : '';
  }
  function isInteractive(el) {
    const t = el.tagName;
    if (['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(t)) return true;
    return el.getAttribute('role') === 'button' || el.getAttribute('role') === 'tab' || el.hasAttribute('tabindex');
  }
  function layoutParent(el) {
    const cs = getComputedStyle(el);
    return cs.display.includes('flex') || cs.display.includes('grid');
  }
  // 覆盖层分层：fixed/absolute 祖先 = 独立图层。跨层矩形重叠是「抽屉/浮层盖住
  // 底下的表格」，属于设计本身；只有同层重叠才是布局挤压。
  // 元素实际可见矩形：与所有 overflow:hidden/clip **以及滚动容器**的滚动口
  // 求交。多行 inline 的 getBoundingClientRect 是两行联合包围盒，会盖住后面的
  // 行内内容——用这个交集与「单行 client rect」双重校正，避免把「被裁掉/
  // 滚出滚动口/跨行包围盒」当成重叠。
  const CLIPPING = ['hidden', 'clip', 'auto', 'scroll', 'overlay'];
  function visibleRect(el) {
    const r = el.getBoundingClientRect();
    let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom;
    let p = el.parentElement;
    while (p && p !== document.documentElement) {
      const cs = getComputedStyle(p);
      const cx = CLIPPING.includes(cs.overflowX);
      const cy = CLIPPING.includes(cs.overflowY);
      if (cx || cy) {
        const pr = p.getBoundingClientRect();
        if (cx) { x0 = Math.max(x0, pr.left); x1 = Math.min(x1, pr.right); }
        if (cy) { y0 = Math.max(y0, pr.top); y1 = Math.min(y1, pr.bottom); }
      }
      p = p.parentElement;
    }
    return { left: x0, top: y0, right: x1, bottom: y1, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
  }
  // 文本自身的第一行包围盒（Range 量的是字形行盒，不含 label 的 padding-top）。
  function firstTextRect(el) {
    if (!el) return null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const n = walker.nextNode();
    if (!n || !n.nodeValue || !n.nodeValue.trim()) return null;
    const range = document.createRange();
    range.selectNodeContents(n);
    // 取第一行（多行文本的 range 包围盒会跨行，中心对齐就失去意义）
    const rects = range.getClientRects();
    const r = rects && rects.length ? rects[0] : range.getBoundingClientRect();
    return r.height > 1 ? r : null;
  }
  function isMultilineInline(el) {
    if (getComputedStyle(el).display !== 'inline') return false;
    return el.getClientRects().length > 1;
  }
  function layerOf(el) {
    let p = el;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      if (cs.position === 'fixed' || cs.position === 'absolute') return p;
      p = p.parentElement;
    }
    return document.body;
  }

  const all = [...scope.querySelectorAll('*')].filter(isVisible);
  const textLeaves = all.filter((el) => hasTextNode(el) && ![...el.children].some((c) => isVisible(c) && hasTextNode(c)));
  const interactive = all.filter(isInteractive);
  const painted = all.filter((el) => hasTextNode(el) || isInteractive(el) || ['IMG', 'SVG', 'CANVAS'].includes(el.tagName));

  // ── 0. 页面级滚动 ─────────────────────────────────────────────
  const de = document.documentElement;
  if (de.scrollWidth > winW + 1) push('doc-overflow', 'err', de, `document scrollWidth=${de.scrollWidth} > win=${winW}`);
  if (de.scrollHeight > de.clientHeight + 1 && getComputedStyle(document.body).overflowY === 'visible') {
    push('body-scroll', 'warn', de, `document scrollHeight=${de.scrollHeight} > client=${de.clientHeight}（整窗纵向滚动）`);
  }

  // ── 1. 文本裁切 / 容器裁切 / 溢出 ─────────────────────────────
  for (const el of textLeaves) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const clippedX = el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0;
    const clippedY = el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0;
    const ellipsis = cs.textOverflow === 'ellipsis' && (cs.overflowX !== 'visible' || cs.whiteSpace === 'nowrap');
    const clippedByX = clippedX && ['hidden', 'clip'].includes(cs.overflowX) && !ellipsis;
    const clippedByY = clippedY && ['hidden', 'clip'].includes(cs.overflowY) && cs.webkitLineClamp === 'none';
    const noScroll = !isScrollable(el);
    if (clippedByX && noScroll) {
      push('clipped-text', 'err', el, `scrollW=${el.scrollWidth} clientW=${el.clientWidth} overflowX=${cs.overflowX}`, { axis: 'x' });
    }
    if (clippedByY && noScroll) {
      push('clipped-text', 'err', el, `scrollH=${el.scrollHeight} clientH=${el.clientHeight} overflowY=${cs.overflowY}`, { axis: 'y' });
    }
    if (ellipsis && clippedX) {
      // 省略号本身合理，但用户需要能看全文：本元素或 3 层内祖先要有 title/aria-label
      let n = el;
      let titled = false;
      for (let i = 0; i < 4 && n && n !== document.body; i++) {
        if (n.getAttribute('title') || n.getAttribute('aria-label')) { titled = true; break; }
        n = n.parentElement;
      }
      if (!titled) push('ellipsis-no-title', 'info', el, `scrollW=${el.scrollWidth} clientW=${el.clientWidth}`);
    }
    // 超长不可断 token（无空白、无连字符、非中文）撑破窄栏
    const m = textOf(el).match(/[A-Za-z0-9_\-./:?=&%#@+]{28,}/);
    if (m && el.scrollWidth > el.clientWidth + 2) {
      // 有省略号 = 有意截断（文件名/ID 常态）；无省略号的裸溢出才是排版塌方。
      push('long-token', ellipsis ? 'info' : 'warn', el, `token=${m[0].slice(0, 40)}… len=${m[0].length}`);
    }
    // 行高异常（溢出容器后才算，避免误报）
    // line-height:1 的文本盒高度就等于字号，不能算「塌陷」；只有明显低于
    // 一个字形行（<0.75em）才说明被压掉了。
    const fs = parseFloat(cs.fontSize);
    if (r.height > 0 && r.height < fs * 0.75 && textOf(el).length > 2) push('collapsed-text', 'warn', el, `h=${r.height.toFixed(1)} fontSize=${fs}`);
  }

  // 非文本容器裁切：overflow hidden 且纵向内容溢出（内容不可达）
  for (const el of all) {
    if (textLeaves.includes(el)) continue;
    const cs = getComputedStyle(el);
    if (!['hidden', 'clip'].includes(cs.overflowY)) continue;
    if (el.clientHeight < 4) continue;
    if (el.scrollHeight > el.clientHeight + 4) {
      // 内部若有自身可滚动的后代，说明内容仍有可达路径（如吸顶头+滚动体）
      const innerScroller = [...el.querySelectorAll('*')].some((c) => isScrollable(c) && c.scrollHeight > c.clientHeight + 2);
      if (!innerScroller) push('content-cut', 'err', el, `scrollH=${el.scrollHeight} clientH=${el.clientHeight}`);
    }
  }

  // 视口外（无滚动可达）
  for (const el of painted) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const sa = scrollAncestor(el);
    if (sa) continue;
    if (cs.position === 'fixed') continue;
    const vr = visibleRect(el);
    if (vr.width < 1 || vr.height < 1) continue; // 已被祖先裁掉，不会画到视口外
    if (vr.right > winW + 2) push('spill', 'err', el, `right=${vr.right.toFixed(1)} > winW=${winW}`, { side: 'right' });
    if (vr.left < -2) push('spill', 'err', el, `left=${vr.left.toFixed(1)} < 0`, { side: 'left' });
    if (vr.bottom > winH + 2) push('spill', 'err', el, `bottom=${vr.bottom.toFixed(1)} > winH=${winH}`, { side: 'bottom' });
    if (vr.top < -2) push('spill', 'err', el, `top=${vr.top.toFixed(1)} < 0`, { side: 'top' });
  }

  // 子元素画出父盒（父不可滚动、overflow 可见）：轻微伸出多为设计，超出 6px 才报
  for (const el of painted) {
    const p = el.parentElement;
    if (!p || !all.includes(p)) continue;
    if (!layoutParent(p)) continue;
    const pr = p.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(p);
    if (isScrollable(p) || ['hidden', 'clip'].includes(cs.overflowX)) continue;
    if (r.width < 2 || r.height < 2) continue;
    const over = Math.max(pr.left - r.left, r.right - pr.right, pr.top - r.top, r.bottom - pr.bottom);
    // 伸进父级 padding / 可见溢出区通常是无害的（按钮贴着单元格内边距），
    // 只有与别的元素真正撞上时才算问题——那由 overlap 负责。这里只留线索。
    if (over > 6) push('child-spill', 'info', el, `over=${over.toFixed(1)} parent=${cls(p)} pbox=${Math.round(pr.width)}x${Math.round(pr.height)} cbox=${Math.round(r.width)}x${Math.round(r.height)}`);
  }

  // ── 2. 挤压 ───────────────────────────────────────────────────
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (!layoutParent(el)) continue;
    const isRow = cs.display.includes('flex')
      ? cs.flexDirection === 'row' || cs.flexDirection === 'row-reverse'
      : cs.gridTemplateColumns && cs.gridTemplateColumns.split(' ').length > 1;
    if (!isRow) continue; // 纵向堆叠/单列 grid 的「子项宽度求和」没有意义
    const kids = [...el.children].filter(isVisible).filter((k) => !['absolute', 'fixed'].includes(getComputedStyle(k).position));
    if (kids.length < 2) continue;
    const er = el.getBoundingClientRect();
    const sumW = kids.reduce((s, k) => s + k.getBoundingClientRect().width, 0);
    // nowrap 的横向 flex 子项总宽超出容器且不可滚动 → 被压扁或溢出
    if (cs.display.includes('flex') && cs.flexWrap === 'nowrap' && sumW > er.width + 4 && !isScrollable(el)) {
      push('squeeze', 'warn', el, `childrenSumW=${sumW.toFixed(0)} containerW=${er.width.toFixed(0)}`);
    }
    for (const k of kids) {
      const kr = k.getBoundingClientRect();
      const kt = textOf(k);
      const decorative = k.getAttribute('aria-hidden') === 'true'
        || pointerTransparent(k)
        || /^[·•|/、,，.。:：\-–—]+$/.test(kt)
        || (kt.length < 3 && !isInteractive(k));
      if (decorative) continue;
      const minW = isInteractive(k) ? 24 : 16;
      if (kr.width > 0 && kr.width < minW && (kt.length >= 3 || isInteractive(k))) {
        push('squeeze', 'warn', k, `w=${kr.width.toFixed(1)} parent=${cls(el)} flex=${cs.display}/${cs.flexDirection}`);
      }
    }
  }

  // ── 3. 重叠（同级静态元素）───────────────────────────────────
  const overlapPool = painted.slice().sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y);
  for (let i = 0; i < overlapPool.length; i++) {
    const a = overlapPool[i];
    const ar = a.getBoundingClientRect();
    if (ar.width < 4 || ar.height < 4) continue;
    const acs = getComputedStyle(a);
    if (acs.position === 'absolute' || acs.position === 'fixed') continue;
    if (acs.pointerEvents === 'none' && !hasTextNode(a)) continue;
    if (isMultilineInline(a)) continue;
    for (let j = i + 1; j < overlapPool.length; j++) {
      const b = overlapPool[j];
      const br = b.getBoundingClientRect();
      if (br.y >= ar.bottom) break;
      if (br.width < 4 || br.height < 4) continue;
      const bcs = getComputedStyle(b);
      if (bcs.position === 'absolute' || bcs.position === 'fixed') continue;
      if (a.contains(b) || b.contains(a)) continue;
      if (layerOf(a) !== layerOf(b)) continue;
      if (isMultilineInline(b)) continue;
      const av = visibleRect(a);
      const bv = visibleRect(b);
      if (av.width < 4 || av.height < 4 || bv.width < 4 || bv.height < 4) continue;
      const ow = Math.min(av.right, bv.right) - Math.max(av.left, bv.left);
      const oh = Math.min(av.bottom, bv.bottom) - Math.max(av.top, bv.top);
      if (ow > 4 && oh > 4 && ow * oh > 40) {
        push('overlap', 'err', a, `与 ${cls(b)} 重叠 ${ow.toFixed(0)}x${oh.toFixed(0)} a=${Math.round(av.left)},${Math.round(av.top)} ${Math.round(av.width)}x${Math.round(av.height)} b=${Math.round(bv.left)},${Math.round(bv.top)} ${Math.round(bv.width)}x${Math.round(bv.height)} (b:${textOf(b).slice(0, 20)})`);
      }
    }
  }

  // ── 4. 遮挡：可交互元素中心被别的元素盖住 ───────────────────
  if (O.occlusion) {
    for (const el of interactive.slice(0, 120)) {
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) continue;
      if (pointerTransparent(el)) continue;
      // 只有「完整落在滚动口 + 视口内」的元素才能做中心点命中判定；部分露出
      // （例如滚到固定底栏下面）的元素中心会命中遮住它的容器，属假阳性。
      const vr = visibleRect(el);
      if (vr.width < r.width - 1 || vr.height < r.height - 1) continue;
      if (vr.top < 1 || vr.left < 1 || vr.bottom > winH - 1 || vr.right > winW - 1) continue;
      const cx = vr.left + vr.width / 2;
      const cy = vr.top + vr.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      if (!hit) continue;
      if (hit === el || el.contains(hit) || hit.contains(el)) continue;
      // 抽屉/全屏日志等浮层盖住底层页面属设计：跨层不算遮挡
      if (layerOf(hit) !== layerOf(el)) continue;
      // 文本/图标子节点被伪元素或装饰层挡住时 elementFromPoint 仍返回子节点，已排除
      push('occluded', 'err', el, `center hit by ${cls(hit)} "${textOf(hit).slice(0, 24)}"`);
    }
  }

  // ── 5. 行内对齐 / 间距节奏 ──────────────────────────────────
  for (const sel of O.rowSelectors) {
    for (const row of [...scope.querySelectorAll(sel)].filter(isVisible).slice(0, 60)) {
      const kids = [...row.children].filter(isVisible);
      if (kids.length < 2) continue;
      // 控件列的包围盒可能含下方提示文案；对齐看的是「第一个真实控件」。
      const control = kids[kids.length - 1];
      const controlFirst = control.querySelector('input,select,textarea,button,[role="button"]');
      // 用字形行盒而非带 padding 的盒中心：label 常有 padding-top 与 34px 高的
      // 输入框视觉对齐，盒中心会差 4px 左右，属假阳性。
      const a = firstTextRect(kids[0]) || kids[0].getBoundingClientRect();
      const b = firstTextRect(controlFirst) || (controlFirst || control).getBoundingClientRect();
      // 只有并排（纵向交叠）的两栏才谈「垂直中心对齐」；label 在上、值在下的
      // 堆叠行（dt/dd、窄窗换行）中心差是设计使然。
      const vOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (vOverlap < Math.min(a.height, b.height) * 0.7) continue;
      const dy = Math.abs((a.top + a.height / 2) - (b.top + b.height / 2));
      if (dy > 3 && Math.max(a.height, b.height) < 80) push('row-misalign', 'warn', row, `centerDelta=${dy.toFixed(1)} a=${Math.round(a.top)},${Math.round(a.height)} b=${Math.round(b.top)},${Math.round(b.height)} (${cls(kids[0])} vs ${cls(controlFirst || control)})`);
    }
  }

  const vstacks = ['.cfgx-panel', '.cfgx-group', '.apps-list', '.historyx-list', '.appx-drawer-body', '.wizard-body', '.log-fs-files'];
  for (const sel of vstacks) {
    for (const box of [...scope.querySelectorAll(sel)].filter(isVisible)) {
      const kids = [...box.children].filter(isVisible);
      if (kids.length < 5 || kids.length > 80) continue;
      if (isScrollable(box)) continue;
      const gaps = [];
      for (let i = 1; i < kids.length; i++) {
        const prev = kids[i - 1].getBoundingClientRect();
        const cur = kids[i].getBoundingClientRect();
        if (Math.abs(cur.x - prev.x) > 24) continue;
        const g = Math.round(cur.top - prev.bottom);
        if (g >= -4 && g < 96) gaps.push(g);
      }
      if (gaps.length < 4) continue;
      const min = Math.min(...gaps);
      const max = Math.max(...gaps);
      if (max - min > 10) push('gap-variance', 'info', box, `gaps min=${min} max=${max} n=${gaps.length}`);
    }
  }

  // 同类重复行高度不齐（列表锯齿）
  const rowGroups = new Map();
  for (const el of all) {
    const f = firstClass(el);
    if (!f || hasTextNode(el) === false) continue;
    const parent = el.parentElement;
    if (!parent) continue;
    const key = cls(parent) + '>' + f;
    if (!rowGroups.has(key)) rowGroups.set(key, []);
    rowGroups.get(key).push(el);
  }
  for (const [key, group] of rowGroups) {
    if (group.length < 4 || group.length > 80) continue;
    const hs = group.map((el) => el.getBoundingClientRect().height).filter((h) => h > 8);
    if (hs.length < 4) continue;
    const min = Math.min(...hs);
    const max = Math.max(...hs);
    if (max - min > 8) push('row-height-variance', 'info', group[0], `${key} h=${min.toFixed(0)}..${max.toFixed(0)} n=${hs.length}`);
  }

  // ── 6. 触控目标 / 原生控件 / 滚动 ───────────────────────────
  for (const el of interactive) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.height > 0 && r.height < 24) push('tiny-target', r.height < 20 ? 'err' : 'warn', el, `h=${r.height.toFixed(1)} w=${r.width.toFixed(1)}`);
    if (cs.pointerEvents === 'none' && !el.disabled) push('dead-control', 'err', el, 'pointer-events:none');
    if (cs.cursor === 'default' && ['BUTTON', 'A'].includes(el.tagName)) push('missing-pointer', 'info', el, 'cursor:default');
  }
  for (const el of all) {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
      const ap = getComputedStyle(el).appearance || getComputedStyle(el).webkitAppearance;
      if (ap && ap !== 'none') push('native-control', 'info', el, `appearance=${ap}`);
    }
    if (isScrollable(el)) {
      const barW = el.offsetWidth - el.clientWidth;
      const barH = el.offsetHeight - el.clientHeight;
      if ((barW > 1 && el.scrollHeight > el.clientHeight + 1) || (barH > 1 && el.scrollWidth > el.clientWidth + 1)) {
        push('native-scrollbar', 'info', el, `classic scrollbar ${barW}x${barH}px`);
      }
      if (el.scrollHeight > el.clientHeight + 2 && scrollAncestor(el)) push('nested-scroll', 'info', el, 'scroll container inside scroll container');
    }
  }
  // 拖拽区里的可点击控件（无边框窗口的经典死区）
  for (const el of all) {
    const cs = getComputedStyle(el);
    const region = cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region');
    if (region === 'drag' && el.querySelector('button,a,input,select,textarea,[role="button"]')) {
      push('drag-region-hit', 'err', el, 'drag region contains interactive descendants');
    }
  }

  // ── 7. 对比度（与 ui-metrics 同口径：半透明层层合成）─────────
  function parse(s) {
    const m = String(s).match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/);
    return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
  }
  function lum(rgb) {
    const [r, g, b] = rgb.map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function ratio(fg, bg) {
    const l1 = lum(fg), l2 = lum(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  function blend(fg, bg) {
    const a = fg[3];
    return [Math.round(fg[0] * a + bg[0] * (1 - a)), Math.round(fg[1] * a + bg[1] * (1 - a)), Math.round(fg[2] * a + bg[2] * (1 - a))];
  }
  function bgOf(el) {
    const stack = [];
    let p = el;
    while (p) {
      const c = parse(getComputedStyle(p).backgroundColor);
      if (c && c[3] > 0) {
        stack.push(c);
        if (c[3] >= 0.999) break;
      }
      p = p.parentElement;
    }
    let bg = [255, 255, 255];
    for (let i = stack.length - 1; i >= 0; i--) bg = blend(stack[i], bg);
    return bg;
  }
  if (O.contrast) {
    for (const el of textLeaves) {
      const t = textOf(el);
      if (t.length < 2) continue;
      const cs = getComputedStyle(el);
      const fg = parse(cs.color);
      if (!fg || fg[3] === 0) continue;
      const bg = bgOf(el);
      const rr = ratio(fg[3] >= 0.999 ? fg : blend(fg, bg), bg);
      // WCAG 大字号阈值 3.0：>=24px 或 >=18.66px 且 bold；其余 4.5。
      const fpx = parseFloat(cs.fontSize);
      const fw = Number(cs.fontWeight) || 400;
      const large = fpx >= 24 || (fpx >= 18.66 && fw >= 700);
      const min = large ? 3 : 4.5;
      // 0.02 容差：设计稿按 4.50 定的色值，取整误差不该反复报红。
      if (rr < min - 0.02) push('contrast', rr < min - 1.5 ? 'err' : 'warn', el, `ratio=${rr.toFixed(2)} need=${min} ${fpx}px/${fw} color=${cs.color} bg=rgb(${bg.join(',')})`);
    }
  }

  // ── 8. 统计与关键容器几何 ──────────────────────────────────
  const fontHist = {};
  const sizes = new Set();
  let chars = 0;
  for (const el of textLeaves) {
    const cs = getComputedStyle(el);
    fontHist[cs.fontSize] = (fontHist[cs.fontSize] || 0) + 1;
    sizes.add(cs.fontSize);
    chars += textOf(el).length;
  }
  const selectors = ['.topbar', '.topbar-tabs', '.tabs', '.main-content', '.cfg-nav', '.cfg-scroll-inner', '.cfg-footer',
    '.apps-controls', '.apps-list', '.appx-table-wrap', '.appx-table', '.appx-drawer', '.appx-compact-list',
    '.history-filters', '.historyx-layout', '.historyx-list', '.historyx-detail', '.log-fullscreen', '.log-fs-side',
    '.status-page', '.hero', '.today-summary', '.close-tip', '.cfgx-panel', '.cfgx-effective', '.health-card'];
  const boxes = {};
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el || !isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    boxes[sel] = { x: +r.x.toFixed(0), y: +r.y.toFixed(0), w: +r.width.toFixed(0), h: +r.height.toFixed(0) };
  }

  return {
    win: { w: winW, h: winH, dpr: window.devicePixelRatio },
    page: scope.id || scope.className || 'body',
    scope: { x: +scopeRect.x.toFixed(0), y: +scopeRect.y.toFixed(0), w: +scopeRect.width.toFixed(0), h: +scopeRect.height.toFixed(0) },
    doc: { scrollW: de.scrollWidth, clientW: de.clientWidth, scrollH: de.scrollHeight, clientH: de.clientHeight },
    counts: { elements: all.length, textLeaves: textLeaves.length, interactive: interactive.length },
    typography: { distinctSizes: sizes.size, fontHist, chars },
    counters,
    issues,
    boxes,
  };
}

// 把问题框画在截图上（只标 err/warn），便于人眼复核。
function drawIssueOverlay(issues) {
  const old = document.getElementById('__acf_deep_overlay');
  if (old) old.remove();
  const layer = document.createElement('div');
  layer.id = '__acf_deep_overlay';
  layer.style.cssText = 'position:fixed;inset:0;z-index:2147483600;pointer-events:none;';
  for (const i of issues) {
    if (i.sev === 'info') continue;
    const d = document.createElement('div');
    const color = i.sev === 'err' ? '#ef4444' : '#f59e0b';
    d.style.cssText = `position:absolute;left:${i.rect.x}px;top:${i.rect.y}px;width:${i.rect.w}px;height:${i.rect.h}px;border:1.5px solid ${color};box-sizing:border-box;`;
    const tag = document.createElement('span');
    tag.textContent = i.kind;
    tag.style.cssText = `position:absolute;left:0;top:-14px;font:10px/12px monospace;background:${color};color:#fff;padding:0 3px;white-space:nowrap;`;
    d.appendChild(tag);
    layer.appendChild(d);
  }
  document.body.appendChild(layer);
}

// ── 探针自检 ────────────────────────────────────────────────────────────────
// 「0 问题」只有在探针真能抓到问题时才有意义。注入一组已知坏布局，
// 断言每个检测器都命中；缺任何一个都说明该维度失明（而不是页面干净）。
let selfTestFailed = false;
async function runSelfTest(page) {
  await page.evaluate(() => {
    const old = document.getElementById('__deep_selftest_host');
    if (old) old.remove();
    const host = document.createElement('div');
    host.id = '__deep_selftest_host';
    // fixed 定位：.main-content 是 overflow:hidden 的应用外壳，static 追加会
    // 被推到折叠线以下裁掉，量不到。fixed 后自带独立图层，仍在视口内。
    host.style.cssText = 'position:fixed;left:8px;top:80px;z-index:9999;width:320px;padding:8px;background:#fff;color:#111;font:12px/1.4 sans-serif;';
    host.innerHTML = `
      <div id="st-squeeze" style="display:flex;flex-wrap:nowrap;width:80px;gap:2px">
        <span style="flex:none;width:60px">AAAA</span><span style="flex:none;width:60px">BBBB</span>
      </div>
      <div id="st-clip" style="width:70px;overflow:hidden;white-space:nowrap">CLIPPEDTEXTCLIPPEDTEXT</div>
      <div id="st-cut" style="height:20px;overflow:hidden"><div style="height:60px">tall</div></div>
      <div id="st-overlap" style="position:relative;height:18px">
        <span style="display:inline-block;width:60px;height:16px;background:#eee">one</span><span style="display:inline-block;width:60px;height:16px;margin-left:-40px;background:#ddd">two</span>
      </div>
      <button id="st-tiny" style="width:16px;height:16px;padding:0">x</button>
      <div style="height:30px;overflow:auto"><div style="height:60px;overflow:auto"><div style="height:120px">nested</div></div></div>
      <select id="st-native"><option>a</option></select>
      <div id="st-token" style="width:60px;white-space:nowrap;overflow:visible">SUPERCALIFRAGILISTICEXPIALIDOCIOUS_TOKEN_1234567890</div>`;
    document.querySelector('.main-content').appendChild(host);
  });
  const dbg = await page.evaluate(() => [...document.querySelectorAll('#st-overlap span')].map((e) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return { x: r.x, y: r.y, w: r.width, h: r.height, disp: cs.display, pos: cs.position, ml: cs.marginLeft };
  }));
  const res = await page.evaluate(deepProbe, { scope: '#__deep_selftest_host', contrast: false, occlusion: false, rowSelectors: [] });
  if (!res.counters.overlap) console.log('  selftest overlap debug=' + JSON.stringify(dbg));
  await page.evaluate(() => document.getElementById('__deep_selftest_host')?.remove());
  const expect = ['squeeze', 'clipped-text', 'content-cut', 'overlap', 'tiny-target', 'nested-scroll', 'native-control', 'long-token'];
  const missing = expect.filter((k) => !res.counters[k]);
  console.log(`  selftest: ${missing.length ? 'FAIL missing ' + missing.join(',') : 'PASS ' + expect.length + '/' + expect.length}`);
  if (missing.length) console.log('  selftest counters=' + JSON.stringify(res.counters));
  if (missing.length) selfTestFailed = true;
}

// ── 运行器 ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setSize(app, page, w, h) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await app.evaluate(({ BrowserWindow }, { w, h }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return;
      if (win.isMaximized()) win.unmaximize();
      win.setContentSize(w, h);
    }, { w, h });
    await sleep(320);
    if (!page) return;
    const cur = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
    if (cur[0] === w && cur[1] === h) return;
  }
}

async function setZoom(app, factor) {
  await app.evaluate(({ BrowserWindow }, f) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.webContents.setZoomFactor(f);
  }, factor);
  await sleep(400);
}

async function clickIf(loc, timeout = 1200) {
  try {
    const first = loc.first();
    if ((await first.count()) === 0) return false;
    await first.click({ timeout });
    return true;
  } catch {
    return false;
  }
}

const results = [];
let shotSeq = 0;

async function measure(page, app, label, opts = {}) {
  let res;
  try {
    res = await page.evaluate(deepProbe, opts.probe || {});
  } catch (e) {
    res = { error: String(e).slice(0, 200), issues: [], counters: {}, boxes: {}, win: {}, counts: {} };
  }
  res.label = label;
  res.fixture = opts.fixture;
  res.zoom = opts.zoom || 1;
  results.push(res);
  const errs = res.issues.filter((i) => i.sev === 'err').length;
  const warns = res.issues.filter((i) => i.sev === 'warn').length;
  console.log(`  · ${label.padEnd(42)} err=${String(errs).padStart(3)} warn=${String(warns).padStart(3)} ${res.error ? 'ERROR ' + res.error : ''}`);
  if (DO_SHOTS && (errs || warns || SHOTS_ALL)) {
    try {
      await page.evaluate(drawIssueOverlay, res.issues);
      await sleep(100);
      const name = `${String(++shotSeq).padStart(3, '0')}-${label.replace(/[^\w.-]+/g, '_')}.png`;
      await page.screenshot({ path: path.join(SHOT_DIR, name), scale: 'css' });
      await page.evaluate(() => document.getElementById('__acf_deep_overlay')?.remove());
      res.shot = name;
    } catch { /* 截图失败不影响扫描 */ }
  }
  return res;
}

// 页面状态清单：每个状态负责把 UI 摆到目标形态并（必要时）复位。
function statePlan() {
  return [
    // 状态页
    { name: 'status-default', group: 'core', enter: async (p) => { await p.getByRole('tab', { name: L.tabs.status }).click(); await sleep(350); } },
    { name: 'status-log-fullscreen', group: 'core', enter: async (p) => { await p.getByRole('tab', { name: L.tabs.status }).click(); await sleep(250); await clickIf(p.getByRole('button', { name: L.viewLogs })); await sleep(450); } , reset: async (p) => { await p.keyboard.press('Escape'); await sleep(250); } },
    { name: 'status-log-files-search', group: 'full', enter: async (p) => {
      await p.getByRole('tab', { name: L.tabs.status }).click(); await sleep(200);
      await clickIf(p.getByRole('button', { name: L.viewLogs })); await sleep(400);
      await clickIf(p.locator('.log-file-search'));
      await p.locator('.log-file-search').fill('zzz-no-match').catch(() => {});
      await sleep(300);
    }, reset: async (p) => { await p.keyboard.press('Escape'); await sleep(250); } },
    // 历史页
    { name: 'history-default', group: 'core', enter: async (p) => { await p.getByRole('tab', { name: L.tabs.history }).click(); await sleep(450); } },
    { name: 'history-detail', group: 'core', enter: async (p) => {
      await p.getByRole('tab', { name: L.tabs.history }).click(); await sleep(400);
      await clickIf(p.locator('.historyx-run-row')); await sleep(350);
    }, reset: async (p) => { await p.keyboard.press('Escape'); await sleep(200); } },
    { name: 'history-log-overlay', group: 'full', enter: async (p) => {
      await p.getByRole('tab', { name: L.tabs.history }).click(); await sleep(400);
      await clickIf(p.locator('.historyx-run-row').first().getByRole('button', { name: L.viewLogs })); await sleep(500);
    }, reset: async (p) => { await p.keyboard.press('Escape'); await sleep(250); } },
    { name: 'history-filter-failed', group: 'full', enter: async (p) => {
      await p.getByRole('tab', { name: L.tabs.history }).click(); await sleep(400);
      await clickIf(p.locator('.history-filter-chips button', { hasText: L.failed })); await sleep(300);
    }, reset: async (p) => {
      await clickIf(p.locator('.history-filter-chips button', { hasText: L.all })); await sleep(200);
    } },
    { name: 'history-no-match', group: 'full', enter: async (p) => {
      await p.getByRole('tab', { name: L.tabs.history }).click(); await sleep(300);
      await p.locator('.history-search-input').fill('zzzz-no-match').catch(() => {}); await sleep(450);
    }, reset: async (p) => { await p.locator('.history-search-input').fill('').catch(() => {}); await sleep(220); } },
    { name: 'history-menu-open', group: 'full', enter: async (p) => {
      await p.getByRole('tab', { name: L.tabs.history }).click(); await sleep(300);
      await clickIf(p.locator('.historyx-menu-trigger')); await sleep(250);
    }, reset: async (p) => { await p.keyboard.press('Escape'); await sleep(200); } },
    // 应用页（V5 没有视图切换：≥1100px 表格、<1100px 紧凑列表由 CSS 决定，
    // 因此同一状态在宽/窄窗会自动测到两种形态）
    { name: 'apps-table', group: 'core', enter: async (p) => {
      await p.getByRole('tab', { name: L.tabs.apps }).click(); await sleep(450);
    } },
    { name: 'apps-drawer', group: 'core', enter: async (p) => {
      await p.getByRole('tab', { name: L.tabs.apps }).click(); await sleep(450);
      await clickIf(p.locator('.appx-row:visible, .appx-compact-row:visible').first()); await sleep(450);
    }, reset: async (p) => { await p.keyboard.press('Escape'); await sleep(220); } },
    { name: 'apps-drawer-confirm', group: 'full', enter: async (p) => {
      await p.getByRole('tab', { name: L.tabs.apps }).click(); await sleep(450);
      await clickIf(p.locator('.appx-row:visible, .appx-compact-row:visible').first()); await sleep(450);
      const btn = p.locator('.appx-drawer .appx-release-row button[aria-label*="删除"]').last();
      await clickIf(btn); await sleep(300);
    }, reset: async (p) => { await p.keyboard.press('Escape'); await sleep(150); await p.keyboard.press('Escape'); await sleep(220); } },
    { name: 'apps-applog', group: 'full', enter: async (p) => {
      await p.getByRole('tab', { name: L.tabs.apps }).click(); await sleep(450);
      await clickIf(p.locator('.appx-row:visible, .appx-compact-row:visible').first()); await sleep(400);
      await clickIf(p.locator('.appx-drawer').getByRole('button', { name: L.appLog })); await sleep(450);
    }, reset: async (p) => { await p.keyboard.press('Escape'); await sleep(200); await p.keyboard.press('Escape'); await sleep(220); } },
    { name: 'apps-no-match', group: 'full', enter: async (p) => {
      await p.getByRole('tab', { name: L.tabs.apps }).click(); await sleep(300);
      await p.locator('.apps-search input').fill('zzzz-no-match').catch(() => {}); await sleep(400);
    }, reset: async (p) => { await p.locator('.apps-search input').fill('').catch(() => {}); await sleep(220); } },
    // 配置页
    ...['connection', 'network', 'python', 'agent', 'about'].map((slug, idx) => ({
      name: `config-${slug}`,
      group: 'core',
      enter: async (p) => {
        await p.getByRole('tab', { name: L.tabs.config }).click(); await sleep(300);
        if (idx > 0) {
          const labels = L.sections;
          await clickIf(p.getByRole('button', { name: labels[idx] })); await sleep(280);
        }
      },
    })),
    { name: 'config-connection-error', group: 'full', enter: async (p) => {
      await p.getByRole('tab', { name: L.tabs.config }).click(); await sleep(300);
      await clickIf(p.getByRole('button', { name: L.sections[0] })); await sleep(200);
      const input = p.locator('.cfgx-row-control input').first();
      await input.fill('').catch(() => {});
      await input.fill('not-a-url-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx').catch(() => {});
      await sleep(250);
    }, reset: async (p) => {
      // 不 reload：reload 会让主进程重建渲染器并可能触发向导窗口，扫描句柄随之
      // 失效。把输入填回合法值即可（未保存，不落盘）。
      await p.locator('.cfgx-row-control input').first().fill('http://192.168.1.10:3001').catch(() => {});
      await sleep(200);
    } },
  ];
}

async function scanFixture(kind) {
  console.log(`\n════ fixture=${kind} lang=${LANG} ════`);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-deep-user-'));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ uiLanguage: LANG }));
  const workDir = buildFixture(kind);
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: [APP_ENTRY],
    env: { ...process.env, ELECTRON_USER_DATA_DIR: userData },
  });

  try {
    const wizard = await app.firstWindow();
    await wizard.waitForLoadState('domcontentloaded');
    await wizard.getByText(L.welcome).first().waitFor({ timeout: 20000 });

    // 向导 5 步（含空值/校验态；全部用同一窗口真实渲染）。向导窗口可缩放，
    // 每步在默认 660×780 与「矮窄 560×480」各量一次——步骤条/表单在窄窗的
    // 换行与按钮裁切是高频回归点。
    const wLabel = (name, size) => `${kind}/wizard-${size}/${name}`;
    const measureWizard = async (name) => {
      await measure(wizard, app, wLabel(name, '660x780'), { fixture: kind });
      if (STATES === 'all') {
        await setSize(app, wizard, 560, 480);
        await sleep(280);
        await measure(wizard, app, wLabel(name, '560x480'), { fixture: kind });
        await setSize(app, wizard, 660, 780);
        await sleep(260);
      }
    };
    if (STATES === 'all') {
      await measureWizard('step1');
    }
    const next = async () => {
      const btn = wizard.getByRole('button', { name: new RegExp(L.next + '|' + L.start) }).first();
      await clickIf(btn, 2500);
      await sleep(320);
    };
    if (STATES === 'all') {
      await next();
      await measureWizard('step2-empty');
    } else {
      await next();
    }
    await wizard.locator('input.input').first().fill('http://192.168.1.10:3001').catch(() => {});
    await sleep(200);
    if (STATES === 'all') {
      await wizard.locator('input.input').first().fill('http://' + 'x'.repeat(120) + ':3001').catch(() => {});
      await sleep(250);
      await measureWizard('step2-stress');
      await wizard.locator('input.input').first().fill('http://192.168.1.10:3001').catch(() => {});
      await sleep(200);
    }
    await next();
    if (STATES === 'all') await measureWizard('step3-empty');
    await wizard.locator('input.input').first().fill('demo-executor-01-executor-with-a-very-long-name-for-layout').catch(() => {});
    await sleep(200);
    if (STATES === 'all') await measureWizard('step3-stress');
    await next();
    await sleep(300);
    if (STATES === 'all') await measureWizard('step4');
    await next();
    await sleep(300);
    if (STATES === 'all') await measureWizard('step5');

    // 保存（名字回落到正常值，避免把超长名带进主窗）
    await wizard.locator('input.input').first().fill('demo-executor-01').catch(() => {});
    const cfg = await wizard.evaluate(() => window.electronAPI.getConfig());
    const statusReady = app.waitForEvent('window');
    await wizard.evaluate(([config, dir]) => {
      void window.electronAPI.saveAndCloseWizard(Object.assign({}, config, {
        workDir: dir, adminApiUrl: 'http://192.168.1.10:3001', executorName: 'demo-executor-01',
        autoStart: false, autoStartExecutor: false,
      }));
    }, [cfg, workDir]);
    const page = await statusReady;
    await page.waitForLoadState('domcontentloaded');
    await page.getByText(L.logTitle).first().waitFor({ timeout: 20000 });
    await sleep(800);
    if (SELFTEST) await runSelfTest(page);

    // 状态页以外，先确保没有任何浮层残留
    const plan = statePlan().filter((s) => STATES === 'all' || STATES === 'core' ? (STATES === 'core' ? s.group === 'core' : true) : STATES.split(',').includes(s.name));
    for (const size of SIZES) {
      await setSize(app, page, size.w, size.h);
      if (ZOOM !== 1) await setZoom(app, ZOOM);
      console.log(`\n── ${size.name} ──`);
      for (const st of plan) {
        await page.keyboard.press('Escape').catch(() => {});
        await sleep(120);
        try {
          await st.enter(page);
        } catch (e) {
          console.log(`  ! ${st.name} 进入失败: ${String(e).slice(0, 100)}`);
          continue;
        }
        const label = `${kind}${LANG !== 'zh' ? '/' + LANG : ''}/${size.name}${ZOOM !== 1 ? '@' + ZOOM + 'x' : ''}/${st.name}`;
        await measure(page, app, label, { fixture: kind, zoom: ZOOM });
        if (st.reset) {
          await st.reset(page).catch(() => {});
          await sleep(150);
        }
      }

      // 缩放扫描：断点附近逐档量。只在首个尺寸档做一次（横扫 26 档 × 4 页，
      // 每档都要真实 setContentSize，重复到每个高度档会白跑数分钟）。
      if (DO_SWEEP && size === SIZES[0]) {
        await sweepWidths(app, page, kind, size.h);
        await sweepDrawer(app, page, kind);
      }
    }

    // 活体 resize（宽→窄）只在全量模式跑：静态尺寸扫描抓不到「浮层开着被缩窗」
    if (STATES === 'all') {
      console.log('\n── resize scenarios ──');
      await runResizeScenarios(app, page, kind);
    }
    if (STATES === 'all' || STATES === 'update') {
      console.log('── update banner ──');
      await runUpdateBannerScenarios(app, page, kind);
    }
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// 更新横幅（UpdateBanner）四态：只有主进程 updater 事件能点亮它，普通点击
// 到达不了。直接 webContents.send 合成事件，覆盖「可用/下载中/待重启/失败」
// 与展开更新日志（超长 release notes）在宽窄窗下的排版。
async function runUpdateBannerScenarios(app, page, kind) {
  const notes = Array.from({ length: 40 }, (_, i) => `- 修复第 ${i + 1} 项：长文案换行、极端窄窗布局与滚动边界场景调整说明`).join('\n');
  const send = (channel, data) => app.evaluate(({ BrowserWindow }, p) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.webContents.send(p.channel, p.data);
  }, { channel, data });
  const press = async (w, h) => { await setSize(app, page, w, h); await sleep(300); };
  const label = (name) => `${kind}/update-banner/${name}`;

  await page.getByRole('tab', { name: L.tabs.status }).click();
  await sleep(300);

  await send('updater:available', { version: '9.9.9', current: '1.9.4', previouslyDownloaded: false, releaseNotes: notes });
  await sleep(400);
  for (const [w, h] of [[1440, 900], [760, 560]]) {
    await press(w, h);
    await measure(page, app, label(`available-${w}x${h}`), { fixture: kind });
    const summary = page.locator('.update-notes summary').first();
    if (await summary.isVisible().catch(() => false)) {
      await summary.click().catch(() => {});
      await sleep(250);
      await measure(page, app, label(`notes-open-${w}x${h}`), { fixture: kind });
      await summary.click().catch(() => {});
      await sleep(200);
    }
  }

  await send('updater:progress', { percent: 42, transferred: 42 * 1024 * 1024, total: 100 * 1024 * 1024, bytesPerSecond: 1024 * 1024 });
  await sleep(350);
  for (const [w, h] of [[1440, 900], [760, 560]]) {
    await press(w, h);
    await measure(page, app, label(`downloading-${w}x${h}`), { fixture: kind });
  }

  await send('updater:downloaded', { version: '9.9.9' });
  await sleep(350);
  for (const [w, h] of [[1440, 900], [760, 560]]) {
    await press(w, h);
    await measure(page, app, label(`downloaded-${w}x${h}`), { fixture: kind });
  }

  await send('updater:error', { message: '检查更新失败：net::ERR_CONNECTION_RESET（https://github.com/example/autocodeflow/releases/download/desktop-v9.9.9/AutoCodeFlow-9.9.9.AppImage）——请检查代理或稍后重试' });
  await sleep(350);
  for (const [w, h] of [[1440, 900], [760, 560]]) {
    await press(w, h);
    await measure(page, app, label(`error-${w}x${h}`), { fixture: kind });
  }
}

// 抽屉开着横扫宽度：抽屉在 ≥1400 会把页面右移、<1400 覆盖内容。跨 1400
// 断点最容易出现「表格压成 0 宽 / 抽屉压住操作列 / 页面横向溢出」。
async function sweepDrawer(app, page, kind) {
  const widths = [1100, 1200, 1300, 1399, 1400, 1401, 1440, 1600, 1920, 2048];
  await page.getByRole('tab', { name: L.tabs.apps }).click();
  await sleep(300);
  for (const w of widths) {
    await setSize(app, page, w, 640);
    await sleep(260);
    if (!(await page.locator('.appx-drawer').isVisible().catch(() => false))) {
      await clickIf(page.locator('.appx-row:visible, .appx-compact-row:visible').first());
      await sleep(300);
    }
    const res = await page.evaluate(deepProbe, { contrast: false, occlusion: false, maxPerKind: 12 });
    res.label = `${kind}/sweep-drawer${w}x640`;
    res.fixture = kind;
    res.sweep = { w, h: 640, tab: 'apps-drawer' };
    results.push(res);
    const bad = (res.issues || []).filter((i) => i.sev !== 'info').length;
    if (bad) console.log(`  ~ sweep-drawer ${w}x640: warn/err=${bad}`);
  }
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(200);
}

// 缩放中带浮层/抽屉的「活体 resize」：宽窗打开 → 直接缩到最小窗。
// 静态尺寸各测一遍抓不到「浮层宽度写死、缩窗后压住内容/跑出视口」的回归。
async function runResizeScenarios(app, page, kind) {
  const back = async () => { await page.keyboard.press('Escape').catch(() => {}); await sleep(220); };
  const scenario = async (name, open, close) => {
    await setSize(app, page, 1440, 900);
    await sleep(250);
    await open();
    const wide = await measure(page, app, `${kind}/resize/${name}-wide`, { fixture: kind });
    await setSize(app, page, 760, 560);
    await sleep(350);
    await measure(page, app, `${kind}/resize/${name}-narrow`, { fixture: kind });
    await close();
    void wide;
  };
  try {
    await scenario('drawer', async () => {
      await page.getByRole('tab', { name: L.tabs.apps }).click();
      await sleep(400);
      await clickIf(page.locator('.appx-row:visible, .appx-compact-row:visible').first());
      await sleep(400);
    }, back);
    await scenario('log-overlay', async () => {
      await page.getByRole('tab', { name: L.tabs.status }).click();
      await sleep(300);
      await clickIf(page.getByRole('button', { name: L.viewLogs }));
      await sleep(450);
    }, back);
    await scenario('history-detail', async () => {
      await page.getByRole('tab', { name: L.tabs.history }).click();
      await sleep(400);
      await clickIf(page.locator('.historyx-run-row').first());
      await sleep(350);
    }, back);
    await scenario('config-scrolled', async () => {
      await page.getByRole('tab', { name: L.tabs.config }).click();
      await sleep(350);
      await clickIf(page.getByRole('button', { name: L.sections[1] }));
      await sleep(300);
      await page.evaluate(() => {
        const sc = document.querySelector('.cfg-scroll');
        if (sc) sc.scrollTop = sc.scrollHeight;
      });
      await sleep(250);
    }, async () => { /* 无浮层可关 */ });
  } catch (e) {
    console.log(`  ! resize 场景失败: ${String(e).slice(0, 100)}`);
  }
}

// 关键断点附近逐档测：820 / 900 / 1100 / 1400 / 1600 两侧各一档。
async function sweepWidths(app, page, kind, h) {
  const widths = [760, 800, 819, 820, 821, 859, 860, 861, 899, 900, 901, 1023, 1024, 1099, 1100, 1101, 1199, 1200, 1279, 1280, 1399, 1400, 1499, 1600, 1920, 2048];
  const tabs = [
    { name: 'status', enter: async (p) => { await p.getByRole('tab', { name: L.tabs.status }).click(); await sleep(200); } },
    { name: 'history', enter: async (p) => { await p.getByRole('tab', { name: L.tabs.history }).click(); await sleep(220); } },
    { name: 'apps', enter: async (p) => { await p.getByRole('tab', { name: L.tabs.apps }).click(); await sleep(220); } },
    { name: 'config', enter: async (p) => { await p.getByRole('tab', { name: L.tabs.config }).click(); await sleep(220); } },
  ];
  for (const tab of tabs) {
    await tab.enter(page);
    for (const w of widths) {
      await setSize(app, page, w, h);
      const res = await page.evaluate(deepProbe, { contrast: false, occlusion: false, maxPerKind: 12 });
      res.label = `${kind}/sweep${w}x${h}/${tab.name}`;
      res.fixture = kind;
      res.sweep = { w, h, tab: tab.name };
      results.push(res);
      const errs = res.counters && Object.keys(res.counters).length;
      const errKinds = (res.issues || []).filter((i) => i.sev === 'err').length;
      if (errKinds) console.log(`  ~ sweep ${w}x${h} ${tab.name}: err=${errKinds} kinds=${errs}`);
    }
  }
}

// ── 报告 ────────────────────────────────────────────────────────────────────
function writeReport() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'deep.json'), JSON.stringify(results, null, 2));

  const byKind = {};
  const bySev = { err: 0, warn: 0, info: 0 };
  for (const r of results) {
    for (const i of r.issues || []) {
      bySev[i.sev] = (bySev[i.sev] || 0) + 1;
      const k = i.kind;
      if (!byKind[k]) byKind[k] = { err: 0, warn: 0, info: 0, samples: [] };
      byKind[k][i.sev]++;
      if (byKind[k].samples.length < 12) byKind[k].samples.push(`[${r.label}] ${i.path} "${i.text}" ${i.detail}`);
    }
  }
  const lines = [];
  lines.push(`UI 深度扫描 — ${new Date().toISOString()}`);
  lines.push(`lang=${LANG} states=${results.length}  err=${bySev.err} warn=${bySev.warn} info=${bySev.info}${selfTestFailed ? '  ⚠ 探针自检失败（结果不可信）' : ''}`);
  lines.push('');
  lines.push('── 按类型汇总 ──');
  for (const [k, v] of Object.entries(byKind).sort((a, b) => (b[1].err + b[1].warn) - (a[1].err + a[1].warn))) {
    lines.push(`${k.padEnd(22)} err=${String(v.err).padStart(4)} warn=${String(v.warn).padStart(4)} info=${String(v.info).padStart(4)}`);
  }
  lines.push('');
  lines.push('── 明细（仅 err/warn，按状态）──');
  for (const r of results) {
    const bad = (r.issues || []).filter((i) => i.sev !== 'info');
    if (!bad.length) continue;
    lines.push(`\n### ${r.label}  win=${r.win && r.win.w}x${r.win && r.win.h}`);
    for (const i of bad) lines.push(`  [${i.sev.toUpperCase()}] ${i.kind.padEnd(18)} ${i.path} "${i.text}" — ${i.detail}`);
  }
  lines.push('\n── 各类样本 ──');
  for (const [k, v] of Object.entries(byKind)) {
    lines.push(`\n## ${k}`);
    for (const s of v.samples) lines.push('  ' + s);
  }
  fs.writeFileSync(path.join(OUT, 'deep-report.txt'), lines.join('\n') + '\n');
  console.log(`\n${lines.slice(0, 40).join('\n')}`);
  console.log(`\nDONE → ${OUT}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (DO_SHOTS) fs.mkdirSync(SHOT_DIR, { recursive: true });
  for (const kind of FIXTURES) {
    // eslint-disable-next-line no-await-in-loop
    await scanFixture(kind);
  }
  writeReport();
  if (selfTestFailed) process.exit(2);
  if (FAIL_ON === 'err' || FAIL_ON === 'warn') {
    const bad = results.some((r) => (r.issues || []).some((i) => (FAIL_ON === 'err' ? i.sev === 'err' : i.sev !== 'info')));
    if (bad) process.exit(3);
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  writeReport();
  process.exit(1);
});
