/**
 * R3-A（部署模型评审 2026-10-23 §4.3）：GET /applications/:id/releases 版本行的
 * **设备徽标**（devices）聚合——数据来自设备心跳上报的事实
 * （ExecutorService.getAppVersionFacts），不是部署行推断。
 *
 * 覆盖：running/retained 判定（currentVersion 命中 / retainedVersions 命中/
 * 双命中）、无关设备不混入、无任何设备上报时 devices 恒空数组（旧执行器混合
 * 窗口期，其余字段原样）、synthetic 行同享徽标。
 * 聚合正确性（版本×部署）基础断言见 app-releases.spec.ts。
 */
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  AppDeploymentService,
  RELEASES_SYNTHETIC_SCAN_PAGE_SIZE,
} from "../app-deployment.service";
import {
  AppDeployment,
  DeploymentStatus,
  RunMode,
} from "../entities/app-deployment.entity";
import { ApplicationVersion } from "../entities/application-version.entity";
import { ApplicationService } from "../application.service";
import { ExecutorService } from "../../executor/executor.service";
import { ConfigService } from "@nestjs/config";

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
    deployedVersion: null,
    deployedAt: new Date("2026-09-01T01:00:00Z"),
    createdAt: new Date("2026-09-01T01:00:00Z"),
    updatedAt: new Date("2026-09-01T01:00:00Z"),
    statusMessage: "Deploy command sent to executor",
    env: null,
    ...overrides,
  }) as AppDeployment;

