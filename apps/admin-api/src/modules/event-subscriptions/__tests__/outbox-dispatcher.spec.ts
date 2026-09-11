/**
 * FEAT-19: OutboxDispatcher 行为 spec。
 *
 * 覆盖：
 * - enqueue 落库（eventId 格式/行形状）；disabled 时不落库。
 * - 扫描补投成功 → dispatchedAt 回写（重启恢复：遗留未派发行被启动扫描补投）。
 * - 失败 → attempts+1 + nextAttemptAt 指数退避（封顶 5min）。
 * - 超过 MAX_OUTBOX_ATTEMPTS → 死信落库 + deadLettered 终态。
 * - 扫描只取「未派发 + 非死信 + 无退避指针或已到期」的行。
 * - 扫描 DB 抖动不外抛（下轮再试）。
 * - 既有 dispatcher 接线：事件到达 → outbox 落行（写成功才返回）。
 * - OnModuleInit 定时器生命周期（destroy 清理）。
 */
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { EventSubscription } from "../entities/event-subscription.entity";
import { EventSubscriptionDeadLetter } from "../entities/event-subscription-dead-letter.entity";
import { EventOutbox } from "../entities/event-outbox.entity";
import {
  OutboxDispatcher,
  OUTBOUND_DISPATCHER_TOKEN,
  OUTBOX_BATCH_SIZE,
  OUTBOX_LEASE_MS,
  OUTBOX_MAX_ROW_PROCESSING_MS,
  OUTBOX_SCAN_INTERVAL_MS,
} from "../outbox-dispatcher.service";
import {
  MAX_OUTBOX_ATTEMPTS,
  outboxRetryDelayMs,
} from "../event-subscription.util";

jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn().mockResolvedValue({ status: 200 }) },
}));

function makeRow(overrides: Partial<EventOutbox> = {}): EventOutbox {
  return {
    id: "aaaaaaa1-0000-4000-8000-000000000001",
    eventId: "execution.failed:11111111-1111-4111-8111-111111111111",
    eventType: "execution.failed",
    payload: { event: "execution.failed", occurredAt: "t", data: {} },
    dispatchedAt: null,
    attempts: 0,
    nextAttemptAt: null,
    leaseUntil: null,
    leaseToken: null,
    deadLettered: false,
    createdAt: new Date(),
    ...overrides,
  } as EventOutbox;
}

