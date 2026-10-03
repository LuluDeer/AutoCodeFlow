// ux-walkthrough.mjs — 真实 Chromium 渲染走查(375/1280 双视口)
//
// 背景:三轮移动端治理(R5/R6)与多轮 UX 修复全部基于 jsdom 断言,从未经过真实
// 布局引擎。本脚本用 playwright-core(本目录 node_modules)直接驱动本机
// Chromium(%LOCALAPPDATA%/ms-playwright/chromium-1234),在 vite dev(5176)上
// 访问 router.tsx 全部页面:
//   - 375×812:检测 document 横向溢出(scrollWidth > innerWidth+1)+ 找出超出
//     视口最宽的元素(tag.class + 文本片段);
//   - 1280×800:冒烟——只确认渲染无 JS 错误;
//   - 全程收集 console error/warning(标注 i18next missing-key、React key/prop
//     告警)、pageerror、以及 404 的 /api 请求(=夹具缺口,记录端点名)。
//
// 本机无 Docker / 无后端(PG/Redis 不存在),API 全部走 context.route('**/api/**')
// 夹具供数,形状从 src/api/*.ts 的 TypeScript 接口逐字段推导。
//
// 刻意**不放 e2e/ 目录**:e2e/ 是 CI 权威套件的 testDir,新文件会被 CI 拾取;
// 本脚本是本地走查工具,独立运行:
//   node scripts/ux-walkthrough.mjs            (需先 npm run dev,端口 5176)
// 产物:apps/admin-web/test-results/ux-walkthought 见 OUT_DIR(根 .gitignore 的
// `test-results/` 已覆盖该目录,不会入库)。

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'test-results', 'ux-walkthrough');
const BASE_URL = process.env.WALKTHROUGH_BASE_URL || 'http://localhost:5176';
const ISO = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const MIN = 60_000;

mkdirSync(OUT_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// 夹具数据(形状对齐 src/api/*.ts 的接口)
// ─────────────────────────────────────────────────────────────────────────────

const USER = { id: 1, username: 'admin', email: 'admin@autoflow.local', role: 'admin' };

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
  { id: 'e-9001', taskId: 't-1001', taskName: TASKS[0].name, status: 'failed', triggerType: 'cron', executorAddress: 'http://192.168.4.54:9001', startTime: ISO(-95 * MIN), endTime: ISO(-94 * MIN), duration: 61_230, params: { target: 'pg-prod-1' }, logs: '[2026-10-03 02:00:01] 开始备份\n[2026-10-03 02:00:44] FATAL: OSS 凭据失效', errorMessage: 'OSS 上传失败: SignatureDoesNotMatch', failureReason: 'credential', exitCode: 2, aiAnalysis: '疑似对象存储凭据轮换后未同步到任务级 secrets。', retryCount: 2, taskVersion: 'v7', traceId: '4bf92f3577b34da6a3ce929d0e0e4736', resolvedPackageVersion: null, result: { interpreter: { requested: '3.12', resolved: '3.12.13', reason: 'match', pool: 'uv' } }, createdAt: ISO(-95 * MIN) },
  { id: 'e-9002', taskId: 't-1005', taskName: TASKS[4].name, status: 'success', triggerType: 'cron', executorAddress: 'http://192.168.4.54:9001', startTime: ISO(-20 * MIN), endTime: ISO(-18 * MIN), duration: 121_000, exitCode: 0, logs: '巡检完成,7/7 通过', createdAt: ISO(-20 * MIN), retryCount: 0, taskVersion: 'v2' },
  { id: 'e-9003', taskId: 't-1001', taskName: TASKS[0].name, status: 'running', triggerType: 'api', executorAddress: 'http://192.168.4.60:9001', startTime: ISO(-2 * MIN), logs: '备份进行中 34%', createdAt: ISO(-2 * MIN) },
  { id: 'e-9004', taskId: 't-1002', taskName: TASKS[1].name, status: 'timeout', triggerType: 'fixed_rate', executorAddress: 'http://192.168.4.61:9001', startTime: ISO(-3 * 3600e3), endTime: ISO(-3 * 3600e3 + 600e3), duration: 600_000, errorMessage: '执行超时(600s)', failureReason: 'timeout', exitCode: null, createdAt: ISO(-3 * 3600e3) },
  { id: 'e-9005', taskId: 't-1003', taskName: TASKS[2].name, status: 'killed', triggerType: 'cron', executorAddress: 'http://192.168.4.62:9001', startTime: ISO(-26 * 3600e3), endTime: ISO(-25 * 3600e3), duration: 2100e3, errorMessage: '管理员手动终止', createdAt: ISO(-26 * 3600e3), exitCode: 137 },
];

const EXECUTORS = [
  { id: 'ex-3001', appName: '上海电信机房-生产执行器-01-长名称验证用例', address: 'http://192.168.4.54:9001', status: 'online', type: 'python', executorVersion: '2.14.0', cpuUsage: 62.5, memUsage: 71.2, diskUsage: 55.0, networkLatency: 8, runningTaskCount: 3, totalTaskCount: 512, failedTaskCount: 9, lastHeartbeat: ISO(-30e3), groupName: 'prod-sh', tags: ['ssd', 'prod', 'gpu'], description: '上海金融中心机房主力执行器,承载生产备份与巡检任务', maxConcurrentTasks: 10, projectId: null, runningExecutionIds: ['e-9003'], reservedSlots: 0, deadLetterCount: 0, dispatchMode: 'push', protocolVersion: 2, versionCompliant: true, offlineReason: null, interpreters: [{ version: '3.11.9', available: true, discoveredAt: ISO(-3 * 24 * 3600e3) }, { version: '3.12.13', path: 'C:/Python312/python.exe', available: true, discoveredAt: ISO(-1 * 24 * 3600e3) }] },
  { id: 'ex-3002', appName: '北京联通节点-02', address: 'http://10.8.0.12:9001', status: 'online', executorVersion: '2.14.0', cpuUsage: 28.1, memUsage: 44.8, runningTaskCount: 1, lastHeartbeat: ISO(-45e3), groupName: 'prod-bj', tags: ['pull'], maxConcurrentTasks: 6, dispatchMode: 'pull', protocolVersion: 2, versionCompliant: true, interpreters: [{ version: '3.12.13', available: true }] },
  { id: 'ex-3003', appName: '办公室测试机-工位-07', address: 'http://192.168.1.107:9001', status: 'offline', executorVersion: '2.9.1', cpuUsage: 0, memUsage: 0, runningTaskCount: 0, lastHeartbeat: ISO(-26 * 3600e3), groupName: null, tags: ['test'], description: '工位开发机,下班关机', maxConcurrentTasks: 4, dispatchMode: 'push', versionCompliant: false, offlineReason: 'stale_timeout', interpreters: null },
  { id: 'ex-3004', appName: '华东云节点-03-弹性伸缩组a', address: 'http://10.20.3.7:9001', status: 'online', executorVersion: '2.13.2', cpuUsage: 84.9, memUsage: 90.3, diskUsage: 78, runningTaskCount: 8, totalTaskCount: 1100, failedTaskCount: 41, lastHeartbeat: ISO(-20e3), groupName: 'cloud-ecn', tags: ['cloud'], maxConcurrentTasks: 12, dispatchMode: 'push', versionCompliant: true, interpreters: [{ version: '3.10.14', available: true }, { version: '3.12.13', available: true }] },
  { id: 'ex-3005', appName: '边缘一体机-门店编号0001', address: 'http://10.66.0.1:9001', status: 'online', executorVersion: '2.12.0', cpuUsage: 12.0, memUsage: 38.0, runningTaskCount: 0, lastHeartbeat: ISO(-2 * MIN), groupName: 'edge', tags: ['edge'], maxConcurrentTasks: 2, dispatchMode: 'pull', protocolVersion: 1, versionCompliant: true, interpreters: [] },
];

const APPLICATIONS = [
  { id: 'app-2001', name: '数据采集平台-生产环境-长名称验证用例', description: '分布式采集与清洗管线,含 12 个子任务', version: '2.3.1', runtime: 'python', status: 'running', gitRepo: 'https://git.example.com/data/collector.git', gitBranch: 'main', gitCommit: 'f00dcafe', entrypoint: 'main.py', approvalRequired: true, mutexGroupId: 'mg-1', env: { LOG_LEVEL: 'info' }, manifest: { tasks: 12 }, createdAt: ISO(-80 * 24 * 3600e3), updatedAt: ISO(-2 * 24 * 3600e3) },
  { id: 'app-2002', name: '报表服务', description: '日报/周报导出', version: '1.0.0', runtime: 'node', status: 'stopped', gitRepo: 'https://git.example.com/bi/report.git', gitBranch: 'master', gitCommit: 'beef1234', entrypoint: 'index.js', createdAt: ISO(-120 * 24 * 3600e3), updatedAt: ISO(-30 * 24 * 3600e3) },
  { id: 'app-2003', name: '运维工具箱', description: null, version: '0.9.2', runtime: 'shell', status: 'running', createdAt: ISO(-50 * 24 * 3600e3), updatedAt: ISO(-4 * 24 * 3600e3) },
  { id: 'app-2004', name: '爬虫集群-电商价格监控', description: '多站点价格抓取', version: '3.7.0', runtime: 'python', status: 'failed', createdAt: ISO(-15 * 24 * 3600e3), updatedAt: ISO(-1 * 24 * 3600e3) },
];

