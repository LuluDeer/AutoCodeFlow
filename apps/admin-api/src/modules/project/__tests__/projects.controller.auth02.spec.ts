import { ForbiddenException } from "@nestjs/common";
import { ProjectsController } from "../projects.controller";
import { DEFAULT_PROJECT_ID } from "../project.entity";
import { UserRole } from "../../users/entities/user.entity";
import { AuditService } from "../../audit/audit.service";
import type { ProjectViewRow } from "../project.dto";

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
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const controller = new ProjectsController(
      service as never,
      access as never,
      audit as unknown as AuditService,
    );
    return { controller, service, access, audit };
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
    const actor = { id: 7, username: "admin", role: UserRole.ADMIN };
    const req = { ip: "127.0.0.1" } as never;

    await controller.addMember("p1", { userId: 8, role: "editor" }, actor, req);
    expect(access.addMember).toHaveBeenCalledWith("p1", 8, "editor");

    await controller.updateMember("p1", 8, { role: "viewer" }, actor, req);
    expect(access.updateMember).toHaveBeenCalledWith("p1", 8, "viewer");

    await controller.removeMember("p1", 8, actor, req);
    expect(access.removeMember).toHaveBeenCalledWith("p1", 8);
  });

  // ---------------------------------------------------------------------
  // D3-B-P1-1：项目/成员写路由审计落证（红→绿回归）。
  // ---------------------------------------------------------------------
  const actor = { id: 7, username: "admin", role: UserRole.ADMIN };
  const req = { ip: "10.0.0.1" } as never;

  it("create：落证 project.create（含 resourceId=新建项目 id）", async () => {
    const { controller, service, audit } = makeController();
    service.create.mockResolvedValue({ id: "new-p", name: "X" });
    await controller.create({ name: "X" } as never, actor, req);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 7,
        username: "admin",
        action: "project.create",
        resource: "project",
        resourceId: "new-p",
        ip: "10.0.0.1",
      }),
    );
  });

  it("update：落证 project.update", async () => {
    const { controller, service, audit } = makeController();
    service.update.mockResolvedValue({ id: "p1", name: "X" });
    await controller.update("p1", { name: "Y" } as never, actor, req);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "project.update",
        resource: "project",
        resourceId: "p1",
      }),
    );
  });

  it("remove：落证 project.delete", async () => {
    const { controller, service, audit } = makeController();
    service.remove.mockResolvedValue({ deleted: true });
    await controller.remove("p1", actor, req);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "project.delete",
        resource: "project",
        resourceId: "p1",
      }),
    );
  });

  it("addMember/updateMember/removeMember：落证 member.grant/update/revoke", async () => {
    const { controller, access, audit } = makeController();
    access.addMember.mockResolvedValue({});
    access.updateMember.mockResolvedValue({});
    access.removeMember.mockResolvedValue({ deleted: true });

    await controller.addMember("p1", { userId: 8, role: "editor" }, actor, req);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.grant",
        resource: "project_member",
        resourceId: "p1",
        detail: expect.objectContaining({ targetUserId: 8, role: "editor" }),
      }),
    );

    await controller.updateMember("p1", 8, { role: "viewer" }, actor, req);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.update",
        detail: expect.objectContaining({ targetUserId: 8, role: "viewer" }),
      }),
    );

    await controller.removeMember("p1", 8, actor, req);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.revoke",
        detail: expect.objectContaining({ targetUserId: 8 }),
      }),
    );
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

    const rows = (await controller.findAll(admin)) as ProjectViewRow[];
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

    const rows = (await controller.findAll(user)) as ProjectViewRow[];
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

    const rows = (await controller.findAll(user)) as ProjectViewRow[];
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

    const rows = (await controller.findAll(undefined)) as ProjectViewRow[];
    expect(rows.map((r) => r.id)).toEqual([DEFAULT_PROJECT_ID]);
  });

  // ---------------------------------------------------------------------
  // R3：可选服务端分页（向后兼容双形态）。
  // ---------------------------------------------------------------------

  it("findAll：不传 page/pageSize → 全量数组（旧契约，acf-cli/mcp-server/项目选择器零改动）", async () => {
    const { controller, service } = makeController();
    service.findAll.mockResolvedValue([
      proj(DEFAULT_PROJECT_ID, "Default"),
      proj("p1", "Alpha"),
    ]);

    const rows = await controller.findAll(admin);
    expect(Array.isArray(rows)).toBe(true);
    expect((rows as ProjectViewRow[]).map((r) => r.id)).toEqual([
      DEFAULT_PROJECT_ID,
      "p1",
    ]);
  });

  it("findAll：传 page/pageSize → 分页信封（切片在可见集上，total=该主体可见总数）", async () => {
    const { controller, service, access } = makeController();
    service.findAll.mockResolvedValue([
      proj(DEFAULT_PROJECT_ID, "Default"),
      proj("p1", "Alpha"),
      proj("p2", "Beta"),
    ]);
    // 普通用户只可见 Default ∪ p2——分页必须作用在**可见集**上，
    // total 若数上不可见项目，分页器就会数出别的租户的项目。
    access.listRolesForUser.mockResolvedValue([
      {
        id: "m2",
        projectId: "p2",
        userId: 7,
        role: "editor",
        createdAt: new Date(),
      },
    ]);

    const page1 = (await controller.findAll(user, "1", "1")) as {
      list: ProjectViewRow[];
      items: ProjectViewRow[];
      total: number;
      page: number;
      pageSize: number;
      totalPages: number;
    };
    expect(page1.items.map((r) => r.id)).toEqual([DEFAULT_PROJECT_ID]);
    expect(page1.list).toEqual(page1.items);
    expect(page1.total).toBe(2);
    expect(page1.page).toBe(1);
    expect(page1.pageSize).toBe(1);
    expect(page1.totalPages).toBe(2);

    const page2 = (await controller.findAll(user, "2", "1")) as {
      items: ProjectViewRow[];
    };
    expect(page2.items.map((r) => r.id)).toEqual(["p2"]);
    expect(page2.items[0].myRole).toBe("editor");
  });

  it("findAll：pageSize 超上限钳制到 100、page 超上限钳制到 10000（对齐 PageQueryDto 纪律）", async () => {
    const { controller, service } = makeController();
    service.findAll.mockResolvedValue([proj(DEFAULT_PROJECT_ID, "Default")]);

    const out = (await controller.findAll(admin, "3", "500")) as {
      page: number;
      pageSize: number;
      items: ProjectViewRow[];
    };
    expect(out.page).toBe(3);
    expect(out.pageSize).toBe(100);
    // 越界页在内存切片下安全返回空页（不会 500）
    expect(out.items).toEqual([]);
  });

  it("findAll：非法分页参数（NaN/负数/非整数/空串）视同未传 → 维持旧全量数组契约", async () => {
    const { controller, service } = makeController();
    service.findAll.mockResolvedValue([
      proj(DEFAULT_PROJECT_ID, "Default"),
      proj("p1", "Alpha"),
    ]);

    for (const evil of ["abc", "-1", "2.5", "0", ""]) {
      const rows = await controller.findAll(admin, evil, evil);
      expect(Array.isArray(rows)).toBe(true);
    }
    // 一个合法一个非法：合法者生效、非法者回落缺省（信封形态）
    const mixed = (await controller.findAll(admin, "abc", "1")) as {
      page: number;
      pageSize: number;
    };
    expect(mixed.page).toBe(1);
    expect(mixed.pageSize).toBe(1);
  });
});
