import { Router, Request, Response } from 'express';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { config } from '../config';
import { logger, runWithTrace } from '../logger';
import {
  getRunningCountArray,
  registerRunningExecutionIdsProvider,
  registerDeadLetterCountProvider,
} from '../scheduler';
import { loadManifest, mergeTaskWithManifest } from '../manifest';
import { pushCallback, CallbackFailureReason } from '../callback';
import { gatherArtifacts, artifactsDirFor, ArtifactManifestEntry } from '../artifacts';
import { getCurrentToken } from '../middleware/auth';
import { getCurrentAdminUrl } from '../admin-client';
import { resolveAdminApiBaseUrl } from '../admin-api-url';
import { appendLog, getDeadLetterCount, registerActiveWorkdirProvider, diskUsagePercent, DISK_CRITICAL_PERCENT } from '../file-logger';
import { taskWorkerManager, ExecutionCancelledError } from '../task-worker';
import { runCommand, killProcessTree } from '../run-command';
import { buildChildEnv } from '../env-whitelist';
// L-3：任务子进程 POSIX ulimit（NOFILE/CPU）——node 无 preexec_fn，生产路径
// 包一层 sh+ulimit；win32 原样返回。
import { applyTaskRlimits } from '../process-rlimits';
// 4-2（audit-r4）：任务进程内存看门狗（RSS 采样，node 侧无 RLIMIT 等价物）。
import {
  startMemoryWatchdog,
  winTasklistSampler,
  linuxProcTreeSampler,
} from '../memory-watchdog';
// A3-C：协议闸门（由 packages/executor-protocol/protocol.json 生成，勿手改产物）
import {
  ExecuteRequestSchema,
  KillResponseSchema,
} from '../generated/protocol.schemas';
import {
  createExecutionCallbackToken,
  CALLBACK_TOKEN_GRACE_SECONDS,
} from '../execution-callback-token';
// WS5（python_task_upload_and_multiversion）：解释器池 + zip 整包渠道。
import {
  InterpreterUnavailableError,
  ensureVersion,
  normalizeRuntimeVersion,
  poolSummary,
  resolveUvBin,
} from '../interpreters';
import { ZipSafetyError, safeExtractZip } from '../zip-safety';
import { downloadFile } from '../lib/download';

/** Convert git URL to a safe cache directory name */
function repoDirName(repoUrl: string): string {
  const base = repoUrl.replace(/\/$/, '').split('/').pop() ?? 'repo';
  const cleaned = base.replace(/\.git$/, '').replace(/[^a-zA-Z0-9_.-]/g, '_');
  // Salt with a URL hash — sanitization alone maps distinct repos like
  // a/b and a_b onto the same cache directory (cross-repo contamination).
  const hash = crypto.createHash('sha256').update(repoUrl).digest('hex').slice(0, 12);
  return `${cleaned}-${hash}`;
}

/** Strip embedded credentials (user:token@) before a URL reaches the logs. */
function redactUrl(u: string): string {
  return u.replace(/\/\/[^/@]+@/, '//***@');
}

/**
 * E-26（DEEP_REVIEW 0ef3bbe）：cmd.exe 下的参数引号。
 *
 * `runCommand` 在 win32 用 `spawn(cmd, args, { shell: true })`，Node 会把
 * argv 按 `join(' ')` 拼成一条命令行交给 cmd.exe——**不会**替参数加引号。
 * 于是 `--prefix C:\My Tasks\nm` 被拆成两个 token：npm 读到 `--prefix C:\My`
 * 并把 `Tasks\nm` 当成要安装的包名（安装错位，任务随后 MODULE_NOT_FOUND）。
 *
 * 只在 win32 且参数含空白/shell 元字符时用双引号包裹（cmd.exe 会还原成一个
 * token）；POSIX 侧 shell:false，参数原样传给 execve，加引号反而会变成路径的
 * 一部分。平台作为参数传入以便单测覆盖两种形态。
 */
