import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import type { INestApplication } from "@nestjs/common";
import type { Queue } from "bullmq";
import request from "supertest";
import { DataSource } from "typeorm";

import { AiService, type ToolCall } from "../src/modules/ai/ai.service";
import { AgentApprovalWakeupService } from "../src/modules/agent/runtime/agent-approval-wakeup.service";
import type { AgentJobData } from "../src/modules/agent/runtime/agent.processor";
import { AgentRuntimeService } from "../src/modules/agent/runtime/agent-runtime.service";
import { AgentSessionService } from "../src/modules/agent/runtime/agent-session.service";
import { WAITING_FOR_APPROVAL_PREFIX } from "../src/modules/agent/runtime/agent-approval-waiting";
import { createTestApp, loginAsAdmin } from "./helpers/app.helper";

/**
 * R322 · R296「审批 granted 丢失唤醒」真实进程内集成 e2e（方案 E-pure，R321 §5.2）。
 *
 * 验收级别：真 PG / 真 Redis / 真 Nest / 真 BullMQ worker，**只脚本化 LLM 答复**。
 * 核心手法：把 `AgentSessionService.markWaiting` 包成「先 await 可手动 resolve 的
 * Deferred，再调原方法」，精确制造竞态窗口——pending 单已落库、session 仍 running、
 * 管理员 grant 读到 running 快照（resumed=false）；gate 放行后由 markWaiting 尾钩
 * 的 wakeup probe 补偿入队，断言会话自动收敛、审批单 consumed、被批工具副作用落库。
 *
 * 写域只限本文件。测试库必须含 test/e2e 字样，防误连生产库。
 * 口令只从 env/.env 读取，绝不写进本文件或日志。
 */
