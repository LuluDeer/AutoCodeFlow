import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, In, Repository } from "typeorm";
import * as fs from "fs";
import * as path from "path";
import { getArtifactRootDir } from "./artifacts.constants";
import { TaskExecution } from "../task/entities/task-execution.entity";
// ARTIFACTS-INDEX-46: 产物索引表（TTL 清理与 jsonb 清单列同批回收）。
import { ExecutionArtifactRow } from "./entities/execution-artifact.entity";
// ARCH-31 §5: cron 维护任务统一 Leader 门禁（@Optional——既有单测直接 new
// 装配时 gate 缺席 → null → 门禁不生效，先例同 TracingService）。
import { LeaderGateService } from "../../common/leader-gate/leader-gate.service";

/**
 * FEAT-05：执行产物 TTL 清理（搭车日志保留期策略）。
 *
 * 产物文件落在 `uploads/artifacts/<execId>/`。NETOPT-8⑦ 起磁盘与 DB 清单
 * **同步回收**：磁盘目录按 `LOG_RETENTION_DAYS`（configuration.logRetention.days，
 * 默认 30）删除「目录内最新文件 mtime 早于保留期」（A-10：此前取最旧 mtime，
 * 长执行的近期产物被连坐清除）的产物子目录后，同一批 execId 的
 * DB 清单列（task_executions.artifacts）同步置空——此前磁盘独立回收而清单列
 * 随执行行 90d 保留，30-90 天窗口内执行详情仍列产物但下载 404。
 *
 * best-effort：单目录清理失败只记日志跳过，绝不阻断其余目录，也不影响主流程；
 * DB 侧失败只 warn，不回滚已完成的磁盘回收（磁盘已回收是事实），但同一 chunk
 * 的两个 DB 写要么整批提交、要么整批不写，绝不半写。多实例并发删除幂等
 * （rm -rf 已删目录 no-op）。
 *
 * DL-1：同一 chunk 的「jsonb 清单列置空 + 索引行删除」放进**同一事务**。此前
 * 两个 try/catch 各自 best-effort、互不感知，而磁盘已 rm -rf（不可逆）——一侧
 * 成功一侧失败会留下「详情列产物但下载 404」/「索引已删但 jsonb 仍列」的长期
 * 不一致，且只 warn 没人看。现在任一侧失败 ⇒ 整 chunk 回滚 ⇒ 两个 DB 写同进
 * 同退，失败可见（warn 带 chunk 大小与首个 id，并说明 DB 未清、下轮重试）。
 * DL-2：产物根下的目录名在进 IN() 前必须过 uuid 形状校验——task_executions.id
 * 是 uuid 列，混入任何非 UUID 目录名都会让 PG 抛 22P02，整 chunk（最多 1000
 * 行）在磁盘已删后每晚永久失败。
 */

@Injectable()
export class ArtifactsRetentionService {
  private readonly logger = new Logger(ArtifactsRetentionService.name);

  /** NETOPT-8⑦: 清单置空 UPDATE 的分批 IN 大小（PG 绑定参数余量内） */
  private static readonly ARTIFACTS_DB_SWEEP_CHUNK = 1000;