const APP_DEPLOYMENTS = [
  { id: 'dep-7001', applicationId: 'app-2001', executorId: 'ex-3001', executorAddress: 'http://192.168.4.54:9001', status: 'running', runMode: 'daemon', deployedCommit: 'f00dcafe', deployedVersion: '2.3.1', startCommand: 'python main.py', env: { LOG_LEVEL: 'info' }, pid: 4200, lastHeartbeat: ISO(-30e3), statusMessage: '运行正常', deployedAt: ISO(-2 * 24 * 3600e3), approvalStatus: 'approved', approvalMeta: { requestedBy: 2, requestedByName: '王运维', requestedAt: ISO(-2 * 24 * 3600e3 - 3600e3), actedBy: 1, actedByName: 'admin', actedAt: ISO(-2 * 24 * 3600e3), reason: '常规发布' }, rolloutState: 'promoted', createdAt: ISO(-2 * 24 * 3600e3), updatedAt: ISO(-1 * 3600e3) },
  { id: 'dep-7002', applicationId: 'app-2002', executorId: 'ex-3002', executorAddress: 'http://10.8.0.12:9001', status: 'stopped', runMode: 'scheduled', deployedCommit: 'beef1234', deployedVersion: '1.0.0', startCommand: 'node index.js', env: null, pid: null, lastHeartbeat: null, statusMessage: '已停止', deployedAt: ISO(-30 * 24 * 3600e3), approvalStatus: null, approvalMeta: null, rolloutState: null, createdAt: ISO(-30 * 24 * 3600e3), updatedAt: ISO(-20 * 24 * 3600e3) },
  { id: 'dep-7003', applicationId: 'app-2004', executorId: 'ex-3004', executorAddress: 'http://10.20.3.7:9001', status: 'failed', runMode: 'once', deployedCommit: null, deployedVersion: '3.7.0', startCommand: null, env: null, pid: null, lastHeartbeat: null, statusMessage: '依赖安装失败: numpy 轮子不匹配', deployedAt: null, approvalStatus: null, approvalMeta: null, rolloutState: 'failed', createdAt: ISO(-1 * 24 * 3600e3), updatedAt: ISO(-1 * 24 * 3600e3) },
];

const USERS = [
  { id: 1, username: 'admin', email: 'admin@autoflow.local', role: 'admin', createdAt: ISO(-365 * 24 * 3600e3), updatedAt: ISO(-10 * 24 * 3600e3) },
  { id: 2, username: '王运维', email: 'wang.ops@autoflow.local', role: 'user', createdAt: ISO(-200 * 24 * 3600e3), updatedAt: ISO(-8 * 24 * 3600e3) },
  { id: 3, username: 'li.data', email: 'li.data@autoflow.local', role: 'user', createdAt: ISO(-150 * 24 * 3600e3), updatedAt: ISO(-6 * 24 * 3600e3) },
  { id: 4, username: '张前端-超长用户名验证用例', email: 'zhang.fe@autoflow.local', role: 'user', createdAt: ISO(-90 * 24 * 3600e3), updatedAt: ISO(-3 * 24 * 3600e3) },
  { id: 5, username: 'sre-oncall', email: 'sre@autoflow.local', role: 'admin', createdAt: ISO(-60 * 24 * 3600e3), updatedAt: ISO(-1 * 24 * 3600e3) },
];

const PROJECTS = [
  { id: 'p-1000', name: '默认项目', description: '未归属任务/应用的兜底视图', createdAt: ISO(-365 * 24 * 3600e3), updatedAt: ISO(-10 * 24 * 3600e3), myRole: 'admin' },
  { id: 'p-1001', name: '数据平台组-用户画像与报表-长名称验证用例', description: '画像宽表、标签、报表', createdAt: ISO(-200 * 24 * 3600e3), updatedAt: ISO(-2 * 24 * 3600e3), myRole: 'editor' },
  { id: 'p-1002', name: '数据采集平台', description: null, createdAt: ISO(-100 * 24 * 3600e3), updatedAt: ISO(-3 * 24 * 3600e3), myRole: 'admin' },
  { id: 'p-1003', name: '前端基建', description: 'admin-web 与组件库', createdAt: ISO(-80 * 24 * 3600e3), updatedAt: ISO(-1 * 24 * 3600e3), myRole: null },
  { id: 'p-1004', name: '边缘节点运维', description: '门店一体机', createdAt: ISO(-30 * 24 * 3600e3), updatedAt: ISO(-8 * 3600e3), myRole: 'viewer' },
];

const SOPS = [
  { id: 'sop-5001', slug: 'weekly-db-maintenance', title: '数据库周维护-SOP-含超长标题验证用例-上海金融中心机房-primary-cluster', currentVersion: 'v3', status: 'published', applicationId: null, frontMatterJson: { owner: 'sre' }, bodyMarkdown: '## 步骤\n1. 检查主从延迟\n2. 切换流量', createdBy: 'admin', createdAt: ISO(-90 * 24 * 3600e3), updatedAt: ISO(-2 * 24 * 3600e3) },
  { id: 'sop-5002', slug: 'executor-onboarding', title: '新执行器接入', currentVersion: 'v1', status: 'published', applicationId: 'app-2001', frontMatterJson: {}, bodyMarkdown: '安装 → 注册 → 试跑', createdBy: 'admin', createdAt: ISO(-60 * 24 * 3600e3), updatedAt: ISO(-10 * 24 * 3600e3) },
  { id: 'sop-5003', slug: 'incident-oss-credentials', title: 'OSS 凭据轮换应急', currentVersion: null, status: 'draft', applicationId: null, frontMatterJson: null, bodyMarkdown: '草稿', createdBy: '王运维', createdAt: ISO(-3 * 24 * 3600e3), updatedAt: ISO(-1 * 24 * 3600e3) },
  { id: 'sop-5004', slug: 'legacy-log-rotate', title: '旧版日志轮转(已废弃)', currentVersion: 'v2', status: 'deprecated', applicationId: null, frontMatterJson: null, bodyMarkdown: null, createdBy: 'admin', createdAt: ISO(-300 * 24 * 3600e3), updatedAt: ISO(-80 * 24 * 3600e3) },
];

const SOP_ASSIGNMENT = {
  id: 'asg-8001', sopId: 'sop-5001', sopVersion: 'v3', targetExecutorId: 'ex-3001', targetAgentSessionId: 'ag-6001', status: 'in_progress',
  clarificationRound: 1, maxRounds: 3, resultJson: null, parentSessionId: null, pulledAt: ISO(-50 * MIN), lastProgressAt: ISO(-20 * MIN),
  progressJson: { step: '检查主从延迟' }, attempt: 1, lastReplyDeliveredAt: ISO(-30 * MIN), capabilitySnapshotJson: { agent: 'sop' },
  permissionProfileAtPull: 'default', assignedBy: 'admin', createdAt: ISO(-60 * MIN), updatedAt: ISO(-20 * MIN),
};

const AGENT_SESSIONS = [
  { id: 'ag-6001', kind: 'sop_assignment', status: 'running', title: '执行 SOP:数据库周维护', triggerSource: 'sop', parentSessionId: null, contextJson: null, scopeJson: null, budgetJson: { maxSteps: 40, maxTokens: 200000, wallClockMs: 1800000, maxToolCalls: 60 }, resultJson: null, summary: null, errorMessage: null, totalSteps: 12, totalTokensIn: 45230, totalTokensOut: 8120, totalToolCalls: 9, waitingFor: null, startedAt: ISO(-50 * MIN), finishedAt: null, createdAt: ISO(-50 * MIN), updatedAt: ISO(-1 * MIN) },
  { id: 'ag-6002', kind: 'ops_agent', status: 'succeeded', title: '夜间巡检摘要', triggerSource: 'scheduler', parentSessionId: null, contextJson: null, scopeJson: null, budgetJson: null, resultJson: { ok: true }, summary: '全部通过', errorMessage: null, totalSteps: 6, totalTokensIn: 12000, totalTokensOut: 3000, totalToolCalls: 4, waitingFor: null, startedAt: ISO(-8 * 3600e3), finishedAt: ISO(-7.8 * 3600e3), createdAt: ISO(-8 * 3600e3), updatedAt: ISO(-7.8 * 3600e3) },
  { id: 'ag-6003', kind: 'sop_assignment', status: 'waiting_input', title: '执行 SOP:新执行器接入', triggerSource: 'sop', parentSessionId: null, contextJson: null, scopeJson: null, budgetJson: { maxSteps: 40, maxTokens: 200000, wallClockMs: 1800000, maxToolCalls: 60 }, resultJson: null, summary: null, errorMessage: null, totalSteps: 3, totalTokensIn: 8000, totalTokensOut: 1200, totalToolCalls: 2, waitingFor: '澄清:目标机房网段?', startedAt: ISO(-2 * 3600e3), finishedAt: null, createdAt: ISO(-2 * 3600e3), updatedAt: ISO(-1.5 * 3600e3) },
  { id: 'ag-6004', kind: 'ops_agent', status: 'failed', title: '报表数据修复', triggerSource: 'manual', parentSessionId: null, contextJson: null, scopeJson: null, budgetJson: null, resultJson: null, summary: null, errorMessage: '数据库连接超时', totalSteps: 2, totalTokensIn: 4000, totalTokensOut: 800, totalToolCalls: 1, waitingFor: null, startedAt: ISO(-26 * 3600e3), finishedAt: ISO(-25.9 * 3600e3), createdAt: ISO(-26 * 3600e3), updatedAt: ISO(-25.9 * 3600e3) },
  { id: 'ag-6005', kind: 'ops_agent', status: 'budget_exceeded', title: '全量任务梳理', triggerSource: 'manual', parentSessionId: null, contextJson: null, scopeJson: null, budgetJson: { maxSteps: 10, maxTokens: 50000, wallClockMs: 600000, maxToolCalls: 20 }, resultJson: null, summary: null, errorMessage: '超出 maxSteps 预算', totalSteps: 10, totalTokensIn: 60000, totalTokensOut: 15000, totalToolCalls: 20, waitingFor: null, startedAt: ISO(-3 * 24 * 3600e3), finishedAt: ISO(-3 * 24 * 3600e3 + 600e3), createdAt: ISO(-3 * 24 * 3600e3), updatedAt: ISO(-3 * 24 * 3600e3 + 600e3) },
];

