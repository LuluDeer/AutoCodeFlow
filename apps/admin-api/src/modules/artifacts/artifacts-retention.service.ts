import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import * as fs from "fs";
import * as path from "path";
import { getArtifactRootDir } from "./artifacts.constants";
import { TaskExecution } from "../task/entities/task-execution.entity";
// ARCH-31 §5: cron 维护任务统一 Leader 门禁（@Optional——既有单测直接 new
// 装配时 gate 缺席 → null → 门禁不生效，先例同 TracingService）。
import { LeaderGateService } from "../../common/leader-gate/leader-gate.service";

/**
 * FEAT-05：执行产物 TTL 清理（搭车日志保留期策略）。
 *
 * 产物文件落在 `uploads/artifacts/<execId>/`。NETOPT-8⑦ 起磁盘与 DB 清单
 * **同步回收**：磁盘目录按 `LOG_RETENTION_DAYS`（configuration.logRetention.days，
 * 默认 30）删除"最旧文件 mtime 早于保留期"的产物子目录后，同一批 execId 的
 * DB 清单列（task_executions.artifacts）同步置空——此前磁盘独立回收而清单列
 * 随执行行 90d 保留，30-90 天窗口内执行详情仍列产物但下载 404。
 *
 * best-effort：单目录清理失败只记日志跳过，绝不阻断其余目录，也不影响主流程；
 * 清单置空（UPDATE）失败同样只 warn，不回滚已完成的磁盘回收。多实例并发删除
 * 幂等（rm -rf 已删目录 no-op）。
 */
@Injectable()
export class ArtifactsRetentionService {
  private readonly logger = new Logger(ArtifactsRetentionService.name);

  /** NETOPT-8⑦: 清单置空 UPDATE 的分批 IN 大小（PG 绑定参数余量内） */
  private static readonly ARTIFACTS_DB_SWEEP_CHUNK = 1000;

  constructor(
    private readonly configService: ConfigService,
    // ARCH-31 §5: 多实例下 @Cron 维护任务仅 cron Leader 执行（@Global 恒提供）。
    @Optional()
    private readonly leaderGate: LeaderGateService | null = null,
    // NETOPT-8⑦: 清盘后同步置空 task_executions.artifacts 清单列。
    // @Optional 同 leaderGate 先例——既有单测装配未提供时为 null，退化为
    // 仅磁盘清理（旧行为）。
    @Optional()
    @InjectRepository(TaskExecution)
    private readonly execRepo: Repository<TaskExecution> | null = null,
  ) {}

  private resolveRetentionDays(): number {
    const parsed = this.configService.get<number>("logRetention.days");
    if (typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return 30;
  }

  @Cron("0 45 3 * * *")
  async handleDailyCleanup(): Promise<void> {
    // ARCH-31 §5: 多实例下仅 cron Leader 执行（下同，详见 LeaderGateService）
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    try {
      const removed = await this.cleanupExpiredArtifacts();
      if (removed > 0) {
        this.logger.log(`FEAT-05: 清理 ${removed} 个过期产物目录`);
      }
    } catch (err) {
      this.logger.error(
        `FEAT-05: 产物 TTL 清理失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 返回被删除的子目录数。now 可注入以便测试。 */
  async cleanupExpiredArtifacts(now: Date = new Date()): Promise<number> {
    const root = getArtifactRootDir();
    if (!fs.existsSync(root)) return 0;
    const retentionDays = this.resolveRetentionDays();
    const cutoffMs = now.getTime() - retentionDays * 86_400_000;

    let removed = 0;
    let entries: string[] = [];
    // NETOPT-8⑦: 本轮被清盘的 execId（目录名即执行 id）——清盘后同步置空
    // 这些执行的 DB artifacts 清单列
    const removedExecIds: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch (err) {
      this.logger.warn(
        `FEAT-05: 无法读取产物根目录: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }

    for (const entry of entries) {
      const dir = path.join(root, entry);
      try {
        const oldest = this.oldestMtimeMs(dir);
        if (oldest !== null && oldest < cutoffMs) {
          await fs.promises.rm(dir, { recursive: true, force: true });
          removed++;
          removedExecIds.push(entry);
        }
      } catch (err) {
        // best-effort：跳过该目录，等下一轮。
        this.logger.debug(
          `FEAT-05: 跳过产物目录 ${entry}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // NETOPT-8⑦: 磁盘清盘后同步清 DB 清单——修复 30（磁盘 TTL）-90（DB 行）
    // 天窗口内「详情仍列产物但下载 404」的两侧不一致。best-effort：UPDATE
    // 失败只 warn，不回滚已完成的磁盘回收（磁盘已回收是事实，清单残留由
    // 下一轮或执行行 90d retention 收口）。
    if (removedExecIds.length > 0 && this.execRepo) {
      for (
        let i = 0;
        i < removedExecIds.length;
        i += ArtifactsRetentionService.ARTIFACTS_DB_SWEEP_CHUNK
      ) {
        const chunk = removedExecIds.slice(
          i,
          i + ArtifactsRetentionService.ARTIFACTS_DB_SWEEP_CHUNK,
        );
        try {
          await this.execRepo.update({ id: In(chunk) }, { artifacts: null });
        } catch (err) {
          this.logger.warn(
            `FEAT-05: 清空 ${chunk.length} 个执行产物清单列失败（磁盘已回收，清单由执行行 90d retention 兜底）: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    return removed;
  }

  /** 目录内最旧文件 mtime（毫秒）；空目录/不可读回退目录自身 mtime。 */
  private oldestMtimeMs(dir: string): number | null {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return null;
    let oldest = st.mtimeMs;
    for (const f of fs.readdirSync(dir)) {
      const fst = fs.statSync(path.join(dir, f));
      if (fst.mtimeMs < oldest) oldest = fst.mtimeMs;
    }
    return oldest;
  }
}
