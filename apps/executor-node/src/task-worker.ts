import { logger } from './logger';
import { runTask } from './routes/execute';
import { pushCallback } from './callback';

export interface TaskPayload {
  id?: string | number;
  runtime?: string;
  entrypoint?: string;
  timeout?: number;
  requirements?: string[];
  gitRepo?: string;
  gitCommit?: string;
  gitBranch?: string;
  glueSource?: string;
  glue_source?: string;
  glueLanguage?: string;
  glue_language?: string;
  [key: string]: unknown;
}

interface TaskQueueItem {
  executionId: string;
  task: TaskPayload;
  params: Record<string, unknown>;
  onComplete?: () => void;
  /** execute.ts 后台流程提供的"到点再准备"回调：worker 轮到该执行时
   *  （同一 taskId 串行）才执行 git checkout / 依赖安装等 prepare 阶段，
   *  返回真正准备好的 task。缺省时 executeItem 直接 runTask（旧语义）。 */
  runPrepared?: (assertNotCancelled: () => void) => Promise<{ task: any; params: Record<string, any> }>;
  /** kill 端点已收尾（回调 + 槽位释放由其负责）：不得再执行、不得再触发 onComplete */
  cancelled?: boolean;
}

/** prepare/执行期间被 kill 端点取消的内部信号——worker 捕获后静默返回，
 *  收尾责任在发起取消的一方。 */
export class ExecutionCancelledError extends Error {
  constructor(executionId: string) {
    super(`Execution ${executionId} was cancelled`);
    this.name = 'ExecutionCancelledError';
  }
}

interface WorkerState {
  running: boolean;
  currentExecutionId: string | null;
  queue: TaskQueueItem[];
}

class TaskWorker {
  private taskId: string;
  private state: WorkerState;
  private stopped: boolean;
  private maxConcurrent: number;
  private runningCount: number;
  private onIdle?: () => void;

  constructor(taskId: string, maxConcurrent: number = 1, onIdle?: () => void) {
    this.taskId = taskId;
    this.maxConcurrent = maxConcurrent;
    this.state = {
      running: false,
      currentExecutionId: null,
      queue: [],
    };
    this.stopped = false;
    this.runningCount = 0;
    this.onIdle = onIdle;
  }

  enqueue(
    executionId: string,
    task: any,
    params: Record<string, any>,
    onComplete?: () => void,
    runPrepared?: TaskQueueItem['runPrepared'],
  ): void {
    this.state.queue.push({ executionId, task, params, onComplete, runPrepared });
    logger.debug(`Task ${this.taskId}: Enqueued execution ${executionId}, queue size: ${this.state.queue.length}`);
    this.process();
  }

  private async process(): Promise<void> {
    if (this.stopped) return;
    
    while (this.state.queue.length > 0 && this.runningCount < this.maxConcurrent) {
      const item = this.state.queue.shift();
      if (!item) break;

      this.runningCount++;
      this.executeItem(item).finally(() => {
        this.runningCount--;
        // runningCount 在 process 的 finally 中递减（executeItem 的 finally
        // 早于该递减执行），空闲判定必须挂在这里：无运行中且无排队时通知
        // Manager 安排延迟回收，防止 workers Map 按 taskId 只增不减（N9）。
        if (this.runningCount === 0 && this.state.queue.length === 0) {
          this.onIdle?.();
        }
        setImmediate(() => this.process());
      });
    }
  }

  private async executeItem(item: TaskQueueItem): Promise<void> {
    const { executionId, params, onComplete } = item;
    
    try {
      logger.debug(`Task ${this.taskId}: Starting execution ${executionId}`);

      // runPrepared 由 execute.ts 提供：prepare（git/依赖安装）在轮到本
      // 执行时才跑，返回真正可运行的 task；未提供则沿用旧语义直接 runTask。
      let task: any = item.task;
      let runParams: Record<string, any> = params;
      if (item.runPrepared) {
        if (item.cancelled) {
          throw new ExecutionCancelledError(executionId);
        }
        const prepared = await item.runPrepared(() => {
          if (item.cancelled) throw new ExecutionCancelledError(executionId);
        });
        task = prepared.task;
        runParams = prepared.params;
      }
      
      await runTask(task, runParams, executionId);
      
      logger.debug(`Task ${this.taskId}: Completed execution ${executionId}`);
    } catch (error: any) {
      if (error instanceof ExecutionCancelledError || item.cancelled) {
        // kill 取消：任务从未启动。失败回调由 kill 端点/runPrepared 取消分支
        // 负责；容量释放走下面 finally 的 onComplete——entry.release() 幂等，
        // 与 kill 端点的收尾并存也不会双释放。
        logger.info(`Task ${this.taskId}: Execution ${executionId} cancelled by kill request`);
        return;
      }
      logger.error(`Task ${this.taskId}: Execution ${executionId} failed: ${error.message}`);
    } finally {
      if (!item.cancelled) {
        onComplete?.();
      }
    }
  }

