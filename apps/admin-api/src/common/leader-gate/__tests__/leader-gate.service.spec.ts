import {
  CRON_LEADER_LOCK_KEY,
  CRON_LEADER_RETRY_MS,
  CRON_LEADER_TTL_MS,
  LeaderGateService,
} from "../leader-gate.service";
import { Lock, RedisLockService } from "../../services/redis-lock.service";
import { Repository } from "typeorm";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { AuthService } from "../../../modules/auth/auth.service";
import { UsersService } from "../../../modules/users/users.service";
import { RefreshToken } from "../../../modules/auth/entities/refresh-token.entity";

/** 构造一个已获取的锁句柄（release 可断言） */
function makeLock(overrides: Partial<Lock> = {}): Lock {
  return {
    key: CRON_LEADER_LOCK_KEY,
    lockId: "cron-leader-lock-id-1",
    ttlMs: CRON_LEADER_TTL_MS,
    released: false,
    release: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

interface LockServiceMock {
  service: RedisLockService;
  acquireLock: jest.Mock;
  extendLock: jest.Mock;
}

function makeLockService(): LockServiceMock {
  const acquireLock = jest.fn();
  const extendLock = jest.fn();
  const service = { acquireLock, extendLock } as unknown as RedisLockService;
  return { service, acquireLock, extendLock };
}

async function initGate(
  lockService: RedisLockService,
): Promise<LeaderGateService> {
  const gate = new LeaderGateService(lockService);
  await gate.onModuleInit();
  return gate;
}

describe("LeaderGateService（ARCH-31 §5 cron 维护任务统一 Leader 门禁）", () => {
  let lockMock: LockServiceMock;

  beforeEach(() => {
    jest.useFakeTimers();
    lockMock = makeLockService();
  });

  afterEach(async () => {
    // 逐用例兜底清理，防止定时器跨用例泄漏（无锁的 gate 释放无副作用）
    await Promise.resolve();
    jest.useRealTimers();
  });

  describe("竞选（acquireLock）", () => {
    it("acquire 成功 → isLeader=true，锁参数为独立 key cron:leader + TTL 30s", async () => {
      lockMock.acquireLock.mockResolvedValue(makeLock());

      const gate = await initGate(lockMock.service);

      expect(gate.isLeader).toBe(true);
      expect(lockMock.acquireLock).toHaveBeenCalledWith(
        CRON_LEADER_LOCK_KEY,
        CRON_LEADER_TTL_MS,
      );
      expect(CRON_LEADER_LOCK_KEY).toBe("cron:leader");
    });

    it("acquire 返回 null（锁被其他实例持有）→ 保持 follower 且安排竞选重试；重试到点后再次竞选", async () => {
      lockMock.acquireLock.mockResolvedValueOnce(null);

      const gate = await initGate(lockMock.service);

      expect(gate.isLeader).toBe(false);
      expect(lockMock.acquireLock).toHaveBeenCalledTimes(1);

      // 重试周期到点后再次竞选，此次拿到锁 → 升级为 Leader
      lockMock.acquireLock.mockResolvedValueOnce(makeLock());
      await jest.advanceTimersByTimeAsync(CRON_LEADER_RETRY_MS);

      expect(lockMock.acquireLock).toHaveBeenCalledTimes(2);
      expect(gate.isLeader).toBe(true);
    });

    it("acquire 抛错（Redis 不可用）→ fail-open 按 Leader 运行，且保留竞选重试", async () => {
      lockMock.acquireLock.mockRejectedValue(new Error("redis down"));

      const gate = await initGate(lockMock.service);

      expect(gate.isLeader).toBe(true);
      expect(lockMock.acquireLock).toHaveBeenCalledTimes(1);

      // fail-open Leader 周期性重试：Redis 恢复且锁已被其他实例真正持有 → 让位
      lockMock.acquireLock.mockResolvedValueOnce(null);
      await jest.advanceTimersByTimeAsync(CRON_LEADER_RETRY_MS);

      expect(lockMock.acquireLock).toHaveBeenCalledTimes(2);
      expect(gate.isLeader).toBe(false);
    });

    it("fail-open Leader 后补拿真实锁成功 → 无缝转为持锁 Leader（不重复打 acquired 日志路径）", async () => {
      lockMock.acquireLock.mockRejectedValue(new Error("redis down"));
      const gate = await initGate(lockMock.service);
      expect(gate.isLeader).toBe(true);

      lockMock.acquireLock.mockResolvedValueOnce(makeLock());
      await jest.advanceTimersByTimeAsync(CRON_LEADER_RETRY_MS);

      expect(gate.isLeader).toBe(true);
      // 后续 extendLock 校验定时器已就位（用 TTL/2 处的一次校验证明）
      lockMock.extendLock.mockResolvedValue(true);
      await jest.advanceTimersByTimeAsync(CRON_LEADER_TTL_MS / 2);
      expect(lockMock.extendLock).toHaveBeenCalledTimes(1);
    });
  });

  describe("Leader 租约校验（extendLock）", () => {
    it("extendLock 返回 false（锁已易主）→ demote、释放本地锁句柄并安排重试", async () => {
      const lock = makeLock();
      lockMock.acquireLock.mockResolvedValue(lock);
      const gate = await initGate(lockMock.service);
      expect(gate.isLeader).toBe(true);

      lockMock.extendLock.mockResolvedValue(false);
      await jest.advanceTimersByTimeAsync(CRON_LEADER_TTL_MS / 2);

      expect(gate.isLeader).toBe(false);
      expect(lock.release).toHaveBeenCalledTimes(1);
      // demote 后保留竞选重试：下一周期再次竞选
      lockMock.acquireLock.mockResolvedValueOnce(
        makeLock({ lockId: "lock-id-2" }),
      );
      await jest.advanceTimersByTimeAsync(CRON_LEADER_RETRY_MS);
      expect(lockMock.acquireLock).toHaveBeenCalledTimes(2);
      expect(gate.isLeader).toBe(true);
    });

    it("extendLock 抛错（Redis 抖动）→ 保留租约，下个校验周期再判定", async () => {
      const lock = makeLock();
      lockMock.acquireLock.mockResolvedValue(lock);
      const gate = await initGate(lockMock.service);

      lockMock.extendLock.mockRejectedValueOnce(new Error("timeout"));
      await jest.advanceTimersByTimeAsync(CRON_LEADER_TTL_MS / 2);
      expect(gate.isLeader).toBe(true);

      // 下一周期恢复 → 校验通过仍为 Leader
      lockMock.extendLock.mockResolvedValueOnce(true);
      await jest.advanceTimersByTimeAsync(CRON_LEADER_TTL_MS / 2);
      expect(gate.isLeader).toBe(true);
      expect(lockMock.extendLock).toHaveBeenCalledTimes(2);
    });
  });

  describe("销毁（onModuleDestroy）", () => {
    it("持锁 Leader 销毁：释放锁、清空身份，重试/校验定时器不再触发", async () => {
      const lock = makeLock();
      lockMock.acquireLock.mockResolvedValue(lock);
      const gate = await initGate(lockMock.service);
      expect(gate.isLeader).toBe(true);

      await gate.onModuleDestroy();

      expect(gate.isLeader).toBe(false);
      expect(lock.release).toHaveBeenCalledTimes(1);

      const callsAtDestroy = lockMock.acquireLock.mock.calls.length;
      await jest.advanceTimersByTimeAsync(CRON_LEADER_TTL_MS * 10);
      expect(lockMock.acquireLock.mock.calls.length).toBe(callsAtDestroy);
      expect(lockMock.extendLock).not.toHaveBeenCalled();
    });

    it("follower 销毁：待发的竞选重试定时器被清除，不再发起 acquire", async () => {
      lockMock.acquireLock.mockResolvedValue(null);
      const gate = await initGate(lockMock.service);
      expect(gate.isLeader).toBe(false);
      expect(lockMock.acquireLock).toHaveBeenCalledTimes(1);

      await gate.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(CRON_LEADER_RETRY_MS * 10);

      expect(lockMock.acquireLock).toHaveBeenCalledTimes(1);
    });
  });

  describe("代表性 service 门禁行为（@Cron 第一行 guard 契约）", () => {
    // 用 AuthService.cleanupExpiredTokens 作代表：门禁写在 @Cron 方法体
    // 第一行 `if (this.leaderGate && !this.leaderGate.isLeader) return;`，
    // 全部 10 处门禁 @Cron 同构（仅注入与底层动作不同）。
    const makeAuthRepo = () =>
      ({
        delete: jest.fn().mockResolvedValue({ affected: 1 }),
      }) as unknown as Repository<RefreshToken>;

    const makeAuthService = (
      repo: Repository<RefreshToken>,
      leaderGate: LeaderGateService | null,
    ): AuthService =>
      new AuthService(
        {} as UsersService,
        {} as JwtService,
        {} as ConfigService,
        repo,
        leaderGate,
      );

    it("follower gate（isLeader=false）→ 底层动作不执行", async () => {
      const repo = makeAuthRepo();
      const followerGate = { isLeader: false } as LeaderGateService;
      const service = makeAuthService(repo, followerGate);

      await service.cleanupExpiredTokens();

      expect(repo.delete).not.toHaveBeenCalled();
    });

    it("leader gate（isLeader=true）→ 底层动作执行", async () => {
      const repo = makeAuthRepo();
      const leaderGate = { isLeader: true } as LeaderGateService;
      const service = makeAuthService(repo, leaderGate);

      await service.cleanupExpiredTokens();

      expect(repo.delete).toHaveBeenCalledTimes(1);
    });

    it("gate 缺席（null，既有单测直接 new 装配）→ 门禁不生效，动作照常执行（锁既有行为）", async () => {
      const repo = makeAuthRepo();
      const service = makeAuthService(repo, null);

      await service.cleanupExpiredTokens();

      expect(repo.delete).toHaveBeenCalledTimes(1);
    });
  });
});
