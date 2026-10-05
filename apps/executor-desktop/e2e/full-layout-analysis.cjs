// 全面布局分析：测量所有关键元素的几何尺寸，找出布局问题
const { _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_ENTRY = path.join(__dirname, '..', 'dist', 'main', 'index.js');
const ELECTRON_BIN = require('electron');
const OUT = path.join(__dirname, '.layout-analysis');

function mkWorkDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-layout-'));
  const metaDir = path.join(root, 'meta');
  fs.mkdirSync(metaDir, { recursive: true });
  const now = Date.now();
  const MIN = 60_000;
  const records = [
    { executionId: 'e1f0a2b3-c7d8-4e5f-9a01-234567890abc', taskId: 't-1001', taskName: '每日报表生成与汇总推送', startTime: now - 8 * MIN, endTime: now - 5 * MIN, status: 'failed', exitCode: 1, errorMessage: 'python: No module named pandas' },
    { executionId: 'e2f0a2b3-c7d8-4e5f-9a01-234567890abd', taskId: 't-1001', taskName: '每日报表生成与汇总推送', startTime: now - 3 * 60 * MIN, endTime: now - 2 * 60 * MIN, status: 'success', exitCode: 0 },
    { executionId: 'e4f0a2b3-c7d8-4e5f-9a01-234567890abf', taskId: 't-1002', taskName: '库存系统定时对账', startTime: now - 30 * MIN, endTime: now - 28 * MIN, status: 'success', exitCode: 0 },
    { executionId: 'e5f0a2b3-c7d8-4e5f-9a01-234567890ac0', taskId: 't-1002', taskName: '库存系统定时对账', startTime: now - 26 * 60 * MIN, status: 'running' },
  ];
  records.forEach((r, i) => fs.writeFileSync(path.join(metaDir, `meta-${String(i).padStart(4, '0')}.json`), JSON.stringify(r)));
  const appA = path.join(root, 'apps', 'a1b2c3d4-0000-4000-8000-000000000001');
  const relA1 = path.join(appA, 'releases', '1.4.2-3fa1b2c3-0000-4000-8000-00000000000a');
  fs.mkdirSync(relA1, { recursive: true });
  fs.writeFileSync(path.join(appA, 'app.json'), JSON.stringify({ appName: '数据同步机器人', runMode: 'daemon' }));
  return root;
}

