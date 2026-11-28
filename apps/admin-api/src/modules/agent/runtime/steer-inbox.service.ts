/**
 * N8 · steer inbox 的装配层（跨副本 Redis list + 进程内兜底）。
 *
 * 纯状态机在 `steer-inbox.ts`（零依赖、21 例反证已由 steer-inbox.spec 覆盖）；
 * 本文件负责按 sessionId 存/取，并把 park 的正文写进 Redis list，使**另一副本**
 * 的 worker 在步边界也能 drain 到——旧版只有进程内 Map，worker 被调度到别的
 * 副本时 steer 直接丢失。
 *
 * 与 `AgentEventStreamService` 的 `acf:agent-steer:<sid>` 刻意**分 key**：那条
 * 通道由 `sendMessageAndResume` 写、`drainSteers` 读，两个消费者共读一份 list
 * 会互相抢走对方的 steer。独立 key 让两条写入路径各自完整，runtime 两边都 drain。
 *
 * Redis 缺席（配置缺失 / 连接失败 / 单实例测试 `new SteerInboxService()`）时
 * 保留原来的进程内 Map 行为：语义与既有测试逐字兼容，只是没有跨副本能力。
 */
import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import {
  drainAtStepBoundary,
  emptyInbox,
  parkIntent,
  shouldWake,
  type DrainResult,
  type SteerInbox,
  type SteerIntent,
  type StepBoundary,
} from "./steer-inbox";

/** 跨副本 steer 意图列表（与 stream 的 agentSteerKey 分离）。 */
export const agentSteerInboxKey = (sessionId: string): string =>
  `acf:agent-steer-inbox:${sessionId}`;

const STEER_TTL_SECONDS = 60 * 60 * 24;

/** Redis 最小写入面：测试用内存替身即可，不必连真实 Redis。 */
export interface SteerRedisPort {
  rpush(key: string, value: string): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  del(key: string): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface SteerParkResult {
  /** 实际写入的意图；被终态/未知状态拒绝时为 null。 */
  intent: SteerIntent | null;
  /** shouldWake 判定：终态一律 false，绝不复活死意图。 */
  wake: boolean;
}

/**
 * Redis list 元素 = 完整 SteerIntent（id + 正文 + 入队步），而不是裸正文：
 * id 是跨副本幂等锚点。用户连发两条相同「继续」也必须保留两份意图，
 * 不能像旧版那样按正文去重、并在 drain 时重新 randomUUID 把锚点丢掉。
 */
function serializeIntent(intent: SteerIntent): string {
  return JSON.stringify(intent);
}

/** 兼容升级前残留的裸正文元素：补一个一次性 id，之后同样按 id 幂等。 */
function parseIntent(raw: string): SteerIntent {
  try {
    const parsed = JSON.parse(raw) as Partial<SteerIntent> | null;
    if (
      parsed &&
      typeof parsed.id === "string" &&
      parsed.id.length > 0 &&
      typeof parsed.content === "string"
    ) {
      return {
        id: parsed.id,
        content: parsed.content,
        parkedAtStep:
          typeof parsed.parkedAtStep === "number" &&
          Number.isFinite(parsed.parkedAtStep)
            ? parsed.parkedAtStep
            : 0,
      };
    }
  } catch {
    // 非 JSON（旧裸正文）→ 走下面的一次性 id 兜底。
  }
  return { id: randomUUID(), content: raw, parkedAtStep: 0 };
}

/** Redis 与内存各有一份时按 id 幂等；重复正文绝不合并。 */
function mergeIntents(
  remote: readonly SteerIntent[],
  local: readonly SteerIntent[],
): SteerIntent[] {
  const seen = new Set<string>();
  const merged: SteerIntent[] = [];
  for (const intent of [...remote, ...local]) {
    if (seen.has(intent.id)) continue;
    seen.add(intent.id);
    merged.push(intent);
  }
  return merged;
}

@Injectable()
export class SteerInboxService {
  private readonly logger = new Logger(SteerInboxService.name);
  private readonly inboxes = new Map<string, SteerInbox>();
  private redisOverride: SteerRedisPort | null = null;
  private client: Redis | null = null;

  // @Optional：既有单测直接 `new SteerInboxService()`，缺席即退回纯内存。
  constructor(@Optional() private readonly config?: ConfigService) {}

