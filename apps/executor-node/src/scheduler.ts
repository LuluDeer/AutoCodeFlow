import * as os from 'os';
import { randomUUID } from 'crypto';
import { config } from './config';
import { logger } from './logger';
import { post } from './admin-client';
import { recordHeartbeat } from './heartbeat-state';

// BUG-03: Use atomic operations to prevent race conditions in concurrent task counting
// SharedArrayBuffer allows atomic operations across threads, but for single-process Node.js
// we use a simple lock-free approach with Atomics for consistency
const sharedBuffer = new SharedArrayBuffer(4);
const runningCountArray = new Int32Array(sharedBuffer);

export const executorStartedAt = new Date().toISOString();
export const executorStartupId = randomUUID();

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

// For backward compatibility — use getRunningCount() directly for new code
export const runningCount = getRunningCount;  // alias to the function

/**
 * Measure actual CPU usage by sampling cpu times over 500ms.
 * os.loadavg() always returns [0,0,0] on Windows, so we use this instead.
 */
async function measureCpuUsage(): Promise<number> {
  return new Promise((resolve) => {
    const cpus1 = os.cpus();
    setTimeout(() => {
      const cpus2 = os.cpus();
      let idle = 0, total = 0;
      for (let i = 0; i < cpus1.length; i++) {
        const t1 = cpus1[i].times;
        const t2 = cpus2[i].times;
        const idleDiff = t2.idle - t1.idle;
        const totalDiff =
          (t2.user - t1.user) +
          (t2.nice - t1.nice) +
          (t2.sys - t1.sys) +
          (t2.idle - t1.idle) +
          (t2.irq - t1.irq);
        idle += idleDiff;
        total += totalDiff;
      }
      const usage = total > 0 ? ((total - idle) / total) * 100 : 0;
      resolve(Math.round(usage * 100) / 100);
    }, 500);
  });
}

async function sendHeartbeat() {
  try {
    const cpuUsage = await measureCpuUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memUsage = ((totalMem - freeMem) / totalMem) * 100;

    // OPS-03: generate trace ID for heartbeat
    const traceId = randomUUID();

    logger.info(`[${traceId}] Sending heartbeat`);
    await post('/api/executors/heartbeat', {
      address: config.executorAddressPublic || config.executorAddress,
      cpuUsage,
      memUsage,
      runningTaskCount: getRunningCount(),
      restartedAt: executorStartedAt,
      startupId: executorStartupId,
    });
    logger.info(`[${traceId}] Heartbeat succeeded`);
    recordHeartbeat(true);
  } catch (err: unknown) {
    logger.warn(`Heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    recordHeartbeat(false);
  }
}

export function startHeartbeat() {
  return setInterval(sendHeartbeat, config.heartbeatIntervalSeconds * 1000);
}
