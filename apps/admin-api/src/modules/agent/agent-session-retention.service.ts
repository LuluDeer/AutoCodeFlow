import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import {
  AgentSession,
  AGENT_TERMINAL_STATUSES,
} from "./entities/agent-session.entity";
import { AgentStep } from "./entities/agent-step.entity";
import { AgentToolCall } from "./entities/agent-tool-call.entity";
import { AgentApproval } from "./entities/agent-approval.entity";
// S7-G1：取证型事件日志（只写不读的第一阶段），保留期必须接进本 cron
import { AgentEvent } from "./entities/agent-event.entity";
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
 *   （与审计保留期对齐，见 agent-tool-call.entity 头注）；
 * · **approvals**：已处置（granted/consumed/denied）且所属会话已终态的、超
 *   180 天的行——审批单是**审计物证**（谁批准、何时真的执行），保留期与
 *   write/dangerous 的 tool_calls 对齐；`pending` **不删**：它是待办工作项，
 *   删掉等于静默抹掉一个还在等人点头的请求（会话会停在 waiting_input 且无迹可查）。
 * 默认值即上表；`AGENT_STEP_RETENTION_DAYS` /
 * `AGENT_TOOL_CALL_READ_RETENTION_DAYS` /
 * `AGENT_TOOL_CALL_WRITE_RETENTION_DAYS` 可覆盖（可选环境变量，未设/非法
 * 回落默认——ARCH-27 运行时读取经 ConfigService）。
 */
export const AGENT_STEP_RETENTION_DEFAULT_DAYS = 90;
export const AGENT_TOOL_CALL_READ_RETENTION_DEFAULT_DAYS = 30;
export const AGENT_TOOL_CALL_WRITE_RETENTION_DEFAULT_DAYS = 180;
export const AGENT_APPROVAL_RETENTION_DEFAULT_DAYS = 180;
/**
 * S7-G1：取证事件表（`agent_events`）的默认保留期。
 *
 * 180 天 = 与 write/dangerous 工具台账同一档：事件是“当时发生了什么”的**结论性
 * 证据**（prompt 指纹、工具状态迁移序列），体积远小于 steps（不含正文/参数/结果），
 * 而取证需求常发生在事故很久之后。比 steps（90 天）长是有意的——steps 是可重算的
 * 上下文原材料，事件是不可重算的事故现场。
 */
export const AGENT_EVENT_RETENTION_DEFAULT_DAYS = 180;

/** 单批 IN 列表上限（每日批量任务，分块防超长语句）。 */
const DELETE_CHUNK = 500;

/**
 * 终态会话 id 的分页加载批大小。
 *
 * 为什么按 id **keyset 分页**而不是一次 find 全量：终态会话只增不减，运营
 * 数年后是数十万~百万行——一次 find 全量载入内存再分块删，每天 cron 都是
 * 一次内存尖峰（此前工具调用/审批单各自再复制一份 id 数组）。keyset 游标
 * （上一批最大 id 起步）让每批内存有界且游标稳定，删除语句仍在 IN 列表上
 * 走既有索引。
 */
const SCAN_BATCH = 1_000;

/** 导出供测试构造满批页（keyset 分页的「尾批不满即停」语义钉死用）。 */
export const AGENT_RETENTION_SCAN_BATCH = SCAN_BATCH;

const ENV_STEP_RETENTION_DAYS = "AGENT_STEP_RETENTION_DAYS";
const ENV_TOOL_CALL_READ_RETENTION_DAYS = "AGENT_TOOL_CALL_READ_RETENTION_DAYS";
const ENV_TOOL_CALL_WRITE_RETENTION_DAYS =
  "AGENT_TOOL_CALL_WRITE_RETENTION_DAYS";
const ENV_APPROVAL_RETENTION_DAYS = "AGENT_APPROVAL_RETENTION_DAYS";
const ENV_EVENT_RETENTION_DAYS = "AGENT_EVENT_RETENTION_DAYS";

