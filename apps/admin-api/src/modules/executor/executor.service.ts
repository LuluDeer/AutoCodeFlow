import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { Executor, ExecutorStatus } from './entities/executor.entity';
import { TaskExecution, ExecutionStatus } from '../task/entities/task-execution.entity';

@Injectable()
export class ExecutorService {
  private readonly logger = new Logger(ExecutorService.name);
  constructor(
    @InjectRepository(Executor) private repo: Repository<Executor>,
    @InjectRepository(TaskExecution) private execRepo: Repository<TaskExecution>,
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

  async dispatch(task: any, execution: TaskExecution) {
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

    // 3. 按负载（runningTaskCount）最小值选择
    const matched = candidates.sort((a, b) => a.runningTaskCount - b.runningTaskCount)[0];
    if (!matched) throw new Error('No available executor');

    this.logger.log(`Dispatching task "${task.name}" to executor ${matched.address} (runningTasks=${matched.runningTaskCount})`);
    execution.executorAddress = matched.address;
    const resp = await axios.post(
      `http://${matched.address}/api/execute`,
      { executionId: execution.id, task, params: execution.params },
      { timeout: ((task.timeout || 300) + 10) * 1000 },
    );
    return resp.data;
  }

  /** 每 5 分钟扫描 RUNNING 超时且执行器已离线的 execution，防止僵尸任务 */
  @Cron('0 */5 * * * *')
  async detectLostExecutions() {
    const threshold = new Date(Date.now() - 15 * 60 * 1000);
    const lostExecs = await this.execRepo
      .createQueryBuilder('exec')
      .where('exec.status = :status', { status: ExecutionStatus.RUNNING })
      .andWhere('exec.startTime < :threshold', { threshold })
      .getMany();
    if (lostExecs.length === 0) return;
    for (const exec of lostExecs) {
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
}
