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

  /** 事件监听器引用（退订用——总线是全局单例，不退订会留悬挂监听）。 */
  private readonly onExecutionFailed = async (
    e: ExecutionTerminalEventPayload,
  ): Promise<void> => {
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
  private async handleEvent(
    eventType: string,
    resourceKey: string | null,
    payload: unknown,
    thresholdOverride?: number,
  ): Promise<void> {
    if (!this.enabled()) return;

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
        // 作用域：事件触发的会话绑定到该事件资源（设计文档 03 §5.3）
        // 缺省空 scope = 不可操作任何资源，Agent 只能读、只能上报。
        // 这是刻意保守：自动触发的会话不该有写权限。
        scope: {},
      });

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

    try {
      await this.createWatchSession();
    } catch (err: unknown) {
      this.logger.warn(
        `scheduledWatch failed (fail-open): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 建一个运维巡检会话（也供人工/测试触发，故独立成方法）。 */
  async createWatchSession(): Promise<string> {
    const session = await this.sessions.create({
      kind: "ops_watch",
      triggerSource: "cron",
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
