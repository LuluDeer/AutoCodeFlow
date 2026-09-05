import { Router, Request, Response } from 'express';
import { spawn, ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { config } from '../config';
import { logger } from '../logger';
import { getRunningCountArray } from '../scheduler';
import { loadManifest, mergeTaskWithManifest } from '../manifest';
import { pushCallback } from '../callback';
import { appendLog } from '../file-logger';
import { taskWorkerManager } from '../task-worker';
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

export async function gitCheckoutTo(repoUrl: string, ref: string, dest: string): Promise<void> {
  const cacheDir = path.join(config.workDir, '.git_cache', repoDirName(repoUrl));
  await queueGitCheckout(cacheDir, async () => {
    if (fs.existsSync(cacheDir) && !(await isBareGitRepo(cacheDir))) {
      logger.warn(`[git] cache ${cacheDir} is not a valid bare repo (killed clone?) — quarantining and re-cloning`);
      quarantineBrokenCache(cacheDir);
    }
    if (!fs.existsSync(path.join(cacheDir, 'HEAD'))) {
      fs.mkdirSync(cacheDir, { recursive: true });
      const r = await runCommand('git', ['clone', '--bare', repoUrl, cacheDir], { timeout: 120_000 });
      if (r.status !== 0) {
        fs.rmSync(cacheDir, { recursive: true, force: true });
        throw new Error(`git clone failed: ${r.stderr.trim()}`);
      }
    } else {
      const r = await runCommand('git', ['-C', cacheDir, 'fetch', '--all'], { timeout: 60_000 });
      if (r.status !== 0) {
        // Continuing with a stale cache made tasks silently run old code.
        throw new Error(`git fetch failed: ${r.stderr.trim()}`);
      }
    }
    fs.mkdirSync(dest, { recursive: true });
    const r = await runCommand(
      'git',
      [`--git-dir=${cacheDir}`, `--work-tree=${dest}`, 'checkout', ref, '--', '.'],
      { timeout: 30_000 },
    );
    if (r.status !== 0) throw new Error(`git checkout failed: ${r.stderr.trim()}`);
  });
}

const taskInstallQueues = new Map<string, Promise<unknown>>();

/** Serialize dependency installs per task id — concurrent requests for the
 *  same task would race on the shared .node_modules/<taskId> directory. */
function queueTaskInstall<T>(taskId: string, job: () => Promise<T>): Promise<T> {
  const prev = taskInstallQueues.get(taskId) ?? Promise.resolve();
  const run = prev.then(job, job);
  const tail = run.then(() => undefined, () => undefined);
  taskInstallQueues.set(taskId, tail);
  tail.finally(() => {
    if (taskInstallQueues.get(taskId) === tail) taskInstallQueues.delete(taskId);
  });
  return run;
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

executeRouter.post('/execute', async (req: Request, res: Response) => {
  // BUG-03: Use atomic operations to prevent race conditions in capacity checking
  // Atomically increment counter first, then check if over capacity
  const current = Atomics.add(getRunningCountArray(), 0, 1);
  if (current >= config.maxConcurrentTasks) {
    Atomics.sub(getRunningCountArray(), 0, 1);
    res.status(429).json({ error: 'Executor is at capacity' });
    return;
  }

  // Helper function to release capacity exactly once for synchronous rejection paths.
  const releaseCapacity = () => {
    Atomics.sub(getRunningCountArray(), 0, 1);
  };

  const sendError = (status: number, error: string) => {
    releaseCapacity();
    res.status(status).json({ error });
  };

  // Set once the task is queued — after that the worker's onComplete owns
  // the capacity slot and the outer catch must not double-release it.
  let handedOff = false;
  try {
  const body = req.body as ExecuteRequest;
  const { executionId, params } = body;

  if (!executionId || !body.task) {
    sendError(400, 'executionId and task are required');
    return;
  }

  const workDir = path.join(config.workDir, executionId);
  // S6/Q11: path traversal guard — ensure workDir stays within configured base
  const resolvedWorkDir = path.resolve(workDir);
  const resolvedBase = path.resolve(config.workDir);
  if (!resolvedWorkDir.startsWith(resolvedBase + path.sep) && resolvedWorkDir !== resolvedBase) {
    sendError(400, 'Invalid executionId: path traversal detected');
    return;
  }

  // SEC-04: Check for symbolic link attacks
  try {
    // Check if the base directory exists and is not a symlink
    const baseStats = fs.lstatSync(resolvedBase);
    if (baseStats.isSymbolicLink()) {
      sendError(400, 'Base work directory cannot be a symbolic link');
      return;
    }

    // If workDir already exists, check if it's a symlink
    if (fs.existsSync(resolvedWorkDir)) {
      const workDirStats = fs.lstatSync(resolvedWorkDir);
      if (workDirStats.isSymbolicLink()) {
        sendError(400, 'Work directory cannot be a symbolic link');
        return;
      }

      // Check the real path to prevent symlink escape
      const realWorkDir = fs.realpathSync(resolvedWorkDir);
      const realBase = fs.realpathSync(resolvedBase);
      if (!realWorkDir.startsWith(realBase + path.sep) && realWorkDir !== realBase) {
        sendError(400, 'Symbolic link escape detected');
        return;
      }
    }
  } catch (err) {
    sendError(400, `Path validation failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    return;
  }

  fs.mkdirSync(workDir, { recursive: true });
  // S6/Q11: restrict permissions so sibling tasks cannot read this directory
  try { fs.chmodSync(workDir, 0o700); } catch (_) { /* ignore on unsupported filesystems */ }

  // --- Git version binding: if task specifies gitRepo, clone/checkout to work dir ---
  const gitRepo = body.task.gitRepo;
  const gitCommit = body.task.gitCommit;
  const gitBranch = body.task.gitBranch ?? 'main';
  if (gitRepo) {
    // S7: SSRF guard — only allow http(s) and ssh git URLs; reject file:// and others
    const allowedGitPattern = /^(https?:\/\/|git@|ssh:\/\/)/i;
    if (!allowedGitPattern.test(gitRepo)) {
      sendError(400, `gitRepo URL scheme not allowed: ${gitRepo}`);
      return;
    }

    // S7: SSRF guard — block private IP addresses and localhost
    const privateIpPattern = /(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.1[6-9]\.\d{1,3}\.\d{1,3}|172\.2[0-9]\.\d{1,3}\.\d{1,3}|172\.3[0-1]\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3})/i;
    if (privateIpPattern.test(gitRepo)) {
      sendError(400, `gitRepo URL contains restricted address: ${gitRepo}`);
      return;
    }

    const ref = gitCommit || gitBranch;
    // git checkout uses array args (no shell injection), but an option-like
    // ref (`-b`, `--orphan`) would still be parsed as a flag by git — same
    // guard deploy.ts applies to its checkout path.
    if (/^-/.test(ref)) {
      sendError(400, `Invalid git ref: ${ref}`);
      return;
    }
    logger.info(`Checking out ${redactUrl(gitRepo)}@${ref} to ${workDir}`);
    try {
      await gitCheckoutTo(gitRepo, ref, workDir);
    } catch (err) {
      sendError(500, err instanceof Error ? err.message : 'Git checkout failed');
      return;
    }
  }

  // Load manifest.yaml and merge with task (task fields take priority)
  const manifest = loadManifest(workDir);
  const task = mergeTaskWithManifest(body.task as Record<string, unknown>, manifest);

  const runtime = (task.runtime as string) || 'node';
  const entrypoint = (task.entrypoint as string) || 'index.js';
  const timeout = (task.timeout as number) || config.taskTimeoutSeconds;
  // Bounded timeout: a negative value fires setTimeout immediately (instant
  // task kill) and an unbounded one arms a near-permanent timer.
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 86_400) {
    sendError(400, `Invalid task timeout: ${timeout} (expected 1..86400 seconds)`);
    return;
  }
  const requirements: string[] = (task.requirements as string[]) || [];
  const taskId = String(task.id || executionId);

  // Glue script support: write inline source to a temp file and use it as entrypoint
  let actualRuntime = runtime;
  let actualEntrypoint = entrypoint;
  let actualRequirements = requirements;
  const glueSource = (task.glueSource as string | undefined) || (task.glue_source as string | undefined);
  const glueLanguage = (task.glueLanguage as string | undefined) || (task.glue_language as string | undefined);
  if (glueSource) {
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
      sendError(400, `Unsupported glue language: ${glueLanguage}`);
      return;
    }

    if (typeof glueSource !== 'string') {
      sendError(400, 'glueSource must be a string');
      return;
    }
    fs.writeFileSync(glueFile, glueSource, 'utf-8');
    fs.chmodSync(glueFile, 0o755);
    logger.info(`Glue script written to ${glueFile} (${glueSource.length} bytes)`);
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
    // S16: validate each package name against npm naming rules before shell expansion
    const npmNameRe = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[\w.^~-]+)?$/i;
    for (const pkg of actualRequirements) {
      if (!npmNameRe.test(pkg)) {
        sendError(400, `Invalid npm package name: ${pkg}`);
        return;
      }
    }
    logger.info(`Installing ${actualRequirements.length} packages for task ${taskId}`);
    // Generate .npmrc to use private registry for @autocodeflow scoped packages
    if (config.npmRegistryUrl) {
      const npmrc = path.join(nodeModulesDir, '.npmrc');
      const hasAutoflowPackage = actualRequirements.some(pkg => pkg.startsWith('@autocodeflow/'));
      const registryConfig = hasAutoflowPackage
        ? `@autocodeflow:registry=${config.npmRegistryUrl}\n`
        : `registry=${config.npmRegistryUrl}\n`;
      fs.writeFileSync(npmrc, registryConfig);
      logger.info(`Using npm registry: ${redactUrl(config.npmRegistryUrl)} for task ${taskId}`);
    }
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const installResult = await queueTaskInstall(taskId, () =>
      runCommand(
        npmCmd,
        ['install', '--prefix', nodeModulesDir, ...actualRequirements],
        { timeout: 300_000, shell: process.platform === 'win32' },
      ),
    );
    if (installResult.status !== 0) {
      const errMsg = installResult.stderr.trim() || 'npm install failed';
      sendError(500, `Dependency installation failed: ${errMsg}`);
      return;
    }
  }

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
    timeout + CALLBACK_TOKEN_GRACE_SECONDS,
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
    sendError(400, `Unsupported runtime: ${actualRuntime}`);
    return;
  }

  // Hardening: the entrypoint is resolved against the work dir by every
  // runtime (cwd=workDir), so a relative path with `..` could execute a
  // script anywhere on the host. Glue scripts use absolute paths that are
  // already inside the work dir and pass this guard unchanged.
  const entryAbs = path.resolve(workDir, actualEntrypoint);
  const workDirAbs = path.resolve(workDir);
  if (entryAbs !== workDirAbs && !entryAbs.startsWith(workDirAbs + path.sep)) {
    sendError(400, 'entrypoint escapes the task work directory');
    return;
  }

  logger.info(`Running task ${String(task.name)} [${executionId}]: ${cmd} ${args.join(' ')}`);

  const taskInfo = {
    taskId,
    task: { ...task, runtime: actualRuntime, entrypoint: actualEntrypoint, timeout, workDir, env, cmd, args },
    params,
    executionId,
  };

  try {
    taskWorkerManager.execute(taskId, executionId, taskInfo.task, { ...params, executionId }, () => {
      releaseCapacity();
    });
    handedOff = true;
  } catch (err) {
    releaseCapacity();
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to enqueue task' });
    return;
  }

  res.json({ status: 'accepted', executionId });
  } catch (err) {
    // Express 4 does not await async handlers: a synchronous throw below the
    // capacity reservation (mkdirSync, writeFileSync, manifest parse, …)
    // would hang the request forever and leak the reserved slot.
    if (handedOff) {
      // The worker's onComplete owns the capacity slot from here on.
      logger.error(`Post-enqueue error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!res.headersSent) {
      sendError(500, err instanceof Error ? err.message : 'Internal executor error');
    }
  }
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
 *  kill detached process groups instead of orphaning them on exit. */
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
      errorMessage: truncateCallbackErrorMessage(message),
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

    const timer = setTimeout(() => {
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
    }, timeoutSec * 1000);

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
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
      clearTimeout(timer);
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
