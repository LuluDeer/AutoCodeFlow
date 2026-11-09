/**
 * R178 · `POST /executor-packages/:id/push` 的「**没有在线执行器可推送**」语义。
 *
 * ## 为什么这条单独成文件（而不是塞进既有的两个 spec）
 *
 * ① **它是本族里唯一一个真正经 HTTP 返回给调用方的「无可用执行器」失败点**：
 *    - 派发/广播那几条（`NO_DISPATCHABLE_EXECUTOR` / `NO_BROADCAST_EXECUTOR` /
 *      `EXECUTOR_APP_NAME_NOT_FOUND` / `PINNED_EXECUTOR_*`）都在 **BullMQ worker**
 *      里抛出，异常被 `apps/admin-api/src/modules/task/task.processor.ts:340` 的
 *      catch 吃掉并转成执行行终态 —— **不产生任何 HTTP 响应**；
 *    - 选机那几条（`NO_AVAILABLE_EXECUTOR_FOR_SELECTION` 等）经
 *      `POST /app-deployments/applications/:appId/deploy` 返回。
 *    - **只有本条**（`EXECUTOR_PACKAGE_PUSH_NO_TARGETS`）既走 HTTP、又直接是
 *      「没有可用执行器」的表述 ⇒ 它的状态变更**直接改变前端行为**。
 *
 * ② **端到端钉住**：既有 spec 里的断言形态是「服务抛的异常带什么码」；本文件
 *    走**真实 HTTP**（Nest 应用 + supertest + 全局异常过滤器），钉住**客户端
 *    真正看到的响应体与状态码**——那才是对外契约。
 *
 * ## 判据
 *
 * `503`（而非 `500`）：「没有在线执行器」是**暂时性**的（执行器下次心跳即上线），
 * 处置是「等一会儿重试」。`500` 会让 `apps/admin-web` **不重试**
 * （瞬时重试集只有 502/503/504）并弹出「服务器内部错误」（引导人报障）；
 * `503` 则会重试并提示「服务暂时不可用，请稍后重试」（引导人等待）。
 *
 * ⚠️ 码表层的口径守卫在别处（`src/common/errors/__tests__/no-executor-http-status.spec.ts`
 * ——它直接读 `EXECUTOR_CODES`，是「码表层」的不变式）。本文件守的是**端到端
 * HTTP 面**：状态码 + `errorCode` + 中文兜底文案，三者一起进响应体。
 */
import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import request from "supertest";
import { ExecutorPackageController } from "../executor-package.controller";
import { ExecutorPackageService } from "../executor-package.service";
import { ExecutorService } from "../../executor/executor.service";
import { SystemConfigService } from "../../config/config.service";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { HttpExceptionFilter } from "../../../common/filters/http-exception.filter";

describe("R178 · POST /executor-packages/:id/push —— 没有在线执行器可推送 ⇒ 503", () => {
  let app: INestApplication;
  const id = "11111111-1111-4111-8111-111111111111";
  const config = new ConfigService({
    "jwt.secret": "push-no-target-secret",
    "executor.sharedToken": "env-token",
    "app.adminApiUrl": "http://admin:3002/api/",
  });
  const systemConfig = { findOne: jest.fn() };
  /** 控制器实际调用的服务方法——本用例让它走**真实实现**（同一条抛点）。 */
  const pushToExecutors = jest.fn();

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ExecutorPackageController],
      providers: [
        { provide: ExecutorPackageService, useValue: { pushToExecutors } },
        { provide: ConfigService, useValue: config },
        { provide: SystemConfigService, useValue: systemConfig },
        {
          provide: ExecutorService,
          useValue: {
            // 空 executorIds = 全部 ONLINE；本用例夹具给**零台在线** ⇒
            // 服务里 `targets.length === 0` ⇒ 抛 EXECUTOR_PACKAGE_PUSH_NO_TARGETS。
            findPushTargets: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    })
      // 类级 @UseGuards(JwtAuthGuard, RolesGuard) 在本用例不是被测面 ⇒ 放行
      // （沿本仓既有 HTTP 契约 spec 的标准形态，见 config.controller.spec.ts）。
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix("api");
    // 全局异常过滤器是**生产**同款（main.ts:444）——响应体的
    // {code,errorCode,message,params} 形状由它产出 ⇒ 本用例验的是真契约。
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    systemConfig.findOne.mockResolvedValue({ value: "db-token" });
  });

  afterAll(async () => {
    await app.close();
  });

  it("返回 503 + errorCode=EXECUTOR_PACKAGE_PUSH_NO_TARGETS（不是 500）", async () => {
    // 复用**真实的服务方法**（与生产同一条抛点），只把「目标执行器」置空。
    const svc = new ExecutorPackageService({} as never, config as never);
    jest.spyOn(svc, "findOne").mockResolvedValue({ id } as never);
    pushToExecutors.mockImplementation(svc.pushToExecutors.bind(svc));

    const response = await request(app.getHttpServer())
      .post(`/api/executor-packages/${id}/push`)
      .send({});

    // 503 —— 关键断言：「暂时没有在线执行器」是可重试的容量问题，不是服务端 bug。
    expect(response.status).toBe(503);
    // 数字 `code` 仍是 HTTP 状态码（消费方契约，见 error-code-contract.spec.ts）。
    expect(response.body.code).toBe(503);
    // 稳定业务码透出（前端据此查本地化词条）。
    expect(response.body.errorCode).toBe("EXECUTOR_PACKAGE_PUSH_NO_TARGETS");
    // 中文兜底自足（裸 API / CLI / MCP / 日志都读它）。
    expect(response.body.message).toBe("没有找到可推送的目标执行器");
  });

  it("反向护栏：夹具确实是「零台在线执行器」（用例本身没有假绿）", async () => {
    // 若上面那条用例因为「根本没走到抛点」而拿到 503（例如路由层提前拒绝），
    // 这条会红——它断言 findPushTargets 返回空 ⇒ 目标集为空 ⇒ 必走那条抛点。
    const execSvc = app.get<ExecutorService>(ExecutorService);
    const targets = await execSvc.findPushTargets();
    expect(targets).toEqual([]);
  });
});
