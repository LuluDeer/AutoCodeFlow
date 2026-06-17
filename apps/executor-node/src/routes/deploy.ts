import { Router, Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { spawnSync, spawn, ChildProcess } from 'child_process';
import { config } from '../config';
import { logger } from '../logger';
import { post } from '../admin-client';

export const deployRouter = Router();

interface DeployPayload {
  deploymentId: string;
  applicationId: string;
  appId?: string; // alias for applicationId (backward compat)
  appName: string;
  gitRepo?: string | null;
  gitBranch: string;
  gitCommit?: string | null;
  packageUrl?: string | null;
  runtime: string;
  entrypoint?: string;
  runMode: 'once' | 'daemon' | 'scheduled';
  env?: Record<string, string>;
  upgrade?: boolean;
}

/** Map of deploymentId -> running child process (daemon mode) */
const runningApps = new Map<string, ChildProcess>();

/** Report app status back to admin-api */
async function reportStatus(
  deploymentId: string,
  status: 'running' | 'stopped' | 'failed',
  pid?: number,
  message?: string,
): Promise<void> {
  try {
    await post('/api/app-deployments/heartbeat', { deploymentId, status, pid, message });
  } catch (err: any) {
    logger.warn(`Failed to report deployment status: ${err.message}`);
  }
}

/** Install dependencies for the given deployment directory */
function installDeps(
  deployDir: string,
  runtime: string,
  envVars: Record<string, string>,
): void {
  const env = { ...process.env, ...envVars };

  // SEC: spawnSync with array args — no shell, no injection
  if (runtime === 'node' || runtime === 'nodejs') {
    const pkgJson = path.join(deployDir, 'package.json');
    if (fs.existsSync(pkgJson)) {
      logger.info(`[deploy] Installing Node.js dependencies in ${deployDir}`);
      const npmArgs = ['install', '--production'];
      if (config.npmRegistryUrl) npmArgs.push(`--registry=${config.npmRegistryUrl}`);
      const r = spawnSync('npm', npmArgs, { cwd: deployDir, env, stdio: 'pipe', timeout: 300_000 });
      if (r.status !== 0) throw new Error(r.stderr?.toString() || 'npm install failed');
    }
  } else if (runtime === 'python') {
    const reqFile = path.join(deployDir, 'requirements.txt');
    if (fs.existsSync(reqFile)) {
      logger.info(`[deploy] Creating Python venv and installing deps in ${deployDir}`);
      const venvDir = path.join(deployDir, '.venv');
      const venvR = spawnSync('python3', ['-m', 'venv', venvDir], { cwd: deployDir, env, stdio: 'pipe', timeout: 60_000 });
      if (venvR.status !== 0) throw new Error(venvR.stderr?.toString() || 'python3 -m venv failed');
      const pip = path.join(venvDir, 'bin', 'pip');
      const pipArgs = ['install', '-r', 'requirements.txt'];
      if (config.pythonRegistryUrl) pipArgs.push('-i', config.pythonRegistryUrl);
      const pipR = spawnSync(pip, pipArgs, { cwd: deployDir, env, stdio: 'pipe', timeout: 300_000 });
      if (pipR.status !== 0) throw new Error(pipR.stderr?.toString() || 'pip install failed');
    }
  }
}

/** Start the application process */
function startApp(
  deploymentId: string,
  deployDir: string,
  runtime: string,
  entrypoint: string,
  runMode: string,
  envVars: Record<string, string>,
): void {
  const env = { ...process.env, ...envVars };

  let cmd: string;
  let args: string[];

  if (runtime === 'python') {
    const pythonBin = path.join(deployDir, '.venv', 'bin', 'python3');
    cmd = fs.existsSync(pythonBin) ? pythonBin : 'python3';
    args = [entrypoint];
  } else if (runtime === 'node' || runtime === 'nodejs') {
    cmd = 'node';
    args = [entrypoint];
  } else {
    // shell
    cmd = 'sh';
    args = ['-c', entrypoint];
  }

  logger.info(`[deploy] Starting app ${deploymentId}: ${cmd} ${args.join(' ')}`);

  const child = spawn(cmd, args, {
    cwd: deployDir,
    env,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  runningApps.set(deploymentId, child);

  // Stream logs to file
  const logFile = path.join(deployDir, 'app.log');
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

  // Report started
  reportStatus(deploymentId, 'running', child.pid);

  child.on('exit', (code) => {
    runningApps.delete(deploymentId);
    if (code === 0) {
      logger.info(`[deploy] App ${deploymentId} exited cleanly`);
      reportStatus(deploymentId, 'stopped', undefined, `Exited with code ${code}`);
    } else {
      logger.warn(`[deploy] App ${deploymentId} exited with code ${code}`);
      reportStatus(deploymentId, 'failed', undefined, `Exited with code ${code}`);
    }
  });

  child.on('error', (err) => {
    runningApps.delete(deploymentId);
    logger.error(`[deploy] App ${deploymentId} error: ${err.message}`);
    reportStatus(deploymentId, 'failed', undefined, err.message);
  });
}

/** Download a file over HTTP/HTTPS to a local path */
function downloadPackage(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? require('https') : require('http');
    const file = fs.createWriteStream(dest);
    const req = proto.get(url, (res: any) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        downloadPackage(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (!res.statusCode || res.statusCode >= 400) {
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    req.on('error', (err: Error) => { fs.unlink(dest, () => {}); reject(err); });
    req.setTimeout(120_000, () => { req.destroy(); reject(new Error('Download timed out')); });
  });
}

/** Main deploy handler */
deployRouter.post('/deploy', async (req: Request, res: Response) => {
  const payload = req.body as DeployPayload;
  const { deploymentId, appName, gitRepo, gitBranch, gitCommit, packageUrl, runtime, entrypoint, runMode, env: envVars = {}, upgrade = false } = payload;

  if (!deploymentId) {
    return res.status(400).json({ error: 'deploymentId is required' });
  }
  if (!gitRepo && !packageUrl) {
    return res.status(400).json({ error: 'Either gitRepo or packageUrl is required' });
  }

  // Work directory for this deployment (accept appId as alias for applicationId)
  const appId = payload.applicationId || payload.appId;
  if (!appId) {
    return res.status(400).json({ error: 'applicationId is required' });
  }
  const deployDir = path.join(config.workDir, 'apps', appId, deploymentId);

  // Acknowledge immediately; deploy runs async
  res.json({ ok: true, deploymentId });

  setImmediate(async () => {
    try {
      // Stop existing process if upgrading
      if (upgrade && runningApps.has(deploymentId)) {
        const existing = runningApps.get(deploymentId)!;
        existing.kill('SIGTERM');
        runningApps.delete(deploymentId);
        logger.info(`[deploy] Stopped existing process for ${deploymentId}`);
        await new Promise(r => setTimeout(r, 2000));
      }

      if (!fs.existsSync(deployDir)) {
        fs.mkdirSync(deployDir, { recursive: true });
      }

      if (packageUrl) {
        // Package-based deployment: download zip and extract
        logger.info(`[deploy] Downloading package from ${packageUrl}`);
        const zipPath = path.join(deployDir, '_package.zip');
        await downloadPackage(packageUrl, zipPath);
        logger.info(`[deploy] Extracting package for ${deploymentId}`);
        const unzipR = spawnSync('unzip', ['-o', zipPath, '-d', deployDir], { stdio: 'pipe', timeout: 60_000 });
        if (unzipR.status !== 0) throw new Error(unzipR.stderr?.toString() || 'unzip failed');
        fs.unlinkSync(zipPath);
        logger.info(`[deploy] Package extracted for ${deploymentId}`);
      } else if (gitRepo) {
        const gitDir = path.join(deployDir, '.git');
        // SEC: all git commands use spawnSync with array args — no shell, no injection
        if (!fs.existsSync(gitDir)) {
          // Fresh clone
          logger.info(`[deploy] Cloning ${gitRepo}@${gitBranch}`);
          const cloneR = spawnSync(
            'git', ['clone', '--depth', '1', '--branch', gitBranch, gitRepo, '.'],
            { cwd: deployDir, stdio: 'pipe', timeout: 120_000 },
          );
          if (cloneR.status !== 0) throw new Error(cloneR.stderr?.toString() || 'git clone failed');
        } else {
          // Pull latest
          logger.info(`[deploy] Pulling latest for ${deploymentId}`);
          const fetchR = spawnSync('git', ['fetch', '--depth', '1', 'origin'], { cwd: deployDir, stdio: 'pipe', timeout: 60_000 });
          if (fetchR.status !== 0) logger.warn(`git fetch warning: ${fetchR.stderr?.toString()}`);
          const resetR = spawnSync('git', ['reset', '--hard', `origin/${gitBranch}`], { cwd: deployDir, stdio: 'pipe', timeout: 30_000 });
          if (resetR.status !== 0) throw new Error(resetR.stderr?.toString() || 'git reset failed');
        }

        if (gitCommit) {
          const coR = spawnSync('git', ['checkout', gitCommit], { cwd: deployDir, stdio: 'pipe', timeout: 30_000 });
          if (coR.status !== 0) throw new Error(coR.stderr?.toString() || 'git checkout failed');
        }
      }

      // Install dependencies
      installDeps(deployDir, runtime, envVars);

      // Write .env file for the app
      if (Object.keys(envVars).length > 0) {
        const envContent = Object.entries(envVars).map(([k, v]) => `${k}=${v}`).join('\n');
        fs.writeFileSync(path.join(deployDir, '.env'), envContent, 'utf-8');
      }

      // Start app if runMode is daemon or once
      // Pick a sensible default entrypoint based on runtime when none was specified
      const defaultEntry = (runtime === 'python') ? 'main.py'
        : (runtime === 'node' || runtime === 'nodejs') ? 'index.js'
        : 'main.sh';
      const entry = entrypoint || defaultEntry;
      if (runMode === 'daemon' || runMode === 'once') {
        startApp(deploymentId, deployDir, runtime, entry, runMode, envVars);
      } else {
        // scheduled mode: just deploy, tasks are triggered via normal task dispatch
        await reportStatus(deploymentId, 'running', undefined, 'Deployed in scheduled mode');
      }
    } catch (err: any) {
      logger.error(`[deploy] Deployment ${deploymentId} failed: ${err.message}`);
      await reportStatus(deploymentId, 'failed', undefined, err.message);
    }
  });
});

/** Stop a running app */
deployRouter.post('/app-stop', (req: Request, res: Response) => {
  const { deploymentId } = req.body;
  const child = runningApps.get(deploymentId);
  if (child) {
    child.kill('SIGTERM');
    runningApps.delete(deploymentId);
    logger.info(`[deploy] Stopped app ${deploymentId}`);
  }
  res.json({ ok: true });
});

/** List running apps */
deployRouter.get('/app-status', (_req: Request, res: Response) => {
  const status: Record<string, { pid: number | undefined; running: boolean }> = {};
  for (const [id, child] of runningApps) {
    status[id] = { pid: child.pid, running: !child.killed };
  }
  res.json(status);
});

export { runningApps };
