/**
 * Agent 会话实时事件流：Redis Pub/Sub 跨实例扇出 + agent_events 表 seq 重放 + SSE 推送。
 *
 * ## 为什么重放 + 订阅缺一不可
 * Redis Pub/Sub 是「此时此刻」的，断线/重连/跨副本建连时此前产生的帧不会重来；
 * `agent_events` 是持久事实。因此每个订阅者先按 `seq > fromSeq` 从表里补齐历史，
 * 再实时转发 Pub/Sub 帧，中间用一条 `synced` 事件标明「重放到哪、当前状态、是否
 * 有活跃 worker」——客户端据此去重（按 seq）与决定是否继续等待。
 *
 * ## 队列上限与 resync_required
 * 每个订阅者有界队列（默认 512 帧）。消费慢于生产时溢出不是「丢几帧了事」：
 * 客户端拿到 `resync_required` 并主动断开，重连时带上最后已见 seq 重新走重放，
 * 这样任何丢失都能被检出、补齐，而不是静默产生一个缺口。
 *
 * ## fail-open 纪律
 * Redis 不可用不影响主链：发布/订阅失败只 warn，SSE 侧仍有 DB 重放与 15s ping。
 * 事件写入失败也不影响推理——本服务只做转发，不决定会话状态。
 */
import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectDataSource } from "@nestjs/typeorm";
import type { DataSource } from "typeorm";
import type { Response } from "express";
import Redis from "ioredis";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import type { AgentSessionStatus } from "../entities/agent-session.entity";
import { AgentSessionService, redactForStorage } from "./agent-session.service";
import type {
  AgentStreamReplayMeta,
  AgentStreamReplayResult,
  StreamSnapshotPayload,
} from "./agent-event-stream.contract";

/** 单次重放最多取多少条（多取 1 条用于判定 hasMore，发送仍只发 5000 条）。 */
const REPLAY_BATCH_LIMIT = 5000;

/** 跨实例事件中转频道（全局唯一；载荷自带 sessionId，订阅端按会话过滤）。 */
export const AGENT_EVENT_RELAY_CHANNEL = "acf:agent-events:relay";
/** 中断信号 key（DB CAS 之外的高频通知通道）。 */
export const agentAbortKey = (sessionId: string): string =>
  `acf:agent-abort:${sessionId}`;
/** 运行中 steer 意图列表（跨副本，runtime 在步边界 drain）。 */
export const agentSteerKey = (sessionId: string): string =>
  `acf:agent-steer:${sessionId}`;
/** 本地中断频道前缀（EventEmitter 事件名）。 */
const abortChannel = (sessionId: string): string => `abort:${sessionId}`;

export interface DurableAgentEvent {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
  createdAt?: string | Date;
}

export type AgentDeltaFrame =
  | { type: "token_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_delta"; name: string; args?: unknown }
  | { type: "phase_changed"; phase: string }
  | { type: "status_changed"; status: AgentSessionStatus };

export interface StreamSessionOptions {
  fromSeq?: number;
  res: Response;
  signal?: AbortSignal;
}

export interface AgentAbortResult {
  sessionId: string;
  status: AgentSessionStatus;
  aborted: boolean;
}

export interface SendMessageOptions {
  content: string;
  mode?: "followup" | "steer";
  actor: string;
}

export interface SendMessageResult {
  sessionId: string;
  status: AgentSessionStatus;
  stepSeq: number;
  /** 终态会话返回 rejected_terminal；旧调用方仍只消费 steered/enqueued 两值。 */
  action: "steered" | "enqueued" | "rejected_terminal";
  /** 仅 rejected_terminal 携带：拒绝原因（简短、可直接展示）。 */
  reason?: string;
}

type RelayEnvelope =
  | {
      instanceId: string;
      sessionId: string;
      event: DurableAgentEvent;
      delta?: undefined;
      abort?: undefined;
    }
  | {
      instanceId: string;
      sessionId: string;
      delta: AgentDeltaFrame;
      event?: undefined;
      abort?: undefined;
    }
  | {
      instanceId: string;
      sessionId: string;
      abort: true;
      event?: undefined;
      delta?: undefined;
    };

