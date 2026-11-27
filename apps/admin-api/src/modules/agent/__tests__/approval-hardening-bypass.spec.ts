/**
 * 审批旁路加固的定向回归（impl-approval-hardening）。
 *
 * 覆盖三处真实旁路：
 *   ① phrase allow/deny 没有复刻 grant/deny 的决策副作用；
 *   ② phrase 未走四眼判定，创建者可用 allow 自批普通工具；
 *   ③ 过期审批在重建上下文时落「批准后会恢复」的误导兜底文案。
 *
 * 验证级别：**单测 / 内存替身**（假 sessions、假 approvals、假 queue）——
 * 证明分支逻辑与副作用调用成立，不证明真 PG/Redis/队列持久化。
 */
import { UserRole } from "../../users/entities/user.entity";
import { AgentController } from "../agent.controller";
import type { ApprovalPhraseDto } from "../dto/approval-phrase.dto";
import type { AgentApproval } from "../entities/agent-approval.entity";
import {
  isApprovalSelfDecision,
  type ApprovalSelfConfigReader,
} from "../runtime/agent-approval-wakeup.service";
import { computeApprovalPolicyFingerprint } from "../runtime/agent-approvals.service";
import { AgentRuntimeService } from "../runtime/agent-runtime.service";

const SESSION = "11111111-1111-4111-8111-111111111111";
const KEY = `apr-${SESSION}-aaaaaaaaaaaaaaaa`;
const FP = computeApprovalPolicyFingerprint({
  writeRequiresApproval: false,
  dangerousRequiresApproval: true,
  allowDangerous: false,
  executableSourceGate: true,
});

const admin = (username = "bob") =>
  ({ id: 1, username, role: UserRole.ADMIN }) as never;

/** 与 phrase 端点读配置口径一致的默认快照（不含四眼开关）。 */
const DEFAULT_CONFIG: Record<string, unknown> = {
  "agent.policy.writeRequiresApproval": false,
  "agent.policy.dangerousRequiresApproval": true,
  "agent.policy.allowDangerous": false,
  "agent.policy.executableSourceGate": true,
};

interface HarnessOptions {
  createdBy?: string | null;
  status?: string;
  toolName?: string;
  blockSelfApproval?: boolean;
  decidedStatus?: "granted" | "denied";
  toolCallSettled?: number;
  hasPending?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const toolName = options.toolName ?? "update_task";
  const session = {
    id: SESSION,
    status: options.status ?? "waiting_input",
    totalSteps: 3,
    createdBy: options.createdBy ?? null,
  };
  const approval = {
    approvalKey: KEY,
    sessionId: SESSION,
    toolName,
    status: "pending",
    policyFingerprint: FP,
  } as Partial<AgentApproval>;
  const decidedRow = {
    approvalKey: KEY,
    status: options.decidedStatus ?? "granted",
    decidedBy: "bob",
    decidedAt: new Date("2026-01-01T00:00:00Z"),
  } as Partial<AgentApproval>;
  const settledRow = {
    approvalId: KEY,
    toolCallId: "tc-1",
    toolName,
    tier: "write",
    status: "denied",
    durationMs: 0,
    resultJson: null,
    errorMessage: "已被 bob 人工拒绝",
  };

  const sessions = {
    requireById: jest.fn(async () => session),
    findById: jest.fn(async () => session),
    settleToolCallByApprovalId: jest.fn(
      async () => options.toolCallSettled ?? 1,
    ),
    listToolCalls: jest.fn(async () => [settledRow]),
    findEventSeqByRef: jest.fn(async () => 7),
    tryAppendEvent: jest.fn(async () => 1),
  };
  const approvals = {
    findByKey: jest.fn(async () => approval),
    decideByPhrase: jest.fn(async () => decidedRow),
    hasPendingForSession: jest.fn(async () => options.hasPending ?? false),
  };
  const queue = { add: jest.fn(async () => ({ id: "job-1" })) };
  const config = {
    get: jest.fn((key: string) =>
      key === "agent.policy.blockSelfApproval"
        ? (options.blockSelfApproval ?? false)
        : DEFAULT_CONFIG[key],
    ),
  };
  const ctl = new AgentController(
    sessions as never,
    {} as never,
    approvals as never,
    queue as never,
    config as never,
  );
  return { ctl, sessions, approvals, queue, config, session, approval };
}

const phrase = (value: string): ApprovalPhraseDto => ({ phrase: value });