describe("R296 approval granted lost-wakeup · real in-process race (e2e)", () => {
  let app: INestApplication;
  let db: DataSource;
  let admin: string;
  let reviewer: string;
  let queue: Queue<AgentJobData>;

  const PREFIX = `r296-e2e-${randomUUID().slice(0, 12)}`;
  const RESULT = "R296 race resolved by tail-hook compensation";
  const createdPaths: string[] = [];
  const sessionIds: string[] = [];
  /** 本 spec 自己调用手动 resume 端点的次数（反面断言用，不依赖 Nest 路由 spy）。 */
  let manualResumeCalls = 0;
  /** 测试失败时兜底放行所有 gate，避免 worker 被永久卡住拖垮 app.close()。 */
  const allGates: Deferred[] = [];

  type SessionRow = {
    id: string;
    status: string;
    waitingFor: string | null;
    totalSteps: number;
    errorMessage: string | null;
    resultJson: Record<string, unknown> | null;
  };
  type ApprovalRow = {
    approvalKey: string;
    sessionId: string;
    status: string;
    scope: string;
  };

  /** 可手动 resolve 的一次性闸门。 */
  class Gate {
    readonly promise: Promise<void>;
    private resolveFn!: () => void;
    constructor() {
      this.promise = new Promise<void>((resolve) => {
        this.resolveFn = resolve;
      });
      allGates.push(this as unknown as Deferred);
    }
    open(): void {
      this.resolveFn();
    }
  }
  // 仅用于 allGates 的类型占位（Gate 自身即该结构）。
  type Deferred = { open(): void };

  const unwrap = (body: any): any => body?.data ?? body;

  async function post(path: string, body: object, token = admin): Promise<any> {
    if (path.includes("/resume")) manualResumeCalls += 1;
    const r = await request(app.getHttpServer())
      .post(path)
      .set("Authorization", `Bearer ${token}`)
      .send(body)
      .expect(201);
    return unwrap(r.body);
  }

  async function get(path: string, token = admin): Promise<any> {
    const r = await request(app.getHttpServer())
      .get(path)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    return unwrap(r.body);
  }

  /** 造第二个管理员（四眼审批），口令仅存在于本进程内存。 */
  async function createReviewer(): Promise<string> {
    const password = `Aa1!${randomUUID()}`;
    const user = await post("/users", {
      username: `${PREFIX}-reviewer`,
      password,
      email: `${PREFIX}-reviewer@example.invalid`,
      role: "admin",
    });
    createdPaths.push(`/users/${user.id}`);
    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username: `${PREFIX}-reviewer`, password })
      .expect(201);
    const token: string = unwrap(login.body).accessToken;
    expect(token).toBeTruthy();
    return token;
  }

  async function createTemplate(suffix: string): Promise<string> {
    const key = `${PREFIX}-${suffix}`;
    const t = await post("/task-templates", {
      key,
      name: key,
      config: { runtime: "shell", triggerType: "manual" },
    });
    createdPaths.push(`/task-templates/${t.id}`);
    return t.id;
  }

  /** 脚本化模型：首轮发一个 approvalRequired 工具调用，拿到工具结果后给结论。 */
  function scriptSingleApprovalTool(templateId: string, taskName: string): void {
    jest
      .spyOn(app.get(AiService), "chatMultimodal")
      .mockImplementation(async ({ messages }) => {
        const n = messages.filter((m) => m.role === "tool").length;
        const calls: ToolCall[] =
          n === 0
            ? [
                {
                  type: "function",
                  id: "call-0",
                  function: {
                    name: "create_task_from_template",
                    arguments: JSON.stringify({
                      template: templateId,
                      name: taskName,
                    }),
                  },
                },
              ]
            : [];
        return {
          model: "local-script",
          content: calls.length ? "" : RESULT,
          toolCalls: calls,
          usage: { tokensIn: 2, tokensOut: 1 },
        };
      });
  }

  async function sessionRow(id: string): Promise<SessionRow | undefined> {
    const [row] = await db.query(
      'SELECT id, status, "waitingFor", "totalSteps", "errorMessage", "resultJson" FROM agent_sessions WHERE id = $1',
      [id],
    );
    return row;
  }

  async function approvalRows(sessionId: string): Promise<ApprovalRow[]> {
    return db.query(
      'SELECT "approvalKey", "sessionId", status, scope FROM agent_approvals WHERE "sessionId" = $1 ORDER BY "createdAt"',
      [sessionId],
    );
  }

  async function taskNames(marker: string): Promise<string[]> {
    const rows: { name: string }[] = await db.query(
      "SELECT name FROM tasks WHERE name LIKE $1 ORDER BY name",
      [`%${marker}%`],
    );
    return rows.map((r) => r.name);
  }

  /** poll DB 副作用，不用固定 sleep（照抄 funnel-listener e2e 的纪律）。 */
  async function poll<T>(
    label: string,
    read: () => Promise<T | undefined>,
    ok: (v: T) => boolean,
    timeoutMs = 10_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: T | undefined;
    do {
      last = await read();
      if (last !== undefined && ok(last)) return last;
      await wait(50);
    } while (Date.now() < deadline);
    throw new Error(`timeout waiting ${label}: last=${JSON.stringify(last)}`);
  }

  async function pollPendingApproval(sessionId: string): Promise<ApprovalRow> {
    return poll(
      `pending approval for ${sessionId}`,
      async () => (await approvalRows(sessionId)).find((a) => a.status === "pending"),
      () => true,
    );
  }

  async function waitForStep(id: string, n: number, status: string): Promise<void> {
    await poll(
      `${status}@step${n} of ${id}`,
      async () => sessionRow(id),
      (s) => s.status === status && s.totalSteps === n,
    ).catch((e) => {
      // failed 是显式失败面，保留 journey e2e 的报错语义。
      throw e;
    });
  }

  async function waitForFinal(id: string): Promise<SessionRow> {
    return poll(
      `succeeded session ${id}`,
      async () => sessionRow(id),
      (s) => s.status === "succeeded",
    );
  }

  beforeAll(async () => {
    if (!/(^|_)(test|e2e)(_|$)/i.test(process.env.DB_DATABASE ?? "")) {
      throw new Error(
        "This e2e requires an explicit test/e2e database (e.g. autoflow_ttfv_e2e)",
      );
    }
    app = await createTestApp();
    db = app.get(DataSource);
    admin = await loginAsAdmin(app);
    reviewer = await createReviewer();
    // 必须取 wakeup provider 实际注入的那个 Queue 实例：实测
    // app.get(getQueueToken(AGENT_QUEUE_NAME)) 拿到的是另一个实例，spy/gate 会落空。
    queue = (app.get(AgentApprovalWakeupService) as unknown as {
      queue: Queue<AgentJobData>;
    }).queue;
    expect(queue).toBeDefined();
  });

  afterEach(() => {
    // 任何用例残留的 gate 都放行，避免 worker 卡死影响后续用例 / app.close()。
    for (const g of allGates.splice(0)) g.open();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    try {
      if (db && sessionIds.length) {
        for (const sid of sessionIds) {
          try {
            await db.query(`DELETE FROM "agent_approvals" WHERE "sessionId" = $1`, [sid]);
            await db.query(`DELETE FROM "agent_tool_calls" WHERE "sessionId" = $1`, [sid]);
            await db.query(`DELETE FROM "agent_steps" WHERE "sessionId" = $1`, [sid]);
            await db.query(`DELETE FROM "agent_events" WHERE "sessionId" = $1`, [sid]);
            await db.query(`DELETE FROM "agent_sessions" WHERE id = $1`, [sid]);
          } catch (e) {
            // 清理失败不掩盖用例结论；真跑后按实际 FK 报错再收紧删除顺序。
            console.warn(`R296 e2e cleanup session ${sid}: ${(e as Error).message}`);
          }
        }
      }
      if (db) {
        await db.query(`DELETE FROM "tasks" WHERE name LIKE $1`, [`${PREFIX}%`]);
      }
      if (admin) {
        for (const path of [...createdPaths].reverse()) {
          await request(app.getHttpServer())
            .delete(path)
            .set("Authorization", `Bearer ${admin}`)
            .expect(200)
            .catch(() => undefined);
        }
      }
    } finally {
      await app?.close();
    }
  });

  it("主场景 · 竞态 grant(resumed=false) → markWaiting 尾钩补偿 → 自动收敛 consumed", async () => {
    const templateId = await createTemplate("main");
    const taskName = `${PREFIX}-main-task`;
    scriptSingleApprovalTool(templateId, taskName);

    manualResumeCalls = 0;
    const sessions = app.get(AgentSessionService);
    const originalMarkWaiting = sessions.markWaiting;
    const gate = new Gate();
    const addSpy = jest.spyOn(queue, "add");
    let observedWaitingFor = "";

    // ① 把 markWaiting 包成「先 await gate，再调原方法」。
    jest
      .spyOn(sessions, "markWaiting")
      .mockImplementation(async (id: string, waitingFor: string) => {
        observedWaitingFor = waitingFor;
        await gate.promise;
        return originalMarkWaiting.call(sessions, id, waitingFor);
      });

    let sessionId = "";
    try {
      const created = await post("/agent/sessions", {
        kind: "chat",
        context: { question: PREFIX },
      });
      sessionId = created.id;
      sessionIds.push(sessionId);

      // ③ pending 单已落库，session 仍 running（被 gate 卡在 markWaiting 门口）。
      const pending = await pollPendingApproval(sessionId);
      const gated = await sessionRow(sessionId);
      expect(gated?.status).toBe("running");

      // ④ 第二个管理员 grant：E-pure 语义下读到 running 快照 → resumed=false。
      const grant = await post(
        `/agent/sessions/${sessionId}/approvals/${pending.approvalKey}/grant`,
        {},
        reviewer,
      );
      expect(grant).toMatchObject({ ok: true, resumed: false });
      expect((await approvalRows(sessionId)).find((a) => a.approvalKey === pending.approvalKey)?.status).toBe("granted");

      // ⑤ gate 放行 → 原 markWaiting 写 waiting_input → 尾钩 probe → 补偿入队。
      gate.open();

      // 尾钩 probe 是 onModuleInit 里 bind 过的引用，post-init spy 拦不到；
      // 以 markWaiting 实参 + 真实 queue.add 凭据作为 probe 已执行的见证。
      // 实测补偿 job 可在 50ms 轮询间隔内一路跑到 succeeded，故不抓瞬时 waiting_input。
      expect(app.get(AgentApprovalWakeupService)).toBeDefined();
      expect(observedWaitingFor).toBe(
        `${WAITING_FOR_APPROVAL_PREFIX} ${pending.approvalKey}`,
      );
      await poll(
        "compensation enqueue observed",
        async () =>
          addSpy.mock.calls.some(
            (c) =>
              c[0] === "run" &&
              (c[1] as AgentJobData)?.reason === "resume:approval",
          ),
        (v) => v,
      );

      // BullMQ Queue.add 的 mock.calls 元素是 [name, data, opts?]。
      const wakeupAdds = addSpy.mock.calls.filter(
        (c) => c[0] === "run" && (c[1] as AgentJobData)?.reason === "resume:approval",
      );
      expect(wakeupAdds.length).toBeGreaterThanOrEqual(1);
      const jobData = wakeupAdds[0][1] as AgentJobData;
      const jobOpts = wakeupAdds[0][2] as any;
      expect(jobData).toMatchObject({
        sessionId,
        expectTotalSteps: expect.any(Number),
        expectWaitingFor: observedWaitingFor,
      });
      // R323：补偿 job 走独立 dedup 命名空间，手动 resume 仍用 resume-。
      const dedupId = `resume-wakeup-${sessionId}-${jobData.expectTotalSteps}`;
      expect(jobOpts?.deduplication?.id).toBe(dedupId);
      // 反面断言：同名 dedup id 的补偿 job 至多 1 个。
      const sameDedupAdds = addSpy.mock.calls.filter(
        (c) => (c[2] as any)?.deduplication?.id === dedupId,
      );
      expect(sameDedupAdds.length).toBeLessThanOrEqual(1);

      // ⑥ 轮询直到收敛；复用 journey e2e 的 waitForStep 校验步序前进。
      await waitForStep(sessionId, Number(jobData.expectTotalSteps) + 1, "succeeded");
      const final = await waitForFinal(sessionId);
      expect(final.status).toBe("succeeded");
      expect((final.resultJson as any)?.conclusion).toBe(RESULT);
      const after = (await approvalRows(sessionId)).find(
        (a) => a.approvalKey === pending.approvalKey,
      );
      expect(after?.status).toBe("consumed");
      expect(after?.scope).toBe("once");
      expect(await taskNames("main-task")).toEqual([taskName]);
      console.log(
        `R296-EVIDENCE main session=${sessionId} status=${final.status} steps=${final.totalSteps} approval=${after?.status} task=${(await taskNames("main-task"))[0]} dedup=${dedupId}`,
      );

      // ⑦ 全程没走手动 resume 端点。
      expect(manualResumeCalls).toBe(0);
    } finally {
      gate.open();
    }
  });

  /** 等本会话的 resume job 全部从 waiting/active/delayed 排空（不固定 sleep）。 */
  async function waitJobsDrained(id: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    do {
      const jobs = await queue.getJobs(["waiting", "active", "delayed"]);
      if (!jobs.some((j) => j.data?.sessionId === id)) return;
      await wait(50);
    } while (Date.now() < deadline);
    throw new Error(`resume jobs for ${id} did not drain`);
  }

  it("正向 · 补偿 job active 期间真实手动 resume 并存（不吞）→ 无双跑/单份副作用", async () => {
    // 完全走真实端点，不造状态旁路：
    //  ① probe 已按旧 waitingFor 入队、补偿 job 被 gate 卡在 run()（job active、
    //     独立 dedup key `resume-wakeup-{sid}-{steps}` 被占）；
    //  ② 打真实手动 resume 端点，正向断言它的 job 不再被 dedup 吞（manual job ≥1）、
    //     两来源 dedup id 分属 resume-wakeup- / resume- 两个命名空间；
    //  ③ 放行补偿 job：测试代码没有改过 waitingFor，CAS 命中 → 单份副作用；
    //     迟到手动 job 带陈旧 totalSteps 让位（无双跑）；
    //  ④ 验证补偿 job 终结后 `resume-wakeup-` dedup key 释放、同 id 可再 add。
    const templateId = await createTemplate("obs");
    const taskName = `${PREFIX}-race-task`;
    scriptSingleApprovalTool(templateId, taskName);

    const sessions = app.get(AgentSessionService);
    const runtime = app.get(AgentRuntimeService);
    const originalMarkWaiting = sessions.markWaiting;
    const originalRun = runtime.run;
    const gate = new Gate(); // 卡 markWaiting（制造 grant 竞态）
    const runGate = new Gate(); // 卡「带 expectWaitingFor 的补偿 job」的执行
    const manualRunGate = new Gate(); // 卡「手动 resume job」的执行（稳定 liveJobs 观察窗口）

    jest
      .spyOn(sessions, "markWaiting")
      .mockImplementation(async (id: string, waitingFor: string) => {
        await gate.promise;
        return originalMarkWaiting.call(sessions, id, waitingFor);
      });
    let gatedRunSettled = false;
    const addSpy = jest.spyOn(queue, "add");
    const runSpy = jest
      .spyOn(runtime, "run")
      .mockImplementation((id: string, opts?: any) => {
        if (opts?.expectWaitingFor !== undefined) {
          return runGate.promise.then(async () => {
            try {
              return await originalRun.call(runtime, id, opts);
            } finally {
              gatedRunSettled = true;
            }
          });
        }
        // 手动 resume job 只带 expectTotalSteps（无 expectWaitingFor）。并发=2，
        // 不 gate 住它会瞬间跑完并被 removeOnComplete 清出队列，liveJobs 抓不到。
        // 首跑是单参 run(id)（opts undefined），不受此分支影响。
        if (
          opts?.expectWaitingFor === undefined &&
          opts?.expectTotalSteps !== undefined
        ) {
          return manualRunGate.promise.then(() =>
            originalRun.call(runtime, id, opts),
          );
        }
        return originalRun.call(runtime, id, opts);
      });

    let sessionId = "";
    try {
      const created = await post("/agent/sessions", {
        kind: "chat",
        context: { question: `${PREFIX}-race` },
      });
      sessionId = created.id;
      sessionIds.push(sessionId);

      const pending = await pollPendingApproval(sessionId);
      const grant = await post(
        `/agent/sessions/${sessionId}/approvals/${pending.approvalKey}/grant`,
        {},
        reviewer,
      );
      expect(grant).toMatchObject({ ok: true, resumed: false });

      gate.open(); // markWaiting 提交 → probe 入队补偿 job（独立 resume-wakeup- 命名空间）
      await poll(
        "compensation job entered gated run()",
        async () =>
          runSpy.mock.calls.some(
            (c) => (c[1] as any)?.expectWaitingFor !== undefined,
          ),
        (v) => v,
      );

      const waiting = await poll(
        "session waiting_input (race)",
        async () => sessionRow(sessionId),
        (s) => s.status === "waiting_input",
      );
      const expectedWaitingFor = `${WAITING_FOR_APPROVAL_PREFIX} ${pending.approvalKey}`;
      expect(waiting.waitingFor).toBe(expectedWaitingFor);

      // CAS 契约核验（不改任何状态）：陈旧 waitingFor 凭据必被 markRunning 拒绝。
      const staleClaim = await sessions.markRunning(sessionId, {
        expectWaitingFor: "stale-approval-key",
        expectTotalSteps: waiting.totalSteps,
      });
      expect(staleClaim).toBe(false);
      expect((await sessionRow(sessionId))?.status).toBe("waiting_input");

      // 真实手动 resume 端点：补偿 job 此时 active、独立 dedup key 被占。
      const manual = await post(`/agent/sessions/${sessionId}/resume`, {});
      expect(manual).toMatchObject({ ok: true });

      // 正向断言①：手动 job 不再被吞——liveJobs 里 resume:manual 的 job ≥1。
      // 两个 job 的 run() 都被 gate 卡住，稳定处于 waiting/active（不固定 sleep）。
      await poll(
        "manual resume job coexists with active compensation",
        async () => queue.getJobs(["waiting", "active", "delayed"]),
        (jobs) =>
          jobs.filter(
            (j) =>
              j.data?.sessionId === sessionId &&
              j.data?.reason === "resume:manual",
          ).length >= 1,
      );
      const liveJobs = await queue.getJobs(["waiting", "active", "delayed"]);
      const manualJobs = liveJobs.filter(
        (j) =>
          j.data?.sessionId === sessionId && j.data?.reason === "resume:manual",
      );
      const compensationJobs = liveJobs.filter(
        (j) =>
          j.data?.sessionId === sessionId &&
          j.data?.reason === "resume:approval",
      );
      expect(manualJobs.length).toBeGreaterThanOrEqual(1);
      expect(compensationJobs.length).toBeGreaterThanOrEqual(1);

      // 正向断言②：两来源 dedup id 不同（补偿 resume-wakeup-，手动 resume-）。
      const manualDedupIds = manualJobs.map(
        (j) => (j.opts as any)?.deduplication?.id as string | undefined,
      );
      expect(
        manualDedupIds.some(
          (id) => id?.startsWith("resume-") && !id.startsWith("resume-wakeup-"),
        ),
      ).toBe(true);

      // 交叉验证：queue.add 凭据里的补偿 dedup id 落在独立命名空间，且与手动键逐字不同。
      const wakeupAdds = addSpy.mock.calls.filter(
        (c) => (c[1] as AgentJobData)?.reason === "resume:approval",
      );
      expect(wakeupAdds.length).toBeGreaterThanOrEqual(1);
      const jobData = wakeupAdds[0][1] as AgentJobData;
      expect(jobData).toMatchObject({
        sessionId,
        expectWaitingFor: expectedWaitingFor,
        expectTotalSteps: expect.any(Number),
      });
      const addedCompensationDedupId = (wakeupAdds[0][2] as any)?.deduplication
        ?.id as string;
      const expectedCompensationDedupId = `resume-wakeup-${sessionId}-${jobData.expectTotalSteps}`;
      expect(addedCompensationDedupId).toBe(expectedCompensationDedupId);
      for (const manualDedupId of manualDedupIds) {
        expect(manualDedupId).not.toBe(addedCompensationDedupId);
      }
      const compensationLiveDedupIds = compensationJobs.map(
        (j) => (j.opts as any)?.deduplication?.id as string | undefined,
      );
      expect(compensationLiveDedupIds).toContain(addedCompensationDedupId);

      console.log(
        `R296-POSITIVE manual-resume-during-active-compensation manualJobs=${manualJobs.length} compensationDedup=${addedCompensationDedupId} manualDedups=${JSON.stringify(manualDedupIds)}`,
      );

      // 放行补偿 job：测试代码未改 waitingFor ⇒ expectWaitingFor CAS 命中，
      // 旧 waitingFor 凭据正确放行一次，审批只 consume 一次、副作用只落一次。
      runGate.open();
      await poll("gated compensation run settled", async () => gatedRunSettled, (v) => v);

      // 迟到手动 job 带陈旧 expectTotalSteps 放行 → CAS 让位（终态拒绝），无双跑。
      manualRunGate.open();
      await waitJobsDrained(sessionId);

      const final = await waitForFinal(sessionId);
      expect(final.status).toBe("succeeded");
      const rows = await approvalRows(sessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("consumed");
      // 无双跑/无重复副作用：被批工具只建了 1 行 task。
      expect(await taskNames("race-task")).toEqual([taskName]);

      // dedup key 释放验证：补偿 job 终结后，同 `resume-wakeup-` dedup id 的 add 应真拿到 job。
      const replay = await queue.add(
        "run",
        {
          sessionId,
          reason: "resume:dedup-release-probe",
          expectTotalSteps: waiting.totalSteps,
        },
        {
          attempts: 1,
          removeOnComplete: true,
          deduplication: {
            id: `resume-wakeup-${sessionId}-${waiting.totalSteps}`,
          },
        },
      );
      expect(replay?.id).toBeTruthy();
      await waitJobsDrained(sessionId);

      // 真实二次 resume：终态会话按产品语义回 {ok:false}（不是 409），
      // 用于区分「永久卡死」与「需重试一次」——这里无需重试即可判定已收敛。
      const second = await post(`/agent/sessions/${sessionId}/resume`, {});
      expect(second).toMatchObject({ ok: false });
      console.log(
        `R296-POSITIVE obs session=${sessionId} status=${final.status} approval=${rows[0].status} tasks=${JSON.stringify(await taskNames("race-task"))} manualJobs=${manualJobs.length} compensationDedup=${addedCompensationDedupId} secondResumeOk=${second.ok}`,
      );
    } finally {
      gate.open();
      runGate.open();
      manualRunGate.open();
    }
  });

  it("反例 · 真实手动 resume 先于补偿入队 → 迟到补偿 job 让位，无双跑/无重复副作用", async () => {
    // §5.2 反例的真实端点版本：把 probe 的 queue.add 卡在门口（不造状态旁路），
    // 让真实手动 resume 先赢；随后放行的补偿 job 带着旧 expectWaitingFor 到达，
    // 必须幂等让位，审批只 consume 一次、被批工具只落一次副作用。
    const templateId = await createTemplate("late");
    const taskName = `${PREFIX}-late-task`;
    scriptSingleApprovalTool(templateId, taskName);

    const sessions = app.get(AgentSessionService);
    const originalMarkWaiting = sessions.markWaiting;
    const gate = new Gate();
    const probeAddGate = new Gate();
    let compensationAddDone = false;

    jest
      .spyOn(sessions, "markWaiting")
      .mockImplementation(async (id: string, waitingFor: string) => {
        await gate.promise;
        return originalMarkWaiting.call(sessions, id, waitingFor);
      });
    const originalAdd = queue.add.bind(queue) as any;
    const addSpy = jest.spyOn(queue, "add") as jest.SpyInstance;
    addSpy.mockImplementation(async (name: any, data: any, opts?: any) => {
      if (data?.reason === "resume:approval") {
        await probeAddGate.promise;
        compensationAddDone = true;
      }
      return originalAdd(name, data, opts);
    });

    let sessionId = "";
    try {
      const created = await post("/agent/sessions", {
        kind: "chat",
        context: { question: `${PREFIX}-late` },
      });
      sessionId = created.id;
      sessionIds.push(sessionId);

      const pending = await pollPendingApproval(sessionId);
      const grant = await post(
        `/agent/sessions/${sessionId}/approvals/${pending.approvalKey}/grant`,
        {},
        reviewer,
      );
      expect(grant).toMatchObject({ ok: true, resumed: false });

      gate.open();
      const waiting = await poll(
        "session waiting_input (late-compensation)",
        async () => sessionRow(sessionId),
        (s) => s.status === "waiting_input",
      );
      expect(waiting.waitingFor).toBe(
        `${WAITING_FOR_APPROVAL_PREFIX} ${pending.approvalKey}`,
      );
      // 补偿 add 已被 probe 调用但卡在 probeAddGate：此刻队列里没有同名 job。
      expect(
        addSpy.mock.calls.some(
          (c) => (c[1] as any)?.reason === "resume:approval",
        ),
      ).toBe(true);

      // 真实手动 resume 端点先赢（此时无同名 dedup job 占键）。
      const manual = await post(`/agent/sessions/${sessionId}/resume`, {});
      expect(manual).toMatchObject({ ok: true });
      const final = await waitForFinal(sessionId);
      expect(final.status).toBe("succeeded");
      expect(await taskNames("late-task")).toEqual([taskName]);

      // 放行迟到的补偿 add → job 带旧 expectWaitingFor 到达，须让位。
      probeAddGate.open();
      await poll("compensation add released", async () => compensationAddDone, (v) => v);
      await waitJobsDrained(sessionId);

      expect(await taskNames("late-task")).toEqual([taskName]); // 无第二份副作用
      const rows = await approvalRows(sessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("consumed");
      console.log(
        `R296-EVIDENCE late session=${sessionId} status=${final.status} approval=${rows[0].status} tasks=${JSON.stringify(await taskNames("late-task"))}`,
      );
    } finally {
      gate.open();
      probeAddGate.open();
    }
  });
});
