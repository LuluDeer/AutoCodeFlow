import { createHash } from "node:crypto";

import {
  AgentApprovalsService,
  canonicalJson,
  computeApprovalArgsDigest,
} from "../../agent/runtime/agent-approvals.service";
import { sopContentHash, type SopFrontMatter } from "../../sop/sop-frontmatter";
import {
  RELEASE_PUBLISHED_BY,
  RELEASE_TOOL_NAME,
  ReleaseApprovalService,
  type ReleaseApprovalArgs,
  type ReleaseApprovalsPort,
  type ReleasePolicyPort,
  type ReleaseSessionsPort,
  type ReleaseSopsPort,
} from "../release-approval.service";

/**
 * ADR-045 重启/多实例恢复单测（内存替身级）：
 * approvals 端口用真 AgentApprovalsService + 内存 repo（findByKey / consume 真语义），
 * sessions 用最小替身提供 contextJson，sops/policy 用最小替身断言副作用。
 */

const FP = "fp-current";
const OTHER_FP = "fp-changed";
const SESSION_ID = "s-restored-1";

type Row = Record<string, any>;

const FRONT_MATTER = { title: "发布恢复锚定测试", capabilities: ["http"] };
const BODY = "## 步骤\n1. 读取输入\n2. 产出结果";
const CONTENT_HASH = sopContentHash(
  FRONT_MATTER as unknown as SopFrontMatter,
  BODY,
);

const BASE_ARGS: ReleaseApprovalArgs = {
  sopId: "sop-persist",
  cardHash: "abcdef0123456789",
  contentHash: CONTENT_HASH,
};

const REQUEST = {
  ...BASE_ARGS,
  username: "alice",
};

const REQUEST_WITH_BUMP = { ...REQUEST, bump: "minor" as const };

function makeArgs(
  overrides: Partial<ReleaseApprovalArgs> = {},
): ReleaseApprovalArgs {
  return { ...BASE_ARGS, ...overrides };
}

function approvalKeyFor(sessionId: string, args: ReleaseApprovalArgs): string {
  return `apr-${sessionId}-${createHash("sha256")
    .update(`${RELEASE_TOOL_NAME}|${canonicalJson(args)}`)
    .digest("hex")
    .slice(0, 16)}`;
}

function makeApprovals(seed: Row[] = []) {
  const rows: Row[] = seed.map((r) => ({ ...r }));
  const repo = {
    create: jest.fn((x: Row) => ({ ...x })),
    save: jest.fn(async (x: Row) => {
      if (rows.some((r) => r.approvalKey === x.approvalKey)) {
        throw Object.assign(new Error("duplicate key"), {
          code: "23505",
          constraint: "UQ_agent_approvals_approvalKey",
        });
      }
      const row: Row = { id: `a-${rows.length + 1}`, ...x };
      rows.push(row);
      return row;
    }),
    findOne: jest.fn(
      async ({ where }: { where: Row }) =>
        rows.find((r) => r.approvalKey === where.approvalKey) ?? null,
    ),
    find: jest.fn(async () => rows),
    update: jest.fn(async (where: Row, patch: Row) => {
      let affected = 0;
      for (const r of rows) {
        if (Object.entries(where).every(([k, v]) => r[k] === v)) {
          Object.assign(r, patch);
          affected += 1;
        }
      }
      return { affected };
    }),
  };
  const real = new AgentApprovalsService(repo as never);
  const port: ReleaseApprovalsPort = {
    buildKey: jest.fn((sid, tool, args) => real.buildKey(sid, tool, args)),
    request: jest.fn((input) => real.request(input)),
    consume: jest.fn((key, fp) => real.consume(key, fp)),
    findByKey: jest.fn((key) => real.findByKey(key)),
  };
  return { rows, repo, port };
}

function makeSessions(context: Row | null, withFindById = true) {
  const findById = jest.fn(async (id: string) => ({
    id,
    contextJson: context,
  }));
  const port: ReleaseSessionsPort = {
    create: jest.fn(async (input) => ({ id: "s-created", ...input })),
    findReviewSession: jest.fn(async () => null),
    findById: withFindById ? findById : undefined,
  };
  return { findById, port };
}

function makeSops() {
  const findDraft = jest.fn(async (_id: string) => ({
    frontMatterJson: FRONT_MATTER,
    bodyMarkdown: BODY,
  }));
  const publish = jest.fn(async (_input: unknown) => ({ sopId: _input }));
  const port: ReleaseSopsPort = {
    findDraft,
    publish: (input) => publish(input) as Promise<unknown>,
  };
  return { findDraft, publish, port };
}

function makePolicy(): ReleasePolicyPort {
  return { currentFingerprint: jest.fn(() => FP) };
}

