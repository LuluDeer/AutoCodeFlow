/**
 * 执行器选择器（GET /executors/picker）——部署下拉的轻量数据源。
 *
 * 背景：GET /executors（findAll）take=EXECUTOR_LIST_LIMIT(500) 且为**静默**
 * 截断——执行器总数超 500 后，部署模态/快速部署两个下拉对第 501+ 台执行器
 * 假阴性（搜不到真实存在的机器）。picker 以 6 列轻读面 + 显式 truncated 旗标
 * 修这个缺陷（截断必须可见，不许静默）。
 *
 * 本 spec 钉三件事：
 *   ① service.findPickerOptions 的读面契约——SQL select 收窄到 6 列（载荷
 *      护栏）、total 独立 COUNT、超限 truncated=true（正常/超限两态）；
 *   ② controller 的 RBAC 姿态与 GET /executors 完全对齐——任何登录用户可读
 *      （无 @Roles 收紧），未登录 401（读面是 list 的严格子集，不放宽也不
 *      额外收紧）；
 *   ③ 固定段路由次序——/executors/picker 声明在 :id 参数路由之前，不被吞。
 */
import { Test } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  INestApplication,
  ExecutionContext,
  Provider,
  UnauthorizedException,
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import request from "supertest";
import { ExecutorService, EXECUTOR_PICKER_LIMIT } from "../executor.service";
import { ExecutorController } from "../executor.controller";
import { Executor, ExecutorStatus } from "../entities/executor.entity";
import { ExecutorMetricsHistory } from "../entities/executor-metrics-history.entity";
import { Task } from "../../task/entities/task.entity";
import { TaskExecution } from "../../task/entities/task-execution.entity";
import { NotificationService } from "../../notification/notification.service";
import { SystemConfigService } from "../../config/config.service";
import { SecretsCryptoService } from "../../../common/utils/secret-crypto.util.service";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { ProjectAccessService } from "../../project/project-access.service";
import { UserRole } from "../../users/entities/user.entity";

// ─────────────────────────────────────────────────────────────────────────────
// ① service：读面契约 + 截断显式化（正常返回 / 超限）
// ─────────────────────────────────────────────────────────────────────────────

/** 与 executor.service.spec.ts 同款 repo 桩（本文件只用 find/count 两口）。 */
const makeRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  count: jest.fn().mockResolvedValue(0),
});

const makePickerRow = (i: number, over: Record<string, unknown> = {}) => ({
  id: `exec-${i}`,
  appName: `机器-${i}`,
  address: `10.0.0.${i}:8001`,
  status: ExecutorStatus.ONLINE,
  runningTaskCount: i,
  maxConcurrentTasks: 10,
  // 全列实体里下拉不消费的重列——若实现忘了 select 收窄，行里会带上它们，
  // 下方「读面恰好 6 键」断言立即变红。
  interpreters: [{ version: "3.11.13" }],
  runningExecutionIds: ["exec-run-1"],
  tags: ["prod"],
  lastHeartbeat: new Date().toISOString(),
  ...over,
});

