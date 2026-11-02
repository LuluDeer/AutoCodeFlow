import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";

import { AgentSessionService } from "../runtime/agent-session.service";
import { AgentEventAggregator } from "./agent-event-aggregator.service";
import {
  AGENT_QUEUE_NAME,
  type AgentJobData,
} from "../runtime/agent.processor";
import { SchedulerService } from "../../scheduler/scheduler.service";
import { DomainEventBus } from "../../../common/services/domain-event-bus.service";
import { DOMAIN_EVENTS } from "../../../common/events/domain-events";
import type { ExecutionTerminalEventPayload } from "../../../common/events/domain-events";
import type { AgentSessionKind } from "../entities/agent-session.entity";
// 静默降级轮：两处 fail-open 的信号（计数不抛错、不改语义），走 runtime-metrics
// 的模块级注册表——metrics 模块位于依赖链上游，接 DI 会成环，故只走 recordRuntime。
import { recordRuntime } from "../../metrics/runtime-metrics-entry";
// 只取**类型**：stage 的闭集由 metrics 侧拥有（RUNTIME_AGENT_EVENT_TRIGGER_STAGES），
// 本侧用 import type 把写点钉在那个联合上 ⇒ 新增 stage 忘登记先在编译期红，
// 不存在「写了一个未登记标签」的漂移（同 scheduler 对 deferred reason 的做法）。
import type { RuntimeAgentEventTriggerStage } from "../../metrics/runtime-metrics";

/**
 * 巡检熔断参数（2026-10-23）。
 *
 * 为什么是「连续 3 条失败」：默认巡检每小时一次，3 条即约 3 小时——足够区分
 * 「LLM provider 真的挂了」与「偶发 5xx」，又不会让人盯着 20 多条红行才反应。
 * 窗口取 10 是为了在连续失败少于 3 条时尽早退出循环（不必扫全表）。
 */
const AGENT_WATCH_BREAKER_THRESHOLD = 3;
const AGENT_WATCH_BREAKER_WINDOW = 10;
/** 被熔断期间每 N 次跳过一次 warn——防止一小时一条日志刷满运维面板。 */
const AGENT_WATCH_BREAKER_LOG_INTERVAL = 6;

/**
 * 静默降级轮 ①：**熔断器自己失明**的计数。
 *
 * ## 为什么「安全闸门自己失明」必须可查询
 *
 * `watchBreakerVerdict` 的 fail-open 是**有意纪律**（熔断器坏了不该让巡检彻底
 * 停摆），本轮的纪律是「只加信号、不改语义」，所以 `blocked=false` 原样返回。
 *
 * 但这条纪律的代价是**不对称**的：熔断器是唯一能在 LLM provider 挂掉时叫停巡检
 * 的闸门，一旦它读不到会话（`sessions.list` 抛错），返回的 `blocked=false` 不是
 * 「判定 provider 健康」，而是**「不知道」**。于是每个 cron 周期继续派发注定失败
 * 的 ops_watch 会话——每轮一次真实 provider 调用（烧额度）+ 会话页一条 failure 行。
 * 此前这件事只有一条被节流过的 warn：日志一滚就没了，而「巡检会话在刷红」在业务
 * 指标上与「provider 真的病了一小时」长得**一模一样**，无法区分「该停没停」与
 * 「闸门瞎了还照跑」。⇒ 失明必须自己成为一条可算 rate 的序列。
 *
 * 无标签（基数收敛）：唯一写点就一个 catch，可拆的维度只有无界的错误文本
 * （超时 / 池耗尽 / 表被锁）；进 label 就是 OBS3-02 修过的基数事故。要拆先有闭集。
 */
const WATCH_BREAKER_CHECK_FAILED_METRIC =
  "autoflow_agent_watch_breaker_check_failed_total";

/**
 * 静默降级轮 ②：**整轮会话不存在**的计数（聚合事件过阈值后没起成会话）。
 *
 * 与 ① 方向相反：① 是「多跑了一次」，② 是「该跑的那次没跑」。`handleEvent` 的
 * fail-open 是硬纪律（Agent 起不来绝不能影响执行主链），代价是「事件已经被观测到、
 * 然后被静默丢弃」这件事**没有任何失败态可看**——主链一切正常，也没有会话行。
 *
 * `stage` 区分两种相反的结论（实现见 `recordEventTriggerFailed` 的调用点）：
 *   · `session_create` — 会话行没被创建 ⇒ 这一轮**不存在**（查写入面）；
 *   · `enqueue`        — 行建了、`queue.add` 失败 ⇒ 它**永远不会跑**，而列表上
 *     它看起来只是「刚建好」（查队列面）。
 */
