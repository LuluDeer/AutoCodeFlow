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
import { ZipSafetyError, safeExtractZip } from '../zip-safety';
import { isExecutorShuttingDown } from '../shutdown-state';

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

/**
 * NETOPT-E P2-2: 部署 provisioning 的中止信号。deploy 的 setImmediate 后台任务
 * 在 res.json 后继续跑（git clone/npm/pip/unzip 等 detached 长耗时命令），停机
 * 时若不中止会成孤儿进程（Windows 下持锁可让新实例同 app 部署 EBUSY）。执行器
 * gracefulShutdown 调 abortDeployInFlight() 中止全部 in-flight provisioning；
 * 已启动的 daemon（runningApps）不在本集合内——应用进程的生命周期独立于执行器
 * （执行器升级/维护不应杀掉用户部署的生产服务），停机日志会提示存活 daemon 数。
 */
const deployAbort = new AbortController();

/** NETOPT-E P2-2: 停机入口调用——中止全部 in-flight 部署 provisioning。 */
export function abortDeployInFlight(): void {
  if (!deployAbort.signal.aborted) deployAbort.abort();
}

/**
 * NETOPT-8③: deploymentId -> appRoot（apps/<appId> 绝对路径）登记表，在
 * startApp 时登记、进程退出/停止时摘除。runningApps 以 deploymentId 为键，
 * 从 appId 反查「该应用还有哪些 daemon 活着」没有现成路径——/app-uninstall
 * 借本表定位并停掉目标应用的全部 daemon 后再删目录。
 */
const runningAppRoots = new Map<string, string>();

/** Deployments whose next process exit is part of an intentional in-place restart. */
const restartExitReportsToSuppress = new Set<string>();

export function suppressNextRestartExitReport(deploymentId: string): void {
  restartExitReportsToSuppress.add(deploymentId);
}

export function shouldReportProcessExit(deploymentId: string): boolean {
  return !restartExitReportsToSuppress.delete(deploymentId);
}

/**
 * daemon 自动重启（生产反馈：`常驻` 模式名不副实）。
 *
 * 背景：用户反馈「应用部署为什么要管模式？单次/常驻/定时 三个选项里，单次与
 * 常驻行为完全一样」。核对属实——`startApp` 的 runMode 形参此前**零引用**，
 * 调用点只有 `runMode === 'daemon' || runMode === 'once'` 一个分支（两者同路），
 * 且进程退出后只上报 stopped/failed，没有任何重启逻辑。于是"常驻"应用崩一次
 * 就永久躺平，与"单次"无差别——这不是配置问题，是功能没实现。
 *
 * 现在让三个模式真正有区别：
 *   · once      → 跑完即止，退出后上报 stopped/failed（原行为，不变）；
 *   · daemon    → **异常退出自动重启**（带指数退避），干净退出（code 0）不重启
 *                 ——"常驻服务自己正常结束了"应尊重其意图，而不是把它拉起来；
 *   · scheduled → 只落盘不启动（原行为，不变），由任务调度触发。
 *
 * 退避策略：1s 起、每次翻倍、上限 60s；连续失败 **10** 次后放弃并上报 failed
 * （避免"启动即崩"的应用把执行器变成忙等循环）。计数在**成功运行满 60s** 后
 * 清零——即"稳定跑过一分钟"才算一次健康启动，否则慢速崩溃循环也会被当成健康。
 *
 * 与既有语义的交互：
 *   · upgrade/stop/uninstall 都会先 `runningApps.delete()`，而重启定时器在回调
 *     里重新检查 `runningApps.has()`——被显式停掉的 app 不会自我复活；
 *   · 执行器自身 gracefulShutdown 时不重启（`deployAbort.signal.aborted` 判定），
 *     因为停机后本进程即将退出，拉起子进程只会成孤儿。
 */
const RESTART_BASE_DELAY_MS = 1_000;
const RESTART_MAX_DELAY_MS = 60_000;
const RESTART_MAX_ATTEMPTS = 10;
/** 连续运行满该时长即视为"一次健康启动"，重启计数清零。 */
const RESTART_HEALTHY_AFTER_MS = 60_000;

interface DaemonSpec {
  appRoot: string;
  deployDir: string;
  runtime: string;
  entrypoint: string;
  envVars: Record<string, string>;
}
const daemonSpecs = new Map<string, DaemonSpec>();
const restartAttempts = new Map<string, number>();
const restartTimers = new Map<string, NodeJS.Timeout>();

