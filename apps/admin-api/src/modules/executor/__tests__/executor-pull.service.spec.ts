import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { ExecutorPullService } from "../executor-pull.service";

/**
 * ARCH-32（ADR-015）: pull 派发队列单元行为——ioredis 打桩（不真连），
 * 断言入队形态 / FIFO 出队 / 过期载荷丢弃 / 畸形载荷丢弃 / 卫生清理。
 */

jest.mock("ioredis", () => ({
  __esModule: true,
  default: class MockRedis {
    constructor() {
      // 桩客户端：rpop 默认空队列，用例内 mockResolvedValueOnce 覆盖
      return {
        lpush: jest.fn().mockResolvedValue(1),
        rpop: jest.fn().mockResolvedValue(null),
        del: jest.fn().mockResolvedValue(1),
        on: jest.fn(),
        quit: jest.fn().mockResolvedValue("OK"),
      };
    }
  },
}));

describe("ExecutorPullService（ARCH-32）", () => {
  const makeService = async (pullTtlMs = "900000") => {
    const module = await Test.createTestingModule({
      providers: [
        ExecutorPullService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn(() => pullTtlMs) },
        },
      ],
    }).compile();
    return module.get(ExecutorPullService);
  };

  const clientOf = (svc: ExecutorPullService) =>
    (
      svc as unknown as { ensureClient: () => Record<string, jest.Mock> }
    ).ensureClient();

  it("enqueue：LPUSH 到 acf:pull:{executorId}，载荷附 pushedAt", async () => {
    const svc = await makeService();
    const client = clientOf(svc);

    await svc.enqueue("exec-1", { executionId: "e1", params: {} });

    expect(client.lpush).toHaveBeenCalledTimes(1);
    const [key, body] = client.lpush.mock.calls[0] as [string, string];
    expect(key).toBe("acf:pull:exec-1");
    const parsed = JSON.parse(body);
    expect(parsed.executionId).toBe("e1");
    expect(typeof parsed.pushedAt).toBe("number");
  });

  it("pull：取到载荷即返回（FIFO 出队 + JSON 解析）", async () => {
    const svc = await makeService();
    const client = clientOf(svc);
    client.rpop.mockResolvedValueOnce(
      JSON.stringify({ executionId: "e1", pushedAt: Date.now() }),
    );

    const payload = await svc.pull("exec-1", 0);
    expect(payload).toMatchObject({ executionId: "e1" });
    expect(client.rpop).toHaveBeenCalledWith("acf:pull:exec-1");
  });

  it("pull：过期载荷（pushedAt 超 TTL）丢弃不投递", async () => {
    const svc = await makeService("1000");
    const client = clientOf(svc);
    client.rpop.mockResolvedValueOnce(
      JSON.stringify({ executionId: "stale", pushedAt: Date.now() - 60_000 }),
    );

    const payload = await svc.pull("exec-1", 0);
    expect(payload).toBeNull();
  });

  it("pull：畸形 JSON 丢弃不投递", async () => {
    const svc = await makeService();
    const client = clientOf(svc);
    client.rpop.mockResolvedValueOnce("{not-json");

    const payload = await svc.pull("exec-1", 0);
    expect(payload).toBeNull();
  });

  it("clear：DEL 队列键（best-effort）", async () => {
    const svc = await makeService();
    const client = clientOf(svc);

    await svc.clear("exec-1");
    expect(client.del).toHaveBeenCalledWith("acf:pull:exec-1");
  });
});
