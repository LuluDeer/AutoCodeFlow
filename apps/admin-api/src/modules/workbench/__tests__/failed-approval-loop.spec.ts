/**
 * R92 跨角色闭环（单测 / 内存替身级）。
 *
 * 证明两件事，判据是返回值 + 副作用，不是日志文本：
 *   ① commit 的 requestRelease 发起失败 ⇒ 落一条可定位的 approval_request_failed
 *      审计（detail 只有 id/hash/安全枚举，绝无异常原文或 token），draft 不回滚；
 *   ② ADMIN 重新发起端点 ⇒ 真 AgentApprovalsService + 内存 repo 落 1 行 pending，
 *      contentHash 服务端重算比对挡篡改，USER 被 RolesGuard 挡下，重复请求幂等。
 *
 * 真 PG 第 3 级验收由 verify-failed-loop 的 e2e 覆盖；本文件只证明分支逻辑成立。
 */
import { ExecutionContext, RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";

import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { ErrorCode } from "../../../common/errors/error-codes";
import { RolesGuard } from "../../../common/guards/roles.guard";
import type { AuthUser } from "../../../common/interfaces/auth-user.interface";
import { AgentApprovalsService } from "../../agent/runtime/agent-approvals.service";
import type { AuditService } from "../../audit/audit.service";
import { sopContentHash, type SopFrontMatter } from "../../sop/sop-frontmatter";
import { UserRole } from "../../users/entities/user.entity";
import { buildPreview, computePolicyGeneration } from "../preview-validator";
import {
  APPROVAL_REQUEST_FAILED_ACTION,
  APPROVAL_REQUEST_RETRY_HINT,
  classifyApprovalRequestFailure,
  WorkbenchController,
} from "../workbench.controller";
import {
  APPROVAL_REQUEST_RETRIED_ACTION,
  ReleaseRetryController,
  type RequestReleaseRetryDto,
} from "../release-retry.controller";
import {
  RELEASE_TOOL_NAME,
  ReleaseApprovalService,
  type ReleaseApprovalsPort,
  type ReleasePolicyPort,
  type ReleaseSessionsPort,
  type ReleaseSopsPort,
} from "../release-approval.service";

const FP = "fp-r92";
const CARD_HASH = "0123456789abcdef";
const FRONT_MATTER = {
  acceptance: [{ kind: "platform", check: "task_status", expect: "success" }],
} as unknown as SopFrontMatter;
const BODY = "## R92\n正文：审批发起失败后的重试闭环";
const CONTENT_HASH = sopContentHash(FRONT_MATTER, BODY);

const ADMIN: AuthUser = {
  id: 1,
  username: "supervisor",
  email: "supervisor@example.com",
  role: UserRole.ADMIN,
  isActive: true,
};
const USER: AuthUser = {
  ...ADMIN,
  id: 2,
  username: "alice",
  role: UserRole.USER,
};

const base = { goal: "R92 闭环验证方案", cadence: "daily" as const };
const COMMIT_INPUT = {
  ...base,
  expectedCardHash: buildPreview(base).cardHash,
  expectedPolicyGeneration: computePolicyGeneration(),
};

function makeCommitHarness(requestRelease: jest.Mock) {
  const draft = jest.fn(async (input: any) => ({ id: "sop-r92", ...input }));
  const auditLog = jest.fn(async (_p: unknown): Promise<void> => {});
  const moduleRef = { get: jest.fn(() => ({ log: auditLog })) };
  // 构造函数 8 参：sops, activation, generation, quotaGate, rewindRunner,
  // partProjection, releaseApproval, moduleRef。
  const controller = new WorkbenchController(
    { draft } as any,
    null,
    null,
    null,
    null,
    null,
    { requestRelease } as any,
    moduleRef as any,
  );
  return { controller, draft, auditLog, moduleRef };
}

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
    update: jest.fn(async () => ({ affected: 0 })),
  };
  const real = new AgentApprovalsService(repo as never);
  const port: ReleaseApprovalsPort = {
    buildKey: (sid, tool, args) => real.buildKey(sid, tool, args),
    request: (input) => real.request(input),
    consume: (key, fp) => real.consume(key, fp),
  };
  return { rows, repo, port };
}

