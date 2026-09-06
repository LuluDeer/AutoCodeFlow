import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type FileLoggerModule = typeof import('./file-logger');

jest.mock('./logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

function loadModule(workDir: string): FileLoggerModule {
  const mockWorkDir = workDir;
  jest.resetModules();
  jest.mock('./config', () => ({
    config: { workDir: mockWorkDir, logRetentionDays: 7 },
  }));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./file-logger') as FileLoggerModule;
}

// Freeze time at local noon: getLogFilePath derives the date directory from
// wall-clock time, so a real midnight (or a TZ where local date != UTC date)
// between appendLog and the expected-path computation would point the
// assertion at a different directory. Fixed fake timers make both sides use
// the same instant deterministically in any timezone.
const FIXED_NOW = new Date(2026, 5, 15, 12, 0, 0);

/** Mirror file-logger's LOCAL-date formatting (getFullYear/getMonth/getDate).
 *  The previous spec code used toISOString (UTC), which diverges from the
 *  production path for hours every day in non-UTC timezones. */
function expectedLogPath(baseDir: string, executionId: string): string {
  const d = new Date();
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
  return path.join(baseDir, 'logs', dateStr, `${executionId}.log`);
}

describe('appendLog (buffered async writer)', () => {
  let dir: string;
  let fl: FileLoggerModule;

  beforeEach(() => {
    jest.useFakeTimers({ now: FIXED_NOW });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-fl-'));
    fl = loadModule(dir);
  });

  afterEach(() => {
    fl.stopLogCleanup();
    fl.stopWorkDirCleanup();
    fl.stopLogWriter();
    jest.useRealTimers();
  });

  it('buffers appendLog and flushes to disk via flushLogs without blocking', async () => {
    fl.appendLog('exec-1', 'line one');
    fl.appendLog('exec-1', 'line two');

    // Not yet on disk (buffered)…
    const logPath = expectedLogPath(dir, 'exec-1');
    expect(fs.existsSync(logPath)).toBe(false);

    await fl.flushLogs();
    expect(fs.readFileSync(logPath, 'utf-8')).toBe('line one\nline two\n');

    await fl.flushLogs();
    expect(fs.readFileSync(logPath, 'utf-8')).toBe('line one\nline two\n');
  });

  it('caps the buffered content for a single pathological burst', async () => {
    const big = 'z'.repeat(9 * 1024 * 1024); // > MAX_BUFFERED_BYTES (8MB)
    fl.appendLog('exec-burst', big);
    await fl.flushLogs();

    const logPath = expectedLogPath(dir, 'exec-burst');
    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content.length).toBeLessThanOrEqual(8 * 1024 * 1024 + 1);
    // The buffer keeps the newest content (trailing newline included).
    expect(content.endsWith('z\n')).toBe(true);
    expect(content.startsWith('z')).toBe(true);
  });

  it('keeps appendLogSync as an immediate-write path', () => {
    fl.appendLogSync('exec-sync', 'immediate');
    const logPath = expectedLogPath(dir, 'exec-sync');
    expect(fs.readFileSync(logPath, 'utf-8')).toBe('immediate\n');
  });
});

