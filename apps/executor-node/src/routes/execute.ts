import { Router, Request, Response } from 'express';
import { spawn, ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { config } from '../config';
import { logger } from '../logger';
import {
  getRunningCountArray,
  registerRunningExecutionIdsProvider,
  registerDeadLetterCountProvider,
} from '../scheduler';
import { loadManifest, mergeTaskWithManifest } from '../manifest';
import { pushCallback, CallbackFailureReason } from '../callback';
import { appendLog, getDeadLetterCount } from '../file-logger';
import { taskWorkerManager, ExecutionCancelledError } from '../task-worker';
import { runCommand, killProcessTree } from '../run-command';
import { buildChildEnv } from '../env-whitelist';
import {
  createExecutionCallbackToken,
  CALLBACK_TOKEN_GRACE_SECONDS,
} from '../execution-callback-token';

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
      const r = await runCommand('git', ['clone', '--bare', repoUrl, cacheDir], { timeout: 120_000, signal });
      if (signal?.aborted) throw new ExecutionCancelledError(dest);
      if (r.status !== 0) {
        fs.rmSync(cacheDir, { recursive: true, force: true });
        throw new Error(`git clone failed: ${r.stderr.trim()}`);
      }
    } else {
      const r = await runCommand('git', ['-C', cacheDir, 'fetch', '--all'], { timeout: 60_000, signal });
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

interface ExecuteRequest {
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
function isSafeExecutionIdSegment(id: string): boolean {
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

// STALE-01: 心跳上报本机运行中的 executionId 与死信积压。scheduler 不能反向
// import routes（会成环），故由数据属主在此注册 provider。
registerRunningExecutionIdsProvider(listActiveExecutionIds);
registerDeadLetterCountProvider(getDeadLetterCount);

// ---------------------------------------------------------------------------
// POST /execute — 只做参数校验 + 并发预检 + 登记，prepare/spawn 全部进入
// 后台（改动2）。同步 prepare 时 clone(120s)+fetch(60s)+install(300s) 会
// 超过 admin 侧 dispatch HTTP 超时（(task.timeout+10)s），导致 admin 把
// 超时误判为 TIMEOUT 终态而执行器随后成功回调被丢弃、容量计数失真。
// ---------------------------------------------------------------------------
executeRouter.post('/execute', (req: Request, res: Response) => {
  // BUG-03: Use atomic operations to prevent race conditions in capacity checking
  // Atomically increment counter first, then check if over capacity
  const current = Atomics.add(getRunningCountArray(), 0, 1);
  if (current >= config.maxConcurrentTasks) {
    Atomics.sub(getRunningCountArray(), 0, 1);
    res.status(429).json({ error: 'Executor is at capacity' });
    return;
  }

  let entry: ExecutionEntry | null = null;
  /** 同步拒绝路径：释放容量（幂等）。 */
  const reject = (status: number, error: string) => {
    if (entry) entry.release();
    else Atomics.sub(getRunningCountArray(), 0, 1);
    res.status(status).json({ error });
  };

  try {
    const body = req.body as ExecuteRequest;
    const executionId = body?.executionId;
    const params = body?.params;

    if (!executionId || !body.task) {
      reject(400, 'executionId and task are required');
      return;
    }
    if (!isSafeExecutionIdSegment(executionId)) {
      reject(400, 'Invalid executionId: path traversal detected');
      return;
    }
    // 重复领取守卫：同一 execution 仍在运行（含排队）时不得二次领取——
    // 二次 Atomics.add 与首个并发路径叠加会失真/双释放。
    if (liveExecutions.has(executionId)) {
      reject(400, `Execution ${executionId} is already active on this executor`);
      return;
    }

    const workDir = path.join(config.workDir, executionId);
    const guardError = validateExecutionWorkDir(workDir, config.workDir);
    if (guardError) {
      reject(400, guardError);
      return;
    }

    // 廉价同步校验（纯字符串检查，防注入/防误配置，语义与原实现一致）：
    // 后台化后若仍走失败回调，admin 侧 execution 尚未置 running 会丢弃回调，
    // 留下永久僵尸行——必须保持同步 4xx。
    const gitRepo = body.task.gitRepo;
    if (gitRepo) {
      // S7: SSRF guard — only allow http(s) and ssh git URLs; reject file:// and others
      const allowedGitPattern = /^(https?:\/\/|git@|ssh:\/\/)/i;
      if (!allowedGitPattern.test(gitRepo)) {
        reject(400, `gitRepo URL scheme not allowed: ${gitRepo}`);
        return;
      }
      // S7: SSRF guard — block private IP addresses and localhost
      const privateIpPattern = /(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.1[6-9]\.\d{1,3}\.\d{1,3}|172\.2[0-9]\.\d{1,3}\.\d{1,3}|172\.3[0-1]\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3})/i;
      if (privateIpPattern.test(gitRepo)) {
        reject(400, `gitRepo URL contains restricted address: ${gitRepo}`);
        return;
      }
      const ref = (body.task.gitCommit || body.task.gitBranch || 'main') as string;
      // git checkout uses array args (no shell injection), but an option-like
      // ref (`-b`, `--orphan`) would still be parsed as a flag by git — same
      // guard deploy.ts applies to its checkout path.
      if (/^-/.test(ref)) {
        reject(400, `Invalid git ref: ${ref}`);
        return;
      }
    }
    // S16: validate each package name against npm naming rules before any
    // shell expansion (install itself now runs in the background).
    const reqs: string[] = (body.task.requirements as string[]) || [];
    const npmNameRe = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[\w.^~-]+)?$/i;
    for (const pkg of reqs) {
      if (!npmNameRe.test(pkg)) {
        reject(400, `Invalid npm package name: ${pkg}`);
        return;
      }
    }
    // timeout=0 表示不限时（admin 侧 task.entity/scheduler 语义，改动4）——
    // 仅 null/undefined 才回退默认值；越界与非数值保持原 400 语义。
    const rawTimeout = body.task.timeout;
    const timeout = rawTimeout === 0 ? 0 : (rawTimeout as number) || config.taskTimeoutSeconds;
    if (timeout !== 0 && (!Number.isFinite(timeout) || timeout < 1 || timeout > 86_400)) {
      reject(400, `Invalid task timeout: ${timeout} (expected 0 (unbounded) or 1..86400 seconds)`);
      return;
    }
    // Glue 语言的字符串校验是同步 400 语义（与原实现一致），语言支持性判定
    // 依赖 runtime（可能被 manifest 覆盖），留在后台 prepare。
    const glueSource = (body.task.glueSource as string | undefined) || (body.task.glue_source as string | undefined);
    if (glueSource !== undefined && typeof glueSource !== 'string') {
      reject(400, 'glueSource must be a string');
      return;
    }

    // 登记 + 立即 accepted。prepare（clone/checkout、依赖安装）与 spawn
    // 在后台执行（经 worker 按 taskId 串行，见 dispatch）。
    entry = createExecutionEntry(executionId, String(body.task.id || executionId));
    liveExecutions.set(executionId, entry);

    void startExecutionInBackground(executionId, body, params, entry);

    // 响应体与旧实现逐字一致——admin 对 2xx 的处理不变。
    res.json({ status: 'accepted', executionId });
  } catch (err) {
    // Express 4 does not await async handlers: a synchronous throw below the
    // capacity reservation must not hang the request or leak the slot.
    if (!res.headersSent) {
      reject(500, err instanceof Error ? err.message : 'Internal executor error');
    }
  }
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
 *  导出供测试固化该映射。 */
export function prepareFailureReason(message: string): CallbackFailureReason {
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
  return 'unknown';
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

  // Load manifest.yaml and merge with task (task fields take priority)
  const manifest = loadManifest(workDir);
  const task = mergeTaskWithManifest(body.task as Record<string, unknown>, manifest);

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
    if (config.npmRegistryUrl) {
      const npmrc = path.join(nodeModulesDir, '.npmrc');
      fs.writeFileSync(npmrc, buildNpmRcContent(config.npmRegistryUrl, config.npmRegistryToken, actualRequirements));
      logger.info(`Using npm registry: ${redactUrl(config.npmRegistryUrl)} for task ${taskId}`);
    }
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const installResult = await queueTaskInstall(
      taskId,
      async () => {
        if (entry.aborted) throw new ExecutionCancelledError(executionId);
        return runCommand(
          npmCmd,
          ['install', '--prefix', nodeModulesDir, ...actualRequirements],
          { timeout: 300_000, shell: process.platform === 'win32', signal },
        );
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
  const adminApiUrl = config.adminApiUrlInternal || config.adminApiUrl;
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

  let cmd: string;
  let args: string[];

  if (actualRuntime === 'node') {
    cmd = process.platform === 'win32' ? 'node.exe' : 'node';
    args = [actualEntrypoint];
  } else if (actualRuntime === 'python') {
    cmd = process.platform === 'win32' ? 'python.exe' : 'python3';
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

// ---------------------------------------------------------------------------
// POST /executions/:executionId/kill — 改动1：admin 的 killExecution 此前只
// 改 DB，被 kill 的任务在本执行器上继续跑完。这里按运行中注册表终止进程树
// （或中止 prepare 阶段），幂等释放并发槽，回调照常走失败路径
// （failureReason=killed）。
// ---------------------------------------------------------------------------
executeRouter.post('/executions/:executionId/kill', (req: Request, res: Response) => {
  const { executionId } = req.params;
  const entry = liveExecutions.get(executionId);
  if (!entry) {
    // 不在运行表中（从未领取 / 已结束 / 已清理）
    res.status(404).json({ ok: false });
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
    res.json({ ok: true });
    return;
  }
  if (taskWorkerManager.cancelExecution(entry.taskId, executionId)) {
    // 已从 worker 队列摘除（尚未到点）：onComplete 不会再被触发，这里收尾。
    entry.cancelled = true;
    finalizeKilled();
    res.json({ ok: true });
    return;
  }
  if (entry.workerFinished) {
    // 恰在 kill 到达前自然结束：仍按 200 返回（admin 侧已是终态，回调被忽略）。
    res.json({ ok: true });
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
  res.json({ ok: true });
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

function truncateCallbackErrorMessage(message?: string): string | undefined {
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

export async function runTask(task: any, params: Record<string, any>, executionId: string): Promise<void> {
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
    });
  }
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
    // W-14 (windows-findings R-08/2.9): on win32 the child must NOT share the
    // executor's console — a console Ctrl+C/CTRL_BREAK event is delivered to
    // every attached process, hard-killing running tasks instantly (0xC000013A)
    // and bypassing gracefulShutdown's drain + killRunningTaskProcesses tree
    // kill entirely, which orphaned the tasks' own detached grandchildren.
    // windowsHide gives the child its own hidden console (CREATE_NO_WINDOW);
    // reaping stays with the executor (timeout taskkill /T /F, P-7).
    const proc = spawn(cmd, args, {
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

    proc.on('close', (code: number | null) => {
      if (timer) clearTimeout(timer);
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