function harness(
  options: {
    context?: Row | null;
    withFindById?: boolean;
    args?: ReleaseApprovalArgs;
    approvalFingerprint?: string | null;
    approvalStatus?: string;
  } = {},
) {
  const args = options.args ?? makeArgs();
  const approvalKey = approvalKeyFor(SESSION_ID, args);
  const approvals = makeApprovals([
    {
      approvalKey,
      sessionId: SESSION_ID,
      toolName: RELEASE_TOOL_NAME,
      status: options.approvalStatus ?? "granted",
      scope: "once",
      policyFingerprint:
        options.approvalFingerprint === undefined
          ? FP
          : options.approvalFingerprint,
      argsDigest: computeApprovalArgsDigest(args),
      preview: null,
      reason: "test",
    },
  ]);
  const context = options.context === undefined ? { ...args } : options.context;
  const sessions = makeSessions(context, options.withFindById !== false);
  const sops = makeSops();
  const policy = makePolicy();
  const svc = new ReleaseApprovalService(
    approvals.port,
    sessions.port,
    sops.port,
    policy,
  );
  return { args, approvalKey, approvals, sessions, sops, policy, svc };
}

describe("ReleaseApprovalService · releaseByApprovalKey 持久化恢复", () => {
  it("① 新实例 Map 为空：审批单 + contextJson 重建 args，digest 对账通过才发布", async () => {
    const { approvalKey, approvals, sessions, sops, policy, svc, args } =
      harness();

    // 传 null 走原语义：回落到当前策略指纹，而不是审批单上的指纹
    const out = await svc.releaseByApprovalKey(approvalKey, null);

    expect(out).toEqual({ published: true });
    expect(approvals.port.findByKey).toHaveBeenCalledWith(approvalKey);
    expect(sessions.findById).toHaveBeenCalledWith(SESSION_ID);
    expect(policy.currentFingerprint).toHaveBeenCalledTimes(1);
    expect(approvals.port.consume).toHaveBeenCalledWith(approvalKey, FP);
    expect(approvals.rows[0].status).toBe("consumed");
    expect(sops.publish).toHaveBeenCalledTimes(1);
    expect(sops.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        sopId: args.sopId,
        publishedBy: RELEASE_PUBLISHED_BY,
      }),
    );
  });

  it("② context 被篡改（cardHash 不同）：digest 不匹配 ⇒ fail-closed，publish 零调用", async () => {
    const tamperedArgs = makeArgs({ cardHash: "deadbeefdeadbeef" });
    const { approvalKey, approvals, sops, svc } = harness({
      context: { ...tamperedArgs },
    });

    const out = await svc.releaseByApprovalKey(approvalKey, FP);

    expect(out).toEqual({ published: false, reason: "dependency_unavailable" });
    expect(approvals.port.consume).not.toHaveBeenCalled();
    expect(sops.findDraft).not.toHaveBeenCalled();
    expect(sops.publish).not.toHaveBeenCalled();
    expect(approvals.rows[0].status).toBe("granted");
  });

  it("③ 缺 findById 端口：fail-closed，不发布", async () => {
    const { approvalKey, sessions, sops, svc } = harness({
      withFindById: false,
    });

    const out = await svc.releaseByApprovalKey(approvalKey, FP);

    expect(out).toEqual({ published: false, reason: "dependency_unavailable" });
    expect(sessions.findById).not.toHaveBeenCalled();
    expect(sops.publish).not.toHaveBeenCalled();
  });

  it("④ 内存 Map 命中：requestRelease 后同实例直接发布，落库 digest 与 args 一致", async () => {
    const approvals = makeApprovals();
    const sessions = makeSessions(null);
    const sops = makeSops();
    const svc = new ReleaseApprovalService(
      approvals.port,
      sessions.port,
      sops.port,
      makePolicy(),
    );

    const requested = await svc.requestRelease(REQUEST_WITH_BUMP);
    const expectedArgs = makeArgs({ bump: "minor" });

    // bump 必须进 context，否则重启后重建出的 digest 与落库值不符
    expect(
      (sessions.port.create as jest.Mock).mock.calls[0][0].context,
    ).toEqual(expectedArgs);
    expect(approvals.rows[0].argsDigest).toBe(
      computeApprovalArgsDigest(expectedArgs),
    );

    // 模拟主管已批准：consume 的条件写只吃 granted + once + 当前指纹。
    approvals.rows[0].status = "granted";
    const out = await svc.releaseByApprovalKey(requested.approvalKey, FP);

    expect(out).toEqual({ published: true });
    expect(approvals.port.findByKey).not.toHaveBeenCalled();
    expect(sessions.findById).not.toHaveBeenCalled();
    expect(sops.publish).toHaveBeenCalledTimes(1);
  });

  it("恢复路径仍以当前策略指纹为准：显式传入变更指纹 ⇒ consume 不命中，publish 零调用", async () => {
    const { approvalKey, sops, svc } = harness();

    const out = await svc.releaseByApprovalKey(approvalKey, OTHER_FP);

    expect(out).toEqual({ published: false, reason: "approval_not_consumed" });
    expect(sops.publish).not.toHaveBeenCalled();
  });

  it("context 缺必需字段：fail-closed", async () => {
    const { approvalKey, sops, svc } = harness({
      context: { sopId: BASE_ARGS.sopId, cardHash: BASE_ARGS.cardHash },
    });

    const out = await svc.releaseByApprovalKey(approvalKey, FP);

    expect(out).toEqual({ published: false, reason: "dependency_unavailable" });
    expect(sops.publish).not.toHaveBeenCalled();
  });
});
