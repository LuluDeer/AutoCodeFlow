import { Router, Request, Response } from 'express';
import * as os from 'os';
import * as fs from 'fs';
import { config } from '../config';
import { runningCount } from '../scheduler';
import { taskWorkerManager } from '../task-worker';

export const healthRouter = Router();

function getDiskUsage(): number {
  try {
    const stats = fs.statfs('/');
    const used = (stats.total - stats.available) / stats.total;
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
  
  const isHealthy = cpuUsage < 80 && memUsage < 80 && (diskUsage < 90 || diskUsage < 0);
  
  res.json({
    status: isHealthy ? 'healthy' : 'degraded',
    appName: config.appName,
    address: config.executorAddress,
    cpuUsage: Math.round(cpuUsage * 100) / 100,
    memUsage: Math.round(memUsage * 100) / 100,
    diskUsage: diskUsage >= 0 ? Math.round(diskUsage * 100) / 100 : undefined,
    runningTasks: runningCount,
    maxConcurrentTasks: config.maxConcurrentTasks,
    workerStats: taskWorkerManager.getStats(),
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