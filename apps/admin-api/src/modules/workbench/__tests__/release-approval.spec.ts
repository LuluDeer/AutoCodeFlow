import { createHash } from "node:crypto";

import {
  AgentApprovalsService,
  canonicalJson,
} from "../../agent/runtime/agent-approvals.service";
import { sopContentHash, type SopFrontMatter } from "../../sop/sop-frontmatter";
import {
  RELEASE_PUBLISHED_BY,
  RELEASE_TOOL_NAME,
  ReleaseApprovalService,
  type ReleaseApprovalsPort,
  type ReleasePolicyPort,
  type ReleaseSessionsPort,
  type ReleaseSopsPort,
} from "../release-approval.service";

/**
 * ADR-045 编排层单测（内存替身级）。
 * approvals 端口用**真** AgentApprovalsService + 内存 repo 装配，断言 scope=once、
 * 幂等与 consume 条件写都是真语义；sessions/sops/policy 用最小替身断言调用副作用。
 */

const FP = "fp-default-snapshot";
const OTHER_FP = "fp-changed-snapshot";

type Row = Record<string, any>;

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
  };
  return { rows, repo, port };
}

function makeSessions() {
  const rows: Array<{ id: string; createdBy?: string; context?: Row }> = [];
  const port: ReleaseSessionsPort = {
    create: jest.fn(async (input) => {
      const row = { id: `s-${rows.length + 1}`, ...input };
      rows.push(row);
      return row;
    }),
    findReviewSession: jest.fn(async (key) => {
      const hit = rows.find(
        (r) =>
          r.createdBy === key.createdBy &&
          r.context?.sopId === key.sopId &&
          r.context?.cardHash === key.cardHash &&
          r.context?.contentHash === key.contentHash,
      );
      return hit ? { id: hit.id } : null;
    }),
  };
  return { rows, port };
}

const FRONT_MATTER = { title: "发布锚定测试", capabilities: ["http"] };
const BODY = "## 步骤\n1. 读取输入\n2. 产出结果";
const CONTENT_HASH = sopContentHash(
  FRONT_MATTER as unknown as SopFrontMatter,
  BODY,
);

function makeSops(
  frontMatter: Row | null = FRONT_MATTER,
  body: string | null = BODY,
) {
  const draft = { frontMatterJson: frontMatter, bodyMarkdown: body };
  const findDraft = jest.fn(async (_id: string) => draft);
  const publish = jest.fn(async (_input: unknown) => ({ sopId: _input }));
  const port: ReleaseSopsPort = {
    findDraft: (id) => findDraft(id),
    publish: (input) => publish(input) as Promise<unknown>,
  };
  return { draft, findDraft, publish, port };
}

function makePolicy(fingerprint: string | null = FP): ReleasePolicyPort {
  return { currentFingerprint: jest.fn(() => fingerprint) };
}

const REQUEST = {
  sopId: "sop-anchor",
  cardHash: "0123456789abcdef",
  contentHash: CONTENT_HASH,
  username: "alice",
};

function expectedKey(sessionId: string, bump?: "patch" | "minor" | "major") {
  const args = {
    sopId: REQUEST.sopId,
    cardHash: REQUEST.cardHash,
    contentHash: REQUEST.contentHash,
    ...(bump !== undefined ? { bump } : {}),
  };
  const digest = createHash("sha256")
    .update(`${RELEASE_TOOL_NAME}|${canonicalJson(args)}`)
    .digest("hex")
    .slice(0, 16);
  return {
    approvalKey: `apr-${sessionId}-${digest}`,
    digest: createHash("sha256").update(canonicalJson(args)).digest("hex"),
    args,
  };
}

function grantedRow(approvalKey: string, fingerprint = FP): Row {
  return {
    id: "a-1",
    approvalKey,
    sessionId: "s-1",
    toolName: RELEASE_TOOL_NAME,
    status: "granted",
    scope: "once",
    policyFingerprint: fingerprint,
    argsDigest: "x",
    preview: null,
    reason: "test",
  };
}

