import { Injectable, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Not, Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Task, TaskStatus } from './entities/task.entity';
import { TaskExecution, ExecutionStatus } from './entities/task-execution.entity';
import { ExecutionLogLine } from './entities/execution-log-line.entity';
import { TaskVersion } from './entities/task-version.entity';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { TriggerTaskDto } from './dto/trigger-task.dto';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import { SchedulerService } from '../scheduler/scheduler.service';

@Injectable()
export class TaskService {
  constructor(
    @InjectRepository(Task) private taskRepo: Repository<Task>,
    @InjectRepository(TaskExecution) private execRepo: Repository<TaskExecution>,
    @InjectRepository(ExecutionLogLine) private logLineRepo: Repository<ExecutionLogLine>,
    @InjectRepository(TaskVersion) private versionRepo: Repository<TaskVersion>,
    @InjectQueue('task-queue') private taskQueue: Queue,
    private dataSource: DataSource,
    @Inject(forwardRef(() => SchedulerService)) private schedulerService: SchedulerService,
  ) {}

  async create(dto: CreateTaskDto) {
    if (dto.dependencies && Object.keys(dto.dependencies).length > 0) {
      await this.checkCircularDependency(dto.id, dto.dependencies);
    }
    return this.taskRepo.save(this.taskRepo.create(dto));
  }

  private async checkCircularDependency(taskId: string, dependencies: Record<string, string>): Promise<void> {
    const visited = new Set<string>();
    const currentPath = new Set<string>();
    
    const dependencyIds = Object.values(dependencies);
    
    for (const depId of dependencyIds) {
      if (depId === taskId) {
        throw new Error(`Circular dependency detected: task ${taskId} depends on itself`);
      }
    }

    await this.detectCycle(taskId, dependencyIds, visited, currentPath);
  }

  private async detectCycle(
    taskId: string,
    dependencyIds: string[],
    visited: Set<string>,
    currentPath: Set<string>,
  ): Promise<void> {
    for (const depId of dependencyIds) {
      if (depId === taskId) {
        throw new Error(`Circular dependency detected: task ${taskId} has a cyclic dependency chain`);
      }
      
      if (currentPath.has(depId)) {
        throw new Error(`Circular dependency detected: task ${taskId} -> ... -> ${depId} (cycle)`);
      }
      
      if (visited.has(depId)) {
        continue;
      }

      visited.add(depId);
      currentPath.add(depId);

      try {
        const depTask = await this.taskRepo.findOne({ where: { id: depId } });
        if (depTask && depTask.dependencies && Object.keys(depTask.dependencies).length > 0) {
          const childDependencies = Object.values(depTask.dependencies);
          await this.detectCycle(taskId, childDependencies, visited, currentPath);
        }
      } finally {
        currentPath.delete(depId);
      }
    }
  }

  async findAll(p: PaginationDto) {
    const [list, total] = await this.taskRepo.findAndCount({
      where: { status: Not(TaskStatus.DELETED) },
      skip: (p.page - 1) * p.pageSize,
      take: p.pageSize,
      order: { createdAt: 'DESC' },
    });
    return paginate(list, total, p.page, p.pageSize);
  }

  async findOne(id: string) {
    const t = await this.taskRepo.findOne({ where: { id } });
    if (!t) throw new NotFoundException('Task not found');
    return t;
  }

  async update(id: string, dto: UpdateTaskDto) {
    const t = await this.findOne(id);
    const updated = await this.taskRepo.save(Object.assign(t, dto));
    // 先停止旧调度，再按新状态决定是否重新注册，无需等待下一次 reload
    this.schedulerService.stop(id);
    if (updated.status === TaskStatus.ACTIVE) {
      await this.schedulerService.scheduleOne(updated);
    }
    return updated;
  }

  async remove(id: string) {
    const t = await this.findOne(id);
    // 立即停止调度，不等下次 reload
    this.schedulerService.stop(id);
    t.status = TaskStatus.DELETED;
    await this.taskRepo.save(t);
    return { deleted: true };
  }

