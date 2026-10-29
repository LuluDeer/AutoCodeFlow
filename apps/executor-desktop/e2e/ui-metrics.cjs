// UI 量化审计：不看截图“感觉”，直接读真实渲染后的 DOM 几何与样式。
//
// 输出（e2e/.metrics/）：
//   metrics.json     每个页面/尺寸一行的结构化指标
//   metrics.txt      人读摘要
//   *-overlay.png    8px 网格 + 关键容器描边的标注截图
//
// 指标口径：
//   coverage       内容区域 8px 网格中被「有文字/控件/底色/描边」的叶子节点覆盖的比例
//   contentBox     叶子节点联合包围盒；rightVoid/bottomVoid = 区域右/下缘到内容包围盒的空隙
//   density        每 10 万 CSS px² 的字符数 / 叶子节点数
//   typography     可见文本的字号直方图与种类数（层级是否过多）
//   boundaries     有描边/阴影/圆角的元素数 + 最大嵌套层数（卡片套卡片）
//   alignment      出现频次最高的左边缘；offGrid = 不在 4px 网格上的高频边缘数
//   rowGaps        配置页「标签右缘 → 控件左缘」的间距分布
//   truncated      无省略号的文本裁切
//   lowContrast    文本与最近不透明祖先背景的对比度 < 4.5
//
// 用法：node e2e/ui-metrics.cjs [--sizes=760x560,1440x900,1920x1080]
const { _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_ENTRY = path.join(__dirname, '..', 'dist', 'main', 'index.js');
const ELECTRON_BIN = require('electron');
const OUT = path.join(__dirname, '.metrics');
const argv = process.argv.slice(2);
const argOf = (k) => {
  const hit = argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : null;
};
const SIZES = (argOf('sizes')
  ? argOf('sizes').split(',')
  : ['760x560', '1024x700', '1440x900', '1920x1080']
).map((s) => {
  const [w, h] = s.split('x').map(Number);
  return { w, h, name: s };
});

function mkWorkDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-metrics-'));
  const metaDir = path.join(root, 'meta');
  fs.mkdirSync(metaDir, { recursive: true });
  const now = Date.now();
  const MIN = 60_000;
  const longName = '跨境电商订单对账与发票归档批处理（华东节点）';
  const taskNames = [
    '每日报表生成与汇总推送',
    longName,
    '库存系统定时对账',
    '客户资料增量同步（CRM → 数据仓库）',
    '夜间全量索引重建',
    '财务凭证同步',
    '邮件通知派发',
    '舆情监控采集',
    '数据库备份校验',
  ];
  const longError = 'python: No module named pandas —— 解释器 3.11 准备失败：下载超时（registry.npmmirror.com 连接被重置），请检查网络或改用离线包';
  const records = [];
  for (let i = 0; i < 30; i++) {
    const task = taskNames[i % taskNames.length];
    const status = i === 3 ? 'running' : i % 7 === 0 ? 'failed' : i % 11 === 0 ? 'running' : 'success';
    const start = now - i * 43 * MIN - (i % 3) * 3 * 60 * MIN;
    records.push({
      executionId: `e${String(i).padStart(3, '0')}a2b3-c7d8-4e5f-9a01-234567890abc`,
      taskId: `t-${1001 + (i % taskNames.length)}`,
      taskName: task,
      startTime: i === 5 ? undefined : start,
      endTime: status === 'running' ? undefined : start + (2 + (i % 17)) * MIN,
      status,
      exitCode: status === 'failed' ? (i % 3) : status === 'success' ? 0 : undefined,
      errorMessage: status === 'failed' ? (i % 2 === 0 ? longError : 'HTTP 502 Bad Gateway: upstream connect error or disconnect/reset before headers') : undefined,
    });
  }
  // 僵死运行（>6h 无终态，历史页会染黄）与跨日期桶样本
  records.push({ executionId: 'stale-a2b3-c7d8-4e5f-9a01-234567890abc', taskId: 't-9001', taskName: '月度经营分析报表', startTime: now - 7 * 60 * MIN, status: 'running' });
  records.push({ executionId: 'old0-a2b3-c7d8-4e5f-9a01-234567890abc', taskId: 't-9002', taskName: '供应商结算单生成', startTime: now - 5 * 24 * 60 * MIN, endTime: now - 5 * 24 * 60 * MIN + 40 * 1000, status: 'failed', exitCode: 1 });
  records.forEach((r, i) => fs.writeFileSync(path.join(metaDir, `meta-${String(i).padStart(4, '0')}.json`), JSON.stringify(r)));
  // 执行日志分片：workDir/logs/YYYY-MM-DD/<executionId>.log（与主进程解析口径一致），
  // 让历史页的“查看日志”浮层有真实内容可测，而不是空态。
  const logsBase = path.join(root, 'logs');
  const pad = (n) => String(n).padStart(2, '0');
  for (const r of records) {
    if (!r.startTime) continue;
    const d = new Date(r.startTime);
    const dateDir = path.join(logsBase, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    fs.mkdirSync(dateDir, { recursive: true });
    const lines = Array.from({ length: 60 }, (_, j) => {
      const level = j === 20 ? 'WARN' : j === 40 ? 'ERROR' : 'INFO';
      return `${new Date(r.startTime + j * 1000).toISOString()} [${level}] [23fb6898] ${r.taskName} step ${j} rows=${100 + j} elapsed=${120 + j}ms`;
    });
    fs.writeFileSync(path.join(dateDir, `${r.executionId}.log`), lines.join('\n'));
  }

  const log = Array.from({ length: 40 }, (_, i) => `2026-10-20T06:12:${String(i).padStart(2, '0')}.000Z [INFO] [23fb6898] sync batch #${i} done`);
  const defs = [
    { id: 'a1b2c3d4-0000-4000-8000-000000000001', name: '数据同步机器人', runMode: 'daemon', versions: 3, log: true, current: true },
    { id: 'b1b2c3d4-0000-4000-8000-000000000002', name: longName, runMode: 'cron', versions: 2, log: false, current: false },
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
        fs.symlinkSync(
          path.join(appDir, 'releases', versions[versions.length - 1]),
          path.join(appDir, 'current'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch { /* current 软链失败不阻断指标采集 */ }
    }
  }
  return root;
}

const METRICS = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const boxOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) };
  };
  const cls = (el) => (typeof el.className === 'string' && el.className ? el.className : el.tagName).split(/\s+/).slice(0, 2).join('.');
  const txt = (el) => (el.textContent || '').trim();
  const active = document.querySelector('.tab-panel.is-active') || document.body;
  const page = active.id || 'unknown';

  const selectors = {
    'config-panel': ['.cfg-nav', '.cfg-scroll-inner', '.cfgx-panel', '.cfgx-group', '.cfgx-effective', '.cfgx-row', '.cfgx-row-label', '.cfgx-row-control', '.cfg-footer', '.cfg-aside', '.cfgx-matrix'],
    'apps-panel': ['.apps-controls', '.apps-list', '.appx-table-wrap', '.appx-table', '.appx-row', '.appx-drawer', '.appx-compact-list', '.appx-compact-row'],
    'history-panel': ['.history-filters', '.history-groups', '.history-date-header', '.history-group', '.history-group-header', '.history-runs', '.history-run-row', '.history-run-id', '.log-fullscreen'],
  }[page] || [];
  const boxes = {};
  for (const s of selectors) {
    const el = document.querySelector(s);
    if (el) boxes[s] = boxOf(el);
  }

  const logOverlay = document.querySelector('.log-fullscreen');
  const region = logOverlay || document.querySelector(
    page === 'config-panel' ? '.cfg-scroll-inner'
      : page === 'history-panel' ? '.history-groups'
        : '.apps-list',
  ) || active;
  const rb = boxOf(region);
  const all = [...region.querySelectorAll('*')].filter(vis);
  const leaves = all.filter((el) => {
    const kids = [...el.children].filter(vis);
    return kids.length === 0 || ['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'IMG', 'SVG'].includes(el.tagName);
  });

  const G = 8;
  const cols = Math.max(1, Math.ceil(rb.w / G));
  const rows = Math.max(1, Math.ceil(rb.h / G));
  const covered = new Set();
  let ux0 = Infinity, uy0 = Infinity, ux1 = -Infinity, uy1 = -Infinity;
  for (const el of leaves) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const hasPaint = txt(el).length > 0
      || ['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'IMG', 'SVG', 'CANVAS'].includes(el.tagName)
      || cs.backgroundColor !== 'rgba(0, 0, 0, 0)'
      || parseFloat(cs.borderTopWidth) > 0
      || cs.boxShadow !== 'none';
    if (hasPaint && r.width > 1 && r.height > 1) {
      ux0 = Math.min(ux0, r.x); uy0 = Math.min(uy0, r.y);
      ux1 = Math.max(ux1, r.right); uy1 = Math.max(uy1, r.bottom);
      const x0 = Math.max(0, Math.floor((r.x - rb.x) / G));
      const x1 = Math.min(cols - 1, Math.ceil((r.right - rb.x) / G) - 1);
      const y0 = Math.max(0, Math.floor((r.y - rb.y) / G));
      const y1 = Math.min(rows - 1, Math.ceil((r.bottom - rb.y) / G) - 1);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) covered.add(y * cols + x);
    }
  }
  const contentBox = Number.isFinite(ux0)
    ? { x: +ux0.toFixed(1), y: +uy0.toFixed(1), w: +(ux1 - ux0).toFixed(1), h: +(uy1 - uy0).toFixed(1), right: +ux1.toFixed(1), bottom: +uy1.toFixed(1) }
    : null;

  let chars = 0, textEls = 0;
  const fontHist = {};
  const colorHist = {};
  const truncated = [];
  for (const el of leaves) {
    const t = txt(el);
    if (t) { chars += t.length; textEls++; }
    if (el.children.length === 0 && t.length > 0) {
      const cs = getComputedStyle(el);
      fontHist[cs.fontSize] = (fontHist[cs.fontSize] || 0) + 1;
      colorHist[cs.color] = (colorHist[cs.color] || 0) + 1;
      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
        const cs2 = getComputedStyle(el);
        if (cs2.textOverflow !== 'ellipsis' && cs2.overflowX !== 'auto' && cs2.overflowX !== 'scroll') {
          truncated.push({ cls: cls(el), scroll: el.scrollWidth, client: el.clientWidth, text: t.slice(0, 40) });
        }
      }
    }
  }

  let bordered = 0, shadowed = 0, rounded = 0, maxBorderDepth = 0;
  for (const el of all) {
    const cs = getComputedStyle(el);
    const b = parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0;
    const sh = cs.boxShadow !== 'none';
    const rd = parseFloat(cs.borderRadius) > 0;
    if (b) bordered++;
    if (sh) shadowed++;
    if (rd) rounded++;
    if (b || sh) {
      let d = 0, p = el;
      while (p && p !== active) {
        const pcs = getComputedStyle(p);
        if (parseFloat(pcs.borderTopWidth) > 0 || pcs.boxShadow !== 'none') d++;
        p = p.parentElement;
      }
      maxBorderDepth = Math.max(maxBorderDepth, d);
    }
  }

  const edges = {};
  for (const el of leaves) {
    const r = el.getBoundingClientRect();
    if (r.width < 4) continue;
    const k = Math.round(r.x);
    edges[k] = (edges[k] || 0) + 1;
  }
  const topEdges = Object.entries(edges).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([x, n]) => ({ x: +x, n }));
  const offGrid = topEdges.filter((e) => e.x % 4 !== 0).length;

  const rowGaps = [];
  const controlFill = [];
  for (const row of active.querySelectorAll('.cfgx-row')) {
    const l = row.querySelector('.cfgx-row-label');
    const c = row.querySelector('.cfgx-row-control');
    if (!l || !c) continue;
    const lr = l.getBoundingClientRect();
    const cr = c.getBoundingClientRect();
    rowGaps.push(Math.round(cr.x - lr.right));
    const input = c.querySelector('input,select,textarea');
    if (input) {
      const cw = cr.width;
      const iw = input.getBoundingClientRect().width;
      if (cw > 0) controlFill.push({ control: Math.round(cw), input: Math.round(iw), ratio: +(iw / cw).toFixed(2) });
    }
  }

  const gapHist = {};
  for (const parent of active.querySelectorAll('.cfgx-panel,.cfgx-group,.apps-list,.cfgx-effective,.appx-drawer')) {
    const kids = [...parent.children].filter(vis);
    for (let i = 1; i < kids.length; i++) {
      const a = kids[i - 1].getBoundingClientRect();
      const b = kids[i].getBoundingClientRect();
      const g = Math.round(b.y - a.bottom);
      if (g >= 0 && g < 80) gapHist[g] = (gapHist[g] || 0) + 1;
    }
  }

  const primaryActions = [...active.querySelectorAll('.btn-primary,.btn-success')].filter(vis).length;
  const ACCENTS = ['rgb(21, 128, 61)', 'rgb(22, 163, 74)', 'rgb(220, 38, 38)', 'rgb(217, 119, 6)', 'rgb(37, 99, 235)', 'rgb(147, 51, 234)'];
  const accentCount = {};
  for (const el of leaves) {
    const c = getComputedStyle(el).color;
    if (ACCENTS.includes(c)) accentCount[c] = (accentCount[c] || 0) + 1;
  }

  const parse = (s) => {
    const m = s.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/);
    return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
  };
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const over = (fg, bg) => {
    const a = fg[3];
    return [
      Math.round(fg[0] * a + bg[0] * (1 - a)),
      Math.round(fg[1] * a + bg[1] * (1 - a)),
      Math.round(fg[2] * a + bg[2] * (1 - a)),
    ];
  };
  // 半透明底色必须先与祖先底合成再算对比度；否则 rgba(15,23,42,.05)
  // 会被当成深色实底，code/disabled 按钮会报出假阳性（2.06 / 1.34）。
  const bgOf = (el) => {
    const stack = [];
    let p = el;
    while (p) {
      const cs = getComputedStyle(p);
      const c = parse(cs.backgroundColor);
      if (c && c[3] > 0) {
        stack.push(c);
        if (c[3] >= 0.999) break;
      }
      p = p.parentElement;
    }
    let bg = [255, 255, 255];
    for (let i = stack.length - 1; i >= 0; i--) bg = over(stack[i], bg);
    return bg;
  };
  const lowContrast = [];
  for (const el of leaves) {
    if (el.children.length) continue;
    const t = txt(el);
    if (t.length < 2) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg || fg[3] === 0) continue;
    const bg = bgOf(el);
    const ratio = contrast(fg[3] >= 0.999 ? fg : over(fg, bg), bg);
    if (ratio < 4.5) lowContrast.push({ cls: cls(el), ratio: +ratio.toFixed(2), text: t.slice(0, 24) });
  }

  const firstCompact = document.querySelector('.appx-compact-row');
  const compactInfo = firstCompact ? {
    box: boxOf(firstCompact),
    textChars: txt(firstCompact).length,
    leaves: [...firstCompact.querySelectorAll('*')].filter(vis).length,
    text: txt(firstCompact).replace(/\s+/g, ' ').slice(0, 120),
  } : null;

  const area = Math.max(1, rb.w * rb.h);
  return {
    page,
    win: { w: window.innerWidth, h: window.innerHeight },
    region: rb,
    contentBox,
    rightVoid: contentBox ? +(rb.right - contentBox.right).toFixed(1) : null,
    bottomVoid: contentBox ? +(rb.bottom - contentBox.bottom).toFixed(1) : null,
    coverage: +((covered.size / (cols * rows)) * 100).toFixed(1),
    density: {
      chars,
      textEls,
      leaves: leaves.length,
      charsPer100k: +((chars / area) * 100000).toFixed(0),
      leavesPer100k: +((leaves.length / area) * 100000).toFixed(1),
    },
    typography: { fontHist, distinctSizes: Object.keys(fontHist).length },
    colors: { colorHist, accentCount, distinctTextColors: Object.keys(colorHist).length },
    boundaries: { bordered, shadowed, rounded, maxBorderDepth },
    alignment: { topEdges, offGrid },
    rowGaps: rowGaps.slice(0, 24),
    controlFill: controlFill.slice(0, 24),
    gapHist,
    primaryActions,
    truncated: truncated.slice(0, 10),
    lowContrast: lowContrast.slice(0, 10),
    compactInfo,
    boxes,
  };
};

