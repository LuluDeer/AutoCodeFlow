// Load .env file before anything else so process.env is populated
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// Polyfill globalThis.crypto for Node.js < 19 (defensive: task scripts and
// third-party dependencies may use the Web Crypto global; executor code
// itself uses node:crypto randomUUID directly)
if (!globalThis.crypto) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- crypto polyfill, CJS require needed
  const nodeCrypto = require('crypto');
  (globalThis as any).crypto = nodeCrypto.webcrypto ?? nodeCrypto;
}

import express from 'express';
import { config, EXECUTOR_VERSION, PROTOCOL_VERSION } from './config';
import { logger } from './logger';
import {
  executorStartedAt,
  executorStartupId,
  getRunningCount,
  startHeartbeat,
  registerInterpretersProvider,
  waitForRunningCountZero,
  ReportedInterpreter,
} from './scheduler';
import { interpretersForReport, resolveUvBin } from './interpreters';
import {
  detectRuntimesOnHost,
  reportedExecutorType,
  type ReportedRuntime,
} from './runtime-detection';
import { startCallbackThread, stopCallbackThread } from './callback';
import {
  startLogCleanup,
  stopLogCleanup,
  startWorkDirCleanup,
  stopWorkDirCleanup,
  flushLogs,
} from './file-logger';
import { checkAdminApiConnectivity, initAdminClients, post, postWithStaticToken } from './admin-client';
import { adoptExecutorTokenHash } from './admin-envelope';
import { recordRegistration } from './heartbeat-state';
// ARCH-36（ADR-017 阶段 2）：稳定设备指纹（register/heartbeat 同源，memo 一次）。
import { getDeviceFingerprint } from './device-identity';
import { setExecutorShuttingDown, isExecutorShuttingDown } from './shutdown-state';
import { taskWorkerManager } from './task-worker';
import { startPullLoop, stopPullLoop } from './pull';
import { killRunningTaskProcesses, abortAllLiveExecutions } from './routes/execute';
import { abortDeployInFlight, runningApps } from './routes/deploy';
import { healthRouter } from './routes/health';
import { executeRouter } from './routes/execute';
import { configRouter } from './routes/config';
import { logsRouter } from './routes/logs';
import { deployRouter } from './routes/deploy';
import { updatePackageRouter } from './routes/update-package';
import { verifyToken, setOnTokenAcquired } from './middleware/auth';

const app = express();
app.use(express.json());

app.use('/', healthRouter);
app.use('/api', verifyToken, executeRouter);
app.use('/api', verifyToken, logsRouter);
app.use('/api', verifyToken, deployRouter);
app.use('/api', verifyToken, updatePackageRouter);
app.use('/api', configRouter);

/**
 * 探测并上报本机运行能力（shell/node/python）。
 *
 * 原实现内联在这里用 `spawnSync('which', ...)` 判定 python，但 **Windows 上
 * 没有 `which`**（实测 ENOENT，`status === null`），于是 Windows 客户端恒定
 * 上报 `['shell','node']`——哪怕机器上装了 Python。而 admin 侧派发**只按
 * capabilities 过滤**，任务 runtime 缺省又是 `python`，结果新设备会被所有
 * 默认任务过滤掉。现改为实跑探测，并把"自带 uv 可用"也算作 Python 能力，
 * 判定逻辑见 `runtime-detection.ts`（纯函数，已有单测覆盖）。
 *
 * 探测失败一律降级（绝不让注册失败）：能力少报只会让任务不派过来，
 * 而抛异常会让整台执行器注册不上，后者严重得多。
 */
async function detectAvailableRuntimes(): Promise<ReportedRuntime[]> {
  let hasUv = false;
  try {
    const uv = await resolveUvBin();
    hasUv = uv.path !== null;
    if (uv.source === 'missing') {
      logger.warn(
        'no uv available (UV_BIN / PATH / bundled all absent) — python tasks ' +
          'declaring runtimeVersion will not be runnable on this executor',
      );
    }
  } catch (err: any) {
    logger.warn(`uv resolution failed during runtime detection: ${err?.message ?? err}`);
  }
  try {
    return await detectRuntimesOnHost({ hasUv });
  } catch (err: any) {
    logger.warn(`runtime detection failed, degrading to shell+node: ${err?.message ?? err}`);
    return ['shell', 'node'];
  }
}

// N41: register 失败不再永久依赖进程重启恢复。token 链恢复（fetchToken 成功，
// 经 setOnTokenAcquired 钩子）后触发一次带富元数据的重注册——admin 侧对同
// (address, startupId) 的 register 幂等（不轮换 token、按白名单更新元数据），
// 所以这次补注册只会修复 /token side effect 重建行时丢失的
// type/capabilities/maxConcurrent/version，不会引发旋转风暴。
let registerSucceeded = false;
let reRegisterInFlight = false;

