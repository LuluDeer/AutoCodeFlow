import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";

import { createTestApp, loginAsAdmin } from "./helpers/app.helper";
import { WorkbenchController } from "../src/modules/workbench/workbench.controller";
import { ReleaseApprovalService } from "../src/modules/workbench/release-approval.service";

/**
 * ADR-045 · 审批发起三态诚实化 —— 真 PG 进程内 e2e（AGENTS §4.4 第 3 级）。
 *
 * 判据是**落库副作用**，不是「接口 200」：
 *   ① submitted：合法 preview → commit ⇒ 返回 stable code `submitted` + approvalKey；
 *      真库 agent_approvals 有该 sop_publish / scope=once / pending 单，sops 有 draft 行。
 *   ② failed：进程内把 ReleaseApprovalService 的 RELEASE_POLICY_PORT 临时改成
 *      `currentFingerprint() => null`（requestRelease 第 260-265 行 fail-closed 抛错）⇒
 *      返回 `failed`，HTTP 仍是 201 业务成功信封；sops draft 仍落库，agent_approvals 零该单。
 *   ③ not_requested：进程内把 controller 的 releaseApproval 端口临时置空（端口缺席变体）⇒
 *      返回 `not_requested`，draft 仍落库，agent_approvals 零该单。
 *   ④ 契约稳定性：三态只用 ASCII 稳定码；旧硬编码中文 `next` 不再出现在响应里。
 *
 * 随机 uuid 隔离；afterAll 精确清理 + 清理后复查 0 残留。
 * 只在本文件内临时改进程内对象并在 afterEach 逐一还原，不改任何生产源码。
 */
