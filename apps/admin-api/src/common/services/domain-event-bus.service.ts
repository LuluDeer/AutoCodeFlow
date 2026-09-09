/**
 * ARCH-21: 进程内领域事件总线——Node 原生 EventEmitter 的薄封装。
 *
 * 为什么不用 @nestjs/event-emitter：admin-api 依赖里没有它，为解耦一件事
 * 引一个新依赖不划算；本总线 60 行内覆盖需求（emit 带事件名常量 + on/off +
 * fail-open），且语义完全自控（listener 抛错绝不冒泡主链，见下）。
 *
 * fail-open 契约（验收红线之一）：
 * - 同步监听器抛错 → 捕获记日志，emit 正常返回；
 * - 异步监听器（返回 Promise）reject → 捕获记日志（防 unhandledRejection）；
 * - 主链（如 handleCallback）对「谁在监听、监听器成败」完全无感。
 *
 * 时序契约：调用方必须在 DB 终态落库（save/UPDATE 命中 winner）之后再 emit，
 * 事件即"已提交的既成事实"——listener 可放心按 id 回查。
 */
import { Global, Injectable, Logger, Module } from "@nestjs/common";
import { EventEmitter } from "node:events";
import { DomainEventName } from "../events/domain-events";

/**
 * 监听器：同步/异步皆可，返回值被忽略（若返回 Promise 其 rejection 由总线
 * 捕获记日志）；抛错一律被总线吞掉——fail-open，见文件头契约。
 */
export type DomainEventListener<T = unknown> = (payload: T) => unknown;

interface Registration {
  original: DomainEventListener<any>;
  wrapped: (...args: unknown[]) => void;
}

@Injectable()
export class DomainEventBus {
  private readonly logger = new Logger(DomainEventBus.name);
  private readonly emitter = new EventEmitter();
  /** event → listener 身份 → 包装记录（off 需要拿到包装后的同一个函数引用）。 */
  private readonly registrations = new Map<
    string,
    Map<DomainEventListener<any>, Registration>
  >();

  constructor() {
    // 默认上限 10 会对"多模块各挂若干 listener"的形态打 MaxListeners 警告；
    // 事件总线是刻意多订阅结构，放宽并显式声明。
    this.emitter.setMaxListeners(100);
  }

  /**
   * 发布事件（同步派发给当前全部监听器，fail-open）。
   * 返回 boolean（EventEmitter 语义：是否有监听器）仅供测试/诊断，
   * 调用方不得据此改变主链行为。
   */
  emit<T>(event: DomainEventName, payload: T): boolean {
    try {
      return this.emitter.emit(event, payload);
    } catch (err: unknown) {
      // 理论上不可达（派发均经 wrap 兜底），保留最外层保险丝。
      this.logger.error(
        `DomainEventBus emit("${event}") failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  on<T>(event: DomainEventName, listener: DomainEventListener<T>): void {
    const wrapped = (payload: unknown): void => {
      try {
        const result = listener(payload as T);
        if (result && typeof (result as Promise<void>).then === "function") {
          (result as Promise<void>).catch((err: unknown) =>
            this.logListenerError(event, err),
          );
        }
      } catch (err: unknown) {
        this.logListenerError(event, err);
      }
    };
    let byListener = this.registrations.get(event);
    if (!byListener) {
      byListener = new Map();
      this.registrations.set(event, byListener);
    }
    byListener.set(listener, { original: listener, wrapped });
    this.emitter.on(event, wrapped);
  }

  off(event: DomainEventName, listener: DomainEventListener<any>): void {
    const byListener = this.registrations.get(event);
    const reg = byListener?.get(listener);
    if (!byListener || !reg) return;
    this.emitter.off(event, reg.wrapped);
    byListener.delete(listener);
    if (byListener.size === 0) this.registrations.delete(event);
  }

  /** 当前注册在该事件上的监听器数量（测试与诊断用）。 */
  listenerCount(event: DomainEventName): number {
    return this.registrations.get(event)?.size ?? 0;
  }

  private logListenerError(event: DomainEventName, err: unknown): void {
    this.logger.error(
      `DomainEventBus listener for "${event}" threw (fail-open, main chain unaffected): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

@Global()
@Module({
  providers: [DomainEventBus],
  exports: [DomainEventBus],
})
export class DomainEventModule {}
