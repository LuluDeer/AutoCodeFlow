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
 * ADR-045 · 审批单跨实例恢复（两个真 Nest 实例 + 真 PG + 真 Redis，AGENTS §4.4 第 3 级）。
 *
 * 与 release-restart-recovery.e2e-spec.ts 的区别：那份用**单进程清 Map**模拟重启；
 * 本 spec 用 `createTestApp()` 起**两个真 Nest 实例**（A / B），共享同一 PG
 * （DB_DATABASE=autoflow_test）与 Redis。A 建单 + 批准，B 完成发布。
 *
 * 「跨实例」的核心证据：
 *   · A 的 argsByApprovalKey 在 requestRelease 后**含**该 key（快路径）；
 *   · B 的 argsByApprovalKey 从未见过该 key（**必空**）——B 无法走内存快路径；
 *   · B 的 releaseByApprovalKey 仍发布成功 ⇒ 必然走
 *     approvalKey → agent_approvals(sessionId,argsDigest) → session.contextJson
 *     → 重建 args → digest 逐字对账 → consume + publish 的**持久化恢复路径**。
 *
 * 只断言真实副作用（sop_versions / agent_approvals / agent_sessions / sops 行），
 * 不把「接口返回成功」当结论。零 mock（除 jest.spyOn 只读观察真实调用）、零 page.route；
 * 随机 uuid 隔离；afterAll 精确清理自建行（失败也清）。
 */
