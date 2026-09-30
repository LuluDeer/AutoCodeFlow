import { Test, type TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { createHmac } from "crypto";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { TaskWebhookController } from "../task-webhook.controller";
import { TaskWebhookService } from "../task-webhook.service";
import { TaskService } from "../task.service";
import { SecretsCryptoService } from "../../../common/utils/secret-crypto.util.service";
import { AuditService } from "../../audit/audit.service";
import { Task } from "../entities/task.entity";
import { TaskExecution } from "../entities/task-execution.entity";

/**
 * FEAT-21: 任务 webhook 入站触发 spec（controller + service 行为）。
 *
 * 安全契约：任务不存在 / 未启用 / 签名失败 → **同一条 401 消息**（反枚举，
 * APP-001 先例）；HMAC 纪律与 applications/alerts 同源（webhook-hmac.util）。
 */

const HOOK_SECRET = "plain-hook-secret";
const API_BASE = "https://api.example.com";
const FIXED_NOW = 1_700_000_000_000;
const BODY = Buffer.from(JSON.stringify({ params: { rowId: "rec123" } }));

function sign(timestamp: string, body: Buffer, secret = HOOK_SECRET): string {
  return (
    "sha256=" +
    createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`), body]))
      .digest("hex")
  );
}

const TASK_ID = "11111111-1111-4111-8111-111111111111";

function taskRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: TASK_ID,
    name: "rpa-job",
    webhookSecret: `enc:v1:${HOOK_SECRET}`,
    ownerUserId: 7,
    projectId: null,
    ...overrides,
  };
}

function chainableRepo(row: Record<string, unknown> | null) {
  const qb: Record<string, unknown> = {};
  qb.addSelect = jest.fn().mockReturnValue(qb);
  qb.where = jest.fn().mockReturnValue(qb);
  qb.andWhere = jest.fn().mockReturnValue(qb);
  qb.getOne = jest.fn().mockResolvedValue(row);
  return { createQueryBuilder: jest.fn().mockReturnValue(qb) };
}

describe("TaskWebhookController / TaskWebhookService（FEAT-21）", () => {
  let moduleRef: TestingModule;
  let controller: TaskWebhookController;
  let taskRepo: { createQueryBuilder: jest.Mock; update: jest.Mock };
  let execRepo: { findOne: jest.Mock };
  let taskService: {
    trigger: jest.Mock;
    assertCanOperate: jest.Mock;
  };
  let secretsCrypto: {
    encryptionEnabled: boolean;
    encryptValue: jest.Mock;
    decryptValue: jest.Mock;
  };
  let audit: { log: jest.Mock };
  let dateNowSpy: jest.SpyInstance<number, []>;

  beforeEach(async () => {
    dateNowSpy = jest.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
    taskRepo = {
      ...chainableRepo(taskRow()),
      update: jest.fn().mockResolvedValue({}),
    };
    execRepo = { findOne: jest.fn() };
    taskService = {
      trigger: jest.fn().mockResolvedValue({ id: "exec-1", status: "pending" }),
      assertCanOperate: jest.fn().mockResolvedValue(undefined),
    };
    secretsCrypto = {
      encryptionEnabled: true,
      encryptValue: jest.fn((v: string) => `enc:v1:test|${v}`),
      decryptValue: jest.fn((envelope: string) =>
        envelope.startsWith("enc:v1:") ? HOOK_SECRET : envelope,
      ),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };

    moduleRef = await Test.createTestingModule({
      controllers: [TaskWebhookController],
      providers: [
        TaskWebhookService,
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getRepositoryToken(TaskExecution), useValue: execRepo },
        { provide: TaskService, useValue: taskService },
        { provide: SecretsCryptoService, useValue: secretsCrypto },
        { provide: ConfigService, useValue: { get: jest.fn(() => API_BASE) } },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    controller = moduleRef.get(TaskWebhookController);
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  const callTrigger = (
    dto: Record<string, unknown> = { params: { rowId: "rec123" } },
    opts: {
      signature?: string;
      timestamp?: string;
      rawBody?: Buffer;
      wait?: string;
      timeout?: string;
    } = {},
  ) =>
    controller.trigger(
      TASK_ID,
      dto as never,
      opts.signature ?? sign(String(FIXED_NOW), opts.rawBody ?? BODY),
      opts.timestamp ?? String(FIXED_NOW),
      opts.wait,
      opts.timeout,
      "203.0.113.9",
      { rawBody: opts.rawBody ?? BODY } as never,
    );

  // ── 公开触发：反枚举 401 三态同消息 ────────────────────────────────────

  it("未知任务 / 未启用 / 签名失败 → 同一条 401 消息（taskId 枚举不可探测）", async () => {
    (taskRepo.createQueryBuilder as jest.Mock).mockReturnValue(
      (() => {
        const qb = chainableRepo(null);
        return qb.createQueryBuilder();
      })(),
    );
    const unknownTaskErr = await callTrigger().catch((e) => e);

    (taskRepo.createQueryBuilder as jest.Mock).mockReturnValue(
      (() => {
        const qb = chainableRepo(taskRow({ webhookSecret: null }));
        return qb.createQueryBuilder();
      })(),
    );
    const disabledErr = await callTrigger().catch((e) => e);

    const badSigErr = await callTrigger(undefined, {
      signature: "sha256=deadbeef",
    }).catch((e) => e);

    for (const err of [unknownTaskErr, disabledErr, badSigErr]) {
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(err.message).toBe("Task webhook authentication failed");
    }
  });

  it("过期时间戳 → 同一条 401", async () => {
    const stale = String(FIXED_NOW - 6 * 60 * 1000);
    const err = await callTrigger(undefined, {
      signature: sign(stale, BODY),
      timestamp: stale,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.message).toBe("Task webhook authentication failed");
  });

  // ── 公开触发：成功链路 ────────────────────────────────────────────────

  it("合法签名 + params → trigger(id, { params }, null, 'webhook')，明文密钥经 decryptValue 解出", async () => {
    const result = await callTrigger();
    expect(secretsCrypto.decryptValue).toHaveBeenCalledWith(
      `enc:v1:${HOOK_SECRET}`,
    );
    expect(taskService.trigger).toHaveBeenCalledWith(
      TASK_ID,
      { params: { rowId: "rec123" } },
      null,
      "webhook",
    );
    expect(result).toEqual({ id: "exec-1", status: "pending" });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task.trigger_webhook",
        resourceId: TASK_ID,
        ip: "203.0.113.9",
      }),
    );
  });

  it("空 body（无 params 键）→ trigger 用 {}（任务默认 params 语义）", async () => {
    await callTrigger({}, { rawBody: Buffer.from("{}") });
    expect(taskService.trigger).toHaveBeenLastCalledWith(
      TASK_ID,
      {},
      null,
      "webhook",
    );
  });

  it("params 超 64KB → 400（auth 通过后才校验，先 401 后 400 顺序不泄露）", async () => {
    const bigParams = { blob: "x".repeat(70_000) };
    const bigBody = Buffer.from(JSON.stringify({ params: bigParams }));
    await expect(
      callTrigger({ params: bigParams }, { rawBody: bigBody }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(taskService.trigger).not.toHaveBeenCalled();
  });

  // ── 同步等待模式 ──────────────────────────────────────────────────────

  it("wait=1：执行已终态 → completed=true + 白名单视图（无 logs/secrets）", async () => {
    execRepo.findOne.mockResolvedValue({
      id: "exec-1",
      taskId: TASK_ID,
      taskName: "rpa-job",
      status: "success",
      result: { screenshot: "/m/1.png" },
      errorMessage: null,
      failureReason: null,
      startTime: new Date(FIXED_NOW),
      endTime: new Date(FIXED_NOW + 1000),
      duration: 1000,
      executorAddress: "10.0.0.8:9000",
      exitCode: 0,
      logs: "HUGE LOGS SHOULD NOT LEAK",
    });
    const result = (await callTrigger(undefined, { wait: "1" })) as unknown as {
      completed: boolean;
      execution: Record<string, unknown>;
    };
    expect(result.completed).toBe(true);
    expect(result.execution).toMatchObject({
      id: "exec-1",
      status: "success",
      result: { screenshot: "/m/1.png" },
    });
    expect(JSON.stringify(result)).not.toContain("HUGE LOGS");
  });

  it("wait=1 超时 → completed=false + 最新快照（不视为错误）", async () => {
    let now = FIXED_NOW;
    dateNowSpy.mockImplementation(() => (now += 700));
    execRepo.findOne.mockResolvedValue({
      id: "exec-1",
      taskId: TASK_ID,
      taskName: "rpa-job",
      status: "running",
      result: null,
    });
    const result = (await callTrigger(undefined, {
      wait: "1",
      timeout: "1",
    })) as { completed: boolean; execution: { status: string } | null };
    expect(result.completed).toBe(false);
    expect(result.execution?.status).toBe("running");
  }, 10_000);

  // ── 管理面 ────────────────────────────────────────────────────────────

  const svc = () =>
    moduleRef.get(TaskWebhookService) as unknown as {
      getStatus: (id: string, user: unknown) => Promise<unknown>;
      enable: (
        id: string,
        user: unknown,
        ip: string | null,
      ) => Promise<unknown>;
      disable: (
        id: string,
        user: unknown,
        ip: string | null,
      ) => Promise<unknown>;
    };

  it("getStatus：enabled + url（secret 永不回传）", async () => {
    const status = (await svc().getStatus(TASK_ID, {
      id: 7,
      role: "admin",
    })) as { enabled: boolean; url: string };
    expect(status).toEqual({
      enabled: true,
      url: `${API_BASE}/api/webhooks/tasks/${TASK_ID}`,
    });
    expect(JSON.stringify(status)).not.toContain(HOOK_SECRET);
  });

  it("enable：生成 acfw_ 前缀密钥、加密落库、一次性回显明文", async () => {
    const issued = (await svc().enable(
      TASK_ID,
      { id: 7, role: "admin" },
      "1.2.3.4",
    )) as {
      url: string;
      secret: string;
    };
    expect(issued.secret).toMatch(/^acfw_[0-9a-f]{64}$/);
    expect(issued.url).toBe(`${API_BASE}/api/webhooks/tasks/${TASK_ID}`);
    expect(secretsCrypto.encryptValue).toHaveBeenCalledWith(issued.secret);
    expect(taskRepo.update).toHaveBeenCalledWith(TASK_ID, {
      webhookSecret: `enc:v1:test|${issued.secret}`,
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.webhook_enable" }),
    );
  });

  it("disable：置 NULL + 审计", async () => {
    const result = (await svc().disable(
      TASK_ID,
      { id: 7, role: "admin" },
      null,
    )) as {
      enabled: boolean;
    };
    expect(result).toEqual({ enabled: false });
    expect(taskRepo.update).toHaveBeenCalledWith(TASK_ID, {
      webhookSecret: null,
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "task.webhook_disable" }),
    );
  });

  it("assertCanOperate 拒绝（viewer）→ 403 透传", async () => {
    taskService.assertCanOperate.mockRejectedValue(
      new ForbiddenException("viewer"),
    );
    await expect(
      svc().enable(TASK_ID, { id: 3, role: "viewer" }, null),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("任务不存在（管理面）→ 404", async () => {
    (taskRepo.createQueryBuilder as jest.Mock).mockReturnValue(
      (() => {
        const qb = chainableRepo(null);
        return qb.createQueryBuilder();
      })(),
    );
    await expect(
      svc().getStatus(TASK_ID, { id: 7, role: "admin" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("降级模式（key 未配置）明文存储、明文可读", async () => {
    secretsCrypto.encryptionEnabled = false;
    const issued = (await svc().enable(
      TASK_ID,
      { id: 7, role: "admin" },
      null,
    )) as {
      secret: string;
    };
    expect(secretsCrypto.encryptValue).not.toHaveBeenCalled();
    expect(taskRepo.update).toHaveBeenCalledWith(TASK_ID, {
      webhookSecret: issued.secret,
    });

    // 明文行触发链路：resolveSecret 走 isEncryptedSecret 分支原样返回
    (taskRepo.createQueryBuilder as jest.Mock).mockReturnValue(
      (() => {
        const qb = chainableRepo(taskRow({ webhookSecret: issued.secret }));
        return qb.createQueryBuilder();
      })(),
    );
    const rawBody = Buffer.from("{}");
    await controller.trigger(
      TASK_ID,
      {} as never,
      sign(String(FIXED_NOW), rawBody, issued.secret),
      String(FIXED_NOW),
      undefined,
      undefined,
      "1.2.3.4",
      { rawBody } as never,
    );
    expect(taskService.trigger).toHaveBeenCalled();
  });
});
