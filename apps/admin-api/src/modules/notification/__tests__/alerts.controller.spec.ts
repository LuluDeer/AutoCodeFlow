import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { createHmac } from "crypto";
import { getRepositoryToken } from "@nestjs/typeorm";
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
