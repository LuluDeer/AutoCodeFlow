/**
 * 审批 expired 的**事件投影**分支 + 三处镜像的漂移闸。
 *
 * `expired` 不是人工决定（`ApprovalDecidedStatus` 只有 granted/denied/consumed），
 * 所以事件流里永远没有 `approval_decided(expired)`。它只能由调用方从
 * `agent_approvals.status`（`ApprovalStatusLookup.statuses`）经
 * `ProjectionSnapshot.approvalStatuses` 带入。这里钉住三件事：
 *   ① expired 在投影侧显式说「已过期 / 重新发起」，不再承诺「批准后会恢复」，
 *      也不误说「已执行」；
 *   ② granted/denied/consumed 仍只认 `approval_decided` 事件——快照里即使
 *      塞了状态也不给快照作证；待审批兜底文案保持原样；
 *   ③ runtime 快照 / 事件投影 / 两个审计脚本四处文案逐字同在，任一被漂白，
 *      守卫必须报缺（真红，不是恒绿摆设）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  projectSession,
  type ProjectionEvent,
  type ProjectionSnapshot,
} from "../agent-event-projection";

const ROOT = join(__dirname, "../../../../../../..");

const EXPIRED_TEXT =
  "【审批已过期】审批单 ap-1 已因超时过期，不再接受批准；本次调用未执行。" +
  "请重新发起该操作（会重新申请审批），不要原地重提本调用——重提不会改变过期结论。";

const TOOL_CALLS = [
  {
    id: "c1",
    type: "function" as const,
    function: { name: "stop_task", arguments: '{"id":"t-1"}' },
  },
];

/** 一份「一次写操作挂在审批上」的最小世界：没有决定事件，也没有 body 正文。 */
function pendingWorld(): {
  events: ProjectionEvent[];
  snapshot: ProjectionSnapshot;
} {
  const events: ProjectionEvent[] = [
    {
      seq: 1,
      kind: "step_appended",
      payload: {
        stepId: "s1",
        role: "assistant",
        folded: false,
        toolCallCount: 1,
      },
      causedBySeq: null,
    },
    {
      seq: 2,
      kind: "tool_call_recorded",
      payload: {
        toolCallId: "c1",
        toolName: "stop_task",
        tier: "write",
        status: "awaiting_approval",
        approvalId: "ap-1",
      },
      causedBySeq: null,
    },
  ];
  const snapshot: ProjectionSnapshot = {
    steps: {
      s1: {
        content: null,
        toolCallId: null,
        toolCalls: TOOL_CALLS,
        summary: null,
        rowStatus: "awaiting_approval",
      },
    },
    toolCalls: {
      c1: {
        result: null,
        errorMessage: "该调用需要人工审批",
        resultTruncated: false,
        rowStatus: "awaiting_approval",
      },
    },
  };
  return { events, snapshot };
}

function withDecision(
  world: ReturnType<typeof pendingWorld>,
  status: string,
  decidedBy: string | null = "alice",
): ProjectionEvent[] {
  return [
    ...world.events,
    {
      seq: 3,
      kind: "approval_decided",
      payload: {
        approvalKey: "ap-1",
        status,
        decidedBy,
        decidedAt: "2026-11-02T02:00:00.000Z",
      },
      causedBySeq: null,
    },
  ];
}

function toolText(
  events: ProjectionEvent[],
  snapshot: ProjectionSnapshot,
): string {
  const projected = projectSession(events, snapshot);
  return String(
    projected.messages.find((m) => m.role === "tool")?.content ?? "",
  );
}

describe("expired 审批的事件投影", () => {
  it("approvalStatuses=expired ⇒ 逐字说出「已过期 / 重新发起」，不承诺恢复也不说已执行", () => {
    const world = pendingWorld();
    const text = toolText(world.events, {
      ...world.snapshot,
      approvalStatuses: { "ap-1": { status: "expired", decidedBy: null } },
    });

    expect(text).toBe(EXPIRED_TEXT);
    expect(text).toContain("【审批已过期】");
    expect(text).toContain("重新发起");
    expect(text).not.toContain("批准后会恢复");
    expect(text).not.toContain("【已执行】");
  });

  it("没有 approvalStatuses ⇒ 待审批兜底文案保持原样（存量行为不变）", () => {
    const world = pendingWorld();
    const text = toolText(world.events, world.snapshot);

    expect(text).toContain("【等待人工审批】");
    expect(text).toContain("批准后会恢复");
    expect(text).not.toContain("审批已过期");
  });

  it("快照里的 granted 不能代替事件：没有 approval_decided 仍说「等待人工审批」", () => {
    const world = pendingWorld();
    const text = toolText(world.events, {
      ...world.snapshot,
      approvalStatuses: { "ap-1": { status: "granted", decidedBy: "alice" } },
    });

    expect(text).toContain("【等待人工审批】");
    expect(text).toContain("批准后会恢复");
    expect(text).not.toContain("【已获批准】");
  });

  it.each([
    ["granted", "【已获批准】", "alice"],
    ["denied", "【已被拒绝】", "alice"],
    ["consumed", "【已执行】", ""],
  ] as const)(
    "%s + approval_decided 事件 ⇒ 仍走事件文案（快照塞 expired 也不覆盖）",
    (status, marker, who) => {
      const world = pendingWorld();
      const events = withDecision(world, status, who === "" ? null : who);
      const text = toolText(events, {
        ...world.snapshot,
        approvalStatuses: { "ap-1": { status: "expired", decidedBy: null } },
      });

      expect(text).toContain(marker);
      expect(text).not.toContain("审批已过期");
      expect(text).not.toContain("批准后会恢复");
    },
  );
});

describe("三处镜像 + 本投影的 expired 文案漂移闸", () => {
  const NEEDLE = "【审批已过期】审批单 ";
  const MIRRORS = [
    "apps/admin-api/src/modules/agent/runtime/agent-runtime.service.ts",
    "apps/admin-api/src/modules/agent/runtime/agent-event-projection.ts",
    "scripts/agent-event-projection-audit.mjs",
    "scripts/agent-context-token-audit.mjs",
  ];

  const sources = MIRRORS.map(
    (f) => [f, readFileSync(join(ROOT, f), "utf8")] as const,
  );
  const missing = (list: ReadonlyArray<readonly [string, string]>) =>
    list.filter(([, src]) => !src.includes(NEEDLE)).map(([f]) => f);

  it("四处源码都逐字含有 expired 哨针", () => {
    expect(missing(sources)).toEqual([]);
  });

  it("任一镜像被漂白 ⇒ 守卫报缺（真红，而非恒绿）", () => {
    for (const target of MIRRORS) {
      const bleached = sources.map(
        ([f, src]) =>
          [
            f,
            f === target
              ? src.split(NEEDLE).join("【审批已过期】审批编号 ")
              : src,
          ] as const,
      );
      expect(missing(bleached)).toContain(target);
    }
  });
});
