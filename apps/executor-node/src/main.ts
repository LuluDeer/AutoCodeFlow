// Load .env file before anything else so process.env is populated
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// Polyfill globalThis.crypto for Node.js < 19 (defensive: task scripts and
// third-party dependencies may use the Web Crypto global; executor code
// itself uses node:crypto randomUUID directly)
if (!globalThis.crypto) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeCrypto = require('crypto');
  (globalThis as any).crypto = nodeCrypto.webcrypto ?? nodeCrypto;
}

import express from 'express';
import * as http from 'http';
import { spawnSync } from 'child_process';
import { config } from './config';
import { logger } from './logger';
import { executorStartedAt, executorStartupId, getRunningCount, startHeartbeat } from './scheduler';
import { startCallbackThread, stopCallbackThread } from './callback';
import {
  startLogCleanup,
  stopLogCleanup,
  startWorkDirCleanup,
  stopWorkDirCleanup,
  flushLogs,
} from './file-logger';
import { checkAdminApiConnectivity, initAdminClients, post, postWithStaticToken } from './admin-client';
import { adoptExecutorTokenHash } from './admin-envelope';
import { taskWorkerManager } from './task-worker';
import { killRunningTaskProcesses } from './routes/execute';
import { healthRouter } from './routes/health';
import { executeRouter } from './routes/execute';
import { configRouter } from './routes/config';
import { logsRouter } from './routes/logs';
import { deployRouter } from './routes/deploy';
import { updatePackageRouter } from './routes/update-package';
import { verifyToken, setOnTokenAcquired } from './middleware/auth';

const app = express();
app.use(express.json());

app.use('/', healthRouter);
app.use('/api', verifyToken, executeRouter);
app.use('/api', verifyToken, logsRouter);
app.use('/api', verifyToken, deployRouter);
app.use('/api', verifyToken, updatePackageRouter);
app.use('/api', configRouter);

/**
 * Detect which runtimes are actually available on this system.
 * Always includes 'shell' (bash). Node is always available since we run in Node.js.
 * Checks for python3/python in PATH.
 */
function detectAvailableRuntimes(): string[] {
  const runtimes: string[] = ['shell', 'node'];

  for (const bin of ['python3', 'python']) {
    const r = spawnSync('which', [bin], { stdio: 'ignore' });
    if (r.status === 0) {
      runtimes.push('python');
      break;
    }
  }

  return runtimes;
}

// N41: register 失败不再永久依赖进程重启恢复。token 链恢复（fetchToken 成功，
// 经 setOnTokenAcquired 钩子）后触发一次带富元数据的重注册——admin 侧对同
// (address, startupId) 的 register 幂等（不轮换 token、按白名单更新元数据），
// 所以这次补注册只会修复 /token side effect 重建行时丢失的
// type/capabilities/maxConcurrent/version，不会引发旋转风暴。
let registerSucceeded = false;
let reRegisterInFlight = false;

async function registerExecutor(): Promise<boolean> {
  const runtimes = detectAvailableRuntimes();
  try {
    const resp = await postWithStaticToken('/api/executors/register', {
      appName: config.appName,
      groupName: config.groupName || undefined,
      address: config.executorAddressPublic || config.executorAddress,
      type: 'node',
      version: '1.0.0',
      // Legacy field kept for backwards compatibility
      capabilities: runtimes,
      // Structured capability fields
      runtime: runtimes,
      maxConcurrent: config.maxConcurrentTasks,
      restartedAt: executorStartedAt,
      startupId: executorStartupId,
    });
    // N26 (round-8): adopt the per-executor tokenHash returned at register
    // time. It becomes the HMAC source secret for per-execution callback
    // tokens (execution-callback-token.ts resolveCallbackSecret), so
    // per-node `--secret` deployments verify on the admin side against the
    // exact value stored there. The response may or may not be wrapped by
    // the admin ResponseInterceptor ({code,message,data}) — unwrapAdminResponseData
    // reads both shapes (R9: shared with middleware/auth.ts fetchToken).
    adoptExecutorTokenHash(resp?.data);
    registerSucceeded = true;
    logger.info(`Registered to admin-api (runtimes: ${runtimes.join(', ')}, maxConcurrent: ${config.maxConcurrentTasks})`);
    return true;
  } catch (err: any) {
    registerSucceeded = false;
    logger.warn(
      `Register failed (will re-register with rich metadata on next token acquisition): ${err.message}`,
    );
    return false;
  }
}

/** N41: token 恢复后的补注册——已注册短路 + in-flight 去重，防重复风暴。 */
function maybeReRegister(): void {
  if (registerSucceeded || reRegisterInFlight) return;
  reRegisterInFlight = true;
  void registerExecutor().finally(() => {
    reRegisterInFlight = false;
  });
}

async function notifyOffline(): Promise<void> {
  try {
    await post('/api/executors/offline', {
      address: config.executorAddressPublic || config.executorAddress,
    });
    logger.info('Sent offline notification to admin-api');
  } catch (err: any) {
    logger.warn(`Failed to send offline notification: ${err.message}`);
  }
}

