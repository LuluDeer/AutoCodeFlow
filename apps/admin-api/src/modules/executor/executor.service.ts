import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, MoreThanOrEqual, In } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { Executor, ExecutorStatus } from './entities/executor.entity';
import { TaskExecution, ExecutionStatus } from '../task/entities/task-execution.entity';
import { Task, ExecuteMode } from '../task/entities/task.entity';
import { PaginationDto } from '../../common/dto/pagination.dto';

@Injectable()
export class ExecutorService {
  private readonly logger = new Logger(ExecutorService.name);
  private readonly protocol: string;
  
  constructor(
    @InjectRepository(Executor) private repo: Repository<Executor>,
    @InjectRepository(TaskExecution) private execRepo: Repository<TaskExecution>,
    @InjectRepository(Task) private taskRepo: Repository<Task>,
    private readonly configService: ConfigService,
  ) {
    this.protocol = this.configService.get<string>('app.protocol') || 'http';
  }
  
  private getExecutorUrl(address: string, path: string): string {
    if (address.startsWith('http://') || address.startsWith('https://')) {
      return `${address}/${path}`;
    }
    return `${this.protocol}://${address}/${path}`;
  }

  async register(data: { appName: string; address: string; type?: string; version?: string; capabilities?: string[] }) {
    let e: Executor | null = await this.repo.findOne({ where: { address: data.address } });
    if (!e) e = this.repo.create(data as Partial<Executor>);
    e.status = ExecutorStatus.ONLINE;
    e.lastHeartbeat = new Date();
    return this.repo.save(e);
  }

  async heartbeat(address: string, metrics: {
    cpuUsage?: number;
    memUsage?: number;
    diskUsage?: number;
    networkLatency?: number;
    runningTaskCount?: number;
    totalTaskCount?: number;
    failedTaskCount?: number;
  }) {
    const e = await this.repo.findOne({ where: { address } });
    if (!e) throw new NotFoundException('Executor not found');
    Object.assign(e, metrics, { status: ExecutorStatus.ONLINE, lastHeartbeat: new Date() });
    return this.repo.save(e);
  }

  findAll() { return this.repo.find({ order: { createdAt: 'DESC' } }); }
  
  async findOne(id: string): Promise<Executor> {
    const executor = await this.repo.findOne({ where: { id } });
    if (!executor) throw new NotFoundException('Executor not found');
    return executor;
  }
  
  /**
   * Update executor metadata (group, tags, description, maxConcurrentTasks).
   */
  async update(id: string, data: {
    groupName?: string | null;
    tags?: string[] | null;
    description?: string | null;
    maxConcurrentTasks?: number | null;
  }): Promise<Executor> {
    const executor = await this.findOne(id);
    Object.assign(executor, data);
    return this.repo.save(executor);
  }
  
  /**
   * Get all unique executor groups.
   */
  async getGroups(): Promise<string[]> {
    const execs = await this.repo.createQueryBuilder('e')
      .select('DISTINCT e.groupName', 'groupName')
      .where('e.groupName IS NOT NULL')
      .getRawMany();
    return execs.map(x => x.groupName).filter(Boolean);
  }
  
  /**
   * Get all unique executor tags.
   */
  async getTags(): Promise<string[]> {
    const execs = await this.repo.find();
    const tagSet = new Set<string>();
    execs.forEach(e => {
      if (e.tags) e.tags.forEach(tag => tagSet.add(tag));
    });
    return Array.from(tagSet).sort();
  }

