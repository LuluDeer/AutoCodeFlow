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
