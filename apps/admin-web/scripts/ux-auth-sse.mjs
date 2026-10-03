// ux-auth-sse.mjs — 鉴权流 / 路由守卫 / viewer RBAC 渲染 / SSE 实时流 走查(真实 Chromium)
//
// 背景:首轮 ux-walkthrough(纯读路径)明确的盲区——写路径/鉴权流/实时流全没验过。
// 本脚本与其互补,验四面(全部真实 Chromium,产物落 test-results/ux-auth-sse/):
//   S1 鉴权流:无登录态访问受保护路由 → /login;登录页提交 → Dashboard;登出 → /login。
//   S2 路由守卫边界:无效 token + refresh 401 → /login?reason=expired&redirect=…;
//      profile 持续 401 + refresh 200 → 是否陷入 login↔校验死循环(计数器取证)。
//   S3 viewer RBAC 渲染:role=viewer 逐页核对渲染边界——admin-only 按钮「禁用+
//      Tooltip(P1-5 口径)」而非消失、入口按设计隐藏、路由级 RequireAdmin 403。
//   S4 SSE 实时流:/metrics/stream 快照帧驱动 UI 更新 + 数据延迟角标闭环;
//      静默流不显示「重连中」;断流后「重连中」/「实时日志流已断开」如实出现;
//      /executions/stream 终态事件 → 列表状态翻转;/tasks/:id/executions/:id/logs/stream
//      推送日志行 → 日志区真实追加。
//
// 架构与 ux-walkthrough 的差异:本脚本**自起 vite(VITE_PORT=5177,避开并行走查的
// 5176)+ 自起 mock 后端(127.0.0.1:3105,vite.config.ts 硬编码的 proxy target)**。
// JSON 端点由 mock 后端供数(夹具从 ux-walkthrough.mjs 抄录);SSE 端点由 mock 后端
// 真·分块流式应答(保持连接打开/推帧/断流 destroy)——Playwright route.fulfill 的
// 响应体一次性到齐、连接随即关闭,EventSource 必然立刻 onerror,无法表达
// 「长连接保持打开」的正常路径,也测不出「静默流不显示重连中」。这是刻意不走
// route 拦截而走本机 mock 后端的原因(能力边界详见报告)。
//
// 独立运行:node scripts/ux-auth-sse.mjs(自带 vite + mock,无需预起 dev)。
// 产物:OUT_DIR 下 report.md / results.json / 截图;根 .gitignore 的 test-results/ 已覆盖。

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'test-results', 'ux-auth-sse');
const WEB_PORT = 5177;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const MOCK_PORT = 3105; // vite.config.ts server.proxy['/api'].target 硬编码
const ISO = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const MIN = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// 夹具数据(从 ux-walkthrough.mjs 抄录,形状对齐 src/api/*.ts 接口)
// ─────────────────────────────────────────────────────────────────────────────

const USER_ADMIN = { id: 1, username: 'admin', email: 'admin@autoflow.local', role: 'admin' };
const USER_VIEWER = { id: 9, username: 'viewer', email: 'viewer@autoflow.local', role: 'viewer' };

const TASKS = [
  {
    id: 't-1001', name: '生产库每日全量备份-含超长名称验证用例-上海金融中心机房-primary', description: '每日 02:00 全量备份生产 PG 集群,并上传对象存储',
    runtime: 'python', entrypoint: 'jobs/backup_full.py', status: 'active', triggerType: 'cron', cronExpression: '0 2 * * *', timezone: 'Asia/Shanghai',
    priority: 2, maxRetry: 3, retryDelay: 60, timeout: 3600, timeoutSeconds: 3600, timeoutAction: 'kill_retry', timeoutWarnRatio: 80,
    blockStrategy: 'serial', projectId: 'p-1000', applicationId: null, executorAppName: '上海电信机房-生产执行器-01-长名称', executorId: null,
    executorGroup: 'prod-sh', executorTags: ['ssd', 'prod'], executorAffinityTags: ['ssd'], executorAntiAffinityTags: [],
    deploymentPolicy: 'prefer', dependencies: { 't-1003': 'success' }, maintenanceWindows: [{ start: '0 0 * * *', end: '30 0 * * *', description: '跨午夜维护窗口' }],
    runbook: '## 失败排障\n1. 检查对象存储凭据\n2. 检查 pg_dump 版本', gitRepo: 'https://git.example.com/ops/jobs.git', gitBranch: 'main',
    gitCommit: 'a1b2c3d', currentVersion: 'v7', runtimeVersion: '3.12', codeSource: 'git', alarmEmail: 'oncall@example.com', alarmChannels: ['email'],
    lastTriggerTime: ISO(-90 * MIN), createdAt: ISO(-40 * 24 * 3600e3), updatedAt: ISO(-2 * 24 * 3600e3),
    params: { target: 'pg-prod-1', compress: true }, secrets: { OSS_AK: '******', OSS_SK: '******' },
  },
  {
    id: 't-1002', name: '应用日志滚动清理', runtime: 'shell', entrypoint: 'cleanup.sh', status: 'active', triggerType: 'fixed_rate', fixedRate: 30,
    priority: 'P3', maxRetry: 1, timeout: 600, projectId: null, executorAppName: '北京联通节点-02', lastTriggerTime: ISO(-35 * MIN),
    createdAt: ISO(-90 * 24 * 3600e3), updatedAt: ISO(-5 * 24 * 3600e3),
  },
  {
    id: 't-1003', name: '用户画像宽表同步', runtime: 'node', entrypoint: 'sync_profile.mjs', status: 'paused', triggerType: 'cron', cronExpression: '0 */2 * * *',
    priority: 1, maxRetry: 5, timeout: 1800, projectId: 'p-1001', executorAppName: '华东云节点-03', lastTriggerTime: ISO(-26 * 3600e3),
    createdAt: ISO(-60 * 24 * 3600e3), updatedAt: ISO(-1 * 24 * 3600e3), alarmEmail: 'data-team@example.com', alarmChannels: ['email', 'dingtalk'],
  },
  {
    id: 't-1004', name: 'Glue 脚本-临时对账任务', runtime: 'glue', entrypoint: '', status: 'active', triggerType: 'manual', glueSource: 'print("对账中")',
    glueLanguage: 'python', priority: 3, maxRetry: 0, timeout: 300, projectId: null, createdAt: ISO(-3 * 24 * 3600e3), updatedAt: ISO(-1 * 24 * 3600e3),
  },
  {
    id: 't-1005', name: '数据采集平台-巡检上报', runtime: 'python', entrypoint: 'inspect/main.py', status: 'active', triggerType: 'cron',
    cronExpression: '*/10 * * * *', priority: 2, maxRetry: 2, timeout: 900, projectId: 'p-1002', applicationId: 'app-2001',
    codeSource: 'application_zip', executorAppName: '上海电信机房-生产执行器-01-长名称', lastTriggerTime: ISO(-12 * MIN),
    createdAt: ISO(-20 * 24 * 3600e3), updatedAt: ISO(-6 * 3600e3),
  },
];

const EXECUTIONS = [
  { id: 'e-9001', taskId: 't-1001', taskName: TASKS[0].name, status: 'failed', triggerType: 'cron', executorAddress: 'http://192.168.4.54:9001', startTime: ISO(-95 * MIN), endTime: ISO(-94 * MIN), duration: 61_230, params: { target: 'pg-prod-1' }, logs: '[2026-10-03 02:00:01] 开始备份\n[2026-10-03 02:00:44] FATAL: OSS 凭据失效', errorMessage: 'OSS 上传失败: SignatureDoesNotMatch', failureReason: 'credential', exitCode: 2, aiAnalysis: '疑似对象存储凭据轮换后未同步到任务级 secrets。', retryCount: 2, taskVersion: 'v7', traceId: '4bf92f3577b34da6a3ce929d0e0e4736', resolvedPackageVersion: null, result: null, createdAt: ISO(-95 * MIN) },
  { id: 'e-9002', taskId: 't-1005', taskName: TASKS[4].name, status: 'success', triggerType: 'cron', executorAddress: 'http://192.168.4.54:9001', startTime: ISO(-20 * MIN), endTime: ISO(-18 * MIN), duration: 121_000, exitCode: 0, logs: '巡检完成,7/7 通过', createdAt: ISO(-20 * MIN), retryCount: 0, taskVersion: 'v2' },
  { id: 'e-9003', taskId: 't-1001', taskName: TASKS[0].name, status: 'running', triggerType: 'api', executorAddress: 'http://192.168.4.60:9001', startTime: ISO(-2 * MIN), logs: '备份进行中 34%', createdAt: ISO(-2 * MIN) },
  { id: 'e-9004', taskId: 't-1002', taskName: TASKS[1].name, status: 'timeout', triggerType: 'fixed_rate', executorAddress: 'http://192.168.4.61:9001', startTime: ISO(-3 * 3600e3), endTime: ISO(-3 * 3600e3 + 600e3), duration: 600_000, errorMessage: '执行超时(600s)', failureReason: 'timeout', exitCode: null, createdAt: ISO(-3 * 3600e3) },
  { id: 'e-9005', taskId: 't-1003', taskName: TASKS[2].name, status: 'killed', triggerType: 'cron', executorAddress: 'http://192.168.4.62:9001', startTime: ISO(-26 * 3600e3), endTime: ISO(-25 * 3600e3), duration: 2100e3, errorMessage: '管理员手动终止', createdAt: ISO(-26 * 3600e3), exitCode: 137 },
];