  async dispatch(task: Task, execution: TaskExecution) {
    const all = await this.repo.find({ where: { status: ExecutorStatus.ONLINE } });

    let candidates = all;

    // 1. 按 appName 精确匹配（用户手动指定）
    if (task.executorAppName) {
      candidates = all.filter(e => e.appName === task.executorAppName);
      if (candidates.length === 0) {
        throw new Error(`No available executor with appName "${task.executorAppName}"`);
      }
    } else {
      // 2. 按分组/标签/运行时过滤
      let filtered = all;
      
      // 2.1 按分组过滤
      if (task.executorGroup) {
        filtered = filtered.filter(e => e.groupName === task.executorGroup);
      }
      
      // 2.2 按标签过滤（任务需要的标签必须是执行器标签的子集）
      if (task.executorTags && task.executorTags.length > 0) {
        filtered = filtered.filter(e => {
          if (!e.tags) return false;
          return task.executorTags!.every(tag => e.tags!.includes(tag));
        });
      }
      
      // 2.3 按 runtime/capabilities 过滤
      if (task.runtime) {
        filtered = filtered.filter(e =>
          !e.capabilities || e.capabilities.length === 0
            ? true
            : e.capabilities.includes(task.runtime),
        );
      }
      
      if (filtered.length > 0) {
        candidates = filtered;
      }
    }

    // 3. 按负载（runningTaskCount）升序排列，依次尝试乐观锁抢占
    const sorted = candidates.sort((a, b) => a.runningTaskCount - b.runningTaskCount);

    let matched: Executor | null = null;
    for (const candidate of sorted) {
      const maxConcurrent = candidate.maxConcurrentTasks ?? Infinity;
      // 乐观锁：仅当 runningTaskCount < maxConcurrentTasks 时才 increment
      const result = await this.repo
        .createQueryBuilder()
        .update(Executor)
        .set({ runningTaskCount: () => 'running_task_count + 1' })
        .where('id = :id', { id: candidate.id })
        .andWhere('status = :status', { status: ExecutorStatus.ONLINE })
        .andWhere(
          maxConcurrent === Infinity
            ? '1=1'
            : 'running_task_count < :max',
          maxConcurrent === Infinity ? {} : { max: maxConcurrent },
        )
        .execute();
      if (result.affected && result.affected > 0) {
        matched = candidate;
        candidate.runningTaskCount += 1; // sync local state after DB increment
        break;
      }
    }

    if (!matched) throw new Error('No available executor (all at capacity or concurrency conflict)');

    this.logger.log(`Dispatching task "${task.name}" to executor ${matched.address} (runningTasks=${matched.runningTaskCount})`);
    execution.executorAddress = matched.address;

    try {
      const resp = await axios.post(
        this.getExecutorUrl(matched.address, 'api/execute'),
        { executionId: execution.id, task, params: execution.params },
        { timeout: ((task.timeout || 300) + 10) * 1000 },
      );
      return resp.data;
    } catch (err: unknown) {
      // 派发失败时回退计数，避免泄漏
      await this.repo
        .createQueryBuilder()
        .update(Executor)
        .set({ runningTaskCount: () => 'GREATEST(running_task_count - 1, 0)' })
        .where('id = :id', { id: matched.id })
        .execute();
      throw err;
    }
  }

