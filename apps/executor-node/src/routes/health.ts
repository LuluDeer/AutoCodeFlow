import { Router, Request, Response } from 'express';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { config } from '../config';
import { runningCount } from '../scheduler';
import { taskWorkerManager } from '../task-worker';
import { getExecutorAuthToken } from './logs';
import {
  getHeartbeatState,
  recordHeartbeat,
  setAdminApiReachable,
} from '../heartbeat-state';

// Re-exported for existing importers; the state lives in heartbeat-state.
export { recordHeartbeat };

export function buildAdminHealthPath(adminUrl: URL): string {
  const basePath = adminUrl.pathname.replace(/\/+$/, '');
  if (!basePath || basePath === '/') return '/api/health';
  if (basePath.endsWith('/api')) return `${basePath}/health`;
  return `${basePath}/api/health`;
}

export function buildAdminHealthRequestOptions(adminUrl: URL) {
  const isHttps = adminUrl.protocol === 'https:';
  return {
    hostname: adminUrl.hostname,
    port: adminUrl.port || (isHttps ? 443 : 80),
    path: buildAdminHealthPath(adminUrl),
    method: 'GET',
    timeout: 3000,
  };
}

export async function checkAdminApi(): Promise<boolean> {
  return new Promise((resolve) => {
    const adminUrl = new URL(config.adminApiUrlInternal || config.adminApiUrl || 'http://localhost:3000');
    const reqOptions = buildAdminHealthRequestOptions(adminUrl);
    const requestImpl = adminUrl.protocol === 'https:' ? https.request : http.request;
    const req = requestImpl(reqOptions, (res) => {
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

export const healthRouter = Router();

// E-20（DEEP_REVIEW 0ef3bbe）：node /health 旧实现用 os.loadavg()[0] 报 CPU
// —— loadavg 在 Windows 恒为 [0,0,0]，导致 CPU 指标恒 0、degraded 判定在 Windows
// 上失真。改为对 os.cpus() 累计 times 做相邻采样差分得到真实 CPU 占用百分比
// （跨平台，Windows/Linux/macOS 一致），与 python /health 用的 psutil.cpu_percent()
// 口径对齐。首次调用无基线返回 0（不告警），第二次起有真实差分。
let prevCpuSample: { busy: number; total: number } | null = null;

/** Reset the CPU sampling baseline (test hook — mirrors
 *  scheduler's resetVersionDriftWarnStateForTest). */
export function resetCpuSampleForTest(): void {
  prevCpuSample = null;
}

export function sampleCpuPercent(readCpus: () => os.CpuInfo[] = os.cpus): number {
  let user = 0;
  let sys = 0;
  let idle = 0;
  for (const c of readCpus()) {
    user += c.times.user;
    sys += c.times.sys;
    idle += c.times.idle;
  }
  const busy = user + sys;
  const total = busy + idle;
  if (prevCpuSample === null) {
    prevCpuSample = { busy, total };
    return 0;
  }
  const dTotal = total - prevCpuSample.total;
  const dBusy = busy - prevCpuSample.busy;
  prevCpuSample = { busy, total };
  if (dTotal <= 0) return 0;
  return Math.min(100, (dBusy / dTotal) * 100);
}

// E-20（DEEP_REVIEW 0ef3bbe）：statfsSync('/') 在 Windows 可能失败（根盘符解析
// 差异），旧实现 catch 返回 -1 并依赖调用方特判。改为显式返回 null，响应里
// 直接上报 null（而非 -1/缺省），让运维/监控明确「指标不可用」而非误读为「0% 占用」。
function getDiskUsage(): number | null {
  try {
    // statfsSync fields: blocks (total), bfree/bavail (free blocks)
    const stats = fs.statfsSync(process.platform === 'win32' ? process.cwd().split(path.sep)[0] + path.sep : '/');
    if (!stats.blocks) return null;
    const used = (stats.blocks - stats.bavail) / stats.blocks;
    return used * 100;
  } catch {
    return null;
  }
}

healthRouter.get('/health', async (_req: Request, res: Response) => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpuUsage = sampleCpuPercent();
  const memUsage = ((totalMem - freeMem) / totalMem) * 100;
  const diskUsage = getDiskUsage();

  // Check admin-api connectivity and update cached state
  const reachable = await checkAdminApi();
  setAdminApiReachable(reachable);

  // E-20（DEEP_REVIEW 0ef3bbe）：diskUsage 为 null（Windows 等无法 statfs 根盘）
  // 时不参与 degraded 判定，避免「指标不可用」被误判成「磁盘爆满」。
  const diskOk = diskUsage === null || diskUsage < 90;
  const isHealthy = cpuUsage < 80 && memUsage < 80 && diskOk;

  res.json({
    status: isHealthy ? 'healthy' : 'degraded',
    appName: config.appName,
    address: config.executorAddress,
    cpuUsage: Math.round(cpuUsage * 100) / 100,
    memUsage: Math.round(memUsage * 100) / 100,
    diskUsage: diskUsage === null ? null : Math.round(diskUsage * 100) / 100,
    runningTasks: runningCount(),
    maxConcurrentTasks: config.maxConcurrentTasks,
    workerStats: taskWorkerManager.getStats(),
    adminApiReachable: reachable,
    tokenValid: !!getExecutorAuthToken(),
    lastHeartbeat: getHeartbeatState().lastHeartbeatTime,
    timestamp: new Date().toISOString(),
  });
});

healthRouter.get('/health/live', (_req: Request, res: Response) => {
  res.status(200).send('OK');
});

// E-20（DEEP_REVIEW 0ef3bbe）：就绪探针规范路径统一为 /health/ready（与 admin-api
// /api/health/ready、executor-python 同步新增的 /health/ready 对齐）；python 旧路径
// /health/readiness 保留为 deprecated alias 一个版本。CPU 判定同样改用跨平台
// sampleCpuPercent()，不再用 Windows 恒 0 的 os.loadavg()[0]。
healthRouter.get('/health/ready', async (_req: Request, res: Response) => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpuUsage = sampleCpuPercent();
  const memUsage = ((totalMem - freeMem) / totalMem) * 100;

  // A3（executor-protocol）：判定维度与 python 侧对齐为「资源 + admin 连通性」。
  // 此前 node 只看资源、python 只看 admin 连通性——各缺一块：node 在 admin 不可达
  // 时照样报 ready（回调发不出去却继续接任务），python 在 CPU 打满时照样报 ready。
  // 状态码与 payload 形状三方统一（ready→200 / not_ready→503，见 protocol.json）。
  const reachable = await checkAdminApi();
  setAdminApiReachable(reachable);

  if (!reachable) {
    const adminUrl = new URL(config.adminApiUrlInternal || config.adminApiUrl || 'http://localhost:3000');
    res.status(503).json({
      status: 'not_ready',
      reason: `admin-api unreachable (${buildAdminHealthPath(adminUrl)})`,
    });
  } else if (cpuUsage >= 90 || memUsage >= 90) {
    res.status(503).json({ status: 'not_ready', reason: 'Resource usage too high' });
  } else {
    res.status(200).json({ status: 'ready' });
  }
});