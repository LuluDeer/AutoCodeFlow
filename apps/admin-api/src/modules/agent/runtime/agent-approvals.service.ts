import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { createHash } from "node:crypto";
import { LessThan, Repository } from "typeorm";
import { AppError } from "../../../common/errors/app-error";
import {
  AgentApproval,
  type AgentApprovalStatus,
} from "../entities/agent-approval.entity";

/**
 * A1 审批闭环（实施轮 #12 → 执行侧闭环 #14）：审批单的落库、状态翻转与领取。
 *
 * 状态迁移：pending → granted / pending → denied（人工处置，条件写）；
 * granted → consumed（执行体在副作用之前**原子领取**，一张单只能用一次）。
 * 写路径统一走**条件 UPDATE**（ADR-026 规则 4）：两个管理员同时点批准、或批准
 * 与拒绝撞在同一张单上时，命中 0 行的一方拿到 APPROVAL_ALREADY_DECIDED——
 * 审批单的结论只能有一个，先到者赢。
 */
/**
 * 待审批单的有效期（7 天）。
 *
 * 超过即由维护扫描标 `expired` 并收敛对应会话——否则没人点的审批会让会话
 * 永久 waiting_input（既不执行也不失败），运营看板上永远挂着一条待办。
 * 7 天足够覆盖「周五提交、下周一处理」的真实节奏。
 */
