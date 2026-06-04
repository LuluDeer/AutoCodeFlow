import { Router, Request, Response } from 'express';
import { spawn, spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { config } from '../config';
import { logger } from '../logger';
import { incrementRunning, decrementRunning, runningCount } from '../scheduler';
import { loadManifest, mergeTaskWithManifest } from '../manifest';

/** 将 git URL 转成安全缓存目录名 */
function repoDirName(repoUrl: string): string {
  const base = repoUrl.replace(/\/$/, '').split('/').pop() ?? 'repo';
  return base.replace(/\.git$/, '').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

/** Clone（带 bare 缓存）并 checkout 指定 ref 到 dest 目录 */
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
  };
  params?: Record<string, unknown>;
}

executeRouter.post('/execute', async (req: Request, res: Response) => {
  if (runningCount >= config.maxConcurrentTasks) {
    res.status(429).json({ error: 'Executor is at capacity' });
    return;
  }

  const body = req.body as ExecuteRequest;
  const { executionId, params } = body;

  if (!executionId || !body.task) {
    res.status(400).json({ error: 'executionId and task are required' });
    return;
  }

  const workDir = path.join(config.workDir, executionId);
  // S6/Q11: path traversal guard — ensure workDir stays within configured base
  const resolvedWorkDir = path.resolve(workDir);
  const resolvedBase = path.resolve(config.workDir);
  if (!resolvedWorkDir.startsWith(resolvedBase + path.sep) && resolvedWorkDir !== resolvedBase) {
    res.status(400).json({ error: 'Invalid executionId: path traversal detected' });
    return;
  }
  fs.mkdirSync(workDir, { recursive: true });
  // S6/Q11: restrict permissions so sibling tasks cannot read this directory
  try { fs.chmodSync(workDir, 0o700); } catch (_) { /* ignore on unsupported filesystems */ }

  // --- Git 版本绑定：若任务指定了 gitRepo 则 clone/checkout 到工作目录 ---
  const gitRepo: string | undefined = (body.task as any).gitRepo;
  const gitCommit: string | undefined = (body.task as any).gitCommit;
  const gitBranch: string = (body.task as any).gitBranch || 'main';
  if (gitRepo) {
    // S7: SSRF guard — only allow http(s) and ssh git URLs; reject file:// and others
    const allowedGitPattern = /^(https?:\/\/|git@|ssh:\/\/)/i;
    if (!allowedGitPattern.test(gitRepo)) {
      res.status(400).json({ error: `gitRepo URL scheme not allowed: ${gitRepo}` });
      return;
    }
    const ref = gitCommit || gitBranch;
    logger.info(`Checking out ${gitRepo}@${ref} to ${workDir}`);
    gitCheckoutTo(gitRepo, ref, workDir);
  }

  // 加载 manifest.yaml 并与 task 合并（task 字段优先）
  const manifest = loadManifest(workDir);
  const task = mergeTaskWithManifest(body.task as Record<string, unknown>, manifest);

  const runtime = (task.runtime as string) || 'node';
  const entrypoint = (task.entrypoint as string) || 'index.js';
  const timeout = (task.timeout as number) || 300;
  const requirements: string[] = (task.requirements as string[]) || [];
  const taskId = String(task.id || executionId);

  // node runtime: 按需安装依赖到任务隔离目录
  if (runtime === 'node' && requirements.length > 0) {
    const nodeModulesDir = path.join(config.workDir, '.node_modules', taskId);
    fs.mkdirSync(nodeModulesDir, { recursive: true });
    const pkgJson = path.join(nodeModulesDir, 'package.json');
    if (!fs.existsSync(pkgJson)) {
      fs.writeFileSync(pkgJson, JSON.stringify({ name: `task-${taskId}`, version: '1.0.0' }));
    }
    // S16: validate each package name against npm naming rules before shell expansion
    const npmNameRe = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[\w.^~-]+)?$/i;
    for (const pkg of requirements) {
      if (!npmNameRe.test(pkg)) {
        res.status(400).json({ error: `Invalid npm package name: ${pkg}` });
        return;
      }
    }
    logger.info(`Installing ${requirements.length} packages for task ${taskId}`);
    // N18: use spawnSync instead of execSync so shell: false is actually honoured
    // (execSync ignores shell: false — it is a spawnSync-only option)
    const installResult = spawnSync(
      'npm',
      ['install', '--prefix', nodeModulesDir, ...requirements],
      { stdio: 'pipe', timeout: 300_000 },
    );
    if (installResult.status !== 0) {
      const errMsg = installResult.stderr?.toString() || 'npm install failed';
      res.status(500).json({ error: `Dependency installation failed: ${errMsg}` });
      return;
    }
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EXECUTION_ID: executionId,
    TASK_ID: String(task.id || ''),
    TASK_NAME: String(task.name || ''),
  };

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      env[`AUTOFLOW_${k.toUpperCase()}`] = String(v);
    }
  }

  let cmd: string;
  let args: string[];

  if (runtime === 'node') {
    cmd = 'node';
    args = [entrypoint];
  } else if (runtime === 'shell') {
    cmd = 'bash';
    args = [entrypoint];
  } else {
    res.status(400).json({ error: `Unsupported runtime: ${runtime}` });
    return;
  }

  logger.info(`Running task ${String(task.name)} [${executionId}]: ${cmd} ${args.join(' ')}`);
  incrementRunning();

  try {
    const result = await runProcess(cmd, args, workDir, env, timeout, executionId);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    decrementRunning();
  }
});

function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutSec: number,
  _executionId?: string,
): Promise<{ success: boolean; logs: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, env });
    let logs = '';

    proc.stdout.on('data', (d: Buffer) => { logs += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { logs += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Task timeout after ${timeoutSec}s`));
    }, timeoutSec * 1000);

    proc.on('close', (code: number) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Process exited with code ${code}\n${logs}`));
      } else {
        resolve({ success: true, logs, exitCode: code });
      }
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