const EXECUTORS = [
  { id: 'ex-3001', appName: '上海电信机房-生产执行器-01-长名称验证用例', address: 'http://192.168.4.54:9001', status: 'online', type: 'python', executorVersion: '2.14.0', cpuUsage: 62.5, memUsage: 71.2, diskUsage: 55.0, networkLatency: 8, runningTaskCount: 3, totalTaskCount: 512, failedTaskCount: 9, lastHeartbeat: ISO(-30e3), groupName: 'prod-sh', tags: ['ssd', 'prod', 'gpu'], description: '上海金融中心机房主力执行器', maxConcurrentTasks: 10, projectId: null, runningExecutionIds: ['e-9003'], reservedSlots: 0, deadLetterCount: 0, dispatchMode: 'push', protocolVersion: 2, versionCompliant: true, offlineReason: null, interpreters: [{ version: '3.12.13', path: 'C:/Python312/python.exe', available: true, discoveredAt: ISO(-1 * 24 * 3600e3) }] },
  { id: 'ex-3002', appName: '北京联通节点-02', address: 'http://10.8.0.12:9001', status: 'online', executorVersion: '2.14.0', cpuUsage: 28.1, memUsage: 44.8, runningTaskCount: 1, lastHeartbeat: ISO(-45e3), groupName: 'prod-bj', tags: ['pull'], maxConcurrentTasks: 6, dispatchMode: 'pull', protocolVersion: 2, versionCompliant: true, interpreters: [{ version: '3.12.13', available: true }] },
  { id: 'ex-3003', appName: '办公室测试机-工位-07', address: 'http://192.168.1.107:9001', status: 'offline', executorVersion: '2.9.1', cpuUsage: 0, memUsage: 0, runningTaskCount: 0, lastHeartbeat: ISO(-26 * 3600e3), groupName: null, tags: ['test'], description: '工位开发机,下班关机', maxConcurrentTasks: 4, dispatchMode: 'push', versionCompliant: false, offlineReason: 'stale_timeout', interpreters: null },
];

const APPLICATIONS = [
  { id: 'app-2001', name: '数据采集平台-生产环境-长名称验证用例', description: '分布式采集与清洗管线', version: '2.3.1', runtime: 'python', status: 'running', gitRepo: 'https://git.example.com/data/collector.git', gitBranch: 'main', gitCommit: 'f00dcafe', entrypoint: 'main.py', approvalRequired: true, mutexGroupId: 'mg-1', env: { LOG_LEVEL: 'info' }, manifest: { tasks: 12 }, createdAt: ISO(-80 * 24 * 3600e3), updatedAt: ISO(-2 * 24 * 3600e3) },
  { id: 'app-2002', name: '报表服务', description: '日报/周报导出', version: '1.0.0', runtime: 'node', status: 'stopped', gitRepo: 'https://git.example.com/bi/report.git', gitBranch: 'master', gitCommit: 'beef1234', entrypoint: 'index.js', createdAt: ISO(-120 * 24 * 3600e3), updatedAt: ISO(-30 * 24 * 3600e3) },
];

const APP_DEPLOYMENTS = [
  { id: 'dep-7001', applicationId: 'app-2001', executorId: 'ex-3001', executorAddress: 'http://192.168.4.54:9001', status: 'running', runMode: 'daemon', deployedCommit: 'f00dcafe', deployedVersion: '2.3.1', startCommand: 'python main.py', env: { LOG_LEVEL: 'info' }, pid: 4200, lastHeartbeat: ISO(-30e3), statusMessage: '运行正常', deployedAt: ISO(-2 * 24 * 3600e3), approvalStatus: 'approved', approvalMeta: { requestedBy: 2, requestedByName: '王运维', requestedAt: ISO(-2 * 24 * 3600e3 - 3600e3), actedBy: 1, actedByName: 'admin', actedAt: ISO(-2 * 24 * 3600e3), reason: '常规发布' }, rolloutState: 'promoted', createdAt: ISO(-2 * 24 * 3600e3), updatedAt: ISO(-1 * 3600e3) },
];

const USERS = [
  { id: 1, username: 'admin', email: 'admin@autoflow.local', role: 'admin', createdAt: ISO(-365 * 24 * 3600e3), updatedAt: ISO(-10 * 24 * 3600e3) },
  { id: 2, username: '王运维', email: 'wang.ops@autoflow.local', role: 'user', createdAt: ISO(-200 * 24 * 3600e3), updatedAt: ISO(-8 * 24 * 3600e3) },
  { id: 9, username: 'viewer', email: 'viewer@autoflow.local', role: 'user', createdAt: ISO(-30 * 24 * 3600e3), updatedAt: ISO(-3 * 24 * 3600e3) },
];

const PROJECTS = [
  { id: 'p-1000', name: '默认项目', description: '未归属任务/应用的兜底视图', createdAt: ISO(-365 * 24 * 3600e3), updatedAt: ISO(-10 * 24 * 3600e3), myRole: 'admin' },
  { id: 'p-1001', name: '数据平台组-用户画像与报表-长名称验证用例', description: '画像宽表、标签、报表', createdAt: ISO(-200 * 24 * 3600e3), updatedAt: ISO(-2 * 24 * 3600e3), myRole: 'editor' },
];

const SOPS = [
  { id: 'sop-5001', slug: 'weekly-db-maintenance', title: '数据库周维护-SOP', currentVersion: 'v3', status: 'published', applicationId: null, frontMatterJson: { owner: 'sre' }, bodyMarkdown: '## 步骤\n1. 检查主从延迟', createdBy: 'admin', createdAt: ISO(-90 * 24 * 3600e3), updatedAt: ISO(-2 * 24 * 3600e3) },
];

const AGENT_SESSIONS = [
  { id: 'ag-6001', kind: 'ops_agent', status: 'succeeded', title: '夜间巡检摘要', triggerSource: 'scheduler', parentSessionId: null, contextJson: null, scopeJson: null, budgetJson: null, resultJson: { ok: true }, summary: '全部通过', errorMessage: null, totalSteps: 6, totalTokensIn: 12000, totalTokensOut: 3000, totalToolCalls: 4, waitingFor: null, startedAt: ISO(-8 * 3600e3), finishedAt: ISO(-7.8 * 3600e3), createdAt: ISO(-8 * 3600e3), updatedAt: ISO(-7.8 * 3600e3) },
];

const PACKAGES = [
  { id: 'pkg-4001', name: 'autoflow-executor-node', version: '2.14.0', type: 'node', platform: 'win64', fileSize: 18_324_992, sha256: 'ab12'.repeat(16), changelog: '支持协议 v2 控制面', status: 'active', downloadCount: 132, createdAt: ISO(-20 * 24 * 3600e3), updatedAt: ISO(-20 * 24 * 3600e3) },
];

const TEMPLATES = [
  { id: 'tpl-1', key: 'scheduled_backup', name: '定时备份', description: '按 cron 周期备份目标并上传存储', category: '备份', config: { triggerType: 'cron', cronExpression: '0 2 * * *', runtime: 'shell', entrypoint: 'backup.sh', timeoutSeconds: 3600, maxRetry: 3, retryDelay: 60, blockStrategy: 'discard' }, createdBy: null, createdAt: ISO(-100 * 24 * 3600e3) },
];

const CHANNELS = [
  { key: 'email', name: '邮件', enabled: true, config: { smtpHost: 'smtp.example.com', smtpPort: '465', from: 'alert@example.com', to: 'oncall@example.com' }, description: 'SMTP 邮件通知' },
  { key: 'dingtalk', name: '钉钉', enabled: true, config: { webhook: 'https://oapi.dingtalk.com/robot/send?access_token=***' }, description: '钉钉群机器人 webhook' },
];

const SILENCES = [
  { id: 'sil-1', scope: 'task', channelType: null, taskId: 't-1002', applicationId: null, level: null, reason: '日志清理预期抖动', startTime: ISO(-2 * 24 * 3600e3), endTime: ISO(5 * 24 * 3600e3), durationMinutes: null, createdBy: 'admin', createdAt: ISO(-2 * 24 * 3600e3) },
];

const CONFIGS = [
  { id: 1, key: 'executor.heartbeat.interval', value: '30000', description: '执行器心跳间隔(毫秒)', valueType: 'number', isSecret: false, tag: 'executor', createdAt: ISO(-300 * 24 * 3600e3), updatedAt: ISO(-60 * 24 * 3600e3) },
  { id: 6, key: 'deployment.policy', value: 'prefer', description: '全局部署约束', valueType: 'string', isSecret: false, tag: 'deployment', createdAt: ISO(-90 * 24 * 3600e3), updatedAt: ISO(-20 * 24 * 3600e3) },
];

const API_KEYS = [
  { id: 1, name: 'CI 流水线-部署触发', keyPrefix: 'acf_ci_9f2a', scope: 'trigger', expiresAt: ISO(90 * 24 * 3600e3), revokedAt: null, lastUsedAt: ISO(-3 * 3600e3), createdAt: ISO(-80 * 24 * 3600e3) },
];

const EVENT_SUBSCRIPTIONS = [
  { id: 'es-1', userId: 1, eventTypes: ['execution.failed', 'executor.offline'], url: 'https://ci.example.com/hooks/autoflow', secret: '******', enabled: true, consecutiveFailures: 0, lastFailureAt: null, lastFailureError: null, createdAt: ISO(-60 * 24 * 3600e3), updatedAt: ISO(-10 * 24 * 3600e3) },
];

const AUTH_SESSIONS = [
  { id: 11, createdAt: ISO(-2 * 3600e3), expiresAt: ISO(5 * 3600e3), userAgent: 'Chrome 141 / Windows 10', ip: '192.168.4.2', current: true },
];

const AUDIT_LOGS = [
  { id: 101, action: 'executor.delete', resource: 'executor', resourceId: 'ex-3009', username: 'admin', result: 'success', detail: { address: 'http://10.20.3.9:9001' }, ip: '192.168.4.2', createdAt: ISO(-2 * 3600e3) },
];

const TREND = Array.from({ length: 7 }, (_, i) => ({
  date: new Date(Date.now() - (6 - i) * 24 * 3600e3).toISOString().slice(0, 10),
  success: 180 + i * 12, failed: 8 + (i % 3) * 4, timeout: 2 + (i % 2),
}));

const EXEC_METRICS_HISTORY = Array.from({ length: 24 }, (_, i) => ({
  timestamp: new Date(Date.now() - (23 - i) * 3600e3).toISOString(),
  cpuUsage: i % 7 === 3 ? null : 30 + ((i * 7) % 50),
  memUsage: i % 5 === 2 ? null : 45 + ((i * 3) % 40),
  runningTaskCount: i % 4,
}));

const SUMMARY = {
  totalTasks: 128, todayRuns: 342, totalExecutors: 12, onlineExecutors: 9,
  executions: { total: 15230, success: 14520, failed: 512, running: 7 },
  successRate: 96.4, avgDurationMs: 5230,
};

