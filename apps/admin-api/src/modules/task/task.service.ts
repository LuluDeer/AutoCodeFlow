import { Injectable, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Not, Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Task, TaskStatus } from './entities/task.entity';
import { TaskExecution, ExecutionStatus } from './entities/task-execution.entity';
import { ExecutionLogLine } from './entities/execution-log-line.entity';
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
}