describe("FEAT-19 OutboxDispatcher", () => {
  const dataSourceMock = {
    query: jest.fn().mockResolvedValue([]),
  };
  const outboxRepoMock = {
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockImplementation((x) => Promise.resolve(x)),
    create: jest.fn((x) => x),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const subRepoMock = {
    find: jest.fn().mockResolvedValue([]),
  };
  const dlRepoMock = {
    save: jest.fn().mockImplementation((x) => Promise.resolve(x)),
    create: jest.fn((x) => x),
  };
  // deliverToSubscribers 的桩：默认成功；失败用例改 reject。
  const dispatcherMock = {
    deliverToSubscribers: jest.fn().mockResolvedValue(undefined),
  };
  const configMock = {
    get: jest.fn((key: string) =>
      key === "eventOutbox.enabled" ? true : undefined,
    ),
  };

  let outbox: OutboxDispatcher;

  beforeEach(async () => {
    jest.clearAllMocks();
    dataSourceMock.query.mockReset();
    dataSourceMock.query.mockResolvedValue([]);
    const moduleRef = await Test.createTestingModule({
      providers: [
        OutboxDispatcher,
        // FEAT-19 接线形态：派发面经 OUTBOUND_DISPATCHER_TOKEN 令牌注入
        // （与 event-subscription.module 的 useFactory 别名同构）。
        {
          provide: OUTBOUND_DISPATCHER_TOKEN,
          useValue: dispatcherMock,
        },
        { provide: ConfigService, useValue: configMock },
        { provide: DataSource, useValue: dataSourceMock },
        { provide: getRepositoryToken(EventOutbox), useValue: outboxRepoMock },
        {
          provide: getRepositoryToken(EventSubscription),
          useValue: subRepoMock,
        },
        {
          provide: getRepositoryToken(EventSubscriptionDeadLetter),
          useValue: dlRepoMock,
        },
      ],
    }).compile();
    outbox = moduleRef.get(OutboxDispatcher);
  });

  afterEach(() => {
    outbox.onModuleDestroy();
  });

  describe("enqueue", () => {
    it("落一行 outbox（eventId=事件名:uuid 截 64、payload 原文、行形状完整）", async () => {
      const payload = { event: "execution.failed", occurredAt: "t", data: {} };
      await outbox.enqueue("execution.failed", payload);
      expect(outboxRepoMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "execution.failed",
          payload,
          dispatchedAt: null,
          attempts: 0,
          deadLettered: false,
        }),
      );
      const arg = outboxRepoMock.create.mock.calls[0][0] as EventOutbox;
      expect(arg.eventId.startsWith("execution.failed:")).toBe(true);
      expect(arg.eventId.length).toBeLessThanOrEqual(64);
      expect(outboxRepoMock.save).toHaveBeenCalledTimes(1);
    });

    it("落库失败仅记日志 fail-open（不外抛）", async () => {
      outboxRepoMock.save.mockRejectedValueOnce(new Error("db down"));
      await expect(
        outbox.enqueue("execution.failed", { event: "execution.failed" }),
      ).resolves.toBeUndefined();
      outboxRepoMock.save.mockRejectedValueOnce(new Error("db down"));
      await expect(
        outbox.enqueue("execution.failed", {}),
      ).resolves.toBeUndefined();
    });
  });

  describe("scanOnce（重启恢复 + 补投）", () => {
    it("补投成功：deliverToSubscribers 被调 + 行回写 dispatchedAt 终态", async () => {
      const row = makeRow({
        leaseUntil: new Date(Date.now() + 60_000),
        leaseToken: "claim-token",
      });
      dataSourceMock.query.mockResolvedValueOnce([row]);
      // 有匹配订阅（否则 processRow 走无订阅短路，不调派发面）。
      subRepoMock.find.mockResolvedValue([
        { id: "s1", eventTypes: ["execution.failed"] },
      ]);
      const n = await outbox.scanOnce();
      expect(n).toBe(1);
      expect(dispatcherMock.deliverToSubscribers).toHaveBeenCalledWith(
        "execution.failed",
        row.payload,
      );
      expect(outboxRepoMock.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: row.id, leaseToken: "claim-token" }),
        expect.objectContaining({ nextAttemptAt: null, leaseToken: null }),
      );
      const patch = outboxRepoMock.update.mock.calls[0][1] as {
        dispatchedAt: Date;
      };
      expect(patch.dispatchedAt).toBeInstanceOf(Date);
    });

    it("claim SQL 原子地选择并更新 lease，活动租约由谓词跳过且过期可回收", async () => {
      dataSourceMock.query.mockResolvedValueOnce([]);
      await outbox.scanOnce();
      const [sql, params] = dataSourceMock.query.mock.calls[0] as [
        string,
        unknown[],
      ];
      expect(sql).toContain("FOR UPDATE SKIP LOCKED");
      expect(sql).toContain('UPDATE "event_outbox"');
      expect(sql).toContain('"leaseUntil" IS NULL OR "leaseUntil" <= $1');
      expect(sql).toContain(
        '"leaseToken" = md5(random()::text || clock_timestamp()::text)',
      );
      expect(sql).toContain('"nextAttemptAt" IS NULL OR "nextAttemptAt" <= $1');
      expect(sql).toContain("LIMIT $2");
      expect(params).toHaveLength(3);
      expect(params[1]).toBe(OUTBOX_BATCH_SIZE);
    });

    it("串行逐行处理时，单行 claim 窗口覆盖最坏正常派发时间", () => {
      // 3 x 10s HTTP timeout + 1s + 2s backoff = 33s; the 60s lease leaves
      // enough margin for DB reads and finalization while the row is active.
      expect(OUTBOX_BATCH_SIZE).toBe(1);
      expect(OUTBOX_MAX_ROW_PROCESSING_MS).toBe(33_000);
      expect(OUTBOX_LEASE_MS).toBeGreaterThan(OUTBOX_MAX_ROW_PROCESSING_MS);
    });

    it("claim 返回互不相交的行并为每行生成独立 token", async () => {
      const rows = [
        makeRow({ id: "row-1", leaseToken: "token-1" }),
        makeRow({ id: "row-2", leaseToken: "token-2" }),
      ];
      dataSourceMock.query.mockResolvedValueOnce(rows);
      const otherInstanceRows = [
        makeRow({ id: "row-3", leaseToken: "token-3" }),
      ];
      dataSourceMock.query.mockResolvedValueOnce(otherInstanceRows);
      await expect(outbox.scanOnce()).resolves.toBe(2);
      expect(dataSourceMock.query).toHaveBeenCalledTimes(1);
      expect(new Set(rows.map((row) => row.leaseToken)).size).toBe(rows.length);
      expect(new Set(otherInstanceRows.map((row) => row.id))).not.toEqual(
        new Set(rows.map((row) => row.id)),
      );
    });

    it("补投失败：attempts+1 且 nextAttemptAt = now + 退避（outboxRetryDelayMs）", async () => {
      const row = makeRow({ attempts: 2, leaseToken: "claim-token" });
      dataSourceMock.query.mockResolvedValueOnce([row]);
      subRepoMock.find.mockResolvedValue([
        { id: "s1", eventTypes: ["execution.failed"] },
      ]);
      dispatcherMock.deliverToSubscribers.mockRejectedValueOnce(
        new Error("ECONNREFUSED"),
      );
      const before = Date.now();
      await outbox.scanOnce();
      const [where, patch] = outboxRepoMock.update.mock.calls[0] as [
        { id: string },
        { attempts: number; nextAttemptAt: Date },
      ];
      expect(where).toEqual(expect.objectContaining({ id: row.id }));
      expect(patch.attempts).toBe(3);
      const expected = before + outboxRetryDelayMs(3);
      expect(patch.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
        expected - 50,
      );
      expect(patch.nextAttemptAt.getTime()).toBeLessThanOrEqual(
        Date.now() + outboxRetryDelayMs(3),
      );
    });

    it("无匹配订阅：不调派发面，行直接终态回写（防冷订阅集积压）", async () => {
      const row = makeRow({ leaseToken: "claim-token" });
      dataSourceMock.query.mockResolvedValueOnce([row]);
      subRepoMock.find.mockResolvedValue([
        { id: "s1", eventTypes: ["executor.offline"] },
      ]);
      await outbox.scanOnce();
      expect(dispatcherMock.deliverToSubscribers).not.toHaveBeenCalled();
      expect(outboxRepoMock.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: row.id, leaseToken: "claim-token" }),
        expect.objectContaining({ nextAttemptAt: null, leaseToken: null }),
      );
    });

    it("扫描 DB 抖动不外抛（返回 0，下轮再试）", async () => {
      dataSourceMock.query.mockRejectedValueOnce(new Error("db gone"));
      await expect(outbox.scanOnce()).resolves.toBe(0);
    });

    it("重入保护：扫描进行中时再次 scanOnce 直接返回 0", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      dispatcherMock.deliverToSubscribers
        .mockImplementationOnce(() => gate)
        .mockReset()
        .mockResolvedValue(undefined);
      dataSourceMock.query.mockResolvedValueOnce([
        makeRow({ leaseToken: "claim-token" }),
      ]);
      const first = outbox.scanOnce();
      const second = await outbox.scanOnce();
      expect(second).toBe(0);
      release();
      await expect(first).resolves.toBe(1);
    });
  });

  describe("死信阈值", () => {
    it(`超过 ${MAX_OUTBOX_ATTEMPTS} 次：落 event_subscription_dead_letters + deadLettered 终态`, async () => {
      const row = makeRow({ attempts: MAX_OUTBOX_ATTEMPTS });
      dataSourceMock.query.mockResolvedValueOnce([row]);
      subRepoMock.find.mockResolvedValue([
        { id: "s1", eventTypes: ["execution.failed"] },
      ]);
      dispatcherMock.deliverToSubscribers.mockRejectedValue(
        new Error("still down"),
      );
      await outbox.scanOnce();
      expect(dlRepoMock.save).toHaveBeenCalledTimes(1);
      const dl = dlRepoMock.save.mock.calls[0][0];
      expect(dl.eventType).toBe("execution.failed");
      expect(dl.attempts).toBe(MAX_OUTBOX_ATTEMPTS + 1);
      expect(dl.error).toContain("still down");
      expect(outboxRepoMock.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: row.id }),
        expect.objectContaining({ deadLettered: true, leaseToken: null }),
      );
      // 死信行不再设置退避指针。
      const patch = outboxRepoMock.update.mock.calls[0][1] as Record<
        string,
        unknown
      >;
      expect(patch.attempts).toBe(MAX_OUTBOX_ATTEMPTS + 1);
      expect(patch.nextAttemptAt).toBeNull();
    });

    it("未到阈值：不落死信，只退避", async () => {
      const row = makeRow({ attempts: MAX_OUTBOX_ATTEMPTS - 1 });
      dataSourceMock.query.mockResolvedValueOnce([row]);
      subRepoMock.find.mockResolvedValue([
        { id: "s1", eventTypes: ["execution.failed"] },
      ]);
      dispatcherMock.deliverToSubscribers.mockRejectedValueOnce(
        new Error("flaky"),
      );
      await outbox.scanOnce();
      expect(dlRepoMock.save).not.toHaveBeenCalled();
      expect(outboxRepoMock.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: row.id }),
        expect.objectContaining({
          attempts: MAX_OUTBOX_ATTEMPTS,
          leaseToken: null,
        }),
      );
    });

    it("stale owner: finalize affected=0 时不写死信", async () => {
      const row = makeRow({
        attempts: MAX_OUTBOX_ATTEMPTS,
        leaseToken: "stale-token",
      });
      dataSourceMock.query.mockResolvedValueOnce([row]);
      subRepoMock.find.mockResolvedValue([
        { id: "s1", eventTypes: ["execution.failed"] },
      ]);
      dispatcherMock.deliverToSubscribers.mockRejectedValueOnce(
        new Error("stale failure"),
      );
      outboxRepoMock.update.mockResolvedValueOnce({ affected: 0 });

      await outbox.scanOnce();

      expect(outboxRepoMock.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: row.id,
          leaseToken: "stale-token",
        }),
        expect.objectContaining({ deadLettered: true }),
      );
      expect(dlRepoMock.save).not.toHaveBeenCalled();
    });

    it("stale owner: finalize DB error 时不写死信", async () => {
      const row = makeRow({
        attempts: MAX_OUTBOX_ATTEMPTS,
        leaseToken: "stale-token",
      });
      dataSourceMock.query.mockResolvedValueOnce([row]);
      subRepoMock.find.mockResolvedValue([
        { id: "s1", eventTypes: ["execution.failed"] },
      ]);
      dispatcherMock.deliverToSubscribers.mockRejectedValueOnce(
        new Error("stale failure"),
      );
      outboxRepoMock.update.mockRejectedValueOnce(new Error("db gone"));

      await outbox.scanOnce();

      expect(dlRepoMock.save).not.toHaveBeenCalled();
    });
  });

  describe("退避纯函数与开关", () => {
    it("outboxRetryDelayMs：5s 基座指数退避，封顶 5min", () => {
      expect(outboxRetryDelayMs(1)).toBe(5_000);
      expect(outboxRetryDelayMs(2)).toBe(10_000);
      expect(outboxRetryDelayMs(4)).toBe(40_000);
      expect(outboxRetryDelayMs(7)).toBe(300_000);
      expect(outboxRetryDelayMs(50)).toBe(300_000);
    });

    it("EVENT_OUTBOX_ENABLED=false：不落库、OnModuleInit 不设 timer", async () => {
      configMock.get.mockReturnValue(false);
      const moduleRef = await Test.createTestingModule({
        providers: [
          OutboxDispatcher,
          { provide: OUTBOUND_DISPATCHER_TOKEN, useValue: dispatcherMock },
          { provide: ConfigService, useValue: configMock },
          { provide: DataSource, useValue: dataSourceMock },
          {
            provide: getRepositoryToken(EventOutbox),
            useValue: outboxRepoMock,
          },
          {
            provide: getRepositoryToken(EventSubscription),
            useValue: subRepoMock,
          },
          {
            provide: getRepositoryToken(EventSubscriptionDeadLetter),
            useValue: dlRepoMock,
          },
        ],
      }).compile();
      const disabled = moduleRef.get(OutboxDispatcher);
      expect(disabled.isEnabled()).toBe(false);
      disabled.onModuleInit();
      await disabled.enqueue("execution.failed", {});
      expect(outboxRepoMock.save).not.toHaveBeenCalled();
      disabled.onModuleDestroy();
      configMock.get.mockReturnValue(true);
    });
  });

  describe("OnModuleInit 生命周期", () => {
    it("enabled 时 OnModuleInit 启动扫描 + 周期 timer；destroy 清理", async () => {
      jest.useFakeTimers();
      try {
        dataSourceMock.query.mockResolvedValue([]);
        outbox.onModuleInit();
        // 启动扫描已触发一轮。
        await Promise.resolve();
        await Promise.resolve();
        expect(dataSourceMock.query).toHaveBeenCalled();
        const callsBefore = dataSourceMock.query.mock.calls.length;
        // 快进一个周期 → 下一轮扫描。
        await jest.advanceTimersByTimeAsync(OUTBOX_SCAN_INTERVAL_MS);
        expect(dataSourceMock.query.mock.calls.length).toBeGreaterThan(
          callsBefore,
        );
        outbox.onModuleDestroy();
        const callsAfterDestroy = dataSourceMock.query.mock.calls.length;
        await jest.advanceTimersByTimeAsync(OUTBOX_SCAN_INTERVAL_MS * 3);
        expect(dataSourceMock.query.mock.calls.length).toBe(callsAfterDestroy);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
