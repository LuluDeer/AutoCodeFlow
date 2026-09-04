// ts-jest with esModuleInterop resolves `import Redis from 'ioredis'` to
// the `.default` property of the mock module.  The factory must therefore
// return { __esModule: true, default:<constructor> }.
jest.mock("ioredis", () => {
  const instance = {
    set: jest.fn(),
    eval: jest.fn(),
    quit: jest.fn(),
    on: jest.fn(),
    // N3: readyClient inspects status and subscribes via once/off while
    // waiting for the connection to become ready.
    status: "ready",
    once: jest.fn(),
    off: jest.fn(),
  };
  const RedisMock = jest.fn().mockImplementation(() => instance);
  (RedisMock as any).mockInstance = instance;
  return { __esModule: true, default: RedisMock };
});

import { ConfigService } from "@nestjs/config";
import { RedisLockService, REDIS_READY_WAIT_MS } from "../redis-lock.service";

const { default: RedisMock } = jest.requireMock("ioredis") as {
  default: jest.Mock & {
    mockInstance: Record<string, jest.Mock> & { status: string };
  };
};
const m = RedisMock.mockInstance;

const makeConfig = () =>
  ({
    get: jest.fn().mockImplementation((key: string) => {
      if (key === "redis.host") return "localhost";
      if (key === "redis.port") return 6379;
      if (key === "redis.password") return undefined;
      return undefined;
    }),
  }) as unknown as ConfigService;

