/**
 * R325（北极星严格判据 §6 步骤3）：business_confirmed 漏斗埋点 listener。
 *
 * 订阅 execution.confirmed（显式确认端点在确认成功后 emit），按 executionId
 * 回查执行行 → executor.deviceFingerprint，派生 install/execution 匿名 ID，
 * 经 FunnelEventsService 写入漏斗事实表。事件载荷无指纹（§6 步骤2），故必须
 * 回查；viaRelay 载荷跳过，避免多副本重复写入。
 *
 * ts 取载荷 confirmedAt（确认真实时间），不以当前时间伪造——北极星按周聚合
 * 要真实确认时刻（§5）。dedupeKey = `confirmed:<execution_id_hash>`（§5 拍板，
 * 指标脚本哨针的 `confirmed:` 前缀来源，不许改）。
 *
 * 副作用 listener 全程 fail-open：任何回查/派生/写入异常只 warn，绝不把错误
 * 回灌事件总线或主链。funnel.record 内含 opt-in 单一闸门，本 listener 不重复判授权。
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
  ExecutionConfirmedEventPayload,
} from "../../../common/events/domain-events";
import { DomainEventBus } from "../../../common/services/domain-event-bus.service";
import { SecretsCryptoService } from "../../../common/utils/secret-crypto.util.service";
import { Executor } from "../../executor/entities/executor.entity";
import { TaskExecution } from "../../task/entities/task-execution.entity";
import { FunnelEventsService } from "./funnel-events.service";

@Injectable()
export class FunnelConfirmationListener
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(FunnelConfirmationListener.name);

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
    this.bus.on(DOMAIN_EVENTS.EXECUTION_CONFIRMED, this.onConfirmed);
  }

  onModuleDestroy(): void {
    this.bus.off(DOMAIN_EVENTS.EXECUTION_CONFIRMED, this.onConfirmed);
  }

  onConfirmed = async (
    event: ExecutionConfirmedEventPayload,
  ): Promise<void> => {
    try {
      // 缺 executionId 跳过：后续回查/派生都依赖它。
      if (!event?.executionId) return;
      // confirmedAt 缺失时不以当前时间伪造事件时间（漏斗口径要真实确认时刻）。
      if (!event.confirmedAt) return;
      // 跨实例 relay 的副本不得重复写漏斗（起源实例已写入）。
      // 载荷契约无该字段，仍做防御性检查（PK-14 增量字段兼容）。
      if ((event as any)?.viaRelay) return;

      const execution = await this.executions.findOne({
        where: { id: event.executionId },
      });
      // 合成行（synthetic=true）非真实确认尝试，与其他 listener 对齐排除。
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
      const executionIdHash = this.crypto.deriveAnonymousId(
        event.executionId,
        "ttfv-execution",
      );
      if (!executionIdHash) return;

      await this.funnel.record({
        installId,
        eventName: "business_confirmed",
        executionIdHash,
        // 北极星只按 execution + install 聚合：taskId 可空，null 时诚实传 null。
        taskIdHash: event.taskId
          ? (this.crypto.deriveAnonymousId(event.taskId, "ttfv-task") ?? null)
          : null,
        dedupeKey: `confirmed:${executionIdHash}`,
        ts: new Date(event.confirmedAt),
      });
    } catch (err: unknown) {
      this.logger.warn(
        `TTFV business_confirmed listener failed for execution ${event?.executionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };
}
