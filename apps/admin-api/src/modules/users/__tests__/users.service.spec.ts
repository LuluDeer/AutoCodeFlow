import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { getRepositoryToken } from "@nestjs/typeorm";
import { UsersService } from "../users.service";
import { User, UserRole } from "../entities/user.entity";
import * as bcrypt from "bcrypt";

jest.mock("bcrypt");

const makeRepo = (overrides: Partial<Record<string, jest.Mock>> = {}) => ({
  findOne: jest.fn(),
  findAndCount: jest.fn(),
  find: jest.fn(),
  count: jest.fn().mockResolvedValue(1),
  create: jest.fn((d: any) => d),
  save: jest.fn((e: any) => Promise.resolve(e)),
  delete: jest.fn().mockResolvedValue({ affected: 0 }),
  remove: jest.fn(),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  createQueryBuilder: jest.fn(),
  ...overrides,
});

// Chainable QueryBuilder stub for the conditional-UPDATE methods
// (recordLoginFailure / clearExpiredLock).
const makeQb = (executeResults: any[] = []) => {
  const qb: any = {};
  for (const m of ["update", "set", "where", "andWhere", "returning"]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.execute = jest.fn();
  executeResults.forEach((r) => qb.execute.mockResolvedValueOnce(r));
  return qb;
};

describe("UsersService", () => {
  let service: UsersService;
  let repo: ReturnType<typeof makeRepo>;
  // ARCH-27: initialAdmin 配置经 ConfigService 读取 —— spec 注入桩实现。
  let configService: { get: jest.Mock };

  beforeEach(async () => {
    repo = makeRepo();
    configService = { get: jest.fn().mockReturnValue(undefined) };
    (bcrypt.hash as jest.Mock).mockResolvedValue("hashed-password");
    const module = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: repo },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();
    service = module.get(UsersService);
  });

  describe("create", () => {
    it("should create a user with hashed password", async () => {
      repo.findOne.mockResolvedValue(null);
      repo.save.mockResolvedValue({
        id: 1,
        username: "test",
        password: "hashed-password",
      });

      const result = await service.create({
        username: "test",
        email: "test@example.com",
        password: "PlainPass1!",
      });

      expect(bcrypt.hash).toHaveBeenCalledWith("PlainPass1!", 12);
      expect(result.password).toBe("hashed-password");
    });

    it("should throw ConflictException when user exists", async () => {
      repo.findOne.mockResolvedValue({ id: 1, username: "test" });
      await expect(
        service.create({
          username: "test",
          email: "test@example.com",
          password: "StrongPass1!",
        }),
      ).rejects.toThrow("already exists");
    });
  });

  describe("findAll", () => {
    it("should return paginated users", async () => {
      repo.findAndCount.mockResolvedValue([[{ id: 1, username: "test" }], 1]);
      const result = await service.findAll({ page: 1, pageSize: 10 });
      expect(result.list).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  // ARCH-27: admin 种子账号配置经 ConfigService 读取（initialAdmin 节），
  // 不再直读 process.env —— 用桩 ConfigService 断言 seed 行为。
  describe("onModuleInit — initial admin seed (ARCH-27)", () => {
    it("seeds the admin user from initialAdmin config when the table is empty", async () => {
      repo.count.mockResolvedValue(0);
      configService.get.mockImplementation((key: string) => {
        if (key === "initialAdmin.password") return "SeedPass1!";
        if (key === "initialAdmin.email") return "seed-admin@example.com";
        return undefined;
      });

      await service.onModuleInit();

      expect(bcrypt.hash).toHaveBeenCalledWith("SeedPass1!", 12);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          username: "admin",
          email: "seed-admin@example.com",
          role: UserRole.ADMIN,
          isActive: true,
        }),
      );
      expect(repo.save).toHaveBeenCalledTimes(1);
    });

    it("falls back to the default seed email when initialAdmin.email is unset", async () => {
      repo.count.mockResolvedValue(0);
      configService.get.mockImplementation((key: string) =>
        key === "initialAdmin.password" ? "SeedPass1!" : undefined,
      );

      await service.onModuleInit();

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: "admin@autoflow.local" }),
      );
    });

    it("skips seeding when initialAdmin.password is not configured", async () => {
      repo.count.mockResolvedValue(0);
      const warnSpy = jest
        .spyOn((service as any).logger, "warn")
        .mockImplementation(() => {});

      await service.onModuleInit();

      expect(repo.create).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("INITIAL_ADMIN_PASSWORD not set"),
      );
      warnSpy.mockRestore();
    });

    it("does nothing when users already exist", async () => {
      repo.count.mockResolvedValue(1);

      await service.onModuleInit();

      expect(configService.get).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
    });

    // ARCH-31: 空库 + 多实例同时引导 → 两个实例都看到 count=0，唯一索引只放行
    // 一个赢家。此前输家直接抛出 23505 并中断进程启动（第二个副本起不来）。
    it("seed race (ARCH-31): 输家遇到 23505 时核对已有用户后跳过，不中断启动", async () => {
      repo.count
        .mockResolvedValueOnce(0) // 启动检查：表空
        .mockResolvedValueOnce(1); // 冲突后复核：另一个实例已种下
      configService.get.mockImplementation((key: string) =>
        key === "initialAdmin.password" ? "SeedPass1!" : undefined,
      );
      repo.save.mockRejectedValueOnce(
        Object.assign(
          new Error("duplicate key value violates unique constraint"),
          {
            code: "23505",
          },
        ),
      );
      const logSpy = jest
        .spyOn((service as any).logger, "log")
        .mockImplementation(() => {});

      await expect(service.onModuleInit()).resolves.toBeUndefined();

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("another instance already seeded"),
      );
      logSpy.mockRestore();
    });

    it("seed race (ARCH-31): 非唯一冲突的异常照旧上抛（不吞真实故障）", async () => {
      repo.count.mockResolvedValue(0);
      configService.get.mockImplementation((key: string) =>
        key === "initialAdmin.password" ? "SeedPass1!" : undefined,
      );
      repo.save.mockRejectedValueOnce(new Error("connection reset"));

      await expect(service.onModuleInit()).rejects.toThrow("connection reset");
    });
  });

  // R19: currentPassword is a verification-only field consumed by the
  // controller; Object.assign would graft it onto the entity and save()
  // echoes it back in the response.
  describe("update (R19)", () => {
    it("strips currentPassword before persisting and echoing", async () => {
      repo.findOne.mockResolvedValue({
        id: 1,
        username: "u",
        password: "hashed",
        role: "user",
      });
      const dto: any = {
        email: "new@example.com",
        currentPassword: "plaintext-pw",
      };
      const result = await service.update(1, dto);

      expect(dto.currentPassword).toBeUndefined();
      const saved = repo.save.mock.calls[0][0];
      expect(saved.currentPassword).toBeUndefined();
      expect((result as any).currentPassword).toBeUndefined();
      expect(saved.email).toBe("new@example.com");
    });

    it("still hashes a supplied password", async () => {
      repo.findOne.mockResolvedValue({ id: 1, username: "u", password: "old" });
      await service.update(1, { password: "PlainPass1!" } as any);
      expect(bcrypt.hash).toHaveBeenCalledWith("PlainPass1!", 12);
      const saved = repo.save.mock.calls[0][0];
      expect(saved.password).toBe("hashed-password");
    });
  });

  // R10: expired lockouts must be cleared atomically so the next failure
  // starts a fresh window instead of instantly re-tripping the threshold.
  describe("clearExpiredLock (R10)", () => {
    it("issues a conditional UPDATE resetting counter and lock", async () => {
      const qb = makeQb([{ affected: 1 }]);
      repo.createQueryBuilder.mockReturnValue(qb);

      await expect(service.clearExpiredLock(7)).resolves.toBe(true);

      expect(qb.set).toHaveBeenCalledWith({
        loginFailCount: 0,
        lockedUntil: null,
      });
      expect(qb.where).toHaveBeenCalledWith("id = :id", { id: 7 });
      const [cond, params] = qb.andWhere.mock.calls[0];
      expect(cond).toContain("lockedUntil IS NOT NULL");
      expect(cond).toContain("lockedUntil < :now");
      expect(params.now).toBeInstanceOf(Date);
    });

    it("returns false when nothing matched (lock still active or already cleared)", async () => {
      const qb = makeQb([{ affected: 0 }]);
      repo.createQueryBuilder.mockReturnValue(qb);
      await expect(service.clearExpiredLock(7)).resolves.toBe(false);
    });
  });

  describe("recordLoginFailure (R10 semantics)", () => {
    it("first failure after an expired-lock reset does NOT re-lock (1 < maxFail)", async () => {
      // clearExpiredLock already zeroed the counter, so the increment lands
      // on 1 — below the threshold, no second (lockedUntil) UPDATE is issued.
      const qb = makeQb([{ raw: [{ loginFailCount: 1 }] }]);
      repo.createQueryBuilder.mockReturnValue(qb);

      await service.recordLoginFailure(7, { maxFail: 5, lockMinutes: 15 });

      expect(qb.execute).toHaveBeenCalledTimes(1);
      expect(repo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it("crossing the threshold sets lockedUntil with the expired-only guard", async () => {
      const qb1 = makeQb([{ raw: [{ loginFailCount: 5 }] }]);
      const qb2 = makeQb([{ affected: 1 }]);
      repo.createQueryBuilder.mockReturnValueOnce(qb1).mockReturnValueOnce(qb2);

      await service.recordLoginFailure(7, { maxFail: 5, lockMinutes: 15 });

      expect(qb2.set).toHaveBeenCalledWith({ lockedUntil: expect.any(Date) });
      expect(qb2.andWhere).toHaveBeenCalledWith(
        "(lockedUntil IS NULL OR lockedUntil < :now)",
        { now: expect.any(Date) },
      );
    });
  });
});
