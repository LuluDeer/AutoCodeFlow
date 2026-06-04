import express from 'express';
import axios from 'axios';
import { config } from './config';
import { logger } from './logger';
import { startHeartbeat } from './scheduler';
import { healthRouter } from './routes/health';
import { executeRouter } from './routes/execute';
// S-01: import auth middleware alongside router — all /api routes require authentication
import { logsRouter, executorAuthMiddleware } from './routes/logs';

const app = express();
app.use(express.json());

app.use('/', healthRouter);
app.use('/api', executorAuthMiddleware, executeRouter);
app.use('/api', executorAuthMiddleware, logsRouter);

// S5/S14: attach shared token so admin-api can verify executor identity
function executorHeaders(): Record<string, string> {
  const token = process.env.EXECUTOR_SHARED_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function registerExecutor() {
  try {
    await axios.post(`${config.adminApiUrl}/api/executors/register`, {
      appName: config.appName,
      address: config.executorAddress,
      type: 'node',
      version: '1.0.0',
      capabilities: ['node', 'shell'],
    }, { timeout: 10_000, headers: executorHeaders() });
    logger.info('Registered to admin-api');
  } catch (err: any) {
    logger.warn(`Register failed (will retry via heartbeat): ${err.message}`);
  }
}

app.listen(config.port, async () => {
  logger.info(`Executor started: ${config.appName} @ ${config.executorAddress}`);
  await registerExecutor();
  startHeartbeat();
});
