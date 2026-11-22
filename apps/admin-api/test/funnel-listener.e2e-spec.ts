import { createHash, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";

import { DOMAIN_EVENTS } from "../src/common/events/domain-events";
import { DomainEventBus } from "../src/common/services/domain-event-bus.service";
import { SecretsCryptoService } from "../src/common/utils/secret-crypto.util.service";
import { createTestApp, loginAsAdmin } from "./helpers/app.helper";

/**
 * R319 · TTFV 漏斗 listener 真链路 e2e。
 *
 * 与 R316（ttfv-journey.e2e，直接调 funnel.record）不同：本 spec **真发领域事件**
 * （DomainEventBus.emit），让 AppModule 装配的真 listener 跑，验证
 *   executor.registered / execution.completed / execution.killed / execution.failed
 *     → listener 回查链（execution→executor→deviceFingerprint→deriveAnonymousId）
 *     → funnel.record（opt-in 闸门）→ funnel_events 真落库
 * 断言全部针对真实 DB 副作用（funnel_events 行 / dedupe_key），不拿「接口 200」
 * 或内存替身充数。
 *
 * 写域只限本文件；测试库必须含 test/e2e 字样，防误连生产库。
 */
describe("TTFV funnel listener · real domain event → listener → funnel_events (e2e)", () => {
  let app: INestApplication;
  let db: DataSource;
  let bus: DomainEventBus;
  let crypto: SecretsCryptoService;
  let admin: string;
  let installId: string;
  let executorId: string;

  const PREFIX = "ttfv-listener-e2e-";
  // 合法 64-hex 测试指纹（executor-fingerprint.util.ts FINGERPRINT_RE: /^[0-9a-f]{64}$/）
  const TEST_FP = createHash("sha256")
    .update("ttfv-listener-e2e-fixture")
    .digest("hex");

  const createdTaskIds: string[] = [];
  const createdExecutionIds: string[] = [];

  const unwrap = (body: any): any => body?.data ?? body;

  /** 无 key（degraded）时显式失败，避免 listener 静默跳过导致「假绿」。 */
  function derive(input: string, purpose: string): string {
    const value = crypto.deriveAnonymousId(input, purpose);
    if (!value) {
      throw new Error(
        `deriveAnonymousId returned null for ${purpose}: SEC_SECRETS_KEY missing?`,
      );
    }
    return value;
  }

  async function postConsent(body: object): Promise<any> {
    const res = await request(app.getHttpServer())
      .post("/agent/telemetry/consent")
      .set("Authorization", `Bearer ${admin}`)
      .send(body)
      .expect(201);
    return unwrap(res.body);
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

  async function insertExecution(
    taskId: string,
    taskName: string,
    synthetic: boolean,
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

  async function rowsByDedupe(keys: string[]): Promise<any[]> {
    if (keys.length === 0) return [];
    return db.query(
      `SELECT event_name, install_id, dedupe_key, task_id_hash, execution_id_hash, ts
         FROM funnel_events WHERE dedupe_key = ANY($1) ORDER BY dedupe_key`,
      [keys],
    );
  }

  async function rowsByTaskHash(taskHash: string): Promise<any[]> {
    return db.query(
      `SELECT event_name, dedupe_key FROM funnel_events WHERE task_id_hash = $1`,
      [taskHash],
    );
  }

  /** listener 是 async fire-and-forget：poll 等落库（50ms，最多 3s），不固定 sleep。 */
  async function waitForRows(
    keys: string[],
    count: number,
    label: string,
    timeoutMs = 3000,
  ): Promise<any[]> {
    const deadline = Date.now() + timeoutMs;
    let last: any[] = [];
    while (Date.now() < deadline) {
      last = await rowsByDedupe(keys);
      if (last.length >= count) return last;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `timeout waiting ${label}: got ${last.length} rows, expected >= ${count}`,
    );
  }

  /** 只删本 spec 造的行；不 DROP 表/库。执行行先于 task，executor 单独。 */
  async function cleanup(): Promise<void> {
    if (!db || !installId) return;
    await db.query(`DELETE FROM funnel_events WHERE install_id = $1`, [
      installId,
    ]);
    await db.query(`DELETE FROM telemetry_optin WHERE install_id = $1`, [
      installId,
    ]);
    await db.query(
      `DELETE FROM task_executions WHERE "taskId" IN (
         SELECT id FROM tasks WHERE name LIKE $1)`,
      [`${PREFIX}%`],
    );
    await db.query(`DELETE FROM tasks WHERE name LIKE $1`, [`${PREFIX}%`]);
    await db.query(`DELETE FROM executors WHERE "deviceFingerprint" = $1`, [
      TEST_FP,
    ]);
  }

  beforeAll(async () => {
    if (!/(^|_)(test|e2e)(_|$)/i.test(process.env.DB_DATABASE ?? "")) {
      throw new Error(
        "funnel-listener e2e requires an explicit test/e2e database",
      );
    }
    app = await createTestApp();
    db = app.get(DataSource);
    bus = app.get(DomainEventBus);
    crypto = app.get(SecretsCryptoService);
    admin = await loginAsAdmin(app);

    installId = derive(TEST_FP, "ttfv-install");
    expect(installId).toMatch(/^[0-9a-f]{32}$/);

    // 真 listener 挂载诊断：证明事件分发确实有订阅方（不是 emit 到空总线）。
    expect(
      bus.listenerCount(DOMAIN_EVENTS.EXECUTOR_REGISTERED),
    ).toBeGreaterThanOrEqual(1);
    // COMPLETED 至少 success + attempt 两个 listener
    expect(
      bus.listenerCount(DOMAIN_EVENTS.EXECUTION_COMPLETED),
    ).toBeGreaterThanOrEqual(2);
    // KILLED 至少 attempt listener
    expect(
      bus.listenerCount(DOMAIN_EVENTS.EXECUTION_KILLED),
    ).toBeGreaterThanOrEqual(1);

    await cleanup();

    // 开系统总闸 + 授权本测试的 installId（显式派生 ID，不依赖无参分支遍历）。
    const consent = await postConsent({
      optIn: true,
      installId,
      source: "api",
    });
    expect(consent).toMatchObject({ systemEnabled: true, optedIn: true });
    expect(consent.installIds).toContain(installId);

    // 造真 executor：listener 回查链 execution.executorId → executors.deviceFingerprint
    executorId = randomUUID();
    await db.query(
      `INSERT INTO executors (id, "appName", address, "deviceFingerprint")
       VALUES ($1, $2, $3, $4)`,
      [executorId, `${PREFIX}app`, `${PREFIX}${randomUUID()}`, TEST_FP],
    );
  });

  afterAll(async () => {
    try {
      // 复位系统级副作用（关总闸 + 撤销本 install），再清行。
      if (app && admin && installId) {
        await postConsent({
          optIn: false,
          installId,
          source: "api",
        }).catch(() => undefined);
      }
      await cleanup();
    } finally {
      await app?.close();
    }
  });

  it("A · 真发 executor.registered → install_completed 落库（dedupe/install id/ts 对齐）", async () => {
    const observedAt = new Date().toISOString();
    expect(
      bus.emit(DOMAIN_EVENTS.EXECUTOR_REGISTERED, {
        installId,
        appName: `${PREFIX}app`,
        observedAt,
      }),
    ).toBe(true);

    const key = `install-completed:${installId}`;
    const rows = await waitForRows([key], 1, "install_completed");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_name: "install_completed",
      install_id: installId,
      dedupe_key: key,
    });
    expect(rows[0].task_id_hash).toBeNull();
    expect(rows[0].execution_id_hash).toBeNull();
    expect(new Date(rows[0].ts).toISOString()).toBe(observedAt);
  });

  it("B · 真发 execution.completed(success) → 一个事件被 success+attempt 两 listener 各写一行", async () => {
    const taskName = `${PREFIX}success-${randomUUID()}`;
    const taskId = await insertTask(taskName);
    const executionId = await insertExecution(taskId, taskName, false);

    const taskHash = derive(taskId, "ttfv-task");
    const execHash = derive(executionId, "ttfv-execution");
    const finishedAt = new Date().toISOString();

    expect(
      bus.emit(DOMAIN_EVENTS.EXECUTION_COMPLETED, {
        executionId,
        taskId,
        taskName,
        status: "success",
        failureReason: null,
        finishedAt,
      }),
    ).toBe(true);

    const keys = [`first-success:${taskHash}`, `first-attempted:${taskHash}`];
    const rows = await waitForRows(keys, 2, "success+attempt");
    expect(rows).toHaveLength(2);
    const success = rows.find((row) => row.event_name === "task_first_success");
    const attempt = rows.find(
      (row) => row.event_name === "task_first_attempted",
    );
    expect(success).toMatchObject({
      install_id: installId,
      dedupe_key: `first-success:${taskHash}`,
      task_id_hash: taskHash,
      execution_id_hash: execHash,
    });
    expect(attempt).toMatchObject({
      install_id: installId,
      dedupe_key: `first-attempted:${taskHash}`,
      task_id_hash: taskHash,
      execution_id_hash: execHash,
    });
    expect(new Date(success!.ts).toISOString()).toBe(finishedAt);
  });

  it("C · killed 也算 attempt：独立 task 真发 execution.killed → 新增 first-attempted，且不写 first-success", async () => {
    const taskName = `${PREFIX}killed-${randomUUID()}`;
    const taskId = await insertTask(taskName);
    const executionId = await insertExecution(taskId, taskName, false);

    const taskHash = derive(taskId, "ttfv-task");
    const execHash = derive(executionId, "ttfv-execution");
    const finishedAt = new Date().toISOString();

    expect(
      bus.emit(DOMAIN_EVENTS.EXECUTION_KILLED, {
        executionId,
        taskId,
        taskName,
        status: "killed",
        failureReason: null,
        finishedAt,
      }),
    ).toBe(true);

    const key = `first-attempted:${taskHash}`;
    const rows = await waitForRows([key], 1, "killed first-attempted");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_name: "task_first_attempted",
      install_id: installId,
      dedupe_key: key,
      task_id_hash: taskHash,
      execution_id_hash: execHash,
    });
    // success listener 只订阅 COMPLETED：KILLED 不写 first-success。
    expect(await rowsByDedupe([`first-success:${taskHash}`])).toHaveLength(0);
  });

  it("D · synthetic 排除：synthetic 执行真发 failed 不落 attempt；非 synthetic 哨兵落库证明 listener 已处理", async () => {
    // 注意：FunnelSuccessListener 无 synthetic 检查，若 emit COMPLETED 会写一行
    // first-success（与本场景「零新增」断言冲突）。故用 EXECUTION_FAILED——
    // 只有 FunnelAttemptListener 订阅，其回查 execution.synthetic=true 即跳过。
    const synTaskName = `${PREFIX}synthetic-${randomUUID()}`;
    const synTaskId = await insertTask(synTaskName);
    const synExecutionId = await insertExecution(synTaskId, synTaskName, true);
    const synTaskHash = derive(synTaskId, "ttfv-task");

    // 哨兵：非 synthetic 的独立 task，验证 listener 确实在处理这批 FAILED 事件
    // （等到哨兵落库，才断言 synthetic 的 dedupe key 仍未出现）。
    const probeTaskName = `${PREFIX}probe-${randomUUID()}`;
    const probeTaskId = await insertTask(probeTaskName);
    const probeExecutionId = await insertExecution(
      probeTaskId,
      probeTaskName,
      false,
    );
    const probeTaskHash = derive(probeTaskId, "ttfv-task");

    const finishedAt = new Date().toISOString();
    expect(
      bus.emit(DOMAIN_EVENTS.EXECUTION_FAILED, {
        executionId: synExecutionId,
        taskId: synTaskId,
        taskName: synTaskName,
        status: "failed",
        failureReason: "script_error",
        finishedAt,
      }),
    ).toBe(true);
    expect(
      bus.emit(DOMAIN_EVENTS.EXECUTION_FAILED, {
        executionId: probeExecutionId,
        taskId: probeTaskId,
        taskName: probeTaskName,
        status: "failed",
        failureReason: "script_error",
        finishedAt,
      }),
    ).toBe(true);

    await waitForRows(
      [`first-attempted:${probeTaskHash}`],
      1,
      "probe first-attempted",
    );
    // synthetic 执行被 attempt listener 跳过：新 taskHash ⇒ dedupe 不会挡，
    // 若没跳过就会落库，故此断言真正验证了 synthetic 排除。
    expect(await rowsByDedupe([`first-attempted:${synTaskHash}`])).toHaveLength(
      0,
    );
    expect(await rowsByDedupe([`first-success:${synTaskHash}`])).toHaveLength(
      0,
    );
    expect(await rowsByTaskHash(synTaskHash)).toHaveLength(0);
  });
});