const PACKAGES = [
  { id: 'pkg-4001', name: 'autoflow-executor-node', version: '2.14.0', type: 'node', platform: 'win64', fileSize: 18_324_992, sha256: 'ab12'.repeat(16), changelog: '支持协议 v2 控制面', status: 'active', downloadCount: 132, createdAt: ISO(-20 * 24 * 3600e3), updatedAt: ISO(-20 * 24 * 3600e3) },
  { id: 'pkg-4002', name: 'autoflow-executor-node', version: '2.13.2', type: 'node', platform: 'win64', fileSize: 18_100_000, sha256: 'cd34'.repeat(16), changelog: '', status: 'deprecated', downloadCount: 321, createdAt: ISO(-50 * 24 * 3600e3), updatedAt: ISO(-20 * 24 * 3600e3) },
  { id: 'pkg-4003', name: 'autoflow-executor-python', version: '2.14.0', type: 'python', platform: 'linux-x64', fileSize: 24_500_000, sha256: 'ef56'.repeat(16), changelog: 'uv venv 多版本解释器', status: 'active', downloadCount: 88, createdAt: ISO(-20 * 24 * 3600e3), updatedAt: ISO(-20 * 24 * 3600e3) },
  { id: 'pkg-4004', name: 'autoflow-executor-universal', version: '2.12.0', type: 'universal', platform: 'any', fileSize: 30_000_000, sha256: '9900'.repeat(16), changelog: '', status: 'deprecated', downloadCount: 512, createdAt: ISO(-90 * 24 * 3600e3), updatedAt: ISO(-40 * 24 * 3600e3) },
];

const TEMPLATES = [
  { id: 'tpl-1', key: 'scheduled_backup', name: '定时备份', description: '按 cron 周期备份目标并上传存储', category: '备份', config: { triggerType: 'cron', cronExpression: '0 2 * * *', runtime: 'shell', entrypoint: 'backup.sh', timeoutSeconds: 3600, maxRetry: 3, retryDelay: 60, blockStrategy: 'discard' }, createdBy: null, createdAt: ISO(-100 * 24 * 3600e3) },
  { id: 'tpl-2', key: 'health_check', name: '健康巡检', description: '周期探测服务端点并告警', category: '巡检', config: { triggerType: 'fixed_rate', fixedRate: 300, runtime: 'python', timeoutSeconds: 120, maxRetry: 1 }, createdBy: null, createdAt: ISO(-100 * 24 * 3600e3) },
  { id: 'tpl-3', key: 'data_sync', name: '数据同步', description: '跨库/跨仓数据同步', category: '同步', config: { triggerType: 'cron', cronExpression: '0 */2 * * *', runtime: 'node', timeoutSeconds: 1800, maxRetry: 5 }, createdBy: null, createdAt: ISO(-100 * 24 * 3600e3) },
  { id: 'tpl-4', key: 'log_cleanup', name: '日志清理', description: '滚动清理过期日志', category: '清理', config: { triggerType: 'fixed_rate', fixedRate: 1800, runtime: 'shell', entrypoint: 'cleanup.sh', timeoutSeconds: 600, maxRetry: 1 }, createdBy: null, createdAt: ISO(-100 * 24 * 3600e3) },
  { id: 'tpl-5', key: 'webhook_ping', name: 'Webhook 探活', description: '周期 POST 探测回调端点', category: '通知', config: { triggerType: 'fixed_rate', fixedRate: 60, runtime: 'shell', timeoutSeconds: 30, maxRetry: 2 }, createdBy: null, createdAt: ISO(-100 * 24 * 3600e3) },
  { id: 'tpl-6', key: 'custom-monthly-report', name: '自定义-月度报表生成', description: '由 admin 保存的自定义模板', category: '报表', config: { triggerType: 'cron', cronExpression: '0 6 1 * *', runtime: 'python', maxRetry: 2 }, createdBy: 'admin', createdAt: ISO(-10 * 24 * 3600e3) },
];

const CHANNELS = [
  { key: 'email', name: '邮件', enabled: true, config: { smtpHost: 'smtp.example.com', smtpPort: '465', from: 'alert@example.com', to: 'oncall@example.com' }, description: 'SMTP 邮件通知,支持多收件人' },
  { key: 'dingtalk', name: '钉钉', enabled: true, config: { webhook: 'https://oapi.dingtalk.com/robot/send?access_token=***' }, description: '钉钉群机器人 webhook' },
  { key: 'wecom', name: '企业微信', enabled: false, config: {}, description: '企业微信应用消息' },
  { key: 'slack', name: 'Slack', enabled: false, config: {}, description: 'Slack Incoming Webhook' },
  { key: 'webhook', name: '自定义 Webhook', enabled: true, config: { url: 'https://hooks.example.com/autoflow', method: 'POST' }, description: 'POST JSON 到自定义端点' },
];

const SILENCES = [
  { id: 'sil-1', scope: 'task', channelType: null, taskId: 't-1002', applicationId: null, level: null, reason: '日志清理预期抖动,静默一周', startTime: ISO(-2 * 24 * 3600e3), endTime: ISO(5 * 24 * 3600e3), durationMinutes: null, createdBy: 'admin', createdAt: ISO(-2 * 24 * 3600e3) },
  { id: 'sil-2', scope: 'global', channelType: 'dingtalk', taskId: null, applicationId: null, level: 'warn', reason: '停机窗口', startTime: ISO(-8 * 3600e3), endTime: ISO(-2 * 3600e3), durationMinutes: 360, createdBy: 'sre-oncall', createdAt: ISO(-8 * 3600e3) },
];

const CONFIGS = [
  { id: 1, key: 'executor.heartbeat.interval', value: '30000', description: '执行器心跳间隔(毫秒)', valueType: 'number', isSecret: false, tag: 'executor', createdAt: ISO(-300 * 24 * 3600e3), updatedAt: ISO(-60 * 24 * 3600e3) },
  { id: 2, key: 'executor.shared.token', value: null, description: '执行器注册共享令牌(密文存库)', valueType: 'string', isSecret: true, tag: 'executor', createdAt: ISO(-300 * 24 * 3600e3), updatedAt: ISO(-30 * 24 * 3600e3) },
  { id: 3, key: 'notification.default.channels', value: '["email","dingtalk"]', description: '默认通知渠道', valueType: 'json', isSecret: false, tag: 'notification', createdAt: ISO(-280 * 24 * 3600e3), updatedAt: ISO(-10 * 24 * 3600e3) },
  { id: 4, key: 'scheduler.leader.lock.ttl', value: '15', description: '调度器领导锁 TTL(秒)', valueType: 'number', isSecret: false, tag: 'scheduler', createdAt: ISO(-270 * 24 * 3600e3), updatedAt: ISO(-270 * 24 * 3600e3) },
  { id: 5, key: 'ai.provider', value: 'qwen', description: 'AI 分析提供方', valueType: 'string', isSecret: false, tag: 'ai', createdAt: ISO(-120 * 24 * 3600e3), updatedAt: ISO(-5 * 24 * 3600e3) },
  { id: 6, key: 'deployment.policy', value: 'prefer', description: '全局部署约束(strict/prefer)', valueType: 'string', isSecret: false, tag: 'deployment', createdAt: ISO(-90 * 24 * 3600e3), updatedAt: ISO(-20 * 24 * 3600e3) },
];

