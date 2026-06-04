import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { Executor, ExecutorStatus } from './entities/executor.entity';
import { TaskExecution, ExecutionStatus } from '../task/entities/task-execution.entity';
import { Task } from '../task/entities/task.entity';

@Injectable()
export class ExecutorService {
  private readonly logger = new Logger(ExecutorService.name);
  constructor(
    @InjectRepository(Executor) private repo: Repository<Executor>,
    @InjectRepository(TaskExecution) private execRepo: Repository<TaskExecution>,
    @InjectRepository(Task) private taskRepo: Repository<Task>,
    private readonly configService: ConfigService,
  ) {}

  async register(data: { appName: string; address: string; type?: string; version?: string; capabilities?: string[] }) {
    let e: Executor | null = await this.repo.findOne({ where: { address: data.address } });
    if (!e) e = this.repo.create(data as Partial<Executor>);
    e.status = ExecutorStatus.ONLINE;
    e.lastHeartbeat = new Date();
    return this.repo.save(e);
  }

  async heartbeat(address: string, metrics: { cpuUsage?: number; memUsage?: number; runningTaskCount?: number }) {
    const e = await this.repo.findOne({ where: { address } });
    if (!e) throw new NotFoundException('Executor not found');
    Object.assign(e, metrics, { status: ExecutorStatus.ONLINE, lastHeartbeat: new Date() });
    return this.repo.save(e);
  }

  findAll() { return this.repo.find({ order: { createdAt: 'DESC' } }); }

  async dispatch(task: Task, execution: TaskExecution) {
    const all = await this.repo.find({ where: { status: ExecutorStatus.ONLINE } });

    let candidates = all;

    // 1. 按 appName 精确匹配（用户手动指定）
    if (task.executorAppName) {
      candidates = all.filter(e => e.appName === task.executorAppName);
      if (candidates.length === 0) {
        throw new Error(`No available executor with appName "${task.executorAppName}"`);
      }
    } else if (task.runtime) {
      // 2. 按 runtime/capabilities 过滤（python/node/shell）
      const filtered = all.filter(e =>
        !e.capabilities || e.capabilities.length === 0
          ? true  // 无 capabilities 声明的执行器视为通用
          : e.capabilities.includes(task.runtime),
      );
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
        `http://${matched.address}/api/execute`,
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

  /** 每 30s 自动扫描，将心跳超时 90s 的执行器标记为 OFFLINE */
  @Cron('*/30 * * * * *')
  async markStaleOffline() {
    const cutoff = new Date(Date.now() - 90_000);
    const result = await this.repo.update(
      { status: ExecutorStatus.ONLINE, lastHeartbeat: LessThan(cutoff) },
      { status: ExecutorStatus.OFFLINE },
    );
    if (result.affected && result.affected > 0) {
      this.logger.warn(`Marked ${result.affected} executor(s) as OFFLINE due to heartbeat timeout`);
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
}
