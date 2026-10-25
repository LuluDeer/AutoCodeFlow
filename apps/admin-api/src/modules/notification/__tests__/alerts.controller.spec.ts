import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { createHmac } from "crypto";
import { getRepositoryToken } from "@nestjs/typeorm";
import request from "supertest";
import {
  BadGatewayException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { AlertsController } from "../alerts.controller";
import { NotificationService } from "../notification.service";
import { Task } from "../../task/entities/task.entity";

const SECRET = "test-alert-webhook-secret";
const FIXED_NOW = 1_700_000_000_000;

function sign(timestamp: string, body: Buffer): string {
  return (
    "sha256=" +
    createHmac("sha256", SECRET)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`), body]))
      .digest("hex")
  );
}

function payloadBody(): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: "4",
      status: "firing",
      alerts: [
        {
          status: "firing",
          labels: { alertname: "PG_DOWN", severity: "critical" },
          annotations: { summary: "PostgreSQL 不可达" },
          startsAt: "2026-09-07T05:00:00Z",
        },
      ],
    }),
  );
}

describe("AlertsController webhook (OBS-02)", () => {
  let controller: AlertsController;
  let notificationService: { sendAll: jest.Mock };
  let taskRepo: { findOne: jest.Mock };
  let configGet: jest.Mock;

  beforeEach(async () => {
    jest.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
    notificationService = { sendAll: jest.fn() };
    taskRepo = { findOne: jest.fn().mockResolvedValue(null) };
    configGet = jest
      .fn()
      .mockImplementation((key: string) =>
        key === "alert.webhookSecret" ? SECRET : undefined,
      );

    const moduleRef = await Test.createTestingModule({
      controllers: [AlertsController],
      providers: [
        { provide: NotificationService, useValue: notificationService },
        { provide: ConfigService, useValue: { get: configGet } },
        { provide: getRepositoryToken(Task), useValue: taskRepo },
      ],
    }).compile();

    controller = moduleRef.get(AlertsController);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("accepts a validly signed Alertmanager payload and fans out to notification channels", async () => {
    notificationService.sendAll.mockResolvedValue({
      wecom: "sent",
      slack: "failed",
    });
    const rawBody = payloadBody();
    const timestamp = String(FIXED_NOW);

    const res = await controller.webhook(
      JSON.parse(rawBody.toString()),
      sign(timestamp, rawBody),
      timestamp,
      { rawBody } as any,
    );

    expect(res.ok).toBe(true);
    expect(res.delivered).toBe(1);
    expect(notificationService.sendAll).toHaveBeenCalledTimes(1);
    const arg = notificationService.sendAll.mock.calls[0][0];
    expect(arg.title).toBe("[Alert] PG_DOWN firing");
    expect(arg.level).toBe("error");
    expect(arg.content).toContain("PostgreSQL 不可达");
  });

  it("returns 503 (secure default) when ALERT_WEBHOOK_SECRET is not configured", async () => {
    configGet.mockImplementation(() => "");

    await expect(
      controller.webhook({ alerts: [] } as any, undefined, undefined, {
        rawBody: payloadBody(),
      } as any),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(notificationService.sendAll).not.toHaveBeenCalled();
  });

  it("rejects a wrong signature with 401", async () => {
    const rawBody = payloadBody();
    const timestamp = String(FIXED_NOW);
    const wrongSig = sign(timestamp, Buffer.from("tampered"));

    await expect(
      controller.webhook(JSON.parse(rawBody.toString()), wrongSig, timestamp, {
        rawBody,
      } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(notificationService.sendAll).not.toHaveBeenCalled();
  });

  it("rejects a stale timestamp (> 5 min window) with 401", async () => {
    const rawBody = payloadBody();
    const stale = String(FIXED_NOW - 6 * 60 * 1000);

    await expect(
      controller.webhook(
        JSON.parse(rawBody.toString()),
        sign(stale, rawBody),
        stale,
        { rawBody } as any,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(notificationService.sendAll).not.toHaveBeenCalled();
  });

  it("rejects missing signature header with 401", async () => {
    await expect(
      controller.webhook({ alerts: [] } as any, undefined, String(FIXED_NOW), {
        rawBody: payloadBody(),
      } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("400s an empty alerts array without touching the notification service", async () => {
    const rawBody = Buffer.from(JSON.stringify({ alerts: [] }));
    const timestamp = String(FIXED_NOW);

    await expect(
      controller.webhook({ alerts: [] }, sign(timestamp, rawBody), timestamp, {
        rawBody,
      } as any),
    ).rejects.toMatchObject({ status: 400 });
    expect(notificationService.sendAll).not.toHaveBeenCalled();
  });

  it("stitches tasks.runbook into the notification when labels.taskId resolves", async () => {
    taskRepo.findOne.mockResolvedValue({
      id: "task-abc",
      runbook: "1. 检查 PG 连接串\n2. 切换备库",
    });
    notificationService.sendAll.mockResolvedValue({ wecom: "sent" });
    const rawBody = Buffer.from(
      JSON.stringify({
        alerts: [
          {
            status: "firing",
            labels: { alertname: "PG_DOWN", taskId: "task-abc" },
            annotations: { summary: "PostgreSQL 不可达" },
            startsAt: "2026-09-07T05:00:00Z",
          },
        ],
      }),
    );
    const timestamp = String(FIXED_NOW);

    await controller.webhook(
      JSON.parse(rawBody.toString()),
      sign(timestamp, rawBody),
      timestamp,
      { rawBody } as any,
    );

    expect(taskRepo.findOne).toHaveBeenCalledWith({
      where: { id: "task-abc" },
    });
    const arg = notificationService.sendAll.mock.calls[0][0];
    expect(arg.content).toContain("Runbook: 1. 检查 PG 连接串\n2. 切换备库");
  });

  it("resolved-only payload sends at info level", async () => {
    notificationService.sendAll.mockResolvedValue({ wecom: "sent" });
    const rawBody = Buffer.from(
      JSON.stringify({
        alerts: [
          {
            status: "resolved",
            labels: { alertname: "PG_DOWN" },
            annotations: {},
            endsAt: "2026-09-07T05:10:00Z",
          },
        ],
      }),
    );
    const timestamp = String(FIXED_NOW);

    await controller.webhook(
      JSON.parse(rawBody.toString()),
      sign(timestamp, rawBody),
      timestamp,
      { rawBody } as any,
    );

    const arg = notificationService.sendAll.mock.calls[0][0];
    expect(arg.title).toBe("[Alert] PG_DOWN resolved");
    expect(arg.level).toBe("info");
  });

  it("502s when every channel is unconfigured/skipped (nobody received the alert)", async () => {
    notificationService.sendAll.mockResolvedValue({
      wecom: "skipped",
      slack: "skipped",
      email: "skipped",
      dingtalk: "skipped",
      webhook: "skipped",
    });
    const rawBody = payloadBody();
    const timestamp = String(FIXED_NOW);

    await expect(
      controller.webhook(
        JSON.parse(rawBody.toString()),
        sign(timestamp, rawBody),
        timestamp,
        { rawBody } as any,
      ),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it("degrades gracefully when the tasks.runbook lookup throws (alert still goes out)", async () => {
    taskRepo.findOne.mockRejectedValue(new Error("db down"));
    notificationService.sendAll.mockResolvedValue({ wecom: "sent" });
    const rawBody = Buffer.from(
      JSON.stringify({
        alerts: [
          {
            status: "firing",
            labels: { alertname: "PG_DOWN", taskId: "task-abc" },
            annotations: {},
          },
        ],
      }),
    );
    const timestamp = String(FIXED_NOW);

    const res = await controller.webhook(
      JSON.parse(rawBody.toString()),
      sign(timestamp, rawBody),
      timestamp,
      { rawBody } as any,
    );
    expect(res.ok).toBe(true);
    const arg = notificationService.sendAll.mock.calls[0][0];
    expect(arg.content).not.toContain("Runbook:");
  });
});

/**
 * F-53（UIAUDIT 后端轮 P2-2/P3-4）：webhook body 校验启用后的契约
 * （supertest 走真实参数管道——上面的直调用例绕过管道，钉不住 ValidationPipe）。
 *
 * 关键契约：
 *   · 未知键（顶层 + alerts 项内）**静默剥离**而非 400——外部 Alertmanager
 *     版本字段面不可控，这是对全站 forbidNonWhitelisted 纪律的显式例外；
 *   · 剥离发生在「已解析对象」上，HMAC 仍按 req.rawBody 原始字节校验
 *     （合法签名 + 带未知键的载荷照常放行 = 剥离不影响签名面的证明）；
 *   · 已知字段形状错 → 400 VALIDATION_FAILED。
 */
describe("AlertsController webhook body validation (F-53, supertest 真实管道)", () => {
  let app: INestApplication;
  let notificationService: { sendAll: jest.Mock };
  let taskRepo: { findOne: jest.Mock };

  function signOf(timestamp: string, body: Buffer): string {
    return (
      "sha256=" +
      createHmac("sha256", SECRET)
        .update(Buffer.concat([Buffer.from(`${timestamp}.`), body]))
        .digest("hex")
    );
  }

  beforeAll(async () => {
    notificationService = { sendAll: jest.fn() };
    taskRepo = { findOne: jest.fn().mockResolvedValue(null) };
    const moduleRef = await Test.createTestingModule({
      controllers: [AlertsController],
      providers: [
        {
          provide: NotificationService,
          useValue: notificationService,
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === "alert.webhookSecret" ? SECRET : undefined,
          },
        },
        { provide: getRepositoryToken(Task), useValue: taskRepo },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    // 控制器注册的全局 filter 在 main.ts——测试里补挂，断言 errorCode 封套。
    const { HttpExceptionFilter } = await import(
      "../../../common/filters/http-exception.filter"
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    notificationService.sendAll.mockClear();
    taskRepo.findOne.mockClear();
  });

  it("未知键（顶层 + alerts 项内）被静默剥离，合法签名照常放行（HMAC 对 rawBody 不受剥离影响）", async () => {
    notificationService.sendAll.mockResolvedValue({ wecom: "sent" });
    const rawBody = Buffer.from(
      JSON.stringify({
        version: "4",
        status: "firing",
        alerts: [
          {
            status: "firing",
            labels: { alertname: "PG_DOWN" },
            annotations: { summary: "down" },
            startsAt: "2026-10-25T00:00:00Z",
            futureFieldFromNewerAlertmanager: { nested: true },
          },
        ],
        brandNewTopLevelField: "whatever",
      }),
    );
    const timestamp = String(Date.now());

    // 注意：superagent 对 Buffer + application/json 会 JSON.stringify 再序列化
    //（wire bytes 变成 {"type":"Buffer",...}，与签名字节不一致必 401）——
    // 发签名字节的 utf8 字符串原样上送。
    const res = await request(app.getHttpServer())
      .post("/alerts/webhook")
      .set("X-AutoCodeFlow-Timestamp", timestamp)
      .set("X-Hub-Signature-256", signOf(timestamp, rawBody))
      .set("Content-Type", "application/json")
      .send(rawBody.toString("utf8"));

    expect(res.status).toBe(201);
    expect(notificationService.sendAll).toHaveBeenCalledTimes(1);
    // alertname 照常映射进标题（剥离未知键没有伤及消费字段）。
    const arg = notificationService.sendAll.mock.calls[0][0];
    expect(arg.title).toContain("PG_DOWN");
  });

  it("已知字段形状错（alerts 传字符串）→ 400 VALIDATION_FAILED 封套", async () => {
    const rawBody = Buffer.from(
      JSON.stringify({ status: "firing", alerts: "oops" }),
    );
    const timestamp = String(Date.now());

    // 注意：superagent 对 Buffer + application/json 会 JSON.stringify 再序列化
    //（wire bytes 变成 {"type":"Buffer",...}，与签名字节不一致必 401）——
    // 发签名字节的 utf8 字符串原样上送。
    const res = await request(app.getHttpServer())
      .post("/alerts/webhook")
      .set("X-AutoCodeFlow-Timestamp", timestamp)
      .set("X-Hub-Signature-256", signOf(timestamp, rawBody))
      .set("Content-Type", "application/json")
      .send(rawBody.toString("utf8"));

    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("VALIDATION_FAILED");
    expect(notificationService.sendAll).not.toHaveBeenCalled();
  });
});
