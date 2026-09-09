import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { AppDeploymentService } from "../app-deployment.service";
import {
  releaseSortTimestampMs,
  RELEASES_MAX_PAGE_SIZE,
} from "../app-deployment.service";
import {
  AppDeployment,
  DeploymentStatus,
  RunMode,
} from "../entities/app-deployment.entity";
import { ApplicationVersion } from "../entities/application-version.entity";
import { ApplicationService } from "../application.service";
import { ExecutorService } from "../../executor/executor.service";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator";
import { ConfigService } from "@nestjs/config";

/**
 * DEP-01：GET /applications/:id/releases 统一只读追溯视图。
 *
 * 覆盖：聚合正确性（同版本多次部署取最新 / 多版本排序 / 无部署版本行也出现）、
 * 分页与上限（默认 50、显式超限截到 200、翻页不重复不遗漏）、
 * triggerType 推导（manual/upgrade/unknown 规则 + null 态）、
 * synthetic 行（有部署无快照的历史数据）、鉴权（默认 JWT，非 public）。
 */

const versionRow = (
  id: string,
  version: string,
  overrides: Partial<ApplicationVersion> = {},
): ApplicationVersion =>
  ({
    id,
    applicationId: "app-1",
    version,
    gitCommit: null,
    snapshot: {},
    sourceDeploymentId: null,
    status: "released",
    createdBy: null,
    description: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  }) as ApplicationVersion;

const deploymentRow = (
  id: string,
  overrides: Partial<AppDeployment> = {},
): AppDeployment =>
  ({
    id,
    applicationId: "app-1",
    executorAddress: "http://exec-a:3001",
    executorId: "exec-a",
    status: DeploymentStatus.RUNNING,
    runMode: RunMode.DAEMON,
    deployedCommit: "abc123",
    deployedVersion: null,
    startCommand: null,
    env: null,
    pid: 123,
    lastHeartbeat: null,
    statusMessage: "Deploy command sent to executor",
    deployedAt: new Date("2026-09-01T01:00:00Z"),
    createdAt: new Date("2026-09-01T01:00:00Z"),
    updatedAt: new Date("2026-09-01T01:00:00Z"),
    ...overrides,
  }) as AppDeployment;