// 8px 网格 + 关键容器描边：让“边界/对齐/内容填充”肉眼可核。
const OVERLAY = () => {
  const old = document.getElementById('__acf_metrics_overlay');
  if (old) old.remove();
  const layer = document.createElement('div');
  layer.id = '__acf_metrics_overlay';
  layer.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;';
  const grid = document.createElement('div');
  grid.style.cssText = 'position:absolute;inset:0;background-image:linear-gradient(to right,rgba(0,120,255,.10) 1px,transparent 1px),linear-gradient(to bottom,rgba(0,120,255,.10) 1px,transparent 1px);background-size:8px 8px;';
  layer.appendChild(grid);
  const colors = [['#ff3b30', 2], ['#ff9500', 2], ['#34c759', 2], ['#5856d6', 2], ['#00c7be', 1]];
  ['.cfg-nav', '.cfg-scroll-inner', '.cfgx-panel', '.cfgx-row', '.cfgx-row-label', '.cfgx-row-control', '.cfgx-effective', '.apps-controls', '.apps-list', '.appx-table-wrap', '.appx-row', '.appx-drawer', '.appx-compact-row', '.history-filters', '.history-groups', '.history-group', '.history-group-header', '.history-run-row'].forEach((sel, i) => {
    document.querySelectorAll(sel).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      const d = document.createElement('div');
      const [c, w] = colors[i % colors.length];
      d.style.cssText = `position:absolute;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;border:${w}px solid ${c};box-sizing:border-box;`;
      layer.appendChild(d);
    });
  });
  document.body.appendChild(layer);
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-metrics-user-'));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ uiLanguage: 'zh' }));
  const workDir = mkWorkDir();
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: [APP_ENTRY],
    env: { ...process.env, ELECTRON_USER_DATA_DIR: userData },
  });
  const rows = [];
  const lines = [];
  const log = (s) => { lines.push(s); };
  const setSize = async (w, h, page) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await app.evaluate(({ BrowserWindow }, { w, h }) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win) return;
        if (win.isMaximized()) win.unmaximize();
        win.setContentSize(w, h);
      }, { w, h });
      await new Promise((r) => setTimeout(r, 350));
      if (!page) return;
      const cur = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
      if (cur[0] === w && cur[1] === h) return;
    }
  };
  const measure = async (page, label) => {
    const res = await page.evaluate(METRICS);
    res.label = label;
    rows.push(res);
    log(`\n### ${label}  ${res.win.w}x${res.win.h}`);
    log(`  region=${JSON.stringify(res.region)} content=${JSON.stringify(res.contentBox)} rightVoid=${res.rightVoid} bottomVoid=${res.bottomVoid}`);
    log(`  coverage=${res.coverage}%  density=${JSON.stringify(res.density)}`);
    log(`  typography=${JSON.stringify(res.typography.fontHist)} (${res.typography.distinctSizes} sizes)`);
    log(`  colors=${JSON.stringify(res.colors.accentCount)} textColors=${res.colors.distinctTextColors}`);
    log(`  boundaries=${JSON.stringify(res.boundaries)} offGrid=${res.alignment.offGrid}`);
    log(`  topEdges=${JSON.stringify(res.alignment.topEdges)}`);
    log(`  rowGaps=${JSON.stringify(res.rowGaps)} controlFill=${JSON.stringify(res.controlFill)} gapHist=${JSON.stringify(res.gapHist)}`);
    log(`  primaryActions=${res.primaryActions}`);
    if (res.truncated.length) log(`  truncated=${JSON.stringify(res.truncated)}`);
    if (res.lowContrast.length) log(`  lowContrast=${JSON.stringify(res.lowContrast)}`);
    if (res.compactInfo) log(`  compactInfo=${JSON.stringify(res.compactInfo)}`);
    log(`  boxes=${JSON.stringify(res.boxes)}`);
    return res;
  };
  const overlayShot = async (page, name) => {
    await page.evaluate(OVERLAY);
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(OUT, name + '-overlay.png'), scale: 'css' });
    await page.evaluate(() => document.getElementById('__acf_metrics_overlay')?.remove());
  };

  try {
    const wizard = await app.firstWindow();
    await wizard.waitForLoadState('domcontentloaded');
    await wizard.getByText('欢迎使用').first().waitFor({ timeout: 20000 });
    const cfg = await wizard.evaluate(() => window.electronAPI.getConfig());
    const statusReady = app.waitForEvent('window');
    await wizard.evaluate(([config, dir]) => {
      void window.electronAPI.saveAndCloseWizard(Object.assign({}, config, {
        workDir: dir, adminApiUrl: 'http://192.168.1.10:3001', executorName: 'demo-executor-01',
        autoStart: false, autoStartExecutor: false,
      }));
    }, [cfg, workDir]);
    const status = await statusReady;
    await status.waitForLoadState('domcontentloaded');
    await status.getByText('运行日志').first().waitFor({ timeout: 20000 });
    await status.waitForTimeout(800);

    for (const size of SIZES) {
      await setSize(size.w, size.h);

      // 配置页：5 个分区（每轮先回连接与身份，避免沿用上一尺寸停留的分区）
      await status.getByRole('tab', { name: '配置' }).click();
      await status.waitForTimeout(300);
      const connBtn = status.getByRole('button', { name: '连接与身份' }).first();
      if (await connBtn.count()) { await connBtn.click(); await status.waitForTimeout(200); }
      await measure(status, `${size.name}/config-connection`);
      await overlayShot(status, `${size.name}-config-connection`);
      for (const [name, slug] of [['网络地址', 'network'], ['Python 运行环境', 'python'], ['Agent（实验性）', 'agent'], ['关于与更新', 'about']]) {
        await status.getByRole('button', { name }).click();
        await status.waitForTimeout(250);
        await measure(status, `${size.name}/config-${slug}`);
      }

      // 历史页：台账 → 选中详情/窄窗抽屉 → 日志浮层 → 失败筛选 → 无结果
      await status.getByRole('tab', { name: '历史' }).click();
      await status.waitForTimeout(500);
      await measure(status, `${size.name}/history-default`);
      await overlayShot(status, `${size.name}-history-default`);
      const histRow = status.locator('.history-run-row').first();
      if (await histRow.isVisible().catch(() => false)) {
        await histRow.click();
        await status.waitForTimeout(350);
        await measure(status, `${size.name}/history-detail`);
        await overlayShot(status, `${size.name}-history-detail`);
        await status.keyboard.press('Escape');
        await status.waitForTimeout(200);
      }
      const histLogBtn = status.getByRole('button', { name: '查看日志' }).first();
      if (await histLogBtn.isVisible().catch(() => false)) {
        await histLogBtn.click();
        await status.waitForTimeout(450);
        await measure(status, `${size.name}/history-log-overlay`);
        await overlayShot(status, `${size.name}-history-log-overlay`);
        await status.keyboard.press('Escape');
        await status.waitForTimeout(250);
      }
      const failChip = status.locator('.history-chip').filter({ hasText: '失败' }).first();
      if (await failChip.isVisible().catch(() => false)) {
        await failChip.click();
        await status.waitForTimeout(300);
        await measure(status, `${size.name}/history-filter-failed`);
        const allChip = status.locator('.history-chip').filter({ hasText: '全部' }).first();
        if (await allChip.isVisible().catch(() => false)) {
          await allChip.click();
          await status.waitForTimeout(250);
        }
      }
      const histSearch = status.locator('.history-search-input');
      if (await histSearch.isVisible().catch(() => false)) {
        await histSearch.fill('zzzz-no-match');
        await status.waitForTimeout(500);
        await measure(status, `${size.name}/history-no-match`);
        await histSearch.fill('');
        await status.waitForTimeout(300);
      }

      // 应用页：先钉回表格视图（视图偏好会写 localStorage，跨尺寸会串）
      await status.getByRole('tab', { name: '应用' }).click();
      await status.waitForTimeout(400);
      const tableBtn = status.getByRole('button', { name: '表格' }).first();
      if (await tableBtn.count()) { await tableBtn.click(); await status.waitForTimeout(250); }
      if (await status.locator('.appx-table').isVisible().catch(() => false)) {
        await measure(status, `${size.name}/apps-table`);
        await overlayShot(status, `${size.name}-apps-table`);
      }

      // 详情抽屉（宽窗表格行；窄窗紧凑行）
      const row = status.locator('.appx-row').first();
      if (await row.isVisible().catch(() => false)) {
        await row.click();
        await status.locator('.appx-drawer').waitFor({ timeout: 5000 });
        await status.waitForTimeout(250);
        await measure(status, `${size.name}/apps-drawer`);
        await overlayShot(status, `${size.name}-apps-drawer`);
        await status.keyboard.press('Escape');
        await status.waitForTimeout(200);
      }

      // 窄窗紧凑列表（<1100px；卡片模式已移除）
      if (await status.locator('.appx-compact-list').isVisible().catch(() => false)) {
        await measure(status, `${size.name}/apps-compact`);
        await overlayShot(status, `${size.name}-apps-compact`);
        const compactRow = status.locator('.appx-compact-row').first();
        if (await compactRow.isVisible().catch(() => false)) {
          await compactRow.click();
          await status.locator('.appx-drawer').waitFor({ timeout: 5000 });
          await status.waitForTimeout(250);
          await measure(status, `${size.name}/apps-compact-drawer`);
          await overlayShot(status, `${size.name}-apps-compact-drawer`);
          await status.keyboard.press('Escape');
          await status.waitForTimeout(200);
        }
      }
    }

    fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(rows, null, 2));
    fs.writeFileSync(path.join(OUT, 'metrics.txt'), lines.join('\n') + '\n');
    console.log(lines.join('\n'));
    console.log('\nDONE → ' + OUT);
  } finally {
    await app.close().catch(() => {});
  }
})();
