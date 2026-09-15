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
// A3-C：协议闸门/响应契约（由 packages/executor-protocol/protocol.json 生成，勿手改产物）
import {
  ConfigReloadRequestSchema,
  ConfigReloadResponseSchema,
} from '../generated/protocol.schemas';

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
  // A3-C：响应字段名以 executor-protocol 为单一事实源（snake_case），与
  // executor-python / protocol.json 的 ConfigReloadResponse 对齐——node 旧实现
  // 用 camelCase（updatedFields/ignoredFields）是三方里唯一的漂移点。
  updated_fields: string[];
  /** E-22: request keys this endpoint does not understand. Reported instead of
   *  silently dropped — a typo'd/unsupported field used to come back as
   *  `success: true` with an empty update list, which reads as "applied". */
  ignored_fields: string[];
}

/**
 * A3-C：出参必经生成的协议 schema——契约不再只是被测试引用的产物。
 * 这里构造的响应若不满足 ConfigReloadResponse（缺字段/类型错）即服务端 bug，
 * 直接抛出走 500，而不是把一个畸形探针/响应发回 admin。
 */
function buildReloadResponse(input: {
  success: boolean;
  message: string;
  updatedFields: string[];
  ignoredFields: string[];
}): ConfigReloadResponse {
  const payload: ConfigReloadResponse = {
    success: input.success,
    message: input.message,
    updated_fields: input.updatedFields,
    ignored_fields: input.ignoredFields,
  };
  const checked = ConfigReloadResponseSchema.safeParse(payload);
  if (!checked.success) {
    const where = checked.error.issues[0]?.path.join('.') || '(root)';
    throw new Error(
      `config reload response violates executor-protocol at ${where}: ` +
        checked.error.issues[0]?.message,
    );
  }
  return payload;
}

/** Every key /config/reload actually honours (both workDir spellings). */
const KNOWN_CONFIG_FIELDS = new Set([
  'maxConcurrentTasks',
  'taskTimeoutSeconds',
  'heartbeatIntervalSeconds',
  'adminApiUrl',
  'adminApiUrlInternal',
  'adminApiUrlExternal',
  'adminApiUrls',
  'workDir',
  'WORK_DIR',
]);

function collectIgnoredFields(body: unknown): string[] {
  if (body === null || typeof body !== 'object') return [];
  return Object.keys(body as Record<string, unknown>)
    .filter((key) => !KNOWN_CONFIG_FIELDS.has(key))
    .sort();
}

configRouter.post('/config/reload', async (req: Request, res: Response) => {
  const body = req.body as ConfigReloadRequest;
  const updatedFields: string[] = [];
  // E-22: surface unrecognised keys rather than silently returning success.
  const ignoredFields = collectIgnoredFields(req.body);

  try {
    // A3-C：先做手检（数值下界，400 文案更具体且被既有用例钉住），再过协议
    // 闸门——与 routes/execute.ts 同一原则：手检兜具体文案，生成的 schema 兜
    // 手检没覆盖的**类型/形状**错误（如 maxConcurrentTasks 传字符串、
    // adminApiUrls 传非数组），且必须发生在任何 config 写入**之前**，畸形载荷
    // 绝不允许改到一半状态。
    if (body.maxConcurrentTasks !== undefined && body.maxConcurrentTasks < 1) {
      res.status(400).json({ error: 'maxConcurrentTasks must be >= 1' });
      return;
    }
    if (body.taskTimeoutSeconds !== undefined && body.taskTimeoutSeconds < 1) {
      res.status(400).json({ error: 'taskTimeoutSeconds must be >= 1' });
      return;
    }
    if (body.heartbeatIntervalSeconds !== undefined && body.heartbeatIntervalSeconds < 5) {
      res.status(400).json({ error: 'heartbeatIntervalSeconds must be >= 5' });
      return;
    }
    const parsedReq = ConfigReloadRequestSchema.safeParse(req.body);
    if (!parsedReq.success) {
      const first = parsedReq.error.issues[0];
      const where = first.path.length ? first.path.join('.') : '(root)';
      res.status(400).json({ error: `Invalid config reload request: ${where}: ${first.message}` });
      return;
    }

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

    if (ignoredFields.length > 0) {
      logger.warn(`Config reload ignored unsupported field(s): ${ignoredFields.join(', ')}`);
    }

    if (updatedFields.length === 0) {
      res.json(
        buildReloadResponse({
          success: true,
          message: ignoredFields.length > 0
            ? `No fields to update (ignored unsupported field(s): ${ignoredFields.join(', ')})`
            : 'No fields to update',
          updatedFields: [],
          ignoredFields,
        }),
      );
      return;
    }

    res.json(
      buildReloadResponse({
        success: true,
        message: `Updated ${updatedFields.length} field(s)`,
        updatedFields,
        ignoredFields,
      }),
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Config reload failed: ${msg}`);
    res.status(500).json({ error: `Config reload failed: ${msg}` });
  }
});
