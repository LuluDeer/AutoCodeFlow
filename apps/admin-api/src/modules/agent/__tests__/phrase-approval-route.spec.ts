import { PATH_METADATA } from "@nestjs/common/constants";

import { AppError } from "../../../common/errors/app-error";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";
import { UserRole } from "../../users/entities/user.entity";
import { AgentController } from "../agent.controller";
import type { ApprovalPhraseDto } from "../dto/approval-phrase.dto";
import type { AgentApproval } from "../entities/agent-approval.entity";
import {
  AgentApprovalsService,
  computeApprovalPolicyFingerprint,
} from "../runtime/agent-approvals.service";

/**
 * N17 一句话审批路由：只验 HTTP 装配层的三件事——
 *   ① decidedBy 取登录用户（请求体自报一律忽略，防冒批）；
 *   ② policyFingerprint 取服务端当前策略快照（请求体自报一律忽略，防旧指纹
 *      绕过策略变更失效）；
 *   ③ ADMIN-only + 归属校验 + 会话/审批单不存在时按既有错误码映射。
 * 审批语义（短语白名单、reset 拒绝、once 条件写）在 runtime spec 里钉，这里
 * 只断言「转发给 service 的四个实参」与「错误没被吞」。
 */

const KEY = "apr-11111111-1111-4111-8111-111111111111-aaaaaaaaaaaaaaaa";
const SESSION = "11111111-1111-4111-8111-111111111111";
const admin = { id: 1, username: "alice", role: UserRole.ADMIN } as never;

const DEFAULT_POLICY = {
  writeRequiresApproval: false,
  dangerousRequiresApproval: true,
  allowDangerous: false,
  executableSourceGate: true,
};
const FP_DEFAULT = computeApprovalPolicyFingerprint(DEFAULT_POLICY);
/** 任一项策略变动都让指纹漂移，用来证明指纹来自服务端而非请求体。 */
const FP_TIGHTENED = computeApprovalPolicyFingerprint({
  ...DEFAULT_POLICY,
  writeRequiresApproval: true,
});

function harness(options: {
  sessionId?: string;
  approval?: Partial<AgentApproval> | null;
  config?: Record<string, unknown>;
  decideByPhrase?: (...args: unknown[]) => Promise<unknown>;
}) {
  const sessions = {
    requireById: jest.fn(async () => ({ id: options.sessionId ?? SESSION })),
  };
  const approvals = {
    findByKey: jest.fn(async () => options.approval ?? null),
    decideByPhrase: jest.fn(
      options.decideByPhrase ?? (async () => ({ status: "granted" })),
    ),
  };
  const config = {
    get: jest.fn((key: string) => options.config?.[key]),
  };
  const ctl = new AgentController(
    sessions as never,
    { resolveBudget: jest.fn() } as never,
    approvals as unknown as AgentApprovalsService,
    { add: jest.fn() } as never,
    config as never,
  );
  return { ctl, approvals, sessions, config };
}

const pending = {
  approvalKey: KEY,
  sessionId: SESSION,
  toolName: "update_task",
  status: "pending",
} as Partial<AgentApproval>;

/** 请求体里带自报身份 / 自报指纹——故意塞满，验证路由一个都不读。 */
function bodyWithSpoof(phrase: string): ApprovalPhraseDto {
  return {
    phrase,
    decidedBy: "attacker",
    decidedAt: "2099-01-01T00:00:00Z",
    policyFingerprint: "0".repeat(64),
    status: "granted",
  } as unknown as ApprovalPhraseDto;
}