function makeRetryHarness(
  options: { fm?: unknown; body?: string | null } = {},
) {
  const approvals = makeApprovals();
  const sessions: Row[] = [];
  const sessionsPort: ReleaseSessionsPort = {
    create: jest.fn(async (input) => {
      const row = { id: `s-${sessions.length + 1}`, ...input };
      sessions.push(row);
      return { id: String(row.id) };
    }),
    findReviewSession: jest.fn(async (key) => {
      const hit = sessions.find(
        (r) =>
          r.createdBy === key.createdBy &&
          r.context?.sopId === key.sopId &&
          r.context?.cardHash === key.cardHash &&
          r.context?.contentHash === key.contentHash,
      );
      return hit ? { id: String(hit.id) } : null;
    }),
  };
  const sopsPort: ReleaseSopsPort = {
    findDraft: jest.fn(async () => ({
      frontMatterJson: (options.fm === undefined
        ? FRONT_MATTER
        : options.fm) as Record<string, unknown> | null,
      bodyMarkdown: options.body === undefined ? BODY : options.body,
    })),
    publish: jest.fn(async () => ({})) as ReleaseSopsPort["publish"],
  };
  const policy: ReleasePolicyPort = { currentFingerprint: () => FP };
  const release = new ReleaseApprovalService(
    approvals.port,
    sessionsPort,
    sopsPort,
    policy,
  );
  const auditLog = jest.fn(async (_p: unknown): Promise<void> => {});
  const controller = new ReleaseRetryController(
    release,
    { log: auditLog } as unknown as AuditService,
    sopsPort,
  );
  return { controller, approvals, sessionsPort, sopsPort, auditLog };
}

const validBody = (): RequestReleaseRetryDto => ({
  sopId: "sop-r92",
  cardHash: CARD_HASH,
  contentHash: CONTENT_HASH,
});

