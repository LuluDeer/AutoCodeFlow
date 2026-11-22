import { Logger } from "@nestjs/common";
import { AgentApprovalWakeupService } from "../agent-approval-wakeup.service";
import {
  WAITING_FOR_APPROVAL_PREFIX,
  waitingForApproval,
} from "../agent-approval-waiting";
import { manualResumeDeduplicationId } from "../agent-job-options";

/**
 * 反证记录（2026-11-21）：临时改动 probe 的判定条件 → 跑本 spec → 还原源码
 * （还原后 sha256 与原文件一致）。四条分支均证明有牙：
 *   · 删掉 hasPending 守卫           ⇒ ②（及①）转红，jest exit 1；
 *   · status 判据 waiting_input→running ⇒ ⑤（及①④⑥）转红，exit 1；
 *   · 删掉 granted 守卫              ⇒ ④（及①）转红，exit 1；
 *   · 前缀误改成「等待执行器」        ⇒ ③（及①②④⑥）转红，exit 1。
 */
const SESSION_ID = "s-1";
const APPROVAL_KEY = "apr-s-1-1700000000000";

type SessionStub = {
  id: string;
  status: string;
  waitingFor: string | null;
  totalSteps: number;
};

type HarnessOptions = {
  /** 传 null 模拟 findById 查无此会话；传对象则覆盖默认会话字段。 */
  session?: Partial<SessionStub> | null;
  findByIdError?: Error;
  hasPending?: boolean;
  hasGrant?: boolean;
  addError?: Error;
};

/**
 * 内存替身：queue / approvals / sessions 全部是假对象，不碰 DB / Redis / Nest。
 * 构造参数顺序与真实服务一致（queue, approvals, sessions）。
 */
