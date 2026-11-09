/**
 * R182 · 调用点 #4（`upgradeWithSnapshot`）的**并发保护**——「回滚推送」的落库不许静默覆盖。
 *
 * ## 为什么单独一个文件
 *
 * R182 之前，`upgradeWithSnapshot` 的落库是**整行 `save()`**（无 `WHERE` 谓词）⇒
 * 与并发的 `stop()` / `heartbeat` **互相静默覆盖**：**无 409、无异常、无日志**。
 * 而这条路径在**自动回滚**链路上，异常还会被上层 `catch` 吞成一行日志 ⇒
 * **改错极难察觉**。
 *
 * ⚠️ **本文件存在的原因不只是「测新功能」**：R182 改完实现后，
 * **既有的 314 条用例里没有一条会红**（去掉 `version` 谓词仍然 314/314 绿）——
 * ⇒ **这条并发保护当时处于「改了但没被验证」的状态**。
 * 本文件就是把它**钉住**的那条钉子（→ 359）。
 *
 * ## 判据（三条）
 *
 * ① **谓词生效**：回滚落库走 `version` 谓词的条件 UPDATE ⇒ 版本不匹配时
 *    `affected === 0` ⇒ 抛**并发冲突**（`APP_DEPLOYMENT_CONCURRENT_MODIFICATION` / 409），
 *    **不是**静默覆盖；
 * ② **成功路径仍写全那 5 列**：`startCommand` / `status` / `statusMessage` /
 *    `triggerType` / `operator`（少写任何一列都是**行为变更**）；
 * ③ **`env` 不由它写**：快照里的 `snapshot.env` 只进**推送载荷**、**不写部署行**
 *    （这条是 R180 查证过的前提，改窄列之所以安全全靠它 ⇒ 钉住它）。
 */
import { ConflictException } from "@nestjs/common";
import { DeploymentStatus } from "../entities/app-deployment.entity";

/** 与 `app-deployment.service.spec.ts` 同款的最小 harness（不重复整份 mock）。 */
type Qb = {
  update: jest.Mock;
  set: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  execute: jest.Mock;
};