describe("AppDeploymentService.getReleases (DEP-01)", () => {
  let service: AppDeploymentService;
  let deploymentRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let versionRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    findAndCount: jest.Mock;
  };

  beforeEach(async () => {
    deploymentRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((d) => d),
      save: jest.fn(async (e) => e),
    };
    versionRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AppDeploymentService,
        {
          provide: getRepositoryToken(AppDeployment),
          useValue: deploymentRepo,
        },
        {
          provide: getRepositoryToken(ApplicationVersion),
          useValue: versionRepo,
        },
        {
          provide: ApplicationService,
          useValue: {
            maskEnvForRead: (e: unknown) => e,
            maskReadSurface: (a: unknown) => a,
          },
        },
        {
          provide: ExecutorService,
          useValue: { getSharedToken: async () => null },
        },
        {
          provide: ConfigService,
          useValue: { get: () => undefined },
        },
      ],
    }).compile();

    service = moduleRef.get(AppDeploymentService);
  });

  // ------------------------------------------------------------------
  // 聚合正确性
  // ------------------------------------------------------------------

  it("同版本多次部署：取最近一次（状态/时间/执行器），deploymentCount 计全部，operator 读 createdBy", async () => {
    versionRepo.findAndCount.mockResolvedValue([
      [
        versionRow("v-1", "1.0.0", {
          snapshot: { packageUrl: "http://api/uploads/packages/a_1.zip" },
          sourceDeploymentId: "d-old",
          createdBy: "ops@corp",
        }),
      ],
      1,
    ]);
    // source-deployment 查询
    deploymentRepo.find.mockImplementation(async (opts: any) => {
      const where = opts?.where ?? {};
      if (where.id) {
        // source deployment 查询
        return where.id && typeof where.id === "object"
          ? [
              deploymentRow("d-old", {
                deployedVersion: "1.0.0",
                statusMessage: "Upgrade triggered",
              }),
            ]
          : [];
      }
      return [
        deploymentRow("d-new", {
          deployedVersion: "1.0.0",
          status: DeploymentStatus.STOPPED,
          deployedAt: new Date("2026-09-05T02:00:00Z"),
          createdAt: new Date("2026-09-05T02:00:00Z"),
          statusMessage: "stopped by heartbeat",
          executorAddress: "http://exec-b:3001",
        }),
        deploymentRow("d-old", {
          deployedVersion: "1.0.0",
          deployedAt: new Date("2026-09-01T01:00:00Z"),
          createdAt: new Date("2026-09-01T01:00:00Z"),
        }),
      ];
    });
    // synthetic 去重需要全量快照版本集合（select:["version"] 查询）
    versionRepo.find.mockResolvedValue([versionRow("v-1", "1.0.0")]);

    const res = await service.getReleases("app-1", 1, 50);
    expect(res.data).toHaveLength(1);
    const row = res.data[0];
    expect(row.id).toBe("v-1");
    expect(row.version).toBe("1.0.0");
    expect(row.packageUrl).toBe("http://api/uploads/packages/a_1.zip");
    // 同版本多次部署 → 取「最近一次」（createdAt DESC 首见）
    expect(row.latestDeploymentId).toBe("d-new");
    expect(row.deploymentStatus).toBe(DeploymentStatus.STOPPED);
    expect(row.deployedAt).toBe("2026-09-05T02:00:00.000Z");
    expect(row.deploymentCount).toBe(2);
    expect(row.executorAddress).toBe("http://exec-b:3001");
    // 无 trigger 列 → 从最近部署行状态面推导：deployedAt 已置位且无升级指纹 → manual
    expect(row.triggerType).toBe("manual");
    // 版本行 operator 来自快照表的 createdBy
    expect(row.operator).toBe("ops@corp");
    expect(row.operatorSource).toBe("application_versions.createdBy");
    expect(row.synthetic).toBe(false);
    expect(res.total).toBe(1);
  });

  it("无部署的版本行也出现在统一视图，部署字段为 null", async () => {
    versionRepo.findAndCount.mockResolvedValue([
      [
        versionRow("v-no-deploy", "2.0.0", {
          snapshot: { packageUrl: "http://api/uploads/packages/no-deploy.zip" },
        }),
      ],
      1,
    ]);
    deploymentRepo.find.mockResolvedValue([]);

    const res = await service.getReleases("app-1");
    expect(res.data).toHaveLength(1);
    expect(res.data[0]).toMatchObject({
      id: "v-no-deploy",
      version: "2.0.0",
      packageUrl: "http://api/uploads/packages/no-deploy.zip",
      deployedAt: null,
      latestDeploymentId: null,
      deploymentStatus: null,
      deploymentCount: 0,
      triggerType: null,
      synthetic: false,
    });
  });

  it("多版本按排序键（最近部署/快照时间）降序，无部署行落位到正确间隙", async () => {
    versionRepo.findAndCount.mockResolvedValue([
      [
        versionRow("v-old", "1.0.0", {
          snapshot: {},
          sourceDeploymentId: "d-old",
          createdAt: new Date("2026-08-01T00:00:00Z"),
        }),
        versionRow("v-mid", "1.1.0", {
          snapshot: {},
          createdAt: new Date("2026-08-20T00:00:00Z"),
        }),
        versionRow("v-new", "1.2.0", {
          snapshot: {},
          createdAt: new Date("2026-09-01T00:00:00Z"),
        }),
      ],
      3,
    ]);
    deploymentRepo.find.mockImplementation(async (opts: any) => {
      const where = opts?.where ?? {};
      if (where.deployedVersion && where.deployedVersion?._type === "in") {
        return [
          // d-new 部署时间 9-02；d-old 8-02；v-mid 无部署（createdAt DESC）
          deploymentRow("d-new", {
            deployedVersion: "1.2.0",
            deployedAt: new Date("2026-09-02T00:00:00Z"),
            createdAt: new Date("2026-09-02T00:00:00Z"),
          }),
          deploymentRow("d-old", {
            deployedVersion: "1.0.0",
            deployedAt: new Date("2026-08-02T00:00:00Z"),
            createdAt: new Date("2026-08-02T00:00:00Z"),
          }),
        ];
      }
      if (where.id) return [];
      return [];
    });

    const res = await service.getReleases("app-1", 1, 50);
    // 期望：1.2.0(9-02) > 1.1.0(8-20 无部署按快照时间) > 1.0.0(8-02)
    expect(res.data.map((r) => r.version)).toEqual(["1.2.0", "1.1.0", "1.0.0"]);
    expect(res.data[1]).toMatchObject({
      id: "v-mid",
      deployedAt: null,
      deploymentCount: 0,
    });
  });

  // ------------------------------------------------------------------
  // triggerType 推导规则（纯 classifyReleaseTrigger 语义经由行级断言）
  // ------------------------------------------------------------------

  it("triggerType：升级部署行（statusMessage 含 Upgrade triggered）→ upgrade", async () => {
    versionRepo.findAndCount.mockResolvedValue([
      [
        versionRow("v-up", "3.0.0", {
          snapshot: {},
          sourceDeploymentId: "d-up",
        }),
      ],
      1,
    ]);
    deploymentRepo.find.mockImplementation(async (opts: any) => {
      const where = opts?.where ?? {};
      if (where.deployedVersion) {
        return [
          deploymentRow("d-up", {
            deployedVersion: "3.0.0",
            status: DeploymentStatus.UPGRADING,
            statusMessage: "Upgrade triggered",
            deployedAt: null,
          }),
        ];
      }
      return [];
    });
    const res = await service.getReleases("app-1");
    expect(res.data[0].triggerType).toBe("upgrade");
  });

  it("triggerType：新部署成功（deployedAt 已置位且无升级指纹）→ manual；PENDING 未推送 → unknown", async () => {
    versionRepo.findAndCount.mockResolvedValue([
      [
        versionRow("v-manual", "4.0.0", {
          snapshot: {},
          sourceDeploymentId: "d-manual",
        }),
      ],
      1,
    ]);
    deploymentRepo.find.mockImplementation(async (opts: any) => {
      const where = opts?.where ?? {};
      if (where.deployedVersion) {
        return [
          deploymentRow("d-manual", {
            deployedVersion: "4.0.0",
            statusMessage: "Deploy command sent to executor",
            deployedAt: new Date("2026-09-03T00:00:00Z"),
            createdAt: new Date("2026-09-03T00:00:00Z"),
          }),
        ];
      }
      return [];
    });
    const manualRes = await service.getReleases("app-1");
    expect(manualRes.data[0].triggerType).toBe("manual");

    // PENDING + 无 deployedAt + 无部署（source 查询返回空）→ null（无法判定）
    deploymentRepo.find.mockImplementation(async (opts: any) => {
      const where = opts?.where ?? {};
      if (where.deployedVersion) {
        return [
          deploymentRow("d-pending", {
            deployedVersion: "4.0.0",
            status: DeploymentStatus.PENDING,
            statusMessage: "Deploy command sent to executor",
            deployedAt: null,
            createdAt: new Date("2026-09-03T00:00:00Z"),
          }),
        ];
      }
      return [];
    });
    const pendingRes = await service.getReleases("app-1");
    // PENDING 行 deployedAt=null 且非升级指纹 → unknown
    expect(pendingRes.data[0].triggerType).toBe("unknown");
  });

  // ------------------------------------------------------------------
  // 分页与上限
  // ------------------------------------------------------------------

  it("分页：page 超出总页数返回空 data 但 total 不变", async () => {
    versionRepo.findAndCount.mockImplementation(async (opts: any) => {
      const all = [
        versionRow("v-a", "1.0.0", { snapshot: {} }),
        versionRow("v-b", "1.1.0", { snapshot: {} }),
      ];
      const skip = opts.skip ?? 0;
      const take = opts.take ?? 50;
      return [all.slice(skip, skip + take), all.length];
    });
    deploymentRepo.find.mockResolvedValue([]);

    const page1 = await service.getReleases("app-1", 1, 1);
    expect(page1.data.map((r) => r.id)).toEqual(["v-a"]);
    expect(page1.total).toBe(2);
    const page2 = await service.getReleases("app-1", 2, 1);
    expect(page2.data.map((r) => r.id)).toEqual(["v-b"]);
    const page3 = await service.getReleases("app-1", 3, 1);
    expect(page3.data).toEqual([]);
    expect(page3.total).toBe(2);
  });

  it("分页上限：pageSize 超过 200 被截断（防全表）", async () => {
    versionRepo.findAndCount.mockResolvedValue([[], 0]);
    deploymentRepo.find.mockResolvedValue([]);
    const res = await service.getReleases("app-1", 1, 9999);
    expect(res.pageSize).toBe(RELEASES_MAX_PAGE_SIZE);
    const takeArg = versionRepo.findAndCount.mock.calls[0][0].take;
    expect(takeArg).toBe(RELEASES_MAX_PAGE_SIZE);
  });

  it("默认 pageSize=50（不传参）", async () => {
    versionRepo.findAndCount.mockResolvedValue([[], 0]);
    deploymentRepo.find.mockResolvedValue([]);
    const res = await service.getReleases("app-1");
    expect(res.pageSize).toBe(50);
  });

  // ------------------------------------------------------------------
  // synthetic 行（有部署无快照的历史数据）
  // ------------------------------------------------------------------

  it("纯部署历史（无版本快照表行）：按 deployedVersion 聚合并只保留最近一次，__unknown__ 归一一行", async () => {
    versionRepo.findAndCount.mockResolvedValue([[], 0]);
    deploymentRepo.find.mockResolvedValue([
      deploymentRow("d-a-2", {
        deployedVersion: "0.9.0",
        deployedAt: new Date("2026-07-02T00:00:00Z"),
        createdAt: new Date("2026-07-02T00:00:00Z"),
        status: DeploymentStatus.FAILED,
      }),
      deploymentRow("d-a-1", {
        deployedVersion: "0.9.0",
        deployedAt: new Date("2026-07-01T00:00:00Z"),
        createdAt: new Date("2026-07-01T00:00:00Z"),
        status: DeploymentStatus.RUNNING,
      }),
      deploymentRow("d-unk", {
        deployedVersion: null,
        status: DeploymentStatus.RUNNING,
        deployedAt: new Date("2026-06-15T00:00:00Z"),
        createdAt: new Date("2026-06-15T00:00:00Z"),
      }),
    ]);

    const res = await service.getReleases("app-1");
    expect(res.total).toBe(0); // total 反映版本表行数（legacy 行不计，过渡期语义）
    expect(res.data.map((r) => r.version)).toEqual(["0.9.0", null]);
    const legacy = res.data.find((r) => r.version === "0.9.0")!;
    expect(legacy.synthetic).toBe(true);
    expect(legacy.latestDeploymentId).toBe("d-a-2"); // 最近一次 = FAILED
    expect(legacy.deploymentStatus).toBe(DeploymentStatus.FAILED);
    expect(legacy.deploymentCount).toBe(2);
    expect(legacy.packageUrl).toBeNull();
    expect(legacy.operatorMissingReason).toContain("createdBy");
    const unknown = res.data.find((r) => r.version === null)!;
    expect(unknown.latestDeploymentId).toBe("d-unk");
    expect(unknown.triggerType).toBe("manual"); // deployedAt 已置位且非升级指纹
  });

  // ------------------------------------------------------------------
  // 排序纯函数
  // ------------------------------------------------------------------

  it("releaseSortTimestampMs：deployedAt > latestDeploymentCreatedAt > versionCreatedAt，空/非法回退 0", () => {
    expect(
      releaseSortTimestampMs({
        deployedAt: new Date("2026-09-02T00:00:00Z"),
        latestDeploymentCreatedAt: new Date("2026-09-01T00:00:00Z"),
        versionCreatedAt: new Date("2026-08-01T00:00:00Z"),
      }),
    ).toBe(new Date("2026-09-02T00:00:00Z").getTime());
    expect(
      releaseSortTimestampMs({
        versionCreatedAt: new Date("2026-08-01T00:00:00Z"),
      }),
    ).toBe(new Date("2026-08-01T00:00:00Z").getTime());
    expect(releaseSortTimestampMs({})).toBe(0);
    expect(releaseSortTimestampMs({ deployedAt: "not-a-date" as any })).toBe(0);
  });
});

