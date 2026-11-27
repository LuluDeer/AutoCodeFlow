import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { DataSource } from "typeorm";

import { createTestApp } from "./helpers/app.helper";
import {
  AgentApprovalsService,
  computeApprovalArgsDigest,
} from "../src/modules/agent/runtime/agent-approvals.service";
import { AgentSessionService } from "../src/modules/agent/runtime/agent-session.service";
import {
  ReleaseApprovalService,
  type ReleaseApprovalArgs,
} from "../src/modules/workbench/release-approval.service";
import { SopService } from "../src/modules/sop/sop.service";
import {
  sopContentHash,
  validateFrontMatter,
  type SopFrontMatter,
} from "../src/modules/sop/sop-frontmatter";

/**
 * ADR-045 · 发布锚点跨进程恢复（真 PG 进程内 e2e，AGENTS §4.4 第 3 级）。
 *
 * 与 publish-approval-inbox.e2e-spec.ts 的区别：那份验证「同进程内存快路径」的
 * 审批 → 发布副作用；本 spec 专门验证「重启 / 多实例」下进程内
 * `argsByApprovalKey` / `sessionByRequestKey` 丢失后的**持久化恢复路径**：
 *   approvalKey → agent_approvals(sessionId,argsDigest) → agent_sessions.contextJson
 *   → 重建 args → argsDigest 逐字对账 → consume + publish。
 *
 * 只断言真实副作用（sop_versions / agent_approvals / agent_sessions / sops 行），
 * 不把「接口返回成功」当结论。零 mock（真 Nest + 真 TypeORM + 真 Redis + 真 PG）；
 * 随机 uuid 隔离；afterAll 精确清理自建行（失败也清）。
 */
