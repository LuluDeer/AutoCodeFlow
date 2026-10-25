import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { NotificationConfigController } from "../notification-config.controller";
import { NotificationConfigService } from "../notification-config.service";
import { NotificationSilenceService } from "../notification-silence.service";
import { NotificationService } from "../notification.service";
import { AuditService } from "../../../modules/audit/audit.service";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";

/**
 * F-53（UIAUDIT 后端轮 P2-2）：notification-config 两个测试端点的 body 纪律
 * （supertest 走真实参数管道；既有的 notification-config.controller.spec 直调
 * controller，绕过管道，钉不住 ValidationPipe）。
 *
 *   · POST /notification/test —— SendTestDto：多余字段 400（恢复全站
 *     forbidNonWhitelisted 纪律）；channels 走渠道枚举白名单。
 *   · POST /notification/channels/:key/test —— 动态键覆盖体不能 class DTO 化
 *     （键集随渠道类型变化），改挂 ChannelConfigOverridePipe：值必须 string、
 *     非法形状 400；合法 string→string 映射照常透传 service。
 */
describe("NotificationConfigController body 纪律（F-53）", () => {
  let app: INestApplication;
  let configService: {
    testChannel: jest.Mock;
    sendTest: jest.Mock;
  };

  beforeAll(async () => {
    configService = {
      testChannel: jest.fn().mockResolvedValue({ success: true }),
      sendTest: jest.fn().mockResolvedValue({ success: true }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationConfigController],
      providers: [
        { provide: NotificationConfigService, useValue: configService },
        { provide: NotificationService, useValue: {} },
        { provide: NotificationSilenceService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    const { ValidationPipe } = await import("@nestjs/common");
    const { HttpExceptionFilter } =
      await import("../../../common/filters/http-exception.filter");
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── POST /notification/test（SendTestDto）──────────────────────────────
  it("sendTest：多余字段 → 400 VALIDATION_FAILED", async () => {
    const res = await request(app.getHttpServer())
      .post("/notification/test")
      .send({ channels: ["email"], title: "t", content: "c", evil: 1 });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("VALIDATION_FAILED");
    expect(configService.sendTest).not.toHaveBeenCalled();
  });

  it("sendTest：channels 传未知渠道 → 400（枚举白名单，先于 service 的静默跳过）", async () => {
    const res = await request(app.getHttpServer())
      .post("/notification/test")
      .send({ channels: ["carrier-pigeon"], title: "t", content: "c" });
    expect(res.status).toBe(400);
    expect(configService.sendTest).not.toHaveBeenCalled();
  });

  it("sendTest：合法 body 透传 service", async () => {
    const res = await request(app.getHttpServer())
      .post("/notification/test")
      .send({ channels: ["email"], title: "t", content: "c" });
    expect(res.status).toBe(201);
    expect(configService.sendTest).toHaveBeenCalledWith({
      channels: ["email"],
      title: "t",
      content: "c",
    });
  });

  // ── POST /notification/channels/:key/test（动态键形状管道）─────────────
  it("testChannel：非字符串值 → 400（此前任意形状直达渠道 override）", async () => {
    const res = await request(app.getHttpServer())
      .post("/notification/channels/webhook/test")
      .send({ url: "https://ok", port: 587 });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("VALIDATION_FAILED");
    expect(configService.testChannel).not.toHaveBeenCalled();
  });

  it("testChannel：合法 string→string 覆盖体（含掩码回显 ***）照常透传", async () => {
    const res = await request(app.getHttpServer())
      .post("/notification/channels/webhook/test")
      .send({ url: "https://example/hook", password: "***" });
    expect(res.status).toBe(201);
    expect(configService.testChannel).toHaveBeenCalledWith("webhook", {
      url: "https://example/hook",
      password: "***",
    });
  });
});
