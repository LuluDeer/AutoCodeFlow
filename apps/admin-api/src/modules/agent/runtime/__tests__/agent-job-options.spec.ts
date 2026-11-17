import type { JobsOptions } from "bullmq";

import {
  autoResumeJobId,
  autoResumeJobOptions,
  manualResumeJobId,
} from "../agent-job-options";

/**
 * BullMQ 的 jobId 规则（安装版 classes/job.js `validateOptions`）：
 *   · 纯整数拒绝；
 *   · 含 `:` 且不是恰好 3 段 → 抛 "Custom Id cannot contain :"。
 *
 * 这条校验发生在写 Redis **之前**，调用方只 catch 记 warn 就会变成「代码
 * 看起来排了 job、实际永远排不进去」。GAP-3 首版正是用
 * `auto-resume:${sessionId}`（2 段）踩中——必须由单测钉住，而不是靠段数恰好。
 */
function bullmqRejects(jobId: string): boolean {
  if (`${parseInt(jobId, 10)}` === jobId) return true;
  return jobId.includes(":") && jobId.split(":").length !== 3;
}

describe("agent-job-options —— BullMQ job 选项的合法性", () => {
  it("自动续跑 jobId 通过 BullMQ 校验（无冒号，不靠 3 段兼容分支）", () => {
    const id = autoResumeJobId("3f2b9c1e-0000-4000-8000-000000000000");
    expect(bullmqRejects(id)).toBe(false);
    expect(id).not.toContain(":");
    expect(id).toContain("3f2b9c1e-0000-4000-8000-000000000000");
  });

  it("对照：单冒号 id 会被拒绝（防止有人「优化」回旧形态）", () => {
    expect(bullmqRejects("auto-resume:abc")).toBe(true);
  });

  it("延迟/不重试/完成后删除：固定 jobId 不会命中已完成的旧 job（静默 no-op）", () => {
    const opts: JobsOptions = autoResumeJobOptions(60_000);
    expect(opts).toMatchObject({
      delay: 60_000,
      attempts: 1,
      removeOnComplete: true,
    });
  });
  describe("R215 · 人工/审批恢复的 jobId", () => {
    const SID = "3f2b9c1e-0000-4000-8000-000000000000";

    it("① 通过 BullMQ 校验（**无冒号** —— `${id}:resume` 是 2 段，实测会被拒）", () => {
      const id = manualResumeJobId(SID);
      expect(bullmqRejects(id)).toBe(false);
      expect(id).not.toContain(":");
      expect(id).toContain(SID);
    });

    it("② **可枚举且确定**（同一会话恒得同一 id —— 这是积压判据能查到它的前提）", () => {
      // 旧写法 `${id}:resume:${Date.now()}` 每次调用都不同 ⇒ 判据**无法**按 id 查，
      // 只能扫全队列（O(n) 且有上限）⇒ 那正是它被改掉的原因。
      expect(manualResumeJobId(SID)).toBe(manualResumeJobId(SID));
      expect(manualResumeJobId(SID)).toBe(`resume-${SID}`);
    });

    it("③ 与自动续跑的 id **不同**（两者都指向同一会话，但不能撞 id）", () => {
      expect(manualResumeJobId(SID)).not.toBe(autoResumeJobId(SID));
    });

    it("④ 对照：`${id}:resume`（2 段）**会**被拒绝 —— 防止有人「优化」回带冒号的形态", () => {
      expect(bullmqRejects(`${SID}:resume`)).toBe(true);
    });
  });
});