const EVENT_TRIGGER_FAILED_METRIC = "autoflow_agent_event_trigger_failed_total";

/**
 * 记一次「巡检熔断器读失败」——**旁路里的旁路**，绝不向外抛。
 *
 * 为什么自己再包一层 try：调用方已在 catch 里，`recordRuntime` 虽然只是纯内存
 * 自增（正常不抛），但「计数器出问题把巡检搞崩」不能靠对上游的信任来避免——一旦
 * 抛出，本来的「闸门读不到、照常巡检」就升级成「巡检异常」。计数失败的正确影响面
 * 是**零**。
 */
function recordWatchBreakerCheckFailed(): void {
  try {
    recordRuntime(WATCH_BREAKER_CHECK_FAILED_METRIC, {});
  } catch {
    // 计数失败不影响任何用户可见行为（no-op by design）
  }
}

/**
 * 记一次「聚合事件没能起会话」——同样绝不向外抛（旁路里的旁路）。
 *
 * 注意一处**刻意的窄化**：这里只在「过阈值之后」才被调用（调用点在 `handleEvent`
 * 的 catch 里），所以事件未达阈值（accumulate/ignored）与总开关关闭
 * （`agent.trigger.enabled=false`，裁剪部署 / 单测环境）都**不计数**——那是设计
 * 形态与聚合节流，不是故障；把它们算进来会让单测环境永久制造一条假告警。
 */
function recordEventTriggerFailed(stage: RuntimeAgentEventTriggerStage): void {
  try {
    recordRuntime(EVENT_TRIGGER_FAILED_METRIC, { stage });
  } catch {
    // 计数失败不影响任何用户可见行为（no-op by design）
  }
}

/**
 * P4（agent-and-deployment）：触发器（设计文档 02 §5.1）。
 *
 * ## 四种触发源
 * | 触发源 | 实现 |
 * |---|---|
 * | 定时 | `@Cron` + leader 门禁（多副本安全） |
 * | 事件 | 订阅 DomainEventBus → **先过聚合器**（防风暴） |
 * | 人工 | 已有的 `POST /api/agent/sessions` |
 * | 指派 | P6（执行器 Agent 回问） |
 *
 * ## 两条硬纪律
 *
 * **① 扫描型触发必须过 leader 门禁。**
 * 多副本部署时，每台实例都会跑 `@Cron`。若不判 leader，N 个副本会让每次
 * 巡检跑 N 次、产生 N 个 Agent 会话（且互相看不到对方的会话）。
 * 复用 `SchedulerService.getStats().isLeader` —— 与既有 scheduler 的
 * 扫描型 tick 同一门禁，不另造一套 leader 选举。
 *
 * **② 事件不进 Agent，先进聚合窗口。**
 * 见 `AgentEventAggregator`。这里是「消费聚合结果」的那一端。
 *
 * ## 静默成功是刻意设计
 * 运维 Agent 的价值是**有事才说话**。定时巡检若每次都通知，人很快就会屏蔽
 * 这个渠道——真出事时通知也一起被屏蔽。故巡检类会话在无实质结论时
 * **不发通知**（由 `AgentSession.summary` 为空表征）。
 */
