import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ProjectAccessService } from "../project-access.service";
import { PROJECT_ROLE_RANK } from "../entities/project-member.entity";
import { DEFAULT_PROJECT_ID } from "../project.entity";
// R32-A5：装配钉子——@Optional 注入若静默退化为 undefined，存在性校验就形同虚设。
import { ProjectsModule } from "../projects.module";
import { UsersModule } from "../../users/users.module";
import { UsersService } from "../../users/users.service";

/**
 * AUTH-02（项目级角色细化）：ProjectAccessService 单元矩阵。
 *
 * 覆盖：角色判定（档位比较）、非成员/无主体、查询失败 fail-open（按非成员 +
 * warn，不抛给业务面）、CRUD 与角色校验、未分配 projectId → 默认项目。
 */
describe("ProjectAccessService（AUTH-02）", () => {
  // R32-A5: 第二个 ctor 参数是 @Optional 的 UsersService——默认不提供
  // （null），既有 14 条用例因此逐字节走「未接线」的旧路径。
  const makeService = (
    overrides: Partial<Record<string, jest.Mock>> = {},
    usersService: unknown = null,
  ) => {
    const repo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((x) => x),
      save: jest.fn(async (x) => ({ id: "m1", createdAt: new Date(), ...x })),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      ...overrides,
    };
    const svc = new ProjectAccessService(repo as never, usersService as never);
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

  /**
   * R32-B1：判定三态。
   *
   * 缺陷成因是「两种语义共用一个 null」：`resolveRole` 的 null 既是「查到了、没有
   * 成员行」又是「查询失败、判定没做完」，而执行类写面只认得前者的宽松语义，于是
   * 把故障也放行了。本组用例钉住两件事：(1) 三态在类型/取值上分得开；
   * (2) `resolveRole` 的二态折叠**逐字节不变**（读面契约不破）。
   */
  describe("R32-B1：三态 resolveRoleState（写面契约）", () => {
    it("有成员行 → { status: 'role' }（判定成功且有角色）", async () => {
      const { svc, repo } = makeService();
      repo.findOne.mockResolvedValue({ role: "viewer" });
      await expect(svc.resolveRoleState(7, "p1")).resolves.toEqual({
        status: "role",
        role: "viewer",
      });
    });

    it("无成员行 → { status: 'none' }（判定成功、无角色关系）", async () => {
      const { svc } = makeService();
      await expect(svc.resolveRoleState(7, "p1")).resolves.toEqual({
        status: "none",
      });
      // 无主体同样不是"判定失败"，而是"没有可判定的角色"。
      await expect(svc.resolveRoleState(null, "p1")).resolves.toEqual({
        status: "none",
      });
      await expect(svc.resolveRoleState(undefined, "p1")).resolves.toEqual({
        status: "none",
      });
    });

    it("查询抛错 → { status: 'unavailable' }（既不是 role 也不是 none）", async () => {
      const { svc } = makeService({
        findOne: jest.fn().mockRejectedValue(new Error("connection reset")),
      });
      const warnSpy = jest
        .spyOn(
          (svc as unknown as { logger: { warn: jest.Mock } }).logger,
          "warn",
        )
        .mockImplementation(() => {});

      const state = await svc.resolveRoleState(7, "p1");

      expect(state).toEqual({ status: "unavailable" });
      // 三种取值互不相等：任何调用点都必须显式处理 unavailable，无法用
      // `if (!role)` 之类的二态写法蒙混过关。
      expect(state).not.toEqual({ status: "none" });
      // 现场证据必须留：判定不可用时的 warn 文案未变（既有断言依赖该子串）。
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("resolveRole failed"),
      );
      warnSpy.mockRestore();
    });

    it("resolveRole 仍是二态折叠：unavailable → null（读面 fail-open 逐字节不变）", async () => {
      const { svc } = makeService({
        findOne: jest.fn().mockRejectedValue(new Error("connection reset")),
      });
      const warnSpy = jest
        .spyOn(
          (svc as unknown as { logger: { warn: jest.Mock } }).logger,
          "warn",
        )
        .mockImplementation(() => {});

      await expect(svc.resolveRole(7, "p1")).resolves.toBeNull();
      await expect(svc.hasProjectRole(7, "p1", "viewer")).resolves.toBe(false);
      warnSpy.mockRestore();
    });

    it("脏角色值仍在 role 分支里交出去（不在这里折成 none）", async () => {
      const { svc, repo } = makeService();
      repo.findOne.mockResolvedValue({ role: "superuser" });
      await expect(svc.resolveRoleState(7, "p1")).resolves.toEqual({
        status: "role",
        role: "superuser",
      });
      // 拒绝的责任仍在 isProjectRole（与改动前同一条判定链）。
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

    // R32-A5（轴1 幽灵成员 / 轴3 成员管理）：**创建路径**的幽灵成员。
    //
    // A-8 只补了「删除用户」方向的清理（users.service.remove 同事务删
    // project_members）。但 project_members.userId 无 FK，创建路径此前对目标
    // userId 不做任何校验：POST /projects/:id/members {userId: 987654} 会 201
    // 一条指向"没有人"的成员行 → 成员面板展示一个无对应用户的成员；
    // 更关键的是 resolveRole(987654, pid) 对该 id 是**既成授权**——将来 id
    // 复用、跨环境/备份导入数据时它立刻变成真实访问权。授予是授权动作，
    // 授予对象必须在场（fail-closed），与 hasProjectRole 的判定侧姿态相反。
    describe("addMember 目标用户存在性（R32-A5）", () => {
      it("目标用户不存在 → 404 USER_ID_NOT_FOUND，且不落成员行", async () => {
        const users = { findByIdOrNull: jest.fn().mockResolvedValue(null) };
        const { svc, repo } = makeService({}, users);

        await expect(
          svc.addMember("p1", 987654, "editor"),
        ).rejects.toMatchObject({ errorCode: "USER_ID_NOT_FOUND" });

        expect(users.findByIdOrNull).toHaveBeenCalledWith(987654);
        expect(repo.findOne).not.toHaveBeenCalled();
        expect(repo.create).not.toHaveBeenCalled();
        expect(repo.save).not.toHaveBeenCalled();
      });

      it("目标用户存在 → 照常落行（零行为变化）", async () => {
        const users = { findByIdOrNull: jest.fn().mockResolvedValue({ id: 8 }) };
        const { svc, repo } = makeService({}, users);

        await svc.addMember("p1", 8, "viewer");

        expect(users.findByIdOrNull).toHaveBeenCalledWith(8);
        expect(repo.create).toHaveBeenCalledWith({
          projectId: "p1",
          userId: 8,
          role: "viewer",
        });
      });

      it("usersService 未接线（既有极简装配）→ 跳过校验，维持既有行为", async () => {
        const { svc, repo } = makeService();
        await expect(svc.addMember("p1", 8, "viewer")).resolves.toBeTruthy();
        expect(repo.create).toHaveBeenCalled();
      });

      // R32-C2（L6，真 fail-open 收口）：R32-A5 只堵了「查得到、但不存在」。
      // 「**查不动**」这条分支当时是 warn 后放行——DB 抖动窗口内的授予动作会
      // 直接写出 project_members 行，而该表 userId **无 FK**，于是又长出一条
      // A5 刚堵掉的幽灵成员/既成授权。判定不可用 ≠ 用户不存在：既不能折成
      // 404（会把抖动报成"账号不存在"），也不能放行。fail-closed = 503 +
      // 明确可重试的通用码 DEPENDENCY_UNAVAILABLE。
      it("存在性查询抖动 → 503 DEPENDENCY_UNAVAILABLE，且绝不落成员行（fail-closed）", async () => {
        const users = {
          findByIdOrNull: jest.fn().mockRejectedValue(new Error("connection reset")),
        };
        const { svc, repo } = makeService({}, users);
        const warnSpy = jest
          .spyOn(
            (svc as unknown as { logger: { warn: jest.Mock } }).logger,
            "warn",
          )
          .mockImplementation(() => {});

        await expect(
          svc.addMember("p1", 8, "viewer"),
        ).rejects.toMatchObject({
          errorCode: "DEPENDENCY_UNAVAILABLE",
          status: 503,
        });

        // 现场证据必须留在日志里（503 是给调用方的姿势，不是免掉 warn 的理由）
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("target user lookup failed"),
        );
        // 闸门在写库之前——查询失败时连"查重"都不该发生
        expect(repo.findOne).not.toHaveBeenCalled();
        expect(repo.create).not.toHaveBeenCalled();
        expect(repo.save).not.toHaveBeenCalled();
        warnSpy.mockRestore();
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

/**
 * R32-A5 装配钉子：addMember 的目标用户存在性校验依赖 **@Optional 注入**。
 *
 * @Optional 的代价是「装配漏了也不报错，只是悄悄不校验」——恰是本轮要补的那类
 * 静默缺口。故把装配本身钉住：ProjectsModule 必须 import UsersModule，且
 * ProjectAccessService 的第二构造参数类型确实是 UsersService（Nest 的
 * design:paramtypes 反射来源）。两条任一被破坏，addMember 就退回「谁都能被授予」，
 * 而所有业务用例仍然全绿。
 */
describe("ProjectAccessService 装配（R32-A5）", () => {
  it("ProjectsModule imports UsersModule（否则 @Optional 注入静默为 undefined）", () => {
    const imports = (Reflect.getMetadata("imports", ProjectsModule) ??
      []) as unknown[];
    expect(imports).toContain(UsersModule);
  });

  it("ProjectAccessService 的 ctor 第二参类型是 UsersService", () => {
    const paramTypes = Reflect.getMetadata(
      "design:paramtypes",
      ProjectAccessService,
    ) as unknown[] | undefined;
    expect(paramTypes?.[1]).toBe(UsersService);
  });
});