const API_KEYS = [
  { id: 1, name: 'CI 流水线-部署触发', keyPrefix: 'acf_ci_9f2a', scope: 'trigger', expiresAt: ISO(90 * 24 * 3600e3), revokedAt: null, lastUsedAt: ISO(-3 * 3600e3), createdAt: ISO(-80 * 24 * 3600e3) },
  { id: 2, name: '监控只读拉取', keyPrefix: 'acf_ro_11cd', scope: 'readonly', expiresAt: null, revokedAt: null, lastUsedAt: ISO(-30 * MIN), createdAt: ISO(-120 * 24 * 3600e3) },
  { id: 3, name: '旧版集成(已吊销)', keyPrefix: 'acf_rw_88aa', scope: 'manage', expiresAt: null, revokedAt: ISO(-40 * 24 * 3600e3), lastUsedAt: ISO(-45 * 24 * 3600e3), createdAt: ISO(-200 * 24 * 3600e3) },
];

const EVENT_SUBSCRIPTIONS = [
  { id: 'es-1', userId: 1, eventTypes: ['execution.failed', 'executor.offline'], url: 'https://ci.example.com/hooks/autoflow', secret: '******', enabled: true, consecutiveFailures: 0, lastFailureAt: null, lastFailureError: null, createdAt: ISO(-60 * 24 * 3600e3), updatedAt: ISO(-10 * 24 * 3600e3) },
  { id: 'es-2', userId: 1, eventTypes: ['deployment.completed'], url: 'https://ops.example.com/api/deploy-callback', secret: '******', enabled: true, consecutiveFailures: 5, lastFailureAt: ISO(-4 * 3600e3), lastFailureError: 'connect ETIMEDOUT 10.9.9.9:443', createdAt: ISO(-30 * 24 * 3600e3), updatedAt: ISO(-4 * 3600e3) },
  { id: 'es-3', userId: null, eventTypes: ['execution.completed'], url: 'https://audit.example.com/events', secret: '******', enabled: false, consecutiveFailures: 0, lastFailureAt: null, lastFailureError: null, createdAt: ISO(-90 * 24 * 3600e3), updatedAt: ISO(-80 * 24 * 3600e3) },
];

const AUTH_SESSIONS = [
  { id: 11, createdAt: ISO(-2 * 3600e3), expiresAt: ISO(5 * 3600e3), userAgent: 'Chrome 141 / Windows 10', ip: '192.168.4.2', current: true },
  { id: 7, createdAt: ISO(-3 * 24 * 3600e3), expiresAt: ISO(4 * 24 * 3600e3), userAgent: 'Edge 140 / Windows 11', ip: '192.168.4.9', current: false },
  { id: 5, createdAt: ISO(-9 * 24 * 3600e3), expiresAt: ISO(-1 * 24 * 3600e3), userAgent: 'Chrome 139 / macOS', ip: '10.1.1.4', current: false },
];

