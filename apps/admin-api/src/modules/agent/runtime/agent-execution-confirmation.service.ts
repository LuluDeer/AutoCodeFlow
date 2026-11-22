/**
 * R325（北极星「被业务确认」判据，§6 步骤 1-2）：显式确认端点的业务 service。
 *
 * 职责边界（严格保持薄）：
 * - 按 executionId 回查 TaskExecution 确认执行真实存在（不存在 ⇒ not_found，
 *   **不抛**，由端点决定 404）；
 * - emit `execution.confirmed` 领域事件，载荷只带 executionId / taskId /
 *   confirmedAt（真实确认时间 ISO），不携带指纹 / 用户名（§7）；
 * - **业务可用性与遥测解耦**（PM 明确，§7）：本 service 不查 telemetry opt-in、
 *   不调 FunnelEventsService——确认动作照常成功；是否写漏斗由 listener 内的
 *   单一 opt-in 闸门决定。
 *
 * fail-open 契约：查库异常向上抛（端点 5xx，数据问题不掩盖）；emit 是纯遥测
 * 副作用，即便替身/总线抛错也只记日志、绝不回灌业务结果（返回值亦忽略）。
 * 幂等不在本层做：重复确认一律 ok:true 且 emit，由 listener 的
 * dedupeKey = confirmed:<execution_id_hash> 保证「每次执行最多一条事件」。
 */
import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { Repository } from "typeorm";

import {
  DOMAIN_EVENTS,
  type ExecutionConfirmedEventPayload,
} from "../../../common/events/domain-events";
import { DomainEventBus } from "../../../common/services/domain-event-bus.service";
import { TaskExecution } from "../../task/entities/task-execution.entity";

@Injectable()
export class AgentExecutionConfirmationService {
  private readonly logger = new Logger(AgentExecutionConfirmationService.name);

  constructor(
    private readonly bus: DomainEventBus,
    @InjectRepository(TaskExecution)
    private readonly executions: Repository<TaskExecution>,
  ) {}

  async confirm(
    executionId: string,
  ): Promise<
    { ok: true; confirmedAt: string } | { ok: false; reason: "not_found" }
  > {
    const execution = await this.executions.findOne({
      where: { id: executionId },
    });
    if (!execution) return { ok: false, reason: "not_found" };

    // 确认发生的真实时间（不是入库 createdAt，也不是 listener 侧的当前时间）。
    const now = new Date().toISOString();
    const payload: ExecutionConfirmedEventPayload = {
      executionId,
      taskId: execution.taskId ?? null,
      confirmedAt: now,
    };

    try {
      // emit 返回值（是否有监听器）仅供诊断，业务结果不据此改变。
      this.bus.emit(DOMAIN_EVENTS.EXECUTION_CONFIRMED, payload);
    } catch (err: unknown) {
      // DomainEventBus 自身 fail-open；这里再加一层保险丝：遥测失败绝不回灌。
      this.logger.warn(
        `emit execution.confirmed failed for ${executionId} (fail-open): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return { ok: true, confirmedAt: now };
  }
}
