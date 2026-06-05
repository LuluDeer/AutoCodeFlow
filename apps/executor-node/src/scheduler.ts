import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config';
import { logger } from './logger';
import { post } from './admin-client';

// BUG-03: Use atomic operations to prevent race conditions in concurrent task counting
// SharedArrayBuffer allows atomic operations across threads, but for single-process Node.js
// we use a simple lock-free approach with Atomics for consistency
const sharedBuffer = new SharedArrayBuffer(4);
const runningCountArray = new Int32Array(sharedBuffer);

export function getRunningCount(): number {
  return Atomics.load(runningCountArray, 0);
}

export function getRunningCountArray(): Int32Array {
  return runningCountArray;
}

export function incrementRunning(): void {
  Atomics.add(runningCountArray, 0, 1);
}

export function decrementRunning(): void {
  Atomics.sub(runningCountArray, 0, 1);
}

// For backward compatibility
export const runningCount = new Proxy({}, {
  get() { return getRunningCount(); }
});

async function sendHeartbeat() {
  try {
    const cpuUsage = os.loadavg()[0]; // 1-min load avg
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memUsage = ((totalMem - freeMem) / totalMem) * 100;

    // OPS-03: generate trace ID for heartbeat
    const traceId = uuidv4();

    logger.info(`[${traceId}] Sending heartbeat`);
    await post('/api/executors/heartbeat', {
      address: config.executorAddressPublic || config.executorAddress,
      cpuUsage,
      memUsage,
      runningTaskCount: runningCount,
    });
  } catch (err: any) {
    logger.warn(`Heartbeat failed: ${err.message}`);
  }
}

export function startHeartbeat() {
  return setInterval(sendHeartbeat, 30_000);
}
