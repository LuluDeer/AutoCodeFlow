/**
 * R3-A（部署模型评审 2026-10-23 §九 9.3-1 硬要求）：resolveVersionFollowPackage
 * 的版本来源切换——**设备上报事实**（executor_app_versions.currentVersion）优先，
 * 无上报行 / currentVersion=null / 读失败 → 回退既有部署行推断
 * （pickDeploymentVersionForExecutor）。函数对外行为签名不变，只改判据来源。
 *
 * 私有方法经 (service as any) 直调（先例 executor.mutex-claim.spec）——
 * 经 dispatch 单发路径黑盒驱动需要整条候选池/闸门装配，判据本身是纯解析层。
 */
import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { getRepositoryToken } from "@nestjs/typeorm";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ExecutorService } from "../executor.service";
import { Executor, ExecutorStatus } from "../entities/executor.entity";
import { ExecutorMetricsHistory } from "../entities/executor-metrics-history.entity";
import { ExecutorAppVersion } from "../entities/executor-app-version.entity";
import { ApplicationVersion } from "../../application/entities/application-version.entity";
import { Task } from "../../task/entities/task.entity";
import { TaskExecution } from "../../task/entities/task-execution.entity";
import {
  AppDeployment,
  DeploymentStatus,
} from "../../application/entities/app-deployment.entity";
import { NotificationService } from "../../notification/notification.service";
import { SystemConfigService } from "../../config/config.service";
import { SecretsCryptoService } from "../../../common/utils/secret-crypto.util.service";

const makeRepo = () => {
  const repo: Record<string, jest.Mock> = {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn((d: unknown) => d),
    save: jest.fn(async (e: unknown) => e),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  repo.createQueryBuilder = jest.fn(() => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getOne: jest.fn().mockResolvedValue(null),
  }));
  return repo;
};

const matchedExecutor = {
  id: "exec-1",
  address: "http://exec-a:3001",
  status: ExecutorStatus.ONLINE,
} as Executor;

const deploymentRow = (over: Partial<AppDeployment> = {}): AppDeployment =>
  ({
    id: "dep-1",
    applicationId: "app-1",
    executorId: "exec-1",
    executorAddress: "http://exec-a:3001",
    status: DeploymentStatus.RUNNING,
    deployedVersion: "1.0.0",
    deployedAt: new Date("2026-09-01T00:00:00Z"),
    createdAt: new Date("2026-09-01T00:00:00Z"),
    ...over,
  }) as AppDeployment;

const task = { id: "t-1", name: "demo-task", applicationId: "app-1" } as Task;

const snapshotRow = (version: string, packageUrl: string | null) =>
  ({
    id: `ver-${version}`,
    applicationId: "app-1",
    version,
    snapshot: packageUrl ? { packageUrl } : {},
  }) as unknown as {
    applicationId: string;
    version: string;
    snapshot: Record<string, unknown>;
  };