describe("Commit approval status honesty (real PG e2e)", () => {
  let app: INestApplication;
  let db: DataSource;
  let admin: string;
  let controller: WorkbenchController;
  let release: ReleaseApprovalService;

  const runId = randomUUID().slice(0, 12);
  const prefix = `wb-approval-honest-${runId}`;
  const cadence = "daily" as const;

  const goals = {
    submitted: `${prefix} 已提交审批用例：汇总昨日订单异常`,
    failed: `${prefix} 审批失败用例：汇总本周订单异常`,
    notRequested: `${prefix} 未发起审批用例：汇总本月订单异常`,
  } as const;

  type CommitBody = {
    sopId?: string;
    slug?: string;
    status?: string;
    approvalStatus?: string;
    approvalKey?: string;
    next?: string;
    policyGeneration?: string;
    [key: string]: unknown;
  };

  // 三态响应逐一留档给契约用例；也便于失败时在 afterAll 精确清理。
  const observed: Array<{ state: string; body: CommitBody }> = [];
  const sopIds: string[] = [];
  const approvalKeys: string[] = [];
  const sessionIds: string[] = [];
  const cardHashes: string[] = [];

  // 进程内临时改动的原始引用，afterEach 无条件还原。
  let originalPolicy: unknown;
  let originalReleaseApproval: unknown;

  const unwrap = (body: any): CommitBody => body?.data ?? body;
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

  const commit = async (goal: string): Promise<CommitBody> => {
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
    const body = unwrap(res.body);
    expect(body.status).toBe("draft");
    expect(typeof body.sopId).toBe("string");
    expect(body.sopId).toBeTruthy();
    sopIds.push(String(body.sopId));
    if (body.approvalKey) approvalKeys.push(String(body.approvalKey));
    return body;
  };

  const approvalsFor = async (sopId: string) =>
    db.query(
      `SELECT "approvalKey", "sessionId", "toolName", status, scope, "policyFingerprint", reason
         FROM agent_approvals WHERE reason LIKE '%' || $1 || '%'`,
      [sopId],
    );

  const draftFor = async (sopId: string) =>
    db.query('SELECT id, slug, status FROM sops WHERE id = $1', [sopId]);

  const sessionsFor = async (cardHash: string) =>
    db.query('SELECT id, title FROM agent_sessions WHERE title LIKE $1', [
      `方案卡发布复核 ${cardHash}%`,
    ]);

  beforeAll(async () => {
    const dbName = process.env.DB_DATABASE ?? "";
    if (!/(^|_)(test|e2e)(_|$)/i.test(dbName)) {
      throw new Error(
        `commit approval status e2e 需要显式 test/e2e 库（收到 DB_DATABASE=${dbName || "<empty>"}）`,
      );
    }
    app = await createTestApp();
    db = app.get(DataSource);
    admin = await loginAsAdmin(app);
    controller = app.get(WorkbenchController);
    release = app.get(ReleaseApprovalService);
    expect(controller).toBeTruthy();
    expect(release).toBeTruthy();

    // 确认被测对象就是 controller 持有的那个单例，否则临时替换不会命中（假绿）。
    expect((release as any).policy).toBeTruthy();
    expect(typeof (release as any).policy.currentFingerprint).toBe("function");
    expect((controller as any).releaseApproval).toBe(release);
  });

  afterEach(() => {
    // 无论用例成败都还原，避免污染后续用例或同进程其它 suite。
    if (originalPolicy !== undefined) (release as any).policy = originalPolicy;
    if (originalReleaseApproval !== undefined) {
      (controller as any).releaseApproval = originalReleaseApproval;
    }
    originalPolicy = undefined;
    originalReleaseApproval = undefined;
  });

  afterAll(async () => {
    const step = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        console.warn(`WARN commit-approval-status cleanup failed (${label}): ${String(err)}`);
      }
    };
    try {
      if (!db) return;
      // 兜底扫一遍随机前缀建造的 SOP / 审批单 / 会话，断言中途失败也不留脏行。
      const extraSops: { id: string }[] = await db.query(
        "SELECT id FROM sops WHERE title LIKE $1",
        [`方案卡：${prefix}%`],
      );
      for (const row of extraSops) if (!sopIds.includes(row.id)) sopIds.push(row.id);
      for (const key of approvalKeys) {
        await step(`approval:key:${key}`, () =>
          db.query('DELETE FROM agent_approvals WHERE "approvalKey" = $1', [key]),
        );
      }
      for (const cardHash of cardHashes) {
        const stray: { "sessionId": string }[] = await db.query(
          'SELECT "sessionId" FROM agent_approvals WHERE reason LIKE $1',
          [`%${cardHash}%`],
        );
        for (const row of stray) {
          if (!sessionIds.includes(row.sessionId)) sessionIds.push(row.sessionId);
        }
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

      // 清理复查：0 残留才算干净（不是「删了就算」）。
      const checks: Array<[string, string, unknown[]]> = [
        ["sops", "SELECT count(*)::int AS n FROM sops WHERE title LIKE $1", [`方案卡：${prefix}%`]],
        [
          "agent_approvals",
          "SELECT count(*)::int AS n FROM agent_approvals WHERE reason LIKE $1",
          [`%${prefix}%`],
        ],
        [
          "agent_sessions",
          "SELECT count(*)::int AS n FROM agent_sessions WHERE title LIKE $1",
          [`%${prefix}%`],
        ],
      ];
      for (const [label, sql, params] of checks) {
        await step(`verify-zero:${label}`, async () => {
          const rows: { n: number }[] = await db.query(sql, params);
          if (rows[0]?.n !== 0) throw new Error(`${label} 残留 ${rows[0]?.n} 行`);
        });
      }
    } finally {
      await app?.close();
    }
  });

  it("① happy path：submitted + approvalKey + 真库 once 审批单 + draft 行", async () => {
    const body = await commit(goals.submitted);
    observed.push({ state: "submitted", body });

    expect(body.approvalStatus).toBe("submitted");
    expect(typeof body.approvalKey).toBe("string");
    expect(body.approvalKey!).toMatch(/^apr-/);

    const draft = await draftFor(String(body.sopId));
    expect(draft).toHaveLength(1);
    expect(draft[0]).toMatchObject({ status: "draft", slug: body.slug });

    const approvals = await approvalsFor(String(body.sopId));
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      approvalKey: body.approvalKey,
      toolName: "sop_publish",
      scope: "once",
      status: "pending",
    });
    expect(approvals[0].policyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    sessionIds.push(String(approvals[0].sessionId));

    const sessions = await sessionsFor(cardHashes[0]);
    expect(sessions).toHaveLength(1);

    console.info(
      "[commit-approval-status evidence] " +
        JSON.stringify({
          state: "submitted",
          sopId: body.sopId,
          status: body.approvalStatus,
          approvalKey: body.approvalKey,
          draftRows: draft.length,
          approvalRows: approvals.length,
          approvalScope: approvals[0].scope,
          approvalTool: approvals[0].toolName,
          sessionRows: sessions.length,
        }),
    );
  });

  it("② 指纹不可读 ⇒ failed：draft 仍落 + 零审批单 + 201 业务信封", async () => {
    // 覆盖点：让 RELEASE_POLICY_PORT.currentFingerprint() 返回 null ⇒
    // requestRelease 第 260-265 行 fail-closed 抛错 ⇒ controller catch → failed。
    originalPolicy = (release as any).policy;
    (release as any).policy = { currentFingerprint: () => null };

    const body = await commit(goals.failed);
    observed.push({ state: "failed", body });

    expect(body.approvalStatus).toBe("failed");
    expect(body.approvalKey).toBeUndefined();

    const draft = await draftFor(String(body.sopId));
    expect(draft).toHaveLength(1);
    expect(draft[0]).toMatchObject({ status: "draft", slug: body.slug });

    const approvals = await approvalsFor(String(body.sopId));
    const sessions = await sessionsFor(cardHashes[1]);
    expect(approvals).toHaveLength(0);
    expect(sessions).toHaveLength(0);

    console.info(
      "[commit-approval-status evidence] " +
        JSON.stringify({
          state: "failed",
          sopId: body.sopId,
          status: body.approvalStatus,
          draftRows: draft.length,
          approvalRows: approvals.length,
          sessionRows: sessions.length,
          approvalKey: body.approvalKey ?? null,
        }),
    );
  });

  it("③ 端口缺席 ⇒ not_requested：draft 仍落 + 零审批单", async () => {
    originalReleaseApproval = (controller as any).releaseApproval;
    (controller as any).releaseApproval = null;

    const body = await commit(goals.notRequested);
    observed.push({ state: "not_requested", body });

    expect(body.approvalStatus).toBe("not_requested");
    expect(body.approvalKey).toBeUndefined();

    const draft = await draftFor(String(body.sopId));
    expect(draft).toHaveLength(1);
    expect(draft[0]).toMatchObject({ status: "draft", slug: body.slug });

    const approvals = await approvalsFor(String(body.sopId));
    const sessions = await sessionsFor(cardHashes[2]);
    expect(approvals).toHaveLength(0);
    expect(sessions).toHaveLength(0);

    console.info(
      "[commit-approval-status evidence] " +
        JSON.stringify({
          state: "not_requested",
          sopId: body.sopId,
          status: body.approvalStatus,
          draftRows: draft.length,
          approvalRows: approvals.length,
          sessionRows: sessions.length,
          approvalKey: body.approvalKey ?? null,
        }),
    );
  });

  it("④ 契约稳定性：三值稳定码齐全，旧硬编码中文 next 不再出现", async () => {
    expect(observed.map((item) => item.body.approvalStatus).sort()).toEqual(
      ["failed", "not_requested", "submitted"],
    );
    for (const item of observed) {
      expect(["submitted", "failed", "not_requested"]).toContain(item.body.approvalStatus);
      expect(item.body.approvalStatus).toMatch(/^[a-z_]+$/); // 稳定码，非中文文案
      expect(Object.prototype.hasOwnProperty.call(item.body, "next")).toBe(false);
    }
  });
});
