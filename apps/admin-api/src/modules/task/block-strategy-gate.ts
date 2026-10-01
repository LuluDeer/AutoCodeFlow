import { DataSource, In, Repository } from "typeorm";
import { BlockStrategy, Task } from "./entities/task.entity";
import {
  ExecutionStatus,
  TaskExecution,
} from "./entities/task-execution.entity";
import { transitionToTerminal } from "./execution-terminal";

/**
 * N-14（chaos 场景④真发现）：blockStrategy 闸门的单一事实源。
 *
 * 此前闸门只在本文件的调用方之一 SchedulerService.enqueue()（cron/fixed_rate/
 * misfire）内联——手动/API/依赖触发经 TaskService.trigger() 直入 BullMQ，
 * 完全绕过 block 策略（cover_early 任务手动二次触发两执行并发，2026-10-01
 * chaos 实测）。本模块把闸门抽为共享 util，两条路径同规则。
 *
 * ## 比较维度：「任务 + 参数」（朴素「仅按任务」方案已被否决）
 *
 * 直接按 taskId 拦截会误伤「同任务不同参数」的合法并发（发货程序按订单
 * 传参：A 订单在发，B 订单的触发会被覆盖/丢弃——B 的货就没了）。调度路径
 * 从未踩坑只因 cron/fixed_rate 恒用 task.params 同参，不是设计考虑过参数。
 * 因此闸门只对 **params 规范化等价** 的在跑/排队执行生效：
 * - 同参（重复工作）→ 按策略 discard/cover_early；
 * - 异参（不同工作）→ 放行并发。
 *
 * ## 与互斥组（MUTEX-01）的正交关系
 *
 * 互斥组管执行层「同设备×同组串行」（WAITING 排队 + 10s sweep 唤醒），
 * 本闸门管触发层「重复工作判定」，两层都须通过、互不感知。统计范围保持
 * In([RUNNING, WAITING])：WAITING（互斥/部署约束排队）计入「前一轮还没
 * 跑完」；PENDING 刻意不计入（BullMQ backlog 是常态，计入会改变既有语义）。
 *
 * ## 选型边界（文档化）
 *
 * - cover_early：强杀同参在跑执行（无断点续接）后新触发从头重做——受害者
 *   恒为同参执行，工作量不丢（与 maxRetry 重试同构；非幂等副作用是任务
 *   作者借 maxRetry/retryableErrors 慎重处理的既有面）；
 * - serial：触发层不拦（本函数直接放行），串行语义由互斥组执行层承担，
 *   不可中断/不可重来的任务应选它；
 * - discard：同参在跑即放弃本轮（手动/API 面 409，调度面静默跳过）。
 */

/**
 * params 规范化：递归排序对象键的稳定 JSON 序列化，供「同参」判定。
 * - 对象键序不敏感（{a,b} 与 {b,a} 等价）；数组保序（有序列表是语义的一部分）；
 * - 值为 undefined 的对象键等价于不存在（与 JSON 序列化行为一致）；
 * - 顶层/叶级 undefined 归一为 null。
 */
export function canonicalizeParams(
  params: Record<string, unknown> | null | undefined,
): string {
  return JSON.stringify(canonicalizeValue(params ?? null));
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalizeValue(v);
    }
    return out;
  }
  return value ?? null;
}

export interface BlockStrategyGateHooks {
  /** 闸门动作的可观测出口（调度面/手动面的日志口径各自拼接） */
  warn(message: string): void;
  /** 被覆盖 RUNNING 执行的执行器槽位回退（未提供则不释放） */
  releaseSlot?(address: string | null): Promise<void>;
  /** 被覆盖 RUNNING 执行的进程终止下发（A4：先终态后 kill，见下） */
  notifyKill?(executionId: string, address: string): Promise<void>;
  /** discard 命中的 metrics 出口（调度面 recordTriggerSkippedBlockStrategy） */
  onDiscardSkip?(): void;
}

export type BlockStrategyGateOutcome = "proceed" | "skip";

/**
 * 对一次触发施加 blockStrategy 闸门。
 *
 * @param task 触发目标（需 id/name/blockStrategy；调用方保证已取到新态）
 * @param incomingParams 本次触发的生效参数（行将写入的 params：手动面为
 *   dto.params ?? task.params，调度面恒 task.params）
 * @param execRepo 执行行仓储
 * @returns "skip"=丢弃本轮触发（调用方终止：调度面 return null / 手动面 409）；
 *   "proceed"=放行（含 cover 已完成取消动作后的放行）
 */
