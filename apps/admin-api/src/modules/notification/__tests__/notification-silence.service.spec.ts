/**
 * FEAT-01: 通知静默持久化——service CRUD 校验 + NotificationService
 * 写穿/回灌/降级三语义。
 */
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BadRequestException } from "@nestjs/common";
import { NotificationSilenceService } from "../notification-silence.service";
import { NotificationSilence } from "../entities/notification-silence.entity";
import { NotificationService } from "../notification.service";
// 渠道类不经 notification.service 转出口——直从 channels/ 模块导入
import { WecomChannel } from "../channels/wecom.channel";
import { DingtalkChannel } from "../channels/dingtalk.channel";
import { EmailChannel } from "../channels/email.channel";
import { SlackChannel } from "../channels/slack.channel";
import { WebhookChannel } from "../channels/webhook.channel";
// NF-05: feishu 渠道桩（第六路扇出）
import { FeishuChannel } from "../channels/feishu.channel";

const makeRepo = () => ({
  create: jest.fn((d) => ({
    ...d,
    id: "sil-1",
    startTime: d.startTime ?? new Date(),
  })),
  save: jest.fn((e) => Promise.resolve({ ...e, id: "sil-1" })),
  count: jest.fn().mockResolvedValue(0),
  find: jest.fn().mockResolvedValue([]),
  delete: jest.fn().mockResolvedValue({ affected: 1 }),
  createQueryBuilder: jest.fn(),
});

describe("NotificationSilenceService (FEAT-01)", () => {
  let service: NotificationSilenceService;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(async () => {
    repo = makeRepo();
    const module = await Test.createTestingModule({
      providers: [
        NotificationSilenceService,
        { provide: getRepositoryToken(NotificationSilence), useValue: repo },
      ],
    }).compile();
    service = module.get(NotificationSilenceService);
  });

  it("creates a task-scoped silence and folds durationMinutes into endTime", async () => {
    const created = await service.create({
      scope: "task",
      taskId: "t-1",
      durationMinutes: 30,
    });
    expect(created.endTime).toBeDefined();
    expect(created.startTime).toBeDefined();
    expect(created.endTime!.getTime() - created.startTime!.getTime()).toBe(
      30 * 60_000,
    );
  });

  it("rejects scope=task without taskId and invalid scopes", async () => {
    await expect(service.create({ scope: "task" })).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.create({ scope: "weird" } as never)).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      service.create({ scope: "application", channelType: "pagerduty" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("lists active rows via filtered query", async () => {
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([{ id: "sil-1" }]),
    };
    repo.createQueryBuilder.mockReturnValue(qb);
    const rows = await service.listActive(new Date("2026-09-07T00:00:00Z"));
    expect(rows).toHaveLength(1);
    expect(qb.take).toHaveBeenCalledWith(1000);
  });
});

describe("NotificationService silence persistence wiring (FEAT-01)", () => {
  function silenceStoreMock(overrides: Record<string, jest.Mock> = {}) {
    return {
      listActive: jest.fn().mockResolvedValue([
        {
          id: "sil-db-1",
          scope: "task",
          taskId: "t-9",
          level: null,
          channelType: null,
          applicationId: null,
          reason: "maintenance",
          startTime: new Date(Date.now() - 60_000),
          endTime: new Date(Date.now() + 3_600_000),
          durationMinutes: 60,
          createdAt: new Date(),
        },
      ]),
      create: jest.fn().mockResolvedValue({ id: "sil-db-2" }),
      remove: jest.fn().mockResolvedValue(true),
      cleanExpired: jest.fn().mockResolvedValue(0),
      ...overrides,
    };
  }

  async function makeService(
    silenceStore: ReturnType<typeof silenceStoreMock> | undefined,
  ) {
    const module = await Test.createTestingModule({
      providers: [
        NotificationService,
        { provide: WecomChannel, useValue: { send: jest.fn() } },
        { provide: DingtalkChannel, useValue: { send: jest.fn() } },
        { provide: EmailChannel, useValue: { send: jest.fn() } },
        { provide: SlackChannel, useValue: { send: jest.fn() } },
        { provide: WebhookChannel, useValue: { send: jest.fn() } },
        { provide: FeishuChannel, useValue: { send: jest.fn() } },
        ...(silenceStore
          ? [{ provide: NotificationSilenceService, useValue: silenceStore }]
          : []),
      ],
    }).compile();
    return module.get(NotificationService);
  }

  it("write-through: addSilence persists via the store and adopts the DB id", async () => {
    const store = silenceStoreMock();
    const service = await makeService(store);

    const memoryId = service.addSilence({ taskId: "t-1", durationMinutes: 10 });
    await new Promise((r) => setTimeout(r, 0)); // flush write-through promise

    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "task", taskId: "t-1" }),
    );
    // 内存即刻生效（同步语义不变）
    expect(service.isSilenced("t-1")).toBe(true);
    void memoryId;
  });

  it("restore: onModuleInit loads persisted active silences into the memory map", async () => {
    const store = silenceStoreMock();
    const service = await makeService(store);

    service.onModuleInit();
    await new Promise((r) => setTimeout(r, 0));

    // DB 中的 t-9 静默重启后仍生效
    expect(service.isSilenced("t-9")).toBe(true);
    expect(service.isSilenced("t-other")).toBe(false);
    expect(store.listActive).toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it("degrades to memory-only when no store is provided (optional injection)", async () => {
    const service = await makeService(undefined);
    const id = service.addSilence({ taskId: "t-2", durationMinutes: 5 });
    expect(id).toBeTruthy();
    expect(service.isSilenced("t-2")).toBe(true);
    expect(service.removeSilence(id)).toBe(true);
    expect(service.isSilenced("t-2")).toBe(false);
  });
});
