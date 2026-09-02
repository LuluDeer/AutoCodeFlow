import { Router, Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, spawnSync, ChildProcess } from 'child_process';
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
  version?: string | null;
  runtime: string;
  entrypoint?: string;
  runMode: 'once' | 'daemon' | 'scheduled';
  env?: Record<string, string>;
  upgrade?: boolean;
}

/** Map of deploymentId -> running child process (daemon mode) */
const runningApps = new Map<string, ChildProcess>();

/** Deployments whose next process exit is part of an intentional in-place restart. */
const restartExitReportsToSuppress = new Set<string>();

export function suppressNextRestartExitReport(deploymentId: string): void {
  restartExitReportsToSuppress.add(deploymentId);
}

export function shouldReportProcessExit(deploymentId: string): boolean {
  return !restartExitReportsToSuppress.delete(deploymentId);
}

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

/** Resolve platform-aware Python / pip binary paths inside a venv */
function venvBins(venvDir: string): { python: string; pip: string } {
  const isWin = process.platform === 'win32';
  return {
    python: isWin
      ? path.join(venvDir, 'Scripts', 'python.exe')
      : path.join(venvDir, 'bin', 'python3'),
    pip: isWin
      ? path.join(venvDir, 'Scripts', 'pip.exe')
      : path.join(venvDir, 'bin', 'pip'),
  };
}

/** Install dependencies for the given deployment directory */
function installDeps(
  deployDir: string,
  runtime: string,
  envVars: Record<string, string>,
): void {
  const env = { ...process.env, ...envVars };
  const isWin = process.platform === 'win32';

  // SEC: spawnSync with array args — no shell, no injection
  if (runtime === 'node' || runtime === 'nodejs') {
    const pkgJson = path.join(deployDir, 'package.json');
    if (fs.existsSync(pkgJson)) {
      logger.info(`[deploy] Installing Node.js dependencies in ${deployDir}`);
      // On Windows, npm is a .cmd file and needs shell:true to resolve
      const npmCmd = isWin ? 'npm.cmd' : 'npm';
      const npmArgs = ['install', '--production'];
      if (config.npmRegistryUrl) npmArgs.push(`--registry=${config.npmRegistryUrl}`);
      const r = spawnSync(npmCmd, npmArgs, { cwd: deployDir, env, stdio: 'pipe', timeout: 300_000, shell: isWin });
      if (r.status !== 0) throw new Error(r.stderr?.toString() || 'npm install failed');
    }
  } else if (runtime === 'python') {
    const reqFile = path.join(deployDir, 'requirements.txt');
    if (fs.existsSync(reqFile)) {
      logger.info(`[deploy] Creating Python venv and installing deps in ${deployDir}`);
      const venvDir = path.join(deployDir, '.venv');
      // Try 'python3' first (Linux/macOS), fall back to 'python' (Windows)
      const pythonCmd = isWin ? 'python' : 'python3';
      const venvR = spawnSync(pythonCmd, ['-m', 'venv', venvDir], { cwd: deployDir, env, stdio: 'pipe', timeout: 60_000 });
      if (venvR.status !== 0) throw new Error(venvR.stderr?.toString() || `${pythonCmd} -m venv failed`);
      const bins = venvBins(venvDir);
      const pipArgs = ['install', '-r', 'requirements.txt'];
      if (config.pythonRegistryUrl) pipArgs.push('-i', config.pythonRegistryUrl);
      const pipR = spawnSync(bins.pip, pipArgs, { cwd: deployDir, env, stdio: 'pipe', timeout: 300_000 });
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

  const isWin = process.platform === 'win32';

  if (runtime === 'python') {
    const bins = venvBins(path.join(deployDir, '.venv'));
    // Use venv python if available, otherwise fall back to system python
    const fallback = isWin ? 'python' : 'python3';
    cmd = fs.existsSync(bins.python) ? bins.python : fallback;
    args = [entrypoint];
  } else if (runtime === 'node' || runtime === 'nodejs') {
    cmd = 'node';
    args = [entrypoint];
  } else {
    // shell — use cmd.exe on Windows
    if (isWin) {
      cmd = 'cmd.exe';
      args = ['/c', entrypoint];
    } else {
      cmd = 'sh';
      args = ['-c', entrypoint];
    }
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
  logStream.on('error', (err) => {
    logger.warn(`[deploy] Failed to write app log for ${deploymentId}: ${err.message}`);
  });
  // end:false on both sources — with the default end:true the first stream
  // to finish would end the file while the other still writes
  // (write-after-end crash).
  let openLogSources = 2;
  const closeLogStream = () => {
    if (--openLogSources <= 0) logStream.end();
  };
  child.stdout?.pipe(logStream, { end: false });
  child.stderr?.pipe(logStream, { end: false });
  child.stdout?.on('close', closeLogStream);
  child.stderr?.on('close', closeLogStream);

  // Report started
  reportStatus(deploymentId, 'running', child.pid);

  child.on('exit', (code) => {
    runningApps.delete(deploymentId);
    if (!shouldReportProcessExit(deploymentId)) {
      logger.info(`[deploy] Suppressed exit report for restarted app ${deploymentId}`);
      return;
    }
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

/** Strip embedded credentials (user:token@) before a URL reaches the logs. */
function redactUrl(u: string): string {
  return u.replace(/\/\/[^/@]+@/, '//***@');
}

/** Promise-wrapped spawn — deploy runs inside setImmediate, but spawnSync
 *  still froze the whole process (heartbeats, /health, all APIs) for the
 *  duration of git/npm/pip/unzip work. */
function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; shell?: boolean } = {},
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = opts.timeout
      ? setTimeout(() => {
          try { child.kill('SIGKILL'); } catch (_) { /* already dead */ }
        }, opts.timeout)
      : null;
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ status: null, stderr: `${stderr}${err.message}` });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ status: code, stderr });
    });
  });
}

