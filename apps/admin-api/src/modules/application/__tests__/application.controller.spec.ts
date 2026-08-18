import { INestApplication, UnauthorizedException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createHmac } from "crypto";
import * as express from "express";
import * as request from "supertest";
import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator";
import { AppDeploymentService } from "../app-deployment.service";
import { ApplicationController } from "../application.controller";
import { ApplicationService } from "../application.service";

function sign(secret: string, timestamp: string, body: Buffer): string {
  return (
    "sha256=" +
    createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`), body]))
      .digest("hex")
  );
}

describe("ApplicationController webhook", () => {
  const fixedNow = 1_700_000_000_000;
  let svc: {
    findByNameWithSecret: jest.Mock;
    update: jest.Mock;
  };
  let deploymentSvc: {
    findRunningByApp: jest.Mock;
    upgrade: jest.Mock;
  };
  let controller: ApplicationController;

  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(fixedNow);
    svc = {
      findByNameWithSecret: jest.fn(),
      update: jest.fn(),
    };
    deploymentSvc = {
      findRunningByApp: jest.fn().mockResolvedValue([]),
      upgrade: jest.fn(),
    };
    controller = new ApplicationController(svc as any, deploymentSvc as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("marks webhook public so CI does not need a user JWT", () => {
    expect(
      Reflect.getMetadata(IS_PUBLIC_KEY, ApplicationController.prototype.webhook),
    ).toBe(true);
  });

  it("accepts a valid timestamped raw-body signature", async () => {
    const dto = {
      appName: "my-app",
      version: "1.2.0",
      triggerDeploy: false,
    };
    const rawBody = Buffer.from(JSON.stringify(dto));
    const timestamp = String(fixedNow);
    svc.findByNameWithSecret.mockResolvedValue({
      id: "app-1",
      name: "my-app",
      webhookSecret: "secret",
    });
    svc.update.mockResolvedValue({ id: "app-1", ...dto });

    const result = await controller.webhook(
      dto,
      sign("secret", timestamp, rawBody),
      timestamp,
      { rawBody } as any,
    );

    expect(result.ok).toBe(true);
    expect(svc.update).toHaveBeenCalledWith("app-1", {
      version: "1.2.0",
    });
  });

  it("rejects matching apps that do not have a webhook secret", async () => {
    svc.findByNameWithSecret.mockResolvedValue({
      id: "app-1",
      name: "my-app",
      webhookSecret: null,
    });

    await expect(
      controller.webhook(
        { appName: "my-app", version: "1.2.0" },
        "sha256=ignored",
        String(fixedNow),
        { rawBody: Buffer.from('{"appName":"my-app","version":"1.2.0"}') } as any,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects signed apps when the signature header is missing", async () => {
    svc.findByNameWithSecret.mockResolvedValue({
      id: "app-1",
      name: "my-app",
      webhookSecret: "secret",
    });

    await expect(
      controller.webhook({ appName: "my-app", version: "1.2.0" }, undefined, String(fixedNow), {
        rawBody: Buffer.from('{"appName":"my-app","version":"1.2.0"}'),
      } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects signed apps when the timestamp is stale", async () => {
    const dto = { appName: "my-app", version: "1.2.0" };
    const rawBody = Buffer.from(JSON.stringify(dto));
    const timestamp = String(fixedNow - 10 * 60 * 1000);
    svc.findByNameWithSecret.mockResolvedValue({
      id: "app-1",
      name: "my-app",
      webhookSecret: "secret",
    });

    await expect(
      controller.webhook(dto, sign("secret", timestamp, rawBody), timestamp, {
        rawBody,
      } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects signed apps when raw body capture is unavailable", async () => {
    const dto = { appName: "my-app", version: "1.2.0" };
    const rawBody = Buffer.from(JSON.stringify(dto));
    const timestamp = String(fixedNow);
    svc.findByNameWithSecret.mockResolvedValue({
      id: "app-1",
      name: "my-app",
      webhookSecret: "secret",
    });

    await expect(
      controller.webhook(dto, sign("secret", timestamp, rawBody), timestamp, {} as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects signatures computed from a different raw body", async () => {
    const dto = { appName: "my-app", version: "1.2.0" };
    const rawBody = Buffer.from('{"version":"1.2.0","appName":"my-app"}');
    const timestamp = String(fixedNow);
    svc.findByNameWithSecret.mockResolvedValue({
      id: "app-1",
      name: "my-app",
      webhookSecret: "secret",
    });

    await expect(
      controller.webhook(
        dto,
        sign("secret", timestamp, Buffer.from(JSON.stringify(dto))),
        timestamp,
        { rawBody } as any,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe("ApplicationController webhook HTTP raw body", () => {
  const fixedNow = 1_700_000_000_000;
  let app: INestApplication;
  let svc: {
    findByNameWithSecret: jest.Mock;
    update: jest.Mock;
  };

  beforeEach(async () => {
    jest.spyOn(Date, "now").mockReturnValue(fixedNow);
    svc = {
      findByNameWithSecret: jest.fn().mockResolvedValue({
        id: "app-1",
        name: "my-app",
        webhookSecret: "secret",
      }),
      update: jest.fn().mockResolvedValue({
        id: "app-1",
        name: "my-app",
        version: "1.2.0",
      }),
    };
    const deploymentSvc = {
      findRunningByApp: jest.fn().mockResolvedValue([]),
      upgrade: jest.fn(),
    };
    const module = await Test.createTestingModule({
      controllers: [ApplicationController],
      providers: [
        { provide: ApplicationService, useValue: svc },
        { provide: AppDeploymentService, useValue: deploymentSvc },
      ],
    }).compile();

    app = module.createNestApplication();
    app.use(
      express.json({
        limit: "1mb",
        verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
          req.rawBody = Buffer.from(buf);
        },
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
    jest.restoreAllMocks();
  });

  it("verifies the exact HTTP raw JSON body, not JSON.stringify(dto)", async () => {
    const rawBody = Buffer.from('{"version":"1.2.0","appName":"my-app"}');
    const timestamp = String(fixedNow);

    await request(app.getHttpServer())
      .post("/applications/webhook")
      .set("Content-Type", "application/json")
      .set("X-AutoCodeFlow-Timestamp", timestamp)
      .set("X-Hub-Signature-256", sign("secret", timestamp, rawBody))
      .send(rawBody.toString())
      .expect(201);

    expect(svc.update).toHaveBeenCalledWith("app-1", {
      version: "1.2.0",
    });
  });
});