@Injectable()
export class AgentTriggerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentTriggerService.name);

  /** 熔断期间累计跳过的轮数（只用于日志节流，不参与判定）。 */
  private skippedWatches = 0;

  /** 事件监听器引用（退订用——总线是全局单例，不退订会留悬挂监听）。 */
  private readonly onExecutionFailed = async (
    e: ExecutionTerminalEventPayload,
  ): Promise<void> => {
    // 第四轮审计（A3）: viaRelay 载荷跳过（与 onExecutionKilled 同契约）。
    if (e?.viaRelay) return;
    await this.handleEvent(
      DOMAIN_EVENTS.EXECUTION_FAILED,
      e.taskId ?? e.executionId,
      e,
    );
  };

  private readonly onExecutionKilled = async (
    e: ExecutionTerminalEventPayload,
  ): Promise<void> => {
    // KILLED 是管理员动作的结果，价值低于自发失败——但仍可能暴露
    // 「批量异常终止」这类模式，故与 failed 同路（聚合阈值会把单次过滤掉）。
    // 第四轮审计（A3）: viaRelay 载荷跳过——跨实例 relay 补发只服务读面
    // （SSE），副作用（Agent 会话触发）已在起源实例执行，多副本下不跳过
    // = 双倍事件计数，窗口阈值被虚假推高。
    if (e?.viaRelay) return;
    await this.handleEvent(
      DOMAIN_EVENTS.EXECUTION_KILLED,
      e.taskId ?? e.executionId,
      e,
    );
  };

  private readonly onExecutorOffline = async (e: {
    executorId: string;
    appName: string;
    address: string;
  }): Promise<void> => {
    // 执行器离线**单次即值得关注**（不像执行失败有噪声）——但设计上仍走
    // 聚合器，由阈值决定。默认阈值 3 对离线偏高，故离线用独立阈值见
    // handleEvent 的 thresholdOverride。
    await this.handleEvent(DOMAIN_EVENTS.EXECUTOR_OFFLINE, e.address, e, 1);
  };

  constructor(
    private readonly sessions: AgentSessionService,
    private readonly aggregator: AgentEventAggregator,
    private readonly scheduler: SchedulerService,
    private readonly bus: DomainEventBus,
    private readonly config: ConfigService,
    @InjectQueue(AGENT_QUEUE_NAME) private readonly queue: Queue<AgentJobData>,
  ) {}

  // ── 生命周期 ────────────────────────────────────────────────────

  onModuleInit(): void {
    if (!this.enabled()) {
      this.logger.log(
        "Agent auto-triggers disabled (agent.trigger.enabled=false)",
      );
      return;
    }
    this.bus.on(DOMAIN_EVENTS.EXECUTION_FAILED, this.onExecutionFailed);
    this.bus.on(DOMAIN_EVENTS.EXECUTION_KILLED, this.onExecutionKilled);
    this.bus.on(DOMAIN_EVENTS.EXECUTOR_OFFLINE, this.onExecutorOffline);
    this.logger.log(
      `Agent auto-triggers enabled: window=${this.aggregator.resolveWindowMs()}ms threshold=${this.aggregator.resolveThreshold()}`,
    );
  }

  onModuleDestroy(): void {
    this.bus.off(DOMAIN_EVENTS.EXECUTION_FAILED, this.onExecutionFailed);
    this.bus.off(DOMAIN_EVENTS.EXECUTION_KILLED, this.onExecutionKilled);
    this.bus.off(DOMAIN_EVENTS.EXECUTOR_OFFLINE, this.onExecutorOffline);
  }

  // ── 事件触发 ────────────────────────────────────────────────────

  /**
   * 处理一条领域事件：先过聚合器，达阈值才起会话。
   *
   * @param thresholdOverride 覆盖默认阈值（执行器离线这类单次即重要的用 1）
   */
  /**
   * 把事件绑定成会话 scope（SCOPE-BIND，审计轮 #11）。
   *
   * 设计原则：**scope 只放这一个事件涉及的资源 id**，绝不放通配。
   * 事件类型 → 资源集合的映射按"处置该事件需要碰哪些资源"来定，
   * 而不是按"哪些资源存在"——多放一个键就等于多开一个能力面。
   *
   * 认不出的事件类型 / 缺 resourceKey ⇒ 返回 `{}`（沿用旧的保守默认）。
   * 这样新增事件类型时，最坏结果是"该事件的会话仍是只读"，而不是"意外获得写权限"。
   */
  buildEventScope(
    eventType: string,
    resourceKey: string | null,
    /** 事件原始载荷——执行器类事件需要从里面取 **id**（resourceKey 是地址）。 */
    payload?: unknown,
  ): Record<string, string[]> {
    const key = (resourceKey ?? "").trim();
    if (!key || key === "global") return {};

    switch (eventType) {
      case "execution.failed":
      case "execution.killed":
        // 执行类事件：execution 维度做重试/终止，task 维度做暂停/恢复。
        // 两个键都放同一个 id 是**刻意的**：事件只带一个 resourceKey
        // （`e.taskId ?? e.executionId`），无法在不查库的前提下区分它是
        // executionId 还是 taskId，故两处都登记——仍然只涉及"这一个"资源。
        return { executions: [key], tasks: [key] };
      case "executor.offline": {
        // ⚠️ 执行器离线事件的 resourceKey 是 **address**（`office:8002`），
        // 因为聚合要按"哪台机器"分组；而工具（executor 类）的 resourceIdParam
        // 要的是 **executorId**。直接把 address 塞进 scope 等于绑错维度——
        // 校验会拿 id 去和地址比，永远不匹配（实测：这条是被新断言抓出来的，
        // 首版实现正是错的）。
        // 故从事件载荷取 id；取不到就不绑（保守：该会话对执行器仍是只读）。
        const id =
          payload && typeof payload === "object"
            ? (payload as { executorId?: unknown }).executorId
            : undefined;
        return typeof id === "string" && id.trim()
          ? { executors: [id.trim()] }
          : {};
      }
      case "deployment.completed":
        return { applications: [key] };
      default:
        return {};
    }
  }

  private async handleEvent(
    eventType: string,
    resourceKey: string | null,
    payload: unknown,
    thresholdOverride?: number,
  ): Promise<void> {
    if (!this.enabled()) return;

    // 会话行是否真的建出来了：catch 里据此区分两种**方向相反**的故障
    // （见 recordEventTriggerFailed 的 note）。这里只是一个观测用的局部事实，
    // 不参与任何控制流——fail-open 的语义与修复前逐字一致。
    let sessionCreated = false;

    try {
      const verdict = this.aggregator.observe(
        eventType,
        resourceKey,
        payload,
        thresholdOverride,
      );

      if (verdict.action === "ignored") {
        this.logger.debug(`Event ignored: ${verdict.reason}`);
        return;
      }
      if (verdict.action === "accumulate") {
        this.logger.debug(
          `Event accumulated: ${eventType} ${verdict.count}/${verdict.needed}`,
        );
        return;
      }

      // ── 达阈值 → 起 incident 会话 ──
      const { trigger } = verdict;
      const kind: AgentSessionKind = "incident";
      const session = await this.sessions.create({
        kind,
        triggerSource: `event:${trigger.eventType}`,
        // G4：系统发起的会话没有「人」，发起人记 system 主体
        createdBy: `system:event:${trigger.eventType}`,
        title: this.buildTitle(trigger),
        context: {
          eventType: trigger.eventType,
          resourceKey: trigger.resourceKey,
          eventCount: trigger.count,
          windowMs: trigger.windowMs,
          samples: trigger.samples,
          // 聚合后的统计交给 Agent——它据此判断是「单点故障」还是「系统性」
          aggregated: true,
        },
        // 作用域：事件触发的会话绑定到**该事件涉及的资源**（设计文档 03 §5.3）。
        //
        // SCOPE-BIND（2026-10-27 审计轮 #11，A2）：此前这里是硬编码 `scope: {}`，
        // 注释写"刻意保守：不可操作任何资源"。**保守方向没错，但与白名单能力设计
        // 直接矛盾**——incident 白名单包含 trigger_task / retry_execution /
        // kill_execution / pause_task / resume_task，而这些工具的 resourceKind 是
        // task/execution，会走 validateScope；而 validateScope 对「该资源类型的
        // 允许集合为空」是**直接 deny out_of_scope**（boundary:344-351）。
        // 于是整个事件处置场景只剩 resourceKind=none 的只读工具可用——
        // 白名单里那五个收敛性写工具**一个都调不动**，功能是残的。
        //
        // 修法：把事件自身的 resourceKey 绑进 scope（这正是"绑定到该事件资源"
        // 的原意），**不放大**任何权限——会话仍然只能碰这一个资源：
        //   · execution.* → executions + tasks（重试/终止要按执行 id，暂停/恢复按任务）
        //   · executor.offline → executors
        //   · deployment.completed → applications
        // 认不出的形态保持空 scope（保守默认不倒退）。
        scope: this.buildEventScope(
          trigger.eventType,
          trigger.resourceKey,
          trigger.samples?.[0] ?? trigger,
        ),
      });

      sessionCreated = true;

      await this.queue.add(
        "run",
        { sessionId: session.id, reason: `event:${trigger.eventType}` },
        { jobId: session.id, attempts: 1 },
      );

      // 清理桶，让下个窗口重新累积
      this.aggregator.drain(trigger.eventType, trigger.resourceKey);

      this.logger.log(
        `Agent session triggered by aggregated event: ${session.id} (${trigger.eventType} x${trigger.count})`,
      );
    } catch (err: unknown) {
      // 静默降级轮：**先计数后 warn**（同一个 catch，同源）。fail-open 的语义
      // 一个字都不改——这里只多一条可查询的序列：事件已过阈值，这一轮却没跑起来。
      //   · sessionCreated=false ⇒ 会话行压根没建出来，该轮**不存在**；
      //   · sessionCreated=true  ⇒ 建了但没入列，它**永远不会跑**（列表上却像正常）。
      // 两种结论的分诊方向相反（写入面 vs 队列面），故用闭集 stage 分开。
      recordEventTriggerFailed(sessionCreated ? "enqueue" : "session_create");
      // 事件路径必须 fail-open——Agent 起不来绝不能影响执行主链
      this.logger.warn(
        `Agent event trigger failed (fail-open): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 人可读标题（Admin Web 列表展示）。 */
  private buildTitle(t: {
    eventType: string;
    resourceKey: string;
    count: number;
    windowMs: number;
  }): string {
    const mins = Math.round(t.windowMs / 60000) || 1;
    const what =
      t.eventType === "executor.offline"
        ? "执行器离线"
        : t.eventType === "execution.killed"
          ? "执行被终止"
          : "执行失败";
    return `${what} × ${t.count}（${t.resourceKey}，近 ${mins} 分钟）`;
  }

  // ── 定时触发 ────────────────────────────────────────────────────

  /**
   * 定时巡检。
   *
   * 频率：每小时（可配）。刻意**不用更短的间隔**——巡检会消耗 LLM 配额，
   * 而环境异常通常不是分钟级变化的。需要更实时响应的场景应走事件触发。
   *
   * 多副本安全：**扫描型 tick 仅 leader 执行**（复用 scheduler 的 leader 状态）。
   */
  @Cron("0 5 * * * *")
  async scheduledWatch(): Promise<void> {
    if (!this.enabled()) return;
    if (this.config.get<boolean>("agent.trigger.cronEnabled") === false) return;

    // ★ 多副本门禁：非 leader 直接跳过，否则 N 个副本会起 N 个会话
    if (!this.isLeader()) {
      this.logger.debug("scheduledWatch skipped: not the scheduler leader");
      return;
    }

    // ★ 熔断（2026-10-23 实测缺陷）：巡检的**失败发生在 LLM 调用阶段**
    // （job 内部），不在下面这个 try 里——于是 `createWatchSession` 每次都成功，
    // 失败会话照样每小时落一行。实测 demo 库 22 条一模一样的
    // `LLM call failed: Request failed with status code 403`，把 Agent 会话页
    // 刷成一片红，而没有任何机制叫停。
    //
    // 判据：最近 AGENT_WATCH_BREAKER_WINDOW 条 ops_watch 会话里**连续**失败数
    // 达到阈值即跳过本轮，并按 LOG_INTERVAL 节流告警（不刷日志）。
    // 用「连续」而非「窗口内计数」：一次成功即说明通道恢复，不应被更早的历史
    // 失败继续压制。
    const verdict = await this.watchBreakerVerdict();
    if (verdict.blocked) {
      this.skippedWatches += 1;
      if (this.skippedWatches % AGENT_WATCH_BREAKER_LOG_INTERVAL === 1) {
        this.logger.warn(
          `scheduledWatch skipped by breaker: ${verdict.consecutiveFailures} consecutive failed ops_watch sessions ` +
            `(last error: ${verdict.lastError ?? "unknown"}). ` +
            `Fix the LLM provider, or disable agent.trigger.cronEnabled. ` +
            `(${this.skippedWatches} skipped so far)`,
        );
      }
      return;
    }

    try {
      await this.createWatchSession();
      this.skippedWatches = 0;
    } catch (err: unknown) {
      this.logger.warn(
        `scheduledWatch failed (fail-open): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 巡检熔断判定：数最近若干条 ops_watch 会话里**连续** failed 的条数。
   *
   * 失败姿态：查询出错时**放行**（blocked=false）——熔断器自己坏了不该让巡检
   * 彻底停摆，最多回到修复前的行为（继续刷失败会话）。
   *
   * 这条 fail-open 的**代价**（静默降级轮 ①）是「闸门失明」：放行不是判定结论，
   * 而是默认值。故 catch 里同时 +1 `autoflow_agent_watch_breaker_check_failed_total`
   * ——语义不变，只是让「闸门瞎着还在跑」变成一条可查询、可告警的序列。
   */
  private async watchBreakerVerdict(): Promise<{
    blocked: boolean;
    consecutiveFailures: number;
    lastError: string | null;
  }> {
    try {
      const { items } = await this.sessions.list({
        kind: "ops_watch",
        page: 1,
        pageSize: AGENT_WATCH_BREAKER_WINDOW,
      });
      let consecutive = 0;
      let lastError: string | null = null;
      for (const s of items) {
        // 只统计终态失败；仍在跑/等输入的不参与判定（它们不是失败）。
        if (s.status !== "failed") break;
        consecutive += 1;
        lastError ??= s.errorMessage ?? null;
      }
      return {
        blocked: consecutive >= AGENT_WATCH_BREAKER_THRESHOLD,
        consecutiveFailures: consecutive,
        lastError,
      };
    } catch (err: unknown) {
      // 静默降级轮：**先计数后 warn**（同一个 catch ⇒ 「日志里有一条 warn」与
      // 「计数器 +1」永远同源）。计数本身不参与返回值——下面这行 `blocked: false`
      // 是**语义**，本轮一个字都不改。
      //
      // 这里必须可查询的理由：`blocked=false` 在这一分支**不代表**「provider 健康」，
      // 它代表「不知道」。闸门失明 ⇒ 每个 cron 周期继续派发注定失败的 ops_watch
      // 会话（烧 LLM 额度 + 刷错误会话），而业务指标上它与「provider 真病了一小时」
      // 完全同形。见 WATCH_BREAKER_CHECK_FAILED_METRIC 的长注释。
      recordWatchBreakerCheckFailed();
      this.logger.warn(
        `watch breaker check failed (fail-open, will still schedule): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { blocked: false, consecutiveFailures: 0, lastError: null };
    }
  }

  /** 建一个运维巡检会话（也供人工/测试触发，故独立成方法）。 */
  async createWatchSession(): Promise<string> {
    const session = await this.sessions.create({
      kind: "ops_watch",
      triggerSource: "cron",
      createdBy: "system:cron",
      title: "定时环境巡检",
      context: {
        instruction:
          "请巡检平台当前状态：检查执行器在线情况、调度器健康、近期执行失败率。" +
          "只在发现异常时给出结论与建议；一切正常则简短说明即可。",
      },
      // 巡检**纯只读**：ops_watch 的工具白名单已限制为 read 类，
      // scope 再收一道（空 = 不可操作任何资源）。
      scope: {},
    });

    await this.queue.add(
      "run",
      { sessionId: session.id, reason: "trigger:cron" },
      { jobId: session.id, attempts: 1 },
    );

    this.logger.log(`Agent watch session created: ${session.id}`);
    return session.id;
  }

  /** 清理过期聚合桶（定时，防内存泄漏）。 */
  @Cron("0 */10 * * * *")
  sweepAggregator(): void {
    if (!this.isLeader()) return;
    const removed = this.aggregator.sweep();
    if (removed > 0) {
      this.logger.debug(`Aggregator swept ${removed} expired bucket(s)`);
    }
  }

  // ── 辅助 ────────────────────────────────────────────────────────

  /**
   * 是否为本实例是 leader。
   *
   * 复用 `SchedulerService.getStats().isLeader`——与既有 scheduler 的扫描型
   * tick 同一门禁。**不另造一套 leader 选举**（两套选举会产生「都认为自己是
   * leader」的窗口，那是最难排查的一类 bug）。
   */
  private isLeader(): boolean {
    try {
      return this.scheduler.getStats().isLeader === true;
    } catch {
      // 读不到 leader 状态时**保守跳过**：宁可少巡检，不可多副本重复触发
      return false;
    }
  }

  private enabled(): boolean {
    const raw = this.config.get<unknown>("agent.trigger.enabled");
    if (raw === undefined || raw === null || raw === "") return true; // 默认开
    if (typeof raw === "boolean") return raw;
    const s = String(raw).trim().toLowerCase();
    return s !== "false" && s !== "0";
  }
}
