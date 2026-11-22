import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { AgentApprovalsService } from "./agent-approvals.service";
import { WAITING_FOR_APPROVAL_PREFIX } from "./agent-approval-waiting";
import { approvalWakeupJobOptions } from "./agent-job-options";
import { AGENT_QUEUE_NAME, type AgentJobData } from "./agent.processor";
import { AgentSessionService } from "./agent-session.service";

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