  async pause(id: string) {
    const t = await this.findOne(id);
    if (t.status === TaskStatus.PAUSED) {
      return { success: true, message: '任务已经是暂停状态' };
    }
    this.schedulerService.stop(id);
    t.status = TaskStatus.PAUSED;
    await this.taskRepo.save(t);
    return { success: true, message: '任务已暂停' };
  }

  async resume(id: string) {
    const t = await this.findOne(id);
    if (t.status !== TaskStatus.PAUSED) {
      return { success: true, message: '任务不是暂停状态' };
    }
    t.status = TaskStatus.ACTIVE;
    await this.taskRepo.save(t);
    await this.schedulerService.scheduleOne(t);
    return { success: true, message: '任务已恢复' };
  }

  async trigger(id: string, dto: TriggerTaskDto) {
    const task = await this.findOne(id);
    const exec = await this.dataSource.transaction(async (manager) => {
      return manager.save(
        manager.create(TaskExecution, {
          taskId: task.id,
          taskName: task.name,
          status: ExecutionStatus.PENDING,
          params: dto.params ?? task.params,
          triggerType: 'manual',
          taskVersion: task.currentVersion,
        }),
      );
    });
    await this.taskQueue.add('execute', { executionId: exec.id }, { attempts: task.maxRetry });
    return exec;
  }

  async getExecutions(taskId: string, p: PaginationDto) {
    const [list, total] = await this.execRepo.findAndCount({
      where: { taskId },
      skip: (p.page - 1) * p.pageSize,
      take: p.pageSize,
      order: { createdAt: 'DESC' },
    });
    return paginate(list, total, p.page, p.pageSize);
  }

  async getExecution(id: string) {
    const e = await this.execRepo.findOne({ where: { id } });
    if (!e) throw new NotFoundException('Execution not found');
    return e;
  }

  async getExecutionLogs(execId: string, fromLine = 0) {
    const exec = await this.execRepo.findOne({ where: { id: execId } });
    if (!exec) throw new NotFoundException('Execution not found');
    // N10: use typed logLineRepo instead of string-based getRepository
    // CODE-01: fetch true total in parallel so pagination metadata is accurate
    const [lines, totalLines] = await Promise.all([
      this.logLineRepo
        .createQueryBuilder('l')
        .where('l.executionId = :id', { id: execId })
        .andWhere('l.lineNumber >= :from', { from: fromLine })
        .orderBy('l.lineNumber', 'ASC')
        .select(['l.lineNumber', 'l.content'])
        .getMany(),
      this.logLineRepo.count({ where: { executionId: execId } }),
    ]);
    return {
      lines: lines.map((r) => r.content),
      // CODE-01: true total count, not (currentBatch + offset)
      totalLines,
      hasMore: fromLine + lines.length < totalLines,
    };
  }

  async rollback(id: string, dto: { gitCommit: string; params?: Record<string, any> }) {
    const task = await this.findOne(id);
    const prevCommit = task.gitCommit;

    const exec = await this.dataSource.transaction(async (manager) => {
      // 更新 task 的 gitCommit
      task.gitCommit = dto.gitCommit;
      await manager.save(Task, task);

      // 创建执行记录
      return manager.save(
        manager.create(TaskExecution, {
          taskId: task.id,
          taskName: task.name,
          status: ExecutionStatus.PENDING,
          params: dto.params ?? task.params,
          triggerType: 'rollback',
          taskVersion: dto.gitCommit,
        }),
      );
    });

    await this.taskQueue.add('execute', { executionId: exec.id }, { attempts: task.maxRetry });
    // N11: re-schedule so active cron/fixed-rate tasks pick up the new commit immediately
    if (task.status === TaskStatus.ACTIVE) {
      await this.schedulerService.scheduleOne(task);
    }
    return { execution: exec, rolledBackFrom: prevCommit, rolledBackTo: dto.gitCommit };
  }

