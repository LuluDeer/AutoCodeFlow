import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { randomUUID } from "node:crypto";
import { EVENT_SCHEMA_VERSION } from "../../common/events/domain-events";

/**
 * ARCH-32（ADR-015）：pull 模式派发队列。
 *
 * push 派发的传输层是 axios POST 到执行器 address；pull 执行器（NAT 内、
 * 零入站可达）改为从本服务的 Redis 队列拉取。调度侧语义不变——dispatch()
 * 选坑成功后把既有派发载荷 `{executionId, task, params}` 附加 traceparent
 * 与 pushedAt 入队，执行器长轮询取走即执行。
 *
 * 队列形态：每执行器一条 List（key `acf:pull:{executorId}`），LPUSH 入队 /
 * RPOP 出队（FIFO，先入先派）。多实例安全：队列在共享 Redis（ARCH-31），
 * 任意 admin-api 副本的拉取循环等价（无实例亲和）。
 *
 * 过期语义：载荷自带 pushedAt，拉取侧超过 EXECUTOR_PULL_TTL_MS 即丢弃并
 * warn（执行器长期不拉取的场景）；执行行本身由既有 stale sweep 收敛，
 * 本服务不重复兜底、不新增后台任务。
 *
 * ---------------------------------------------------------------------------
 * ARCH-33（ADR-016）：控制面命令通道。
 *
 * ADR-015 只把「任务派发」搬上了 pull 通道，而所有「中台主动拨入执行器」
 * 的控制面调用（deploy / app-stop / app-uninstall / config-reload /
 * kill / update-package）仍是纯 push 硬编码——公网中台 + 内网执行器拓扑下
 * 必然超时（生产实证：app_deployments.statusMessage = "Failed to reach
 * executor after 3 attempts: timeout of 30000ms exceeded"）。
 *
 * 本服务新增**独立**的命令队列 `acf:cmd:{executorId}`，与任务队列物理分离：
 *  - 零回归：任务队列的入队/出队/TTL/单飞语义逐字节不变，已验收的 pull
 *    派发链路不被触碰；
 *  - TTL 语义不同：任务载荷超时丢弃是对的（执行行有 stale sweep 兜底）；
 *    控制命令超时丢弃会**静默丢操作**，故用更长的 EXECUTOR_CMD_TTL_MS；
 *  - 批量语义：app-uninstall 一次要发 stop×N + uninstall×1，同批下发才能
 *    保证顺序。
 */
@Injectable()
export class ExecutorPullService {
  private readonly logger = new Logger(ExecutorPullService.name);
  private client: Redis | null = null;

  /** 拉取循环的轮询间隔（RPOP 无 Blocking 语义，避免占用长连接）。 */
  private static readonly POLL_INTERVAL_MS = 500;

  /**
   * 单次长轮询最多带回的命令数。app-uninstall 的扇出（stop×N + uninstall）
   * 是最大的合理批次；上限防止一条被污染的队列把响应体撑爆。
   */
  static readonly MAX_COMMANDS_PER_PULL = 64;

  /** 命令结果保留时长（排障读面；非业务事实源，业务终态另有回调收敛）。 */
  private static readonly COMMAND_RESULT_TTL_SECONDS = 600;

  constructor(private configService: ConfigService) {}

