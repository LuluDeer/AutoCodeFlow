import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bull';
import { TaskExecution, ExecutionStatus } from './entities/task-execution.entity';
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
    private executorService: ExecutorService,
    private aiService: AiService,
    private notificationService: NotificationService,
  ) {}

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
    } finally {
      exec.endTime = new Date();
      exec.duration = exec.endTime.getTime() - exec.startTime.getTime();
      await this.execRepo.save(exec);
    }
  }
}
