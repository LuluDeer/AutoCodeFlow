import { config } from './config';
import { logger } from './logger';
import { postLong, request } from './admin-client';
import { unwrapAdminResponseData } from './admin-envelope';
import { getRunningCount, getRunningCountArray } from './scheduler';
import { getExecutorAuthToken } from './routes/logs';
import {
  acceptExecution,
  truncateCallbackErrorMessage,
  ExecuteRequest,
} from './routes/execute';
import { pushCallback } from './callback';
import axios from 'axios';

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

/**
 * E-07（残差收口）：在飞长轮询的中止句柄。
 *
 * 旧实现只 clearInterval——已发出的那一轮长轮询（服务端阻塞至多 25s）仍在
 * 飞。停机 drain 阶段若它在窗口末端带回一个任务，acceptExecution 照样会领取
 * 并执行，与「停机第一步停止取件」的意图相悖；进程也因该 socket 未关而多挂
 * 至多 25s。现改为：每轮发起前建 AbortController，停机时 abort 之——服务端
 * 连接立即断开，窗口内的任务不再被领取（admin 侧无人认领的 RUNNING 行由既有
 * stale sweep 收敛，与 pull 请求失败路径同一语义）。
 */
let pullAbortController: AbortController | null = null;

/**
 * 1-3（audit-r4）：预留槽位停滞看门狗硬期限（毫秒）。postLong 自带 40s 请求
 * 超时，但网络栈病态（半开连接、TCP 停滞）时 axios 内部超时不保证触发——
 * 那本轮 pullOnce 永不 settle，预留的槽位随进程存活期泄漏一个（pullInFlight
 * 单飞封住了并发泄漏面，但这一个仍会长期占位、拖低可用容量）。硬期限取
 * 45s > 请求窗口 40s：到点 abort 在飞请求 → postLong 必然 reject → 走
 * catch/finally 释放预留（与停机 abort 同一语义路径）。定时器在 finally
 * 摘除，不残留句柄。
 */
const PULL_STALL_TIMEOUT_MS = 45_000;

/**
 * E-1（中台↔执行器深度审查）：pull 模式配置热更新。
 *
 * 背景：执行器配置热更新只有 admin 主动 POST /api/config/reload 一条通道；
 * pull 执行器（NAT 内、零入站）无法被推送，配置变更只能等重启生效。方案：
 * admin 的 pull 响应附带 `configVersion` 指纹；本执行器记录**已应用版本**，
 * 检测到指纹变化即主动 GET /api/executors/config 拉取全量配置，并复用本地
 * /api/config/reload 的**同一套校验与应用路径**（自回环 HTTP——apply 逻辑
 * 单一事实源，零漂移；失败不影响本轮任务取件，下一轮 pull 再试）。
 *
 * 节流：指纹未变不拉取；拉取/应用失败保留旧版本号，下一轮重试（不背压任务
 * 通道）。启动早期 admin 尚未就绪时的拉取失败只记 warn，静默恢复。
 */
let appliedConfigVersion: string | null = null;

