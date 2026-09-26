import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { existsSync, readdirSync, statSync } from "fs";
import * as fs from "fs";
import * as path from "path";
import { Repository } from "typeorm";

import { AgentMedia } from "./entities/agent-media.entity";
import { getAgentMediaRootDir } from "./sop-media.service";
// ARCH-31 §5: cron 维护任务统一 Leader 门禁（@Optional——既有单测直接 new
// 装配时 gate 缺席 → null → 门禁不生效，先例同 ArtifactsRetentionService）。
import { LeaderGateService } from "../../common/leader-gate/leader-gate.service";

/**
 * P7b 残差补齐：Agent 媒体 TTL 清理。
 *
 * ## 为什么必须有
 * 媒体回传（截图/录屏）单文件可达 100MB，sop-media 的头注写着「assignmentId
 * 分层让 30 天保留清理按目录整删」——但清理服务从未落地，媒体随指派无限
 * 累积。roadmap §11 的决策是「媒体存储 + 7 天保留」，本服务兑现它。
 *
 * ## 形态（对齐 ArtifactsRetentionService 的维护任务先例）
 * · 每日一次 @Cron + LeaderGateService 门禁（多实例不重复删）；
 * · 目录粒度回收：`<assignmentId>/` 内最旧文件 mtime 早于保留期 → 整目录
 *   删除 + 同 assignmentId 的 DB 行删除（磁盘与清单同步，不留「下载 404」
 *   的僵尸行）；
 * · best-effort：单目录失败只记日志跳过，绝不阻断其余目录；删除幂等。
 * · 保留期：`AGENT_MEDIA_RETENTION_DAYS`（默认 7，roadmap §11 决策值；
 *   ARCH-27——运行时读取经 ConfigService，键在 app.module Joi 注册）。
 */
@Injectable()
export class AgentMediaRetentionService {
  private readonly logger = new Logger(AgentMediaRetentionService.name);

  constructor(
    // ARCH-31 §5: 多实例下 @Cron 维护任务仅 cron Leader 执行
    @Optional()
    private readonly leaderGate: LeaderGateService | null = null,
    @InjectRepository(AgentMedia)
    private readonly mediaRepo: Repository<AgentMedia>,
    private readonly config: ConfigService,
  ) {}

  private resolveRetentionDays(): number {
    const raw = this.config.get<string | number>("AGENT_MEDIA_RETENTION_DAYS");
    if (raw === undefined || raw === null || raw === "") return 7;
    const n = typeof raw === "number" ? raw : parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 7;
  }

  @Cron("0 15 3 * * *")
  async handleDailyCleanup(): Promise<void> {
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    try {
      const removed = await this.cleanupExpiredMedia();
      if (removed > 0) {
        this.logger.log(
          `Agent media retention: 清理 ${removed} 个过期指派媒体目录`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Agent media retention failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 返回被删除的指派媒体目录数。now 可注入以便测试。 */
  async cleanupExpiredMedia(now: Date = new Date()): Promise<number> {
    const root = getAgentMediaRootDir();
    if (!existsSync(root)) return 0;
    const cutoffMs = now.getTime() - this.resolveRetentionDays() * 86_400_000;

    let removed = 0;
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch (err) {
      this.logger.warn(
        `无法读取媒体根目录: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }

    for (const entry of entries) {
      const dir = path.join(root, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
        const oldest = this.oldestMtimeMs(dir);
        if (oldest !== null && oldest < cutoffMs) {
          await fs.promises.rm(dir, { recursive: true, force: true });
          // 磁盘已回收 → DB 行同步删（目录名即 assignmentId 的分层结构）
          await this.mediaRepo.delete({ assignmentId: entry });
          removed++;
        }
      } catch (err) {
        // best-effort：跳过该目录，等下一轮
        this.logger.debug(
          `跳过媒体目录 ${entry}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return removed;
  }

  /** 目录内最旧文件 mtime（毫秒）；空目录/不可读回退目录自身 mtime。 */
  private oldestMtimeMs(dir: string): number | null {
    const st = statSync(dir);
    if (!st.isDirectory()) return null;
    let oldest = st.mtimeMs;
    for (const f of readdirSync(dir)) {
      const fst = statSync(path.join(dir, f));
      if (fst.mtimeMs < oldest) oldest = fst.mtimeMs;
    }
    return oldest;
  }
}
