/**
 * F-41（UIUX 审计 P1-2）：非法/不存在 ID 深链的 HTTP 语义集成 spec。
 *
 * 真机缺陷：`/tasks/999999`、`/applications/abc`、`/executors/not-exist`、
 * `/tasks/:id/executions/999999` 全部 500（errorCode:null）——非 UUID 字符串
 * 直达 TypeORM 查询触发 PG 22P02（invalid input syntax for type uuid），
 * QueryFailedError 未映射冒泡。前端还对其整组重试。
 *
 * 修复（两层，本 spec 走真实路由栈钉住）：
 *   1. 参数管道：读面 `:id`/`:execId` 挂 ParseUuidShapePipe（projects.controller
 *      同款先例）——形态非法 400 打 400 封套，不打 DB；
 *   2. 全局兜底：HttpExceptionFilter 把 PG 22P02 映射为 400 INVALID_VALUE_FORMAT
 *      （见 http-exception.filter，任何绕过管道的路径不再 500）。
 *   形态合法但不存在 → 404（service 抛 AppError TASK_NOT_FOUND，本 spec 经
 *   mock service 透传该形态，钉住「400 形态错 / 404 不存在」的分界）。
 *
 * F-52（UIAUDIT 后端轮 P2-1，2026-10-25）：形态非法的封套统一为
 * `400 + errorCode=INVALID_VALUE_FORMAT + 中文目录文案`——此前路由管道拒绝时
 * 原样透传 NestJS 英文（errorCode:null），与 22P02 兜底两套形态漂移。同轮把
 * users（ParseIntShapePipe）与 task-templates（ParseUuidShapePipe）两个残留
 * 控制器收编进同一契约，本 spec 一并钉住（不再各写一份只能证明管道元数据的
 * 单测）。
 *
 * 不依赖 DB：五个控制器的 service 全部 mock，JwtAuthGuard 以 useValue 放行。
 */
import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { QueryFailedError } from "typeorm";

import { TaskController } from "../../../modules/task/task.controller";
import { TaskService } from "../../../modules/task/task.service";
import { TaskWebhookService } from "../../../modules/task/task-webhook.service";
import { ApplicationController } from "../../../modules/application/application.controller";
import { ApplicationService } from "../../../modules/application/application.service";
import { AppDeploymentService } from "../../../modules/application/app-deployment.service";
import { ExecutorController } from "../../../modules/executor/executor.controller";
import { ExecutorService } from "../../../modules/executor/executor.service";
import { UsersController } from "../../../modules/users/users.controller";
import { UsersService } from "../../../modules/users/users.service";
import { TaskTemplateController } from "../../../modules/task-template/task-template.controller";
import { TaskTemplateService } from "../../../modules/task-template/task-template.service";
import { SystemConfigService } from "../../../modules/config/config.service";
import { AuditService } from "../../../modules/audit/audit.service";
import { JwtAuthGuard } from "../../guards/jwt-auth.guard";
import { HttpExceptionFilter } from "../../filters/http-exception.filter";
import { AppError } from "../../errors/app-error";

const TASK_UUID = "2509e892-cb1c-4746-9505-2dfe932ebf33";

/** 造一个 PG 22P02 形态的 QueryFailedError（uuid 列收到非 UUID 值）。 */
function pgCastError(value: string): QueryFailedError {
  return new QueryFailedError(
    "SELECT ... WHERE id = $1",
    [value],
    Object.assign(new Error(`invalid input syntax for type uuid: "${value}"`), {
      code: "22P02",
    }) as Error,
  );
}

