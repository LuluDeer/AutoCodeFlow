import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConflictException } from "@nestjs/common";
import { MutexGroupService } from "../mutex-group.service";
import { MutexGroup } from "../entities/mutex-group.entity";

/**
 * N-15：互斥组作用域（scope）读写面单测——create 默认 device（存量行为）、
 * scope 透传、update 可改档。占坑语义的两档分支由
 * executor/__tests__/executor.mutex-claim.spec.ts 覆盖。
 */
const makeRepo = () => ({
  create: jest.fn((d) => d),
  save: jest.fn(async (e) => ({ id: "g-1", ...e })),
  findOne: jest.fn().mockResolvedValue(null),
});

describe("MutexGroupService scope (N-15)", () => {
  let service: MutexGroupService;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(async () => {
    repo = makeRepo();
    const module = await Test.createTestingModule({
      providers: [
        MutexGroupService,
        { provide: getRepositoryToken(MutexGroup), useValue: repo },
      ],
    }).compile();
    service = module.get(MutexGroupService);
  });

  it("create：缺省 scope=device（存量行为），显式 global 透传", async () => {
    await service.create({ name: "g-device" } as never);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "device" }),
    );

    await service.create({ name: "g-global", scope: "global" } as never);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "global" }),
    );
  });

  it("update：可改档（global→device 释放跨设备约束）", async () => {
    repo.findOne.mockResolvedValueOnce({
      id: "g-1",
      name: "sso",
      scope: "global",
      maxConcurrentPerDevice: 1,
    });
    const saved = await service.update("g-1", { scope: "device" } as never);
    expect(saved.scope).toBe("device");
  });

  it("create：同名冲突仍 409（scope 改动不破坏既有唯一约束路径）", async () => {
    repo.findOne.mockResolvedValueOnce({ id: "g-exists", name: "dup" });
    await expect(
      service.create({ name: "dup" } as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
