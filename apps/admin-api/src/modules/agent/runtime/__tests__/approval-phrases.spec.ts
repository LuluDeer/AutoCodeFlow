import type { AgentApproval } from "../../entities/agent-approval.entity";
import {
  AgentApprovalsService,
  computeApprovalPolicyFingerprint,
} from "../agent-approvals.service";
import { parseApprovalPhrase } from "../approval-phrases";

/**
 * N17 的一句话审批规格。分两层钉：
 *   ① 纯函数层的**整句白名单**（含模糊词/「allow all」必须不命中）；
 *   ② 服务层 `decideByPhrase` 的**指纹前置比对 + 一次性消费**（用内存表跑真实
 *      `decide` 的条件写，而不是 mock 掉它——重复消费的 409 正是从那里来）。
 */

const FP = computeApprovalPolicyFingerprint({
  writeRequiresApproval: false,
  dangerousRequiresApproval: true,
  allowDangerous: false,
  executableSourceGate: true,
});
const FP_CHANGED = computeApprovalPolicyFingerprint({
  writeRequiresApproval: true,
  dangerousRequiresApproval: true,
  allowDangerous: false,
  executableSourceGate: true,
});
const KEY = "apr-11111111-1111-4111-8111-111111111111-aaaaaaaaaaaaaaaa";
const SESSION = "11111111-1111-4111-8111-111111111111";

function pendingRow(over: Partial<AgentApproval> = {}): Partial<AgentApproval> {
  return {
    id: "row-1",
    approvalKey: KEY,
    sessionId: SESSION,
    // 非会话级白名单工具：decide(granted) 的 deriveSessionGrant 会早退，
    // 测试不需要给 insert 造替身。
    toolName: "update_task",
    reason: "r",
    argsDigest: "a".repeat(64),
    preview: null,
    status: "pending",
    scope: "once",
    policyFingerprint: FP,
    decidedBy: null,
    decidedAt: null,
    expiresAt: null,
    ...over,
  };
}

/** 最小内存表：findOne 按 where 全等匹配；update 按条件写返回 affected。 */
function makeRepo(rows: Array<Partial<AgentApproval>> = []) {
  const table = rows.map((r) => ({ ...r })) as Array<Record<string, unknown>>;
  const match = (
    row: Record<string, unknown>,
    where: Record<string, unknown>,
  ) => Object.entries(where).every(([k, v]) => row[k] === v);
  const repo = {
    __table: table,
    findOne: jest.fn(async (opts: { where: Record<string, unknown> }) => {
      const hit = table.find((r) => match(r, opts.where));
      return hit ? { ...hit } : null;
    }),
    update: jest.fn(
      async (
        criteria: Record<string, unknown>,
        patch: Record<string, unknown>,
      ) => {
        const hits = table.filter((r) => match(r, criteria));
        for (const r of hits) Object.assign(r, patch);
        return { affected: hits.length };
      },
    ),
  };
  return repo;
}

describe("N17 · parseApprovalPhrase 整句精确匹配", () => {
  it.each([
    ["allow", "allow"],
    ["allow once", "allow"],
    ["Allow", "allow"],
    ["  allow  ", "allow"],
    ["允许", "allow"],
    ["批准", "allow"],
    ["deny", "deny"],
    ["拒绝", "deny"],
    ["reset", "reset"],
  ])("命中 %p ⇒ kind=%s，scope 恒为 once", (phrase, kind) => {
    expect(parseApprovalPhrase(phrase)).toEqual({ kind, scope: "once" });
  });

  it.each([
    "可以",
    "好的",
    "行",
    "ok",
    "yes",
    "嗯",
    "批准吧",
    "allow all",
    "allow forever",
    "allow once please",
    "ALLOW ALL",
    "deny all",
    "  allow it  ",
    "",
  ])("模糊词/变体 %p 一律不命中（刻意收窄）", (phrase) => {
    expect(parseApprovalPhrase(phrase)).toBeNull();
  });
});