function analyzePage(win, pageName, elements) {
  return win.evaluate(([name, els]) => {
    const issues = [];
    const winW = window.innerWidth;
    const winH = window.innerHeight;

    for (const { sel, label, check } of els) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);

      // 检查元素是否超出视口
      if (r.right > winW || r.bottom > winH) {
        issues.push(`[${name}] ${label}: 超出视口 (${Math.round(r.right)}x${Math.round(r.bottom)} vs ${winW}x${winH})`);
      }

      // 检查元素是否过宽（超过父容器）
      if (r.width > winW * 0.95) {
        issues.push(`[${name}] ${label}: 过宽 (${Math.round(r.width)}px, 视口 ${winW}px)`);
      }

      // 检查文本是否溢出
      if (el.scrollWidth > el.clientWidth && !el.classList.contains('log-viewer')) {
        issues.push(`[${name}] ${label}: 文本溢出 (scrollWidth=${el.scrollWidth} > clientWidth=${el.clientWidth})`);
      }
    }

    // 检查页面级留白（用主内容区的最后一个可见子元素）
    const main = document.querySelector('.main-content');
    if (main) {
      // 找到当前激活的 tab-panel
      const activePanel = main.querySelector('.tab-panel.is-active');
      if (activePanel) {
        const panelRect = activePanel.getBoundingClientRect();
        const panelChildren = Array.from(activePanel.children);
        if (panelChildren.length > 0) {
          const lastChild = panelChildren[panelChildren.length - 1];
          const lastR = lastChild.getBoundingClientRect();
          const bottomGap = winH - lastR.bottom;
          if (bottomGap > winH * 0.3 && bottomGap < winH) {
            issues.push(`[${name}] 页面底部留白过大: ${Math.round(bottomGap)}px (${Math.round(bottomGap/winH*100)}%)`);
          }
        }
      }
    }

    return issues;
  }, [pageName, elements]);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-layout-user-'));
  const workDir = mkWorkDir();
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: [APP_ENTRY],
    env: { ...process.env, ELECTRON_USER_DATA_DIR: userData },
  });

  const report = [];
  const log = (s) => { report.push(s); console.log(s); };

  try {
    const wizard = await app.firstWindow();
    await wizard.waitForLoadState('domcontentloaded');
    await wizard.getByText('欢迎使用').first().waitFor({ timeout: 20000 });

    // 向导页分析
    log('\n=== 向导页 ===');
    const wizardIssues = await analyzePage(wizard, '向导', [
      { sel: '.wizard', label: '向导容器' },
      { sel: '.wizard-hero', label: '品牌hero' },
      { sel: '.wizard-features', label: '功能列表' },
      { sel: '.wizard-actions', label: '操作区' },
    ]);
    wizardIssues.forEach(log);

    const cfg = await wizard.evaluate(() => window.electronAPI.getConfig());
    const statusReady = app.waitForEvent('window');
    await wizard.evaluate(([config, dir]) => {
      void window.electronAPI.saveAndCloseWizard({ ...config, workDir: dir, adminApiUrl: 'http://192.168.1.10:3001', executorName: 'demo-executor-01', autoStart: false, autoStartExecutor: false });
    }, [cfg, workDir]);
    const status = await statusReady;
    await status.waitForLoadState('domcontentloaded');
    await status.getByText('运行日志').first().waitFor({ timeout: 20000 });

    const winSize = await status.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    log(`\n=== 窗口尺寸: ${winSize.w} x ${winSize.h} ===`);

    // 状态页分析
    log('\n=== 状态页 ===');
    const statusIssues = await analyzePage(status, '状态', [
      { sel: '.hero-card', label: '状态横幅' },
      { sel: '.status-body', label: '主体双栏' },
      { sel: '.log-section', label: '日志区' },
      { sel: '.log-viewer', label: '日志查看器' },
    ]);
    statusIssues.forEach(log);

    // 各元素间距测量
    const statusGaps = await status.evaluate(() => {
      const hero = document.querySelector('.hero-card');
      const body = document.querySelector('.status-body');
      const logSec = document.querySelector('.log-section');
      if (!hero || !body || !logSec) return null;
      return {
        heroToOverview: Math.round(body.getBoundingClientRect().top - hero.getBoundingClientRect().bottom),
        overviewToLog: Math.round(logSec.getBoundingClientRect().top - body.getBoundingClientRect().top),
      };
    });
    log(`  状态横幅 -> 概览卡: ${statusGaps.heroToOverview}px`);
    log(`  概览卡 -> 日志区: ${statusGaps.overviewToLog}px`);

    // 配置页分析
    log('\n=== 配置页 ===');
    await status.getByRole('tab', { name: '配置' }).click();
    await status.waitForTimeout(400);
    const cfgIssues = await analyzePage(status, '配置', [
      { sel: '.cfg-layout', label: '配置布局' },
      { sel: '.cfg-nav', label: '侧边导航' },
      { sel: '.cfg-scroll-inner', label: '表单内容区' },
      { sel: '.cfg-footer', label: '底部保存栏' },
    ]);
    cfgIssues.forEach(log);

    // 历史页分析
    log('\n=== 历史页 ===');
    await status.getByRole('tab', { name: '历史' }).click();
    await status.waitForTimeout(500);
    const historyIssues = await analyzePage(status, '历史', [
      { sel: '.history-page', label: '历史页容器' },
      { sel: '.history-toolbar', label: '工具栏' },
      { sel: '.history-filters', label: '筛选区' },
      { sel: '.history-groups', label: '分组列表' },
    ]);
    historyIssues.forEach(log);

    // 历史页分组详情
    const historyGroups = await status.evaluate(() => {
      const groups = Array.from(document.querySelectorAll('.history-group'));
      return groups.map((g, i) => {
        const r = g.getBoundingClientRect();
        const header = g.querySelector('.history-group-header');
        const meta = g.querySelector('.history-group-meta');
        return {
          i,
          w: Math.round(r.width),
          h: Math.round(r.height),
          expanded: g.classList.contains('expanded'),
          headerW: header ? Math.round(header.getBoundingClientRect().width) : null,
          metaW: meta ? Math.round(meta.getBoundingClientRect().width) : null,
        };
      });
    });
    log('  历史分组详情:');
    historyGroups.forEach(g => {
      log(`    组${g.i}: ${g.w}x${g.h} ${g.expanded ? '[展开]' : ''} header=${g.headerW} meta=${g.metaW}`);
    });

    // 应用页分析
    log('\n=== 应用页 ===');
    await status.getByRole('tab', { name: '应用' }).click();
    await status.waitForTimeout(500);
    const appsIssues = await analyzePage(status, '应用', [
      { sel: '.apps-page', label: '应用页容器' },
      { sel: '.apps-toolbar', label: '工具栏' },
      { sel: '.apps-controls', label: '控制区' },
      { sel: '.apps-list', label: '应用列表' },
    ]);
    appsIssues.forEach(log);

    // 展开应用分析
    await status.getByRole('button', { name: /数据同步机器人/ }).first().click();
    await status.waitForTimeout(300);
    const appDetailIssues = await analyzePage(status, '应用展开', [
      { sel: '.app-group-card.expanded', label: '展开的应用卡片' },
      { sel: '.app-group-tools', label: '应用工具区' },
      { sel: '.app-group-path', label: '路径芯片' },
    ]);
    appDetailIssues.forEach(log);

    fs.writeFileSync(path.join(OUT, 'full-layout-report.txt'), report.join('\n'));
    console.log('\n完整布局报告已保存');
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exit(1); });