const AUDIT_LOGS = [
  { id: 101, action: 'executor.delete', resource: 'executor', resourceId: 'ex-3009', username: 'admin', result: 'success', detail: { address: 'http://10.20.3.9:9001', appName: '废弃云节点', reason: '缩容' }, ip: '192.168.4.2', createdAt: ISO(-2 * 3600e3) },
  { id: 100, action: 'config.update', resource: 'config', resourceId: 'deployment.policy', username: 'sre-oncall', result: 'success', detail: { key: 'deployment.policy', newValue: 'prefer' }, ip: '192.168.4.9', createdAt: ISO(-5 * 3600e3) },
  { id: 99, action: 'user.login', resource: 'user', resourceId: '4', username: '张前端-超长用户名验证用例', result: 'failure', detail: { reason: '密码错误' }, ip: '10.8.0.3', createdAt: ISO(-8 * 3600e3) },
  { id: 98, action: 'sop.publish', resource: 'sop', resourceId: 'sop-5001', username: 'admin', result: 'success', detail: { version: 'v3' }, ip: '192.168.4.2', createdAt: ISO(-2 * 24 * 3600e3) },
  { id: 97, action: 'task.batchDelete', resource: 'task', resourceId: 'batch', username: '王运维', result: 'failure', detail: { count: 12, error: '部分任务仍在运行' }, ip: '192.168.4.30', createdAt: ISO(-3 * 24 * 3600e3) },
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

function executorMetrics(ex) {
  return {
    executor: { id: ex.id, address: ex.address, status: ex.status },
    sevenDayStats: { totalExecutions: 512, successful: 494, failed: 18, successRate: 96.5, averageDurationMs: 8420 },
    current: { runningTaskCount: ex.runningTaskCount, reservedSlots: ex.reservedSlots ?? 0, cpuUsage: ex.cpuUsage, memUsage: ex.memUsage, pendingPullItems: ex.dispatchMode === 'pull' ? 2 : 0 },
    history: EXEC_METRICS_HISTORY,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 路由匹配表: [method, pathname 正则, handler(url, query)]
// handler 返回响应体(裸数据——client.ts 拦截器仅在信封含 code+data 时才拆包,
// 裸数组/裸对象原样通过)。返回 { __status: 204 } 特殊处理空响应。
// ─────────────────────────────────────────────────────────────────────────────

const pagedEnvelope = (items, q) => {
  const page = Math.max(1, parseInt(q.get('page') || '1', 10) || 1);
  const pageSize = Math.max(1, parseInt(q.get('pageSize') || '20', 10) || 20);
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    total: items.length, page, pageSize,
    totalPages: Math.ceil(items.length / pageSize),
  };
};

// tasksApi.list / listAll:必须有 items/total/page/pageSize(+totalPages),
// 且 pageSize/total/page 须与请求参数逐字段一致(tasks.ts validateTaskListPage 校验)。
const TASKS_PAGED = (q) => {
  const env = pagedEnvelope(TASKS, q);
  return { ...env, list: env.items }; // projects 同款 list/items 双键兼容,防未来漂移
};

const ROUTES = [
  // ── auth ──
  ['GET', /^\/auth\/oidc\/status$/, () => ({ enabled: false })],
  ['GET', /^\/auth\/profile$/, () => USER],
  ['POST', /^\/auth\/login$/, () => ({ accessToken: 'mock-access', refreshToken: 'mock-refresh', user: USER })],
  ['POST', /^\/auth\/sse-ticket$/, () => ({ ticket: 'mock-sse-ticket', expiresAt: ISO(30e3) })],
  ['GET', /^\/auth\/sessions$/, () => AUTH_SESSIONS],
  // ── metrics / dashboard ──
  ['GET', /^\/metrics\/summary$/, () => ({ totalTasks: 128, todayRuns: 342, totalExecutors: 12, onlineExecutors: 9, executions: { total: 15230, success: 14520, failed: 512, running: 7 }, successRate: 96.4, avgDurationMs: 5230 })],
  ['GET', /^\/metrics\/trend$/, () => TREND],
  ['GET', /^\/metrics\/executors$/, () => EXECUTORS.slice(0, 5).map((e) => ({ id: e.id, appName: e.appName, address: e.address, status: e.status, cpuUsage: e.cpuUsage, memUsage: e.memUsage, runningTaskCount: e.runningTaskCount, lastHeartbeat: e.lastHeartbeat }))],
  ['GET', /^\/metrics\/failures$/, () => [
    { id: 'e-9001', taskId: 't-1001', taskName: TASKS[0].name, errorMessage: 'OSS 上传失败: SignatureDoesNotMatch', failureReason: 'credential', exitCode: 2, createdAt: ISO(-95 * MIN), duration: 61_230 },
    { id: 'e-9004', taskId: 't-1002', taskName: TASKS[1].name, errorMessage: '执行超时(600s)', failureReason: 'timeout', exitCode: null, createdAt: ISO(-3 * 3600e3), duration: 600_000 },
    { id: 'e-9006', taskId: 't-1003', taskName: TASKS[2].name, errorMessage: '源库连接被拒绝', failureReason: 'network', exitCode: 1, createdAt: ISO(-6 * 3600e3), duration: 2100 },
  ]],
  ['GET', /^\/metrics\/scheduler$/, () => ({
    counters: { ticks: 86400, tickDurationMsTotal: 432000, lastTickDurationMs: 4, lastTickAt: ISO(-1e3), triggersClaimed: 1520, triggersSkippedLockHeld: 3, triggersSkippedDbClaim: 1, triggersSkippedInactive: 42, triggersSkippedBlockStrategy: 6, triggersSkippedMaintenance: 12, triggersFailed: 2, dependencyTriggersClaimed: 30, dependencyTriggersSkipped: 2, triggerLatencyCount: 1520, triggerLatencySumMs: 456000, triggerLatencyBuckets: [1200, 220, 60, 25, 10, 5], lastTriggerLatencyMs: 180, startedAt: ISO(-24 * 3600e3) },
    derived: { avgTickDurationMs: 5, tickRatePerSec: 1, triggerClaimRatePerSec: 0.017, avgTriggerLatencyMs: 300, p99TriggerLatencyMs: 820 },
    queue: { waiting: 3, active: 7, delayed: 12, failed: 2, completed: 15210 },
    scheduler: { healthy: true, isLeader: true, activeTimers: 96, activeCronTasks: 64, runningTaskCount: 7, totalScheduledTasks: 128, uptime: 864000 },
    instance: { pid: 3105, hostname: 'autoflow-admin' },
  })],
  ['GET', /^\/tasks\/scheduler\/stats$/, () => ({ healthy: true, activeTimers: 96, activeCronTasks: 64, runningTaskCount: 7, totalScheduledTasks: 128, uptime: 864000 })],
  // ── tasks ──
  ['GET', /^\/tasks$/, (u, q) => TASKS_PAGED(q)],
  ['GET', /^\/tasks\/executions\/all$/, (u, q) => pagedEnvelope(EXECUTIONS, q)],
  ['GET', /^\/tasks\/executions\/([^/]+)\/artifacts$/, () => [{ name: 'backup-dump.sql.gz', size: 1_288_490_188, sha256: 'aa'.repeat(20) }, { name: '备份日志-中文文件名.txt', size: 4096, sha256: 'bb'.repeat(20) }]],
  ['GET', /^\/tasks\/([^/]+)$/, (u, q, m) => TASKS.find((t) => t.id === m[1]) || TASKS[0]],
  ['GET', /^\/tasks\/([^/]+)\/executions$/, (u, q, m) => {
    const pool = EXECUTIONS.filter((e) => e.taskId === m[1]);
    return pagedEnvelope(pool.length ? pool : EXECUTIONS, q);
  }],
  // tasksApi.execution — GET /tasks/:taskId/executions/:execId(注意必须排在
  // 列表路由之后单独声明,且不能被 /:id 吞掉)
  ['GET', /^\/tasks\/([^/]+)\/executions\/([^/]+)$/, (u, q, m) => EXECUTIONS.find((e) => e.id === m[2]) || EXECUTIONS[0]],
  ['GET', /^\/tasks\/([^/]+)\/executions\/([^/]+)\/logs$/, () => ({ lines: ['[02:00:01] INFO 开始备份', '[02:00:22] INFO 导出 pg_dump 完成 (12.4GB)', '[02:00:44] ERROR OSS 上传失败: SignatureDoesNotMatch', '[02:00:44] FATAL 进程退出码 2'], totalLines: 4, hasMore: false })],
  ['GET', /^\/tasks\/([^/]+)\/executions\/([^/]+)\/report$/, (u, q, m) => ({
    execution: EXECUTIONS.find((e) => e.id === m[2]) || EXECUTIONS[0],
    timeline: [
      { phase: 'created', at: ISO(-95 * MIN), detail: 'cron 触发入队' },
      { phase: 'started', at: ISO(-95 * MIN + 2e3), detail: 'executor http://192.168.4.54:9001 认领' },
      { phase: 'finished', at: ISO(-94 * MIN), detail: '失败: OSS 上传失败' },
    ],
    report: null,
  })],
  ['GET', /^\/tasks\/([^/]+)\/stats$/, (u, q, m) => ({
    recentExecutions: EXECUTIONS.filter((e) => e.taskId === m[1]).concat(EXECUTIONS.slice(0, 2)).map((e) => ({ ...e, logs: undefined, result: undefined })),
    successRate: 92.3, succeeded: 190, failed: 16, recentSuccessRate: 85.0, avgDurationMs: 98200, totalRuns: 206,
  })],
  ['GET', /^\/tasks\/([^/]+)\/versions$/, () => [
    { id: 'tv-3', taskId: 't-1001', version: 'v3', gitCommit: '111aaaa', snapshot: { entrypoint: 'jobs/backup_full.py' }, createdBy: 'admin', description: '初始版本', createdAt: ISO(-30 * 24 * 3600e3) },
    { id: 'tv-5', taskId: 't-1001', version: 'v5', gitCommit: '222bbbb', snapshot: { maxRetry: 5 }, createdBy: '王运维', description: '提高重试预算', createdAt: ISO(-10 * 24 * 3600e3) },
    { id: 'tv-7', taskId: 't-1001', version: 'v7', gitCommit: 'a1b2c3d', snapshot: { timeoutSeconds: 3600 }, createdBy: 'admin', description: '超时动作改 kill_retry', createdAt: ISO(-2 * 24 * 3600e3) },
  ]],
  ['GET', /^\/tasks\/([^/]+)\/webhook$/, () => ({ enabled: true, url: 'http://localhost:3105/api/tasks/t-1001/webhook' })],
  // ── executors ──
  ['GET', /^\/executors$/, () => EXECUTORS],
  ['GET', /^\/executors\/picker$/, () => ({ items: EXECUTORS.filter((e) => e.status === 'online').map((e) => ({ id: e.id, appName: e.appName, address: e.address, status: e.status, runningTaskCount: e.runningTaskCount, maxConcurrentTasks: e.maxConcurrentTasks ?? null })), total: EXECUTORS.length, truncated: false, limit: 500 })],
  ['GET', /^\/executors\/groups$/, () => ['prod-sh', 'prod-bj', 'cloud-ecn', 'edge']],
  ['GET', /^\/executors\/tags$/, () => ['ssd', 'prod', 'gpu', 'pull', 'test', 'cloud', 'edge']],
  ['GET', /^\/executors\/runtime-config$/, () => ({ heartbeatIntervalMs: 30000, heartbeatTimeoutMultiplier: 3, heartbeatTimeoutMs: 90000, listLimit: 500, executorTotal: EXECUTORS.length })],
  ['GET', /^\/executors\/install-cmd$/, () => ({ cmd: 'powershell -c "irm http://localhost:3105/install.ps1 | iex"', token: 'sh-token-****', adminApiUrl: 'http://localhost:3105' })],
  ['GET', /^\/executors\/([^/]+)\/removal-impact$/, (u, q, m) => ({ appName: (EXECUTORS.find((e) => e.id === m[1]) || EXECUTORS[0]).appName, address: (EXECUTORS.find((e) => e.id === m[1]) || EXECUTORS[0]).address, status: 'online', pinnedTasks: 2, appNameBoundTasks: 5, pendingPullItems: 0 })],
  ['GET', /^\/executors\/([^/]+)\/metrics$/, (u, q, m) => executorMetrics(EXECUTORS.find((e) => e.id === m[1]) || EXECUTORS[0])],
  ['GET', /^\/executors\/([^/]+)\/executions$/, (u, q) => ({ total: EXECUTIONS.length, items: EXECUTIONS.slice(0, 4).map((e) => ({ id: e.id, taskId: e.taskId, taskName: e.taskName, status: e.status, startTime: e.startTime, endTime: e.endTime, duration: e.duration, errorMessage: e.errorMessage, exitCode: e.exitCode ?? null, createdAt: e.createdAt })) })],
  ['GET', /^\/executors\/([^/]+)$/, (u, q, m) => EXECUTORS.find((e) => e.id === m[1]) || EXECUTORS[0]],
  // ── config / settings ──
  ['GET', /^\/config$/, () => CONFIGS],
  ['GET', /^\/config\/history$/, () => ({ data: [
    { id: 9, configKey: 'deployment.policy', action: 'update', oldValue: 'strict', newValue: 'prefer', description: '放宽为软偏好', userId: '5', username: 'sre-oncall', ipAddress: '192.168.4.9', createdAt: ISO(-20 * 24 * 3600e3) },
    { id: 8, configKey: 'ai.provider', action: 'update', oldValue: 'openai', newValue: 'qwen', description: null, userId: '1', username: 'admin', ipAddress: '192.168.4.2', createdAt: ISO(-5 * 24 * 3600e3) },
    { id: 7, configKey: 'notification.default.channels', action: 'create', oldValue: null, newValue: '["email","dingtalk"]', description: '初始配置', userId: '1', username: 'admin', ipAddress: '192.168.4.2', createdAt: ISO(-10 * 24 * 3600e3) },
  ], total: 3 })],
  ['GET', /^\/config\/executor-shared-token$/, () => ({ token: 'sh-****-masked', hasToken: true })],
  ['GET', /^\/config\/runtime-version$/, () => ({ min: '3.10', max: '3.13', onlineMin: '3.11', legacyDefaultInterpreter: '3.9', tier1: ['3.12'], tier2: ['3.11', '3.12'], tier3: ['3.10'] })],
  ['GET', /^\/ai\/config$/, () => ({ provider: 'qwen', openaiModel: 'gpt-4o-mini', openaiBaseUrl: 'https://api.openai.com/v1', ollamaHost: 'http://localhost:11434', ollamaModel: 'qwen2.5:7b', qwenModel: 'qwen-max', qwenBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', qwenMaxTokens: '2048', qwenTimeoutMs: '30000', hasApiKey: true })],
  ['GET', /^\/api-keys$/, () => API_KEYS],
  ['GET', /^\/event-subscriptions$/, () => EVENT_SUBSCRIPTIONS],
  // 死信分页(GET /event-subscriptions/{id}/dead-letters?{page,limit})
  ['GET', /^\/event-subscriptions\/([^/]+)\/dead-letters$/, () => ({
    data: [
      { id: 'dl-1', subscriptionId: 'es-2', eventType: 'deployment.completed', payload: { event: 'deployment.completed', occurredAt: ISO(-4 * 3600e3), data: { deploymentId: 'dep-7003' } }, error: 'connect ETIMEDOUT 10.9.9.9:443', attempts: 6, createdAt: ISO(-4 * 3600e3) },
      { id: 'dl-2', subscriptionId: 'es-2', eventType: 'deployment.completed', payload: { event: 'deployment.completed', occurredAt: ISO(-9 * 3600e3), data: { deploymentId: 'dep-7002' } }, error: 'HTTP 502 Bad Gateway', attempts: 6, createdAt: ISO(-9 * 3600e3) },
    ],
    total: 2,
  })],
  // ── notifications ──
  ['GET', /^\/notification\/channels$/, () => CHANNELS],
  ['GET', /^\/notification\/silences$/, () => SILENCES],
  // ── applications / deployments / mutex ──
  ['GET', /^\/applications$/, () => APPLICATIONS],
  ['GET', /^\/applications\/([^/]+)\/releases$/, () => ({
    data: [
      { id: 'av-3', version: '2.3.1', packageUrl: 'http://localhost:3105/uploads/app-2001-2.3.1.zip', gitCommit: 'f00dcafe', deployedAt: ISO(-2 * 24 * 3600e3), latestDeploymentId: 'dep-7001', deploymentStatus: 'running', deploymentCount: 3, executorAddress: 'http://192.168.4.54:9001', runMode: 'daemon', triggerType: 'upgrade', operator: null, operatorSource: 'application_versions.createdBy', operatorMissingReason: 'legacy rows have no createdBy', sourceDeploymentId: 'dep-7001', status: 'released', createdAt: ISO(-2 * 24 * 3600e3), synthetic: false },
      { id: 'av-2', version: '2.2.0', packageUrl: 'http://localhost:3105/uploads/app-2001-2.2.0.zip', gitCommit: 'abcd1234', deployedAt: ISO(-9 * 24 * 3600e3), latestDeploymentId: null, deploymentStatus: null, deploymentCount: 2, executorAddress: 'http://192.168.4.54:9001', runMode: 'daemon', triggerType: 'upgrade', operator: null, operatorSource: 'application_versions.createdBy', operatorMissingReason: 'legacy rows have no createdBy', sourceDeploymentId: null, status: 'released', createdAt: ISO(-9 * 24 * 3600e3), synthetic: false },
      { id: null, version: null, packageUrl: null, gitCommit: null, deployedAt: ISO(-40 * 24 * 3600e3), latestDeploymentId: 'dep-old', deploymentStatus: 'stopped', deploymentCount: 1, executorAddress: 'http://192.168.4.60:9001', runMode: 'once', triggerType: 'unknown', operator: null, operatorSource: 'application_versions.createdBy', operatorMissingReason: 'legacy rows have no createdBy', sourceDeploymentId: 'dep-old', status: 'stopped', createdAt: ISO(-40 * 24 * 3600e3), synthetic: true },
    ],
    total: 3, page: 1, pageSize: 20,
  })],
  ['GET', /^\/applications\/([^/]+)\/versions$/, () => [
    { id: 'av-3', sourceDeploymentId: 'dep-7001', createdAt: ISO(-2 * 24 * 3600e3), snapshot: { version: '2.3.1' }, deployCount: 3, deploymentId: 'dep-7001', version: '2.3.1', commit: 'f00dcafe', status: 'released', deployedAt: ISO(-2 * 24 * 3600e3), executorAddress: 'http://192.168.4.54:9001' },
    { id: 'av-2', sourceDeploymentId: null, createdAt: ISO(-9 * 24 * 3600e3), snapshot: { version: '2.2.0' }, deployCount: 2, deploymentId: null, version: '2.2.0', commit: 'abcd1234', status: 'released', deployedAt: null, executorAddress: null },
  ]],
  ['GET', /^\/applications\/([^/]+)\/removal-impact$/, () => ({ applicationName: APPLICATIONS[0].name, tasksLosingSource: 4, deploymentCount: 3, packageFileWillBeDeleted: true })],
  ['GET', /^\/applications\/([^/]+)$/, (u, q, m) => APPLICATIONS.find((a) => a.id === m[1]) || APPLICATIONS[0]],
  ['GET', /^\/app-deployments$/, (u, q) => {
    const appId = q.get('applicationId');
    const pool = appId ? APP_DEPLOYMENTS.filter((d) => d.applicationId === appId) : APP_DEPLOYMENTS;
    const withApp = pool.map((d) => ({ ...d, application: APPLICATIONS.find((a) => a.id === d.applicationId) || null }));
    return { data: withApp, total: withApp.length };
  }],
  ['GET', /^\/mutex-groups$/, () => [
    { id: 'mg-1', name: '生产发布互斥-全局组-长名称验证用例', maxConcurrentPerDevice: 1, scope: 'global', description: '全平台同时只允许一个生产发布', createdAt: ISO(-50 * 24 * 3600e3), updatedAt: ISO(-2 * 24 * 3600e3) },
    { id: 'mg-2', name: '采集器单机互斥', maxConcurrentPerDevice: 2, scope: 'device', description: null, createdAt: ISO(-20 * 24 * 3600e3), updatedAt: ISO(-20 * 24 * 3600e3) },
  ]],
  // ── projects / users ──
  ['GET', /^\/projects\/me\/roles$/, () => ({ userId: 1, isAdmin: true, memberships: [{ id: 'pm-1', projectId: 'p-1001', userId: 1, role: 'editor', createdAt: ISO(-100 * 24 * 3600e3) }] })],
  ['GET', /^\/projects\/([^/]+)\/members$/, () => [
    { id: 'pm-1', projectId: 'p-1001', userId: 1, role: 'admin', createdAt: ISO(-100 * 24 * 3600e3) },
    { id: 'pm-2', projectId: 'p-1001', userId: 2, role: 'editor', createdAt: ISO(-90 * 24 * 3600e3) },
    { id: 'pm-3', projectId: 'p-1001', userId: 4, role: 'viewer', createdAt: ISO(-3 * 24 * 3600e3) },
  ]],
  // projectsApi.list(无 page 参数)→ 裸数组;listPaged(带 page)→ 分页信封
  // (list/items 双键为后端 R-21 遗留,前端只消费 list,双键都给)。
  ['GET', /^\/projects$/, (u, q) => {
    if (!q.has('page')) return PROJECTS;
    const env = pagedEnvelope(PROJECTS, q);
    return { list: env.items, items: env.items, total: env.total, page: env.page, pageSize: env.pageSize, totalPages: env.totalPages };
  }],
  ['GET', /^\/users$/, (u, q) => {
    const page = Math.max(1, parseInt(q.get('page') || '1', 10) || 1);
    const pageSize = Math.max(1, parseInt(q.get('pageSize') || '20', 10) || 20);
    return { list: USERS.slice((page - 1) * pageSize, page * pageSize), total: USERS.length, page, pageSize };
  }],
  // ── registry ──
  ['GET', /^\/registry\/pypi\/packages$/, () => ({ packages: ['autoflow-executor', 'numpy', 'pandas', 'httpx', 'pydantic', '数据工具箱-datatoolbox', 'very-long-package-name-for-overflow-checking-case'] })],
  ['GET', /^\/registry\/npm\/packages$/, () => ({ packages: [
    { name: 'autoflow-agent', versions: ['1.0.0', '1.1.0', '2.0.0'], description: 'AutoFlow 执行器 Agent 端', latest: '2.0.0' },
    { name: '@autoflow/executor-node', versions: ['2.12.0', '2.13.2', '2.14.0'], description: 'Node 执行器内核', latest: '2.14.0' },
    { name: 'legacy-reporter', versions: ['0.0.1'], latest: '0.0.1' },
  ] })],
  // ── executor packages ──
  ['GET', /^\/executor-packages$/, (u, q) => pagedEnvelope(PACKAGES, q)],
  // ── agent ──
  ['GET', /^\/agent\/budget$/, () => ({ maxSteps: 40, maxTokens: 200000, wallClockMs: 1800000, maxToolCalls: 60 })],
  ['GET', /^\/agent\/sessions$/, (u, q) => {
    const env = pagedEnvelope(AGENT_SESSIONS, q);
    return { items: env.items, total: env.total };
  }],
  ['GET', /^\/agent\/sessions\/([^/]+)$/, (u, q, m) => ({
    session: AGENT_SESSIONS.find((s) => s.id === m[1]) || AGENT_SESSIONS[0],
    steps: [
      { id: 'st-1', sessionId: m[1], seq: 1, role: 'system', content: '你是 AutoFlow 运维 Agent', reasoning: null, toolCallsJson: null, toolCallId: null, tokensIn: 320, tokensOut: 0, latencyMs: 12, provider: 'dashscope', model: 'qwen-max', summary: null, createdAt: ISO(-50 * MIN) },
      { id: 'st-2', sessionId: m[1], seq: 2, role: 'assistant', content: '开始检查主从延迟', reasoning: '需要先看 replication lag', toolCallsJson: [{ name: 'shell' }], toolCallId: 'tc-1', tokensIn: 900, tokensOut: 210, latencyMs: 1400, provider: 'dashscope', model: 'qwen-max', summary: null, createdAt: ISO(-49 * MIN) },
    ],
    toolCalls: [
      { id: 'tc-1', sessionId: m[1], stepId: 'st-2', toolName: 'shell.exec', tier: 'L1', argsJson: { cmd: 'psql -c "SHOW repl_lag"' }, resultJson: { lag: '2s' }, resultTruncated: false, status: 'success', errorMessage: null, approvalId: null, durationMs: 220, createdAt: ISO(-49 * MIN) },
    ],
    children: [],
  })],
  // ── sop ──
  ['GET', /^\/sop$/, (u, q) => {
    const env = pagedEnvelope(SOPS, q);
    return { items: env.items, total: env.total };
  }],
  ['GET', /^\/sop\/assignable-executors$/, () => [{ id: 'ex-3001', appName: EXECUTORS[0].appName, address: EXECUTORS[0].address, status: 'online', lastHeartbeat: EXECUTORS[0].lastHeartbeat, agentCapabilities: ['agent:sop', 'shell'] }]],
  ['GET', /^\/sop\/assignments\/([^/]+)\/media$/, () => [
    { id: 'm-1', assignmentId: 'asg-8001', name: '主从延迟截图-超长文件名验证用例-20261003-024500.png', mime: 'image/png', sizeBytes: 245_760, storedPath: '/uploads/agent/m-1.png', uploadedBy: 'ag-6001', createdAt: ISO(-25 * MIN) },
  ]],
  ['GET', /^\/sop\/assignments\/([^/]+)$/, () => ({
    assignment: SOP_ASSIGNMENT,
    clarifications: [
      { id: 'cl-1', clientClarificationId: 'c-1', assignmentId: 'asg-8001', round: 1, question: '维护窗口内是否允许短暂只读?', questionContextJson: null, answer: '允许,已与业务方确认', resolution: 'answered', newSopVersion: null, mediaRefsJson: null, reviewSessionId: null, createdAt: ISO(-40 * MIN), updatedAt: ISO(-30 * MIN) },
    ],
  })],
  ['GET', /^\/sop\/([^/]+)\/assignments$/, (u, q, m) => (m[1] === 'sop-5001' ? [SOP_ASSIGNMENT] : [])],
  ['GET', /^\/sop\/([^/]+)\/versions$/, (u, q, m) => (m[1] === 'sop-5001' ? [
    { id: 'sv-3', sopId: 'sop-5001', version: 'v3', frontMatterJson: { owner: 'sre' }, bodyMarkdown: '## 步骤\n1. 检查主从延迟', changelog: '补充回滚步骤', contentHash: 'aa'.repeat(16), publishedBy: 'admin', publishedAt: ISO(-2 * 24 * 3600e3), createdAt: ISO(-2 * 24 * 3600e3) },
  ] : [])],
  ['GET', /^\/sop\/([^/]+)$/, (u, q, m) => SOPS.find((s) => s.id === m[1]) || SOPS[0]],
  // ── audit ──
  ['GET', /^\/audit$/, () => ({ data: AUDIT_LOGS, total: AUDIT_LOGS.length })],
  // ── task templates ──
  ['GET', /^\/task-templates$/, () => TEMPLATES],
];

// ─────────────────────────────────────────────────────────────────────────────
// 路由拦截
// ─────────────────────────────────────────────────────────────────────────────

const coverage = new Set();   // 'GET /tasks'
const gaps = new Set();       // 'GET /tasks/foo/bar' — 404 的端点(夹具缺口)
const apiStatuses = [];       // { status, url } — 非 2xx 的 /api 响应

function templatePath(pathname) {
  // 参数段归一:uuid / 纯数字 / t-1001 / e-9001 / asg-8001 等 id 形态 → :id
  return pathname
    .split('/')
    .map((seg) => (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(seg) || /^\d+$/.test(seg) || /^[a-z]{1,4}-\d+$/i.test(seg) ? ':id' : seg))
    .join('/');
}

async function apiHandler(route) {
  const req = route.request();
  const url = new URL(req.url());
  const method = req.method();
  // 只拦 /api/ 前缀(vite proxy 目标);其余(vite 模块 /src/api/*.ts 等)放行。
  // 注意 glob '**/api/**' 会同时命中 /src/api/*.ts 源码模块——放行分支必须先判。
  if (!url.pathname.startsWith('/api/')) return route.continue();
  const pathname = url.pathname.slice('/api'.length);

  // SSE 流端点:返回一个安静的长 retry 流,避免浏览器 3s 原生重连风暴
  if (pathname.endsWith('/stream')) {
    coverage.add(`${method} ${templatePath(pathname)} (SSE)`);
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'retry: 600000\n\n' });
  }

  for (const [routeMethod, re, handler] of ROUTES) {
    if (routeMethod !== method) continue;
    const match = pathname.match(re);
    if (!match) continue;
    coverage.add(`${method} ${templatePath(pathname)}`);
    let body;
    try {
      body = handler(url, url.searchParams, match);
    } catch (err) {
      gaps.add(`HANDLER-ERROR ${method} ${pathname}: ${err.message}`);
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: `fixture handler error: ${err.message}` }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body ?? null) });
  }

  // 未匹配 → 夹具缺口。记录端点名并返回 404(前端会 toast,页面仍渲染)
  gaps.add(`${method} ${pathname}`);
  apiStatuses.push({ status: 404, url: `${method} ${pathname}` });
  return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 404, message: `fixture missing: ${method} ${pathname}` }) });
}

