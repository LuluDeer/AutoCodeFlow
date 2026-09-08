import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { AppDeploymentService } from "../app-deployment.service";
import {
  AppDeployment,
  DeploymentStatus,
  DeploymentTriggerType,
  RunMode,
} from "../entities/app-deployment.entity";
import { ApplicationVersion } from "../entities/application-version.entity";
import { ApplicationService } from "../application.service";
import { ExecutorService } from "../../executor/executor.service";

/**
 * FEAT-20（迁移 1790000000004）：部署写面 triggerType/operator 落库断言。
 * 覆盖 deploy（manual）、upgrade（upgrade）、upgrade-all、rollback、
 * approve（approval）各写面 + /releases 聚合读面两字段透出。
 */
jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn().mockResolvedValue({ data: {} }) },
}));
import axios from "axios";
const mockAxiosPost = axios.post as jest.Mock;

jest.mock("node:dns/promises", () => ({ lookup: jest.fn() }));
import { lookup } from "node:dns/promises";
const mockedLookup = lookup as unknown as jest.Mock;

const makeRepo = (overrides: Partial<Record<string, jest.Mock>> = {}) => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findAndCount: jest.fn(),
  create: jest.fn((d: any) => ({ ...d, id: d.id ?? "deploy-1" })),
  save: jest.fn((e: any) => Promise.resolve({ ...e, id: e.id ?? "deploy-1" })),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  ...overrides,
});

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
  approvalRequired: false,
};

const mockExecutor = { id: "exec-1", address: "http://executor:3001" };

