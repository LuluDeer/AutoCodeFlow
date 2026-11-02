import { createHash } from "node:crypto";

import { AgentController } from "../agent.controller";
import type { AgentApproval } from "../entities/agent-approval.entity";
import {
  AgentApprovalsService,
  canonicalJson,
  computeApprovalArgsDigest,
} from "../runtime/agent-approvals.service";

/**
 * S1-C3（OSS 对照调研 · 审批信息完整性）：**审批单携带被批对象的摘要与预览**。
 *
 * 缺陷（一句话）：`agent_approvals` 只有工具名 + 固定 reason ⇒ 审批人看不到自己
 * 正在批准的调用带什么参数——四眼原则在信息面上是空的（盲批）。
 *
 * 本 spec 钉住三件不许漂移的事实：
 *   ① `argsDigest === sha256(canonicalJson(args))`，且与 `buildKey` 共用**同一份**
 *      `canonicalJson`（「批的就是这次调用」的对账锚点，不能有第二套规范化）；
 *   ② `request()` 真的把摘要/预览落库，且**必填**（新行的 NULL 只能表示「旧单」）；
 *   ③ 审批端点原样返回新字段；旧单（两列 NULL）不报错、不臆造。
 *
 * preview 的脱敏与截断规则在 tool-executor 侧（脱敏只有一份实现），逐条断言见
 * `tools/__tests__/tool-executor.service.spec.ts`。
 */
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

describe("S1-C3 · argsDigest 与审批键同源（canonicalJson 只有一份）", () => {
  const args = {
    taskId: 42,
    patch: { title: "新标题", labels: ["b", "a"] },
    note: "x",
  };

  it("computeApprovalArgsDigest === sha256(canonicalJson(args))（独立算一遍核对）", () => {
    // 期望值用 node:crypto + 同模块导出的 canonicalJson **独立**算一遍：
    // 若实现里偷偷换了序列化（键序、数组序、undefined 处理），这里立刻红。
    const expected = sha256hex(canonicalJson(args));
    expect(computeApprovalArgsDigest(args)).toBe(expected);
    expect(computeApprovalArgsDigest(args)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("buildKey 与 argsDigest 出自同一份规范化（一个 canonicalJson 串喂两者）", () => {
    const svc = new AgentApprovalsService({} as never);
    const canon = canonicalJson(args);
    expect(computeApprovalArgsDigest(args)).toBe(sha256hex(canon));
    // 键 §= apr-<sessionId>-<sha256(toolName|规范化参数) 前 16 位>：第二段必须
    // 由**同一个** canon 串算出——两处若各写一份规范化，审批键与摘要会对不上。
    expect(svc.buildKey("s-1", "update_task", args)).toBe(
      `apr-s-1-${sha256hex(`update_task|${canon}`).slice(0, 16)}`,
    );
  });

  it("键序不同 ⇒ 同摘要；参数任一不同 ⇒ 不同摘要；null 参数也是确定值", () => {
    const reordered = {
      note: "x",
      patch: { labels: ["b", "a"], title: "新标题" },
      taskId: 42,
    };
    expect(computeApprovalArgsDigest(reordered)).toBe(
      computeApprovalArgsDigest(args),
    );
    expect(computeApprovalArgsDigest({ ...args, taskId: 43 })).not.toBe(
      computeApprovalArgsDigest(args),
    );
    // args=null 不是「没有摘要」：canonicalJson(null) === "null" 是确定值，
    // 因此新行永远有摘要，NULL 只可能是「本列上线前创建」。
    expect(computeApprovalArgsDigest(null)).toBe(sha256hex("null"));
  });
});

describe("S1-C3 · request 把摘要与预览落库", () => {
  const input = {
    approvalKey: "apr-s-1-x",
    sessionId: "s-1",
    toolName: "update_task",
    reason: "write 类操作需要人工点头（审批策略 writeRequiresApproval=true）",
    argsDigest: "a".repeat(64),
    preview: '{"truncated":false,"args":"{\\"taskId\\":42}"}',
    // N3（迁移 1790000000087）：新行**必填**策略指纹——理由同 argsDigest：
    // 这一列的 NULL 只允许表示「本列上线前创建」，不许表示「忘了采集」。
    policyFingerprint: "c".repeat(64),
  };

  it("create() 带上 argsDigest/preview（审批人看的就是这份落库值）", async () => {
    const repo = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn(async (x: unknown) => x),
    };
    const svc = new AgentApprovalsService(repo as never);
    const row = await svc.request(input);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalKey: input.approvalKey,
        argsDigest: input.argsDigest,
        preview: input.preview,
        policyFingerprint: input.policyFingerprint,
        status: "pending",
      }),
    );
    expect(row).toMatchObject({
      argsDigest: input.argsDigest,
      preview: input.preview,
      policyFingerprint: input.policyFingerprint,
    });
  });

  /**
   * N3（迁移 1790000000087）：**新行必带策略指纹**，且授权范围固定 `once`。
   *
   * 为什么这条断言不能省：`policyFingerprint` 若在 `request()` 里漏传（或传成
   * `undefined`），落库就是 NULL——而 NULL 的语义是"本列上线前创建"。于是这
   * 张**新**单会被当成"旧单"，consume 时按 fail-closed 拒掉：症状是"所有新
   * 申请都执行不了"，根因却在一处没人看的漏传。故这里把它钉死。
   *
   * `scope` 同理：申请方不能自选授权范围（会话级授权只能由已批的单**派生**，
   * 见 `deriveSessionGrant`），否则调用方就能自己给自己发"会话级免审"。
   */
  it("N3：新行必带策略指纹、且授权范围固定 once（申请方不能自选 scope）", async () => {
    const repo = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn(async (x: unknown) => x),
    };
    const svc = new AgentApprovalsService(repo as never);
    const row = await svc.request(input);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        policyFingerprint: input.policyFingerprint,
        scope: "once",
      }),
    );
    expect(row.policyFingerprint).toBe(input.policyFingerprint);
    expect(row.scope).toBe("once");
  });

  it("无参数调用（preview=null）也能落库：NULL 的语义由摘要是否为空界定", async () => {
    const repo = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn(async (x: unknown) => x),
    };
    const svc = new AgentApprovalsService(repo as never);
    await svc.request({
      ...input,
      preview: null,
      argsDigest: computeApprovalArgsDigest(null),
    });
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ preview: null, argsDigest: sha256hex("null") }),
    );
  });
});