describe("Release approval cross-instance recovery (two real Nest apps, real PG e2e)", () => {
  const E2E_PREFIX = "e2e-crossinst";

  let appA: INestApplication;
  let appB: INestApplication;
  let dbA: DataSource;
  let dbB: DataSource;

  let approvalsA: AgentApprovalsService;
  let approvalsB: AgentApprovalsService;
  let sessionsA: AgentSessionService;
  let sessionsB: AgentSessionService;
  let releaseA: ReleaseApprovalService;
  let releaseB: ReleaseApprovalService;
  let sopsA: SopService;
  let sopsB: SopService;

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
  /** INSERT sops 后立即记账：即便后续建单/断言抛错，afterAll 仍能清掉 draft 行。 */
  const earlySopIds: string[] = [];

  /** 进程内快路径 Map 的持有判定（只读观察，不篡改）。 */
  const cachedKeyIn = (release: ReleaseApprovalService, key: string): boolean =>
    (release as any).argsByApprovalKey.has(key);

  const approvalRow = async (db: DataSource, approvalKey: string) =>
    (
      await db.query(
        `SELECT status, scope, "decidedBy", "decidedAt", "consumedAt",
                "argsDigest", "policyFingerprint", "toolName"
         FROM agent_approvals WHERE "approvalKey" = $1`,
        [approvalKey],
      )
    )[0];

  const versionRows = async (db: DataSource, sopId: string) =>
    db.query(
      `SELECT version, "publishedBy", "contentHash" FROM sop_versions
       WHERE "sopId" = $1 ORDER BY "publishedAt"`,
      [sopId],
    );

  const contextOf = async (db: DataSource, sessionId: string) =>
    (
      await db.query(
        'SELECT "contextJson" FROM agent_sessions WHERE id = $1',
        [sessionId],
      )
    )[0]?.contextJson as Record<string, unknown> | undefined;

  /**
   * 用 appA 在真库建 draft + 由 appA 的 release 服务建审批单；
   * fixture 入账供 afterAll 清理。建单后钉死「A 有 key、B 无 key」。
   */
  const createFixtureInA = async (label: string): Promise<Fixture> => {
    const runId = randomUUID().slice(0, 10);
    const sopId = randomUUID();
    const slug = `${E2E_PREFIX}-${label}-${runId}`;
    const cardHash = `card-crossinst-${label}-${runId}`;
    const creatorName = `${E2E_PREFIX}-${label}-${runId}`;
    const bodyMarkdown = `# 审批跨实例恢复 e2e ${label} ${runId}\n\n两真实例共享真库副作用验证用正文。`;
    const frontMatter = {
      acceptance: [{ kind: "command" as const, run: `echo crossinst-${label}` }],
    } as unknown as SopFrontMatter;
    const contentHash = sopContentHash(frontMatter, bodyMarkdown);
    // strict 归一化后哈希必须与申请锚点一致，否则会因 content_changed 假红。
    const normalized = validateFrontMatter(
      frontMatter as unknown as Record<string, unknown>,
      { strict: true },
    );
    expect(sopContentHash(normalized, bodyMarkdown)).toBe(contentHash);

    // A 实例直连真库建 draft（B 实例随后从同一库读到它）。
    await dbA.query(
      `INSERT INTO sops (id, slug, title, "currentVersion", status,
                         "applicationId", "frontMatterJson", "bodyMarkdown",
                         "createdBy", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, NULL, 'draft', NULL, $4::jsonb, $5, $6, now(), now())`,
      [
        sopId,
        slug,
        `审批跨实例恢复 e2e ${label} ${runId}`,
        JSON.stringify(frontMatter),
        bodyMarkdown,
        `user:${creatorName}`,
      ],
    );
    // 与 sopId 同时记账：后续任何断言抛错都不会让这条 draft 变孤儿。
    earlySopIds.push(sopId);
    // 同一 draft 必须对 B 实例的 DataSource 可见（证明两实例共享同一库）。
    const seenByB = (
      await dbB.query('SELECT id, status FROM sops WHERE id = $1', [sopId])
    )[0];
    expect(seenByB).toMatchObject({ id: sopId, status: "draft" });

    const args: ReleaseApprovalArgs = {
      sopId,
      cardHash,
      contentHash,
      bump: "patch",
    };
    const requested = await releaseA.requestRelease({
      sopId,
      cardHash,
      contentHash,
      username: creatorName,
      bump: "patch",
    });
    expect(requested.approvalKey).toMatch(/^apr-/);
    expect(requested.sessionId).toBeTruthy();

    // 核心证据：建单只在 A 发生 ⇒ A 的快路径有该 key，B 的快路径必空。
    expect(cachedKeyIn(releaseA, requested.approvalKey)).toBe(true);
    expect(cachedKeyIn(releaseB, requested.approvalKey)).toBe(false);

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
        `release cross-instance e2e 需要 test/e2e 库（收到 ${dbName || "<empty>"}）`,
      );
    }

    // 两个真 Nest 实例：独立 DI 容器 ⇒ 各自持有独立的进程内 Map。
    appA = await createTestApp();
    appB = await createTestApp();
    dbA = appA.get(DataSource);
    dbB = appB.get(DataSource);

    approvalsA = appA.get(AgentApprovalsService);
    approvalsB = appB.get(AgentApprovalsService);
    sessionsA = appA.get(AgentSessionService);
    sessionsB = appB.get(AgentSessionService);
    releaseA = appA.get(ReleaseApprovalService);
    releaseB = appB.get(ReleaseApprovalService);
    sopsA = appA.get(SopService);
    sopsB = appB.get(SopService);

    expect(approvalsA).toBeTruthy();
    expect(approvalsB).toBeTruthy();
    expect(sessionsA).toBeTruthy();
    expect(sessionsB).toBeTruthy();
    expect(releaseA).toBeTruthy();
    expect(releaseB).toBeTruthy();
    expect(sopsA).toBeTruthy();
    expect(sopsB).toBeTruthy();

    // 实例隔离：两个服务实例、两个 DataSource 实例都是不同对象。
    expect(releaseA).not.toBe(releaseB);
    expect(approvalsA).not.toBe(approvalsB);
    expect(dbA).not.toBe(dbB);

    // 但它们连的是同一个物理库（否则 B 永远看不到 A 的写入）。
    const [dbNameA] = await dbA.query("SELECT current_database() AS name");
    const [dbNameB] = await dbB.query("SELECT current_database() AS name");
    expect(dbNameA.name).toBe(dbNameB.name);

    // 恢复路径依赖的两个惰性端口在 B 实例上必须存在（不可枚举也行）。
    const approvalPortB = (releaseB as any).approvals;
    const sessionPortB = (releaseB as any).sessions;
    expect(typeof approvalPortB?.findByKey).toBe("function");
    expect(typeof sessionPortB?.findById).toBe("function");
  });

  afterAll(async () => {
    const step = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        console.warn(
          `WARN release-cross-instance cleanup failed (${label}): ${String(err)}`,
        );
      }
    };
    try {
      if (dbA) {
        for (const f of fixtures) {
          await step(`approvals.byKey:${f.label}`, () =>
            dbA.query('DELETE FROM agent_approvals WHERE "approvalKey" = $1', [
              f.approvalKey,
            ]),
          );
          // decide 派生的会话级授权行（scope='session'）挂在同一 sessionId 上。
          await step(`approvals.bySession:${f.label}`, () =>
            dbA.query('DELETE FROM agent_approvals WHERE "sessionId" = $1', [
              f.sessionId,
            ]),
          );
          await step(`events:${f.label}`, () =>
            dbA.query('DELETE FROM agent_events WHERE "sessionId" = $1', [
              f.sessionId,
            ]),
          );
          await step(`sessions:${f.label}`, () =>
            dbA.query("DELETE FROM agent_sessions WHERE id = $1", [f.sessionId]),
          );
          await step(`versions:${f.label}`, () =>
            dbA.query('DELETE FROM sop_versions WHERE "sopId" = $1', [f.sopId]),
          );
          await step(`sops:${f.label}`, () =>
            dbA.query("DELETE FROM sops WHERE id = $1", [f.sopId]),
          );
        }
        // 兜底：fixtures 记账之前就 INSERT 的 draft（建单中途抛错时只有这里能清）。
        for (const sopId of earlySopIds) {
          await step(`versions.early:${sopId.slice(0, 8)}`, () =>
            dbA.query('DELETE FROM sop_versions WHERE "sopId" = $1', [sopId]),
          );
          await step(`sops.early:${sopId.slice(0, 8)}`, () =>
            dbA.query("DELETE FROM sops WHERE id = $1", [sopId]),
          );
        }
      }
    } finally {
      await appB?.close();
      await appA?.close();
    }
  });

  it("① A 申请+批准、B 用空 Map 走持久化恢复并完成真发布", async () => {
    const f = await createFixtureInA("ok");

    // 跨实例核心证据再钉一次：B 的快路径确实没有这张单的锚点。
    expect(cachedKeyIn(releaseA, f.approvalKey)).toBe(true);
    expect(cachedKeyIn(releaseB, f.approvalKey)).toBe(false);

    // 锚点确实落库（不是只在 A 的进程内存里）。
    const stored = await contextOf(dbA, f.sessionId);
    expect(stored).toMatchObject({
      sopId: f.sopId,
      cardHash: f.cardHash,
      contentHash: f.contentHash,
      bump: "patch",
    });
    const rowBefore = await approvalRow(dbA, f.approvalKey);
    expect(rowBefore.argsDigest).toBe(computeApprovalArgsDigest(f.args));
    expect(rowBefore.status).toBe("pending");

    // A 实例批准（真库 pending → granted）。
    const decided = await approvalsA.decide(f.approvalKey, "granted", "admin");
    expect(decided?.status).toBe("granted");

    // spy 装在 B 实例上、且在 A 的 decide 之后，避免把 A 的读算进来。
    const findSpyOnB = jest.spyOn(approvalsB, "findByKey");
    try {
      const result = await releaseB.releaseByApprovalKey(f.approvalKey, null);
      expect(result).toEqual({ published: true });
      // B 必然通过真库回读审批单：持久化恢复路径被真实执行。
      expect(findSpyOnB).toHaveBeenCalledWith(f.approvalKey);
      expect(findSpyOnB).toHaveBeenCalledTimes(1);
    } finally {
      findSpyOnB.mockRestore();
    }

    // 真库副作用（全部从 B 实例的 DataSource 读，证明 B 看到 A 的单 + 自己发的版）。
    const versions = await versionRows(dbB, f.sopId);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      publishedBy: "agent:tool-call",
      contentHash: f.contentHash,
    });
    const rowAfter = await approvalRow(dbB, f.approvalKey);
    expect(rowAfter.status).toBe("consumed");
    expect(rowAfter.consumedAt).not.toBeNull();
    const sopRow = (
      await dbB.query('SELECT status, "currentVersion" FROM sops WHERE id = $1', [
        f.sopId,
      ])
    )[0];
    expect(sopRow.status).toBe("published");
    expect(sopRow.currentVersion).toBe(versions[0].version);
  });

  it("② 篡改反证：B 读到的 contextJson.cardHash 被真库改写 ⇒ digest 不符，零发布副作用", async () => {
    const f = await createFixtureInA("tampered");

    expect(cachedKeyIn(releaseA, f.approvalKey)).toBe(true);
    expect(cachedKeyIn(releaseB, f.approvalKey)).toBe(false);

    // 篡改 B 所依赖的会话上下文（经 B 实例的 DataSource 写，A 的单保持原样）。
    const tamperedCardHash = `${f.cardHash}-tampered`;
    await dbB.query(
      `UPDATE agent_sessions SET "contextJson" =
         jsonb_set("contextJson", '{cardHash}', to_jsonb($2::text))
       WHERE id = $1`,
      [f.sessionId, tamperedCardHash],
    );
    const stored = await contextOf(dbB, f.sessionId);
    expect(stored?.cardHash).toBe(tamperedCardHash);

    // 篡改后的 args 摘要必须与该单落库的 argsDigest 不同。
    const rowBefore = await approvalRow(dbA, f.approvalKey);
    expect(
      computeApprovalArgsDigest({ ...f.args, cardHash: tamperedCardHash }),
    ).not.toBe(rowBefore.argsDigest);

    expect(await versionRows(dbB, f.sopId)).toHaveLength(0);
    const decided = await approvalsA.decide(f.approvalKey, "granted", "admin");
    expect(decided?.status).toBe("granted");

    const findSpyOnB = jest.spyOn(approvalsB, "findByKey");
    try {
      const result = await releaseB.releaseByApprovalKey(f.approvalKey, null);
      expect(result).toEqual({ published: false, reason: "dependency_unavailable" });
      // B 仍走持久化恢复读到了被篡改的 context，只是被 digest 闸挡下。
      expect(findSpyOnB).toHaveBeenCalledWith(f.approvalKey);
    } finally {
      findSpyOnB.mockRestore();
    }

    // 真库副作用：零版本行、审批单停在 granted 未被 consume、draft 未发布。
    expect(await versionRows(dbB, f.sopId)).toHaveLength(0);
    const rowAfter = await approvalRow(dbB, f.approvalKey);
    expect(rowAfter.status).toBe("granted");
    expect(rowAfter.consumedAt).toBeNull();
    const sopRow = (
      await dbB.query('SELECT status, "currentVersion" FROM sops WHERE id = $1', [
        f.sopId,
      ])
    )[0];
    expect(sopRow.status).toBe("draft");
    expect(sopRow.currentVersion).toBeNull();
  });
});
