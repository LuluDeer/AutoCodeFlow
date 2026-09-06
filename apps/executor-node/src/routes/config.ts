/**
 * Configuration hot-reload endpoint.
 * Allows admin-api to push configuration updates without executor restart.
 */
import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { verifyToken } from '../middleware/auth';
import { config } from '../config';
import { initAdminClients } from '../admin-client';
import { logger } from '../logger';
import { listActiveExecutionIds, validateExecutionWorkDir } from './execute';

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
  // workDir 与 WORK_DIR 两个字段名都接受（env 变量名为 WORK_DIR，运维直觉
  // 常按大写提交）。
  workDir?: string;
  WORK_DIR?: string;
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

    // WORK_DIR 热切换：新基目录必须是绝对路径、无 ".." 段、真实存在且非
    // symlink，并复用 execute.ts 的同一套校验（validateExecutionWorkDir，
    // 规则不得漂移）；存在仍在旧目录运行的执行时拒绝切换，避免运行中的
    // 任务目录与后续清理/日志回捞路径脱钩。
    if (body.workDir !== undefined || body.WORK_DIR !== undefined) {
      const raw = String(body.workDir ?? body.WORK_DIR).trim();
      const isAbsolute = path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw);
      if (!raw || !isAbsolute || /(^|[\\/])\.\.([\\/]|$)/.test(raw)) {
        res.status(400).json({ error: 'workDir must be an absolute path without ".." segments' });
        return;
      }
      const resolvedNew = path.resolve(raw);
      if (!fs.existsSync(resolvedNew)) {
        res.status(400).json({ error: `workDir does not exist: ${resolvedNew}` });
        return;
      }
      try {
        if (fs.lstatSync(resolvedNew).isSymbolicLink()) {
          res.status(400).json({ error: 'workDir cannot be a symbolic link' });
          return;
        }
      } catch (err: unknown) {
        res.status(400).json({ error: `workDir validation failed: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      const active = listActiveExecutionIds();
      for (const executionId of active) {
        const guard = validateExecutionWorkDir(path.join(resolvedNew, executionId), resolvedNew);
        if (guard !== null) {
          res.status(400).json({ error: `workDir validation failed for active execution ${executionId}: ${guard}` });
          return;
        }
      }
      if (active.length > 0) {
        res.status(400).json({ error: `workDir cannot change while ${active.length} execution(s) are running on the old directory` });
        return;
      }
      // config.workDir 是读 process.env 的 getter——热更新写 env 即全链路生效
      // （含 workDir 派生的日志/回调目录解析路径）。E10：file-logger 的
      // logsDir 已改惰性解析（getLogsDir 每次经 config.workDir 重算），与
      // routes/logs.ts 的读路径、callback.ts 的 getCallbackDir 对齐；新增
      // workDir 派生路径时必须保持"调用期解析"，不得模块加载期固化。
      process.env.WORK_DIR = resolvedNew;
      updatedFields.push('workDir');
      logger.info(`Hot-reloaded workDir=${resolvedNew}`);
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
