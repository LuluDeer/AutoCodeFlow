import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { AgentRuntimeService } from "./agent-runtime.service";

/**
 * P2：Agent 队列名。
 *
 * **刻意与 `task-queue` 分开**（设计文档 02 §5.3）。Agent 的工作负载特征
 * 与任务派发完全不同（LLM 长调用、分钟级会话、会挂起等待），混在一条队列
 * 里一个卡住的会话就会拖住任务派发。独立队列是「Agent 拥塞不影响主链」的
 * 第一道结构保证。
 */
export const AGENT_QUEUE_NAME = "agent-jobs";

/**
 * Agent 并发上限。
 *
 * **固定为 2，不随 CPU 弹性扩**——这是刻意的保守选择：Agent 是本平台唯一
 * 会主动发起 LLM 调用（有真金白银成本）与写操作（有生产风险）的组件。
 * 宁可 Agent 排队慢，不可它抢占主链资源或同时发起多个写操作。
 *
 * 需要提高时改这个常量并同步评估：① LLM 配额是否够；② admin-api 的
 * 事件循环延迟是否受影响（P2 验收要求 P99 上升 < 5%）。
 */
export const AGENT_QUEUE_CONCURRENCY = 2;

/**
 * 队列任务类型。
 *
 * 只有两种：首次运行与恢复。两者走**同一条** `runtime.run()`——因为
 * run() 每次从 DB 重建上下文（可重入），resume 与 start 在语义上没有区别，
 * 分开实现只会产生两条行为可能漂移的路径。
 */
export interface AgentJobData {
  sessionId: string;
  /** 仅用于日志/可观测（如 "resume:approval" / "trigger:cron"）。 */
  reason?: string;
}

@Processor(AGENT_QUEUE_NAME, { concurrency: AGENT_QUEUE_CONCURRENCY })
export class AgentProcessor extends WorkerHost {
  private readonly logger = new Logger(AgentProcessor.name);

  constructor(private readonly runtime: AgentRuntimeService) {
    super();
  }

  async process(job: Job<AgentJobData>): Promise<void> {
    const { sessionId, reason } = job.data;
    this.logger.log(
      `Agent job start: session=${sessionId}${reason ? ` reason=${reason}` : ""}`,
    );

    try {
      const outcome = await this.runtime.run(sessionId);
      this.logger.log(
        `Agent job done: session=${sessionId} status=${outcome.status} steps=${outcome.steps}`,
      );
    } catch (err: unknown) {
      // 兜底：run() 内部已把可预期的失败收敛为终态，能落到这里的只有
      // 未预期异常（DB 不可用等）。此处**不重抛**——重抛会让 BullMQ
      // 按默认策略重试，而一个未预期异常通常不会因重试而好转；
      // 更危险的是重试会重复执行已发生的副作用。
      // 如实记录并让 job 成功结束，由 outbox/定时扫描决定是否需要人工介入。
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Agent job threw unexpectedly: session=${sessionId} — ${msg}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }
}
