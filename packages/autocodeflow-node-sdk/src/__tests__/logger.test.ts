import { TaskLogger } from '../logger';
import { LogLevel } from '../types';

describe('TaskLogger', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('constructor', () => {
    it('creates a logger with an empty log buffer', () => {
      const logger = new TaskLogger();
      expect(logger.getLogs()).toHaveLength(0);
    });
  });

  describe('info()', () => {
    it('adds an INFO log entry to the buffer', () => {
      const logger = new TaskLogger();
      logger.info('hello world');
      const logs = logger.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('info' as LogLevel);
      expect(logs[0].message).toBe('hello world');
    });

    it('writes to console.info', () => {
      const logger = new TaskLogger();
      logger.info('test msg');
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('warn()', () => {
    it('adds a WARN log entry to the buffer', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const logger = new TaskLogger();
      logger.warn('be careful');
      const logs = logger.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('warn' as LogLevel);
      expect(logs[0].message).toBe('be careful');
      warnSpy.mockRestore();
    });
  });

  describe('error()', () => {
    it('adds an ERROR log entry to the buffer', () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const logger = new TaskLogger();
      logger.error('something failed');
      const logs = logger.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('error' as LogLevel);
      expect(logs[0].message).toBe('something failed');
      errorSpy.mockRestore();
    });
  });

  describe('debug()', () => {
    it('adds a DEBUG log entry to the buffer', () => {
      const logger = new TaskLogger();
      logger.debug('debug details');
      const logs = logger.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('debug' as LogLevel);
    });
  });

  describe('getLogs()', () => {
    it('returns all logs in insertion order', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const logger = new TaskLogger();
      logger.info('first');
      logger.warn('second');
      logger.error('third');
      const logs = logger.getLogs();
      expect(logs).toHaveLength(3);
      expect(logs[0].message).toBe('first');
      expect(logs[1].message).toBe('second');
      expect(logs[2].message).toBe('third');
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('each entry has a timestamp string', () => {
      const logger = new TaskLogger();
      logger.info('ts test');
      const entry = logger.getLogs()[0];
      expect(typeof entry.timestamp).toBe('string');
      expect(entry.timestamp.length).toBeGreaterThan(0);
    });

    it('logs with meta are stored correctly', () => {
      const logger = new TaskLogger();
      logger.info('with meta', { userId: 42 });
      const entry = logger.getLogs()[0];
      expect(entry.meta).toEqual({ userId: 42 });
    });
  });
});

describe('TaskLogger ring buffer (PK-24)', () => {
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it('retains at most MAX_ENTRIES (1000) entries and drops the oldest', () => {
    const logger = new TaskLogger();
    for (let i = 0; i < TaskLogger.MAX_ENTRIES + 250; i++) {
      logger.info(`line-${i}`);
    }
    const logs = logger.getLogs();
    expect(logs).toHaveLength(TaskLogger.MAX_ENTRIES);
    // 保留的是最新的尾部，最老的 250 条被挤出
    expect(logs[0].message).toBe(`line-${250}`);
    expect(logs[logs.length - 1].message).toBe(`line-${1000 + 249}`);
  });

  it('counts every evicted entry in droppedCount', () => {
    const logger = new TaskLogger();
    expect(logger.droppedCount).toBe(0);
    for (let i = 0; i < 1200; i++) {
      logger.info(`m-${i}`);
    }
    expect(logger.droppedCount).toBe(200);
    logger.clear();
    // 显式 clear 是主动丢弃，不计入环形溢出
    expect(logger.droppedCount).toBe(200);
    expect(logger.getLogs()).toHaveLength(0);
  });

  it('getLogs is unchanged (copy semantics) below the cap', () => {
    const logger = new TaskLogger();
    logger.info('only one');
    expect(logger.droppedCount).toBe(0);
    const logs = logger.getLogs();
    logs.push({ timestamp: 'x', level: 'info', message: 'mutated' });
    expect(logger.getLogs()).toHaveLength(1);
  });
});
