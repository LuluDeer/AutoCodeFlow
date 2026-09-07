import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import * as fs from "fs";
import * as path from "path";
import { getArtifactRootDir } from "./artifacts.constants";

/**
 * FEAT-05：执行产物 TTL 清理（搭车日志保留期策略）。
 *
 * 产物文件落在 `uploads/artifacts/<execId>/`，DB 里的清单列（task_executions.artifacts）
 * 随行生命周期由既有 execution 清理/保留处理；但磁盘字节需要独立回收，否则
 * uploads 卷无限膨胀。本服务每日按 `LOG_RETENTION_DAYS`（configuration.logRetention.days）
 * 删除"最旧文件 mtime 早于保留期"的产物子目录。
 *
 * best-effort：单目录清理失败只记日志跳过，绝不阻断其余目录，也不影响主流程。
 * 多实例并发删除幂等（rm -rf 已删目录 no-op）。
 */
@Injectable()
export class ArtifactsRetentionService {
  private readonly logger = new Logger(ArtifactsRetentionService.name);

  constructor(private readonly configService: ConfigService) {}

  private resolveRetentionDays(): number {
    const parsed = this.configService.get<number>("logRetention.days");
    if (typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return 30;
  }

  @Cron("0 45 3 * * *")
  async handleDailyCleanup(): Promise<void> {
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
        }
      } catch (err) {
        // best-effort：跳过该目录，等下一轮。
        this.logger.debug(
          `FEAT-05: 跳过产物目录 ${entry}: ${err instanceof Error ? err.message : String(err)}`,
        );
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
