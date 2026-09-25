import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import {
  AlertLevel,
  NotificationService,
} from "../../notification/notification.service";
import { AgentSession } from "../entities/agent-session.entity";

/**
 * P4（agent-and-deployment）：Agent 会话通知（设计文档 02 §7.2）。
 *
 * ## 通知时机（§7.2 的表逐行落地）
 *
 * | 会话结局 | 级别 | 行为 |
 * |---|---|---|
 * | `succeeded` 且 summary 非空 | INFO | 一句话摘要 + 会话标识 |
 * | `succeeded` 无 summary | — | **不通知**（静默会话） |
 * | `failed` / `budget_exceeded` | ERROR | 失败原因（升级通知） |
 * | `aborted` | — | 管理员自己的动作，不回推 |
 * | 工具待审批 | WARNING | 工具名 + 审批单 id |
 *
 * **静默成功是刻意设计**：运维 Agent 的价值是「有事才说话」。巡检类会话
 * 大部分无事——若每次都通知，人很快屏蔽这个渠道，真出事时通知也一起被屏蔽。
 * 「无结论」的表征与 `AgentTriggerService` 的约定一致：`summary` 为空。
 *
 * ## fail-open
 * 所有出站调用都吞异常只告警：调用方是推理循环与会话收敛路径，通知挂了
 * **绝不能**把已经落库收敛的会话再搅出第二次失败，更不能影响执行主链。
 * （渠道内部的逐渠道路失败已由 NotificationService.sendToChannels 兜住，
 * 这里兜的是「通知服务整体不可用」这层。）
 */
@Injectable()
export class AgentNotifyService {
  private readonly logger = new Logger(AgentNotifyService.name);

  constructor(
    private readonly notifications: NotificationService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 会话收敛到终态后的通知判定（在 `AgentSessionService.finish()` 落库后调用）。
   *
   * @param session **已应用本次终态更新**的会话快照——finish() 里是
   *   先落库再通知，传进来的必须是更新后的形状，否则「summary 是否有结论」
   *   会读到旧值，静默语义就错了。
   */
  async sessionFinished(session: AgentSession): Promise<void> {
    if (!this.enabled()) return;

    try {
      const tag = `Agent:${session.title || session.kind}`;

      // 静默会话：成功但无实质结论（无 summary）→ 不通知
      if (session.status === "succeeded") {
        if (!session.summary) return;
        await this.notifications.notify(
          tag,
          `${session.summary}\n\n会话 ${session.id}（触发：${session.triggerSource}，步骤 ${session.totalSteps}，令牌 ${session.totalTokensIn + session.totalTokensOut}）`,
          AlertLevel.INFO,
        );
        return;
      }

      // aborted 是管理员主动终止，管理员本人知道，不回推
      if (session.status === "aborted") return;

      // failed / budget_exceeded：升级通知（ERROR 级）
      const why =
        session.errorMessage ?? session.summary ?? "无错误详情（查会话步骤）";
      await this.notifications.notify(
        tag,
        `会话 ${session.status}：${why}\n\n会话 ${session.id}（触发：${session.triggerSource}，步骤 ${session.totalSteps}）`,
        AlertLevel.ERROR,
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Agent session notify failed (fail-open): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 工具调用触发人工审批时的推送（在审批单落库后调用）。
   *
   * 审批当前走 Admin Web 会话详情页人工处理（resume）；通知让管理员
   * **不用轮询**就知道有单子挂着——DEP-04 的「审批不催等于没审」同款问题。
   */
  async approvalRequested(
    session: AgentSession,
    toolName: string,
    approvalId: string,
    reason: string,
  ): Promise<void> {
    if (!this.enabled()) return;

    try {
      await this.notifications.notify(
        `Agent审批:${session.title || session.kind}`,
        `工具 ${toolName} 等待人工审批：${reason}\n审批单 ${approvalId}（会话 ${session.id}）——请在 Admin Web 会话详情页处理后 resume。`,
        AlertLevel.WARNING,
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Agent approval notify failed (fail-open): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 配置开关（`agent.notify.enabled`，默认开——渠道未配置时各渠道自行跳过）。 */
  private enabled(): boolean {
    const raw = this.config.get<unknown>("agent.notify.enabled");
    if (raw === undefined || raw === null || raw === "") return true;
    if (typeof raw === "boolean") return raw;
    const s = String(raw).trim().toLowerCase();
    return s !== "false" && s !== "0";
  }
}
