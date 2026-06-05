import express from 'express';
import axios from 'axios';
import * as http from 'http';
import { config } from './config';
import { logger } from './logger';
import { startHeartbeat, runningCount } from './scheduler';
import { healthRouter } from './routes/health';
import { executeRouter } from './routes/execute';
import { configRouter } from './routes/config';
// S-01: import auth middleware alongside router — all /api routes require authentication
import { logsRouter, executorAuthMiddleware } from './routes/logs';
// SEC-03: import dynamic token auth middleware
import { verifyToken, getCurrentToken } from './middleware/auth';

const app = express();
app.use(express.json());

app.use('/', healthRouter);
// SEC-03: use dynamic token auth middleware (with fallback to static token)
app.use('/api', verifyToken, executeRouter);
app.use('/api', verifyToken, logsRouter);
app.use('/api', configRouter);

function getAdminApiUrl(): string {
  if (config.adminApiUrlExternal) {
    return config.adminApiUrlExternal;
  }
  if (config.adminApiUrlInternal) {
    return config.adminApiUrlInternal;
  }
  return config.adminApiUrl;
}

// S5/S14: attach dynamic or static token for executor registration
async function executorHeaders(): Promise<Record<string, string>> {
  const token = await getCurrentToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function registerExecutor() {
  try {
    const headers = await executorHeaders();
    await axios.post(`${getAdminApiUrl()}/api/executors/register`, {
      appName: config.appName,
      address: config.executorAddressPublic || config.executorAddress,
      type: 'node',
      version: '1.0.0',
      capabilities: ['node', 'shell'],
    }, { timeout: 10_000, headers });
    logger.info('Registered to admin-api');
  } catch (err: any) {
    logger.warn(`Register failed (will retry via heartbeat): ${err.message}`);
  }
}

async function notifyOffline(): Promise<void> {
  try {
    const headers = await executorHeaders();
    await axios.post(`${getAdminApiUrl()}/api/executors/offline`, {
      address: config.executorAddressPublic || config.executorAddress,
    }, { timeout: 5000, headers });
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

  // Wait for running tasks (max 30 seconds)
  const maxWait = 30_000;
  const startTime = Date.now();
  while (runningCount > 0) {
    if (Date.now() - startTime > maxWait) {
      logger.warn(`Grace period expired, ${runningCount} task(s) still running, forcing shutdown`);
      break;
    }
    logger.info(`Waiting for ${runningCount} task(s) to complete...`);
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
  await registerExecutor();
  heartbeatInterval = startHeartbeat();
});
