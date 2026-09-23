import * as os from 'os';
import { randomUUID } from 'crypto';
import { config, EXECUTOR_VERSION, PROTOCOL_VERSION } from './config';
import { logger } from './logger';
import { post } from './admin-client';
import { recordHeartbeat } from './heartbeat-state';
import { executorStartedAt, executorStartupId } from './startup-identity';
// ARCH-36（ADR-017 阶段 2）：设备指纹与 register 同源（同一 memo）。
import { getDeviceFingerprint } from './device-identity';
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

/**
 * NETOPT-9-7: bounded wait for the running-task ledger to reach zero.
 *
 * Used by main.ts after killRunningTaskProcesses() at grace expiry: the killed
 * processes' close → runTask catch → pushCallback chain needs a small window to
 * enqueue their terminal callbacks before stopCallbackThread()'s final
 * "queue empty → break" check, otherwise those callbacks are lost with the
 * process (parity with executor-python's await_background_tasks_after_kill,
 * QA8). Bounded so shutdown can never hang on a task whose ledger slot is
 * leaked.
 *
 * Exported (not private) so the wait itself is unit-testable with fake timers
 * + a mocked getRunningCount.
 */
export async function waitForRunningCountZero(
  maxWaitMs = 5_000,
  pollMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (getRunningCount() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return getRunningCount() === 0;
}

// For backward compatibility — use getRunningCount() directly for new code
export const runningCount = getRunningCount;  // alias to the function

// STALE-01: heartbeat enrichment providers. The live execution registry lives
// in routes/execute.ts which already imports this module — importing back
// would form a cycle, so the data owners register their getters here.
let runningExecutionIdsProvider: () => string[] = () => [];
let deadLetterCountProvider: () => number = () => 0;

/**
 * E-01-RPT（生产实证：RPA5「当前运行任务 1/10、活性上报 0 条」）：
 * pull 长轮询「已预留但尚未认领」的槽位数。
 *
 * 背景——为什么需要这个字段：E-01 让 pull 循环在发起 25s 长轮询**之前**先
 * 原子预留一个容量槽位（`pull.ts` 的 Atomics.add），预留计入同一个并发账本，
 * 因此 `runningTaskCount` 在长轮询窗口内诚实包含这个预留（这正是关闭
 * admin 超卖竞态窗口的机制本身，见 pull.ts 顶部注释）。
 *
 * 但 `runningExecutionIds` 来自**另一个账本**（`liveExecutions` Map，只有
 * 真正领取到的执行才有 id）。空闲执行器几乎始终处在长轮询窗口内，于是稳态
 * 下就是「runningTaskCount=1 + runningExecutionIds=[]」——两个数字都对，
 * 却度量了不同的东西：前者是**已占槽位**，后者是**在跑执行**。
 *
 * 后果（生产现象）：中台详情页把两者交叉核对，遂恒亮「活性上报 0 条，与运行
 * 计数 1 不一致」，并显示「当前运行任务 1/10」——而该设备上确实没有任何任务
 * 在跑。这不是计数泄漏，也不是卡住的任务，是 E-01 预留窗口的**上报口径缺失**。
 *
 * 修法：预留方（pull 循环）把「预留中」的槽位数单独上报，中台据此把
 * 「已占槽位」换算成「实际运行 = runningTaskCount − reservedSlots」，派发
 * 闸门仍读 runningTaskCount（E-01 的防超卖语义逐字节不变）。
 */
let pullReservedSlotsProvider: () => number = () => 0;

export function registerPullReservedSlotsProvider(fn: () => number): void {
  pullReservedSlotsProvider = fn;
}

/**
 * E-01-RPT: 预留槽位数上报前的防御性归一。
 *
 * 契约：非负整数。provider 异常/返回非法值一律收敛为 0（=「无预留」），
 * 而非让心跳失败——上报口径缺失只会让中台回落到旧的「按已占槽位显示」，
 * 而心跳失败会让 admin 判 OFFLINE，代价完全不成比例。
 *
 * 不在此处按 maxConcurrentTasks 钳制：该值随 /config/reload 热更，且
 * 单飞（pullInFlight）保证真值恒为 0 或 1；钳制只会掩盖 provider 的 bug。
 * admin 侧另有采纳域校验（越界 → 视同未上报，DB 值不动）。
 */
function collectReservedSlots(): number {
  let value: unknown;
  try {
    value = pullReservedSlotsProvider();
  } catch (err: unknown) {
    logger.warn(
      `pullReservedSlots provider failed; reporting 0: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 0;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    logger.warn(
      `pullReservedSlots provider returned a non-integer (${String(value)}); reporting 0`,
    );
    return 0;
  }
  return value;
}

/** NETOPT-C P2-1: 心跳活性清单上限——与 admin E9 采纳域（maxConcurrentTasks
 *  ≤10000）对齐，保证容量上界内每个在跑执行都能进入 stale-sweep 存活宽限
 *  （旧 200 封顶在并发 >200 时让第 201+ 个 id 从 includes() 判据里消失）。 */
export const MAX_RUNNING_EXECUTION_IDS = 10_000;

export function registerRunningExecutionIdsProvider(fn: () => string[]): void {
  runningExecutionIdsProvider = fn;
}

export function registerDeadLetterCountProvider(fn: () => number): void {
  deadLetterCountProvider = fn;
}

// FR-13/FR-14（python_task_upload_and_multiversion, CONTRACT.md §2.3）：解释器
// 缓存池清单与 `runningExecutionIds`/`deadLetterCount` 同一 provider 模式。
//
// 为什么是 provider 而不是直接 import interpreters.ts：main.ts 需要在
// **首次 register 之前**接好数据源（python 侧 `register_interpreters_provider`
// 同理），这样首个 register 与首个 heartbeat 上报的是同一份快照，不会出现
// "注册说池为空、心跳说有 3.9"的自相矛盾窗口。
//
// 返回 Promise：探测需要 spawn uv（有界、带 TTL 缓存）。心跳是 async 的，
// await 它不会阻塞事件循环。
export interface ReportedInterpreter {
  version: string;
  path: string;
  available: boolean;
  discoveredAt: string;
}

let interpretersProvider: () => Promise<ReportedInterpreter[]> = async () => [];

export function registerInterpretersProvider(fn: () => Promise<ReportedInterpreter[]>): void {
  interpretersProvider = fn;
}

/**
 * provider 输出归一为契约形状的数组（CONTRACT.md §2.2）。
 *
 * 上报的是"能力快照"，**任何异常都不能让心跳失败**——那会让 admin 判执行器
 * OFFLINE，代价远大于少报一次清单。异常/非数组一律收敛为空数组，与 python 侧
 * `_collect_interpreters` 逐条对齐。
 */
async function collectInterpreters(): Promise<ReportedInterpreter[]> {
  let value: unknown;
  try {
    value = await interpretersProvider();
  } catch (err: unknown) {
    logger.warn(
      `interpreters provider failed; reporting an empty inventory: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
  if (!Array.isArray(value)) {
    logger.warn(`interpreters provider returned ${typeof value}, expected array`);
    return [];
  }
  // §2.2 结构校验：项缺 version / version 非 X.Y[.Z] → 整字段拒绝采纳（admin
  // 侧也会拒，但在这里先过滤掉脏项可以避免一个坏项废掉整份清单）。
  return value.filter(
    (item): item is ReportedInterpreter =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as ReportedInterpreter).version === 'string' &&
      /^\d+\.\d+(\.\d+)?$/.test((item as ReportedInterpreter).version),
  );
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
    const runningIds = runningExecutionIdsProvider();
    if (runningIds.length > MAX_RUNNING_EXECUTION_IDS) {
      logger.warn(
        `runningExecutionIds exceeds heartbeat cap ${MAX_RUNNING_EXECUTION_IDS} (${runningIds.length} running) — overflow ids lose stale-sweep grace`,
      );
    }
    const resp = await post('/api/executors/heartbeat', {
      address: config.executorAddressPublic || config.executorAddress,
      cpuUsage,
      memUsage,
      runningTaskCount: getRunningCount(),
      // STALE-01: admin 的 stale sweep 据此跳过"回调只是迟到"（重试退避、
      // 同任务排队）的执行，避免误判失败+提前释放容量。上限与 E9 对齐（见
      // MAX_RUNNING_EXECUTION_IDS），deadLetterCount 暴露落盘回调积压。
      runningExecutionIds: runningIds.slice(0, MAX_RUNNING_EXECUTION_IDS),
      // E-01-RPT（生产实证：RPA5「当前运行任务 1/10、活性上报 0 条」）：
      // runningTaskCount 含 pull 长轮询「预留中」的槽位（E-01 防超卖机制），
      // 而 runningExecutionIds 只含真正领取到的执行——空闲执行器稳态下
      // 恒为「1 + []」，中台详情页因此恒亮「不一致」告警。此处把预留数单独
      // 上报，中台即可算出「实际运行 = runningTaskCount − reservedSlots」。
      //
      // 语义红线：**始终发送该字段**（含 0），与 runningExecutionIds 同款
      // 三态纪律——`0` = 已上报且无预留，字段缺席 = 旧版执行器未上报（中台
      // 回落到「按已占槽位显示」的旧口径，行为与引入前逐字节一致）。
      reservedSlots: collectReservedSlots(),
      deadLetterCount: deadLetterCountProvider(),
      // FR-13/FR-14（CONTRACT.md §2.3）：解释器缓存池清单。**始终发送该字段**
      // （哪怕为空数组）——`[]` 表示"已上报且池为空"，而字段缺席表示"旧执行器
      // 未上报"（admin 按 ["3.12"] 兜底）。本执行器是能上报的新版本，池为空是
      // 真实事实，不该让 admin 用兜底值去猜，否则一个声明 3.12 的任务会被派到
      // 池里根本没有 3.12 的执行器上。provider 走 WS3 的 TTL 探测缓存，
      // 心跳路径零 uv 进程开销（NFR-10）。
      interpreters: await collectInterpreters(),
      // E9: 上报当前并发上限，admin 容量核算不再依赖注册期快照；读 config
      // 对象属性，/config/reload 热更 maxConcurrentTasks 后下个心跳即回传新值。
      maxConcurrentTasks: config.maxConcurrentTasks,
      restartedAt: executorStartedAt,
      startupId: executorStartupId,
      // ARCH-36（ADR-017 阶段 2）：稳定设备指纹随心跳一并回传。register 已
      // 落库过，此处是幂等重传（memo 命中，纯内存读取，零进程开销）；价值在于
      // 「注册时数据目录恰好只读、之后恢复」的场景能自愈，以及 admin 侧可比较
      // 注册期与心跳期是否一致（不一致 = 盐文件被换/工作目录改了）。
      deviceFingerprint: getDeviceFingerprint() ?? undefined,
      // EXE-VER-1: 版本随心跳上报（可选字段），中心端 EXECUTOR_MIN_VERSION
      // 门禁开启时在响应中回显 versionCompliant（见下方消费）。
      version: EXECUTOR_VERSION,
      // PROTOCOL-VER（B-3/U-2）：协议版本随心跳回传（与 register 同源），
      // 中台可据此在心跳路径同样做兼容性分支。
      protocolVersion: PROTOCOL_VERSION,
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
