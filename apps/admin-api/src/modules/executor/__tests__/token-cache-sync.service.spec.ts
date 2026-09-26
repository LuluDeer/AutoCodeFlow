import { ConfigService } from "@nestjs/config";
import type Redis from "ioredis";
import { EventEmitter } from "node:events";

import {
  EXECUTOR_TOKEN_EVICT_CHANNEL,
  ExecutorTokenCacheSyncService,
} from "../token-cache-sync.service";

/** ioredis 假体：EventEmitter 覆盖订阅端语义 + publish/quit 记录。 */
class FakeRedis extends EventEmitter {
  published: Array<{ channel: string; payload: string }> = [];
  subscribed: string[] = [];
  quitCalled = false;

  async subscribe(channel: string): Promise<void> {
    this.subscribed.push(channel);
  }

  async publish(channel: string, payload: string): Promise<number> {
    this.published.push({ channel, payload });
    return 1;
  }

  async quit(): Promise<void> {
    this.quitCalled = true;
  }

  disconnect(): void {
    /* no-op */
  }
}

/** 暴露测试缝：用假客户端替代真实 ioredis 连接。 */
class TestableSync extends ExecutorTokenCacheSyncService {
  constructor(
    private readonly testSubscriber: FakeRedis,
    private readonly testPublisher: FakeRedis,
  ) {
    super({ get: () => undefined } as unknown as ConfigService);
  }

  protected createPublisherClient(): Redis {
    return this.testPublisher as unknown as Redis;
  }

  protected createSubscriberClient(): Redis {
    return this.testSubscriber as unknown as Redis;
  }
}

describe("ExecutorTokenCacheSyncService（ARCH-31 §3.7 驱逐广播）", () => {
  function harness() {
    const subscriber = new FakeRedis();
    const publisher = new FakeRedis();
    const svc = new TestableSync(subscriber, publisher);
    const onEvict = jest.fn();
    const onFlush = jest.fn();
    svc.bindHandlers({ onEvict, onFlush });
    svc.onModuleInit();
    return { svc, subscriber, publisher, onEvict, onFlush };
  }

  it("订阅接线：subscribe 到指定频道（订阅连接独立于发布连接）", () => {
    const { subscriber } = harness();
    expect(subscriber.subscribed).toEqual([EXECUTOR_TOKEN_EVICT_CHANNEL]);
  });

  it("合法消息触发 onEvict（载荷只取 address 字符串）", () => {
    const { subscriber, onEvict } = harness();
    subscriber.emit(
      "message",
      EXECUTOR_TOKEN_EVICT_CHANNEL,
      JSON.stringify({ address: "10.0.0.9:3002" }),
    );
    expect(onEvict).toHaveBeenCalledWith("10.0.0.9:3002");
  });

  it.each([
    ["非 JSON", "not-json"],
    ["缺 address", JSON.stringify({ foo: 1 })],
    ["address 非字符串", JSON.stringify({ address: 42 })],
    ["空 address", JSON.stringify({ address: "" })],
  ])("畸形载荷（%s）被忽略且不抛", (_label, payload) => {
    const { subscriber, onEvict } = harness();
    expect(() =>
      subscriber.emit("message", EXECUTOR_TOKEN_EVICT_CHANNEL, payload),
    ).not.toThrow();
    expect(onEvict).not.toHaveBeenCalled();
  });

  it("其他频道的消息不触发 onEvict", () => {
    const { subscriber, onEvict } = harness();
    subscriber.emit(
      "message",
      "some:other:channel",
      JSON.stringify({ address: "x" }),
    );
    expect(onEvict).not.toHaveBeenCalled();
  });

  it("ready 事件（首连+重连）触发 onFlush；回调抛错不外泄", () => {
    const { subscriber, onFlush } = harness();
    subscriber.emit("ready");
    subscriber.emit("ready");
    expect(onFlush).toHaveBeenCalledTimes(2);

    const broken = harness();
    broken.onFlush.mockImplementation(() => {
      throw new Error("handler boom");
    });
    expect(() => broken.subscriber.emit("ready")).not.toThrow();
  });

  it("publishTokenEviction 走发布连接并发送 JSON 载荷", async () => {
    const { svc, publisher, subscriber } = harness();
    await svc.publishTokenEviction("10.0.0.9:3002");
    expect(publisher.published).toEqual([
      {
        channel: EXECUTOR_TOKEN_EVICT_CHANNEL,
        payload: JSON.stringify({ address: "10.0.0.9:3002" }),
      },
    ]);
    // 订阅连接从未被用于发布
    expect(subscriber.published).toEqual([]);
  });

  it("发布失败被吞（其他实例走 TTL 兜底，不影响调用方）", async () => {
    const publisher = new FakeRedis();
    publisher.publish = async () => {
      throw new Error("connection refused");
    };
    const subscriber = new FakeRedis();
    const svc = new TestableSync(subscriber, publisher);
    svc.bindHandlers({ onEvict: jest.fn(), onFlush: jest.fn() });
    svc.onModuleInit();
    await expect(svc.publishTokenEviction("a:1")).resolves.toBeUndefined();
  });

  it("destroy 后 publish 是 no-op；onModuleDestroy 关闭两条连接", async () => {
    const { svc, publisher, subscriber } = harness();
    await svc.publishTokenEviction("a:1"); // publisher 惰性创建于首次发布
    await svc.onModuleDestroy();
    await svc.publishTokenEviction("a:1"); // destroyed：no-op
    expect(publisher.published).toHaveLength(1);
    expect(publisher.quitCalled).toBe(true);
    expect(subscriber.quitCalled).toBe(true);
  });
});
