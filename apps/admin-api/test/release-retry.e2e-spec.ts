import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import request from "supertest";
import { DataSource } from "typeorm";

import { createTestApp } from "./helpers/app.helper";
import { AgentApprovalsService } from "../src/modules/agent/runtime/agent-approvals.service";
import { ReleaseApprovalService } from "../src/modules/workbench/release-approval.service";
import {
  sopContentHash,
  validateFrontMatter,
  type SopFrontMatter,
} from "../src/modules/sop/sop-frontmatter";

/**
 * 发布失败一键重试（真 PG 进程内 e2e，AGENTS §4.4 第 3 级）。
 *
 * 判据不是接口返回码，而是**真库副作用**：
 *   · 白名单 reason（consume 前失败）⇒ 真 consume + 真 publish：
 *     sop_versions 恰 1 行 publishedBy='agent:tool-call'，审批单 consumed + consumedAt 非空；
 *   · 二次 retry ⇒ consume 幂等，版本行数不增；
 *   · publish_failed / 未知 reason ⇒ 400（VALIDATION_FAILED），零发布副作用；
 *   · 审计旁路落 sop_publish.release_succeeded / release_failed。
 *
 * 真 Nest + 真 TypeORM + 真 PG；随机 uuid 隔离；afterAll 逐行清（失败也清）。
 * DB_DATABASE 必须是 test/e2e 库（生产 autoflow 缺表会拒跑）。
 */
