/**
 * GET /app-deployments/stats —— 应用列表页部署统计的聚合端点。
 *
 * ## 为什么有这个端点（用户报障回归，2026-10-13 生产实证）
 *
 * 报障原文：「在应用管理页面，对应应用的行点击新建部署，会弹出非常多的
 * ThrottlerException: Too Many Requests，刷新页面也弹出。本来已经部署了
 * 1 台设备的，我想再部署一台就出现这种问题。」
 *
 * 根因不在部署动作本身（那次 POST deploy 实际返回 201、第二台也确实起来了），
 * 而在**应用列表页的 N+1 扇出**：该页为统计每行「运行 X/Y 台」，对每个应用
 * 各发一个 `GET /app-deployments?applicationId=…&pageSize=100`。
 * ThrottlerGuard 默认 `generateKey = {类名}-{方法名}-{tracker}`（tracker=IP），
 * 于是这 N 个请求**共享同一个 60/min 计流桶**：26 个应用时，进页面(26) +
 * 返回页面(26) + 部署后自动刷新(26) = 78 > 60 → 整页部署列 429，且限流器
 * 进入 block（时长=ttl=60s），block 期内**连第 1 个请求也 429**——这正是
 * 「刷新页面也弹出」且"越刷越红"的机制。生产 nginx 日志中 149 个 429 全部
 * 是同一个 `GET /api/app-deployments`，且 26 与当时应用数精确相等。
 *
 * 本 spec 钉住三件事：
 *   ① service.findStats() 的聚合口径（total/running/failed/lastDeployedAt）
 *      必须与原前端「拉全量再 filter」逐项一致——列表页那列是「我的应用在跑吗」
 *      的答案，口径漂了就是又一次「中台显示不可信」；
 *   ② 空结果不造行（无部署的应用由调用方按 0 处理）；
 *   ③ 路由次序：`/app-deployments/stats` 必须不被 `@Get(":id")` 吞掉
 *      （否则 "stats" 进 ParseUUIDPipe → 400），且读面 RBAC 与 findAll 同姿态。
 */
import "reflect-metadata";
import {
  INestApplication,
  UnauthorizedException,
  ExecutionContext,
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import request from "supertest";
import { AppDeploymentController } from "../app-deployment.controller";
import { AppDeploymentService } from "../app-deployment.service";
import { ApplicationService } from "../application.service";
import {
  AppDeployment,
  DeploymentStatus,
} from "../entities/app-deployment.entity";
import { ApplicationVersion } from "../entities/application-version.entity";
import { ExecutorService } from "../../executor/executor.service";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { UserRole } from "../../users/entities/user.entity";

// ─────────────────────────────────────────────────────────────────────────────
// ① service.findStats()：聚合口径
// ─────────────────────────────────────────────────────────────────────────────

/** 链式 QueryBuilder 替身：记录 select/参数，回放预设的 getRawMany 行。 */
function makeStatsRepo(rawRows: Array<Record<string, unknown>>) {
  const qb = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    setParameters: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(rawRows),
  };
  return {
    createQueryBuilder: jest.fn(() => qb),
    // findStats 之外的方法（构造期/其它路径）不需要，但保持形态完整。
    find: jest.fn(),
    findOne: jest.fn(),
    findAndCount: jest.fn(),
    qb,
  };
}

async function buildService(rawRows: Array<Record<string, unknown>>) {
  const repo = makeStatsRepo(rawRows);
  const module = await Test.createTestingModule({
    providers: [
      AppDeploymentService,
      { provide: getRepositoryToken(AppDeployment), useValue: repo },
      {
        provide: getRepositoryToken(ApplicationVersion),
        useValue: makeStatsRepo([]),
      },
      {
        provide: ApplicationService,
        // findStats 不碰掩码，但构造期依赖必须可解析（其余方法不用）。
        useValue: { maskEnvForRead: jest.fn((e: unknown) => e) },
      },
      { provide: ExecutorService, useValue: {} },
      {
        provide: ConfigService,
        useValue: { get: jest.fn().mockReturnValue(undefined) },
      },
    ],
  }).compile();
  return { svc: module.get(AppDeploymentService), repo };
}