/** 已处置的审批状态（pending 是待办工作项，绝不由清理任务删除）。 */
const SETTLED_APPROVAL_STATUSES = ["granted", "consumed", "denied"] as const;

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
    @InjectRepository(AgentApproval)
    private readonly approvals: Repository<AgentApproval>,
    private readonly config: ConfigService,
    // S7-G1：取证事件表仓储（@Optional + 置尾——既有单测直接 new 装配时缺席，
    // 缺席时 cleanupExpiredEvents 直接返回 0，不影响 steps/tool_calls/approvals
    // 的既有行为；先例同 leaderGate / systemConfig 的 @Optional 处理）。
    @Optional()
    @InjectRepository(AgentEvent)
    private readonly events: Repository<AgentEvent> | null = null,
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
      const { steps, toolCalls, approvals } = await this.cleanupExpiredRows();
      // S7-G1：取证事件表的清理与上面三者**同一个 cron、同一次 try**——
      // 分成两条 cron 会让「事件清理没接线」再次变成静默故障面（本仓反复
      // 出现过「新表 + 没有清理路径」）。失败同样只记 error、等下一轮重试。
      const events = await this.cleanupExpiredEvents();
      if (steps + toolCalls + approvals + events > 0) {
        this.logger.log(
          `Agent session retention: 清理 steps=${steps} 行、toolCalls=${toolCalls} 行、` +
            `approvals=${approvals} 行、events=${events} 行`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Agent session retention failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * S7-G1：清理 `agent_events`（取证型事件日志）的超期行，返回删除行数。
   *
   * ## 为什么必须有（否则就是一张永不清理的新表）
   * 会话行**永不删除**（保留期只清 steps / tool_calls / approvals），所以
   * `ON DELETE CASCADE` 在这张表上等于**没有**清理效果。事件表的写入点是每步 /
   * 每次工具状态迁移 / 每轮 provider 调用——量级与 steps 同阶甚至更高，不清理
   * 就是永续增长的审计垃圾（迁移 0086 的注释里已经踩过同一个论证）。
   *
   * ## 保留期：默认 180 天（与 write/dangerous 工具台账对齐）
   * 为什么比 steps（90 天）长：事件表存的是「当时发生了什么」的**结论性证据**
   * （prompt 指纹、工具状态序列），体积远小于 steps（不含正文/参数/结果），
   * 而取证需求往往发生在事故之后很久。为什么不像 approvals(180) 那样带状态
   * 筛选：事件没有「待办」语义，全部可清。
   * `AGENT_EVENT_RETENTION_DAYS` 可覆盖（未设/非法回落默认，与其它四项同口径）。
   *
   * ## 为什么只清**终态会话**的事件
   * 与 steps 同一条理由，且更硬：非终态会话（pending/running/waiting_input）的
   * 事件序列是**正在被写入**的取证对象——挂起/恢复期间把它删掉，会让「这个会话
   * 上一轮看到了什么」永久缺段，而这正是事件日志存在的理由。删除谓词里同样带
   * `NOT EXISTS(... status NOT IN terminal)` 复查一次：取页与删除之间会话可能被
   * `reopenForResume` 重开（failed → pending）。
   *
   * ## 为什么用 keyset 分页（与 steps 同款）
   * 终态会话只增不减，一次 find 全量 = 每日一次内存尖峰；分页让每批有界。
   *
   * @returns 删除行数（未注入 events 仓储时为 0）
   */
  async cleanupExpiredEvents(now: Date = new Date()): Promise<number> {
    if (!this.events) {
      // @Optional 的代价必须可见：装配漏登记（forFeature 少一项）时这里会一直被
      // 跳过，而「跳过」在数据面与「没有超期行」完全同形——一张永不清理的新表
      // 就是这么长出来的。所以每次运行都留一条 warn，而不是静默 return 0。
      this.logger.warn(
        "cleanupExpiredEvents skipped — AgentEvent repository is not wired (@Optional); agent_events 将不会被清理",
      );
      return 0;
    }
    const cutoff = this.cutoff(
      now,
      this.resolveDays(
        ENV_EVENT_RETENTION_DAYS,
        AGENT_EVENT_RETENTION_DEFAULT_DAYS,
      ),
    );
    let deleted = 0;
    let cursor: string | null = null;
    for (;;) {
      const page = await this.loadTerminalSessionIds(cursor);
      if (page.length === 0) break;
      cursor = page[page.length - 1];
      for (let i = 0; i < page.length; i += DELETE_CHUNK) {
        const chunk = page.slice(i, i + DELETE_CHUNK);
        const res = await this.events
          .createQueryBuilder()
          .delete()
          .where("sessionId IN (:...ids)", { ids: chunk })
          .andWhere("createdAt < :cutoff", { cutoff })
          .andWhere(
            `NOT EXISTS (SELECT 1 FROM "agent_sessions" s
               WHERE s.id = "agent_events"."sessionId"
                 AND s.status NOT IN (:...eventTerminal))`,
            { eventTerminal: [...AGENT_TERMINAL_STATUSES] },
          )
          .execute();
        deleted += res.affected ?? 0;
      }
      if (page.length < SCAN_BATCH) break;
    }
    return deleted;
  }

  /** 返回删除行数。now 可注入以便测试。 */
  async cleanupExpiredRows(now: Date = new Date()): Promise<{
    steps: number;
    toolCalls: number;
    approvals: number;
  }> {
    const stepCutoff = this.cutoff(
      now,
      this.resolveDays(
        ENV_STEP_RETENTION_DAYS,
        AGENT_STEP_RETENTION_DEFAULT_DAYS,
      ),
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
    const approvalCutoff = this.cutoff(
      now,
      this.resolveDays(
        ENV_APPROVAL_RETENTION_DAYS,
        AGENT_APPROVAL_RETENTION_DEFAULT_DAYS,
      ),
    );

    // 只清**终态**会话的 steps——非终态（pending/running/waiting_input）的
    // steps 是推理循环可重入与上下文重建的唯一数据源（见 agent-step 头注）。
    // 终态 id 按 keyset 分页加载（内存有界）；删除沿用 IN 分块。
    let stepsDeleted = 0;
    let approvalsDeleted = 0;
    let cursor: string | null = null;
    for (;;) {
      const page = await this.loadTerminalSessionIds(cursor);
      if (page.length === 0) break;
      cursor = page[page.length - 1];

      // steps：会话终态 + createdAt 超期才删
      for (let i = 0; i < page.length; i += DELETE_CHUNK) {
        const chunk = page.slice(i, i + DELETE_CHUNK);
        const res = await this.steps
          .createQueryBuilder()
          .delete()
          .where("sessionId IN (:...ids)", { ids: chunk })
          .andWhere("createdAt < :cutoff", { cutoff: stepCutoff })
          // 数据审计 #2：取页与删除之间会话可能被 reopenForResume 重开
          // （failed → pending）。不复查状态就会把**正在恢复的会话**的历史
          // 删掉——它随后重建出空上下文，把已发生的写操作重做一遍。
          .andWhere(
            `NOT EXISTS (SELECT 1 FROM "agent_sessions" s
               WHERE s.id = "agent_steps"."sessionId"
                 AND s.status NOT IN (:...stepTerminal))`,
            { stepTerminal: [...AGENT_TERMINAL_STATUSES] },
          )
          .execute();
        stepsDeleted += res.affected ?? 0;
      }

      // 审批单：只清「已处置 + 会话已终态 + 超期」的行。
      // · 只看 createdAt 不看 decidedAt：一张单挂在 waiting_input 上一年没被
      //   处置时，它既没有 decidedAt 也不该被保留成永久垃圾——但 status 仍是
      //   pending，下面的 IN 会把这类行挡住（待办工作项不自动消失，交人工处置）。
      // · 不看 tool_calls 是否已被删：两者保留期不同（read 30 天），用会话
      //   终态做归属依据，避免「tool_call 先被清 → 审批单永远找不到」的孤儿行。
      for (let i = 0; i < page.length; i += DELETE_CHUNK) {
        const chunk = page.slice(i, i + DELETE_CHUNK);
        const res = await this.approvals
          .createQueryBuilder()
          .delete()
          .where("sessionId IN (:...ids)", { ids: chunk })
          .andWhere("status IN (:...statuses)", {
            statuses: [...SETTLED_APPROVAL_STATUSES],
          })
          .andWhere("createdAt < :cutoff", { cutoff: approvalCutoff })
          // 同 steps：会话被重开时，审批单是「已批准待重放」的唯一物证，
          // 不能在该窗口里被清理掉。
          .andWhere(
            `NOT EXISTS (SELECT 1 FROM "agent_sessions" s
               WHERE s.id = "agent_approvals"."sessionId"
                 AND s.status NOT IN (:...approvalTerminal))`,
            { approvalTerminal: [...AGENT_TERMINAL_STATUSES] },
          )
          .execute();
        approvalsDeleted += res.affected ?? 0;
      }

      // 尾批不满 → 本页即最后一页
      if (page.length < SCAN_BATCH) break;
    }

    // tool_calls 按 tier 分档清理（read 短、write/dangerous 与审计对齐）——
    // tier + createdAt 自带筛选条件，无需按会话归属，单语句即可。
    let toolCallsDeleted = 0;
    const tierBatches: Array<{
      tiers: string[];
      cutoff: Date;
      /** 只清终态会话的行（数据审计 #4：read 档曾完全不看会话状态）。 */
      guardSessionTerminal: boolean;
    }> = [
      { tiers: ["read"], cutoff: readCutoff, guardSessionTerminal: true },
      // write/dangerous 是审计面：即使会话非终态也按 180 天保留，
      // 否则「一个长挂起的会话」会让它的写操作记录比只读记录更早消失。
      {
        tiers: ["write", "dangerous"],
        cutoff: writeCutoff,
        guardSessionTerminal: false,
      },
    ];
    for (const { tiers, cutoff, guardSessionTerminal } of tierBatches) {
      const qb = this.toolCalls
        .createQueryBuilder()
        .delete()
        .where("tier IN (:...tiers)", { tiers })
        .andWhere("createdAt < :cutoff", { cutoff });
      if (guardSessionTerminal) {
        qb.andWhere(
          `NOT EXISTS (SELECT 1 FROM "agent_sessions" s
             WHERE s.id = "agent_tool_calls"."sessionId"
               AND s.status NOT IN (:...toolTerminal))`,
          { toolTerminal: [...AGENT_TERMINAL_STATUSES] },
        );
      }
      const res = await qb.execute();
      toolCallsDeleted += res.affected ?? 0;
    }

    return {
      steps: stepsDeleted,
      toolCalls: toolCallsDeleted,
      approvals: approvalsDeleted,
    };
  }

  /** keyset 分页加载一页终态会话 id（id 升序，游标 = 上一页最大 id）。 */
  private async loadTerminalSessionIds(
    afterId: string | null,
  ): Promise<string[]> {
    const qb = this.sessions
      .createQueryBuilder("s")
      .select("s.id", "id")
      .where("s.status IN (:...statuses)", {
        statuses: [...AGENT_TERMINAL_STATUSES],
      })
      .orderBy("s.id", "ASC")
      .limit(SCAN_BATCH);
    if (afterId !== null) {
      qb.andWhere("s.id > :afterId", { afterId });
    }
    const rows = await qb.getRawMany<{ id: string }>();
    return rows.map((r) => r.id);
  }

  private cutoff(now: Date, days: number): Date {
    return new Date(now.getTime() - days * 86_400_000);
  }
}
