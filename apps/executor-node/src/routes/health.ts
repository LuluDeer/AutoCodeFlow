import { Router, Request, Response } from 'express';
import * as os from 'os';
import { config } from '../config';

export const healthRouter = Router();

healthRouter.get('/health', (_req: Request, res: Response) => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  res.json({
    status: 'ok',
    appName: config.appName,
    address: config.executorAddress,
    cpu: os.loadavg()[0],
    mem: ((totalMem - freeMem) / totalMem) * 100,
  });
});
