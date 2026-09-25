import { Module, OnModuleInit, Logger, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";
import { BullModule } from "@nestjs/bullmq";

import { AgentSession } from "./entities/agent-session.entity";
import { AgentStep } from "./entities/agent-step.entity";
import { AgentToolCall } from "./entities/agent-tool-call.entity";
import { AgentSessionService } from "./runtime/agent-session.service";
import { AgentBudgetService } from "./runtime/agent-budget.service";
import { AgentRuntimeService } from "./runtime/agent-runtime.service";
import { AgentProcessor, AGENT_QUEUE_NAME } from "./runtime/agent.processor";
import { AgentNotifyService } from "./runtime/agent-notify.service";
import { AgentController } from "./agent.controller";
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
    TypeOrmModule.forFeature([AgentSession, AgentStep, AgentToolCall]),
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
    private readonly api: AgentApiClient,
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
   * **不需要改动循环逻辑**。
   */
  onModuleInit(): void {
    this.runtime.setToolExecutor(this.executor);
    this.logger.log(
      `Agent tool executor wired. Implemented tools: ${this.api.implementedTools().length}`,
    );
  }
}
