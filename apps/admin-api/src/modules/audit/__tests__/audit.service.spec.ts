import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
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
        // SEC-10: AuditService 新增 DataSource 依赖（retention 清理的
        // append-only bypass 事务）——本套件不触发清理路径，给桩即可。
        { provide: DataSource, useValue: { transaction: jest.fn() } },
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

    // API-09（本轮体验审查）：这两条原断言「含特殊字符的 action 一律 400」。
    // 那条白名单被**有意**放宽了，理由如下（安全性反而更强，不是削弱）：
    //   · 注入风险从来不由白名单承担——`action` 一直是**绑定参数**
    //     （`log.action ILIKE :action`），值从不拼进 SQL。旧白名单对安全
    //     没有增量，只是"看起来更安全"。
    //   · 它只剩副作用：用户想按中文、`:`、`/` 这类正常词搜索时直接吃 400 +
    //     英文技术报错，而期待的是"没有匹配"或结果列表。
    //   · 真正需要处理的是 LIKE **元字符**（`%` / `_`）——旧实现把这个漏了：
    //     `username` 分支根本没白名单，搜 `zhang_san` 会命中 `zhangXsan`。
    // 现改为「只限长度 + 转义 LIKE 元字符」，两条路径（findAll/exportCsv）
    // 同一判据。故此处断言从「必须 400」改为「必须被转义后当字面量绑定」。
    it("API-09: action 含特殊字符时不再 400，而是转义后按字面量绑定", async () => {
      const qbMock = {
        orderBy: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      (repo as any).createQueryBuilder = jest.fn().mockReturnValue(qbMock);

      await service.findAll({ action: "inject'xss" });

      // 值仍然走绑定参数（无字符串拼接），且原文按字面量传入
      expect(qbMock.andWhere).toHaveBeenCalledWith("log.action ILIKE :action", {
        action: "%inject'xss%",
      });
    });

    it("API-09: action 里的 LIKE 元字符被转义（%) 与 _ 按字面量匹配）", async () => {
      const qbMock = {
        orderBy: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      (repo as any).createQueryBuilder = jest.fn().mockReturnValue(qbMock);

      await service.findAll({ action: "100%_done" });

      expect(qbMock.andWhere).toHaveBeenCalledWith("log.action ILIKE :action", {
        action: "%100\\%\\_done%",
      });
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

    // AUTH-05: (resource, resourceId) pair filter — scoped-down replacement
    // for the planned per-Project dimension (no Project entity exists yet).
    it("AUTH-05: applies exact resourceId filter", async () => {
      const qbMock = {
        orderBy: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      (repo as any).createQueryBuilder = jest.fn().mockReturnValue(qbMock);

      await service.findAll({ resourceId: "task-abc-123" });
      expect(qbMock.andWhere).toHaveBeenCalledWith(
        "log.resourceId = :resourceId",
        {
          resourceId: "task-abc-123",
        },
      );
    });

    it("AUTH-05: applies resource + resourceId as a combined pair filter", async () => {
      const qbMock = {
        orderBy: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      (repo as any).createQueryBuilder = jest.fn().mockReturnValue(qbMock);

      await service.findAll({ resource: "executor", resourceId: "e-1" });
      expect(qbMock.andWhere).toHaveBeenCalledWith("log.resource = :resource", {
        resource: "executor",
      });
      expect(qbMock.andWhere).toHaveBeenCalledWith(
        "log.resourceId = :resourceId",
        {
          resourceId: "e-1",
        },
      );
    });

    it("AUTH-05: caps an oversized resourceId needle at 100 chars", async () => {
      const qbMock = {
        orderBy: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      (repo as any).createQueryBuilder = jest.fn().mockReturnValue(qbMock);

      await service.findAll({ resourceId: "x".repeat(500) });
      expect(qbMock.andWhere).toHaveBeenCalledWith(
        "log.resourceId = :resourceId",
        {
          resourceId: "x".repeat(100),
        },
      );
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

    // S8: cells starting with = + - @ tab CR are interpreted as formulas by
    // Excel/Sheets when the CSV is opened — each must be neutralized with a
    // leading apostrophe.
    it.each([
      ["username", "=cmd()"],
      ["action", "+task.create"],
      ["resource", "@ATTACK"],
      ["resourceId", "-task-1"],
      ["result", "\tsuccess"],
      ["ip", "\r127.0.0.1"],
    ])(
      "S8: neutralizes a %s cell starting with a formula character",
      async (field, value) => {
        const row = {
          id: "1",
          userId: 1,
          username: "admin",
          action: "task.create",
          resource: "task",
          resourceId: "t-1",
          ip: "127.0.0.1",
          result: "success",
          createdAt: new Date("2024-01-01T00:00:00.000Z"),
          [field]: value,
        };
        const qb = makeExportQb([row]);
        (repo as any).createQueryBuilder = jest.fn().mockReturnValue(qb);
        const csv = await service.exportCsv({});
        expect(csv).toContain(`'${value}`);
        // the raw, un-prefixed payload must not appear at a cell start
        expect(csv).not.toContain(`,${value}`);
      },
    );

    it("S8: a combined formula payload is still RFC4180-quoted on top of the prefix", async () => {
      const row = {
        id: "1",
        userId: 1,
        username: "=cmd(),'x",
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
      expect(csv).toContain("\"'=cmd(),'x\"");
    });

    it("S8: leaves benign cells untouched", async () => {
      const row = {
        id: "1",
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
      expect(csv).toContain("admin");
      expect(csv).toContain("task.create");
    });

    // API-09：exportCsv 与 findAll 共用同一过滤判据（R4 P1-2 的 parity 要求）。
    // 同 findAll 的两条：白名单放宽为「只限长度 + 转义 LIKE 元字符」，
    // 故此处断言从「必须 400」改为「转义后按字面量绑定」——两条路径必须同款。
    it("API-09: exportCsv 与 findAll 同款——特殊字符不再 400，转义后字面量绑定", async () => {
      const qb = makeExportQb([]);
      (repo as any).createQueryBuilder = jest.fn().mockReturnValue(qb);
      await service.exportCsv({ action: "bad<script>" });
      expect(qb.andWhere).toHaveBeenCalledWith("log.action ILIKE :action", {
        action: "%bad<script>%",
      });
    });

    it("API-09: exportCsv 同样转义 LIKE 元字符", async () => {
      const qb = makeExportQb([]);
      (repo as any).createQueryBuilder = jest.fn().mockReturnValue(qb);
      await service.exportCsv({ action: "a_b%c" });
      expect(qb.andWhere).toHaveBeenCalledWith("log.action ILIKE :action", {
        action: "%a\\_b\\%c%",
      });
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

    // AUTH-05: the CSV export must honour the identical filter set as the
    // list endpoint (R4 P1-2 parity extended with the resourceId pair).
    it("AUTH-05: exportCsv applies the same resource/resourceId pair filter", async () => {
      const qb = makeExportQb([]);
      (repo as any).createQueryBuilder = jest.fn().mockReturnValue(qb);
      await service.exportCsv({ resource: "executor", resourceId: "e-9" });
      expect(qb.andWhere).toHaveBeenCalledWith("log.resource = :resource", {
        resource: "executor",
      });
      expect(qb.andWhere).toHaveBeenCalledWith("log.resourceId = :resourceId", {
        resourceId: "e-9",
      });
    });

    it("AUTH-05: exportCsv caps an oversized resourceId needle at 100 chars", async () => {
      const qb = makeExportQb([]);
      (repo as any).createQueryBuilder = jest.fn().mockReturnValue(qb);
      await service.exportCsv({ resourceId: "y".repeat(300) });
      expect(qb.andWhere).toHaveBeenCalledWith("log.resourceId = :resourceId", {
        resourceId: "y".repeat(100),
      });
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