describe("Release approval restart recovery (real PG e2e)", () => {
  let app: INestApplication;
  let db: DataSource;
  let approvals: AgentApprovalsService;
  let sessions: AgentSessionService;
  let release: ReleaseApprovalService;
  let sops: SopService;

  interface Fixture {
    label: string;
    sopId: string;
    slug: string;
    cardHash: string;
    creatorName: string;
    contentHash: string;
    approvalKey: string;
    sessionId: string;
    args: ReleaseApprovalArgs;
  }
  /** 全部自建行按 fixture 记账，afterAll 逐行清（用例失败也清）。 */
  const fixtures: Fixture[] = [];

  /** 模拟重启/另一实例：只清进程内快路径，真库一行不动。 */
  const clearProcessMaps = () => {
    (release as any).argsByApprovalKey.clear();
    (release as any).sessionByRequestKey.clear();
  };

  const approvalRow = async (approvalKey: string) =>
    (
      await db.query(
        `SELECT status, scope, "decidedBy", "decidedAt", "consumedAt",
                "argsDigest", "policyFingerprint", "toolName"
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

  const contextOf = async (sessionId: string) =>
    (
      await db.query(
        'SELECT "contextJson" FROM agent_sessions WHERE id = $1',
        [sessionId],
      )
    )[0]?.contextJson as Record<string, unknown> | undefined;

  /** 真库建 draft + 真 requestRelease 建单； fixture 入账供 afterAll 清理。 */
  const createFixture = async (label: string): Promise<Fixture> => {
    const runId = randomUUID().slice(0, 10);
    const sopId = randomUUID();
    const slug = `e2e-restart-${label}-${runId}`;
    const cardHash = `card-restart-${label}-${runId}`;
    const creatorName = `e2e-restart-${label}-${runId}`;
    const bodyMarkdown = `# 发布锚点恢复 e2e ${label} ${runId}\n\n真库副作用验证用正文。`;
    const frontMatter = {
      acceptance: [{ kind: "command" as const, run: `echo restart-${label}` }],
    } as unknown as SopFrontMatter;
    const contentHash = sopContentHash(frontMatter, bodyMarkdown);
    // strict 归一化后哈希必须与申请锚点一致，否则会因 content_changed 假红。
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
        `发布锚点恢复 e2e ${label} ${runId}`,
        JSON.stringify(frontMatter),
        bodyMarkdown,
        `user:${creatorName}`,
      ],
    );

    const args: ReleaseApprovalArgs = {
      sopId,
      cardHash,
      contentHash,
      bump: "patch",
    };
    const requested = await release.requestRelease({
      sopId,
      cardHash,
      contentHash,
      username: creatorName,
      bump: "patch",
    });
    expect(requested.approvalKey).toMatch(/^apr-/);
    expect(requested.sessionId).toBeTruthy();
    // 建单后内存快路径必须有该 key；否则本 spec 的「清 Map 后恢复」前提不成立。
    expect((release as any).argsByApprovalKey.has(requested.approvalKey)).toBe(
      true,
    );

    const fixture: Fixture = {
      label,
      sopId,
      slug,
      cardHash,
      creatorName,
      contentHash,
      approvalKey: requested.approvalKey,
      sessionId: requested.sessionId,
      args,
    };
    fixtures.push(fixture);
    return fixture;
  };

  beforeAll(async () => {
    const dbName = process.env.DB_DATABASE ?? "";
    if (!/(^|_)(test|e2e)(_|$)/i.test(dbName)) {
      throw new Error(
        `release restart recovery e2e 需要 test/e2e 库（收到 ${dbName || "<empty>"}）`,
      );
    }
    app = await createTestApp();
    db = app.get(DataSource);
    approvals = app.get(AgentApprovalsService);
    sessions = app.get(AgentSessionService);
    release = app.get(ReleaseApprovalService);
    sops = app.get(SopService);
    expect(approvals).toBeTruthy();
    expect(sessions).toBeTruthy();
    expect(release).toBeTruthy();
    expect(sops).toBeTruthy();

    // 恢复路径依赖的两个惰性端口：findByKey / findById 必须存在（不可枚举也行）。
    const approvalPort = (release as any).approvals;
    const sessionPort = (release as any).sessions;
    expect(typeof approvalPort?.findByKey).toBe("function");
    expect(typeof sessionPort?.findById).toBe("function");
  });

  afterAll(async () => {
    const step = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        console.warn(
          `WARN release-restart-recovery cleanup failed (${label}): ${String(err)}`,
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
          // decide 派生的会话级授权行（scope='session'）挂在同一 sessionId 上。
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
      }
    } finally {
      await app?.close();
    }
  });

  it("① 重启恢复：清 Map 后 findByKey 真回读 → digest 对账 → 真发布副作用", async () => {
    const f = await createFixture("ok");

    // 锚点确实落库（不是只在进程内存里）。
    const stored = await contextOf(f.sessionId);
    expect(stored).toMatchObject({
      sopId: f.sopId,
      cardHash: f.cardHash,
      contentHash: f.contentHash,
      bump: "patch",
    });
    const rowBefore = await approvalRow(f.approvalKey);
    expect(rowBefore.argsDigest).toBe(computeApprovalArgsDigest(f.args));
    expect(rowBefore.status).toBe("pending");

    clearProcessMaps();
    expect((release as any).argsByApprovalKey.has(f.approvalKey)).toBe(false);

    const decided = await approvals.decide(f.approvalKey, "granted", "admin");
    expect(decided?.status).toBe("granted");

    // spy 装在 decide 之后，避免把 decide 内部 findByKey 算进来。
    const findSpy = jest.spyOn(approvals, "findByKey");
    try {
      const result = await release.releaseByApprovalKey(f.approvalKey, null);
      expect(result).toEqual({ published: true });
      // 断言真的走了持久化恢复路径，而不是任何残留内存快路径。
      expect(findSpy).toHaveBeenCalledWith(f.approvalKey);
      expect(findSpy).toHaveBeenCalledTimes(1);
    } finally {
      findSpy.mockRestore();
    }

    const versions = await versionRows(f.sopId);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      publishedBy: "agent:tool-call",
      contentHash: f.contentHash,
    });
    const rowAfter = await approvalRow(f.approvalKey);
    expect(rowAfter.status).toBe("consumed");
    expect(rowAfter.consumedAt).not.toBeNull();
    const sopRow = (
      await db.query('SELECT status, "currentVersion" FROM sops WHERE id = $1', [
        f.sopId,
      ])
    )[0];
    expect(sopRow.status).toBe("published");
    expect(sopRow.currentVersion).toBe(versions[0].version);
  });

  it("② 篡改反证：真库改 contextJson.cardHash ⇒ digest 不符 fail-closed，零发布副作用", async () => {
    const f = await createFixture("tampered");

    clearProcessMaps();
    const tamperedCardHash = `${f.cardHash}-tampered`;
    await db.query(
      `UPDATE agent_sessions SET "contextJson" =
         jsonb_set("contextJson", '{cardHash}', to_jsonb($2::text))
       WHERE id = $1`,
      [f.sessionId, tamperedCardHash],
    );
    const stored = await contextOf(f.sessionId);
    expect(stored?.cardHash).toBe(tamperedCardHash);
    // 篡改后的 args 摘要必须与审批单落库的 argsDigest 不同。
    const rowBefore = await approvalRow(f.approvalKey);
    expect(computeApprovalArgsDigest({ ...f.args, cardHash: tamperedCardHash })).not.toBe(
      rowBefore.argsDigest,
    );

    expect(await versionRows(f.sopId)).toHaveLength(0);
    const decided = await approvals.decide(f.approvalKey, "granted", "admin");
    expect(decided?.status).toBe("granted");

    const result = await release.releaseByApprovalKey(f.approvalKey, null);
    expect(result).toEqual({ published: false, reason: "dependency_unavailable" });

    // 真库副作用：零版本行、审批单停在 granted 未被 consume、draft 未发布。
    expect(await versionRows(f.sopId)).toHaveLength(0);
    const rowAfter = await approvalRow(f.approvalKey);
    expect(rowAfter.status).toBe("granted");
    expect(rowAfter.consumedAt).toBeNull();
    const sopRow = (
      await db.query('SELECT status, "currentVersion" FROM sops WHERE id = $1', [
        f.sopId,
      ])
    )[0];
    expect(sopRow.status).toBe("draft");
    expect(sopRow.currentVersion).toBeNull();
  });
});
