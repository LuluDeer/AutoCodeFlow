// 临时视觉验收脚本：启动真实应用，对向导/状态/配置/历史/应用逐页截图。
// 用法：node e2e/screenshots.cjs  （输出到 e2e/.screenshots/）
const { _electron: electron } = require('@playwright/test');
const { test: _t } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_ENTRY = path.join(__dirname, '..', 'dist', 'main', 'index.js');
const ELECTRON_BIN = require('electron');
const OUT = path.join(__dirname, '.screenshots');

function mkWorkDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-shots-work-'));
  const metaDir = path.join(root, 'meta');
  fs.mkdirSync(metaDir, { recursive: true });
  const now = Date.now();
  const MIN = 60_000;
  const records = [
    { executionId: 'e1f0a2b3-c7d8-4e5f-9a01-234567890abc', taskId: 't-1001', taskName: '每日报表生成与汇总推送', startTime: now - 8 * MIN, endTime: now - 5 * MIN, status: 'failed', exitCode: 1, errorMessage: 'python: No module named pandas（解释器 3.11 准备失败：下载超时）' },
    { executionId: 'e2f0a2b3-c7d8-4e5f-9a01-234567890abd', taskId: 't-1001', taskName: '每日报表生成与汇总推送', startTime: now - 3 * 60 * MIN, endTime: now - 2 * 60 * MIN, status: 'success', exitCode: 0 },
    { executionId: 'e3f0a2b3-c7d8-4e5f-9a01-234567890abe', taskId: 't-1001', taskName: '每日报表生成与汇总推送', startTime: now - 5 * 60 * MIN, endTime: now - 4 * 60 * MIN, status: 'success', exitCode: 0 },
    { executionId: 'e4f0a2b3-c7d8-4e5f-9a01-234567890abf', taskId: 't-1002', taskName: '库存系统定时对账', startTime: now - 30 * MIN, endTime: now - 28 * MIN, status: 'success', exitCode: 0 },
    { executionId: 'e5f0a2b3-c7d8-4e5f-9a01-234567890ac0', taskId: 't-1002', taskName: '库存系统定时对账', startTime: now - 26 * 60 * MIN, status: 'running' },
  ];
  records.forEach((r, i) => fs.writeFileSync(path.join(metaDir, `meta-${String(i).padStart(4, '0')}.json`), JSON.stringify(r)));

  // 应用 A：有名字、两个版本、其中一个带 app.log
  const appA = path.join(root, 'apps', 'a1b2c3d4-0000-4000-8000-000000000001');
  const relA1 = path.join(appA, 'releases', '1.4.2-3fa1b2c3-0000-4000-8000-00000000000a');
  const relA2 = path.join(appA, 'releases', '1.4.3-3fa1b2c3-0000-4000-8000-00000000000b');
  fs.mkdirSync(relA1, { recursive: true });
  fs.mkdirSync(relA2, { recursive: true });
  fs.writeFileSync(path.join(appA, 'app.json'), JSON.stringify({ appName: '数据同步机器人', runMode: 'daemon' }));
  fs.writeFileSync(path.join(relA2, 'app.json'), JSON.stringify({ appName: '数据同步机器人', runMode: 'daemon' }));
  fs.writeFileSync(path.join(relA2, 'app.log'), Array.from({ length: 40 }, (_, i) => `2026-09-28T0${i % 10}:12:${String(i).padStart(2, '0')}.000Z [INFO] [23fb6898-e228-4ca2-8ed4-956758b5d2f0] sync batch #${i} done`).join('\n'));
  // 应用 B：旧部署无 app.json（名称未知）、scheduled 模式无日志
  const appB = path.join(root, 'apps', 'b1b2c3d4-0000-4000-8000-000000000002');
  const relB1 = path.join(appB, 'releases', '0.9.0-4fb1b2c3-0000-4000-8000-00000000000c');
  fs.mkdirSync(relB1, { recursive: true });
  return root;
}