function harness(options: HarnessOptions = {}) {
  const session: SessionStub = {
    id: SESSION_ID,
    status: "waiting_input",
    waitingFor: waitingForApproval(APPROVAL_KEY),
    totalSteps: 3,
    ...(options.session ?? {}),
  };

  const add = jest.fn(
    async (_name: string, _data: unknown, _opts: unknown): Promise<void> => {
      if (options.addError) throw options.addError;
    },
  );
  const hasPending = jest.fn(
    async (_id: string): Promise<boolean> => options.hasPending ?? false,
  );
  const hasGrant = jest.fn(
    async (_id: string): Promise<boolean> => options.hasGrant ?? true,
  );
  const findById = jest.fn(async (_id: string): Promise<SessionStub | null> => {
    if (options.findByIdError) throw options.findByIdError;
    if (options.session === null) return null;
    return { ...session };
  });
  const warn = jest
    .spyOn(Logger.prototype, "warn")
    .mockImplementation(() => undefined);

  const service = new AgentApprovalWakeupService(
    { add } as never,
    {
      hasPendingForSession: hasPending,
      hasGrantAwaitingResumeForSession: hasGrant,
    } as never,
    { findById } as never,
  );

  return { service, add, hasPending, hasGrant, findById, warn, session };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("AgentApprovalWakeupService.probe · 共享常量契约", () => {
  it("等待审批前缀与构造器是唯一事实源", () => {
    expect(WAITING_FOR_APPROVAL_PREFIX).toBe("等待审批");
    expect(waitingForApproval(APPROVAL_KEY)).toBe(`等待审批 ${APPROVAL_KEY}`);
  });
});

describe("AgentApprovalWakeupService.probe · 判定分支", () => {
  it("① 四条件全满足 → 入队一次，data/opts/dedup id 全部精确", async () => {
    const { service, add, hasPending, hasGrant, findById } = harness();

    await expect(service.probe(SESSION_ID)).resolves.toBeUndefined();

    expect(findById).toHaveBeenCalledWith(SESSION_ID);
    expect(hasPending).toHaveBeenCalledWith(SESSION_ID);
    expect(hasGrant).toHaveBeenCalledWith(SESSION_ID);
    expect(add).toHaveBeenCalledTimes(1);

    const [name, data, opts] = add.mock.calls[0];
    expect(name).toBe("run");
    expect(data).toMatchObject({
      sessionId: SESSION_ID,
      reason: "resume:approval",
      expectTotalSteps: 3,
      expectWaitingFor: `等待审批 ${APPROVAL_KEY}`,
    });

    const jobOpts = opts as {
      attempts: number;
      removeOnComplete: boolean;
      deduplication: { id: string; keepLastIfActive?: boolean };
    };
    expect(jobOpts.attempts).toBe(1);
    expect(jobOpts.removeOnComplete).toBe(true);
    // R323：补偿 job 用独立 dedup 命名空间，不再与手动 resume 抢同一把锁。
    expect(jobOpts.deduplication.id).toBe(`resume-wakeup-${SESSION_ID}-3`);
    // waiting_input 不是 failed ⇒ reopenedFailure=false ⇒ 不开 keepLastIfActive。
    expect(jobOpts.deduplication.keepLastIfActive).toBeUndefined();
  });

  it("② 还有 pending 单 → 不入队，且不再查 granted（hasPending 优先）", async () => {
    const { service, add, hasPending, hasGrant } = harness({
      hasPending: true,
    });

    await service.probe(SESSION_ID);

    expect(hasPending).toHaveBeenCalledTimes(1);
    expect(hasGrant).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it("③ waitingFor 非「等待审批」前缀 → 不入队，且不查审批", async () => {
    const { service, add, hasPending, hasGrant } = harness({
      session: { waitingFor: "等待执行器 asg-123 澄清回复" },
    });

    await service.probe(SESSION_ID);

    expect(hasPending).not.toHaveBeenCalled();
    expect(hasGrant).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it("④ 无 granted 待消费单 → 不入队", async () => {
    const { service, add, hasGrant } = harness({ hasGrant: false });

    await service.probe(SESSION_ID);

    expect(hasGrant).toHaveBeenCalledWith(SESSION_ID);
    expect(add).not.toHaveBeenCalled();
  });

  it("⑤ session 非 waiting_input → 不入队，且不查审批", async () => {
    const { service, add, hasPending, hasGrant } = harness({
      session: { status: "running" },
    });

    await service.probe(SESSION_ID);

    expect(hasPending).not.toHaveBeenCalled();
    expect(hasGrant).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it("⑥ findById 抛错 → 不 throw，只 warn（fail-closed）", async () => {
    const { service, add, hasPending, warn } = harness({
      findByIdError: new Error("db down"),
    });

    await expect(service.probe(SESSION_ID)).resolves.toBeUndefined();

    expect(hasPending).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(`session=${SESSION_ID}`);
    expect(String(warn.mock.calls[0][0])).toContain("db down");
  });

  it("⑥ queue.add 抛错 → 不 throw，只 warn（fail-closed）", async () => {
    const { service, add, warn } = harness({
      addError: new Error("redis down"),
    });

    await expect(service.probe(SESSION_ID)).resolves.toBeUndefined();

    expect(add).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(`session=${SESSION_ID}`);
    expect(String(warn.mock.calls[0][0])).toContain("redis down");
  });

  it("⑦ findById 查无此会话 → 安静返回，不入队", async () => {
    const { service, add, hasPending, hasGrant, warn } = harness({
      session: null,
    });

    await service.probe(SESSION_ID);

    expect(hasPending).not.toHaveBeenCalled();
    expect(hasGrant).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("AgentApprovalWakeupService.probe · 与手动 resume 并存（R323）", () => {
  it("补偿 job 的 dedup id 与手动 resume 不同——两来源可并存", async () => {
    const { service, add } = harness();

    await service.probe(SESSION_ID);

    expect(add).toHaveBeenCalledTimes(1);
    const opts = add.mock.calls[0][2] as {
      deduplication: { id: string; keepLastIfActive?: boolean };
    };
    const wakeupId = opts.deduplication.id;
    const manualId = manualResumeDeduplicationId(SESSION_ID, 3);

    // 显式钉住两个命名空间的字面值，避免某天两边一起漂移仍"相等"。
    expect(wakeupId).toBe(`resume-wakeup-${SESSION_ID}-3`);
    expect(manualId).toBe(`resume-${SESSION_ID}-3`);
    // 并存前提：dedup id 不同 ⇒ 手动 resume 不会被补偿 job 吞掉。
    expect(wakeupId).not.toBe(manualId);
    // 补偿 job 无 failed→pending 重开语义。
    expect(opts.deduplication.keepLastIfActive).toBeUndefined();
  });
});
