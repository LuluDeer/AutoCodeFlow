import * as nodeCron from "node-cron";

/**
 * A6b：**下一个 cron 落点**的计算（纯函数，无 IO、无状态）。
 *
 * ## 为什么单独成文件
 *
 * 需求横跨两个模块：
 *   · `task.service`（登记侧）—— 运维勾选「提前触发并消耗下一个计划点」时，
 *     要算出**下一个**落点并登记；
 *   · `scheduler.service`（消费侧）—— 到点判定「这一拍是否已被登记消耗」。
 *
 * 两端必须算出**逐字节相同的落点时刻**，否则登记了却跳不掉（或跳错拍）。
 * 放进共享纯函数 ⇒ 一处实现、两处调用，**不可能漂移**。
 *
 * ## 口径（与调度器注册**同源**）
 *
 * 用 `node-cron` 自己的时间匹配器（`ScheduledTask.getNextRuns(1)`）——它就是
 * `scheduler.scheduleOne` 里 `nodeCron.createTask(...)` 用的那套匹配器 ⇒
 * 「下一个落点」的定义与「到点触发」的定义**天然一致**（含时区语义）。
 *
 * ⚠️ **不用** `maintenance-window.util` 的 `lastWindowCronFireBefore`：那是
 * **向后**查（最近一个已过的落点），且是 5 段 cron 的自研解析器；本需求要的是
 * **向前**查（下一个落点），且要跟调度器同源。
 *
 * ## 一次性资源纪律
 *
 * `nodeCron.createTask` 会把任务注册进 node-cron 的**全局注册表**
 * （`nodeCron.getTasks()`）——若不 `destroy()`，每次调用都会泄漏一个条目
 * （实测：`createTask` 后 size+1，`destroy()` 后 size 归零）。
 * ⇒ 本函数**必须** `destroy()` 掉临时任务（无论成功与否）。
 */

/**
 * 算出「**从现在起算的下一个** cron 落点」。
 *
 * ⚠️ 语义锚点是 **now**（不是调用方传入的某个时刻）——node-cron 的
 * `getNextRuns(count)` 内部就是从 `new Date()` 起逐次 `getNextMatch`，
 * **不接受外部起点**（公开 API 无此能力）。本函数因此**不暴露起点参数**：
 * 暴露一个会被忽略的参数比不暴露更危险（调用方会以为算的是自己要的落点）。
 *
 * @param cronExpression cron 表达式（5 段）。空/非法 ⇒ null。
 * @param timezone IANA 时区（与调度注册同语义）。空 ⇒ 服务器默认时区。
 * @returns 落点时刻（秒/毫秒恒为 0）；表达式为空/非法 ⇒ null。
 */
export function computeNextCronFirePoint(
  cronExpression: string | null | undefined,
  timezone?: string | null,
): Date | null {
  const expr = cronExpression?.trim();
  if (!expr) return null;
  if (!nodeCron.validate(expr)) return null;
  const tz = timezone?.trim() || undefined;
  let task: nodeCron.ScheduledTask | null = null;
  try {
    task = nodeCron.createTask(expr, () => {}, { timezone: tz });
    const next = task.getNextRuns(1)[0];
    if (!next) return null;
    // 落点的秒/毫秒恒为 0（node-cron 按分钟粒度匹配）。显式抹平，避免未来
    // node-cron 改粒度时，登记值与到点判定值出现毫秒级偏差 ⇒ 登记跳不掉。
    return new Date(Math.floor(next.getTime() / 60_000) * 60_000);
  } catch {
    return null;
  } finally {
    // 必须销毁：否则每次调用都往 node-cron 的全局注册表里漏一个条目。
    try {
      task?.destroy();
    } catch {
      /* 销毁失败不影响返回值 */
    }
  }
}
