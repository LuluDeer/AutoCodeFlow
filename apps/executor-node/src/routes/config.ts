/**
 * Configuration hot-reload endpoint.
 * Allows admin-api to push configuration updates without executor restart.
 */
import { Router, Request, Response } from 'express';
import { verifyToken } from '../middleware/auth';
import { config } from '../config';
import { initAdminClients } from '../admin-client';
import { logger } from '../logger';

export const configRouter = Router();
configRouter.use(verifyToken as any);

interface ConfigReloadRequest {
  maxConcurrentTasks?: number;
  taskTimeoutSeconds?: number;
  heartbeatIntervalSeconds?: number;
  adminApiUrl?: string;
  adminApiUrlInternal?: string;
  adminApiUrlExternal?: string;
  adminApiUrls?: string[];
}

function rebuildAdminApiUrls(explicitUrls?: string[]): string[] {
  const configuredUrls = (explicitUrls ?? [])
    .map((url) => url.trim())
    .filter(Boolean);

  if (configuredUrls.length > 0) return configuredUrls;
  if (config.adminApiUrlInternal) return [config.adminApiUrlInternal];
  if (config.adminApiUrl) return [config.adminApiUrl];
  return [];
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
      config.maxConcurrentTasks = body.maxConcurrentTasks;
      updatedFields.push('maxConcurrentTasks');
      logger.info(`Hot-reloaded maxConcurrentTasks=${body.maxConcurrentTasks}`);
    }

    if (body.taskTimeoutSeconds !== undefined) {
      if (body.taskTimeoutSeconds < 1) {
        res.status(400).json({ error: 'taskTimeoutSeconds must be >= 1' });
        return;
      }
      config.taskTimeoutSeconds = body.taskTimeoutSeconds;
      updatedFields.push('taskTimeoutSeconds');
      logger.info(`Hot-reloaded taskTimeoutSeconds=${body.taskTimeoutSeconds}`);
    }

    if (body.heartbeatIntervalSeconds !== undefined) {
      if (body.heartbeatIntervalSeconds < 5) {
        res.status(400).json({ error: 'heartbeatIntervalSeconds must be >= 5' });
        return;
      }
      config.heartbeatIntervalSeconds = body.heartbeatIntervalSeconds;
      updatedFields.push('heartbeatIntervalSeconds');
      logger.info(`Hot-reloaded heartbeatIntervalSeconds=${body.heartbeatIntervalSeconds}`);
    }

    let adminApiUrlsChanged = false;
    let explicitAdminApiUrls: string[] | undefined;

    if (body.adminApiUrl !== undefined) {
      config.adminApiUrl = body.adminApiUrl;
      if (body.adminApiUrlInternal === undefined && body.adminApiUrls === undefined) {
        config.adminApiUrlInternal = body.adminApiUrl;
      }
      updatedFields.push('adminApiUrl');
      adminApiUrlsChanged = true;
      logger.info(`Hot-reloaded adminApiUrl=${body.adminApiUrl}`);
    }

    if (body.adminApiUrlInternal !== undefined) {
      config.adminApiUrlInternal = body.adminApiUrlInternal;
      updatedFields.push('adminApiUrlInternal');
      adminApiUrlsChanged = true;
      logger.info(`Hot-reloaded adminApiUrlInternal=${body.adminApiUrlInternal}`);
    }

    if (body.adminApiUrlExternal !== undefined) {
      config.adminApiUrlExternal = body.adminApiUrlExternal;
      updatedFields.push('adminApiUrlExternal');
      logger.info(`Hot-reloaded adminApiUrlExternal=${body.adminApiUrlExternal}`);
    }

    if (body.adminApiUrls !== undefined) {
      explicitAdminApiUrls = body.adminApiUrls;
      updatedFields.push('adminApiUrls');
      adminApiUrlsChanged = true;
      logger.info(`Hot-reloaded adminApiUrls=${body.adminApiUrls.join(',')}`);
    }

    if (adminApiUrlsChanged) {
      config.adminApiUrls = rebuildAdminApiUrls(explicitAdminApiUrls);
      initAdminClients(config.adminApiUrls);
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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Config reload failed: ${msg}`);
    res.status(500).json({ error: `Config reload failed: ${msg}` });
  }
});
