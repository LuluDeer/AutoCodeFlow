/**
 * impl-apprelease-contract：后端 /releases 行契约定向测试。
 *
 * 验收级别：单测（内存仓储替身）。钉住三件事：
 *   1. 版本快照行的 sourceDeploymentId/status/createdAt/synthetic 由真投影填值；
 *   2. 无快照的部署记录合成行 synthetic=true 且深链字段仍完整；
 *   3. AppReleaseRowDto 已把这四个 UI 已消费字段纳入公开契约。
 */
import { Logger } from "@nestjs/common";
import {
  AppDeploymentReleaseView,
  type AppDeploymentReleaseViewDeps,
} from "../app-deployment-release-view.collaborator";
import type { AppDeployment } from "../entities/app-deployment.entity";
import { DeploymentStatus } from "../entities/app-deployment.entity";
import type { ApplicationVersion } from "../entities/application-version.entity";
import type { AppReleaseRowDto } from "../dto/application-response.dto";

function makeDeps(over: Partial<AppDeploymentReleaseViewDeps> = {}) {
  const repoFind = jest.fn();
  const versionFindAndCount = jest.fn();
  const versionFind = jest.fn();

  const deps: AppDeploymentReleaseViewDeps = {
    repo: {
      find: repoFind,
      findAndCount: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      insert: jest.fn(),
    } as never,
    versionRepo: {
      find: versionFind,
      findAndCount: versionFindAndCount,
      findOne: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    } as never,
    deploymentEventRepo: null,
    appService: {
      maskEnvForRead: (env: unknown) => env,
    } as never,
    executorService: {
      getAppVersionFacts: jest.fn().mockResolvedValue([]),
    } as never,
    findAllByApp: jest.fn().mockResolvedValue([]),
    logger: {
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      log: jest.fn(),
    } as unknown as Logger,
    ...over,
  };
  return { deps, repoFind, versionFindAndCount, versionFind };
}

const versionRow = (
  over: Partial<ApplicationVersion> = {},
): ApplicationVersion =>
  ({
    id: "ver-contract-1",
    applicationId: "app-contract-1",
    version: "1.2.0",
    gitCommit: "abc123",
    snapshot: { packageUrl: "https://pkg.example/1.2.0.zip" },
    sourceDeploymentId: "dep-source-1",
    status: "deploying",
    createdBy: "alice",
    description: null,
    createdAt: new Date("2026-11-27T01:02:03.000Z"),
    ...over,
  }) as unknown as ApplicationVersion;

const deploymentRow = (over: Partial<AppDeployment> = {}): AppDeployment =>
  ({
    id: "dep-latest-1",
    applicationId: "app-contract-1",
    deployedVersion: "1.2.0",
    deployedCommit: "abc123",
    status: DeploymentStatus.RUNNING,
    deployedAt: new Date("2026-11-27T02:03:04.000Z"),
    createdAt: new Date("2026-11-27T02:00:00.000Z"),
    executorAddress: "10.0.0.9:3002",
    runMode: "daemon",
    operator: "bob",
    triggerType: "manual",
    statusMessage: null,
    ...over,
  }) as unknown as AppDeployment;

describe("AppReleaseRowDto 契约字段（impl-apprelease-contract）", () => {
  it("DTO 公开面包含 UI 已消费四字段", () => {
    // 编译期证明 keyof 已含四字段；运行期断言投影形状同型。
    const dto: Pick<
      AppReleaseRowDto,
      "sourceDeploymentId" | "status" | "createdAt" | "synthetic"
    > = {
      sourceDeploymentId: "dep-source-1",
      status: "deploying",
      createdAt: "2026-11-27T01:02:03.000Z",
      synthetic: false,
    };
    expect(dto).toMatchObject({
      sourceDeploymentId: "dep-source-1",
      status: "deploying",
      createdAt: "2026-11-27T01:02:03.000Z",
      synthetic: false,
    });
  });

  it("真投影：版本快照行四字段有值且深链键不丢", async () => {
    const { deps, repoFind, versionFindAndCount, versionFind } = makeDeps();
    const v = versionRow();
    versionFindAndCount.mockResolvedValue([[v], 1]);
    versionFind.mockResolvedValue([v]);
    repoFind.mockImplementation(
      (opts: { where?: { deployedVersion?: unknown } }) =>
        Promise.resolve(opts?.where?.deployedVersion ? [deploymentRow()] : []),
    );

    const out = await new AppDeploymentReleaseView(deps).getReleases(
      "app-contract-1",
    );
    const row = out.data.find((r) => r.version === "1.2.0")!;

    expect(row).toMatchObject({
      id: "ver-contract-1",
      version: "1.2.0",
      latestDeploymentId: "dep-latest-1",
      sourceDeploymentId: "dep-source-1",
      status: "deploying",
      createdAt: "2026-11-27T01:02:03.000Z",
      synthetic: false,
    });
    expect(row.sourceDeploymentId).toBe(v.sourceDeploymentId);
    expect(row.status).toBe(v.status);
    expect(row.createdAt).toBe(v.createdAt.toISOString());
  });

  it("合成行：synthetic=true 且 sourceDeploymentId/status/createdAt 真填值", async () => {
    const { deps, repoFind, versionFindAndCount } = makeDeps();
    versionFindAndCount.mockResolvedValue([[], 0]);
    const synthetic = deploymentRow({
      id: "dep-synthetic-1",
      deployedVersion: "9.9.9",
      status: DeploymentStatus.RUNNING,
      deployedAt: new Date("2026-11-27T03:04:05.000Z"),
    });
    repoFind.mockImplementation(
      (opts: { where?: { deployedVersion?: unknown } }) =>
        Promise.resolve(opts?.where?.deployedVersion ? [] : [synthetic]),
    );

    const out = await new AppDeploymentReleaseView(deps).getReleases(
      "app-contract-1",
    );
    const row = out.data.find((r) => r.synthetic)!;

    expect(row).toMatchObject({
      id: null,
      version: "9.9.9",
      latestDeploymentId: "dep-synthetic-1",
      sourceDeploymentId: "dep-synthetic-1",
      status: "running",
      createdAt: "2026-11-27T03:04:05.000Z",
      synthetic: true,
    });
    // 深链白名单键（id / latestDeploymentId / sourceDeploymentId / version / createdAt）
    // 一个都不能因新增 DTO 字段而丢失或改语义。
    expect(Object.keys(row)).toEqual(
      expect.arrayContaining([
        "id",
        "latestDeploymentId",
        "sourceDeploymentId",
        "version",
        "createdAt",
      ]),
    );
  });
});
