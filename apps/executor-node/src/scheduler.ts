import axios from 'axios';
import * as os from 'os';
import { config } from './config';
import { logger } from './logger';

export let runningCount = 0;

export function incrementRunning() { runningCount++; }
export function decrementRunning() { runningCount--; }

async function sendHeartbeat() {
  try {
    const cpuUsage = os.loadavg()[0]; // 1-min load avg
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memUsage = ((totalMem - freeMem) / totalMem) * 100;

    await axios.post(`${config.adminApiUrl}/api/executors/heartbeat`, {
      address: config.executorAddress,
      cpuUsage,
      memUsage,
      runningTaskCount: runningCount,
    }, { timeout: 5000 });
  } catch (err: any) {
    logger.warn(`Heartbeat failed: ${err.message}`);
  }
}

export function startHeartbeat() {
  return setInterval(sendHeartbeat, 30_000);
}
