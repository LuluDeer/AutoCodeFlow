import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { QueryFailedError } from "typeorm";
import { MutexGroupService } from "../mutex-group.service";
import { MutexGroup } from "../entities/mutex-group.entity";

// R6：模拟 PG 唯一约束冲突（SQLSTATE 23505）——驱动抛 QueryFailedError 且
// 携带 .code（task.service 同名先例的判定面）。
const uniqueViolationError = () => {
  const err = new QueryFailedError(
    'INSERT INTO "mutex_groups" ...',
    [],
    new Error(
      'duplicate key value violates unique constraint "uq_mutex_groups_name"',
    ),
  );
  (err as unknown as { code?: string }).code = "23505";
  return err;
};

describe("MutexGroupService (MUTEX-01)", () => {
  let service: MutexGroupService;
  let repo: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
    manager: { query: jest.Mock };
  };

  beforeEach(async () => {
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((d) => d),
      save: jest.fn(async (e) => ({
        id: "g1",
        maxConcurrentPerDevice: 1,
        ...e,
      })),
      remove: jest.fn().mockResolvedValue(undefined),
      manager: { query: jest.fn().mockResolvedValue([{ count: 0 }]) },
    };
    const module = await Test.createTestingModule({
      providers: [
        MutexGroupService,
        { provide: getRepositoryToken(MutexGroup), useValue: repo },
      ],
    }).compile();
    service = module.get(MutexGroupService);
  });

  it("create：并发数缺省为 1，组名去空白", async () => {
    const created = await service.create({ name: "  ziniao  " });
    expect(created.name).toBe("ziniao");
    expect(created.maxConcurrentPerDevice).toBe(1);
  });

  it("create：重名 → 409", async () => {
    repo.findOne.mockResolvedValue({ id: "g0", name: "ziniao" });
    await expect(service.create({ name: "ziniao" })).rejects.toThrow(
      ConflictException,
    );
  });

  it("remove：组上仍挂应用且未显式 force → 409（避免无感知解除一批应用的互斥）", async () => {
    repo.findOne.mockResolvedValue({ id: "g1", name: "ziniao" });
    repo.manager.query.mockResolvedValue([{ count: 2 }]);
    await expect(service.remove("g1")).rejects.toThrow(ConflictException);
    // force=true 放行删除。
    await expect(service.remove("g1", true)).resolves.toBeUndefined();
    expect(repo.remove).toHaveBeenCalled();
  });

  it("remove：组不存在 → 404", async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(service.remove("nope")).rejects.toThrow(NotFoundException);
  });

  // P3：同名预检查是 check-then-act，并发同名时后落库者撞 unique(name)
  // （23505）——必须 409 而非裸 500（照抄 task.service create 的先例）。
  it("create：并发同名撞 23505 → 409", async () => {
    repo.findOne.mockResolvedValue(null); // 预检查通过（TOCTOU 窗口）
    repo.save.mockRejectedValueOnce(uniqueViolationError());
    await expect(service.create({ name: "ziniao" })).rejects.toThrow(
      ConflictException,
    );
  });

  it("create：非唯一约束错误照原样抛（不误吞）", async () => {
    repo.findOne.mockResolvedValue(null);
    repo.save.mockRejectedValueOnce(new Error("connection reset"));
    await expect(service.create({ name: "ziniao" })).rejects.toThrow(
      "connection reset",
    );
  });

  it("update：更名并发撞 23505 → 409（预检查排除自身 id 后的兜底）", async () => {
    // 第一次 findOne（按 id）返回本组；第二次（按 name）无冲突 → 通过预检查
    repo.findOne.mockImplementation(
      (opts: { where: Record<string, unknown> }) =>
        Promise.resolve(opts.where.id ? { id: "g1", name: "old-name" } : null),
    );
    repo.save.mockRejectedValueOnce(uniqueViolationError());
    await expect(service.update("g1", { name: "new-name" })).rejects.toThrow(
      ConflictException,
    );
  });
});