/** relay 载荷（去掉 instanceId；显式保留判别字段，避免联合被 Omit 折叠）。 */
type RelayPayload =
  | { sessionId: string; event: DurableAgentEvent }
  | { sessionId: string; delta: AgentDeltaFrame }
  | { sessionId: string; abort: true };

interface Subscriber {
  sessionId: string;
  queue: Array<{ event: string; payload: unknown }>;
  overflowed: boolean;
  wake: () => void;
}

const DEFAULT_QUEUE_LIMIT = 512;
const PING_INTERVAL_MS = 15_000;
const PUBLISH_TIMEOUT_MS = 3_000;
const STEER_TTL_SECONDS = 60 * 60 * 24;
const TERMINAL_STATUSES: readonly string[] = [
  "succeeded",
  "failed",
  "aborted",
  "budget_exceeded",
];

/** 活跃流快照：token/reasoning/phase 按会话聚合，供 mid-stream 刷新续传。 */
export class ActiveStreamAccumulator {
  private readonly entries = new Map<
    string,
    {
      tokens: string[];
      reasoning: string[];
      phase: string | null;
      lastSeq: number;
      updatedAt: number;
    }
  >();

  /** 记录一帧；token/reasoning 片段有上限，防止长会话把内存吃光。 */
  append(sessionId: string, frame: AgentDeltaFrame, seq?: number): void {
    const entry = this.entries.get(sessionId) ?? {
      tokens: [],
      reasoning: [],
      phase: null,
      lastSeq: 0,
      updatedAt: 0,
    };
    if (frame.type === "token_delta") {
      entry.tokens.push(frame.text);
      if (entry.tokens.length > 256) entry.tokens.shift();
    } else if (frame.type === "reasoning_delta") {
      entry.reasoning.push(frame.text);
      if (entry.reasoning.length > 256) entry.reasoning.shift();
    } else if (frame.type === "phase_changed") {
      entry.phase = frame.phase;
    }
    if (seq !== undefined) entry.lastSeq = Math.max(entry.lastSeq, seq);
    entry.updatedAt = Date.now();
    this.entries.set(sessionId, entry);
  }

  /** 刷新续传快照：mid-stream 刷新时一次拿到完整片段、阶段与位置，不闪断。 */
  snapshot(sessionId: string): {
    content: string;
    reasoning: string;
    phase: string | null;
    lastSeq: number;
    active: boolean;
  } | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    return {
      content: entry.tokens.join(""),
      reasoning: entry.reasoning.join(""),
      phase: entry.phase,
      lastSeq: entry.lastSeq,
      active: Date.now() - entry.updatedAt < 60_000,
    };
  }

  clear(sessionId: string): void {
    this.entries.delete(sessionId);
  }
}

@Injectable()
export class AgentEventStreamService implements OnModuleDestroy {
  private readonly logger = new Logger(AgentEventStreamService.name);
  private readonly instanceId = randomBytes(12).toString("hex");
  private readonly emitter = new EventEmitter();
  private readonly subscribers = new Set<Subscriber>();
  private readonly steers = new Map<string, string[]>();
  /**
   * 本进程已见到的终态事件 seq（sessionId → terminal seq）。
   *
   * 用 seq 而非单纯 Set 是为了支持新世代：failed → reopenForResume → running
   * 后，运行帧的 seq 必然大于终态 seq，应当放行；单纯 Set 只增不减会永久吞帧。
   * DB 重放只发历史帧，**不写这里**，避免历史终态污染当前世代。
   */
  private readonly terminalKinds = new Map<string, number>();
  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;
  private destroyed = false;
  /** 活跃流快照（供 mid-stream 刷新；与 Pub/Sub 是两个正交的通道）。 */
  readonly accumulator = new ActiveStreamAccumulator();

  /**
   * 同步终态询问：本进程是否已从本地发布或跨副本 relay 中见过终态。
   * 不读库、不 await；供 runtime 在写 running/started 前做同段守卫。
   * DB 重放的历史终态不写此标记，避免旧世代污染当前世代。
   */
  hasTerminalEvent(sessionId: string): boolean {
    return this.terminalKinds.has(sessionId);
  }

