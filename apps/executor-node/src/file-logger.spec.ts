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

describe('appendLog (buffered async writer)', () => {
  let dir: string;
  let fl: FileLoggerModule;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-fl-'));
    fl = loadModule(dir);
  });

  afterEach(() => {
    fl.stopLogCleanup();
    fl.stopWorkDirCleanup();
    fl.stopLogWriter();
  });

  it('buffers appendLog and flushes to disk via flushLogs without blocking', async () => {
    fl.appendLog('exec-1', 'line one');
    fl.appendLog('exec-1', 'line two');

    // Not yet on disk (buffered)…
    const logPath = path.join(dir, 'logs', new Date().toISOString().slice(0, 10), 'exec-1.log');
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

    const logPath = path.join(dir, 'logs', new Date().toISOString().slice(0, 10), 'exec-burst.log');
    const content = fs.readFileSync(logPath, 'utf-8');
    expect(content.length).toBeLessThanOrEqual(8 * 1024 * 1024 + 1);
    // The buffer keeps the newest content (trailing newline included).
    expect(content.endsWith('z\n')).toBe(true);
    expect(content.startsWith('z')).toBe(true);
  });

  it('keeps appendLogSync as an immediate-write path', () => {
    fl.appendLogSync('exec-sync', 'immediate');
    const logPath = path.join(dir, 'logs', new Date().toISOString().slice(0, 10), 'exec-sync.log');
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
    const base = path.join(process.cwd(), '.pkg-updates');
    fs.mkdirSync(base, { recursive: true });
    const files = ['pkg-a.zip', 'pkg-b.zip', 'pkg-c.zip', 'pkg-d.zip'];
    try {
      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      const now = Date.now();
      files.forEach((name, i) => {
        const p = path.join(base, name);
        fs.writeFileSync(p, 'data');
        // a oldest (10 days + minutes), d newest (10 days) — all past TTL
        const t = new Date(oldDate.getTime() - (files.length - i) * 60_000);
        fs.utimesSync(p, t, t);
        void now;
      });

      const result = fl.cleanupWorkDir(7);
      expect(result.packages).toBe(1); // beyond keepNewest=3 → oldest removed
      expect(fs.existsSync(path.join(base, 'pkg-d.zip'))).toBe(true);
      expect(fs.existsSync(path.join(base, 'pkg-c.zip'))).toBe(true);
      expect(fs.existsSync(path.join(base, 'pkg-a.zip'))).toBe(false);
    } finally {
      for (const name of files) {
        try { fs.unlinkSync(path.join(base, name)); } catch { /* already gone */ }
      }
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
