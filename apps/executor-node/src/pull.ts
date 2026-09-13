import { config } from './config';
import { logger } from './logger';
import { postLong } from './admin-client';
import { unwrapAdminResponseData } from './admin-envelope';
import { getRunningCount } from './scheduler';
import {
  acceptExecution,
  truncateCallbackErrorMessage,
  ExecuteRequest,
} from './routes/execute';
import { pushCallback } from './callback';

/**
 * ARCH-32（ADR-015）：pull 模式派发循环——NAT 内执行器的零入站取件通道。
 *
 * push 模式由 admin 主动 POST /api/execute；pull 模式下执行器在有空闲并发
 * 槽位时向 admin 发起长轮询（POST /executors/pull，服务端阻塞至多
 * EXECUTOR_PULL_WAIT_MS），从响应载荷中取任务，随后走与 push 完全相同的
 * acceptExecution 领取路径与回调通道。除「谁发起连接」外，两种模式在执行
 * 器侧的执行/回调语义逐字节一致。
 *
 * 节奏：1s 心跳节拍检查空闲槽位 + pullInFlight 单飞——空闲时即一轮长轮询
 * （服务端挂 25s），无任务则空转返回；有任务立即领取并继续下一轮。
 */
let pullInFlight = false;

export async function pullOnce(): Promise<void> {
  if (pullInFlight) return;
  pullInFlight = true;
  try {
    const resp = await postLong('/api/executors/pull', {
      address: config.executorAddressPublic || config.executorAddress,
      waitMs: 25_000,
    });
    const payload = unwrapAdminResponseData(resp?.data);
    const task = payload?.task as (ExecuteRequest & { traceparent?: string }) | null;
    if (!task || !task.executionId) return;

    logger.info(`Pulled execution ${task.executionId} from admin pull queue`);
    const { traceparent, ...body } = task;
    const accepted = acceptExecution(body as ExecuteRequest, traceparent);
    if (accepted.status !== 200) {
      // 领取被拒（容量竞态/校验失败）：补发 failed 回调，admin 侧不留僵尸
      // RUNNING 行（stale sweep 之前先收敛）。
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
  }
}

export function startPullLoop(): NodeJS.Timeout {
  return setInterval(() => {
    if (getRunningCount() < config.maxConcurrentTasks) {
      void pullOnce();
    }
  }, 1000);
}
