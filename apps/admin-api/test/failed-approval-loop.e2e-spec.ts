import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";

import { createTestApp, loginAsAdmin } from "./helpers/app.helper";
import { WorkbenchController } from "../src/modules/workbench/workbench.controller";
import { ReleaseApprovalService } from "../src/modules/workbench/release-approval.service";

/**
 * ADR-045 · 审批发起失败跨角色闭环 —— 真 PG 进程内 e2e（AGENTS §4.4 第 3 级）。
 *
 * 判据是**真库副作用**，不是「接口 2xx」：
 *   ① 失败审计真落库：进程内把 ReleaseApprovalService 的策略端口临时改成
 *      `currentFingerprint() => null`（requestRelease fail-closed 抛错）⇒
 *      commit 返回 201 业务成功信封 + approvalStatus='failed'，真库 audit_logs
 *      有一行 `sop_publish.approval_request_failed`，detail 含
 *      sopId/cardHash/contentHash/requestedBy/reason 且无密钥/token/异常原文。
 *   ② 重试真落审批单：用失败审计 detail 字段调
 *      `POST /workbench/release-approvals/request`（ADMIN）⇒ 服务端重算
 *      contentHash 比对通过 → requestRelease 落新 pending 审批单 + retried 审计。
 *   ③ 篡改 fail-closed：body contentHash 与 draft 不符 ⇒ 400 + 零审批单 + 无 retried。
 *   ④ 权限 fail-closed：USER token 调重试端点 ⇒ 403 + 零副作用。
 *
 * 随机前缀隔离；afterAll 精确清理（audit_logs 走 append-only bypass GUC）+ 复查 0 残留。
 * 只在本文件内临时改进程内对象并在 afterEach 还原，不改任何生产源码。
 */