  /** 见 TaskWorkerManager.cancelExecution：仅处理未开始（仍在队列中）的执行。 */
  cancelQueued(executionId: string): boolean {
    const idx = this.state.queue.findIndex(i => i.executionId === executionId);
    if (idx === -1) return false;
    const [item] = this.state.queue.splice(idx, 1);
    item.cancelled = true;
    return true;
  }

  stop(): void {
    this.stopped = true;
    // Fail queued items instead of dropping them silently — admin-api marks
    // the executions failed and capacity slots are released.
    const queued = this.state.queue.splice(0);
    for (const item of queued) {
      pushCallback({
        executionId: item.executionId,
        status: 'failed',
        errorMessage: 'Executor is shutting down before this execution started',
      });
      item.onComplete?.();
    }
    logger.info(`Task ${this.taskId}: Worker stopped (${queued.length} queued item(s) failed)`);
  }

  getRunningCount(): number {
    return this.runningCount;
  }

  getQueueSize(): number {
    return this.state.queue.length;
  }
}

/** worker 空闲多久后被回收（N9）。导出以便测试与运维核对。 */
export const IDLE_RECYCLE_MS = 5 * 60_000;

class TaskWorkerManager {
  private workers = new Map<string, TaskWorker>();
  private idleTimers = new Map<string, NodeJS.Timeout>();
  private maxConcurrentPerTask: number;

  constructor(maxConcurrentPerTask: number = 1) {
    this.maxConcurrentPerTask = maxConcurrentPerTask;
  }

  getWorker(taskId: string): TaskWorker {
    // 任何对 worker 的再次命中都视为活动，取消待执行的空闲回收
    this.cancelIdleRecycle(taskId);
    let worker = this.workers.get(taskId);
    if (!worker) {
      worker = new TaskWorker(taskId, this.maxConcurrentPerTask, () => this.scheduleIdleRecycle(taskId));
      this.workers.set(taskId, worker);
      logger.info(`Created worker for task ${taskId}`);
    }
    return worker;
  }

  async execute(
    taskId: string,
    executionId: string,
    task: any,
    params: Record<string, any>,
    onComplete?: () => void,
    runPrepared?: (assertNotCancelled: () => void) => Promise<{ task: any; params: Record<string, any> }>,
  ): Promise<void> {
    const worker = this.getWorker(taskId);
    worker.enqueue(executionId, task, params, onComplete, runPrepared);
  }

  /** 把仍在排队的执行从 worker 队列中摘除并标记取消。true=执行尚未开始，
   *  调用方（kill 端点）负责失败回调与容量释放；false=已在运行中（或不存在），
   *  调用方改走"杀进程 + 等 worker 正常收尾"路径。 */
  cancelExecution(taskId: string, executionId: string): boolean {
    const worker = this.workers.get(taskId);
    return worker ? worker.cancelQueued(executionId) : false;
  }

  private scheduleIdleRecycle(taskId: string): void {
    this.cancelIdleRecycle(taskId);
    const timer = setTimeout(() => {
      this.idleTimers.delete(taskId);
      const worker = this.workers.get(taskId);
      // 双保险：回收只作用于真正空闲的 worker，绝不触碰运行中/排队的执行
      if (worker && worker.getRunningCount() === 0 && worker.getQueueSize() === 0) {
        logger.info(`Recycling idle worker for task ${taskId}`);
        this.stopWorker(taskId);
      }
    }, IDLE_RECYCLE_MS);
    // 空闲回收定时器不应阻止进程退出
    timer.unref();
    this.idleTimers.set(taskId, timer);
  }

  private cancelIdleRecycle(taskId: string): void {
    const timer = this.idleTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(taskId);
    }
  }

  stopWorker(taskId: string): void {
    this.cancelIdleRecycle(taskId);
    const worker = this.workers.get(taskId);
    if (worker) {
      worker.stop();
      this.workers.delete(taskId);
    }
  }

  stopAll(): void {
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
    for (const [taskId, worker] of this.workers) {
      worker.stop();
    }
    this.workers.clear();
    logger.info('All workers stopped');
  }

  getStats(): Record<string, { running: number; queueSize: number }> {
    const stats: Record<string, { running: number; queueSize: number }> = {};
    for (const [taskId, worker] of this.workers) {
      stats[taskId] = {
        running: worker.getRunningCount(),
        queueSize: worker.getQueueSize(),
      };
    }
    return stats;
  }
}

export const taskWorkerManager = new TaskWorkerManager();
export { TaskWorker, TaskWorkerManager };