describe("R182 · 调用点 #4（upgradeWithSnapshot）的并发保护", () => {
  let service: any;
  let repo: any;
  let appService: any;
  let executorService: any;
  /** 每次 CAS 记一次：`{ expected, sql }`。 */
  let casCalls: Array<{
    expected: number | undefined;
    setPayload: Record<string, unknown>;
  }>;
  /** 替身返回的 affected（默认 1 = 命中）。 */
  let affected = 1;
  /** 替身读到的当前行版本。 */
  let rowVersion = 7;

  const makeQb = (): Qb => {
    const qb: any = {
      update: jest.fn(() => qb),
      set: jest.fn((payload: Record<string, unknown>) => {
        qb.__payload = payload;
        return qb;
      }),
      where: jest.fn(() => qb),
      andWhere: jest.fn((_sql: string, params: any) => {
        if (params?.expected !== undefined) qb.__expected = params.expected;
        return qb;
      }),
      execute: jest.fn(async () => {
        casCalls.push({
          expected: qb.__expected,
          setPayload: qb.__payload ?? {},
        });
        return { affected };
      }),
    };
    return qb as Qb;
  };

  beforeEach(() => {
    casCalls = [];
    affected = 1;
    rowVersion = 7;

    repo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((d: any) => ({ ...d, id: d.id ?? "deploy-1" })),
      save: jest.fn((e: any) =>
        Promise.resolve({ ...e, id: e.id ?? "deploy-1" }),
      ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => makeQb()),
    };
    appService = {
      findByIdRaw: jest.fn().mockResolvedValue({
        id: "app-1",
        name: "my-app",
        runtime: "node",
        entrypoint: "node dist/main.js",
        version: "2.0.0",
        env: { NODE_ENV: "production" },
      }),
      update: jest.fn().mockResolvedValue({}),
    };
    executorService = {
      deliverControlCommand: jest.fn().mockResolvedValue({ delivered: "push" }),
      // R182：mock 完整性（→ 358）—— push 路径还要 `getExecutorUrl`；缺它同样会抛 TypeError
      // 并被 `.catch()` 吞掉 ⇒ 表现为「断言拿不到东西」的**无关失败**。
      getExecutorUrl: jest.fn(() => "http://203.0.113.10:3001"),
    };
  });

  /** 直接调私有方法（#4 就是私有的；用 `as any` 触达是本仓对私有链路的常规做法）。 */
  const callUpgradeWithSnapshot = (
    deployment: any,
    version: any,
    trigger?: any,
  ) => (service as any).upgradeWithSnapshot(deployment, version, trigger);

  const makeService = () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 测试里按需构造，避开整个 Nest DI
    const { AppDeploymentService } = require("../app-deployment.service");
    const inst = Object.create(AppDeploymentService.prototype) as any;
    inst.repo = repo;
    inst.appService = appService;
    inst.executorService = executorService;
    // R182：mock 完整性 ——  会调 （不是 info）⇒ 缺它会抛
    // TypeError 并被 push 的 .catch() 吞掉 ⇒ 表现为「后续断言拿不到东西」的**无关失败**（→ 358）。
    inst.logger = {
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      log: jest.fn(),
      debug: jest.fn(),
    };
    return inst;
  };

  const deploymentRow = () => ({
    id: "deploy-1",
    applicationId: "app-1",
    executorId: "exec-1",
    executorAddress: "203.0.113.10:3001",
    status: DeploymentStatus.RUNNING,
    statusMessage: "running",
    startCommand: "node dist/old.js",
    version: rowVersion,
  });

  const snapshotVersion = {
    version: "1.0.0",
    gitCommit: "abc123",
    snapshot: {
      version: "1.0.0",
      runtime: "node",
      gitBranch: "release",
      packageUrl: "http://packages/app.zip",
      env: { NODE_ENV: "production" },
      entrypoint: "node app.js",
      manifest: { tasks: [] },
    },
  };

  it("① 版本不匹配 ⇒ affected=0 ⇒ 抛并发冲突（409），不是静默覆盖", async () => {
    service = makeService();
    affected = 0; // 模拟「行已被并发推进」⇒ 谓词命中 0 行

    await expect(
      callUpgradeWithSnapshot(deploymentRow(), snapshotVersion),
    ).rejects.toMatchObject({ constructor: ConflictException, status: 409 });

    // 关键：谓词**真的**带了 version（不是无谓词写）
    expect(casCalls.length).toBeGreaterThan(0);
    expect(casCalls[0].expected).toBe(7);
  });

  it("② 成功路径写全那 5 列（少写一列都是行为变更）", async () => {
    service = makeService();
    await callUpgradeWithSnapshot(deploymentRow(), snapshotVersion, {
      triggerType: "rollback",
      operator: null,
    });

    const set = casCalls[0].setPayload;
    expect(set.status).toBe(DeploymentStatus.UPGRADING);
    expect(String(set.statusMessage)).toContain("Rolling back to 1.0.0");
    // A-4：回滚推送前 startCommand 必须同步为快照的 entrypoint
    expect(set.startCommand).toBe("node app.js");
    expect(set.triggerType).toBe("rollback");
    expect(set.operator).toBeNull();
  });

  it("③ `env` 不由它写（快照 env 只进推送载荷）—— 窄列化安全的前提被钉住", async () => {
    service = makeService();
    await callUpgradeWithSnapshot(deploymentRow(), snapshotVersion);

    // 落库载荷里**没有** env（它由 push 之前持久化，此处不碰）
    expect(casCalls[0].setPayload).not.toHaveProperty("env");
    // 而推送载荷里 env 是**快照的值**（掩码面不进发送路径）
    const deliverArg = executorService.deliverControlCommand.mock.calls[0][0];
    expect(deliverArg.payload.env).toEqual({ NODE_ENV: "production" });
  });
});