describe("N17 · decideApprovalByPhrase 路由装配（ADMIN-only）", () => {
  it("路由是 POST sessions/:id/approvals/:approvalKey/phrase，且带 ADMIN 角色元数据", () => {
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        AgentController.prototype.decideApprovalByPhrase,
      ),
    ).toBe("sessions/:id/approvals/:approvalKey/phrase");
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        AgentController.prototype.decideApprovalByPhrase,
      ),
    ).toEqual([UserRole.ADMIN]);
  });

  it("正常处置：四个实参 = (审批键, 短语, 登录用户名, 服务端默认指纹)", async () => {
    const h = harness({ approval: pending });
    await h.ctl.decideApprovalByPhrase(
      SESSION,
      KEY,
      { phrase: "allow" },
      admin,
    );
    expect(h.approvals.decideByPhrase).toHaveBeenCalledWith(
      KEY,
      "allow",
      "alice",
      FP_DEFAULT,
    );
  });

  it("自报 decidedBy / decidedAt / status 一律忽略：署名仍是登录用户 alice", async () => {
    const h = harness({ approval: pending });
    await h.ctl.decideApprovalByPhrase(
      SESSION,
      KEY,
      bodyWithSpoof("批准"),
      admin,
    );
    expect(h.approvals.decideByPhrase).toHaveBeenCalledWith(
      KEY,
      "批准",
      "alice",
      FP_DEFAULT,
    );
  });

  it("自报 policyFingerprint 一律忽略：传的是服务端当前策略快照", async () => {
    const h = harness({ approval: pending });
    await h.ctl.decideApprovalByPhrase(
      SESSION,
      KEY,
      bodyWithSpoof("allow"),
      admin,
    );
    const [, , , fingerprint] = h.approvals.decideByPhrase.mock.calls[0];
    expect(fingerprint).toBe(FP_DEFAULT);
    expect(fingerprint).not.toBe("0".repeat(64));
  });

  it("策略收紧后指纹随之变化——证明指纹来自 ConfigService 当前值，不是常量", async () => {
    const h = harness({
      approval: pending,
      config: { "agent.policy.writeRequiresApproval": true },
    });
    await h.ctl.decideApprovalByPhrase(
      SESSION,
      KEY,
      bodyWithSpoof("allow"),
      admin,
    );
    expect(h.approvals.decideByPhrase).toHaveBeenCalledWith(
      KEY,
      "allow",
      "alice",
      FP_TIGHTENED,
    );
  });

  it("服务层拒绝（reset / 不可识别短语）原样透传，按 errorCode + 中文 message 断言", async () => {
    const h = harness({
      approval: pending,
      decideByPhrase: async () => {
        throw new AppError("VALIDATION_FAILED", {
          detail: "reset 不对应一次性授权决策",
        });
      },
    });
    await expect(
      h.ctl.decideApprovalByPhrase(SESSION, KEY, { phrase: "reset" }, admin),
    ).rejects.toMatchObject({
      errorCode: "VALIDATION_FAILED",
      // AppError 按 status 把原型挂到 Nest 内置异常上，禁断言 instanceof。
      message: expect.stringContaining("reset"),
    });
  });

  it("审批单不属于 URL 会话 ⇒ 拒绝，且不触碰 service 的处置入口", async () => {
    const h = harness({ approval: { ...pending, sessionId: "other-session" } });
    await expect(
      h.ctl.decideApprovalByPhrase(SESSION, KEY, { phrase: "allow" }, admin),
    ).rejects.toMatchObject({ errorCode: "AGENT_APPROVAL_SESSION_MISMATCH" });
    expect(h.approvals.decideByPhrase).not.toHaveBeenCalled();
  });

  it("审批单不存在 ⇒ 404 语义错误码，不继续调 service", async () => {
    const h = harness({ approval: null });
    await expect(
      h.ctl.decideApprovalByPhrase(SESSION, KEY, { phrase: "allow" }, admin),
    ).rejects.toMatchObject({ errorCode: "AGENT_APPROVAL_NOT_FOUND" });
    expect(h.approvals.decideByPhrase).not.toHaveBeenCalled();
  });

  it("策略快照读取抛错 ⇒ AppError + 中文 detail，不裸抛、不回退旧指纹", async () => {
    const h = harness({
      approval: pending,
      config: Object.defineProperty({}, "agent.policy.allowDangerous", {
        get() {
          throw new Error("config backend down");
        },
      }),
    });
    await expect(
      h.ctl.decideApprovalByPhrase(SESSION, KEY, { phrase: "allow" }, admin),
    ).rejects.toMatchObject({
      errorCode: "VALIDATION_FAILED",
      message: expect.stringContaining("无法读取当前审批策略快照"),
    });
    expect(h.approvals.decideByPhrase).not.toHaveBeenCalled();
  });

  it("成功回执只暴露行快照，不回显请求体自报字段", async () => {
    const h = harness({
      approval: pending,
      decideByPhrase: async () => ({
        approvalKey: KEY,
        status: "granted",
        decidedBy: "alice",
        decidedAt: new Date("2026-01-01T00:00:00Z"),
      }),
    });
    const out = await h.ctl.decideApprovalByPhrase(
      SESSION,
      KEY,
      bodyWithSpoof("allow"),
      admin,
    );
    expect(out).toEqual({
      ok: true,
      approval: {
        approvalKey: KEY,
        status: "granted",
        decidedBy: "alice",
        decidedAt: new Date("2026-01-01T00:00:00Z"),
      },
      // 该夹具的会话快照没有 waiting_input 状态 ⇒ 不触发恢复入队。
      resumed: false,
    });
    expect(JSON.stringify(out)).not.toContain("attacker");
  });
});