describe("ReleaseApprovalService · requestRelease（建单）", () => {
  it("toolName/argsDigest/session.createdBy/scope=once 全部落对，request 只调一次", async () => {
    const approvals = makeApprovals();
    const sessions = makeSessions();
    const policy = makePolicy();
    const svc = new ReleaseApprovalService(
      approvals.port,
      sessions.port,
      makeSops().port,
      policy,
    );

    const out = await svc.requestRelease(REQUEST);

    expect(sessions.port.create).toHaveBeenCalledTimes(1);
    expect(sessions.port.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "sop_review",
        createdBy: "user:alice",
        scope: { sops: [REQUEST.sopId] },
        context: expect.objectContaining({ sopId: REQUEST.sopId }),
      }),
    );
    expect(approvals.port.request).toHaveBeenCalledTimes(1);
    const call = (approvals.port.request as jest.Mock).mock.calls[0][0];
    const exp = expectedKey(out.sessionId);
    expect(out.approvalKey).toBe(exp.approvalKey);
    expect(call.approvalKey).toBe(exp.approvalKey);
    expect(call.sessionId).toBe(out.sessionId);
    expect(call.toolName).toBe(RELEASE_TOOL_NAME);
    expect(call.argsDigest).toBe(exp.digest);
    expect(call.policyFingerprint).toBe(FP);
    expect(typeof call.preview).toBe("string");
    expect(Buffer.byteLength(call.preview, "utf8")).toBeLessThanOrEqual(2048);
    expect(call.reason).toContain("方案卡发布四眼审批");
    // scope=once / status=pending 由真 request 硬写，断言落库副作用而不是入参
    expect(approvals.rows[0]).toMatchObject({
      approvalKey: exp.approvalKey,
      toolName: RELEASE_TOOL_NAME,
      scope: "once",
      status: "pending",
    });
  });

  it("重复申请：命中同一 approvalKey，request 幂等只落一张单", async () => {
    const approvals = makeApprovals();
    const sessions = makeSessions();
    const svc = new ReleaseApprovalService(
      approvals.port,
      sessions.port,
      makeSops().port,
      makePolicy(),
    );

    const a = await svc.requestRelease(REQUEST);
    const b = await svc.requestRelease(REQUEST);

    expect(b.approvalKey).toBe(a.approvalKey);
    expect(b.sessionId).toBe(a.sessionId);
    expect(sessions.port.create).toHaveBeenCalledTimes(1);
    expect(sessions.port.findReviewSession).toHaveBeenCalledTimes(1);
    expect(approvals.rows).toHaveLength(1);
    expect(approvals.repo.save).toHaveBeenCalledTimes(2);
  });

  it("端口缺席：requestRelease 抛错，不建单", async () => {
    const svc = new ReleaseApprovalService(null, null, null, null);
    await expect(svc.requestRelease(REQUEST)).rejects.toThrow(/端口未装配/);
  });
});

