import { TaskWebhookService } from "../task-webhook.service";
import { ExecutionWakeService } from "../execution-wake.service";

/**
 * FIX-4.2: webhook 同步等待（?wait=1）的事件化单测——覆盖两路：
 *  ① 唤醒路：ExecutionWakeService.waitWakeup 返回 true → 立即复查 DB 并
 *     （若已终态）返回 completed=true，不受轮询间隔约束；
 *  ② 兜底路：唤醒服务缺席 / 始终超时 → 按 1s→5s 退避轮询，直至 deadline
 *     返回 completed=false（超时不视为错误）。
 * 构造直连（不经 Nest Module）——等待循环是纯逻辑，依赖全部用替身。
 */

const makeExec = (status: string, overrides: Record<string, unknown> = {}) => ({
  id: "exec-1",
  taskId: "t1",
  taskName: "rpa-job",
  status,
  result: null,
  errorMessage: null,
  failureReason: null,
  startTime: new Date(1_700_000_000_000),
  endTime: null,
  duration: null,
  executorAddress: "10.0.0.8:9000",
  exitCode: null,
  ...overrides,
});

const makeDeps = () => ({
  taskRepo: {},
  execRepo: { findOne: jest.fn() },
  taskService: {},
  secretsCrypto: { encryptionEnabled: false },
  config: { get: jest.fn().mockReturnValue("http://api.test") },
  audit: { log: jest.fn() },
});

const makeWake = (impl: (id: string, ms: number) => Promise<boolean>) =>
  ({ waitWakeup: jest.fn(impl) }) as unknown as ExecutionWakeService;

const build = (
  deps: ReturnType<typeof makeDeps>,
  wake: ExecutionWakeService | null,
) =>
  new TaskWebhookService(
    deps.taskRepo as never,
    deps.execRepo as never,
    deps.taskService as never,
    deps.secretsCrypto as never,
    deps.config as never,
    deps.audit as never,
    wake,
  );

describe("TaskWebhookService.waitForTerminal — 终态唤醒事件化（FIX-4.2）", () => {
  it("唤醒路：首轮挂起期间收到唤醒 → 复查到终态 → completed=true", async () => {
    const deps = makeDeps();
    deps.execRepo.findOne
      .mockResolvedValueOnce(makeExec("running"))
      .mockResolvedValueOnce(makeExec("success", { endTime: new Date() }));
    const svc = build(
      deps,
      makeWake(async () => {
        // 模拟「唤醒信号在挂起期间到达」（waitWakeup 立即 resolve true）
        return true;
      }),
    );
    const result = await svc.waitForTerminal("exec-1", 5);
    expect(result.completed).toBe(true);
    expect(result.execution?.status).toBe("success");
    // 只挂起了一次（首查非终态 → 唤醒 → 复查终态 → 退出）
    expect((deps.execRepo.findOne).mock.calls.length).toBe(2);
  });

  it("唤醒后轮询间隔复位到基线（下一次挂起仍给满 1s 窗口）", async () => {
    const deps = makeDeps();
    deps.execRepo.findOne
      .mockResolvedValueOnce(makeExec("running"))
      .mockResolvedValueOnce(makeExec("running"))
      .mockResolvedValue(makeExec("success", { endTime: new Date() }));
    const wake = makeWake(jest.fn(async () => true));
    const svc = build(deps, wake);
    await svc.waitForTerminal("exec-1", 10);
    const waitWakeup = (wake as unknown as { waitWakeup: jest.Mock })
      .waitWakeup;
    expect(waitWakeup).toHaveBeenCalled();
    for (const call of waitWakeup.mock.calls as unknown as [string, number][]) {
      expect(call[0]).toBe("exec-1");
      // 唤醒立即返回时 waitMs 恒为基线 1000（不因唤醒而指数放大）
      expect(call[1]).toBe(1000);
    }
  });

  it("兜底路：唤醒缺席（未装配）→ 纯退避轮询，超时返回 completed=false", async () => {
    const deps = makeDeps();
    deps.execRepo.findOne.mockResolvedValue(makeExec("running"));
    const svc = build(deps, null);
    const result = await svc.waitForTerminal("exec-1", 1);
    expect(result.completed).toBe(false);
    expect(result.execution?.status).toBe("running");
    // 至少经历「首查 + 一轮兜底轮询」
    expect(deps.execRepo.findOne.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 10_000);

  it("兜底路：唤醒始终超时 → 退避节奏生效（waitMs 1000→2000→…封顶 5000）", async () => {
    const deps = makeDeps();
    deps.execRepo.findOne.mockResolvedValue(makeExec("running"));
    // 微延迟模拟「真实挂起至超时」：即时返回会让 15s deadline 转出数万轮
    const wake = makeWake(jest.fn(async () => {
      await new Promise((r) => setTimeout(r, 2));
      return false;
    }));
    const svc = build(deps, wake);
    const result = await svc.waitForTerminal("exec-1", 8);
    expect(result.completed).toBe(false);
    const waitMsSeq = ((wake as unknown as { waitWakeup: jest.Mock })
      .waitWakeup.mock.calls as unknown as [string, number][]).map(
      (c) => c[1],
    );
    expect(waitMsSeq.length).toBeGreaterThanOrEqual(3);
    expect(waitMsSeq[0]).toBe(1000);
    expect(waitMsSeq[1]).toBe(2000);
    // 封顶不超过 5000（避免对潜在长序列做 Math.max 展开）
    expect(waitMsSeq.some((ms) => ms > 5000)).toBe(false);
  }, 15_000);

  it("唤醒等待上限：waitWakeup 的 waitMs 不超过剩余 deadline", async () => {
    const deps = makeDeps();
    deps.execRepo.findOne.mockResolvedValue(makeExec("running"));
    const wake = makeWake(jest.fn(async () => false));
    const svc = build(deps, wake);
    await svc.waitForTerminal("exec-1", 1);
    const waitMsSeq = ((wake as unknown as { waitWakeup: jest.Mock })
      .waitWakeup.mock.calls as unknown as [string, number][]).map(
      (c) => c[1],
    );
    for (const ms of waitMsSeq) expect(ms).toBeLessThanOrEqual(1000);
  }, 10_000);

  it("首查即终态 → 不挂起、不触碰唤醒通道", async () => {
    const deps = makeDeps();
    deps.execRepo.findOne.mockResolvedValue(makeExec("killed"));
    const wake = makeWake(jest.fn(async () => true));
    const svc = build(deps, wake);
    const result = await svc.waitForTerminal("exec-1", 5);
    expect(result.completed).toBe(true);
    expect((wake as unknown as { waitWakeup: jest.Mock }).waitWakeup).not
      .toHaveBeenCalled();
  });
});
