import express from 'express';
import * as http from 'http';
import { config } from './config';
import { logger } from './logger';
import { getRunningCount } from './scheduler';
import { startCallbackThread, stopCallbackThread } from './callback';
import { startLogCleanup, stopLogCleanup } from './file-logger';
import { initAdminClients, post } from './admin-client';
import { taskWorkerManager } from './task-worker';
import { healthRouter } from './routes/health';
import { executeRouter } from './routes/execute';
import { configRouter } from './routes/config';
import { logsRouter, executorAuthMiddleware } from './routes/logs';
import { verifyToken } from './middleware/auth';

const app = express();
app.use(express.json());

app.use('/', healthRouter);
app.use('/api', verifyToken, executeRouter);
app.use('/api', verifyToken, logsRouter);
app.use('/api', configRouter);

async function registerExecutor() {
  try {
    await post('/api/executors/register', {
      appName: config.appName,
      address: config.executorAddressPublic || config.executorAddress,
      type: 'node',
      version: '1.0.0',
      capabilities: ['node', 'shell'],
    });
    logger.info('Registered to admin-api');
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
  
  // Initialize admin clients for HA support
  const adminUrls = config.adminApiUrls.length > 0 
    ? config.adminApiUrls 
    : [config.adminApiUrl];
  initAdminClients(adminUrls);
  
  await registerExecutor();
  heartbeatInterval = startHeartbeat();
  startCallbackThread();
  startLogCleanup(config.logRetentionDays || 7);
});
