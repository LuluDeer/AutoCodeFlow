import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { AgentController } from "../../agent.controller";
import type { AgentJobData } from "../agent.processor";
import { AgentBacklogService } from "../agent-backlog.service";
import { manualResumeJobId } from "../agent-job-options";

// 只在显式给出本次临时 Redis 的映射端口时运行；不读 .env，不回落到宿主 6379。
const rawPort = process.env.AGENT_RESUME_TEST_REDIS_PORT;
const live = rawPort === undefined ? describe.skip : describe;
live("AgentController 恢复契约 · 真 BullMQ", () => {
  let queue: Queue<AgentJobData>;
  let worker: Worker<AgentJobData>;
  beforeEach(async () => {
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || port === 6379) {
      throw new Error(
        "AGENT_RESUME_TEST_REDIS_PORT must be an isolated mapped port (not 6379)",
      );
    }
    const name = `agent-resume-test-${randomUUID()}`;
    const connection = { host: "127.0.0.1", port };
    queue = new Queue(name, { connection });
    worker = new Worker(name, null, { connection, autorun: false });
    await Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]);
  });
  afterEach(async () => {
    await worker?.close(true);
    try {
      await queue?.obliterate({ force: true }); // 随机生成的本用例队列
    } finally {
      await queue?.close();
    }
  });

  // 只替换会话/审批库。入队和响应走真实控制器，job 的 waiting/active/completed 转换走 Redis Lua。
  function fixture() {
    const id = randomUUID();
    const session = { id, status: "waiting_input", totalSteps: 3 };
    const controller = new AgentController(
      {
        requireById: async () => ({ ...session }),
        listSteps: async () => [{}],
        reopenForResume: async () => {
          if (session.status !== "failed") return false;
          session.status = "pending";
          return true;
        },
      } as never,
      {} as never,
      {
        findByKey: async () => ({ sessionId: id }),
        decide: async (approvalKey: string) => ({
          approvalKey,
          status: "granted",
          decidedBy: "admin",
        }),
        hasPendingForSession: async () => false,
      } as never,
      queue,
    );
    const grant = (key: string) =>
      controller.grantApproval(id, key, { username: "admin" } as never);
    const resume = () => controller.resume(id);
    return { id, session, grant, resume };
  }
  const take = (lock: string) => worker.getNextJob(lock, { block: false });

  it("旧 completed 原样保留；同轮重复点击不加一份，下一轮能在前一 job 仍 active 时独立入队", async () => {
    const { id, session, grant, resume } = fixture();
    const legacy = manualResumeJobId(id);
    await queue.add("run", { sessionId: id }, { jobId: legacy, attempts: 1 });
    await (await take("legacy")).moveToCompleted(null, "legacy", false);
    await expect(queue.getJobState(legacy)).resolves.toBe("completed");

    await expect(grant("approval-1")).resolves.toMatchObject({
      ok: true,
      resumed: true,
    });
    await Promise.all([resume(), resume()]);
    expect(await queue.getWaitingCount()).toBe(1);
    const first = await take("round-1");
    expect(first.data).toMatchObject({
      reason: "resume:approval",
      expectTotalSteps: 3,
    });
    await resume(); // 同轮 active，仍只有第一份
    expect(await queue.getWaitingCount()).toBe(0);

    session.totalSteps += 1; // runtime 已写下一步并再次 markWaiting，前一 job 尚未完成
    await expect(grant("approval-2")).resolves.toMatchObject({
      ok: true,
      resumed: true,
    });
    await resume();
    expect(await queue.getJobCounts("active", "waiting")).toEqual({
      active: 1,
      waiting: 1,
    });
    const second = await take("round-2");
    expect(second.id).not.toBe(first.id);
    expect(second.data).toMatchObject({
      reason: "resume:approval",
      expectTotalSteps: 4,
    });
    await first.moveToCompleted(null, "round-1", false);
    await second.moveToCompleted(null, "round-2", false);
    session.totalSteps += 1;
    await expect(resume()).resolves.toEqual({ ok: true });
    const third = await take("manual");
    expect(third.data).toMatchObject({
      reason: "resume:manual",
      expectTotalSteps: 5,
    });
    await third.moveToCompleted(null, "manual", false);
    expect(await queue.getWaitingCount()).toBe(0);
    expect(await queue.getJobState(legacy)).toBe("completed");
  });

  it("failed 没有新增 step，前一 job 仍 active：重开只留下一个后继，积压能查到它", async () => {
    const { id, session, resume } = fixture();
    await resume();
    const old = await take("before-failure");
    session.status = "failed";
    await expect(resume()).resolves.toEqual({ ok: true });
    await resume(); // 已被重开的 pending，不是另一次重试
    await old.moveToCompleted(null, "before-failure", false);
    expect(await queue.getWaitingCount()).toBe(1);
    const backlog = new AgentBacklogService(
      { find: async () => [session] } as never,
      queue,
    );
    expect((await backlog.findBacklogged()).sessionIds).toEqual([]);
    const retry = await take("retry");
    expect(retry.id).not.toBe(old.id);
    expect(retry.data).toMatchObject({ sessionId: id, expectTotalSteps: 3 });
    await retry.moveToCompleted(null, "retry", false);
    expect((await backlog.findBacklogged()).sessionIds).toEqual([id]);
  });
});
