import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";

import { createTestApp, loginAsAdmin } from "./helpers/app.helper";
import {
  AgentApprovalsService,
  computeApprovalArgsDigest,
} from "../src/modules/agent/runtime/agent-approvals.service";
import { AgentSessionService } from "../src/modules/agent/runtime/agent-session.service";
import { ReleaseApprovalService } from "../src/modules/workbench/release-approval.service";
import { SopService } from "../src/modules/sop/sop.service";
import {
  sopContentHash,
  validateFrontMatter,
  type SopFrontMatter,
} from "../src/modules/sop/sop-frontmatter";

/**
 * ADR-045 · 发布审批 → 收件箱 → 系统代理发布（真 PG 进程内 e2e，AGENTS §4.4 第 3 级）。
 *
 * 本 spec 的存在理由是**副作用**，不是「接口返回成功」：
 *   ① 主管 `GET /agent/approvals/pending` 里出现这张 `sop_publish` 待批单
 *      （toolName / preview 可解析出 args / argsDigest 64 位 hex）；
 *   ② 业务人员（role=user，非创建人）同一端点**看不到**它（第 70 轮归属过滤对发布单同样成立）；
 *   ③ 主管 grant ⇒ 真库 `agent_approvals` 落定 + `sop_versions` 出现 `published_by='agent:tool-call'`；
 *   ④ 重放不重复发布（consume=false / 重复 grant 409 / 版本行数不增）；
 *   ⑤ `args_digest` 与 `sha256(canonicalJson(args))` 同源（现算比对）。
 *
 * 真服务、真仓储、真 PG：不 mock 任何东西（传输层也是 supertest 真 HTTP）。
 * 随机 uuid 隔离；afterAll 精确清理自建行（失败也清）。
 *
 * ## 两处曾实测到的产品缺陷（第 72 轮已修，本 spec 转为**回归锚点**）
 *
 * 1. `workbench.module.ts` 的 `RELEASE_APPROVALS_PORT` 曾在 WorkbenchModule 实例化期
 *    **eager** 调 `moduleRef.get(AgentApprovalsService, {strict:false})`，拿到的是
 *    一个**构造器没跑过**的实例（仓储 undefined）⇒ `requestRelease` 在
 *    `approvals.request()` 处抛 `Cannot read properties of undefined (reading 'create')`。
 *    已改为**惰性代理**（每个方法现场 `moduleRef.get`）。本 spec 现在直接断言端口可调用
 *    （`typeof port.request === 'function'`），不再在测试进程内替换端口——否则 e2e 会
 *    掩盖「代理是否真的惰性」这件事。
 * 2. `AgentInboxService` 的「空视域哨兵」曾是裸字符串 `__no_visible_session__`，打在
 *    **uuid 列** `sessionId` 上 ⇒ PG `invalid input syntax for type uuid` ⇒
 *    items/total/sessionTotal 全 null + `degraded:true`。已改为合法的全零 uuid。
 *    本 spec 因此**新增 ⑦**：零会话的 role=user 必须拿到 `total=0 / degraded=false`
 *    （「事实是零」而不是「读不到」）。
 */