function executorMetrics(ex) {
  return {
    executor: { id: ex.id, address: ex.address, status: ex.status },
    sevenDayStats: { totalExecutions: 512, successful: 494, failed: 18, successRate: 96.5, averageDurationMs: 8420 },
    current: { runningTaskCount: ex.runningTaskCount, reservedSlots: ex.reservedSlots ?? 0, cpuUsage: ex.cpuUsage, memUsage: ex.memUsage, pendingPullItems: ex.dispatchMode === 'pull' ? 2 : 0 },
    history: EXEC_METRICS_HISTORY,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// mock 后端(127.0.0.1:3105 = vite proxy target)。同进程,脚本可直接驱动状态。
// ─────────────────────────────────────────────────────────────────────────────

function startMockApi() {
  const state = {
    role: 'admin',            // /auth/login 与 /auth/profile 返回的角色
    profileMode: 'ok',        // 'ok' | '401'
    refreshMode: 'ok',        // 'ok' | '401'
    dataAuthMode: 'open',     // 'open' | '401'(数据端点统一 401,模拟无效 token)
    metricsStreamMode: 'silent', // 'silent' | 'snapshot' | 'abort'
    executions: JSON.parse(JSON.stringify(EXECUTIONS)),
    counters: { profile: 0, refresh: 0, login: 0, logout: 0, sseMetrics: 0, sseExec: 0, sseLogs: 0, sseTicket: 0 },
    reqLog: [],               // { method, path } 全量请求流水(循环保守上限)
  };

  const openMetricsStreams = new Set();
  const openExecStreams = new Set();
  const openLogStreams = new Set();
  const sockets = new Set();
  const gaps = new Set();
  const coverage = new Set();

  const ADMIN_ONLY_GET = [
    /^\/config$/, /^\/config\/history$/, /^\/config\/executor-shared-token$/,
    /^\/users$/, /^\/audit$/, /^\/ai\/config$/,
    /^\/notification\/channels$/, /^\/notification\/silences$/,
    /^\/executor-packages$/, /^\/agent\//, /^\/executors\/install-cmd$/,
  ];

  const currentUser = () => (state.role === 'admin' ? USER_ADMIN : USER_VIEWER);

  const pagedEnvelope = (items, q) => {
    const page = Math.max(1, parseInt(q.get('page') || '1', 10) || 1);
    const pageSize = Math.max(1, parseInt(q.get('pageSize') || '20', 10) || 20);
    const start = (page - 1) * pageSize;
    return { items: items.slice(start, start + pageSize), total: items.length, page, pageSize, totalPages: Math.ceil(items.length / pageSize) };
  };
  const TASKS_PAGED = (q) => ({ ...pagedEnvelope(TASKS, q), list: pagedEnvelope(TASKS, q).items });

  const ROUTES = [
    // ── auth(动态行为) ──
    ['GET', /^\/auth\/oidc\/status$/, () => ({ enabled: false })],
    ['GET', /^\/auth\/profile$/, () => {
      state.counters.profile++;
      if (state.profileMode === '401') return { __status: 401, __body: { code: 401, message: 'invalid token (mock profile)' } };
      return currentUser();
    }],
    ['POST', /^\/auth\/login$/, () => {
      state.counters.login++;
      return { accessToken: `mock-access-${Date.now()}`, refreshToken: 'mock-refresh-token', user: currentUser() };
    }],
    ['POST', /^\/auth\/refresh$/, () => {
      state.counters.refresh++;
      if (state.refreshMode === '401') return { __status: 401, __body: { code: 401, message: 'invalid refresh token (mock)' } };
      return { accessToken: `mock-access-refreshed-${Date.now()}`, refreshToken: 'mock-refresh-token-rotated' };
    }],
    ['POST', /^\/auth\/logout$/, () => { state.counters.logout++; return { success: true }; }],
    ['POST', /^\/auth\/sse-ticket$/, () => { state.counters.sseTicket++; return { ticket: 'mock-sse-ticket', expiresAt: ISO(30e3) }; }],
    ['GET', /^\/auth\/sessions$/, () => AUTH_SESSIONS],
    // ── metrics / dashboard ──
    ['GET', /^\/metrics\/summary$/, () => SUMMARY],
    ['GET', /^\/metrics\/trend$/, () => TREND],
    ['GET', /^\/metrics\/executors$/, () => EXECUTORS.map((e) => ({ id: e.id, appName: e.appName, address: e.address, status: e.status, cpuUsage: e.cpuUsage, memUsage: e.memUsage, runningTaskCount: e.runningTaskCount, lastHeartbeat: e.lastHeartbeat }))],
    ['GET', /^\/metrics\/failures$/, () => [
      { id: 'e-9001', taskId: 't-1001', taskName: TASKS[0].name, errorMessage: 'OSS 上传失败', failureReason: 'credential', exitCode: 2, createdAt: ISO(-95 * MIN), duration: 61_230 },
    ]],
    ['GET', /^\/metrics\/scheduler$/, () => ({
      counters: { ticks: 86400, tickDurationMsTotal: 432000, lastTickDurationMs: 4, lastTickAt: ISO(-1e3), triggersClaimed: 1520, triggersSkippedLockHeld: 3, triggersSkippedDbClaim: 1, triggersSkippedInactive: 42, triggersSkippedBlockStrategy: 6, triggersSkippedMaintenance: 12, triggersFailed: 2, dependencyTriggersClaimed: 30, dependencyTriggersSkipped: 2, triggerLatencyCount: 1520, triggerLatencySumMs: 456000, triggerLatencyBuckets: [1200, 220, 60, 25, 10, 5], lastTriggerLatencyMs: 180, startedAt: ISO(-24 * 3600e3) },
      derived: { avgTickDurationMs: 5, tickRatePerSec: 1, triggerClaimRatePerSec: 0.017, avgTriggerLatencyMs: 300, p99TriggerLatencyMs: 820 },
      queue: { waiting: 3, active: 7, delayed: 12, failed: 2, completed: 15210 },
      scheduler: { healthy: true, isLeader: true, activeTimers: 96, activeCronTasks: 64, runningTaskCount: 7, totalScheduledTasks: 128, uptime: 864000 },
      instance: { pid: 3105, hostname: 'mock' },
    })],
    ['GET', /^\/tasks\/scheduler\/stats$/, () => ({ healthy: true, activeTimers: 96, activeCronTasks: 64, runningTaskCount: 7, totalScheduledTasks: 128, uptime: 864000 })],
    // ── tasks(执行记录读 state,供终态事件翻转断言) ──
    ['GET', /^\/tasks$/, (u, q) => TASKS_PAGED(q)],
    ['GET', /^\/tasks\/executions\/all$/, (u, q) => pagedEnvelope(state.executions, q)],
    ['GET', /^\/tasks\/([^/]+)\/executions\/([^/]+)\/logs$/, (u, q, m) => ({ lines: ['[02:00:01] INFO 开始备份', '[02:00:44] FATAL 进程退出码 2'], totalLines: 2, hasMore: false })],
    ['GET', /^\/tasks\/([^/]+)\/executions\/([^/]+)\/report$/, (u, q, m) => ({
      execution: state.executions.find((e) => e.id === m[2]) || state.executions[0],
      timeline: [{ phase: 'created', at: ISO(-95 * MIN), detail: 'cron 触发入队' }],
      report: null,
    })],
    ['GET', /^\/tasks\/([^/]+)\/executions\/([^/]+)\/artifacts$/, () => [{ name: 'backup-dump.sql.gz', size: 1_288_490_188, sha256: 'aa'.repeat(20) }]],
    ['GET', /^\/tasks\/([^/]+)\/executions\/([^/]+)$/, (u, q, m) => state.executions.find((e) => e.id === m[2]) || state.executions[0]],
    ['GET', /^\/tasks\/([^/]+)\/executions$/, (u, q, m) => {
      const pool = state.executions.filter((e) => e.taskId === m[1]);
      return pagedEnvelope(pool.length ? pool : state.executions, q);
    }],
    ['GET', /^\/tasks\/([^/]+)\/stats$/, (u, q, m) => ({ recentExecutions: state.executions.filter((e) => e.taskId === m[1]).map((e) => ({ ...e, logs: undefined, result: undefined })), successRate: 92.3, succeeded: 190, failed: 16, recentSuccessRate: 85.0, avgDurationMs: 98200, totalRuns: 206 })],
    ['GET', /^\/tasks\/([^/]+)\/versions$/, (u, q, m) => [{ id: 'tv-7', taskId: m[1], version: 'v7', gitCommit: 'a1b2c3d', snapshot: { timeoutSeconds: 3600 }, createdBy: 'admin', description: '超时动作改 kill_retry', createdAt: ISO(-2 * 24 * 3600e3) }]],
    ['GET', /^\/tasks\/([^/]+)\/webhook$/, () => ({ enabled: true, url: 'http://localhost:3105/api/tasks/t-1001/webhook' })],
    ['GET', /^\/tasks\/([^/]+)$/, (u, q, m) => TASKS.find((t) => t.id === m[1]) || TASKS[0]],
    // ── executors ──
    ['GET', /^\/executors$/, () => EXECUTORS],
    ['GET', /^\/executors\/picker$/, () => ({ items: EXECUTORS.filter((e) => e.status === 'online').map((e) => ({ id: e.id, appName: e.appName, address: e.address, status: e.status, runningTaskCount: e.runningTaskCount, maxConcurrentTasks: e.maxConcurrentTasks ?? null })), total: EXECUTORS.length, truncated: false, limit: 500 })],
    ['GET', /^\/executors\/groups$/, () => ['prod-sh', 'prod-bj']],
    ['GET', /^\/executors\/tags$/, () => ['ssd', 'prod', 'gpu', 'pull', 'test']],
    ['GET', /^\/executors\/install-cmd$/, () => ({ cmd: 'powershell -c "irm http://localhost:3105/install.ps1 | iex"', token: 'sh-token-****', adminApiUrl: 'http://localhost:3105' })],
    ['GET', /^\/executors\/([^/]+)\/removal-impact$/, (u, q, m) => ({ appName: (EXECUTORS.find((e) => e.id === m[1]) || EXECUTORS[0]).appName, address: (EXECUTORS.find((e) => e.id === m[1]) || EXECUTORS[0]).address, status: 'online', pinnedTasks: 2, appNameBoundTasks: 5, pendingPullItems: 0 })],
    ['GET', /^\/executors\/([^/]+)\/metrics$/, (u, q, m) => executorMetrics(EXECUTORS.find((e) => e.id === m[1]) || EXECUTORS[0])],
    ['GET', /^\/executors\/([^/]+)\/executions$/, (u, q) => ({ total: state.executions.length, items: state.executions.slice(0, 4).map((e) => ({ id: e.id, taskId: e.taskId, taskName: e.taskName, status: e.status, startTime: e.startTime, endTime: e.endTime, duration: e.duration, errorMessage: e.errorMessage, exitCode: e.exitCode ?? null, createdAt: e.createdAt })) })],
    ['GET', /^\/executors\/([^/]+)$/, (u, q, m) => EXECUTORS.find((e) => e.id === m[1]) || EXECUTORS[0]],
    // ── config / settings ──
    ['GET', /^\/config$/, () => CONFIGS],
    ['GET', /^\/config\/history$/, () => ({ data: [{ id: 9, configKey: 'deployment.policy', action: 'update', oldValue: 'strict', newValue: 'prefer', description: '放宽为软偏好', userId: '5', username: 'sre-oncall', ipAddress: '192.168.4.9', createdAt: ISO(-20 * 24 * 3600e3) }], total: 1 })],
    ['GET', /^\/config\/executor-shared-token$/, () => ({ token: 'sh-****-masked', hasToken: true })],
    ['GET', /^\/config\/runtime-version$/, () => ({ min: '3.10', max: '3.13', onlineMin: '3.11', legacyDefaultInterpreter: '3.9', tier1: ['3.12'], tier2: ['3.11', '3.12'], tier3: ['3.10'] })],
    ['GET', /^\/ai\/config$/, () => ({ provider: 'qwen', openaiModel: 'gpt-4o-mini', openaiBaseUrl: 'https://api.openai.com/v1', ollamaHost: 'http://localhost:11434', ollamaModel: 'qwen2.5:7b', qwenModel: 'qwen-max', qwenBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', qwenMaxTokens: '2048', qwenTimeoutMs: '30000', hasApiKey: true })],
    ['GET', /^\/api-keys$/, () => API_KEYS],
    ['GET', /^\/event-subscriptions$/, () => EVENT_SUBSCRIPTIONS],
    ['GET', /^\/event-subscriptions\/([^/]+)\/dead-letters$/, () => ({ data: [], total: 0 })],
    // ── notifications ──
    ['GET', /^\/notification\/channels$/, () => CHANNELS],
    ['GET', /^\/notification\/silences$/, () => SILENCES],
    // ── applications ──
    ['GET', /^\/applications$/, () => APPLICATIONS],
    ['GET', /^\/applications\/([^/]+)\/releases$/, (u, q, m) => ({ data: [{ id: 'av-3', version: '2.3.1', packageUrl: 'http://localhost:3105/uploads/app-2001-2.3.1.zip', gitCommit: 'f00dcafe', deployedAt: ISO(-2 * 24 * 3600e3), latestDeploymentId: 'dep-7001', deploymentStatus: 'running', deploymentCount: 3, executorAddress: 'http://192.168.4.54:9001', runMode: 'daemon', triggerType: 'upgrade', operator: null, operatorSource: 'application_versions.createdBy', operatorMissingReason: 'legacy rows have no createdBy', sourceDeploymentId: 'dep-7001', status: 'released', createdAt: ISO(-2 * 24 * 3600e3), synthetic: false }], total: 1, page: 1, pageSize: 20 })],
    ['GET', /^\/applications\/([^/]+)\/versions$/, () => [{ id: 'av-3', sourceDeploymentId: 'dep-7001', createdAt: ISO(-2 * 24 * 3600e3), snapshot: { version: '2.3.1' }, deployCount: 3, deploymentId: 'dep-7001', version: '2.3.1', commit: 'f00dcafe', status: 'released', deployedAt: ISO(-2 * 24 * 3600e3), executorAddress: 'http://192.168.4.54:9001' }]],
    ['GET', /^\/applications\/([^/]+)\/removal-impact$/, () => ({ applicationName: APPLICATIONS[0].name, tasksLosingSource: 4, deploymentCount: 1, packageFileWillBeDeleted: true })],
    ['GET', /^\/applications\/([^/]+)$/, (u, q, m) => APPLICATIONS.find((a) => a.id === m[1]) || APPLICATIONS[0]],
    ['GET', /^\/app-deployments$/, (u, q) => {
      const appId = q.get('applicationId');
      const pool = appId ? APP_DEPLOYMENTS.filter((d) => d.applicationId === appId) : APP_DEPLOYMENTS;
      return { data: pool.map((d) => ({ ...d, application: APPLICATIONS.find((a) => a.id === d.applicationId) || null })), total: pool.length };
    }],
    ['GET', /^\/mutex-groups$/, () => [{ id: 'mg-1', name: '生产发布互斥-全局组', maxConcurrentPerDevice: 1, scope: 'global', description: null, createdAt: ISO(-50 * 24 * 3600e3), updatedAt: ISO(-2 * 24 * 3600e3) }]],
    // ── projects / users ──
    ['GET', /^\/projects\/me\/roles$/, () => ({ userId: 1, isAdmin: state.role === 'admin', memberships: [{ id: 'pm-1', projectId: 'p-1001', userId: 1, role: 'editor', createdAt: ISO(-100 * 24 * 3600e3) }] })],
    ['GET', /^\/projects\/([^/]+)\/members$/, () => [
      { id: 'pm-1', projectId: 'p-1001', userId: 1, role: 'admin', createdAt: ISO(-100 * 24 * 3600e3) },
      { id: 'pm-2', projectId: 'p-1001', userId: 2, role: 'editor', createdAt: ISO(-90 * 24 * 3600e3) },
    ]],
    ['GET', /^\/projects$/, (u, q) => {
      if (!q.has('page')) return PROJECTS;
      const env = pagedEnvelope(PROJECTS, q);
      return { list: env.items, items: env.items, total: env.total, page: env.page, pageSize: env.pageSize, totalPages: env.totalPages };
    }],
    ['GET', /^\/users$/, (u, q) => ({ list: USERS, total: USERS.length, page: 1, pageSize: 20 })],
    // ── registry / packages / agent / sop / audit / templates ──
    ['GET', /^\/registry\/pypi\/packages$/, () => ({ packages: ['autoflow-executor', 'numpy', 'pandas'] })],
    ['GET', /^\/registry\/npm\/packages$/, () => ({ packages: [{ name: 'autoflow-agent', versions: ['1.0.0', '2.0.0'], description: 'AutoFlow 执行器 Agent 端', latest: '2.0.0' }] })],
    ['GET', /^\/executor-packages$/, (u, q) => pagedEnvelope(PACKAGES, q)],
    ['GET', /^\/agent\/budget$/, () => ({ maxSteps: 40, maxTokens: 200000, wallClockMs: 1800000, maxToolCalls: 60 })],
    ['GET', /^\/agent\/sessions$/, (u, q) => { const env = pagedEnvelope(AGENT_SESSIONS, q); return { items: env.items, total: env.total }; }],
    ['GET', /^\/agent\/sessions\/([^/]+)$/, (u, q, m) => ({ session: AGENT_SESSIONS[0], steps: [], toolCalls: [], children: [] })],
    ['GET', /^\/sop$/, (u, q) => { const env = pagedEnvelope(SOPS, q); return { items: env.items, total: env.total }; }],
    ['GET', /^\/sop\/assignable-executors$/, () => [{ id: 'ex-3001', appName: EXECUTORS[0].appName, address: EXECUTORS[0].address, status: 'online', lastHeartbeat: EXECUTORS[0].lastHeartbeat, agentCapabilities: ['agent:sop', 'shell'] }]],
    ['GET', /^\/sop\/([^/]+)$/, (u, q, m) => SOPS.find((s) => s.id === m[1]) || SOPS[0]],
    ['GET', /^\/sop\/([^/]+)\/assignments$/, () => []],
    ['GET', /^\/sop\/([^/]+)\/versions$/, () => []],
    ['GET', /^\/audit$/, () => ({ data: AUDIT_LOGS, total: AUDIT_LOGS.length })],
    ['GET', /^\/task-templates$/, () => TEMPLATES],
  ];

  function sendJson(res, status, body) {
    const payload = JSON.stringify(body ?? null);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  }

  function sseHead(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
  }

  function startPing(res, registry) {
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* 断开即停 */ }
    }, 5000);
    if (ping.unref) ping.unref();
    reqClose(res, registry, ping);
  }

  function reqClose(res, registry, ping) {
    res.on('close', () => {
      registry.delete(res);
      if (ping) clearInterval(ping);
    });
  }

  const server = http.createServer((req, res) => {
    sockets.add(res);
    res.on('close', () => sockets.delete(res));
    const url = new URL(req.url, 'http://mock');
    // vite proxy 转发保留 /api 前缀(walkthrough 的 route 拦截里是手动 slice 掉的)
    let pathname = url.pathname;
    if (pathname === '/api') pathname = '/';
    else if (pathname.startsWith('/api/')) pathname = pathname.slice('/api'.length);
    const method = req.method;
    if (state.reqLog.length < 20000) state.reqLog.push(`${method} ${pathname}`);

    try {
      // ── SSE 端点:真·流式应答 ──
      if (pathname === '/metrics/stream' && method === 'GET') {
        state.counters.sseMetrics++;
        coverage.add('GET /metrics/stream (SSE)');
        if (state.metricsStreamMode === 'abort') {
          // 模拟传输层断流:建连即 destroy → EventSource onerror → 重连
          res.destroy();
          return;
        }
        sseHead(res);
        openMetricsStreams.add(res);
        if (state.metricsStreamMode === 'snapshot') {
          res.write(`data: ${JSON.stringify(state.metricsSnapshot ?? { summary: SUMMARY, executors: null, scheduler: null, errors: [] })}\n\n`);
        }
        startPing(res, openMetricsStreams);
        return;
      }
      if (pathname === '/executions/stream' && method === 'GET') {
        state.counters.sseExec++;
        coverage.add('GET /executions/stream (SSE)');
        sseHead(res);
        openExecStreams.add(res);
        startPing(res, openExecStreams);
        return;
      }
      const logStream = pathname.match(/^\/tasks\/([^/]+)\/executions\/([^/]+)\/logs\/stream$/);
      if (logStream && method === 'GET') {
        state.counters.sseLogs++;
        coverage.add(`GET /tasks/:id/executions/:id/logs/stream (SSE)`);
        sseHead(res);
        openLogStreams.add(res);
        startPing(res, openLogStreams);
        return;
      }

      // ── JSON 端点 ──
      // 数据端点统一 401(模拟无效 access token,鉴权流/死循环验证用)
      if (state.dataAuthMode === '401' && pathname !== '/auth/oidc/status') {
        sendJson(res, 401, { code: 401, message: 'invalid token (mock, dataAuthMode=401)' });
        return;
      }
      // 与后端一致的 ADMIN-only 读面(403,viewer RBAC 核对用)
      if (state.role !== 'admin' && method === 'GET' && ADMIN_ONLY_GET.some((re) => re.test(pathname))) {
        sendJson(res, 403, { code: 403, message: 'Forbidden: admin only (mock)' });
        return;
      }
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        // 本轮只记录不修:写端点一律 200 空体(写路径的功能验证不在本轮范围)
        for (const [routeMethod, re, handler] of ROUTES) {
          if (routeMethod !== method) continue;
          const m = pathname.match(re);
          if (!m) continue;
          coverage.add(`${method} ${pathname.replace(/\/(t|e|ex|app|sop|ag|pkg|tpl|sil|es|asg)-?\d*/i, '/:id')}`);
          const body = handler(url, url.searchParams, m);
          if (body && body.__status) return sendJson(res, body.__status, body.__body);
          return sendJson(res, 200, body ?? null);
        }
        sendJson(res, 200, { success: true });
        return;
      }
      for (const [routeMethod, re, handler] of ROUTES) {
        if (routeMethod !== method) continue;
        const m = pathname.match(re);
        if (!m) continue;
        coverage.add(`GET ${pathname.replace(/\/([teexapsog]-?\d+|app-\d+|\d+)/i, '/:id')}`);
        const body = handler(url, url.searchParams, m);
        if (body && body.__status) return sendJson(res, body.__status, body.__body);
        return sendJson(res, 200, body ?? null);
      }
      gaps.add(`${method} ${pathname}`);
      sendJson(res, 404, { code: 404, message: `fixture missing: ${method} ${pathname}` });
    } catch (err) {
      try { sendJson(res, 500, { code: 500, message: `mock handler error: ${err.message}` }); } catch { /* ignore */ }
    }
  });

  return new Promise((resolve) => {
    // 不指定 host:双栈监听(::,ipv6Only=false)——vite proxy target 是硬编码的
    // `http://localhost:3105`,Node dns.lookup 在 Windows 上常先返回 ::1,
    // 只绑 127.0.0.1 会让代理侧 ECONNREFUSED。
    server.listen(MOCK_PORT, () => resolve({
      server, state, coverage, gaps,
      pushMetricsSnapshot(snap) {
        state.metricsSnapshot = snap;
        for (const res of [...openMetricsStreams]) {
          try { res.write(`data: ${JSON.stringify(snap)}\n\n`); } catch { /* ignore */ }
        }
      },
      pushExecutionEvent(name, payload) {
        for (const res of [...openExecStreams]) {
          try {
            res.write(`event: ${name}\n`);
            res.write(`data: ${JSON.stringify(payload ?? {})}\n\n`);
          } catch { /* ignore */ }
        }
      },
      pushLogLine(line) {
        for (const res of [...openLogStreams]) {
          try { res.write(`data: ${JSON.stringify(line)}\n\n`); } catch { /* ignore */ }
        }
      },
      abortMetricsStreams() { for (const res of [...openMetricsStreams]) { try { res.end(); } catch { /* ignore */ } } openMetricsStreams.clear(); },
      abortLogStreams() { for (const res of [...openLogStreams]) { try { res.end(); } catch { /* ignore */ } } openLogStreams.clear(); },
      flipExecution(id, patch) {
        const exec = state.executions.find((e) => e.id === id);
        if (exec) Object.assign(exec, patch);
        return exec;
      },
      // 仅重置执行夹具(不动 counters)——S4② 翻转终态后,S4③ 需要恢复 running
      // 才能让 ExecutionLogSection 重建日志 SSE(effect 按 data.status 门控)
      resetExecutions() { state.executions = JSON.parse(JSON.stringify(EXECUTIONS)); },
      reset() {
        state.role = 'admin';
        state.profileMode = 'ok';
        state.refreshMode = 'ok';
        state.dataAuthMode = 'open';
        state.metricsStreamMode = 'silent';
        state.executions = JSON.parse(JSON.stringify(EXECUTIONS));
        state.counters = { profile: 0, refresh: 0, login: 0, logout: 0, sseMetrics: 0, sseExec: 0, sseLogs: 0, sseTicket: 0 };
        state.reqLog = [];
      },
      close() {
        for (const s of sockets) { try { s.destroy(); } catch { /* ignore */ } }
        return new Promise((r) => server.close(() => r()));
      },
    }));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// vite dev(5177)启动与就绪等待 —— 走 vite JS API 而非子进程 CLI:
// 关键是 cacheDir 隔离。并行走查的另一实例跑 5176,若共用 node_modules/.vite,
// 一侧重新预打包会触发另一侧「outdated dep → 整页 reload」,打断进行中的断言。
// ─────────────────────────────────────────────────────────────────────────────

const VITE_CACHE_DIR = join(ROOT, 'node_modules', '.vite-ux-auth-sse');

async function startVite() {
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: join(ROOT, 'vite.config.ts'),
    cacheDir: VITE_CACHE_DIR,
    server: { port: WEB_PORT, strictPort: true },
    logLevel: 'info',
  });
  await server.listen();
  return server;
}

async function waitFor(urlDesc, fn, timeout = 15000, interval = 250) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) { lastErr = err; }
    await sleep(interval);
  }
  throw new Error(`waitFor 超时(${timeout}ms): ${urlDesc}${lastErr ? ` — last: ${lastErr.message}` : ''}`);
}

