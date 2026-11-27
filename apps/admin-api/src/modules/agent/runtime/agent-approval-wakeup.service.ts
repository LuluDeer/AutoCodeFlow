import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { AgentApprovalsService } from "./agent-approvals.service";
import { WAITING_FOR_APPROVAL_PREFIX } from "./agent-approval-waiting";
import { approvalWakeupJobOptions } from "./agent-job-options";
import { AGENT_QUEUE_NAME, type AgentJobData } from "./agent.processor";
import { AgentSessionService, buildEventBody } from "./agent-session.service";

/**
 * 四眼原则的**服务端共享判定**（纯函数，grant / deny / phrase 三条处置入口共用）。
 *
 * 输入只有几个事实 + 一个配置读取端口：会话创建者、当前登录用户名、当前登录
 * 用户的数字 id、工具名与 ConfigService。任何放行决定都必须在写库之前过这一关
 * ——phrase 端点原先只拦 `sop_publish`，普通工具可被创建者本人用一句 `allow`
 * 自批，正是漏了这一步。
 *
 * `createdBy` 有两种**同人**形状，必须同时覆盖：
 *   · `user:<username>` —— agent 会话直建口径（AgentController.create）；
 *   · `user:<数字 id>` —— workbench 建单口径（WorkbenchController.createSession
 *     用 `user:${userId}`）。只比 username 时，管理员从工作台建单、再到
 *     `/agent-sessions` 深链处置自己的审批单就能自批，`blockSelfApproval=true`
 *     也拦不住（攻击者不需要知道对方用户名）。
 *
 * · `createdBy` 缺失（存量行 NULL）⇒ 不可判定，不拦（沿用既有 grant 语义）；
 * · `agent.policy.blockSelfApproval` 显式 `true` ⇒ 同一人不可批自己发起的会话；
 * · `sop_publish` 服务端强制四眼，与该开关无关（ADR-045，关开关也照拦）。
 */
export interface ApprovalSelfConfigReader {
  get<T = unknown>(key: string): T | undefined;
}

export function isApprovalSelfDecision(input: {
  createdBy: string | null | undefined;
  username: string;
  /** 当前登录用户数字 id（workbench 建单的 `user:<id>` 口径所需）。 */
  userId?: number | string | null;
  toolName: string;
  config?: ApprovalSelfConfigReader | null;
}): boolean {
  if (!input.createdBy) return false;
  const selfByName = input.createdBy === `user:${input.username}`;
  const rawId = input.userId;
  const normalizedId =
    typeof rawId === "number"
      ? Number.isFinite(rawId)
        ? String(Math.trunc(rawId))
        : null
      : typeof rawId === "string" && /^\d+$/.test(rawId.trim())
        ? rawId.trim()
        : null;
  const selfById =
    normalizedId !== null && input.createdBy === `user:${normalizedId}`;
  if (!selfByName && !selfById) return false;
  if (input.toolName === "sop_publish") return true;
  return input.config?.get<boolean>("agent.policy.blockSelfApproval") === true;
}

/**
 * deny 之后把 `tool_call_status_changed` 补进事件流（**旁路**，永不抛出）。
 *
 * 为什么正文必须写在这次迁移上：台账行会被就地覆盖，回读到的不再是「deny 那
 * 一刻」的拒绝文案；正文形状与另两个写入点逐字段同形（`payload.body.result /
 * error`），存在性哨兵 `errorMessage: "present"` 原样保留给投影/守卫读。
 *
 * 因果边 `causedBySeq` 指向那条 `approval_decided`：这次迁移的直接原因是人按
 * 下拒绝，不是当初的申请。解析失败只丢这条边，事件照写（取 NULL 时读侧标
 * heuristic，比没有事件或假边都诚实）。任何写失败只 warn，绝不反向弄挂 deny。
 */