/** 测试用：清空重启状态（避免用例间串扰）。 */
export function resetDaemonRestartState(): void {
  for (const t of restartTimers.values()) clearTimeout(t);
  restartTimers.clear();
  restartAttempts.clear();
  daemonSpecs.clear();
}

/**
 * 进程退出后的 daemon 重启决策。返回 true 表示已安排重启。
 *
 * "是否该继续运行"的唯一权威是 `daemonSpecs` 登记（而非 runningApps——退出
 * 处理器里 runningApps 已被 delete，用它判定会让重启永不发生）：
 *   · 登记在  → 这是应常驻的 daemon，异常退出即重启；
 *   · 登记不在 → 非 daemon，或已被 stop/uninstall/upgrade 显式摘除 → 不重启。
 * 摘除动作统一收敛到 unregisterDaemon()，故"停机意图"只有一个表达点。
 */
export function scheduleDaemonRestart(
  deploymentId: string,
  exitCode: number | null,
): boolean {
  const spec = daemonSpecs.get(deploymentId);
  if (!spec) return false;
  // 执行器自身正在停机 → 不重启（拉起即孤儿）。
  if (deployAbort.signal.aborted) return false;
  // 干净退出（code 0）= 应用主动结束，不重启。
  if (exitCode === 0) return false;

  const attempts = (restartAttempts.get(deploymentId) ?? 0) + 1;
  restartAttempts.set(deploymentId, attempts);
  if (attempts > RESTART_MAX_ATTEMPTS) {
    logger.error(
      `[deploy] App ${deploymentId} crashed ${attempts - 1} times; giving up auto-restart`,
    );
    unregisterDaemon(deploymentId);
    void reportStatus(
      deploymentId,
      'failed',
      undefined,
      `Exited with code ${exitCode} and exceeded ${RESTART_MAX_ATTEMPTS} auto-restart attempts`,
    );
    return false;
  }

  const delay = Math.min(
    RESTART_BASE_DELAY_MS * 2 ** (attempts - 1),
    RESTART_MAX_DELAY_MS,
  );
  logger.warn(
    `[deploy] App ${deploymentId} exited with code ${exitCode}; ` +
      `auto-restart #${attempts} in ${delay}ms (daemon mode)`,
  );
  // unref：重启定时器不应阻止执行器进程退出。
  const timer = setTimeout(() => {
    restartTimers.delete(deploymentId);
    // 定时器触发时再次确认：期间可能已被 stop/uninstall/新部署接管。
    if (deployAbort.signal.aborted) return;
    const current = daemonSpecs.get(deploymentId);
    if (!current) return;
    try {
      startApp(
        deploymentId,
        current.appRoot,
        current.deployDir,
        current.runtime,
        current.entrypoint,
        'daemon',
        current.envVars,
      );
    } catch (err: any) {
      logger.error(
        `[deploy] Auto-restart of ${deploymentId} failed to spawn: ${err.message}`,
      );
      void reportStatus(deploymentId, 'failed', undefined, err.message);
    }
  }, delay);
  timer.unref?.();
  restartTimers.set(deploymentId, timer);
  return true;
}

/** 登记 daemon 重启所需的启动参数（startApp 内调用）。 */
function registerDaemonSpec(deploymentId: string, spec: DaemonSpec): void {
  daemonSpecs.set(deploymentId, spec);
}

