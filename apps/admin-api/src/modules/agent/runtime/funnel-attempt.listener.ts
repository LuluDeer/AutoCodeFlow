/**
 * R318（TTFV §7.7）：task_first_attempted 漏斗埋点 listener。
 *
 * 订阅 COMPLETED(success) 与 FAILED(failed/timeout/killed) 两个终态（同一
 * handler），即「首次触发执行，无论成败」——消除 R313 用 task_first_success
 * 代理 §1.2 激活率分子造成的低估。载荷无 synthetic/指纹，故必须回查执行行
 * 并显式排除 synthetic=true（合成行非真实尝试，与 R291 代理口径一致）。
 * 回查 executor.deviceFingerprint 后派生 install/task/execution 匿名 ID，
 * 经 FunnelEventsService 写入漏斗事实表。viaRelay 载荷跳过，避免多副本重复
 * 写入（§7.3）。两个终态谁先到谁写 first-attempted，orIgnore dedupe 保证
 * 同一 task 只落一条。
 *
 * 副作用 listener 全程 fail-open：任何回查/派生/写入异常只 warn，绝不把错误
 * 回灌事件总线或主链（DomainEventBus 自身亦 fail-open，但 listener 自稳）。
 * funnel.record 内含 opt-in 单一闸门，本 listener 不重复判授权。
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import {
  DOMAIN_EVENTS,
  ExecutionTerminalEventPayload,
} from "../../../common/events/domain-events";
import { DomainEventBus } from "../../../common/services/domain-event-bus.service";
import { SecretsCryptoService } from "../../../common/utils/secret-crypto.util.service";
import { Executor } from "../../executor/entities/executor.entity";
import { TaskExecution } from "../../task/entities/task-execution.entity";
import { FunnelEventsService } from "./funnel-events.service";

@Injectable()
export class FunnelAttemptListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FunnelAttemptListener.name);

  constructor(
    private readonly bus: DomainEventBus,
    private readonly funnel: FunnelEventsService,
    private readonly crypto: SecretsCryptoService,
    @InjectRepository(TaskExecution)
    private readonly executions: Repository<TaskExecution>,
    @InjectRepository(Executor)
    private readonly executors: Repository<Executor>,
  ) {}

  onModuleInit(): void {
    this.bus.on(DOMAIN_EVENTS.EXECUTION_COMPLETED, this.onFirstAttempted);
    this.bus.on(DOMAIN_EVENTS.EXECUTION_FAILED, this.onFirstAttempted);
    // KILLED 走独立事件（task.service.emitKilledEvent，不经 emitTerminalEvent），
    // 但载荷形状与 ExecutionTerminalEventPayload 完全一致——管理员 kill 的
    // synthetic=false 执行也是真实"首次触发"，必须计入激活分子（R318 C 复核补齐）。
    this.bus.on(DOMAIN_EVENTS.EXECUTION_KILLED, this.onFirstAttempted);
  }

  onModuleDestroy(): void {
    this.bus.off(DOMAIN_EVENTS.EXECUTION_COMPLETED, this.onFirstAttempted);
    this.bus.off(DOMAIN_EVENTS.EXECUTION_FAILED, this.onFirstAttempted);
    this.bus.off(DOMAIN_EVENTS.EXECUTION_KILLED, this.onFirstAttempted);
  }

  onFirstAttempted = async (
    event: ExecutionTerminalEventPayload,
  ): Promise<void> => {
    try {
      // 跨实例 relay 的副本不得重复写漏斗（起源实例已写入）。
      if (event?.viaRelay) return;
      // 缺数据诚实跳过：taskId 可能因任务级联清理为 null（domain-events.ts:194）。
      if (!event.taskId) return;
      // finishedAt 缺失时不以当前时间伪造事件时间（TTFV 分母/分子口径要真实 ts）。
      if (!event.finishedAt) return;

      const execution = await this.executions.findOne({
        where: { id: event.executionId },
      });
      // 合成行（synthetic=true）非真实尝试，与 R291 代理口径一致，必须排除。
      if (execution?.synthetic === true) return;

      const executorId = execution?.executorId;
      if (!executorId) return;

      const executor = await this.executors.findOne({
        where: { id: executorId },
      });
      const fingerprint = executor?.deviceFingerprint;
      if (!fingerprint) return;

      // 无密钥（degraded）时 deriveAnonymousId 返回 null：诚实缺失，不伪造 ID。
      const installId = this.crypto.deriveAnonymousId(
        fingerprint,
        "ttfv-install",
      );
      if (!installId) return;
      const taskIdHash = this.crypto.deriveAnonymousId(
        event.taskId,
        "ttfv-task",
      );
      if (!taskIdHash) return;
      const executionIdHash =
        this.crypto.deriveAnonymousId(event.executionId, "ttfv-execution") ??
        null;

      await this.funnel.record({
        installId,
        eventName: "task_first_attempted",
        taskIdHash,
        executionIdHash,
        dedupeKey: `first-attempted:${taskIdHash}`,
        ts: new Date(event.finishedAt),
      });
    } catch (err: unknown) {
      this.logger.warn(
        `TTFV task_first_attempted listener failed for execution ${event?.executionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };
}
