import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";
import {
  AppDeploymentService,
  RELEASES_SYNTHETIC_SCAN_PAGE_SIZE,
} from "../app-deployment.service";
import {
  AppDeployment,
  DeploymentStatus,
  DeploymentTriggerType,
  RunMode,
} from "../entities/app-deployment.entity";
import { ApplicationVersion } from "../entities/application-version.entity";
import {
  AppDeploymentEvent,
  AppDeploymentEventType,
} from "../entities/app-deployment-event.entity";
import { ApplicationService } from "../application.service";
import { ExecutorService } from "../../executor/executor.service";
import { AppDeploymentController } from "../app-deployment.controller";
import { ListDeploymentEventsQueryDto } from "../dto/app-deployment.dto";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { UserRole } from "../../users/entities/user.entity";

/**
 * R4（部署模型评审 2026-10-23 §4.1A + §4.7）：不可变部署事件表。
 *
 * 覆盖：九个写入点各落一条事件、事件写入失败不阻断主动作（fail-open）、
 * deployCount 从事件聚合（DB 侧 GROUP BY）+ legacy 回退、/releases truncated
 * 标记（扫描上限 vs 提前耗尽）、/events 读面分页与权限。
 */

// Mock axios to avoid real HTTP calls (deploy/upgrade push 链 fire-and-forget)
jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn().mockResolvedValue({ data: {} }) },
}));

// R8: pushDeployToExecutor / stop run assertSafeExecutorUrl, which resolves
// hostnames via node:dns/promises — pin it so specs never hit DNS.
jest.mock("node:dns/promises", () => ({ lookup: jest.fn() }));
import { lookup } from "node:dns/promises";
const mockedLookup = lookup as unknown as jest.Mock;

const mockApp = {
  id: "app-1",
  name: "my-app",
  gitRepo: "https://github.com/org/repo",
  gitBranch: "main",
  gitCommit: "abc123",
  runtime: "node",
  entrypoint: "node dist/main.js",
  version: "1.0.0",
  env: { NODE_ENV: "production" },
};

const mockExecutor = {
  id: "exec-1",
  address: "http://executor:3001",
};

const deploymentRow = (
  id: string,
  overrides: Partial<AppDeployment> = {},
): AppDeployment =>
  ({
    id,
    applicationId: "app-1",
    executorAddress: mockExecutor.address,
    executorId: mockExecutor.id,
    status: DeploymentStatus.RUNNING,
    runMode: RunMode.DAEMON,
    deployedCommit: "abc123",
    deployedVersion: "1.0.0",
    startCommand: null,
    env: null,
    pid: 123,
    lastHeartbeat: null,
    statusMessage: null,
    deployedAt: new Date("2026-09-01T01:00:00Z"),
    createdAt: new Date("2026-09-01T01:00:00Z"),
    updatedAt: new Date("2026-09-01T01:00:00Z"),
    ...overrides,
  }) as AppDeployment;

const makeDeploymentRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  findAndCount: jest.fn().mockResolvedValue([[], 0]),
  create: jest.fn((d: any) => d),
  save: jest.fn((e: any) =>
    Promise.resolve({ id: e.id ?? "deploy-new", ...e }),
  ),
  delete: jest.fn().mockResolvedValue({ affected: 1 }),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  // 卡死扫描的批量 UPDATE 走 createQueryBuilder 链（service.spec 同款）。
  createQueryBuilder: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 0, raw: [] }),
  })),
});

const makeEventRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  findAndCount: jest.fn().mockResolvedValue([[], 0]),
  create: jest.fn((d: any) => d),
  save: jest.fn((e: any) => Promise.resolve(e)),
  insert: jest.fn().mockResolvedValue({ generatedMaps: [], raw: [] }),
  count: jest.fn().mockResolvedValue(0),
  createQueryBuilder: jest.fn(() => {
    // 链式聚合查询替身（DB 侧 GROUP BY）：链式方法返回 this，终态 getRawMany。
    const qb: Record<string, jest.Mock> = {};
    for (const m of ["select", "addSelect", "where", "andWhere", "groupBy"]) {
      qb[m] = jest.fn(() => qb);
    }
    qb.getRawMany = jest.fn().mockResolvedValue([]);
    return qb;
  }),
});