/**
 * FR-13/FR-14：解释器缓存池清单快照（注册与心跳共用的数据源）。
 *
 * 与 python 侧 `get_interpreters_snapshot()` 同语义：懒探测 + 复用探测缓存，
 * 绝不每次调用都 spawn uv（NFR-10）。`interpretersForReport` 内部已把探测
 * 失败收敛为 `[]` 并 warn（AC-14b：上报失败绝不阻断注册/启动）。
 */
function getInterpretersSnapshot(): Promise<ReportedInterpreter[]> {
  return interpretersForReport();
}

async function registerExecutor(): Promise<boolean> {
  const runtimes = await detectAvailableRuntimes();
  try {
    const resp = await postWithStaticToken('/api/executors/register', {
      appName: config.appName,
      groupName: config.groupName || undefined,
      address: config.executorAddressPublic || config.executorAddress,
      // 桌面客户端兼具 shell/node/python 执行面 → 自报 universal（此前硬编码
      // 'node'，后台把通用执行器显示成 node-only）。注意：type 只影响展示，
      // **派发只看 capabilities**，故两者由同一份 runtimes 同源推导。
      type: reportedExecutorType(runtimes),
      // EXE-VER-1: 版本上报单源 EXECUTOR_VERSION（心跳同源）；
      // 中心端 EXECUTOR_MIN_VERSION 门禁按此判定，低于下限 403。
      version: EXECUTOR_VERSION,
      // PROTOCOL-VER（B-3/U-2）：协议版本上报——中台据此做兼容性分支，
      // 与实现版本门禁解耦（见 config.ts PROTOCOL_VERSION 注释）。
      protocolVersion: PROTOCOL_VERSION,
      // ARCH-32: 派发模式自报（pull = NAT 内零入站，经长轮询取件）
      dispatchMode: config.pullMode ? 'pull' : 'push',
      // Legacy field kept for backwards compatibility
      capabilities: runtimes,
      // Structured capability fields
      runtime: runtimes,
      maxConcurrent: config.maxConcurrentTasks,
      restartedAt: executorStartedAt,
      startupId: executorStartupId,
      // ARCH-36（ADR-017 阶段 2）：稳定设备指纹（sha256(deviceId:installSalt)）。
      // 采集失败/不可用 → null，字段按 undefined 送出（admin 列保持 NULL =
      // 未上报，行为与引入前一致）；绝不因采集失败阻断注册。
      deviceFingerprint: getDeviceFingerprint() ?? undefined,
      // FR-13/AC-13a（python_task_upload_and_multiversion, CONTRACT.md §2.3）：
      // 解释器缓存池清单随注册上报。**始终发送该字段**（哪怕为 []）——见
      // scheduler.ts 的字段缺省语义说明。探测有界（≤5s）+ 容错（失败退化 []，
      // AC-14b：绝不阻断注册/启动），且走 TTL 缓存，重注册不会重复 spawn uv。
      interpreters: await getInterpretersSnapshot(),
    });
    // N26 (round-8): adopt the per-executor tokenHash returned at register
    // time. It becomes the HMAC source secret for per-execution callback
    // tokens (execution-callback-token.ts resolveCallbackSecret), so
    // per-node `--secret` deployments verify on the admin side against the
    // exact value stored there. The response may or may not be wrapped by
    // the admin ResponseInterceptor ({code,message,data}) — unwrapAdminResponseData
    // reads both shapes (R9: shared with middleware/auth.ts fetchToken).
    adoptExecutorTokenHash(resp?.data);
    registerSucceeded = true;
    // F-2: 结构化注册判定（desktop /health/admin-status 据此显示「在线」，
    // 不再依赖 'Registered to admin-api' 日志文案匹配）。
    recordRegistration(true);
    logger.info(`Registered to admin-api (runtimes: ${runtimes.join(', ')}, maxConcurrent: ${config.maxConcurrentTasks})`);
    return true;
  } catch (err: any) {
    registerSucceeded = false;
    recordRegistration(false);
    // EXE-VER-1: 门禁 403 时把服务端报文（含 minVersion 与升级指引）透传到
    // 执行器日志——只看 axios 的 "status code 403" 无法定位版本问题。
    const serverMessage =
      err?.response?.data?.message ?? err?.response?.data?.error;
    logger.warn(
      `Register failed (will re-register with rich metadata on next token acquisition): ${
        serverMessage ? `${err.message} — ${serverMessage}` : err.message
      }`,
    );
    return false;
  }
}