/** Download a file over HTTP/HTTPS to a local path */
function downloadPackage(url: string, dest: string, maxRedirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? require('https') : require('http');
    const file = fs.createWriteStream(dest);
    const fail = (err: Error) => {
      file?.destroy?.();
      fs.unlink(dest, () => {});
      reject(err);
    };
    const req = proto.get(url, (res: any) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file?.close?.();
        fs.unlinkSync(dest);
        if (maxRedirects <= 0) {
          reject(new Error('Download failed: too many redirects'));
          return;
        }
        downloadPackage(res.headers.location, dest, maxRedirects - 1).then(resolve).catch(reject);
        return;
      }
      if (!res.statusCode || res.statusCode >= 400) {
        fail(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    req.on('error', fail);
    req.setTimeout(120_000, () => { req.destroy(); fail(new Error('Download timed out')); });
  });
}

function isSafePathSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function validatePackageUrl(packageUrl: string): string | null {
  try {
    const parsed = new URL(packageUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `packageUrl scheme not allowed: ${parsed.protocol}. Only http and https are permitted.`;
    }
    return null;
  } catch {
    return 'packageUrl is not a valid URL';
  }
}

function normalizeReleasePart(value: string | null | undefined, fallback: string): string {
  const normalized = (value || fallback)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80);
  return normalized || fallback;
}

interface DeploymentPaths {
  appRoot: string;
  releasesDir: string;
  tmpDir: string;
  currentLink: string;
  releaseKey: string;
  finalReleaseDir: string;
  extractDir: string;
}

export function buildDeploymentPaths(
  workDir: string,
  appId: string,
  deploymentId: string,
  version?: string | null,
): DeploymentPaths {
  if (!isSafePathSegment(appId)) {
    throw new Error('applicationId contains unsupported characters');
  }
  if (!isSafePathSegment(deploymentId)) {
    throw new Error('deploymentId contains unsupported characters');
  }

  const versionPart = normalizeReleasePart(version, 'version');
  const releaseKey = `${versionPart}-${deploymentId}`;
  const appRoot = path.join(workDir, 'apps', appId);
  const releasesDir = path.join(appRoot, 'releases');
  const tmpDir = path.join(appRoot, 'tmp');

  return {
    appRoot,
    releasesDir,
    tmpDir,
    currentLink: path.join(appRoot, 'current'),
    releaseKey,
    finalReleaseDir: path.join(releasesDir, releaseKey),
    extractDir: path.join(tmpDir, `${releaseKey}-extracting`),
  };
}

function readCurrentTarget(currentLink: string): string | null {
  try {
    if (fs.existsSync(currentLink) && fs.lstatSync(currentLink).isSymbolicLink()) {
      return fs.readlinkSync(currentLink);
    }
  } catch (err: any) {
    logger.warn(`[deploy] Failed to read current release link: ${err.message}`);
  }
  return null;
}