describe("AppDeploymentService — FEAT-20 triggerType/operator 落库", () => {
  let service: AppDeploymentService;
  let repo: ReturnType<typeof makeRepo>;
  let versionRepo: ReturnType<typeof makeRepo>;
  let appService: any;
  let executorService: any;

  beforeEach(async () => {
    repo = makeRepo();
    versionRepo = makeRepo();
    appService = {
      findById: jest.fn().mockResolvedValue(mockApp),
      findByIdRaw: jest.fn().mockResolvedValue(mockApp),
      update: jest.fn((_: string, dto: any) =>
        Promise.resolve({ ...mockApp, ...dto }),
      ),
      maskEnvForRead: jest.fn((env: any) => env),
      maskReadSurface: jest.fn((app: any) => app),
    };
    executorService = {
      findOne: jest.fn().mockResolvedValue(mockExecutor),
      getExecutorUrl: jest.fn(
        (addr: string, p: string) => `${addr}/${p}`,
      ),
      getSharedToken: jest.fn().mockResolvedValue(""),
      selectLeastLoaded: jest.fn().mockResolvedValue(mockExecutor),
    };

    const module = await Test.createTestingModule({
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
      ],
    }).compile();

    service = module.get(AppDeploymentService);
    mockAxiosPost.mockClear().mockResolvedValue({ data: {} });
    mockedLookup.mockReset();
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  it("deploy 落 triggerType=manual + operator=JWT 用户名", async () => {
    repo.findOne.mockResolvedValue(null); // 无 in-flight
    await service.deploy("app-1", { runMode: RunMode.DAEMON }, undefined, {
      operator: "alice",
      triggerType: DeploymentTriggerType.MANUAL,
    });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerType: "manual",
        operator: "alice",
      }),
    );
  });

  it("deploy 审批分支（approvalRequired）同样落 manual + 提交人", async () => {
    repo.findOne.mockResolvedValue(null);
    appService.findByIdRaw.mockResolvedValue({ ...mockApp, approvalRequired: true });

    await service.deploy(
      "app-1",
      { runMode: RunMode.DAEMON },
      { id: 7, name: "alice" },
      { operator: "alice", triggerType: DeploymentTriggerType.MANUAL },
    );

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: DeploymentStatus.PENDING,
        approvalStatus: "pending_approval",
        triggerType: "manual",
        operator: "alice",
      }),
    );
  });

  it("upgrade 落 triggerType=upgrade + operator（行复用升级覆写为最近动作）", async () => {
    const row = {
      id: "deploy-1",
      applicationId: "app-1",
      status: DeploymentStatus.RUNNING,
      triggerType: "manual",
      operator: "bob",
    };
    repo.findOne.mockResolvedValue(row);

    await service.upgrade("deploy-1", {
      operator: "carol",
      triggerType: DeploymentTriggerType.UPGRADE,
    });

    const saved = repo.save.mock.calls.map(([e]: any[]) => e)[0];
    expect(saved.triggerType).toBe("upgrade");
    expect(saved.operator).toBe("carol");
  });

  it("upgrade-all（all 模式）把 trigger 上下文透传给逐台 upgrade", async () => {
    const rows = [
      { id: "d1", applicationId: "app-1", status: DeploymentStatus.RUNNING },
      { id: "d2", applicationId: "app-1", status: DeploymentStatus.RUNNING },
    ];
    repo.find.mockResolvedValue(rows);
    const upSpy = jest
      .spyOn(service, "upgrade")
      .mockResolvedValue(rows[0] as any);

    await service.upgradeAllWithRollout(
      "app-1",
      null,
      { operator: "carol", triggerType: DeploymentTriggerType.UPGRADE },
    );

    expect(upSpy).toHaveBeenCalledWith("d1", {
      operator: "carol",
      triggerType: "upgrade",
    });
    expect(upSpy).toHaveBeenCalledWith("d2", {
      operator: "carol",
      triggerType: "upgrade",
    });
  });

  it("rollbackApplication 快照路径逐台落 triggerType=rollback + operator", async () => {
    versionRepo.findOne.mockResolvedValue({
      id: "ver-1",
      applicationId: "app-1",
      version: "0.9.0",
      gitCommit: "def456",
      status: "released",
      snapshot: { packageUrl: "http://pkg/0.9.0" },
    });
    repo.find.mockResolvedValue([
      { id: "d1", applicationId: "app-1", status: DeploymentStatus.RUNNING },
    ]);
    // upgrade() 内部 findByIdRaw("d1") 走 repo.findOne；断言落库行已带
    // rollback 痕迹（push 失败的 FAILED 分支同样保留 trigger 字段）。
    repo.findOne.mockResolvedValue({
      id: "d1",
      applicationId: "app-1",
      status: DeploymentStatus.RUNNING,
      approvalStatus: null,
      executorAddress: mockExecutor.address,
    });

    await service.rollbackApplication("app-1", "ver-1", {
      operator: "alice",
      triggerType: DeploymentTriggerType.ROLLBACK,
    });

    const upgradeSave = repo.save.mock.calls
      .map(([e]: any[]) => e)
      .find((e: any) => e.triggerType === "rollback");
    expect(upgradeSave.operator).toBe("alice");
  });

  it("approveDeployment 覆写为 approval 语义 + 审批人（提交痕迹在 approvalMeta）", async () => {
    repo.findOne.mockResolvedValue({
      id: "deploy-1",
      applicationId: "app-1",
      status: DeploymentStatus.PENDING,
      approvalStatus: "pending_approval",
      approvalMeta: { requestedBy: 7, requestedByName: "alice" },
      executorAddress: mockExecutor.address,
    });

    const result = await service.approveDeployment(
      "deploy-1",
      { id: 9, name: "carol" },
      undefined,
      { operator: "carol", triggerType: DeploymentTriggerType.APPROVAL },
    );

    expect(result.triggerType).toBe("approval");
    expect(result.operator).toBe("carol");
    // 第二人规则痕迹仍在
    expect(result.approvalMeta.requestedByName).toBe("alice");
    expect(result.approvalMeta.actedByName).toBe("carol");
  });

  it("GET 列表（findAll）与 findById 原样透出 triggerType/operator（掩码面不丢列）", async () => {
    const row = {
      id: "deploy-1",
      status: DeploymentStatus.RUNNING,
      triggerType: "manual",
      operator: "alice",
      env: { A: "1" },
      application: { env: null },
    };
    repo.findOne.mockResolvedValue(row);
    repo.findAndCount.mockResolvedValue([[row], 1]);

    const listed = await service.findAll("app-1");
    expect(listed.data[0].triggerType).toBe("manual");
    expect(listed.data[0].operator).toBe("alice");

    const single = await service.findById("deploy-1");
    expect(single.triggerType).toBe("manual");
    expect(single.operator).toBe("alice");
  });

  it("/releases 聚合行：部署行持久化列优先（rollback 值直读），operatorSource 随命中面标注", async () => {
    versionRepo.findAndCount.mockResolvedValue([
      [
        {
          id: "ver-1",
          version: "1.0.0",
          gitCommit: "abc123",
          snapshot: { packageUrl: "http://pkg/1.0.0" },
          sourceDeploymentId: null,
          status: "released",
          createdBy: null,
          createdAt: new Date("2026-01-01T00:00:00Z"),
        },
      ],
      1,
    ]);
    // getReleases：repo.find 首次 = 部署行聚合，第二次 = 全部署（synthetic 面）；
    // versionRepo.find = 快照版本号面
    repo.find
      .mockResolvedValueOnce([
        {
          id: "d1",
          deployedVersion: "1.0.0",
          status: "running",
          executorAddress: "http://executor:3001",
          runMode: "daemon",
          deployedAt: new Date("2026-01-02T00:00:00Z"),
          createdAt: new Date("2026-01-01T12:00:00Z"),
          // FEAT-20 持久化列：rollback 直读，不走 statusMessage 推导
          triggerType: "rollback",
          operator: "alice",
        },
      ])
      .mockResolvedValueOnce([]);
    versionRepo.find.mockResolvedValue([{ version: "1.0.0" }]);

    const res = await service.getReleases("app-1");
    expect(res.data[0].triggerType).toBe("rollback");
    expect(res.data[0].operator).toBe("alice");
    expect(res.data[0].operatorSource).toBe("deployments.operator");
    expect(res.data[0].operatorMissingReason).toBe("");
  });

  it("/releases 存量行（列 null）回退推导 + createdBy，来源标注回退面", async () => {
    versionRepo.findAndCount.mockResolvedValue([
      [
        {
          id: "ver-2",
          version: "0.9.0",
          gitCommit: "def456",
          snapshot: {},
          sourceDeploymentId: null,
          status: "released",
          createdBy: "ops@corp",
          createdAt: new Date("2026-01-01T00:00:00Z"),
        },
      ],
      1,
    ]);
    versionRepo.find.mockResolvedValue([{ version: "0.9.0" }]);
    repo.find
      .mockResolvedValueOnce([
        {
          id: "d2",
          deployedVersion: "0.9.0",
          status: "running",
          executorAddress: "http://executor:3001",
          runMode: "daemon",
          deployedAt: new Date("2026-01-02T00:00:00Z"),
          createdAt: new Date("2026-01-01T12:00:00Z"),
          triggerType: null, // 存量行
          operator: null,
        },
      ])
      .mockResolvedValueOnce([]);

    const res = await service.getReleases("app-1");
    expect(res.data[0].triggerType).toBe("manual"); // deployedAt 置位 + 无升级指纹
    expect(res.data[0].operator).toBe("ops@corp");
    expect(res.data[0].operatorSource).toBe("application_versions.createdBy");
    // operator 有回退命中（createdBy）时不再缺失标注
    expect(res.data[0].operatorMissingReason).toBe("");
  });
});
