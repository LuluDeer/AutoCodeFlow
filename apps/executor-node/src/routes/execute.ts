import { Router, Request, Response } from 'express';
import { spawn, spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { config } from '../config';
import { logger } from '../logger';
import { getRunningCountArray } from '../scheduler';
import { loadManifest, mergeTaskWithManifest } from '../manifest';
import { pushCallback } from '../callback';
import { appendLog } from '../file-logger';
import { taskWorkerManager } from '../task-worker';

/** Convert git URL to a safe cache directory name */
function repoDirName(repoUrl: string): string {
  const base = repoUrl.replace(/\/$/, '').split('/').pop() ?? 'repo';
  return base.replace(/\.git$/, '').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

/** Clone (with bare cache) and checkout the specified ref to dest directory */
function gitCheckoutTo(repoUrl: string, ref: string, dest: string): void {
  const cacheDir = path.join(config.workDir, '.git_cache', repoDirName(repoUrl));
  if (!fs.existsSync(path.join(cacheDir, 'HEAD'))) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const r = spawnSync('git', ['clone', '--bare', repoUrl, cacheDir], { timeout: 120_000 });
    if (r.status !== 0) throw new Error(`git clone failed: ${r.stderr?.toString()}`);
  } else {
    const r = spawnSync('git', ['-C', cacheDir, 'fetch', '--all'], { timeout: 60_000 });
    if (r.status !== 0) logger.warn(`git fetch warning: ${r.stderr?.toString()}`);
  }
  fs.mkdirSync(dest, { recursive: true });
  const r = spawnSync(
    'git',
    [`--git-dir=${cacheDir}`, `--work-tree=${dest}`, 'checkout', ref, '--', '.'],
    { timeout: 30_000 },
  );
  if (r.status !== 0) throw new Error(`git checkout failed: ${r.stderr?.toString()}`);
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

  // Helper function to send error response and decrement capacity counter
  const sendError = (status: number, error: string) => {
    Atomics.sub(getRunningCountArray(), 0, 1);
    res.status(status).json({ error });
  };

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
    logger.info(`Checking out ${gitRepo}@${ref} to ${workDir}`);
    gitCheckoutTo(gitRepo, ref, workDir);
  }

  // Load manifest.yaml and merge with task (task fields take priority)
  const manifest = loadManifest(workDir);
  const task = mergeTaskWithManifest(body.task as Record<string, unknown>, manifest);

  const runtime = (task.runtime as string) || 'node';
  const entrypoint = (task.entrypoint as string) || 'index.js';
  const timeout = (task.timeout as number) || 300;
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
    } else if (glLower === 'shell' || glLower === 'glue_shell') {
      glueFile = path.join(workDir, 'glue_script.sh');
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
  if (actualRuntime === 'node' && actualRequirements.length > 0) {
    const nodeModulesDir = path.join(config.workDir, '.node_modules', taskId);
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
      logger.info(`Using npm registry: ${config.npmRegistryUrl} for task ${taskId}`);
    }
    const installResult = spawnSync(
      'npm',
      ['install', '--prefix', nodeModulesDir, ...actualRequirements],
      { stdio: 'pipe', timeout: 300_000 },
    );
    if (installResult.status !== 0) {
      const errMsg = installResult.stderr?.toString() || 'npm install failed';
      sendError(500, `Dependency installation failed: ${errMsg}`);
      return;
    }
  }

  // SEC-01: only pass a whitelist of env vars to child process — never expose executor secrets
  const ENV_WHITELIST = new Set([
    'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
    'NODE_PATH', 'npm_config_cache', 'npm_config_prefix',
    'TMPDIR', 'TEMP', 'TMP',
    'USER', 'LOGNAME', 'SHELL',
    'SYSTEMROOT', 'WINDIR', // Windows compat
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (ENV_WHITELIST.has(k)) env[k] = v;
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
      args = ['-c', `cd "${workDir}" && exec "${actualEntrypoint}"`];
    }
  } else {
    sendError(400, `Unsupported runtime: ${actualRuntime}`);
    return;
  }

  logger.info(`Running task ${String(task.name)} [${executionId}]: ${cmd} ${args.join(' ')}`);

  const taskInfo = {
    taskId,
    task: { ...task, runtime: actualRuntime, entrypoint: actualEntrypoint, timeout, workDir, env, cmd, args },
    params,
    executionId,
  };

  taskWorkerManager.execute(taskId, executionId, taskInfo.task, { ...params, executionId }, () => {
    Atomics.sub(getRunningCountArray(), 0, 1);
  });
  
  res.json({ status: 'accepted', executionId });
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
      logs: result.logs,
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
      logs,
      errorMessage: message,
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
    const proc = spawn(cmd, args, { cwd, env, detached: process.platform !== 'win32' });
    let logs = '';
    // Guard against close firing after timeout has already rejected the promise
    let settled = false;

    proc.stdout.on('data', (d: Buffer) => {
      const output = d.toString();
      logs += output;
      if (executionId) appendLog(executionId, output);
    });
    proc.stderr.on('data', (d: Buffer) => {
      const output = d.toString();
      logs += output;
      if (executionId) appendLog(executionId, output);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // B-06: kill the entire process group so child processes spawned by the task are also terminated
      try {
        if (proc.pid !== undefined) {
          if (process.platform !== 'win32') {
            process.kill(-proc.pid, 'SIGKILL');
          } else {
            proc.kill('SIGKILL');
          }
        }
      } catch (_) {
        try { proc.kill('SIGKILL'); } catch (_2) { /* already dead */ }
      }
      reject(new Error(`Task timeout after ${timeoutSec}s`));
    }, timeoutSec * 1000);

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        // Attach logs and exitCode as properties so callers can surface them independently
        const err = new Error(`Process exited with code ${exitCode}`) as Error & { logs: string; exitCode: number };
        (err as any).logs = logs;
        (err as any).exitCode = exitCode;
        reject(err);
      } else {
        resolve({ success: true, logs, exitCode });
      }
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}