  /** 定向测试/特殊装配：注入 Redis 替身，断言跨副本 drain 的真实副作用。 */
  setRedis(port: SteerRedisPort | null): void {
    this.redisOverride = port;
  }

  private getRedis(): SteerRedisPort | null {
    if (this.redisOverride) return this.redisOverride;
    if (!this.config) return null;
    if (!this.client || this.client.status === "end") {
      this.client = new Redis({
        host: this.config.get<string>("redis.host"),
        port: this.config.get<number>("redis.port"),
        password: this.config.get<string>("redis.password"),
        db: this.config.get<number>("redis.db", 0),
        commandTimeout: 3000,
        enableOfflineQueue: false,
      });
      this.client.on("error", (err: Error) => {
        this.logger.warn(
          `agent steer inbox Redis 连接错误（回落内存）: ${err.message}`,
        );
      });
    }
    return this.client as unknown as SteerRedisPort;
  }

  onModuleDestroy(): void {
    if (this.client && this.client.status !== "end") {
      void this.client.quit().catch(() => undefined);
    }
    this.client = null;
  }

  /**
   * waiting_input 期入队（controller 已显式判过状态；这里再用 shouldWake
   * fail-closed 兜一道：终态/未知态一律不入 inbox、不产生唤醒凭据）。
   *
   * Redis 在场时**只写 Redis**（唯一事实源）：两个副本各写一份本地 Map 会让
   * 已由 B 副本 drain 的意图在 A 副本的下一次 run 里二次注入。Redis 缺席或
   * 写入失败才回落本地 Map —— 既有单实例测试与老装配逐字兼容。
   */
  async park(
    sessionId: string,
    content: string,
    parkedAtStep: number,
    targetStatus: string | null | undefined,
  ): Promise<SteerParkResult> {
    const intent: SteerIntent = {
      id: randomUUID(),
      content,
      parkedAtStep,
    };
    if (
      !shouldWake({ targetId: sessionId, intentId: intent.id }, targetStatus)
    ) {
      return { intent: null, wake: false };
    }
    const redis = this.getRedis();
    if (redis) {
      try {
        const key = agentSteerInboxKey(sessionId);
        await redis.rpush(key, serializeIntent(intent));
        await redis.expire(key, STEER_TTL_SECONDS);
        return { intent, wake: true };
      } catch (err: unknown) {
        this.logger.warn(
          `agent steer inbox Redis 写入失败（回落本进程内存）: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    const inbox = this.inboxes.get(sessionId) ?? emptyInbox();
    this.inboxes.set(sessionId, parkIntent(inbox, intent));
    return { intent, wake: true };
  }

  /**
   * 步边界取出并清空；非步边界原样保留（语义全在纯函数里）。
   *
   * 只有真的在步边界才读+删 Redis：非边界时提前 del 会把另一副本刚写入的
   * steer 丢掉。边界处 Redis 与内存合并按 id 幂等（重复正文不合并），
   * 避免同一意图二次注入。
   */
  async drain(
    sessionId: string,
    currentStep: StepBoundary,
  ): Promise<DrainResult> {
    if (currentStep === null) {
      const inbox = this.inboxes.get(sessionId) ?? emptyInbox();
      return { intents: [], inbox };
    }
    const remote = await this.takeRemote(sessionId);
    const local = this.inboxes.get(sessionId) ?? emptyInbox();
    const merged = mergeIntents(remote, local.intents);
    this.inboxes.delete(sessionId);
    return drainAtStepBoundary({ intents: merged }, currentStep);
  }

  /** 只读视图（接线层断言「POST 只写 inbox」用；生产无消费方）。 */
  peek(sessionId: string): SteerInbox {
    return this.inboxes.get(sessionId) ?? emptyInbox();
  }

  private async takeRemote(sessionId: string): Promise<SteerIntent[]> {
    const redis = this.getRedis();
    if (!redis) return [];
    try {
      const key = agentSteerInboxKey(sessionId);
      const values = await redis.lrange(key, 0, -1);
      if (values.length) await redis.del(key);
      return values.map(parseIntent);
    } catch (err: unknown) {
      this.logger.warn(
        `agent steer inbox Redis 读取失败（回落内存）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }
}
