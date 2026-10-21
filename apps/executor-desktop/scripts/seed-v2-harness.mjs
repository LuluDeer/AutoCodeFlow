#!/usr/bin/env node
/**
 * 为 V2 联调准备一份**隔离的** Electron userData：
 *   <dir>/config.json         —— 已配置形态的本地配置（字段与 V1 AppConfig 对齐）
 *   <dir>/work/meta/*.json    —— 执行记录（V1 的真实 meta schema：executionId / startTime / endTime）
 *   <dir>/work/logs/<date>/*  —— 对应的任务日志（V1 的 log:read 按 executionId 解析）
 *
 * 只写目标目录，不碰用户真实配置。用法：node seed-v2-harness.mjs /tmp/acf-v2-e2e
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node seed-v2-harness.mjs <userDataDir>');
  process.exit(1);
}

const workDir = path.join(dir, 'work');
const metaDir = path.join(workDir, 'meta');
const now = new Date();
const dateDir = [
  now.getFullYear(),
  String(now.getMonth() + 1).padStart(2, '0'),
  String(now.getDate()).padStart(2, '0'),
].join('-');
const logDir = path.join(workDir, 'logs', dateDir);

fs.mkdirSync(metaDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });

const config = {
  configured: true,
  adminApiUrl: 'ws://127.0.0.1:8001',
  executorName: 'executor-v2-harness',
  executorHost: '0.0.0.0',
  executorPort: 9123,
  executorToken: 'harness-shared-token',
  workDir,
  maxConcurrentTasks: 6,
  autoStart: false,
  autoStartExecutor: false,
  notifyEnabled: false,
  logLevel: 'info',
  uiLanguage: 'zh',
  uvPythonInstallMirror: '',
};
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));

// 主进程当天日志（logs:getToday 的读取锚点），让状态页的日志区有真实内容。
const uiLogDir = path.join(dir, 'logs');
fs.mkdirSync(uiLogDir, { recursive: true });
const uiLog = [];
for (let i = 0; i < 24; i += 1) {
  const at = new Date(now.getTime() - (24 - i) * 45_000);
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  const ss = String(at.getSeconds()).padStart(2, '0');
  if (i === 18) {
    uiLog.push(`${hh}:${mm}:${ss} WARN  heartbeat latency high (rtt=1840ms)`);
  } else if (i === 20) {
    uiLog.push(`${hh}:${mm}:${ss} ERROR executor offline: ECONNREFUSED 127.0.0.1:9123`);
  } else {
    uiLog.push(`${hh}:${mm}:${ss} INFO  heartbeat ok rtt=${18 + (i % 7) * 3}ms · queue=0 · running=0/6`);
  }
}
fs.writeFileSync(path.join(uiLogDir, `executor-${dateDir}.log`), `${uiLog.join('\n')}\n`);

const rows = [
  ['exec_a1b2c3', '日报汇总', 'success', 5 * 60_000, 4218],
  ['exec_d4e5f6', '库存同步', 'failed', 40 * 60_000, 7421],
  ['exec_g7h8i9', '订单对账', 'success', 2 * 60 * 60_000, 1203],
  ['exec_j0k1l2', '发票归档', 'success', 26 * 60 * 60_000, 940],
];

const stamp = (date) =>
  [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');

for (const [id, name, status, ago, duration] of rows) {
  const start = new Date(Date.now() - ago);
  const meta = {
    executionId: id,
    taskId: `task_${id.slice(-4)}`,
    taskName: name,
    startTime: start.getTime(),
    status,
    endTime: start.getTime() + duration,
    exitCode: status === 'success' ? 0 : 1,
  };
  fs.writeFileSync(path.join(metaDir, `${id}.json`), JSON.stringify(meta, null, 2));

  const lines = [];
  for (let i = 0; i < 36; i += 1) {
    const at = stamp(new Date(start.getTime() + i * 400));
    const isFailure = status === 'failed' && i === 30;
    lines.push(
      isFailure
        ? `${at} ERROR TimeoutError: upstream 响应超过 30000ms (harness)`
        : `${at} INFO  batch #${String(i).padStart(3, '0')} rows=${110 + i * 3} elapsed=${(i * 0.4).toFixed(1)}s`,
    );
  }
  fs.writeFileSync(path.join(logDir, `${id}.log`), `${lines.join('\n')}\n`);
}

// ── 已部署应用（executor-node 真实布局：releases/<version>-<uuid>/ + current 软链）──
const appsDir = path.join(workDir, 'apps');
const APPS = [
  {
    id: 'app_report_daily',
    name: '日报生成器',
    releases: ['1.4.2-11111111-1111-4111-8111-111111111111'],
    current: '1.4.2-11111111-1111-4111-8111-111111111111',
  },
  {
    id: 'app_inventory_sync',
    name: '库存同步',
    releases: [
      '1.9.0-22222222-2222-4222-8222-222222222222',
      '2.0.1-33333333-3333-4333-8333-333333333333',
    ],
    current: '2.0.1-33333333-3333-4333-8333-333333333333',
  },
];
for (const app of APPS) {
  const appRoot = path.join(appsDir, app.id);
  fs.mkdirSync(path.join(appRoot, 'releases'), { recursive: true });
  fs.writeFileSync(
    path.join(appRoot, 'app.json'),
    JSON.stringify({ appName: app.name, runMode: 'daemon', runtime: 'python' }, null, 2),
  );
  for (const release of app.releases) {
    const releaseDir = path.join(appRoot, 'releases', release);
    fs.mkdirSync(releaseDir, { recursive: true });
    const lines = [];
    for (let i = 0; i < 18; i += 1) {
      const at = new Date(Date.now() - (18 - i) * 30_000);
      const hh = String(at.getHours()).padStart(2, '0');
      const mm = String(at.getMinutes()).padStart(2, '0');
      const ss = String(at.getSeconds()).padStart(2, '0');
      lines.push(
        `${hh}:${mm}:${ss} INFO  app ${app.id} release ${release} tick #${i} rows=${90 + i * 4}`,
      );
    }
    fs.writeFileSync(path.join(releaseDir, 'app.log'), `${lines.join('\n')}\n`);
  }
  try {
    fs.rmSync(path.join(appRoot, 'current'), { force: true });
    fs.symlinkSync(path.join('releases', app.current), path.join(appRoot, 'current'));
  } catch {
    /* Windows 无权限时忽略：apps:list 仍能列出 release */
  }
}