  async handleCallback(callbacks: Array<{
    executionId: string;
    status: 'success' | 'failed';
    exitCode?: number;
    logs?: string;
    errorMessage?: string;
    durationMs?: number;
  }>) {
    const results = [];
    for (const cb of callbacks) {
      try {
        const execution = await this.execRepo.findOne({ where: { id: cb.executionId } });
        if (!execution) {
          results.push({ executionId: cb.executionId, success: false, error: 'Execution not found' });
          continue;
        }

        execution.status = cb.status === 'success' ? ExecutionStatus.SUCCESS : ExecutionStatus.FAILED;
        execution.endTime = new Date();
        execution.duration = cb.durationMs;
        
        if (cb.status === 'failed') {
          execution.errorMessage = cb.errorMessage;
        }
        
        if (cb.logs) {
          execution.logs = cb.logs;
          // 同时保存到日志表
          const logLines = cb.logs.split('\n');
          for (let i = 0; i < logLines.length; i++) {
            await this.logLineRepo.save(this.logLineRepo.create({
              executionId: cb.executionId,
              lineNumber: i,
              content: logLines[i],
            }));
          }
        }

        await this.execRepo.save(execution);
        results.push({ executionId: cb.executionId, success: true });
      } catch (error: any) {
        results.push({ executionId: cb.executionId, success: false, error: error.message });
      }
    }
    return results;
  }

  async saveVersion(taskId: string, createdBy?: string, description?: string): Promise<TaskVersion> {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException('Task not found');
    }

    const existingVersions = await this.versionRepo.find({ where: { taskId } });
    const versionNum = existingVersions.length + 1;
    const version = `v${versionNum}`;

    const snapshot: Record<string, any> = {
      id: task.id,
      name: task.name,
      description: task.description,
      runtime: task.runtime,
      entrypoint: task.entrypoint,
      params: task.params,
      timeout: task.timeout,
      maxRetry: task.maxRetry,
      retryDelay: task.retryDelay,
      retryableErrors: task.retryableErrors,
      triggerType: task.triggerType,
      cronExpression: task.cronExpression,
      fixedRate: task.fixedRate,
      blockStrategy: task.blockStrategy,
      misfireStrategy: task.misfireStrategy,
      priority: task.priority,
      executeMode: task.executeMode,
      currentVersion: task.currentVersion,
      gitCommit: task.gitCommit,
    };

    return this.versionRepo.save(this.versionRepo.create({
      taskId,
      version,
      gitCommit: task.gitCommit,
      snapshot,
      createdBy,
      description,
    }));
  }

  async getVersions(taskId: string): Promise<TaskVersion[]> {
    return this.versionRepo.find({
      where: { taskId },
      order: { createdAt: 'DESC' },
    });
  }

  async getVersion(taskId: string, versionId: string): Promise<TaskVersion> {
    const version = await this.versionRepo.findOne({
      where: { id: versionId, taskId },
    });
    if (!version) {
      throw new NotFoundException('Version not found');
    }
    return version;
  }

  async rollbackToVersion(taskId: string, versionId: string): Promise<Task> {
    const version = await this.getVersion(taskId, versionId);
    
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException('Task not found');
    }

    Object.assign(task, version.snapshot);
    task.currentVersion = version.version;
    
    return this.taskRepo.save(task);
  }

  async compareVersions(taskId: string, versionId1: string, versionId2: string): Promise<Record<string, { old: any; new: any }>> {
    const v1 = await this.getVersion(taskId, versionId1);
    const v2 = await this.getVersion(taskId, versionId2);
    
    const allKeys = new Set([...Object.keys(v1.snapshot), ...Object.keys(v2.snapshot)]);
    const diff: Record<string, { old: any; new: any }> = {};
    
    for (const key of allKeys) {
      if (JSON.stringify(v1.snapshot[key]) !== JSON.stringify(v2.snapshot[key])) {
        diff[key] = {
          old: v1.snapshot[key],
          new: v2.snapshot[key],
        };
      }
    }
    
    return diff;
  }

  async deleteVersion(taskId: string, versionId: string): Promise<void> {
    const version = await this.getVersion(taskId, versionId);
    await this.versionRepo.delete(version.id);
  }
}
