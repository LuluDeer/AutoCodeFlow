import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";

import {
  AgentSession,
  AGENT_TERMINAL_STATUSES,
} from "./entities/agent-session.entity";
import { AgentStep } from "./entities/agent-step.entity";
import { AgentToolCall } from "./entities/agent-tool-call.entity";
// ARCH-31 §5: cron 维护任务统一 Leader 门禁（@Optional——既有单测直接 new
// 装配时 gate 缺席 → null → 门禁不生效，先例同 AgentMediaRetentionService）。
import { LeaderGateService } from "../../common/leader-gate/leader-gate.service";

/**
 * B-10（会话域 retention）：Agent 会话的 steps 与 tool_calls 定时清理。
 *
 * ## 为什么必须有
 * agent-tool-call.entity 的头注承诺「由定时清理任务按 tier + createdAt 分别
 * 处理」但任务从未落地；ops_watch 每小时一会话、steps 全量存 LLM 文本，
 * 只增不减。本服务兑现该承诺（对齐 agent-media-retention / outbox retention
 * 的既有维护任务模式）。
 *
 * ## 保留策略（集中常量 + 环境变量可选覆盖）
 * · **steps**：只清**终态**会话（AGENT_TERMINAL_STATUSES）的、createdAt 超
 *   90 天的行——非终态会话的 steps 是可重入/重建上下文的唯一数据源，动了
 *   会把挂起会话作废；
 * · **tool_calls**：按 tier 分别保留——read 30 天、write/dangerous 180 天
 *   （与审计保留期对齐，见 agent-tool-call.entity 头注）。
 * 默认值即上表；`AGENT_STEP_RETENTION_DAYS` /
 * `AGENT_TOOL_CALL_READ_RETENTION_DAYS` /
 * `AGENT_TOOL_CALL_WRITE_RETENTION_DAYS` 可覆盖（可选环境变量，未设/非法
 * 回落默认——ARCH-27 运行时读取经 ConfigService）。
 */
export const AGENT_STEP_RETENTION_DEFAULT_DAYS = 90;
export const AGENT_TOOL_CALL_READ_RETENTION_DEFAULT_DAYS = 30;
export const AGENT_TOOL_CALL_WRITE_RETENTION_DEFAULT_DAYS = 180;

/** 单批 IN 列表上限（每日批量任务，分块防超长语句）。 */
const DELETE_CHUNK = 500;

const ENV_STEP_RETENTION_DAYS = "AGENT_STEP_RETENTION_DAYS";
const ENV_TOOL_CALL_READ_RETENTION_DAYS = "AGENT_TOOL_CALL_READ_RETENTION_DAYS";
const ENV_TOOL_CALL_WRITE_RETENTION_DAYS =
  "AGENT_TOOL_CALL_WRITE_RETENTION_DAYS";

@Injectable()
export class AgentSessionRetentionService {
  private readonly logger = new Logger(AgentSessionRetentionService.name);

  constructor(
    // ARCH-31 §5: 多实例下 @Cron 维护任务仅 cron Leader 执行
    @Optional()
    private readonly leaderGate: LeaderGateService | null = null,
    @InjectRepository(AgentSession)
    private readonly sessions: Repository<AgentSession>,
    @InjectRepository(AgentStep)
    private readonly steps: Repository<AgentStep>,
    @InjectRepository(AgentToolCall)
    private readonly toolCalls: Repository<AgentToolCall>,
    private readonly config: ConfigService,
  ) {}

  private resolveDays(envKey: string, fallback: number): number {
    const raw = this.config.get<string | number>(envKey);
    if (raw === undefined || raw === null || raw === "") return fallback;
    const n = typeof raw === "number" ? raw : parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  @Cron("0 40 3 * * *")
  async handleDailyCleanup(): Promise<void> {
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    try {
      const { steps, toolCalls } = await this.cleanupExpiredRows();
      if (steps + toolCalls > 0) {
        this.logger.log(
          `Agent session retention: 清理 steps=${steps} 行、toolCalls=${toolCalls} 行`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Agent session retention failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 返回删除行数。now 可注入以便测试。 */
  async cleanupExpiredRows(now: Date = new Date()): Promise<{
    steps: number;
    toolCalls: number;
  }> {
    const stepCutoff = this.cutoff(
      now,
      this.resolveDays(ENV_STEP_RETENTION_DAYS, AGENT_STEP_RETENTION_DEFAULT_DAYS),
    );
    const readCutoff = this.cutoff(
      now,
      this.resolveDays(
        ENV_TOOL_CALL_READ_RETENTION_DAYS,
        AGENT_TOOL_CALL_READ_RETENTION_DEFAULT_DAYS,
      ),
    );
    const writeCutoff = this.cutoff(
      now,
      this.resolveDays(
        ENV_TOOL_CALL_WRITE_RETENTION_DAYS,
        AGENT_TOOL_CALL_WRITE_RETENTION_DEFAULT_DAYS,
      ),
    );

    // 只清**终态**会话的 steps——非终态（pending/running/waiting_input）的
    // steps 是推理循环可重入与上下文重建的唯一数据源（见 agent-step 头注）。
    const terminalIds = (
      await this.sessions.find({
        where: { status: In([...AGENT_TERMINAL_STATUSES]) },
        select: { id: true },
      })
    ).map((s) => s.id);

    let stepsDeleted = 0;
    for (let i = 0; i < terminalIds.length; i += DELETE_CHUNK) {
      const chunk = terminalIds.slice(i, i + DELETE_CHUNK);
      const res = await this.steps
        .createQueryBuilder()
        .delete()
        .where("sessionId IN (:...ids)", { ids: chunk })
        .andWhere("createdAt < :cutoff", { cutoff: stepCutoff })
        .execute();
      stepsDeleted += res.affected ?? 0;
    }

    // tool_calls 按 tier 分档清理（read 短、write/dangerous 与审计对齐）
    let toolCallsDeleted = 0;
    const tierBatches: Array<{
      tiers: string[];
      cutoff: Date;
    }> = [
      { tiers: ["read"], cutoff: readCutoff },
      { tiers: ["write", "dangerous"], cutoff: writeCutoff },
    ];
    for (const { tiers, cutoff } of tierBatches) {
      const res = await this.toolCalls
        .createQueryBuilder()
        .delete()
        .where("tier IN (:...tiers)", { tiers })
        .andWhere("createdAt < :cutoff", { cutoff })
        .execute();
      toolCallsDeleted += res.affected ?? 0;
    }

    return { steps: stepsDeleted, toolCalls: toolCallsDeleted };
  }

  private cutoff(now: Date, days: number): Date {
    return new Date(now.getTime() - days * 86_400_000);
  }
}
