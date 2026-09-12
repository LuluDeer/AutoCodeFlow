import { TaskService } from "../task.service";
import { UserRole } from "../../users/entities/user.entity";

/**
 * NF-03（任务级 RBAC 预研）：写面属主守卫矩阵。
 * assertCanWrite 是纯守卫（不触库），直接构造 service 实例的最小依赖面
 * （对齐 task.service.spec 的桩形态，但只测守卫本身）。
 */
describe("TaskService.assertCanWrite（NF-03 属主矩阵）", () => {
  let service: TaskService;

  const makeDeps = () => ({
    taskRepo: { findOne: jest.fn(), findAndCount: jest.fn(), save: jest.fn() },
    execRepo: {},
    logLineRepo: {},
    versionRepo: {},
    taskQueue: { add: jest.fn() },
    dataSource: {},
    schedulerService: { stop: jest.fn(), scheduleOne: jest.fn() },
    executorService: {},
    configService: { get: jest.fn() },
    secretsCrypto: { encryptForStorage: jest.fn(), maskForResponse: jest.fn() },
    aiService: {},
    aiAnalysisService: {},
    eventBus: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
  });

  beforeEach(() => {
    // 守卫方法不触任何依赖——最小桩即可实例化（构造器注入面按 task.service
    // 构造器顺序；缺省依赖用 null 占位，assertCanWrite 不读它们）。
    service = new TaskService(
      makeDeps().taskRepo as never,
      makeDeps().execRepo as never,
      makeDeps().logLineRepo as never,
      makeDeps().versionRepo as never,
      makeDeps().taskQueue as never,
      makeDeps().dataSource as never,
      makeDeps().schedulerService as never,
      makeDeps().aiService as never,
      makeDeps().aiAnalysisService as never,
      makeDeps().configService as never,
      makeDeps().executorService as never,
      makeDeps().eventBus as never,
      null as never,
      null as never,
      null as never,
      // AUTH-02: ProjectAccessService（@Optional，缺席 = 旁路）
      null as never,
    );
  });

  const admin = { id: 1, role: UserRole.ADMIN };
  const owner = { id: 7, role: UserRole.USER };
  const other = { id: 8, role: UserRole.USER };

  it("ADMIN 全量放行（无论行属主）", () => {
    expect(() =>
      service.assertCanWrite({ ownerUserId: 7 }, admin),
    ).not.toThrow();
    expect(() =>
      service.assertCanWrite({ ownerUserId: null }, admin),
    ).not.toThrow();
    expect(() =>
      service.assertCanWrite({ ownerUserId: 8 }, admin),
    ).not.toThrow();
  });

  it("属主改自己 → 放行", () => {
    expect(() =>
      service.assertCanWrite({ ownerUserId: 7 }, owner),
    ).not.toThrow();
  });

  it("非属主非 admin → 403", () => {
    expect(() => service.assertCanWrite({ ownerUserId: 7 }, other)).toThrow(
      "You do not own this task",
    );
  });

  it("无主行（NULL/存量）非 admin → 403（保守默认）", () => {
    expect(() => service.assertCanWrite({ ownerUserId: null }, owner)).toThrow(
      "no owner",
    );
  });

  it("user 为 null/undefined（API-Key 主体）按非 ADMIN → 403", () => {
    expect(() => service.assertCanWrite({ ownerUserId: 7 }, null)).toThrow();
    expect(() =>
      service.assertCanWrite({ ownerUserId: null }, undefined),
    ).toThrow();
  });

  it("悬垂 ownerUserId（用户已删除，id 不存在）≠ 当前用户 → 403（方向安全）", () => {
    expect(() => service.assertCanWrite({ ownerUserId: 9999 }, owner)).toThrow(
      "You do not own this task",
    );
  });
});

/**
 * AUTH-02：项目角色叠加面（只增放行、不收紧）+ 执行类写面 viewer 约束。
 * 用可注入的 ProjectAccessService 桩构造第二个 service 实例。
 */
describe("TaskService 项目角色面（AUTH-02）", () => {
  const makeServiceWithAccess = (
    hasProjectRole: jest.Mock,
    resolveRole: jest.Mock,
  ) => {
    const access = { hasProjectRole, resolveRole };
    return new TaskService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      null as never,
      null as never,
      null as never,
      access as never,
    );
  };

  const plainUser = { id: 8, role: UserRole.USER };
  const admin = { id: 1, role: UserRole.ADMIN };

  it("assertCanWriteProjectAware：非属主 + 项目 editor → 放行（AUTH-02 的新增放行）", async () => {
    const svc = makeServiceWithAccess(
      jest.fn().mockResolvedValue(true),
      jest.fn(),
    );
    await expect(
      svc.assertCanWriteProjectAware(
        { ownerUserId: 7, projectId: "p1" },
        plainUser,
      ),
    ).resolves.toBeUndefined();
  });

  it("assertCanWriteProjectAware：非属主 + 非成员 → 仍 403（放行面只增不减）", async () => {
    const svc = makeServiceWithAccess(
      jest.fn().mockResolvedValue(false),
      jest.fn(),
    );
    await expect(
      svc.assertCanWriteProjectAware(
        { ownerUserId: 7, projectId: "p1" },
        plainUser,
      ),
    ).rejects.toThrow("You do not own this task");
  });

  it("assertCanWriteProjectAware：无主存量行 + 项目 editor → 放行（团队可接管存量）", async () => {
    const svc = makeServiceWithAccess(
      jest.fn().mockResolvedValue(true),
      jest.fn(),
    );
    await expect(
      svc.assertCanWriteProjectAware({ ownerUserId: null }, plainUser),
    ).resolves.toBeUndefined();
  });

  it("assertCanWriteProjectAware：ADMIN 短路，不查项目角色", async () => {
    const has = jest.fn().mockResolvedValue(false);
    const svc = makeServiceWithAccess(has, jest.fn());
    await expect(
      svc.assertCanWriteProjectAware({ ownerUserId: 7 }, admin),
    ).resolves.toBeUndefined();
    expect(has).not.toHaveBeenCalled();
  });

  it("assertCanOperate：项目 viewer → 403（viewer 即只读，角色模型唯一硬约束）", async () => {
    const svc = makeServiceWithAccess(
      jest.fn(),
      jest.fn().mockResolvedValue("viewer"),
    );
    await expect(
      svc.assertCanOperate({ ownerUserId: 7, projectId: "p1" }, plainUser),
    ).rejects.toThrow("viewer");
  });

  it("assertCanOperate：viewer 之外（editor/无角色/ADMIN/无主体）一律维持既有行为", async () => {
    const editorSvc = makeServiceWithAccess(
      jest.fn(),
      jest.fn().mockResolvedValue("editor"),
    );
    const noneSvc = makeServiceWithAccess(
      jest.fn(),
      jest.fn().mockResolvedValue(null),
    );
    const viewerSvc = makeServiceWithAccess(
      jest.fn(),
      jest.fn().mockResolvedValue("viewer"),
    );
    const row = { ownerUserId: 7, projectId: "p1" };

    await expect(
      editorSvc.assertCanOperate(row, plainUser),
    ).resolves.toBeUndefined();
    await expect(
      noneSvc.assertCanOperate(row, plainUser),
    ).resolves.toBeUndefined();
    await expect(
      viewerSvc.assertCanOperate(row, admin),
    ).resolves.toBeUndefined();
    await expect(
      viewerSvc.assertCanOperate(row, null),
    ).resolves.toBeUndefined();
  });
});
