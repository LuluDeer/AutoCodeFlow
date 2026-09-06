import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import { logger } from './logger';

const logsDir = path.join(config.workDir, 'logs');
fs.mkdirSync(logsDir, { recursive: true });

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getLogFilePath(executionId: string, date?: Date): string {
  const dateStr = date ? formatDate(date) : formatDate(new Date());
  const dateDir = path.join(logsDir, dateStr);
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

function removeOlderThan(dir: string, cutoffMs: number, options: { keepNewest?: number; directoryNames?: RegExp } = {}): number {
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

/** Remove expired task workdirs, stale caches, old packages and dead-letter
 *  overflow. Safe to run at startup and on an interval. */
export function cleanupWorkDir(
  ttlDays: number = CLEANUP_TTL_DAYS,
): { workDirs: number; caches: number; packages: number; deadLetters: number } {
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  let workDirs = 0;
  let caches = 0;
  let packages = 0;
  let deadLetters = 0;

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
    deadLetters = removeOlderThan(path.join(config.workDir, 'callbacks', 'dead-letter'), cutoff, {
      keepNewest: MAX_DEAD_LETTER_FILES,
    });
  } catch (error: unknown) {
    logger.error(
      `Workdir cleanup error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { workDirs, caches, packages, deadLetters };
}

const MAX_PKG_UPDATES = 3;
const MAX_DEAD_LETTER_FILES = 50;

/** Current dead-letter backlog size (file count). Reported via heartbeat so
 *  long disconnections (callbacks parked on disk) stay visible to ops. */
export function getDeadLetterCount(): number {
  try {
    return fs.readdirSync(
      path.join(config.workDir, 'callbacks', 'dead-letter'),
    ).length;
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
    const total = r.workDirs + r.caches + r.packages + r.deadLetters;
    if (total > 0) {
      logger.info(
        `Workdir cleanup removed ${total} item(s): ${r.workDirs} workdir(s), ${r.caches} cache entr(ies), ${r.packages} package(s), ${r.deadLetters} dead-letter file(s)`,
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
    walk(logsDir);
  } catch {
    // Ignore if logs directory doesn't exist
  }
  
  return { totalSize, fileCount };
}