import { config } from './config';
import { logger } from './logger';
import { postLong } from './admin-client';
import { unwrapAdminResponseData } from './admin-envelope';
import { getRunningCount, getRunningCountArray } from './scheduler';
import {
  acceptExecution,
  truncateCallbackErrorMessage,
  ExecuteRequest,
} from './routes/execute';
import { pushCallback } from './callback';

/**
 * ARCH-32（ADR-015）：pull 模式派发循环——NAT 内执行器的零入站取件通道。
 *
 * push 模式由 admin 主动 POST /api/execute；pull 模式下执行器向 admin 发起
 * 长轮询（POST /executors/pull，服务端阻塞至多 EXECUTOR_PULL_WAIT_MS），从
 * 响应载荷中取任务，随后走与 push 完全相同的 acceptExecution 领取路径与回
 * 调通道。除「谁发起连接」外，两种模式在执行器侧的执行/回调语义逐字节一致。
 *
 * 节奏：1s 心跳节拍检查空闲槽位 + pullInFlight 单飞——空闲时即一轮长轮询
 * （服务端挂 25s），无任务则空转返回；有任务立即领取并继续下一轮。
 *
 * E-01（P1）pull 容量竞态——预留槽位方案：
 * 旧实现「先检查空槽 → 再发长轮询 → 拿到任务后才 accept」，而 admin 端长
 * 轮询阻塞最长 25s；期间一个 push 派发可能占走最后一个槽位，accept 返回
 * 429，旧代码随即补发 failed 回调——把「暂时没槽位」的瞬态固化成 admin 侧
 * 永久失败（评审 audit-r2 E-01 / audit-r3 E-01 复核）。现改为：
 *
 *   1. 发起 pull 之前先在本执行器的并发账本（与 acceptExecution 同一个
 *      SharedArrayBuffer 计数）原子预留一个槽位（add-then-check，与
 *      acceptExecution 同款原子模式）；
 *   2. 预留成功才发 pull 请求。心跳 runningTaskCount 因此诚实包含「预留中
 *      的槽位」——admin 的容量核算在长轮询窗口内看到的执行器就是满的，
 *      不会再把 push 派发塞进这最后一个空槽（诚实语义，非故意虚报）；
 *   3. admin 无任务返回 → finally 立即释放预留，进入下一轮；
 *   4. admin 返回任务 → 以 slotPreReserved 领取，预留即正式占用，容量检
 *      查必然通过（见 acceptExecution 注释）；执行完成路径的 entry.release()
 *      归还的正是这一个预留槽位，账本零漂移。
 */
let pullInFlight = false;

export async function pullOnce(): Promise<void> {
  if (pullInFlight) return;
  pullInFlight = true;
  // E-01: 预留标记——true 期间本函数持有且仅持有一个账本槽位；accept 返回
  // 200（预留转正式占用）或本函数提前占位失败时置 false，finally 里对仍
  // 持有的预留做唯一一次释放（唯一的释放点，杜绝双释放）。
  let slotReserved = false;
  try {
    // 原子预留：add 返回旧值，旧值已 ≥ 上限说明无空闲槽位——回退并跳过
    // 本轮（与 acceptExecution 的 add-then-check 同款原子模式）。
    const previous = Atomics.add(getRunningCountArray(), 0, 1);
    if (previous >= config.maxConcurrentTasks) {
      Atomics.sub(getRunningCountArray(), 0, 1);
      return;
    }
    slotReserved = true;

    const resp = await postLong('/api/executors/pull', {
      address: config.executorAddressPublic || config.executorAddress,
      waitMs: 25_000,
    });
    const payload = unwrapAdminResponseData(resp?.data);
    const task = payload?.task as (ExecuteRequest & { traceparent?: string }) | null;
    if (!task || !task.executionId) return; // 无任务：finally 释放预留

    logger.info(`Pulled execution ${task.executionId} from admin pull queue`);
    const { traceparent, ...body } = task;
    // 预留即正式占用：slotPreReserved 模式下 accept 不再重复计数，容量检
    // 查必然通过；执行完成时 entry.release() 释放的就是这个预留槽位。
    const accepted = acceptExecution(body as ExecuteRequest, traceparent, {
      slotPreReserved: true,
    });
    if (accepted.status === 200) {
      // 所有权移交完成：槽位由执行条目持有至终态，finally 不再释放。
      slotReserved = false;
    } else if (accepted.status === 429) {
      // 防御路径（正常流程不可达——预留模式下 accept 的容量检查必然通过；
      // 仅当账本被异常推高/竞态残余时触发）：释放预留 + warn，但【不回调
      // failed】。429 是「暂时没容量」的瞬态，把它补发成 failed 恰是本修
      // 复要关闭的「固化永久失败」行为；admin 侧对无人认领的 RUNNING 行
      // 有 stale sweep 兜底收敛，这里静默让位。
      logger.warn(
        `Pulled execution ${task.executionId} rejected with 429 despite pre-reserved slot ` +
          '(capacity ledger drift) — releasing reservation, no failed callback ' +
          '(admin stale sweep converges the orphan RUNNING row)',
      );
    } else {
      // 非 200 且非 429（400 校验失败等）：真失败——维持既有语义补发
      // failed 回调，admin 侧不留僵尸 RUNNING 行。预留由 finally 释放。
      const error =
        typeof (accepted.payload as { error?: string }).error === 'string'
          ? (accepted.payload as { error: string }).error
          : `HTTP ${accepted.status}`;
      logger.warn(
        `Pulled execution ${task.executionId} rejected (HTTP ${accepted.status}): ${error}`,
      );
      pushCallback({
        executionId: task.executionId,
        status: 'failed',
        errorMessage: truncateCallbackErrorMessage(
          `Executor rejected pulled dispatch: ${error}`,
        ),
      });
    }
  } catch (err: unknown) {
    logger.warn(
      `Pull failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    pullInFlight = false;
    if (slotReserved) {
      // 释放预留（无任务 / accept 非 200 / pull 请求异常）：唯一释放点。
      Atomics.sub(getRunningCountArray(), 0, 1);
    }
  }
}

// E-07: 保存 pull 循环句柄，供优雅停机（main.ts gracefulShutdown 首步）
// clearInterval 停止——避免 drain/关机阶段继续领取新任务。
let pullLoopInterval: NodeJS.Timeout | null = null;

export function startPullLoop(): NodeJS.Timeout {
  // E-07: 保存句柄（原实现直接 return 丢弃）；停机路径据此停止 pull 循环。
  pullLoopInterval = setInterval(() => {
    // 廉价预检（预留本身在 pullOnce 内原子完成，双保险不改变正确性）：
    // E-01 后 getRunningCount() 诚实包含预留中的槽位，满载时连 pullOnce
    // 都不必进入。
    if (getRunningCount() < config.maxConcurrentTasks) {
      void pullOnce();
    }
  }, 1000);
  return pullLoopInterval;
}

/** E-07: 停止 pull 取件循环（main.ts gracefulShutdown 首步调用）。 */
export function stopPullLoop(): void {
  if (pullLoopInterval) {
    clearInterval(pullLoopInterval);
    pullLoopInterval = null;
  }
}