describe("AppDeploymentService.findStats — 聚合口径", () => {
  it("pg 驱动回传 bigint 字符串时收口成 number（不能透传 '33'）", async () => {
    const { svc } = await buildService([
      {
        applicationId: "app-1",
        total: "33",
        running: "30",
        failed: "3",
        lastDeployedAt: new Date("2026-10-13T06:26:51.000Z"),
      },
    ]);

    const [row] = await svc.findStats();

    expect(row.applicationId).toBe("app-1");
    // 反证：若直接透传，前端拿到字符串做算术/比较会静默出错（"30" > 9 为 false）。
    expect(row.total).toBe(33);
    expect(row.running).toBe(30);
    expect(row.failed).toBe(3);
    expect(typeof row.total).toBe("number");
  });

  it("lastDeployedAt 统一成 ISO 串；NULL → null（不是 'Invalid Date'）", async () => {
    const { svc } = await buildService([
      {
        applicationId: "app-1",
        total: "1",
        running: "1",
        failed: "0",
        lastDeployedAt: new Date("2026-10-13T06:26:51.000Z"),
      },
      // 该应用有部署行但 deployedAt/createdAt 皆缺（防御性：契约里是 nullable）
      {
        applicationId: "app-2",
        total: "2",
        running: "0",
        failed: "0",
        lastDeployedAt: null,
      },
    ]);

    const rows = await svc.findStats();

    expect(rows[0].lastDeployedAt).toBe("2026-10-13T06:26:51.000Z");
    // 反证：null 若被 new Date(null).toISOString() 处理会抛 RangeError 或
    // 变成 1970——两者都会让前端显示"55 年前部署"。
    expect(rows[1].lastDeployedAt).toBeNull();
  });

  it("驱动把时间列回成字符串时同样归一（不同 driver 形态不一）", async () => {
    const { svc } = await buildService([
      {
        applicationId: "app-1",
        total: "1",
        running: "1",
        failed: "0",
        lastDeployedAt: "2026-10-13 06:26:51.304817",
      },
    ]);

    const [row] = await svc.findStats();
    expect(row.lastDeployedAt).toBe(
      new Date("2026-10-13 06:26:51.304817").toISOString(),
    );
  });

  it("空表 → 空数组（不为无部署的应用造行）", async () => {
    const { svc } = await buildService([]);
    await expect(svc.findStats()).resolves.toEqual([]);
  });

  it("按 applicationId 分组，且 running/failed 用参数化状态值（不硬编码字面量）", async () => {
    const { svc, repo } = await buildService([]);
    await svc.findStats();

    expect(repo.qb.groupBy).toHaveBeenCalledWith("d.applicationId");
    // 状态值必须来自枚举，避免枚举改名后 SUM 恒为 0（"0 / 33 台运行中"假绿）。
    expect(repo.qb.setParameters).toHaveBeenCalledWith({
      running: DeploymentStatus.RUNNING,
      failed: DeploymentStatus.FAILED,
    });
    const selects = repo.qb.addSelect.mock.calls.map((c) => String(c[0]));
    // COALESCE 而非裸 MAX(deployedAt)：pending 行 deployedAt 为 NULL，
    // 裸 MAX 会让"刚创建还没跑起来"的应用显示成"从未部署"。
    expect(selects.some((s) => s.includes("COALESCE"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ② controller：路由次序 + RBAC
// ─────────────────────────────────────────────────────────────────────────────

describe("AppDeploymentController GET /app-deployments/stats — routing & RBAC", () => {
  let app: INestApplication;

  const makeSvc = () => ({
    findStats: jest.fn().mockResolvedValue([
      {
        applicationId: "app-1",
        total: 2,
        running: 2,
        failed: 0,
        lastDeployedAt: "2026-10-13T06:26:51.000Z",
      },
    ]),
    findAll: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    findById: jest.fn(),
  });

  const jwtGuard = {
    canActivate(context: ExecutionContext) {
      const req = context.switchToHttp().getRequest();
      const role = req.headers["x-test-role"];
      if (!role) throw new UnauthorizedException();
      req.user = { id: 7, role };
      return true;
    },
  };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [AppDeploymentController],
      providers: [
        { provide: AppDeploymentService, useValue: makeSvc() },
        {
          provide: ExecutorService,
          useValue: { validateExecutorToken: jest.fn() },
        },
        { provide: APP_GUARD, useValue: jwtGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(jwtGuard)
      .compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  const svcOf = () =>
    app.get(AppDeploymentService) as unknown as ReturnType<typeof makeSvc>;

  it("固定段路由次序：/app-deployments/stats 不被 :id 参数路由吞掉", async () => {
    // 若 stats 声明在 @Get(":id") 之后，请求会进入 findById("stats") 并被
    // ParseUUIDPipe 拦成 400——本断言即路由次序的回归哨（与 executor
    // controller 的 /executors/picker 同一坑）。
    await request(app.getHttpServer())
      .get("/app-deployments/stats")
      .set("x-test-role", UserRole.ADMIN)
      .expect(200);
    expect(svcOf().findStats).toHaveBeenCalledTimes(1);
    expect(svcOf().findById).not.toHaveBeenCalled();
  });

  it("登录用户可读——与 GET /app-deployments 同姿态（不额外收紧）", async () => {
    const res = await request(app.getHttpServer())
      .get("/app-deployments/stats")
      .set("x-test-role", UserRole.USER)
      .expect(200);
    expect(res.body).toEqual([
      {
        applicationId: "app-1",
        total: 2,
        running: 2,
        failed: 0,
        lastDeployedAt: "2026-10-13T06:26:51.000Z",
      },
    ]);
  });

  it("未登录 401——service 不被触达", async () => {
    await request(app.getHttpServer())
      .get("/app-deployments/stats")
      .expect(401);
    expect(svcOf().findStats).not.toHaveBeenCalled();
  });

  it("无 @Roles 元数据（读面，与 findAll 一致）", () => {
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        AppDeploymentController.prototype.findStats,
      ),
    ).toBeUndefined();
  });
});
