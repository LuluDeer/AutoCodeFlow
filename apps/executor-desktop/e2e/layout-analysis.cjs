// 布局分析：用 Playwright 测量实际渲染的几何尺寸，精确定位布局问题
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

function measure(win, selector) {
  return win.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    return {
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height),
      ml: cs.marginLeft, mr: cs.marginRight, mt: cs.marginTop, mb: cs.marginBottom,
      pl: cs.paddingLeft, pr: cs.paddingRight, pt: cs.paddingTop, pb: cs.paddingBottom,
    };
  }, selector);
}

function gap(win, selA, selB) {
  return win.evaluate(([a, b]) => {
    const elA = document.querySelector(a);
    const elB = document.querySelector(b);
    if (!elA || !elB) return null;
    const rA = elA.getBoundingClientRect();
    const rB = elB.getBoundingClientRect();
    return { vertical: Math.round(rB.top - rA.bottom), horizontal: Math.round(rB.left - rA.right) };
  }, [selA, selB]);
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

    const cfg = await wizard.evaluate(() => window.electronAPI.getConfig());
    const statusReady = app.waitForEvent('window');
    await wizard.evaluate(([config, dir]) => {
      void window.electronAPI.saveAndCloseWizard({ ...config, workDir: dir, adminApiUrl: 'http://192.168.1.10:3001', executorName: 'demo-executor-01', autoStart: false, autoStartExecutor: false });
    }, [cfg, workDir]);
    const status = await statusReady;
    await status.waitForLoadState('domcontentloaded');
    await status.getByText('运行日志').first().waitFor({ timeout: 20000 });

    const winSize = await status.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    log(`\n=== 窗口尺寸: ${winSize.w} x ${winSize.h} ===\n`);

    // ── 配置页布局分析 ──
    await status.getByRole('tab', { name: '配置' }).click();
    await status.waitForTimeout(400);

    const cfgNav = await measure(status, '.cfg-nav');
    const cfgBody = await measure(status, '.cfg-body');
    const cfgScroll = await measure(status, '.cfg-scroll');
    const cfgInner = await measure(status, '.cfg-scroll-inner');
    log('配置页:');
    log(`  cfg-nav: x=${cfgNav.x} w=${cfgNav.w}`);
    log(`  cfg-body: x=${cfgBody.x} w=${cfgBody.w}`);
    log(`  cfg-scroll: x=${cfgScroll.x} w=${cfgScroll.w}`);
    log(`  cfg-scroll-inner: x=${cfgInner.x} w=${cfgInner.w} pl=${cfgInner.pl} pr=${cfgInner.pr}`);
    const innerRightGap = cfgScroll.x + cfgScroll.w - (cfgInner.x + cfgInner.w);
    log(`  右侧留白: ${innerRightGap}px`);

    // 网络页卡片间距（精确选择器：对外地址字段 -> 回连模式卡片）
    await status.getByRole('button', { name: '网络地址' }).click();
    await status.waitForTimeout(300);
    const networkGaps = await status.evaluate(() => {
      // 找到包含"对外地址"label 的字段
      const fields = Array.from(document.querySelectorAll('.cfg-field'));
      const addrField = fields.find(el => el.querySelector('.cfg-label')?.textContent === '对外地址');
      const toggleCard = document.querySelector('.cfg-toggle-card');
      const ipPickerField = fields.find(el => el.querySelector('.cfg-label')?.textContent?.includes('本机网卡'));
      const infoBanner = document.querySelector('.info-banner');
      if (!addrField || !toggleCard) return null;
      const r1 = addrField.getBoundingClientRect();
      const r2 = toggleCard.getBoundingClientRect();
      const rIp = ipPickerField?.getBoundingClientRect();
      const rBanner = infoBanner?.getBoundingClientRect();
      return {
        addrToIpPicker: rIp ? Math.round(rIp.top - r1.bottom) : null,
        ipPickerToBanner: rBanner && rIp ? Math.round(rBanner.top - rIp.bottom) : null,
        bannerToToggle: Math.round(r2.top - (rBanner?.bottom || r1.bottom)),
        addrToToggle: Math.round(r2.top - r1.bottom),
      };
    });
    log('  网络页间距:');
    log(`    对外地址 -> 网卡IP选择: ${networkGaps.addrToIpPicker}px`);
    log(`    网卡IP选择 -> 提示横幅: ${networkGaps.ipPickerToBanner}px`);
    log(`    提示横幅 -> 回连模式卡片: ${networkGaps.bannerToToggle}px`);
    log(`    对外地址 -> 回连模式卡片: ${networkGaps.addrToToggle}px`);

    // ── 历史页布局分析 ──
    await status.getByRole('tab', { name: '历史' }).click();
    await status.waitForTimeout(500);
    const groups = await status.evaluate(() => {
      const els = document.querySelectorAll('.history-group');
      return Array.from(els).map((el, i) => {
        const r = el.getBoundingClientRect();
        const expanded = el.classList.contains('expanded');
        return { i, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), expanded };
      });
    });
    log('\n历史页分组:');
    for (const g of groups) {
      log(`  组${g.i}: x=${g.x} y=${g.y} w=${g.w} h=${g.h} ${g.expanded ? '[展开]' : ''}`);
    }
    const groupsContainer = await measure(status, '.history-groups');
    const pageContainer = await measure(status, '.history-page');
    log(`  groups 容器: x=${groupsContainer.x} w=${groupsContainer.w} h=${groupsContainer.h}`);
    log(`  page 容器: x=${pageContainer.x} w=${pageContainer.w} h=${pageContainer.h}`);

    // ── 应用页布局分析 ──
    await status.getByRole('tab', { name: '应用' }).click();
    await status.waitForTimeout(500);
    const appList = await measure(status, '.apps-list');
    const appPage = await measure(status, '.apps-page');
    log('\n应用页:');
    log(`  apps-list: x=${appList.x} w=${appList.w} h=${appList.h}`);
    log(`  apps-page: x=${appPage.x} w=${appPage.w} h=${appPage.h}`);

    // 展开第一个应用
    await status.getByRole('button', { name: /数据同步机器人/ }).first().click();
    await status.waitForTimeout(300);
    const appCards = await status.evaluate(() => {
      const els = document.querySelectorAll('.app-group-card');
      return Array.from(els).map((el, i) => {
        const r = el.getBoundingClientRect();
        return { i, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      });
    });
    log('  应用卡片:');
    for (const c of appCards) {
      log(`    卡片${c.i}: x=${c.x} y=${c.y} w=${c.w} h=${c.h}`);
    }

    fs.writeFileSync(path.join(OUT, 'layout-report.txt'), report.join('\n'));
    console.log('\n布局报告已保存到', path.join(OUT, 'layout-report.txt'));
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exit(1); });
