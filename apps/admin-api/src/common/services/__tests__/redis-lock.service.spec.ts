// ts-jest with esModuleInterop resolves `import Redis from 'ioredis'` to
// the `.default` property of the mock module.  The factory must therefore
// return { __esModule: true, default:<constructor> }.
jest.mock('ioredis', () => {
  const instance = {
    set: jest.fn(),
    eval: jest.fn(),
    quit: jest.fn(),
    on: jest.fn(),
  };
  const RedisMock = jest.fn().mockImplementation(() => instance);
  (RedisMock as any).mockInstance = instance;
  return { __esModule: true, default: RedisMock };
});

import { ConfigService } from '@nestjs/config';
import { RedisLockService } from '../redis-lock.service';

const { default: RedisMock } = jest.requireMock('ioredis') as {
  default: jest.Mock & { mockInstance: Record<string, jest.Mock> };
};
const m = RedisMock.mockInstance;

const makeConfig = () =>
  ({
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'redis.host') return 'localhost';
      if (key === 'redis.port') return 6379;
      if (key === 'redis.password') return undefined;
      return undefined;
    }),
  } as unknown as ConfigService);

describe('RedisLockService', () => {
  let service: RedisLockService;

  beforeEach(async () => {
    jest.clearAllMocks();
    m.quit.mockResolvedValue('OK');
    service = new RedisLockService(makeConfig());
    await service.onModuleInit();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  describe('acquireLock', () => {
    it('returns a Lock when Redis SET NX succeeds', async () => {
      m.set.mockResolvedValue('OK');
      const lock = await service.acquireLock('resource-a', 5_000);

      expect(lock).not.toBeNull();
      expect(lock!.key).toBe('resource-a');
      expect(lock!.released).toBe(false);
      expect(typeof lock!.release).toBe('function');
    });

    it('returns null when the lock is already held', async () => {
      m.set.mockResolvedValue(null);
      const lock = await service.acquireLock('resource-b', 5_000);
expect(lock).toBeNull();
    });

    it('calls SET with lock:<key>, a random lockId, NX, and PX options', async () => {
      m.set.mockResolvedValue('OK');
      await service.acquireLock('resource-c', 3_000);

      expect(m.set).toHaveBeenCalledWith(
        'lock:resource-c',
        expect.any(String),
        'NX',
        'PX',
        3_000,
      );
    });
  });

  describe('Lock.release', () => {
    it('returns true when Lua script removes the key (eval returns 1)', async () => {
      m.set.mockResolvedValue('OK');
      m.eval.mockResolvedValue(1);

      const lock = await service.acquireLock('resource-d', 5_000);
      const ok = await lock!.release();

      expect(ok).toBe(true);
      expect(lock!.released).toBe(true);
    });

    it('returns false and skips eval on a second release call', async () => {
      m.set.mockResolvedValue('OK');
      m.eval.mockResolvedValue(1);

      const lock = await service.acquireLock('resource-e', 5_000);
      await lock!.release();
      const second = await lock!.release();

      expect(second).toBe(false);
      expect(m.eval).toHaveBeenCalledTimes(1);
    });

    it('returns false when the lock belongs to a different holder (eval returns 0)', async () => {
      m.set.mockResolvedValue('OK');
      m.eval.mockResolvedValue(0);

      const lock = await service.acquireLock('resource-f', 5_000);
      const ok = await lock!.release();

      expect(ok).toBe(false);
    });
  });

  describe('onModuleDestroy', () => {
    it('calls quit() on the Redis client', async () => {
      await service.onModuleDestroy();
      expect(m.quit).toHaveBeenCalled();
    });
  });
});