  /**
   * Broadcast dispatch: send the task to ALL online executors simultaneously.
   * Used when task.executeMode === ExecuteMode.BROADCAST.
   * Returns a list of results for each executor.
   */
  async dispatchBroadcast(task: Task, execution: TaskExecution): Promise<any[]> {
    const all = await this.repo.find({ where: { status: ExecutorStatus.ONLINE } });
    let candidates = all;

    // Apply same filters as dispatch
    if (task.executorAppName) {
      candidates = all.filter(e => e.appName === task.executorAppName);
    } else {
      let filtered = all;
      if (task.executorGroup) {
        filtered = filtered.filter(e => e.groupName === task.executorGroup);
      }
      if (task.executorTags && task.executorTags.length > 0) {
        filtered = filtered.filter(e => {
          if (!e.tags) return false;
          return task.executorTags!.every(tag => e.tags!.includes(tag));
        });
      }
      if (task.runtime) {
        filtered = filtered.filter(e =>
          !e.capabilities || e.capabilities.length === 0
            ? true
            : e.capabilities.includes(task.runtime),
        );
      }
      if (filtered.length > 0) candidates = filtered;
    }

    if (candidates.length === 0) {
      throw new Error('No available executor for broadcast dispatch');
    }

    this.logger.log(`Broadcasting task "${task.name}" to ${candidates.length} executors`);

    // Fire all dispatches in parallel and collect results
    const results = await Promise.allSettled(
      candidates.map(async (executor) => {
        const dispatchUrl = this.getExecutorUrl(executor.address, 'api/execute');
        const resp = await axios.post(
          dispatchUrl,
          { executionId: execution.id, task, params: execution.params },
          { timeout: ((task.timeout || 300) + 10) * 1000 },
        );
        return { executor: executor.address, result: resp.data };
      }),
    );

    const successes: any[] = [];
    const failures: string[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        successes.push(r.value);
      } else {
        const errMsg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        failures.push(`${candidates[i].address}: ${errMsg}`);
      }
    });

    if (failures.length > 0) {
      this.logger.warn(`Broadcast partially failed for task "${task.name}": ${failures.join('; ')}`);
    }

    if (successes.length === 0) {
      throw new Error(`Broadcast failed on all ${candidates.length} executors: ${failures.join('; ')}`);
    }

    return successes;
  }

  /** 每 5 分钟扫描 RUNNING 超时且执行器已离线的 execution，防止僵尸任务 */
  @Cron('0 */5 * * * *')
  async detectLostExecutions() {
    // N12: use a broad threshold for initial query (max sane timeout 24h),
    // then per-execution check uses actual task.timeout + 5min buffer
    const broadThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const lostExecs = await this.execRepo
      .createQueryBuilder('exec')
      .where('exec.status = :status', { status: ExecutionStatus.RUNNING })
      .andWhere('exec.startTime < :threshold', { threshold: broadThreshold })
      .getMany();
    if (lostExecs.length === 0) return;
    for (const exec of lostExecs) {
      // N12: per-execution threshold based on actual task timeout
      const task = exec.taskId
        ? await this.taskRepo.findOne({ where: { id: exec.taskId } })
        : null;
      const taskTimeoutMs = task?.timeout ? task.timeout * 1000 : 5 * 60 * 1000;
      const perExecThreshold = new Date(Date.now() - (taskTimeoutMs + 5 * 60 * 1000));
      if (exec.startTime && exec.startTime > perExecThreshold) {
        // Not yet past this task's timeout+buffer — skip
        continue;
      }
      if (exec.executorAddress) {
        const executor = await this.repo.findOne({ where: { address: exec.executorAddress } });
        if (executor && executor.status === ExecutorStatus.ONLINE) continue;
      }
      exec.status = ExecutionStatus.FAILED;
      exec.endTime = new Date();
      exec.errorMessage = '[系统] 执行器离线或任务超时，调度中心主动标记为失败';
      exec.logs = (exec.logs || '') + '\n[系统] 执行记录超时未收到回调，已强制标记为 FAILED';
      await this.execRepo.save(exec);
      this.logger.warn(`Lost execution marked FAILED: execId=${exec.id}, taskId=${exec.taskId}`);
    }
  }

  /** Q7: 每天凌晨 2 点清理旧执行记录（90天）和审计日志（180天），防止数据库无限膨胀 */
  @Cron('0 0 2 * * *')
  async cleanupOldRecords(): Promise<void> {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const execResult = await this.execRepo.delete({ createdAt: LessThan(ninetyDaysAgo) });
    if (execResult.affected && execResult.affected > 0) {
      this.logger.log(`Q7 Cleanup: removed ${execResult.affected} old task executions (>90 days)`);
    }
  }

  /** 每 30s 自动扫描，将心跳超时的执行器标记为 OFFLINE */
  @Cron('*/30 * * * * *')
  async markStaleOffline() {
    // 使用配置的心跳间隔和超时倍数计算超时时间
    const heartbeatInterval = this.configService.get<number>('executor.heartbeatInterval') || 30000;
    const timeoutMultiplier = this.configService.get<number>('executor.heartbeatTimeoutMultiplier') || 3;
    const timeoutMs = heartbeatInterval * timeoutMultiplier;
    const cutoff = new Date(Date.now() - timeoutMs);
    
    const result = await this.repo.update(
      { status: ExecutorStatus.ONLINE, lastHeartbeat: LessThan(cutoff) },
      { status: ExecutorStatus.OFFLINE },
    );
    if (result.affected && result.affected > 0) {
      this.logger.warn(`Marked ${result.affected} executor(s) as OFFLINE due to heartbeat timeout (${timeoutMs}ms)`);
    }
  }

  /** 每小时执行，清理离线超过7天的执行器记录 */
  @Cron('0 0 * * * *')
  async cleanupOfflineExecutors() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await this.repo.delete({
      status: ExecutorStatus.OFFLINE,
      lastHeartbeat: LessThan(sevenDaysAgo),
    });
    if (result.affected && result.affected > 0) {
      this.logger.log(`Cleaned up ${result.affected} offline executor(s) (>7 days)`);
    }
  }

  /**
   * SEC-03: Issue a fresh per-executor token.
   * Returns the raw token once (caller must store it); only the bcrypt hash is persisted.
   */
  async rotateToken(id: string): Promise<{ token: string }> {
    const executor = await this.repo.findOne({ where: { id } });
    if (!executor) throw new NotFoundException('Executor not found');
    const rawToken = randomBytes(32).toString('hex');
    executor.tokenHash = await bcrypt.hash(rawToken, 12);
    await this.repo.save(executor);
    this.logger.log(`Rotated token for executor ${id} (${executor.address})`);
    return { token: rawToken };
  }

  /**
   * SEC-03: Validate a per-executor token.
   * Falls back to the legacy shared token for backward compatibility.
   */
  async validateExecutorToken(id: string, presented: string): Promise<boolean> {
    const executor = await this.repo
      .createQueryBuilder('e')
      .addSelect('e.tokenHash')
      .where('e.id = :id', { id })
      .getOne();
    if (!executor) return false;
    if (executor.tokenHash) {
      return bcrypt.compare(presented, executor.tokenHash);
    }
    const shared = this.configService.get<string>('executor.sharedToken') ?? '';
    return shared.length > 0 && presented === shared;
  }

  /**
   * SEC-03: Validate executor token by address (used for heartbeat/register validation).
   * Supports both per-executor dynamic tokens and the legacy shared token.
   */
  async validateTokenByAddress(address: string, presented: string): Promise<boolean> {
    // First try to validate against per-executor token
    const executor = await this.repo
      .createQueryBuilder('e')
      .addSelect('e.tokenHash')
      .where('e.address = :address', { address })
      .getOne();
    
    if (executor && executor.tokenHash) {
      const isValid = await bcrypt.compare(presented, executor.tokenHash);
      if (isValid) return true;
    }
    
    // Fall back to shared token
    const shared = this.configService.get<string>('executor.sharedToken') ?? '';
    return shared.length > 0 && presented === shared;
  }

  /**
   * Mark an executor as offline (graceful shutdown).
   */
  async markOffline(address: string): Promise<void> {
    await this.repo.update({ address }, { status: ExecutorStatus.OFFLINE, lastHeartbeat: new Date() });
    this.logger.log(`Executor ${address} marked as offline`);
  }

  /**
   * Get task executions for a specific executor.
   */
  async getExecutorExecutions(id: string, pagination: PaginationDto): Promise<{ total: number; items: TaskExecution[] }> {
    const executor = await this.findOne(id);
    const [items, total] = await this.execRepo.findAndCount({
      where: { executorAddress: executor.address },
      order: { createdAt: 'DESC' },
      take: pagination.limit,
      skip: (pagination.page - 1) * pagination.limit,
    });
    return { total, items };
  }

  /**
   * Get performance metrics for a specific executor.
   */
  async getExecutorMetrics(id: string): Promise<any> {
    const executor = await this.findOne(id);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    
    const totalExecutions = await this.execRepo.count({
      where: { executorAddress: executor.address, createdAt: MoreThanOrEqual(sevenDaysAgo) },
    });
    const successful = await this.execRepo.count({
      where: { executorAddress: executor.address, status: ExecutionStatus.SUCCESS, createdAt: MoreThanOrEqual(sevenDaysAgo) },
    });
    const failed = await this.execRepo.count({
      where: { executorAddress: executor.address, status: ExecutionStatus.FAILED, createdAt: MoreThanOrEqual(sevenDaysAgo) },
    });
    
    const avgDurationQuery = await this.execRepo
      .createQueryBuilder('e')
      .select('AVG(e.duration)', 'avg')
      .where('e.executorAddress = :address', { address: executor.address })
      .andWhere('e.createdAt >= :date', { date: sevenDaysAgo })
      .andWhere('e.duration IS NOT NULL')
      .getRawOne();
    
    return {
      executor: { id: executor.id, address: executor.address, status: executor.status },
      sevenDayStats: {
        totalExecutions,
        successful,
        failed,
        successRate: totalExecutions > 0 ? ((successful / totalExecutions) * 100).toFixed(2) : 0,
        averageDurationMs: avgDurationQuery?.avg ? parseFloat(avgDurationQuery.avg).toFixed(2) : 0,
      },
      current: {
        runningTaskCount: executor.runningTaskCount,
        cpuUsage: executor.cpuUsage,
        memUsage: executor.memUsage,
      },
    };
  }
}
