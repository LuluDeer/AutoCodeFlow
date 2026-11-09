import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConflictException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppDeploymentService } from "../app-deployment.service";
import {
  AppDeployment,
  DeploymentStatus,
  RunMode,
} from "../entities/app-deployment.entity";
import { ApplicationVersion } from "../entities/application-version.entity";
import { ApplicationService } from "../application.service";
import { ExecutorService } from "../../executor/executor.service";
import { controlPlaneMocks } from "../../../common/testing/control-plane-mocks";

/**
 * R179：**并发「重新部署」复用同一行** —— 真并发回归（只有一次能赢）。
 *
 * ## 为什么单独立文件，而不塞进 `app-deployment.service.spec.ts`
 *
 * 那边已有的那条 `R179: 并发双击复用行 ⇒ CAS affected=0 ⇒ 409` 是**顺序**用例：
 * 它把 `execute()` mock 成恒返回 `affected: 0`，证明的是「CAS 输掉时会抛 409」。
 * 它**证明不了**本缺陷的正题 —— 两个请求**同时在飞**时是否真的只有一个赢家。
 * 而旧实现（`save()` 整行写回）在真并发下是「两个都成功、后写者静默覆盖前者，
 * 且两次都往执行器推了命令」。所以这里必须让两个 `deploy()` **同时进入**。
 *
 * ## 替身怎么造才算「真」
 *
 * `repo.createQueryBuilder()` 的替身**复刻真库 CAS 语义**（不是恒返回某个值）：
 * `WHERE version = :expected` 命中当前行版本才 `affected = 1` 并推进版本，
 * 否则 `affected = 0`。两个请求各自 `SELECT` 到同一份快照（`version = 7`），
 * 于是谁先到谁赢 —— 这正是 PostgreSQL 上那条条件 UPDATE 的行为。
 *
 * ## 反证（本文件存在的判据）
 *
 * 把 service 的复用路径从 `claimReusableDeployment()`（条件 UPDATE）退回
 * `saveWithOptimisticLock()`（整行 `save()`），本文件的两条断言必红：
 * 两个请求都 fulfilled、执行器收到两条命令。 ⇒ 它不是「写完就绿」的装饰用例。
 */

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

const mockExecutor = { id: "exec-1", address: "203.0.113.10:3001" };

const makeRepo = () => ({
  findOne: jest.fn(),
  create: jest.fn((d: any) => ({ ...d })),
  save: jest.fn((e: any) => Promise.resolve({ ...e })),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  delete: jest.fn().mockResolvedValue({ affected: 1 }),
  createQueryBuilder: jest.fn(),
});