describe("ReleaseApprovalService · releaseIfApproved（消耗发布）", () => {
  function harness(
    options: {
      status?: "granted" | "pending";
      fingerprint?: string;
      frontMatter?: Row | null;
      body?: string | null;
    } = {},
  ) {
    const key = "apr-s-1-grantedtest000";
    const approvals = makeApprovals([
      grantedRow(key, options.fingerprint ?? FP),
    ]);
    if (options.status === "pending") approvals.rows[0].status = "pending";
    const sops = makeSops(options.frontMatter, options.body);
    const svc = new ReleaseApprovalService(
      approvals.port,
      makeSessions().port,
      sops.port,
      makePolicy(),
    );
    return { key, approvals, sops, svc };
  }

  const baseInput = (key: string, fp = FP, hash = CONTENT_HASH) => ({
    approvalKey: key,
    sopId: REQUEST.sopId,
    expectedContentHash: hash,
    currentPolicyFingerprint: fp,
  });

  it("consume 成功才 publish，publishedBy=系统身份且 audit 记系统 actor", async () => {
    const { key, approvals, sops, svc } = harness();
    const out = await svc.releaseIfApproved(baseInput(key));

    expect(out).toEqual({ published: true });
    expect(approvals.port.consume).toHaveBeenCalledTimes(1);
    expect(sops.publish).toHaveBeenCalledTimes(1);
    expect(sops.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        sopId: REQUEST.sopId,
        publishedBy: RELEASE_PUBLISHED_BY,
      }),
    );
    expect((sops.publish as jest.Mock).mock.calls[0][0].audit).toEqual({
      userId: null,
      username: RELEASE_PUBLISHED_BY,
      ip: null,
    });
    expect(approvals.rows[0].status).toBe("consumed");
  });

  it("指纹变更：consume 命中 0 → publish 零调用", async () => {
    const { key, approvals, sops, svc } = harness();
    const out = await svc.releaseIfApproved(baseInput(key, OTHER_FP));

    expect(out.published).toBe(false);
    expect(out.reason).toBe("approval_not_consumed");
    expect(approvals.port.consume).toHaveBeenCalledTimes(1);
    expect(sops.publish).not.toHaveBeenCalled();
    expect(approvals.rows[0].status).toBe("granted");
  });

  it("contentHash 不匹配：publish/consume 零调用，reason=content_changed", async () => {
    const { key, approvals, sops, svc } = harness();
    const out = await svc.releaseIfApproved(
      baseInput(key, FP, "deadbeefdeadbeef"),
    );

    expect(out).toEqual({ published: false, reason: "content_changed" });
    expect(sops.findDraft).toHaveBeenCalledTimes(1);
    expect(approvals.port.consume).not.toHaveBeenCalled();
    expect(sops.publish).not.toHaveBeenCalled();
  });

  it("非 granted（含自批未处置）：service 只靠 consume 失败挡住，不 publish", async () => {
    const { key, sops, svc } = harness({ status: "pending" });
    const out = await svc.releaseIfApproved(baseInput(key));

    expect(out.published).toBe(false);
    expect(out.reason).toBe("approval_not_consumed");
    expect(sops.publish).not.toHaveBeenCalled();
  });

  it("重复 release：只有第一次 publish（consume 已消费）", async () => {
    const { key, sops, svc } = harness();
    const first = await svc.releaseIfApproved(baseInput(key));
    const second = await svc.releaseIfApproved(baseInput(key));

    expect(first).toEqual({ published: true });
    expect(second.published).toBe(false);
    expect(second.reason).toBe("approval_not_consumed");
    expect(sops.publish).toHaveBeenCalledTimes(1);
  });

  it("draft 内容缺失/读取不到：不 consume 不 publish", async () => {
    const missing = harness({ frontMatter: null });
    const gone = harness({ body: null });
    expect(await missing.svc.releaseIfApproved(baseInput(missing.key))).toEqual(
      { published: false, reason: "content_changed" },
    );
    expect(await gone.svc.releaseIfApproved(baseInput(gone.key))).toEqual({
      published: false,
      reason: "content_changed",
    });
    expect(missing.sops.publish).not.toHaveBeenCalled();
    expect(gone.sops.publish).not.toHaveBeenCalled();
  });

  it("指纹入参不可读 / 端口缺席：fail-closed", async () => {
    const { key, sops, svc } = harness();
    expect(
      await svc.releaseIfApproved(baseInput(key, null as unknown as string)),
    ).toEqual({ published: false, reason: "policy_fingerprint_unavailable" });
    expect(sops.publish).not.toHaveBeenCalled();

    const absent = new ReleaseApprovalService(null, null, null, null);
    expect(await absent.releaseIfApproved(baseInput(key))).toEqual({
      published: false,
      reason: "dependency_unavailable",
    });
  });
});
