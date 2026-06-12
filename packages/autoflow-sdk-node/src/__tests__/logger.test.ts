import { AutoFlowLogger, getLogger } from '../logger';

describe('AutoFlowLogger', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('constructor', () => {
    it('creates a logger with the given name', () => {
      const logger = new AutoFlowLogger('my-task');
      logger.info('hello');
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('[my-task]');
      expect(output).toContain('hello');
    });
  });

  describe('log levels', () => {
    it('debug() emits DEBUG level', () => {
      const logger = new AutoFlowLogger('t');
      logger.debug('dbg msg');
      const out = consoleSpy.mock.calls[0][0] as string;
      expect(out).toContain('[DEBUG]');
      expect(out).toContain('dbg msg');
    });

    it('info() emits INFO level', () => {
      const logger = new AutoFlowLogger('t');
      logger.info('info msg');
      const out = consoleSpy.mock.calls[0][0] as string;
      expect(out).toContain('[INFO]');
    });

    it('warn() emits WARN level', () => {
      const logger = new AutoFlowLogger('t');
      logger.warn('warn msg');
      const out = consoleSpy.mock.calls[0][0] as string;
      expect(out).toContain('[WARN]');
    });

    it('error() emits ERROR level', () => {
      const logger = new AutoFlowLogger('t');
      logger.error('err msg');
      const out = consoleSpy.mock.calls[0][0] as string;
      expect(out).toContain('[ERROR]');
    });
  });

  describe('extra args', () => {
    it('appends extra args to the message', () => {
      const logger = new AutoFlowLogger('t');
      logger.info('count:', 42, 'done');
      const out = consoleSpy.mock.calls[0][0] as string;
      expect(out).toContain('count:');
      expect(out).toContain('42');
      expect(out).toContain('done');
    });
  });

  describe('output format', () => {
    it('includes an ISO timestamp', () => {
      const logger = new AutoFlowLogger('t');
      logger.info('ts check');
      const out = consoleSpy.mock.calls[0][0] as string;
      // ISO timestamp pattern: YYYY-MM-DDTHH:mm:ss
      expect(out).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('getLogger()', () => {
    it('returns an AutoFlowLogger instance', () => {
      const logger = getLogger('my-service');
      expect(logger).toBeInstanceOf(AutoFlowLogger);
    });

    it('creates independent instances for different names', () => {
      const a = getLogger('svc-a');
      const b = getLogger('svc-b');
      a.info('msg-a');
      b.info('msg-b');
      expect(consoleSpy.mock.calls[0][0]).toContain('svc-a');
      expect(consoleSpy.mock.calls[1][0]).toContain('svc-b');
    });
  });
});
