import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { AuditService } from "../audit.service";
import { AuditLog } from "../entities/audit-log.entity";

const makeQb = () => ({
  orderBy: jest.fn().mockReturnThis(),
  andWhere: jest.fn().mockReturnThis(),
  skip: jest.fn().mockReturnThis(),
  take: jest.fn().mockReturnThis(),
  getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
});

const makeRepo = () => ({
  create: jest.fn((d: any) => d),
  save: jest.fn((e: any) => Promise.resolve(e)),
  find: jest.fn(),
  delete: jest.fn().mockResolvedValue({ affected: 0 }),
  createQueryBuilder: jest.fn(() => makeQb()),
});

describe("AuditService", () => {
  let service: AuditService;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(async () => {
    repo = makeRepo();
    const module = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: getRepositoryToken(AuditLog), useValue: repo },
      ],
    }).compile();
    service = module.get(AuditService);
  });

  describe("findAll", () => {
    it("returns paginated results", async () => {
      repo.find.mockResolvedValue([]);
      // createQueryBuilder is used internally; mock it
      const qbMock = {
        orderBy: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      (repo as any).createQueryBuilder = jest.fn().mockReturnValue(qbMock);

      const result = await service.findAll({ page: 1, pageSize: 10 });
      expect(result).toEqual({ data: [], total: 0 });
      expect(qbMock.getManyAndCount).toHaveBeenCalled();
    });

    it("applies action filter", async () => {
      const qbMock = {
        orderBy: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      (repo as any).createQueryBuilder = jest.fn().mockReturnValue(qbMock);

      await service.findAll({ action: "auth.login" });
      expect(qbMock.andWhere).toHaveBeenCalledWith(
        expect.stringContaining("action"),
        expect.objectContaining({ action: expect.stringContaining("auth") }),
      );
    });

    it("applies userId filter", async () => {
      const qbMock = {
        orderBy: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      (repo as any).createQueryBuilder = jest.fn().mockReturnValue(qbMock);

      await service.findAll({ userId: 42 });
      expect(qbMock.andWhere).toHaveBeenCalledWith("log.userId = :userId", {
        userId: 42,
      });
    });

    // R4 P1-2: username / startTime / endTime filters (audit page search bar)
    it("applies username fuzzy filter", async () => {
      const qbMock = {
        orderBy: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      (repo as any).createQueryBuilder = jest.fn().mockReturnValue(qbMock);

      await service.findAll({ username: "admin" });
      expect(qbMock.andWhere).toHaveBeenCalledWith(
        "log.username ILIKE :username",
        { username: "%admin%" },
      );
    });

    it("applies startTime/endTime range filter", async () => {
      const qbMock = {
        orderBy: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      (repo as any).createQueryBuilder = jest.fn().mockReturnValue(qbMock);

      const start = "2026-01-01T00:00:00.000Z";
      const end = "2026-01-31T23:59:59.000Z";
      await service.findAll({ startTime: start, endTime: end });
      expect(qbMock.andWhere).toHaveBeenCalledWith(
        "log.createdAt >= :startTime",
        { startTime: new Date(start) },
      );
      expect(qbMock.andWhere).toHaveBeenCalledWith(
        "log.createdAt <= :endTime",
        { endTime: new Date(end) },
      );
    });

    it("does not add username/time filters when absent", async () => {
      const qbMock = {
        orderBy: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      (repo as any).createQueryBuilder = jest.fn().mockReturnValue(qbMock);

      await service.findAll({});
      expect(qbMock.andWhere).not.toHaveBeenCalled();
    });

    it("rejects invalid action characters", async () => {
      await expect(service.findAll({ action: "inject'xss" })).rejects.toThrow(
        "Invalid action parameter",
      );
    });

    it("caps pageSize at 100", async () => {
      const qbMock = {
        orderBy: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      (repo as any).createQueryBuilder = jest.fn().mockReturnValue(qbMock);

      await service.findAll({ pageSize: 9999 });
      expect(qbMock.take).toHaveBeenCalledWith(100);
    });
  });

  describe("exportCsv", () => {
    const makeExportQb = (rows: any[] = []) => ({
      orderBy: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rows),
    });

    it("returns CSV header even when no rows", async () => {
      const qb = makeExportQb([]);
      (repo as any).createQueryBuilder = jest.fn().mockReturnValue(qb);
      const csv = await service.exportCsv({});
      expect(csv).toContain("id,");
      expect(csv).toContain("action");
      expect(csv).toContain("username");
    });

    it("serializes a log row correctly", async () => {
      const row = {
        id: "abc",
        userId: 1,
        username: "admin",
        action: "task.create",
        resource: "task",
        resourceId: "t-1",
        ip: "127.0.0.1",
        result: "success",
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
      };
      const qb = makeExportQb([row]);
      (repo as any).createQueryBuilder = jest.fn().mockReturnValue(qb);
      const csv = await service.exportCsv({});
      expect(csv).toContain("task.create");
      expect(csv).toContain("admin");
      expect(csv).toContain("2024-01-01");
    });

    it("escapes values containing commas", async () => {
      const row = {
        id: "1",
        userId: 1,
        username: "admin,evil",
        action: "test",
        resource: "task",
        resourceId: "t-1",
        ip: "127.0.0.1",
        result: "success",
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
      };
      const qb = makeExportQb([row]);
      (repo as any).createQueryBuilder = jest.fn().mockReturnValue(qb);
      const csv = await service.exportCsv({});
      expect(csv).toContain('"admin,evil"');
    });

    it("caps export at 10000 rows via limit()", async () => {
      const qb = makeExportQb([]);
      (repo as any).createQueryBuilder = jest.fn().mockReturnValue(qb);
      await service.exportCsv({});
      expect(qb.limit).toHaveBeenCalledWith(10_000);
    });

    it("applies action filter via andWhere", async () => {
      const qb = makeExportQb([]);
      (repo as any).createQueryBuilder = jest.fn().mockReturnValue(qb);
      await service.exportCsv({ action: "task.create" });
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining("action"),
        expect.objectContaining({
          action: expect.stringContaining("task.create"),
        }),
      );
    });
  });

  describe("log", () => {
    it("should save an audit log entry", async () => {
      await service.log({
        userId: 1,
        username: "admin",
        action: "task.create",
        resource: "task",
        resourceId: "task-1",
        ip: "127.0.0.1",
      });

      expect(repo.create).toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalled();
    });

    it("should default result to success", async () => {
      await service.log({ action: "test" });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ result: "success" }),
      );
    });

    it("should accept failure result", async () => {
      await service.log({ action: "test", result: "failure" });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ result: "failure" }),
      );
    });
  });
});