describe("F-41 深链 ID 形态校验（400 形态错 / 404 不存在，不再 500）", () => {
  let app: INestApplication;
  let taskService: Record<string, jest.Mock>;
  let applicationService: Record<string, jest.Mock>;
  let executorService: Record<string, jest.Mock>;
  let usersService: Record<string, jest.Mock>;
  let taskTemplateService: Record<string, jest.Mock>;

  beforeAll(async () => {
    taskService = {
      findOne: jest.fn(),
      getExecutions: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      getExecutionStats: jest.fn().mockResolvedValue({ successRate: 100 }),
      getExecution: jest.fn(),
      getExecutionLogs: jest
        .fn()
        .mockResolvedValue({ lines: [], totalLines: 0 }),
    } as unknown as Record<string, jest.Mock>;
    applicationService = {
      findById: jest.fn(),
    } as unknown as Record<string, jest.Mock>;
    executorService = {
      findOne: jest.fn(),
    } as unknown as Record<string, jest.Mock>;
    usersService = {
      findByIdOrNull: jest.fn(),
    } as unknown as Record<string, jest.Mock>;
    taskTemplateService = {
      findOne: jest.fn(),
    } as unknown as Record<string, jest.Mock>;

    const moduleRef = await Test.createTestingModule({
      controllers: [
        TaskController,
        ApplicationController,
        ExecutorController,
        // F-52：两个管道漂移残留控制器收编进同一契约。
        UsersController,
        TaskTemplateController,
      ],
      providers: [
        { provide: TaskService, useValue: taskService },
        { provide: ApplicationService, useValue: applicationService },
        { provide: ExecutorService, useValue: executorService },
        { provide: UsersService, useValue: usersService },
        { provide: TaskTemplateService, useValue: taskTemplateService },
        { provide: TaskWebhookService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: AppDeploymentService, useValue: {} },
        { provide: ConfigService, useValue: {} },
        { provide: SystemConfigService, useValue: {} },
      ],
    })
      // 审计的是 ID 形态校验与错误映射，不是认证——两个守卫放行
      // （config.controller.spec 等既有 harness 同款）。
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── 深链 1：/tasks/999999（形态非法）────────────────────────────────────
  it("GET /tasks/999999 → 400 INVALID_VALUE_FORMAT（ParseUuidShapePipe 拦截，不打 DB）", async () => {
    const res = await request(app.getHttpServer()).get("/tasks/999999");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(400);
    // F-52：管道拒绝统一封套（此前 errorCode:null + 裸英文 NestJS 文案）。
    expect(res.body.errorCode).toBe("INVALID_VALUE_FORMAT");
    expect(res.body.message).toContain("格式非法");
    expect(taskService.findOne).not.toHaveBeenCalled();
  });

  // ── 深链 2：/applications/abc（形态非法）────────────────────────────────
  it("GET /applications/abc → 400（不打 DB）", async () => {
    const res = await request(app.getHttpServer()).get("/applications/abc");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(400);
    expect(res.body.errorCode).toBe("INVALID_VALUE_FORMAT");
    expect(applicationService.findById).not.toHaveBeenCalled();
  });

  // ── 深链 3：/executors/not-exist-executor（形态非法）────────────────────
  it("GET /executors/not-exist-executor → 400（不打 DB）", async () => {
    const res = await request(app.getHttpServer()).get(
      "/executors/not-exist-executor",
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(400);
    expect(res.body.errorCode).toBe("INVALID_VALUE_FORMAT");
    expect(executorService.findOne).not.toHaveBeenCalled();
  });

  // ── 深链 4：/tasks/:id/executions/999999（execId 形态非法）──────────────
  it("GET /tasks/:uuid/executions/999999 → 400（execId 管道拦截）", async () => {
    const res = await request(app.getHttpServer()).get(
      `/tasks/${TASK_UUID}/executions/999999`,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(400);
    expect(taskService.getExecution).not.toHaveBeenCalled();
  });

  // ── F-52 残留收编 1：/users/abc（整数主键收到非数字形态）────────────────
  it("GET /users/not-a-number → 400 INVALID_VALUE_FORMAT（ParseIntShapePipe 拦截，不打 DB）", async () => {
    const res = await request(app.getHttpServer()).get("/users/not-a-number");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(400);
    expect(res.body.errorCode).toBe("INVALID_VALUE_FORMAT");
    expect(res.body.message).toContain("格式非法");
    expect(usersService.findByIdOrNull).not.toHaveBeenCalled();
  });

  // ── F-52 残留收编 2：/task-templates/999999（UUID 主键收到非 UUID 形态）──
  it("GET /task-templates/999999 → 400 INVALID_VALUE_FORMAT（ParseUuidShapePipe 拦截，不打 DB）", async () => {
    const res = await request(app.getHttpServer()).get(
      "/task-templates/999999",
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(400);
    expect(res.body.errorCode).toBe("INVALID_VALUE_FORMAT");
    expect(res.body.message).toContain("格式非法");
    expect(taskTemplateService.findOne).not.toHaveBeenCalled();
  });

  // ── 形态合法但不存在 → 404（TASK_NOT_FOUND），与 400 分界 ────────────────
  it("GET /tasks/:uuid（合法形态）service 抛 TASK_NOT_FOUND → 404 封套", async () => {
    taskService.findOne.mockRejectedValueOnce(
      new AppError("TASK_NOT_FOUND", { taskId: TASK_UUID }),
    );
    const res = await request(app.getHttpServer()).get(`/tasks/${TASK_UUID}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe(404);
    expect(res.body.errorCode).toBe("TASK_NOT_FOUND");
  });

  it("形态合法但执行不存在 → 404（TASK_EXECUTION_NOT_FOUND）", async () => {
    const execUuid = "fe2b2e65-56aa-4fb1-8f11-34e1ff902335";
    taskService.getExecution.mockRejectedValueOnce(
      new AppError("TASK_EXECUTION_NOT_FOUND", { executionId: execUuid }),
    );
    const res = await request(app.getHttpServer()).get(
      `/tasks/${TASK_UUID}/executions/${execUuid}`,
    );
    expect(res.status).toBe(404);
    expect(res.body.errorCode).toBe("TASK_EXECUTION_NOT_FOUND");
  });

  // ── 全局兜底：绕过管道的路径（如写面 body）22P02 不再 500 ────────────────
  it("22P02 QueryFailedError 冒泡到 filter → 400 INVALID_VALUE_FORMAT（不再 500）", async () => {
    taskService.findOne.mockRejectedValueOnce(pgCastError("999999"));
    const res = await request(app.getHttpServer()).get(
      "/tasks/2509e892-cb1c-4746-9505-2dfe932ebf33",
    );
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("INVALID_VALUE_FORMAT");
    expect(res.body.message).toContain("格式非法");
  });
});
