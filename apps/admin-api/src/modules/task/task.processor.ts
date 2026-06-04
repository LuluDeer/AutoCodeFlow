import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bull';
import { TaskExecution, ExecutionStatus } from './entities/task-execution.entity';
import { ExecutionLogLine } from './entities/execution-log-line.entity';
import { Task } from './entities/task.entity';
import { ExecutorService } from '../executor/executor.service';
import { AiService } from '../ai/ai.service';
import { NotificationService } from '../notification/notification.service';

@Processor('task-queue')
export class TaskProcessor {
  private readonly logger = new Logger(TaskProcessor.name);

  constructor(
    @InjectRepository(TaskExecution) private execRepo: Repository<TaskExecution>,
    @InjectRepository(Task) private taskRepo: Repository<Task>,
    @InjectRepository(ExecutionLogLine) private logLineRepo: Repository<ExecutionLogLine>,
    private executorService: ExecutorService,
    private aiService: AiService,
    private notificationService: NotificationService,
  ) {}

  /**
   * Fetch log lines from executor's /api/logs/{executionId} endpoint and
   * persist them as ExecutionLogLine rows for structured querying.
   */
  private async fetchAndStoreLogLines(exec: TaskExecution, executorAddress: string): Promise<void> {
    if (!executorAddress) return;
    try {
      // N9: use ConfigService instead of direct process.env access
      const token = this.configService.get<string>('executor.sharedToken') ?? '';
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const { default: axios } = await import('axios');
      const resp = await axios.get(
        `http://${executorAddress}/api/logs/${exec.id}`,
        { headers, timeout: 15000 },
      );
      const lines: string[] = resp.data?.lines ?? [];
      if (lines.length === 0) return;
      // Delete stale lines first (idempotent on retry)
      await this.logLineRepo.delete({ executionId: exec.id });
      const entities = lines.map((content, idx) =>
        this.logLineRepo.create({ executionId: exec.id, lineNumber: idx, content }),
      );
      // Bulk insert in chunks of 500 to avoid hitting DB param limits
      const CHUNK = 500;
      for (let i = 0; i < entities.length; i += CHUNK) {
        await this.logLineRepo.save(entities.slice(i, i + CHUNK));
      }
      this.logger.log(`Stored ${entities.length} log lines for execution ${exec.id}`);
    } catch (err) {
      // Non-fatal: log but do not fail the execution record
      this.logger.warn(`Failed to fetch log lines for ${exec.id}: ${err.message}`);
    }
  }

  @Process('execute')
  async handle(job: Job<{ executionId: string }>) {
    const { executionId } = job.data;
    const exec = await this.execRepo.findOne({ where: { id: executionId } });
    if (!exec) return;

    // 从数据库查询最新 task，避免使用队列中可能过期的序列化对象
    const task = await this.taskRepo.findOne({ where: { id: exec.taskId } });
    if (!task) {
      this.logger.error(`Task ${exec.taskId} not found for execution ${executionId}`);
      exec.status = ExecutionStatus.FAILED;
      exec.errorMessage = `Task ${exec.taskId} not found`;
      await this.execRepo.save(exec);
      return;
    }

    exec.status = ExecutionStatus.RUNNING;
    exec.startTime = new Date();
    await this.execRepo.save(exec);

    try {
      const result = await this.executorService.dispatch(task, exec);
      exec.status = ExecutionStatus.SUCCESS;
      exec.result = result;
      exec.logs = result?.logs || '';
      // Fetch and store structured log lines from executor
      await this.fetchAndStoreLogLines(exec, result?.executorAddress ?? exec.executorAddress);
    } catch (err) {
      exec.status = ExecutionStatus.FAILED;
      exec.errorMessage = err.message;
      exec.logs = err.stack || err.message;
      try {
        exec.aiAnalysis = await this.aiService.analyzeFailure(task, exec.logs);
      } catch {}
      this.logger.error(`Task ${task.id} failed: ${err.message}`);
      try {
        await this.notificationService.notifyFailureWithConfig(task.name, exec.id, err.message, exec.aiAnalysis, task.alarmEmail, task.alarmChannels);
      } catch {}
      // Q1: rethrow so BullMQ sees the job as failed and applies maxRetry attempts
      throw err;
    } finally {
      exec.endTime = new Date();
      exec.duration = exec.endTime.getTime() - exec.startTime.getTime();
      await this.execRepo.save(exec);
    }
  }
}
