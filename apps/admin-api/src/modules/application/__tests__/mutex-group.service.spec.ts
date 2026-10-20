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
const makeRepo = () => {
  const repo: any = {
    create: jest.fn((d) => d),
    save: jest.fn(async (e) => ({ id: "g-1", ...e })),
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    manager: { query: jest.fn().mockResolvedValue([]) },
    remove: jest.fn(),
    // R75：update 改列级写 —— 假仓储需要 update，且按真实语义把 patch 落到 findOne 返回的行上
    // （永远返回 affected=1 的替身，会让「改了哪几列」这条判据在测试里不存在）。
    update: jest.fn(async (where: any, patch: any) => {
      const row = await repo.findOne({ where });
      if (!row) return { affected: 0 };
      Object.assign(row, patch);
      return { affected: 1 };
    }),
  };
  return repo;
};

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
    // R75：只写 dto 带来的那一列，不整行 save（整行 save 会在实体将来多出
    // 别的写者时，把那些列按快照写回去）
    expect(repo.update).toHaveBeenCalledWith({ id: "g-1" }, { scope: "device" });
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("create：同名冲突仍 409（scope 改动不破坏既有唯一路径）", async () => {
    repo.findOne.mockResolvedValueOnce({ id: "g-exists", name: "dup" });
    await expect(
      service.create({ name: "dup" } as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

/**
 * MUTEX-CLI（2026-10）：findAll 必须回填 applicationCount。
 *
 * 该字段自 MUTEX-01 起就声明在 MutexGroupResponseDto 上，但 findAll 一直返回
 * 裸实体 → 读面上恒 undefined（契约与实现脱节）。消费方（中台组管理页、
 * `acf mutex list`）要靠它判断「删这个组会不会影响应用」——正是 remove() 里
 * 409 规则所依赖的信息，用户在删之前就该看见。
 */
describe("MutexGroupService.findAll applicationCount（MUTEX-CLI）", () => {
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

  it("按组回填挂载应用数（未挂任何应用的组为 0，不是 undefined）", async () => {
    repo.find.mockResolvedValueOnce([
      { id: "g-1", name: "ziniao", scope: "device", maxConcurrentPerDevice: 1 },
      { id: "g-2", name: "empty", scope: "device", maxConcurrentPerDevice: 1 },
    ]);
    repo.manager.query.mockResolvedValueOnce([
      { mutexGroupId: "g-1", count: 3 },
    ]);

    const out = await service.findAll();

    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(
      expect.objectContaining({ id: "g-1", applicationCount: 3 }),
    );
    // 没有任何应用挂载的组必须是 0——否则读面又是「契约声明了但没值」
    expect(out[1]).toEqual(
      expect.objectContaining({ id: "g-2", applicationCount: 0 }),
    );
  });

  it("无组时短路：不发起聚合查询（空列表页常见路径）", async () => {
    repo.find.mockResolvedValueOnce([]);
    const out = await service.findAll();
    expect(out).toEqual([]);
    expect(repo.manager.query).not.toHaveBeenCalled();
  });

  it("聚合用一条 GROUP BY 查询（非 N+1 逐组 COUNT）", async () => {
    repo.find.mockResolvedValueOnce([
      { id: "g-1", name: "a", scope: "device", maxConcurrentPerDevice: 1 },
      { id: "g-2", name: "b", scope: "device", maxConcurrentPerDevice: 1 },
      { id: "g-3", name: "c", scope: "device", maxConcurrentPerDevice: 1 },
    ]);
    repo.manager.query.mockResolvedValueOnce([]);
    await service.findAll();
    expect(repo.manager.query).toHaveBeenCalledTimes(1);
  });
});