  /**
   * DL-2: 目录名即 execId，能否进 IN() 取决于是否与 task_executions.id
   * （uuid 列）同形。非 UUID 形状的值会让 PG 在解析绑定参数时报 22P02
   * （invalid input syntax for type uuid），使整个 chunk 失败。
   */
  private static readonly UUID_SHAPE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    // ARTIFACTS-INDEX-46: 同批删除 execution_artifacts 索引行（与 jsonb 清单列
    // 双轨恒同宽）。@Optional 同上先例——缺失时仅清 jsonb（降级为旧行为）。
    @Optional()
    @InjectRepository(ExecutionArtifactRow)
    private readonly artifactIndexRepo: Repository<ExecutionArtifactRow> | null = null,
    // DL-1: 双轨两个写的同一事务载体（DataSource 由 TypeOrmModule.forRoot 全局
    // 提供，无需改模块）。@Optional 同 leaderGate 先例——既有单测直接 new 装配
    // 未提供时退化为「先删索引行、成功后再置空 jsonb」的降级顺序（见
    // sweepChunkDb），语义上同样是整 chunk 不半写。
    @Optional()
    private readonly dataSource: DataSource | null = null,
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
        // A-10: 过期判据用目录内**最新** mtime——此前取最旧 mtime，长执行
        // （运行数日，期间持续产出新产物）的目录因旧文件先行过期而被整目录
        // 连坐清除，近期产物一并丢失。最新 mtime 早于保留期 ⟺ 整目录在保留
        // 期内无任何更新，删除才安全。
        const newest = this.newestMtimeMs(dir);
        if (newest !== null && newest < cutoffMs) {
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

    // DL-2: 目录名即 execId，只有与 task_executions.id（uuid 列）同形的才能
    // 进 IN()。此前把 readdir 的原始目录名直接塞进 IN(chunk)：产物根下一旦出
    // 现非 UUID 子目录（手工目录/临时目录/历史遗留），PG 解析绑定参数即抛
    // 22P02，整个 chunk（最多 1000 行）在磁盘已删后每晚永久失败，只留一条 warn。
    const dbExecIds = removedExecIds.filter((id) =>
      ArtifactsRetentionService.UUID_SHAPE.test(id),
    );
    if (dbExecIds.length !== removedExecIds.length) {
      const skipped = removedExecIds.filter(
        (id) => !ArtifactsRetentionService.UUID_SHAPE.test(id),
      );
      // 磁盘已删是事实（rm -rf 不因形状校验回滚），故只跳过 DB 回收并留证。
      this.logger.warn(
        `FEAT-05: 产物根目录下 ${skipped.length} 个非 UUID 子目录已清盘但不参与 DB 清单回收（首个: ${skipped[0]}，目录名与 task_executions.id(uuid) 不同形）`,
      );
      // 差值显式入日志：删目录数 ≠ 参与 DB 清理数时，运维能立刻看出有多少目录
      // 只是清了盘、DB 清单仍未收口。
      this.logger.log(
        `FEAT-05: 本轮删目录 ${removed} 个，参与 DB 清单回收 ${dbExecIds.length} 个（差值 ${removed - dbExecIds.length} 个仅清盘）`,
      );
    }

    // NETOPT-8⑦: 磁盘清盘后同步清 DB 清单——修复 30（磁盘 TTL）-90（DB 行）
    // 天窗口内「详情仍列产物但下载 404」的两侧不一致。DB 侧整体 best-effort：
    // 失败只 warn，不回滚已完成的磁盘回收（磁盘已回收是事实），但同一 chunk
    // 的两个写必须同进同退（DL-1，见 sweepChunkDb），失败样本留给下一轮。
    if (dbExecIds.length === 0) return removed;
    if (!this.execRepo && !this.artifactIndexRepo) return removed;

    for (
      let i = 0;
      i < dbExecIds.length;
      i += ArtifactsRetentionService.ARTIFACTS_DB_SWEEP_CHUNK
    ) {
      const chunk = dbExecIds.slice(
        i,
        i + ArtifactsRetentionService.ARTIFACTS_DB_SWEEP_CHUNK,
      );
      // 返回值仅用于日志可读性（成功/失败已在方法内 warn），此处不中断后续
      // chunk——每个 chunk 相互独立，一批失败不该连坐其余批。
      await this.sweepChunkDb(chunk);
    }

    return removed;
  }

