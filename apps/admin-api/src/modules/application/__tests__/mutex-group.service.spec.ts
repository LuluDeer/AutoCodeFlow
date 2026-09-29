import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { MutexGroupService } from "../mutex-group.service";
import { MutexGroup } from "../entities/mutex-group.entity";

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
});
