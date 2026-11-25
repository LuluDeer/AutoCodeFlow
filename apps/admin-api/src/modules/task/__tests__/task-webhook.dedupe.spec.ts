import { createHmac } from "node:crypto";

import { TaskWebhookService } from "../task-webhook.service";

/**
 * SEC-R3-4（P2）：入站 webhook 的**幂等去重**。
 *
 * 签名 + 时间戳窗只证明「请求新鲜」，证明不了「没被重放过」。同一条
 * (taskId, 签名) 在窗内再次到达时旧实现会再建一条 execution（清理/发布/
 * 对账类任务被重复执行），现在用 SETNX 抢占键命中即返回 `{deduplicated:true}`。
 * Redis 不可达时 fail-open（去重是加固，不是可用性前提）。
 */
const TASK_ID = "11111111-1111-4111-8111-111111111111";
const SECRET = "whsec_test_plain";

function deps() {
  const builder = {
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn(async () => ({ id: TASK_ID, webhookSecret: SECRET })),
  };
  return {
    taskRepo: { createQueryBuilder: jest.fn(() => builder) },
    execRepo: {},
    taskService: { trigger: jest.fn(async () => ({ id: "exec-1" })) },
    secretsCrypto: { encryptionEnabled: false },
    config: { get: jest.fn().mockReturnValue("http://api.test") },
    audit: { log: jest.fn(async () => undefined) },
  };
}

function signedRequest(
  body = '{"params":{"x":1}}',
  timestamp = Date.now(),
) {
  const rawBody = Buffer.from(body, "utf8");
  const ts = String(timestamp);
  const signature =
    "sha256=" +
    createHmac("sha256", SECRET)
      .update(Buffer.concat([Buffer.from(`${ts}.`), rawBody]))
      .digest("hex");
  return { rawBody, timestamp: ts, signature };
}

function build(
  d: ReturnType<typeof deps>,
  guard: { setIfAbsent: jest.Mock } | null,
) {
  return new TaskWebhookService(
    d.taskRepo as never,
    d.execRepo as never,
    d.taskService as never,
    d.secretsCrypto as never,
    d.config as never,
    d.audit as never,
    null,
    guard as never,
  );
}

describe("TaskWebhookService — 入站重放去重（SEC-R3-4）", () => {
  it("首次投递：放行触发", async () => {
    const d = deps();
    const guard = {
      setIfAbsent: jest.fn(async (_key: string, _ttl: number) => true),
    };
    const svc = build(d, guard);

    const res = await svc.triggerFromWebhook(TASK_ID, {}, signedRequest());

    expect(res).toEqual({ id: "exec-1" });
    expect(d.taskService.trigger).toHaveBeenCalledTimes(1);
    const key = guard.setIfAbsent.mock.calls[0][0] as string;
    expect(key).toContain(`webhook:task:${TASK_ID}:`);
    expect(guard.setIfAbsent.mock.calls[0][1]).toBe(10 * 60_000);
  });

  it("重复投递：不触发，返回 deduplicated（让投递方停止重试）", async () => {
    const d = deps();
    const guard = {
      setIfAbsent: jest.fn(async (_key: string, _ttl: number) => false),
    };
    const svc = build(d, guard);

    const res = await svc.triggerFromWebhook(TASK_ID, {}, signedRequest());

    expect(res).toEqual({ deduplicated: true });
    expect(d.taskService.trigger).not.toHaveBeenCalled();
  });

  it("Redis 不可达：fail-open 继续触发（不因去重故障让集成全挂）", async () => {
    const d = deps();
    const guard = {
      setIfAbsent: jest.fn(async (_key: string, _ttl: number) => {
        throw new Error("redis down");
      }),
    };
    const svc = build(d, guard);

    const res = await svc.triggerFromWebhook(TASK_ID, {}, signedRequest());

    expect(res).toEqual({ id: "exec-1" });
    expect(d.taskService.trigger).toHaveBeenCalledTimes(1);
  });

  it("无 replayGuard（极简装配/单测）时行为与改动前一致", async () => {
    const d = deps();
    const svc = build(d, null);
    const res = await svc.triggerFromWebhook(TASK_ID, {}, signedRequest());
    expect(res).toEqual({ id: "exec-1" });
  });

  it("改 delivery 头不能绕过去重（键只由 rawBody 决定，delivery 不入键）", async () => {
    const d = deps();
    const keys: string[] = [];
    const guard = {
      setIfAbsent: jest.fn(async (key: string, _ttl: number) => {
        keys.push(key);
        return true;
      }),
    };
    const svc = build(d, guard);
    const req = signedRequest();

    await svc.triggerFromWebhook(TASK_ID, {}, { ...req, delivery: "d-1" });
    await svc.triggerFromWebhook(TASK_ID, {}, { ...req, delivery: "d-2" });

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("同一 rawBody 换 timestamp 重签（含不同 delivery）仍被去重：只触发一次", async () => {
    const d = deps();
    const seen = new Set<string>();
    const guard = {
      setIfAbsent: jest.fn(async (key: string, _ttl: number) => {
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    };
    const svc = build(d, guard);
    const body = '{"params":{"x":1}}';
    const now = Date.now();
    const first = signedRequest(body, now - 1000);
    const second = signedRequest(body, now + 1000);

    expect(first.signature).not.toBe(second.signature);

    const firstRes = await svc.triggerFromWebhook(TASK_ID, {}, {
      ...first,
      delivery: "d-1",
    });
    const secondRes = await svc.triggerFromWebhook(TASK_ID, {}, {
      ...second,
      delivery: "d-2",
    });

    expect(firstRes).toEqual({ id: "exec-1" });
    expect(secondRes).toEqual({ deduplicated: true });
    expect(d.taskService.trigger).toHaveBeenCalledTimes(1);
    const keys = guard.setIfAbsent.mock.calls.map((call) => call[0]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("不同 rawBody（timestamp 相同）不被去重误杀：两次都触发", async () => {
    const d = deps();
    const seen = new Set<string>();
    const guard = {
      setIfAbsent: jest.fn(async (key: string, _ttl: number) => {
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    };
    const svc = build(d, guard);
    const now = Date.now();
    const first = signedRequest('{"params":{"x":1}}', now);
    const second = signedRequest('{"params":{"x":2}}', now);

    expect(first.timestamp).toBe(second.timestamp);
    expect(first.rawBody.equals(second.rawBody)).toBe(false);

    const firstRes = await svc.triggerFromWebhook(TASK_ID, {}, first);
    const secondRes = await svc.triggerFromWebhook(TASK_ID, {}, second);

    expect(firstRes).toEqual({ id: "exec-1" });
    expect(secondRes).toEqual({ id: "exec-1" });
    expect(d.taskService.trigger).toHaveBeenCalledTimes(2);
    const keys = guard.setIfAbsent.mock.calls.map((call) => call[0]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("触发失败释放幂等键（否则上游重投被误判 deduplicated，任务永久不执行）", async () => {
    const d = deps();
    d.taskService.trigger.mockRejectedValueOnce(new Error("queue down"));
    const guard = {
      setIfAbsent: jest.fn(async () => true),
      deleteKey: jest.fn(async () => undefined),
    };
    const svc = build(d, guard as never);

    await expect(
      svc.triggerFromWebhook(TASK_ID, {}, signedRequest()),
    ).rejects.toThrow("queue down");
    expect(guard.deleteKey).toHaveBeenCalledTimes(1);
  });
});
