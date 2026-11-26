import { Module, OnModuleInit, Logger, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";
import { BullModule, InjectQueue } from "@nestjs/bullmq";
// R305：TelemetryOptinService 的总闸读 SystemConfigService（DB 动态开关，非 env）。
// SystemConfigModule 只依赖 TypeOrmModule，与 AgentModule 无循环依赖。
import { SystemConfigModule } from "../config/config.module";
import type { Queue } from "bullmq";

import { AgentSession } from "./entities/agent-session.entity";
import { AgentStep } from "./entities/agent-step.entity";
import { AgentToolCall } from "./entities/agent-tool-call.entity";
import { AgentApproval } from "./entities/agent-approval.entity";
// S7-G1：取证型事件日志。写入口走 `sessions.manager`（无需仓储），这里登记是为了
// `AgentSessionRetentionService` 的 `@InjectRepository(AgentEvent)` 能解析——
// 不登记时 `@Optional()` 会把它降级成 undefined，保留期清理就**静默不执行**
// （一张永不清理的新表），这比抛装配错误危险得多。
import { AgentEvent } from "./entities/agent-event.entity";
import { FunnelEvent } from "./entities/funnel-event.entity";
// R305：opt-in 授权闸门的状态载体（默认不采集；双闸判定见 TelemetryOptinService）。
import { TelemetryOptin } from "./entities/telemetry-optin.entity";
// R307：task_first_success listener 按 executionId 回查执行行→执行器指纹。
import { TaskExecution } from "../task/entities/task-execution.entity";
import { Executor } from "../executor/entities/executor.entity";
import { AgentSessionService } from "./runtime/agent-session.service";
import { AgentBacklogService } from "./runtime/agent-backlog.service";
import { AgentBacklogAutoReenqueueService } from "./runtime/agent-backlog-auto-reenqueue.service";
import { AgentApprovalWakeupService } from "./runtime/agent-approval-wakeup.service";
import { AgentBacklogReenqueueClaim } from "./runtime/agent-backlog-reenqueue-claim";
import { AgentQueueStallService } from "./runtime/agent-queue-stall.service";
import { AgentQueueIdleService } from "./runtime/agent-queue-idle.service";
import { AgentApprovalsService } from "./runtime/agent-approvals.service";
import { AgentBudgetService } from "./runtime/agent-budget.service";
import {
  AgentRuntimeService,
  AUTO_RESUME_WAITING_FOR,
} from "./runtime/agent-runtime.service";
import {
  AgentProcessor,
  AGENT_QUEUE_NAME,
  type AgentJobData,
} from "./runtime/agent.processor";
import { AgentNotifyService } from "./runtime/agent-notify.service";
import { FunnelEventsService } from "./runtime/funnel-events.service";
import { FunnelSuccessListener } from "./runtime/funnel-success.listener";
// R318：首次触发执行（COMPLETED + FAILED，排除 synthetic）→ task_first_attempted。
import { FunnelAttemptListener } from "./runtime/funnel-attempt.listener";
import { FunnelInstallListener } from "./runtime/funnel-install.listener";
// R325（北极星「被业务确认」）：显式确认端点 service + business_confirmed 漏斗 listener。
import { AgentExecutionConfirmationService } from "./runtime/agent-execution-confirmation.service";
import { FunnelConfirmationListener } from "./runtime/funnel-confirmation.listener";
// R327：北极星双口径周报读面（注入 DataSource，两条原生 SQL 只读对账）。
import { NorthStarMetricsService } from "./runtime/north-star-metrics.service";
import { FunnelEventsRetentionService } from "./runtime/funnel-events-retention.service";
import { TelemetryOptinService } from "./runtime/telemetry-optin.service";
import {
  autoResumeJobId,
  autoResumeJobOptions,
} from "./runtime/agent-job-options";
import { AgentController } from "./agent.controller";
import { AgentSessionRetentionService } from "./agent-session-retention.service";
// R278：待办收件箱的服务端聚合（S1，独立 provider）。
import { AgentInboxService } from "./runtime/agent-inbox.service";
// N8：steer inbox（进程内 provider；runtime/controller 同注入一个实例）。
import { SteerInboxService } from "./runtime/steer-inbox.service";
import { AgentBoundaryService } from "./boundary/agent-boundary.service";
import { ToolExecutorService } from "./tools/tool-executor.service";
import { AgentApiClient } from "./tools/agent-api.client";
import { ToolBinderService } from "./tools/tool-binder.service";
import { AiModule } from "../ai/ai.module";
import { TaskModule } from "../task/task.module";
import { TaskTemplateModule } from "../task-template/task-template.module";
import { ExecutorModule } from "../executor/executor.module";
import { ApplicationModule } from "../application/application.module";
import { SchedulerModule } from "../scheduler/scheduler.module";
import { NotificationModule } from "../notification/notification.module";
import { SopModule } from "../sop/sop.module";
import { AgentTriggerService } from "./trigger/agent-trigger.service";
import { AgentEventAggregator } from "./trigger/agent-event-aggregator.service";

/**
 * P3（agent-and-deployment）：中台 Agent 运行时 + 工具集 + 边界闸门。
 *
 * ## 单向依赖（结构性保证「Agent 失败绝不影响主链」）
 * 本模块**依赖** ai/task/executor/application，但**不被任何业务模块依赖**。
 * 因此 Agent 崩溃、卡死、烧穿预算，都不可能回灌到调度/执行主链——这是
 * 设计文档 02 §2.1 的纪律，也是既有 `ai` 模块 fail-open 姿态的延续。
 *
 * 依赖里用 `forwardRef` 的原因：task/application 模块在装配期也需要
 * 引用彼此的 service（项目既有模式），循环引用由 Nest 的 forwardRef 化解。
 * 注意这里的环是**装配期**的，不是运行期调用链——Agent 仍然只被
 * 本模块的 controller/processor 触发。
 *
 * ## 独立队列（资源隔离）
 * `agent-jobs` 与 `task-queue` 分开，并发固定 2（见 processor）。
 */
@Module({
  imports: [
    ConfigModule,
    SystemConfigModule,
    TypeOrmModule.forFeature([
      AgentSession,
      AgentStep,
      AgentToolCall,
      AgentApproval,
      AgentEvent,
      FunnelEvent,
      TelemetryOptin,
      // R307：listener 回查用的执行行 / 执行器（只读；不改 exports）。
      TaskExecution,
      Executor,
    ]),
    BullModule.registerQueue({ name: AGENT_QUEUE_NAME }),
    AiModule,
    forwardRef(() => TaskModule),
    // P6 补齐：create_task_from_template 的执行体（TaskTemplateService）
    TaskTemplateModule,
    forwardRef(() => ExecutorModule),
    forwardRef(() => ApplicationModule),
    // P4: leader 门禁复用 SchedulerService（不另造选举）；通知渠道用于
    // 审批请求与升级通知。
    forwardRef(() => SchedulerModule),
    NotificationModule,
    // P5/P6: SOP 工具体（ToolBinder 绑定 sop_* 到 SopService）。
    forwardRef(() => SopModule),
  ],
  controllers: [AgentController],
  providers: [
    AgentSessionService,
    // R202：与队列「对账」（积压判据的接线层）。独立 provider ——
    // 它是唯一需要 `@InjectQueue` 的会话侧服务（session service 刻意不依赖队列）。
    AgentBacklogService,
    // R216：「积压」的**自动补入队**（唯一一条自动处置的判据 —— 因为不补它就永远不会跑）。
    // 额度领取外提成协作者：`agent-session.service.ts` 已在 size-caps 基线上顶格。
    AgentBacklogReenqueueClaim,
    AgentBacklogAutoReenqueueService,
    // R296：审批 granted 丢失唤醒的尾钩补偿（独立 provider；session 不注入它，反向注册避免 DI 成环）。
    AgentApprovalWakeupService,
    // R205：队列「停摆」观测（结构性信号：worker 注册表 / 队列是否被暂停）。
    AgentQueueStallService,
    // R207：队列「空转」观测（worker 在册却不再消费 —— 停摆判据的互补格）。
    // 与 stall 服务并列注册：两者读同一队列、但问的是不同问题（R399 互补纪律）。
    AgentQueueIdleService,
    AgentApprovalsService,
    AgentBudgetService,
    AgentRuntimeService,
    AgentProcessor,
    // P3：边界闸门 + 工具执行器 + 执行体客户端 + 只读工具绑定
    AgentBoundaryService,
    ToolExecutorService,
    AgentApiClient,
    ToolBinderService,
    // P4：事件聚合器 + 触发器（定时 + 事件）+ 会话通知（§7.2）
    AgentEventAggregator,
    AgentTriggerService,
    AgentNotifyService,
    // B-10：会话域 retention（终态 steps 90 天、tool_calls 按 tier 保留）
    AgentSessionRetentionService,
    // R278：待办收件箱的服务端聚合（一次 find + 一次 count + 一次 In 批量取标题）。
    // 独立 provider：agent-approvals.service.ts / agent-session.service.ts 都在
    // size-caps 的「逐文件只减不增」基线上，就地新增必然破顶。
    AgentInboxService,
    // N8：waiting_input 期 steer 意图的进程内 inbox（独立 provider，无 DB/队列依赖）。
    SteerInboxService,
    // R302：TTFV 阶段2 的 append-only 漏斗事件写入口（独立 provider，不碰顶格文件）。
    FunnelEventsService,
    // R303：90 天滚动清理（TTFV §3.2；独立 provider，不改写入口/实体）。
    FunnelEventsRetentionService,
    // R305：授权闸门（系统总闸 + install 级 opt_in 双闸；独立 provider）。
    TelemetryOptinService,
    // R307：SUCCESS 终态 → task_first_success 漏斗事件（副作用 listener）。
    FunnelSuccessListener,
    // R318：首次触发执行（success/failed 双终态，排除 synthetic）
    // → task_first_attempted（24h 激活率精确分子）。
    FunnelAttemptListener,
    // R309：首次注册 → install_completed 漏斗事件（副作用 listener）。
    FunnelInstallListener,
    // R325：显式确认端点 → execution.confirmed → business_confirmed 漏斗事件。
    AgentExecutionConfirmationService,
    FunnelConfirmationListener,
    // R327：双口径周报读面（GET /agent/north-star/metrics）。
    NorthStarMetricsService,
  ],
  exports: [
    AgentSessionService,
    AgentRuntimeService,
    AgentBudgetService,
    AgentBoundaryService,
    AgentApiClient,
  ],
})
export class AgentModule implements OnModuleInit {
  private readonly logger = new Logger(AgentModule.name);

  constructor(
    private readonly runtime: AgentRuntimeService,
    private readonly executor: ToolExecutorService,
    private readonly approvals: AgentApprovalsService,
    private readonly api: AgentApiClient,
    // R296：把 wakeup.probe 反向注册给 session（两端都由本模块注入，无环）。
    private readonly sessions: AgentSessionService,
    private readonly wakeup: AgentApprovalWakeupService,
    // GAP-3：LLM 瞬态耗尽的自动续跑出队口（agent-jobs delayed job）。
    @InjectQueue(AGENT_QUEUE_NAME)
    private readonly agentQueue: Queue<AgentJobData>,
    // N8：runtime 只持有 drain 口；装配在 onModuleInit，缺席即 fail-open（同 toolExecutor）。
    private readonly steerInboxes: SteerInboxService,
  ) {}

  /**
   * 装配工具执行器。
   *
   * 为什么在 onModuleInit 而不是构造期：`AgentRuntimeService` 持有的是
   * **接口**（`AgentToolExecutor`），模块加载完成后再注入具体实现，避免
   * 「循环服务的构造期引用」这类问题（工具执行器依赖 session service，
   * 而 session service 与 runtime 同层）。
   *
   * 这个装配点也是 P2 设计「循环与工具用接口切开」的兑现处：接工具集
   **不需要改动循环逻辑**。
   */
  onModuleInit(): void {
    // R296：markWaiting 命中后回读补偿入队。端口反向注册——session 服务既不
    // 注入 wakeup 也不注入 queue；wakeup 注入 session 但不认识本模块 ⇒ DI 无环。
    this.sessions.attachApprovalWakeupProbe(
      this.wakeup.probe.bind(this.wakeup),
    );
    this.runtime.setToolExecutor(this.executor);
    // TOOLS-02：重放文案要知道审批单真实状态（已批准 → 提示重提执行）。
    this.runtime.setApprovals(this.approvals);
    // N8：同一个进程内 inbox 实例同时供 controller.park 与 runtime.drain。
    this.runtime.setSteerInbox(this.steerInboxes);
    // GAP-3：LLM 瞬态耗尽的自动续跑出队口——agent-jobs delayed job（60s）。
    //
    // jobId 固定为「会话 id + 用途」：同一会话重复收敛（重试耗尽与并发判定
    // 撞车）只留一个补跑 job。`removeOnComplete: true` 是必须的——补跑 job
    // 成功后若不删，固定 jobId 会永久命中已完成的旧 job，后续任何补跑都
    // 静默变成 no-op（BullMQ 的 jobId 去重不分状态）。
    //
    // setToolExecutor 同款 onModuleInit 装配：runtime 只认「能延迟入队的
    // 通道」接口，不依赖具体队列实现（单测零装配即保持旧行为）。
    const queue = this.agentQueue;
    this.runtime.enqueueLlmResume = async (
      sessionId: string,
      delayMs: number,
    ) => {
      try {
        // jobId/选项走纯函数（agent-job-options.ts）：BullMQ 拒绝含单个冒号
        // 的自定义 id，这条规则必须在单测里钉住，而不是靠「恰好 3 段」。
        await queue.add(
          "run",
          {
            sessionId,
            reason: "resume:llm-transient",
            expectWaitingFor: AUTO_RESUME_WAITING_FOR,
          },
          {
            jobId: autoResumeJobId(sessionId),
            ...autoResumeJobOptions(delayMs),
          },
        );
        return true;
      } catch (err) {
        this.logger.warn(
          `Agent llm-resume enqueue failed (session=${sessionId}): ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
    };
    this.logger.log(
      `Agent tool executor wired. Implemented tools: ${this.api.implementedTools().length}`,
    );
  }
}
