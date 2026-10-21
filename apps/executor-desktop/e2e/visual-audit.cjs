
// 视觉/几何审计：多窗口尺寸 × 全页面截图 + 越界检测
// 用法：node e2e/visual-audit.cjs [--sizes=760x560,1024x700] [--only=status,history]
const { _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_ENTRY = path.join(__dirname, '..', 'dist', 'main', 'index.js');
const ELECTRON_BIN = require('electron');
const OUT = path.join(__dirname, '.visual');
const argv = process.argv.slice(2);
const argOf = (k) => {
  const hit = argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : null;
};
const ONLY = argOf('only') ? argOf('only').split(',') : null;
const LANG = argOf('lang') || 'zh';
const TAG = argOf('tag') || '';
const SCENARIO = argOf('scenario') || 'rich';
const zhLike = (zh, en) => new RegExp(LANG === 'zh' ? zh : en);
const SIZES = (argOf('sizes')
  ? argOf('sizes').split(',')
  : ['760x560', '900x620', '1024x700', '1280x800', '1440x900', '1920x1080', '2560x1440']
).map((s) => {
  const [w, h] = s.split('x').map(Number);
  return { w, h, name: s };
});

function mkWorkDir(empty) {
  if (empty) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-visual-'));
    fs.mkdirSync(path.join(root, 'meta'), { recursive: true });
    fs.mkdirSync(path.join(root, 'apps'), { recursive: true });
    return root;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-visual-'));
  const metaDir = path.join(root, 'meta');
  fs.mkdirSync(metaDir, { recursive: true });
  const now = Date.now();
  const MIN = 60_000;
  const longName = '跨境电商订单对账与发票归档批处理（华东节点）';
  const records = [
    { executionId: 'e1f0a2b3-c7d8-4e5f-9a01-234567890abc', taskId: 't-1001', taskName: longName, startTime: now - 8 * MIN, endTime: now - 5 * MIN, status: 'failed', exitCode: 1, errorMessage: 'python: No module named pandas —— 解释器 3.11 准备失败：下载超时（registry.npmmirror.com 连接被重置），请检查网络或改用离线包' },
    { executionId: 'e2f0a2b3-c7d8-4e5f-9a01-234567890abd', taskId: 't-1001', taskName: longName, startTime: now - 3 * 60 * MIN, endTime: now - 2 * 60 * MIN, status: 'success', exitCode: 0 },
    { executionId: 'e3f0a2b3-c7d8-4e5f-9a01-234567890abe', taskId: 't-1001', taskName: longName, startTime: now - 5 * 60 * MIN, endTime: now - 4 * 60 * MIN, status: 'success', exitCode: 0 },
    { executionId: 'e4f0a2b3-c7d8-4e5f-9a01-234567890abf', taskId: 't-1002', taskName: '库存系统定时对账', startTime: now - 30 * MIN, endTime: now - 28 * MIN, status: 'success', exitCode: 0 },
    { executionId: 'e5f0a2b3-c7d8-4e5f-9a01-234567890ac0', taskId: 't-1002', taskName: '库存系统定时对账', startTime: now - 26 * 60 * MIN, status: 'running' },
    { executionId: 'e6f0a2b3-c7d8-4e5f-9a01-234567890ac1', taskId: 't-1003', taskName: '客户资料增量同步（CRM → 数据仓库）', startTime: now - 20 * MIN, endTime: now - 12 * MIN, status: 'failed', exitCode: 2, errorMessage: 'HTTP 502 Bad Gateway: upstream connect error or disconnect/reset before headers' },
    { executionId: 'e7f0a2b3-c7d8-4e5f-9a01-234567890ac2', taskId: 't-1004', taskName: '月度经营分析报表', startTime: now - 26 * 60 * MIN, endTime: now - 25 * 60 * MIN, status: 'success', exitCode: 0 },
    { executionId: 'e8f0a2b3-c7d8-4e5f-9a01-234567890ac3', taskId: 't-1005', taskName: '供应商结算单生成', startTime: now - 3 * 24 * 60 * MIN, endTime: now - 3 * 24 * 60 * MIN + 40000, status: 'failed', exitCode: 1 },
  ];
  records.forEach((r, i) => fs.writeFileSync(path.join(metaDir, 'meta-' + String(i).padStart(4, '0') + '.json'), JSON.stringify(r)));
  const longLog = Array.from({ length: 60 }, (_, i) => '2026-10-20T06:12:' + String(i).padStart(2, '0') + '.000Z [INFO] [23fb6898-e228-4ca2-8ed4-956758b5d2f0] sync batch #' + i + ' done rows=' + (1000 + i) + ' elapsed=' + (120 + i) + 'ms strategy=upsert-on-conflict target=warehouse.fact_orders_2026 partition=region=cn-east');
  for (let a = 1; a <= 5; a++) {
    const appId = 'a1b2c3d4-0000-4000-8000-00000000000' + a;
    const appA = path.join(root, 'apps', appId);
    const names = ['数据同步机器人', '报表生成服务', longName + '（旧版）', '库存对账守护进程', '客户资料清洗管道'];
    const relA1 = path.join(appA, 'releases', '1.4.2-3fa1b2c3-0000-4000-8000-00000000000a');
    const relA2 = path.join(appA, 'releases', '1.4.3-3fa1b2c3-0000-4000-8000-00000000000b');
    fs.mkdirSync(relA1, { recursive: true });
    fs.mkdirSync(relA2, { recursive: true });
    fs.writeFileSync(path.join(appA, 'app.json'), JSON.stringify({ appName: names[a - 1], runMode: a % 2 ? 'daemon' : 'cron' }));
    fs.writeFileSync(path.join(relA2, 'app.json'), JSON.stringify({ appName: names[a - 1], runMode: a % 2 ? 'daemon' : 'cron' }));
    fs.writeFileSync(path.join(relA2, 'app.log'), longLog.join('\n'));
  }
  return root;
}

const PROBE = (label) => {
  const issues = [];
  const winW = window.innerWidth;
  const winH = window.innerHeight;
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const cls = (el) => (typeof el.className === 'string' && el.className ? el.className : el.tagName).slice(0, 40);
  // 被祖先容器接住的溢出不算越界：
  //  · overflow:hidden/clip —— 显式裁切，任何方向都算被接住；
  //  · overflow:auto/scroll —— 只有**真的横向可滚**（scrollWidth > clientWidth）
  //    才算；否则整页滚动容器（.main-content 是 overflow-y:auto，计算值
  //    overflow-x 也随之变 auto）会吞掉所有判定，探针等于失明。
  const scrollableX = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      if (['hidden', 'clip'].includes(cs.overflowX)) return true;
      if (['auto', 'scroll'].includes(cs.overflowX) && p.scrollWidth > p.clientWidth + 1) return true;
      p = p.parentElement;
    }
    return false;
  };
  // 折叠容器（collapsible 0fr / inert / aria-hidden）里的元素不可见，
  // 其矩形仍是布局尺寸——不参与越界判定。
  const hiddenByCollapse = (el) => Boolean(el.closest('.collapsible[data-open="false"], [inert], [aria-hidden="true"]'));
  document.querySelectorAll('.tab-panel.is-active *').forEach((el) => {
    if (!vis(el)) return;
    if (hiddenByCollapse(el)) return;
    if (el.closest('.log-viewer, .log-fs-content, .log-empty, .skeleton')) return;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    // 1) 横向溢出视口
    if (r.right > winW + 1.5 && !scrollableX(el)) {
      issues.push('overflow-right ' + cls(el) + ' right=' + Math.round(r.right) + '>' + winW);
    }
    if (r.left < -1.5 && cs.position !== 'fixed' && !scrollableX(el)) {
      issues.push('overflow-left ' + cls(el) + ' left=' + Math.round(r.left));
    }
    // 2) 文本被裁剪（无省略号的溢出）
    if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && cs.overflowX !== 'auto' && cs.overflowX !== 'scroll') {
      const hasEll = cs.textOverflow === 'ellipsis';
      const blockChild = Array.from(el.children).some((c) => ['block', 'flex', 'grid'].includes(getComputedStyle(c).display));
      if (!hasEll && !blockChild && (el.textContent || '').trim().length > 2 && el.children.length === 0) {
        issues.push('text-clipped ' + cls(el) + ' scrollW=' + el.scrollWidth + ' clientW=' + el.clientWidth + ' "' + (el.textContent || '').trim().slice(0, 24) + '"');
      }
    }
    // 3) 子元素超出父容器内容区（视觉越界/贴边出血）
    const p = el.parentElement;
    if (p && p !== document.body) {
      const pr = p.getBoundingClientRect();
      const pcs = getComputedStyle(p);
      if (pcs.overflowX === 'visible') {
        if (r.right > pr.right + 2 && r.width > 30 && r.right < winW) {
          issues.push('bleed-right ' + cls(el) + ' > parent ' + cls(p) + ' by ' + Math.round(r.right - pr.right));
        }
      }
    }
  });
  // 4) 交互元素过小
  document.querySelectorAll('.tab-panel.is-active button:not([disabled]), .tab-panel.is-active input, .tab-panel.is-active select').forEach((el) => {
    if (!vis(el)) return;
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.height < 24) issues.push('small-target ' + cls(el) + ' h=' + Math.round(r.height));
  });
  // 5) 关键容器高度
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top), bottom: Math.round(r.bottom) };
  };
  return {
    label,
    win: { w: winW, h: winH },
    docScrollW: document.documentElement.scrollWidth,
    boxes: {
      topbar: box('.topbar'),
      hero: box('.hero-card'),
      today: box('.today-summary'),
      statusBody: box('.status-body'),
      logSection: box('.log-section'),
      side: box('.status-side'),
      pageHeader: box('.page-header'),
      cfgNav: box('.cfg-nav'),
      cfgScrollInner: box('.cfg-scroll-inner'),
      cfgFooter: box('.cfg-footer'),
      historyFilters: box('.history-filters'),
      appsControls: box('.apps-controls'),
      appsList: box('.apps-list'),
      empty: box('.empty-state'),
    },
    issues: Array.from(new Set(issues)).slice(0, 60),
  };
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-visual-user-'));
  // 界面语言钉死（默认 'auto' 会跟随系统语言，本机 navigator.language=zh-CN，
  // 但 CI 上可能是 en——审计必须在确定语言下比较布局）
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ uiLanguage: LANG }));
  const workDir = mkWorkDir(SCENARIO === 'empty');
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: [APP_ENTRY],
    env: { ...process.env, ELECTRON_USER_DATA_DIR: userData },
  });
  const report = [];
  const log = (s) => { report.push(s); };

  const shot = async (win, name) => {
    const p = path.join(OUT, (TAG ? TAG + '-' : '') + name + '.png');
    try { await win.screenshot({ path: p, scale: 'css' }); } catch (e) { log('SCREENSHOT FAIL ' + name + ' ' + e.message); }
  };
  const probe = async (win, label) => {
    const res = await win.evaluate(PROBE, label);
    log('\n### ' + label + '  win=' + res.win.w + 'x' + res.win.h + ' scrollW=' + res.docScrollW);
    log('  boxes=' + JSON.stringify(res.boxes));
    if (res.issues.length) res.issues.forEach((i) => log('  ! ' + i));
    return res;
  };
  const setSize = async (w, h, page) => {
    // 窗口管理器偶尔会拒绝/改写一次 setSize（实测出现过 1440x900 被改成
    // 1613x950），逐次校验 innerWidth 不匹配就再压一次，最多 4 轮。
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

  try {
    const wizard = await app.firstWindow();
    await wizard.waitForLoadState('domcontentloaded');
    await wizard.getByText(zhLike('欢迎使用', 'Welcome')).first().waitFor({ timeout: 20000 });
    // 向导在无 WM/受限桌面下创建尺寸可能被 WM 收窄，显式钉回设计尺寸 660x780
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (w) { if (w.isMaximized()) w.unmaximize(); w.setContentSize(660, 780); w.center(); }
    });
    await wizard.waitForTimeout(500);
    const wizardNext = async (label) => {
      await wizard.getByRole('button', { name: label }).click();
      await wizard.waitForTimeout(260);
      const skip = wizard.getByRole('button', { name: /仍要继续|Continue anyway/ });
      if (await skip.count()) { await skip.click(); await wizard.waitForTimeout(260); }
    };
    await shot(wizard, 'wizard-1-welcome');
    await probe(wizard, 'wizard-1');
    await wizardNext(/开始配置|Start setup/);
    await shot(wizard, 'wizard-2-connect');
    await probe(wizard, 'wizard-2');
    await wizard.locator('input.input').first().fill('http://192.168.1.10:3001');
    await wizard.waitForTimeout(200);
    await wizardNext(/下一步|Next/);
    await shot(wizard, 'wizard-3-executor');
    await probe(wizard, 'wizard-3');
    await wizard.locator('input.input').first().fill('demo-executor-01');
    await wizard.waitForTimeout(200);
    await wizardNext(/下一步|Next/);
    await shot(wizard, 'wizard-4-source');
    await probe(wizard, 'wizard-4');
    await wizardNext(/下一步|Next/);
    await shot(wizard, 'wizard-5-finish');
    await probe(wizard, 'wizard-5');

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
    await status.getByText(/运行日志|Run logs/).first().waitFor({ timeout: 20000 });
    await status.waitForTimeout(900);

    const LBL = LANG === 'zh'
      ? { status: '状态监控', history: '历史', apps: '应用', config: '配置', viewLogs: '查看日志', cancel: '取消', refresh: '刷新', net: '网络地址', py: 'Python 运行环境', agent: 'Agent（实验性）', about: '关于与更新' }
      : { status: 'Status', history: 'History', apps: 'Apps', config: 'Settings', viewLogs: 'View logs', cancel: 'Cancel', refresh: 'Refresh', net: 'Network', py: 'Python', agent: 'Agent', about: 'About & updates' };
    const tabs = [
      ['status', LBL.status, 'status'],
      ['history', LBL.history, 'history'],
      ['apps', LBL.apps, 'apps'],
      ['config', LBL.config, 'config'],
    ];
    for (const size of SIZES) {
      await setSize(size.w, size.h);
      for (const [key, label, slug] of tabs) {
        if (ONLY && !ONLY.includes(slug)) continue;
        await setSize(size.w, size.h, status);
        await status.getByRole('tab', { name: label }).click();
        await status.waitForTimeout(420);
        await shot(status, size.name + '-' + slug);
        await probe(status, size.name + '/' + slug);
      }
    }

    // 关键状态特写（默认尺寸 1440x900）
    await setSize(1440, 900, status);
    if (!ONLY || ONLY.includes('detail')) {
      await status.getByRole('tab', { name: LBL.apps }).click();
      await status.waitForTimeout(400);
      const appToggle = status.getByRole('button', { name: /数据同步机器人/ }).first();
      if (await appToggle.count()) {
        await appToggle.click();
        await status.waitForTimeout(400);
        await shot(status, '1440x900-apps-expanded');
        await probe(status, '1440x900/apps-expanded');
        const delBtn = status.getByRole('button', { name: /删除 v1\.4\.2 的本地部署/ });
        if (await delBtn.count()) {
          await delBtn.click();
          await status.waitForTimeout(300);
          await shot(status, '1440x900-apps-confirm');
          const cancel = status.getByRole('button', { name: LBL.cancel });
          if (await cancel.count()) await cancel.click();
          await status.waitForTimeout(200);
        }
      }

      await status.getByRole('tab', { name: LBL.history }).click();
      await status.waitForTimeout(450);
      const histLog = status.getByRole('button', { name: LBL.viewLogs }).first();
      if (await histLog.count()) {
        await histLog.click();
        await status.waitForTimeout(700);
        await shot(status, '1440x900-history-logviewer');
        await probe(status, '1440x900/history-logviewer');
        await status.keyboard.press('Escape');
        await status.waitForTimeout(250);
      }

      await status.getByRole('tab', { name: LBL.status }).click();
      await status.waitForTimeout(400);
      const statusLog = status.getByRole('button', { name: LBL.viewLogs }).first();
      if (await statusLog.count()) {
        await statusLog.click();
        await status.waitForTimeout(600);
        await shot(status, '1440x900-status-logviewer');
        await probe(status, '1440x900/status-logviewer');
        await status.keyboard.press('Escape');
        await status.waitForTimeout(250);
      }

      // 配置页 5 分区
      await status.getByRole('tab', { name: LBL.config }).click();
      await status.waitForTimeout(400);
      await shot(status, '1440x900-config-connect');
      for (const name of [LBL.net, LBL.py, LBL.agent, LBL.about]) {
        await status.getByRole('button', { name }).click();
        await status.waitForTimeout(350);
        const slug = name.replace(/[^\w\u4e00-\u9fa5]+/g, '');
        await shot(status, '1440x900-config-' + slug);
        await probe(status, '1440x900/config-' + slug);
      }
      // 未保存态（footer 三钮 + 改动清单）
      await status.getByRole('button', { name: LBL.net }).click();
      await status.waitForTimeout(250);
      const firstInput = status.locator('.cfg-main input.input').first();
      if (await firstInput.count()) {
        await firstInput.fill('demo-executor-renamed');
        await status.waitForTimeout(350);
        await shot(status, '1440x900-config-unsaved');
        await probe(status, '1440x900/config-unsaved');
        const diffBtn = status.locator('.cfg-footer button').filter({ hasText: /更改|changes/i }).first();
        if (await diffBtn.count()) {
          await diffBtn.click();
          await status.waitForTimeout(350);
          await shot(status, '1440x900-config-diff');
          await probe(status, '1440x900/config-diff');
        }
      }
    }

    // 窄窗 + 全屏查看器
    await setSize(900, 620, status);
    if (!ONLY || ONLY.includes('detail')) {
      await status.getByRole('tab', { name: LBL.status }).click();
      await status.waitForTimeout(400);
      const viewBtn = status.getByRole('button', { name: LBL.viewLogs }).first();
      if (await viewBtn.count()) await viewBtn.click();
      await status.waitForTimeout(600);
      await shot(status, '900x620-status-logviewer');
      await probe(status, '900x620/status-logviewer');
      await status.keyboard.press('Escape');
    }
    await setSize(760, 560, status);
    if (!ONLY || ONLY.includes('detail')) {
      await status.getByRole('tab', { name: LBL.status }).click();
      await status.waitForTimeout(400);
      await status.getByRole('button', { name: LBL.viewLogs }).click();
      await status.waitForTimeout(600);
      await shot(status, '760x560-status-logviewer');
      await probe(status, '760x560/status-logviewer');
      await status.keyboard.press('Escape');
      await status.getByRole('tab', { name: LBL.config }).click();
      await status.waitForTimeout(350);
      await status.getByRole('button', { name: LBL.agent }).click();
      await status.waitForTimeout(350);
      await shot(status, '760x560-config-agent');
      await probe(status, '760x560/config-agent');

      // 窄窗历史日志查看器（标题可能很长）
      await status.getByRole('tab', { name: LBL.history }).click();
      await status.waitForTimeout(450);
      const hLog = status.getByRole('button', { name: LBL.viewLogs }).first();
      if (await hLog.count()) {
        await hLog.click();
        await status.waitForTimeout(700);
        await shot(status, '760x560-history-logviewer');
        await probe(status, '760x560/history-logviewer');
        await status.keyboard.press('Escape');
        await status.waitForTimeout(250);
      }

      // 窄窗应用展开（路径芯片左截断）
      await status.getByRole('tab', { name: LBL.apps }).click();
      await status.waitForTimeout(400);
      const appToggle2 = status.getByRole('button', { name: /数据同步机器人/ }).first();
      if (await appToggle2.count()) {
        await appToggle2.click();
        await status.waitForTimeout(450);
        await shot(status, '760x560-apps-expanded');
        await probe(status, '760x560/apps-expanded');
      }

      // 窄窗配置未保存 + 改动清单
      await status.getByRole('tab', { name: LBL.config }).click();
      await status.waitForTimeout(350);
      const netBtn = status.getByRole('button', { name: LBL.net }).first();
      if (await netBtn.count()) await netBtn.click();
      await status.waitForTimeout(250);
      const inp = status.locator('.cfg-main input.input').first();
      if (await inp.count()) {
        await inp.fill('demo-renamed');
        await status.waitForTimeout(300);
        await shot(status, '760x560-config-unsaved');
        const dBtn = status.locator('.cfg-footer button').filter({ hasText: /更改|changes/i }).first();
        if (await dBtn.count()) {
          await dBtn.click();
          await status.waitForTimeout(300);
          await shot(status, '760x560-config-diff');
          await probe(status, '760x560/config-diff');
        }
      }
    }

    fs.writeFileSync(path.join(OUT, 'visual-report.txt'), report.join('\n'));
    console.log(report.join('\n'));
    console.log('\n截图目录: ' + OUT);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exit(1); });