import { TaskContext } from '../context';
import { TaskEnv } from '../types';

const baseEnv: TaskEnv = {
  executionId: 'exec-001',
  taskId: 'task-001',
  taskName: 'Test Task',
  adminApiUrl: 'http://localhost:3000',
  executorToken: 'test-token',
  traceId: 'trace-abc',
};

describe('TaskContext', () => {
  describe('create()', () => {
    it('should expose env properties via shorthand getters', () => {
      const ctx = TaskContext.create(baseEnv);
      expect(ctx.executionId).toBe('exec-001');
      expect(ctx.taskId).toBe('task-001');
      expect(ctx.taskName).toBe('Test Task');
    });

    it('should attach collected logs to the result', () => {
      const ctx = TaskContext.create(baseEnv);
      ctx.logger.info('step 1');
      ctx.logger.warn('step 2');

      const result = ctx.success('done');
      expect(result.success).toBe(true);
      expect(result.logs).toHaveLength(2);
      expect(result.logs![0].level).toBe('info');
      expect(result.logs![1].level).toBe('warn');
    });
  });

  describe('success()', () => {
    it('should return a successful TaskResult with message and output', () => {
      const ctx = TaskContext.create(baseEnv);
      const result = ctx.success('all good', { count: 5 });
      expect(result.success).toBe(true);
      expect(result.message).toBe('all good');
      expect(result.output).toEqual({ count: 5 });
    });
  });

  describe('failure()', () => {
    it('should return a failed TaskResult with message', () => {
      const ctx = TaskContext.create(baseEnv);
      const result = ctx.failure('something went wrong');
      expect(result.success).toBe(false);
      expect(result.message).toBe('something went wrong');
    });
  });

  describe('fromEnv()', () => {
    it('should throw when a required env var is missing', () => {
      const original = process.env['EXECUTION_ID'];
      delete process.env['EXECUTION_ID'];
      expect(() => TaskContext.fromEnv()).toThrow(
        /missing required environment variable "EXECUTION_ID"/,
      );
      // restore
      if (original !== undefined) process.env['EXECUTION_ID'] = original;
    });
  });
});