describe("N17 · decideByPhrase 服务层：指纹前置 + 一次性消费", () => {
  it("allow ⇒ granted，署名落库；deny ⇒ denied", async () => {
    const allowRepo = makeRepo([pendingRow()]);
    const denyRepo = makeRepo([pendingRow()]);
    const allowSvc = new AgentApprovalsService(allowRepo as never);
    const denySvc = new AgentApprovalsService(denyRepo as never);

    const granted = await allowSvc.decideByPhrase(KEY, "allow", "alice", FP);
    expect(granted?.status).toBe("granted");
    expect(granted?.decidedBy).toBe("alice");
    expect(allowRepo.__table[0].status).toBe("granted");

    const denied = await denySvc.decideByPhrase(KEY, "拒绝", "bob", FP);
    expect(denied?.status).toBe("denied");
    expect(denied?.decidedBy).toBe("bob");
    expect(denyRepo.__table[0].status).toBe("denied");
  });

  it("无法识别的短语 ⇒ 400，且不触碰单据", async () => {
    const repo = makeRepo([pendingRow()]);
    const svc = new AgentApprovalsService(repo as never);
    const spy = jest.spyOn(svc, "decide");
    await expect(
      svc.decideByPhrase(KEY, "可以", "alice", FP),
    ).rejects.toMatchObject({ errorCode: "VALIDATION_FAILED" });
    expect(spy).not.toHaveBeenCalled();
    expect(repo.__table[0].status).toBe("pending");
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("reset 是合法短语但 once 模型无对应授权动作 ⇒ 显式拒绝（可归因）", async () => {
    const repo = makeRepo([pendingRow()]);
    const svc = new AgentApprovalsService(repo as never);
    await expect(
      svc.decideByPhrase(KEY, "reset", "alice", FP),
    ).rejects.toMatchObject({ errorCode: "VALIDATION_FAILED" });
    expect(repo.__table[0].status).toBe("pending");
  });

  it("指纹变更 ⇒ 拒绝在 decide 之前，库里不动", async () => {
    const repo = makeRepo([pendingRow()]);
    const svc = new AgentApprovalsService(repo as never);
    const spy = jest.spyOn(svc, "decide");
    await expect(
      svc.decideByPhrase(KEY, "allow", "alice", FP_CHANGED),
    ).rejects.toMatchObject({ errorCode: "VALIDATION_FAILED" });
    expect(spy).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.__table[0].status).toBe("pending");
  });

  it("存量行没有指纹（NULL）⇒ 同样 fail-closed", async () => {
    const repo = makeRepo([pendingRow({ policyFingerprint: null })]);
    const svc = new AgentApprovalsService(repo as never);
    await expect(
      svc.decideByPhrase(KEY, "批准", "alice", FP),
    ).rejects.toMatchObject({ errorCode: "VALIDATION_FAILED" });
    expect(repo.__table[0].status).toBe("pending");
  });

  it("单据不存在 ⇒ 404", async () => {
    const svc = new AgentApprovalsService(makeRepo() as never);
    await expect(
      svc.decideByPhrase(KEY, "allow", "alice", FP),
    ).rejects.toMatchObject({ errorCode: "AGENT_APPROVAL_NOT_FOUND" });
  });

  it("重复消费同一张单 ⇒ 第二次 409（现有 decide 的条件写保证 once）", async () => {
    const repo = makeRepo([pendingRow()]);
    const svc = new AgentApprovalsService(repo as never);
    await expect(
      svc.decideByPhrase(KEY, "allow", "alice", FP),
    ).resolves.toMatchObject({ status: "granted" });
    await expect(
      svc.decideByPhrase(KEY, "allow", "alice", FP),
    ).rejects.toMatchObject({
      errorCode: "AGENT_APPROVAL_ALREADY_DECIDED",
    });
    expect(repo.__table[0].status).toBe("granted");
    expect(repo.__table.filter((r) => r.approvalKey === KEY)).toHaveLength(1);
  });
});
