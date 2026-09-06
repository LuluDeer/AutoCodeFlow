import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import { logger } from './logger';

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
  const filePath = getLogFilePath(executionId);
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
  const filePath = getLogFilePath(executionId);
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
    for (const dateDir of dateDirs) {
      // Directory names are YYYY-MM-DD (see formatDate) — stat.birthtime is
      // unreliable on Linux (often falls back to mtime/epoch), so derive the
      // age from the directory name instead.
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateDir);
      if (!m) continue;
      const dirTime = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
      if (Number.isNaN(dirTime) || dirTime >= cutoff) continue;
      fs.rmSync(path.join(logsDir, dateDir), { recursive: true, force: true });
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
const PROTECTED_WORKDIR_NAMES = new Set([
  'logs', 'meta', 'callbacks', '.git_cache', '.node_modules', '.pkg-updates', 'apps',
]);

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

function removeOlderThan(dir: string, cutoffMs: number, options: { keepNewest?: number; directoryNames?: RegExp; filesOnly?: boolean } = {}): number {
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
 *  is genuinely stranded. */
function removeOrphanCallbackMetaFiles(callbackDir: string, nowMs: number): number {
  let deleted = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(callbackDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.meta')) continue;
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
  return deleted;
}

/** Remove expired task workdirs, stale caches, old packages and dead-letter
 *  overflow. Safe to run at startup and on an interval. */
export function cleanupWorkDir(
  ttlDays: number = CLEANUP_TTL_DAYS,
): { workDirs: number; caches: number; packages: number; deadLetters: number; orphanMetaFiles: number } {
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  let workDirs = 0;
  let caches = 0;
  let packages = 0;
  let deadLetters = 0;
  let orphanMetaFiles = 0;

  try {
    // 1. Task workdirs: any top-level entry that is not infrastructure.
    const baseEntries = fs.readdirSync(config.workDir, { withFileTypes: true });
    for (const entry of baseEntries) {
      if (PROTECTED_WORKDIR_NAMES.has(entry.name)) continue;
      const full = path.join(config.workDir, entry.name);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) {
          if (removePath(full)) workDirs++;
        }
      } catch { /* raced — skip */ }
    }

    // 2. Shared caches (.git_cache, .node_modules): drop entries unused past TTL.
    for (const cacheDirName of ['.git_cache', '.node_modules']) {
      caches += removeOlderThan(path.join(config.workDir, cacheDirName), cutoff);
    }

    // 3. Downloaded packages: keep only the newest few regardless of age.
    packages = removeOlderThan(path.join(process.cwd(), '.pkg-updates'), cutoff, {
      keepNewest: MAX_PKG_UPDATES,
    });

    // 4. Dead-letter callbacks: keep only the newest few for manual replay.
    //    filesOnly (E12): mirrors getDeadLetterCount's file-only semantics —
    //    a stray subdirectory is neither counted toward keepNewest nor
    //    recursively deleted here.
    deadLetters = removeOlderThan(path.join(config.workDir, 'callbacks', 'dead-letter'), cutoff, {
      keepNewest: MAX_DEAD_LETTER_FILES,
      filesOnly: true,
    });

    // 5. E13: reclaim orphan `.meta` files stranded in the callbacks/ top level.
    orphanMetaFiles = removeOrphanCallbackMetaFiles(
      path.join(config.workDir, 'callbacks'),
      Date.now(),
    );
  } catch (error: unknown) {
    logger.error(
      `Workdir cleanup error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { workDirs, caches, packages, deadLetters, orphanMetaFiles };
}

const MAX_PKG_UPDATES = 3;
const MAX_DEAD_LETTER_FILES = 50;
const ORPHAN_META_TTL_MS = 24 * 60 * 60 * 1000;

/** Current dead-letter backlog size (file count). Reported via heartbeat so
 *  long disconnections (callbacks parked on disk) stay visible to ops. Only
 *  regular files are counted — the dead-letter retention sweep in
 *  cleanupWorkDir runs with filesOnly (E12), so it too only ever removes
 *  files: a stray subdirectory neither inflates the reported backlog nor gets
 *  reclaimed by that sweep. */
export function getDeadLetterCount(): number {
  try {
    return fs
      .readdirSync(path.join(config.workDir, 'callbacks', 'dead-letter'), {
        withFileTypes: true,
      })
      .filter((d) => d.isFile()).length;
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
    const total = r.workDirs + r.caches + r.packages + r.deadLetters + r.orphanMetaFiles;
    if (total > 0) {
      logger.info(
        `Workdir cleanup removed ${total} item(s): ${r.workDirs} workdir(s), ${r.caches} cache entr(ies), ${r.packages} package(s), ${r.deadLetters} dead-letter file(s), ${r.orphanMetaFiles} orphan meta file(s)`,
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