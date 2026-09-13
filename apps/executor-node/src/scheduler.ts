import * as os from 'os';
import { randomUUID } from 'crypto';
import { config, EXECUTOR_VERSION } from './config';
import { logger } from './logger';
import { post } from './admin-client';
import { recordHeartbeat } from './heartbeat-state';
import { executorStartedAt, executorStartupId } from './startup-identity';
import { adoptExecutorTokenHash, unwrapAdminResponseData } from './admin-envelope';

// BUG-03: Use atomic operations to prevent race conditions in concurrent task counting
// SharedArrayBuffer allows atomic operations across threads, but for single-process Node.js
// we use a simple lock-free approach with Atomics for consistency
const sharedBuffer = new SharedArrayBuffer(4);
const runningCountArray = new Int32Array(sharedBuffer);

// R9: the process-life identity moved to startup-identity.ts (so
// middleware/auth.ts can send startupId in the token request without a
// scheduler <-> admin-client <-> auth import cycle). Re-exported here for
// existing importers (main.ts, specs).
export { executorStartedAt, executorStartupId };

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

// STALE-01: heartbeat enrichment providers. The live execution registry lives
// in routes/execute.ts which already imports this module — importing back
// would form a cycle, so the data owners register their getters here.
let runningExecutionIdsProvider: () => string[] = () => [];
let deadLetterCountProvider: () => number = () => 0;

export function registerRunningExecutionIdsProvider(fn: () => string[]): void {
  runningExecutionIdsProvider = fn;
}

export function registerDeadLetterCountProvider(fn: () => number): void {
  deadLetterCountProvider = fn;
}

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

// EXE-VER-1: 版本漂移告警节流状态——同一次不合规期最多每 10 分钟 warn 一条。
const VERSION_DRIFT_WARN_INTERVAL_MS = 10 * 60 * 1000;
let lastVersionDriftWarnAt = 0;

function warnVersionDriftThrottled(minVersion: string): void {
  const now = Date.now();
  if (now - lastVersionDriftWarnAt < VERSION_DRIFT_WARN_INTERVAL_MS) return;
  lastVersionDriftWarnAt = now;
  logger.warn(
    `Version drift: executor ${EXECUTOR_VERSION} is below the admin-required minimum ${minVersion} ` +
      `(EXECUTOR_MIN_VERSION). New task dispatch may be refused for this executor — ` +
      `upgrade by re-running the install command or downloading the latest executor artifact.`,
  );
}

export function resetVersionDriftWarnStateForTest(): void {
  lastVersionDriftWarnAt = 0;
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
    const resp = await post('/api/executors/heartbeat', {
      address: config.executorAddressPublic || config.executorAddress,
      cpuUsage,
      memUsage,
      runningTaskCount: getRunningCount(),
      // STALE-01: admin 的 stale sweep 据此跳过"回调只是迟到"（重试退避、
      // 同任务排队）的执行，避免误判失败+提前释放容量；裁剪 200 封顶报文。
      // deadLetterCount 暴露落盘回调积压，供运维感知长期断连。
      runningExecutionIds: runningExecutionIdsProvider().slice(0, 200),
      deadLetterCount: deadLetterCountProvider(),
      // E9: 上报当前并发上限，admin 容量核算不再依赖注册期快照；读 config
      // 对象属性，/config/reload 热更 maxConcurrentTasks 后下个心跳即回传新值。
      maxConcurrentTasks: config.maxConcurrentTasks,
      restartedAt: executorStartedAt,
      startupId: executorStartupId,
      // EXE-VER-1: 版本随心跳上报（可选字段），中心端 EXECUTOR_MIN_VERSION
      // 门禁开启时在响应中回显 versionCompliant（见下方消费）。
      version: EXECUTOR_VERSION,
    });
    // R9 (round-8 P1 W3): the heartbeat response echoes admin's current
    // stored tokenHash (same adoption as register/POST /token), so the
    // per-execution callback HMAC secret stays in sync with admin-side
    // rotations without waiting for a re-register.
    adoptExecutorTokenHash(resp?.data);
    // EXE-VER-1: 版本漂移提醒——门禁开启且本执行器版本低于下限时，admin 在
    // 响应里回显 versionCompliant=false。10 分钟节流防 30s 心跳刷屏；升级
    // 执行器（重装 artifact）后响应回到 true，日志自然静默。
    const heartbeatPayload = unwrapAdminResponseData(resp?.data);
    if (heartbeatPayload && heartbeatPayload.versionCompliant === false) {
      warnVersionDriftThrottled(String(heartbeatPayload.minVersion ?? ''));
    }
    logger.info(`[${traceId}] Heartbeat succeeded`);
    recordHeartbeat(true);
  } catch (err: unknown) {
    logger.warn(`Heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    recordHeartbeat(false);
  }
}

export function startHeartbeat() {
  // Poll once per second so hot-reloaded intervals take effect without
  // rebuilding the timer; main.ts can still stop it with clearInterval.
  let lastHeartbeatAt = Date.now();
  let heartbeatInFlight = false;
  return setInterval(async () => {
    const intervalMs = config.heartbeatIntervalSeconds * 1000;
    if (heartbeatInFlight || Date.now() - lastHeartbeatAt < intervalMs) {
      return;
    }

    lastHeartbeatAt = Date.now();
    heartbeatInFlight = true;
    try {
      await sendHeartbeat();
    } finally {
      heartbeatInFlight = false;
    }
  }, 1000);
}