  /**
   * 恢复成功后清理终态屏障：显式调用本方法即代表调用方已确认 reopen/markRunning
   * 成功，无条件放行，不再比较 atSeq 与终态 event.seq。
   *
   * 原因：stepSeq（totalSteps+1）与 event.seq 是两个独立计数器，跨命名空间比较
   * 会误拒合法恢复；宁可少挡一个过期 running 帧，也不能让合法恢复永久吞帧。
   * atSeq 仅作可选诊断提示保留，不参与判定。
   */
  clearTerminalForResume(sessionId: string, _atSeq?: number): void {
    this.terminalKinds.delete(sessionId);
  }

  /**
   * 装配点（AgentModule.onModuleInit）：把消息续跑接到 agent-jobs。
   * 不直接 @InjectQueue，避免把 BullMQ 拖进纯逻辑单测与 workbench 的惰性解析。
   */
  enqueueResume:
    | ((
        sessionId: string,
        expectedStep: number,
        mode: "followup" | "steer",
      ) => Promise<void>)
    | null = null;

  /** 有未处置审批单时不自动恢复（由 AgentModule 注入 approvals.hasPendingForSession）。 */
  hasPendingApprovals: ((sessionId: string) => Promise<boolean>) | null = null;

  constructor(
    private readonly config: ConfigService,
    @Inject(AgentSessionService)
    private readonly sessions: AgentSessionService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {
    // 本进程内事件不经过 Redis（避免回声环）；远端帧由订阅端走同一条派发链。
    this.emitter.setMaxListeners(0);
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  private redisOptions(): Record<string, unknown> {
    return {
      host: this.config.get("redis.host"),
      port: this.config.get<number>("redis.port"),
      password: this.config.get("redis.password"),
      db: this.config.get<number>("redis.db", 0),
      retryStrategy: (times: number) => Math.min(times * 100, 3_000),
      ...(this.config.get("redis.tls") === true
        ? {
            tls: {
              rejectUnauthorized:
                this.config.get("redis.tlsRejectUnauthorized") !== false,
            },
          }
        : {}),
    };
  }

  private getPublisher(): Redis {
    if (!this.publisher || this.publisher.status === "end") {
      this.publisher = new Redis({
        ...this.redisOptions(),
        commandTimeout: PUBLISH_TIMEOUT_MS,
        enableOfflineQueue: false,
      });
      this.publisher.on("error", (err: Error) => {
        this.logger.warn(
          `agent 事件流发布连接错误（fail-open）: ${err.message}`,
        );
      });
    }
    return this.publisher;
  }

  private ensureSubscriber(): void {
    if (this.subscriber || this.destroyed) return;
    this.subscriber = new Redis(this.redisOptions());
    this.subscriber.on("error", (err: Error) => {
      this.logger.warn(
        `agent 事件流订阅连接错误（fail-open，退化为单实例）: ${err.message}`,
      );
    });
    this.subscriber.on("message", (channel: string, raw: string) => {
      if (channel !== AGENT_EVENT_RELAY_CHANNEL) return;
      this.handleRemote(raw);
    });
    void this.subscriber
      .subscribe(AGENT_EVENT_RELAY_CHANNEL)
      .catch((err: Error) => {
        this.logger.warn(`agent 事件流订阅失败（fail-open）: ${err.message}`);
      });
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    for (const sub of this.subscribers) sub.wake();
    this.subscribers.clear();
    for (const client of [this.publisher, this.subscriber]) {
      if (!client) continue;
      try {
        void client.quit().catch(() => client.disconnect());
      } catch {
        client.disconnect();
      }
    }
    this.publisher = null;
    this.subscriber = null;
  }

  // ── 发布 ────────────────────────────────────────────────────────────────

  /** 持久化事件落库后调用：本进程直接派发 + 远端通过 Redis 扇出。 */
  publishDurableEvent(sessionId: string, event: DurableAgentEvent): void {
    // 终态竞态防护：如果终态 durable 事件已经先到达（快速完成会话常见），
    // 后到的 running/started 事件不得再投影成「正在运行」；否则前端会永久卡在
    // 运行中。读终态与 running 判定放在同一同步段，中间不 await。
    const kind = String(event.kind ?? "");
    const payload = event.payload as Record<string, unknown> | undefined;
    const isRunningStart =
      kind === "session_started" ||
      kind === "session_running" ||
      ((kind === "status_changed" || kind === "session_status_changed") &&
        ["running", "started"].includes(String(payload?.status ?? "")));
    if (isRunningStart && this.terminalKinds.has(sessionId)) return;

    this.dispatch(sessionId, "event", event);
    if (
      TERMINAL_STATUSES.includes(kind) ||
      TERMINAL_STATUSES.includes(String(payload?.status ?? ""))
    ) {
      // 记录终态 seq，作为后续恢复清理的 epoch 基准。
      this.terminalKinds.set(sessionId, Number(event.seq ?? 0));
    }
    const phase = payload?.phase;
    if (typeof phase === "string") {
      this.accumulator.append(
        sessionId,
        { type: "phase_changed", phase },
        event.seq,
      );
    }
    this.relay({ sessionId, event });
  }

  /** LLM 增量帧：只有实时通道，不写库（正文由 step 事件承载）。 */
  publishDelta(sessionId: string, frame: AgentDeltaFrame): void {
    this.accumulator.append(sessionId, frame);
    this.dispatch(sessionId, "delta", frame);
    this.relay({ sessionId, delta: frame });
  }

  private relay(payload: RelayPayload): void {
    if (this.destroyed) return;
    try {
      const envelope: RelayEnvelope = {
        instanceId: this.instanceId,
        ...payload,
      };
      const raw = JSON.stringify(envelope);
      void this.getPublisher()
        .publish(AGENT_EVENT_RELAY_CHANNEL, raw)
        .catch((err: Error) => {
          this.logger.warn(
            `agent 事件流广播失败（本实例仍可见）: ${err.message}`,
          );
        });
    } catch (err: unknown) {
      this.logger.warn(
        `agent 事件流广播序列化失败（本实例仍可见）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private handleRemote(raw: string): void {
    try {
      const envelope = JSON.parse(raw) as RelayEnvelope;
      if (envelope.instanceId === this.instanceId) return;
      if (envelope.abort) {
        this.emitter.emit(abortChannel(envelope.sessionId));
        return;
      }
      if ("event" in envelope) {
        const kind = String(envelope.event.kind ?? "");
        const payload = envelope.event.payload as
          Record<string, unknown> | undefined;
        const status = String(payload?.status ?? "");
        const isRunningStart =
          kind === "session_started" ||
          kind === "session_running" ||
          ((kind === "status_changed" || kind === "session_status_changed") &&
            ["running", "started"].includes(status));
        if (isRunningStart && this.terminalKinds.has(envelope.sessionId))
          return;
        if (
          TERMINAL_STATUSES.includes(kind) ||
          TERMINAL_STATUSES.includes(status)
        ) {
          this.terminalKinds.set(
            envelope.sessionId,
            Number(envelope.event.seq ?? 0),
          );
        }
        this.dispatch(envelope.sessionId, "event", envelope.event);
      } else if ("delta" in envelope) {
        // 跨副本 delta 也要进本实例快照，否则远端产生的内容在本地 mid-stream
        // 刷新时补不回来；本地 publishDelta 已 append，这里不会重复计数（实例自身帧被过滤）。
        this.accumulator.append(envelope.sessionId, envelope.delta);
        this.dispatch(envelope.sessionId, "delta", envelope.delta);
      }
    } catch (err: unknown) {
      this.logger.warn(
        `agent 事件流消息解析失败（忽略）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private dispatch(sessionId: string, event: string, payload: unknown): void {
    for (const sub of this.subscribers) {
      if (sub.sessionId !== sessionId) continue;
      if (sub.queue.length >= this.queueLimit()) {
        if (!sub.overflowed) {
          sub.overflowed = true;
          sub.queue.push({
            event: "resync_required",
            payload: { sessionId, reason: "subscriber_queue_overflow" },
          });
        }
        sub.wake();
        continue;
      }
      sub.queue.push({ event, payload });
      sub.wake();
    }
  }

  private queueLimit(): number {
    const configured = this.config.get<number>("agent.streamQueueLimit");
    return Number.isFinite(configured) && configured > 0
      ? Math.min(configured, 4096)
      : DEFAULT_QUEUE_LIMIT;
  }

  subscribeAbort(sessionId: string, cb: () => void): () => void {
    // runtime worker 副本可能没有任何 SSE 连接；订阅 abort 时也要建立 relay，
    // 否则 handleRemote 的跨副本 abort 信号永远到不了这里。
    this.ensureSubscriber();
    const channel = abortChannel(sessionId);
    this.emitter.on(channel, cb);
    return () => this.emitter.off(channel, cb);
  }

  // ── SSE ─────────────────────────────────────────────────────────────────

  async streamSession(
    sessionId: string,
    { fromSeq, res, signal }: StreamSessionOptions,
  ): Promise<void> {
    this.ensureSubscriber();
    const session = await this.sessions.requireById(sessionId);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const write = (chunk: string): void => {
      if (res.writableEnded) return;
      res.write(chunk);
      const flush = (res as unknown as { flush?: () => void }).flush;
      if (typeof flush === "function") flush.call(res);
    };
    const sendEvent = (event: string, payload: unknown): void => {
      write(`event: ${event}\n`);
      write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const ping = (): void => {
      if (!res.writableEnded) write(": ping\n\n");
    };

    let wake: () => void = () => undefined;
    const sub: Subscriber = {
      sessionId,
      queue: [],
      overflowed: false,
      wake: () => wake(),
    };
    this.subscribers.add(sub);
    let timer: ReturnType<typeof setInterval> | null = null;
    const onAbort = (): void => wake();

    try {
      // 先重放持久事件，再发 synced 边界；重放期间的实时帧进有界队列。
      const replayMeta: AgentStreamReplayMeta = {
        hasMore: false,
        truncated: false,
        count: 0,
      };
      const replayed = await this.replay(
        sessionId,
        fromSeq ?? 0,
        sendEvent,
        replayMeta,
      );
      // 终态竞态：重放若已包含终态事件，后续队列中的 running/started 帧必须丢弃；
      // 扫描与标记放在同一同步段，避免跨 await 的竞态窗口。
      for (const queued of sub.queue) {
        if (queued.event !== "event") continue;
        const ev = queued.payload as Partial<DurableAgentEvent> | undefined;
        const kind = String(ev?.kind ?? "");
        const status = String(
          (ev?.payload as Record<string, unknown> | undefined)?.status ?? "",
        );
        if (
          TERMINAL_STATUSES.includes(kind) ||
          TERMINAL_STATUSES.includes(status)
        ) {
          this.terminalKinds.set(sessionId, Number(ev?.seq ?? 0));
        }
      }
      const snapshotRecord = this.accumulator.snapshot(sessionId);
      const activeStream = snapshotRecord?.active ?? false;
      // 快照按契约只暴露 content/reasoning/phase；lastSeq/active 仍由帧顶层承载。
      let snapshot: StreamSnapshotPayload | undefined;
      if (snapshotRecord) {
        snapshot = {
          content: snapshotRecord.content,
          reasoning: snapshotRecord.reasoning,
          ...(snapshotRecord.phase !== null
            ? { phase: snapshotRecord.phase }
            : {}),
        };
      }
      // status 必须取重放之后的最新快照：重放前的 session 可能仍是 running，
      // 而 REST/终态写入已在重放期间完成，旧快照会盖掉真实终态。
      const fresh = await this.sessions.findById(sessionId).catch(() => null);
      sendEvent("synced", {
        sessionId,
        lastSeq: replayed,
        status: fresh?.status ?? session.status,
        activeStream,
        ...(snapshot ? { snapshot } : {}),
        hasMore: replayMeta.hasMore,
        truncated: replayMeta.truncated,
      });

      timer = setInterval(ping, PING_INTERVAL_MS);
      timer.unref?.();
      if (signal) signal.addEventListener("abort", onAbort);

      for (;;) {
        if (signal?.aborted || res.writableEnded) break;
        if (sub.queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = () => undefined;
          continue;
        }
        const frame = sub.queue.shift();
        if (!frame) continue;
        if (frame.event === "event") {
          const ev = frame.payload as Partial<DurableAgentEvent> | undefined;
          const kind = String(ev?.kind ?? "");
          const status = String(
            (ev?.payload as Record<string, unknown> | undefined)?.status ?? "",
          );
          const isRunningStart =
            kind === "session_started" ||
            kind === "session_running" ||
            ((kind === "status_changed" || kind === "session_status_changed") &&
              ["running", "started"].includes(status));
          if (isRunningStart && this.terminalKinds.has(sessionId)) continue;
          if (
            TERMINAL_STATUSES.includes(kind) ||
            TERMINAL_STATUSES.includes(status)
          ) {
            this.terminalKinds.set(sessionId, Number(ev?.seq ?? 0));
          }
        }
        sendEvent(frame.event, frame.payload);
        if (frame.event === "resync_required") break;
      }
    } catch (err: unknown) {
      this.logger.warn(
        `agent 事件流中断: session=${sessionId} — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      sendEvent("error", { sessionId, message: "事件流读取失败" });
    } finally {
      this.subscribers.delete(sub);
      if (timer) clearInterval(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (!res.writableEnded) res.end();
    }
  }

  /**
   * 从 agent_events 表按 seq 递增重放。只投影 SSE 需要的四列，payload 原样透传
   * （写入侧已 sanitize/redact，不在这里二次改写历史事实）。
   */
  private async replay(
    sessionId: string,
    fromSeq: number,
    sendEvent: (event: string, payload: unknown) => void,
    meta?: AgentStreamReplayMeta,
  ): Promise<number> {
    // 生产为 PG DataSource；查询失败如实上抛，由 streamSession 发 error 帧，
    // 绝不伪造空历史。多取 1 条判定是否还有历史；发送仍严格不超过 5000 条。
    const rows = (await this.dataSource.query(
      `SELECT "seq", "kind", "payload", "createdAt" FROM "agent_events"
       WHERE "sessionId" = $1::uuid AND "seq" > $2 ORDER BY "seq" ASC LIMIT $3`,
      [sessionId, Math.max(0, Math.trunc(fromSeq)), REPLAY_BATCH_LIMIT + 1],
    )) as DurableAgentEvent[];
    const hasMore = rows.length > REPLAY_BATCH_LIMIT;
    const visible = hasMore ? rows.slice(0, REPLAY_BATCH_LIMIT) : rows;
    for (const row of visible) {
      // DB 重放是历史事实：只发给客户端补历史，**不写 terminalKinds**。
      // 旧世代的终态事件不得污染当前世代的 running 放行判定。
      sendEvent("event", {
        seq: Number(row.seq),
        kind: row.kind,
        payload: row.payload,
        createdAt: row.createdAt,
      });
    }
    const result: AgentStreamReplayResult = {
      lastSeq: visible.length
        ? Number(visible[visible.length - 1].seq)
        : fromSeq,
      hasMore,
      truncated: hasMore,
      count: visible.length,
    };
    if (meta) {
      meta.hasMore = result.hasMore;
      meta.truncated = result.truncated;
      meta.count = result.count;
    }
    return result.lastSeq;
  }

  // ── 中断 ────────────────────────────────────────────────────────────────

  /** DB 条件写置 aborted（幂等），并广播 Redis + 本地 EventEmitter。 */
  async requestAbort(
    sessionId: string,
    actor = "admin",
  ): Promise<AgentAbortResult> {
    const session = await this.sessions.requireById(sessionId);
    const attempted = !TERMINAL_STATUSES.includes(session.status);
    if (attempted) {
      // finish() 是 void 的幂等条件写：并发终态只有一个赢家，输家 affected=0。
      // 不靠返回值（它不返回），改为写入后重读状态判定本次是否真的赢了。
      await this.sessions.finish(sessionId, "aborted", {
        errorMessage: `已被 ${redactForStorage(actor)} 人工中止`,
      });
    }
    try {
      await this.getPublisher().set(agentAbortKey(sessionId), "1", "EX", 600);
    } catch (err: unknown) {
      this.logger.warn(
        `agent abort Redis 广播失败（DB 状态已落）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    this.emitter.emit(abortChannel(sessionId));
    this.relay({ sessionId, abort: true });
    const fresh = await this.sessions.findById(sessionId);
    // attempted 防止「原本已 aborted」被算成本次成功；fresh 状态确认并发赢家。
    const aborted = attempted && fresh?.status === "aborted";
    return {
      sessionId,
      status: fresh?.status ?? (aborted ? "aborted" : session.status),
      aborted,
    };
  }

  // ── 消息追加 / 续跑 ─────────────────────────────────────────────────────

  async sendMessageAndResume(
    sessionId: string,
    { content, mode = "followup", actor }: SendMessageOptions,
  ): Promise<SendMessageResult> {
    const actorText = redactForStorage(actor);
    const clean = redactForStorage(content);
    const session = await this.sessions.requireById(sessionId);
    // 终态拒绝必须前移到 appendStep 之前：生产 appendStep 虽自带终态守卫，
    // 内存替身/旁路装配仍会先写 step。先判后写才能保证「拒绝即零副作用」
    // （零 step、零 step_appended 事件、零 steer/队列）。stepSeq=0 表示未写入。
    if (["succeeded", "aborted", "budget_exceeded"].includes(session.status)) {
      return {
        sessionId,
        status: session.status,
        stepSeq: 0,
        action: "rejected_terminal",
        reason: `会话已处于终态（${session.status}），不能继续追加消息`,
      };
    }
    // 先持久化 user step（workbench 侧不重复写），再决定 steer 还是入队。
    const step = await this.sessions.appendStep(sessionId, {
      role: "user",
      content: `[${actorText}] ${clean}`,
    });
    const stepSeq = Number(step.seq ?? 0);
    // appendStep 自身已写 step_appended 事件（并在 eventSeq 带回 seq），这里只做
    // 实时转发——绝不写第二条事件：事件流里同一事实出现两次会让按 seq 去重的
    // 客户端把一次用户消息读成两次输入。
    this.publishDurableEvent(sessionId, {
      seq: step.eventSeq ?? 0,
      kind: "step_appended",
      payload: { role: "user", stepSeq },
      createdAt: new Date().toISOString(),
    });

    // 运行中或仍有未处置审批单：不能入第二个 worker，走跨副本 steer 列表。
    const pending =
      session.status === "waiting_input" &&
      this.hasPendingApprovals !== null &&
      (await this.hasPendingApprovals(sessionId).catch(() => true));
    if (session.status === "running" || pending) {
      const steer = `[用户补充（${actorText}）] ${clean}`;
      this.steers.set(sessionId, [
        ...(this.steers.get(sessionId) ?? []),
        steer,
      ]);
      try {
        const key = agentSteerKey(sessionId);
        await this.getPublisher().rpush(key, steer);
        await this.getPublisher().expire(key, STEER_TTL_SECONDS);
      } catch (err: unknown) {
        this.logger.warn(
          `agent steer Redis 写入失败（内存兜底仍生效）: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return { sessionId, status: session.status, stepSeq, action: "steered" };
    }

    if (session.status === "failed") {
      const reopened = await this.sessions.reopenForResume(sessionId);
      // 恢复成功后按新世代 seq 清理终态屏障，避免后到 running 帧被永久吞掉。
      // reopenForResume 返回 false（状态已变/不可重开）时保持屏障不动。
      if (reopened) this.clearTerminalForResume(sessionId, stepSeq);
    }
    if (this.enqueueResume) {
      await this.enqueueResume(sessionId, stepSeq, mode);
    }
    return { sessionId, status: "pending", stepSeq, action: "enqueued" };
  }

  /** runtime 步边界调用：优先 Redis 持久 steer，失败回落本进程内存。 */
  async drainSteers(sessionId: string): Promise<string[]> {
    let remote: string[] = [];
    try {
      const key = agentSteerKey(sessionId);
      remote = await this.getPublisher().lrange(key, 0, -1);
      if (remote.length) await this.getPublisher().del(key);
    } catch (err: unknown) {
      this.logger.warn(
        `agent steer Redis 读取失败（回落内存）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const local = this.steers.get(sessionId) ?? [];
    this.steers.delete(sessionId);
    // Redis 与内存可能各有一份（同进程写入时两处都写了），按内容去重。
    return [...new Set([...remote, ...local])];
  }
}