describe("R179 并发「重新部署」：复用行的条件 UPDATE（CAS）", () => {
  let service: AppDeploymentService;
  let repo: ReturnType<typeof makeRepo>;
  let versionRepo: ReturnType<typeof makeRepo>;
  let executorService: jest.Mocked<Record<string, jest.Mock>>;

  beforeEach(async () => {
    repo = makeRepo();
    versionRepo = makeRepo();
    versionRepo.findOne.mockResolvedValue(null);

    executorService = {
      findOne: jest.fn().mockResolvedValue(mockExecutor),
      selectLeastLoaded: jest.fn().mockResolvedValue(mockExecutor),
      getSharedToken: jest.fn().mockResolvedValue(""),
      getExecutorUrl: jest.fn(
        (addr: string, p: string) => `http://${addr}/${p}`,
      ),
      // ARCH-33：pull 通道——命令点算「推给执行器的命令数」的唯一入口，
      // 且不触发 HTTP/DNS（本用例只关心「推了几次」，不关心传输细节）。
      ...controlPlaneMocks({ mode: "pull" }),
    } as unknown as jest.Mocked<Record<string, jest.Mock>>;

    const module = await Test.createTestingModule({
      providers: [
        AppDeploymentService,
        { provide: getRepositoryToken(AppDeployment), useValue: repo },
        {
          provide: getRepositoryToken(ApplicationVersion),
          useValue: versionRepo,
        },
        {
          provide: ApplicationService,
          useValue: {
            findById: jest.fn().mockResolvedValue(mockApp),
            findByIdRaw: jest.fn().mockResolvedValue(mockApp),
            maskEnvForRead: jest.fn((env: any) => env),
            maskReadSurface: jest.fn((app: any) => app),
          },
        },
        { provide: ExecutorService, useValue: executorService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
      ],
    }).compile();

    service = module.get(AppDeploymentService);
  });

  it("两个并发「重新部署」⇒ 只有一个成功，另一个 409，且只推一条命令", async () => {
    // 终态行：CAS 的谓词列（status/version）与本次要重置的列都在。
    const row = {
      id: "deploy-existing",
      applicationId: "app-1",
      executorId: "exec-1",
      executorAddress: "203.0.113.10:3001",
      status: DeploymentStatus.FAILED,
      runMode: RunMode.DAEMON,
      pid: 4242,
      statusMessage: "boom",
      version: 7,
    };
    // 每次读到都是**独立快照**：模拟两个请求各自 SELECT 到同一行（version=7）。
    let reads = 0;
    repo.findOne.mockImplementation(async (opts: any) => {
      if (Array.isArray(opts?.where)) return null; // 在途守卫：无在途行
      reads += 1;
      return { ...row };
    });

    let rowVersion = 7;
    let rowStatus: DeploymentStatus = DeploymentStatus.FAILED;
    let claimHits = 0;
    // 第一次 CAS 落库时**已经发生过几次读取**——用于证明两条请求确实同时在飞
    // （若为 2，说明第二个请求在第一个 CAS 之前就读到了同一行）。
    let readsBeforeFirstClaim = -1;
    repo.createQueryBuilder.mockImplementation(() => {
      let expected: number | undefined;
      let expectedStatus: DeploymentStatus | undefined;
      let setStatus: DeploymentStatus | undefined;
      const qb: any = {
        update: jest.fn(() => qb),
        set: jest.fn((values: any) => {
          // R190：记住本次 UPDATE 要写的 status —— 命中后它就是行的新状态
          // （真库语义：SET status = $1）。
          if (values?.status !== undefined) setStatus = values.status;
          return qb;
        }),
        where: jest.fn(() => qb),
        andWhere: jest.fn((_sql: string, params: any) => {
          // R190：两处 CAS 的谓词列不同——
          //   ① 复用行占坑（`claimReusableDeployment`）⇒ `version` 谓词；
          //   ② 推送前落库（`pushDeployToExecutor`）⇒ `status` 谓词
          //     （用它是因为 rollout 的租约心跳会经 TypeORM `update()` 自动
          //     `version+1`，拿 `version` 当谓词会被**正常业务**误伤 ⇒ 灰度批次卡死）。
          if (params?.expected !== undefined) expected = params.expected;
          if (params?.expectedStatus !== undefined) {
            expectedStatus = params.expectedStatus;
          }
          return qb;
        }),
        returning: jest.fn(() => qb),
        // 真库语义：谓词命中才 affected=1，并把版本推进一步。
        // R190：`version` 谓词与 `status` 谓词**并存**（见上面的 andWhere 注记）——
        // 两种谓词都命中才算命中（真库里它们是同一个 UPDATE 的 AND 条件）。
        execute: jest.fn(async () => {
          if (readsBeforeFirstClaim < 0) readsBeforeFirstClaim = reads;
          if (expected !== undefined && expected !== rowVersion) {
            return { affected: 0 };
          }
          if (expectedStatus !== undefined && expectedStatus !== rowStatus) {
            return { affected: 0 };
          }
          rowVersion += 1;
          if (setStatus !== undefined) rowStatus = setStatus;
          claimHits += 1;
          return { affected: 1 };
        }),
      };
      return qb;
    });

    const deploy = () =>
      service.deploy("app-1", {
        executorId: "exec-1",
        runMode: RunMode.DAEMON,
      });

    // **真并发**：两条请求同时在飞（不是先 await 一条再发第二条）。
    const settled = await Promise.allSettled([deploy(), deploy()]);
    // 推送是 fire-and-forget：给它在断言前跑完的机会。
    await new Promise((resolve) => setTimeout(resolve, 0));

    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r) => r.status === "rejected");

    // ① **用户可见的伤害**（先断言它：退回 `save()` 时这条第一个红，红的正是
    //    「两次都成功、后写者静默覆盖前者」这个病，而不是某个实现细节）：
    //    恰好一个成功、一个 409。
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      constructor: ConflictException,
      status: 409,
    });

    // ② 伤害的另一半：旧实现「两次都往执行器推了命令」⇒ 这里必须只有一条。
    const deploysSent = executorService.deliverControlCommand.mock.calls.filter(
      (c: any[]) => c[0]?.type === "deploy",
    );
    expect(deploysSent).toHaveLength(1);
    // 推给执行器的那条必须是**赢家**，且它指向被复用的那一行。
    expect(deploysSent[0][0].payload.deploymentId).toBe("deploy-existing");

    // ③ 机制层：**赢家做两次条件写、输家一次都没命中**。
    //
    // R181 之后这行「复用」路径上有**两处** CAS，都由**赢家**完成：
    //   ① 复用行占坑 —— `claimReusableDeployment()`（expected=7 ⇒ 命中，版本 7→8）；
    //   ② 推送前落库 —— `pushDeployToExecutor()` 的窄列条件 UPDATE
    //      （expected=8 ⇒ 命中，版本 8→9）。
    // 输家在 ① 就 `affected=0` ⇒ 抛 409 ⇒ **一次都没命中**。
    // ⇒ 合计命中 **2** 次、版本推进 **2** 格（7 → 9）。
    // ⚠️ 这条比旧版的 `toBe(1)` **更强**：它同时证明了**推送那一步也受 CAS 保护**
    // （旧版整行 `save()` 是无谓词写，`claimHits` 永远不会是 2）。
    expect(claimHits).toBe(2);
    expect(rowVersion).toBe(9);
    // ④ **确属并发**：第一次 CAS 落库时两条请求都已读到同一行（否则本用例
    // 只是顺序调用，证明不了「同时进来时只有一个赢家」）。
    expect(readsBeforeFirstClaim).toBe(2);
  });
});
