import { Router, Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { config } from '../config';
import { logger } from '../logger';
import { post } from '../admin-client';
import { runCommand, killProcessTree } from '../run-command';
import { buildChildEnv } from '../env-whitelist';
import { downloadFile } from '../lib/download';
import { assertSafeHttpUrl } from '../lib/ssrf-guard';
import { isSafePathSegment } from '../safe-path';
import { guardZipOrThrow } from '../zip-guard';

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

/** E-40（DEEP_REVIEW 0ef3bbe）：.env 行构造——dotenv 解析模型是「一行一个
 *  KEY=VALUE」，旧实现 `${k}=${v}` 裸拼接时，值里一个内嵌 `\nEVIL=1` 就会
 *  给被部署应用凭空注入一个额外环境变量（.env 是该应用唯一的配置入口），
 *  值里的引号/反斜杠同样会被 dotenv 解析成另一种值。
 *  加固方式（键值两层）：
 *   - 键名白名单 `[A-Za-z_][A-Za-z0-9_]*`——不匹配的键直接不写入 .env 并
 *     warn（不抛错：env 另经 buildChildEnv 注入子进程，.env 只是重启后的
 *     持久化副本，因此拒绝写一行坏行比让整次部署失败更小代价）；
 *   - 值统一双引号包裹并转义 `\` `"` CR LF——dotenv 对双引号值的转义语义
 *     是通行子集，`\n` 还原为换行而非分隔新行，换行注入被彻底关闭。 */
const DOTENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function formatDotenvValue(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

export function buildDotenvContent(envVars: Record<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(envVars)) {
    if (!DOTENV_KEY_RE.test(key)) {
      logger.warn(`[deploy] Skipping invalid .env key name: ${JSON.stringify(key)}`);
      continue;
    }
    lines.push(`${key}=${formatDotenvValue(String(value))}`);
  }
  return lines.join('\n');
}

/** Install dependencies for the given deployment directory. Async — the
 *  previous spawnSync calls froze the event loop for up to 5 minutes
 *  (npm/pip installs), stopping heartbeats, /health and every API. */
async function installDeps(
  deployDir: string,
  runtime: string,
  envVars: Record<string, string>,
): Promise<void> {
  // SEC: whitelist env only — the previous `{ ...process.env, ...envVars }`
  // leaked EXECUTOR_SHARED_TOKEN/EXECUTOR_SECRET into user-controlled app
  // install processes, letting deployed code impersonate this executor
  // against admin-api (heartbeats, execution callbacks).
  const env = buildChildEnv(envVars);
  const isWin = process.platform === 'win32';

  if (runtime === 'node' || runtime === 'nodejs') {
    const pkgJson = path.join(deployDir, 'package.json');
    if (fs.existsSync(pkgJson)) {
      logger.info(`[deploy] Installing Node.js dependencies in ${deployDir}`);
      // On Windows, npm is a .cmd file and needs shell:true to resolve
      const npmCmd = isWin ? 'npm.cmd' : 'npm';
      const npmArgs = ['install', '--production'];
      if (config.npmRegistryUrl) npmArgs.push(`--registry=${config.npmRegistryUrl}`);
      const r = await runCommand(npmCmd, npmArgs, { cwd: deployDir, env, timeout: 300_000, shell: isWin });
      if (r.status !== 0) throw new Error(r.stderr?.toString() || 'npm install failed');
    }
  } else if (runtime === 'python') {
    const reqFile = path.join(deployDir, 'requirements.txt');
    if (fs.existsSync(reqFile)) {
      logger.info(`[deploy] Creating Python venv and installing deps in ${deployDir}`);
      const venvDir = path.join(deployDir, '.venv');
      // Try 'python3' first (Linux/macOS), fall back to 'python' (Windows)
      const pythonCmd = isWin ? 'python' : 'python3';
      const venvR = await runCommand(pythonCmd, ['-m', 'venv', venvDir], { cwd: deployDir, env, timeout: 60_000 });
      if (venvR.status !== 0) throw new Error(venvR.stderr?.toString() || `${pythonCmd} -m venv failed`);
      const bins = venvBins(venvDir);
      const pipArgs = ['install', '-r', 'requirements.txt'];
      if (config.pythonRegistryUrl) pipArgs.push('-i', config.pythonRegistryUrl);
      const pipR = await runCommand(bins.pip, pipArgs, { cwd: deployDir, env, timeout: 300_000 });
      if (pipR.status !== 0) throw new Error(pipR.stderr?.toString() || 'pip install failed');
    }
  }
}

/**
 * SEC-DEPLOY-01: validate a shell-runtime entrypoint.
 *
 * Threat: the shell runtime runs `sh -c <entrypoint>` / `cmd.exe /c <entrypoint>`.
 * The string is a *command line*. The original charset `[A-Za-z0-9._/ :\-]`
 * allowed a literal space, so `/usr/bin/env sh -c id` passed validation and
 * executed `id` (verified: returned the real uid/gid list including
 * sudo/docker groups). It correctly blocked `;`, `&`, `|`, `$()`, backticks —
 * i.e. it closed shell *metacharacters* but not *command selection*.
 *
 * The first remediation rejected ALL whitespace. That closed the hole but broke
 * legitimate, already-supported multi-word entrypoints — `sh app.sh`,
 * `node dist/main.js`, `echo hello` all appear in this repo's own specs and
 * selftests, and every such deployment then failed (CI `selftests` /
 * arch31 rollout went red). So the rule must separate "interpreter + script +
 * fixed args" (legitimate) from "shell metacharacter chaining" (attack).
 *
 * Policy: one or more whitespace-separated tokens, each a path-like word
 * matching ^[A-Za-z0-9._][A-Za-z0-9._/-]*$. That excludes quoting and every
 * expansion/separator character (`$`, backtick, `;`, `|`, `&`, `<`, `>`, `(`,
 * `)`, `*`, `?`, `#`, `=`, `~`), and no token may start with `-` (option
 * injection). Without those characters a second command cannot be introduced;
 * the `..` segment check keeps the path inside the deployment directory.
 * Control characters (incl. newline, which would start a second command) are
 * rejected outright.
 *
 * Pure and exported so it is directly unit-testable — the original inline regex
 * had ZERO coverage, which is how the whitespace bypass survived.
 */
export function validateShellEntrypoint(
  entrypoint: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (typeof entrypoint !== 'string' || entrypoint.trim() === '') {
    return { ok: false, reason: 'entrypoint must be a non-empty string' };
  }
  if (/[\u0000-\u001f\u007f]/.test(entrypoint)) {
    return { ok: false, reason: 'must not contain control characters' };
  }
  const tokens = entrypoint.trim().split(/\s+/);
  const TOKEN_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;
  for (const token of tokens) {
    if (!TOKEN_RE.test(token)) {
      return {
        ok: false,
        reason:
          `token ${JSON.stringify(token)} must match ^[A-Za-z0-9._][A-Za-z0-9._/-]*$ ` +
          '(no shell metacharacters, no quoting, no leading dash, no expansion)',
      };
    }
    if (token.split(/[\\/]/).includes('..')) {
      return {
        ok: false,
        reason: `token ${JSON.stringify(token)} must not contain a ".." path segment`,
      };
    }
  }
  return { ok: true };
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
  // SEC: whitelist env only — same trust boundary as task execution. The app
  // and its children get the task/env whitelist plus its own envVars, never
  // the executor's secrets (EXECUTOR_SHARED_TOKEN / EXECUTOR_SECRET).
  const env = buildChildEnv(envVars);

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
  } else if (runtime === 'shell' || runtime === 'bash' || runtime === 'sh') {
    // Critical (executor-node audit 2026-09) + SEC-DEPLOY-01: shell runtime
    // runs `sh -c <entrypoint>` / `cmd.exe /c <entrypoint>`, a direct
    // arbitrary-command surface. Validation is extracted to
    // validateShellEntrypoint() so it is unit-tested (the previous inline
    // regex allowed a literal space, letting `/usr/bin/env sh -c id` execute).
    // With whitespace rejected the string is a single token, so the shell
    // selects exactly the intended script — no metacharacter expansion and no
    // command selection. Arguments belong on the node/python argv path.
    const verdict = validateShellEntrypoint(entrypoint);
    if (!verdict.ok) {
      throw new Error(
        `Refusing shell entrypoint (${verdict.reason}). Received: ${JSON.stringify(entrypoint)}`,
      );
    }
    if (isWin) {
      cmd = 'cmd.exe';
      args = ['/c', entrypoint];
    } else {
      cmd = 'sh';
      args = ['-c', entrypoint];
    }
  } else {
    throw new Error(
      `Unsupported runtime "${runtime}"; expected python | node | shell`,
    );
  }

  logger.info(`[deploy] Starting app ${deploymentId}: ${cmd} ${args.join(' ')}`);

  const child = spawn(cmd, args, {
    cwd: deployDir,
    env,
    // Detached on POSIX so the app leads its own process group — app-stop /
    // upgrade can then kill the whole tree (the app may spawn its own
    // children; a parent-only kill would orphan them).
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // W-24: stdio socket 'error' guards — .pipe() does not swallow source
  // errors, so a failed spawn (ENOENT: missing startCommand, long deploy
  // path without LongPathsEnabled…) would otherwise crash the executor.
  child.stdout?.on('error', () => { /* surfaced via child 'error' handler */ });
  child.stderr?.on('error', () => { /* surfaced via child 'error' handler */ });

  runningApps.set(deploymentId, child);

  // Stream logs to file
  const logFile = path.join(deployDir, 'app.log');
  // E-12: append-only app.log 此前无上限无限增长。启动新进程前，若旧 app.log
  // 已超阈值则轮转（app.log → .1 → .2 → .3，最旧丢弃），本轮从干净的 app.log 起写。
  rotateAppLogIfNeeded(logFile);
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

/** Download a package over HTTP/HTTPS to a local path. Delegates to the
 *  shared downloader (Bearer token + cross-host redirect stripping + absolute
 *  download deadline + size cap) so deploy and update-package behave
 *  identically — update-package previously had a second, token-less copy. */
export function downloadPackage(url: string, dest: string, maxRedirects = 5, sendAuth = true): Promise<void> {
  return downloadFile(url, dest, { maxRedirects, sendAuth }).then(() => undefined);
}

function validatePackageUrl(packageUrl: string): string | null {
  try {
    const parsed = new URL(packageUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `packageUrl scheme not allowed: ${parsed.protocol}. Only http and https are permitted.`;
    }
    // E-04（DEEP_REVIEW 0ef3bbe）：SSRF 闸——fail-closed 拒绝 loopback/私网/
    // link-local（含 169.254.169.254 云元数据）。与 execute.ts 的 gitRepo 闸对齐。
    assertSafeHttpUrl(packageUrl);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'packageUrl is not a valid URL';
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

// E-12（DEEP_REVIEW 0ef3bbe）: 应用部署的 releases 历史与 app.log 永不回收。
// 每次升级都新增 apps/<appId>/releases/<version>-<deploymentId>/（含完整
// node_modules/venv），工作目录清理又把 'apps' 整体列入保护名单，旧 release 与
// daemon 的 app.log 都无任何回收路径，磁盘无界增长。下面补 retention：
//   · releases 目录保留「current 指向项 + 最近 keepCount-1 个（按 mtime）」，其余删；
//   · app.log 超大小阈值时按 .1/.2/.3 轮转（保留 keep 份历史）。
const KEEP_RELEASES = 5;
const APP_LOG_MAX_BYTES = 50 * 1024 * 1024; // 50MB
const APP_LOG_KEEP = 3;

/**
 * Prune a deployment's `releases/` history: keep the symlink target that
 * `current` points at (the live release) plus the `keepCount-1` newest other
 * releases by mtime; delete everything else. Returns the removed absolute dirs.
 * Best-effort: any scan/delete failure is logged, never throws.
 */
export function pruneOldReleases(
  releasesDir: string,
  currentLink: string,
  keepCount: number = KEEP_RELEASES,
): string[] {
  const removed: string[] = [];
  try {
    if (!fs.existsSync(releasesDir)) return removed;
    // current 指向项的目录名（releaseKey）——无论如何不删。
    const currentTarget = readCurrentTarget(currentLink);
    const currentBase = currentTarget ? path.basename(currentTarget) : null;

    const entries = fs.readdirSync(releasesDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        const full = path.join(releasesDir, e.name);
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch {
          mtime = 0;
        }
        return { name: e.name, full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime); // newest first

    // 保留集合：current + 最新 (keepCount-1) 个，合计 keepCount 个。
    const survivors = new Set<string>(currentBase ? [currentBase] : []);
    for (const d of dirs) {
      if (survivors.size >= keepCount) break;
      survivors.add(d.name);
    }

    for (const d of dirs) {
      if (survivors.has(d.name)) continue;
      try {
        fs.rmSync(d.full, { recursive: true, force: true });
        removed.push(d.full);
      } catch (err: any) {
        logger.warn(`[deploy] retention: failed to remove old release ${d.full}: ${err.message}`);
      }
    }
  } catch (err: any) {
    logger.warn(`[deploy] retention scan failed for ${releasesDir}: ${err.message}`);
  }
  return removed;
}

/**
 * Rotate an append-only app.log when it exceeds `maxBytes`: app.log → .1,
 * .1 → .2, …, oldest kept backup dropped. Called at app start (before the
 * new append stream opens), so a fresh cycle starts each deploy/restart.
 * Returns true when a rotation happened. Best-effort, never throws.
 */
export function rotateAppLogIfNeeded(
  logFile: string,
  maxBytes: number = APP_LOG_MAX_BYTES,
  keep: number = APP_LOG_KEEP,
): boolean {
  try {
    if (!fs.existsSync(logFile)) return false;
    const stat = fs.statSync(logFile);
    if (stat.size < maxBytes) return false;
    // i=keep..1：把 .(i-1) 推到 .i（i=1 时 src 即 app.log 本身）。
    for (let i = keep; i >= 1; i--) {
      const src = i === 1 ? logFile : `${logFile}.${i - 1}`;
      const dst = `${logFile}.${i}`;
      try {
        if (fs.existsSync(src)) {
          removePathIfExists(dst);
          fs.renameSync(src, dst);
        }
      } catch (err: any) {
        logger.warn(`[deploy] log rotate: failed ${src} -> ${dst}: ${err.message}`);
      }
    }
    return true;
  } catch (err: any) {
    logger.warn(`[deploy] log rotate check failed for ${logFile}: ${err.message}`);
    return false;
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

/** S6: Pure zip-entry validator. Given the list of entry names read from an
 *  archive, return the ones that would escape the extraction directory. It
 *  rejects POSIX (`/x`), Windows drive (`C:\x`, `C:/x`) and UNC (`\\x`)
 *  absolute paths, and any entry carrying a `..` path segment — splitting on
 *  BOTH separators so a backslash-smuggled traversal (`..\\x`) is caught
 *  identically to `../x`. Kept free of any platform/process/`path.isAbsolute`
 *  dependency so the Linux (`unzip -Z1`) and Windows (PowerShell .NET) listing
 *  branches enforce the exact same rule, and so it is unit-testable on any
 *  host. (The old inline check used `path.isAbsolute`, which on Linux silently
 *  let a Windows-absolute `C:\x` entry through; the explicit patterns here
 *  close that gap.) */
export function findUnsafeZipEntries(entries: string[]): string[] {
  const unsafe: string[] = [];
  for (const entry of entries) {
    const parts = entry.split(/[\\/]+/).filter(Boolean);
    const isAbsolute =
      entry.startsWith('/') ||
      entry.startsWith('\\') ||
      /^[A-Za-z]:[\\/]/.test(entry);
    if (isAbsolute || parts.includes('..')) {
      unsafe.push(entry);
    }
  }
  return unsafe;
}

async function assertSafeZipEntries(zipPath: string): Promise<void> {
  // Read the entry list with a platform-appropriate tool, then run the SAME
  // traversal check. Windows previously returned early here and relied solely
  // on Expand-Archive's own (undocumented) path handling — an asymmetric guard
  // versus the Linux branch.
  let entries: string[];
  if (process.platform === 'win32') {
    // No `unzip` on Windows: enumerate via .NET's ZipFile (zero new deps).
    // ZipFile lives in System.IO.Compression — loaded by default on PowerShell
    // 7+, needing Add-Type on Windows PowerShell 5.1 — so the Add-Type is
    // wrapped in try/catch to work on both. Entry.FullName uses '/' separators
    // per the zip spec; findUnsafeZipEntries normalises both anyway.
    const script =
      'try { Add-Type -AssemblyName System.IO.Compression.FileSystem } catch {}; ' +
      '$z = [System.IO.Compression.ZipFile]::OpenRead($args[0]); ' +
      'try { $z.Entries | ForEach-Object { $_.FullName } } finally { $z.Dispose() }';
    const listR = await runCommand(
      'powershell.exe',
      ['-NoProfile', '-Command', script, zipPath],
      { timeout: 30_000 },
    );
    if (listR.status !== 0) {
      throw new Error(listR.stderr?.toString() || 'zip listing failed');
    }
    entries = listR.stdout.toString().split(/\r?\n/).filter(Boolean);
  } else {
    const listR = await runCommand('unzip', ['-Z1', zipPath], { timeout: 30_000 });
    if (listR.status !== 0) {
      throw new Error(listR.stderr?.toString() || 'unzip listing failed');
    }
    entries = listR.stdout.toString().split(/\r?\n/).filter(Boolean);
  }

  const unsafe = findUnsafeZipEntries(entries);
  if (unsafe.length > 0) {
    throw new Error(`Unsafe zip entry path: ${unsafe[0]}`);
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
            killProcessTree(existing, 'SIGKILL');
            resolve();
          }, 10_000);
          existing.once('exit', () => {
            clearTimeout(gracefulTimeout);
            resolve();
          });
          killProcessTree(existing, 'SIGTERM');
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
        // SEC-05: zip-bomb guard — reject declared-size bombs (ratio /
        // entry-count / per-file & total caps, bounded nested probing)
        // BEFORE handing the archive to Expand-Archive / unzip. Runs after
        // the traversal check below would run; both are independent gates.
        guardZipOrThrow(zipPath);
        await assertSafeZipEntries(zipPath);
        logger.info(`[deploy] Extracting package for ${deploymentId}`);
        // Use platform-appropriate extraction (async — spawnSync here froze
        // the event loop for up to 60s per archive):
        //   Windows: PowerShell Expand-Archive (built-in since PS 5.0)
        //   Linux/macOS: unzip
        let unzipOk = false;
        if (process.platform === 'win32') {
          const psR = await runCommand(
            'powershell.exe',
            [
              '-NoProfile',
              '-Command',
              'Expand-Archive -Force -LiteralPath $args[0] -DestinationPath $args[1]',
              zipPath,
              paths.extractDir,
            ],
            { timeout: 60_000 },
          );
          if (psR.status !== 0) throw new Error(psR.stderr?.toString() || 'Expand-Archive failed');
          unzipOk = true;
        } else {
          const unzipR = await runCommand('unzip', ['-o', zipPath, '-d', paths.extractDir], { timeout: 60_000 });
          if (unzipR.status !== 0) throw new Error(unzipR.stderr?.toString() || 'unzip failed');
          unzipOk = true;
        }
        if (unzipOk) {
          fs.unlinkSync(zipPath);
          logger.info(`[deploy] Package extracted for ${deploymentId}`);
        }
      } else if (gitRepo) {
        // SEC: all git commands use array args via async spawn — no shell, no injection
        // S12: the branch was validated above against `gitBranch || 'main'`, but
        // the clone used the RAW gitBranch — an empty/undefined value reached git
        // as a bad `--branch` argument (empty string, or a spawn TypeError on
        // undefined). Pass `--branch` only when a branch was actually specified;
        // otherwise let git clone the remote's default HEAD (forcing 'main' would
        // break repos whose default is 'master'/other). When gitBranch IS set it
        // is exactly the value the validator checked.
        const cloneArgs = ['clone', '--depth', '1'];
        if (gitBranch) cloneArgs.push('--branch', gitBranch);
        cloneArgs.push(gitRepo, '.');
        logger.info(`[deploy] Cloning ${gitRepo}@${gitBranch || '<default>'}`);
        const cloneR = await runCommand(
          'git', cloneArgs,
          { cwd: paths.extractDir, timeout: 120_000 },
        );
        if (cloneR.status !== 0) throw new Error(cloneR.stderr?.toString() || 'git clone failed');

        if (gitCommit) {
          const coR = await runCommand('git', ['checkout', gitCommit], { cwd: paths.extractDir, timeout: 30_000 });
          if (coR.status !== 0) throw new Error(coR.stderr?.toString() || 'git checkout failed');
        }
      }

      // Install dependencies before publishing the release.
      await installDeps(paths.extractDir, runtime, envVars);

      // Write .env file for the app before publishing the release.
      if (Object.keys(envVars).length > 0) {
        // E-40: escaped/quoted k=v lines — see buildDotenvContent.
        const envContent = buildDotenvContent(envVars);
        fs.writeFileSync(path.join(paths.extractDir, '.env'), envContent, { encoding: 'utf-8', mode: 0o600 });
      }

      removePathIfExists(paths.finalReleaseDir);
      fs.renameSync(paths.extractDir, paths.finalReleaseDir);
      switchCurrentRelease(paths.currentLink, paths.finalReleaseDir);
      switchedCurrent = true;
      logger.info(`[deploy] Current release for ${appName} now points to ${paths.releaseKey}`);

      // E-12: 发布成功后回收旧 releases 历史（保留 current + 最近 N 个），
      // 避免磁盘随每次升级无界增长。best-effort，失败不影响本次发布。
      const pruned = pruneOldReleases(paths.releasesDir, paths.currentLink);
      if (pruned.length > 0) {
        logger.info(`[deploy] retention: pruned ${pruned.length} old release(s) for ${appName}`);
      }

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
    // Apps are spawned detached (process-group leaders) — kill the whole
    // tree so daemons that spawned their own children don't escape.
    killProcessTree(child, 'SIGTERM');
    // Escalate to SIGKILL when the process ignores SIGTERM (mirroring the
    // upgrade path) — otherwise daemons keep running unmanaged.
    const killTimer = setTimeout(() => {
      killProcessTree(child, 'SIGKILL');
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
