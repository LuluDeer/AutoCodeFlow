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

// E10: mirror the REAL config.workDir shape — a getter resolving mutable
// state (process.env.WORK_DIR) at call time, which is exactly what
// /config/reload hot-swaps. Static-property mocks cannot express this.
function loadModuleWithWorkDirGetter(getWorkDir: () => string): FileLoggerModule {
  const mockGetWorkDir = getWorkDir;
  jest.resetModules();
  jest.mock('./config', () => ({
    config: { get workDir() { return mockGetWorkDir(); }, logRetentionDays: 7 },
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

// ---------------------------------------------------------------------------
// E10: workDir 热更新后写/读路径不得分裂——logsDir 必须每次经 config.workDir
// 惰性解析（对齐 routes/logs.ts 的读路径），而非模块加载期固化。
// ---------------------------------------------------------------------------
describe('workDir hot-reload (E10: lazy logsDir)', () => {
  let oldDir: string;
  let newDir: string;

  beforeEach(() => {
    jest.useFakeTimers({ now: FIXED_NOW });
    oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-fl-old-'));
    newDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-fl-new-'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('write and read paths follow a hot-reloaded workDir (no split)', async () => {
    const mockWorkDirRef = { current: oldDir };
    const fl = loadModuleWithWorkDirGetter(() => mockWorkDirRef.current);
    try {
      fl.appendLogSync('exec-before', 'old-dir');
      expect(fs.existsSync(expectedLogPath(oldDir, 'exec-before'))).toBe(true);

      // Simulate /config/reload: process.env.WORK_DIR now points at the new base.
      mockWorkDirRef.current = newDir;

      // Write side (file-logger) resolves the NEW directory…
      fl.appendLogSync('exec-after', 'new-dir');
      expect(fs.existsSync(expectedLogPath(newDir, 'exec-after'))).toBe(true);
      expect(fs.existsSync(expectedLogPath(oldDir, 'exec-after'))).toBe(false);

      // …and the read side agrees: getLogFilePath/readLog/getLogStats match
      // the routes/logs.ts read path (path.join(config.workDir, 'logs')).
      expect(fl.getLogFilePath('exec-after')).toBe(expectedLogPath(newDir, 'exec-after'));
      expect(fl.readLog('exec-after')).toEqual({ lines: ['new-dir'], totalLines: 1 });
      expect(fl.getLogStats().fileCount).toBe(1);

      // Buffered writes flush into the new directory as well.
      fl.appendLog('exec-buffered', 'buffered-new');
      await fl.flushLogs();
      expect(fs.readFileSync(expectedLogPath(newDir, 'exec-buffered'), 'utf-8')).toBe(
        'buffered-new\n',
      );

      // deleteOldLogs targets the new base only; the old base is left untouched.
      const staleDate = '2020-01-01';
      for (const base of [oldDir, newDir]) {
        const stale = path.join(base, 'logs', staleDate);
        fs.mkdirSync(stale, { recursive: true });
        fs.writeFileSync(path.join(stale, 'x.log'), 'data');
      }
      expect(fl.deleteOldLogs(7)).toBe(1);
      expect(fs.existsSync(path.join(newDir, 'logs', staleDate))).toBe(false);
      expect(fs.existsSync(path.join(oldDir, 'logs', staleDate))).toBe(true);
    } finally {
      fl.stopLogCleanup();
      fl.stopWorkDirCleanup();
      fl.stopLogWriter();
    }
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

  it('dead-letter sweep removes only files and leaves subdirectories untouched (E12)', () => {
    // filesOnly 语义（与 getDeadLetterCount 只数文件对称）：杂散子目录既不
    // 占用 keepNewest 名额，也不被递归删除。
    const deadDir = path.join(dir, 'callbacks', 'dead-letter');
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.mkdirSync(deadDir, { recursive: true });
    for (let i = 0; i < 51; i++) {
      const p = path.join(deadDir, `callback-${i}.json`);
      fs.writeFileSync(p, '[]');
      const t = new Date(oldDate.getTime() - i * 1000); // i=50 oldest
      fs.utimesSync(p, t, t);
    }
    const strayDir = path.join(deadDir, 'stray-subdir');
    fs.mkdirSync(strayDir);
    fs.writeFileSync(path.join(strayDir, 'nested.json'), '[]');
    fs.utimesSync(strayDir, oldDate, oldDate);

    const result = fl.cleanupWorkDir(7);
    expect(result.deadLetters).toBe(1); // only the oldest FILE dropped
    expect(fs.existsSync(path.join(deadDir, 'callback-50.json'))).toBe(false);
    expect(fs.existsSync(path.join(deadDir, 'callback-0.json'))).toBe(true);
    expect(fs.existsSync(strayDir)).toBe(true);                       // dir survives
    expect(fs.existsSync(path.join(strayDir, 'nested.json'))).toBe(true); // not recursed
  });

  it('reclaims orphan .meta files stranded by a failed dead-lettering unlink (E13)', () => {
    const callbackDir = path.join(dir, 'callbacks');
    fs.mkdirSync(callbackDir, { recursive: true });
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // > 24h
    const recentDate = new Date(Date.now() - 60 * 60 * 1000);        // < 24h

    // Orphans: companion json already moved/deleted, .meta unlink failed.
    const orphanOld = path.join(callbackDir, 'callback-111-0.json.meta');
    const orphanFresh = path.join(callbackDir, 'callback-222-0.json.meta');
    fs.writeFileSync(orphanOld, '{"retries":5}');
    fs.writeFileSync(orphanFresh, '{"retries":1}');
    fs.utimesSync(orphanOld, oldDate, oldDate);
    fs.utimesSync(orphanFresh, recentDate, recentDate);

    // Paired meta: companion json still lives in callbacks/ — must be kept
    // even when older than the orphan window (owned by the retry loop).
    const liveJson = path.join(callbackDir, 'callback-333-0.json');
    const liveMeta = `${liveJson}.meta`;
    fs.writeFileSync(liveJson, '[]');
    fs.writeFileSync(liveMeta, '{"retries":2}');
    fs.utimesSync(liveMeta, oldDate, oldDate);

    const result = fl.cleanupWorkDir(7);
    expect(result.orphanMetaFiles).toBe(1);
    expect(fs.existsSync(orphanOld)).toBe(false);
    expect(fs.existsSync(orphanFresh)).toBe(true);  // inside the 24h grace window
    expect(fs.existsSync(liveMeta)).toBe(true);     // still owned by its json
    expect(fs.existsSync(liveJson)).toBe(true);
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
