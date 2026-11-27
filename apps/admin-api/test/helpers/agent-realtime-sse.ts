/**
 * Agent 实时流 e2e 的假传输层（L3：真 Nest + 真 PG/Redis + 假 Response）。
 *
 * 这里只替换 Express Response 的字节出口，不替换任何业务服务、仓储或队列：
 * streamSession 仍按生产代码写 SSE 帧，跨副本 relay 仍走真 Redis Pub/Sub。
 * 假 Response 把 `event: ...\ndata: ...\n\n` 解析成结构化帧，供 spec 以
 * 「收到哪几帧、帧里带什么副作用证据」断言，而不是只断言状态码。
 */
export interface SseFrame {
  event: string;
  data: string;
  payload: any;
  at: number;
}

export interface SseSink {
  /** 传给 AgentEventStreamService.streamSession 的 Express Response 替身。 */
  res: any;
  /** 已收到的全部帧（含 event / data / payload）。 */
  frames: SseFrame[];
  waitForFrame(
    event: string,
    predicate?: (payload: any) => boolean,
    timeoutMs?: number,
  ): Promise<SseFrame>;
  waitForEnd(timeoutMs?: number): Promise<void>;
}

export function createSseSink(): SseSink {
  const frames: SseFrame[] = [];
  const frameWaiters = new Set<() => void>();
  const endWaiters = new Set<() => void>();
  let buffer = "";
  let ended = false;

  const notifyFrames = (): void => {
    for (const wake of [...frameWaiters]) wake();
  };
  const notifyEnd = (): void => {
    for (const wake of [...endWaiters]) wake();
  };

  const res: any = {
    writableEnded: false,
    headersSent: false,
    setHeader(): any {
      return res;
    },
    getHeader(): undefined {
      return undefined;
    },
    flushHeaders(): void {
      res.headersSent = true;
    },
    flush(): void {
      // 生产代码对 compression 的 flush() 做 typeof 守卫；这里只需可调用。
    },
    write(chunk: string | Uint8Array): boolean {
      if (res.writableEnded) return true;
      buffer +=
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk).toString("utf8");

      let split: number;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const lines = raw.split("\n");
        // SSE 注释帧（`: ping\n\n`）不是业务事件。
        if (lines.some((line) => line.startsWith(":"))) continue;
        const event =
          lines
            .find((line) => line.startsWith("event:"))
            ?.slice("event:".length)
            .trim() || "message";
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart())
          .join("\n");
        let payload: any = data;
        if (data) {
          try {
            payload = JSON.parse(data);
          } catch {
            payload = data;
          }
        }
        frames.push({ event, data, payload, at: Date.now() });
      }
      notifyFrames();
      return true;
    },
    end(): any {
      if (res.writableEnded) return res;
      res.writableEnded = true;
      ended = true;
      notifyFrames();
      notifyEnd();
      return res;
    },
  };

  return {
    res,
    frames,
    async waitForFrame(event, predicate, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = frames.find(
          (frame) => frame.event === event && (!predicate || predicate(frame.payload)),
        );
        if (hit) return hit;
        if (ended) {
          throw new Error(
            `SSE ended before ${event} frame; got: ${frames
              .map((f) => f.event)
              .join(",")}`,
          );
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `timeout ${timeoutMs}ms waiting for ${event} frame; got: ${frames
              .map((f) => f.event)
              .join(",")}`,
          );
        }
        await new Promise<void>((resolve) => {
          let wake: () => void;
          const timer = setTimeout(() => {
            frameWaiters.delete(wake);
            resolve();
          }, Math.max(1, deadline - Date.now()));
          wake = () => {
            clearTimeout(timer);
            frameWaiters.delete(wake);
            resolve();
          };
          frameWaiters.add(wake);
        });
      }
    },
    async waitForEnd(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (!ended) {
        if (Date.now() >= deadline) {
          throw new Error(`timeout ${timeoutMs}ms waiting for SSE end`);
        }
        await new Promise<void>((resolve) => {
          let wake: () => void;
          const timer = setTimeout(() => {
            endWaiters.delete(wake);
            resolve();
          }, Math.max(1, deadline - Date.now()));
          wake = () => {
            clearTimeout(timer);
            endWaiters.delete(wake);
            resolve();
          };
          endWaiters.add(wake);
        });
      }
    },
  };
}

/** 轮询等待异步副作用（Redis Pub/Sub 订阅建立、DB 状态收敛等）。 */
export async function waitFor<T>(
  probe: () => T | undefined | null | false,
  timeoutMs = 10_000,
  label = "condition",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() >= deadline) {
      throw new Error(`timeout ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
