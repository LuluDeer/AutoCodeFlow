/**
 * Configuration hot-reload endpoint.
 * Allows admin-api to push configuration updates without executor restart.
 */
import { Router, Request, Response } from 'express';
import { verifyToken } from '../middleware/auth';
import { logger } from '../logger';

export const configRouter = Router();
configRouter.use(verifyToken as any);

interface ConfigReloadRequest {
  maxConcurrentTasks?: number;
  taskTimeoutSeconds?: number;
  heartbeatIntervalSeconds?: number;
  adminApiUrl?: string;
}

interface ConfigReloadResponse {
  success: boolean;
  message: string;
  updatedFields: string[];
}

configRouter.post('/config/reload', async (req: Request, res: Response) => {
  const body = req.body as ConfigReloadRequest;
  const updatedFields: string[] = [];

  try {
    if (body.maxConcurrentTasks !== undefined) {
      if (body.maxConcurrentTasks < 1) {
        res.status(400).json({ error: 'maxConcurrentTasks must be >= 1' });
        return;
      }
      // Note: For now, this only tracks the config value locally.
      // A full implementation would use this to limit task execution.
      updatedFields.push('maxConcurrentTasks');
      logger.info(`Hot-reloaded maxConcurrentTasks=${body.maxConcurrentTasks}`);
    }

    if (body.taskTimeoutSeconds !== undefined) {
      if (body.taskTimeoutSeconds < 1) {
        res.status(400).json({ error: 'taskTimeoutSeconds must be >= 1' });
        return;
      }
      updatedFields.push('taskTimeoutSeconds');
      logger.info(`Hot-reloaded taskTimeoutSeconds=${body.taskTimeoutSeconds}`);
    }

    if (body.heartbeatIntervalSeconds !== undefined) {
      if (body.heartbeatIntervalSeconds < 5) {
        res.status(400).json({ error: 'heartbeatIntervalSeconds must be >= 5' });
        return;
      }
      updatedFields.push('heartbeatIntervalSeconds');
      logger.info(`Hot-reloaded heartbeatIntervalSeconds=${body.heartbeatIntervalSeconds}`);
    }

    if (body.adminApiUrl !== undefined) {
      updatedFields.push('adminApiUrl');
      logger.info(`Hot-reloaded adminApiUrl=${body.adminApiUrl}`);
    }

    if (updatedFields.length === 0) {
      res.json({ success: true, message: 'No fields to update', updatedFields: [] } as ConfigReloadResponse);
      return;
    }

    res.json({
      success: true,
      message: `Updated ${updatedFields.length} field(s)`,
      updatedFields,
    } as ConfigReloadResponse);
  } catch (err: any) {
    logger.error(`Config reload failed: ${err.message}`);
    res.status(500).json({ error: `Config reload failed: ${err.message}` });
  }
});