export function quoteShellArgForPlatform(
  arg: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return arg;
  return /[\s"&^|<>()]/.test(arg) ? `"${arg}"` : arg;
}

const gitCacheQueues = new Map<string, Promise<unknown>>();

/** Serialize first-time clones per repo — concurrent executions of the same
 *  repo would race `git clone --bare` into the same cache directory and the
 *  losing side fails the whole execution (npm installs already queue via
 *  queueTaskInstall; git had no equivalent). */
function queueGitCheckout<T>(cacheKey: string, job: () => Promise<T>): Promise<T> {
  const prev = gitCacheQueues.get(cacheKey) ?? Promise.resolve();
  const run = prev.then(job, job);
  const tail = run.then(() => undefined, () => undefined);
  gitCacheQueues.set(cacheKey, tail);
  tail.finally(() => {
    if (gitCacheQueues.get(cacheKey) === tail) gitCacheQueues.delete(cacheKey);
  });
  return run;
}

/** Clone (with bare cache) and checkout the specified ref to dest directory */
/** W-23 (windows-findings, parity with executor-python): the clone cache was
 *  probed by `exists(HEAD)` only — a directory left half-written by a killed
 *  clone (taskkill /F mid-clone) then either failed `git clone` forever
 *  ("destination exists") or, worse on the python side, was treated as warm
 *  cache and failed `fetch` forever. Validate with git itself and quarantine
 *  (rename, not delete — forensics + Windows may still see file locks) so the
 *  next checkout self-heals by re-cloning. */
async function isBareGitRepo(cacheDir: string): Promise<boolean> {
  if (!fs.existsSync(path.join(cacheDir, 'HEAD'))) return false;
  const probe = await runCommand('git', ['-C', cacheDir, 'rev-parse', '--is-bare-repository'], { timeout: 15_000 });
  return probe.status === 0 && probe.stdout.trim() === 'true';
}

function quarantineBrokenCache(cacheDir: string): void {
  const broken = `${cacheDir}-broken-${Date.now()}`;
  try {
    fs.renameSync(cacheDir, broken);
  } catch (err) {
    logger.warn(`[git] could not quarantine cache dir ${cacheDir} (${err instanceof Error ? err.message : String(err)}); removing`);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

/**
 * Clone/fetch/checkout the specified ref to dest directory.
 * `signal` lets the execution kill endpoint abort a prepare-phase checkout
 * (改动2): the in-flight git process tree is hard-killed and the queued job
 * chain rejects with ExecutionCancelledError.
 */
export async function gitCheckoutTo(
  repoUrl: string,
  ref: string,
  dest: string,
  signal?: AbortSignal,
): Promise<void> {
  const cacheDir = path.join(config.workDir, '.git_cache', repoDirName(repoUrl));
  await queueGitCheckout(cacheDir, async () => {
    if (signal?.aborted) throw new ExecutionCancelledError(dest);
    if (fs.existsSync(cacheDir) && !(await isBareGitRepo(cacheDir))) {
      logger.warn(`[git] cache ${cacheDir} is not a valid bare repo (killed clone?) — quarantining and re-cloning`);
      quarantineBrokenCache(cacheDir);
    }
    if (!fs.existsSync(path.join(cacheDir, 'HEAD'))) {
      fs.mkdirSync(cacheDir, { recursive: true });
      const r = await runCommand('git', ['clone', '--bare', '--depth', '1', repoUrl, cacheDir], { timeout: 120_000, signal });
      if (signal?.aborted) throw new ExecutionCancelledError(dest);
      if (r.status !== 0) {
        fs.rmSync(cacheDir, { recursive: true, force: true });
        throw new Error(`git clone failed: ${r.stderr.trim()}`);
      }
    } else {
      const r = await runCommand('git', ['-C', cacheDir, 'fetch', '--all', '--unshallow'], { timeout: 60_000, signal });
      if (signal?.aborted) throw new ExecutionCancelledError(dest);
      if (r.status !== 0) {
        // Continuing with a stale cache made tasks silently run old code.
        throw new Error(`git fetch failed: ${r.stderr.trim()}`);
      }
    }
    fs.mkdirSync(dest, { recursive: true });
    const r = await runCommand(
      'git',
      [`--git-dir=${cacheDir}`, `--work-tree=${dest}`, 'checkout', ref, '--', '.'],
      { timeout: 30_000, signal },
    );
    if (signal?.aborted) throw new ExecutionCancelledError(dest);
    if (r.status !== 0) throw new Error(`git checkout failed: ${r.stderr.trim()}`);
  });
}

const taskInstallQueues = new Map<string, Promise<unknown>>();

/** Serialize dependency installs per task id — concurrent requests for the
 *  same task would race on the shared .node_modules/<taskId> directory.
 *  A rejected job propagates the rejection to every chained follower (改动2:
 *  a kill-aborted install must reach ALL queued executions, not just the
 *  first one — each of their git/npm processes has already been hard-killed
 *  via its own abort signal, so they must not proceed as if the install
 *  succeeded). An aborted follower converts the shared rejection into an
 *  ExecutionCancelledError so the ownership chain (worker skip, no double
 *  release) kicks in. */
function queueTaskInstall<T>(taskId: string, job: () => Promise<T>, isAborted: () => boolean): Promise<T> {
  const prev = taskInstallQueues.get(taskId) ?? Promise.resolve();
  const run = prev.then(job, job);
  const tail = run.then(() => undefined, () => undefined);
  taskInstallQueues.set(taskId, tail);
  tail.finally(() => {
    if (taskInstallQueues.get(taskId) === tail) taskInstallQueues.delete(taskId);
  });
  return run.catch((err) => {
    if (isAborted()) throw new ExecutionCancelledError(taskId);
    throw err;
  });
}

export const executeRouter = Router();

export interface ExecuteRequest {
  executionId: string;
  task: {
    id?: string;
    name?: string;
    runtime?: string;
    entrypoint?: string;
    timeout?: number;
    requirements?: string[];
    gitRepo?: string;
    gitCommit?: string;
    gitBranch?: string;
    [key: string]: unknown;
  };
  params?: Record<string, unknown>;
}

/** executionId 会被用作 workDir 下的目录名——限定安全字符集，杜绝路径穿越
 *  （S6/Q11 的字符级前置，深度解析检查见 validateExecutionWorkDir）。 */
// A3（executor-protocol）：导出以便 spec 与 protocol.json 的
// ExecuteRequest.executionId pattern 做**逐字符**一致性断言——两处正则各改一处
// 就会让「协议说的」与「执行器实际拦的」分叉（正是本契约要消灭的漂移）。
export function isSafeExecutionIdSegment(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
}

/** S6/Q11 + SEC-04: path traversal / symlink guard for workDir.
 *  Returns an error message, or null when the directory is safe to use.
 *  Shared by POST /execute (request + background) and the /config/reload
 *  workDir validation (routes/config.ts) so the rules never drift apart. */
export function validateExecutionWorkDir(workDir: string, baseDir: string): string | null {
  const resolvedWorkDir = path.resolve(workDir);
  const resolvedBase = path.resolve(baseDir);
  if (!resolvedWorkDir.startsWith(resolvedBase + path.sep) && resolvedWorkDir !== resolvedBase) {
    return 'Invalid executionId: path traversal detected';
  }
  // SEC-04: Check for symbolic link attacks
  try {
    // Check if the base directory exists and is not a symlink
    const baseStats = fs.lstatSync(resolvedBase);
    if (baseStats.isSymbolicLink()) {
      return 'Base work directory cannot be a symbolic link';
    }

    // If workDir already exists, check if it's a symlink
    if (fs.existsSync(resolvedWorkDir)) {
      const workDirStats = fs.lstatSync(resolvedWorkDir);
      if (workDirStats.isSymbolicLink()) {
        return 'Work directory cannot be a symbolic link';
      }

      // Check the real path to prevent symlink escape
      const realWorkDir = fs.realpathSync(resolvedWorkDir);
      const realBase = fs.realpathSync(resolvedBase);
      if (!realWorkDir.startsWith(realBase + path.sep) && realWorkDir !== realBase) {
        return 'Symbolic link escape detected';
      }
    }
  } catch (err) {
    return `Path validation failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
  }
  return null;
}

/**
 * Live executions on this executor, keyed by executionId — the kill endpoint
 * (改动1) finds the process / prepare-stage state here, and the release path
 * carries an idempotent capacity slot so kill + natural completion can never
 * double-release.
 */
interface ExecutionEntry {
  executionId: string;
  taskId: string;
  aborted: boolean;
  abortController: AbortController;
  /** kill 端点已下达终止指令（runTask 失败回调据此标记 failureReason=killed） */
  killedByRequest: boolean;
  /** killed 失败回调已推送（kill 端点与 runPrepared 取消分支共用防双推；
   *  pushCallback 本身也按 executionId 去重覆盖，这里是双保险）。 */
  killedCallbackPushed: boolean;
  /** 已移交 worker 排队/执行：收尾责任归 worker 的 onComplete，除非取消发生在启动前 */
  enqueued: boolean;
  /** kill 端点在移交后取消本执行（worker 排队项被摘除）：onComplete 不会再被
   *  触发，runPrepared/在跑流程据此静默退出，绝不双释放。 */
  cancelled: boolean;
  /** worker 的 onComplete（含停机失败路径）已执行，容量已随之释放 */
  workerFinished: boolean;
  capacityReleased: boolean;
  /** OBS-01: dispatch 请求的 W3C traceparent 头（admin OTEL_ENABLED=false 时缺省） */
  traceparent?: string;
  /**
   * WS5：本执行实际使用的 `.venvs` 目录名（`<taskId>` / `<taskId>-<X.Y>`），
   * 由 `venvDirName` 在 prepare 时写入。cleanupWorkDir 的活跃保护集直接读它，
   * 从而与目录名同源——清扫侧绝不自行反推版本签名（见 file-logger
   * `ActiveWorkdirSet.venvDirNames` 注释）。
   */
  venvDirName?: string;
  release(): void;
}

const liveExecutions = new Map<string, ExecutionEntry>();

/** 推送（且只推一次）killed 失败回调。容量释放不在这里——所有权见各调用方
 *  注释：未开始路径 kill 端点释放；prepare/运行中被取消路径 worker 的
 *  onComplete 释放。 */
function pushKilledCallbackOnce(executionId: string, entry: ExecutionEntry): void {
  if (entry.killedCallbackPushed) return;
  entry.killedCallbackPushed = true;
  appendLog(executionId, 'Execution killed by admin request');
  writeExecMeta(executionId, {
    status: 'failed',
    endTime: Date.now(),
    errorMessage: 'Killed by admin request',
  });
  pushCallback({
    executionId,
    status: 'failed',
    errorMessage: 'Execution killed by admin request',
    failureReason: 'killed',
    ...(liveExecutions.get(executionId)?.traceparent
      ? { traceparent: liveExecutions.get(executionId)!.traceparent }
      : {}),
  });
}

function createExecutionEntry(executionId: string, taskId: string): ExecutionEntry {
  const entry: ExecutionEntry = {
    executionId,
    taskId,
    aborted: false,
    abortController: new AbortController(),
    killedByRequest: false,
    killedCallbackPushed: false,
    enqueued: false,
    cancelled: false,
    workerFinished: false,
    capacityReleased: false,
    release: () => {
      if (entry.capacityReleased) return; // 幂等：kill 与自然完成竞争时只减一次
      entry.capacityReleased = true;
      Atomics.sub(getRunningCountArray(), 0, 1);
      liveExecutions.delete(entry.executionId);
    },
  };
  return entry;
}

/** execution 是否在本执行器的运行表中（/execute 重复领取检查用，测试导出）。 */
export function executionExists(executionId: string): boolean {
  return liveExecutions.has(executionId);
}

/** 当前运行表中所有 executionId（/config/reload 的 workDir 切换安全检查用）。 */
export function listActiveExecutionIds(): string[] {
  return [...liveExecutions.keys()];
}

/** E-08: 当前运行表中所有 taskId（cleanupWorkDir 保护活跃 .node_modules/
 *  .git_cache 分片用——对照 python maintenance._live_workdir_names）。 */
export function listActiveTaskIds(): string[] {
  return [...new Set([...liveExecutions.values()].map((e) => e.taskId))];
}

/** WS5: 当前运行表中活跃的 `.venvs` 目录名（含版本签名），供 cleanupWorkDir
 *  保护活跃任务的 venv 不被 TTL 清扫（对照 python maintenance 的 live 保护）。 */
export function listActiveVenvDirNames(): string[] {
  return [
    ...new Set(
      [...liveExecutions.values()]
        .map((e) => e.venvDirName)
        .filter((n): n is string => typeof n === 'string' && n.length > 0),
    ),
  ];
}

// STALE-01: 心跳上报本机运行中的 executionId 与死信积压。scheduler 不能反向
// import routes（会成环），故由数据属主在此注册 provider。
registerRunningExecutionIdsProvider(listActiveExecutionIds);
registerDeadLetterCountProvider(getDeadLetterCount);
// E-08: 注册活跃工作目录快照，cleanupWorkDir 据此跳过活跃 execution 目录及其
// .node_modules/.git_cache 分片（liveness 未知时 provider 抛错 → 删 Nothing）。
registerActiveWorkdirProvider(() => ({
  executionIds: new Set(listActiveExecutionIds()),
  taskIds: new Set(listActiveTaskIds()),
  venvDirNames: new Set(listActiveVenvDirNames()),
}));

// ---------------------------------------------------------------------------
// POST /execute — 只做参数校验 + 并发预检 + 登记，prepare/spawn 全部进入
// 后台（改动2）。同步 prepare 时 clone(120s)+fetch(60s)+install(300s) 会
// 超过 admin 侧 dispatch HTTP 超时（(task.timeout+10)s），导致 admin 把
// 超时误判为 TIMEOUT 终态而执行器随后成功回调被丢弃、容量计数失真。
//
// ARCH-32: 校验/领取核心抽为 acceptExecution —— HTTP 路由与 pull 循环
// （pull.ts，NAT 内执行器经长轮询取件）共用同一条路径，杜绝双实现漂移。
// 返回 { status, payload }；HTTP 路由是薄适配层（写响应），pull 循环对
// 非 200 结果补发 failed 回调（admin 侧不留僵尸 RUNNING 行）。
// E-01（P1）pull 容量竞态：opts.slotPreReserved=true 表示调用方（pull 循环）
// 已在发起长轮询【之前】于同一并发账本原子预留了一个槽位——预留即正式
// 占用，本函数在该模式下绝不触碰计数（成功路径的 entry.release() 在完成
// 时归还的正是那一个预留槽位；同步拒绝路径由调用方统一释放预留）。
// ---------------------------------------------------------------------------
export interface AcceptExecutionOptions {
  /**
   * E-01: 槽位已由 pull 循环预先原子预留（同一 SharedArrayBuffer 账本）。
   * true 时跳过「add + 容量检查」（重复 add 会凭空吞掉一个槽位），仅保留
   * 防御性复查：账本被异常推高到超过上限（竞态残余/外部计数污染）时仍以
   * 429 拒绝，让 pull 循环走「释放预留 + 不回调 failed」的防御分支。正常
   * 路径预留后 count ≤ max，该检查必然通过。
   */
  slotPreReserved?: boolean;
}

export function acceptExecution(
  body: ExecuteRequest,
  traceparent?: string,
  opts?: AcceptExecutionOptions,
): { status: number; payload: Record<string, unknown> } {
  const slotPreReserved = opts?.slotPreReserved === true;
  if (slotPreReserved) {
    // E-01 预留模式（见 AcceptExecutionOptions）：不再 add——调用方已占位。
    if (Atomics.load(getRunningCountArray(), 0) > config.maxConcurrentTasks) {
      return { status: 429, payload: { error: 'Executor is at capacity' } };
    }
  } else {
    // BUG-03: Use atomic operations to prevent race conditions in capacity checking
    // Atomically increment counter first, then check if over capacity
    const current = Atomics.add(getRunningCountArray(), 0, 1);
    if (current >= config.maxConcurrentTasks) {
      Atomics.sub(getRunningCountArray(), 0, 1);
      return { status: 429, payload: { error: 'Executor is at capacity' } };
    }
  }

  let entry: ExecutionEntry | null = null;
  /** 同步拒绝路径：释放容量（幂等）。 */
  const reject = (status: number, error: string) => {
    if (slotPreReserved) {
      // E-01 预留模式：槽位所有权始终在调用方（pull 循环对任何非 200 统一
      // 释放预留），这里绝不 decrement；只回收已登记的条目防僵尸 RUNNING
      // 表——置 capacityReleased 后条目的 release() 变 no-op，绝无双减。
      if (entry) {
        entry.capacityReleased = true;
        liveExecutions.delete(entry.executionId);
      }
    } else if (entry) {
      entry.release();
    } else {
      Atomics.sub(getRunningCountArray(), 0, 1);
    }
    return { status, payload: { error } };
  };

  try {
    // P2：磁盘临界水位——磁盘满时任何任务都会在写 workdir/log 阶段失败，
    // 提前拒绝新任务比让任务在准备阶段失败更诚实。statfs 是同步的，accept
    // 本来就是同步快路径；计量失败（返回 0）按无压力放行。
    if (diskUsagePercent() >= DISK_CRITICAL_PERCENT) {
      return reject(503, 'Executor disk is critically full; new tasks are refused');
    }

    const executionId = body?.executionId;
    const params = body?.params;

    if (!executionId || !body.task) {
      return reject(400, 'executionId and task are required');
    }
    // A3-C：executionId 必须是字符串。非字符串（JSON number 等）此前能穿过上面
    // 的真值判断与 isSafeExecutionIdSegment（RegExp.test 会做隐式类型转换），
    // 然后在 `path.join(workDir, executionId)` 抛 TypeError → 被外层 catch 兜成
    // **500**。畸形输入该是 400——协议里 executionId 本就是 string，这里与下面
    // 的协议闸门同向，只是先给一条比 schema 文案更具体的错误。
    if (typeof executionId !== 'string') {
      return reject(400, 'executionId must be a string');
    }
    if (!isSafeExecutionIdSegment(executionId)) {
      return reject(400, 'Invalid executionId: path traversal detected');
    }
    // 重复领取守卫：同一 execution 仍在运行（含排队）时不得二次领取——
    // 二次 Atomics.add 与首个并发路径叠加会失真/双释放。
    if (liveExecutions.has(executionId)) {
      return reject(400, `Execution ${executionId} is already active on this executor`);
    }

    const workDir = path.join(config.workDir, executionId);
    const guardError = validateExecutionWorkDir(workDir, config.workDir);
    if (guardError) {
      return reject(400, guardError);
    }

    // 廉价同步校验（纯字符串检查，防注入/防误配置，语义与原实现一致）：
    // 后台化后若仍走失败回调，admin 侧 execution 尚未置 running 会丢弃回调，
    // 留下永久僵尸行——必须保持同步 4xx。
    const gitRepo = body.task.gitRepo;
    if (gitRepo) {
      // S7: SSRF guard — only allow http(s) and ssh git URLs; reject file:// and others
      const allowedGitPattern = /^(https?:\/\/|git@|ssh:\/\/)/i;
      if (!allowedGitPattern.test(gitRepo)) {
        return reject(400, `gitRepo URL scheme not allowed: ${gitRepo}`);
      }
      // S7: SSRF guard — block private IP addresses and localhost
      const privateIpPattern = /(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.1[6-9]\.\d{1,3}\.\d{1,3}|172\.2[0-9]\.\d{1,3}\.\d{1,3}|172\.3[0-1]\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3})/i;
      if (privateIpPattern.test(gitRepo)) {
        return reject(400, `gitRepo URL contains restricted address: ${gitRepo}`);
      }
      const ref = (body.task.gitCommit || body.task.gitBranch || 'main') as string;
      // git checkout uses array args (no shell injection), but an option-like
      // ref (`-b`, `--orphan`) would still be parsed as a flag by git — same
      // guard deploy.ts applies to its checkout path.
      if (/^-/.test(ref)) {
        return reject(400, `Invalid git ref: ${ref}`);
      }
    }
    // S16: validate each package name against npm naming rules before any
    // shell expansion (install itself now runs in the background).
    // E-19: requirements 类型守卫——上游 DTO 演进误传字符串会让下方
    // `for (const pkg of reqs)` 逐字符当包名迭代（python _validate_requirements
    // 同源问题）。同步 400 拒绝，与 python accept_execution 入口并列；缺省（undefined/
    // null）仍当空数组，向后兼容。
    if (body.task.requirements !== undefined && body.task.requirements !== null
        && !Array.isArray(body.task.requirements)) {
      return reject(400, 'requirements must be an array of package names');
    }
    const reqs: string[] = Array.isArray(body.task.requirements)
      ? (body.task.requirements as string[])
      : [];
    // S16 + 对等修复：校验规则**必须按 runtime 分流**。
    //
    // 此前无论 runtime 一律套 npm 命名正则，于是 python 任务的全部 pip 形态
    // 依赖都被 400 —— 包括 admin 自己 DTO 里写明的示例 `requests>=2.31`：
    //   `requests>=2.31` / `rich==13.7.1` / `requests[socks]==2.31` / `flask~=3.0`
    //   / `zope.interface>=5` / 带 marker 的 `requests ; python_version<"3.8"`
    // 全部 REJECT。后果是同一个 python 任务在 executor-python 上正常、在
    // executor-node 上必然失败——正是 CONTRACT §3.3 要求「全对等」的那条路径。
    //
    // 反向同样危险：npm 正则**接受** `-r` / `--index-url` 这类单 token 选项
    // （每个元素各自都能匹配），而它们会被原样 push 进 `uv pip install` argv
    // （见下方 installArgs），等于允许用 `--index-url pypi.evil.com` 劫持包索引
    // ——python 侧 `_validate_requirements` 明确把 leading-'-' 当作唯一注入向量。
    //
    // 故按 runtime 分别套用两侧既有的判据：python 用 python 的规则，node 用 npm 的。
    const runtime = (body.task.runtime as string | undefined) || 'node';
    const npmNameRe = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[\w.^~-]+)?$/i;
    for (const pkg of reqs) {
      const invalid =
        runtime === 'python'
          ? typeof pkg !== 'string' || !pkg.trim() || pkg.trim().startsWith('-')
          : !npmNameRe.test(pkg);
      if (invalid) {
        return reject(
          400,
          runtime === 'python'
            ? `Invalid requirement (options are not allowed): ${pkg}`
            : `Invalid npm package name: ${pkg}`,
        );
      }
    }
    // timeout=0 表示不限时（admin 侧 task.entity/scheduler 语义，改动4）——
    // 仅 null/undefined 才回退默认值；越界与非数值保持原 400 语义。
    const rawTimeout = body.task.timeout;
    const timeout = rawTimeout === 0 ? 0 : (rawTimeout as number) || config.taskTimeoutSeconds;
    if (timeout !== 0 && (!Number.isFinite(timeout) || timeout < 1 || timeout > 86_400)) {
      return reject(400, `Invalid task timeout: ${timeout} (expected 0 (unbounded) or 1..86400 seconds)`);
    }
    // Glue 语言的字符串校验是同步 400 语义（与原实现一致），语言支持性判定
    // 依赖 runtime（可能被 manifest 覆盖），留在后台 prepare。
    const glueSource = (body.task.glueSource as string | undefined) || (body.task.glue_source as string | undefined);
    if (glueSource !== undefined && typeof glueSource !== 'string') {
      return reject(400, 'glueSource must be a string');
    }
    // A3-C：协议闸门——形状约束由 `packages/executor-protocol/protocol.json`
    // 生成（zod 侧），与 executor-python 共用同一份。放在上述手检**之后**：
    // 手检的 400 文案更具体且已被既有用例钉住，闸门兜的是它们没覆盖的部分
    // （params/executionId 的类型、task 各字段类型、timeoutSeconds 边界等），
    // 以及「以后往协议里加约束即自动生效」——契约不再依赖某个人记得补手检。
    const parsed = ExecuteRequestSchema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const where = first.path.length ? first.path.join('.') : '(root)';
      return reject(400, `Invalid execute request: ${where}: ${first.message}`);
    }

    // 登记 + 立即 accepted。prepare（clone/checkout、依赖安装）与 spawn
    // 在后台执行（经 worker 按 taskId 串行，见 dispatch）。
    entry = createExecutionEntry(executionId, String(body.task.id || executionId));
    liveExecutions.set(executionId, entry);
    // OBS-01: 记录派发载荷的 W3C traceparent（HTTP 路由取请求头、pull 路径
    // 取载荷字段；缺省=无追踪），后续注入任务 env AUTOFLOW_TRACE_ID 并随回
    // 调回传关联。
    if (traceparent) {
      entry.traceparent = traceparent;
      logger.info(`Execution ${executionId} trace: ${traceparent.split('-')[1] ?? 'malformed'}`);
    }

    void startExecutionInBackground(executionId, body, params, entry);

    // 响应体与旧实现逐字一致——admin 对 2xx 的处理不变。
    return { status: 200, payload: { status: 'accepted', executionId } };
  } catch (err) {
    // 同步 throw（容量预留之后）不得泄漏槽位——reject 内部幂等释放。
    return reject(500, err instanceof Error ? err.message : 'Internal executor error');
  }
}

executeRouter.post('/execute', (req: Request, res: Response) => {
  const body = req.body as ExecuteRequest;
  const tpHeader = req.headers['traceparent'];
  const result = acceptExecution(
    body,
    typeof tpHeader === 'string' ? tpHeader : undefined,
  );
  res.status(result.status).json(result.payload);
});

/**
 * 后台启动：先做与 worker 无关的前置（mkdir/chmod + 二次 symlink 检查），
 * 然后移交 worker——同一 taskId 的 worker 轮到本执行时才运行 prepare 与
 * spawn（保持原有同任务串行语义），失败回调走现有 pushCallback 通道。
 */
async function startExecutionInBackground(
  executionId: string,
  body: ExecuteRequest,
  params: Record<string, unknown> | undefined,
  entry: ExecutionEntry,
): Promise<void> {
  const failStart = (message: string, failureReason: CallbackFailureReason, logs?: string) => {
    appendLog(executionId, `[prepare] ${message}`);
    writeExecMeta(executionId, {
      executionId,
      status: 'failed',
      endTime: Date.now(),
      errorMessage: message,
    });
    pushCallback({
      executionId,
      status: 'failed',
      errorMessage: truncateCallbackErrorMessage(message),
      failureReason,
      logs: truncateCallbackLogs(logs),
      ...(entry.traceparent ? { traceparent: entry.traceparent } : {}),
    });
    entry.release(); // 幂等
  };

  try {
    if (entry.aborted) {
      // kill 在移交前到达：后台流程不启动，收尾由 kill 端点负责。
      return;
    }
    const workDir = path.join(config.workDir, executionId);
    fs.mkdirSync(workDir, { recursive: true });
    // S6/Q11: restrict permissions so sibling tasks cannot read this directory
    try { fs.chmodSync(workDir, 0o700); } catch (_) { /* ignore on unsupported filesystems */ }
    // symlink 检查在 mkdir 之前无法覆盖"dirent 恰在检查与 mkdir 之间被替换"
    // 的 TOCTOU 窗口，这里在真正使用前复查一次。
    const guardError = validateExecutionWorkDir(workDir, config.workDir);
    if (guardError) {
      failStart(guardError, 'unknown');
      return;
    }
    await dispatchExecutionToWorker(executionId, body, params, workDir, entry);
  } catch (err) {
    failStart(err instanceof Error ? err.message : 'Executor background start failed', 'unknown');
  }
}

/** prepare 失败信息的 failureReason 归类（对齐 admin ExecutionFailureReason）：
 *  BUG-10 细化——git 拉取 / 依赖安装 / 运行时缺失拆分为独立分类，便于
 *  统计与告警；未命中细分的获取类错误保持 package_fetch_failed 兜底。
 *  导出供测试固化该映射。
 *
 *  WS5（python_task_upload_and_multiversion, CONTRACT.md §3.3-5）：解释器规则
 *  **必须排在 dependency 规则之前**，理由是三条既有规则的正则都很宽：
 *    - uv 对缺失解释器的原文是 `No interpreter found for Python 3.7 in managed
 *      installations, search path, or registry`，对不可下载版本是
 *      `No download found for request: cpython-3.7-<platform>`；我们把
 *      `uv venv` 的失败包装成 `uv venv failed: ...`，一旦先跑 dependency 规则
 *      就会被 `uv pip install failed|...` 家族误吞；
 *    - `No such file or directory`（runtime_missing 规则）也是 `uv venv --python
 *      <失效路径>` 的真实报错形态，会把它错判成 runtime_missing。
 *  两者都是"环境缺东西"，但处置完全不同（装运行时二进制 vs 预填/下载解释器
 *  缓存池），绝不能混为一类。 */
export function prepareFailureReason(message: string): CallbackFailureReason {
  // WS5：解释器无法获取——必须最先判定（见上方注释）。
  if (
    /interpreter \d+\.\d+ unavailable|No interpreter found|No download found|Python downloads are set to ['"]?manual|解释器.*无法获取/i.test(
      message,
    )
  ) {
    return 'interpreter_unavailable';
  }
  // git clone/fetch/checkout 或 CalledProcessError 形态（node 侧 git 也是子进程）
  if (/git (clone|fetch|checkout) failed|\bgit\b.*returned non-zero|\bgit\b.*\b(clone|fetch|checkout)\b.*fail/i.test(message)) {
    return 'git_fetch_failed';
  }
  if (/npm install failed|uv pip install failed|pip install failed|Dependency installation failed/i.test(message)) {
    return 'dependency_install_failed';
  }
  if (/spawn .*ENOENT|runtime .*not (supported|available)|executable .*not found|No such file or directory/i.test(message)) {
    return 'runtime_missing';
  }
  if (/Invalid npm package name/i.test(message)) {
    return 'package_fetch_failed';
  }
  // WS5：zip 整包渠道的获取类失败（缺 packageUrl / 下载失败 / 归档被安全闸
  // 拒绝）归入既有的 package_fetch_failed 兜底桶——它们都是"包没拿到"，
  // 复用既有分类，不为它们新增枚举值。
  if (/packageUrl|Package download failed|Unsafe or invalid package archive/i.test(message)) {
    return 'package_fetch_failed';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// WS5（python_task_upload_and_multiversion）—— python 多版本 / 整包渠道辅助
// ---------------------------------------------------------------------------

/** 包内 requirements.txt 的解析上限（D4/AC-04c）。超限即**忽略**而不是截断：
 *  一个 1MB 的 requirements.txt 只可能是恶意/损坏输入，截断会静默改变依赖集。 */
const PACKAGE_REQUIREMENTS_MAX_BYTES = 1024 * 1024;

/** zip 整包下载预算（与 python 侧 ZIP_DOWNLOAD_TIMEOUT_SECONDS 对齐）。 */
const ZIP_DOWNLOAD_TIMEOUT_MS = 120_000;

/** `uv venv` / `uv pip install` 的独立预算。 */
const UV_VENV_TIMEOUT_MS = 120_000;
const UV_PIP_TIMEOUT_MS = 300_000;

/**
 * 需求条目的归一化键（D4"同名覆盖"判定用）。
 *
 * 取包名（去掉 extras/环境标记/版本约束）并按 **PEP 503** 归一：小写 + 把
 * `-`/`_`/`.` 的连续串折叠成单个 `-`。于是 `Requests>=2`、
 * `requests[socks]==2.31`、`requests ; python_version<'3.8'`、`zope.interface`
 * 与 `zope-interface` 都被视为同一个包——任务级条目据此覆盖包内条目。
 * 解析不出来时返回整串，保证不同条目永远不会因为解析失败而被误判成同名。
 *
 * 与 python 侧 `_requirement_key` 逐字对齐（两个执行器必须同判）。
 */
function requirementKey(spec: string): string {
  const trimmed = spec.trim();
  const head = trimmed.split(/[<>=!~;[\s@]/, 1)[0].trim();
  if (!head) return trimmed;
  return head.replace(/[-_.]+/g, '-').toLowerCase();
}

/**
 * D4：包内 requirements.txt ∪ 任务级 requirements，**任务级同名覆盖**。
 *
 * 规则（AC-04a/b/c）：
 *   - 同名条目任务级胜出——uv 不会同时看到两个版本的约束；
 *   - 其余条目取并集，顺序稳定：先包内（保持文件顺序），再任务级的新增项；
 *   - 输入顺序即输出顺序，同一输入永远产出同一结果（可重复执行）。
 *
 * 实现用 `Map` 保序去重（对应 python 侧 `dict` 保序）：后写入的同名键覆盖值
 * 但**不改动首次插入的位置**，于是"包内顺序优先、任务级新增项追加"自然成立。
 * 这与 `manifest.mergeTaskWithManifest` 的 `dict.fromkeys` 先例同源。
 *
 * 导出为纯函数以便单测直接固化 D4 规则（不经过整条 prepare 链路）。
 */
export function mergeRequirements(
  packageReqs: readonly string[] | undefined,
  taskReqs: readonly string[] | undefined,
): string[] {
  const merged = new Map<string, string>();
  for (const spec of packageReqs ?? []) {
    if (typeof spec === 'string' && spec.trim()) merged.set(requirementKey(spec), spec.trim());
  }
  for (const spec of taskReqs ?? []) {
    if (typeof spec === 'string' && spec.trim()) merged.set(requirementKey(spec), spec.trim());
  }
  return [...merged.values()];
}

/**
 * 把包内 requirements.txt 文本解析为需求规格列表（去噪，不做语义解析）。
 *
 * 只做三件事：去注释（`#`，含行内）、去空白、丢弃 pip **选项行**与其它不可
 * 解析的结构（`[extras]` 段头、裸 URL/路径）。
 *
 * 刻意**不**实现 `-r other.txt` 的递归展开：那会让包内文本决定执行器去读哪个
 * 文件，是不必要的攻击面。`-` 开头的行会被 uv 当**选项**解析（索引劫持向量），
 * 因此绝不透传——这与任务级 requirements 的既有校验同一条纪律，只是包内文件
 * 是数据而非任务参数，静默跳过 + 日志比让整次执行失败更合适。
 */
export function parsePackageRequirements(text: string): string[] {
  const specs: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#', 1)[0].trim();
    if (!line) continue;
    if (line.startsWith('-')) {
      logger.info(`Skipping option line in package requirements.txt: ${line}`);
      continue;
    }
    if (line.startsWith('[') && line.endsWith(']')) continue; // pip 配置段头
    if (/^(https?:\/\/|file:\/\/|\/|\.|~)/.test(line)) {
      logger.info(`Skipping non-spec line in package requirements.txt: ${line}`);
      continue;
    }
    specs.push(line);
  }
  return specs;
}

/**
 * 读取包内 requirements.txt（不存在/超限/不可读 → 空列表 + 日志）。
 *
 * 大小写不敏感地扫描**工作目录顶层**（Windows 上 `Requirements.txt` 是合法
 * 文件名而 Linux 上不是；两侧都接受才能让同一个 zip 在任何宿主上行为一致）。
 */
export function readPackageRequirements(workDir: string): string[] {
  let candidate: string | null = null;
  try {
    for (const name of fs.readdirSync(workDir)) {
      if (name.toLowerCase() === 'requirements.txt') {
        const full = path.join(workDir, name);
        if (fs.statSync(full).isFile()) {
          candidate = full;
          break;
        }
      }
    }
  } catch (err) {
    logger.warn(
      `Cannot scan ${workDir} for requirements.txt: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  if (!candidate) return [];
  try {
    if (fs.statSync(candidate).size > PACKAGE_REQUIREMENTS_MAX_BYTES) {
      logger.warn(
        `Package requirements.txt ${candidate} exceeds ${PACKAGE_REQUIREMENTS_MAX_BYTES} bytes — ` +
          'ignored (install the dependencies via the task-level requirements instead)',
      );
      return [];
    }
    return parsePackageRequirements(fs.readFileSync(candidate, 'utf-8'));
  } catch (err) {
    logger.warn(
      `Failed to read package requirements.txt ${candidate}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/** venv 内解释器/可执行文件路径（win32 是 Scripts\python.exe，POSIX 是 bin/python3）。 */
export function venvPythonBin(venvDir: string): string {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python3');
}

/**
 * venv 目录键（D6/FR-16）。
 *
 * 无声明版本 → `<taskId>`，**逐字节不变**（AC-10a：存量任务的 venv 目录名零
 * 变化，既有缓存的 venv 照旧命中）。有声明版本 → `<taskId>-<X.Y>`，于是声明
 * 版本一变就不可能复用旧 venv（AC-16a）。
 *
 * **只有这一处**做版本派生：目录名与 TTL 清扫的 live 保护集必须同源，否则版本
 * 切换会退化成"保护 A、写 B、清扫 C"的漂移（DESIGN §1.2.2 的纪律）。
 */
export function venvDirName(taskId: string, runtimeVersion: string | null | undefined): string {
  return runtimeVersion ? `${taskId}-${runtimeVersion}` : taskId;
}

/** `pyvenv.cfg` 的 `home` / `version_info` 解析（纯文件系统，不 spawn 进程）。 */
function readPyvenvCfg(venvDir: string): Record<string, string> | null {
  try {
    const text = fs.readFileSync(path.join(venvDir, 'pyvenv.cfg'), 'utf-8');
    const cfg: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      const idx = line.indexOf('=');
      if (idx <= 0) continue;
      cfg[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    return cfg;
  } catch {
    return null;
  }
}

/** `recorded` 是否为 `requested` 的补丁版本（3.12.11 属于 3.12）。 */
function versionMatchesRequested(recorded: string, requested: string): boolean {
  const m = /(\d+\.\d+(?:\.\d+)?)/.exec(recorded);
  if (!m) return false; // 解析不出来 → 保守判定为不匹配
  return m[1] === requested || m[1].startsWith(`${requested}.`);
}

/**
 * venv 目录存在但**不可用**时返回原因；健康则返回 null（可复用）。
 *
 * 为什么需要这一步（python 侧实测确认的生产事故类缺陷）：`uv venv` 建出的
 * 环境里，`Scripts/python.exe` 只是约 600KB 的 shim，真正的解释器仍在缓存池
 * 里，依赖记在 `pyvenv.cfg` 的 `home = <UV_PYTHON_INSTALL_DIR>/cpython-…`。
 * 池里那个目录一旦被回收/换卷/清空，venv 当场报废（`No Python at '...'`），
 * 而 `venvDir.exists()` 依旧为真——旧逻辑会"复用"一个死 venv，任务在 exec
 * 阶段以一个令人费解的退出码失败：既不是干净的 interpreter_unavailable，
 * 也把 D14（不回退宿主解释器）的语义搅浑。
 *
 * 纯文件系统判定，**不 spawn 任何进程**（准备阶段的每一毫秒都在任务超时预算
 * 里）。任何读取/解析异常都按"不可用"处理——宁可多重建一次 venv，也不复用
 * 一个可能已死的环境。
 */
function venvReuseProblem(
  venvDir: string,
  pythonBin: string,
  runtimeVersion: string | null,
): string | null {
  if (!fs.existsSync(pythonBin)) {
    return `the venv python executable is missing (${pythonBin})`;
  }
  const cfg = readPyvenvCfg(venvDir);
  if (cfg === null) return 'pyvenv.cfg is missing or unreadable';
  const home = cfg['home'];
  if (!home) return 'pyvenv.cfg has no "home" entry (cannot tell which interpreter backs it)';
  if (!fs.existsSync(home)) {
    return `the interpreter it was built from no longer exists (${home})`;
  }
  if (runtimeVersion) {
    // 版本不匹配 = 目录键撞车或 venv 是别的版本建的：必须重建，否则 AC-15b
    // （不受 PATH 影响、必须用声明版本）被静默违反。
    const recorded = cfg['version_info'] || path.basename(home);
    if (!versionMatchesRequested(recorded, runtimeVersion)) {
      return `it was built for Python ${recorded} but the task declares ${runtimeVersion}`;
    }
  }
  return null;
}

/**
 * 解释器获取失败时抛出的错误，**额外携带结构化快照**。
 *
 * 为什么需要单独一个类型：失败消息是给人读的一句话，而"池里已缓存哪些版本 /
 * 失败原因 / 请求的版本"是**机器输入**（调度侧据此决定把任务派到哪台执行器）。
 * python 侧在 `_interpreter_failure_result`（execute.py:1036）里把这些放进
 * `result.interpreter` 随回调上报，admin 落进 `task_executions.result`；node
 * 此前只发文本，于是同一类失败在两个执行器上留痕能力不对等（CONTRACT §3.3
 * 要求"全对等"）。
 *
 * 保留 `interpreter <X.Y> unavailable` 消息骨架：`prepareFailureReason` 靠它
 * 把这类失败归到 `interpreter_unavailable`，绝不能因为加了结构化字段而改文案。
 */
export class InterpreterUnavailablePrepareError extends Error {
  readonly snapshot: Record<string, unknown>;

  constructor(message: string, snapshot: Record<string, unknown>) {
    super(message);
    this.name = 'InterpreterUnavailablePrepareError';
    this.snapshot = snapshot;
  }
}

/**
 * 构造解释器失败的结构化快照，形状与 python 侧 `_interpreter_failure_result`
 * 的 `result.interpreter` **逐字段对齐**（requested / resolved / reason /
 * detail / pool），否则 admin 侧按同一形状解析时会拿到 undefined。
 *
 * 注意 `pool` 用 **snake_case `install_dir`**：这是跨进程的线上契约形状
 * （python 的 `_pool_summary` 就返回 `install_dir`，admin-web 的
 * `normalizePool`（interpreter-context.ts:76）也只读 `pool.install_dir`）。
 * 而 `poolSummary()` 返回的是本地 camelCase `installDir`，**不能直接当载荷发**
 * ——那样池目录一栏会永远渲染成 `-`。
 */
function interpreterFailureSnapshot(
  requested: string,
  err: InterpreterUnavailableError,
): Record<string, unknown> {
  const pool = poolSummary();
  return {
    interpreter: {
      requested,
      // 失败路径上必然没有解析结果——显式 null 而不是省略键，让 admin 侧
      // 的 `snapshot.resolved === null` 判断在两侧行为一致。
      resolved: null,
      reason: err.reason,
      detail: err.detail,
      pool: { install_dir: pool.installDir, versions: pool.versions },
    },
  };
}

/**
 * 解析声明版本的池内解释器绝对路径，失败时抛出带留痕消息的普通 Error
 * （调用方负责分类与回调）。
 */
async function ensureInterpreter(
  version: string,
  logPrepare: (m: string) => void,
): Promise<string> {
  logPrepare(`Resolving Python ${version} from the interpreter pool`);
  try {
    return await ensureVersion(version);
  } catch (err) {
    if (err instanceof InterpreterUnavailableError) {
      const message = interpreterFailureMessage(err.version, err);
      logPrepare(message);
      throw new InterpreterUnavailablePrepareError(
        message,
        interpreterFailureSnapshot(err.version, err),
      );
    }
    throw err;
  }
}

interface EnsureVenvOptions {
  venvDir: string;
  venvPython: string;
  requirements: string[];
  declaredVersion: string | null;
  logPrepare: (m: string) => void;
  signal: AbortSignal;
  isAborted: () => boolean;
}

/**
 * 建/复用 venv 并安装依赖，返回 venv 内解释器绝对路径。
 *
 * 与 python 侧 `ensure_venv` 逐条对齐：
 *   - 复用前校验 venv 是否**仍然可用**（`venvReuseProblem`）：健康的照旧直接
 *     复用（AC-16b：不产生任何 uv 调用），损坏的**删除后重建**而不是带着它
 *     往下跑。重建是安全的——venv 里只有依赖安装结果，requirements 会重装。
 *   - 无版本 → `uv venv --no-project <dir>`（**argv 逐字节不变**，AC-10a）。
 *   - 有版本 → 先 `ensureVersion` 拿池内绝对路径，再
 *     `uv venv --python <abs> --no-project <dir>`。
 *   - 失败/超时一律清掉半成品 venv：否则 `exists()` 会让下次静默复用一个坏环境。
 *   - 依赖安装 `uv pip install --python <venvPython> [--index-url <url>] <reqs>`。
 */
async function ensurePythonVenv(opts: EnsureVenvOptions): Promise<string> {
  const { venvDir, venvPython, requirements, declaredVersion, logPrepare, signal, isAborted } = opts;

  // 私有 PyPI 源：config 层已过凭据自由校验（无 userinfo/query/fragment）。
  // 校验失败在 config getter 里降级为 ''（官方源）并 warn，绝不把畸形 URL
  // 送进 uv argv。
  const registryUrl = config.pypiRegistryUrl;

  if (fs.existsSync(venvDir)) {
    const problem = venvReuseProblem(venvDir, venvPython, declaredVersion);
    if (problem) {
      logPrepare(`Discarding the cached venv ${venvDir} and rebuilding it: ${problem}`);
      try {
        fs.rmSync(venvDir, { recursive: true, force: true });
      } catch (err) {
        logger.warn(
          `Failed to remove the broken venv ${venvDir}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (!fs.existsSync(venvDir)) {
    const venvArgs = ['venv'];
    let uv: string;
    if (declaredVersion) {
      // EXP-02（本轮体验审查）：**必须先解析解释器，再解析 uv**。
      //
      // 此前顺序相反（先 `resolveUvForExecute()`），后果是：在一台既没装 uv、
      // 任务又声明了 Python 版本的执行器上，抛出的永远是
      //   「uv is not available on this executor (no UV_BIN, not on PATH, ...)」
      // 该文案既不含 `解释器 <X.Y> 无法获取` 骨架、也不匹配
      // `prepareFailureReason` 的解释器规则，于是落到 `unknown`；
      // 而 **python 执行器在同一情形下报 `interpreter_unavailable`**
      // ——同一失败在两个执行器上归类不同，排障者按分类筛选会漏掉一半。
      //
      // `ensureVersion()` 走的是解释器池/下载器，**不需要 uv**，所以把它提前
      // 能得到更准确的归因：池里没有 + 下不下来 → `interpreter_unavailable`
      // （附「候选执行器」快照，调度侧据此改派）；池里有 → 再解析 uv，此时
      // uv 缺失才是真正的根因。
      const poolPython = await ensureInterpreter(declaredVersion, logPrepare);
      uv = await resolveUvForExecute();
      // D8：只传池内绝对路径，绝不传裸版本号（裸版本号 = uv 的自动下载语义）。
      venvArgs.push('--python', poolPython);
    } else {
      uv = await resolveUvForExecute();
    }
    // 兼容红线 §4.1/AC-10a：无版本分支的剩余 argv 与改造前逐字节相同。
    venvArgs.push('--no-project', venvDir);
    logPrepare(`Creating venv with uv: ${venvDir}`);
    const venvResult = await runCommand(uv, venvArgs, {
      timeout: UV_VENV_TIMEOUT_MS,
      env: buildChildEnv({
        UV_PYTHON_INSTALL_DIR: config.uvPythonInstallDir,
        UV_CACHE_DIR: path.join(config.uvPythonInstallDir, '.cache'),
        // 关键：即便上面某处意外传了裸版本号，uv 也只会拒绝而不是偷偷下载。
        UV_PYTHON_DOWNLOADS: 'manual',
        UV_NO_PROGRESS: '1',
      }),
      signal,
    });
    if (isAborted()) throw new ExecutionCancelledError('');
    if (venvResult.status !== 0) {
      removeVenvQuietly(venvDir);
      const detail = (venvResult.stderr || venvResult.stdout || '').trim();
      // 解释器相关的失败要保留 uv 原文（`No interpreter found ...`），
      // `prepareFailureReason` 据此归类为 interpreter_unavailable。
      throw new Error(`uv venv failed: ${detail || 'unknown error'}`);
    }
  }

  if (requirements.length > 0) {
    const uv = await resolveUvForExecute();
    // 注入闸门（python 侧唯一一处）：这里的 `requirements` 是**任务依赖 ∪ 包内
    // requirements.txt ∪ manifest.yaml** 的合并结果，后两者都可能来自上传的 zip
    // 包——即不可信数据。`/execute` 入口的校验只覆盖任务声明的依赖，故必须在
    // 拼 argv **之前**再判一次，否则 `["--index-url", "pypi.evil.com"]` 会直达
    // `uv pip install`（索引劫持）——与 python 侧 `_validate_requirements` 同款
    // 判据（uv 收到的 requirement 是 argv，不是 shell，唯一注入向量就是 leading-'-'
    // 被当成 uv 选项）。
    for (const spec of requirements) {
      if (typeof spec !== 'string' || !spec.trim() || spec.trim().startsWith('-')) {
        throw new Error(
          `Invalid requirement (options are not allowed): ${String(spec)}`,
        );
      }
    }
    logPrepare(`Installing ${requirements.length} packages into ${venvDir}`);
    const installArgs = ['pip', 'install', '--python', venvPython];
    if (registryUrl) installArgs.push('--index-url', registryUrl);
    installArgs.push(...requirements);
    const installResult = await runCommand(uv, installArgs, {
      timeout: UV_PIP_TIMEOUT_MS,
      env: buildChildEnv({
        UV_PYTHON_INSTALL_DIR: config.uvPythonInstallDir,
        UV_CACHE_DIR: path.join(config.uvPythonInstallDir, '.cache'),
        UV_PYTHON_DOWNLOADS: 'manual',
        UV_NO_PROGRESS: '1',
      }),
      signal,
    });
    if (isAborted()) throw new ExecutionCancelledError('');
    if (installResult.status !== 0) {
      const detail = (installResult.stderr || installResult.stdout || '').trim();
      throw new Error(`uv pip install failed: ${detail || 'unknown error'}`);
    }
  }

  return venvPython;
}

function removeVenvQuietly(venvDir: string): void {
  try {
    fs.rmSync(venvDir, { recursive: true, force: true });
  } catch {
    /* best effort — 清理失败不掩盖原始失败 */
  }
}

/** uv 二进制路径；不可用时给出可操作的指引（而非一个 spawn ENOENT）。 */
async function resolveUvForExecute(): Promise<string> {
  const uv = await resolveUvBin();
  if (!uv.path) {
    throw new Error(
      'uv is not available on this executor (no UV_BIN, not on PATH, no bundled binary); ' +
        'install uv or use a client build that bundles it',
    );
  }
  return uv.path;
}

/**
 * 构造解释器获取失败时的 callback 错误消息（FR-12 留痕 / AC-12a）。
 *
 * 模板与 python 侧 `_interpreter_failure_result`、CONTRACT.md:315 **逐段对齐**：
 * `解释器 <X.Y> 无法获取（缓存缺失 + 下载失败：<reason>：<detail>）；` +
 * `候选执行器: <appName>[已缓存: <v1, v2>]`。
 *
 * 两个要点：① 必须保留 `解释器 <X.Y> 无法获取` 骨架——`prepareFailureReason`
 * 靠它把这类失败归到 `interpreter_unavailable`；② 「候选执行器」段不可省，
 * 调度侧据此判断该把任务改派到哪台执行器（AC-09b/AC-12a 的消费方读的就是
 * appName + 已缓存版本清单），此前 node 只发 `；已缓存: …`、缺候选执行器段，
 * 同一失败在两侧消息里形状不一致。appName 取 `config.appName`（APP_NAME，
 * 默认 executor-node-1），与 python 的 `settings.app_name` 同位。
 */
function interpreterFailureMessage(
  requested: string,
  err: InterpreterUnavailableError,
): string {
  const pool = poolSummary();
  const cached = pool.versions.length > 0 ? pool.versions.join(', ') : '无';
  return (
    `解释器 ${requested} 无法获取（缓存缺失 + 下载失败：${err.reason}：${err.detail}）；` +
    `候选执行器: ${config.appName}[已缓存: ${cached}]`
  );
}

/**
 * 构造 prepared task 并移交 worker（导出供测试注入）。taskId 此时即可得
 * （manifest 合并允许覆盖任意字段，但 worker 分组仅用于同任务串行，无安全
 * 含义）。移交后容量/收尾责任归 worker 的 onComplete。
 */
export async function dispatchExecutionToWorker(
  executionId: string,
  body: ExecuteRequest,
  params: Record<string, unknown> | undefined,
  workDir: string,
  entry: ExecutionEntry,
): Promise<void> {
  const taskId = String((body.task as Record<string, unknown>).id || executionId);
  entry.taskId = taskId;
  const placeholder = {
    ...body.task,
    workDir,
    runtime: body.task.runtime,
    entrypoint: body.task.entrypoint,
  };
  const runPrepared = async (assertNotCancelled: () => void) => {
    try {
      return await prepareExecution(executionId, body, params, workDir, entry, assertNotCancelled);
    } catch (err) {
      if (err instanceof ExecutionCancelledError || entry.aborted || entry.cancelled) {
        // 被 kill：worker 跳过任务执行。失败回调的推送责任按取消发生的阶段
        // 划分——未开始/排队中被摘除的路径由 kill 端点收尾；已被 worker 取出
        // （不在队列，kill 端点找不到可杀的进程）时由这里补推。容量释放统一
        // 走 worker onComplete（未取消标记时），幂等防双释放。
        if (entry.killedByRequest && !entry.cancelled) {
          pushKilledCallbackOnce(executionId, entry);
        }
        throw err instanceof ExecutionCancelledError ? err : new ExecutionCancelledError(executionId);
      }
      // prepare 真实失败（git clone / 依赖安装 / 参数非法）：这里完成回调上报
      // （原实现经 HTTP 500 反馈，现已 accepted），容量仍由 worker 的
      // onComplete 释放——不留悬挂状态。
      const message = err instanceof Error ? err.message : 'Task preparation failed';
      appendLog(executionId, `[prepare] ${message}`);
      writeExecMeta(executionId, {
        status: 'failed',
        endTime: Date.now(),
        errorMessage: message,
      });
      pushCallback({
        executionId,
        status: 'failed',
        errorMessage: truncateCallbackErrorMessage(message),
        failureReason: prepareFailureReason(message),
        // FR-12/AC-12a：解释器类失败附带结构化快照（与 python 侧对等）。
        // admin 把它原样落进 task_executions.result，运维据此判断"池里缺还是
        // 下载失败还是 uv 没装"，不必翻执行器日志。
        ...(err instanceof InterpreterUnavailablePrepareError
          ? { result: err.snapshot }
          : {}),
        ...(entry.traceparent ? { traceparent: entry.traceparent } : {}),
      });
      throw err;
    }
  };
  const onComplete = () => {
    entry.workerFinished = true;
    entry.release();
  };
  try {
    await taskWorkerManager.execute(taskId, executionId, placeholder, { ...(params || {}), executionId }, onComplete, runPrepared);
    entry.enqueued = true;
  } catch (err) {
    // 移交失败：worker 不会调用 onComplete，这里负责失败回调 + 释放。
    const message = err instanceof Error ? err.message : 'Failed to enqueue task';
    appendLog(executionId, `[prepare] ${message}`);
    pushCallback({
      executionId,
      status: 'failed',
      errorMessage: truncateCallbackErrorMessage(message),
      failureReason: 'unknown',
      ...(entry.traceparent ? { traceparent: entry.traceparent } : {}),
    });
    entry.release();
  }
}

/**
 * prepare 阶段（原同步请求路径逻辑，改动2）：git checkout → manifest 合并
 * → glue → 依赖安装 → env 注入 → 组装 cmd/args。返回真正可运行的 task。
 * 每个检查点响应 kill（aborted 标志 + abortController.signal）。
 * 失败抛普通 Error（调用方负责回调），被 kill 时抛 ExecutionCancelledError
 * （调用方静默退出，收尾归 kill 端点）。
 */
async function prepareExecution(
  executionId: string,
  body: ExecuteRequest,
  params: Record<string, unknown> | undefined,
  workDir: string,
  entry: ExecutionEntry,
  assertNotCancelled: () => void,
): Promise<{ task: any; params: Record<string, any> }> {
  const signal = entry.abortController.signal;
  const checkAbort = () => {
    if (entry.aborted) throw new ExecutionCancelledError(executionId);
    assertNotCancelled();
  };
  checkAbort();

  const taskName = String(body.task.name || body.task.id || executionId);
  const logPrepare = (message: string) => {
    logger.info(message);
    appendLog(executionId, message);
  };

  // --- Git version binding: if task specifies gitRepo, clone/checkout to work dir ---
  const gitRepo = body.task.gitRepo;
  const gitCommit = body.task.gitCommit;
  const gitBranch = body.task.gitBranch ?? 'main';
  if (gitRepo) {
    const ref = gitCommit || gitBranch;
    logPrepare(`Checking out ${redactUrl(gitRepo)}@${ref} to ${workDir}`);
    try {
      await gitCheckoutTo(gitRepo, ref, workDir, signal);
    } catch (err) {
      if (err instanceof ExecutionCancelledError || entry.aborted) throw err;
      const message = err instanceof Error ? err.message : 'Git checkout failed';
      logPrepare(`Git checkout failed: ${message}`);
      throw new Error(message);
    }
  }
  checkAbort();

  // Load manifest.yaml and merge with task (task fields take priority).
  //
  // 位置纪律（与 executor-python 的 load_manifest 逐字对齐）：**git clone 之后、
  // zip 解压之前**。
  //
  //   * 放在 git 之后 —— manifest 是仓库自己声明的入口，git 渠道必须读得到；
  //   * 放在 zip 解压**之前** —— 此刻 workDir 还是空的，于是 zip 渠道读不到
  //     任何 manifest，包内自带的 manifest.yaml 无法把"包内数据"提权成
  //     "任务配置"（劫持 entrypoint / runtime / requirements / timeout）。
  //
  // 这正是 python 侧 `execute.py` 的次序：git checkout(2686) → load_manifest(2691)
  // → zip 解压(2810)。此前 node 把 loadManifest 放在解压**之后**（原 1307 行），
  // 于是上传者只要在包里塞一份 manifest.yaml 就能改掉任务的 entrypoint——
  // 而 admin 在 upload 时就已按 manifest 注册过任务并把 entrypoint 写进了派发
  // 载荷，执行器再读一次包内的纯属冗余，且是 zip 渠道独有的攻击面。
  // CONTRACT §3.3 要求两侧"全对等"，此处即对等修复。
  const manifest = loadManifest(workDir);
  const task = mergeTaskWithManifest(body.task as Record<string, unknown>, manifest);

  // ---------------------------------------------------------------------
  // WS5（python_task_upload_and_multiversion, CONTRACT.md §3.3-1 / D3）：
  // zip 整包渠道。
  //
  // 触发条件必须尊重文档化优先级 **git > glue > application_zip**，否则会
  // 踩中存量数据的兼容红线 §4.4：历史行可以同时带 `gitRepo` 与
  // `applicationId`（后者当年只是一个弱引用，**不**表示"代码来自上传的
  // 包"）。若简单地按 `applicationId` 触发，就会先 git clone 再用 zip 内容
  // 覆盖同一个目录，还叠加包内 requirements —— 既静默改变了存量任务的结果，
  // 也是"包内容覆盖已克隆源码"的安全意外。
  //
  //   1. `codeSource === 'application_zip'` —— 写面校验过的**显式信号**；
  //   2. 无 `codeSource` 但 `applicationId` + **`packageUrl` 同时存在** ——
  //      历史行/迁移置 NULL 的歧义场景。这里刻意改看 `packageUrl` 这个
  //      **admin 生产出来的正向信号**（admin 只为它认定的 zip 任务附
  //      packageUrl），而不是继续依赖 applicationId 这个歧义列：admin 不当作
  //      zip 任务的行自然没有 packageUrl，于是原样落回既有行为。
  //
  // 位置纪律：本区块必须保持在上方 `loadManifest` **之后**（即 manifest 读取
  // 发生在 zip 下载/解压**之前**）。manifest 从 workDir 读取，而走到这里时
  // zip 渠道的 workDir 仍为空，包内自带的 manifest.yaml 因此永远不会被合并——
  // 否则它就能劫持 entrypoint/runtime/requirements（把"包内数据"提权成"任务
  // 配置"），那是 zip 渠道独有的攻击面（P0-3，与 executor-python 同序）。
  // 调整本区块位置时，切勿把它挪回 loadManifest 之前。
  // ---------------------------------------------------------------------
  const taskRec = body.task as Record<string, unknown>;
  const codeSource = (taskRec.codeSource as string | undefined) || (taskRec.code_source as string | undefined);
  const applicationId = (taskRec.applicationId as string | undefined) || (taskRec.application_id as string | undefined);
  const packageUrl = (taskRec.packageUrl as string | undefined) || (taskRec.package_url as string | undefined);
  const glueSourceField = (taskRec.glueSource as string | undefined) || (taskRec.glue_source as string | undefined);

  let isZipChannel = codeSource === 'application_zip' || (!codeSource && !!applicationId && !!packageUrl);
  if (isZipChannel && (gitRepo || glueSourceField)) {
    // 写面互斥（CONTRACT.md §2.1）保证不可达；真出现了就按文档优先级让位，
    // 并留下 ERROR 级日志——静默按其中一个跑才是真正危险的。
    logger.error(
      `Task ${taskName} declares codeSource=${String(codeSource)}/applicationId=${String(applicationId)} ` +
        `together with ${gitRepo ? 'gitRepo' : 'glueSource'} — applying the documented precedence ` +
        'git > glue > application_zip and ignoring the zip channel',
    );
    isZipChannel = false;
  }

  let packageRequirements: string[] = [];
  if (isZipChannel) {
    if (!packageUrl) {
      // 绝不静默跑一个空工作目录（那会把"配置缺失"伪装成"脚本报错"）。
      // 只有**确实是** zip 任务（codeSource 显式声明）才会走到这里：歧义分支
      // 本就要求 packageUrl 存在，所以存量 git+applicationId 行不受影响。
      throw new Error(
        'application_zip task has no packageUrl in the dispatch payload ' +
          '(admin must attach the resolved applications.packageUrl); ' +
          `applicationId=${String(applicationId)}`,
      );
    }
    const zipPath = path.join(workDir, 'package.zip');
    logPrepare(`Downloading package from ${redactUrl(packageUrl)}`);
    try {
      // 复用既有下载链：SSRF 闸（fail-closed）+ Bearer 首跳 + 跨跳剥离 +
      // 绝对超时 + 体积上限。size cap 与 python 侧 200MB 对齐。
      await downloadFile(packageUrl, zipPath, {
        timeoutMs: ZIP_DOWNLOAD_TIMEOUT_MS,
        maxBytes: config.packageDownloadMaxBytes,
      });
    } catch (err) {
      if (err instanceof ExecutionCancelledError || entry.aborted) throw err;
      throw new Error(
        `Package download failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    checkAbort();

    // zip-guard 炸弹审查 + zip-slip/绝对路径/符号链接拒绝，逐条目断言落盘
    // 目标仍在 workDir 之内。失败会自行清理本次写出的内容。
    logPrepare('Extracting package (zip-safety vetting enabled)');
    try {
      safeExtractZip(zipPath, workDir, { removeArchive: true });
    } catch (err) {
      if (err instanceof ZipSafetyError) {
        throw new Error(`Unsafe or invalid package archive: ${err.message}`);
      }
      throw err;
    }
    checkAbort();

    // D4/AC-04a/b：包内 requirements.txt ∪ 任务级 requirements（任务级同名覆盖）。
    packageRequirements = readPackageRequirements(workDir);
    if (packageRequirements.length > 0) {
      logPrepare(`Package declares ${packageRequirements.length} requirement(s)`);
    }
  }

  const runtime = (task.runtime as string) || 'node';
  const entrypoint = (task.entrypoint as string) || 'index.js';
  // 改动4：timeout=0 = 不限时（不设 kill 定时器）；null/undefined 才用默认。
  const rawTimeout = task.timeout;
  const timeout = rawTimeout === 0 ? 0 : (rawTimeout as number) || config.taskTimeoutSeconds;
  // Bounded timeout: a negative value fires setTimeout immediately (instant
  // task kill) and an unbounded one arms a near-permanent timer.
  if (timeout !== 0 && (!Number.isFinite(timeout) || timeout < 1 || timeout > 86_400)) {
    throw new Error(`Invalid task timeout: ${timeout} (expected 0 (unbounded) or 1..86400 seconds)`);
  }
  const requirements: string[] = (task.requirements as string[]) || [];
  const taskId = entry.taskId;

  // WS5（FR-06b/FR-15）：任务声明的 Python 版本。
  //
  // 只在 runtime=python 时消费（NG-02：node/shell 的多版本不在本期范围，
  // 声明了也不影响其既有 argv）。非法格式在此显式拒绝——**绝不静默忽略**：
  // 一个畸形版本若被当成"没声明"，任务会以宿主默认解释器跑出一个看似成功的
  // 结果，那比直接失败危险得多。
  const rawRuntimeVersion =
    (task.runtimeVersion as string | undefined) ?? (task.runtime_version as string | undefined);
  let declaredVersion: string | null = null;
  if (rawRuntimeVersion !== undefined && rawRuntimeVersion !== null && rawRuntimeVersion !== '') {
    declaredVersion = normalizeRuntimeVersion(rawRuntimeVersion);
  }

  // Glue script support: write inline source to a temp file and use it as entrypoint
  let actualRuntime = runtime;
  let actualEntrypoint = entrypoint;
  let actualRequirements = requirements;
  const glueSource = (task.glueSource as string | undefined) || (task.glue_source as string | undefined);
  const glueLanguage = (task.glueLanguage as string | undefined) || (task.glue_language as string | undefined);
  if (glueSource) {
    if (typeof glueSource !== 'string') {
      throw new Error('glueSource must be a string');
    }
    let glueFile: string;
    const glLower = glueLanguage ? glueLanguage.toLowerCase() : '';
    if (glLower === 'javascript' || glLower === 'glue_node' || (!glueLanguage && runtime === 'node')) {
      glueFile = path.join(workDir, 'glue_script.js');
      actualRuntime = 'node';
    } else if (glLower === 'python' || glLower === 'glue_python' || (!glueLanguage && runtime === 'python')) {
      glueFile = path.join(workDir, 'glue_script.py');
      actualRuntime = 'python';
    } else if (glLower === 'shell' || glLower === 'glue_shell' || (!glueLanguage && runtime === 'shell')) {
      // W-11 (windows-findings): parity bug — node/python branches accept a
      // missing glueLanguage (fall back to task.runtime), shell did not and
      // 400'd `Unsupported glue language: ` for shell glue created without
      // the explicit field. Also on win32 the file MUST end in .cmd:
      // `cmd.exe /c <path>.sh` neither runs the batch nor exits cleanly —
      // it hangs (observed holding a task slot until timeout).
      glueFile = path.join(workDir, process.platform === 'win32' ? 'glue_script.cmd' : 'glue_script.sh');
      actualRuntime = 'shell';
    } else {
      throw new Error(`Unsupported glue language: ${glueLanguage}`);
    }
    fs.writeFileSync(glueFile, glueSource, 'utf-8');
    fs.chmodSync(glueFile, 0o755);
    logPrepare(`Glue script written to ${glueFile} (${glueSource.length} bytes)`);
    actualEntrypoint = actualRuntime === 'shell' ? glueFile : path.basename(glueFile);
    actualRequirements = [];  // Glue scripts use system runtime, no per-task deps
  }

  // D4（AC-04a/b）：zip 渠道下把包内 requirements.txt 并入任务级 requirements
  // （任务级同名覆盖）。glue 分支已把 actualRequirements 清空且不建 venv，
  // 因此这里跳过——glue 的语义是"用系统运行时跑一段内联脚本"。
  if (!glueSource && actualRuntime === 'python' && packageRequirements.length > 0) {
    actualRequirements = mergeRequirements(packageRequirements, actualRequirements);
    logPrepare(
      `Merged package + task requirements for ${taskId}: ${actualRequirements.join(', ')}`,
    );
  }

  // node runtime: install dependencies on demand to task-isolated directory
  let sharedNodeModulesDir: string | null = null;
  if (actualRuntime === 'node' && actualRequirements.length > 0) {
    const nodeModulesDir = path.join(config.workDir, '.node_modules', taskId);
    sharedNodeModulesDir = nodeModulesDir;
    fs.mkdirSync(nodeModulesDir, { recursive: true });
    const pkgJson = path.join(nodeModulesDir, 'package.json');
    if (!fs.existsSync(pkgJson)) {
      fs.writeFileSync(pkgJson, JSON.stringify({ name: `task-${taskId}`, version: '1.0.0' }));
    }
    // S16: names were validated synchronously at /execute; re-check here in
    // case requirements arrived only via manifest.yaml.
    const npmNameRe = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[\w.^~-]+)?$/i;
    for (const pkg of actualRequirements) {
      if (!npmNameRe.test(pkg)) {
        throw new Error(`Invalid npm package name: ${pkg}`);
      }
    }
    logPrepare(`Installing ${actualRequirements.length} packages for task ${taskId}`);
    // 改动3: .npmrc 指向私服（@autoflow / @autocodeflow 双 scope 行）；
    // 配置了 NPM_REGISTRY_TOKEN 时追加 _authToken 行——registry-npm 对
    // '**' 的 access 是 $authenticated，匿名安装必 401。token 不打日志。
    //
    // The config is deliberately created in a fresh, mode-700 system temp
    // directory rather than in the task cwd or the persistent node_modules
    // cache. It exists only for the lifetime of the npm child and is removed
    // in the callback's finally block after npm has exited. In particular,
    // npm_config_userconfig must remain valid until runCommand observes the
    // child's close event; deleting it before then races npm's config reads.
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    // E-26（DEEP_REVIEW 0ef3bbe）：win32 下 runCommand 用 spawn(cmd, args,
    // {shell:true})——Node 按 join(' ') 拼 cmd 命令行且不对 args 加引号。当
    // WORK_DIR 含空格（如 C:\My Tasks\...）时，`--prefix C:\My Tasks\...` 被
    // cmd.exe 拆成 `--prefix C:\My` + 把 `Tasks\...` 当成要安装的包名，安装错位。
    // 对含空格/shell 元字符的路径参数显式包裹双引号（cmd.exe 还原为一个 token）。
    // 包名已由 npmNameRe 校验（不含空格），无需加引号。
    const npmArgs = ['install', '--prefix', quoteShellArgForPlatform(nodeModulesDir)];
    if (config.npmRegistryToken) {
      // Keep the existing boundary: authenticated installs disable lifecycle
      // scripts, so an install script cannot read npm_config_userconfig while
      // the token-bearing file exists. This intentionally does not enable
      // native/lifecycle dependencies; callers needing those must use a
      // trusted package path rather than weakening this executor policy.
      npmArgs.push('--ignore-scripts');
    }
    npmArgs.push(...actualRequirements);
    const installResult = await queueTaskInstall(
      taskId,
      async () => {
        if (entry.aborted) throw new ExecutionCancelledError(executionId);

        const npmConfig = createTemporaryNpmConfig(
          config.npmRegistryUrl,
          config.npmRegistryToken,
          actualRequirements,
        );
        try {
          if (config.npmRegistryUrl) {
            logger.info(`Using npm registry: ${redactUrl(config.npmRegistryUrl)} for task ${taskId}`);
          }
          // npm itself must not reconstruct the executor's environment (or
          // discover credentials via npm_config_*); only the runtime paths and
          // the two temporary config paths are provided. The token remains in
          // the config file, never in an environment variable.
          const npmInstallEnv = buildChildEnv({
            npm_config_userconfig: npmConfig.userconfig,
            npm_config_globalconfig: npmConfig.globalconfig,
            npm_config_registry: config.npmRegistryUrl || undefined,
            npm_config_cache: path.join(nodeModulesDir, '.npm-cache'),
            npm_config_prefix: nodeModulesDir,
          });
          return await runCommand(
            npmCmd,
            npmArgs,
            {
              cwd: workDir,
              env: npmInstallEnv,
              timeout: 300_000,
              shell: process.platform === 'win32',
              signal,
            },
          );
        } finally {
          // This runs after success, non-zero exit, timeout, abort, and a
          // thrown spawn/config exception. A cleanup error is surfaced to the
          // caller (and therefore the task callback) rather than silently
          // leaving a credential behind.
          removeTemporaryNpmConfig(npmConfig);
        }
      },
      () => entry.aborted,
    );
    if (entry.aborted) throw new ExecutionCancelledError(executionId);
    if (installResult.status !== 0) {
      const errMsg = installResult.stderr.trim() || 'npm install failed';
      const message = `Dependency installation failed: ${errMsg}`;
      logPrepare(message);
      throw new Error(message);
    }
  }
  checkAbort();

  // ---------------------------------------------------------------------
  // WS5（python_task_upload_and_multiversion, CONTRACT.md §3.3-3/4）：
  // python 的 venv + 依赖安装 + 解释器解析。
  //
  // 兼容红线 §4.6（硬要求）：**无版本且无依赖**的 python 任务必须逐字节保持
  // 现状 `python3 <entrypoint>`——不建 venv、不探测解释器池、不 spawn uv。
  // 下面的分支顺序就是这条红线的实现：先判"要不要建 venv"，不要就直接落到
  // 既有的 cmd 构造；"要不要用池内解释器"只在声明了版本时才成立。
  //
  // 有依赖或声明版本 → 建 venv：
  //   - 目录键带版本签名（D6/FR-16）：`<taskId>` / `<taskId>-<X.Y>`，声明版本
  //     一变就不可能复用旧 venv（AC-16a）；
  //   - 声明版本 → `uv venv --python <池内绝对路径> --no-project <dir>`，
  //     **绝不**传裸版本号（那会触发 uv 的"缺则自动下载"语义，绕过 D13 的全局
  //     单下载队列）。D8 硬约束：venv 阶段绝不触发下载。
  // ---------------------------------------------------------------------
  let pythonBinFromVenv: string | null = null;
  let resolvedInterpreter: string | null = null;

  if (actualRuntime === 'python') {
    const needsVenv = !glueSource && (actualRequirements.length > 0 || declaredVersion !== null);
    if (needsVenv) {
      // 唯一派生点：目录名同时写入 entry（供 TTL 清扫的活跃保护集读取），
      // 于是"写哪个目录"与"保护哪个目录"永不漂移（DESIGN §1.2.2）。
      const venvName = venvDirName(taskId, declaredVersion);
      entry.venvDirName = venvName;
      const venvDir = path.join(config.workDir, '.venvs', venvName);
      const venvPython = venvPythonBin(venvDir);
      try {
        pythonBinFromVenv = await ensurePythonVenv({
          venvDir,
          venvPython,
          requirements: actualRequirements,
          declaredVersion,
          logPrepare,
          signal,
          isAborted: () => entry.aborted,
        });
      } catch (err) {
        if (err instanceof ExecutionCancelledError || entry.aborted) throw err;
        if (err instanceof InterpreterUnavailableError) {
          // 解释器取不到：必须归类为 interpreter_unavailable，且消息要能被人
          // 读懂（FR-12 留痕）。池快照一并带上——"池里有什么"是判断"该下载还是
          // 该离线预填"的第一手信息。
          const message = interpreterFailureMessage(
            err.version,
            err,
          );
          logPrepare(message);
          // 与 ensureInterpreter 同款：带上结构化快照（FR-12/AC-12a 对等）。
          throw new InterpreterUnavailablePrepareError(
            message,
            interpreterFailureSnapshot(err.version, err),
          );
        }
        throw err;
      }
      resolvedInterpreter = pythonBinFromVenv;
      logPrepare(`Using venv interpreter: ${pythonBinFromVenv}`);
    } else if (declaredVersion) {
      // glue 渠道 + 声明版本（AC-11a）：不建 venv、不装依赖，但要用声明的
      // 解释器执行——否则"声明了版本"在 glue 任务上会被静默忽略。
      resolvedInterpreter = await ensureInterpreter(declaredVersion, logPrepare);
    }
  }
  checkAbort();

  // SEC-01: only pass a whitelist of env vars to child process — never expose executor secrets
  const env: NodeJS.ProcessEnv = buildChildEnv();
  // Requirements were installed to .node_modules/<taskId>/node_modules via npm
  // --prefix; Node's resolution chain never reaches a dot-prefixed sibling
  // directory, so point NODE_PATH at it or every require() fails with
  // MODULE_NOT_FOUND (verified reproduction — see review round 4).
  if (sharedNodeModulesDir) {
    const taskNodeModules = path.join(sharedNodeModulesDir, 'node_modules');
    env['NODE_PATH'] = env['NODE_PATH']
      ? `${taskNodeModules}${path.delimiter}${env['NODE_PATH']}`
      : taskNodeModules;
  }
  // inject task-scoped context
  env['EXECUTION_ID'] = executionId;
  env['TASK_ID'] = String(task.id || '');
  env['TASK_NAME'] = String(task.name || '');

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      env[`AUTOFLOW_${k.toUpperCase()}`] = String(v);
    }
  }

  // N23: per-execution callback credentials — injected AFTER the params loop
  // so user params can never override them. The token is an HMAC bound to
  // this executionId with a short TTL (task timeout + grace), derived from
  // the executor shared secret; it lets task code call
  // POST /api/executions/callback without ever seeing the shared token
  // (SEC-01 whitelist untouched — this is the explicit extra channel).
  // AUTOFLOW_ADMIN_API_URL is non-secret routing info, same value the
  // executor itself uses to reach admin-api.
  const callbackToken = createExecutionCallbackToken(
    executionId,
    (timeout === 0 ? TOKEN_TTL_UNBOUNDED_SECONDS : timeout) + CALLBACK_TOKEN_GRACE_SECONDS,
  );
  if (callbackToken) {
    env['AUTOFLOW_CALLBACK_TOKEN'] = callbackToken;
  }
  // AUTOFLOW-API-URL-01（本轮审计）：优先级必须与 executor-python 一致
  // （external > internal > default，见 `admin-api-url.resolveAdminApiBaseUrl`
  // 的注释）。
  //
  // 失败模式（改动前）：这里只读 `adminApiUrlInternal || adminApiUrl`，而
  // 执行器**自己**的出站走 `middleware/auth.ts::getAdminApiUrl`（external 优先）
  // ——同一进程对"admin 在哪"给出两个答案：任务侧拿到的 internal 地址在跨网/
  // 公网部署下不可达，SDK 的 `ctx.http` 于是回调不出去，而失败是静默的
  // （只是"没有回调"，终态由执行器补，用户看到的是进度丢失）。
  // python 侧注入的是 `admin_api.get_admin_api_base_url()`（external 优先），
  // 故这是 node 单侧的漂移。
  const adminApiUrl = resolveAdminApiBaseUrl(config);
  if (adminApiUrl) {
    env['AUTOFLOW_ADMIN_API_URL'] = adminApiUrl;
  }
  // N27: the address this executor registered itself with (same value
  // main.ts sends to /api/executors/register). Non-secret routing info —
  // the per-execution callback path requires every callback item to carry
  // executorAddress, and task code cannot know it any other way. Injected
  // after the params loop so user params can never override it.
  const registeredAddress = config.executorAddressPublic || config.executorAddress;
  if (registeredAddress) {
    env['AUTOFLOW_EXECUTOR_ADDRESS'] = registeredAddress;
  }

  // FEAT-05: 预建产物目录约定 <workDir>/artifacts/，注入 AUTOFLOW_ARTIFACTS_DIR，
  // 任务把交付物写此目录即被收集上传。best-effort，失败不阻断。
  const artifactsDir = artifactsDirFor(workDir);
  try {
    fs.mkdirSync(artifactsDir, { recursive: true });
  } catch (e) {
    logger.warn(`create artifacts dir failed (non-critical): ${String(e)}`);
  }
  env['AUTOFLOW_ARTIFACTS_DIR'] = artifactsDir;

  // OBS-01: 把 dispatch 请求的 W3C traceparent 头透传为任务 env（任务代码
  // 可读 AUTOFLOW_TRACE_ID 做下游关联）。在 params 注入之后（用户参数不可
  // 覆盖，与 AUTOFLOW_CALLBACK_TOKEN 同一纪律）。缺省（admin 未开追踪）
  // 不注入，与既有行为一致。
  if (entry.traceparent) {
    env['AUTOFLOW_TRACE_ID'] = entry.traceparent;
  }

  let cmd: string;
  let args: string[];

  if (actualRuntime === 'node') {
    cmd = process.platform === 'win32' ? 'node.exe' : 'node';
    args = [actualEntrypoint];
  } else if (actualRuntime === 'python') {
    // WS5（CONTRACT.md §3.3-4）：
    //   有 venv        → venv 内解释器绝对路径；
    //   仅声明版本     → 池内解释器绝对路径（ensureVersion 的返回值）；
    //   无版本无依赖   → **现状 `python3 <entrypoint>` 逐字节不变**
    //                    （兼容红线 §4.6 / AC-10a）。
    // 用绝对路径而非裸版本号：裸版本号会重新进入 uv 的解析/下载语义，而此刻
    // 我们已经在受控入口里解析过了。
    //
    // D14 兜底断言：**声明了版本就绝不允许落到 `python3` 兜底**。上面的分支保证
    // 了"declaredVersion !== null ⇒ 走 needsVenv ⇒ 取解释器失败即抛错"，所以这条
    // `||` 链在声明版本时理论上不可达；但那种"理论不可达"正是后续重构最容易破坏
    // 的东西（例如有人把 needsVenv 的条件改窄）。这里显式失败而不是静默降级：
    // 静默跑在宿主解释器上会让"声明了版本"变成一句空话，且完全无声。
    if (declaredVersion !== null && !pythonBinFromVenv && !resolvedInterpreter) {
      throw new Error(
        `interpreter ${declaredVersion} unavailable (internal): no interpreter was resolved ` +
          `for a version-declaring task — refusing to fall back to the host interpreter`,
      );
    }
    cmd = pythonBinFromVenv || resolvedInterpreter || (process.platform === 'win32' ? 'python.exe' : 'python3');
    args = [actualEntrypoint];
  } else if (actualRuntime === 'shell') {
    if (process.platform === 'win32') {
      cmd = 'cmd.exe';
      args = ['/c', actualEntrypoint];
    } else {
      cmd = 'bash';
      // spawn already runs with cwd=workDir — passing the entrypoint
      // directly avoids quote-breakout through string concatenation.
      args = [actualEntrypoint];
    }
  } else {
    throw new Error(`Unsupported runtime: ${actualRuntime}`);
  }

  // Hardening: the entrypoint is resolved against the work dir by every
  // runtime (cwd=workDir), so a relative path with `..` could execute a
  // script anywhere on the host. Glue scripts use absolute paths that are
  // already inside the work dir and pass this guard unchanged.
  const entryAbs = path.resolve(workDir, actualEntrypoint);
  const workDirAbs = path.resolve(workDir);
  if (entryAbs !== workDirAbs && !entryAbs.startsWith(workDirAbs + path.sep)) {
    throw new Error('entrypoint escapes the task work directory');
  }

  logger.info(`Running task ${taskName} [${executionId}]: ${cmd} ${args.join(' ')}`);

  const timeoutForTask = timeout === 0 ? Infinity : timeout;
  return {
    task: { ...task, runtime: actualRuntime, entrypoint: actualEntrypoint, timeout: timeoutForTask, workDir, env, cmd, args },
    params: { ...(params || {}), executionId },
  };
}

// timeout=0（不限时）任务的回调 token 必须有数字 TTL——取 10 年上限
// （86400s/天 × 3650）。admin 侧僵尸回收对该类任务本就有 1h 兜底窗口。
const TOKEN_TTL_UNBOUNDED_SECONDS = 315_360_000;

/**
 * 任务 .npmrc 内容（改动3）：
 * - 仅内部 scope 依赖 → 只写 scoped registry 行（保持既有行为：公共包走默认
 *   registry，匿名可用）；
 * - 含公共包 → 写全局 registry 行（私服作为缓存代理加速）；
 * - 两种 scope（@autoflow / @autocodeflow，命名三处漂移）都写 scoped 行；
 * - 配置了 token → 追加 `//<host:port>/:_authToken=`（http/https 均支持）。
 * token 绝不出现在返回值之外的任何地方（不打日志）。
 */
export function buildNpmRcContent(
  registryUrl: string,
  token: string | undefined,
  requirements: string[],
): string {
  const lines: string[] = [];
  for (const scope of ['@autoflow', '@autocodeflow']) {
    lines.push(`${scope}:registry=${registryUrl}`);
  }
  const scopedOnly =
    requirements.length > 0 &&
    requirements.every(pkg => pkg.startsWith('@autoflow/') || pkg.startsWith('@autocodeflow/'));
  if (!scopedOnly) {
    lines.push(`registry=${registryUrl}`);
  }
  if (token) {
    const authLine = npmAuthUrlLine(registryUrl);
    if (authLine) lines.push(`${authLine}:_authToken=${token}`);
  }
  return lines.join('\n') + '\n';
}

/** `https://host:port/base/` → `//host:port/base/`（npm auth 行键格式）。 */
function npmAuthUrlLine(registryUrl: string): string | null {
  const m = /^https?:\/\/(.+)$/i.exec(registryUrl.trim());
  return m ? `//${m[1]}` : null;
}

interface TemporaryNpmConfig {
  directory: string;
  userconfig: string;
  globalconfig: string;
}

/**
 * Create npm's config files outside the task tree. The userconfig can contain
 * NPM_REGISTRY_TOKEN, so the directory and files are private and short-lived;
 * callers must invoke removeTemporaryNpmConfig only after npm has exited.
 */
function createTemporaryNpmConfig(
  registryUrl: string,
  token: string | undefined,
  requirements: string[],
): TemporaryNpmConfig {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autocodeflow-npm-'));
  const npmConfig: TemporaryNpmConfig = {
    directory,
    userconfig: path.join(directory, '.npmrc'),
    globalconfig: path.join(directory, '.npm-globalrc'),
  };
  try {
    // Do not tolerate a permissive temp directory/file mode: a token must not
    // become readable by another local user while npm is installing.
    fs.chmodSync(directory, 0o700);
    fs.writeFileSync(
      npmConfig.userconfig,
      registryUrl ? buildNpmRcContent(registryUrl, token, requirements) : '',
      { encoding: 'utf8', mode: 0o600 },
    );
    fs.chmodSync(npmConfig.userconfig, 0o600);
    // Pin npm's global config too, even when it is empty, so a user's global
    // .npmrc cannot introduce another credential or override registry policy.
    fs.writeFileSync(npmConfig.globalconfig, '', { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(npmConfig.globalconfig, 0o600);
    return npmConfig;
  } catch (err) {
    try {
      removeTemporaryNpmConfig(npmConfig);
    } catch (cleanupErr) {
      throw new Error(
        `Failed to create npm config and failed to clean it up: ${
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        }`,
      );
    }
    throw err;
  }
}

/**
 * Remove every temporary npm config artifact. Cleanup errors are deliberately
 * fatal: silently continuing could leave a registry credential readable on a
 * shared executor. The caller's finally block invokes this only after the npm
 * child has emitted close, so no active child can still need the files.
 */
function removeTemporaryNpmConfig(npmConfig: TemporaryNpmConfig): void {
  const errors: string[] = [];
  for (const file of [npmConfig.userconfig, npmConfig.globalconfig]) {
    try {
      fs.unlinkSync(file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    fs.rmSync(npmConfig.directory, { recursive: true, force: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') errors.push(`${npmConfig.directory}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (errors.length > 0) {
    const message = `Unable to remove temporary npm config: ${errors.join('; ')}`;
    logger.error(message);
    throw new Error(message);
  }
}

// ---------------------------------------------------------------------------
// POST /executions/:executionId/kill — 改动1：admin 的 killExecution 此前只
// 改 DB，被 kill 的任务在本执行器上继续跑完。这里按运行中注册表终止进程树
// （或中止 prepare 阶段），幂等释放并发槽，回调照常走失败路径
// （failureReason=killed）。
// ---------------------------------------------------------------------------
/**
 * A3（kill/logs 契约化）：kill 出参必经生成的 KillResponse——两侧逐字段同形
 * `{ok:boolean}` 且 forbid 额外键。构造方就是本路由，校验失败 = 服务端把响应
 * 形状改漂移了，直接抛出走 500，而不是发一个 admin 无法解析的载荷。
 */
function killBody(ok: boolean): { ok: boolean } {
  const payload = { ok };
  const checked = KillResponseSchema.safeParse(payload);
  if (!checked.success) {
    const where = checked.error.issues[0]?.path.join('.') || '(root)';
    throw new Error(`kill response violates executor-protocol at ${where}`);
  }
  return payload;
}

executeRouter.post('/executions/:executionId/kill', (req: Request, res: Response) => {
  const { executionId } = req.params;
  const entry = liveExecutions.get(executionId);
  if (!entry) {
    // 不在运行表中（从未领取 / 已结束 / 已清理）
    res.status(404).json(killBody(false));
    return;
  }

  entry.killedByRequest = true;
  entry.aborted = true;
  entry.abortController.abort();

  const finalizeKilled = () => {
    pushKilledCallbackOnce(executionId, entry);
    entry.release(); // 幂等防双释放
  };

  if (!entry.enqueued) {
    // prepare 尚未移交 worker（后台前置阶段）：立刻收尾，runPrepared 检查点
    // 会因 aborted 标志静默退出。
    finalizeKilled();
    res.json(killBody(true));
    return;
  }
  if (taskWorkerManager.cancelExecution(entry.taskId, executionId)) {
    // 已从 worker 队列摘除（尚未到点）：onComplete 不会再被触发，这里收尾。
    entry.cancelled = true;
    finalizeKilled();
    res.json(killBody(true));
    return;
  }
  if (entry.workerFinished) {
    // 恰在 kill 到达前自然结束：仍按 200 返回（admin 侧已是终态，回调被忽略）。
    res.json(killBody(true));
    return;
  }

  // 已 spawn：终止整个进程树（复用 killProcessTree），close 事件走 runTask
  // 失败路径（据 killedByRequest 标记 failureReason=killed），容量由 worker
  // onComplete 释放（幂等）。
  const proc = runningTaskProcesses.get(executionId);
  if (proc) {
    killProcessTree(proc, 'SIGKILL');
  } else {
    logger.warn(`[kill] ${executionId} enqueued but no live process registered — waiting for natural end`);
  }
  res.json(killBody(true));
});

/** Write execution metadata to workDir/meta/{executionId}.json so the desktop can build history */
function writeExecMeta(executionId: string, data: Record<string, unknown>): void {
  try {
    const metaDir = path.join(config.workDir, 'meta');
    fs.mkdirSync(metaDir, { recursive: true });
    const metaFile = path.join(metaDir, `${executionId}.json`);
    const existing = fs.existsSync(metaFile)
      ? JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
      : {};
    fs.writeFileSync(metaFile, JSON.stringify({ ...existing, ...data }, null, 2), 'utf-8');
  } catch (_) { /* best effort */ }
}

const CALLBACK_LOG_MAX_LENGTH = 10_000;
const CALLBACK_LOG_HEAD_LENGTH = 5_000;
// admin CallbackItemDto caps errorMessage at 4096 — a longer value makes the
// DTO validation reject the WHOLE batch (now ≤100 items), so clamp it here.
const CALLBACK_ERROR_MESSAGE_MAX_LENGTH = 4000;

function truncateCallbackLogs(logs?: string): string | undefined {
  if (typeof logs !== 'string' || logs.length <= CALLBACK_LOG_MAX_LENGTH) {
    return logs;
  }

  const marker = `\n... [logs truncated, original length ${logs.length} chars] ...\n`;
  const tailLength = Math.max(CALLBACK_LOG_MAX_LENGTH - CALLBACK_LOG_HEAD_LENGTH - marker.length, 0);
  return `${logs.slice(0, CALLBACK_LOG_HEAD_LENGTH)}${marker}${tailLength > 0 ? logs.slice(-tailLength) : ''}`;
}

export function truncateCallbackErrorMessage(message?: string): string | undefined {
  if (typeof message !== 'string' || message.length <= CALLBACK_ERROR_MESSAGE_MAX_LENGTH) {
    return message;
  }
  return `${message.slice(0, CALLBACK_ERROR_MESSAGE_MAX_LENGTH)}... [error message truncated]`;
}

const LOG_HEAD_LIMIT = 500_000;
const LOG_TAIL_LIMIT = 500_000;

/** Bounded in-memory log accumulator: keeps the first and last ~500KB of
 *  output. Without a cap a single `while(true) console.log(...)` task grows
 *  the string unbounded and OOMs the whole executor (all concurrent tasks
 *  die with it). The full output is already on disk for LOG-01 backfill. */
export class BoundedLogBuffer {
  private head = '';
  private tail = '';
  private truncated = false;
  private total = 0;

  append(chunk: string): void {
    this.total += chunk.length;
    if (this.head.length < LOG_HEAD_LIMIT) {
      const space = LOG_HEAD_LIMIT - this.head.length;
      this.head += chunk.slice(0, space);
      const rest = chunk.slice(space);
      if (rest) this.pushTail(rest);
    } else {
      this.pushTail(chunk);
    }
  }

  private pushTail(chunk: string): void {
    this.tail += chunk;
    if (this.tail.length > LOG_TAIL_LIMIT) {
      this.tail = this.tail.slice(this.tail.length - LOG_TAIL_LIMIT);
      this.truncated = true;
    }
  }

  toString(): string {
    if (this.tail.length === 0) return this.head;
    if (!this.truncated) return this.head + this.tail;
    const marker = `\n... [log output truncated in memory, ${this.total} chars total, full output on disk] ...\n`;
    return `${this.head}${marker}${this.tail}`;
  }
}

/** Live task child processes keyed by executionId — lets graceful shutdown
 *  kill detached process groups instead of orphaning them on exit, and lets
 *  the kill endpoint (改动1) find the process tree of one execution. */
const runningTaskProcesses = new Map<string, ChildProcess>();

/** Kill every running task's process group (POSIX) / process (win32).
 *  Called when the executor's graceful-shutdown grace period expires so
 *  detached children don't outlive the executor as unmanaged orphans. */
export function killRunningTaskProcesses(signal: NodeJS.Signals = 'SIGKILL'): number {
  let killed = 0;
  for (const [key, proc] of runningTaskProcesses) {
    runningTaskProcesses.delete(key);
    if (!proc.pid) continue;
    try {
      // W-03: delegate to killProcessTree for parity — on win32 it uses
      // taskkill /T /F so a timed-out task's grandchildren are reaped too,
      // matching the POSIX negative-pid group kill.
      killProcessTree(proc, signal);
      killed++;
    } catch (_) {
      /* already dead */
    }
  }
  return killed;
}

/** FEAT-05: 终态回调前收集/上传产物清单，best-effort——任何异常只记日志返回 undefined。 */
async function collectTerminalArtifacts(
  executionId: string,
  workDir: string,
): Promise<ArtifactManifestEntry[] | undefined> {
  try {
    const token = await getCurrentToken();
    const manifest = await gatherArtifacts(
      executionId,
      workDir,
      getCurrentAdminUrl(),
      token ?? null,
    );
    return manifest.length ? manifest : undefined;
  } catch (e) {
    logger.warn(`artifacts: 终态收集异常（忽略，不阻塞回调）: ${String(e)}`);
    return undefined;
  }
}

export async function runTask(task: any, params: Record<string, any>, executionId: string): Promise<void> {
  // 8-1（audit-r4）：执行链 trace context 注入。traceparent 的 trace-id 段
  // （W3C 格式 traceparent: <trace-id>-<parent-id>-<flags>）写入 AsyncLocalStorage，
  // 链内所有 logger.* 自动带 `[trace=...]`——执行器内部日志可按 trace 与回调
  // 回传的 traceparent 头、admin 侧关联（OBS-01 同源）。
  const traceId = liveExecutions.get(executionId)?.traceparent?.split('-')[1];
  if (!traceId) {
    return runTaskInner(task, params, executionId);
  }
  return runWithTrace({ traceId }, () => runTaskInner(task, params, executionId));
}

async function runTaskInner(task: any, params: Record<string, any>, executionId: string): Promise<void> {
  const { cmd, args, workDir, env, timeout } = task;
  const startTime = Date.now();

  // Write start metadata
  writeExecMeta(executionId, {
    executionId,
    taskId: String(task.id || ''),
    taskName: String(task.name || task.id || executionId),
    startTime,
    status: 'running',
  });

  try {
    const result = await runProcess(cmd, args, workDir, env, timeout, executionId);

    writeExecMeta(executionId, {
      status: 'success',
      endTime: Date.now(),
      exitCode: result.exitCode,
    });

    pushCallback({
      executionId,
      status: 'success',
      exitCode: result.exitCode,
      logs: truncateCallbackLogs(result.logs),
      durationMs: Date.now() - startTime,
      artifacts: await collectTerminalArtifacts(executionId, workDir),
      ...(liveExecutions.get(executionId)?.traceparent
        ? { traceparent: liveExecutions.get(executionId)!.traceparent }
        : {}),
    });
  } catch (err: unknown) {
    // Extract structured fields attached by the close handler; fall back for plain errors
    const processErr = err as any;
    const message = err instanceof Error ? err.message : String(err);
    const logs: string | undefined = typeof processErr?.logs === 'string' ? processErr.logs : undefined;
    const exitCode: number | undefined = typeof processErr?.exitCode === 'number' ? processErr.exitCode : undefined;
    // 改动1：kill 端点已下达终止指令——失败回调标记 failureReason=killed
    // （与 admin 侧 ExecutionFailureReason.KILLED 对齐）。
    const killed = liveExecutions.get(executionId)?.killedByRequest === true;

    writeExecMeta(executionId, {
      status: 'failed',
      endTime: Date.now(),
      exitCode,
      errorMessage: message,
    });

    pushCallback({
      executionId,
      status: 'failed',
      exitCode,
      logs: truncateCallbackLogs(logs),
      errorMessage: truncateCallbackErrorMessage(killed ? 'Task process tree killed by admin request' : message),
      ...(killed ? { failureReason: 'killed' as CallbackFailureReason } : {}),
      durationMs: Date.now() - startTime,
      artifacts: await collectTerminalArtifacts(executionId, workDir),
      ...(liveExecutions.get(executionId)?.traceparent
        ? { traceparent: liveExecutions.get(executionId)!.traceparent }
        : {}),
    });
  }
}

/**
 * 4-3（audit-r4 F-1 parity）：TASK_SANDBOX=bwrap 时把任务 argv 包进
 * bubblewrap——`--die-with-parent --unshare-all --share-net --ro-bind / /
 * --bind <cwd> <cwd> --tmpfs /tmp --proc /proc --dev /dev --chdir <cwd>`，
 * 与 executor-python sandbox.py::build_sandbox_cmd 逐字同构：宿主根文件系统
 * 只读（任务无法篡改解释器池/执行器文件）、user ns 隔离、仅工作目录可写、
 * `--share-net` 保持外网（任务本质是自动化脚本，断网即废——网络隔离语义与
 * python 侧一致）。**fail-closed 纪律**：配置了 bwrap 但 bwrap 二进制缺失或
 * 平台非 Linux → 抛错拒绝任务，绝不静默降级为直跑（python 侧 SandboxUnavailable
 * 同语义）。仅检查二进制存在性（同 python）；user namespace 被内核禁用属
 * 运行时失败，由 bwrap 非零退出 → 任务失败（fail-closed 自然达成）。
 */
function buildTaskSandboxArgv(
  cmd: string,
  args: string[],
  cwd: string,
): { cmd: string; args: string[] } {
  if (config.taskSandbox !== 'bwrap') {
    return { cmd, args };
  }
  if (process.platform === 'win32') {
    throw new Error(
      'TASK_SANDBOX=bwrap is not supported on Windows; unset TASK_SANDBOX to run tasks unsandboxed',
    );
  }
  let bwrapPath = '';
  try {
    const which = spawnSync('which', ['bwrap'], { encoding: 'utf8', timeout: 3000 });
    if (which.status === 0 && which.stdout) {
      bwrapPath = which.stdout.trim().split(/\r?\n/)[0] || '';
    }
  } catch {
    bwrapPath = '';
  }
  if (!bwrapPath) {
    throw new Error(
      'TASK_SANDBOX=bwrap is configured but the bwrap binary is not on PATH; ' +
        'install bubblewrap or unset TASK_SANDBOX (fail-closed, no sandbox downgrade)',
    );
  }
  return {
    cmd: bwrapPath,
    args: [
      '--die-with-parent',
      '--unshare-all',
      '--share-net',
      '--ro-bind', '/', '/',
      '--bind', cwd, cwd,
      '--tmpfs', '/tmp',
      '--proc', '/proc',
      '--dev', '/dev',
      '--chdir', cwd,
      '--',
      cmd,
      ...args,
    ],
  };
}

function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutSec: number,
  executionId?: string,
): Promise<{ success: boolean; logs: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    // 4-3（audit-r4 F-1 parity）：沙箱 argv 解析在 spawn 之前完成，fail-closed
    // ——bwrap 缺失/平台不支持时拒绝任务，不进入 spawn。
    let argvSpec: { cmd: string; args: string[] };
    try {
      argvSpec = buildTaskSandboxArgv(cmd, args, cwd);
    } catch (sandboxErr) {
      reject(sandboxErr instanceof Error ? sandboxErr : new Error(String(sandboxErr)));
      return;
    }
    // W-14 (windows-findings R-08/2.9): on win32 the child must NOT share the
    // executor's console — a console Ctrl+C/CTRL_BREAK event is delivered to
    // every attached process, hard-killing running tasks instantly (0xC000013A)
    // and bypassing gracefulShutdown's drain + killRunningTaskProcesses tree
    // kill entirely, which orphaned the tasks' own detached grandchildren.
    // windowsHide gives the child its own hidden console (CREATE_NO_WINDOW);
    // reaping stays with the executor (timeout taskkill /T /F, P-7).
    // L-3：POSIX 下把最终 argv 包一层 sh+ulimit（NOFILE/CPU）；win32 原样返回。
    // 必须在 bwrap 包装之后再包——ulimit 沿 sh → bwrap → 任务树继承。
    const rlimitArgv = applyTaskRlimits(argvSpec.cmd, argvSpec.args, timeoutSec);
    const proc = spawn(rlimitArgv.cmd, rlimitArgv.args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    // W-24 (windows-findings): when spawn fails on Windows (ENOENT — bad
    // executable, unreadable/oversized cwd e.g. >260-char WORK_DIR without
    // LongPathsEnabled), node fires 'error' on the half-open stdio SOCKETS in
    // addition to the ChildProcess 'error' handler below. An unhandled socket
    // error is an uncaughtException that KILLS THE WHOLE EXECUTOR (observed:
    // one task crash took down every running task). No-op guards here route
    // the failure into the proc-level handler; the task fails, the executor
    // lives.
    proc.stdout?.on('error', () => { /* surfaced via proc 'error' event */ });
    proc.stderr?.on('error', () => { /* surfaced via proc 'error' event */ });
    // Bounded accumulator — an unbounded `logs += output` OOMs the executor
    // on chatty tasks (memory peaks before the 10k callback truncation).
    const logBuffer = new BoundedLogBuffer();
    // Guard against close firing after timeout has already rejected the promise
    let settled = false;

    if (proc.pid !== undefined) {
      runningTaskProcesses.set(executionId ?? `pid-${proc.pid}`, proc);
    }

    proc.stdout.on('data', (d: Buffer) => {
      const output = d.toString();
      logBuffer.append(output);
      if (executionId) appendLog(executionId, output);
    });
    proc.stderr.on('data', (d: Buffer) => {
      const output = d.toString();
      logBuffer.append(output);
      if (executionId) appendLog(executionId, output);
    });

    const unregister = () => {
      if (proc.pid !== undefined) {
        runningTaskProcesses.delete(executionId ?? `pid-${proc.pid}`);
      }
    };

    // 改动4：timeoutSec=0/Infinity → 不限时，不挂 kill 定时器（setTimeout
    // 传 Infinity 会溢出为立即触发）。
    const timer = timeoutSec && Number.isFinite(timeoutSec)
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          if (stopMemoryWatchdog) {
            stopMemoryWatchdog();
            stopMemoryWatchdog = null;
          }
          // B-06: kill the entire process group so child processes spawned by the task are also terminated
          killProcessTree(proc, 'SIGKILL');
          // Attach collected logs like the close path does — otherwise the
          // failure callback carries no logs and the admin-side full-log
          // backfill (LOG-01) never triggers.
          const timeoutErr = new Error(`Task timeout after ${timeoutSec}s`) as Error & { logs: string };
          timeoutErr.logs = logBuffer.toString();
          reject(timeoutErr);
        }, timeoutSec * 1000)
      : null;

    // 4-2（audit-r4）：任务内存看门狗（默认 2048MB；TASK_MEMORY_LIMIT_MB=0
    // 关闭）。node 侧无 RLIMIT 等价物，用 RSS 周期采样 + 超限树杀达成
    // 「失控任务不能 OOM 宿主」的防护（python 侧 RLIMIT_AS 同量级）。采样
    // 器按平台选：Linux /proc 进程树求和（含孙进程），Windows tasklist 直系
    // 子进程（best-effort，模块注释已文档化）。超限回调与 close/timeout 共用
    // settled 守卫：先 settle + 停看门狗 + 树杀 + 附日志 reject，绝不双发。
    let stopMemoryWatchdog: (() => void) | null = null;
    if (proc.pid !== undefined && config.taskMemoryLimitMb > 0) {
      stopMemoryWatchdog = startMemoryWatchdog({
        pid: proc.pid,
        limitMb: config.taskMemoryLimitMb,
        sampler: process.platform === 'win32' ? winTasklistSampler : linuxProcTreeSampler,
        intervalMs: config.taskMemoryWatchdogIntervalMs,
        onExceed: () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (stopMemoryWatchdog) {
            stopMemoryWatchdog();
            stopMemoryWatchdog = null;
          }
          killProcessTree(proc, 'SIGKILL');
          unregister();
          const memErr = new Error(
            `Task exceeded memory limit of ${config.taskMemoryLimitMb}MB`,
          ) as Error & { logs: string };
          memErr.logs = logBuffer.toString();
          reject(memErr);
        },
      });
    }

    proc.on('close', (code: number | null) => {
      if (timer) clearTimeout(timer);
      if (stopMemoryWatchdog) {
        stopMemoryWatchdog();
        stopMemoryWatchdog = null;
      }
      unregister();
      if (settled) return;
      settled = true;
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        // Attach logs and exitCode as properties so callers can surface them independently
        const err = new Error(`Process exited with code ${exitCode}`) as Error & { logs: string; exitCode: number };
        (err as any).logs = logBuffer.toString();
        (err as any).exitCode = exitCode;
        reject(err);
      } else {
        resolve({ success: true, logs: logBuffer.toString(), exitCode });
      }
    });

    proc.on('error', (err: Error) => {
      if (timer) clearTimeout(timer);
      if (stopMemoryWatchdog) {
        stopMemoryWatchdog();
        stopMemoryWatchdog = null;
      }
      unregister();
      if (settled) return;
      settled = true;
      // W-24: surface spawn failures (ENOENT on Windows from an unreachable
      // cwd, incl. >260-char WORK_DIR without LongPathsEnabled) with a hint
      // pointing at the most likely cause + the OS toggle, instead of a bare
      // code.
      const hint =
        err && (err as NodeJS.ErrnoException).code === 'ENOENT' && cwd && cwd.length > 259
          ? ' (cwd path exceeds Windows MAX_PATH (260) — enable LongPathsEnabled ' +
            'or shorten WORK_DIR)'
          : '';
      (err as Error & { logs?: string; exitCode?: number }).logs = logBuffer.toString();
      (err as Error & { exitCode?: number }).exitCode = -1;
      reject(new Error(`${err.message}${hint}`));
    });
  });
}
