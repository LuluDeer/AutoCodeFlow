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
  fs.symlinkSync(relA2, path.join(appA, 'current'), 'junction'); // current 软链：让库存截图覆盖「当前版本徽章」分支
  fs.writeFileSync(path.join(relA2, 'app.log'), Array.from({ length: 40 }, (_, i) => `2026-09-28T0${i % 10}:12:${String(i).padStart(2, '0')}.000Z [INFO] [23fb6898-e228-4ca2-8ed4-956758b5d2f0] sync batch #${i} done`).join('\n'));
  // 应用 B：旧部署无 app.json（名称未知）、scheduled 模式无日志
  const appB = path.join(root, 'apps', 'b1b2c3d4-0000-4000-8000-000000000002');
  const relB1 = path.join(appB, 'releases', '0.9.0-4fb1b2c3-0000-4000-8000-00000000000c');
  fs.mkdirSync(relB1, { recursive: true });

  // ── 规模压测夹具（长期使用审计）：多应用/多版本/长名称/无名应用 ──
  const hex = (n) => `0000${n.toString(16)}`.slice(-4);
  const moreNames = [
    '报表生成器', '客户数据每日清洗入库（含异常重试队列）', '夜间全量索引重建',
    '财务凭证同步', '邮件通知派发', '数据库备份校验', '舆情监控采集',
    '合同归档 OCR', '风控指标计算', '渠道对账机器人',
  ];
  moreNames.forEach((name, j) => {
    const appId = `c${hex(j + 1)}b2c3d4-0000-4000-8000-${hex(j + 1)}0000000003`;
    const appDir = path.join(root, 'apps', appId);
    const relCount = j % 3 === 0 ? 3 : j % 2 === 0 ? 2 : 1;
    for (let r = 0; r < relCount; r++) {
      const rel = path.join(appDir, 'releases', `1.${r}.0-5fb1b2c3-0000-4000-8000-${hex(j * 10 + r)}000000000d`);
      fs.mkdirSync(rel, { recursive: true });
      if (r === relCount - 1) fs.writeFileSync(path.join(rel, 'app.json'), JSON.stringify({ appName: name, runMode: 'daemon' }));
    }
    fs.writeFileSync(path.join(appDir, 'app.json'), JSON.stringify({ appName: name, runMode: 'daemon' }));
  });
  // 无名应用 ×3（无 app.json）
  for (let j = 0; j < 3; j++) {
    const appId = `d${hex(j + 1)}b2c3d4-0000-4000-8000-${hex(j + 1)}0000000004`;
    const rel = path.join(root, 'apps', appId, 'releases', `0.8.0-6fb1b2c3-0000-4000-8000-${hex(j + 1)}000000000e`);
    fs.mkdirSync(rel, { recursive: true });
  }

  // 执行记录：5 条脚本锚点记录 + 25 条压测记录（9 个任务、混合状态、含超长任务名与错误信息）
  const stressTasks = [
    '渠道对账机器人', '客户数据每日清洗入库（含异常重试队列）', '夜间全量索引重建',
    '财务凭证同步', '邮件通知派发', '数据库备份校验', '舆情监控采集',
  ];
  const uuid = (n) => `${hex(n)}f0a2b3-c7d8-4e5f-9a01-23456789${hex(n + 9)}ab`;
  for (let i = 0; i < 25; i++) {
    const taskName = stressTasks[i % stressTasks.length];
    const start = now - (i + 1) * 37 * MIN;
    const running = i % 13 === 5;
    const failed = !running && i % 6 === 2;
    records.push({
      executionId: uuid(i + 20),
      taskId: `t-${2000 + (i % stressTasks.length)}`,
      taskName,
      startTime: start,
      ...(running ? {} : { endTime: start + 4 * MIN }),
      status: running ? 'running' : failed ? 'failed' : 'success',
      exitCode: failed ? 1 : 0,
      ...(failed ? { errorMessage: 'python: No module named pandas（解释器 3.11 准备失败：下载超时，重试 3 次仍未恢复）' } : {}),
    });
  }
  // 追加的记录统一落盘（前 5 条重写同内容，无害）
  records.forEach((r, i) => fs.writeFileSync(path.join(metaDir, `meta-${String(i).padStart(4, '0')}.json`), JSON.stringify(r)));
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

  // 预写「今天的执行器日志」让状态窗截图贴近真实运行密度：electron-log 包裹
  // winston 行的双重时间戳 + [executor]/[executor:err] 段 + CRLF 行尾（Windows
  // 真实落盘形态），含 warn/error 级别以驱动级别芯片与告警计数。
  // 若不预写，日志区只有应用自身几行启动日志，排版评估会基于失真的空态。
  {
    const logDir = path.join(userData, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const now = Date.now();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const fmtLocal = (t) => {
      const d = new Date(t);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    };
    const trace = '23fb6898-e228-4ca2-8ed4-956758b5d2f0';
    const infos = [
      'Sending heartbeat',
      'Heartbeat succeeded',
      'Polling assignments: none pending',
      'Task t-1002 heartbeat acknowledged',
      'Agent idle: waiting for next assignment window',
    ];
    const lines = [];
    for (let i = 400; i >= 1; i--) {
      const t = now - i * 47_000;
      const iso = new Date(t).toISOString();
      if (i % 19 === 0) {
        lines.push(`[${fmtLocal(t)}] [error] [executor:err] ${iso} [ERROR] [${trace}] Task t-1001 exited with code 1: python: No module named pandas`);
      } else if (i % 7 === 0) {
        lines.push(`[${fmtLocal(t)}] [warn]  [executor] ${iso} [WARN] [${trace}] Heartbeat latency high: 4.2s (threshold 3s)`);
      } else {
        lines.push(`[${fmtLocal(t)}] [info]  [executor] ${iso} [INFO] [${trace}] ${infos[i % infos.length]}`);
      }
    }
    // electron-log 落盘为 CRLF（Windows）——保持与生产一致，顺带钉住
    // readLastLines 的 CRLF 剥离路径。
    const day = new Date(now);
    const logName = `executor-${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}.log`;
    fs.writeFileSync(path.join(logDir, logName), lines.join('\r\n') + '\r\n');
  }

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
    // 第 2 步（连接服务端）：验证步骤进度指引「第 X / 4 步」与表单态
    await wizard.getByRole('button', { name: /开始配置/ }).click();
    await wizard.getByText('连接服务端').first().waitFor({ timeout: 10000 });
    await shot(wizard, '01b-wizard-connect');

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
    for (const [name, file] of [['网络地址', '05-config-network'], ['Python 运行环境', '06-config-python'], ['Agent（实验性）', '07-config-agent'], ['关于与更新', '08-config-about']]) {
      await status.getByRole('button', { name }).click();
      await shot(status, file);
    }

    // 历史页（伪造数据，自动展开最近一组）
    await status.getByRole('tab', { name: '历史' }).click();
    await status.getByText('历史执行记录').first().waitFor({ timeout: 15000 });
    await shot(status, '09-history');
    // V4-3 起状态页右栏「最近失败」卡也含任务名文本（面板常驻挂载，hidden 下
    // getByText 仍命中）——历史页断言锚定 #history-panel 作用域，避免歧义命中
    // 隐藏面板里的同名文本（getByRole 无此问题：display:none 不进无障碍树）。
    await status.locator('#history-panel').getByText('每日报表生成与汇总推送').first().waitFor({ timeout: 10000 });
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

    // ── 窄窗口通道（长期使用审计）：800×720 接近最小窗口，验证响应式与密度 ──
    await app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()
        .filter((w) => w.isVisible())
        .forEach((w) => w.setSize(size.w, size.h));
    }, { w: 800, h: 720 });
    await shot(status, '20-n-apps');
    await status.getByRole('tab', { name: '状态监控' }).click();
    await shot(status, '21-n-status');
    await status.getByRole('tab', { name: '配置' }).click();
    await shot(status, '22-n-config');
    await status.getByRole('tab', { name: '历史' }).click();
    await status.getByText('历史执行记录').first().waitFor({ timeout: 15000 });
    await shot(status, '23-n-history');

    console.log('DONE');
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exit(1); });
