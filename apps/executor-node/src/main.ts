// Load .env file before anything else so process.env is populated
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// Polyfill globalThis.crypto for Node.js < 19 (used by uuid and other dependencies)
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
import { startLogCleanup, stopLogCleanup } from './file-logger';
import { checkAdminApiConnectivity, initAdminClients, post, postWithStaticToken } from './admin-client';
import { taskWorkerManager } from './task-worker';
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
    await postWithStaticToken('/api/executors/register', {
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
    logger.info(`Registered to admin-api (runtimes: ${runtimes.join(', ')}, maxConcurrent: ${config.maxConcurrentTasks})`);
  } catch (err: any) {
    logger.warn(`Register failed (will retry via heartbeat): ${err.message}`);
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

  // Stop log cleanup thread
  stopLogCleanup();

  // Stop all task workers
  taskWorkerManager.stopAll();

  // Wait for running tasks (max 30 seconds)
  const maxWait = 30_000;
  const startTime = Date.now();
  while (getRunningCount() > 0) {
    if (Date.now() - startTime > maxWait) {
      logger.warn(`Grace period expired, ${getRunningCount()} task(s) still running, forcing shutdown`);
      break;
    }
    logger.info(`Waiting for ${getRunningCount()} task(s) to complete...`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Send offline notification
  await notifyOffline();

  logger.info('Executor shutdown complete');
  process.exit(0);
}

// Register signal handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const server = app.listen(config.port, async () => {
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
});
