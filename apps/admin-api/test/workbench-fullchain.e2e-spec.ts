import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";
import { createTestApp, loginAsAdmin } from "./helpers/app.helper";

/**
 * AGENTS §4.4 第 3 级：真 PG + 真 Nest + 真 HTTP（supertest）。
 *
 * 全链断言的是**落库副作用**，不是接口 200：
 *   preview（确定性、无落库）→ commit（sops draft 行 + capability_activation_log
 *   success 行）→ quota 硬阈值（system_configs key）→ 再 commit（第四闸 fail-close：
 *   HTTP 429/RATE_LIMITED，sops 表不增、无第二次 success 激活行）→ 同 gate 的直接
 *   激活 HTTP 面 429/RATE_LIMITED + blocked 审计行。
 *
 * 硬阈闸已上移到 draft 落库之前，controller 不再吞 gate 的 RATE_LIMITED；
 * activation.record 保持 fail-open，且只在真正放行后调用。⑤ 固化严格契约。
 *
 * 不 mock DataSource / SopService / activation / quota；本链无 LLM（preview 是纯函数）。
 * 随机前缀隔离数据；quota key 固定，afterAll 精确还原。
 */
describe("Workbench full chain (real PG e2e)", () => {
  let app: INestApplication;
  let db: DataSource;
  let admin: string;

  const runId = randomUUID().slice(0, 12);
  const prefix = `wb-fullchain-${runId}`;
  const goal1 = `${prefix} 汇总昨日订单异常并推送日报`;
  const goal2 = `${prefix} 汇总本周订单异常并推送周报`;
  const cadence = "daily" as const;
  const quotaKey = "acf.showback.quota.capability.workbench.commit";
  const quotaCfg = {
    scope: "capability",
    target: "workbench.commit",
    softLimit: 1,
    hardLimit: 1,
    windowDays: 30,
  };

  type QuotaRow = {
    key: string;
    value: string | null;
    description: string | null;
    valueType: string;
    isSecret: boolean;
  };
  let quotaBefore: QuotaRow | null = null;
  const createdLogIds: string[] = [];

  beforeAll(async () => {
    const dbName = process.env.DB_DATABASE ?? "";
    if (!/(^|_)(test|e2e)(_|$)/i.test(dbName)) {
      throw new Error(
        `workbench fullchain e2e 需要显式 test/e2e 库（收到 DB_DATABASE=${dbName || "<empty>"}）`,
      );
    }
    app = await createTestApp();
    db = app.get(DataSource);
    admin = await loginAsAdmin(app);
    const rows: QuotaRow[] = await db.query(
      'SELECT key, value, description, "valueType", "isSecret" FROM system_configs WHERE key = $1',
      [quotaKey],
    );
    quotaBefore = rows[0] ?? null;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    try {
      if (db) {
        // 按随机前缀（goal 进入 title）定位本次造的全部 SOP；被拦的那次若有
        // 残留 draft 也一并清掉，避免断言中途失败留下脏行。
        const ours: { id: string }[] = await db.query(
          "SELECT id FROM sops WHERE title LIKE $1",
          [`方案卡：${prefix}%`],
        );
        const sopIds = ours.map((row) => row.id);
        if (sopIds.length > 0) {
          await db.query(
            'DELETE FROM capability_activation_log WHERE "sessionId" = ANY($1::text[])',
            [sopIds],
          );
          await db.query("DELETE FROM sops WHERE id = ANY($1::uuid[])", [
            sopIds,
          ]);
        }
        if (createdLogIds.length > 0) {
          await db.query(
            "DELETE FROM capability_activation_log WHERE id = ANY($1::uuid[])",
            [createdLogIds],
          );
        }
        if (quotaBefore) {
          await db.query(
            'UPDATE system_configs SET value = $1, description = $2, "valueType" = $3, "isSecret" = $4 WHERE key = $5',
            [
              quotaBefore.value,
              quotaBefore.description,
              quotaBefore.valueType,
              quotaBefore.isSecret,
              quotaKey,
            ],
          );
        } else {
          await db.query("DELETE FROM system_configs WHERE key = $1", [
            quotaKey,
          ]);
        }
      }
    } finally {
      await app?.close();
    }
  });

  const auth = () => `Bearer ${admin}`;

  it("preview → commit → 硬阈值拦截，每一步都有真实落库证据", async () => {
    // ① preview：确定性闸门，16 hex 锚点，不落 SOP。
    const preview1: any = (
      await request(app.getHttpServer())
        .post("/workbench/preview")
        .set("Authorization", auth())
        .send({ goal: goal1, cadence })
        .expect(201)
    ).body;
    const p1 = preview1.data ?? preview1;
    expect(p1.eligible).toBe(true);
    expect(p1.cardHash).toMatch(/^[0-9a-f]{16}$/);
    expect(p1.policyGeneration).toMatch(/^[0-9a-f]{16}$/);

    // ② commit：回填两个锚点，落 draft SOP + success 激活审计。
    const commitRes: any = await request(app.getHttpServer())
      .post("/workbench/commit")
      .set("Authorization", auth())
      .send({
        goal: goal1,
        cadence,
        expectedCardHash: p1.cardHash,
        expectedPolicyGeneration: p1.policyGeneration,
      })
      .expect(201);
    const commit1 = commitRes.body.data ?? commitRes.body;
    expect(commit1.status).toBe("draft");
    expect(commit1.sopId).toBeTruthy();
    expect(commit1.slug).toMatch(/^workbench-[0-9a-f]{8}$/);

    const sops1: { id: string; slug: string; status: string }[] =
      await db.query("SELECT id, slug, status FROM sops WHERE id = $1", [
        commit1.sopId,
      ]);
    expect(sops1).toHaveLength(1);
    expect(sops1[0]).toMatchObject({ slug: commit1.slug, status: "draft" });

    const logs1: {
      id: string;
      sessionId: string;
      result: string;
      capabilityKey: string;
    }[] = await db.query(
      'SELECT id, "sessionId", result, "capabilityKey" FROM capability_activation_log WHERE "sessionId" = $1',
      [commit1.sopId],
    );
    expect(logs1).toHaveLength(1);
    expect(logs1[0]).toMatchObject({
      sessionId: commit1.sopId,
      result: "success",
      capabilityKey: "workbench.commit",
    });
    createdLogIds.push(logs1[0].id);

    // ③ quota 硬阈值：system_configs key = acf.showback.quota.capability.workbench.commit。
    const quotaRes: any = await request(app.getHttpServer())
      .put("/capability-activation/quota")
      .set("Authorization", auth())
      .send(quotaCfg)
      .expect(200);
    const quotaOut = quotaRes.body.data ?? quotaRes.body;
    expect(quotaOut).toMatchObject(quotaCfg);

    const quotaRows: { value: string }[] = await db.query(
      "SELECT value FROM system_configs WHERE key = $1",
      [quotaKey],
    );
    expect(quotaRows).toHaveLength(1);
    expect(JSON.parse(quotaRows[0].value)).toMatchObject(quotaCfg);

    // ④ 新 preview 拿新 hash，再 commit：usage=1 ≥ hardLimit=1 ⇒ gate 命中。
    const preview2: any = (
      await request(app.getHttpServer())
        .post("/workbench/preview")
        .set("Authorization", auth())
        .send({ goal: goal2, cadence })
        .expect(201)
    ).body;
    const p2 = preview2.data ?? preview2;
    expect(p2.eligible).toBe(true);
    expect(p2.cardHash).toMatch(/^[0-9a-f]{16}$/);
    expect(p2.cardHash).not.toBe(p1.cardHash);

    const since = new Date();
    const blockedBefore: { id: string }[] = await db.query(
      'SELECT id FROM capability_activation_log WHERE "capabilityKey" = $1 AND result = $2 AND "createdAt" >= $3',
      ["workbench.commit", "blocked", since.toISOString()],
    );

    // 第四闸在 draft 之前 fail-close：usage=1 ≥ hardLimit=1 ⇒ 429，且无落库副作用。
    const commitRes2: any = await request(app.getHttpServer())
      .post("/workbench/commit")
      .set("Authorization", auth())
      .send({
        goal: goal2,
        cadence,
        expectedCardHash: p2.cardHash,
        expectedPolicyGeneration: p2.policyGeneration,
      })
      .expect(429);
    const errorCode2 =
      commitRes2.body.errorCode ?? commitRes2.body.data?.errorCode;

    const blockedAfter: { id: string; sessionId: string; result: string }[] =
      await db.query(
        'SELECT id, "sessionId", result FROM capability_activation_log WHERE "capabilityKey" = $1 AND result = $2 AND "createdAt" >= $3 ORDER BY "createdAt" ASC',
        ["workbench.commit", "blocked", since.toISOString()],
      );
    for (const row of blockedAfter) createdLogIds.push(row.id);

    const sopsAfter: { id: string; slug: string; status: string }[] =
      await db.query("SELECT id, slug, status FROM sops WHERE title LIKE $1", [
        `方案卡：${prefix}%`,
      ]);

    // 第二次 commit 之后：gate 直接 429，不写 blocked 审计（controller 未走到
    // activation.record）；since 之后也不应有任何 success 激活行。
    const successAfter: { id: string; sessionId: string }[] = await db.query(
      'SELECT id, "sessionId" FROM capability_activation_log WHERE "capabilityKey" = $1 AND result = $2 AND "createdAt" >= $3',
      ["workbench.commit", "success", since.toISOString()],
    );
    for (const row of successAfter) createdLogIds.push(row.id);

    // ⑤ 严格契约：第二次 commit 429/RATE_LIMITED，sops 不增（仍 1 行），
    // 无新增 blocked/success 激活行。gate 内部 fail-open 只影响配额读取故障，
    // 这里配额已落库且命中，必须 fail-close。
    expect({
      httpStatus: commitRes2.status,
      errorCode: errorCode2,
      blockedDelta: blockedAfter.length - blockedBefore.length,
      successAfterCount: successAfter.length,
      sopCount: sopsAfter.length,
      sopIds: sopsAfter.map((row) => row.id),
    }).toEqual({
      httpStatus: 429,
      errorCode: "RATE_LIMITED",
      blockedDelta: 0,
      successAfterCount: 0,
      sopCount: 1,
      sopIds: [commit1.sopId],
    });

    // ⑥ 同一个 gate 的 HTTP 拒绝面：POST /capability-activation 直接触发
    // activation.service.record ⇒ evaluateHardLimit 命中 ⇒ 429/RATE_LIMITED，
    // 并再落一条 blocked 审计行（sessionId 用本次唯一标记，便于精确清理）。
    const marker = `${prefix}-gate-blocked`;
    const direct: any = await request(app.getHttpServer())
      .post("/capability-activation")
      .set("Authorization", auth())
      .send({
        capabilityKey: "workbench.commit",
        capabilityVersion: "1.0.0",
        sessionId: marker,
        parameters: { marker },
      });
    expect(direct.status).toBe(429);
    expect(direct.body.errorCode ?? direct.body.data?.errorCode).toBe(
      "RATE_LIMITED",
    );

    const gateLogs: { id: string; result: string }[] = await db.query(
      'SELECT id, result FROM capability_activation_log WHERE "sessionId" = $1',
      [marker],
    );
    expect(gateLogs).toHaveLength(1);
    expect(gateLogs[0].result).toBe("blocked");
    createdLogIds.push(gateLogs[0].id);

    // 验收证据：把每步的真实副作用值打到日志，便于 CI 逐项复核。
    console.info(
      "[workbench-fullchain evidence] " +
        JSON.stringify({
          runId,
          preview1: {
            eligible: p1.eligible,
            cardHash: p1.cardHash,
            policyGeneration: p1.policyGeneration,
          },
          commit1: {
            sopId: commit1.sopId,
            slug: commit1.slug,
            status: commit1.status,
            activation: logs1[0].result,
          },
          quotaKey,
          preview2: { eligible: p2.eligible, cardHash: p2.cardHash },
          commit2: {
            httpStatus: commitRes2.status,
            errorCode: errorCode2,
            blockedDelta: blockedAfter.length - blockedBefore.length,
            successAfterCount: successAfter.length,
          },
          gateRejection: {
            status: direct.status,
            errorCode: direct.body.errorCode ?? direct.body.data?.errorCode,
            blockedAuditId: gateLogs[0].id,
            blockedSessionId: marker,
          },
          sopsAfterCount: sopsAfter.length,
        }),
    );
  });
});
