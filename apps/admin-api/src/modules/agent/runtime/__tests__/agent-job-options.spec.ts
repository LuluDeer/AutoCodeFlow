import type { JobsOptions } from "bullmq";

import {
  approvalWakeupDeduplicationId,
  approvalWakeupJobOptions,
  autoResumeJobId,
  autoResumeJobOptions,
  manualResumeJobOptions,
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
  it("人工与审批共用当前进度去重键；跨步数不相撞，不与旧 retained jobId 相撞", () => {
    const first = manualResumeJobOptions("s-1", 0);
    expect(first.jobId).toBeUndefined();
    expect(first.deduplication).toEqual({ id: "resume-s-1-0" });
    expect(first.deduplication).toEqual(
      manualResumeJobOptions("s-1", 0).deduplication,
    );
    expect(first.deduplication).not.toEqual(
      manualResumeJobOptions("s-1", 1).deduplication,
    );
    expect(first.deduplication).not.toEqual(
      manualResumeJobOptions("s-2", 0).deduplication,
    );
  });
  describe("R215 · 升级前人工/审批 job 的兼容探针", () => {
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

  /**
   * R323：补偿 job（reason=resume:approval）换独立 dedup 命名空间，让两来源并存。
   * 核心反证是 ③——钉死补偿键与手动 resume 键永不撞；两来源双跑由 markRunning CAS
   * 兜底，不靠 dedup 吞并。此组为纯函数级断言，不含 Redis。
   */
  describe("R323 · 审批补偿 job 的独立 dedup 命名空间", () => {
    it("① dedup id 精确 = resume-wakeup-s-1-3，无冒号、过 BullMQ 校验，跨 session/steps 不撞", () => {
      const id = approvalWakeupDeduplicationId("s-1", 3);
      expect(id).toBe("resume-wakeup-s-1-3");
      expect(id).not.toContain(":");
      expect(bullmqRejects(id)).toBe(false);
      // 跨 session / 跨 steps 均不相撞。
      expect(approvalWakeupDeduplicationId("s-2", 3)).not.toBe(id);
      expect(approvalWakeupDeduplicationId("s-1", 4)).not.toBe(id);
    });

    it("② opts 结构精确：attempts/removeOnComplete/deduplication.id，且无 keepLastIfActive", () => {
      const opts = approvalWakeupJobOptions("s-1", 3);
      expect(opts).toEqual({
        attempts: 1,
        removeOnComplete: true,
        deduplication: { id: "resume-wakeup-s-1-3" },
      });
      // 两来源天然并存，双跑由 CAS 兜底，无需靠 keepLastIfActive 吞并。
      expect(opts.deduplication).not.toHaveProperty("keepLastIfActive");
    });

    it("③ 与手动 resume 的 dedup id **不同**（本切片核心反证：两来源不撞键）", () => {
      const wakeupId = approvalWakeupJobOptions("s-1", 3).deduplication?.id;
      const manualId = manualResumeJobOptions("s-1", 3).deduplication?.id;
      expect(manualId).toBe("resume-s-1-3");
      expect(wakeupId).toBe("resume-wakeup-s-1-3");
      expect(wakeupId).not.toBe(manualId);
      // 跨多组 session/steps 都不撞，防止只在某些入参下碰巧分键。
      for (const [sid, steps] of [
        ["s-1", 0],
        ["s-2", 3],
        ["3f2b9c1e", 9],
      ] as const) {
        expect(approvalWakeupJobOptions(sid, steps).deduplication?.id).not.toBe(
          manualResumeJobOptions(sid, steps).deduplication?.id,
        );
      }
    });

    it("④ 确定性：同入参同 dedup id，重复 probe 幂等仍成立", () => {
      // 补偿 probe 可被 markWaiting 尾钩多次触发；纯函数下重复调用恒得同一 dedup id，
      // 这是 BullMQ 去重（同键重复 add 为 no-op / 幂等）成立的前提。
      const first = approvalWakeupJobOptions("s-1", 3);
      for (let i = 0; i < 5; i += 1) {
        expect(approvalWakeupDeduplicationId("s-1", 3)).toBe(
          approvalWakeupDeduplicationId("s-1", 3),
        );
        expect(approvalWakeupJobOptions("s-1", 3)).toEqual(first);
      }
      expect(first.deduplication?.id).toBe("resume-wakeup-s-1-3");
    });
  });
});