describe("RedisLockService", () => {
  let service: RedisLockService;

  beforeEach(async () => {
    jest.clearAllMocks();
    m.quit.mockResolvedValue("OK");
    m.status = "ready";
    service = new RedisLockService(makeConfig());
    await service.onModuleInit();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  describe("acquireLock", () => {
    it("returns a Lock when Redis SET NX succeeds", async () => {
      m.set.mockResolvedValue("OK");
      const lock = await service.acquireLock("resource-a", 5_000);

      expect(lock).not.toBeNull();
      expect(lock!.key).toBe("resource-a");
      expect(lock!.released).toBe(false);
      expect(typeof lock!.release).toBe("function");
    });

    it("returns null when the lock is already held", async () => {
      m.set.mockResolvedValue(null);
      const lock = await service.acquireLock("resource-b", 5_000);
      expect(lock).toBeNull();
    });

    it("calls SET with lock:<key>, a random lockId, NX, and PX options", async () => {
      m.set.mockResolvedValue("OK");
      await service.acquireLock("resource-c", 3_000);

      expect(m.set).toHaveBeenCalledWith(
        "lock:resource-c",
        expect.any(String),
        "NX",
        "PX",
        3_000,
      );
    });
  });

  describe("Lock.release", () => {
    it("returns true when Lua script removes the key (eval returns 1)", async () => {
      m.set.mockResolvedValue("OK");
      m.eval.mockResolvedValue(1);

      const lock = await service.acquireLock("resource-d", 5_000);
      const ok = await lock!.release();

      expect(ok).toBe(true);
      expect(lock!.released).toBe(true);
    });

    it("returns false and skips eval on a second release call", async () => {
      m.set.mockResolvedValue("OK");
      m.eval.mockResolvedValue(1);

      const lock = await service.acquireLock("resource-e", 5_000);
      await lock!.release();
      const second = await lock!.release();

      expect(second).toBe(false);
      expect(m.eval).toHaveBeenCalledTimes(1);
    });

    it("returns false when the lock belongs to a different holder (eval returns 0)", async () => {
      m.set.mockResolvedValue("OK");
      m.eval.mockResolvedValue(0);

      const lock = await service.acquireLock("resource-f", 5_000);
      const ok = await lock!.release();

      expect(ok).toBe(false);
    });
  });

  describe("watchdog renewal (High-5.1 + R4-P0 renew flag)", () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it("renews a default lock at ttl/3 while not released (leader-lease behaviour)", async () => {
      jest.useFakeTimers();
      m.set.mockResolvedValue("OK");
      m.eval.mockResolvedValue(1); // extendLock succeeds

      const lock = await service.acquireLock("lease-lock", 9_000);
      expect(m.eval).not.toHaveBeenCalled();

      // renewMs = max(1000, 9000/3) = 3000 — first renewal fires at t+3000.
      // extendLock resolves through the (async) readyClient fast-path, so the
      // eval lands one microtask after the interval callback.
      await jest.advanceTimersByTimeAsync(3_000);
      expect(m.eval).toHaveBeenCalledTimes(1);
      expect(m.eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        "lock:lease-lock",
        expect.any(String),
        9_000,
      );

      // Still renewing at t+9000 (three cycles)
      await jest.advanceTimersByTimeAsync(6_000);
      expect(m.eval).toHaveBeenCalledTimes(3);

      // t+12000: the watchdog keeps the lease alive indefinitely
      await jest.advanceTimersByTimeAsync(3_000);
      expect(m.eval).toHaveBeenCalledTimes(4);

      // release() stops the watchdog (final eval = the release DEL)
      await lock!.release();
      await jest.advanceTimersByTimeAsync(30_000);
      expect(m.eval).toHaveBeenCalledTimes(5);
    });

    it("stops renewing after release()", async () => {
      jest.useFakeTimers();
      m.set.mockResolvedValue("OK");
      m.eval.mockResolvedValue(1);

      const lock = await service.acquireLock("lease-release", 9_000);
      await jest.advanceTimersByTimeAsync(3_000);
      expect(m.eval).toHaveBeenCalledTimes(1);

      await lock!.release();
      await jest.advanceTimersByTimeAsync(30_000);
      // Only the release Lua eval + the one renewal — no further renewals.
      expect(m.eval).toHaveBeenCalledTimes(2);
    });

    it("R4-P0: renew:false never starts the watchdog — the lock expires naturally (trigger-dedup behaviour)", async () => {
      jest.useFakeTimers();
      m.set.mockResolvedValue("OK");
      m.eval.mockResolvedValue(1);

      const lock = await service.acquireLock("task:trigger:t1", 30_000, {
        renew: false,
      });
      expect(lock).not.toBeNull();

      // Far beyond ttl/3 cycles — no renewal eval ever fired.
      jest.advanceTimersByTime(120_000);
      // eval would only be called by an explicit release; release() must also
      // still work (compare-and-delete), but no periodic renewal happened.
      const ok = await lock!.release();
      expect(ok).toBe(true);
      expect(m.eval).toHaveBeenCalledTimes(1); // the release DEL only
    });

    it("R4-P0: a failed release on a renew:false lock does not renew either", async () => {
      jest.useFakeTimers();
      m.set.mockResolvedValue("OK");
      // extendLock/releaseLock Lua returns 0 (lock lost / not ours)
      m.eval.mockResolvedValue(0);

      const lock = await service.acquireLock("task:trigger:t2", 30_000, {
        renew: false,
      });
      jest.advanceTimersByTime(120_000);
      const ok = await lock!.release();
      expect(ok).toBe(false);
      expect(m.eval).toHaveBeenCalledTimes(1);
    });
  });

  describe("onModuleDestroy", () => {
    it("calls quit() on the Redis client", async () => {
      await service.onModuleDestroy();
      expect(m.quit).toHaveBeenCalled();
    });

    it("N3: is a no-op-safe on quit when the client was never created (lazy ensureClient)", async () => {
      const fresh = new RedisLockService(makeConfig());
      await expect(fresh.onModuleDestroy()).resolves.not.toThrow();
      expect(m.quit).not.toHaveBeenCalled();
    });
  });

  describe("N3: startup-order race — readyClient wait", () => {
    afterEach(() => {
      // The wait tests install per-test `once` implementations; restore the
      // default no-op so later suites are unaffected.
      m.status = "ready";
      m.once.mockReset();
    });
    // N3 regression: a consumer's onModuleInit (scheduler leader election)
    // can run before RedisLockService.onModuleInit; acquireLock used to hit
    // an undefined client and throw, degrading the scheduler to a fail-open
    // "fake leader" for a full retry cycle (~15s).
    it("creates the client on first acquireLock even when onModuleInit never ran", async () => {
      // beforeEach already created one client for `service`; count from scratch.
      RedisMock.mockClear();
      const lazy = new RedisLockService(makeConfig());
      m.set.mockResolvedValue("OK");

      const lock = await lazy.acquireLock("lazy-key", 5_000);

      expect(RedisMock).toHaveBeenCalledTimes(1);
      expect(lock).not.toBeNull();
      expect(lock!.key).toBe("lazy-key");
      await lazy.onModuleDestroy();
    });

    it("does not create a second client when onModuleInit already ran", async () => {
      RedisMock.mockClear();
      m.set.mockResolvedValue("OK");
      await service.acquireLock("dup-key", 5_000);
      expect(RedisMock).not.toHaveBeenCalled();
    });

    it("acquires immediately when the client is already ready", async () => {
      m.set.mockResolvedValue("OK");
      await service.acquireLock("ready-key", 5_000);
      expect(m.set).toHaveBeenCalled();
    });

    it("waits for ready and succeeds when the ready event fires in time", async () => {
      m.status = "connecting";
      m.set.mockResolvedValue("OK");
      m.once.mockImplementation((event: string, cb: () => void) => {
        if (event === "ready") setTimeout(cb, 10);
        return m;
      });

      const pending = service.acquireLock("wait-key", 5_000);
      await expect(pending).resolves.not.toBeNull();
      expect(m.set).toHaveBeenCalled();
      // Listeners must be cleaned up after the wait resolves.
      expect(m.off).toHaveBeenCalledWith("ready", expect.any(Function));
      expect(m.off).toHaveBeenCalledWith("error", expect.any(Function));
    });

    it("throws within the bounded window when Redis never becomes ready (fail-open preserved)", async () => {
      jest.useFakeTimers();
      m.status = "connecting";
      // Register listeners but never fire them — Redis stays unreachable.
      m.once.mockImplementation(() => m);
      try {
        const pending = service.acquireLock("never-key", 5_000);
        const assertion = expect(pending).rejects.toThrow(
          /not ready after \d+ms/,
        );
        // Exhaust the REDIS_READY_WAIT_MS window without a real timer wait.
        await jest.advanceTimersByTimeAsync(REDIS_READY_WAIT_MS + 1);
        await assertion;
        expect(m.set).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it("throws immediately when the client status is end (closed connection)", async () => {
      m.status = "end";
      await expect(service.acquireLock("closed-key", 5_000)).rejects.toThrow(
        /status=end/,
      );
      expect(m.set).not.toHaveBeenCalled();
    });

    it("rejects as soon as a connection error fires while waiting", async () => {
      m.status = "connecting";
      m.once.mockImplementation((event: string, cb: (e?: Error) => void) => {
        if (event === "error")
          setTimeout(() => cb(new Error("ECONNREFUSED")), 10);
        return m;
      });

      await expect(service.acquireLock("err-key", 5_000)).rejects.toThrow(
        /ECONNREFUSED/,
      );
      expect(m.set).not.toHaveBeenCalled();
    });
  });
});