(async () => {
  // 只清空 OUT 的内容、不删除根目录本身：OUT 可能正在资源管理器中打开，
  // Windows 下 rmdir 一个「在 Explorer 中打开」的目录会 EBUSY。文件可正常覆盖。
  fs.mkdirSync(OUT, { recursive: true });
  for (const entry of fs.readdirSync(OUT)) {
    fs.rmSync(path.join(OUT, entry), { recursive: true, force: true });
  }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-shots-user-'));
  const workDir = mkWorkDir();
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: [APP_ENTRY],
    env: { ...process.env, ELECTRON_USER_DATA_DIR: userData },
  });
  const shot = async (win, name) => {
    await win.waitForTimeout(400);
    await win.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log('shot:', name);
  };
  try {
    const wizard = await app.firstWindow();
    await wizard.waitForLoadState('domcontentloaded');
    await wizard.getByText('欢迎使用').first().waitFor({ timeout: 20000 });
    await shot(wizard, '01-wizard');

    const cfg = await wizard.evaluate(() => window.electronAPI.getConfig());
    const statusReady = app.waitForEvent('window');
    await wizard.evaluate(([config, dir]) => {
      void window.electronAPI.saveAndCloseWizard({ ...config, workDir: dir, adminApiUrl: 'http://192.168.1.10:3001', executorName: 'demo-executor-01', autoStart: false, autoStartExecutor: false });
    }, [cfg, workDir]);
    const status = await statusReady;
    await status.waitForLoadState('domcontentloaded');
    await status.getByText('运行日志').first().waitFor({ timeout: 20000 });
    await shot(status, '02-status');

    // 全屏日志查看器
    await status.getByRole('button', { name: '查看日志' }).click();
    await shot(status, '03-log-viewer');
    await status.keyboard.press('Escape');

    // 配置页 5 个分区
    await status.getByRole('tab', { name: '配置' }).click();
    await shot(status, '04-config-connection');
    for (const [name, file] of [['网络地址', '05-config-network'], ['Python 运行环境', '06-config-python'], ['Agent（实验性）', '07-config-agent'], ['基本设置', '08-config-general']]) {
      await status.getByRole('button', { name }).click();
      await shot(status, file);
    }

    // 历史页（伪造数据，自动展开最近一组）
    await status.getByRole('tab', { name: '历史' }).click();
    await status.getByText('历史执行记录').first().waitFor({ timeout: 15000 });
    await shot(status, '09-history');
    await status.getByText('每日报表生成与汇总推送').first().waitFor({ timeout: 10000 });
    await shot(status, '10-history-expanded');
    // 单条执行日志浮层
    await status.getByRole('button', { name: '查看日志' }).first().click();
    await shot(status, '11-history-log-overlay');
    await status.getByRole('button', { name: '关闭', exact: true }).click();

    // 应用页
    await status.getByRole('tab', { name: '应用' }).click();
    await status.getByText('本地应用').first().waitFor({ timeout: 15000 });
    await shot(status, '12-apps');
    // 展开第一个应用
    await status.getByRole('button', { name: /数据同步机器人/ }).first().click();
    await status.getByRole('button', { name: '卸载应用' }).waitFor({ timeout: 10000 });
    await shot(status, '13-apps-expanded');
    // 触发「删除版本」页内确认条（第二个版本非 current）
    await status.getByRole('button', { name: /删除 v1\.4\.2 的本地部署/ }).click();
    await status.getByText('确定删除本地版本 v1.4.2').waitFor({ timeout: 5000 });
    await shot(status, '14-apps-confirm-delete');
    await status.getByRole('button', { name: '取消' }).click();
    // 触发「卸载应用」页内确认条
    await status.getByRole('button', { name: '卸载应用' }).click();
    await status.getByText('确定从本机卸载「数据同步机器人」吗？').waitFor({ timeout: 5000 });
    await shot(status, '15-apps-confirm-uninstall');
    await status.getByRole('button', { name: '取消' }).click();
    // 名称未知的应用
    await status.getByRole('button', { name: /未知应用名/ }).first().click();
    await shot(status, '16-apps-unknown');

    console.log('DONE');
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exit(1); });