describe("ExecutorService.findPickerOptions — 轻读面 + 显式截断", () => {
  let service: ExecutorService;
  let executorRepo: ReturnType<typeof makeRepo>;

  const makeService = async (repo: ReturnType<typeof makeRepo>) => {
    const module = await Test.createTestingModule({
      providers: [
        ExecutorService,
        { provide: getRepositoryToken(Executor), useValue: repo },
        { provide: getRepositoryToken(TaskExecution), useValue: makeRepo() },
        { provide: getRepositoryToken(Task), useValue: makeRepo() },
        {
          provide: getRepositoryToken(ExecutorMetricsHistory),
          useValue: makeRepo(),
        },
        { provide: getQueueToken("task-queue"), useValue: { add: jest.fn() } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue("http") },
        },
        {
          provide: NotificationService,
          useValue: {
            notifyFailure: jest.fn(),
            notifyFailureWithConfig: jest.fn(),
            notifyExecutorOnline: jest.fn(),
            notifyExecutorOffline: jest.fn(),
            sendAll: jest.fn(),
          },
        },
        {
          provide: SystemConfigService,
          useValue: {
            findOne: jest.fn().mockRejectedValue(new Error("not found")),
          },
        },
        {
          provide: SecretsCryptoService,
          useValue: new SecretsCryptoService({ get: () => "" } as never),
        },
      ] as Provider[],
    }).compile();
    return module.get(ExecutorService);
  };

  beforeEach(async () => {
    executorRepo = makeRepo();
    service = await makeService(executorRepo);
  });

  it("正常返回：读面恰好 6 键，select 收窄 + take=EXECUTOR_PICKER_LIMIT 下推 SQL", async () => {
    executorRepo.count.mockResolvedValue(2);
    executorRepo.find.mockResolvedValue([makePickerRow(1), makePickerRow(2)]);

    const result = await service.findPickerOptions();

    // 读面契约：选项文案/在线态禁用 + 部署模态负载条所需的全部字段，且**只有**
    // 这些字段——多一键即读面漂移（列表页字段不得顺着实体漏进来）。
    expect(result.items).toHaveLength(2);
    for (const item of result.items) {
      expect(Object.keys(item).sort()).toEqual(
        [
          "address",
          "appName",
          "id",
          "maxConcurrentTasks",
          "runningTaskCount",
          "status",
        ].sort(),
      );
    }
    expect(result.items[0]).toMatchObject({
      id: "exec-1",
      appName: "机器-1",
      address: "10.0.0.1:8001",
      status: ExecutorStatus.ONLINE,
      runningTaskCount: 1,
      maxConcurrentTasks: 10,
    });
    // 截断旗标与上限回显：未超限必须如实 truncated=false（前端据此不告警）。
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(2);
    expect(result.limit).toBe(EXECUTOR_PICKER_LIMIT);
    // 载荷护栏下推到 SQL：select 只取 6 列（runningExecutionIds 等重列不出库），
    // take 上限与 createdAt DESC 排序（下拉展示最新接入的机器优先）。
    expect(executorRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        order: { createdAt: "DESC" },
        take: EXECUTOR_PICKER_LIMIT,
        select: {
          id: true,
          appName: true,
          address: true,
          status: true,
          runningTaskCount: true,
          maxConcurrentTasks: true,
        },
      }),
    );
  });

  it("超限：total > 行数 → truncated=true + 全量 total（显式上报，绝不静默）", async () => {
    // repo 桩不执行 take——直接以「count=2500、find 回 3 行」模拟
    // 「全量 2500 台、返回前 EXECUTOR_PICKER_LIMIT 行」的超限形态。
    executorRepo.count.mockResolvedValue(2500);
    executorRepo.find.mockResolvedValue([
      makePickerRow(1),
      makePickerRow(2),
      makePickerRow(3),
    ]);

    const result = await service.findPickerOptions();

    expect(result.truncated).toBe(true);
    expect(result.total).toBe(2500);
    expect(result.items).toHaveLength(3);
    expect(result.limit).toBe(EXECUTOR_PICKER_LIMIT);
    // 不抛错：超限时下拉仍有前 2000 台可用，靠 truncated 旗标显式告警。
  });

  it("边界：total 恰等于返回行数（未超限）→ truncated=false", async () => {
    // repo 桩不执行 take——以「count 恰等于 find 行数」模拟「全量正好在
    // 上限内」：截断判定是 total > items.length，total == 行数必须如实 false
    // （真实 take=EXECUTOR_PICKER_LIMIT 下，count==行数即恰好取尽不截断）。
    executorRepo.count.mockResolvedValue(8);
    executorRepo.find.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => makePickerRow(i + 1)),
    );

    const result = await service.findPickerOptions();

    expect(result.truncated).toBe(false);
    expect(result.total).toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ② controller：RBAC 与 GET /executors 对齐 + 路由次序
// ─────────────────────────────────────────────────────────────────────────────

describe("ExecutorController GET /executors/picker — RBAC & routing", () => {
  let app: INestApplication;

  const makeSvc = () => ({
    findPickerOptions: jest.fn().mockResolvedValue({
      items: [
        {
          id: "exec-1",
          appName: "机器-1",
          address: "10.0.0.1:8001",
          status: ExecutorStatus.ONLINE,
          runningTaskCount: 0,
          maxConcurrentTasks: 10,
        },
      ],
      total: 1,
      truncated: false,
      limit: EXECUTOR_PICKER_LIMIT,
    }),
  });

  // 与 rbac matrix spec 同款：只 mock 认证，走真实全局 RolesGuard——
  // picker 无 @Roles，任何登录用户可读（与 GET /executors 一致）。
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
      controllers: [ExecutorController],
      providers: [
        { provide: ExecutorService, useValue: makeSvc() },
        { provide: ConfigService, useValue: {} },
        { provide: SystemConfigService, useValue: {} },
        {
          provide: ProjectAccessService,
          useValue: { hasProjectRole: jest.fn() },
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
    app.get(ExecutorService) as unknown as ReturnType<typeof makeSvc>;

  it("登录用户 200——与 GET /executors 同姿态（不额外收紧）", async () => {
    const res = await request(app.getHttpServer())
      .get("/executors/picker")
      .set("x-test-role", UserRole.USER)
      .expect(200);
    expect(res.body).toMatchObject({ truncated: false, total: 1 });
    expect(res.body.items[0]).toMatchObject({
      id: "exec-1",
      appName: "机器-1",
    });
    expect(svcOf().findPickerOptions).toHaveBeenCalledTimes(1);
  });

  it("未登录 401——service 不被触达", async () => {
    await request(app.getHttpServer()).get("/executors/picker").expect(401);
    expect(svcOf().findPickerOptions).not.toHaveBeenCalled();
  });

  it("固定段路由次序：/executors/picker 不被 :id 参数路由吞掉", async () => {
    // 若声明顺序错误（picker 落在 @Get(":id") 之后），请求会进入 findOne("picker")
    // 并以 404/500 收场——本断言即路由次序的回归哨。
    await request(app.getHttpServer())
      .get("/executors/picker")
      .set("x-test-role", UserRole.ADMIN)
      .expect(200);
    expect(svcOf().findPickerOptions).toHaveBeenCalledTimes(1);
  });
});