/** N41: token 恢复后的补注册——已注册短路 + in-flight 去重，防重复风暴。 */
function maybeReRegister(): void {
  if (registerSucceeded || reRegisterInFlight) return;
  reRegisterInFlight = true;
  void registerExecutor().finally(() => {
    reRegisterInFlight = false;
  });
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

async function gracefulShutdown(signal: string, exitCode = 0): Promise<void> {
  if (isExecutorShuttingDown()) return;
  setExecutorShuttingDown(true);

  logger.info(`Received ${signal}, initiating graceful shutdown...`);

  // E-07: 优雅停机第一步停止 pull 取件循环——drain/关机阶段不再领取新任务
  // （与 python main.py 取消 _pull_task 对等）。pull 循环每秒一次，若不停机会
  // 与后续停机步骤竞争领取任务。
  stopPullLoop();

  // NETOPT-E P2-2: 中止全部 in-flight 部署 provisioning（git clone/npm/pip/
  // unzip/download——detached 长耗时命令，不中止会在执行器退出后成孤儿，Windows
  // 下持锁让新实例同 app 部署 EBUSY）。已启动的 daemon（runningApps）不受影响：
  // 应用进程生命周期独立于执行器，停机日志下方提示存活数量。
  abortDeployInFlight();

  // Stop heartbeat
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  // Stop accepting new requests before task shutdown can enqueue final callbacks
  server.close();
  // NETOPT-9-1: server.close() only refuses NEW connections — keep-alive
  // connections established before the drain window keep serving requests
  // (push dispatch would still claim tasks during the 30s grace). closeIdle
  // Connections() tears down the idle half of those so an in-flight /execute
  // on a live connection hits the acceptExecution 503 guard instead of being
  // accepted and SIGKILLed at grace expiry.
  server.closeIdleConnections?.();

  // Stop log cleanup thread + buffered log writer
  stopLogCleanup();
  stopWorkDirCleanup();

  // Stop all task workers
  taskWorkerManager.stopAll();

  // Wait for running tasks (max 30 seconds)
  const maxWait = 30_000;
  const startTime = Date.now();
  while (getRunningCount() > 0) {
    if (Date.now() - startTime > maxWait) {
      // Grace expired: kill the detached task process groups, otherwise they
      // outlive the executor as unmanaged orphans (callbacks from tasks killed below may not be reported; queued callbacks are drained normally).
      // NETOPT-C P3: 先 abort 全部活跃执行——prepare 阶段的 runCommand 子进程
      // （git clone/npm/uv，detached 不登记）由 abort signal 树杀，检查点随
      // 即静默退出释放槽位；killRunningTaskProcesses 只管 runProcess 登记的
      // 任务进程组。两者缺一都会让槽位卡到进程退出。
      const aborted = abortAllLiveExecutions();
      const killed = killRunningTaskProcesses();
      logger.warn(
        `Grace period expired, ${getRunningCount()} task(s) still running, forcing shutdown` +
          (aborted > 0 ? ` — aborted ${aborted} prepare/active execution(s)` : '') +
          (killed > 0 ? ` — killed ${killed} task process group(s)` : ''),
      );
      // NETOPT-9-7: give the killed tasks' close → runTask catch → pushCallback
      // chain a bounded window to enqueue their terminal callbacks before the
      // callback thread's final "queue empty → break" check (parity with
      // executor-python's await_background_tasks_after_kill, QA8). Without
      // this, killed tasks' callbacks race the thread shutdown and are lost
      // with the process.
      await waitForRunningCountZero(5_000, 100);
      break;
    }
    logger.info(`Waiting for ${getRunningCount()} task(s) to complete...`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Drain callbacks produced by stopped and completed workers before exiting
  await stopCallbackThread();

  // Flush any buffered task logs to disk before exiting
  try {
    await flushLogs();
  } catch (_) { /* best effort — we are shutting down */ }

  // Send offline notification
  await notifyOffline();

  // NETOPT-E P2-2: 提示存活 daemon（不随执行器停机——独立生命周期）。
  logger.info(
    `Executor shutdown complete` +
      (runningApps.size > 0 ? ` (${runningApps.size} app daemon(s) left running)` : ''),
  );
  process.exit(exitCode);
}

// Register signal handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
// R-08 (windows-findings 2.9): Node maps the Windows CTRL_BREAK_EVENT console
// signal to SIGBREAK. Without this handler, Ctrl+Break (the only signal a
// detached/background executor can receive, since taskkill cannot deliver
// SIGTERM to console apps) killed the process immediately (exit 0xC000013A)
// — running task processes were orphaned instead of being reaped by
// gracefulShutdown's killRunningTaskProcesses. No-op on POSIX.
process.on('SIGBREAK', () => gracefulShutdown('SIGBREAK'));

// W-25 (windows-findings): last-line-of-defence parity with admin-api's
// OPS-06/ARCH-008. Before this, ANY unexpected async error killed the process
// by default WITHOUT running gracefulShutdown — task process trees then
// outlived the executor as unmanaged orphans (the exact failure mode W-24
// just removed one instance of; this covers every future one). Route both
// through the same drain + tree-kill chain, then exit(1) so a supervisor
// restarts us. 45s cap = 30s task grace + slack; if it ever fires, the
// hard exit still happens.
function fatalShutdown(reason: string): void {
  logger.error(`FATAL (unhandled): ${reason} — graceful shutdown with exit(1)`);
  let done = false;
  const hardExit = setTimeout(() => {
    if (!done) {
      logger.error('Graceful shutdown stalled after fatal error — hard exiting');
      process.exit(1);
    }
  }, 45_000);
  hardExit.unref();
  gracefulShutdown(reason, 1)
    .catch(() => undefined)
    .finally(() => {
      done = true;
      process.exit(1);
    });
}
process.on('unhandledRejection', (reason) => {
  fatalShutdown(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});
process.on('uncaughtException', (err) => {
  fatalShutdown(`uncaughtException: ${err.stack ?? String(err)}`);
});

// E-25（DEEP_REVIEW 0ef3bbe）：默认绑定 127.0.0.1（BIND_ADDRESS 可覆盖为
// 0.0.0.0），避免裸机部署在 token 缺失时暴露公开 RCE 面。容器场景由
// compose 显式设 BIND_ADDRESS=0.0.0.0。
const server = app.listen(config.port, config.bindAddress, async () => {
  try {
    logger.info(`Executor started: ${config.appName} @ ${config.executorAddress}`);

    // Initialize admin clients for HA support.
    // config.adminApiUrls already applies the URL priority:
    // ADMIN_API_URLS > ADMIN_API_URL_INTERNAL > ADMIN_API_URL.
    initAdminClients(config.adminApiUrls);
    await checkAdminApiConnectivity();

    // N41: token 恢复钩子先于首次注册挂载——启动期 admin 不可达时，register
    // 失败后由后续成功的 fetchToken 自动补注册（maybeReRegister 自带去重）。
    setOnTokenAcquired(maybeReRegister);
    // FR-13/FR-14：解释器清单的心跳 provider 在**首次注册之前**接好——这样首个
    // register 与首个 heartbeat 上报的是同一份快照，不会出现"注册说池为空、
    // 心跳说有 3.9"的自相矛盾窗口（对照 python main.py 的同序接线）。
    registerInterpretersProvider(getInterpretersSnapshot);
    await registerExecutor();
    heartbeatInterval = startHeartbeat();
    // ARCH-32: pull 模式取件循环（与 push 模式互斥不冲突——push 由 admin
    // 入站 POST 驱动，pull 循环只拉取队列；两种来源共用 acceptExecution）。
    if (config.pullMode) {
      startPullLoop();
      logger.info('Pull dispatch mode enabled (EXECUTOR_PULL_MODE=true) — no inbound reachability required');
    }
    startCallbackThread();
    startLogCleanup(config.logRetentionDays || 7);
    // Disk reclamation for task workdirs / git caches / downloaded packages /
    // dead-letter callbacks — same retention policy as the logs (7 days).
    startWorkDirCleanup(config.logRetentionDays || 7);

    // Fail loudly on a misconfiguration that would silently open an
    // unauthenticated /api/execute endpoint (dev mode passthrough).
    // E-25（DEEP_REVIEW 0ef3bbe）：默认绑定 127.0.0.1 降低暴露面；
    // 若显式绑定 0.0.0.0 且无 token，警告升级。
    if (!config.token) {
      const bindWarning = config.bindAddress === '0.0.0.0'
        ? 'WARNING: binding on 0.0.0.0 with no token configured — /api/* is PUBLICLY accessible! '
        : '';
      logger.warn(
        `${bindWarning}No EXECUTOR_SHARED_TOKEN / EXECUTOR_SECRET configured — /api/* accepts UNAUTHENTICATED requests. ` +
          'Set REQUIRE_TOKEN=true to refuse unauthenticated task submissions instead.',
      );
    }
  } catch (err: unknown) {
    // An async callback rejection here would be unhandled — exit loudly
    // instead so the supervisor restarts the executor.
    logger.error(`Startup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
});
