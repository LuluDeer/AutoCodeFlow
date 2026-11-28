import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { Queue } from "bullmq";
import { DataSource } from "typeorm";

import { createTestApp } from "./helpers/app.helper";
import { createSseSink, waitFor, type SseSink } from "./helpers/agent-realtime-sse";
import { AgentSessionService } from "../src/modules/agent/runtime/agent-session.service";
import {
  AgentEventStreamService,
  agentAbortKey,
  agentSteerKey,
} from "../src/modules/agent/runtime/agent-event-stream.service";
import {
  SteerInboxService,
  agentSteerInboxKey,
} from "../src/modules/agent/runtime/steer-inbox.service";
import { bindSessionAbort } from "../src/modules/agent/runtime/agent-runtime-realtime.collaborator";
import { AGENT_QUEUE_NAME } from "../src/modules/agent/runtime/agent.processor";

/**
 * Agent 实时流 / 跨副本控制 · 真实进程内 L3 验收。
 *
 * 级别 3：两个真 Nest 实例（独立 DI 容器）+ 真 PG + 真 Redis + 假 Response
 * 字节出口。所有业务服务、仓储、队列、Pub/Sub 都是生产实现；只把 SSE 的
 * `res.write` 换成可解析的 sink，以便断言「真的收到哪几帧」。
 *
 * 本 spec 由 scripts/verify-agent-realtime.sh 显式注入 AGENT_REALTIME_E2E=1
 * 与一次性库/Redis 逻辑库后运行。普通 `npm run test:e2e` 未注入这些 gate 时
 * 保持 skip，避免污染既有 e2e job；harness 会校验断言摘要文件存在且 5 组
 * 全过，缺失/跳过一律非零退出（不把 skip 报绿）。
 */
const RUN = process.env.AGENT_REALTIME_E2E === "1";
const gatedDescribe = RUN ? describe : describe.skip;

const STAMP = process.env.AGENT_REALTIME_STAMP ?? "";
const EXPECTED_DB = process.env.AGENT_REALTIME_DB_NAME ?? "";
const REDIS_DB = Number(process.env.AGENT_REALTIME_REDIS_DB ?? "");
const ASSERTIONS_FILE = process.env.AGENT_REALTIME_ASSERTIONS_FILE ?? "";

interface AssertionRecord {
  name: string;
  passed: true;
  evidence: Record<string, unknown>;
}

interface OpenStream {
  service: AgentEventStreamService;
  sink: SseSink;
  controller: AbortController;
  close(): Promise<void>;
}