describe("Failed approval loop (real PG e2e)", () => {
  let app: INestApplication;
  let db: DataSource;
  let admin: string;
  let controller: WorkbenchController;
  let release: ReleaseApprovalService;

  const runId = randomUUID().slice(0, 12);
  const prefix = `wb-failed-loop-${runId}`;
  const cadence = "daily" as const;
  const auditActionFailed = "sop_publish.approval_request_failed";
  const auditActionRetried = "sop_publish.approval_request_retried";
  const retryPath = "/workbench/release-approvals/request";

  type CommitBody = {
    sopId?: string;
    slug?: string;
    status?: string;
    approvalStatus?: string;
    approvalKey?: string;
    [key: string]: unknown;
  };

  type FailedAuditDetail = {
    sopId: string;
    cardHash: string;
    contentHash: string;
    requestedBy: string;
    reason: string;
    [key: string]: unknown;
  };

  /** 每个用例自建一条失败 commit + 失败审计，按 label 隔离，互不依赖顺序。 */
  type FailureFixture = { body: CommitBody; detail: FailedAuditDetail };
  const fixtures: FailureFixture[] = [];
  const sopIds: string[] = [];
  const approvalKeys: string[] = [];
  const sessionIds: string[] = [];
  const cardHashes: string[] = [];

  /** 进程内临时替换的策略端口原始引用，afterEach 无条件还原。 */
  let originalPolicy: unknown;

  // USER 角色账号（权限 fail-closed 用），精确清理。
  let userToken: string;
  let userId: number | null = null;
  const userUsername = `e2e-floop-user-${runId}`;

  const unwrap = (body: any): any => body?.data ?? body;
  const auth = () => `Bearer ${admin}`;

  const preview = async (goal: string): Promise<{ cardHash: string; policyGeneration: string }> => {
    const res: any = await request(app.getHttpServer())
      .post("/workbench/preview")
      .set("Authorization", auth())
      .send({ goal, cadence })
      .expect(201);
    const p = unwrap(res.body);
    expect(p.eligible).toBe(true);
    expect(String(p.cardHash)).toMatch(/^[0-9a-f]{16}$/);
    expect(String(p.policyGeneration)).toMatch(/^[0-9a-f]{16}$/);
    return { cardHash: String(p.cardHash), policyGeneration: String(p.policyGeneration) };
  };

  /** 构造「审批发起失败」：临时让策略指纹不可读 ⇒ requestRelease fail-closed 抛错。 */
  const createFailure = async (label: string): Promise<FailureFixture> => {
    originalPolicy = (release as any).policy;
    (release as any).policy = { currentFingerprint: () => null };
    try {
      const goal = `${prefix} ${label}：汇总昨日订单异常`;
      const anchor = await preview(goal);
      cardHashes.push(anchor.cardHash);
      const res: any = await request(app.getHttpServer())
        .post("/workbench/commit")
        .set("Authorization", auth())
        .send({
          goal,
          cadence,
          expectedCardHash: anchor.cardHash,
          expectedPolicyGeneration: anchor.policyGeneration,
        })
        .expect(201); // 业务成功信封：审批发起失败也不是 5xx
      const body: CommitBody = unwrap(res.body);
      expect(body.status).toBe("draft");
      expect(typeof body.sopId).toBe("string");
      expect(body.sopId).toBeTruthy();
      expect(body.approvalStatus).toBe("failed");
      expect(body.approvalKey).toBeUndefined();
      sopIds.push(String(body.sopId));

      const detail = await waitFailedAudit(String(body.sopId));
      const fixture: FailureFixture = { body, detail };
      fixtures.push(fixture);
      return fixture;
    } finally {
      // 必须在返回前还原：retry 端点内部也调 requestRelease，若策略端口仍返回
      // null，②的重试会跟着 fail-closed（假红），所以 createFailure 自还原，
      // afterEach 只作兜底（覆盖中途抛错路径）。
      if (originalPolicy !== undefined) (release as any).policy = originalPolicy;
      originalPolicy = undefined;
    }
  };

  const failedAuditRows = async (sopId: string) =>
    db.query(
      `SELECT action, result, "resourceId", detail FROM audit_logs
       WHERE action = $1 AND (detail ->> 'sopId') = $2`,
      [auditActionFailed, sopId],
    );

  const retriedAuditRows = async (sopId: string) =>
    db.query(
      `SELECT action, result, "resourceId", detail FROM audit_logs
       WHERE action = $1 AND (detail ->> 'sopId') = $2`,
      [auditActionRetried, sopId],
    );

  const waitFailedAudit = async (sopId: string): Promise<FailedAuditDetail> => {
    // 失败审计经 ModuleRef fire-and-forget 落库：轮询等，最多 3s。
    for (let i = 0; i < 30; i += 1) {
      const rows = await failedAuditRows(sopId);
      if (rows.length > 0) return rows[0].detail as FailedAuditDetail;
      await new Promise((r) => setTimeout(r, 100));
    }
    const rows = await failedAuditRows(sopId);
    expect(rows.length).toBeGreaterThan(0); // 失败审计没落库 = 直接判失败
    return rows[0].detail as FailedAuditDetail;
  };

  /** 重试后按 sopId 查真库 pending 审批单（requestRelease reason 含 sopId）。 */
  const approvalsFor = async (sopId: string) =>
    db.query(
      `SELECT "approvalKey", "sessionId", "toolName", status, scope, "policyFingerprint", reason
         FROM agent_approvals WHERE reason LIKE '%' || $1 || '%'`,
      [sopId],
    );

  const retry = (body: Record<string, unknown>, token: string = admin) =>
    request(app.getHttpServer())
      .post(retryPath)
      .set("Authorization", `Bearer ${token}`)
      .send(body);

  beforeAll(async () => {
    const dbName = process.env.DB_DATABASE ?? "";
    if (!/(^|_)(test|e2e)(_|$)/i.test(dbName)) {
      throw new Error(
        `failed approval loop e2e 需要显式 test/e2e 库（收到 DB_DATABASE=${dbName || "<empty>"}）`,
      );
    }
    app = await createTestApp();
    db = app.get(DataSource);
    admin = await loginAsAdmin(app);
    controller = app.get(WorkbenchController);
    release = app.get(ReleaseApprovalService);
    expect(controller).toBeTruthy();
    expect(release).toBeTruthy();
    // 确认被测对象就是 controller 持有的单例，否则临时替换不会命中（假绿）。
    expect((release as any).policy).toBeTruthy();
    expect(typeof (release as any).policy.currentFingerprint).toBe("function");
    expect((controller as any).releaseApproval).toBe(release);

    // 真注册面建 role=user 账号并登录，验证 ADMIN-only 闸的 403。
    const created = await request(app.getHttpServer())
      .post("/users")
      .set("Authorization", auth())
      .send({
        username: userUsername,
        password: `Aa1!${runId}x`,
        email: `${userUsername}@example.invalid`,
        role: "user",
      })
      .expect(201);
    userId = unwrap(created.body).id ?? null;
    expect(userId).toBeTruthy();
    const loggedIn = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username: userUsername, password: `Aa1!${runId}x` })
      .expect(201);
    userToken = unwrap(loggedIn.body).accessToken;
    expect(userToken).toBeTruthy();
  });

  afterEach(() => {
    // 无论用例成败都还原，避免污染后续用例或同进程其它 suite。
    if (originalPolicy !== undefined) (release as any).policy = originalPolicy;
    originalPolicy = undefined;
  });

  afterAll(async () => {
    const step = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        console.warn(`WARN failed-approval-loop cleanup failed (${label}): ${String(err)}`);
      }
    };
    try {
      if (!db) return;
      // 汇总兜底扫一遍随机前缀建造的 SOP / 审批单 / 会话。
      const extraSops: { id: string }[] = await db.query(
        "SELECT id FROM sops WHERE title LIKE $1",
        [`方案卡：${prefix}%`],
      );
      for (const row of extraSops) if (!sopIds.includes(row.id)) sopIds.push(row.id);
      for (const f of fixtures) {
        const key = f.body.approvalKey;
        if (key && !approvalKeys.includes(String(key))) approvalKeys.push(String(key));
      }

      for (const key of approvalKeys) {
        await step(`approval:key:${key}`, () =>
          db.query('DELETE FROM agent_approvals WHERE "approvalKey" = $1', [key]),
        );
      }
      for (const cardHash of cardHashes) {
        const stray: { sessionId: string }[] = await db.query(
          'SELECT "sessionId" FROM agent_approvals WHERE reason LIKE $1',
          [`%${cardHash}%`],
        );
        for (const row of stray) if (!sessionIds.includes(row.sessionId)) sessionIds.push(row.sessionId);
        const sess: { id: string }[] = await db.query(
          'SELECT id FROM agent_sessions WHERE title LIKE $1',
          [`方案卡发布复核 ${cardHash}%`],
        );
        for (const row of sess) if (!sessionIds.includes(row.id)) sessionIds.push(row.id);
      }
      for (const sid of sessionIds) {
        await step(`approval:session:${sid}`, () =>
          db.query('DELETE FROM agent_approvals WHERE "sessionId" = $1', [sid]),
        );
        await step(`events:${sid}`, () =>
          db.query('DELETE FROM agent_events WHERE "sessionId" = $1', [sid]),
        );
      }
      if (sopIds.length > 0) {
        await step("activation-log", () =>
          db.query(
            'DELETE FROM capability_activation_log WHERE "sessionId" = ANY($1::text[])',
            [sopIds],
          ),
        );
      }
      for (const sid of sessionIds) {
        await step(`session:${sid}`, () =>
          db.query("DELETE FROM agent_sessions WHERE id = $1", [sid]),
        );
      }
      if (sopIds.length > 0) {
        await step("sops", () =>
          db.query("DELETE FROM sops WHERE id = ANY($1::uuid[])", [sopIds]),
        );
      }
      // audit_logs 是 append-only（触发器拒绝普通 DELETE）：同 retentionDelete 的
      // 唯一放行点——单事务 SET LOCAL bypass GUC，按 detail.sopId 精确删除。
      if (sopIds.length > 0) {
        await step("audit-logs", () =>
          db.transaction(async (em) => {
            await em.query("SET LOCAL app.bypass_audit_guard = 'on'");
            await em.query(
              `DELETE FROM audit_logs WHERE (detail ->> 'sopId') = ANY($1::text[])`,
              [sopIds],
            );
          }),
        );
      }
      if (userId !== null) {
        await step("user:refresh", () =>
          db.query('DELETE FROM refresh_tokens WHERE "userId" = $1', [userId]),
        );
        await step("user:row", () =>
          db.query("DELETE FROM users WHERE id = $1", [userId]),
        );
      }

      // 清理复查：0 残留才算干净（不是「删了就算」）。
      const checks: Array<[string, string, unknown[]]> = [
        ["sops", "SELECT count(*)::int AS n FROM sops WHERE title LIKE $1", [`方案卡：${prefix}%`]],
        ["agent_approvals", "SELECT count(*)::int AS n FROM agent_approvals WHERE reason LIKE $1", [`%${prefix}%`]],
        ["agent_sessions", "SELECT count(*)::int AS n FROM agent_sessions WHERE title LIKE $1", [`%${prefix}%`]],
      ];
      for (const [label, sql, params] of checks) {
        await step(`verify-zero:${label}`, async () => {
          const rows: { n: number }[] = await db.query(sql, params);
          if (rows[0]?.n !== 0) throw new Error(`${label} 残留 ${rows[0]?.n} 行`);
        });
      }
      await step("verify-zero:audit-logs", async () => {
        const rows: { n: number }[] = await db.query(
          `SELECT count(*)::int AS n FROM audit_logs
           WHERE (detail ->> 'sopId') = ANY($1::text[])`,
          [sopIds],
        );
        if (rows[0]?.n !== 0) throw new Error(`audit_logs 残留 ${rows[0]?.n} 行`);
      });
    } finally {
      await app?.close();
    }
  });

  it("① 失败审计真落库：201 信封 + failed + audit_logs 一行 detail 无密钥", async () => {
    const { body, detail } = await createFailure("audit-failed");

    const rows = await failedAuditRows(String(body.sopId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: auditActionFailed, result: "failure" });
    expect(rows[0].resourceId).toBe(body.sopId);

    expect(detail.sopId).toBe(body.sopId);
    expect(detail.cardHash).toMatch(/^[0-9a-f]{16}$/);
    expect(detail.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.requestedBy).toBeTruthy();
    // reason 安全枚举，绝不带异常原文（"策略指纹不可读" ⇒ policy_fingerprint_unavailable）。
    expect([
      "policy_fingerprint_unavailable",
      "dependency_unavailable",
      "approval_request_failed",
    ]).toContain(detail.reason);
    expect(detail.attempt).toBe("initial");

    const serialised = JSON.stringify(detail);
    for (const secret of ["apiKey", "token", "secret", "password", "approvalKey"]) {
      expect(serialised.toLowerCase()).not.toContain(secret.toLowerCase());
    }

    console.info(
      "[failed-approval-loop evidence] " +
        JSON.stringify({
          case: "failed-audit",
          sopId: body.sopId,
          status: body.approvalStatus,
          auditRows: rows.length,
          detailKeys: Object.keys(detail).sort(),
          reason: detail.reason,
        }),
    );
  });

  it("② 重试真落审批单：ADMIN 调端点 → 2xx + pending 单 + retried 审计", async () => {
    const { detail } = await createFailure("retry-ok");
    const before = await approvalsFor(detail.sopId);
    expect(before).toHaveLength(0);

    const res = await retry({
      sopId: detail.sopId,
      cardHash: detail.cardHash,
      contentHash: detail.contentHash,
    });
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    const payload = unwrap(res.body);
    expect(payload.retried).toBe(true);
    expect(payload.approvalKey).toMatch(/^apr-/);
    expect(payload.sessionId).toBeTruthy();
    approvalKeys.push(String(payload.approvalKey));
    sessionIds.push(String(payload.sessionId));

    const approvals = await approvalsFor(detail.sopId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      approvalKey: payload.approvalKey,
      sessionId: payload.sessionId,
      toolName: "sop_publish",
      scope: "once",
      status: "pending",
    });
    expect(approvals[0].policyFingerprint).toMatch(/^[0-9a-f]{64}$/);

    // retried 审计 fire-and-forget：轮询等。
    let retried: any[] = [];
    for (let i = 0; i < 30; i += 1) {
      retried = await retriedAuditRows(detail.sopId);
      if (retried.length > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({ action: auditActionRetried, result: "success" });
    expect(retried[0].resourceId).toBe(detail.sopId);
    const rd = retried[0].detail;
    expect(rd.sopId).toBe(detail.sopId);
    expect(rd.cardHash).toBe(detail.cardHash);
    expect(rd.contentHash).toBe(detail.contentHash);
    expect(rd.requestedBy).toBeTruthy();
    expect(rd.approvalKey).toBe(payload.approvalKey);
    expect(rd.sessionId).toBe(payload.sessionId);
    expect(rd.attempt).toBe("request_retry");

    console.info(
      "[failed-approval-loop evidence] " +
        JSON.stringify({
          case: "retry-ok",
          sopId: detail.sopId,
          http: res.status,
          approvalRows: approvals.length,
          approvalStatus: approvals[0].status,
          approvalScope: approvals[0].scope,
          approvalTool: approvals[0].toolName,
          policyFingerprintLen: String(approvals[0].policyFingerprint).length,
          retriedAuditRows: retried.length,
        }),
    );
  });

  it("③ 篡改 contentHash fail-closed：400 + 零审批单 + 无 retried 审计", async () => {
    const { detail } = await createFailure("tamper");
    const tampered = `0`.repeat(64) === detail.contentHash ? `1`.repeat(64) : `0`.repeat(64);

    const res = await retry({
      sopId: detail.sopId,
      cardHash: detail.cardHash,
      contentHash: tampered,
    });
    expect(res.status).toBe(400);

    const approvals = await approvalsFor(detail.sopId);
    expect(approvals).toHaveLength(0);
    expect(await retriedAuditRows(detail.sopId)).toHaveLength(0);

    console.info(
      "[failed-approval-loop evidence] " +
        JSON.stringify({
          case: "tamper",
          sopId: detail.sopId,
          http: res.status,
          approvalRows: approvals.length,
          retriedAuditRows: 0,
        }),
    );
  });

  it("④ 权限 fail-closed：USER token → 403 + 零审批单 + 无 retried 审计", async () => {
    const { detail } = await createFailure("forbidden");

    const res = await retry(
      {
        sopId: detail.sopId,
        cardHash: detail.cardHash,
        contentHash: detail.contentHash,
      },
      userToken,
    );
    expect(res.status).toBe(403);

    const approvals = await approvalsFor(detail.sopId);
    expect(approvals).toHaveLength(0);
    expect(await retriedAuditRows(detail.sopId)).toHaveLength(0);

    console.info(
      "[failed-approval-loop evidence] " +
        JSON.stringify({
          case: "forbidden",
          sopId: detail.sopId,
          http: res.status,
          approvalRows: approvals.length,
          retriedAuditRows: 0,
        }),
    );
  });
});
