/**
 * 四眼原则 P0 回归：workbench 会话以 `user:<数字 id>` 记发起人，
 * 深链 /agent-sessions 的 grant/deny/phrase 必须同样识别为「本人」。
 *
 * 验证级别：单测 / 内存替身（假 sessions、假 approvals、假 queue、假 config）——
 * 证明判定分支与「处置前拦下、零写副作用」成立，不证明真 PG/Redis。
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

type Any = Record<string, any>;
const SESSION = "22222222-2222-4222-8222-222222222222";
const KEY = `apr-${SESSION}-bbbbbbbbbbbbbbbb`;
const FP = computeApprovalPolicyFingerprint({
  writeRequiresApproval: false,
  dangerousRequiresApproval: true,
  allowDangerous: false,
  executableSourceGate: true,
});

const configWith = (block: boolean): ApprovalSelfConfigReader => ({
  get: <T = unknown>(key: string): T | undefined => {
    if (key === "agent.policy.blockSelfApproval") return block as T;
    const defaults: Record<string, unknown> = {
      "agent.policy.writeRequiresApproval": false,
      "agent.policy.dangerousRequiresApproval": true,
      "agent.policy.allowDangerous": false,
      "agent.policy.executableSourceGate": true,
    };
    return defaults[key] as T | undefined;
  },
});

const admin = (id: number, username = "alice") =>
  ({ id, username, role: UserRole.ADMIN }) as Any;

function harness(createdBy: string | null, toolName = "update_task", block = true) {
  const session: Any = {
    id: SESSION,
    status: "waiting_input",
    totalSteps: 3,
    createdBy,
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
    status: "granted",
    decidedBy: "alice",
    decidedAt: new Date("2026-01-01T00:00:00Z"),
  } as Partial<AgentApproval>;

  const sessions = {
    requireById: jest.fn(async () => session),
    findById: jest.fn(async () => session),
    settleToolCallByApprovalId: jest.fn(async () => 0),
    listToolCalls: jest.fn(async () => []),
    findEventSeqByRef: jest.fn(async () => null),
    tryAppendEvent: jest.fn(async () => 1),
  };
  const approvals = {
    findByKey: jest.fn(async () => approval),
    decideByPhrase: jest.fn(async () => decidedRow),
    decide: jest.fn(async () => decidedRow),
    hasPendingForSession: jest.fn(async () => false),
  };
  const queue = { add: jest.fn(async () => ({ id: "job-1" })) };
  const ctl = new AgentController(
    sessions as never,
    {} as never,
    approvals as never,
    queue as never,
    configWith(block) as never,
  );
  return { ctl, sessions, approvals, queue, session, approval };
}

const phrase = (value: string): ApprovalPhraseDto => ({ phrase: value });

describe("isApprovalSelfDecision 同时覆盖 user:<id> 与 user:<username>", () => {
  it("workbench 口径 user:42 + 当前用户 id=42 ⇒ 自批", () => {
    expect(
      isApprovalSelfDecision({
        createdBy: "user:42",
        username: "alice",
        userId: 42,
        toolName: "update_task",
        config: configWith(true),
      }),
    ).toBe(true);
  });

  it("字符串 id 同样识别；不同 id 不误伤他人", () => {
    expect(
      isApprovalSelfDecision({
        createdBy: "user:42",
        username: "alice",
        userId: "42",
        toolName: "update_task",
        config: configWith(true),
      }),
    ).toBe(true);
    expect(
      isApprovalSelfDecision({
        createdBy: "user:42",
        username: "alice",
        userId: 43,
        toolName: "update_task",
        config: configWith(true),
      }),
    ).toBe(false);
  });

  it("旧 user:<username> 口径与 sop_publish 强制四眼不变", () => {
    expect(
      isApprovalSelfDecision({
        createdBy: "user:alice",
        username: "alice",
        userId: 42,
        toolName: "update_task",
        config: configWith(true),
      }),
    ).toBe(true);
    expect(
      isApprovalSelfDecision({
        createdBy: "user:42",
        username: "alice",
        userId: 42,
        toolName: "sop_publish",
        config: configWith(false),
      }),
    ).toBe(true);
  });

  it("createdBy 缺失仍不可判定、不拦", () => {
    expect(
      isApprovalSelfDecision({
        createdBy: null,
        username: "alice",
        userId: 42,
        toolName: "update_task",
        config: configWith(true),
      }),
    ).toBe(false);
  });
});

describe("workbench 建单自批：深链处置路径回归", () => {
  it("phrase allow：同一管理员（id 对上 createdBy）被拦，审批与队列零写入", async () => {
    const h = harness("user:42");

    await expect(
      h.ctl.decideApprovalByPhrase(
        SESSION,
        KEY,
        phrase("allow"),
        admin(42) as never,
      ),
    ).rejects.toMatchObject({ errorCode: "AGENT_APPROVAL_SELF_DENIED" });

    expect(h.approvals.decideByPhrase).not.toHaveBeenCalled();
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it("grant 端点同一判据：数字 id 命中也拦住", async () => {
    const h = harness("user:42");

    await expect(
      h.ctl.grantApproval(SESSION, KEY, admin(42) as never),
    ).rejects.toMatchObject({ errorCode: "AGENT_APPROVAL_SELF_DENIED" });

    expect(h.approvals.decide).not.toHaveBeenCalled();
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it("另一管理员（id 不同）仍可处置，不误伤", async () => {
    const h = harness("user:42");

    const out = await h.ctl.decideApprovalByPhrase(
      SESSION,
      KEY,
      phrase("allow"),
      admin(43, "bob") as never,
    );

    expect(out.resumed).toBe(true);
    expect(h.approvals.decideByPhrase).toHaveBeenCalled();
  });

  it("sop_publish 强制四眼：workbench 数字 id 口径即使关开关也拦", async () => {
    const h = harness("user:42", "sop_publish", false);

    await expect(
      h.ctl.grantApproval(SESSION, KEY, admin(42) as never),
    ).rejects.toMatchObject({ errorCode: "AGENT_APPROVAL_SELF_DENIED" });
    expect(h.approvals.decide).not.toHaveBeenCalled();
  });
});