// ─────────────────────────────────────────────────────────────────────────────
// 页面清单(path 取自 src/router.tsx;settings 各 Tab 用 ?tab= 深链)
// ─────────────────────────────────────────────────────────────────────────────

const PAGES = [
  { key: 'login', path: '/login', auth: false },
  { key: 'dashboard', path: '/dashboard' },
  { key: 'tasks', path: '/tasks' },
  { key: 'task-new', path: '/tasks/new' },
  { key: 'task-detail', path: '/tasks/t-1001' },
  { key: 'execution-detail', path: '/tasks/t-1001/executions/e-9001' },
  { key: 'executions', path: '/executions' },
  { key: 'agent-sessions', path: '/agent-sessions' },
  { key: 'sops', path: '/sops' },
  { key: 'projects', path: '/projects' },
  { key: 'users', path: '/users' },
  { key: 'registry', path: '/registry' },
  { key: 'settings-token', path: '/settings' },
  { key: 'settings-ai', path: '/settings?tab=ai' },
  { key: 'settings-config', path: '/settings?tab=config' },
  { key: 'settings-security', path: '/settings?tab=security' },
  { key: 'settings-api-keys', path: '/settings?tab=api-keys' },
  { key: 'settings-events', path: '/settings?tab=event-subscriptions' },
  { key: 'notifications', path: '/notifications' },
  { key: 'applications', path: '/applications' },
  { key: 'app-detail', path: '/applications/app-2001' },
  { key: 'executors', path: '/executors' },
  { key: 'executor-detail', path: '/executors/ex-3001' },
  { key: 'executor-packages', path: '/executor-packages' },
  { key: 'task-templates', path: '/task-templates' },
  { key: 'audit', path: '/audit' },
];