gatedDescribe("Agent 实时流跨副本控制（两真 Nest + 真 PG/Redis，L3）", () => {
  jest.setTimeout(120_000);

  let appA: INestApplication;
  let appB: INestApplication;
  let dbA: DataSource;
  let streamA: AgentEventStreamService;
  let streamB: AgentEventStreamService;
  let sessionsA: AgentSessionService;
  let sessionsB: AgentSessionService;
  let steerInboxA: SteerInboxService;
  let steerInboxB: SteerInboxService;
  let redis: Redis;
  let queue: Queue;

  const trackedSessionIds: string[] = [];
  const openStreams: OpenStream[] = [];
  const assertions: AssertionRecord[] = [];

  function writeSummary(): void {
    if (!ASSERTIONS_FILE) return;
    mkdirSync(dirname(ASSERTIONS_FILE), { recursive: true });
    writeFileSync(
      ASSERTIONS_FILE,
      JSON.stringify(
        {
          stamp: STAMP,
          database: EXPECTED_DB,
          redisDb: REDIS_DB,
          passed: assertions.length === 5 && assertions.every((a) => a.passed),
          assertions,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  function record(name: string, evidence: Record<string, unknown>): void {
    assertions.push({ name, passed: true, evidence });
    writeSummary();
  }

  async function createSession(label: string) {
    const session = await sessionsA.create({
      kind: "chat",
      title: `${STAMP}-${label}`,
      triggerSource: "agent-realtime-e2e",
      createdBy: `e2e:${STAMP}`,
      context: { marker: `${STAMP}:${label}` },
      scope: {},
    });
    trackedSessionIds.push(session.id);
    return session;
  }

  /**
   * 等 relay 订阅真正建立：ioredis 的 status=ready 只表示 TCP 连接就绪，
   * SUBSCRIBE 命令可能仍在途。对同一 subscriber 连接发 PING，Redis 按命令顺序
   * 处理 ⇒ PING 返回时 SUBSCRIBE 必已生效，后续 publish 不会再被竞态吞掉。
   */
  async function ensureRelayReady(service: AgentEventStreamService): Promise<void> {
    const subscriber = (
      service as unknown as { subscriber?: { status?: string; ping(): Promise<unknown> } }
    ).subscriber;
    if (!subscriber) {
      throw new Error("relay subscriber 未建立（ensureSubscriber 未生效）");
    }
    await waitFor(
      () => (subscriber.status === "ready" ? true : undefined),
      10_000,
      "relay subscriber connection ready",
    );
    await subscriber.ping();
  }

  async function ensurePublisherReady(service: AgentEventStreamService): Promise<void> {
    const publisher = (service as unknown as { getPublisher(): { status?: string } }).getPublisher();
    await waitFor(
      () => (publisher.status === "ready" ? true : undefined),
      10_000,
      "relay publisher ready",
    );
  }

  /** SteerInbox 的 Redis 客户端也是惰性创建且 enableOfflineQueue=false。 */
  async function ensureSteerRedisReady(inbox: SteerInboxService): Promise<void> {
    const client = (
      inbox as unknown as { getRedis(): { status?: string } | null }
    ).getRedis();
    if (!client) throw new Error("steer inbox 未取得 Redis 客户端");
    await waitFor(
      () => (client.status === "ready" ? true : undefined),
      10_000,
      "steer inbox redis ready",
    );
  }

  async function openStream(
    service: AgentEventStreamService,
    sessionId: string,
  ): Promise<OpenStream> {
    const sink = createSseSink();
    const controller = new AbortController();
    let closed = false;
    const promise = service
      .streamSession(sessionId, {
        res: sink.res,
        signal: controller.signal,
      })
      .catch((err: unknown) => {
        // streamSession 自身不抛出业务错误；这里的 catch 只防止 unhandled
        // rejection，最终由 afterAll 的 activeStreams 断言暴露异常。
        throw err;
      });
    const entry: OpenStream = {
      service,
      sink,
      controller,
      async close() {
        if (closed) return;
        closed = true;
        if (!controller.signal.aborted) controller.abort();
        await Promise.race([
          promise.catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
      },
    };
    openStreams.push(entry);
    // streamSession 同步调用 ensureSubscriber；PING 保证 SUBSCRIBE 已真正生效，
    // 否则 Pub/Sub 建立竞态会把「跨副本」误判成「没收到」。
    await ensureRelayReady(service);
    await sink.waitForFrame("synced");
    return entry;
  }

  async function countRows(
    table: "agent_steps" | "agent_events",
    sessionId: string,
  ): Promise<number> {
    const rows = await dbA.query(
      `SELECT COUNT(*)::int AS n FROM "${table}" WHERE "sessionId" = $1`,
      [sessionId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async function jobCounts(): Promise<Record<string, number>> {
    const raw = await queue.getJobCounts(
      "waiting",
      "delayed",
      "prioritized",
      "active",
      "completed",
      "failed",
    );
    return Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [key, Number(value)]),
    );
  }

  async function jobsForSession(sessionId: string): Promise<number> {
    const jobs = await queue.getJobs([
      "waiting",
      "delayed",
      "prioritized",
      "active",
      "completed",
      "failed",
    ]);
    return jobs.filter((job) => job?.data?.sessionId === sessionId).length;
  }

  beforeAll(async () => {
    if (!RUN) throw new Error("AGENT_REALTIME_E2E=1 未注入，L3 spec 不应运行");
    if (!STAMP || !/^[A-Za-z0-9_-]+$/.test(STAMP)) {
      throw new Error(`AGENT_REALTIME_STAMP 非法: ${STAMP || "<empty>"}`);
    }
    if (!/^autoflow_agent_rt_e2e_[A-Za-z0-9_-]+$/.test(EXPECTED_DB)) {
      throw new Error(`AGENT_REALTIME_DB_NAME 非法: ${EXPECTED_DB || "<empty>"}`);
    }
    if (!Number.isInteger(REDIS_DB) || REDIS_DB < 1 || REDIS_DB > 14) {
      throw new Error(`AGENT_REALTIME_REDIS_DB 必须是 1..14: ${REDIS_DB}`);
    }

    // 两个真 Nest 实例：独立 DI 容器 / 独立进程内 accumulator / 独立 Redis
    // Pub/Sub 订阅；共享同一 throwaway PG 库与 Redis 逻辑库。
    appA = await createTestApp();
    appB = await createTestApp();
    dbA = appA.get(DataSource);
    streamA = appA.get(AgentEventStreamService);
    streamB = appB.get(AgentEventStreamService);
    sessionsA = appA.get(AgentSessionService);
    sessionsB = appB.get(AgentSessionService);
    steerInboxA = appA.get(SteerInboxService);
    steerInboxB = appB.get(SteerInboxService);

    expect(appA.get(ConfigService).get<number>("redis.db")).toBe(REDIS_DB);
    expect(appB.get(ConfigService).get<number>("redis.db")).toBe(REDIS_DB);
    expect(streamA).not.toBe(streamB);
    expect(sessionsA).not.toBe(sessionsB);
    expect(dbA).not.toBe(appB.get(DataSource));

    const [dbNameA] = await dbA.query("SELECT current_database() AS name");
    const [dbNameB] = await appB
      .get(DataSource)
      .query("SELECT current_database() AS name");
    expect(dbNameA.name).toBe(EXPECTED_DB);
    expect(dbNameB.name).toBe(EXPECTED_DB);
    expect(dbNameA.name).not.toBe("autoflow_test");
    expect(dbNameA.name).not.toBe("autoflow");

    redis = new Redis({
      host: process.env.REDIS_HOST ?? "localhost",
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      db: REDIS_DB,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    await redis.connect();
    queue = new Queue(AGENT_QUEUE_NAME, {
      connection: {
        host: process.env.REDIS_HOST ?? "localhost",
        port: Number(process.env.REDIS_PORT ?? 6379),
        password: process.env.REDIS_PASSWORD || undefined,
        db: REDIS_DB,
      },
    });
    await queue.waitUntilReady();
    writeSummary();
  });

  afterAll(async () => {
    for (const entry of openStreams) {
      try {
        await entry.close();
      } catch {
        // 清理阶段不让单个流的关停异常掩盖前序断言结果。
      }
    }
    try {
      await queue?.close();
    } catch {
      /* best effort */
    }
    try {
      if (redis?.status === "ready") {
        for (const sessionId of trackedSessionIds) {
          await redis.del(
            agentAbortKey(sessionId),
            agentSteerKey(sessionId),
            agentSteerInboxKey(sessionId),
          );
        }
      }
      redis?.disconnect();
    } catch {
      /* best effort */
    }

    if (dbA && trackedSessionIds.length > 0) {
      const ids = trackedSessionIds;
      const cleanup = async (sql: string) => {
        try {
          await dbA.query(sql, [ids]);
        } catch {
          /* best effort: harness 会按一次性库名整体 drop */
        }
      };
      await cleanup('DELETE FROM "agent_events" WHERE "sessionId" = ANY($1::uuid[])');
      await cleanup('DELETE FROM "agent_tool_calls" WHERE "sessionId" = ANY($1::uuid[])');
      await cleanup('DELETE FROM "agent_steps" WHERE "sessionId" = ANY($1::uuid[])');
      await cleanup('DELETE FROM "agent_sessions" WHERE id = ANY($1::uuid[])');
    }

    try {
      await appB?.close();
    } catch {
      /* best effort */
    }
    try {
      await appA?.close();
    } catch {
      /* best effort */
    }
    writeSummary();
  });

  it("① A 建会话+订阅，B 发 delta/relay；A 收到增量且新流的 synced.snapshot 带 content/reasoning/phase", async () => {
    const session = await createSession("delta");
    const first = await openStream(streamA, session.id);
    const eventsBefore = await countRows("agent_events", session.id);

    const tokenText = `token-from-B-${randomUUID().slice(0, 8)}`;
    const reasoningText = `reasoning-from-B-${randomUUID().slice(0, 8)}`;
    const phase = `phase-${randomUUID().slice(0, 8)}`;

    // B 的 publisher 也是惰性创建且 enableOfflineQueue=false；先等连接就绪，
    // 否则首帧 publish 会被 ioredis 直接拒绝（生产是 fail-open，测试不能误判）。
    await ensurePublisherReady(streamB);
    streamB.publishDelta(session.id, { type: "token_delta", text: tokenText });
    streamB.publishDelta(session.id, {
      type: "reasoning_delta",
      text: reasoningText,
    });
    streamB.publishDelta(session.id, { type: "phase_changed", phase });

    const tokenFrame = await first.sink.waitForFrame(
      "delta",
      // constant-time-exempt: e2e 夹具回读自身刚发布的 tokenText 断言帧到达，非凭据比较路径
      (p) => p?.type === "token_delta" && p?.text === tokenText,
    );
    const reasoningFrame = await first.sink.waitForFrame(
      "delta",
      (p) => p?.type === "reasoning_delta" && p?.text === reasoningText,
    );
    const phaseFrame = await first.sink.waitForFrame(
      "delta",
      (p) => p?.type === "phase_changed" && p?.phase === phase,
    );

    expect(tokenFrame.payload.text).toBe(tokenText);
    expect(reasoningFrame.payload.text).toBe(reasoningText);
    expect(phaseFrame.payload.phase).toBe(phase);
    expect(await countRows("agent_events", session.id)).toBe(eventsBefore);
    expect(first.sink.frames.some((f) => f.event === "error")).toBe(false);
    await first.close();

    // 新开一条 A 实例流：synced 边界必须带回 A 累加器已吸收的跨副本增量。
    const second = await openStream(streamA, session.id);
    const synced = await second.sink.waitForFrame(
      "synced",
      (p) => p?.sessionId === session.id,
    );
    expect(synced.payload.snapshot).toMatchObject({
      content: tokenText,
      reasoning: reasoningText,
      phase,
    });
    expect(synced.payload.activeStream).toBe(true);
    expect(synced.payload.hasMore).toBe(false);
    expect(synced.payload.truncated).toBe(false);
    await second.close();

    record("cross-instance-delta-and-snapshot", {
      sessionId: session.id,
      receivedDeltaFrames: [tokenFrame.event, reasoningFrame.event, phaseFrame.event],
      snapshot: synced.payload.snapshot,
      durableEventsAddedByDelta: 0,
    });
  });

  it("② 重放超过 5000 事件：synced.hasMore/truncated 为真，恰好 5000 帧且不误报完成", async () => {
    const session = await createSession("replay");
    // 会话创建自带 seq=1；补 seq=2..5002 共 5001 条 ⇒ 历史总量 5002。
    await dbA.query(
      `INSERT INTO "agent_events"
         ("id", "sessionId", "seq", "kind", "payload", "createdAt")
       SELECT gen_random_uuid(), $1::uuid, g, 'status_changed',
              '{"status":"pending"}'::jsonb, now()
       FROM generate_series(2, $2) AS g`,
      [session.id, 5002],
    );

    const stream = await openStream(streamA, session.id);
    const synced = await stream.sink.waitForFrame(
      "synced",
      (p) => p?.sessionId === session.id,
    );
    const eventFrames = stream.sink.frames.filter((f) => f.event === "event");

    expect(eventFrames).toHaveLength(5000);
    expect(Number(eventFrames[0].payload.seq)).toBe(1);
    expect(Number(eventFrames[eventFrames.length - 1].payload.seq)).toBe(5000);
    expect(synced.payload.hasMore).toBe(true);
    expect(synced.payload.truncated).toBe(true);
    expect(Number(synced.payload.lastSeq)).toBe(5000);
    expect(stream.sink.frames.some((f) => f.event === "resync_required")).toBe(false);
    expect(stream.sink.frames.some((f) => f.event === "error")).toBe(false);
    await stream.close();

    record("replay-over-5000-truncation", {
      sessionId: session.id,
      totalDbEvents: 5002,
      replayedFrames: eventFrames.length,
      lastSeq: synced.payload.lastSeq,
      hasMore: synced.payload.hasMore,
      truncated: synced.payload.truncated,
      falseCompletionFrames: 0,
    });
  });

  it("③ 终态会话追加消息：rejected_terminal + 零 step / 零 queue job / 零 durable event", async () => {
    const session = await createSession("terminal");
    await sessionsA.finish(session.id, "succeeded", { summary: "L3 fixture" });

    const stepsBefore = await countRows("agent_steps", session.id);
    const eventsBefore = await countRows("agent_events", session.id);
    const countsBefore = await jobCounts();
    const enqueueSpy = jest.spyOn(streamB as any, "enqueueResume");
    try {
      const result = await streamB.sendMessageAndResume(session.id, {
        content: "terminal sessions must not accept messages",
        mode: "followup",
        actor: "e2e-A",
      });

      expect(result).toMatchObject({
        sessionId: session.id,
        status: "succeeded",
        action: "rejected_terminal",
        stepSeq: 0,
      });
      expect(typeof result.reason).toBe("string");
      expect((result.reason ?? "").length).toBeGreaterThan(0);
      expect(enqueueSpy).not.toHaveBeenCalled();
    } finally {
      enqueueSpy.mockRestore();
    }

    expect(await countRows("agent_steps", session.id)).toBe(stepsBefore);
    expect(await countRows("agent_events", session.id)).toBe(eventsBefore);
    expect(await jobCounts()).toEqual(countsBefore);
    expect(await jobsForSession(session.id)).toBe(0);
    expect(await redis.exists(agentSteerKey(session.id))).toBe(0);
    expect(await redis.exists(agentSteerInboxKey(session.id))).toBe(0);

    record("terminal-append-zero-side-effects", {
      sessionId: session.id,
      action: "rejected_terminal",
      stepsAdded: 0,
      durableEventsAdded: 0,
      queueJobsAdded: 0,
      steerKeysAdded: 0,
    });
  });

  it("④ A cancel ⇒ B 的 in-flight binding 收到 AbortSignal，DB 收敛 aborted", async () => {
    const session = await createSession("abort");
    // 只置运行态作为 in-flight 前提；不启动真实 worker，避免假 LLM 噪声。
    await dbA.query('UPDATE "agent_sessions" SET status = $2 WHERE id = $1', [
      session.id,
      "running",
    ]);

    const channel = `abort:${session.id}`;
    const listenersBefore = (streamB as unknown as { emitter: { listenerCount(c: string): number } }).emitter.listenerCount(
      channel,
    );
    const binding = bindSessionAbort(streamB, session.id);
    try {
      expect(binding.signal.aborted).toBe(false);
      // subscribeAbort 会惰性建 relay 订阅；同一连接 PING 保证 SUBSCRIBE 已生效，
      // 再让 A 发 cancel，否则测的是 Redis 订阅竞态而不是跨副本信号链。
      await ensureRelayReady(streamB);
      expect(
        (streamB as unknown as { emitter: { listenerCount(c: string): number } }).emitter.listenerCount(channel),
      ).toBe(listenersBefore + 1);

      // A 的 publisher 同样惰性创建；requestAbort 里 set/publish 都是 fire-and-forget。
      await ensurePublisherReady(streamA);
      const cancelled = await streamA.requestAbort(session.id, "e2e-A");
      expect(cancelled).toMatchObject({ sessionId: session.id, aborted: true });

      await waitFor(() => (binding.signal.aborted ? true : undefined), 10_000, "B abort signal");
      const fresh = await sessionsB.requireById(session.id);
      expect(fresh.status).toBe("aborted");
      expect(await redis.get(agentAbortKey(session.id))).toBe("1");
    } finally {
      binding.dispose();
    }
    expect(
      (streamB as unknown as { emitter: { listenerCount(c: string): number } }).emitter.listenerCount(channel),
    ).toBe(listenersBefore);

    record("cross-instance-abort-signal-and-db", {
      sessionId: session.id,
      signalAbortedOnB: true,
      statusSeenByB: "aborted",
      redisAbortFlag: "1",
      listenerDisposed: true,
    });
  });

  it("⑤ A steer 入 inbox；B 工作副本仅在步边界 drain 且只消费一次", async () => {
    const session = await createSession("steer");
    await sessionsA.markWaiting(session.id, "e2e-approval");
    expect((await sessionsB.requireById(session.id)).status).toBe("waiting_input");

    const stepsBefore = await countRows("agent_steps", session.id);
    const countsBefore = await jobCounts();
    const content = `steer-from-A-${randomUUID().slice(0, 8)}`;
    await ensureSteerRedisReady(steerInboxA);
    await ensureSteerRedisReady(steerInboxB);
    const parked = await steerInboxA.park(session.id, content, 1, "waiting_input");
    expect(parked.intent).not.toBeNull();
    expect(parked.wake).toBe(true);

    const key = agentSteerInboxKey(session.id);
    // 当前实现把完整 SteerIntent（id/content/parkedAtStep）作为 JSON 写 list；
    // id 是跨副本幂等锚点，drain 不得重新 randomUUID。
    const readStoredIntents = async () =>
      (await redis.lrange(key, 0, -1)).map(
        (raw) =>
          JSON.parse(raw) as {
            id: string;
            content: string;
            parkedAtStep: number;
          },
      );
    const stored = await readStoredIntents();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: parked.intent?.id,
      content,
      parkedAtStep: 1,
    });
    expect(typeof stored[0].id).toBe("string");
    expect(stored[0].id.length).toBeGreaterThan(0);
    expect(await redis.ttl(key)).toBeGreaterThan(0);

    // 非步边界：不得提前取走（否则另一副本的 worker 会永远丢掉这条 steer）。
    const nonBoundary = await steerInboxB.drain(session.id, null);
    expect(nonBoundary.intents).toHaveLength(0);
    expect((await readStoredIntents()).map((i) => i.id)).toEqual([stored[0].id]);

    const drained = await steerInboxB.drain(session.id, 1);
    expect(drained.intents.map((intent) => intent.content)).toEqual([content]);
    // 幂等锚点：Redis 里的 id 原样交付给 B，未被 drain 重造。
    expect(drained.intents.map((intent) => intent.id)).toEqual([stored[0].id]);
    expect(new Set(drained.intents.map((intent) => intent.id)).size).toBe(1);

    const secondDrain = await steerInboxB.drain(session.id, 2);
    expect(secondDrain.intents).toHaveLength(0);
    expect(await redis.exists(key)).toBe(0);

    expect(await countRows("agent_steps", session.id)).toBe(stepsBefore);
    expect(await jobCounts()).toEqual(countsBefore);
    expect(await jobsForSession(session.id)).toBe(0);

    record("cross-instance-steer-single-drain", {
      sessionId: session.id,
      parkedOn: "A",
      drainedOn: "B",
      intentId: parked.intent?.id,
      nonBoundaryConsumed: 0,
      boundaryIntents: 1,
      secondBoundaryIntents: 0,
      stepsAdded: 0,
      queueJobsAdded: 0,
    });
  });
});