export const AGENT_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class AgentApprovalsService {
  private readonly logger = new Logger(AgentApprovalsService.name);

  constructor(
    @InjectRepository(AgentApproval)
    private readonly approvals: Repository<AgentApproval>,
  ) {}

  /**
   * 申请键的**确定性**构造（实施轮 #14）。
   *
   * 键 = `apr-<sessionId>-<sha256(toolName|规范化参数) 前 16 位>`。同一会话里
   * 「同一工具 + 同一参数」的重试必须命中同一行（幂等），否则：
   *   · 模型每重试一次就多一张 pending 单（运营看板只增不减）；
   *   · 管理员批准的那张与模型正在等的调用不是同一行，「批准后重放即执行」
   *     这条链根本接不上。
   *
   * 参数规范化：对象按键名排序递归序列化，数组保持顺序（顺序是语义），
   * undefined 掉键（JSON 语义一致）。同一逻辑参数的不同书写（键序不同）
   * 得到同一键。
   */
  buildKey(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown> | null,
  ): string {
    const digest = createHash("sha256")
      .update(`${toolName}|${canonicalJson(args)}`)
      .digest("hex")
      .slice(0, 16);
    return `apr-${sessionId}-${digest}`;
  }

  /** 申请落库。approvalKey 唯一约束保证重试不产生第二张单（幂等）。 */
  async request(input: {
    approvalKey: string;
    sessionId: string;
    toolName: string;
    reason: string;
  }): Promise<AgentApproval> {
    const row = this.approvals.create({
      approvalKey: input.approvalKey,
      sessionId: input.sessionId,
      toolName: input.toolName,
      reason: input.reason,
      status: "pending",
    });
    try {
      return await this.approvals.save(row);
    } catch (err: unknown) {
      // 唯一约束冲突 = 同一 approvalKey 已申请过（重试/重放）：返回既有单，
      // 让幂等语义对调用方透明。
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: string }).code === "23505"
      ) {
        const existing = await this.approvals.findOne({
          where: { approvalKey: input.approvalKey },
        });
        if (!existing) throw err;
        // A2（P2）：TTL 过期单必须可以复活，否则 approvalKey 被**永久钉死**。
        //
        // 死锁链：审批超时 → 维护扫描标 expired + 会话 failed（提示「重新
        // 发起」）→ 管理员 resume → 模型重提同一工具同参（buildKey 确定性）
        // → 这里命中同一行 expired 单 → 会话又 waiting_input；而 decide 只
        // 允许从 pending 出发，grant/deny 永远 409。这张单再也处置不了，
        // 每次 resume 都是白烧一轮 LLM。
        //
        // 因此 expired 视为「没人处理、需要新窗口」：条件写复位为 pending，
        // createdAt 刷新（TTL 从新窗口算），清掉上一轮的处置痕迹。
        //
        // 只复活 expired——denied/consumed/granted 仍是终点：复活它们等于给
        // 已被拒绝、或已经用过的副作用发第二张通行证（consume 的原子性正是
        // 为了「一次批准只放行一次」）。pending 无需任何动作，原样返回。
        if (existing.status === "expired") {
          const revived = await this.approvals.update(
            { id: existing.id, status: "expired" },
            {
              status: "pending",
              createdAt: new Date(),
              decidedBy: null,
              decidedAt: null,
            },
          );
          if (revived.affected) {
            this.logger.warn(
              `Agent approval revived after TTL expiry: key=${input.approvalKey} ` +
                `session=${input.sessionId} tool=${input.toolName} ` +
                `previous=${existing.decidedBy ?? "unknown"} — 新一轮审批窗口已开启`,
            );
          }
          // 无论条件写是否命中都**重新读取**返回最新行：命中 0 说明并发方
          // （另一次 request 的复位、或人工处置）刚改过它，此时返回最新状态
          // 才是事实；抛错会让模型这一轮无谓失败。
          const latest = await this.findByKey(input.approvalKey);
          return latest ?? existing;
        }
        return existing;
      }
      throw err;
    }
  }

  async findByKey(approvalKey: string): Promise<AgentApproval | null> {
    return this.approvals.findOne({ where: { approvalKey } });
  }

  async listForSession(sessionId: string): Promise<AgentApproval[]> {
    return this.approvals.find({
      where: { sessionId },
      order: { createdAt: "ASC" },
    });
  }

  /**
   * 处置（批准/拒绝）。条件写钉住 status='pending'——终态竞争由数据库行锁
   * 仲裁，撞上的调用方收 APPROVAL_ALREADY_DECIDED（409）。
   * 返回 null = 单不存在；返回行 = 本次调用完成了处置。
   *
   * 谓词必须是 `status = 'pending'`（而不是「非 granted/denied」）：新增
   * `consumed` 后，否定式谓词会把**已执行过**的单重新翻回 granted，等于给
   * 一次副作用发第二张通行证。
   */
  async decide(
    approvalKey: string,
    decision: Extract<AgentApprovalStatus, "granted" | "denied">,
    decidedBy: string,
  ): Promise<AgentApproval | null> {
    const updated = await this.approvals.update(
      { approvalKey, status: "pending" },
      { status: decision, decidedBy, decidedAt: new Date() },
    );
    if (!updated.affected) {
      const row = await this.findByKey(approvalKey);
      if (!row) return null;
      throw new AppError("AGENT_APPROVAL_ALREADY_DECIDED", {
        approvalKey,
        status: row.status,
      });
    }
    const row = await this.findByKey(approvalKey);
    if (!row) return null;
    return row;
  }

  /**
   * 把超过 TTL 的 pending 单标成 `expired`（维护扫描调用）。
   *
   * 条件写钉住 `status='pending'`：与人工批准/拒绝并发时先到者赢，没抢到的
   * 那张不会把 granted/denied 覆盖成 expired。返回受影响的会话 id 去重集合，
   * 供调用方收敛仍挂在 waiting_input 的会话。
   */
  async expireStalePending(
    cutoff: Date,
    now: Date = new Date(),
  ): Promise<{ expired: number; sessionIds: string[] }> {
    const stale = await this.approvals.find({
      where: { status: "pending", createdAt: LessThan(cutoff) },
      select: { id: true, sessionId: true },
    });
    const sessionIds = new Set<string>();
    let expired = 0;
    for (const row of stale) {
      const res = await this.approvals.update(
        { id: row.id, status: "pending" },
        {
          status: "expired",
          decidedBy: "system:approval-ttl",
          decidedAt: now,
        },
      );
      if (res.affected) {
        expired += 1;
        sessionIds.add(row.sessionId);
      }
    }
    return { expired, sessionIds: [...sessionIds] };
  }

  /** 会话还有没有未处置的审批单（resume 前置校验用）。 */
  async hasPendingForSession(sessionId: string): Promise<boolean> {
    const pending = await this.approvals.find({
      where: { sessionId, status: "pending" },
      take: 1,
    });
    return pending.length > 0;
  }

  /**
   * **领取**一张已批准的审批单（granted → consumed，条件写）。
   *
   * 为什么必须先领取再执行：批准是「放行一次」，不是「长期开闸」。若只看
   * `status === 'granted'` 就放行，同一会话后续任何同参调用（甚至模型刷循环）
   * 都会无限复用这一次点头——审批从门退化成通知。
   *
   * 为什么在**副作用之前**领取：领取成功才允许执行；反过来（先执行再领取）
   * 并发下会出现「两次执行、一次领取」，副作用双份。领取失败 = 已被别处用掉，
   * 调用方必须按拒绝处理（fail-closed）。
   *
   * @returns true = 本次调用持有这张单的执行权
   */
  async consume(approvalKey: string): Promise<boolean> {
    const updated = await this.approvals.update(
      { approvalKey, status: "granted" },
      // consumedAt 与状态同一条 UPDATE 落：分成两次写会出现「状态已 consumed、
      // 时刻为空」的窗口，而那正是审计要区分的「批准了但没执行」。
      { status: "consumed", consumedAt: new Date() },
    );
    return (updated.affected ?? 0) > 0;
  }
}

/**
 * 规范化 JSON：对象键排序（递归）、数组保序、undefined 掉键。
 *
 * 只为「同参重试命中同一审批键」服务——不做通用序列化器，因此不处理
 * Date/Buffer 等特殊类型（工具参数来自 JSON.parse，本来就只有 JSON 类型）。
 *
 * 深度钳位（防线前移）：buildKey 在**边界闸门的深度闸之前**执行——工具参数
 * 来自 LLM，`[[[…]]]` 在字符预算内可嵌数万层，无界递归会在这里先爆栈
 * （RangeError 逃出 tool-executor → 运行时循环无兜底 → 会话永久卡 running）。
 * 超深部分截断为稳定占位串：两个不同深载荷可能得到同键，但它们必然被
 * boundary 的 MAX_SCAN_DEPTH 拒绝（buildKey 之后、任何副作用之前），
 * 键碰撞不可达。合法工具参数都是两三层 schema，钳位不影响任何真实调用。
 */
const CANONICAL_MAX_DEPTH = 64;

export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > CANONICAL_MAX_DEPTH) return '"[DEEP_NESTED]"';
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v, depth + 1)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v, depth + 1)}`)
    .join(",")}}`;
}