describe("S1-C3 · 过期单复活时刷新摘要与预览", () => {
  it("旧单（两列 NULL）复活 → 条件写一并写入本次调用的摘要/预览", async () => {
    const conflict = Object.assign(new Error("duplicate key"), {
      code: "23505",
    });
    let row: Record<string, unknown> = {
      id: "a-1",
      approvalKey: "apr-s-1-x",
      sessionId: "s-1",
      toolName: "update_task",
      reason: "r",
      status: "expired",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      decidedBy: "system:approval-ttl",
      decidedAt: new Date("2026-01-08T00:00:00Z"),
      consumedAt: null,
      // 这两列上线前的旧行：NULL
      argsDigest: null,
      preview: null,
    };
    const update = jest.fn(
      async (
        criteria: Record<string, unknown>,
        patch: Record<string, unknown>,
      ) => {
        const match = Object.entries(criteria).every(([k, v]) => row[k] === v);
        if (!match) return { affected: 0 };
        row = { ...row, ...patch };
        return { affected: 1 };
      },
    );
    const repo = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn(async () => {
        throw conflict;
      }),
      update,
      findOne: jest.fn(async () => ({ ...row })),
      find: jest.fn(async () => []),
    };
    const svc = new AgentApprovalsService(repo as never);
    const out = await svc.request({
      approvalKey: "apr-s-1-x",
      sessionId: "s-1",
      toolName: "update_task",
      reason: "r",
      argsDigest: "f".repeat(64),
      preview: '{"truncated":false,"args":"{}"}',
      policyFingerprint: "c".repeat(64),
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a-1", status: "expired" }),
      expect.objectContaining({
        status: "pending",
        argsDigest: "f".repeat(64),
        preview: '{"truncated":false,"args":"{}"}',
      }),
    );
    expect(out.status).toBe("pending");
    expect(out.argsDigest).toBe("f".repeat(64));
  });
});

describe("S1-C3 · 审批端点原样返回新字段（旧单 NULL 不报错）", () => {
  /** 与 agent-approvals.spec.ts 同款最小装配（只用到 approvals + sessions）。 */
  function harness(rows: Array<Partial<AgentApproval>>) {
    const approvals = {
      listForSession: jest.fn(async () => rows),
      findByKey: jest.fn(async () => null),
      hasPendingForSession: jest.fn(async () => false),
    };
    const sessions = {
      requireById: jest.fn(async () => ({
        id: "s-1",
        status: "waiting_input",
      })),
    };
    const ctl = new AgentController(
      sessions as never,
      { resolveBudget: jest.fn() } as never,
      approvals as unknown as AgentApprovalsService,
      { add: jest.fn() } as never,
      { get: () => false } as never,
    );
    return { ctl, approvals, sessions };
  }

  it("GET sessions/:id/approvals 返回 argsDigest/preview；跨会话列不出别人的单", async () => {
    const fresh = {
      id: "a-1",
      approvalKey: "apr-s-1-new",
      sessionId: "s-1",
      toolName: "update_task",
      reason: "r",
      status: "pending" as const,
      argsDigest: "b".repeat(64),
      preview: '{"truncated":false,"args":"{\\"taskId\\":42}"}',
    };
    const legacy = {
      id: "a-0",
      approvalKey: "apr-s-1-old",
      sessionId: "s-1",
      toolName: "sop_publish",
      reason: "r",
      status: "pending" as const,
      // 本列上线前的行：**不知道**，不是「没有参数」
      argsDigest: null,
      preview: null,
    };
    const { ctl, approvals } = harness([fresh, legacy]);
    const out = await ctl.listApprovals("s-1");
    expect(approvals.listForSession).toHaveBeenCalledWith("s-1");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      argsDigest: "b".repeat(64),
      preview: '{"truncated":false,"args":"{\\"taskId\\":42}"}',
    });
    // 旧单不报错：字段原样为 null，读面自己决定降级文案
    expect(out[1].argsDigest).toBeNull();
    expect(out[1].preview).toBeNull();
  });
});