export async function applyBlockStrategyGate(
  task: Pick<Task, "id" | "name" | "blockStrategy">,
  incomingParams: Record<string, unknown> | null | undefined,
  execRepo: Repository<TaskExecution>,
  hooks: BlockStrategyGateHooks,
): Promise<BlockStrategyGateOutcome> {
  if (task.blockStrategy === BlockStrategy.SERIAL) return "proceed";

  const actives = await execRepo.find({
    where: {
      taskId: task.id,
      status: In([ExecutionStatus.RUNNING, ExecutionStatus.WAITING]),
    },
  });
  const incoming = canonicalizeParams(incomingParams);
  const sameParams = actives.filter(
    (row) => canonicalizeParams(row.params) === incoming,
  );
  if (sameParams.length === 0) return "proceed";

  if (task.blockStrategy === BlockStrategy.DISCARD) {
    hooks.warn(
      `Task "${task.name}" is ${sameParams[0].status.toUpperCase()} with ${sameParams.length} same-params active execution(s) (blockStrategy=DISCARD), skip trigger`,
    );
    hooks.onDiscardSkip?.();
    return "skip";
  }

  // COVER_EARLY：取消全部同参在跑/排队执行（新触发取而代之）。逐条处理——
  // 多条同参并发只能在竞态或历史存量下出现，全部清掉比旧实现的「只覆盖最新
  // 一条」（findOne DESC）更彻底且语义一致。
  for (const candidate of sameParams) {
    hooks.warn(
      `Task "${task.name}" is ${candidate.status.toUpperCase()} (blockStrategy=COVER_EARLY), cancelling running execution ${candidate.id}`,
    );
    // R4-P1: the previous blind save() could overwrite a SUCCESS that
    // a concurrent callback had already committed (and double-release
    // the executor slot, oversubscribing capacity).
    // A1: 走统一入口——开放态门槛、RETURNING winner 判定、以及「驱动
    // 命中但未返回行」的快照兜底，三件事都在 transitionToTerminal 里。
    const { rows: coveredRows } = await transitionToTerminal(execRepo, {
      ids: [candidate.id],
      patch: {
        status: ExecutionStatus.CANCELLED,
        errorMessage: "Task was covered by new trigger",
        endTime: new Date(),
      },
      addressSnapshot: {
        [candidate.id]: candidate.executorAddress ?? null,
      },
    });
    if (coveredRows.length === 0) {
      hooks.warn(
        `COVER_EARLY: execution ${candidate.id} already reached a terminal state (concurrent callback/kill), not covered`,
      );
      continue;
    }
    for (const row of coveredRows) {
      // WAITING（排队未开跑）无进程可杀、无槽位可冲销：executorAddress 恒空，
      // 槽位与 kill 都不触碰（旧调度内联实现是靠 releaseExecutorSlot 的空守卫
      // 兜底，gate 化后守卫前移到调用侧，钩子契约更干净）。
      if (row.executorAddress) {
        await hooks.releaseSlot?.(row.executorAddress);
        // A4（第三轮审计·高）：此前只翻转 DB 终态、不杀进程——RUNNING 的
        // 被覆盖执行原进程会继续跑完再回调，回调被终态门拒收，白烧整机算力
        // 且与「被覆盖即终止」的 runbook.cancelled 文案相悖。此处补 best-effort
        // kill 下发（push 执行器直连 /kill-execution，pull 执行器走命令队列）。
        // 顺序刻意后置：先落 CANCELLED 终态再通知执行器——若进程先死并回调
        // KILLED，本处的覆盖跃迁会因终态门命中 0 行而误判「未覆盖」。
        // 下发失败仅 warn，绝不阻塞 CANCELLED 终态与新触发的执行。
        if (candidate.status === ExecutionStatus.RUNNING) {
          try {
            await hooks.notifyKill?.(row.id, row.executorAddress);
            hooks.warn(
              `COVER_EARLY: kill notified to executor ${row.executorAddress} for covered execution ${row.id}`,
            );
          } catch (err: unknown) {
            hooks.warn(
              `COVER_EARLY: kill notification failed for covered execution ${row.id} ` +
                `(executor ${row.executorAddress}): ${
                  err instanceof Error ? err.message : String(err)
                } — CANCELLED terminal state is unaffected`,
            );
          }
        }
      }
      hooks.warn(`COVER_EARLY: execution ${row.id} cancelled by new trigger`);
    }
  }
  return "proceed";
}

/**
 * 执行器槽位回退（被覆盖 RUNNING 执行在 executors.runningTaskCount 上的
 * 计数冲销）。调度器与手动触发路径共用——GREATEST 下限保护防负数。
 */
export async function releaseExecutorSlotByAddress(
  dataSource: DataSource,
  address?: string | null,
): Promise<void> {
  if (!address) return;
  await dataSource
    .createQueryBuilder()
    .update("executors")
    .set({ runningTaskCount: () => 'GREATEST("runningTaskCount" - 1, 0)' })
    .where("address = :addr", { addr: address })
    .execute();
}
