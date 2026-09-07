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

@Injectable()
export class ExecutionEventsListener
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ExecutionEventsListener.name);

  constructor(
    private readonly bus: DomainEventBus,
    private readonly notificationService: NotificationService,
    private readonly auditService: AuditService,
    @InjectRepository(Task)
    private readonly taskRepo: Repository<Task>,
  ) {}

  onModuleInit(): void {
    this.bus.on(DOMAIN_EVENTS.EXECUTION_FAILED, this.onExecutionFailed);
  }

  onModuleDestroy(): void {
    this.bus.off(DOMAIN_EVENTS.EXECUTION_FAILED, this.onExecutionFailed);
  }

  /**
   * 失败类终态（FAILED/TIMEOUT；未来 KILLED 的 sweep 路径接入时语义同样
   * 成立）→ 告警通知。SUCCESS 不发通知——与迁移前主链行为一致（旧代码仅
   * FAILED/TIMEOUT 触发告警），execution.completed 事件现阶段供 FEAT-07
   * 出站 webhook 等未来消费者，通知侧刻意不订阅。
   */
  onExecutionFailed = async (
    event: ExecutionTerminalEventPayload,
  ): Promise<void> => {
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
}