describe("Publish approval inbox (real PG e2e)", () => {
  let app: INestApplication;
  let db: DataSource;
  let admin: string;
  let approvals: AgentApprovalsService;
  let sessions: AgentSessionService;
  let release: ReleaseApprovalService;
  let sops: SopService;

  const runId = randomUUID().slice(0, 10);
  const sopId = randomUUID();
  const slug = `e2e-publish-${runId}`;
  const cardHash = `card-${runId}`;
  const creatorName = `e2e-creator-${runId}`;
  const bizName = `e2e-biz-${runId}`;
  const bizPassword = `Aa1!${randomUUID()}`;
  // ⑦ 用：**零会话**的 role=user（空视域分支的真进程回归锚点）。
  const biz0Name = `e2e-biz0-${runId}`;
  const biz0Password = `Aa1!${randomUUID()}`;
  const bodyMarkdown = `# 发布审批 e2e ${runId}\n\n真库副作用验证用正文。`;
  const frontMatter = {
    acceptance: [{ kind: "command" as const, run: "echo publish-e2e" }],
  } as unknown as SopFrontMatter;
  const contentHash = sopContentHash(frontMatter, bodyMarkdown);
  const releaseArgs = { sopId, cardHash, contentHash, bump: "patch" as const };

  let approvalKey = "";
  let sessionId = "";
  let bizSessionId = "";
  let bizUserId: number | null = null;
  let bizToken = "";
  let biz0UserId: number | null = null;
  let biz0Token = "";

  const unwrap = (body: any) => body?.data ?? body;

  const pendingFor = async (token: string) => {
    const res = await request(app.getHttpServer())
      .get("/agent/approvals/pending")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return unwrap(res.body) as {
      items: Array<{
        approvalKey: string;
        sessionId: string;
        toolName: string;
        preview: string | null;
        argsDigest: string | null;
      }>;
      total: number | null;
      sessionTotal: number | null;
      returned: number;
      degraded: boolean;
    };
  };

  const approvalRow = async () =>
    (
      await db.query(
        `SELECT status, scope, "decidedBy", "decidedAt", "consumedAt",
                "argsDigest", "policyFingerprint", "toolName"
         FROM agent_approvals WHERE "approvalKey" = $1`,
        [approvalKey],
      )
    )[0];

  const versionRows = async () =>
    db.query(
      `SELECT version, "publishedBy", "contentHash" FROM sop_versions
       WHERE "sopId" = $1 ORDER BY "publishedAt"`,
      [sopId],
    );

  beforeAll(async () => {
    const dbName = process.env.DB_DATABASE ?? "";
    if (!/(^|_)(test|e2e)(_|$)/i.test(dbName)) {
      throw new Error(
        `publish approval inbox e2e 需要 test/e2e 库（收到 ${dbName || "<empty>"}）`,
      );
    }
    app = await createTestApp();
    db = app.get(DataSource);
    admin = await loginAsAdmin(app);
    approvals = app.get(AgentApprovalsService);
    sessions = app.get(AgentSessionService);
    release = app.get(ReleaseApprovalService);
    sops = app.get(SopService);
    expect(approvals).toBeTruthy();
    expect(sessions).toBeTruthy();
    expect(release).toBeTruthy();
    expect(sops).toBeTruthy();

    // ── 装配回归锚点（第 72 轮修复后）：端口必须是**可调用**的惰性代理 ──────────
    // 修复前这里是 eager 的「构造器未跑」空壳（`port.request` 存在但内部仓储 undefined）；
    // 修复后 `request` 每次调用现场解析真服务。此处只断言「可调用」，
    // 真正的证明是 ③ 的发布副作用——若代理失效，③ 必红（不再有测试进程内替换）。
    const port = (release as any).approvals;
    expect(typeof port?.request).toBe("function");
    expect(typeof port?.consume).toBe("function");
    expect(typeof port?.buildKey).toBe("function");

    // 业务人员（role=user）：走真注册面，不直插 users 行。
    const created = await request(app.getHttpServer())
      .post("/users")
      .set("Authorization", `Bearer ${admin}`)
      .send({
        username: bizName,
        password: bizPassword,
        email: `${bizName}@example.invalid`,
        role: "user",
      })
      .expect(201);
    bizUserId = unwrap(created.body).id ?? null;
    expect(bizUserId).toBeTruthy();
    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username: bizName, password: bizPassword })
      .expect(201);
    bizToken = unwrap(login.body).accessToken;
    expect(bizToken).toBeTruthy();

    // ⑦ 的另一个业务人员：**不建任何会话**（空视域分支）。
    const created0 = await request(app.getHttpServer())
      .post("/users")
      .set("Authorization", `Bearer ${admin}`)
      .send({
        username: biz0Name,
        password: biz0Password,
        email: `${biz0Name}@example.invalid`,
        role: "user",
      })
      .expect(201);
    biz0UserId = unwrap(created0.body).id ?? null;
    expect(biz0UserId).toBeTruthy();
    const login0 = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username: biz0Name, password: biz0Password })
      .expect(201);
    biz0Token = unwrap(login0.body).accessToken;
    expect(biz0Token).toBeTruthy();

    // 业务人员**自己**的会话：让 ② 真正走「按 createdBy 过滤」分支（非空视域），
    // 而不是被「零会话 ⇒ 空视域哨兵」的既有缺陷掩盖（见文件头注缺陷 2）。
    const bizSession = await sessions.create({
      kind: "chat",
      triggerSource: "e2e-publish-inbox",
      createdBy: `user:${bizName}`,
      title: `业务人员自己的会话 ${runId}`,
      context: { question: `e2e ${runId}` },
    });
    bizSessionId = bizSession.id;
    expect(bizSessionId).toBeTruthy();

    // 真 SOP 草稿（发布链要求 front-matter 过 strict 校验 + 正文非空）。
    await db.query(
      `INSERT INTO sops (id, slug, title, "currentVersion", status,
                         "applicationId", "frontMatterJson", "bodyMarkdown",
                         "createdBy", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, NULL, 'draft', NULL, $4::jsonb, $5, $6, now(), now())`,
      [
        sopId,
        slug,
        `发布审批 e2e ${runId}`,
        JSON.stringify(frontMatter),
        bodyMarkdown,
        `user:${creatorName}`,
      ],
    );
    // 发布前自检：strict 归一化后的内容哈希必须与申请时锚定的哈希一致，
    // 否则第 ③ 条会因 content_changed 而假红（那是产品行为，不是本 spec 的断言）。
    const normalized = validateFrontMatter(
      frontMatter as unknown as Record<string, unknown>,
      { strict: true },
    );
    expect(sopContentHash(normalized, bodyMarkdown)).toBe(contentHash);

    // 真服务建单：sop_review 会话 + sop_publish 待批单（createdBy = 申请人）。
    const requested = await release.requestRelease({
      sopId,
      cardHash,
      contentHash,
      username: creatorName,
      bump: "patch",
    });
    approvalKey = requested.approvalKey;
    sessionId = requested.sessionId;
    expect(approvalKey).toMatch(/^apr-/);
    expect(sessionId).toBeTruthy();
  });

  afterAll(async () => {
    // 逐步 try/catch：任何一步失败（例如 audit_logs 的 append-only 触发器）
    // 都不得吞掉后面的清理——首版就因这个把 6 轮的用户/SOP 行留在了库里。
    const step = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        console.warn(
          `WARN publish-approval-inbox cleanup failed (${label}): ${String(err)}`,
        );
      }
    };
    try {
      if (db) {
        if (approvalKey)
          await step("approvals.byKey", () =>
            db.query('DELETE FROM agent_approvals WHERE "approvalKey" = $1', [
              approvalKey,
            ]),
          );
        for (const sid of [sessionId, bizSessionId].filter(Boolean)) {
          // 派生会话级授权行（scope='session'）也挂在同一会话上。
          await step(`approvals.bySession:${sid}`, () =>
            db.query('DELETE FROM agent_approvals WHERE "sessionId" = $1', [
              sid,
            ]),
          );
          // agent_events 对 agent_sessions 是 ON DELETE CASCADE，显式删更省心。
          await step(`events:${sid}`, () =>
            db.query('DELETE FROM agent_events WHERE "sessionId" = $1', [sid]),
          );
          await step(`sessions:${sid}`, () =>
            db.query("DELETE FROM agent_sessions WHERE id = $1", [sid]),
          );
        }
        // audit_logs 是 append-only（DB 触发器拒绝 DELETE，由保留期任务收口）⇒
        // 本 spec 的 sop.publish 审计行按设计留在库里，不伪造删除。
        await step("versions", () =>
          db.query('DELETE FROM sop_versions WHERE "sopId" = $1', [sopId]),
        );
        await step("sops", () =>
          db.query("DELETE FROM sops WHERE id = $1", [sopId]),
        );
        if (bizUserId)
          await step("users", () =>
            db.query("DELETE FROM users WHERE id = $1", [bizUserId]),
          );
        if (biz0UserId)
          await step("users0", () =>
            db.query("DELETE FROM users WHERE id = $1", [biz0UserId]),
          );
      }
    } finally {
      await app?.close();
    }
  });

  it("① 主管收件箱出现该 sop_publish 待批单：preview 可解析出 args、argsDigest 是 64 位 hex", async () => {
    const page = await pendingFor(admin);
    const item = page.items.find((i) => i.approvalKey === approvalKey);
    expect(item).toBeTruthy();
    expect(item!.toolName).toBe("sop_publish");
    expect(item!.sessionId).toBe(sessionId);

    expect(typeof item!.preview).toBe("string");
    expect((item!.preview as string).length).toBeGreaterThan(0);
    const envelope = JSON.parse(item!.preview as string);
    expect(envelope).toMatchObject({ truncated: false });
    const previewArgs = JSON.parse(envelope.args);
    expect(previewArgs).toMatchObject({ sopId, cardHash, contentHash });
    expect(previewArgs.bump).toBe("patch");

    expect(item!.argsDigest).toMatch(/^[0-9a-f]{64}$/);
    // 信封口径：total 是独立计数（不是 items.length 冒充），且无降级。
    expect(page.total).toBeGreaterThanOrEqual(page.returned);
    expect(page.degraded).toBe(false);
  });

  it("② 业务人员（role=user，非创建人）同一端点看不到该单（归属过滤对发布单成立）", async () => {
    const mine = await pendingFor(bizToken);
    expect(mine.items.map((i) => i.approvalKey)).not.toContain(approvalKey);
    expect(mine.items.map((i) => i.sessionId)).not.toContain(sessionId);
    // 非空视域（他有自己的会话）⇒ 走真过滤分支，不是「读不到归属」的 fail-closed。
    expect(mine.degraded).toBe(false);
    expect(mine.total).toBe(0);
    expect(mine.sessionTotal).toBe(0);
    // 他自己的会话在库里确实存在（证明「看不到」不是因为他一无所有）。
    const own = (
      await db.query(
        'SELECT id, "createdBy" FROM agent_sessions WHERE id = $1',
        [bizSessionId],
      )
    )[0];
    expect(own.createdBy).toBe(`user:${bizName}`);
  });

  it("③ 主管 grant ⇒ 审批行落定 + sop_versions 出现 published_by='agent:tool-call'", async () => {
    const res = await request(app.getHttpServer())
      .post(`/agent/sessions/${sessionId}/approvals/${approvalKey}/grant`)
      .set("Authorization", `Bearer ${admin}`)
      .send({})
      .expect(201);
    const body = unwrap(res.body);
    expect(body.ok).toBe(true);
    expect(body.approval).toMatchObject({
      approvalKey,
      status: "granted",
      decidedBy: "admin",
    });

    const row = await approvalRow();
    expect(row).toBeTruthy();
    expect(row.toolName).toBe("sop_publish");
    expect(row.scope).toBe("once");
    expect(row.decidedBy).toBe("admin");
    expect(row.decidedAt).not.toBeNull();
    // 同一请求内 consume 已发生（发布是 grant 的同步副作用）⇒ 库里终态是 consumed；
    // 「granted」只是响应体里那一刻的快照，库里不停留。
    expect(row.status).toBe("consumed");
    expect(row.consumedAt).not.toBeNull();

    const versions = await versionRows();
    expect(versions).toHaveLength(1);
    expect(versions[0].publishedBy).toBe("agent:tool-call");
    expect(versions[0].contentHash).toBe(contentHash);

    const sopRow = (
      await db.query(
        'SELECT status, "currentVersion" FROM sops WHERE id = $1',
        [sopId],
      )
    )[0];
    expect(sopRow.status).toBe("published");
    expect(sopRow.currentVersion).toBe(versions[0].version);
    // 真服务读面回读：主表指针与不可变版本快照同源。
    const published = await sops.getSop(sopId);
    expect(published.currentVersion).toBe(versions[0].version);
    expect(published.status).toBe("published");
  });

  it("④ 重放不重复发布：consume=false / 重复 grant 409 / 版本行数不增", async () => {
    const before = await versionRows();
    expect(before).toHaveLength(1);
    const row = await approvalRow();
    const recordedFingerprint = row.policyFingerprint;
    expect(recordedFingerprint).toMatch(/^[0-9a-f]{64}$/);

    // 真 consume 再打一次：once 单已 consumed ⇒ 条件写命中 0 行。
    await expect(
      approvals.consume(approvalKey, recordedFingerprint),
    ).resolves.toBe(false);

    // 真发布入口再走一遍：不得再 publish。
    const replay = await release.releaseIfApproved({
      approvalKey,
      sopId,
      expectedContentHash: contentHash,
      currentPolicyFingerprint: recordedFingerprint,
    });
    expect(replay).toEqual({
      published: false,
      reason: "approval_not_consumed",
    });

    // 重复 grant 路径：条件写钉住 pending ⇒ 409。
    await request(app.getHttpServer())
      .post(`/agent/sessions/${sessionId}/approvals/${approvalKey}/grant`)
      .set("Authorization", `Bearer ${admin}`)
      .send({})
      .expect(409);

    expect(await versionRows()).toHaveLength(before.length);
    const after = await approvalRow();
    expect(after.status).toBe("consumed");
    expect(after.consumedAt).toEqual(row.consumedAt);
  });

  it("⑤ args_digest 与 sha256(canonicalJson(args)) 同源", async () => {
    const row = await approvalRow();
    expect(row.argsDigest).toBe(computeApprovalArgsDigest(releaseArgs));
    // 参数少一个 bump ⇒ 摘要必须不同（否则「批的就是这次调用」不成立）。
    const { bump: _bump, ...withoutBump } = releaseArgs;
    expect(computeApprovalArgsDigest(withoutBump)).not.toBe(row.argsDigest);
  });

  it("⑦ 零会话的 role=user 拿到「事实是零」而不是 degraded 信封（空视域回归锚点）", async () => {
    const page = await pendingFor(biz0Token);
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.sessionTotal).toBe(0);
    expect(page.returned).toBe(0);
    // 修复前：空视域哨兵打在 uuid 列 ⇒ PG 转换错误 ⇒ total=null + degraded=true。
    expect(page.degraded).toBe(false);
    // 库里确实有别人的待批单（证明「零」不是「库里没数据」）。
    const others = await db.query(
      'SELECT count(*)::int AS n FROM agent_approvals WHERE "approvalKey" = $1',
      [approvalKey],
    );
    expect(others[0].n).toBe(1);
  });

  it("⑥ 会话/审批单的真行仍在库里（清理前的最终事实）", async () => {
    const session = (
      await db.query(
        'SELECT id, kind, "createdBy" FROM agent_sessions WHERE id = $1',
        [sessionId],
      )
    )[0];
    expect(session.kind).toBe("sop_review");
    expect(session.createdBy).toBe(`user:${creatorName}`);
    const row = await approvalRow();
    expect(row.status).toBe("consumed");
    expect(row.argsDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
