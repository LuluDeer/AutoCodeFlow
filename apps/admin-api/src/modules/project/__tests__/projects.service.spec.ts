import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { NotFoundException } from "@nestjs/common";
import { ProjectsService } from "../projects.service";
import { Project, DEFAULT_PROJECT_ID } from "../project.entity";

/**
 * AUTH-01: ProjectsService 单测——CRUD + 默认项目删除/改名拦截。
 * 仓库桩与 task.service.spec 的 makeRepo 同形态（轻量 jest.fn 表）。
 */
describe("ProjectsService（AUTH-01）", () => {
  let service: ProjectsService;
  let repo: Record<string, jest.Mock>;

  const makeRow = (over: Partial<Project> = {}): Project =>
    ({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Proj A",
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    }) as Project;

  beforeEach(async () => {
    repo = {
      create: jest.fn((d) => d),
      save: jest.fn(async (e) => e),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const module = await Test.createTestingModule({
      providers: [
        ProjectsService,
        { provide: getRepositoryToken(Project), useValue: repo },
      ],
    }).compile();
    service = module.get(ProjectsService);
  });

  describe("create", () => {
    it("落库 name + 可空 description", async () => {
      repo.create.mockImplementation((d) => ({ ...d }));
      const row = await service.create({ name: "P1", description: "d" });
      expect(repo.create).toHaveBeenCalledWith({
        name: "P1",
        description: "d",
      });
      expect(row.name).toBe("P1");
    });

    it("description 缺省归 null", async () => {
      repo.create.mockImplementation((d) => ({ ...d }));
      await service.create({ name: "P1" });
      expect(repo.create).toHaveBeenCalledWith({
        name: "P1",
        description: null,
      });
    });
  });

  describe("findAll / findOne", () => {
    it("findAll 按 createdAt ASC 返回", async () => {
      repo.find.mockResolvedValue([makeRow()]);
      const rows = await service.findAll();
      expect(repo.find).toHaveBeenCalledWith({
        order: { createdAt: "ASC" },
      });
      expect(rows).toHaveLength(1);
    });

    it("findOne 未命中抛 404", async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.findOne("22222222-2222-4222-8222-222222222222"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("update", () => {
    it("正常更新字段", async () => {
      const row = makeRow();
      repo.findOne.mockResolvedValue(row);
      const saved = await service.update(row.id, { name: "Renamed" });
      expect(saved.name).toBe("Renamed");
      expect(repo.save).toHaveBeenCalled();
    });

    it("默认项目拒绝改名（404 拦截，与 remove 同文案）", async () => {
      const row = makeRow({ id: DEFAULT_PROJECT_ID, name: "Default" });
      repo.findOne.mockResolvedValue(row);
      await expect(
        service.update(DEFAULT_PROJECT_ID, { name: "Other" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it("默认项目允许仅改 description（名字未出现）", async () => {
      const row = makeRow({ id: DEFAULT_PROJECT_ID, name: "Default" });
      repo.findOne.mockResolvedValue(row);
      const saved = await service.update(DEFAULT_PROJECT_ID, {
        description: "meta",
      });
      expect(saved.description).toBe("meta");
    });
  });

  describe("remove — 默认项目拦截", () => {
    it("删除默认项目抛 404（回填锚点不可删）", async () => {
      await expect(service.remove(DEFAULT_PROJECT_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it("非默认项目正常删除", async () => {
      const row = makeRow();
      repo.findOne.mockResolvedValue(row);
      const res = await service.remove(row.id);
      expect(repo.delete).toHaveBeenCalledWith(row.id);
      expect(res).toEqual({ deleted: true });
    });

    it("删除不存在的项目抛 404", async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.remove("22222222-2222-4222-8222-222222222222"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