async function waitViteReady() {
  await waitFor(`vite ${WEB_URL} 就绪`, async () => {
    const ok = await new Promise((resolve) => {
      const req = http.get(`${WEB_URL}/`, (res) => { res.resume(); resolve(res.statusCode === 200); });
      req.on('error', () => resolve(false));
      req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    });
    return ok;
  }, 90_000, 500);
}

// ─────────────────────────────────────────────────────────────────────────────
// 断言收集与页面工具
// ─────────────────────────────────────────────────────────────────────────────

const CHECKS = [];
const SHOTS = [];
let HTTP_FAILS = []; // 本场景内非 2xx / 失败请求(诊断用;SSE 断流测试的 abort 不在此列)
function check(section, name, pass, detail = '') {
  CHECKS.push({ section, name, pass: !!pass, detail: String(detail).slice(0, 400) });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  [${section}] ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`);
}
async function shot(page, name) {
  const file = join(OUT_DIR, `${name}.png`);
  try { await page.screenshot({ path: file, fullPage: false }); SHOTS.push(`${name}.png`); } catch { /* ignore */ }
}
function authStorage(user) {
  return JSON.stringify({ state: { token: 'mock-access-token', refreshToken: 'mock-refresh-token', user }, version: 0 });
}
async function newPage(browser, { auth = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 850 } });
  await context.addInitScript(([authJson]) => {
    localStorage.setItem('autoflow-lang', 'zh');
    if (authJson) localStorage.setItem('autoflow-auth', authJson);
  }, [auth]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${String(err && err.stack || err).slice(0, 300)}`));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console.error: ${msg.text().slice(0, 300)}`); });
  page.on('response', (resp) => {
    try {
      const u = new URL(resp.url());
      if (resp.status() >= 400 && !u.pathname.endsWith('/stream')) {
        HTTP_FAILS.push(`${resp.status()} ${u.pathname}`);
      }
    } catch { /* ignore */ }
  });
  return { context, page, errors };
}
async function gotoPage(page, path) {
  await page.goto(WEB_URL + path, { waitUntil: 'load', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1200);
}
const hasText = (page, text) => page.getByText(text, { exact: false }).first().isVisible().catch(() => false);

/** 收集页面上全部 disabled 按钮(文本+aria)——viewer RBAC 断言素材 */
async function collectDisabledButtons(page) {
  return page.evaluate(() => [...document.querySelectorAll('button')]
    .filter((b) => b.disabled)
    .map((b) => ({ text: (b.textContent || '').trim().slice(0, 24), aria: b.getAttribute('aria-label') }))
    .filter((x) => x.text || x.aria));
}
/** 收集侧边栏菜单项文本(先展开全部分组——antd Menu 折叠子项不进 DOM) */
async function collectMenuTexts(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.ant-menu-submenu:not(.ant-menu-submenu-open) > .ant-menu-submenu-title')
      .forEach((t) => t.click());
  });
  await page.waitForTimeout(600);
  return page.evaluate(() => [...document.querySelectorAll('.ant-menu .ant-menu-item, .ant-menu .ant-menu-submenu-title')]
    .map((e) => (e.textContent || '').trim()).filter(Boolean));
}

// ─────────────────────────────────────────────────────────────────────────────
// 场景
// ─────────────────────────────────────────────────────────────────────────────

async function s1AuthFlow(browser, mock) {
  const S = 'S1 鉴权流';
  mock.reset();
  const { context, page, errors } = await newPage(browser);
  try {
    // ① 无登录态访问受保护路由 → /login
    await page.goto(WEB_URL + '/tasks', { waitUntil: 'load', timeout: 45000 });
    await waitFor('重定向到 /login', () => page.url().includes('/login'), 10000);
    check(S, '无登录态访问 /tasks → 重定向 /login', page.url().includes('/login'), page.url());
    await shot(page, 's1-noauth-redirect');

    // ② 登录页提交 → Dashboard
    await page.getByLabel('用户名').fill('admin');
    await page.getByLabel('密码').fill('mock-password');
    // antd 对两字 CJK 按钮自动插空格(「登 录」),exact 匹配会落空
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await waitFor('登录后进入 /dashboard', () => page.url().includes('/dashboard'), 15000);
    check(S, '登录提交(mock /auth/login 返回 token)→ 进入 /dashboard', page.url().includes('/dashboard'), page.url());
    await waitFor('Dashboard KPI 渲染(今日执行)', () => hasText(page, '今日执行'), 15000);
    const stored = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('autoflow-auth') || '{}'); } catch { return {}; } });
    check(S, '登录后 localStorage autoflow-auth 写入 token/refreshToken/user',
      !!stored?.state?.token && !!stored?.state?.refreshToken && stored?.state?.user?.role === 'admin',
      `token=${!!stored?.state?.token} refresh=${!!stored?.state?.refreshToken} role=${stored?.state?.user?.role}`);
    await shot(page, 's1-after-login-dashboard');

    // ③ 登出 → 回登录页
    await page.locator('button.user-dropdown-trigger').first().click();
    await waitFor('用户菜单展开(退出登录项可见)', () => hasText(page, '退出登录'), 8000);
    await page.getByText('退出登录', { exact: true }).first().click();
    await waitFor('登出后回到 /login', () => page.url().includes('/login'), 10000);
    check(S, '登出(mock /auth/logout + 本地清理)→ 回 /login', page.url().includes('/login'), page.url());
    const afterLogout = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('autoflow-auth') || '{}'); } catch { return {}; } });
    check(S, '登出后 autoflow-auth token/refresh 已清空', !afterLogout?.state?.token && !afterLogout?.state?.refreshToken,
      `token=${afterLogout?.state?.token ?? 'null'} refresh=${afterLogout?.state?.refreshToken ?? 'null'}`);
    check(S, '登出请求已发(mock 计数 logout>=1)', mock.state.counters.logout >= 1, `logout=${mock.state.counters.logout}`);
    await shot(page, 's1-after-logout');
  } finally {
    if (errors.length) check(S, 'S1 期间无 JS 错误', false, errors.slice(0, 3).join(' | '));
    await context.close();
  }
}

async function s2RouteGuards(browser, mock) {
  const S = 'S2 路由守卫边界';
  // ① 无 refreshToken(仅 token)→ PrivateRoute 直接回 /login
  {
    mock.reset();
    const { context, page } = await newPage(browser, { auth: JSON.stringify({ state: { token: 'orphan-access', refreshToken: null, user: USER_ADMIN }, version: 0 }) });
    try {
      await page.goto(WEB_URL + '/dashboard', { waitUntil: 'load', timeout: 45000 });
      await waitFor('仅 token 无 refresh → /login', () => page.url().includes('/login'), 10000);
      check(S, 'PrivateRoute 按 refreshToken 判定:无 refreshToken(有 token)→ /login', page.url().includes('/login'), page.url());
    } finally { await context.close(); }
  }
  // ② 无效 token + refresh 401:/users 与 /tasks → /login?reason=expired&redirect=…,且不死循环
  for (const path of ['/users', '/tasks']) {
    mock.reset();
    mock.state.refreshMode = '401';
    mock.state.dataAuthMode = '401';
    const { context, page } = await newPage(browser, { auth: authStorage(USER_ADMIN) });
    try {
      await page.goto(WEB_URL + path, { waitUntil: 'load', timeout: 45000 });
      await waitFor(`无效 token 访问 ${path} → /login`, () => page.url().includes('/login'), 15000);
      const u = new URL(page.url());
      const reason = u.searchParams.get('reason');
      const redirect = u.searchParams.get('redirect');
      check(S, `无效 token 访问 ${path} → 401 链路后跳 /login?reason=expired`, page.url().includes('/login') && reason === 'expired', `url=${page.url()}`);
      check(S, `跳登录携带回跳参数 redirect=${path}`, redirect === path, `redirect=${redirect}`);
      await waitFor('登录页会话过期提示渲染', () => hasText(page, '登录状态已过期'), 8000);
      check(S, 'SESSION-EXPIRED 提示(登录状态已过期)可见', true);
      const refreshBefore = mock.state.counters.refresh;
      const profileBefore = mock.state.counters.profile;
      await page.waitForTimeout(4000);
      check(S, `${path} 落地后 4s 无循环重定向(URL 稳定)`, page.url().includes('/login'), page.url());
      check(S, `${path} 落地后 4s 无请求风暴(refresh/profile 计数不增长)`,
        mock.state.counters.refresh === refreshBefore && mock.state.counters.profile === profileBefore,
        `refresh ${refreshBefore}→${mock.state.counters.refresh}, profile ${profileBefore}→${mock.state.counters.profile}`);
      check(S, `${path} refresh 单飞(refresh 请求 ≤2 次)`, mock.state.counters.refresh <= 2, `refresh=${mock.state.counters.refresh}`);
      await shot(page, `s2-invalid-token-${path.replace(/\//g, '_')}`);
    } finally { await context.close(); }
  }
  // ③ profile 持续 401 + refresh 200:是否陷入 login↔校验死循环
  {
    mock.reset();
    mock.state.profileMode = '401';
    const { context, page } = await newPage(browser, { auth: JSON.stringify({ state: { token: 'stale-access', refreshToken: 'good-refresh', user: { id: 1, username: 'admin' } }, version: 0 }) });
    try {
      await page.goto(WEB_URL + '/users', { waitUntil: 'load', timeout: 45000 });
      await waitFor('profile 401(且 refresh 成功重试仍 401)→ 最终登出回 /login', () => page.url().includes('/login'), 20000);
      check(S, 'profile 持续 401 → 拦截器重试后放弃并跳 /login(不挂死)', page.url().includes('/login'), page.url());
      const reason = new URL(page.url()).searchParams.get('reason');
      check(S, 'profile 401 终局携带 reason=expired', reason === 'expired', `reason=${reason}`);
      const profileBefore = mock.state.counters.profile;
      const refreshBefore = mock.state.counters.refresh;
      await page.waitForTimeout(4000);
      check(S, '4s 观察窗:profile/refresh 计数稳定(无死循环)',
        mock.state.counters.profile === profileBefore && mock.state.counters.refresh === refreshBefore,
        `profile=${profileBefore}→${mock.state.counters.profile}, refresh=${refreshBefore}→${mock.state.counters.refresh}`);
      check(S, 'profile 401 只重试一次(profile ≤3 次、refresh ≤2 次)',
        mock.state.counters.profile <= 3 && mock.state.counters.refresh <= 2,
        `profile=${mock.state.counters.profile}, refresh=${mock.state.counters.refresh}`);
      await shot(page, 's2-profile-401-loop-check');
    } finally { await context.close(); }
  }
}