describe("Release failure retry (real PG e2e)", () => {
  let app: INestApplication;
  let db: DataSource;
  let admin: string;
  let jwt: JwtService;
  let config: ConfigService;
  let approvals: AgentApprovalsService;
  let release: ReleaseApprovalService;

  interface Fixture {
    label: string;
    sopId: string;
    slug: string;
    cardHash: string;
    creatorName: string;
    contentHash: string;
    approvalKey: string;
    sessionId: string;
    bodyMarkdown: string;
  }
  /** 全部自建行按 fixture 记账，afterAll 逐行清（用例失败也清）。 */
  const fixtures: Fixture[] = [];

  const unwrap = (body: any) => body?.data ?? body;

  const approvalRow = async (approvalKey: string) =>
    (
      await db.query(
        `SELECT status, "decidedBy", "decidedAt", "consumedAt", "toolName"
         FROM agent_approvals WHERE "approvalKey" = $1`,
        [approvalKey],
      )
    )[0];

  const versionRows = async (sopId: string) =>
    db.query(
      `SELECT version, "publishedBy", "contentHash" FROM sop_versions
       WHERE "sopId" = $1 ORDER BY "publishedAt"`,
      [sopId],
    );

  const sopRow = async (sopId: string) =>
    (
      await db.query(
        'SELECT status, "currentVersion" FROM sops WHERE id = $1',
        [sopId],
      )
    )[0];

  const auditRows = async (approvalKey: string, action: string) => {
    const rows = await db.query(
      `SELECT action, result, detail FROM audit_logs
       WHERE action = $1 AND (detail ->> 'approvalKey') = $2`,
      [action, approvalKey],
    );
    return rows;
  };

  const waitAudit = async (approvalKey: string, action: string) => {
    // 审计是 fire-and-forget 旁路：轮询等落库，最多 3s。
    for (let i = 0; i < 30; i += 1) {
      const rows = await auditRows(approvalKey, action);
      if (rows.length > 0) return rows;
      await new Promise((r) => setTimeout(r, 100));
    }
    return auditRows(approvalKey, action);
  };

  /** 真库建 granted 审批单（= consume 前失败的可重试前提），零版本行。 */
  const createFixture = async (label: string): Promise<Fixture> => {
    const runId = randomUUID().slice(0, 10);
    const sopId = randomUUID();
    const slug = `e2e-retry-${label}-${runId}`;
    const cardHash = `card-retry-${label}-${runId}`;
    const creatorName = `e2e-retry-${label}-${runId}`;
    const bodyMarkdown = `# 发布重试 e2e ${label} ${runId}\n\n真库副作用验证用正文。`;
    const frontMatter = {
      acceptance: [{ kind: "command" as const, run: `echo retry-${label}` }],
    } as unknown as SopFrontMatter;
    const contentHash = sopContentHash(frontMatter, bodyMarkdown);
    const normalized = validateFrontMatter(
      frontMatter as unknown as Record<string, unknown>,
      { strict: true },
    );
    expect(sopContentHash(normalized, bodyMarkdown)).toBe(contentHash);

    await db.query(
      `INSERT INTO sops (id, slug, title, "currentVersion", status,
                         "applicationId", "frontMatterJson", "bodyMarkdown",
                         "createdBy", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, NULL, 'draft', NULL, $4::jsonb, $5, $6, now(), now())`,
      [
        sopId,
        slug,
        `发布重试 e2e ${label} ${runId}`,
        JSON.stringify(frontMatter),
        bodyMarkdown,
        `user:${creatorName}`,
      ],
    );

    const requested = await release.requestRelease({
      sopId,
      cardHash,
      contentHash,
      username: creatorName,
      bump: "patch",
    });
    expect(requested.approvalKey).toMatch(/^apr-/);
    expect(requested.sessionId).toBeTruthy();

    const decided = await approvals.decide(requested.approvalKey, "granted", "admin");
    expect(decided?.status).toBe("granted");

    const fixture: Fixture = {
      label,
      sopId,
      slug,
      cardHash,
      creatorName,
      contentHash,
      approvalKey: requested.approvalKey,
      sessionId: requested.sessionId,
      bodyMarkdown,
    };
    fixtures.push(fixture);

    // 前提自检：consume 前失败状态——审批 granted、零版本行、草稿未发布。
    expect(await versionRows(sopId)).toHaveLength(0);
    const before = await approvalRow(requested.approvalKey);
    expect(before.status).toBe("granted");
    expect(before.consumedAt).toBeNull();
    return fixture;
  };

  /**
   * 测试库 admin 的口令是环境种子（本轮实测 admin/admin123 不匹配，loginFailCount 已涨），
   * 但本 spec 验的是发布副作用而非口令策略：用同一套 JwtService + 真库用户行签 access
   * token，仍走真 JwtAuthGuard / RolesGuard（真 DB 查用户、真 role=admin 判定）。
   */
  const signAdminToken = async () => {
    const row = (
      await db.query(
        `SELECT id, "sessionVersion" FROM users WHERE username = 'admin' AND role = 'admin'`,
      )
    )[0];
    expect(row).toBeTruthy();
    return jwt.sign(
      { sub: row.id, type: "access", ver: row.sessionVersion },
      { secret: config.get<string>("jwt.secret") },
    );
  };

  const retry = async (
    approvalKey: string,
    expectedReason: string,
    token: string = admin,
  ) =>
    request(app.getHttpServer())
      .post(`/workbench/release-approvals/${approvalKey}/retry`)
      .set("Authorization", `Bearer ${token}`)
      .send({ expectedReason });

  beforeAll(async () => {
    const dbName = process.env.DB_DATABASE ?? "";
    if (!/(^|_)(test|e2e)(_|$)/i.test(dbName)) {
      throw new Error(
        `release retry e2e 需要 test/e2e 库（收到 ${dbName || "<empty>"}）`,
      );
    }
    app = await createTestApp();
    db = app.get(DataSource);
    jwt = app.get(JwtService);
    config = app.get(ConfigService);
    admin = await signAdminToken();
    approvals = app.get(AgentApprovalsService);
    release = app.get(ReleaseApprovalService);
    expect(approvals).toBeTruthy();
    expect(release).toBeTruthy();
  });

  afterAll(async () => {
    const step = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        console.warn(
          `WARN release-retry cleanup failed (${label}): ${String(err)}`,
        );
      }
    };
    try {
      if (db) {
        for (const f of fixtures) {
          await step(`approvals.byKey:${f.label}`, () =>
            db.query('DELETE FROM agent_approvals WHERE "approvalKey" = $1', [
              f.approvalKey,
            ]),
          );
          // decide 派生的会话级授权行（scope='session'）挂在同一 sessionId。
          await step(`approvals.bySession:${f.label}`, () =>
            db.query('DELETE FROM agent_approvals WHERE "sessionId" = $1', [
              f.sessionId,
            ]),
          );
          await step(`events:${f.label}`, () =>
            db.query('DELETE FROM agent_events WHERE "sessionId" = $1', [
              f.sessionId,
            ]),
          );
          await step(`sessions:${f.label}`, () =>
            db.query("DELETE FROM agent_sessions WHERE id = $1", [f.sessionId]),
          );
          await step(`versions:${f.label}`, () =>
            db.query('DELETE FROM sop_versions WHERE "sopId" = $1', [f.sopId]),
          );
          await step(`sops:${f.label}`, () =>
            db.query("DELETE FROM sops WHERE id = $1", [f.sopId]),
          );
        }
        // audit_logs 是 append-only（DB 触发器拒绝 DELETE）：按设计留在库里，
        // 用随机 approvalKey 隔离，不伪造删除。
      }
    } finally {
      await app?.close();
    }
  });

  it("① 白名单 policy_fingerprint_unavailable：retry 真 consume + 真 publish（断言真库副作用）", async () => {
    const f = await createFixture("policy-fp");
    const res = await retry(f.approvalKey, "policy_fingerprint_unavailable");

    expect([200, 201]).toContain(res.status);
    expect(unwrap(res.body)).toMatchObject({ retried: true, published: true });

    const versions = await versionRows(f.sopId);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      publishedBy: "agent:tool-call",
      contentHash: f.contentHash,
    });
    const after = await approvalRow(f.approvalKey);
    expect(after.status).toBe("consumed");
    expect(after.consumedAt).not.toBeNull();
    const published = await sopRow(f.sopId);
    expect(published.status).toBe("published");
    expect(published.currentVersion).toBe(versions[0].version);

    const audits = await waitAudit(f.approvalKey, "sop_publish.release_succeeded");
    expect(audits.length).toBeGreaterThan(0);
    expect(audits[0]).toMatchObject({ action: "sop_publish.release_succeeded" });
  });

  it("② 二次 retry：consume 幂等，sop_versions 不新增版本行", async () => {
    const f = await createFixture("idempotent");
    const first = await retry(f.approvalKey, "dependency_unavailable");
    expect([200, 201]).toContain(first.status);
    expect(await versionRows(f.sopId)).toHaveLength(1);

    const second = await retry(f.approvalKey, "dependency_unavailable");
    expect([200, 201, 400]).toContain(second.status);
    // 核心副作用断言：无论返回体口径如何，绝不能重复发布。
    expect(await versionRows(f.sopId)).toHaveLength(1);
    expect((await approvalRow(f.approvalKey)).status).toBe("consumed");
  });

  it("③ 白名单 dependency_unavailable：consume 前失败同样可重试", async () => {
    const f = await createFixture("dependency");
    const res = await retry(f.approvalKey, "dependency_unavailable");
    expect([200, 201]).toContain(res.status);
    expect(unwrap(res.body)).toMatchObject({ retried: true, published: true });

    const versions = await versionRows(f.sopId);
    expect(versions).toHaveLength(1);
    expect(versions[0].publishedBy).toBe("agent:tool-call");
    expect((await approvalRow(f.approvalKey)).consumedAt).not.toBeNull();
  });

  it("④ publish_failed ⇒ 400（VALIDATION_FAILED），零发布副作用（不调发布、不 consume）", async () => {
    const f = await createFixture("publish-failed");
    const res = await retry(f.approvalKey, "publish_failed");
    expect(res.status).toBe(400);

    expect(await versionRows(f.sopId)).toHaveLength(0);
    const after = await approvalRow(f.approvalKey);
    expect(after.status).toBe("granted");
    expect(after.consumedAt).toBeNull();
    expect((await sopRow(f.sopId)).status).toBe("draft");

    // 400 是入参闸门拒绝，根本没有 retry 尝试：审计表也不该出现重试记录。
    expect(await auditRows(f.approvalKey, "sop_publish.release_failed")).toHaveLength(0);
    expect(await auditRows(f.approvalKey, "sop_publish.release_succeeded")).toHaveLength(0);
  });

  it("⑦ 受理后真发布失败（content_changed）⇒ published:false + release_failed 审计", async () => {
    const f = await createFixture("content-changed");
    // 审批锚定后真库篡改草稿正文 ⇒ 服务端口径 content_changed，fail-closed。
    await db.query(
      'UPDATE sops SET "bodyMarkdown" = $2, "updatedAt" = now() WHERE id = $1',
      [f.sopId, `${f.bodyMarkdown}\n\n[TAMPERED]`],
    );

    const res = await retry(f.approvalKey, "content_changed");
    expect([200, 201]).toContain(res.status);
    expect(unwrap(res.body)).toMatchObject({
      retried: true,
      published: false,
    });

    expect(await versionRows(f.sopId)).toHaveLength(0);
    expect((await approvalRow(f.approvalKey)).status).toBe("granted");
    expect((await sopRow(f.sopId)).status).toBe("draft");

    const audits = await waitAudit(f.approvalKey, "sop_publish.release_failed");
    expect(audits.length).toBeGreaterThan(0);
    expect(audits[0]).toMatchObject({
      action: "sop_publish.release_failed",
      result: "failure",
    });
  });

  it("⑤ 未知 reason ⇒ 400（VALIDATION_FAILED），零发布副作用", async () => {
    const f = await createFixture("unknown-reason");
    const res = await retry(f.approvalKey, "totally_unknown_reason");
    expect(res.status).toBe(400);

    expect(await versionRows(f.sopId)).toHaveLength(0);
    const after = await approvalRow(f.approvalKey);
    expect(after.status).toBe("granted");
    expect(after.consumedAt).toBeNull();
    expect((await sopRow(f.sopId)).status).toBe("draft");
  });

  it("⑥ ADMIN-only：非管理员 token 不得触发重试（403/401 且零副作用）", async () => {
    const f = await createFixture("not-admin");
    // 无 token / 非法 token 必须被守卫拦下，不能借重试端点拿发布权。
    const res = await request(app.getHttpServer())
      .post(`/workbench/release-approvals/${f.approvalKey}/retry`)
      .send({ expectedReason: "dependency_unavailable" });
    expect([401, 403]).toContain(res.status);
    expect(await versionRows(f.sopId)).toHaveLength(0);
    expect((await approvalRow(f.approvalKey)).status).toBe("granted");
  });
});