describe("phrase allow/deny 与 grant/deny 共享决策副作用", () => {
  it("phrase allow：会话挂起且无其它 pending ⇒ 队列出现 resume:approval，响应 resumed=true", async () => {
    const h = harness({ decidedStatus: "granted" });
    const out = await h.ctl.decideApprovalByPhrase(
      SESSION,
      KEY,
      phrase("allow"),
      admin(),
    );

    expect(out.resumed).toBe(true);
    expect(h.queue.add).toHaveBeenCalledWith(
      "run",
      expect.objectContaining({
        sessionId: SESSION,
        reason: "resume:approval",
        expectTotalSteps: 3,
      }),
      expect.anything(),
    );
  });

  it("phrase deny：台账行落 denied、补 tool_call_status_changed，并按当前语义自动恢复", async () => {
    const h = harness({ decidedStatus: "denied" });
    const out = await h.ctl.decideApprovalByPhrase(
      SESSION,
      KEY,
      phrase("deny"),
      admin(),
    );

    // 当前产品语义：deny 与 allow 共用决策副作用——settle 成功后，只要会话
    // 仍在 waiting_input 且无其它 pending 单，就入队 `resume:approval_denied`。
    // 断言从「不恢复」同步为「显式 reason 的恢复」，而不是把整段删掉过绿。
    expect(out.resumed).toBe(true);
    expect(out.resumeReason).toBeUndefined();
    expect(h.queue.add).toHaveBeenCalledWith(
      "run",
      expect.objectContaining({
        sessionId: SESSION,
        reason: "resume:approval_denied",
        expectTotalSteps: 3,
      }),
      expect.anything(),
    );
    expect(h.sessions.settleToolCallByApprovalId).toHaveBeenCalledWith(
      KEY,
      "denied",
      expect.stringContaining("人工拒绝"),
    );
    expect(h.sessions.tryAppendEvent).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        kind: "tool_call_status_changed",
        causedBySeq: 7,
        payload: expect.objectContaining({
          toolCallId: "tc-1",
          status: "denied",
        }),
      }),
    );
  });

  it("phrase deny：条件写命中 0 行 ⇒ 不写状态事件（并发输家不得说「已拒绝」）", async () => {
    const h = harness({ decidedStatus: "denied", toolCallSettled: 0 });
    await h.ctl.decideApprovalByPhrase(SESSION, KEY, phrase("deny"), admin());
    expect(h.sessions.tryAppendEvent).not.toHaveBeenCalled();
  });

  it("phrase allow：仍有其它 pending 单 ⇒ 不重复入队", async () => {
    const h = harness({ decidedStatus: "granted", hasPending: true });
    const out = await h.ctl.decideApprovalByPhrase(
      SESSION,
      KEY,
      phrase("allow"),
      admin(),
    );
    expect(out.resumed).toBe(false);
    expect(h.queue.add).not.toHaveBeenCalled();
  });
});

describe("phrase 与 grant 共用四眼判定", () => {
  it("开启 blockSelfApproval：同创建者管理员 phrase allow ⇒ 403，且不触碰 decideByPhrase", async () => {
    const h = harness({
      createdBy: "user:alice",
      blockSelfApproval: true,
      decidedStatus: "granted",
    });
    await expect(
      h.ctl.decideApprovalByPhrase(
        SESSION,
        KEY,
        phrase("allow"),
        admin("alice"),
      ),
    ).rejects.toMatchObject({ errorCode: "AGENT_APPROVAL_SELF_DENIED" });
    expect(h.approvals.decideByPhrase).not.toHaveBeenCalled();
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it("关闭 blockSelfApproval：同创建者管理员 phrase allow 仍可批准", async () => {
    const h = harness({
      createdBy: "user:alice",
      blockSelfApproval: false,
      decidedStatus: "granted",
    });
    const out = await h.ctl.decideApprovalByPhrase(
      SESSION,
      KEY,
      phrase("allow"),
      admin("alice"),
    );
    expect(out.ok).toBe(true);
    expect(h.approvals.decideByPhrase).toHaveBeenCalledTimes(1);
  });

  it("sop_publish：phrase 路径仍被整条禁用（强制四眼不变）", async () => {
    const h = harness({ toolName: "sop_publish" });
    await expect(
      h.ctl.decideApprovalByPhrase(SESSION, KEY, phrase("allow"), admin()),
    ).rejects.toMatchObject({ errorCode: "VALIDATION_FAILED" });
    expect(h.approvals.decideByPhrase).not.toHaveBeenCalled();
  });

  it("纯函数判定：创建者不一致 / NULL 不拦；开关注人 + 同人拦；sop_publish 无论开关都拦", () => {
    const configOn: ApprovalSelfConfigReader = {
      get<T = unknown>(_key: string): T | undefined {
        return true as T;
      },
    };
    const configOff: ApprovalSelfConfigReader = {
      get<T = unknown>(_key: string): T | undefined {
        return false as T;
      },
    };
    const base = { username: "alice", toolName: "update_task" };
    expect(
      isApprovalSelfDecision({
        ...base,
        createdBy: "user:bob",
        config: configOn,
      }),
    ).toBe(false);
    expect(
      isApprovalSelfDecision({ ...base, createdBy: null, config: configOn }),
    ).toBe(false);
    expect(
      isApprovalSelfDecision({
        ...base,
        createdBy: "user:alice",
        config: configOn,
      }),
    ).toBe(true);
    expect(
      isApprovalSelfDecision({
        ...base,
        createdBy: "user:alice",
        config: configOff,
      }),
    ).toBe(false);
    expect(
      isApprovalSelfDecision({
        ...base,
        toolName: "sop_publish",
        createdBy: "user:alice",
        config: configOff,
      }),
    ).toBe(true);
  });
});

describe("重建上下文中的 expired 审批文案", () => {
  const replay = (approvalStatus: string): string =>
    (
      AgentRuntimeService.prototype as unknown as {
        replayedToolResult: (
          row: unknown,
          approvals: Map<string, { status: string; decidedBy: string | null }>,
        ) => string;
      }
    ).replayedToolResult(
      {
        status: "awaiting_approval",
        approvalId: KEY,
        errorMessage: "需要人工审批",
      },
      new Map([[KEY, { status: approvalStatus, decidedBy: null }]]),
    );

  it("expired：明确「审批已过期 / 需重新发起」，不再承诺「批准后会恢复」", () => {
    const text = replay("expired");
    expect(text).toContain("【审批已过期】");
    expect(text).toContain(KEY);
    expect(text).toContain("重新发起");
    expect(text).not.toContain("批准后会恢复");
    expect(text).not.toContain("【等待人工审批】");
  });

  it("控制组：仍 pending 的审批保持原等待文案", () => {
    expect(replay("pending")).toContain("批准后会恢复");
  });
});
