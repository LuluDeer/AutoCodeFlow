import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { NotFoundException, BadRequestException } from "@nestjs/common";
import { SystemConfigService } from "../config.service";
import { SystemConfig } from "../entities/system-config.entity";
import { ConfigHistory } from "../entities/config-history.entity";

const mockRepo = () => ({
  find: jest.fn(),
  findOneBy: jest.fn(),
  upsert: jest.fn(),
  remove: jest.fn(),
  save: jest.fn(),
  create: jest.fn(),
  createQueryBuilder: jest.fn(),
});

const mockHistoryRepo = () => ({
  findOneBy: jest.fn(),
  save: jest.fn(),
  create: jest.fn(),
  createQueryBuilder: jest.fn(),
});

describe("SystemConfigService", () => {
  let service: SystemConfigService;
  let repo: ReturnType<typeof mockRepo>;
  let historyRepo: ReturnType<typeof mockHistoryRepo>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SystemConfigService,
        { provide: getRepositoryToken(SystemConfig), useFactory: mockRepo },
        {
          provide: getRepositoryToken(ConfigHistory),
          useFactory: mockHistoryRepo,
        },
      ],
    }).compile();

    service = module.get<SystemConfigService>(SystemConfigService);
    repo = module.get(getRepositoryToken(SystemConfig));
    historyRepo = module.get(getRepositoryToken(ConfigHistory));
  });

  describe("findAll", () => {
    it("should return all configs ordered by key", async () => {
      const configs = [{ key: "a" }, { key: "b" }] as SystemConfig[];
      repo.find.mockResolvedValue(configs);
      const result = await service.findAll();
      expect(repo.find).toHaveBeenCalledWith({ order: { key: "ASC" } });
      expect(result).toEqual(configs);
    });
  });

  describe("findOne", () => {
    it("should return config when key exists", async () => {
      const config = { key: "myKey", value: "myVal" } as SystemConfig;
      repo.findOneBy.mockResolvedValue(config);
      const result = await service.findOne("myKey");
      expect(result).toEqual(config);
    });

    it("should throw NotFoundException when key does not exist", async () => {
      repo.findOneBy.mockResolvedValue(null);
      await expect(service.findOne("missing")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("upsert", () => {
    const baseDto = {
      key: "k1",
      value: "v1",
      valueType: "string",
      isSecret: false,
    };

    beforeEach(() => {
      repo.findOneBy.mockResolvedValue(null);
      repo.upsert.mockResolvedValue(undefined);
      historyRepo.create.mockImplementation((d) => d);
      historyRepo.save.mockResolvedValue({});
      repo.findOneBy
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ key: "k1", value: "v1" } as SystemConfig);
    });

    it("should create a config and record history", async () => {
      const result = await service.upsert(baseDto);
      expect(repo.upsert).toHaveBeenCalled();
      expect(historyRepo.save).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("should throw BadRequestException for invalid valueType", async () => {
      await expect(
        service.upsert({ key: "k", value: "v", valueType: "invalid" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException for invalid JSON value", async () => {
      await expect(
        service.upsert({ key: "k", value: "not-json", valueType: "json" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException for invalid boolean value", async () => {
      await expect(
        service.upsert({ key: "k", value: "yes", valueType: "boolean" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException for invalid number value", async () => {
      await expect(
        service.upsert({ key: "k", value: "abc", valueType: "number" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should accept valid JSON value", async () => {
      repo.findOneBy.mockResolvedValue(null);
      repo.upsert.mockResolvedValue(undefined);
      historyRepo.create.mockImplementation((d) => d);
      historyRepo.save.mockResolvedValue({});
      repo.findOneBy
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ key: "k", value: '{"a":1}' } as SystemConfig);
      await expect(
        service.upsert({ key: "k", value: '{"a":1}', valueType: "json" }),
      ).resolves.toBeDefined();
    });

    // S3: a '***' masked echo on an isSecret item means "unchanged" — the
    // stored secret must survive the admin-web edit round-trip instead of
    // being clobbered with the mask (e.g. executor.sharedToken).
    it("S3: keeps the stored value when an isSecret item is saved with the '***' sentinel", async () => {
      repo.findOneBy.mockReset();
      repo.findOneBy
        .mockResolvedValueOnce({
          key: "executor.sharedToken",
          value: "real-secret",
          isSecret: true,
        } as SystemConfig)
        .mockResolvedValueOnce({
          key: "executor.sharedToken",
          value: "real-secret",
          isSecret: true,
        } as SystemConfig);
      repo.upsert.mockResolvedValue(undefined);

      const result = await service.upsert({
        key: "executor.sharedToken",
        value: "***",
        valueType: "string",
        isSecret: true,
      });

      expect(repo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "executor.sharedToken",
          value: "real-secret",
        }),
        expect.anything(),
      );
      // history must record the preserved value as newValue too
      expect(historyRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          oldValue: "real-secret",
          newValue: "real-secret",
        }),
      );
      expect(result).toBeDefined();
    });

    it("S3: overwrites with the real new value when a secret is actually changed", async () => {
      repo.findOneBy.mockReset();
      repo.findOneBy
        .mockResolvedValueOnce({
          key: "executor.sharedToken",
          value: "old-secret",
          isSecret: true,
        } as SystemConfig)
        .mockResolvedValueOnce({
          key: "executor.sharedToken",
          value: "new-secret",
          isSecret: true,
        } as SystemConfig);
      repo.upsert.mockResolvedValue(undefined);

      await service.upsert({
        key: "executor.sharedToken",
        value: "new-secret",
        valueType: "string",
        isSecret: true,
      });

      expect(repo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ value: "new-secret" }),
        expect.anything(),
      );
    });

    it("S3: a literal '***' on a non-secret item is stored as-is", async () => {
      repo.findOneBy.mockReset();
      repo.findOneBy.mockResolvedValue(null);
      repo.upsert.mockResolvedValue(undefined);
      historyRepo.create.mockImplementation((d) => d);
      historyRepo.save.mockResolvedValue({});
      repo.findOneBy.mockResolvedValueOnce(null).mockResolvedValueOnce({
        key: "k",
        value: "***",
        isSecret: false,
      } as SystemConfig);

      await service.upsert({
        key: "k",
        value: "***",
        valueType: "string",
        isSecret: false,
      });

      expect(repo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ value: "***" }),
        expect.anything(),
      );
    });

    it("S3: the preserved value still passes valueType validation (json secret survives an edit)", async () => {
      repo.findOneBy.mockReset();
      repo.findOneBy
        .mockResolvedValueOnce({
          key: "k",
          value: '{"a":1}',
          isSecret: true,
        } as SystemConfig)
        .mockResolvedValueOnce({
          key: "k",
          value: '{"a":1}',
          isSecret: true,
        } as SystemConfig);
      repo.upsert.mockResolvedValue(undefined);

      await expect(
        service.upsert({
          key: "k",
          value: "***",
          valueType: "json",
          isSecret: true,
        }),
      ).resolves.toBeDefined();
      expect(repo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ value: '{"a":1}' }),
        expect.anything(),
      );
    });
  });

  describe("remove", () => {
    it("should remove config and return { deleted: true }", async () => {
      const config = { key: "k1", value: "v1" } as SystemConfig;
      repo.findOneBy.mockResolvedValue(config);
      repo.remove.mockResolvedValue(undefined);
      historyRepo.create.mockImplementation((d) => d);
      historyRepo.save.mockResolvedValue({});
      const result = await service.remove("k1");
      expect(result).toEqual({ deleted: true });
      expect(repo.remove).toHaveBeenCalledWith(config);
    });

    it("should throw NotFoundException when key does not exist", async () => {
      repo.findOneBy.mockResolvedValue(null);
      await expect(service.remove("missing")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("rollback", () => {
    // FEAT-08: every rollback writes its own action='rollback' history row
    // (never a masquerading 'update'/'create'), the write goes through the
    // same repo.upsert shape and validateConfig as the normal upsert path,
    // and the mask/no-oldValue/404 edges are explicit.
    it("should throw NotFoundException when history not found", async () => {
      historyRepo.findOneBy.mockResolvedValue(null);
      await expect(service.rollback(999)).rejects.toThrow(NotFoundException);
    });

    it("rolls a non-delete entry back to oldValue via the same upsert write path and records an action='rollback' history", async () => {
      const history = {
        id: 1,
        configKey: "k1",
        oldValue: "old",
        newValue: "new",
        action: "update",
      };
      historyRepo.findOneBy.mockResolvedValue(history);
      repo.findOneBy
        .mockResolvedValueOnce({
          key: "k1",
          value: "new",
          description: "desc-current",
          valueType: "string",
          isSecret: false,
        } as SystemConfig)
        .mockResolvedValueOnce({
          key: "k1",
          value: "old",
        } as SystemConfig);
      repo.upsert.mockResolvedValue(undefined);
      historyRepo.create.mockImplementation((d) => d);
      historyRepo.save.mockResolvedValue({});

      const result = await service.rollback(1, { username: "admin" });

      // same write shape as upsert (validateConfig already passed: "old" is a
      // plain string with the row's current valueType)
      expect(repo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ key: "k1", value: "old" }),
        { conflictPaths: ["key"], skipUpdateIfNoValuesChanged: true },
      );
      // the rollback itself leaves a trace with action='rollback'
      expect(historyRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          configKey: "k1",
          oldValue: "new",
          newValue: "old",
          action: "rollback",
          username: "admin",
        }),
      );
      expect(result).toMatchObject({ key: "k1", value: "old" });
    });

    it("rejects with BadRequestException when a secret key's history only holds the '***' mask (S3 rollback mirror)", async () => {
      const history = {
        id: 2,
        configKey: "executor.sharedToken",
        oldValue: "***",
        action: "update",
      };
      historyRepo.findOneBy.mockResolvedValue(history);
      repo.findOneBy.mockResolvedValueOnce({
        key: "executor.sharedToken",
        value: "real-secret",
        isSecret: true,
      } as SystemConfig);

      await expect(service.rollback(2)).rejects.toThrow(BadRequestException);
      // the mask must never reach the real config store
      expect(repo.upsert).not.toHaveBeenCalled();
      expect(historyRepo.save).not.toHaveBeenCalled();
    });

    it("a '***' oldValue on a NON-secret key is a literal value and rolls back fine", async () => {
      const history = {
        id: 3,
        configKey: "k",
        oldValue: "***",
        action: "update",
      };
      historyRepo.findOneBy.mockResolvedValue(history);
      repo.findOneBy
        .mockResolvedValueOnce({
          key: "k",
          value: "x",
          isSecret: false,
          valueType: "string",
        } as SystemConfig)
        .mockResolvedValueOnce({ key: "k", value: "***" } as SystemConfig);
      repo.upsert.mockResolvedValue(undefined);
      historyRepo.create.mockImplementation((d) => d);
      historyRepo.save.mockResolvedValue({});

      await expect(service.rollback(3)).resolves.toBeDefined();
      expect(repo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ value: "***" }),
        expect.anything(),
      );
    });

    it("throws BadRequestException for an update entry with empty oldValue (no rollback value)", async () => {
      const history = {
        id: 4,
        configKey: "k1",
        oldValue: null,
        action: "update",
      };
      historyRepo.findOneBy.mockResolvedValue(history);

      await expect(service.rollback(4)).rejects.toThrow(BadRequestException);
      expect(repo.upsert).not.toHaveBeenCalled();
    });

    it("a create entry rolls back to deletion (oldValue is null by definition)", async () => {
      const history = {
        id: 5,
        configKey: "k-new",
        oldValue: null,
        action: "create",
      };
      historyRepo.findOneBy.mockResolvedValue(history);
      const existing = {
        key: "k-new",
        value: "v",
        description: "d",
      } as SystemConfig;
      repo.findOneBy.mockResolvedValue(existing);
      repo.remove.mockResolvedValue(undefined);
      historyRepo.create.mockImplementation((d) => d);
      historyRepo.save.mockResolvedValue({});

      const result = await service.rollback(5);

      expect(result).toEqual({ deleted: true });
      expect(historyRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          configKey: "k-new",
          oldValue: "v",
          newValue: null,
          action: "rollback",
        }),
      );
      expect(repo.remove).toHaveBeenCalledWith(existing);
      expect(repo.upsert).not.toHaveBeenCalled();
    });

    it("a create entry for an already-deleted key is idempotent (no history written)", async () => {
      const history = {
        id: 6,
        configKey: "k-gone",
        oldValue: null,
        action: "create",
      };
      historyRepo.findOneBy.mockResolvedValue(history);
      repo.findOneBy.mockResolvedValue(null);
      repo.remove.mockResolvedValue(undefined);

      const result = await service.rollback(6);

      expect(result).toEqual({ deleted: true });
      expect(repo.remove).not.toHaveBeenCalled();
      expect(historyRepo.save).not.toHaveBeenCalled();
    });

    it("a delete entry restores the recorded oldValue (and its description when the row is gone)", async () => {
      const history = {
        id: 7,
        configKey: "k-del",
        oldValue: "restored",
        description: "orig-desc",
        action: "delete",
      };
      historyRepo.findOneBy.mockResolvedValue(history);
      repo.findOneBy.mockResolvedValueOnce(null).mockResolvedValueOnce({
        key: "k-del",
        value: "restored",
      } as SystemConfig);
      repo.upsert.mockResolvedValue(undefined);
      historyRepo.create.mockImplementation((d) => d);
      historyRepo.save.mockResolvedValue({});

      await service.rollback(7);

      expect(repo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "k-del",
          value: "restored",
          description: "orig-desc",
          valueType: "string",
          isSecret: false,
        }),
        expect.anything(),
      );
    });

    it("a delete entry whose recorded value is null restores an empty-value row (400 path is for update entries only)", async () => {
      const history = {
        id: 8,
        configKey: "k-null",
        oldValue: null,
        action: "delete",
      };
      historyRepo.findOneBy.mockResolvedValue(history);
      repo.findOneBy.mockResolvedValueOnce(null).mockResolvedValueOnce({
        key: "k-null",
        value: null,
      } as SystemConfig);
      repo.upsert.mockResolvedValue(undefined);
      historyRepo.create.mockImplementation((d) => d);
      historyRepo.save.mockResolvedValue({});

      await expect(service.rollback(8)).resolves.toBeDefined();
      expect(repo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ value: null }),
        expect.anything(),
      );
    });

    it("an invalid restored value still passes validateConfig (json entry)", async () => {
      const history = {
        id: 9,
        configKey: "k-json",
        oldValue: "not-json",
        action: "update",
      };
      historyRepo.findOneBy.mockResolvedValue(history);
      repo.findOneBy.mockResolvedValueOnce({
        key: "k-json",
        value: '{"a":1}',
        valueType: "json",
      } as SystemConfig);

      await expect(service.rollback(9)).rejects.toThrow(BadRequestException);
      expect(repo.upsert).not.toHaveBeenCalled();
      expect(historyRepo.save).not.toHaveBeenCalled();
    });
  });

  describe("getHistory", () => {
    it("should return paginated history", async () => {
      const data = [{ id: 1 }] as ConfigHistory[];
      const qb = {
        orderBy: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([data, 1]),
      };
      historyRepo.createQueryBuilder.mockReturnValue(qb);
      const result = await service.getHistory(undefined, 1, 20);
      expect(result.total).toBe(1);
      expect(result.data).toEqual(data);
    });

    it("should filter by key when provided", async () => {
      const data = [{ id: 2 }] as ConfigHistory[];
      const qb = {
        orderBy: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([data, 1]),
      };
      historyRepo.createQueryBuilder.mockReturnValue(qb);
      const result = await service.getHistory("myKey", 1, 10);
      expect(qb.where).toHaveBeenCalledWith("h.configKey = :key", {
        key: "myKey",
      });
      expect(result.data).toEqual(data);
    });
  });

  describe("getByPrefix", () => {
    it("should query configs by prefix", async () => {
      const configs = [{ key: "app.name" }] as SystemConfig[];
      const qb = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(configs),
      };
      repo.createQueryBuilder.mockReturnValue(qb);
      const result = await service.getByPrefix("app.");
      expect(qb.where).toHaveBeenCalledWith("c.key LIKE :prefix", {
        prefix: "app.%",
      });
      expect(result).toEqual(configs);
    });
  });

  describe("getByTag", () => {
    it("should query configs by tag pattern", async () => {
      const configs = [{ key: "k1" }] as SystemConfig[];
      const qb = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(configs),
      };
      repo.createQueryBuilder.mockReturnValue(qb);
      const result = await service.getByTag("mytag");
      expect(qb.where).toHaveBeenCalled();
      expect(result).toEqual(configs);
    });
  });

  describe("validateConfig", () => {
    it("should pass for valid string type", async () => {
      await expect(
        service.validateConfig({ key: "k", value: "any", valueType: "string" }),
      ).resolves.toBeUndefined();
    });

    it("should pass for valid boolean true", async () => {
      await expect(
        service.validateConfig({
          key: "k",
          value: "true",
          valueType: "boolean",
        }),
      ).resolves.toBeUndefined();
    });

    it("should pass for valid number", async () => {
      await expect(
        service.validateConfig({ key: "k", value: "42", valueType: "number" }),
      ).resolves.toBeUndefined();
    });
  });

  describe("batchUpsert", () => {
    it("should upsert each item and return results", async () => {
      repo.findOneBy.mockResolvedValue(null);
      repo.upsert.mockResolvedValue(undefined);
      historyRepo.create.mockImplementation((d) => d);
      historyRepo.save.mockResolvedValue({});
      repo.findOneBy
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ key: "k1", value: "v1" } as SystemConfig)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ key: "k2", value: "v2" } as SystemConfig);
      const items = [
        { key: "k1", value: "v1" },
        { key: "k2", value: "v2" },
      ];
      const result = await service.batchUpsert(items);
      expect(result).toHaveLength(2);
    });
  });
});
