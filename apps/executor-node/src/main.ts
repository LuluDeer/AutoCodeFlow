import express from 'express';
import axios from 'axios';
import { config } from './config';
import { logger } from './logger';
import { startHeartbeat } from './scheduler';
import { healthRouter } from './routes/health';
import { executeRouter } from './routes/execute';

const app = express();
app.use(express.json());

app.use('/', healthRouter);
app.use('/api', executeRouter);

async function registerExecutor() {
  try {
    await axios.post(`${config.adminApiUrl}/api/executors/register`, {
      appName: config.appName,
      address: config.executorAddress,
      type: 'node',
      version: '1.0.0',
      capabilities: ['node', 'shell'],
    }, { timeout: 10_000 });
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