async function maybePullConfig(adminConfigVersion: unknown): Promise<void> {
  if (typeof adminConfigVersion !== 'string' || adminConfigVersion.length === 0) {
    return; // 旧版 admin 无指纹字段 → 不拉取（行为不变）
  }
  if (appliedConfigVersion === adminConfigVersion) return;
  try {
    const address = config.executorAddressPublic || config.executorAddress;
    // GET /api/executors/config 走 request()（自动鉴权 + failover + 401 自愈），
    // 与心跳同一认证通道。
    const resp = await request(
      'get',
      `/api/executors/config?address=${encodeURIComponent(address)}`,
    );
    const body = unwrapAdminResponseData(resp?.data);
    if (!body || typeof body !== 'object') {
      logger.warn(
        'Pull-mode config fetch returned a non-object payload; keeping applied config version',
      );
      return;
    }
    // 复用本地 /api/config/reload 的校验 + 应用路径（schema 闸门 + workDir
    // 校验 + ignored_fields 上报），与 admin 主动推送行为逐字节一致。
    const localUrl = `http://127.0.0.1:${config.port}/api/config/reload`;
    const local = await axios.post(localUrl, body, {
      headers: { Authorization: `Bearer ${getExecutorAuthToken()}` },
      timeout: 10_000,
    });
    if (local.status >= 200 && local.status < 300) {
      appliedConfigVersion = adminConfigVersion;
      logger.info(
        `Pull-mode config hot-reloaded (version ${adminConfigVersion}): ` +
          `${(local.data as { updated_fields?: string[] })?.updated_fields?.join(', ') || 'no changes'}`,
      );
    } else {
      logger.warn(
        `Pull-mode config reload rejected by local /config/reload (HTTP ${local.status})`,
      );
    }
  } catch (err: unknown) {
    logger.warn(
      `Pull-mode config reload failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function pullOnce(): Promise<void> {
  if (pullInFlight) return;
  pullInFlight = true;
  // E-01: 预留标记——true 期间本函数持有且仅持有一个账本槽位；accept 返回
  // 200（预留转正式占用）或本函数提前占位失败时置 false，finally 里对仍
  // 持有的预留做唯一一次释放（唯一的释放点，杜绝双释放）。
  let slotReserved = false;
  // E-07: 本轮的中止句柄（finally 负责摘除，避免停机后残留悬空引用）。
  let controller: AbortController | null = null;
  // 1-3: 停滞看门狗句柄（finally 摘除）。
  let stallTimer: NodeJS.Timeout | null = null;
  try {
    // 原子预留：add 返回旧值，旧值已 ≥ 上限说明无空闲槽位——回退并跳过
    // 本轮（与 acceptExecution 的 add-then-check 同款原子模式）。
    const previous = Atomics.add(getRunningCountArray(), 0, 1);
    if (previous >= config.maxConcurrentTasks) {
      Atomics.sub(getRunningCountArray(), 0, 1);
      return;
    }
    slotReserved = true;

    controller = new AbortController();
    pullAbortController = controller;
    // 1-3: 预留成立后才挂看门狗——只保护持有预留的本轮。
    stallTimer = setTimeout(() => {
      controller?.abort();
    }, PULL_STALL_TIMEOUT_MS);

    const resp = await postLong(
      '/api/executors/pull',
      {
        address: config.executorAddressPublic || config.executorAddress,
        waitMs: 25_000,
      },
      40_000,
      controller.signal,
    );
    const payload = unwrapAdminResponseData(resp?.data);
    // E-1: 配置指纹比对 + 主动拉取（失败不阻塞取件，下一轮重试）。
    await maybePullConfig(payload?.configVersion);
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
        // E-42（DEEP_REVIEW 0ef3bbe）parity：这条拒绝发生在 accept 之前的
        // 校验/登记阶段（400 等），既不是拉取失败也不是运行失败——admin 的
        // inferFailureReason 只能从 errorMessage 猜。显式上报 'unknown'
        // （ExecutionFailureReason 枚举成员），与 executor-python
        // reject_pulled_execution 的同一路径口径一致。429 那条瞬态路径已在
        // 上方提前 return，不回调（见 E-01）。
        failureReason: 'unknown',
        errorMessage: truncateCallbackErrorMessage(
          `Executor rejected pulled dispatch: ${error}`,
        ),
      });
    }
  } catch (err: unknown) {
    // E-07: 停机 abort 是预期中止，不是故障——记 info 而非 warn，避免把正常
    // 关机路径污染成告警噪声（运维侧 warn 应保持可行动信号）。
    if (controller?.signal.aborted) {
      logger.info('Pull long-poll aborted during shutdown');
    } else {
      logger.warn(
        `Pull failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } finally {
    pullInFlight = false;
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
    if (pullAbortController === controller) {
      pullAbortController = null;
    }
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

/** E-07: 停止 pull 取件循环（main.ts gracefulShutdown 首步调用）。
 *
 *  两步都要做：① clearInterval 停掉后续轮次；② abort 在飞的那一轮长轮询——
 *  否则服务端 25s 阻塞窗口内仍可能带回任务被领取，且进程要多挂至多 25s。 */
export function stopPullLoop(): void {
  if (pullLoopInterval) {
    clearInterval(pullLoopInterval);
    pullLoopInterval = null;
  }
  if (pullAbortController) {
    pullAbortController.abort();
    pullAbortController = null;
  }
}