describe("AppDeploymentService 部署事件（R4 §4.1A）", () => {
  let service: AppDeploymentService;
  let repo: ReturnType<typeof makeDeploymentRepo>;
  let versionRepo: ReturnType<typeof makeDeploymentRepo>;
  let eventRepo: ReturnType<typeof makeEventRepo>;
  let appService: {
    findByIdRaw: jest.Mock;
    update: jest.Mock;
    maskReadSurface: jest.Mock;
    maskEnvForRead: jest.Mock;
  };
  let executorService: Record<string, jest.Mock>;

  beforeEach(async () => {
    repo = makeDeploymentRepo();
    versionRepo = makeDeploymentRepo();
    eventRepo = makeEventRepo();
    appService = {
      findByIdRaw: jest.fn().mockResolvedValue(mockApp),
      update: jest.fn((_: string, dto: any) =>
        Promise.resolve({ ...mockApp, ...dto }),
      ),
      maskEnvForRead: jest.fn((e: unknown) => e),
      maskReadSurface: jest.fn((a: unknown) => a),
    };
    executorService = {
      findOne: jest.fn().mockResolvedValue(mockExecutor),
      selectLeastLoaded: jest.fn().mockResolvedValue(mockExecutor),
      getSharedToken: jest.fn().mockResolvedValue(""),
      getExecutorUrl: jest.fn(
        (addr: string, p: string) =>
          `${addr.startsWith("http://") || addr.startsWith("https://") ? "" : "http://"}${addr}/${p}`,
      ),
      deliverControlCommand: jest.fn().mockResolvedValue({ delivered: "push" }),
      // R3-A（§4.3）：getReleases 的设备徽标聚合源（本 spec 无设备事实用例）
      getAppVersionFacts: jest.fn().mockResolvedValue([]),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AppDeploymentService,
        { provide: getRepositoryToken(AppDeployment), useValue: repo },
        {
          provide: getRepositoryToken(ApplicationVersion),
          useValue: versionRepo,
        },
        { provide: ApplicationService, useValue: appService },
        { provide: ExecutorService, useValue: executorService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
        // R4：事件表 repo（生产由 application.module forFeature 恒提供）。
        {
          provide: getRepositoryToken(AppDeploymentEvent),
          useValue: eventRepo,
        },
      ],
    }).compile();

    service = moduleRef.get(AppDeploymentService);
    mockedLookup.mockReset();
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => mockedLookup.mockReset());

  // ----------------------------------------------------------------
  // 写入点：每个动作各落一条事件
  // ----------------------------------------------------------------

  it("deploy 新建行 → deploy_created 事件（版本事实=动作时 app.version）", async () => {
    repo.create.mockImplementation((d: any) => d);
    await service.deploy("app-1", { executorId: "exec-1" });

    expect(eventRepo.insert).toHaveBeenCalledTimes(1);
    expect(eventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationId: "app-1",
        eventType: AppDeploymentEventType.DEPLOY_CREATED,
        deployedVersion: "1.0.0",
        detail: { runMode: RunMode.ONCE },
      }),
    );
  });

  it("deploy 审批请求行 → deploy_created 事件（detail 标 approvalRequired）", async () => {
    appService.findByIdRaw.mockResolvedValue({
      ...mockApp,
      approvalRequired: true,
    });
    repo.create.mockImplementation((d: any) => d);
    await service.deploy("app-1", { executorId: "exec-1" });

    expect(eventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: AppDeploymentEventType.DEPLOY_CREATED,
        detail: { approvalRequired: true, runMode: RunMode.ONCE },
      }),
    );
  });

  it("deploy 复用终态行 → redeploy_reused 事件（不新建行的唯一动作痕迹）", async () => {
    const reusable = deploymentRow("reused-1", {
      status: DeploymentStatus.FAILED,
    });
    // 第 1 次 findOne：在途守卫（null）；第 2 次：可复用终态行
    repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(reusable);

    await service.deploy("app-1", { executorId: "exec-1" });

    expect(eventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentId: "reused-1",
        eventType: AppDeploymentEventType.REDEPLOY_REUSED,
        deployedVersion: "1.0.0",
      }),
    );
  });

  it("approveDeployment → approval_approved 事件（reason 进 detail）", async () => {
    repo.findOne.mockResolvedValue(
      deploymentRow("dep-1", {
        status: DeploymentStatus.PENDING,
        approvalStatus: "pending_approval",
        approvalMeta: { requestedBy: 2, requestedAt: "2026-10-24T00:00:00Z" },
        deployedVersion: null,
      }),
    );
    await service.approveDeployment("dep-1", { id: 1, name: "admin" }, "ok");

    expect(eventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: AppDeploymentEventType.APPROVAL_APPROVED,
        deployedVersion: "1.0.0", // approve 载入 app：版本事实 = 当前 app.version
        detail: { reason: "ok" },
      }),
    );
  });

  it("rejectDeployment → approval_rejected 事件", async () => {
    repo.findOne.mockResolvedValue(
      deploymentRow("dep-1", {
        status: DeploymentStatus.PENDING,
        approvalStatus: "pending_approval",
        approvalMeta: { requestedBy: 2 },
      }),
    );
    await service.rejectDeployment(
      "dep-1",
      { id: 1, name: "admin" },
      "not needed",
    );

    expect(eventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: AppDeploymentEventType.APPROVAL_REJECTED,
        operator: "admin",
        detail: { reason: "not needed" },
      }),
    );
  });

  it("cancelDeployment → approval_cancelled 事件", async () => {
    repo.findOne.mockResolvedValue(
      deploymentRow("dep-1", {
        status: DeploymentStatus.PENDING,
        approvalStatus: "pending_approval",
        approvalMeta: { requestedBy: 1 },
      }),
    );
    await service.cancelDeployment("dep-1", { id: 1, name: "requester" });

    expect(eventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: AppDeploymentEventType.APPROVAL_CANCELLED,
        operator: "requester",
      }),
    );
  });

  it("upgrade → upgrade 事件（版本事实=推送目标 app.version；R1/rollback 链同经此处）", async () => {
    repo.findOne.mockResolvedValue(deploymentRow("dep-1"));
    appService.findByIdRaw.mockResolvedValue({ ...mockApp, version: "2.0.0" });
    await service.upgrade("dep-1", {
      operator: "admin",
      triggerType: DeploymentTriggerType.UPGRADE,
    });

    expect(eventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentId: "dep-1",
        eventType: AppDeploymentEventType.UPGRADE,
        deployedVersion: "2.0.0",
        triggerType: "upgrade",
        operator: "admin",
      }),
    );
  });

  it("stop → stop 事件（detail 记停机信号送达与否）", async () => {
    repo.findOne.mockResolvedValue(deploymentRow("dep-1"));
    await service.stop("dep-1");

    expect(eventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: AppDeploymentEventType.STOP,
        deployedVersion: "1.0.0",
        detail: { stopSignalDelivered: true },
      }),
    );
  });

  it("stop 信号未送达 → detail 如实记录 stopSignalDelivered=false", async () => {
    repo.findOne.mockResolvedValue(
      deploymentRow("dep-1", {
        statusMessage: "[Stop not delivered] executor offline",
      }),
    );
    await service.stop("dep-1");

    expect(eventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: AppDeploymentEventType.STOP,
        detail: { stopSignalDelivered: false },
      }),
    );
  });

  it("removeDeployment → remove 事件（在 delete 之前落——事件比行活得久）", async () => {
    const doomed = deploymentRow("dep-1", { status: DeploymentStatus.FAILED });
    repo.findOne.mockResolvedValue(doomed);
    await service.removeDeployment("dep-1", { id: 1, username: "admin" });

    expect(eventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: AppDeploymentEventType.REMOVE,
        operator: "admin",
        detail: { deletedStatus: DeploymentStatus.FAILED },
      }),
    );
    const insertOrder = eventRepo.insert.mock.invocationCallOrder[0];
    const deleteOrder = repo.delete.mock.invocationCallOrder[0];
    expect(insertOrder).toBeLessThan(deleteOrder);
  });

  it("卡死扫描实际命中的行 → stuck_failed 事件（previousStatus 进 detail）", async () => {
    const stuckRow = deploymentRow("stuck-1", {
      status: DeploymentStatus.DEPLOYING,
      updatedAt: new Date(Date.now() - 20 * 60 * 1000),
      statusMessage: "Deploying",
    });
    repo.find.mockResolvedValue([stuckRow]);
    repo.createQueryBuilder.mockImplementation(() => ({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      // A-9：RETURNING 取回实际命中 id（该行确实被 UPDATE 成 FAILED）
      returning: jest.fn().mockReturnThis(),
      execute: jest
        .fn()
        .mockResolvedValue({ affected: 1, raw: [{ id: "stuck-1" }] }),
    }));

    await service.detectStuckDeployments();

    expect(eventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentId: "stuck-1",
        eventType: AppDeploymentEventType.STUCK_FAILED,
        operator: null, // 系统路径
        detail: { previousStatus: DeploymentStatus.DEPLOYING },
      }),
    );
  });

  it("卡死扫描未命中（并发已推进）→ 不落事件", async () => {
    const stuckRow = deploymentRow("stuck-1", {
      status: DeploymentStatus.DEPLOYING,
      updatedAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    repo.find.mockResolvedValue([stuckRow]);
    // execute 默认返回 affected=0, raw=[]（makeDeploymentRepo 缺省）

    await service.detectStuckDeployments();

    expect(eventRepo.insert).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------------
  // fail-open：事件写入失败绝不阻断主动作
  // ----------------------------------------------------------------

  it("事件 insert 抛错 → deploy 仍成功返回（best-effort + warn）", async () => {
    eventRepo.insert.mockRejectedValue(new Error("events table down"));
    const warnSpy = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    repo.create.mockImplementation((d: any) => d);

    const result = await service.deploy("app-1", { executorId: "exec-1" });

    expect(result.id).toBe("deploy-new");
    expect(eventRepo.insert).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Deployment event write failed"),
    );
    warnSpy.mockRestore();
  });

  // ----------------------------------------------------------------
  // 读面：deployCount 事件聚合 + legacy 回退（§4.7）
  // ----------------------------------------------------------------

  describe("buildDeployCountMap（经 getVersionHistory 公共面）", () => {
    const versionSnapshot = {
      id: "v-1",
      applicationId: "app-1",
      version: "1.0.0",
      gitCommit: null,
      snapshot: {},
      sourceDeploymentId: null,
      status: "released",
      createdBy: null,
      description: null,
      createdAt: new Date("2026-09-01T00:00:00Z"),
    } as ApplicationVersion;

    it("应用已有事件 → DB 侧 GROUP BY 聚合（COUNT 字符串收口为数字）", async () => {
      versionRepo.find.mockResolvedValue([versionSnapshot]);
      eventRepo.count.mockResolvedValue(3);
      eventRepo.createQueryBuilder.mockImplementationOnce(() => {
        const qb: Record<string, jest.Mock> = {};
        for (const m of [
          "select",
          "addSelect",
          "where",
          "andWhere",
          "groupBy",
        ]) {
          qb[m] = jest.fn(() => qb);
        }
        qb.getRawMany = jest.fn().mockResolvedValue([
          { version: "1.0.0", count: "7" }, // pg bigint 字符串形态
          { version: "2.0.0", count: "2" },
        ]);
        return qb;
      });

      const history = await service.getVersionHistory("app-1");

      const v1 = history.find((h: any) => h.version === "1.0.0");
      expect(v1?.deployCount).toBe(7);
      expect(eventRepo.count).toHaveBeenCalledWith({
        where: { applicationId: "app-1" },
      });
    });

    it("应用零事件（legacy）→ 回退 findAllByApp 行计数", async () => {
      versionRepo.find.mockResolvedValue([versionSnapshot]);
      eventRepo.count.mockResolvedValue(0);
      repo.find.mockResolvedValue([
        deploymentRow("d-1", { deployedVersion: "1.0.0" }),
        deploymentRow("d-2", { deployedVersion: "1.0.0" }),
        deploymentRow("d-3", { deployedVersion: "2.0.0" }),
      ]);

      const history = await service.getVersionHistory("app-1");

      const v1 = history.find((h: any) => h.version === "1.0.0");
      expect(v1?.deployCount).toBe(2);
      // 未走事件聚合查询
      expect(eventRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("聚合只计部署动作事件（deploy_created/redeploy_reused/upgrade）", async () => {
      // 常量集合经 SQL where 注入——此处验证聚合链路查询的 types 参数
      versionRepo.find.mockResolvedValue([versionSnapshot]);
      eventRepo.count.mockResolvedValue(1);
      eventRepo.createQueryBuilder.mockImplementationOnce(() => {
        const qb: Record<string, jest.Mock> = {};
        for (const m of [
          "select",
          "addSelect",
          "where",
          "andWhere",
          "groupBy",
        ]) {
          qb[m] = jest.fn(() => qb);
        }
        qb.getRawMany = jest
          .fn()
          .mockResolvedValue([{ version: "1.0.0", count: "1" }]);
        return qb;
      });

      await service.getVersionHistory("app-1");

      const qb = eventRepo.createQueryBuilder.mock.results[0].value;
      const typesArg = qb.andWhere.mock.calls.find((c: any[]) =>
        String(c[0]).includes("eventType"),
      )?.[1];
      expect(typesArg).toEqual({
        types: [
          AppDeploymentEventType.DEPLOY_CREATED,
          AppDeploymentEventType.REDEPLOY_REUSED,
          AppDeploymentEventType.UPGRADE,
        ],
      });
    });
  });

  // ----------------------------------------------------------------
  // 读面：/releases truncated（§4.7 去静默截断）
  // ----------------------------------------------------------------

  describe("getReleases truncated 标记", () => {
    it("synthetic 扫描页页扫满到 5000 上限 → truncated=true", async () => {
      versionRepo.findAndCount.mockResolvedValue([[], 0]);
      const fullPage = Array.from(
        { length: RELEASES_SYNTHETIC_SCAN_PAGE_SIZE },
        (_, i) => deploymentRow(`d-${i}`),
      );
      repo.find.mockResolvedValue(fullPage); // 每页都满 → 循环到上限

      const res = await service.getReleases("app-1", 1, 50);

      expect(res.truncated).toBe(true);
      expect(repo.find).toHaveBeenCalledTimes(5); // 5000 / 1000
    });

    it("部署行不足一页（提前耗尽）→ truncated=false", async () => {
      versionRepo.findAndCount.mockResolvedValue([[], 0]);
      repo.find.mockResolvedValue([deploymentRow("d-1"), deploymentRow("d-2")]);

      const res = await service.getReleases("app-1", 1, 50);

      expect(res.truncated).toBe(false);
      // 响应字段只增不改：四键信封原样保留
      expect(res.page).toBe(1);
      expect(res.pageSize).toBe(50);
      expect(res.data).toHaveLength(1); // 单一 deployedVersion → 1 条 synthetic 行
      expect(res.data[0].synthetic).toBe(true);
    });

    it("第 2 页不跑 synthetic 扫描 → 恒 truncated=false", async () => {
      versionRepo.findAndCount.mockResolvedValue([[], 0]);

      const res = await service.getReleases("app-1", 2, 50);

      expect(res.truncated).toBe(false);
      expect(repo.find).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------
  // 读面：/events 分页
  // ----------------------------------------------------------------

  describe("getEventsByApp", () => {
    it("分页透传（默认 50，上限 200，createdAt+id 倒序）", async () => {
      const rows = [{ id: "e-1" }] as AppDeploymentEvent[];
      eventRepo.findAndCount.mockResolvedValue([rows, 1]);

      const res = await service.getEventsByApp("app-1");

      expect(res).toEqual({ data: rows, total: 1, page: 1, pageSize: 50 });
      expect(eventRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { applicationId: "app-1" },
          order: { createdAt: "DESC", id: "DESC" },
          skip: 0,
          take: 50,
        }),
      );
    });

    it("pageSize 超限钳到 200；page 从 1 起", async () => {
      eventRepo.findAndCount.mockResolvedValue([[], 0]);

      const res = await service.getEventsByApp("app-1", 3, 500);

      expect(res.page).toBe(3);
      expect(res.pageSize).toBe(200);
      expect(eventRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 400, take: 200 }),
      );
    });

    it("eventType 直等过滤：where 带 eventType（命中复合索引前缀）", async () => {
      eventRepo.findAndCount.mockResolvedValue([[], 0]);

      await service.getEventsByApp("app-1", 1, 50, {
        eventType: AppDeploymentEventType.UPGRADE,
      });

      expect(eventRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { applicationId: "app-1", eventType: "upgrade" },
        }),
      );
    });

    it("since/until 半开区间：since 含头（>=）、until 不含尾（<）", async () => {
      eventRepo.findAndCount.mockResolvedValue([[], 0]);

      await service.getEventsByApp("app-1", 1, 50, {
        since: "2026-10-01T00:00:00Z",
        until: "2026-10-24T00:00:00Z",
      });

      const where = eventRepo.findAndCount.mock.calls[0][0].where;
      const range = where.createdAt; // And(MoreThanOrEqual, LessThan)
      expect(range.constructor.name).toBe("FindOperator");
      expect(range.type).toBe("and");
      const [gte, lt] = range.value;
      expect(gte.type).toBe("moreThanOrEqual");
      expect(new Date(gte.value).toISOString()).toBe(
        "2026-10-01T00:00:00.000Z",
      ); // 含头
      expect(lt.type).toBe("lessThan");
      expect(new Date(lt.value).toISOString()).toBe("2026-10-24T00:00:00.000Z"); // 不含尾
    });

    it("边界：only since / only until / 组合 eventType+区间", async () => {
      eventRepo.findAndCount.mockResolvedValue([[], 0]);

      await service.getEventsByApp("app-1", 1, 50, {
        since: "2026-10-01T00:00:00Z",
      });
      let w = eventRepo.findAndCount.mock.calls[0][0].where;
      expect(w.createdAt.type).toBe("moreThanOrEqual"); // 无 until → 不包 And
      expect(w).not.toHaveProperty("eventType");

      await service.getEventsByApp("app-1", 1, 50, {
        until: "2026-10-24T00:00:00Z",
      });
      w = eventRepo.findAndCount.mock.calls[1][0].where;
      expect(w.createdAt.type).toBe("lessThan"); // 无 since → 单边 <

      await service.getEventsByApp("app-1", 1, 50, {
        eventType: AppDeploymentEventType.DEPLOY_CREATED,
        since: "2026-10-01T00:00:00Z",
        until: "2026-10-24T00:00:00Z",
      });
      w = eventRepo.findAndCount.mock.calls[2][0].where;
      expect(w.eventType).toBe("deploy_created");
      expect(w.createdAt.type).toBe("and");
    });

    it("无过滤参数 → where 与旧版逐字节一致（加性变更回归锚）", async () => {
      eventRepo.findAndCount.mockResolvedValue([[], 0]);

      await service.getEventsByApp("app-1", 1, 50, undefined);

      const arg = eventRepo.findAndCount.mock.calls[0][0];
      expect(arg.where).toEqual({ applicationId: "app-1" });
    });

    it("repo 未接线（装配错误）→ fail-honest 抛错而非伪装空页", async () => {
      const moduleRef = await Test.createTestingModule({
        providers: [
          AppDeploymentService,
          { provide: getRepositoryToken(AppDeployment), useValue: repo },
          {
            provide: getRepositoryToken(ApplicationVersion),
            useValue: versionRepo,
          },
          { provide: ApplicationService, useValue: appService },
          { provide: ExecutorService, useValue: executorService },
          {
            provide: ConfigService,
            useValue: { get: jest.fn().mockReturnValue(undefined) },
          },
          // 刻意不提供 AppDeploymentEvent token（@Optional → null）
        ],
      }).compile();
      const bare = moduleRef.get(AppDeploymentService);

      await expect(bare.getEventsByApp("app-1")).rejects.toThrow(/not wired/);
    });
  });
});

// ====================================================================
// Controller：/events 端点（分页 + 权限对齐部署读面）
// ====================================================================

describe("AppDeploymentController applications/:appId/events（R4）", () => {
  const makeSvc = () =>
    ({
      getEventsByApp: jest.fn().mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        pageSize: 50,
      }),
    }) as unknown as AppDeploymentService;
  const makeExec = () => ({}) as never;

  it("读面：无 @Roles（登录即可，与 findAll/stats 一致）", () => {
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        AppDeploymentController.prototype.listApplicationEvents,
      ),
    ).toBeUndefined();
  });

  it("RolesGuard：普通用户放行 /events 读面", () => {
    const guard = new RolesGuard(new Reflector());
    const ctx = {
      getHandler: () => AppDeploymentController.prototype.listApplicationEvents,
      getClass: () => AppDeploymentController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { role: UserRole.USER } }),
      }),
    } as never;
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('路由声明在 @Get(":id") 之前（防 "applications" 被当成 :id 捕获 400）', () => {
    const proto = AppDeploymentController.prototype;
    const names = Object.getOwnPropertyNames(proto);
    expect(names.indexOf("listApplicationEvents")).toBeLessThan(
      names.indexOf("findById"),
    );
  });

  it("handler 透传分页参数给 service", async () => {
    const svc = makeSvc();
    const controller = new AppDeploymentController(svc, makeExec());

    await controller.listApplicationEvents("app-1", {
      page: 2,
      pageSize: 100,
    } as ListDeploymentEventsQueryDto);

    expect(svc.getEventsByApp).toHaveBeenCalledWith("app-1", 2, 100, {
      eventType: undefined,
      since: undefined,
      until: undefined,
    });
  });

  it("查询参数缺省：page=1、pageSize=50", async () => {
    const svc = makeSvc();
    const controller = new AppDeploymentController(svc, makeExec());

    await controller.listApplicationEvents("app-1", {
      page: 1,
      pageSize: 50,
    } as ListDeploymentEventsQueryDto);

    expect(svc.getEventsByApp).toHaveBeenCalledWith("app-1", 1, 50, {
      eventType: undefined,
      since: undefined,
      until: undefined,
    });
  });

  it("handler 透传过滤参数（eventType/since/until）给 service", async () => {
    const svc = makeSvc();
    const controller = new AppDeploymentController(svc, makeExec());

    await controller.listApplicationEvents("app-1", {
      page: 1,
      pageSize: 50,
      eventType: "upgrade",
      since: "2026-10-01T00:00:00Z",
      until: "2026-10-24T00:00:00Z",
    } as ListDeploymentEventsQueryDto);

    expect(svc.getEventsByApp).toHaveBeenCalledWith("app-1", 1, 50, {
      eventType: "upgrade",
      since: "2026-10-01T00:00:00Z",
      until: "2026-10-24T00:00:00Z",
    });
  });
});

