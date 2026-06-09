import { logger } from './logger';

interface TaskQueueItem {
  executionId: string;
  task: any;
  params: Record<string, any>;
  onComplete?: () => void;
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

  constructor(taskId: string, maxConcurrent: number = 1) {
    this.taskId = taskId;
    this.maxConcurrent = maxConcurrent;
    this.state = {
      running: false,
      currentExecutionId: null,
      queue: [],
    };
    this.stopped = false;
    this.runningCount = 0;
  }

  enqueue(executionId: string, task: any, params: Record<string, any>, onComplete?: () => void): void {
    this.state.queue.push({ executionId, task, params, onComplete });
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
        setImmediate(() => this.process());
      });
    }
  }

  private async executeItem(item: TaskQueueItem): Promise<void> {
    const { executionId, task, params, onComplete } = item;
    
    try {
      logger.debug(`Task ${this.taskId}: Starting execution ${executionId}`);
      
      const { runTask } = await import('./routes/execute');
      await runTask(task, params, executionId);
      
      logger.debug(`Task ${this.taskId}: Completed execution ${executionId}`);
    } catch (error: any) {
      logger.error(`Task ${this.taskId}: Execution ${executionId} failed: ${error.message}`);
    } finally {
      onComplete?.();
    }
  }

  stop(): void {
    this.stopped = true;
    logger.info(`Task ${this.taskId}: Worker stopped`);
  }

  getRunningCount(): number {
    return this.runningCount;
  }

  getQueueSize(): number {
    return this.state.queue.length;
  }
}

class TaskWorkerManager {
  private workers = new Map<string, TaskWorker>();
  private maxConcurrentPerTask: number;

  constructor(maxConcurrentPerTask: number = 1) {
    this.maxConcurrentPerTask = maxConcurrentPerTask;
  }

  getWorker(taskId: string): TaskWorker {
    let worker = this.workers.get(taskId);
    if (!worker) {
      worker = new TaskWorker(taskId, this.maxConcurrentPerTask);
      this.workers.set(taskId, worker);
      logger.info(`Created worker for task ${taskId}`);
    }
    return worker;
  }

  async execute(taskId: string, executionId: string, task: any, params: Record<string, any>, onComplete?: () => void): Promise<void> {
    const worker = this.getWorker(taskId);
    worker.enqueue(executionId, task, params, onComplete);
  }

  stopWorker(taskId: string): void {
    const worker = this.workers.get(taskId);
    if (worker) {
      worker.stop();
      this.workers.delete(taskId);
    }
  }

  stopAll(): void {
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