describe("R3-A §九 9.3-1 — resolveVersionFollowPackage 判据切换到设备上报", () => {
  let service: ExecutorService;
  let appVersionRepo: ReturnType<typeof makeRepo>;
  let versionRepo: ReturnType<typeof makeRepo>;
  let warnSpy: jest.SpyInstance;

  const buildService = async (): Promise<ExecutorService> => {
    const module = await Test.createTestingModule({
      providers: [
        ExecutorService,
        { provide: getRepositoryToken(Executor), useValue: makeRepo() },
        { provide: getRepositoryToken(TaskExecution), useValue: makeRepo() },
        { provide: getRepositoryToken(Task), useValue: makeRepo() },
        {
          provide: getRepositoryToken(ExecutorMetricsHistory),
          useValue: makeRepo(),
        },
        {
          provide: getRepositoryToken(ExecutorAppVersion),
          useValue: appVersionRepo,
        },
        {
          provide: getRepositoryToken(ApplicationVersion),
          useValue: versionRepo,
        },
        { provide: getQueueToken("task-queue"), useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: NotificationService,
          useValue: {
            notifyFailure: jest.fn(),
            notifyExecutorOnline: jest.fn().mockResolvedValue(undefined),
            notifyExecutorOffline: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: SystemConfigService,
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as any),
        },
      ],
    }).compile();
    return module.get(ExecutorService);
  };

  beforeEach(async () => {
    appVersionRepo = makeRepo();
    versionRepo = makeRepo();
    warnSpy = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
    service = await buildService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("设备上报优先：currentVersion=1.1.0 → 用 1.1.0 快照包，部署行推断（1.0.0）让位", async () => {
    appVersionRepo.findOne.mockResolvedValue({ currentVersion: "1.1.0" });
    versionRepo.findOne.mockResolvedValue(
      snapshotRow("1.1.0", "http://api/uploads/packages/app_1.1.0.zip"),
    );
    const res = await (service as any).resolveVersionFollowPackage(
      task,
      matchedExecutor,
      [deploymentRow({ deployedVersion: "1.0.0" })],
    );
    expect(res).toEqual({
      version: "1.1.0",
      packageUrl: "http://api/uploads/packages/app_1.1.0.zip",
    });
    // 事实查询按 (applicationId, executorId) 命中——事实行恒有行身份，无 address 兜底
    expect(appVersionRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { applicationId: "app-1", executorId: "exec-1" },
      }),
    );
    // 版本快照按**设备事实版本**解析，而不是部署行版本
    expect(versionRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { applicationId: "app-1", version: "1.1.0" },
      }),
    );
  });

  it("无上报行（旧执行器混合窗口期）→ 回退部署行推断（running 优先、最新 deployedAt）", async () => {
    appVersionRepo.findOne.mockResolvedValue(null);
    versionRepo.findOne.mockResolvedValue(
      snapshotRow("1.0.0", "http://api/uploads/packages/app_1.0.0.zip"),
    );
    const res = await (service as any).resolveVersionFollowPackage(
      task,
      matchedExecutor,
      [
        deploymentRow({
          id: "dep-old",
          deployedVersion: "0.9.0",
          deployedAt: new Date("2026-08-01T00:00:00Z"),
        }),
        deploymentRow({
          id: "dep-new",
          deployedVersion: "1.0.0",
          deployedAt: new Date("2026-09-01T00:00:00Z"),
        }),
      ],
    );
    expect(res).toEqual({
      version: "1.0.0",
      packageUrl: "http://api/uploads/packages/app_1.0.0.zip",
    });
  });

  it("上报行 currentVersion=null（设备自报无 current）→ 回退部署行推断", async () => {
    appVersionRepo.findOne.mockResolvedValue({ currentVersion: null });
    versionRepo.findOne.mockResolvedValue(
      snapshotRow("1.0.0", "http://api/uploads/packages/app_1.0.0.zip"),
    );
    const res = await (service as any).resolveVersionFollowPackage(
      task,
      matchedExecutor,
      [deploymentRow()],
    );
    expect(res?.version).toBe("1.0.0");
  });

  it("事实读失败 → warn + 回退部署行推断（绝不因版本跟随阻断派发）", async () => {
    appVersionRepo.findOne.mockRejectedValue(new Error("db down"));
    versionRepo.findOne.mockResolvedValue(
      snapshotRow("1.0.0", "http://api/uploads/packages/app_1.0.0.zip"),
    );
    const res = await (service as any).resolveVersionFollowPackage(
      task,
      matchedExecutor,
      [deploymentRow()],
    );
    expect(res?.version).toBe("1.0.0");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("读取设备版本事实失败"),
    );
  });

  it("设备上报版本的快照无 packageUrl → 回退当前版（null，同既有兜底）", async () => {
    appVersionRepo.findOne.mockResolvedValue({ currentVersion: "1.1.0" });
    versionRepo.findOne.mockResolvedValue(snapshotRow("1.1.0", null));
    const res = await (service as any).resolveVersionFollowPackage(
      task,
      matchedExecutor,
      [deploymentRow()],
    );
    // 快照无包地址 → 整体不成立，**不**再回退部署行版本（事实优先：设备确实
    // 跑 1.1.0，只是中台拿不到它的包；下发给 1.0.0 反而违背「设备上是什么
    // 版本就跑什么版本」）。回退语义 = 应用当前版。
    expect(res).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("无 packageUrl"),
    );
  });

  it("两层来源都无版本痕迹（legacy 部署行 + 无事实行）→ null（应用当前版）", async () => {
    appVersionRepo.findOne.mockResolvedValue(null);
    const res = await (service as any).resolveVersionFollowPackage(
      task,
      matchedExecutor,
      [deploymentRow({ deployedVersion: null })],
    );
    expect(res).toBeNull();
  });
});