describe("AppDeploymentService.getReleases devices 聚合（R3-A §4.3）", () => {
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
  let executorService: { getAppVersionFacts: jest.Mock };

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
    executorService = { getAppVersionFacts: jest.fn().mockResolvedValue([]) };

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
        { provide: ExecutorService, useValue: executorService },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    service = moduleRef.get(AppDeploymentService);
  });

  it("devices 列「currentVersion === 版本 或 ∈ retainedVersions」的设备；retained 如实标注", async () => {
    versionRepo.findAndCount.mockResolvedValue([
      [versionRow("v-1", "1.2.0"), versionRow("v-2", "1.1.0")],
      2,
    ]);
    executorService.getAppVersionFacts.mockResolvedValue([
      // exec-a 正在跑 1.2.0（同时保留 1.1.0 → 两行都出现）
      {
        executorId: "exec-a",
        executorName: "node-a",
        currentVersion: "1.2.0",
        retainedVersions: ["1.2.0", "1.1.0"],
        online: true,
        lastHeartbeat: "2026-10-24T08:00:00.000Z",
      },
      // exec-b current 指向别版但保留 1.1.0 → 只出现在 1.1.0 行（retained-only）
      {
        executorId: "exec-b",
        executorName: "node-b",
        currentVersion: "2.0.0",
        retainedVersions: ["1.1.0"],
        online: false,
        lastHeartbeat: "2026-10-01T08:00:00.000Z",
      },
      // exec-c 与两版都无关 → 不出现在任何行
      {
        executorId: "exec-c",
        executorName: "node-c",
        currentVersion: "3.0.0",
        retainedVersions: [],
        online: true,
        lastHeartbeat: null,
      },
    ]);

    const res = await service.getReleases("app-1", 1, 50);
    const row120 = res.data.find((r) => r.version === "1.2.0")!;
    const row110 = res.data.find((r) => r.version === "1.1.0")!;

    expect(row120.devices).toHaveLength(1);
    expect(row120.devices![0]).toEqual({
      executorId: "exec-a",
      executorName: "node-a",
      currentVersion: "1.2.0",
      retained: true,
      online: true,
      lastHeartbeat: "2026-10-24T08:00:00.000Z",
    });
    expect(row110.devices).toHaveLength(2);
    const byId = new Map(row110.devices!.map((d) => [d.executorId, d]));
    // 正在跑 1.1.0 的设备不存在（exec-a current 是 1.2.0）→ 1.1.0 行上两台都
    // 是「保留」语义（retained=true；exec-a 是「双保留」之一）
    expect(byId.get("exec-a")?.retained).toBe(true);
    expect(byId.get("exec-a")?.currentVersion).toBe("1.2.0");
    expect(byId.get("exec-b")?.retained).toBe(true);
    expect(byId.get("exec-b")?.online).toBe(false);
    expect(byId.get("exec-b")?.lastHeartbeat).toBe("2026-10-01T08:00:00.000Z");
  });

  it("无任何设备上报（旧执行器混合窗口期）→ devices 恒空数组，部署推断字段原样保留", async () => {
    versionRepo.findAndCount.mockResolvedValue([
      [versionRow("v-1", "1.0.0")],
      1,
    ]);
    deploymentRepo.find.mockResolvedValue([
      deploymentRow("dep-1", { deployedVersion: "1.0.0" }),
    ]);
    // synthetic 去重需要全量快照版本集合（1.0.0 已有快照行 → 不重复出合成行）
    versionRepo.find.mockResolvedValue([versionRow("v-1", "1.0.0")]);

    const res = await service.getReleases("app-1", 1, 50);
    expect(res.data).toHaveLength(1);
    const row = res.data[0];
    expect(row.devices).toEqual([]);
    // 推断字段保留不动（渐进迁移红线）
    expect(row.deploymentStatus).toBe(DeploymentStatus.RUNNING);
    expect(row.executorAddress).toBe("http://exec-a:3001");
    expect(row.deploymentCount).toBe(1);
  });

  it("synthetic 行同享设备徽标（孤儿 deployedVersion 版本串）；__unknown__ 行恒空", async () => {
    // 无快照行 + 部署行有 deployedVersion=9.9.9 → synthetic 聚合行
    versionRepo.findAndCount.mockResolvedValue([[], 0]);
    deploymentRepo.find.mockResolvedValue([
      deploymentRow("dep-x", {
        deployedVersion: "9.9.9",
        status: DeploymentStatus.STOPPED,
      }),
      deploymentRow("dep-y", { deployedVersion: null }),
    ]);
    executorService.getAppVersionFacts.mockResolvedValue([
      {
        executorId: "exec-a",
        executorName: "node-a",
        currentVersion: "9.9.9",
        retainedVersions: [],
        online: true,
        lastHeartbeat: "2026-10-24T08:00:00.000Z",
      },
    ]);

    const res = await service.getReleases("app-1", 1, 50);
    const synthetic99 = res.data.find((r) => r.version === "9.9.9")!;
    expect(synthetic99.synthetic).toBe(true);
    expect(synthetic99.devices).toHaveLength(1);
    expect(synthetic99.devices![0].executorId).toBe("exec-a");
    // __unknown__（deployedVersion 为空的合成行）无版本可比对 → 恒空
    const unknown = res.data.find((r) => r.version === null)!;
    expect(unknown.devices).toEqual([]);
    // 未截断 → retainedButTruncated 恒空数组（字段只增不改）
    expect(res.retainedButTruncated).toEqual([]);
  });

  // ------------------------------------------------------------------
  // P8-R（部署模型评审遗留）：truncated 截断吞掉被截版本的 devices 徽标 →
  // retainedButTruncated 用同一份全应用设备事实求差集，把「有设备保留但
  // 不在本页行中」的版本号显式带回（事实不因分页截断而消失）。
  // ------------------------------------------------------------------
  it("truncated=true：设备保留的版本不在本页行中 → retainedButTruncated 列出该版本号", async () => {
    // 无快照行 → 第 1 页跑 synthetic 扫描；页页扫满到 5000 上限触发 truncated
    versionRepo.findAndCount.mockResolvedValue([[], 0]);
    const fullPage = Array.from(
      { length: RELEASES_SYNTHETIC_SCAN_PAGE_SIZE },
      (_, i) => deploymentRow(`d-${i}`, { deployedVersion: "5.0.0" }),
    );
    deploymentRepo.find.mockResolvedValue(fullPage);
    // 设备事实：一台正跑 5.0.0（页内 synthetic 行可见），另一台保留 0.9.0
    // 与 1.0.0（被截部分——不在任何返回行中，只能靠差集带回）
    executorService.getAppVersionFacts.mockResolvedValue([
      {
        executorId: "exec-a",
        executorName: "node-a",
        currentVersion: "5.0.0",
        retainedVersions: [],
        online: true,
        lastHeartbeat: "2026-10-24T08:00:00.000Z",
      },
      {
        executorId: "exec-b",
        executorName: "node-b",
        currentVersion: "1.0.0",
        retainedVersions: ["0.9.0"],
        online: false,
        lastHeartbeat: null,
      },
    ]);

    const res = await service.getReleases("app-1", 1, 50);

    expect(res.truncated).toBe(true);
    // currentVersion(1.0.0) 命中 + retainedVersions(0.9.0) 命中，且都不在
    // 本页行中；5.0.0 在页内（synthetic 行）不计入；字母序确定性输出
    expect(res.retainedButTruncated).toEqual(["0.9.0", "1.0.0"]);
  });

  it("truncated=true 但被截版本无任何设备保留 → retainedButTruncated 空数组", async () => {
    versionRepo.findAndCount.mockResolvedValue([[], 0]);
    const fullPage = Array.from(
      { length: RELEASES_SYNTHETIC_SCAN_PAGE_SIZE },
      (_, i) => deploymentRow(`d-${i}`, { deployedVersion: "5.0.0" }),
    );
    deploymentRepo.find.mockResolvedValue(fullPage);
    // 设备保留的恰是页内版本 5.0.0 → 差集为空
    executorService.getAppVersionFacts.mockResolvedValue([
      {
        executorId: "exec-a",
        executorName: "node-a",
        currentVersion: "5.0.0",
        retainedVersions: ["5.0.0"],
        online: true,
        lastHeartbeat: "2026-10-24T08:00:00.000Z",
      },
    ]);

    const res = await service.getReleases("app-1", 1, 50);

    expect(res.truncated).toBe(true);
    expect(res.retainedButTruncated).toEqual([]);
  });

  it("truncated=false → 不做差集计算，retainedButTruncated 恒空数组", async () => {
    versionRepo.findAndCount.mockResolvedValue([
      [versionRow("v-1", "1.2.0")],
      1,
    ]);
    // 设备保留的是不在本页的 0.9.0——但未截断（版本表分页完整，0.9.0 在
    // 后续页可见），差集不适用，恒空
    executorService.getAppVersionFacts.mockResolvedValue([
      {
        executorId: "exec-b",
        executorName: "node-b",
        currentVersion: "0.9.0",
        retainedVersions: [],
        online: true,
        lastHeartbeat: null,
      },
    ]);

    const res = await service.getReleases("app-1", 1, 50);

    expect(res.truncated).toBe(false);
    expect(res.retainedButTruncated).toEqual([]);
  });
});