describe('cleanupWorkDir (disk reclamation)', () => {
  let dir: string;
  let fl: FileLoggerModule;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-clean-'));
    fl = loadModule(dir);
  });

  afterEach(() => {
    fl.stopLogCleanup();
    fl.stopWorkDirCleanup();
    fl.stopLogWriter();
  });

  it('removes expired task workdirs but protects infrastructure directories', () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const oldExec = path.join(dir, 'exec-old-1');
    const freshExec = path.join(dir, 'exec-new-1');
    fs.mkdirSync(oldExec, { recursive: true });
    fs.writeFileSync(path.join(oldExec, 'f.txt'), 'x');
    fs.utimesSync(oldExec, oldDate, oldDate);
    fs.mkdirSync(freshExec, { recursive: true });

    // Infrastructure dirs must never be treated as task workdirs.
    for (const name of ['logs', 'meta', 'callbacks', '.git_cache', '.node_modules', '.pkg-updates', 'apps']) {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      fs.utimesSync(path.join(dir, name), oldDate, oldDate);
    }

    const result = fl.cleanupWorkDir(7);
    expect(result.workDirs).toBe(1);
    expect(fs.existsSync(oldExec)).toBe(false);
    expect(fs.existsSync(freshExec)).toBe(true);
    for (const name of ['logs', 'meta', 'callbacks', '.git_cache', '.node_modules', '.pkg-updates', 'apps']) {
      expect(fs.existsSync(path.join(dir, name))).toBe(true);
    }
  });

  it('removes stale .git_cache and .node_modules entries past the TTL', () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const cacheOld = path.join(dir, '.git_cache', 'repo-old');
    const cacheNew = path.join(dir, '.git_cache', 'repo-new');
    const nmOld = path.join(dir, '.node_modules', 'task-old');
    fs.mkdirSync(cacheOld, { recursive: true });
    fs.mkdirSync(cacheNew, { recursive: true });
    fs.mkdirSync(nmOld, { recursive: true });
    fs.utimesSync(cacheOld, oldDate, oldDate);
    fs.utimesSync(nmOld, oldDate, oldDate);

    const result = fl.cleanupWorkDir(7);
    expect(result.caches).toBe(2);
    expect(fs.existsSync(cacheOld)).toBe(false);
    expect(fs.existsSync(cacheNew)).toBe(true);
    expect(fs.existsSync(nmOld)).toBe(false);
  });

  it('keeps only the newest .pkg-updates package files among expired ones', () => {
    // cleanupWorkDir reads process.cwd() at call time — redirect it into the
    // per-test temp dir so the suite never touches (or races with leftovers
    // from previous runs in) the repository's real .pkg-updates directory.
    const spyCwd = jest.spyOn(process, 'cwd').mockReturnValue(dir);
    const base = path.join(dir, '.pkg-updates');
    try {
      fs.mkdirSync(base, { recursive: true });
      const files = ['pkg-a.zip', 'pkg-b.zip', 'pkg-c.zip', 'pkg-d.zip'];
      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      files.forEach((name, i) => {
        const p = path.join(base, name);
        fs.writeFileSync(p, 'data');
        // a oldest (10 days + minutes), d newest (10 days) — all past TTL
        const t = new Date(oldDate.getTime() - (files.length - i) * 60_000);
        fs.utimesSync(p, t, t);
      });

      const result = fl.cleanupWorkDir(7);
      expect(result.packages).toBe(1); // beyond keepNewest=3 → oldest removed
      expect(fs.existsSync(path.join(base, 'pkg-d.zip'))).toBe(true);
      expect(fs.existsSync(path.join(base, 'pkg-c.zip'))).toBe(true);
      expect(fs.existsSync(path.join(base, 'pkg-a.zip'))).toBe(false);
    } finally {
      spyCwd.mockRestore();
    }
  });

  it('caps dead-letter callbacks at the retention count', () => {
    const deadDir = path.join(dir, 'callbacks', 'dead-letter');
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.mkdirSync(deadDir, { recursive: true });
    for (let i = 0; i < 51; i++) {
      const p = path.join(deadDir, `callback-${i}.json`);
      fs.writeFileSync(p, '[]');
      // stagger mtimes so "oldest" is unambiguous
      const t = new Date(oldDate.getTime() - i * 1000);
      fs.utimesSync(p, t, t);
    }

    const result = fl.cleanupWorkDir(7);
    expect(result.deadLetters).toBe(1); // MAX_DEAD_LETTER_FILES=50 → oldest dropped
    expect(fs.existsSync(path.join(deadDir, 'callback-50.json'))).toBe(false); // oldest
    expect(fs.existsSync(path.join(deadDir, 'callback-0.json'))).toBe(true);   // newest kept
  });

  it('startWorkDirCleanup performs an initial sweep', () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const oldExec = path.join(dir, 'exec-sweep');
    fs.mkdirSync(oldExec, { recursive: true });
    fs.utimesSync(oldExec, oldDate, oldDate);

    fl.startWorkDirCleanup(7);
    expect(fs.existsSync(oldExec)).toBe(false);
    // stopping twice is safe
    fl.stopWorkDirCleanup();
    fl.stopWorkDirCleanup();
  });
});

describe('getDeadLetterCount (heartbeat backlog gauge)', () => {
  let dir: string;
  let fl: FileLoggerModule;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-dl-'));
    fl = loadModule(dir);
  });

  afterEach(() => {
    fl.stopLogCleanup();
    fl.stopWorkDirCleanup();
    fl.stopLogWriter();
  });

  it('returns 0 when the dead-letter directory does not exist', () => {
    expect(fl.getDeadLetterCount()).toBe(0);
  });

  it('counts only regular files, ignoring subdirectories', () => {
    const deadDir = path.join(dir, 'callbacks', 'dead-letter');
    fs.mkdirSync(deadDir, { recursive: true });
    fs.writeFileSync(path.join(deadDir, 'a.json'), '[]');
    fs.writeFileSync(path.join(deadDir, 'b.json'), '[]');
    fs.mkdirSync(path.join(deadDir, 'stray-subdir'));

    expect(fl.getDeadLetterCount()).toBe(2);
  });

  it('returns 0 for an empty directory', () => {
    fs.mkdirSync(path.join(dir, 'callbacks', 'dead-letter'), {
      recursive: true,
    });
    expect(fl.getDeadLetterCount()).toBe(0);
  });
});