describe("ApplicationController GET /applications/:id/releases 鉴权元数据", () => {
  it("路由声明使用 JwtAuthGuard（类级）且未被 @Public 标记（默认 JWT 鉴权）", async () => {
    // 直接反射验证装饰器：控制器类在 @UseGuards(JwtAuthGuard) 之下，
    // releases 处理器不携带 IS_PUBLIC_KEY 元数据。
    const { ApplicationController } = await import("../application.controller");
    const isPublic = Reflect.getMetadata(
      IS_PUBLIC_KEY,
      ApplicationController.prototype.listReleases,
    );
    expect(isPublic).toBeUndefined();
    const guards = Reflect.getMetadata("__guards__", ApplicationController);
    expect(Array.isArray(guards) && guards.includes(JwtAuthGuard)).toBe(true);
  });

  it("releases 处理器委托 AppDeploymentService.getReleases（分页参数透传）", async () => {
    const { ApplicationController } = await import("../application.controller");
    const deploymentSvc = {
      getReleases: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    };
    const controller = new ApplicationController(
      {} as any,
      deploymentSvc as any,
      { get: () => undefined } as any,
    );
    await (controller as any).listReleases("app-1", { page: 2, pageSize: 7 });
    expect(deploymentSvc.getReleases).toHaveBeenCalledWith("app-1", 2, 7);
  });
});
