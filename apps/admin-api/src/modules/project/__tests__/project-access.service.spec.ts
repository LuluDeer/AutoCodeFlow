import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ProjectAccessService } from "../project-access.service";
import { PROJECT_ROLE_RANK } from "../entities/project-member.entity";
import { DEFAULT_PROJECT_ID } from "../project.entity";

/**
 * AUTH-02（项目级角色细化）：ProjectAccessService 单元矩阵。
 *
 * 覆盖：角色判定（档位比较）、非成员/无主体、查询失败 fail-open（按非成员 +
 * warn，不抛给业务面）、CRUD 与角色校验、未分配 projectId → 默认项目。
 */
describe("ProjectAccessService（AUTH-02）", () => {
  const makeService = (overrides: Partial<Record<string, jest.Mock>> = {}) => {
    const repo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((x) => x),
      save: jest.fn(async (x) => ({ id: "m1", createdAt: new Date(), ...x })),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      ...overrides,
    };
    const svc = new ProjectAccessService(repo as never);
    return { svc, repo };
  };

  describe("resolveRole / hasProjectRole", () => {
    it("成员行存在 → 返回该角色；未分配 projectId 按默认项目查询", async () => {
      const { svc, repo } = makeService();
      repo.findOne.mockResolvedValue({ role: "editor" });

      await expect(svc.resolveRole(7, null)).resolves.toBe("editor");
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { projectId: DEFAULT_PROJECT_ID, userId: 7 },
      });
    });

    it("无成员行 / 无主体 → null", async () => {
      const { svc } = makeService();
      await expect(svc.resolveRole(7, "p1")).resolves.toBeNull();
      await expect(svc.resolveRole(null, "p1")).resolves.toBeNull();
      await expect(svc.resolveRole(undefined, "p1")).resolves.toBeNull();
    });

    it("档位比较：viewer < editor < admin（hasProjectRole 至少某档）", async () => {
      const ranks = PROJECT_ROLE_RANK;
      expect(ranks.viewer).toBeLessThan(ranks.editor);
      expect(ranks.editor).toBeLessThan(ranks.admin);

      const { svc, repo } = makeService();
      repo.findOne.mockResolvedValue({ role: "viewer" });
      await expect(svc.hasProjectRole(7, "p1", "viewer")).resolves.toBe(true);
      await expect(svc.hasProjectRole(7, "p1", "editor")).resolves.toBe(false);

      repo.findOne.mockResolvedValue({ role: "admin" });
      await expect(svc.hasProjectRole(7, "p1", "editor")).resolves.toBe(true);
      await expect(svc.hasProjectRole(7, "p1", "admin")).resolves.toBe(true);
    });

    it("DB 抖动 → fail-open 按非成员处理并 warn（不让权限服务抖动打断业务写面）", async () => {
      const { svc } = makeService({
        findOne: jest.fn().mockRejectedValue(new Error("connection reset")),
      });
      const warnSpy = jest
        .spyOn(
          (svc as unknown as { logger: { warn: jest.Mock } }).logger,
          "warn",
        )
        .mockImplementation(() => {});

      await expect(svc.hasProjectRole(7, "p1", "viewer")).resolves.toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("resolveRole failed"),
      );
      warnSpy.mockRestore();
    });

    it("列非法角色（脏数据）→ hasProjectRole 返回 false（不误放行）", async () => {
      const { svc, repo } = makeService();
      repo.findOne.mockResolvedValue({ role: "superuser" });
      await expect(svc.hasProjectRole(7, "p1", "viewer")).resolves.toBe(false);
    });
  });

  describe("成员管理", () => {
    it("addMember：已存在则改角色（upsert 语义，不产生重复行）", async () => {
      const { svc, repo } = makeService();
      repo.findOne.mockResolvedValue({
        id: "m1",
        projectId: "p1",
        userId: 7,
        role: "viewer",
      });

      const view = await svc.addMember("p1", 7, "editor");

      expect(view.role).toBe("editor");
      expect(repo.create).not.toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: "m1", role: "editor" }),
      );
    });

    it("addMember：不存在则新建", async () => {
      const { svc, repo } = makeService();
      await svc.addMember("p1", 8, "viewer");
      expect(repo.create).toHaveBeenCalledWith({
        projectId: "p1",
        userId: 8,
        role: "viewer",
      });
    });

    it("非法角色 → 400（DTO 之外的第二道闸，防 service 被内部调用绕过）", async () => {
      const { svc } = makeService();
      await expect(
        svc.addMember("p1", 7, "root" as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.updateMember("p1", 7, "" as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("updateMember：成员不存在 → 404（不静默创建）", async () => {
      const { svc } = makeService();
      await expect(svc.updateMember("p1", 7, "admin")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("removeMember：按 (projectId, userId) 精确删除（行存在时）", async () => {
      const { svc, repo } = makeService();
      repo.findOne.mockResolvedValue({
        id: "m1",
        projectId: "p1",
        userId: 7,
        role: "viewer",
      });
      await expect(svc.removeMember("p1", 7)).resolves.toEqual({
        deleted: true,
      });
      expect(repo.delete).toHaveBeenCalledWith({ projectId: "p1", userId: 7 });
    });

    /**
     * PROJECT-MEMBER-404：行不存在 → 404，而不是「删 0 行 + 200」。
     *
     * 旧行为会让前端 MembersDrawer 弹出一条假成功（它的成功回调不看返回值），
     * 并发场景下用户以为移除了、回列表才发现人还在（或早就没了）。本用例与
     * 上面 updateMember 的 404 用例成对，钉住「同一服务对『行不存在』给同一结论」。
     */
    it("removeMember：成员不存在 → 404（与 updateMember 同口径，不静默 200）", async () => {
      const { svc, repo } = makeService();
      repo.findOne.mockResolvedValue(null);
      await expect(svc.removeMember("p1", 7)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      // 关键：没找到行就不该发 DELETE（否则又是一次「看起来做了什么」）
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it("listRolesForUser：查询失败返回空数组（读面不因权限表抖动 500）", async () => {
      const { svc } = makeService({
        find: jest.fn().mockRejectedValue(new Error("boom")),
      });
      const warnSpy = jest
        .spyOn(
          (svc as unknown as { logger: { warn: jest.Mock } }).logger,
          "warn",
        )
        .mockImplementation(() => {});
      await expect(svc.listRolesForUser(7)).resolves.toEqual([]);
      warnSpy.mockRestore();
    });

    it("listMembers：按 createdAt 升序返回视图对象（不含实体内部字段）", async () => {
      const { svc, repo } = makeService();
      repo.find.mockResolvedValue([
        {
          id: "m1",
          projectId: "p1",
          userId: 7,
          role: "admin",
          createdAt: new Date(1),
        },
      ]);
      const rows = await svc.listMembers("p1");
      expect(rows).toEqual([
        {
          id: "m1",
          projectId: "p1",
          userId: 7,
          role: "admin",
          createdAt: new Date(1),
        },
      ]);
    });
  });
});