function removePathIfExists(target: string): void {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function switchCurrentRelease(currentLink: string, targetDir: string): void {
  const tmpLink = `${currentLink}.next-${process.pid}-${Date.now()}`;
  removePathIfExists(tmpLink);
  fs.symlinkSync(targetDir, tmpLink, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    fs.renameSync(tmpLink, currentLink);
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
    fs.unlinkSync(currentLink);
    fs.renameSync(tmpLink, currentLink);
  }
}

function restoreCurrentRelease(currentLink: string, previousTarget: string | null): void {
  try {
    if (previousTarget) {
      switchCurrentRelease(currentLink, previousTarget);
    } else if (fs.existsSync(currentLink)) {
      fs.unlinkSync(currentLink);
    }
  } catch (err: any) {
    logger.warn(`[deploy] Failed to restore previous current release: ${err.message}`);
  }
}

function assertSafeZipEntries(zipPath: string): void {
  if (process.platform === 'win32') return;

  const listR = spawnSync('unzip', ['-Z1', zipPath], { stdio: 'pipe', timeout: 30_000 });
  if (listR.status !== 0) {
    throw new Error(listR.stderr?.toString() || 'unzip listing failed');
  }

  const entries = listR.stdout.toString().split(/\r?\n/).filter(Boolean);
  for (const entry of entries) {
    const parts = entry.split(/[\\/]+/).filter(Boolean);
    if (path.isAbsolute(entry) || parts.includes('..')) {
      throw new Error(`Unsafe zip entry path: ${entry}`);
    }
  }
}

/** Main deploy handler */
deployRouter.post('/deploy', async (req: Request, res: Response) => {
  const payload = req.body as DeployPayload;
  const { deploymentId, appName, gitRepo, gitBranch, gitCommit, packageUrl, version, runtime, entrypoint, runMode, env: envVars = {}, upgrade = false } = payload;

  if (!deploymentId) {
    return res.status(400).json({ error: 'deploymentId is required' });
  }
  if (!isSafePathSegment(deploymentId)) {
    return res.status(400).json({ error: 'deploymentId contains unsupported characters' });
  }
  if (!gitRepo && !packageUrl) {
    return res.status(400).json({ error: 'Either gitRepo or packageUrl is required' });
  }
  // P0: git argument injection guard — option-like or malformed values would
  // be parsed as flags by git (e.g. --upload-pack=…) instead of ref/URL.
  if (gitRepo) {
    if (/^-/.test(gitRepo) || !/^(https?:\/\/|git@|ssh:\/\/)/i.test(gitRepo)) {
      return res.status(400).json({ error: `Invalid gitRepo URL: ${gitRepo}` });
    }
    const branch = gitBranch || 'main';
    if (
      /^-/.test(branch) ||
      /[\s^~:?*[\]\\]/.test(branch) ||
      branch.includes('..') ||
      branch.startsWith('/')
    ) {
      return res.status(400).json({ error: `Invalid gitBranch: ${branch}` });
    }
    if (gitCommit && !/^[0-9a-fA-F]{7,40}$/.test(gitCommit)) {
      return res.status(400).json({ error: `Invalid gitCommit: ${gitCommit}` });
    }
  }
  if (packageUrl) {
    const packageUrlError = validatePackageUrl(packageUrl);
    if (packageUrlError) {
      return res.status(400).json({ error: packageUrlError });
    }
  }

  // Work directory for this deployment (accept appId as alias for applicationId)
  const appId = payload.applicationId || payload.appId;
  if (!appId) {
    return res.status(400).json({ error: 'applicationId is required' });
  }
  if (!isSafePathSegment(appId)) {
    return res.status(400).json({ error: 'applicationId contains unsupported characters' });
  }
  const paths = buildDeploymentPaths(config.workDir, appId, deploymentId, version);

  // Acknowledge immediately; deploy runs async
  res.json({ ok: true, deploymentId });

  setImmediate(async () => {
    const previousCurrentTarget = readCurrentTarget(paths.currentLink);
    let switchedCurrent = false;
    try {
      // Stop existing process if upgrading — wait for actual exit instead of fixed sleep
      if (upgrade && runningApps.has(deploymentId)) {
        const existing = runningApps.get(deploymentId)!;
        suppressNextRestartExitReport(deploymentId);
        await new Promise<void>((resolve) => {
          const gracefulTimeout = setTimeout(() => {
            logger.warn(`[deploy] Graceful stop timed out for ${deploymentId}, sending SIGKILL`);
            existing.kill('SIGKILL');
            resolve();
          }, 10_000);
          existing.once('exit', () => {
            clearTimeout(gracefulTimeout);
            resolve();
          });
          existing.kill('SIGTERM');
        });
        runningApps.delete(deploymentId);
        logger.info(`[deploy] Stopped existing process for ${deploymentId}`);
      }

      fs.mkdirSync(paths.releasesDir, { recursive: true });
      fs.mkdirSync(paths.tmpDir, { recursive: true });
      removePathIfExists(paths.extractDir);
      fs.mkdirSync(paths.extractDir, { recursive: true });

      if (packageUrl) {
        // Package-based deployment: download zip and extract into a temporary release dir.
        logger.info(`[deploy] Downloading package from ${redactUrl(packageUrl)}`);
        const zipPath = path.join(paths.tmpDir, `${paths.releaseKey}.zip`);
        await downloadPackage(packageUrl, zipPath);
        assertSafeZipEntries(zipPath);
        logger.info(`[deploy] Extracting package for ${deploymentId}`);
        // Use platform-appropriate extraction:
        //   Windows: PowerShell Expand-Archive (built-in since PS 5.0)
        //   Linux/macOS: unzip
        let unzipOk = false;
        if (process.platform === 'win32') {
          const psR = spawnSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-Command',
              'Expand-Archive -Force -LiteralPath $args[0] -DestinationPath $args[1]',
              zipPath,
              paths.extractDir,
            ],
            { stdio: 'pipe', timeout: 60_000 },
          );
          if (psR.status !== 0) throw new Error(psR.stderr?.toString() || 'Expand-Archive failed');
          unzipOk = true;
        } else {
          const unzipR = spawnSync('unzip', ['-o', zipPath, '-d', paths.extractDir], { stdio: 'pipe', timeout: 60_000 });
          if (unzipR.status !== 0) throw new Error(unzipR.stderr?.toString() || 'unzip failed');
          unzipOk = true;
        }
        if (unzipOk) {
          fs.unlinkSync(zipPath);
          logger.info(`[deploy] Package extracted for ${deploymentId}`);
        }
      } else if (gitRepo) {
        // SEC: all git commands use spawnSync with array args — no shell, no injection
        logger.info(`[deploy] Cloning ${gitRepo}@${gitBranch}`);
        const cloneR = spawnSync(
          'git', ['clone', '--depth', '1', '--branch', gitBranch, gitRepo, '.'],
          { cwd: paths.extractDir, stdio: 'pipe', timeout: 120_000 },
        );
        if (cloneR.status !== 0) throw new Error(cloneR.stderr?.toString() || 'git clone failed');

        if (gitCommit) {
          const coR = spawnSync('git', ['checkout', gitCommit], { cwd: paths.extractDir, stdio: 'pipe', timeout: 30_000 });
          if (coR.status !== 0) throw new Error(coR.stderr?.toString() || 'git checkout failed');
        }
      }

      // Install dependencies before publishing the release.
      installDeps(paths.extractDir, runtime, envVars);

      // Write .env file for the app before publishing the release.
      if (Object.keys(envVars).length > 0) {
        const envContent = Object.entries(envVars).map(([k, v]) => `${k}=${v}`).join('\n');
        fs.writeFileSync(path.join(paths.extractDir, '.env'), envContent, { encoding: 'utf-8', mode: 0o600 });
      }

      removePathIfExists(paths.finalReleaseDir);
      fs.renameSync(paths.extractDir, paths.finalReleaseDir);
      switchCurrentRelease(paths.currentLink, paths.finalReleaseDir);
      switchedCurrent = true;
      logger.info(`[deploy] Current release for ${appName} now points to ${paths.releaseKey}`);

      // Start app if runMode is daemon or once
      // Pick a sensible default entrypoint based on runtime when none was specified
      const defaultEntry = (runtime === 'python') ? 'main.py'
        : (runtime === 'node' || runtime === 'nodejs') ? 'index.js'
        : 'main.sh';
      const entry = entrypoint || defaultEntry;
      if (runMode === 'daemon' || runMode === 'once') {
        startApp(deploymentId, paths.finalReleaseDir, runtime, entry, runMode, envVars);
      } else {
        // scheduled mode: just deploy, tasks are triggered via normal task dispatch
        await reportStatus(deploymentId, 'running', undefined, 'Deployed in scheduled mode');
      }
    } catch (err: any) {
      if (switchedCurrent) {
        restoreCurrentRelease(paths.currentLink, previousCurrentTarget);
      }
      removePathIfExists(paths.extractDir);
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
    // Escalate to SIGKILL when the process ignores SIGTERM (mirroring the
    // upgrade path) — otherwise daemons keep running unmanaged.
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* already dead */ }
    }, 10_000);
    child.once('exit', () => clearTimeout(killTimer));
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
