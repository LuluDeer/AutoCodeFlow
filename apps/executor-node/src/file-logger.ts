import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import { logger } from './logger';
// A6: 死信侧车后缀（死信计数与保留扫描都要排除它，见 getDeadLetterCount）
import {
  deadLetterPayloadName,
  DEAD_LETTER_SIDECAR_EXCLUDE_RE,
} from './dead-letter-sidecar';
// NFR-15/D12：解释器池体积红线治理。挂在同一轮磁盘清扫里（一次定时任务同时管
// "过期"与"过大"，与 python maintenance.cleanup_work_dir 同构）。方向单向：
// interpreters.ts 不 import 本模块，无循环依赖。
import { enforceInterpreterPoolLimits } from './interpreters';

// E10: logsDir 惰性解析（与 callback.ts 的 getCallbackDir 同构）——每次访问
// 经 config.workDir（读 process.env 的 getter）重算，/config/reload 热更
// workDir 后写路径与 routes/logs.ts 的读路径同步切换，不再于模块加载期固化
// 导致写旧目录、读新目录的分裂。
function getLogsDir(): string {
  const dir = path.join(config.workDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getLogFilePath(executionId: string, date?: Date): string {
  const dateStr = date ? formatDate(date) : formatDate(new Date());
  const dateDir = path.join(getLogsDir(), dateStr);
  fs.mkdirSync(dateDir, { recursive: true });
  return path.join(dateDir, `${executionId}.log`);
}

// NETOPT-9-4: pin an execution's log file to the date shard it STARTED in.
// getLogFilePath() resolves "today" at call time, so a task running across
// midnight used to split its log across two date shards — routes/logs.ts
// scans newest-first and breaks on the first hit, so the pre-midnight half
// became unreachable and totalLines reset mid-run. The execution pins its
// path once at accept (createExecutionEntry); appendLog/appendLogSync use the
// pinned path while it lives, and release() unpins at the terminal transition.
const pinnedLogPaths = new Map<string, string>();

export function pinLogFilePath(executionId: string, date?: Date): string {
  const filePath = getLogFilePath(executionId, date);
  pinnedLogPaths.set(executionId, filePath);
  return filePath;
}

export function unpinLogFilePath(executionId: string): void {
  pinnedLogPaths.delete(executionId);
}

export function getPinnedLogFilePath(executionId: string): string | undefined {
  return pinnedLogPaths.get(executionId);
}

// --- Buffered async log writer -------------------------------------------------
// appendFileSync per stdout chunk blocked the event loop (heartbeats, /health)
// under high-output tasks. Writes now buffer in memory and flush to disk every
// FLUSH_INTERVAL_MS via fs.promises (libuv threadpool), keeping the event loop
// free; an explicit flush covers shutdown, read-back and tests.
const FLUSH_INTERVAL_MS = 200;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

const pendingWrites = new Map<string, string>();
let flushTimer: NodeJS.Timeout | null = null;
let flushing: Promise<void> = Promise.resolve();

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flushLogs();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

export async function flushLogs(): Promise<void> {
  const run = flushing.then(async () => {
    while (pendingWrites.size > 0) {
      const batch = [...pendingWrites.entries()];
      pendingWrites.clear();
      for (const [filePath, content] of batch) {
        try {
          await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
          await fs.promises.appendFile(filePath, content);
        } catch (error: unknown) {
          logger.error(
            `Failed to append log ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  });
  flushing = run;
  await run;
}

export function stopLogWriter(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

export function appendLog(executionId: string, content: string): void {
  const filePath = pinnedLogPaths.get(executionId) ?? getLogFilePath(executionId);
  const pending = pendingWrites.get(filePath) ?? '';
  let combined = `${pending}${content}\n`;
  // Drop the oldest buffered content if a pathological chunk burst outgrows
  // the buffer — memory safety wins over log completeness.
  if (combined.length > MAX_BUFFERED_BYTES) {
    combined = combined.slice(combined.length - MAX_BUFFERED_BYTES);
  }
  pendingWrites.set(filePath, combined);
  scheduleFlush();
}

/** Backwards-compatible synchronous append used by callers that must see the
 *  content on disk immediately (tests, read-back helpers). */
export function appendLogSync(executionId: string, content: string): void {
  const filePath = pinnedLogPaths.get(executionId) ?? getLogFilePath(executionId);
  fs.appendFileSync(filePath, content + '\n');
}

export function readLog(executionId: string, fromLine: number = 0, maxLines: number = 1000): { lines: string[], totalLines: number } {
  const filePath = getLogFilePath(executionId);
  
  if (!fs.existsSync(filePath)) {
    return { lines: [], totalLines: 0 };
  }
  
  const content = fs.readFileSync(filePath, 'utf-8');
  const allLines = content.split('\n').filter(line => line.length > 0);
  const totalLines = allLines.length;
  
  if (fromLine >= totalLines) {
    return { lines: [], totalLines };
  }
  
  const endIndex = Math.min(fromLine + maxLines, totalLines);
  const lines = allLines.slice(fromLine, endIndex);
  
  return { lines, totalLines };
}

export function clearLog(executionId: string): void {
  const filePath = getLogFilePath(executionId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function deleteOldLogs(retentionDays: number): number {
  let deletedCount = 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const logsDir = getLogsDir();

  try {
    const dateDirs = fs.readdirSync(logsDir);
    // NETOPT-C P3: 仍被 pin 的日志分片不得物理删除——超长任务（timeout=0）
    // 跨 retention 运行时起始分片会被整目录 rmSync，后续 append 因目录消失
    // ENOENT，磁盘历史静默丢失。
    const pinnedDirs = new Set(
      [...pinnedLogPaths.values()].map((p) => path.resolve(path.dirname(p))),
    );
    for (const dateDir of dateDirs) {
      // Directory names are YYYY-MM-DD (see formatDate) — stat.birthtime is
      // unreliable on Linux (often falls back to mtime/epoch), so derive the
      // age from the directory name instead.
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateDir);
      if (!m) continue;
      const dirTime = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
      if (Number.isNaN(dirTime) || dirTime >= cutoff) continue;
      const dirPath = path.resolve(path.join(logsDir, dateDir));
      if (pinnedDirs.has(dirPath)) {
        logger.debug(`Skipping log directory with pinned active log: ${dateDir}`);
        continue;
      }
      fs.rmSync(dirPath, { recursive: true, force: true });
      deletedCount++;
      logger.debug(`Deleted old log directory: ${dateDir}`);
    }
  } catch (error: unknown) {
    logger.error(`Error deleting old logs: ${error instanceof Error ? error.message : String(error)}`);
  }
  
  return deletedCount;
}

let cleanupInterval: NodeJS.Timeout | null = null;

export function startLogCleanup(retentionDays: number = 7): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
  }
  
  logger.info(`Starting log cleanup thread (retention: ${retentionDays} days)`);
  
  const cleanup = () => {
    const deleted = deleteOldLogs(retentionDays);
    if (deleted > 0) {
      logger.info(`Cleaned up ${deleted} old log directories`);
    }
  };
  
  cleanup();
  
  cleanupInterval = setInterval(cleanup, 24 * 60 * 60 * 1000);
}

export function stopLogCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    logger.info('Stopped log cleanup thread');
  }
  stopLogWriter();
}

// --- Workdir disk cleanup -------------------------------------------------------
// Task workdirs, git caches and downloaded packages previously accumulated
// forever — a long-running executor slowly filled the disk until every
// npm/git/uv operation failed. Strategy (aligned with the 7-day log policy):
//   - task workdirs older than CLEANUP_TTL_DAYS are removed
//   - .git_cache / .node_modules entries not touched within TTL are removed
//   - .pkg-updates keeps only the newest MAX_PKG_UPDATES package files
//   - callbacks/dead-letter keeps only the newest MAX_DEAD_LETTER_FILES files
//   - orphan callbacks/*.meta (dead-lettering failed to unlink them) older
//     than ORPHAN_META_TTL_MS are reclaimed (E13)
const CLEANUP_TTL_DAYS = Math.max(1, config.logRetentionDays || 7);
const CLEANUP_SWEEP_INTERVAL_HOURS = 6;

// --- Disk watermark governance (P2) -----------------------------------------
// TTL 清扫基于 mtime 而非磁盘水位：磁盘在 TTL 窗口内被撑满时没有主动应对
// （python 侧同缺口，见 maintenance.disk_usage_percent 对等实现）。这里补两道
// 防线：告警水位触发减半 TTL 的紧急清理；临界水位由 accept 阶段拒新任务
// （execute.ts）兜底——磁盘满时任何任务都会在写 workdir/log 阶段失败，拒绝
// 新任务比让任务在准备阶段失败更诚实。
// 阈值来自 config（DISK_WARN_PERCENT / DISK_CRITICAL_PERCENT，默认 90/95）：
// getter 在模块加载时求值一次，与 process.env 启动期读取一致；测试经
// jest.mock 替换本模块导出，行为不受影响。
export const DISK_WARN_PERCENT = config.diskWarnPercent;
export const DISK_CRITICAL_PERCENT = config.diskCriticalPercent;

/** workDir 所在文件系统的已用百分比（0-100）。fs.statfs 取 `bavail`（非 root
 *  可用块）——水位应反映"还能写多少"，而不是 root 的保留空间。计量失败返回 0：
 *  调用方按"无压力"处理，不因一次 statfs 失败误拒任务。 */
export function diskUsagePercent(): number {
  try {
    const st = fs.statfsSync(config.workDir);
    if (!st.blocks || st.bsize <= 0) return 0;
    const used = st.blocks - st.bavail;
    return Math.round((used / st.blocks) * 100);
  } catch {
    return 0;
  }
}
const PROTECTED_WORKDIR_NAMES = new Set([
  'logs', 'meta', 'callbacks', '.git_cache', '.node_modules', '.pkg-updates', 'apps',
  // WS5（python_task_multiversion）：`.venvs` 是**按任务复用的共享缓存**，不是
  // 某个 execution 的工作目录。不加这个保护名，下面的 workdir 清扫会把整个
  // `.venvs` 目录当成一个过期任务目录整棵删掉——所有任务的 venv 一次性消失，
  // 下次每个任务都要重建 venv + 重装依赖（python 侧 `_PROTECTED_WORKDIR_NAMES`
  // 从一开始就含 `.venvs`，node 侧是本特性才引入这个目录，必须同步）。
  // 它的过期回收走下方与 .git_cache/.node_modules 同构的按分片 TTL 清扫。
  '.venvs',
  // ARCH-36（ADR-017 阶段 2）：`.device-identity` 存放安装实例盐
  // （`<workDir>/.device-identity/<kind>.salt`）。**必须保护**——下面第 1 段
  // 清扫遍历 workDir 的**所有**顶层条目（含普通文件）并按 mtime 删除，盐被删
  // 掉后下次启动会重新生成，deviceFingerprint 随之静默漂移（默认 7 天一次），
  // 于是「同一 address 出现两个指纹」这类观测全部失真，ADR-017 阶段 3 以指纹
  // 为定位键时更会把同一台机器当成新设备。python 侧
  // `maintenance._PROTECTED_WORKDIR_NAMES` 同名同源。
  '.device-identity',
]);

// E-08: active-execution guard for the workdir sweep. The set of live
// executions (and their taskIds used for .git_cache / .node_modules shards) is
// owned by routes/execute — to avoid a circular import (file-logger is already
// imported by execute.ts) we accept a provider that execute registers at load
// time (mirrors scheduler's provider pattern).
// fail-safe: if the provider throws or returns nothing, the sweep deletes
// NOTHING (liveness unknown) — aligned with python maintenance._live_workdir_names.
export interface ActiveWorkdirSet {
  executionIds: Set<string>;
  taskIds: Set<string>;
  /**
   * WS5：活跃任务对应的 `.venvs` **目录名**（`<taskId>` 或 `<taskId>-<X.Y>`）。
   *
   * 为什么不在这里按 `taskIds` 现推：venv 目录名的版本签名派生是
   * `execute.ts::venvDirName` 的**唯一职责**（DESIGN §1.2.2 的"三处同源"纪律：
   * 目录名、锁键、清扫保护集必须同源）。在这里再写一遍反向解析就是第二个事实
   * 源，两边一旦漂移，清扫会删掉活跃任务的 venv——正是那条纪律要防的事故。
   *
   * 可选：缺席（旧注册方）时 `.venvs` 分片**一律不删**（fail-safe，宁可留垃圾
   * 也不删活 venv）。
   */
  venvDirNames?: Set<string>;
}
let activeWorkdirProvider: () => ActiveWorkdirSet = () => ({ executionIds: new Set(), taskIds: new Set() });
export function registerActiveWorkdirProvider(fn: () => ActiveWorkdirSet): void {
  activeWorkdirProvider = fn;
}

function removePath(target: string): boolean {
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch (error: unknown) {
    logger.warn(
      `Disk cleanup failed for ${target}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/** NETOPT-C P3: 正则转义——活跃 executionId 拼进 meta 文件名匹配时防元字符误伤。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeOlderThan(
  dir: string,
  cutoffMs: number,
  options: {
    keepNewest?: number;
    directoryNames?: RegExp;
    filesOnly?: boolean;
    /** A6: 名字匹配者既不占 keepNewest 名额，也照常按 cutoff 删除。 */
    exclude?: RegExp;
    /** NETOPT-C P3: 名字匹配者一律不删（既不按 cutoff，也不计 keepNewest）——
     *  用于活跃执行的 meta 文件保护（区别于 exclude 的"不占名额但照删"）。 */
    protected?: RegExp;
  } = {},
): number {
  let deleted = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  // newest (largest mtime) first so "keep newest N" retention is deterministic
  const withMtime: Array<{ name: string; isDir: boolean; mtime: number }> = [];
  for (const entry of entries) {
    // E12: filesOnly — the dead-letter sweep must mirror getDeadLetterCount's
    // "only regular files" semantics: a stray subdirectory is neither counted
    // toward keepNewest nor recursively removed (it is not a callback payload).
    if (options.filesOnly && entry.isDirectory()) continue;
    if (options.directoryNames && entry.isDirectory() && !options.directoryNames.test(entry.name)) continue;
    // NETOPT-C P3: protected 全跳过——活跃执行的 meta 文件不受 TTL 约束。
    if (options.protected && options.protected.test(entry.name)) continue;
    // A6: 排除项不进 withMtime → 不占 keepNewest 名额，也不被保留（任由
    // cutoff 判定）。用于死信侧车：它必须与自己的 payload 同生共死，但不该
    // 把 keepNewest 的额度吃掉一半。
    if (options.exclude && options.exclude.test(entry.name)) {
      const excludedPath = path.join(dir, entry.name);
      try {
        if (fs.statSync(excludedPath).mtimeMs < cutoffMs) {
          if (removePath(excludedPath)) deleted++;
        }
      } catch {
        /* raced — skip */
      }
      continue;
    }
    try {
      const stat = fs.statSync(path.join(dir, entry.name));
      withMtime.push({ name: entry.name, isDir: entry.isDirectory(), mtime: stat.mtimeMs });
    } catch {
      /* raced with a concurrent delete — skip */
    }
  }
  withMtime.sort((a, b) => b.mtime - a.mtime);
  withMtime.forEach((item, index) => {
    if (item.mtime >= cutoffMs) return;
    if (options.keepNewest !== undefined && index < options.keepNewest) return;
    if (removePath(path.join(dir, item.name))) deleted++;
  });
  return deleted;
}

/** E13: reclaim orphan callback `.meta` files stranded in the callbacks/ top
 *  level. When a callback payload is dead-lettered (or retried successfully),
 *  callback.ts unlinks the companion `<file>.json.meta`; if that unlink fails
 *  the meta is stranded forever — retryFailedCallbacks only matches
 *  `callback-*.json`, the dead-letter sweep only descends into dead-letter/,
 *  and `callbacks` itself is in PROTECTED_WORKDIR_NAMES so the workdir sweep
 *  skips it. Remove top-level `.meta` files whose companion payload json is
 *  gone and that are older than ORPHAN_META_TTL_MS. A live retry round
 *  rewrites the meta every pass (well within the window), so an aged orphan
 *  is genuinely stranded.
 *
 *  NETOPT-4: 同一清扫把回调区残留的 `*.tmp` 纳入回收——`.tmp` 是回调落盘
 *  （tmp→rename 原子写，见 callback.atomicWriteFileSync）的**中间态**，
 *  rename 完成即消失，因此一个过龄 .tmp 必然是写盘中途崩溃/失败留下的孤儿
 *  （callbacks/ 顶层与 dead-letter/ 里的侧车 tmp 都算）。ORPHAN_META_TTL_MS
 *  的年龄门保护仍在写入中的活跃 tmp。 */
function removeOrphanCallbackMetaFiles(callbackDir: string, nowMs: number): number {
  let deleted = 0;
  const deadDir = path.join(callbackDir, 'dead-letter');
  /** 过龄 .tmp 回收（调用方已保证 entry.isFile() 且以 .tmp 结尾）。 */
  const removeIfStaleTmp = (dir: string, name: string): void => {
    const tmpPath = path.join(dir, name);
    try {
      const stat = fs.statSync(tmpPath);
      if (nowMs - stat.mtimeMs < ORPHAN_META_TTL_MS) return;
    } catch {
      /* raced — skip */
      return;
    }
    if (removePath(tmpPath)) deleted++;
  };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(callbackDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // NETOPT-4: 残留 .tmp（写盘中途崩溃/失败）——超过孤儿 TTL 即回收
    if (entry.name.endsWith('.tmp')) {
      removeIfStaleTmp(callbackDir, entry.name);
      continue;
    }
    if (!entry.name.endsWith('.meta')) continue;
    const metaPath = path.join(callbackDir, entry.name);
    // Companion payload: strip the trailing ".meta" -> "<...>.json".
    const jsonPath = metaPath.slice(0, -'.meta'.length);
    if (fs.existsSync(jsonPath)) continue; // still owned by a live callback file
    try {
      const stat = fs.statSync(metaPath);
      if (nowMs - stat.mtimeMs < ORPHAN_META_TTL_MS) continue;
    } catch {
      /* raced — skip */
      continue;
    }
    if (removePath(metaPath)) deleted++;
  }
  // NETOPT-4: dead-letter/ 里的残留 .tmp（侧车原子写的中间态；payload 本体
  // 经 rename 进死信目录，不会在目录内产生 payload tmp）。
  let deadEntries: fs.Dirent[];
  try {
    deadEntries = fs.readdirSync(deadDir, { withFileTypes: true });
  } catch {
    deadEntries = []; /* dead-letter dir absent — nothing to sweep */
  }
  for (const entry of deadEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.tmp')) continue;
    removeIfStaleTmp(deadDir, entry.name);
  }
  return deleted;
}

/** Remove expired task workdirs, stale caches, old packages and dead-letter
 *  overflow. Safe to run at startup and on an interval. */
export function cleanupWorkDir(
  ttlDays: number = CLEANUP_TTL_DAYS,
): { workDirs: number; caches: number; packages: number; deadLetters: number; orphanMetaFiles: number; metaFiles: number } {
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  let workDirs = 0;
  let caches = 0;
  let packages = 0;
  let deadLetters = 0;
  let orphanMetaFiles = 0;
  let metaFiles = 0;

  // E-08: 活跃执行保护——liveness 未知（provider 抛错/返回空）时删 Nothing
  // （fail-safe，对齐 python maintenance._live_workdir_names）；否则跳过活跃
  // executionId 的工作目录及其关联的 .node_modules/.git_cache 分片（按 taskId）。
  let active: ActiveWorkdirSet | null = null;
  try {
    const probe = activeWorkdirProvider();
    if (probe && probe.executionIds instanceof Set && probe.taskIds instanceof Set) {
      active = probe;
    }
  } catch {
    active = null;
  }
  if (active === null) {
    logger.warn(
      'cleanupWorkDir: active execution probe unavailable (liveness unknown) — ' +
      'skipping all deletions (fail-safe)',
    );
    return { workDirs: 0, caches: 0, packages: 0, deadLetters: 0, orphanMetaFiles: 0, metaFiles: 0 };
  }
  const activeExecIds = active.executionIds;
  const activeTaskIds = active.taskIds;

  try {
    // 1. Task workdirs: any top-level entry that is not infrastructure.
    const baseEntries = fs.readdirSync(config.workDir, { withFileTypes: true });
    for (const entry of baseEntries) {
      if (PROTECTED_WORKDIR_NAMES.has(entry.name)) continue;
      // E-08: 跳过仍在运行（活跃）的 execution 工作目录——drain/关机期间其目录
      // mtime 可能已超 TTL，误删会破坏正在跑的任务（对照 python fail-safe）。
      if (activeExecIds.has(entry.name)) continue;
      const full = path.join(config.workDir, entry.name);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) {
          if (removePath(full)) workDirs++;
        }
      } catch { /* raced — skip */ }
    }

    // 2. Shared caches (.git_cache, .node_modules): drop entries unused past TTL
    //    —但永远不删活跃 task 的分片（活跃任务正在用，删了会让它在下次依赖安装
    //    时全量重装或失败；liveness 未知已被上面的 fail-safe 拦下）。
    for (const cacheDirName of ['.git_cache', '.node_modules']) {
      const cacheBase = path.join(config.workDir, cacheDirName);
      let subEntries: fs.Dirent[];
      try {
        subEntries = fs.readdirSync(cacheBase, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subEntries) {
        const subTarget = path.join(cacheBase, sub.name);
        // E-08: 活跃分片保护——taskId 命中的 .git_cache/.node_modules 子目录保留。
        if (sub.isDirectory() && activeTaskIds.has(sub.name)) continue;
        try {
          const stat = fs.statSync(subTarget);
          if (stat.mtimeMs < cutoff) {
            if (removePath(subTarget)) caches++;
          }
        } catch { /* raced — skip */ }
      }
    }

    // 2b. WS5：`.venvs/<venvDirName>` 分片 TTL 清扫（与 .git_cache/.node_modules
    //     同构，对齐 python maintenance 的 `('.git_cache','caches'), ('.venvs','venvs')`
    //     循环）。venv 是**可复用资产**：健康的复用是 AC-16b 的性能语义，但
    //     永不过期会让每个用过的 taskId 都长期占着几百 MB。
    //
    //     活跃保护用的是 venv **目录名**（含版本签名），不是裸 taskId——
    //     `taskIds` 里是 `t1`，而带版本任务的 venv 目录叫 `t1-3.7`，用 taskId
    //     直接比对会漏保护。派生只在 execute.ts 做一处（见 ActiveWorkdirSet
    //     注释）；provider 没提供该集合时**一律不删**（fail-safe）。
    {
      const venvBase = path.join(config.workDir, '.venvs');
      let venvEntries: fs.Dirent[];
      try {
        venvEntries = fs.readdirSync(venvBase, { withFileTypes: true });
      } catch {
        venvEntries = [];
      }
      const liveVenvNames = active.venvDirNames;
      for (const sub of venvEntries) {
        if (!sub.isDirectory()) continue;
        if (!liveVenvNames) break; // liveness 未知 → 一个都不删
        if (liveVenvNames.has(sub.name)) continue;
        const subTarget = path.join(venvBase, sub.name);
        try {
          const stat = fs.statSync(subTarget);
          if (stat.mtimeMs < cutoff) {
            if (removePath(subTarget)) caches++;
          }
        } catch { /* raced — skip */ }
      }
    }

    // 3. Downloaded packages: keep only the newest few regardless of age.
    packages = removeOlderThan(path.join(process.cwd(), '.pkg-updates'), cutoff, {
      keepNewest: MAX_PKG_UPDATES,
    });

    // 4. Dead-letter callbacks: keep only the newest few for manual replay.
    //    filesOnly (E12): mirrors getDeadLetterCount's file-only semantics —
    //    a stray subdirectory is neither counted toward keepNewest nor
    //    recursively deleted here.
    //    exclude (A6): 侧车不占 keepNewest 名额，否则保留额度会被侧车吃掉
    //    一半（每份死信 payload 旁恰好一个侧车）。
    //    NETOPT-4: exclude 追加 `*.tmp`——残留 tmp 不占保留名额，也不被
    //    getDeadLetterCount 计入积压；其按孤儿 TTL 的回收在步骤 5。
    deadLetters = removeOlderThan(path.join(config.workDir, 'callbacks', 'dead-letter'), cutoff, {
      keepNewest: MAX_DEAD_LETTER_FILES,
      filesOnly: true,
      exclude: new RegExp(`${DEAD_LETTER_SIDECAR_EXCLUDE_RE.source}|\\.tmp$`),
    });

    // 5. E13: reclaim orphan `.meta` files stranded in the callbacks/ top level.
    orphanMetaFiles = removeOrphanCallbackMetaFiles(
      path.join(config.workDir, 'callbacks'),
      Date.now(),
    );

    // 6. NETOPT-9-3: meta/*.json — execution metadata written by execute.ts
    //    writeExecMeta (one file per execution; the desktop history builder
    //    and notifier read them). Nothing ever reclaimed them, so a
    //    long-running executor accumulated them unboundedly, and past ~500
    //    files the desktop notifier's slice(0,500) scan window could
    //    permanently miss new-task terminal notifications. TTL aligns with
    //    the logs; filesOnly mirrors the dead-letter sweep (only regular
    //    files are reclaimed; the `meta` directory itself is protected by
    //    PROTECTED_WORKDIR_NAMES so it is never swept as a workdir).
    // NETOPT-C P3: 活跃执行的 meta 文件受保护——长跑任务（timeout=0）的 meta
    // mtime 停在 running 写入时刻，按 TTL 清扫会删掉仍在用的历史/通知数据。
    metaFiles = removeOlderThan(path.join(config.workDir, 'meta'), cutoff, {
      filesOnly: true,
      protected:
        activeExecIds.size > 0
          ? new RegExp(`^(${[...activeExecIds].map(escapeRegExp).join('|')})\\.json$`)
          : undefined,
    });
  } catch (error: unknown) {
    logger.error(
      `Workdir cleanup error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // L-1（NFR-15/D12）：解释器池不参与 TTL 清扫，改由体积红线治理。
  // 与 python maintenance.cleanup_work_dir 末尾调用 enforce_interpreter_pool_limits
  // 同构：放在同一轮里执行，一次定时任务同时管"过期"与"过大"。
  // 返回值不并入上面的计数对象（既有 test 逐键断言），回收结果走日志。
  try {
    const poolResult = enforceInterpreterPoolLimits();
    if (poolResult.reclaimedVersions > 0 || poolResult.overLimit > 0) {
      logger.warn(`Interpreter pool enforcement: ${JSON.stringify(poolResult)}`);
    }
  } catch (error: unknown) {
    logger.error(
      `Interpreter pool enforcement failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { workDirs, caches, packages, deadLetters, orphanMetaFiles, metaFiles };
}

const MAX_PKG_UPDATES = 3;
const MAX_DEAD_LETTER_FILES = 50;
const ORPHAN_META_TTL_MS = 24 * 60 * 60 * 1000;

/** Current dead-letter backlog size (file count). Reported via heartbeat so
 *  long disconnections (callbacks parked on disk) stay visible to ops. Only
 *  regular files are counted — the dead-letter retention sweep in
 *  cleanupWorkDir runs with filesOnly (E12), so it too only ever removes
 *  files: a stray subdirectory neither inflates the reported backlog nor gets
 *  reclaimed by that sweep.
 *
 *  A6: **排除 `.deadletter.json` 侧车**。A6 起每份死信 payload 旁多了一个记录
 *  死信原因/时间/救回次数的侧车文件，二者一一对应。上报的是「积压了多少条没
 *  送出去的回调」，侧车不是回调——不排除的话这个运维指标会凭空翻倍，而翻倍
 *  恰恰会掩盖对账的真实效果（对账删 payload 时会连带删侧车，指标该降一半）。
 *
 *  NETOPT-4: **排除 `*.tmp`**。tmp 是原子写（tmp→rename）的中间态，rename
 *  完成即消失；未完成的 tmp 是崩溃残留，不进「积压回调」运维指标（其回收见
 *  removeOrphanCallbackMetaFiles 的孤儿清扫）。
 */
export function getDeadLetterCount(): number {
  try {
    return fs
      .readdirSync(path.join(config.workDir, 'callbacks', 'dead-letter'), {
        withFileTypes: true,
      })
      .filter(
        (d) =>
          d.isFile() &&
          deadLetterPayloadName(d.name) === null &&
          !d.name.endsWith('.tmp'),
      )
      .length;
  } catch {
    return 0;
  }
}

/** Separate interval from the log-retention sweep so the two cleanups can be
 *  stopped/started independently. */
let workdirCleanupInterval: NodeJS.Timeout | null = null;

/** Run cleanup at startup and every CLEANUP_SWEEP_INTERVAL_HOURS. Shares the
 *  cadence/retention policy with the log cleanup (same TTL, logRetentionDays). */
export function startWorkDirCleanup(ttlDays: number = CLEANUP_TTL_DAYS): void {
  const sweep = () => {
    const r = cleanupWorkDir(ttlDays);
    const total = r.workDirs + r.caches + r.packages + r.deadLetters + r.orphanMetaFiles + r.metaFiles;
    if (total > 0) {
      logger.info(
        `Workdir cleanup removed ${total} item(s): ${r.workDirs} workdir(s), ${r.caches} cache entr(ies), ${r.packages} package(s), ${r.deadLetters} dead-letter file(s), ${r.orphanMetaFiles} orphan meta file(s), ${r.metaFiles} meta file(s)`,
      );
    }
    // P2：磁盘水位（TTL 基于 mtime，磁盘在 TTL 窗口内被撑满时无主动应对）。
    // 告警水位 → 减半 TTL 立即再跑一轮紧急清理（回收刚生成的过期垃圾）；
    // 临界水位 → 除紧急清理外，accept 阶段会拒新任务（execute.ts 同源读取）。
    const usage = diskUsagePercent();
    if (usage >= DISK_CRITICAL_PERCENT) {
      logger.error(
        `Disk usage critical (${usage}% >= ${DISK_CRITICAL_PERCENT}%) — new task accept will be refused; running emergency cleanup with reduced TTL`,
      );
      const emergency = cleanupWorkDir(Math.max(1, Math.floor(ttlDays / 2)));
      const eTotal =
        emergency.workDirs + emergency.caches + emergency.packages +
        emergency.deadLetters + emergency.orphanMetaFiles + emergency.metaFiles;
      if (eTotal > 0) {
        logger.warn(`Emergency cleanup removed ${eTotal} item(s)`);
      }
    } else if (usage >= DISK_WARN_PERCENT) {
      logger.warn(
        `Disk usage high (${usage}% >= ${DISK_WARN_PERCENT}%) — consider raising log retention budget or adding storage`,
      );
    }
  };

  sweep();
  if (workdirCleanupInterval) clearInterval(workdirCleanupInterval);
  workdirCleanupInterval = setInterval(sweep, CLEANUP_SWEEP_INTERVAL_HOURS * 60 * 60 * 1000);
  workdirCleanupInterval.unref?.();
}

export function stopWorkDirCleanup(): void {
  if (workdirCleanupInterval) {
    clearInterval(workdirCleanupInterval);
    workdirCleanupInterval = null;
  }
}

export function getLogStats(): { totalSize: number; fileCount: number } {
  let totalSize = 0;
  let fileCount = 0;
  
  const walk = (dir: string) => {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (file.endsWith('.log')) {
        totalSize += stat.size;
        fileCount++;
      }
    }
  };
  
  try {
    walk(getLogsDir());
  } catch {
    // Ignore if logs directory doesn't exist
  }
  
  return { totalSize, fileCount };
}