  /**
   * DL-1: 同一 chunk 的「jsonb 清单列置空 + 索引行删除」同进同退。
   *
   * 为什么必须在一个事务里：磁盘目录此时已经 rm -rf（不可逆），两个 DB 写若
   * 各自 best-effort，一侧成功一侧失败就会留下「详情页列产物但下载 404」
   * 或「索引已删但 jsonb 仍列」的长期不一致，且旧实现只 warn 无人察觉。
   *
   * 失败语义：整 chunk 回滚 ⇒ 两个写都不生效 ⇒ DB 未清，warn 明说「下轮重试」
   * 并带 chunk 大小与首个 id（warn 级别 + 这两个字段是本条失败唯一的运维可见
   * 抓手）。注意：chunk 的 execId 来自本轮刚删掉的目录，若下轮目录已不在，
   * 这些 execId 不会再被枚举到——真正兜底的是执行行 90d retention（级联删索引
   * 行）。故这里不做「自动重试」的过度承诺，只保证 DB 两侧同进同退且失败可见。
   *
   * 降级（无 DataSource 的既有单测装配）：先删索引行，成功后再置空 jsonb，
   * 任一步失败即整 chunk 跳过（不写另一侧），用顺序换取「不半写」。
   */
  private async sweepChunkDb(chunk: string[]): Promise<boolean> {
    const first = chunk[0];
    if (this.dataSource && this.execRepo && this.artifactIndexRepo) {
      try {
        await this.dataSource.transaction(async (m) => {
          // adr-026-exempt: 只清 artifacts 这一个**清单列**（磁盘已回收后的登记清理），
          // 且只作用于「已被保留期判定过期并删目录」的执行行——90 天前的终态执行不再有新产物
          // 上传（上传要求执行仍在跑），故不存在与写者竞争的现实窗口。
          await m.update(TaskExecution, { id: In(chunk) }, { artifacts: null });
          // ARTIFACTS-INDEX-46: 索引表同批回收（双轨恒同宽——jsonb 置空的同一批
          // execId 的关系化行一并删除，否则 GET /artifacts 会列出已无文件的幽灵
          // 产物）。与上面的 UPDATE 同事务：任一侧失败整批回滚。
          await m.delete(ExecutionArtifactRow, { executionId: In(chunk) });
        });
        return true;
      } catch (err) {
        this.logger.warn(
          `DL-1: 清空产物清单列/索引行的事务失败，整 chunk 已回滚、DB 未清，下轮重试（chunk=${chunk.length}, first=${first}）: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return false;
      }
    }

    // 降级路径顺序钉死：先删索引行（GET /artifacts 读面先收敛，不再列幽灵
    // 产物），成功后再置空 jsonb；任一步失败即不推进，另一侧保持原样。
    if (this.artifactIndexRepo) {
      try {
        await this.artifactIndexRepo.delete({ executionId: In(chunk) });
      } catch (err) {
        this.logger.warn(
          `ARTIFACTS-INDEX-46: 删除产物索引行失败，本 chunk 已跳过、DB 未清，下轮重试（chunk=${chunk.length}, first=${first}）: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return false;
      }
    }
    if (this.execRepo) {
      try {
        await this.execRepo.update({ id: In(chunk) }, { artifacts: null });
      } catch (err) {
        this.logger.warn(
          `FEAT-05: 清空产物清单列失败，本 chunk 已跳过、DB 未清，下轮重试（chunk=${chunk.length}, first=${first}）: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return false;
      }
    }
    return true;
  }

  /**
   * A-10: 目录内最新文件 mtime（毫秒）；空目录/不可读回退目录自身 mtime。
   * 判据语义：目录内最近一次产物落盘时间早于保留期才过期——新旧产物混合的
   * 目录因新产物而整体保留（此前取最旧 mtime 会把近期产物连坐清除）。
   */
  private newestMtimeMs(dir: string): number | null {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return null;
    let newest = st.mtimeMs;
    for (const f of fs.readdirSync(dir)) {
      const fst = fs.statSync(path.join(dir, f));
      if (fst.mtimeMs > newest) newest = fst.mtimeMs;
    }
    return newest;
  }
}