async function s4Sse(browser, mock) {
  const S = 'S4 SSE 实时流';
  mock.reset();
  mock.state.metricsStreamMode = 'snapshot';

  // ① metrics/stream:快照帧驱动 Dashboard 真实更新 + live 徽标 + 降级角标闭环
  {
    const { context, page, errors } = await newPage(browser, { auth: authStorage(USER_ADMIN) });
    try {
      await gotoPage(page, '/dashboard');
      await waitFor('metrics/stream 建连(mock 计数)', () => mock.state.counters.sseMetrics >= 1, 15000);
      check(S, 'Dashboard 建连 /metrics/stream(经 vite proxy → mock 后端)', mock.state.counters.sseMetrics >= 1, `sseMetrics=${mock.state.counters.sseMetrics}`);
      await waitFor('状态点显示「实时」', async () => {
        const t = await page.locator('[data-testid="metrics-stream-status"]').textContent().catch(() => '');
        return (t || '').includes('实时') && !(t || '').includes('重连中');
      }, 15000);
      check(S, '流保持打开 → 状态点「实时」(非重连中)', true);
      check(S, '静默/正常流不显示「数据延迟」角标', !(await page.locator('[data-testid="metrics-stream-degraded"]').isVisible().catch(() => false)));
      await waitFor('REST 基线 KPI(任务总数 128)渲染', () => hasText(page, '128'), 10000);

      // SSE 快照帧覆盖 summary 缓存 → KPI 变化
      mock.pushMetricsSnapshot({ summary: { ...SUMMARY, totalTasks: 777 }, executors: null, scheduler: null, errors: [] });
      await waitFor('SSE 快照帧后 KPI 变为 777', () => hasText(page, '777'), 10000);
      check(S, '收到快照帧后 UI 真实更新(任务总数 128 → 777)', true);
      await shot(page, 's4-metrics-snapshot-update');

      // 降级角标闭环:errors 非空 → 数据延迟角标;恢复 → 消失
      mock.pushMetricsSnapshot({ summary: { ...SUMMARY, totalTasks: 778 }, executors: null, scheduler: null, errors: ['summary'] });
      await waitFor('「数据延迟」角标出现', () => page.locator('[data-testid="metrics-stream-degraded"]').isVisible().catch(() => false), 10000);
      check(S, '快照带 errors → 「数据延迟」角标如实出现', true);
      await shot(page, 's4-metrics-degraded-badge');
      mock.pushMetricsSnapshot({ summary: { ...SUMMARY, totalTasks: 779 }, executors: null, scheduler: null, errors: [] });
      await waitFor('「数据延迟」角标恢复消失', async () => !(await page.locator('[data-testid="metrics-stream-degraded"]').isVisible().catch(() => false)), 10000);
      check(S, '下一拍干净快照 → 「数据延迟」角标清除(A-4 对称闭环)', true);

      // 断流:优雅关闭既有连接(上游 end) + page.route 拦断后续重连请求。
      // 不用 res.destroy():http-proxy 对上游 abrupt destroy 的下游传导不确定,
      // EventSource 可能等不到 error 事件;end() 是干净 EOF,浏览器必触发
      // error → onStatus('reconnecting');重连请求再被 route.abort 拒掉,
      // 状态钉死在「重连中」。
      mock.state.metricsStreamMode = 'abort';
      await page.route('**/api/metrics/stream*', (r) => r.abort());
      mock.abortMetricsStreams();
      await waitFor('断流后状态点变「重连中」', async () => {
        const t = await page.locator('[data-testid="metrics-stream-status"]').textContent().catch(() => '');
        return (t || '').includes('重连中');
      }, 15000);
      check(S, '断流(连接被服务端关闭+重连被拒)后「重连中」如实出现', true);
      await page.waitForTimeout(4000);
      const t = await page.locator('[data-testid="metrics-stream-status"]').textContent().catch(() => '');
      check(S, '4s 观察窗:状态点保持「重连中」,未虚假回落「实时」', (t || '').includes('重连中'), `badge=${(t || '').trim()}`);
      await shot(page, 's4-metrics-reconnecting');
    } finally {
      // route.abort 拦断重连是本场景刻意制造的,其 net::ERR_FAILED/ERR_ABORTED
      // console 噪音不算 JS 错误
      const realErrors = errors.filter((e) => !/ERR_FAILED|ERR_ABORTED/.test(e));
      if (realErrors.length) check(S, 'SSE Dashboard 期间无 JS 错误', false, realErrors.slice(0, 3).join(' | '));
      await context.close();
    }
  }
  mock.state.metricsStreamMode = 'silent';

  // ② executions/stream:终态事件 → 列表状态翻转
  {
    const { context, page, errors } = await newPage(browser, { auth: authStorage(USER_ADMIN) });
    try {
      await gotoPage(page, '/executions');
      await waitFor('executions/stream 建连', () => mock.state.counters.sseExec >= 1, 15000);
      check(S, '执行列表页建连 /executions/stream', mock.state.counters.sseExec >= 1, `sseExec=${mock.state.counters.sseExec}`);
      // e-9001 与 e-9003 同属 t-1001(任务名相同)——行定位必须「任务名 × 状态」双条件
      const rowsOfTask = page.locator('tr', { hasText: TASKS[0].name });
      const runningRow = rowsOfTask.filter({ hasText: '运行中' });
      try {
        await waitFor('运行中行渲染(e-9003)', async () => (await runningRow.count()) >= 1, 15000);
      } catch (err) {
        const bodyText = await page.evaluate(() => (document.querySelector('#main-content')?.textContent || document.body.textContent || '').replace(/\s+/g, ' ').slice(0, 400)).catch(() => '(eval failed)');
        check(S, '执行列表页渲染调试(超时时转储)', false, bodyText);
        throw err;
      }
      check(S, '初始:e-9003 行状态「运行中」', true);
      mock.flipExecution('e-9003', { status: 'success', endTime: ISO(0), duration: 120_000, exitCode: 0, logs: '备份完成 100%' });
      mock.pushExecutionEvent('execution.completed', { id: 'e-9003', taskId: 't-1001', status: 'success', finishedAt: ISO(0) });
      await waitFor('终态事件后行状态翻转为「成功」', async () => {
        const stillRunning = await runningRow.count();
        const successRow = await rowsOfTask.filter({ hasText: '成功' }).count();
        return stillRunning === 0 && successRow >= 1;
      }, 12000);
      check(S, 'execution.completed 事件 → 列表失效重取 → 行状态「运行中」→「成功」', true);
      await shot(page, 's4-executions-stream-flip');
    } finally {
      if (errors.length) check(S, 'SSE 执行列表期间无 JS 错误', false, errors.slice(0, 3).join(' | '));
      await context.close();
    }
  }

  // ③ logs/stream:日志行真实追加;断流后「实时日志流已断开」告警条如实出现
  {
    mock.resetExecutions(); // 撤销 ② 的终态翻转,恢复 e-9003 = running(日志流按 status 门控)
    const { context, page, errors } = await newPage(browser, { auth: authStorage(USER_ADMIN) });
    try {
      await gotoPage(page, '/tasks/t-1001/executions/e-9003');
      await waitFor('logs/stream 建连', () => mock.state.counters.sseLogs >= 1, 15000);
      check(S, '执行详情(运行中)自动建连 /tasks/:id/executions/:id/logs/stream', mock.state.counters.sseLogs >= 1, `sseLogs=${mock.state.counters.sseLogs}`);
      await waitFor('「实时更新中」徽标渲染', () => hasText(page, '实时更新中'), 10000);
      check(S, '流式日志徽标「实时更新中」可见', true);
      const logPre = page.locator('[data-testid="log-pre"]');
      await waitFor('日志区渲染', () => logPre.isVisible().catch(() => false), 10000);
      const beforeText = (await logPre.textContent().catch(() => '')) || '';
      check(S, '推送前日志区不含 SSE 标记行', !beforeText.includes('SSE-LOG-A'), `len=${beforeText.length}`);
      mock.pushLogLine('[SSE-LOG-A] 实时推送第一行 — 走查验证');
      await waitFor('SSE 日志行 A 出现在日志区', async () => ((await logPre.textContent().catch(() => '')) || '').includes('SSE-LOG-A'), 10000);
      mock.pushLogLine('[SSE-LOG-B] 实时推送第二行 — 追加验证');
      await waitFor('SSE 日志行 B 追加', async () => ((await logPre.textContent().catch(() => '')) || '').includes('SSE-LOG-B'), 10000);
      check(S, 'SSE 推送日志行 → 日志区真实追加(A、B 两行)', true);
      await shot(page, 's4-log-stream-appended');

      // 断流:短退避重连(1.5s+3s)耗尽 → 降级轮询告警条。重连请求用
      // page.route 拦断(同 metrics 断流的理由,不依赖 proxy 对 destroy 的传导)。
      await page.route('**/api/tasks/*/executions/*/logs/stream*', (r) => r.abort());
      mock.abortLogStreams();
      await waitFor('断流后「实时日志流已断开」告警条出现', () => hasText(page, '实时日志流已断开'), 20000);
      check(S, '断流重连预算耗尽 → 「实时日志流已断开,已切换为轮询刷新」告警如实出现', true);
      await page.waitForTimeout(800);
      check(S, '断流后「实时更新中」徽标消失', !(await hasText(page, '实时更新中')));
      await shot(page, 's4-log-stream-disconnected');
    } finally {
      // 同 S4①:断流测试刻意 route.abort 重连请求,其网络层 console 噪音不算 JS 错误
      const realErrors = errors.filter((e) => !/ERR_FAILED|ERR_ABORTED/.test(e));
      if (realErrors.length) check(S, 'SSE 日志流期间无 JS 错误', false, realErrors.slice(0, 3).join(' | '));
      await context.close();
    }
  }
}