// Graceful shutdown
let heartbeatInterval: NodeJS.Timeout | null = null;
let isShuttingDown = false;

async function gracefulShutdown(signal: string, exitCode = 0): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}, initiating graceful shutdown...`);

  // Stop heartbeat
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  // Stop accepting new requests before task shutdown can enqueue final callbacks
  server.close();

  // Stop log cleanup thread + buffered log writer
  stopLogCleanup();
  stopWorkDirCleanup();

  // Stop all task workers
  taskWorkerManager.stopAll();

  // Wait for running tasks (max 30 seconds)
  const maxWait = 30_000;
  const startTime = Date.now();
  while (getRunningCount() > 0) {
    if (Date.now() - startTime > maxWait) {
      // Grace expired: kill the detached task process groups, otherwise they
      // outlive the executor as unmanaged orphans (callbacks from tasks killed below may not be reported; queued callbacks are drained normally).
      const killed = killRunningTaskProcesses();
      logger.warn(
        `Grace period expired, ${getRunningCount()} task(s) still running, forcing shutdown` +
          (killed > 0 ? ` — killed ${killed} task process group(s)` : ''),
      );
      break;
    }
    logger.info(`Waiting for ${getRunningCount()} task(s) to complete...`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Drain callbacks produced by stopped and completed workers before exiting
  await stopCallbackThread();

  // Flush any buffered task logs to disk before exiting
  try {
    await flushLogs();
  } catch (_) { /* best effort — we are shutting down */ }

  // Send offline notification
  await notifyOffline();

  logger.info('Executor shutdown complete');
  process.exit(exitCode);
}

// Register signal handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
// R-08 (windows-findings 2.9): Node maps the Windows CTRL_BREAK_EVENT console
// signal to SIGBREAK. Without this handler, Ctrl+Break (the only signal a
// detached/background executor can receive, since taskkill cannot deliver
// SIGTERM to console apps) killed the process immediately (exit 0xC000013A)
// — running task processes were orphaned instead of being reaped by
// gracefulShutdown's killRunningTaskProcesses. No-op on POSIX.
process.on('SIGBREAK', () => gracefulShutdown('SIGBREAK'));

// W-25 (windows-findings): last-line-of-defence parity with admin-api's
// OPS-06/ARCH-008. Before this, ANY unexpected async error killed the process
// by default WITHOUT running gracefulShutdown — task process trees then
// outlived the executor as unmanaged orphans (the exact failure mode W-24
// just removed one instance of; this covers every future one). Route both
// through the same drain + tree-kill chain, then exit(1) so a supervisor
// restarts us. 45s cap = 30s task grace + slack; if it ever fires, the
// hard exit still happens.
function fatalShutdown(reason: string): void {
  logger.error(`FATAL (unhandled): ${reason} — graceful shutdown with exit(1)`);
  let done = false;
  const hardExit = setTimeout(() => {
    if (!done) {
      logger.error('Graceful shutdown stalled after fatal error — hard exiting');
      process.exit(1);
    }
  }, 45_000);
  hardExit.unref();
  gracefulShutdown(reason, 1)
    .catch(() => undefined)
    .finally(() => {
      done = true;
      process.exit(1);
    });
}
process.on('unhandledRejection', (reason) => {
  fatalShutdown(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});
process.on('uncaughtException', (err) => {
  fatalShutdown(`uncaughtException: ${err.stack ?? String(err)}`);
});

const server = app.listen(config.port, async () => {
  try {
    logger.info(`Executor started: ${config.appName} @ ${config.executorAddress}`);

    // Initialize admin clients for HA support.
    // config.adminApiUrls already applies the URL priority:
    // ADMIN_API_URLS > ADMIN_API_URL_INTERNAL > ADMIN_API_URL.
    initAdminClients(config.adminApiUrls);
    await checkAdminApiConnectivity();

    // N41: token 恢复钩子先于首次注册挂载——启动期 admin 不可达时，register
    // 失败后由后续成功的 fetchToken 自动补注册（maybeReRegister 自带去重）。
    setOnTokenAcquired(maybeReRegister);
    await registerExecutor();
    heartbeatInterval = startHeartbeat();
    startCallbackThread();
    startLogCleanup(config.logRetentionDays || 7);
    // Disk reclamation for task workdirs / git caches / downloaded packages /
    // dead-letter callbacks — same retention policy as the logs (7 days).
    startWorkDirCleanup(config.logRetentionDays || 7);

    // Fail loudly on a misconfiguration that would silently open an
    // unauthenticated /api/execute endpoint (dev mode passthrough).
    if (!config.token) {
      logger.warn(
        'No EXECUTOR_SHARED_TOKEN / EXECUTOR_SECRET configured — /api/* accepts UNAUTHENTICATED requests. ' +
          'Set REQUIRE_TOKEN=true to refuse unauthenticated task submissions instead.',
      );
    }
  } catch (err: unknown) {
    // An async callback rejection here would be unhandled — exit loudly
    // instead so the supervisor restarts the executor.
    logger.error(`Startup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
});