export async function appendToolCallStatusChangedEvent(
  sessions: Pick<
    AgentSessionService,
    "findEventSeqByRef" | "listToolCalls" | "tryAppendEvent"
  >,
  logger: Logger,
  sessionId: string,
  approvalKey: string,
): Promise<void> {
  try {
    let causedBySeq: number | null = null;
    try {
      causedBySeq = await sessions.findEventSeqByRef(
        sessionId,
        "approval_decided",
        { approvalKey, status: "denied" },
      );
    } catch (err: unknown) {
      logger.debug(
        `causation resolve skipped (event still appended): session=${sessionId} ` +
          `key=${approvalKey} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const rows = await sessions.listToolCalls(sessionId);
    for (const row of rows) {
      // 只认「这次 settle 之后真的处于 denied」的那一行；没有 toolCallId 的
      // 存量行无法归属，宁可不发（投影会记 row_without_event）。
      if (row.approvalId !== approvalKey) continue;
      if (row.status !== "denied" || !row.toolCallId) continue;
      await sessions.tryAppendEvent(sessionId, {
        kind: "tool_call_status_changed",
        causedBySeq,
        payload: {
          toolCallId: row.toolCallId,
          toolName: row.toolName,
          tier: row.tier,
          status: row.status,
          durationMs: row.durationMs ?? 0,
          resultTruncated: row.resultTruncated === true,
          hasResult: (row.resultJson ?? null) !== null,
          errorMessage: row.errorMessage ? "present" : null,
          body: {
            result: buildEventBody(row.resultJson),
            error: buildEventBody(row.errorMessage),
          },
        },
      });
    }
  } catch (err: unknown) {
    logger.warn(
      `agent_events append failed (bypass — deny unaffected): ` +
        `session=${sessionId} kind=tool_call_status_changed key=${approvalKey} — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * R296 审批 granted 丢失唤醒补偿（E-pure，R321 §4/§7 拍板）。
 *
 * 竞态：tool-executor 落 pending 单 → 管理员 grant（此时 session 仍 running，
 * decideApproval 按快照判 false 不入队）→ markWaiting 写 waiting_input。此刻
 * approval=granted 却没有任何 job 来消费，会话永久卡死。
 *
 * 本服务把入队判定点后移到 markWaiting **提交之后**：由拥有 queue 的独立
 * provider 回读会话 + 审批单，满足条件才补一条 resume job。会话服务仍不依赖
 * queue——DI 走反向注册（`sessions.attachApprovalWakeupProbe(probe)`），无环。
 *
 * fail-closed（R321 §6.2）：补偿是旁路，任何异常只 warn，绝不影响审批申请
 * 路径、绝不推进会话状态、绝不改审批单；宁可继续卡住由人工 resume 恢复。
 *
 * dedup 命名空间（R323）：补偿 job 用独立的 `resume-wakeup-{sessionId}-{totalSteps}`
 * dedup id，与手动 resume 的 `resume-{sessionId}-{totalSteps}` 分开。R322 真 e2e
 * 实证两来源共用键时，补偿 job active 会吞掉真实手动 resume（201 但 zero job）。
 * 分键后两来源并存、双跑由 `markRunning` CAS 兜底，不依赖 dedup 吞并；opts 故
 * 不带 `keepLastIfActive`。手动 resume 路径（controller 等）零改动。
 */
@Injectable()
export class AgentApprovalWakeupService {
  private readonly logger = new Logger(AgentApprovalWakeupService.name);

  constructor(
    @InjectQueue(AGENT_QUEUE_NAME) private readonly queue: Queue<AgentJobData>,
    private readonly approvals: AgentApprovalsService,
    private readonly sessions: AgentSessionService,
  ) {}

  /**
   * 回读一次会话，判定是否需要为「已批准但未消费」的审批单补偿入队。
   *
   * 四个条件全部成立才入队：
   *   ① session 存在且 `status === "waiting_input"`（markWaiting 已提交）；
   *   ② `waitingFor` 以「等待审批」开头（不是别的等待源）；
   *   ③ 没有其它 pending 单（否则恢复后立刻再次挂起，白烧一轮 LLM）；
   *   ④ 有 `scope='once'` 且 `status='granted'` 的单待消费。
   *
   * 入队凭据 `expectWaitingFor` / `expectTotalSteps` 由 markWaiting 之后的
   * 会话快照取得，`markRunning` CAS 据此拒绝早消费/人工介入后的迟到 job。
   *
   * dedup id = `resume-wakeup-{sessionId}-{totalSteps}`（R323 独立命名空间）。
   * 刻意不与手动 resume 的 `resume-{sessionId}-{totalSteps}` 共用：R322 真 e2e
   * 实证补偿 job active 期间真实手动 resume 会因撞同键被吞（端点 201、manual
   * job 数=0）。分命名空间让两来源并存，两个 job 同时存活时由 `markRunning`
   * CAS 兜底（只有一个进循环），而非依赖 dedup 吞并；故 opts 不带 keepLastIfActive。
   */
  async probe(sessionId: string): Promise<void> {
    try {
      // findById 而非 requireById：缺失直接 return，不制造异常噪声。
      const session = await this.sessions.findById(sessionId);
      if (!session) return;
      if (session.status !== "waiting_input") return;

      const waitingFor = session.waitingFor;
      if (!waitingFor?.startsWith(WAITING_FOR_APPROVAL_PREFIX)) return;

      if (await this.approvals.hasPendingForSession(sessionId)) return;
      if (!(await this.approvals.hasGrantAwaitingResumeForSession(sessionId))) {
        return;
      }

      await this.queue.add(
        "run",
        {
          sessionId,
          reason: "resume:approval",
          expectTotalSteps: session.totalSteps,
          expectWaitingFor: waitingFor,
        },
        approvalWakeupJobOptions(sessionId, session.totalSteps),
      );
    } catch (err: unknown) {
      // fail-closed：DB 抖动 / Redis 抖动 / 凭据构造异常一律只 warn。
      this.logger.warn(
        `Agent approval wakeup probe failed: session=${sessionId} ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
