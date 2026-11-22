import { createHash, createHmac, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";

import { DOMAIN_EVENTS } from "../src/common/events/domain-events";
import { AgentExecutionConfirmationService } from "../src/modules/agent/runtime/agent-execution-confirmation.service";
import { DomainEventBus } from "../src/common/services/domain-event-bus.service";
import { SecretsCryptoService } from "../src/common/utils/secret-crypto.util.service";
import { createTestApp, loginAsAdmin } from "./helpers/app.helper";

/**
 * R325 独立验收切片③ —— 「被业务确认」全链路真进程内 e2e。
 *
 * 与 R319（funnel-listener.e2e）不同：本 spec **不直接 emit 领域事件**，而是
 * 真打 `POST /agent/executions/:execId/confirm`，由端点内部的真 service emit
 * `execution.confirmed`，AppModule 装配的真 listener 回查执行行 → executor
 * 指纹 → 匿名 ID → `FunnelEventsService.record`（opt-in 单一闸门）→ 真 PG
 * `funnel_events` 落库。全部断言针对真实 DB 副作用与端点真实响应。
 *
 * 写域只限本文件；测试库必须含 test/e2e 字样，防误连生产库。口令只从进程
 * 环境读、不进文件、不进日志。
 */
describe("business_confirmed · confirm endpoint → domain event → listener → funnel_events (e2e)", () => {
  let app: INestApplication;
  let db: DataSource;
  let bus: DomainEventBus;
  let crypto: SecretsCryptoService;
  let admin: string;

  const PREFIX = "bc-confirm-e2e-";
  const CONFIRM_EVENT = "execution.confirmed";

  // 两枚合法 64-hex 指纹：主场景（授权）+ 隐私解耦场景（未授权）。
  const FP_AUTH = createHash("sha256")
    .update("r325-business-confirmed-auth-fixture")
    .digest("hex");
  const FP_UNAUTH = createHash("sha256")
    .update("r325-business-confirmed-unauth-fixture")
    .digest("hex");

  let installAuth = "";
  let installUnauth = "";
  let executorAuthId = "";
  let executorUnauthId = "";

  const createdTaskIds: string[] = [];
  const createdExecutionIds: string[] = [];

  const unwrap = (body: any): any => body?.data ?? body;

  const witness = (label: string, payload: object): void => {
    console.log(`[BC-E2E-WITNESS] ${label} ${JSON.stringify(payload)}`);
  };

  /** 无 SEC_SECRETS_KEY（degraded）时显式失败，避免 listener 静默跳过造成假绿。 */
  function derive(input: string, purpose: string): string {
    const value = crypto.deriveAnonymousId(input, purpose);
    if (!value) {
      throw new Error(
        `deriveAnonymousId returned null for ${purpose}: SEC_SECRETS_KEY missing?`,
      );
    }
    return value;
  }

  /**
   * 独立 HMAC 见证：不经过应用服务，直接用 .env 注入的 fixture key 复算
   * deriveAnonymousId（32 hex 截断）。与 DB 落库列逐字对比，证明 install_id
   * 真由指纹派生且无原文泄漏。
   */
  function rawDerive(input: string, purpose: string): string | null {
    const raw = process.env.SEC_SECRETS_KEY;
    if (!raw) return null;
    const trimmed = raw.trim();
    const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
      ? Buffer.from(trimmed, "hex")
      : createHash("sha256").update(trimmed, "utf8").digest();
    return createHmac("sha256", key)
      .update(`${purpose}:${input}`)
      .digest("hex")
      .slice(0, 32);
  }

  async function postConsent(body: object): Promise<any> {
    const res = await request(app.getHttpServer())
      .post("/agent/telemetry/consent")
      .set("Authorization", `Bearer ${admin}`)
      .send(body)
      .expect(201);
    return unwrap(res.body);
  }

  async function getStatus(): Promise<any> {
    const res = await request(app.getHttpServer())
      .get("/agent/telemetry/status")
      .set("Authorization", `Bearer ${admin}`)
      .expect(200);
    return unwrap(res.body);
  }

  /** 真打端点，不预设状态码（成功断言在用例内，404 例外单独断言）。 */
  async function postConfirm(execId: string) {
    return request(app.getHttpServer())
      .post(`/agent/executions/${execId}/confirm`)
      .set("Authorization", `Bearer ${admin}`)
      .send({});
  }

  async function insertTask(name: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO tasks (id, name, "triggerType") VALUES ($1, $2, 'manual')`,
      [id, name],
    );
    createdTaskIds.push(id);
    return id;
  }

  async function insertExecutor(fingerprint: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO executors (id, "appName", address, "deviceFingerprint")
       VALUES ($1, $2, $3, $4)`,
      [id, `${PREFIX}app`, `${PREFIX}${randomUUID()}`, fingerprint],
    );
    return id;
  }

  async function insertExecution(
    taskId: string,
    taskName: string,
    executorId: string,
    synthetic = false,
  ): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO task_executions (id, "taskId", "taskName", "executorId", synthetic)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, taskId, taskName, executorId, synthetic],
    );
    createdExecutionIds.push(id);
    return id;
  }

  async function rowsByKey(key: string): Promise<any[]> {
    return db.query(
      `SELECT event_name, install_id, dedupe_key, task_id_hash, execution_id_hash, ts,
              created_at AS "createdAt"
         FROM funnel_events WHERE dedupe_key = $1 ORDER BY ts`,
      [key],
    );
  }

  /** listener 是 async fire-and-forget：poll 等落库（50ms/3s），不固定 sleep。 */
  async function waitForRows(
    key: string,
    count: number,
    label: string,
    timeoutMs = 3000,
  ): Promise<any[]> {
    const deadline = Date.now() + timeoutMs;
    let last: any[] = [];
    while (Date.now() < deadline) {
      last = await rowsByKey(key);
      if (last.length >= count) return last;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `timeout waiting ${label}: got ${last.length} rows, expected >= ${count} (key=${key})`,
    );
  }

  /**
   * 反证用：在一个完整短窗口内持续查库，一旦目标行出现立即失败。
   * 调用方需先让一个「已授权哨兵」落库，证明 listener 在该窗口确实活着。
   */
  async function waitAbsent(
    key: string,
    windowMs: number,
    label: string,
  ): Promise<void> {
    const deadline = Date.now() + windowMs;
    do {
      const rows = await rowsByKey(key);
      if (rows.length > 0) {
        throw new Error(
          `${label}: unauthorized execution wrote ${rows.length} row(s): ${JSON.stringify(rows)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
  }

  /** 只删本 spec 造的行；按 FK 顺序：funnel → execution → task → executor → optin。 */
  async function cleanup(): Promise<void> {
    if (!db) return;
    const installs = [installAuth, installUnauth].filter(Boolean);
    if (installs.length > 0) {
      await db.query(
        `DELETE FROM funnel_events WHERE install_id = ANY($1)`,
        [installs],
      );
    }
    if (createdExecutionIds.length > 0) {
      await db.query(
        `DELETE FROM task_executions WHERE id = ANY($1)`,
        [createdExecutionIds],
      );
    }
    if (createdTaskIds.length > 0) {
      await db.query(`DELETE FROM tasks WHERE id = ANY($1)`, [createdTaskIds]);
    }
    const fps = [FP_AUTH, FP_UNAUTH];
    await db.query(
      `DELETE FROM executors WHERE "deviceFingerprint" = ANY($1)`,
      [fps],
    );
    if (installs.length > 0) {
      await db.query(`DELETE FROM telemetry_optin WHERE install_id = ANY($1)`, [
        installs,
      ]);
    }
  }

  let mainExecId = "";
  let mainKey = "";

  beforeAll(async () => {
    if (!/(^|_)(test|e2e)(_|$)/i.test(process.env.DB_DATABASE ?? "")) {
      throw new Error(
        "business-confirmed e2e requires an explicit test/e2e database",
      );
    }
    app = await createTestApp();
    db = app.get(DataSource);
    bus = app.get(DomainEventBus);
    crypto = app.get(SecretsCryptoService);
    admin = await loginAsAdmin(app);

    expect(DOMAIN_EVENTS.EXECUTION_CONFIRMED).toBe(CONFIRM_EVENT);
    // 真监听挂载诊断：证明 emit 不是打到空总线（无订阅方则后续断言无意义）。
    expect(bus.listenerCount(CONFIRM_EVENT)).toBeGreaterThanOrEqual(1);

    installAuth = derive(FP_AUTH, "ttfv-install");
    installUnauth = derive(FP_UNAUTH, "ttfv-install");
    expect(installAuth).toMatch(/^[0-9a-f]{32}$/);
    expect(installUnauth).toMatch(/^[0-9a-f]{32}$/);
    expect(rawDerive(FP_AUTH, "ttfv-install")).toBe(installAuth);
    expect(rawDerive(FP_UNAUTH, "ttfv-install")).toBe(installUnauth);

    await cleanup();

    // 开系统总闸 + 授权主场景 install（显式 installId，不依赖无参遍历）。
    const consent = await postConsent({
      optIn: true,
      installId: installAuth,
      source: "api",
    });
    expect(consent).toMatchObject({ systemEnabled: true, optedIn: true });
    expect(consent.installIds).toContain(installAuth);

    executorAuthId = await insertExecutor(FP_AUTH);
    executorUnauthId = await insertExecutor(FP_UNAUTH);

    witness("setup", {
      installAuth,
      installUnauth,
      confirmEvent: CONFIRM_EVENT,
      listeners: bus.listenerCount(CONFIRM_EVENT),
    });
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    try {
      // 复位系统级副作用（关总闸 + 撤销本 spec install），再按 FK 顺序清行。
      if (app && admin && installAuth) {
        await postConsent({
          optIn: false,
          installId: installAuth,
          source: "api",
        }).catch(() => undefined);
      }
      await cleanup();
    } finally {
      await app?.close();
    }
  });

  it("A · 主场景：真端点确认 → confirmation 事件 → listener → business_confirmed 真落库", async () => {
    const taskName = `${PREFIX}main-${randomUUID()}`;
    const taskId = await insertTask(taskName);
    const execId = await insertExecution(
      taskId,
      taskName,
      executorAuthId,
      false,
    );
    mainExecId = execId;
    mainKey = `confirmed:${derive(execId, "ttfv-execution")}`;

    const res = await postConfirm(execId);
    expect([200, 201]).toContain(res.status);
    const body = unwrap(res.body);
    expect(body.ok).toBe(true);
    expect(typeof body.confirmedAt).toBe("string");
    const confirmedAtMs = new Date(body.confirmedAt).getTime();
    expect(Number.isFinite(confirmedAtMs)).toBe(true);

    const rows = await waitForRows(mainKey, 1, "business_confirmed/main");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.event_name).toBe("business_confirmed");
    expect(row.dedupe_key).toBe(mainKey);
    expect(row.dedupe_key).toMatch(/^confirmed:[0-9a-f]{32}$/);
    expect(row.execution_id_hash).toBeTruthy();
    expect(row.execution_id_hash).toBe(derive(execId, "ttfv-execution"));
    expect(row.install_id).toBe(installAuth);
    expect(row.install_id).toBe(rawDerive(FP_AUTH, "ttfv-install"));
    expect(row.task_id_hash).toBe(derive(taskId, "ttfv-task"));
    // ts 取端点返回的真实确认时刻，不是入库 createdAt，也不是 listener 当前时间。
    const tsMs = new Date(row.ts).getTime();
    expect(Math.abs(tsMs - confirmedAtMs)).toBeLessThanOrEqual(2000);

    witness("main-insert", {
      executionId: execId,
      dedupeKey: row.dedupe_key,
      eventName: row.event_name,
      installId: row.install_id,
      executionIdHash: row.execution_id_hash,
      taskIdHash: row.task_id_hash,
      confirmedAt: body.confirmedAt,
      ts: new Date(row.ts).toISOString(),
      createdAt: new Date(row["createdAt"]).toISOString(),
      deltaMs: tsMs - confirmedAtMs,
    });
  });

  it("B · 幂等：重复确认同一 execution，漏斗仍只有一行（dedupeKey 生效）", async () => {
    expect(mainExecId).toBeTruthy();
    const res2 = await postConfirm(mainExecId);
    expect([200, 201]).toContain(res2.status);
    expect(unwrap(res2.body).ok).toBe(true);

    // 给第二次 emit 的 listener 一个完整处理窗口，再断言没有新增行。
    await new Promise((resolve) => setTimeout(resolve, 800));
    const rows = await rowsByKey(mainKey);
    expect(rows).toHaveLength(1);
    witness("idempotent", {
      executionId: mainExecId,
      dedupeKey: mainKey,
      rowCount: rows.length,
    });
  });

  it("C · 未授权不落库（隐私解耦）：端点仍 ok:true，授权哨兵落库证明 listener 活着", async () => {
    // 精准控制实例级闸门：先撤销未授权 install（并关总闸），再用已授权 install
    // 重开总闸 ⇒ 全局闸开、installUnauth 仍 opt_in=false，隔离出「实例未授权」。
    const revoked = await postConsent({
      optIn: false,
      installId: installUnauth,
      source: "api",
    });
    expect(revoked).toMatchObject({ systemEnabled: false, optedIn: false });
    const reopened = await postConsent({
      optIn: true,
      installId: installAuth,
      source: "api",
    });
    expect(reopened).toMatchObject({ systemEnabled: true, optedIn: true });

    const optinRows: {
      install_id: string;
      opt_in: boolean;
      source: string;
    }[] = await db.query(
      `SELECT install_id, opt_in, source FROM telemetry_optin WHERE install_id = ANY($1)`,
      [[installAuth, installUnauth]],
    );
    expect(optinRows.find((r) => r.install_id === installAuth)?.opt_in).toBe(
      true,
    );
    expect(optinRows.find((r) => r.install_id === installUnauth)?.opt_in).toBe(
      false,
    );
    expect((await getStatus()).systemEnabled).toBe(true);

    const unauthTask = `${PREFIX}unauth-${randomUUID()}`;
    const unauthTaskId = await insertTask(unauthTask);
    const unauthExecId = await insertExecution(
      unauthTaskId,
      unauthTask,
      executorUnauthId,
      false,
    );
    const unauthKey = `confirmed:${derive(unauthExecId, "ttfv-execution")}`;

    // 已授权哨兵：与未授权执行在同一窗口确认，用于反证「不是 listener 没跑」。
    const probeTask = `${PREFIX}probe-${randomUUID()}`;
    const probeTaskId = await insertTask(probeTask);
    const probeExecId = await insertExecution(
      probeTaskId,
      probeTask,
      executorAuthId,
      false,
    );
    const probeKey = `confirmed:${derive(probeExecId, "ttfv-execution")}`;

    const res = await postConfirm(unauthExecId);
    expect([200, 201]).toContain(res.status);
    const body = unwrap(res.body);
    // PM 明确：业务可用性不受 telemetry 授权影响——未授权也照常确认成功。
    expect(body.ok).toBe(true);
    expect(typeof body.confirmedAt).toBe("string");

    const probeRes = await postConfirm(probeExecId);
    expect(unwrap(probeRes.body).ok).toBe(true);
    const probeRows = await waitForRows(probeKey, 1, "authorized probe");
    expect(probeRows).toHaveLength(1);
    expect(probeRows[0].install_id).toBe(installAuth);

    await waitAbsent(unauthKey, 700, "unauthorized execution");
    expect(await rowsByKey(unauthKey)).toHaveLength(0);

    witness("unauthorized-no-write", {
      executionId: unauthExecId,
      dedupeKey: unauthKey,
      endpointOk: body.ok,
      confirmedAt: body.confirmedAt,
      systemEnabled: true,
      installAuthOptIn: true,
      installUnauthOptIn: false,
      probeDedupeKey: probeKey,
      probeRows: probeRows.length,
      unauthorizedRows: 0,
    });
  });

  it("D · 不存在的 execution：端点 404（TASK_EXECUTION_NOT_FOUND）", async () => {
    // 形态合法但库里不存在的 UUID：命中 service 的 not_found 分支（controller:1083）。
    const missingId = randomUUID();
    const res = await request(app.getHttpServer())
      .post(`/agent/executions/${missingId}/confirm`)
      .set("Authorization", `Bearer ${admin}`)
      .send({});
    expect(res.status).toBe(404);
    const body = res.body ?? {};
    expect(body.errorCode ?? unwrap(body).errorCode).toBe(
      "TASK_EXECUTION_NOT_FOUND",
    );
    witness("not-found", {
      executionId: missingId,
      status: res.status,
      errorCode: body.errorCode ?? unwrap(body).errorCode,
    });
  });

  /**
   * R431 切片②：非法 execId 字面量在第一现场（ParseUuidShapePipe，controller 之前）
   * 被拒：状态码 400 + errorCode=INVALID_VALUE_FORMAT，且 confirm service 零调用。
   * 反证「没查 DB」：若 pipe 未生效，请求会进 controller→service→PG，触发 22P02→500
   * （R330 现场），同时 confirm 会被调用一次——这里两个断言同时钉死这条链。
   */
  it("E · 非法 execId 字面量：400 INVALID_VALUE_FORMAT + confirm service 未被调用（第一现场）", async () => {
    const confirmation = app.get(AgentExecutionConfirmationService);
    const confirmSpy = jest.spyOn(confirmation, "confirm");
    try {
      const rawId = "nonexistent-uuid"; // 字面非 UUID，不是「合法但不存在」。
      const res = await postConfirm(rawId);
      expect(res.status).toBe(400);
      const body = res.body ?? {};
      expect(body.errorCode ?? unwrap(body).errorCode).toBe(
        "INVALID_VALUE_FORMAT",
      );
      // 第一现场关键证据：pipe 在进 controller 之前就拒了，confirm 一次都不该被调用。
      expect(confirmSpy).not.toHaveBeenCalled();
      witness("invalid-id-shape-first-line", {
        executionId: rawId,
        status: res.status,
        errorCode: body.errorCode ?? unwrap(body).errorCode,
        confirmCalls: confirmSpy.mock.calls.length,
      });
    } finally {
      confirmSpy.mockRestore();
    }
  });
});
