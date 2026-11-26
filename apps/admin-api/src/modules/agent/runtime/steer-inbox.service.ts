/**
 * N8 · steer inbox 的进程内装配层。
 *
 * 纯状态机在 `steer-inbox.ts`（零依赖、21 例反证已由 steer-inbox.spec 覆盖）；
 * 本文件只做「按 sessionId 存/取」的装配，与 toolExecutor / approvals 同款
 * provider 风格：runtime 只认注入口，缺席即 fail-open（drain 空 inbox）。
 *
 * 刻意不持久化到 contextJson：那是 N14 generation 契约的字段，steer 是**本进程
 * 本轮 run 的下一跳输入**，跨副本/重启的持久语义不属于这一层。审计已确认此形态。
 */
import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  drainAtStepBoundary,
  emptyInbox,
  parkIntent,
  shouldWake,
  type DrainResult,
  type SteerInbox,
  type SteerIntent,
  type StepBoundary,
} from "./steer-inbox";

export interface SteerParkResult {
  /** 实际写入的意图；被终态/未知状态拒绝时为 null。 */
  intent: SteerIntent | null;
  /** shouldWake 判定：终态一律 false，绝不复活死意图。 */
  wake: boolean;
}

@Injectable()
export class SteerInboxService {
  private readonly inboxes = new Map<string, SteerInbox>();

  /**
   * waiting_input 期入队（controller 已显式判过状态；这里再用 shouldWake
   * fail-closed 兜一道：终态/未知态一律不入 inbox、不产生唤醒凭据）。
   */
  park(
    sessionId: string,
    content: string,
    parkedAtStep: number,
    targetStatus: string | null | undefined,
  ): SteerParkResult {
    const intent: SteerIntent = {
      id: randomUUID(),
      content,
      parkedAtStep,
    };
    if (
      !shouldWake({ targetId: sessionId, intentId: intent.id }, targetStatus)
    ) {
      return { intent: null, wake: false };
    }
    const inbox = this.inboxes.get(sessionId) ?? emptyInbox();
    this.inboxes.set(sessionId, parkIntent(inbox, intent));
    return { intent, wake: true };
  }

  /** 步边界取出并清空（非步边界原样保留，语义全在纯函数里）。 */
  drain(sessionId: string, currentStep: StepBoundary): DrainResult {
    const inbox = this.inboxes.get(sessionId) ?? emptyInbox();
    const result = drainAtStepBoundary(inbox, currentStep);
    if (result.inbox.intents.length === 0) {
      this.inboxes.delete(sessionId);
    } else {
      this.inboxes.set(sessionId, result.inbox);
    }
    return result;
  }

  /** 只读视图（接线层断言「POST 只写 inbox」用；生产无消费方）。 */
  peek(sessionId: string): SteerInbox {
    return this.inboxes.get(sessionId) ?? emptyInbox();
  }
}
