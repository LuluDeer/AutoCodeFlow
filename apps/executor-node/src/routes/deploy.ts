import { Router, Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { execSync, spawn, ChildProcess } from 'child_process';
import { config } from '../config';
import { logger } from '../logger';
import { post } from '../admin-client';

export const deployRouter = Router();

interface DeployPayload {
  deploymentId: string;
  applicationId: string;
  appName: string;
  gitRepo: string;
  gitBranch: string;
  gitCommit?: string;
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

  if (runtime === 'node' || runtime === 'nodejs') {
    const pkgJson = path.join(deployDir, 'package.json');
    if (fs.existsSync(pkgJson)) {
      logger.info(`[deploy] Installing Node.js dependencies in ${deployDir}`);
      const npmArgs = ['install', '--production'];
      if (config.npmRegistryUrl) npmArgs.push(`--registry=${config.npmRegistryUrl}`);
      execSync(`npm ${npmArgs.join(' ')}`, { cwd: deployDir, env, stdio: 'pipe', timeout: 300_000 });
    }
  } else if (runtime === 'python') {
    const reqFile = path.join(deployDir, 'requirements.txt');
    if (fs.existsSync(reqFile)) {
      logger.info(`[deploy] Creating Python venv and installing deps in ${deployDir}`);
      const venvDir = path.join(deployDir, '.venv');
      execSync(`python3 -m venv ${venvDir}`, { cwd: deployDir, env, stdio: 'pipe', timeout: 60_000 });
      const pip = path.join(venvDir, 'bin', 'pip');
      const pipArgs = ['install', '-r', 'requirements.txt'];
      if (config.pythonRegistryUrl) pipArgs.push('-i', config.pythonRegistryUrl);
      execSync(`${pip} ${pipArgs.join(' ')}`, { cwd: deployDir, env, stdio: 'pipe', timeout: 300_000 });
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

/** Main deploy handler */
deployRouter.post('/deploy', async (req: Request, res: Response) => {
  const payload = req.body as DeployPayload;
  const { deploymentId, appName, gitRepo, gitBranch, gitCommit, runtime, entrypoint, runMode, env: envVars = {}, upgrade = false } = payload;

  if (!deploymentId || !gitRepo) {
    return res.status(400).json({ error: 'deploymentId and gitRepo are required' });
  }

  // Work directory for this deployment
  const deployDir = path.join(config.workDir, 'apps', payload.applicationId, deploymentId);

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

      const gitDir = path.join(deployDir, '.git');
      if (!fs.existsSync(gitDir)) {
        // Fresh clone
        logger.info(`[deploy] Cloning ${gitRepo}@${gitBranch}`);
        execSync(
          `git clone --depth 1 --branch ${gitBranch} ${gitRepo} .`,
          { cwd: deployDir, stdio: 'pipe', timeout: 120_000 },
        );
      } else {
        // Pull latest
        logger.info(`[deploy] Pulling latest for ${deploymentId}`);
        execSync('git fetch --depth 1 origin', { cwd: deployDir, stdio: 'pipe', timeout: 60_000 });
        execSync(`git reset --hard origin/${gitBranch}`, { cwd: deployDir, stdio: 'pipe', timeout: 30_000 });
      }

      if (gitCommit) {
        execSync(`git checkout ${gitCommit}`, { cwd: deployDir, stdio: 'pipe', timeout: 30_000 });
      }

      // Install dependencies
      installDeps(deployDir, runtime, envVars);

      // Write .env file for the app
      if (Object.keys(envVars).length > 0) {
        const envContent = Object.entries(envVars).map(([k, v]) => `${k}=${v}`).join('\n');
        fs.writeFileSync(path.join(deployDir, '.env'), envContent, 'utf-8');
      }

      // Start app if runMode is daemon or once
      const entry = entrypoint || 'main.py';
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
