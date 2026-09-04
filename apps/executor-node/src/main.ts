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
import { logsRouter, executorAuthMiddleware } from './routes/logs';
import { deployRouter } from './routes/deploy';
import { updatePackageRouter } from './routes/update-package';
import { verifyToken } from './middleware/auth';

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

async function registerExecutor() {
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
    logger.info(`Registered to admin-api (runtimes: ${runtimes.join(', ')}, maxConcurrent: ${config.maxConcurrentTasks})`);
  } catch (err: any) {
    // N41 (round-10): the old "(will retry via heartbeat)" wording was
    // false — heartbeat never registers (unknown address → 404). The only
    // self-heal is the register-on-token side effect of
    // POST /executors/token in the token-refresh path, which rebuilds the
    // row WITHOUT the rich metadata above (type/capabilities/maxConcurrent/
    // version); full metadata returns only on process restart.
    logger.warn(
      `Register failed (no auto re-register; /token fallback rebuilds the row without rich metadata): ${err.message}`,
    );
  }
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

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}, initiating graceful shutdown...`);

  // Stop heartbeat
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  // Stop callback thread
  stopCallbackThread();

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
      // outlive the executor as unmanaged orphans (callbacks are already
      // stopped, so their results could never be reported anyway).
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

  // Stop accepting new requests
  server.close();

  // Flush any buffered task logs to disk before exiting
  try {
    await flushLogs();
  } catch (_) { /* best effort — we are shutting down */ }

  // Send offline notification
  await notifyOffline();

  logger.info('Executor shutdown complete');
  process.exit(0);
}

// Register signal handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const server = app.listen(config.port, async () => {
  try {
    logger.info(`Executor started: ${config.appName} @ ${config.executorAddress}`);

    // Initialize admin clients for HA support.
    // config.adminApiUrls already applies the URL priority:
    // ADMIN_API_URLS > ADMIN_API_URL_INTERNAL > ADMIN_API_URL.
    initAdminClients(config.adminApiUrls);
    await checkAdminApiConnectivity();

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
