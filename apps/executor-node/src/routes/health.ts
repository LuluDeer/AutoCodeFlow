import { Router, Request, Response } from 'express';
import * as os from 'os';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { config } from '../config';
import { runningCount } from '../scheduler';
import { taskWorkerManager } from '../task-worker';
import { getExecutorAuthToken } from './logs';

// Track last successful heartbeat time
let lastHeartbeatTime: string | null = null;
let adminApiReachable: boolean | null = null;

export function recordHeartbeat(success: boolean): void {
  if (success) lastHeartbeatTime = new Date().toISOString();
  adminApiReachable = success;
}

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

function getDiskUsage(): number {
  try {
    // statfsSync fields: blocks (total), bfree/bavail (free blocks)
    const stats = fs.statfsSync('/');
    const used = (stats.blocks - stats.bavail) / stats.blocks;
    return used * 100;
  } catch {
    return -1;
  }
}

healthRouter.get('/health', async (_req: Request, res: Response) => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpuUsage = os.loadavg()[0];
  const memUsage = ((totalMem - freeMem) / totalMem) * 100;
  const diskUsage = await getDiskUsage();

  // Check admin-api connectivity and update cached state
  const reachable = await checkAdminApi();
  adminApiReachable = reachable;

  const isHealthy = cpuUsage < 80 && memUsage < 80 && (diskUsage < 90 || diskUsage < 0);

  res.json({
    status: isHealthy ? 'healthy' : 'degraded',
    appName: config.appName,
    address: config.executorAddress,
    cpuUsage: Math.round(cpuUsage * 100) / 100,
    memUsage: Math.round(memUsage * 100) / 100,
    diskUsage: diskUsage >= 0 ? Math.round(diskUsage * 100) / 100 : undefined,
    runningTasks: runningCount(),
    maxConcurrentTasks: config.maxConcurrentTasks,
    workerStats: taskWorkerManager.getStats(),
    adminApiReachable: reachable,
    tokenValid: !!getExecutorAuthToken(),
    lastHeartbeat: lastHeartbeatTime,
    timestamp: new Date().toISOString(),
  });
});

healthRouter.get('/health/live', (_req: Request, res: Response) => {
  res.status(200).send('OK');
});

healthRouter.get('/health/ready', async (_req: Request, res: Response) => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpuUsage = os.loadavg()[0];
  const memUsage = ((totalMem - freeMem) / totalMem) * 100;
  
  if (cpuUsage >= 90 || memUsage >= 90) {
    res.status(503).json({ status: 'unready', reason: 'Resource usage too high' });
  } else {
    res.status(200).json({ status: 'ready' });
  }
});