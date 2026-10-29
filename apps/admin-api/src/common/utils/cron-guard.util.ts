/**
 * CRON-GUARD（rt-5，审计 2026-10-29 第 3 轮）：`@Cron` 方法体的**顶层异常闸**。
 *
 * ## 缺陷现场
 *
 * `@nestjs/schedule` 的 cron 回调**不 await** 方法返回的 Promise（见
 * `scheduler.service.ts` 的 CRON-GUARD 头注）。于是方法体内任何一次未捕获的
 * 异常（连接池排队超时、`statement_timeout 30s`、序列化冲突重试耗尽、PG
 * 重启/failover 期间的 ECONNRESET）都会变成**未处理的 Promise rejection**：
 *
 *   cron 到点 → 方法体 await 的 DB 操作 reject → 无人 catch
 *   → `process.on("unhandledRejection")`（`main.ts`）
 *   → `gracefulFatalShutdown(...)` → `app.close()` → `exit(1)`
 *
 * 一次瞬态 DB 抖动 = **整实例**优雅退出（所有 API 一起 503、所有 SSE 断流、
 * BullMQ worker 全部重连）。而正确处置只是「记日志 + 下一拍重试」——这些 cron
 * 体全是幂等扫描/清理，丢弃本轮不会漏收敛，最坏延后一个周期。
 *
 * ## 为什么是公共 util
 *
 * 该模式原先只以 `scheduler.service.ts` 的 `private guardTick` 存在，注释里写
 * 「现在所有 cron 体都经本方法包裹」——那只在**本文件内**成立。rt-5 的机械扫描
 * 显示全仓 26 个 `@Cron` 中另有 5 个方法体裸奔（auth / audit / executor ×2 /
 * app-deployment）。把闸门提成公共设施，站点之间才不会有第二份实现漂移，
 * `scripts/check-cron-guard.mjs` 也才有唯一的判据词（`guardedCron(`）。
 *
 * ## 刻意不做的事
 *
 * - **不重试**：幂等扫描在下一拍重跑，比在本轮内紧循环重试安全（不放大已经
 *   处于故障态的 DB 压力）。
 * - **不吞掉栈**：warn 文案带 `name` + 原始 `stack`，否则「进程没死但任务静默
 *   不干活」是比崩溃更难查的另一半缺陷。
 * - **不用 error 级**：瞬态 DB 抖动的正确响应是「下一拍重试」，error 级会把
 *   告警面拖成噪声源（同 scheduler 的既有口径）。
 * - **不管重入**：并发轮次是另一个维度的问题（`scheduler` 的 `inFlightTicks`
 *   专管它）。本 util 只负责「异常不上抛」。
 */

/** 结构最小面：只消费 warn（不为 util 引入整个 @nestjs/common 依赖面） */
export interface CronGuardLogger {
  warn(message: string): void;
}

/**
 * 跑一段 cron 体，**保证不 reject**。
 *
 * 返回值语义：
 *  - 成功 → 原样透传 body 的返回值（含 `undefined`）；
 *  - 失败 → 记 warn（含 cron 名与原始栈）后返回 `undefined`。
 *
 * 调用方据此可判断「这一拍是否跑成功」（`undefined` = 失败），但**不应**把
 * `undefined` 当成业务值使用。异步 body 的 rejection 与同步 throw 都在闸内。
 *
 * @param name  可定位的 cron 名，约定 `<模块>.<方法>`（如 `auth.cleanupExpiredTokens`），
 *              直接出现在告警文案里，供按任务检索归因。
 * @param logger 只用到 `warn`（NestJS `Logger` 直接满足）。
 * @param body  实际工作体；可同步可异步。
 */
export async function guardedCron<T>(
  name: string,
  logger: CronGuardLogger,
  body: () => T | Promise<T>,
): Promise<T | undefined> {
  try {
    return await body();
  } catch (err: unknown) {
    logger.warn(
      `CRON-GUARD: cron "${name}" failed and was skipped this round ` +
        `(next tick retries): ${
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        }`,
    );
    return undefined;
  }
}
