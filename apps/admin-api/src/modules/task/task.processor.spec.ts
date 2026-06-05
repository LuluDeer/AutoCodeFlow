import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TaskProcessor } from './task.processor';
import { TaskExecution, ExecutionStatus } from './entities/task-execution.entity';
import { ExecutionLogLine } from './entities/execution-log-line.entity';
import { Task } from './entities/task.entity';
import { ExecutorService } from '../executor/executor.service';
import { AiService } from '../ai/ai.service';
import { NotificationService } from '../notification/notification.service';

const makeRepo = (overrides: Partial<Record<string, jest.Mock>> = {}) => ({
  findOne: jest.fn(),
  save: jest.fn((e) => Promise.resolve(e)),
  create: jest.fn((d) => d),
  delete: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe('TaskProcessor', () => {
  let processor: TaskProcessor;
  let execRepo: ReturnType<typeof makeRepo>;
  let taskRepo: ReturnType<typeof makeRepo>;
  let logLineRepo: ReturnType<typeof makeRepo>;
  let executorService: jest.Mocked<Pick<ExecutorService, 'dispatch'>>;
  let aiService: jest.Mocked<Pick<AiService, 'analyzeFailure'>>;
  let notificationService: jest.Mocked<Pick<NotificationService, 'notifyFailureWithConfig'>>;

  const task = { id: 't1', name: 'task1', timeout: 10 } as Task;
  const exec = { id: 'exec-1', taskId: 't1', status: ExecutionStatus.PENDING, params: {} } as TaskExecution;

  beforeEach(async () => {
    execRepo = makeRepo({ findOne: jest.fn().mockResolvedValue({ ...exec }) });
    taskRepo = makeRepo({ findOne: jest.fn().mockResolvedValue(task) });
    logLineRepo = makeRepo();
    executorService = { dispatch: jest.fn() };
    aiService = { analyzeFailure: jest.fn().mockResolvedValue('analysis') };
    notificationService = { notifyFailureWithConfig: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        TaskProcessor,
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getRepositoryToken(ExecutionLogLine), useValue: logLineRepo },
        { provide: ExecutorService, useValue: executorService },
        { provide: AiService, useValue: aiService },
        { provide: NotificationService, useValue: notificationService },
      ],
    }).compile();
    processor = module.get(TaskProcessor);
  });

  it('marks execution SUCCESS when dispatch succeeds', async () => {
    executorService.dispatch.mockResolvedValue({ success: true, logs: 'ok', executorAddress: '127.0.0.1:3001' });
    // mock fetchAndStoreLogLines to avoid real HTTP
    jest.spyOn(processor as any, 'fetchAndStoreLogLines').mockResolvedValue(undefined);
    await processor.handle({ data: { executionId: 'exec-1' } } as any);
    const saved = execRepo.save.mock.calls.map((c: any) => c[0]);
    expect(saved.some((e: any) => e.status === ExecutionStatus.SUCCESS)).toBe(true);
  });

  it('marks execution FAILED and rethrows when dispatch fails', async () => {
    executorService.dispatch.mockRejectedValue(new Error('exec failed'));
    await expect(processor.handle({ data: { executionId: 'exec-1' } } as any)).rejects.toThrow('exec failed');
    const saved = execRepo.save.mock.calls.map((c: any) => c[0]);
    expect(saved.some((e: any) => e.status === ExecutionStatus.FAILED)).toBe(true);
  });

  it('returns early if execution not found', async () => {
    execRepo.findOne.mockResolvedValue(null);
    await processor.handle({ data: { executionId: 'missing' } } as any);
    expect(executorService.dispatch).not.toHaveBeenCalled();
  });

  it('marks FAILED if task not found', async () => {
    taskRepo.findOne.mockResolvedValue(null);
    await processor.handle({ data: { executionId: 'exec-1' } } as any);
    const saved = execRepo.save.mock.calls.map((c: any) => c[0]);
    expect(saved.some((e: any) => e.status === ExecutionStatus.FAILED)).toBe(true);
  });

  it('ERR-01: original error is not masked when save in finally fails', async () => {
    // Mock dispatch to throw an error
    const originalError = new Error('dispatch failed');
    executorService.dispatch.mockRejectedValue(originalError);
    
    // Mock save to fail in the finally block
    let callCount = 0;
    execRepo.save = jest.fn((entity) => {
      callCount++;
      // First two saves (RUNNING status, FAILED status) succeed
      if (callCount <= 2) {
        return Promise.resolve(entity);
      }
      // Third save (finally block) fails
      return Promise.reject(new Error('database connection failed'));
    });

    // The original error should still be thrown, not the save error
    await expect(processor.handle({ data: { executionId: 'exec-1' } } as any)).rejects.toThrow('dispatch failed');
    
    // Verify save was called multiple times (for RUNNING status, FAILED status, and finally)
    expect(execRepo.save).toHaveBeenCalled();
  });

  it('ERR-02: duration is 0 when startTime is null', async () => {
    // Create an execution without startTime
    const execWithoutStartTime = { 
      id: 'exec-2', 
      taskId: 't1', 
      status: ExecutionStatus.PENDING, 
      params: {},
      startTime: null 
    } as unknown as TaskExecution;
    execRepo.findOne = jest.fn().mockResolvedValue(execWithoutStartTime);
    
    // Mock task not found to trigger early failure before startTime is set
    taskRepo.findOne.mockResolvedValue(null);
    
    await processor.handle({ data: { executionId: 'exec-2' } } as any);
    
    const saved = execRepo.save.mock.calls.map((c: any) => c[0]);
    const finalSave = saved[saved.length - 1];
    expect(finalSave.duration).toBe(0);
  });
});
