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

  /**
   * P3-4（2026-10-26 第三轮审计）：单次 takeTask 允许**排水**的过期/畸形
   * 载荷上限（对照命令侧 MAX_COMMANDS_PER_PULL=64 同款防御）。正常情况下一轮
   * 排水 0~几条；128 条全废说明队列被病态数据灌满（或 TTL 被调小后无人拉取
   * 积压），继续 while(true) 只会把一次 pull 拖成 Redis 串行洪泛——超限即放弃
   * 本轮（warn），剩余残留由下一轮继续消化。
   */
  private static readonly MAX_STALE_TASK_DRAIN_PER_TAKE = 128;

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
        // P1-3（生产实证 2026-10-22）：3000ms 与 25s 长轮询 + 事件循环阻塞的组合
        // 不可靠——实测单日 84 次 `Command timed out`，同一秒内多台不同执行器
        // 同时 500（典型的事件循环/Redis 阻塞特征，不是单台执行器的问题）。
        // 抬到 8000ms：仍能挡住真正挂死的连接，但不再把"这一跳慢了"变成 500。
        commandTimeout: 8000,
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

  /**
   * Redis 的**瞬时**故障（命令超时 / 连接被重置）判定。
   *
   * P1-3：这类错误对 pull 端点而言等价于「本轮没取到东西」——把它变成 500 会让
   * 执行器这一轮彻底拿不到任务/命令，还会在 Nginx 访问日志里堆出成片的 500
   * （用户侧看到的是"中台在报错"，实际只是 Redis 那一跳慢了一下）。真正的
   * 逻辑错误仍然上抛，绝不被这段降级吞掉。
   */
  private isTransientRedisError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    if (/command timed out/i.test(message)) return true;
    if (
      /connection is closed|stream isn't writeable|ECONNRESET|EPIPE/i.test(
        message,
      )
    ) {
      return true;
    }
    const code = (err as { code?: string } | null)?.code;
    return (
      code === "ETIMEDOUT" ||
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "EPIPE" ||
      code === "NR_CLOSED"
    );
  }

  /** 瞬时故障的 warn 节流（10s）：心跳/长轮询是高频面，不节流会刷屏。 */
  private lastTransientWarnAt = 0;
  private warnTransient(throttleKey: string, err: unknown): void {
    const now = Date.now();
    if (now - this.lastTransientWarnAt < 10_000) return;
    this.lastTransientWarnAt = now;
    this.logger.warn(
      `Pull ${throttleKey}: Redis transient failure treated as "nothing this round" — ` +
        `${err instanceof Error ? err.message : String(err)} (the executor simply retries on its next poll)`,
    );
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
    if (!client) throw new Error("拉取队列不可用（Redis 客户端错误）");
    // PK-14: 派发载荷顶层附 schemaVersion（与 webhook 信封同源常量）——执行器
    // 未知字段忽略即可（天然向后兼容）；载荷形状演进时执行器可据此分支解析。
    const body = JSON.stringify({
      ...payload,
      schemaVersion: EVENT_SCHEMA_VERSION,
      pushedAt: Date.now(),
    });
    await client.lpush(this.queueKey(executorId), body);

    // NETOPT-G P1-8（可观测性）：入队后回读 LLEN 并记 INFO。
    //
    // 为什么值得多一次 RTT：本次生产事故排查中，"任务到底有没有进队列"反复
    // 消耗了双方多轮往返——中台侧因 redis-cli 未安装而只能看到 nginx 的
    // 124B 空响应，执行器侧看不到服务端的 LPUSH 结果，双方都无法单独证明
    // 队列里有没有东西。此行把入队结果（key + 深度）写进应用日志，日后
    // "派了却没人取"这类问题一跳可查：LLEN>=1 说明载荷确已入队，问题在取件
    // 侧；若日志缺失则说明 LPUSH 之前就失败了。
    //
    // 失败只 WARN 不上抛：回读仅是观测，LLEN 取不到不应让已成功的入队失败
    // （那会让 dispatch 回滚占坑、把一次成功派发变成失败）。
    try {
      const depth = await client.llen(this.queueKey(executorId));
      this.logger.log(
        `Pull enqueue: executor=${executorId} queueDepth=${depth} bytes=${body.length}`,
      );
    } catch (err) {
      this.logger.warn(
        `Pull enqueue depth probe failed for executor ${executorId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
    if (!client) throw new Error("命令队列不可用（Redis 客户端错误）");
    const commandId = randomUUID();
    const body = JSON.stringify({
      commandId,
      type,
      payload,
      schemaVersion: EVENT_SCHEMA_VERSION,
      issuedAt: Date.now(),
    });
    await client.lpush(this.commandQueueKey(executorId), body);
    // P0-4：把「这条命令属于哪条部署行」记进旁路元数据。
    //
    // 为什么需要：执行器上报执行结果时只带 commandId（它不知道、也不该知道
    // app_deployments 的行 id）。没有这层映射，中台就无法在命令失败时把部署行
    // 收成 FAILED，只能等 30 分钟的命令未决豁免期（现场即「点部署没反应」的
    // 直接成因）。best-effort：写失败只 warn——丢的只是"秒级收敛"，不是命令。
    await this.rememberCommandMeta(
      client,
      commandId,
      type,
      payload,
      executorId,
    );
    return commandId;
  }

  /** 命令元数据的 Redis 键（commandId → {type, deploymentId, appId, executorId}）。 */
  private commandMetaKey(commandId: string): string {
    return `acf:cmdmeta:${commandId}`;
  }

  /**
   * P2-2（2026-10-26 第三轮审计）：deploymentId → commandIds 反向集合的键。
   *
   * 为什么维护反向集合而不是 SCAN `acf:cmdmeta:*`：sweep 判败时要撤销的是
   * 「该部署的未消费命令」，按部署反查是精确键读（SMEMBERS 一次定位）；SCAN
   * 要全量游标遍历 + 逐键 GET + JSON 解析，把撤销成本耦合到全局键空间规模。
   * 命令量级小（部署是低频操作）SCAN 也可接受，但反向集合的写入成本
   * （每条 deploy 命令一次 SADD）几乎为零，读取路径更便宜。
   */
  private deploymentCommandsKey(deploymentId: string): string {
    return `acf:cmdbydep:${deploymentId}`;
  }

  /**
   * P2-2：命令撤销标记的键（存在即「该命令已被判败 sweep 撤销，不得投递」）。
   * TTL 与命令载荷一致——命令过期后标记只是幽灵数据。
   */
  private commandCancelKey(commandId: string): string {
    return `acf:cmdcancel:${commandId}`;
  }

  /**
   * 记录命令元数据（best-effort，TTL 与命令载荷一致：命令过期后元数据也
   * 没有意义，留着只会让排障读到幽灵数据）。
   *
   * P2-4：meta 增记目标 executorId——命令结果上报端点据此比对「回报行」与
   * 「命令目标行」，堵住「任意执行器可对任意 commandId 回报」的纵深缺口。
   * P2-2：deploymentId 非空时同步维护 `acf:cmdbydep:{deploymentId}` 反向集合
   * （判败 sweep 按它反查该部署的全部在途命令），TTL 与命令载荷一致。
   */
  private async rememberCommandMeta(
    client: Redis,
    commandId: string,
    type: string,
    payload: Record<string, unknown>,
    executorId: string,
  ): Promise<void> {
    try {
      const deploymentId =
        typeof payload.deploymentId === "string" ? payload.deploymentId : null;
      const appId = typeof payload.appId === "string" ? payload.appId : null;
      const ttlSeconds = Math.max(1, Math.ceil(this.commandTtlMs / 1000));
      await client.set(
        this.commandMetaKey(commandId),
        JSON.stringify({ type, deploymentId, appId, executorId }),
        "EX",
        ttlSeconds,
      );
      if (deploymentId) {
        const members = await client.sadd(
          this.deploymentCommandsKey(deploymentId),
          commandId,
        );
        // sadd 命中即续期：集合的存活期跟随最新一条命令（部署在途期间集合必须
        // 活着，判败 sweep 才有得查）；members=0 说明成员早已存在，同样续期无害。
        if (members !== null && members !== undefined) {
          await client.expire(
            this.deploymentCommandsKey(deploymentId),
            ttlSeconds,
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `Failed to record command meta for ${commandId} (deploy failures will fall back to the stuck sweep): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 取回命令元数据（P0-4；不存在/Redis 不可用返回 null——调用方按"无关联
   * 部署行"处理，语义与引入本机制前一致）。
   *
   * executorId 为 null 的两种形态由调用方区分处理：
   *  - meta 整体为 null：存量命令（P2-4 引入前入队，TTL ≤30min 自然清空）；
   *  - meta 在但 executorId 缺失：同上（升级窗口内的存量 meta），归属比对放行。
   */
  async getCommandMeta(commandId: string): Promise<{
    type: string;
    deploymentId: string | null;
    appId: string | null;
    executorId: string | null;
  } | null> {
    const client = this.ensureClient();
    if (!client) return null;
    try {
      const raw = await client.get(this.commandMetaKey(commandId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.type !== "string") return null;
      return {
        type: parsed.type,
        deploymentId:
          typeof parsed.deploymentId === "string" ? parsed.deploymentId : null,
        appId: typeof parsed.appId === "string" ? parsed.appId : null,
        executorId:
          typeof parsed.executorId === "string" ? parsed.executorId : null,
      };
    } catch {
      return null;
    }
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

  /**
   * P2-2（2026-10-26 第三轮审计）：撤销某部署的全部在途 pull 命令。
   *
   * 场景：2min 卡死 sweep 把部署行判 FAILED 后，命令 TTL（默认 30min）内滞留
   * 在 `acf:cmd:{executorId}` 里的 deploy 命令仍会被回归 pull 的执行器取走并
   * 执行——设备装上无人跟踪的应用（终态行心跳守卫拒绝推进），且 in-flight
   * 槽位已释放、可与新部署叠加成双进程。sweep 判败时调用本方法，给该部署的
   * 全部命令打撤销标记；取件侧（parseCommand）见标记即丢弃不投递。
   *
   * 语义取舍：
   *  - 对**已消费**的命令打标记无副作用（标记只影响取件，且随后随 TTL 过期）；
   *  - best-effort：Redis 故障上抛，由调用方（ExecutorService 包装层）收敛为
   *    warn——撤销失败退回既有兜底（命令 TTL 过后执行器侧按 issuedAt 丢弃）。
   *
   * 返回打标记的命令数（0 = 无在途命令，排障用）。
   */
  async cancelCommandsForDeployment(deploymentId: string): Promise<number> {
    const client = this.ensureClient();
    if (!client) return 0;
    const members = await client.smembers(
      this.deploymentCommandsKey(deploymentId),
    );
    const commandIds = (members ?? []).filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    if (commandIds.length === 0) return 0;
    const ttlSeconds = Math.max(1, Math.ceil(this.commandTtlMs / 1000));
    for (const commandId of commandIds) {
      await client.set(
        this.commandCancelKey(commandId),
        JSON.stringify({ canceledBy: "stuck-sweep", deploymentId }),
        "EX",
        ttlSeconds,
      );
    }
    // 部署已判败：反向集合的使命结束（sweep 对同一行只判一次——FAILED 行离开
    // 扫描谓词），清掉防止残留。best-effort：清失败无碍，成员随 TTL 过期。
    await client
      .del(this.deploymentCommandsKey(deploymentId))
      .catch(() => undefined);
    this.logger.warn(
      `Canceled ${commandIds.length} in-flight pull command(s) for deployment ${deploymentId} ` +
        `(judged FAILED by the stuck sweep): ${commandIds.join(", ")}`,
    );
    return commandIds.length;
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
   *  - P2-2：已被判败 sweep 撤销的命令（acf:cmdcancel:{id} 标记在）丢弃不投递，
   *    并把「作废原因」写进命令结果键留痕（排障读面可见为什么命令没执行）。
   *  - P3-1（2026-10-26 第三轮审计）：`opts.isConnected` 是**调用方的连接存活
   *    探针**（控制器以 res 'close'/destroyed 实现）。断连后继续每 500ms RPOP
   *    到 waitMs 耗尽纯属浪费，且窗口末端弹出的任务投给死 socket 必然丢失、
   *    还把队列里本来能活到下一轮的载荷提前吞掉——每轮等待前探活，断连即退出。
   */
  async pullWork(
    executorId: string,
    waitMs: number,
    opts: {
      wantTask: boolean;
      /** P3-1：连接存活探针。缺省（undefined）= 不感知断连（既有语义基线）。 */
      isConnected?: () => boolean;
    },
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
        // P1-3：Redis 瞬时故障（命令超时/连接重置）在本轮等价于"没有命令"，
        // 不再让整个 pull 请求 500（那样这一轮连任务也拿不到）。
        let raw: string | null;
        try {
          raw = await client.rpop(cmdKey);
        } catch (err) {
          if (!this.isTransientRedisError(err)) throw err;
          this.warnTransient(`executor=${executorId} command pop`, err);
          break;
        }
        if (!raw) break;
        const parsed = await this.parseCommand(client, raw, executorId);
        if (parsed) commands.push(parsed);
      }

      if (!task && opts.wantTask) {
        try {
          task = await this.takeTask(client, taskKey, executorId);
        } catch (err) {
          if (!this.isTransientRedisError(err)) throw err;
          this.warnTransient(`executor=${executorId} task pop`, err);
          task = null;
        }
      }

      if (task || commands.length > 0) break;
      // P3-1：断连即停——不再 RPOP（弹出即丢），也不再进入 500ms 等待。
      // 探针异常按「连接还在」处理（fail-open：探针是优化，不该吞掉取件）。
      if (opts.isConnected && opts.isConnected() === false) break;
      if (Date.now() >= deadline) break;
      await new Promise((r) =>
        setTimeout(r, ExecutorPullService.POLL_INTERVAL_MS),
      );
    }

    // NETOPT-G P1-8（可观测性）：执行器上报满载（wantTask=false）却仍有任务
    // 在队列里堆积时告警——"上报满载但队列非空"是执行器账本与队列状态不一致
    // 的直接信号（本次事故排查中，正是这个组合反复出现却无人可见：中台只能
    // 看到 pull 返回空载荷，无法区分"真没任务"与"有任务但被 wantTask 门禁
    // 挡下"）。
    //
    // 只 WARN 不干预：wantTask 门禁本身是正确设计（无空闲槽位时取走任务会把
    // "暂时没容量"固化成执行失败），这里只是把该状态提前暴露给运维，不改变
    // 取件语义。探测失败静默——纯观测，不应影响取件结果。
    if (!opts.wantTask) {
      try {
        const depth = await client.llen(taskKey);
        if (depth > 0) {
          this.logger.warn(
            `Pull: executor ${executorId} reports no free slots but queue has ${depth} pending task(s) — possible executor capacity/ledger mismatch`,
          );
        }
      } catch {
        /* 纯观测路径，探测失败不影响取件 */
      }
    }

    return { task, commands };
  }

  /**
   * 取一条未过期的任务载荷。过期/畸形载荷丢弃后继续取（既有语义），
   * 队列空则返回 null。
   *
   * P3-4（2026-10-26 第三轮审计）：排水上限 MAX_STALE_TASK_DRAIN_PER_TAKE——
   * 对照命令侧 MAX_COMMANDS_PER_PULL=64。while(true) 无上限时，一条被病态
   * 数据灌满的队列会让单次 pull 串行 RPOP 上千次；超限即放弃本轮并 warn
   * （病态防御，不是业务语义——剩余残留由下一轮 pull 继续消化）。
   */
  private async takeTask(
    client: Redis,
    taskKey: string,
    executorId: string,
  ): Promise<Record<string, unknown> | null> {
    const ttlMs = this.taskTtlMs;
    let drained = 0;
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
          drained += 1;
          if (drained >= ExecutorPullService.MAX_STALE_TASK_DRAIN_PER_TAKE) {
            this.logger.warn(
              `Pull task drain hit the per-take cap (${ExecutorPullService.MAX_STALE_TASK_DRAIN_PER_TAKE} stale payloads) for executor ${executorId} — ` +
                `suspect a poisoned/backlogged queue; leaving the rest for the next pull round`,
            );
            return null;
          }
          continue;
        }
        return payload;
      } catch (err) {
        this.logger.warn(
          `Discarded malformed pull payload for executor ${executorId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        drained += 1;
        if (drained >= ExecutorPullService.MAX_STALE_TASK_DRAIN_PER_TAKE) {
          this.logger.warn(
            `Pull task drain hit the per-take cap (${ExecutorPullService.MAX_STALE_TASK_DRAIN_PER_TAKE} malformed payloads) for executor ${executorId} — ` +
              `suspect a poisoned queue; leaving the rest for the next pull round`,
          );
          return null;
        }
        continue;
      }
    }
  }

  /**
   * 解析一条命令载荷。畸形 JSON 与结构非法的条目丢弃并 warn（不投递给
   * 执行器——执行器侧对未知 type 会回 400，但在中台侧就拦掉能省一次往返，
   * 且畸形条目的错误信息在中台日志里比在执行器日志里更可查）。
   *
   * P2-2（2026-10-26 第三轮审计）：取件时消费撤销标记——判败 sweep 打上的
   * `acf:cmdcancel:{id}` 标记在 → 该命令**不投递**，并把「部署已判败，滞留
   * 命令作废」写进命令结果键留痕（排障读面据此解释命令为什么没被执行）。
   * 标记探测 fail-open：Redis 抖动视为未撤销（宁可多一次投递尝试，不让观测
   * 面故障吞掉正常命令；撤销语义的权威兜底仍是命令 TTL + issuedAt 丢弃）。
   */
  private async parseCommand(
    client: Redis,
    raw: string,
    executorId: string,
  ): Promise<Record<string, unknown> | null> {
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
      // P2-2：撤销标记消费（在 TTL 判定之前——被判败撤销的命令无论新旧都不投递）。
      try {
        const cancelMarker = await client.get(this.commandCancelKey(commandId));
        if (cancelMarker !== null) {
          this.logger.warn(
            `Discarded canceled pull command ${commandId} (type=${type}) for executor ${executorId}: ` +
              `its deployment was already judged FAILED by the stuck sweep`,
          );
          // 留痕到排障读面（best-effort）：结果键 TTL 600s，足够运维回查
          // 「这条命令为什么没执行」。
          await this.recordCommandResult(commandId, {
            commandId,
            type,
            executorId,
            ok: false,
            canceled: true,
            status: null,
            error: "部署已判败，滞留命令作废（stuck sweep 判 FAILED 时撤销）",
            reportedAt: new Date().toISOString(),
          });
          return null;
        }
      } catch {
        /* 标记探测失败 fail-open：视为未撤销，继续按 TTL 语义处理 */
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

  /**
   * DEEP-AUDIT B·1.5/B·1.1：待拉任务队列深度（`acf:pull:{id}` 的 LLEN）。
   *
   * 为什么值得单独读一次：此前"派了却没人取"只有两个观测点——入队日志的
   * queueDepth 与执行器满载时的服务端 WARN，管理台看不到任何痕迹。把深度
   * 透出到删除影响面预览（B·1.1）与执行器详情页（B·1.5「待拉取」徽标），
   * 让队列积压一跳可查。失败按 0（未知）呈现：深度读不到绝不该阻断任何
   * 调用方（预览/心跳/详情读面），TTL 丢弃语义兜底积压上限。
   */
  async depth(executorId: string): Promise<number> {
    const client = this.ensureClient();
    if (!client) return 0;
    try {
      return await client.llen(this.queueKey(executorId));
    } catch {
      return 0;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.quit().catch(() => undefined);
    }
  }
}