const VIEWPORTS = [
  { w: 375, h: 812, label: 'mobile' },
  { w: 1280, h: 800, label: 'desktop' },
];

// console 分类:i18next missing-key / React key|prop / 其他
function classifyConsole(type, text) {
  const t = text || '';
  const flags = [];
  if (/i18next|missingKey|key ['"`].+['"`] .*not found|no translation/i.test(t)) flags.push('i18n');
  if (/React has detected|unique ['"`]key['"`]|Each child in a list|Warning: .*prop|Warning: /i.test(t)) flags.push('react');
  if (flags.length === 0) flags.push('other');
  return flags;
}

async function detectOverflow(page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const doc = document.documentElement;
    const sw = Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0);
    const offenders = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1) {
        // 判定越界元素是否被「容器内横向滚动」收纳(移动端合规形态):
        // 沿祖先链找第一个 overflow-x:auto/scroll 且实际可滚的容器。
        let contained = false;
        let p = el.parentElement;
        for (let i = 0; p && i < 10; i++) {
          const cs = getComputedStyle(p);
          const ox = cs.overflowX;
          if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth + 1) {
            contained = true;
            break;
          }
          p = p.parentElement;
        }
        const cls = typeof el.className === 'string' && el.className
          ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        offenders.push({
          w: Math.round(r.width),
          over: Math.round(r.right - vw),
          sel: `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`,
          text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50),
          contained,
        });
      }
    }
    offenders.sort((a, b) => b.w - a.w);
    const seen = new Set();
    const top = [];
    for (const o of offenders) {
      const k = `${o.sel}|${o.text}`;
      if (seen.has(k)) continue;
      seen.add(k);
      top.push(o);
      if (top.length >= 3) break;
    }
    return { vw, scrollWidth: sw, overflow: sw > vw + 1, top };
  });
}

