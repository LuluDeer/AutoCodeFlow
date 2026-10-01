/**
 * ARCH-21: 执行终态事件的通知监听器。
 *
 * 迁移来源：task.service.ts 的私有方法 `notifyCallbackFailure`（改动1，执行器
 * 回调报出真实失败终态 FAILED/TIMEOUT 时发送告警）。逐行等价迁移——
 * - 配置来源仍为 Task 实体的 alarmEmail / alarmChannels / runbook（taskRepo
 *   回查，事件载荷只带 id 级信息，见 domain-events.ts 设计约束）；
 * - 摘要仍为 failureReason + errorMessage（缺省回退回调日志头行），截 500 字符；
 * - aiAnalysis 随事件载荷透传（handleCallback 在终态 UPDATE 前读的执行行快照，
 *   该 UPDATE 不触碰 aiAnalysis——与迁移前直读实体的取值时序等价）；
 * - fail-open + NOTIFICATION_FAILED 审计兜底原样保留（总线本身也 fail-open，
 *   这里是监听器内部对"通知/查库自身抛错"的第二层兜底，语义同前）。
 *
 * 注册生命周期：OnModuleInit 订阅 / OnModuleDestroy 退订——总线是 @Global
 * 单例，应用重启/测试模块反复装配时不留悬挂监听。
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Task } from "../task/entities/task.entity";
import {
  DOMAIN_EVENTS,
  ExecutionTerminalEventPayload,
} from "../../common/events/domain-events";
import { DomainEventBus } from "../../common/services/domain-event-bus.service";
import { AuditService } from "../audit/audit.service";
import { NotificationService } from "./notification.service";
// DEEP-AUDIT B·1.6: 失败通知聚合窗——失败类终态先尝试入窗，窗到期发一条汇总，
// 告警风暴（同任务高频失败）不再逐条轰炸全渠道。
import {
  DigestDecision,
  NotificationDigestService,
} from "./notification-digest.service";

@Injectable()
export class ExecutionEventsListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExecutionEventsListener.name);

  constructor(
    private readonly bus: DomainEventBus,
    private readonly notificationService: NotificationService,
    private readonly auditService: AuditService,
    @InjectRepository(Task)
    private readonly taskRepo: Repository<Task>,
    // @Optional：存量测试模块未装配 digest 时自动回退逐条直发（既有行为），
    // 生产模块（notification.module.ts）始终提供。
    @Optional()
    private readonly digestService?: NotificationDigestService,
  ) {}

  onModuleInit(): void {
    this.bus.on(DOMAIN_EVENTS.EXECUTION_FAILED, this.onExecutionFailed);
    // FEAT-18: KILLED 终态事件复用 failed 的通知路径——管理员手动 kill 同属
    // 「执行非成功终态」，告警语义一致（载荷形状同为 ExecutionTerminalEventPayload，
    // 管理员动作的结果更应让值守知晓）。直接对齐 failed 语义，不设开关。
    this.bus.on(DOMAIN_EVENTS.EXECUTION_KILLED, this.onExecutionFailed);
  }

  onModuleDestroy(): void {
    this.bus.off(DOMAIN_EVENTS.EXECUTION_FAILED, this.onExecutionFailed);
    this.bus.off(DOMAIN_EVENTS.EXECUTION_KILLED, this.onExecutionFailed);
  }

  /**
   * 失败类终态（FAILED/TIMEOUT；FEAT-18 起 KILLED 经 execution.killed 也走
   * 本方法，语义同样成立）→ 告警通知。SUCCESS 不发通知——与迁移前主链行为
   * 一致（旧代码仅 FAILED/TIMEOUT 触发告警），execution.completed 事件现阶段
   * 供 FEAT-07 出站 webhook 等未来消费者，通知侧刻意不订阅。
   */
  onExecutionFailed = async (
    event: ExecutionTerminalEventPayload,
  ): Promise<void> => {
    // 第四轮审计（A3）: 跨实例 relay 补发的载荷跳过——告警副作用在起源实例
    // 本地 emit 时已执行，多副本下不跳过 = 双倍通知（viaRelay 契约见
    // execution-events-relay.service.ts / domain-events.ts）。
    if (event?.viaRelay) return;
    const taskName = event.taskName ?? event.taskId ?? event.executionId;
    // 通知内容摘要：failureReason + errorMessage（缺省回退到回调日志头），
    // 控制在 500 字符内，避免把整段日志塞进告警。
    const detail =
      event.errorMessage ||
      (event.logs ? event.logs.split("\n")[0] : "") ||
      "no detail";
    const errorSummary = `${event.failureReason ?? "UNKNOWN"}: ${detail}`.slice(
      0,
      500,
    );
    try {
      const task = event.taskId
        ? await this.taskRepo.findOne({ where: { id: event.taskId } })
        : null;

      // DEEP-AUDIT B·1.6: 先尝试入聚合窗（NOTIFICATION_FAILURE_DIGEST_MINUTES，
      // 默认 10；0=关闭）。返回 aggregated 表示失败已入窗、汇总在窗到期时由
      // digest 服务发出（本路径跳过逐条直发）；bypass/服务未装配/入窗过程任何
      // 异常 → 回退逐条即时发送的既有行为（fail-open，绝不吞告警）。
      const decision = await this.tryRecordDigest(event, taskName, errorSummary, task);
      if (decision === "aggregated") return;

      await this.notificationService.notifyFailureWithConfig(
        taskName,
        event.executionId,
        errorSummary,
        event.aiAnalysis ?? "",
        task?.alarmEmail,
        task?.alarmChannels,
        undefined,
        event.taskId ?? undefined,
        task?.runbook,
        // NETOPT-5①: 透传应用上下文——scope=application 的静默只应命中
        // 该应用下任务的通知（此前 isSilenced 完全忽略 scope，应用级静默
        // 等于全平台消音）。Task 实体本就为此处 alarmEmail/runbook 回查所得。
        task?.applicationId ?? undefined,
      );
    } catch (err: unknown) {
      const notifyErrMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Notification failed for callback of execution ${event.executionId}: ${notifyErrMsg}`,
      );
      try {
        await this.auditService.log({
          action: "NOTIFICATION_FAILED",
          resource: "task_execution",
          resourceId: event.executionId,
          detail: { task: taskName, error: notifyErrMsg },
        });
      } catch {
        /* audit is best-effort */
      }
    }
  };

  /**
   * 失败入聚合窗。digest 服务未装配（@Optional 缺省）→ undefined → 直发；
   * recordFailure 内部 fail-open（Redis 不可用等返回 bypass），这里再兜一层
   * try/catch——digest 链路的任何意外都绝不阻断逐条直发的既有告警语义。
   */
  private tryRecordDigest(
    event: ExecutionTerminalEventPayload,
    taskName: string,
    errorSummary: string,
    task: Task | null,
  ): Promise<DigestDecision | undefined> {
    const digest = this.digestService;
    if (!digest) return Promise.resolve(undefined);
    return digest
      .recordFailure({
        taskId: event.taskId ?? undefined,
        taskName,
        failureReason: event.failureReason ?? "UNKNOWN",
        errorSummary,
        executionId: event.executionId,
        alarmEmail: task?.alarmEmail,
        alarmChannels: task?.alarmChannels,
        runbook: task?.runbook,
        applicationId: task?.applicationId ?? undefined,
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `digest record rejected for execution ${event.executionId}（回退逐条发送）: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return undefined;
      });
  }
}
