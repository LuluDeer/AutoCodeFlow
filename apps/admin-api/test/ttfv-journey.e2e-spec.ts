import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";

import { FunnelEventsService } from "../src/modules/agent/runtime/funnel-events.service";
import { createTestApp, loginAsAdmin } from "./helpers/app.helper";

/**
 * TTFV 全链路 e2e（R316）：真 Nest + 真 PG + 真 Redis + 真 supertest 传输。
 *
 * 断言的是**真实 DB 副作用**（funnel_events / telemetry_optin 的行），
 * 不用「接口 200」代替验收：
 *   A. 总闸关闭 + install 未授权 ⇒ funnel.record 真被拦（零行）
 *   B. consent API 开闸/授权 ⇒ record 真落库 ⇒ status 可查 ⇒ dedupeKey 幂等
 *   C. consent API 撤销 ⇒ record 真被拦（行数不变）
 *
 * 写入域只限本文件；测试库必须含 e2e/test 字样，防止误连生产库。
 */
describe("TTFV journey · authorization → gate → funnel event → persistence → metrics (e2e)", () => {
  let app: INestApplication;
  let db: DataSource;
  let funnel: FunnelEventsService;
  let admin: string;

  const prefix = "ttfv-e2e-";
  const installId = `${prefix}${randomUUID()}`;
  const keyInstall = `${installId}:install_completed`;
  const keySuccess = `${installId}:task_first_success`;
  const keyGated = `${installId}:gated`;
  const keyOptOut = `${installId}:opt_out_blocked`;

  const unwrap = (body: any): any => body?.data ?? body;

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

  async function eventRows(): Promise<
    {
      event_name: string;
      install_id: string;
      dedupe_key: string;
      task_id_hash: string | null;
      execution_id_hash: string | null;
    }[]
  > {
    return db.query(
      `SELECT event_name, install_id, dedupe_key, task_id_hash, execution_id_hash
         FROM funnel_events WHERE install_id = $1 ORDER BY event_name`,
      [installId],
    );
  }

  /** 只删本 spec 前缀的事实行，共享测试库里的其它用例数据不动。 */
  async function cleanup(): Promise<void> {
    if (!db) return;
    await db.query("DELETE FROM funnel_events WHERE install_id LIKE $1", [
      `${prefix}%`,
    ]);
    await db.query("DELETE FROM telemetry_optin WHERE install_id LIKE $1", [
      `${prefix}%`,
    ]);
  }

  beforeAll(async () => {
    if (!/(^|_)(test|e2e)(_|$)/i.test(process.env.DB_DATABASE ?? "")) {
      throw new Error(
        "TTFV journey requires an explicit test/e2e database (e.g. autoflow_ttfv_e2e)",
      );
    }
    app = await createTestApp();
    db = app.get(DataSource);
    funnel = app.get(FunnelEventsService);
    admin = await loginAsAdmin(app);

    const tables: { table_name: string }[] = await db.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('funnel_events', 'telemetry_optin')`,
    );
    expect(tables.map((row) => row.table_name).sort()).toEqual([
      "funnel_events",
      "telemetry_optin",
    ]);

    // 复位：清掉上次异常中断残留的本前缀行，并把系统总闸关回默认态。
    await cleanup();
    await postConsent({ optIn: false, installId, source: "api" });
  });

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await app?.close();
    }
  });

  it("A · 未授权时 status 显示总闸关闭，funnel.record 真被拦且零落库", async () => {
    const status = await getStatus();
    expect(status.systemEnabled).toBe(false);
    expect(status.count).toBe(0);
    expect(
      (status.installs ?? []).find(
        (row: any) => row.installId === installId && row.optIn === true,
      ),
    ).toBeUndefined();

    const blocked = await funnel.record({
      installId,
      eventName: "install_completed",
      dedupeKey: keyGated,
    });
    expect(blocked).toEqual({ recorded: false, reason: "not_opted_in" });
    expect(await eventRows()).toHaveLength(0);
  });

  it("B · consent 开闸授权 → 事件真落库 → status 可查 → 同 dedupeKey 幂等", async () => {
    const consent = await postConsent({
      optIn: true,
      installId,
      source: "api",
    });
    expect(consent).toMatchObject({
      systemEnabled: true,
      optedIn: true,
      source: "api",
    });
    expect(consent.installIds).toContain(installId);
    expect(consent.count).toBeGreaterThanOrEqual(1);

    const install = await funnel.record({
      installId,
      eventName: "install_completed",
      dedupeKey: keyInstall,
      ts: new Date(),
    });
    const success = await funnel.record({
      installId,
      eventName: "task_first_success",
      taskIdHash: "ttfv-e2e-task-hash",
      executionIdHash: "ttfv-e2e-execution-hash",
      dedupeKey: keySuccess,
    });
    expect(install).toEqual({ recorded: true });
    expect(success).toEqual({ recorded: true });

    // 指标面：status 从真实 telemetry_optin 行读出授权状态。
    const status = await getStatus();
    expect(status.systemEnabled).toBe(true);
    expect(status.count).toBeGreaterThanOrEqual(1);
    const view = status.installs.find(
      (row: any) => row.installId === installId,
    );
    expect(view).toMatchObject({
      installId,
      optIn: true,
      source: "api",
    });
    expect(view.userIdHash).toBeTruthy();

    // 副作用面：funnel_events 里真有两行，列值与 dedupeKey 对齐。
    const rows = await eventRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.event_name)).toEqual([
      "install_completed",
      "task_first_success",
    ]);
    expect(rows.map((row) => row.dedupe_key)).toEqual([
      keyInstall,
      keySuccess,
    ]);
    expect(rows.every((row) => row.install_id === installId)).toBe(true);
    const successRow = rows.find(
      (row) => row.event_name === "task_first_success",
    );
    expect(successRow.task_id_hash).toBe("ttfv-e2e-task-hash");
    expect(successRow.execution_id_hash).toBe("ttfv-e2e-execution-hash");

    const duplicate = await funnel.record({
      installId,
      eventName: "install_completed",
      dedupeKey: keyInstall,
    });
    expect(duplicate).toEqual({ recorded: false, reason: "duplicate" });
    expect(await eventRows()).toHaveLength(2);
  });

  it("C · opt-out 关总闸后，新事件真被拦且既有事实行不变", async () => {
    const revoked = await postConsent({
      optIn: false,
      installId,
      source: "api",
    });
    expect(revoked).toMatchObject({ systemEnabled: false, optedIn: false });

    const before = await eventRows();
    expect(before).toHaveLength(2);

    const blocked = await funnel.record({
      installId,
      eventName: "task_first_success",
      dedupeKey: keyOptOut,
    });
    expect(blocked).toEqual({ recorded: false, reason: "not_opted_in" });
    expect(await eventRows()).toHaveLength(2);

    const status = await getStatus();
    expect(status.systemEnabled).toBe(false);
    expect(
      status.installs.find((row: any) => row.installId === installId),
    ).toMatchObject({ optIn: false, source: "revoke" });
  });
});