async function visitPage(browser, pageDef, viewport) {
  const context = await browser.newContext({ viewport: { width: viewport.w, height: viewport.h } });
  await context.route('**/api/**', apiHandler);
  if (pageDef.auth !== false) {
    // 登录态注入:zustand persist 落盘 key = 'autoflow-auth'(store/auth.ts),
    // 形状 { state: { token, refreshToken, user } };语言 = 'autoflow-lang'(zh 基线)。
    await context.addInitScript(([auth]) => {
      localStorage.setItem('autoflow-auth', auth);
      localStorage.setItem('autoflow-lang', 'zh');
    }, [JSON.stringify({ state: { token: 'mock-access-token', refreshToken: 'mock-refresh-token', user: USER }, version: 0 })]);
  } else {
    await context.addInitScript(() => localStorage.setItem('autoflow-lang', 'zh'));
  }

  const consoleMsgs = [];
  const pageErrors = [];
  const pageApi404 = [];
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      consoleMsgs.push({ type: msg.type(), text: msg.text().slice(0, 400) });
    }
  });
  page.on('pageerror', (err) => pageErrors.push(String(err && err.stack || err).slice(0, 600)));
  page.on('response', (resp) => {
    try {
      const u = new URL(resp.url());
      if (u.pathname.startsWith('/api/') && resp.status() >= 400) {
        pageApi404.push(`${resp.request().method()} ${u.pathname.replace(/^\/api/, '')} -> ${resp.status()}`);
      }
    } catch { /* ignore */ }
  });

  const url = BASE_URL + pageDef.path;
  let gotoError = null;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
  } catch (err) {
    gotoError = String(err && err.message || err).slice(0, 300);
  }

  let overflowInfo = null;
  let renderSmoke = null;
  if (viewport.w === 375) {
    try { overflowInfo = await detectOverflow(page); } catch { /* 页面已崩则跳过 */ }
  }
  try {
    renderSmoke = await page.evaluate(() => ({
      title: document.title,
      bodyChars: document.body ? document.body.innerText.length : 0,
      hasViteErrorOverlay: !!document.querySelector('vite-error-overlay'),
    }));
  } catch { renderSmoke = { title: '?', bodyChars: 0, hasViteErrorOverlay: false }; }

  const shot = join(OUT_DIR, `${pageDef.key}-${viewport.w}.png`);
  try {
    await page.screenshot({ path: shot, fullPage: false });
  } catch (err) {
    consoleMsgs.push({ type: 'error', text: `[screenshot failed] ${err.message}` });
  }

  await context.close();

  const consoleErrors = consoleMsgs.filter((c) => c.type === 'error');
  const consoleWarns = consoleMsgs.filter((c) => c.type === 'warning');
  const notableWarns = consoleWarns.filter((c) => classifyConsole('warning', c.text).some((f) => f !== 'other'));

  return {
    key: pageDef.key, path: pageDef.path, viewport: viewport.w,
    gotoError, overflowInfo, renderSmoke, shot,
    errors: consoleErrors.map((c) => c.text),
    warnCount: consoleWarns.length,
    notableWarns: notableWarns.map((c) => ({ flags: classifyConsole('warning', c.text), text: c.text.slice(0, 200) })),
    pageErrors,
    pageApi404,
    viteOverlay: renderSmoke.hasViteErrorOverlay,
    blank: renderSmoke.bodyChars < 40 && !gotoError,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const runStartedAt = new Date().toISOString();
  // 本机只装了 chromium-1234 完整版(chrome-win64),playwright-core 1.63 默认
  // 找 chromium_headless_shell-1243 会落空 → 首选显式 executablePath。
  let exe = join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
  let browser;
  try {
    browser = await chromium.launch({ executablePath: exe });
  } catch (err) {
    console.error(`[ux-walkthrough] explicit launch failed, falling back to default registry: ${err.message}`);
    browser = await chromium.launch();
  }

  const results = [];
  // coverage/gaps 以第一次运行为准累计;两次运行对比在 stdout 汇总
  for (const pageDef of PAGES) {
    for (const viewport of VIEWPORTS) {
      const r = await visitPage(browser, pageDef, viewport);
      results.push(r);
      const flag = viewport.w === 375
        ? (r.overflowInfo && r.overflowInfo.overflow ? 'OVERFLOW' : 'ok')
        : (r.errors.length || r.pageErrors.length ? 'JS-ERR' : 'ok');
      process.stdout.write(`[${r.key} @${viewport.w}] ${flag}` +
        (viewport.w === 375 && r.overflowInfo && r.overflowInfo.overflow ? ` sw=${r.overflowInfo.scrollWidth}/${r.overflowInfo.vw}` : '') +
        (r.blank ? ' BLANK' : '') + '\n');
    }
  }

  await browser.close();

  // ── 报告 ──
  const lines = [];
  lines.push(`# Admin-Web UX 走查报告(真实 Chromium)`);
  lines.push('');
  lines.push(`- 运行时间:${runStartedAt}`);
  lines.push(`- 基址:${BASE_URL}(vite dev,端口 5176;API 经 Playwright route 拦截供数,无后端)`);
  lines.push(`- 视口:375×812(溢出检测 + 截图)、1280×800(冒烟)`);
  lines.push(`- 页面数:${PAGES.length} × 视口 2 = ${results.length} 次访问`);
  lines.push(`- 登录态:addInitScript 注入 localStorage 'autoflow-auth'(role=admin,zustand persist 形状)`);
  lines.push(`- 截图目录:${OUT_DIR}`);
  lines.push('');

  const overflowPages = results.filter((r) => r.viewport === 375 && r.overflowInfo && r.overflowInfo.overflow);
  const errPages = results.filter((r) => r.errors.length || r.pageErrors.length);
  const blankPages = results.filter((r) => r.blank);
  lines.push(`## 总览`);
  lines.push('');
  lines.push(`- 375px 横向溢出页:${overflowPages.length ? overflowPages.map((r) => `${r.key}(sw=${r.overflowInfo.scrollWidth})`).join(', ') : '无'}`);
  lines.push(`- console 错误/pageerror 页:${errPages.length ? errPages.map((r) => `${r.key}@${r.viewport}`).join(', ') : '无'}`);
  lines.push(`- 疑似空白页(body<40 字符):${blankPages.length ? blankPages.map((r) => `${r.key}@${r.viewport}`).join(', ') : '无'}`);
  lines.push(`- 夹具缺口端点(404):${gaps.size ? [...gaps].join('; ') : '无'}`);
  lines.push('');

  lines.push(`## 逐页明细`);
  lines.push('');
  lines.push(`| 页面 | 视口 | 溢出 | 最宽越界元素(375) | console 错误 | 显著告警 | 缺口/异常 |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const r of results) {
    const overflowCell = r.viewport === 375
      ? (r.overflowInfo ? (r.overflowInfo.overflow ? `是 (scrollWidth ${r.overflowInfo.scrollWidth} > ${r.overflowInfo.vw})` : '否') : 'n/a(页面异常)')
      : '—(冒烟)';
    const offender = r.viewport === 375 && r.overflowInfo && r.overflowInfo.top.length
      ? r.overflowInfo.top.slice(0, 3).map((o) => `${o.sel} w=${o.w} ${o.contained ? '(容器内滚动)' : '(非滚动容器)'} "${o.text}"`).join('<br>')
      : '—';
    const errCell = r.errors.length + r.pageErrors.length
      ? `${r.errors.length} 错误${r.pageErrors.length ? ` +${r.pageErrors.length} pageerror` : ''}:${(r.errors[0] || r.pageErrors[0] || '').slice(0, 120)}`
      : '0';
    const warnCell = r.notableWarns.length
      ? r.notableWarns.slice(0, 3).map((w) => `[${w.flags.join('/')}] ${w.text.slice(0, 80)}`).join('<br>')
      : `${r.warnCount} 条(均非 i18n/React 类)`;
    const gapCell = [
      r.gotoError ? `goto: ${r.gotoError}` : null,
      r.blank ? '疑似空白页' : null,
      r.viteOverlay ? 'vite 错误浮层' : null,
      ...r.pageApi404.slice(0, 4),
    ].filter(Boolean).join(';<br>') || '—';
    lines.push(`| ${r.key} (${r.path}) | ${r.viewport} | ${overflowCell} | ${offender} | ${errCell} | ${warnCell} | ${gapCell} |`);
  }
  lines.push('');

  if (errPages.length || blankPages.length) {
    lines.push(`## 错误详情`);
    lines.push('');
    for (const r of results) {
      if (!r.errors.length && !r.pageErrors.length && !r.blank) continue;
      lines.push(`### ${r.key} @${r.viewport}`);
      if (r.blank) lines.push(`- 疑似空白(body 仅 ${r.renderSmoke.bodyChars} 字符)`);
      for (const e of r.errors) lines.push(`- [console.error] ${e}`);
      for (const e of r.pageErrors) lines.push(`- [pageerror] ${e}`);
      lines.push('');
    }
  }

  lines.push(`## 夹具覆盖端点(本运行实际命中)`);
  lines.push('');
  for (const c of [...coverage].sort()) lines.push(`- ${c}`);
  lines.push('');
  lines.push(`## 夹具缺口(404 端点)`);
  lines.push('');
  lines.push(gaps.size ? [...gaps].sort().map((g) => `- ${g}`).join('\n') : '- 无');
  lines.push('');

  const report = lines.join('\n');
  writeFileSync(join(OUT_DIR, 'report.md'), report, 'utf8');
  process.stdout.write('\n' + report + '\n');
  process.stdout.write(`\n[ux-walkthrough] report written to ${join(OUT_DIR, 'report.md')}\n`);
}

main().catch((err) => {
  console.error('[ux-walkthrough] fatal:', err);
  process.exit(1);
});
