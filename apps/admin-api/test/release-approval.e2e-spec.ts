import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { DataSource } from "typeorm";
import { createTestApp } from "./helpers/app.helper";
import {
  AgentApprovalsService,
  computeApprovalArgsDigest,
  computeApprovalPolicyFingerprint,
} from "../src/modules/agent/runtime/agent-approvals.service";

/**
 * AGENTS §4.4 第 3 级：真 PG + 真 Nest + 真 service（审批状态机）。
 * ADR-045：发布审批单的 scope=once / argsDigest 锚定 / 指纹失效 / 一次消费，
 * 是"系统代理发布"的前置闸——consume 成功才允许 publish。
 * 断言副作用而非接口 200：approval 行真落库、decide 条件写、consume 条件写。
 * 随机 approvalKey 隔离，afterAll 精确清理自建行。
 */
describe("Release approval chain (real PG e2e)", () => {
  let app: INestApplication;
  let db: DataSource;
  let approvals: AgentApprovalsService;

  const runId = randomUUID().slice(0, 10);
  const sessionId = randomUUID();
  const approvalKey = `apr-e2e-${runId}-sop_publish`;
  const fp = computeApprovalPolicyFingerprint({
    writeRequiresApproval: false,
    dangerousRequiresApproval: true,
    allowDangerous: false,
    executableSourceGate: true,
  });

  beforeAll(async () => {
    const dbName = process.env.DB_DATABASE ?? "";
    if (!/(^|_)(test|e2e)(_|$)/i.test(dbName)) {
      throw new Error(
        `release approval e2e 需要 test/e2e 库（收到 ${dbName || "<empty>"}）`,
      );
    }
    app = await createTestApp();
    db = app.get(DataSource);
    approvals = app.get(AgentApprovalsService);
    await db.query(
      `INSERT INTO agent_sessions (id, kind, status, "triggerSource", "totalSteps", "totalTokensIn", "totalTokensOut", "totalToolCalls", "createdAt", "updatedAt", "autoResumeCount", "contextFoldStreak")
       VALUES ($1, 'sop_review', 'waiting_input', 'e2e-release', 0, 0, 0, 0, now(), now(), 0, 0)`,
      [sessionId],
    );
  });

  afterAll(async () => {
    await db.query('DELETE FROM agent_approvals WHERE "approvalKey" = $1', [
      approvalKey,
    ]);
    await db.query("DELETE FROM agent_sessions WHERE id = $1", [sessionId]);
    await app?.close();
  });

  it("request(once/argsDigest) → decide(granted) → consume(指纹匹配) 状态流转真落库", async () => {
    const args = { sopId: `sop-e2e-${runId}`, contentHash: "a".repeat(64) };
    await approvals.request({
      approvalKey,
      sessionId,
      toolName: "sop_publish",
      reason: "e2e 发布审批",
      argsDigest: computeApprovalArgsDigest(args),
      preview: JSON.stringify({ truncated: false, args }),
      policyFingerprint: fp,
    });

    let rows = await db.query(
      'SELECT status, scope, "argsDigest", "policyFingerprint" FROM agent_approvals WHERE "approvalKey" = $1',
      [approvalKey],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].scope).toBe("once");
    expect(rows[0].argsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].policyFingerprint).toBe(fp);

    const granted = await approvals.decide(approvalKey, "granted", "reviewer");
    expect(granted?.status).toBe("granted");

    // 指纹匹配才 consume 成功（前置闸；publish 由 release service 在其后调用）
    const consumed = await approvals.consume(approvalKey, fp);
    expect(consumed).toBe(true);
    rows = await db.query(
      'SELECT status, "decidedBy", "consumedAt" FROM agent_approvals WHERE "approvalKey" = $1',
      [approvalKey],
    );
    expect(rows[0].status).toBe("consumed");
    expect(rows[0].decidedBy).toBe("reviewer");
    expect(rows[0].consumedAt).not.toBeNull();

    // 二次 consume 失败（once 幂等）
    expect(await approvals.consume(approvalKey, fp)).toBe(false);
  });
});