// 可选：造 N 个应用用于规模验收（ACF_SEED_APP_COUNT=200）。
const scaleCount = Number(process.env.ACF_SEED_APP_COUNT ?? 0);
if (Number.isFinite(scaleCount) && scaleCount > 0) {
  for (let index = 0; index < scaleCount; index += 1) {
    const suffix = String(index + 1).padStart(3, '0');
    const id = `app_scale_${suffix}`;
    const appRoot = path.join(appsDir, id);
    const release = `1.0.${index % 10}-44444444-4444-4444-8444-${String(index + 1).padStart(12, '0')}`;
    fs.mkdirSync(path.join(appRoot, 'releases', release), { recursive: true });
    fs.writeFileSync(
      path.join(appRoot, 'app.json'),
      JSON.stringify({ appName: `批量应用 ${suffix}`, runMode: 'daemon', runtime: 'python' }, null, 2),
    );
    fs.writeFileSync(
      path.join(appRoot, 'releases', release, 'app.log'),
      `${new Date().toTimeString().slice(0, 8)} INFO  app ${id} tick\n`,
    );
    try {
      fs.rmSync(path.join(appRoot, 'current'), { force: true });
      fs.symlinkSync(path.join('releases', release), path.join(appRoot, 'current'));
    } catch {
      /* ignore */
    }
  }
}

console.log(`[seed-v2-harness] userData=${dir}`);
console.log(`[seed-v2-harness] workDir=${workDir} (${rows.length} records)`);
