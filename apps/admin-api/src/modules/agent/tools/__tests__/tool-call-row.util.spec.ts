/**
 * R99（ADR-031 步骤 4）：**台账行纯构造器**的单测。
 *
 * 这些构造器只算「这一行长什么样」，不写库、不碰审批状态 —— 独立单测证明它们
 * 真的是纯的（同入参 ⇒ 同出参，且**不产生 approvalId 之外的额外键**）。
 *
 * 特别钉住一条**容易漂移**的行为：`deniedRow` 在 `approvalId` 为 `null` 时
 * **不得**写出该键（既有实现用条件展开；若改成恒写 `approvalId: null`，
 * 台账行会多一个「看似有单号」的语义差异）。
 */
import {
  awaitingRow,
  deniedRow,
  tierOf,
  type ToolCallRowIds,
} from "../tool-call-row.util";

const IDS: ToolCallRowIds = {
  sessionId: "s-1",
  stepId: "step-1",
  toolCallId: "call-1",
  toolName: "update_task",
};

describe("R99 · tool-call-row.util（纯构造器）", () => {
  describe("tierOf", () => {
    it("返回注册表里该工具的分级", () => {
      expect(tierOf("update_task")).toBe("write");
    });

    it("工具不在注册表 ⇒ 回落 read（与既有行为逐字一致）", () => {
      expect(tierOf("no_such_tool_xyz")).toBe("read");
    });
  });

  describe("deniedRow", () => {
    it("带 approvalId：行里含单号 + status=denied + 透传 identity/args/tier", () => {
      const row = deniedRow(IDS, "write", { taskId: "t-1" }, "why-msg", "apr-x");
      expect(row).toEqual({
        sessionId: "s-1",
        stepId: "step-1",
        toolCallId: "call-1",
        toolName: "update_task",
        tier: "write",
        args: { taskId: "t-1" },
        status: "denied",
        approvalId: "apr-x",
        errorMessage: "why-msg",
      });
    });

    it("不带 approvalId ⇒ 行里**没有** approvalId 这个键（不是 null）", () => {
      const row = deniedRow(IDS, "read", null, "why-msg");
      expect(row).not.toHaveProperty("approvalId");
      expect(row.status).toBe("denied");
      expect(row.args).toBeNull();
    });

    it("纯函数：同入参两次调用产出等值对象且互不共享引用", () => {
      const a = deniedRow(IDS, "read", { x: 1 }, "m");
      const b = deniedRow(IDS, "read", { x: 1 }, "m");
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
    });
  });

  describe("awaitingRow", () => {
    it("status=awaiting_approval + approvalId 必填", () => {
      const row = awaitingRow(IDS, "write", { a: 1 }, "apr-y", "need approval");
      expect(row).toEqual({
        sessionId: "s-1",
        stepId: "step-1",
        toolCallId: "call-1",
        toolName: "update_task",
        tier: "write",
        args: { a: 1 },
        status: "awaiting_approval",
        approvalId: "apr-y",
        errorMessage: "need approval",
      });
    });

    it("stepId 可为 null（会话级调用无 step）", () => {
      const row = awaitingRow(
        { ...IDS, stepId: null },
        "read",
        null,
        "apr-z",
        "m",
      );
      expect(row.stepId).toBeNull();
    });
  });
});