  /** 惰性建连（对齐 RedisLockService N3 先例：不依赖 onModuleInit 时序）。 */
  private ensureClient(): Redis | null {
    if (this.client) return this.client;
    try {
      this.client = new Redis({
        host: this.configService.get("redis.host"),
        port: this.configService.get<number>("redis.port"),
        password: this.configService.get("redis.password") || undefined,
        db: this.configService.get<number>("redis.db", 0),
        commandTimeout: 3000,
        retryStrategy: (times) => Math.min(times * 100, 3000),
        // 惰性连接：pull 端点在被调用前无需 Redis 连接
        lazyConnect: false,
        maxRetriesPerRequest: 2,
      });
      this.client.on("error", (err: Error) => {
        this.logger.error(`Redis connection error: ${err.message}`);
      });
      return this.client;
    } catch (err) {
      this.logger.error(
        `Failed to create Redis client: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private queueKey(executorId: string): string {
    return `acf:pull:${executorId}`;
  }

  /** ARCH-33: 控制面命令队列键（与任务队列物理分离，见类头注）。 */
  private commandQueueKey(executorId: string): string {
    return `acf:cmd:${executorId}`;
  }

  private commandResultKey(commandId: string): string {
    return `acf:cmdres:${commandId}`;
  }

  /** 任务载荷 TTL（既有语义，默认 15min）。 */
  private get taskTtlMs(): number {
    return this.configService.get<number>("executor.pullTtlMs") || 900_000;
  }

  /**
   * ARCH-33: 命令 TTL（默认 30min，长于任务载荷）。
   *
   * 刻意比任务载荷更宽松：丢任务的后果是执行行卡住，由既有 stale sweep
   * 收敛；丢命令**没有任何兜底**——部署指令消失后 app_deployments 行会
   * 永远停在 DEPLOYING 直到 2 分钟的 cron sweep 才判失败，而 stop/uninstall
   * 这类 best-effort 命令丢了连痕迹都没有。
   */
  private get commandTtlMs(): number {
    return this.configService.get<number>("executor.cmdTtlMs") || 1_800_000;
  }

  /**
   * 派发载荷入队（dispatch 占坑成功后的传输分支）。入队失败抛错——调用方
   * （dispatch）按既有失败路径回滚占坑并走重试语义。
   */
  async enqueue(
    executorId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const client = this.ensureClient();
    if (!client) throw new Error("Pull queue unavailable (Redis client error)");
    // PK-14: 派发载荷顶层附 schemaVersion（与 webhook 信封同源常量）——执行器
    // 未知字段忽略即可（天然向后兼容）；载荷形状演进时执行器可据此分支解析。
    const body = JSON.stringify({
      ...payload,
      schemaVersion: EVENT_SCHEMA_VERSION,
      pushedAt: Date.now(),
    });
    await client.lpush(this.queueKey(executorId), body);
  }

  /**
   * ARCH-33（ADR-016）：控制面命令入队，返回 commandId。
   *
   * 与 enqueue 的差异：命令带 `commandId`（结果上报与幂等排障的关联键）与
   * `type`（执行器侧据此构造本地路由——**不接受中台下发的自由路径**）。
   * 入队失败抛错，由调用方决定回退 push 还是报错。
   */
  async enqueueCommand(
    executorId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const client = this.ensureClient();
    if (!client)
      throw new Error("Command queue unavailable (Redis client error)");
    const commandId = randomUUID();
    const body = JSON.stringify({
      commandId,
      type,
      payload,
      schemaVersion: EVENT_SCHEMA_VERSION,
      issuedAt: Date.now(),
    });
    await client.lpush(this.commandQueueKey(executorId), body);
    return commandId;
  }

  /** 取回命令执行结果（排障读面；不存在返回 null）。 */
  async getCommandResult(
    commandId: string,
  ): Promise<Record<string, unknown> | null> {
    const client = this.ensureClient();
    if (!client) return null;
    try {
      const raw = await client.get(this.commandResultKey(commandId));
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /** 记录命令执行结果（best-effort：写失败不影响上报响应）。 */
  async recordCommandResult(
    commandId: string,
    result: Record<string, unknown>,
  ): Promise<void> {
    const client = this.ensureClient();
    if (!client) return;
    try {
      await client.set(
        this.commandResultKey(commandId),
        JSON.stringify(result),
        "EX",
        ExecutorPullService.COMMAND_RESULT_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to record command result for ${commandId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 长轮询取件：在 waitMs 窗口内每 POLL_INTERVAL_MS 取一次队头；取到过期
   * 载荷（pushedAt 早于 TTL 截止）丢弃不投递、继续等下一个。窗口耗尽返回
   * null（端点据此返回空载荷，执行器继续下一轮）。
   *
   * ARCH-33: 保留为「仅取任务」的既有入口（单测与语义基线）；控制面命令经
   * pullWork() 一并取回。
   */
  async pull(
    executorId: string,
    waitMs: number,
  ): Promise<Record<string, unknown> | null> {
    const { task } = await this.pullWork(executorId, waitMs, {
      wantTask: true,
    });
    return task;
  }

  /**
   * ARCH-33（ADR-016）：任务 + 命令的合并长轮询。
   *
   * 语义要点：
   *  - **命令优先**：每轮先清空命令队列（最多 MAX_COMMANDS_PER_PULL 条），
   *    再尝试取一次任务；两者任一非空即返回。命令的交付时延因此与任务同级
   *    （≤500ms），不会被一个空任务队列拖到窗口耗尽。
   *  - **wantTask=false 时绝不碰任务队列**：执行器满载（无空闲槽位）时仍要
   *    能收到控制命令，但不得取走任务——取走即无槽位可跑，会把「暂时没容量」
   *    固化成执行失败（E-01 已关闭的那类问题）。此处用「不出队」而非
   *    「出队后丢弃」实现：丢弃等于凭空吞掉一条派发。
   *  - 过期/畸形载荷沿用既有丢弃语义（任务按 pushedAt 判 TTL，命令按 issuedAt）。
   */
  async pullWork(
    executorId: string,
    waitMs: number,
    opts: { wantTask: boolean },
  ): Promise<{
    task: Record<string, unknown> | null;
    commands: Record<string, unknown>[];
  }> {
    const client = this.ensureClient();
    if (!client) return { task: null, commands: [] };

    // SEC-PULL-01（纵深防御）：waitMs 为 NaN/Infinity 时 `deadline` 也会是 NaN，
    // 而 `Date.now() >= NaN` 恒为 false，下方 while(true) 将永不 break、请求
    // 永久挂起。控制器已做有限性收敛，这里再兜一层，保护任何未来调用方。
    // 非有限值语义上等于「不等待」，取 0（立即取一次即返回）。
    const effectiveWaitMs = Number.isFinite(waitMs) ? Math.max(0, waitMs) : 0;
    const deadline = Date.now() + effectiveWaitMs;
    const taskKey = this.queueKey(executorId);
    const cmdKey = this.commandQueueKey(executorId);

    let task: Record<string, unknown> | null = null;
    const commands: Record<string, unknown>[] = [];

    // 至少尝试取件一次，再判窗口耗尽（waitMs=0 = 立即取一次即返回）。
    while (true) {
      while (commands.length < ExecutorPullService.MAX_COMMANDS_PER_PULL) {
        const raw = await client.rpop(cmdKey);
        if (!raw) break;
        const parsed = this.parseCommand(raw, executorId);
        if (parsed) commands.push(parsed);
      }

      if (!task && opts.wantTask) {
        task = await this.takeTask(client, taskKey, executorId);
      }

      if (task || commands.length > 0) break;
      if (Date.now() >= deadline) break;
      await new Promise((r) =>
        setTimeout(r, ExecutorPullService.POLL_INTERVAL_MS),
      );
    }

    return { task, commands };
  }

  /**
   * 取一条未过期的任务载荷。过期/畸形载荷丢弃后继续取（既有语义），
   * 队列空则返回 null。
   */
  private async takeTask(
    client: Redis,
    taskKey: string,
    executorId: string,
  ): Promise<Record<string, unknown> | null> {
    const ttlMs = this.taskTtlMs;
    while (true) {
      const raw = await client.rpop(taskKey);
      if (!raw) return null;
      try {
        const payload = JSON.parse(raw) as Record<string, unknown>;
        const pushedAt = Number(payload.pushedAt ?? 0);
        if (pushedAt && Date.now() - pushedAt > ttlMs) {
          this.logger.warn(
            `Discarded stale pull payload for executor ${executorId} (age=${Date.now() - pushedAt}ms > TTL ${ttlMs}ms)`,
          );
          continue;
        }
        return payload;
      } catch (err) {
        this.logger.warn(
          `Discarded malformed pull payload for executor ${executorId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
    }
  }

  /**
   * 解析一条命令载荷。畸形 JSON 与结构非法的条目丢弃并 warn（不投递给
   * 执行器——执行器侧对未知 type 会回 400，但在中台侧就拦掉能省一次往返，
   * 且畸形条目的错误信息在中台日志里比在执行器日志里更可查）。
   */
  private parseCommand(
    raw: string,
    executorId: string,
  ): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const commandId = parsed.commandId;
      const type = parsed.type;
      if (typeof commandId !== "string" || typeof type !== "string") {
        this.logger.warn(
          `Discarded malformed pull command for executor ${executorId}: missing commandId/type`,
        );
        return null;
      }
      const issuedAt = Number(parsed.issuedAt ?? 0);
      const ttlMs = this.commandTtlMs;
      if (issuedAt && Date.now() - issuedAt > ttlMs) {
        this.logger.warn(
          `Discarded stale pull command ${commandId} (type=${type}) for executor ${executorId} (age=${Date.now() - issuedAt}ms > TTL ${ttlMs}ms)`,
        );
        return null;
      }
      return parsed;
    } catch (err) {
      this.logger.warn(
        `Discarded malformed pull command for executor ${executorId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * 清空指定执行器的待拉队列（执行器删除/轮换令牌时卫生清理；best-effort，
   * 队列残留由 TTL 丢弃语义兜底）。ARCH-33: 命令队列一并清理。
   */
  async clear(executorId: string): Promise<void> {
    const client = this.ensureClient();
    if (!client) return;
    await client.del(this.queueKey(executorId)).catch(() => undefined);
    await client.del(this.commandQueueKey(executorId)).catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.quit().catch(() => undefined);
    }
  }
}