const guardContext = (user: AuthUser): ExecutionContext =>
  ({
    getHandler: () => ReleaseRetryController.prototype.requestReleaseRetry,
    getClass: () => ReleaseRetryController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

describe("R92 — 审批发起失败的可观测与管理员重试", () => {
  it("① requestRelease 抛错 ⇒ 写失败审计（detail 含定位字段、无密钥）+ 回带 failure，draft 不回滚", async () => {
    const requestRelease = jest.fn(async () => {
      throw new Error("boom secret-token-XYZ policy");
    });
    const { controller, draft, auditLog } = makeCommitHarness(requestRelease);

    const result: any = await controller.commit(
      COMMIT_INPUT as any,
      { id: 7, username: "alice" },
      "127.0.0.1",
    );

    expect(result.approvalStatus).toBe("failed");
    expect(result.approvalKey).toBeUndefined();
    expect(result.approvalFailure).toMatchObject({
      sopId: "sop-r92",
      requestedBy: "alice",
      reason: "approval_request_failed",
    });
    expect(draft).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledTimes(1);

    const payload: any = auditLog.mock.calls[0][0];
    expect(payload.action).toBe(APPROVAL_REQUEST_FAILED_ACTION);
    expect(payload.resource).toBe("sop");
    expect(payload.resourceId).toBe("sop-r92");
    expect(payload.result).toBe("failure");
    expect(payload.detail).toMatchObject({
      sopId: "sop-r92",
      cardHash: COMMIT_INPUT.expectedCardHash,
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      requestedBy: "alice",
      reason: "approval_request_failed",
      attempt: "initial",
    });
    expect(payload.detail.retryHint).toBe(APPROVAL_REQUEST_RETRY_HINT);
    // 反证核心：异常原文（含伪 token）绝不进审计 detail。
    expect(JSON.stringify(payload.detail)).not.toContain("secret-token-XYZ");
  });

  it("①b reason 收敛成安全枚举，原文只进日志", () => {
    expect(
      classifyApprovalRequestFailure(
        new Error("策略指纹不可读，发布申请被拒绝"),
      ),
    ).toBe("policy_fingerprint_unavailable");
    expect(
      classifyApprovalRequestFailure(new Error("端口未装配，申请被拒绝")),
    ).toBe("dependency_unavailable");
    expect(classifyApprovalRequestFailure(new Error("secret-token-XYZ"))).toBe(
      "approval_request_failed",
    );
  });

  it("② ADMIN + 合法 body ⇒ 落 1 行 pending 审批单 + approval_request_retried 审计", async () => {
    const h = makeRetryHarness();

    const res = await h.controller.requestReleaseRetry(validBody(), ADMIN);

    expect(res).toEqual({
      approvalKey: expect.stringMatching(/^apr-/),
      sessionId: "s-1",
      retried: true,
    });
    // 断言实际副作用，不是「接口返回成功」。
    expect(h.approvals.rows).toHaveLength(1);
    expect(h.approvals.rows[0]).toMatchObject({
      toolName: RELEASE_TOOL_NAME,
      scope: "once",
      status: "pending",
    });
    expect(h.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: APPROVAL_REQUEST_RETRIED_ACTION,
        resource: "sop",
        resourceId: "sop-r92",
        result: "success",
        detail: expect.objectContaining({
          sopId: "sop-r92",
          cardHash: CARD_HASH,
          contentHash: CONTENT_HASH,
          requestedBy: "supervisor", // 当前 ADMIN，不是原业务人员 alice
          approvalKey: res.approvalKey,
          sessionId: res.sessionId,
          attempt: "request_retry",
        }),
      }),
    );
  });

  it("③ 篡改 contentHash ⇒ VALIDATION_FAILED(400)，零审批单、零 retried 审计", async () => {
    const h = makeRetryHarness();

    await expect(
      h.controller.requestReleaseRetry(
        { ...validBody(), contentHash: "0".repeat(64) },
        ADMIN,
      ),
    ).rejects.toMatchObject({ errorCode: ErrorCode.VALIDATION_FAILED });

    expect(h.approvals.rows).toHaveLength(0);
    expect(h.auditLog).not.toHaveBeenCalled();
  });

  it("④ USER 调新端点 ⇒ 类级 ADMIN 元数据 + RolesGuard 拒绝", () => {
    const handler = ReleaseRetryController.prototype.requestReleaseRetry;
    expect(Reflect.getMetadata(ROLES_KEY, ReleaseRetryController)).toEqual([
      UserRole.ADMIN,
    ]);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      "release-approvals/request",
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );

    const guard = new RolesGuard(new Reflector());
    expect(guard.canActivate(guardContext(USER))).toBe(false);
    expect(guard.canActivate(guardContext(ADMIN))).toBe(true);
  });

  it("⑤ 二次重试幂等：确定性 key + 唯一约束 ⇒ 不产生第二张 pending 单", async () => {
    const h = makeRetryHarness();

    const first = await h.controller.requestReleaseRetry(validBody(), ADMIN);
    const second = await h.controller.requestReleaseRetry(validBody(), ADMIN);

    // 语义：重复发起允许且幂等——requestRelease 的 key 由
    // (createdBy, sopId, cardHash, contentHash, bump) 确定性构造，
    // AgentApprovalsService.request 撞 UQ_agent_approvals_approvalKey 时返回既有单；
    // 只复活 expired，pending/granted/consumed 原样返回，绝不复活已处置的单 ⇒ 不绕过四眼。
    expect(second.approvalKey).toBe(first.approvalKey);
    expect(second.sessionId).toBe(first.sessionId);
    expect(h.approvals.rows).toHaveLength(1);
    expect(h.approvals.rows[0].status).toBe("pending");
    expect(h.auditLog).toHaveBeenCalledTimes(2); // 每次受理都留痕，便于追踪重复点击
  });

  it("⑥ draft 缺失 / front-matter 或 body 为空 ⇒ 400，零审批单", async () => {
    const missing = makeRetryHarness({ fm: null });
    await expect(
      missing.controller.requestReleaseRetry(validBody(), ADMIN),
    ).rejects.toMatchObject({ errorCode: ErrorCode.VALIDATION_FAILED });
    expect(missing.approvals.rows).toHaveLength(0);

    const emptyBody = makeRetryHarness({ body: null });
    await expect(
      emptyBody.controller.requestReleaseRetry(validBody(), ADMIN),
    ).rejects.toMatchObject({ errorCode: ErrorCode.VALIDATION_FAILED });
    expect(emptyBody.approvals.rows).toHaveLength(0);
  });

  it("⑦ bump 原样透传，且不同 bump 是不同审批单（非重复单）", async () => {
    const h = makeRetryHarness();

    const plain = await h.controller.requestReleaseRetry(validBody(), ADMIN);
    const bumped = await h.controller.requestReleaseRetry(
      { ...validBody(), bump: "minor" },
      ADMIN,
    );

    expect(bumped.approvalKey).not.toBe(plain.approvalKey);
    expect(h.approvals.rows).toHaveLength(2);
    expect(h.approvals.rows.map((r) => r.status)).toEqual([
      "pending",
      "pending",
    ]);
  });
});
