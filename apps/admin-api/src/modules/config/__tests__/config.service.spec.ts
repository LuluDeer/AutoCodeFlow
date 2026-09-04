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
    it("should throw NotFoundException when history not found", async () => {
      historyRepo.findOneBy.mockResolvedValue(null);
      await expect(service.rollback(999)).rejects.toThrow(NotFoundException);
    });

    it("should call upsert with oldValue for non-delete action", async () => {
      const history = {
        id: 1,
        configKey: "k1",
        oldValue: "old",
        action: "update",
      };
      historyRepo.findOneBy.mockResolvedValue(history);
      // upsert needs its dependencies mocked
      repo.findOneBy.mockResolvedValueOnce({
        key: "k1",
        value: "new",
      } as SystemConfig);
      repo.upsert.mockResolvedValue(undefined);
      historyRepo.create.mockImplementation((d) => d);
      historyRepo.save.mockResolvedValue({});
      repo.findOneBy.mockResolvedValueOnce({
        key: "k1",
        value: "old",
      } as SystemConfig);
      const result = await service.rollback(1);
      expect(result).toBeDefined();
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
