import { ForbiddenException } from "@nestjs/common";
import { ProjectsController } from "../projects.controller";
import { DEFAULT_PROJECT_ID } from "../project.entity";
import { UserRole } from "../../users/entities/user.entity";

/**
 * AUTH-02：项目成员端点的 RBAC 姿态与默认项目特例。
 *
 * 写面（任免/改角色/移除）保持 ADMIN-only（RolesGuard 元数据断言），
 * 读面允许成员本人查看所属项目成员；默认项目恒可读（它是「未分配资源」的
 * 归属视图）。
 */
describe("ProjectsController（AUTH-02 成员面）", () => {
  const makeController = () => {
    const service = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };
    const access = {
      listMembers: jest.fn().mockResolvedValue([]),
      addMember: jest.fn(),
      updateMember: jest.fn(),
      removeMember: jest.fn(),
      listRolesForUser: jest.fn().mockResolvedValue([]),
      resolveRole: jest.fn().mockResolvedValue(null),
    };
    const controller = new ProjectsController(
      service as never,
      access as never,
    );
    return { controller, service, access };
  };

  const user = { id: 7, role: UserRole.USER };
  const admin = { id: 1, role: UserRole.ADMIN };

  it("listMembers：ADMIN 可读任意项目", async () => {
    const { controller, access } = makeController();
    await controller.listMembers("p1", admin);
    expect(access.listMembers).toHaveBeenCalledWith("p1");
  });

  it("listMembers：默认项目对普通用户恒可读（未分配资源的归属视图）", async () => {
    const { controller, access } = makeController();
    await controller.listMembers(DEFAULT_PROJECT_ID, user);
    expect(access.listMembers).toHaveBeenCalledWith(DEFAULT_PROJECT_ID);
  });

  it("listMembers：普通用户读非成员项目 → 403", async () => {
    const { controller } = makeController();
    await expect(controller.listMembers("p1", user)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("listMembers：普通用户是该项目成员（任意档）→ 放行", async () => {
    const { controller, access } = makeController();
    access.resolveRole.mockResolvedValue("viewer");
    await controller.listMembers("p1", user);
    expect(access.listMembers).toHaveBeenCalledWith("p1");
  });

  it("addMember/updateMember/removeMember：委托进 ProjectAccessService", async () => {
    const { controller, access } = makeController();
    await controller.addMember("p1", { userId: 8, role: "editor" });
    expect(access.addMember).toHaveBeenCalledWith("p1", 8, "editor");

    await controller.updateMember("p1", 8, { role: "viewer" });
    expect(access.updateMember).toHaveBeenCalledWith("p1", 8, "viewer");

    await controller.removeMember("p1", 8);
    expect(access.removeMember).toHaveBeenCalledWith("p1", 8);
  });

  it("myRoles：ADMIN 标记 + 本人成员关系列表（无主体则空）", async () => {
    const { controller, access } = makeController();
    access.listRolesForUser.mockResolvedValue([
      {
        id: "m1",
        projectId: "p1",
        userId: 7,
        role: "editor",
        createdAt: new Date(),
      },
    ]);

    await expect(controller.myRoles(admin)).resolves.toEqual({
      userId: 1,
      isAdmin: true,
      memberships: expect.any(Array),
    });
    await expect(controller.myRoles(undefined)).resolves.toEqual({
      userId: null,
      isAdmin: false,
      memberships: [],
    });
  });

  // ---------------------------------------------------------------------
  // AUTH-02 后续：项目列表按成员过滤读面（findAll）。
  // ---------------------------------------------------------------------

  const proj = (id: string, name: string) => ({
    id,
    name,
    description: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
  });

  it("findAll：ADMIN 全量可见，且如实标注自己的成员角色", async () => {
    const { controller, service, access } = makeController();
    service.findAll.mockResolvedValue([
      proj(DEFAULT_PROJECT_ID, "Default"),
      proj("p1", "Alpha"),
      proj("p2", "Beta"),
    ]);
    access.listRolesForUser.mockResolvedValue([
      {
        id: "m1",
        projectId: "p1",
        userId: 1,
        role: "viewer",
        createdAt: new Date(),
      },
    ]);

    const rows = await controller.findAll(admin);
    expect(rows.map((r) => r.id)).toEqual([DEFAULT_PROJECT_ID, "p1", "p2"]);
    expect(rows.find((r) => r.id === "p1")?.myRole).toBe("viewer");
    expect(rows.find((r) => r.id === "p2")?.myRole).toBeNull();
  });

  it("findAll：普通用户非成员 → 仅默认项目（myRole null）", async () => {
    const { controller, service, access } = makeController();
    service.findAll.mockResolvedValue([
      proj(DEFAULT_PROJECT_ID, "Default"),
      proj("p1", "Alpha"),
      proj("p2", "Beta"),
    ]);
    access.listRolesForUser.mockResolvedValue([]);

    const rows = await controller.findAll(user);
    expect(rows.map((r) => r.id)).toEqual([DEFAULT_PROJECT_ID]);
    expect(rows[0].myRole).toBeNull();
  });

  it("findAll：普通用户成员 → 默认项目 ∪ 成员项目，成员行 myRole 对应", async () => {
    const { controller, service, access } = makeController();
    service.findAll.mockResolvedValue([
      proj(DEFAULT_PROJECT_ID, "Default"),
      proj("p1", "Alpha"),
      proj("p2", "Beta"),
    ]);
    access.listRolesForUser.mockResolvedValue([
      {
        id: "m2",
        projectId: "p2",
        userId: 7,
        role: "editor",
        createdAt: new Date(),
      },
    ]);

    const rows = await controller.findAll(user);
    expect(rows.map((r) => r.id)).toEqual([DEFAULT_PROJECT_ID, "p2"]);
    expect(rows.find((r) => r.id === "p2")?.myRole).toBe("editor");
    expect(rows.find((r) => r.id === DEFAULT_PROJECT_ID)?.myRole).toBeNull();
  });

  it("findAll：无主体（JWT 缺失的极端形态）→ 按非成员过滤兜底", async () => {
    const { controller, service } = makeController();
    service.findAll.mockResolvedValue([
      proj(DEFAULT_PROJECT_ID, "Default"),
      proj("p1", "Alpha"),
    ]);

    const rows = await controller.findAll(undefined);
    expect(rows.map((r) => r.id)).toEqual([DEFAULT_PROJECT_ID]);
  });
});
