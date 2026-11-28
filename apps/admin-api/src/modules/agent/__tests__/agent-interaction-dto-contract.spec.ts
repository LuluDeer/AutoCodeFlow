/**
 * AgentMessageResponseDto 与 SendMessageResult 的最小契约测试。
 *
 * 只验证后端 DTO/controller 的形状对齐：stream 侧新增的第三值
 * `rejected_terminal` 与可选 `reason` 必须能原样穿过 HTTP 边界，
 * 否则 controller 的 `Promise<AgentMessageResponseDto>` 静态类型与
 * 实际返回值不一致（typecheck 红），前端也拿不到拒绝原因。
 *
 * 验证级别：单测 / 内存替身；不连 PG/Redis，不启 Nest。
 */
import { AgentController } from "../agent.controller";
import { AgentInteractionController } from "../agent-interaction.controller";
import {
  AgentApprovalDecisionResponseDto,
  type AgentMessageResponseDto,
} from "../dto/agent-interaction.dto";

type Any = Record<string, any>;
const SID = "33333333-3333-4333-8333-333333333333";

const rejected: AgentMessageResponseDto = {
  sessionId: SID,
  status: "succeeded",
  stepSeq: 9,
  action: "rejected_terminal",
  reason: "会话已处于终态（succeeded），消息未写入、不触发续跑",
};

describe("AgentMessageResponseDto 三值 action + 可选 reason", () => {
  it("rejected_terminal 形状满足 DTO（含 reason）", () => {
    expect(rejected.action).toBe("rejected_terminal");
    expect(typeof rejected.reason).toBe("string");
    expect(rejected.reason!.length).toBeGreaterThan(0);
  });

  it("steered / enqueued 仍可在不带 reason 时满足 DTO", () => {
    const steered: AgentMessageResponseDto = {
      sessionId: SID,
      status: "running",
      stepSeq: 10,
      action: "steered",
    };
    const enqueued: AgentMessageResponseDto = {
      sessionId: SID,
      status: "pending",
      stepSeq: 11,
      action: "enqueued",
    };
    expect(steered.reason).toBeUndefined();
    expect(enqueued.reason).toBeUndefined();
  });

  it("postMessage 原样透出 stream 的 action/reason，不改形", async () => {
    const sendMessageAndResume = jest.fn(async () => rejected);
    const ctl = new AgentInteractionController({
      sendMessageAndResume,
    } as never);

    const out = await ctl.postMessage(SID, { content: "补充一个目标" }, {
      username: "admin",
    } as never);

    expect(out).toEqual(rejected);
    expect(out.action).toBe("rejected_terminal");
    expect(out.reason).toBe(rejected.reason);
    expect(sendMessageAndResume).toHaveBeenCalledWith(SID, {
      content: "补充一个目标",
      mode: undefined,
      actor: "admin",
    });
  });
});

describe("审批处置响应 DTO 的 resumeReason", () => {
  it("AgentApprovalDecisionResponseDto 保留 phrase 三字段并允许 resumeReason", () => {
    const out: AgentApprovalDecisionResponseDto = {
      ok: true,
      approval: null,
      resumed: false,
      resumeReason: "仍有未处置的审批单，未自动恢复",
    };
    expect(out.ok).toBe(true);
    expect(out.resumed).toBe(false);
    expect(out.resumeReason).toBeDefined();
  });

  it("controller deny 响应原样带出 resumeReason（与 DTO 声明一致）", async () => {
    const session: Any = { id: SID, status: "waiting_input", createdBy: null };
    const ctl = Object.create(AgentController.prototype) as Any;
    ctl.sessions = {
      requireById: jest.fn(async () => session),
      findById: jest.fn(async () => session),
      settleToolCallByApprovalId: jest.fn(async () => 0),
      listToolCalls: jest.fn(async () => []),
    };
    ctl.approvals = {
      findByKey: jest.fn(async () => ({
        sessionId: SID,
        toolName: "update_task",
      })),
      decide: jest.fn(async () => ({
        approvalKey: "k1",
        status: "denied",
        decidedBy: "admin",
        decidedAt: new Date(),
        toolName: "update_task",
      })),
      hasPendingForSession: jest.fn(async () => {
        throw new Error("approval read down");
      }),
    };
    ctl.queue = { add: jest.fn(async () => ({})) };
    ctl.moduleRef = null;
    ctl.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };

    const out: AgentApprovalDecisionResponseDto = await ctl.decideApproval(
      SID,
      "k1",
      "denied",
      { username: "admin" } as Any,
    );

    expect(out.resumed).toBe(false);
    expect(out.resumeReason).toContain("approval read down");
  });
});