/** 摘除 daemon 登记（stop/uninstall/upgrade 接管时调用），使重启不再发生。 */
function unregisterDaemon(deploymentId: string): void {
  daemonSpecs.delete(deploymentId);
  restartAttempts.delete(deploymentId);
  const t = restartTimers.get(deploymentId);
  if (t) {
    clearTimeout(t);
    restartTimers.delete(deploymentId);
  }
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
      const r = await runCommand(npmCmd, npmArgs, { cwd: deployDir, env, timeout: 300_000, shell: isWin, signal: deployAbort.signal });
      if (r.status !== 0) throw new Error(r.stderr?.toString() || 'npm install failed');
    }
  } else if (runtime === 'python') {
    const reqFile = path.join(deployDir, 'requirements.txt');
    if (fs.existsSync(reqFile)) {
      logger.info(`[deploy] Creating Python venv and installing deps in ${deployDir}`);
      const venvDir = path.join(deployDir, '.venv');
      // Try 'python3' first (Linux/macOS), fall back to 'python' (Windows)
      const pythonCmd = isWin ? 'python' : 'python3';
      const venvR = await runCommand(pythonCmd, ['-m', 'venv', venvDir], { cwd: deployDir, env, timeout: 60_000, signal: deployAbort.signal });
      if (venvR.status !== 0) throw new Error(venvR.stderr?.toString() || `${pythonCmd} -m venv failed`);
      const bins = venvBins(venvDir);
      const pipArgs = ['install', '-r', 'requirements.txt'];
      if (config.pythonRegistryUrl) pipArgs.push('-i', config.pythonRegistryUrl);
      const pipR = await runCommand(bins.pip, pipArgs, { cwd: deployDir, env, timeout: 300_000, signal: deployAbort.signal });
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
  appRoot: string,
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
  // NETOPT-8③: 登记 daemon 的 appRoot，供 /app-uninstall 按 appId 定位停机
  runningAppRoots.set(deploymentId, appRoot);

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

  // daemon 重启登记：仅在 daemon 模式下登记（once/scheduled 不重启）。
  // 登记必须在 exit 处理之前完成——启动即崩的应用会立刻触发 exit。
  if (runMode === 'daemon') {
    registerDaemonSpec(deploymentId, {
      appRoot,
      deployDir,
      runtime,
      entrypoint,
      envVars,
    });
    // 稳定运行满 RESTART_HEALTHY_AFTER_MS 视为一次健康启动 → 重启计数清零。
    // unref：不阻止执行器进程退出。
    const healthTimer = setTimeout(() => {
      if (runningApps.get(deploymentId) === child) {
        restartAttempts.delete(deploymentId);
      }
    }, RESTART_HEALTHY_AFTER_MS);
    healthTimer.unref?.();
    child.once('exit', () => clearTimeout(healthTimer));
  } else {
    // 非 daemon：确保不会残留上一轮（同一 deploymentId 先 daemon 后改 once）的登记。
    unregisterDaemon(deploymentId);
  }

  child.on('exit', (code) => {
    runningApps.delete(deploymentId);
    runningAppRoots.delete(deploymentId);
    if (!shouldReportProcessExit(deploymentId)) {
      logger.info(`[deploy] Suppressed exit report for restarted app ${deploymentId}`);
      // 就地重启（upgrade 路径）：本次退出是刻意为之，不触发自动重启逻辑——
      // 调用方会立即用新 release 重新 startApp。但仍需安排后续重启能力，
      // 故此处直接 return（新 startApp 会重新登记 spec）。
      return;
    }
    // daemon 异常退出 → 安排自动重启。返回 true 表示已接管，不再上报终态
    // （重启成功会重新上报 running；放弃重启时由 scheduleDaemonRestart 上报 failed）。
    if (scheduleDaemonRestart(deploymentId, code)) {
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
    runningAppRoots.delete(deploymentId);
    logger.error(`[deploy] App ${deploymentId} error: ${err.message}`);
    // spawn 失败（ENOENT 等）同样走重启决策：daemon 下可能是瞬时故障
    // （例如解释器被临时占用）。scheduleDaemonRestart 内部有次数上限兜底。
    if (scheduleDaemonRestart(deploymentId, null)) {
      return;
    }
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
export function downloadPackage(
  url: string,
  dest: string,
  maxRedirects = 5,
  sendAuth = true,
  signal?: AbortSignal,
): Promise<void> {
  return downloadFile(url, dest, { maxRedirects, sendAuth, signal }).then(() => undefined);
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

/**
 * 同一 `(version, deploymentId)` **重复部署**时，`releaseKey` 与上一次逐字节
 * 相同，于是 `finalReleaseDir` 指向**上一次发布的那个目录**——也就是 `current`
 * 正在指向的、可能仍有进程在跑的活目录。后果有三，第三个是数据完整性损伤：
 *
 *   1. `removePathIfExists(finalReleaseDir)` 会删掉活 release，retention 想保留
 *      的"历史版本"实际从未保留（每次覆盖同一个目录名）；
 *   2. Windows 上若该目录内还有被占用的文件（进程未及退出、或 scheduled 模式下
 *      有任务正在跑），删除直接 `EPERM`/`EBUSY`，部署失败；
 *   3. **最严重**：失败路径的 `restoreCurrentRelease(currentLink,
 *      previousCurrentTarget)` 要把 `current` 指回上一个 release，而那个目录
 *      恰好就是本次被删掉的 `finalReleaseDir` —— 于是回滚把 `current` 指向一个
 *      **已不存在的目录**，应用彻底不可用，且日志只说"恢复失败"。
 *
 * 修复：目标目录已存在时改用带唯一后缀的新目录，让每次部署都真正拿到一个新
 * release。首次部署（目录不存在）保持原命名不变，故既有单测与磁盘布局不受影响。
 *
 * 注意 `buildDeploymentPaths` 仍是**纯函数**（不碰文件系统）——它被单测按精确
 * 路径断言，且"要不要让路"是运行时判定，不属于路径推导。
 */
export function resolveReleasePaths(paths: DeploymentPaths): DeploymentPaths {
  if (!fs.existsSync(paths.finalReleaseDir)) return paths;
  const suffix = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const releaseKey = `${paths.releaseKey}-${suffix}`;
  logger.info(
    `[deploy] Release dir ${paths.releaseKey} already exists; ` +
      `publishing to ${releaseKey} instead (keeps the live release intact)`,
  );
  return {
    ...paths,
    releaseKey,
    finalReleaseDir: path.join(paths.releasesDir, releaseKey),
    extractDir: path.join(paths.tmpDir, `${releaseKey}-extracting`),
  };
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

/**
 * Atomically repoint `<appRoot>/current` at `targetDir`.
 *
 * 生产故障（Windows 升级必失败）：`EPERM: operation not permitted, rename
 * '...\current.next-<pid>-<ts>' -> '...\current'`。
 *
 * 根因是**平台差异**，不是权限问题：Windows 上 `current` 是 **junction**
 * （下方 symlinkSync 的 'junction' 分支），而"把 junction 改名覆盖到已存在
 * 的 junction 上"不被允许 —— 抛 `EPERM`。POSIX 上同样的 rename 覆盖目录符号
 * 链接是合法操作，故 Linux/macOS 从不复现。
 *
 * 原实现只 catch 了 `EEXIST`（POSIX 风格的"目标已存在"），于是 Windows 的
 * `EPERM` 直接冒泡：**首次部署永远成功**（current 尚不存在，rename 无冲突），
 * **第二次起必失败**。这个"装了 1.0.0 成功、升级就炸"的形状正是本缺陷。
 *
 * 修法：Windows 分支先删旧链接再 rename。删除与重建之间有一个极短窗口
 * `current` 不存在，但这在本函数内是可接受的 —— 该窗口内没有任何读方
 * （部署是串行的：同一 deploymentId 的并发由 admin-api 的在途守卫拦下），
 * 且 `restoreCurrentRelease` 会在失败路径上复原。反过来若不做删除，
 * Windows 上根本没有可用的成功路径。
 *
 * `unlinkSync` 对 junction 是安全且正确的：它只删链接本身，**不触碰目标
 * 目录内容**（已实测：删链接后 release 目录与其内部文件完好）。这里刻意
 * 不用 `removePathIfExists`（它走 `rmSync(recursive)`）——递归删除作用在
 * junction 上虽也不会穿透，但语义上"删一棵树"远不如"删一个链接"精确，
 * 一旦将来 Node 行为变化，递归删除误穿透会直接毁掉 release 内容。
 */
function switchCurrentRelease(currentLink: string, targetDir: string): void {
  const tmpLink = `${currentLink}.next-${process.pid}-${Date.now()}`;
  removePathIfExists(tmpLink);
  fs.symlinkSync(targetDir, tmpLink, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    fs.renameSync(tmpLink, currentLink);
  } catch (err: any) {
    // EEXIST: POSIX 风格的"目标已存在"。
    // EPERM:  Windows 上 rename 覆盖已存在的 junction（本缺陷）。两者都走
    //         "先删旧链接再重命名"，语义等价。
    if (err?.code !== 'EEXIST' && err?.code !== 'EPERM') throw err;
    // 删除链接本身；目标目录内容不受影响（见函数头注释）。
    try {
      fs.unlinkSync(currentLink);
    } catch (unlinkErr: any) {
      // ENOENT: 并发/重入导致链接已不在 —— 继续 rename 即可，不算失败。
      if (unlinkErr?.code !== 'ENOENT') throw unlinkErr;
    }
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

/**
 * ⚠️ 已删除：`assertSafeZipEntries()`。
 *
 * 它曾在 `/api/deploy` 的 packageUrl 分支里承担 zip-slip 路径闸门，但**从未
 * 真正生效**——Windows 分支用 `powershell.exe -Command '<脚本>' <arg>` 加
 * PowerShell 自动变量取参，而该形态根本不填充那个变量（`-Command` 已消费掉
 * 脚本字符串，后续 token 成为脚本的独立输出而非参数）。空路径让
 * `ZipFile::OpenRead` 抛异常，但 PowerShell 把异常记为 **non-terminating
 * error、退出码仍为 0**，于是 `status !== 0` 不触发、条目列表成空数组、
 * `findUnsafeZipEntries([])` 返回空 —— 检查静默通过。
 *
 * 现在解压走 `zip-safety.ts` 的 `safeExtractZip`，它**在进程内**逐条目断言
 * 路径（不经过任何外部工具的路径决策），额外覆盖符号链接条目、NUL 截断、
 * 盘符路径与 TOCTOU 复查。本函数没有存在价值，删除以免被再次复用。
 *
 * `findUnsafeZipEntries`（上方）保留：它是纯函数、有单测，且仍是
 * `zip-safety.ts` 之外唯一把"双分隔符 + 盘符 + 绝对路径"规则文档化的地方。
 *
 * 注：本注释刻意不写出那个 PowerShell 变量的字面量——`zip-safety.spec.ts`
 * 有一条源码守卫禁止它在 `deploy.ts` 里出现，写出来会把自己扫红。
 */


/** Main deploy handler */
deployRouter.post('/deploy', async (req: Request, res: Response) => {
  // NETOPT-E P2-2: drain 守卫——停机宽限窗口内不再接受新部署（provisioning 是
  // detached 长耗时命令，停机中接受会在宽限到期后留孤儿子进程）。
  if (isExecutorShuttingDown()) {
    return res.status(503).json({ error: 'Executor is shutting down' });
  }
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
  // let（非 const）：下方 resolveReleasePaths 可能因目标目录已存在而换用带唯一
  // 后缀的新 release 目录，catch 块与后续步骤都要用换过之后的路径。
  let paths = buildDeploymentPaths(config.workDir, appId, deploymentId, version);

  // Acknowledge immediately; deploy runs async
  res.json({ ok: true, deploymentId });

  setImmediate(async () => {
    // 先让路：目标 release 目录已存在（同 version+deploymentId 重复部署）时改用
    // 新目录，避免删掉 current 正在指向的活 release —— 否则失败回滚会把 current
    // 指向已删除的目录。详见 resolveReleasePaths 注释。
    paths = resolveReleasePaths(paths);
    const previousCurrentTarget = readCurrentTarget(paths.currentLink);
    let switchedCurrent = false;
    try {
      // Stop existing process if upgrading — wait for actual exit instead of fixed sleep
      if (upgrade && runningApps.has(deploymentId)) {
        const existing = runningApps.get(deploymentId)!;
        suppressNextRestartExitReport(deploymentId);
        // 摘除 daemon 登记：这次退出是升级刻意为之，绝不能被自动重启逻辑
        // 当成崩溃而把旧 release 的进程再拉起来（下方会用新 release 重新
        // startApp，届时重新登记）。suppressNextRestartExitReport 只压制
        // "上报终态"，不阻止重启，两者职责不同、必须都做。
        unregisterDaemon(deploymentId);
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
        await downloadPackage(packageUrl, zipPath, 5, true, deployAbort.signal);
        logger.info(`[deploy] Extracting package for ${deploymentId}`);
        // 解压走 `safeExtractZip`（与 execute.ts 的包任务同一条路径）。
        //
        // ## 为什么不再用 Expand-Archive / unzip（生产故障复盘）
        //
        // 原实现是「`guardZipOrThrow` → `assertSafeZipEntries` → 平台分支
        // （Windows 走 `Expand-Archive`，其余走 `unzip`）」，三步。前两步的
        // **Windows 分支**都把路径经 `powershell.exe -Command '<脚本>' <arg>`
        // 传参，脚本里用 `$args[0]` 取——**这个形态根本不填充 `$args`**：
        // `-Command` 已消费掉脚本字符串，后续 token 成为脚本的独立输出而非
        // 参数（实测 `powershell -Command 'Write-Output $($args.Count)' a b`
        // 输出 `0`，`a b` 被原样打印）。于是：
        //
        //   1. `Expand-Archive -LiteralPath $args[0]` 拿到空串 →
        //      `ParameterArgumentValidationError` → 部署**必然失败**（生产实证）；
        //   2. 更严重的是 `assertSafeZipEntries` 的
        //      `ZipFile::OpenRead($args[0])` 同样拿到空串 → 抛
        //      "Empty path name is not legal."，但 PowerShell 把该异常记为
        //      **non-terminating error，退出码仍为 0** → `status !== 0` 检查
        //      不触发 → `entries` 变成空数组 → `findUnsafeZipEntries([])` 返回
        //      空 → **zip-slip 路径遍历闸门被静默跳过**。即 Windows 上这道
        //      SEC 闸门从未真正生效，且因为退出码是 0 而毫无迹象。
        //
        // 换成 `safeExtractZip` 后两个问题一起消失，且**严格更强**：
        //   - 它内部先跑 `assertZipFileSafe`（zip-guard 炸弹审查），
        //     再逐条目断言路径（zip-slip / 绝对路径 / `..` 段），
        //     再按 stored/deflate 自行解压（不把路径决策权交给外部工具）；
        //   - 额外拒绝**符号链接条目**（Expand-Archive 会照建，落盘即逃逸通道）；
        //   - 落盘前用 `realpathSync` 复查父目录仍在 destDir 内（防 TOCTOU 替换）；
        //   - 按**实际**解压字节二次卡上限（中央目录声明可以撒谎）。
        //   这也是 `zip-safety.ts` 模块头注明的存在理由，execute.ts 早已采用。
        try {
          safeExtractZip(zipPath, paths.extractDir, { removeArchive: true });
        } catch (err) {
          if (err instanceof ZipSafetyError) {
            throw new Error(`Unsafe or invalid package archive: ${err.message}`);
          }
          throw err;
        }
        logger.info(`[deploy] Package extracted for ${deploymentId}`);
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
          { cwd: paths.extractDir, timeout: 120_000, signal: deployAbort.signal },
        );
        if (cloneR.status !== 0) throw new Error(cloneR.stderr?.toString() || 'git clone failed');

        if (gitCommit) {
          const coR = await runCommand('git', ['checkout', gitCommit], { cwd: paths.extractDir, timeout: 30_000, signal: deployAbort.signal });
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
        startApp(deploymentId, paths.appRoot, paths.finalReleaseDir, runtime, entry, runMode, envVars);
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

/**
 * NETOPT-8③: /app-stop 的核心逻辑抽出（/app-uninstall 复用同一停机语义）。
 * 杀整个进程树（daemon 是 detached 组长，杀父进程会孤儿化其子进程），SIGTERM
 * 不退 10s 后升级 SIGKILL。返回是否确有 daemon 被停。
 */
function stopRunningApp(deploymentId: string): boolean {
  // 先摘除 daemon 登记：这是"停机意图"的唯一表达点——若不摘，exit 处理器会
  // 把这次刻意停机当成崩溃并自动重启，stop/uninstall 直接失效。
  unregisterDaemon(deploymentId);
  const child = runningApps.get(deploymentId);
  if (!child) return false;
  killProcessTree(child, 'SIGTERM');
  // Escalate to SIGKILL when the process ignores SIGTERM (mirroring the
  // upgrade path) — otherwise daemons keep running unmanaged.
  const killTimer = setTimeout(() => {
    killProcessTree(child, 'SIGKILL');
  }, 10_000);
  child.once('exit', () => clearTimeout(killTimer));
  runningApps.delete(deploymentId);
  runningAppRoots.delete(deploymentId);
  logger.info(`[deploy] Stopped app ${deploymentId}`);
  return true;
}

/** Stop a running app */
deployRouter.post('/app-stop', (req: Request, res: Response) => {
  const { deploymentId } = req.body;
  stopRunningApp(deploymentId);
  res.json({ ok: true });
});

/**
 * NETOPT-8③: Uninstall an application — stop every daemon recorded under
 * apps/<appId> (reusing the /app-stop kill semantics) and then remove the
 * app directory. Idempotent: a missing directory is still success (the admin
 * side is best-effort; old executors 404 on this route and are ignored).
 *
 * Path safety mirrors the deploy route's appId guard: a strict segment
 * whitelist (isSafePathSegment — no separators, no traversal, no absolute
 * forms) PLUS a resolved-containment check inside the apps root as defense
 * in depth: the rm -rf target must stay inside <workDir>/apps even if the
 * whitelist ever loosens.
 */
deployRouter.post('/app-uninstall', (req: Request, res: Response) => {
  const appId = req.body?.appId ?? req.body?.applicationId;
  if (!appId) {
    return res.status(400).json({ error: 'appId is required' });
  }
  if (typeof appId !== 'string' || !isSafePathSegment(appId)) {
    return res.status(400).json({ error: 'appId contains unsupported characters' });
  }
  const appsRoot = path.resolve(config.workDir, 'apps');
  const appRoot = path.resolve(appsRoot, appId);
  if (appRoot !== appsRoot && !appRoot.startsWith(appsRoot + path.sep)) {
    return res.status(400).json({ error: 'appId resolves outside the apps root' });
  }

  // 先停 daemon：本应用名下（appRoot 在目标 apps/<appId> 内）的全部进程，
  // rm -rf 不会杀死已启动进程（POSIX unlink 后 inode 存活），必须显式停。
  //
  // 两个登记表都要扫：runningAppRoots 只覆盖"当前活着"的进程，而正在退避等待
  // 重启的 daemon 已从 runningApps/runningAppRoots 摘除、只剩 daemonSpecs 里的
  // 登记——只扫前者会让它在 rm -rf 之后被定时器重新拉起，指向已删除的目录。
  const stopped: string[] = [];
  const targets = new Set<string>();
  for (const [deploymentId, root] of runningAppRoots) {
    const resolvedRoot = path.resolve(root);
    if (resolvedRoot === appRoot || resolvedRoot.startsWith(appRoot + path.sep)) {
      targets.add(deploymentId);
    }
  }
  for (const [deploymentId, spec] of daemonSpecs) {
    const resolvedRoot = path.resolve(spec.appRoot);
    if (resolvedRoot === appRoot || resolvedRoot.startsWith(appRoot + path.sep)) {
      targets.add(deploymentId);
    }
  }
  for (const deploymentId of targets) {
    stopRunningApp(deploymentId);
    stopped.push(deploymentId);
  }

  let removed = false;
  let error: string | undefined;
  try {
    if (fs.existsSync(appRoot)) {
      fs.rmSync(appRoot, { recursive: true, force: true });
      removed = true;
    }
  } catch (err: any) {
    error = err?.message ?? String(err);
    logger.warn(`[deploy] Failed to remove app dir ${appRoot}: ${error}`);
  }
  logger.info(
    `[deploy] Uninstalled app ${appId} (stopped ${stopped.length} daemon(s), removed=${removed})`,
  );
  return res.json({ ok: true, appId, stopped, removed, ...(error ? { error } : {}) });
});

/** List running apps */
deployRouter.get('/app-status', (_req: Request, res: Response) => {
  const status: Record<string, { pid: number | undefined; running: boolean }> = {};
  for (const [id, child] of runningApps) {
    status[id] = { pid: child.pid, running: !child.killed };
  }
  res.json(status);
});

// startApp 一并导出供测试直接驱动（deploy-restart.spec.ts 需要"以 daemon 模式
// 启动后触发退出"这条链路；走 HTTP 路由会绕进 mock 过的 fs/child_process 分支，
// 反而测不到重启决策本身）。
//
// switchCurrentRelease / restoreCurrentRelease 同样导出：它们是 Windows EPERM
// 缺陷的**修复点本身**。仅测试"裸 rename 会抛 EPERM"只能证明平台语义，无法证明
// 本函数处理了它——实测把 EPERM 从 catch 条件里删掉，只测平台语义的用例全绿
// （变异存活）。导出后可直接断言"junction 覆盖场景下本函数不抛且 current 指向
// 新 release"，让该缺陷真正被回归测试覆盖。
export {
  runningApps,
  runningAppRoots,
  daemonSpecs,
  startApp,
  switchCurrentRelease,
  restoreCurrentRelease,
};
