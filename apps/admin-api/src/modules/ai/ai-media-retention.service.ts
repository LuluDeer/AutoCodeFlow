import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { LessThan, Repository } from "typeorm";
import * as fs from "node:fs";
import * as path from "node:path";
import { AiMedia } from "./entities/ai-media.entity";
import { AiSopSession } from "./entities/ai-sop-session.entity";
import { getAiMediaRootDir } from "./ai-media.service";
import { LeaderGateService } from "../../common/leader-gate/leader-gate.service";

/**
 * 视频转 SOP 的**保留期清理**（推理质量轮）。
 *
 * ## 为什么必须有
 * 这条链路会持续沉淀两类数据，且都没有天然寿命：
 *   · `ai_media`：管理员上传的录屏，单文件可达 100MB，盘上按 `<uuid>/` 分目录；
 *   · `ai_sop_sessions`：会话消息全量落库（每轮都带视频清单与模型输出）。
 * 没有清理就是"上传一次、永久占盘 + 永久占表"，而这两类数据的价值都在
 * 交付 SOP 之后迅速衰减。
 *
 * ## 形态（对齐 AgentMediaRetentionService 的维护任务先例）
 * · 每日一次 `@Cron` + `LeaderGateService` 门禁（多实例不重复删）；
 * · 媒体**目录粒度**回收：`storedPath` 的首段就是 `<uuid>/`，整目录删 + 同批
 *    DB 行删（不留「下载 404」的僵尸行）；单条失败只记日志，绝不阻断其余；
 * · 会话按 `createdAt` 删行（消息里只有文本与 mediaId 引用，不占盘）；
 * · 保留期：`ai.mediaRetentionDays`（默认 7，与执行器媒体一致）、
 *   `ai.sessionRetentionDays`（默认 30——会话是"过程记录"，比素材值得多留几天）。
 *
 * ## 为什么按"创建时间"而不是"最后活动时间"
 * 会话可能在出稿后很久才被保存；按 `updatedAt` 清会把"刚保存的草稿对应的会话"
 * 提前删掉。素材与过程记录的寿命应从**产生**算起——这也是审计口径。
 */
@Injectable()
export class AiMediaRetentionService {
  private readonly logger = new Logger(AiMediaRetentionService.name);

  constructor(
    // ARCH-31 §5：多实例下 cron 维护任务仅 leader 执行（@Optional——单测直接
    // new 装配时 gate 缺席 → null → 门禁不生效，先例同 AgentMediaRetentionService）
    @Optional()
    private readonly leaderGate: LeaderGateService | null = null,
    @InjectRepository(AiMedia)
    private readonly mediaRepo: Repository<AiMedia>,
    @InjectRepository(AiSopSession)
    private readonly sessionRepo: Repository<AiSopSession>,
    private readonly config: ConfigService,
  ) {}

  private days(key: string, fallback: number): number {
    const raw = this.config.get<number>(`ai.${key}`);
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0
      ? raw
      : fallback;
  }

  @Cron("0 45 3 * * *")
  async handleDailyCleanup(): Promise<void> {
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    try {
      const media = await this.cleanupExpiredMedia();
      const sessions = await this.cleanupExpiredSessions();
      if (media.rows > 0 || sessions > 0) {
        this.logger.log(
          `AI retention: 媒体 ${media.rows} 条/${media.dirs} 目录、会话 ${sessions} 条`,
        );
      }
    } catch (err) {
      this.logger.error(
        `AI retention failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 清理过期媒体：先删目录再删行（幂等；单条失败不阻断）。 */
  async cleanupExpiredMedia(
    now: Date = new Date(),
  ): Promise<{ rows: number; dirs: number }> {
    const cutoff = new Date(
      now.getTime() - this.days("mediaRetentionDays", 7) * 86_400_000,
    );
    const rows = await this.mediaRepo.find({
      where: { createdAt: LessThan(cutoff) },
      take: 500,
    });
    if (rows.length === 0) return { rows: 0, dirs: 0 };

    const root = path.resolve(getAiMediaRootDir());
    let dirs = 0;
    const removable: string[] = [];

    for (const row of rows) {
      try {
        const dirName = path.dirname(row.storedPath);
        const abs = path.resolve(root, dirName);
        // 只删根内的目录（storedPath 由 service 生成，这里再兜一次）
        if (
          dirName === "." ||
          dirName.startsWith("..") ||
          !abs.startsWith(root + path.sep)
        ) {
          this.logger.warn(
            `AI retention: 跳过可疑路径 id=${row.id} storedPath=${row.storedPath}`,
          );
          removable.push(row.id);
          continue;
        }
        if (fs.existsSync(abs)) {
          fs.rmSync(abs, { recursive: true, force: true });
          dirs += 1;
        }
        removable.push(row.id);
      } catch (err) {
        // 磁盘异常：保留 DB 行，下一轮再试（宁可留僵尸行，也不留无主目录计数错）
        this.logger.warn(
          `AI retention: 删除目录失败 id=${row.id} — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (removable.length > 0) {
      await this.mediaRepo.delete(removable);
    }
    return { rows: removable.length, dirs };
  }

  /** 清理过期会话（只删行；消息里不存字节）。 */
  async cleanupExpiredSessions(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(
      now.getTime() - this.days("sessionRetentionDays", 30) * 86_400_000,
    );
    const res = await this.sessionRepo.delete({ createdAt: LessThan(cutoff) });
    return res.affected ?? 0;
  }
}