describe("ListDeploymentEventsQueryDto 校验（R4）", () => {
  it("字符串分页参数经 @Type 转数字后合法", async () => {
    const dto = plainToInstance(ListDeploymentEventsQueryDto, {
      page: "2",
      pageSize: "100",
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(2);
    expect(dto.pageSize).toBe(100);
  });

  it("page=0 / pageSize=201 拒绝（Min(1) / Max(200)）", async () => {
    const bad = plainToInstance(ListDeploymentEventsQueryDto, {
      page: 0,
      pageSize: 201,
    });
    const errors = await validate(bad);
    expect(errors.map((e) => e.property).sort()).toEqual(["page", "pageSize"]);
  });

  it("缺省值：page=1、pageSize=50", () => {
    const dto = new ListDeploymentEventsQueryDto();
    expect(dto.page).toBe(1);
    expect(dto.pageSize).toBe(50);
  });

  it("eventType：九值白名单全放行（实测自 AppDeploymentEventType 取值域）", async () => {
    const values = Object.values(AppDeploymentEventType);
    expect(values).toHaveLength(9);
    for (const v of values) {
      const dto = plainToInstance(ListDeploymentEventsQueryDto, { eventType: v });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.eventType).toBe(v);
    }
  });

  it("eventType：白名单外单值拒绝（如 'approval'——静默 400 好过静默不过滤）", async () => {
    const dto = plainToInstance(ListDeploymentEventsQueryDto, {
      eventType: "approval",
    });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toEqual(["eventType"]);
  });

  it("since/until：ISO 8601 放行（带毫秒/不带/带偏移）", async () => {
    const dto = plainToInstance(ListDeploymentEventsQueryDto, {
      since: "2026-10-01T00:00:00Z",
      until: "2026-10-24T00:00:00.000+08:00",
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  /**
   * 非 ISO 形态拒绝。注：class-validator@0.15 的 isISO8601 宽松档接受
   * 'YYYYMMDD'（基本格式）与空格分隔（'2026-10-01 00:00'）——这两类串
   * new Date() 也能解析，进 service 后语义仍正确，故不加 strict 收紧
   * （收紧会无谓拒绝合法客户端）；本用例只钉「明显非日期串必拒」。
   */
  it("since/until：明显非日期串拒绝（'yesterday' / '10-01' / 'abc'）", async () => {
    for (const bad of ["yesterday", "10-01", "abc"]) {
      const dto = plainToInstance(ListDeploymentEventsQueryDto, {
        since: bad,
        until: bad,
      });
      const errors = await validate(dto);
      expect(errors.map((e) => e.property).sort()).toEqual(["since", "until"]);
    }
  });

  it("since > until 的倒挂区间：DTO 层不拦（返回空页如实表达「区间内无事件」）", async () => {
    const dto = plainToInstance(ListDeploymentEventsQueryDto, {
      since: "2026-10-24T00:00:00Z",
      until: "2026-10-01T00:00:00Z",
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
