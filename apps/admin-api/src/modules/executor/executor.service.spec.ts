import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ExecutorService } from './executor.service';
import { Executor, ExecutorStatus } from './entities/executor.entity';
import { TaskExecution, ExecutionStatus } from '../task/entities/task-execution.entity';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const makeRepo = (overrides: Partial<Record<string, jest.Mock>> = {}) => ({
  findOne: jest.fn(),
  find: jest.fn(),
  create: jest.fn((d) => d),
  save: jest.fn((e) => Promise.resolve(e)),
  update: jest.fn().mockResolvedValue({ affected: 0 }),
  increment: jest.fn().mockResolvedValue(undefined),
  decrement: jest.fn().mockResolvedValue(undefined),
  delete: jest.fn().mockResolvedValue({ affected: 0 }),
  ...overrides,
});

describe('ExecutorService', () => {
  let service: ExecutorService;
  let executorRepo: ReturnType<typeof makeRepo>;
  let execRepo: ReturnType<typeof makeRepo>;

  beforeEach(async () => {
    executorRepo = makeRepo();
    execRepo = makeRepo();
    const module = await Test.createTestingModule({
      providers: [
        ExecutorService,
        { provide: getRepositoryToken(Executor), useValue: executorRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
      ],
    }).compile();
    service = module.get(ExecutorService);
  });

  describe('register', () => {
    it('creates new executor if not found', async () => {
      executorRepo.findOne.mockResolvedValue(null);
      await service.register({ appName: 'e1', address: '127.0.0.1:3001' });
      expect(executorRepo.save).toHaveBeenCalled();
    });

    it('updates existing executor on re-register', async () => {
      const existing = { appName: 'e1', address: '127.0.0.1:3001', status: ExecutorStatus.OFFLINE };
      executorRepo.findOne.mockResolvedValue(existing);
      await service.register({ appName: 'e1', address: '127.0.0.1:3001' });
      expect(existing.status).toBe(ExecutorStatus.ONLINE);
    });
  });

  describe('dispatch', () => {
    const executor = { address: '127.0.0.1:3001', status: ExecutorStatus.ONLINE, runningTaskCount: 0, capabilities: ['node'] };
    const execution = { id: 'exec-1', params: {} } as TaskExecution;
    const task = { name: 'test', runtime: 'node', timeout: 10 };

    it('dispatches to online executor and returns data', async () => {
      executorRepo.find.mockResolvedValue([executor]);
      mockedAxios.post.mockResolvedValue({ data: { success: true, logs: '' } });
      const result = await service.dispatch(task, execution);
      expect(result.success).toBe(true);
      expect(executorRepo.increment).toHaveBeenCalled();
    });

    it('rolls back increment on dispatch failure', async () => {
      executorRepo.find.mockResolvedValue([executor]);
      mockedAxios.post.mockRejectedValue(new Error('network error'));
      await expect(service.dispatch(task, execution)).rejects.toThrow('network error');
      expect(executorRepo.decrement).toHaveBeenCalled();
    });

    it('throws if no executor available', async () => {
      executorRepo.find.mockResolvedValue([]);
      await expect(service.dispatch(task, execution)).rejects.toThrow('No available executor');
    });
  });
});