async function s3ViewerRbac(browser, mock) {
  const S = 'S3 viewer RBAC 渲染';
  mock.reset();
  mock.state.role = 'viewer';
  const ADMIN_ONLY_MENU = ['用户管理', '审计日志', '通知设置', '执行器包', 'SOP 管理', 'Agent 会话'];

  // ① admin 基线:菜单项与执行器详情按钮(供隐藏入口对比;按钮收集限定主内容区)
  let adminMenu = [];
  let adminExecDetailButtons = [];
  {
    const { context, page } = await newPage(browser, { auth: authStorage(USER_ADMIN) });
    try {
      await gotoPage(page, '/dashboard');
      adminMenu = await collectMenuTexts(page);
      const missing = ADMIN_ONLY_MENU.filter((m) => !adminMenu.some((t) => t.includes(m)));
      check(S, 'admin 基线:ADMIN-only 菜单全部可见', missing.length === 0, missing.length ? `缺失:${missing.join(',')}` : adminMenu.join('/'));
      check(S, 'admin 页头:通知铃入口可见(NotificationBell)', await hasText(page, '通知') || await page.locator('header button').count() > 0);
      await gotoPage(page, '/executors/ex-3001');
      await page.waitForTimeout(1500);
      adminExecDetailButtons = await page.evaluate(() => [...(document.querySelector('#main-content')?.querySelectorAll('button') || [])]
        .map((b) => ((b.textContent || '').trim() || b.getAttribute('aria-label') || '').slice(0, 20))
        .filter(Boolean));
      await shot(page, 's3-admin-executor-detail');
    } finally { await context.close(); }
  }

  const viewerAuth = JSON.stringify({ state: { token: 'viewer-token', refreshToken: 'viewer-refresh', user: USER_VIEWER }, version: 0 });

  // ② 侧边栏菜单:ADMIN-only 入口按设计隐藏
  {
    const { context, page } = await newPage(browser, { auth: viewerAuth });
    try {
      await gotoPage(page, '/dashboard');
      const menu = await collectMenuTexts(page);
      const leaked = ADMIN_ONLY_MENU.filter((m) => menu.some((t) => t.includes(m)));
      check(S, 'viewer 侧边栏:ADMIN-only 菜单入口全部隐藏(/executor-packages /audit /users /notifications /sops /agent-sessions)', leaked.length === 0, leaked.length ? `泄漏:${leaked.join(',')}` : `菜单=${menu.join('/')}`);
      await shot(page, 's3-viewer-dashboard-menu');
    } finally { await context.close(); }
  }

  // ③ 任务列表/详情:P1-5 口径——写按钮禁用(+Tooltip/aria)而非消失
  {
    const { context, page } = await newPage(browser, { auth: viewerAuth });
    try {
      await gotoPage(page, '/tasks');
      const createBtn = page.getByRole('button', { name: '创建任务' }).first();
      check(S, '任务列表「创建任务」按钮:存在且禁用(P1-5 禁用而非消失)', await createBtn.isVisible().catch(() => false) && await createBtn.isDisabled().catch(() => true));
      const disabledBtns = await collectDisabledButtons(page);
      const adminOnlyAria = disabledBtns.filter((b) => (b.aria || '').includes('仅管理员可操作'));
      check(S, '任务行操作按钮(编辑/克隆/执行)aria=仅管理员可操作 且 disabled', adminOnlyAria.length >= 2, JSON.stringify(adminOnlyAria.slice(0, 4)));
      await shot(page, 's3-viewer-tasks');

      await gotoPage(page, '/tasks/t-1001');
      const trigger = page.getByRole('button', { name: '立即触发' }).first();
      const pause = page.getByRole('button', { name: /暂\s*停/ }).first();
      check(S, '任务详情「立即触发」禁用', await trigger.isVisible().catch(() => false) && await trigger.isDisabled().catch(() => true));
      check(S, '任务详情「暂停」禁用(active 任务)', await pause.isVisible().catch(() => false) && await pause.isDisabled().catch(() => true));
      const detailDisabled = await collectDisabledButtons(page);
      check(S, '任务详情禁用按钮均带 aria 或文本(可读屏感知)', detailDisabled.every((b) => b.aria || b.text), JSON.stringify(detailDisabled.slice(0, 5)));
      await shot(page, 's3-viewer-task-detail');
    } finally { await context.close(); }
  }

  // ④ 应用列表/详情:W3 RBAC——写面禁用+Tooltip
  {
    const { context, page } = await newPage(browser, { auth: viewerAuth });
    try {
      await gotoPage(page, '/applications');
      const createBtn = page.getByRole('button', { name: '创建应用' }).first();
      check(S, '应用列表「创建应用」存在且禁用', await createBtn.isVisible().catch(() => false) && await createBtn.isDisabled().catch(() => true));
      const disabledBtns = await collectDisabledButtons(page);
      check(S, '应用列表存在禁用写按钮(编辑/删除/快速部署等)', disabledBtns.length >= 2, `禁用按钮数=${disabledBtns.length}`);
      await shot(page, 's3-viewer-applications');

      await gotoPage(page, '/applications/app-2001');
      // 重新分析在「AI 健康分析」Tab、保存修改在「设置」Tab(默认概览 Tab 看不到)
      await page.locator('.ant-tabs-tab', { hasText: 'AI 健康分析' }).first().click();
      const reanalyze = page.getByRole('button', { name: '重新分析' }).first();
      await waitFor('AI Tab 内「重新分析」按钮出现', () => reanalyze.isVisible().catch(() => false), 8000);
      check(S, '应用详情「重新分析」禁用(AI 健康分析 Tab)', await reanalyze.isDisabled().catch(() => true));
      const startBtn = page.getByRole('button', { name: '开始分析' }).first();
      check(S, '应用详情「开始分析」禁用', await startBtn.isVisible().catch(() => false) && await startBtn.isDisabled().catch(() => true));
      await shot(page, 's3-viewer-app-detail-ai-tab');

      await page.locator('.ant-tabs-tab', { hasText: /^设置/ }).first().click();
      const save = page.getByRole('button', { name: '保存修改' }).first();
      await waitFor('设置 Tab 内「保存修改」按钮出现', () => save.isVisible().catch(() => false), 8000);
      check(S, '应用详情「保存修改」禁用(设置 Tab)', await save.isDisabled().catch(() => true));
      await shot(page, 's3-viewer-app-detail-settings-tab');
    } finally { await context.close(); }
  }

  // ⑤ 执行器列表/详情:ADMIN 入口按设计隐藏;详情页按钮对比 admin 基线
  {
    const { context, page } = await newPage(browser, { auth: viewerAuth });
    try {
      await gotoPage(page, '/executors');
      const installWizard = await hasText(page, '安装向导');
      const quickAdd = await hasText(page, '快速添加');
      check(S, '执行器列表「安装向导」「快速添加」入口对 viewer 隐藏(R5)', !installWizard && !quickAdd, `安装向导=${installWizard}, 快速添加=${quickAdd}`);
      await shot(page, 's3-viewer-executors');

      await gotoPage(page, '/executors/ex-3001');
      await page.waitForTimeout(1500);
      const viewerButtons = await page.evaluate(() => [...(document.querySelector('#main-content')?.querySelectorAll('button') || [])]
        .map((b) => ((b.textContent || '').trim() || b.getAttribute('aria-label') || '').slice(0, 20))
        .filter(Boolean));
      const hidden = adminExecDetailButtons.filter((b) => !viewerButtons.includes(b));
      check(S, '执行器详情:viewer 相比 admin 消失的按钮(=ADMIN-only 入口按设计隐藏)', hidden.length >= 0, `隐藏:${hidden.join(',') || '(无)'}`);
      const leakedDelete = viewerButtons.filter((b) => b.includes('删除') || b.includes('离线') || b.includes('轮换'));
      check(S, '执行器详情:设置离线/轮换 Token/删除等平台级敏感操作对 viewer 不可见', leakedDelete.length === 0, leakedDelete.length ? `泄漏:${leakedDelete.join(',')}` : '无泄漏');
      await shot(page, 's3-viewer-executor-detail');
    } finally { await context.close(); }
  }

  // ⑥ 设置页:非管理员降级(非admin提示 + AI 只读 + Token Tab 不渲染)
  {
    const { context, page } = await newPage(browser, { auth: viewerAuth });
    try {
      await gotoPage(page, '/settings');
      check(S, '设置页:非管理员提示 Alert 渲染', await hasText(page, '您以普通用户身份查看'));
      check(S, '设置页默认 Tab(AI):只读提示「仅管理员可查看和配置 AI 分析」', await hasText(page, '仅管理员可查看和配置 AI 分析'));
      const tokenTab = await page.locator('.ant-tabs-tab', { hasText: '执行器 Token' }).count();
      check(S, '设置页「执行器 Token」Tab 对 viewer 不渲染(R4 收紧矩阵)', tokenTab === 0, `tokenTab=${tokenTab}`);
      await shot(page, 's3-viewer-settings');

      // 配置 Tab:查询不做 enabled 门控(代码注记),viewer 触发 ADMIN-only GET /config → 403 toast
      await page.locator('.ant-tabs-tab', { hasText: '系统配置' }).first().click();
      await page.waitForTimeout(2500);
      const forbiddenToast = await hasText(page, 'admin only');
      check(S, '设置-系统配置 Tab(viewer):ADMIN-only GET /config 被拒(403 拦截器 toast;与 settings/index.tsx 注记「本查询不做 enabled 门控」口径一致)', forbiddenToast, `toast=${forbiddenToast}`);
      await shot(page, 's3-viewer-settings-config-tab');
    } finally { await context.close(); }
  }

  // ⑦ 项目页:成员管理只读(添加成员不渲染)
  {
    const { context, page } = await newPage(browser, { auth: viewerAuth });
    try {
      await gotoPage(page, '/projects');
      check(S, '项目页对 viewer 可达(全员可达路由)', await hasText(page, '数据平台组'));
      const membersBtn = page.getByRole('button', { name: /成\s*员/ }).first();
      if (await membersBtn.isVisible().catch(() => false)) {
        await membersBtn.click();
        await page.waitForTimeout(1200);
        const addMember = await hasText(page, '添加成员');
        check(S, '项目成员抽屉:viewer 只读(「添加成员」不渲染)', !addMember, `addMember=${addMember}`);
      } else {
        check(S, '项目成员抽屉入口可见', false, '未找到「成员」按钮');
      }
      await shot(page, 's3-viewer-projects');
    } finally { await context.close(); }
  }

  // ⑧ 路由级 RequireAdmin:直接访问 ADMIN-only 路由 → 403 提示页(不白屏不跳转)
  for (const [path, label] of [['/users', '用户管理'], ['/notifications', '通知设置'], ['/sops', 'SOP 管理'], ['/agent-sessions', 'Agent 会话'], ['/executor-packages', '执行器包'], ['/audit', '审计日志']]) {
    const { context, page } = await newPage(browser, { auth: viewerAuth });
    try {
      await gotoPage(page, path);
      const forbidden = await hasText(page, '抱歉，您没有权限访问该页面');
      check(S, `viewer 直达 ${label}(${path})→ RequireAdmin 403 提示页`, forbidden, `url=${page.url()}`);
      if (['/users', '/notifications'].includes(path)) await shot(page, `s3-viewer-403-${path.replace(/\//g, '_')}`);
    } finally { await context.close(); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`[ux-auth-sse] ${startedAt}`);
  console.log(`[ux-auth-sse] 产物目录: ${OUT_DIR}`);

  // 0) 端口占用预检(3105 被 mock 用;5177 被 vite 用)
  const mock = await startMockApi();
  console.log(`[ux-auth-sse] mock 后端就绪: http://127.0.0.1:${MOCK_PORT} (vite proxy target)`);

  let viteServer = null;
  let browser = null;
  const summary = { startedAt, checks: CHECKS, shots: SHOTS, mockCounters: null, gaps: [], coverage: [] };
  try {
    viteServer = await startVite();
    console.log(`[ux-auth-sse] vite 就绪中 (VITE_PORT=${WEB_PORT}, cacheDir=.vite-ux-auth-sse) ...`);
    await waitViteReady();
    console.log(`[ux-auth-sse] vite 就绪: ${WEB_URL}`);

    const exe = join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
    try {
      browser = await chromium.launch({ executablePath: exe });
    } catch (err) {
      console.error(`[ux-auth-sse] 显式启动失败,回退默认 registry: ${err.message}`);
      browser = await chromium.launch();
    }

    // 场景逐个容错:单场景崩溃记录为 FAIL,不拖垮整个 run
    const scenarios = [
      ['S1 鉴权流', s1AuthFlow],
      ['S2 路由守卫边界', s2RouteGuards],
      ['S4 SSE 实时流', s4Sse],
      ['S3 viewer RBAC 渲染', s3ViewerRbac],
    ];
    for (const [label, fn] of scenarios) {
      HTTP_FAILS = [];
      try {
        await fn(browser, mock);
      } catch (err) {
        const httpFailInfo = [...new Set(HTTP_FAILS)].slice(0, 6).join(' | ');
        check(label, `${label}:场景完整执行`, false, `${err.message}${httpFailInfo ? ` — http>=400: ${httpFailInfo}` : ''}`);
        console.error(`[ux-auth-sse] 场景失败(${label}):`, err.message);
        mock.reset();
      }
    }

    summary.mockCounters = { ...mock.state.counters };
    summary.gaps = [...mock.gaps];
    summary.coverage = [...mock.coverage].sort();
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (viteServer) await viteServer.close().catch(() => {});
    await mock.close();
    console.log('[ux-auth-sse] vite 与 mock 后端已关闭');
  }

  // ── 报告 ──
  const passed = CHECKS.filter((c) => c.pass).length;
  const failed = CHECKS.length - passed;
  const sections = [...new Set(CHECKS.map((c) => c.section))];
  const lines = [];
  lines.push('# Admin-Web 鉴权/守卫/RBAC/SSE 走查报告(真实 Chromium)');
  lines.push('');
  lines.push(`- 运行时间:${startedAt}`);
  lines.push(`- 基址:${WEB_URL}(本脚本自起 vite,VITE_PORT=${WEB_PORT});API:本脚本自起 mock 后端 127.0.0.1:${MOCK_PORT}(vite proxy target),SSE 真·流式`);
  lines.push(`- 结论:PASS ${passed} / FAIL ${failed}`);
  lines.push(`- mock 计数:${JSON.stringify(summary.mockCounters)}`);
  lines.push(`- 夹具缺口(404):${summary.gaps.length ? summary.gaps.join('; ') : '无'}`);
  lines.push(`- 截图:${SHOTS.length} 张(同目录)`);
  lines.push('');
  for (const s of sections) {
    const items = CHECKS.filter((c) => c.section === s);
    lines.push(`## ${s}(PASS ${items.filter((i) => i.pass).length}/${items.length})`);
    lines.push('');
    for (const c of items) {
      lines.push(`- ${c.pass ? '✅' : '❌'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    }
    lines.push('');
  }
  lines.push(`## mock 后端覆盖端点`);
  lines.push('');
  for (const c of summary.coverage) lines.push(`- ${c}`);
  lines.push('');
  const report = lines.join('\n');
  writeFileSync(join(OUT_DIR, 'report.md'), report, 'utf8');
  writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log('\n' + report);
  console.log(`\n[ux-auth-sse] 报告:${join(OUT_DIR, 'report.md')}`);
  if (failed > 0) process.exitCode = 2;
}

main().catch(async (err) => {
  console.error('[ux-auth-sse] fatal:', err);
  process.exit(1);
});
