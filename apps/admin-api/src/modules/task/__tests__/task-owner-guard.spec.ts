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
    expect(() =>
      service.assertCanWrite({ ownerUserId: 7 }, null),
    ).toThrow();
    expect(() =>
      service.assertCanWrite({ ownerUserId: null }, undefined),
    ).toThrow();
  });

  it("悬垂 ownerUserId（用户已删除，id 不存在）≠ 当前用户 → 403（方向安全）", () => {
    expect(() =>
      service.assertCanWrite({ ownerUserId: 9999 }, owner),
    ).toThrow("You do not own this task");
  });
});
