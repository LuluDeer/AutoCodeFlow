import { Injectable, Logger, Optional } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository, LessThan, In } from "typeorm";
import { Cron } from "@nestjs/schedule";
import { AuditLog } from "./entities/audit-log.entity";
// ARCH-31 §5: cron 维护任务统一 Leader 门禁（@Optional——既有单测直接 new
// 装配时 gate 缺席 → null → 门禁不生效，先例同 TracingService）。
import { LeaderGateService } from "../../common/leader-gate/leader-gate.service";
// NETOPT-8④: 分批 DELETE 循环的轮数/墙钟双闸（LOG-RETENTION-01 回移植）
import { cappedBatchedDelete } from "../../common/utils/capped-batched-delete.util";

/**
 * SEC-10: append-only 语义开关——迁移 1790000000006 给 audit_logs 加了
 * BEFORE UPDATE OR DELETE 触发器（RAISE EXCEPTION）。retention 清理
 * （cleanupOldAuditLogs）是唯一的合法批量 DELETE：放行机制 = 事务内
 * `SET LOCAL app.bypass_audit_guard = 'on'`（触发器读会话 GUC 放行，
 * 事务提交即失效）。绕过面收敛为：能直连 DB 且显式开启该 GUC 的进程；
 * 应用代码中唯一放行点就是本服务的清理任务。
 */
const AUDIT_GUARD_BYPASS_SQL = `SET LOCAL app.bypass_audit_guard = 'on'`;

/** NETOPT-1②: retention 分批大小（对齐 executor.service R-09 metrics 模式）。 */
const AUDIT_RETENTION_BATCH_SIZE = 5000;

/**
 * API-09（本轮体验审查）：把用户输入安全地放进 **ILIKE 模式串**。
 *
 * 两个问题一起修：
 *
 * ① **LIKE 元字符未转义**（真实缺陷）。`username` 过滤此前直接拼
 *    `` `%${input}%` ``。而 ILIKE 里 `%` 是"任意字符"、`_` 是"任意单字符"
 *    ——运维搜一个真的含下划线的用户名（如 `zhang_san`）时，输入里那个 `_`
 *    会被当成通配符，**匹配到 `zhangXsan` 这类无关账号**；搜 `%` 则匹配全部。
 *    结果集看起来"能用"，只是多了些不该有的行——用户很难察觉，会据此得出
 *    错误的审计结论（"这个账号在这次操作里出现过"）。转义后 `%`/`_` 才表示
 *    字面量，符合用户在搜索框里的直觉。
 *
 * ② **`action` 的白名单过严**（体验缺陷）。原实现要求 `^[a-zA-Z0-9_.\-\s]+$`，
 *    否则 400 "Invalid action parameter"。但注入风险早已由**绑定参数**消除
 *    （值从不拼进 SQL），该白名单只剩副作用：用户输入中文、`:`、`/`
 *    （如想按 `task.updateGlue` 之外的自然描述搜）直接吃 400，看到的是英文
 *    技术报错而非"没有匹配"。故放宽为"仅限制长度"，并靠转义保证字面量语义。
 *
 * `escapeLikePattern` 用反斜杠转义 `\` `%` `_`；PG 的 LIKE 默认以 `\` 为
 * 转义字符，故无需额外 ESCAPE 子句。反斜杠必须**先**转义（否则会把后面刚加
 * 的转义符再转一次）。
 */
export function escapeLikePattern(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&");
}

export interface AuditLogPayload {
  userId?: number;
  username?: string;
  action: string;
  resource?: string;
  resourceId?: string;
  detail?: Record<string, any>;
  ip?: string;
  result?: "success" | "failure";
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly repo: Repository<AuditLog>,
    private readonly dataSource: DataSource,
    // ARCH-31 §5: 多实例下 @Cron 维护任务仅 cron Leader 执行（@Global 恒提供）。
    @Optional()
    private readonly leaderGate: LeaderGateService | null = null,
  ) {}

  /**
   * SEC-10: the only sanctioned bulk-DELETE path for audit rows (Q7
   * retention). Runs inside a transaction with the session GUC
   * `app.bypass_audit_guard = 'on'` so the append-only trigger
   * (migration 1790000000006) lets the rows go; everything else —
   * UPDATE/DELETE from any other path — hits the trigger's exception.
   *
   * NETOPT-1②: 原实现是**单个** bypass 事务包一条无界 DELETE——峰值行数下
   * 是长事务（锁表 + WAL 风暴）。改分批：每批先取一批 victim id，再在
   * **各自的** bypass 事务内按 id 删除（放行语义不变，仍只有本路径能删）；
   * 单批不足批大小即停。批大小对齐 executor.service R-09 metrics 模式。
   * NETOPT-8④: 循环收口改走公共 cappedBatchedDelete——LOG-RETENTION-01
   * 轮数/墙钟双闸（affected 恒返满批时旧 `do..while` 永不终止，已实测 OOM）。
   */
  private async retentionDelete(cutoff: Date): Promise<number> {
    return cappedBatchedDelete({
      batchSize: AUDIT_RETENTION_BATCH_SIZE,
      logLabel: "Q7 audit",
      logger: this.logger,
      executeBatch: () =>
        this.dataSource.transaction(async (em) => {
          await em.query(AUDIT_GUARD_BYPASS_SQL);
          const auditRepo = em.getRepository(AuditLog);
          const victims = await auditRepo.find({
            select: ["id"],
            where: { createdAt: LessThan(cutoff) },
            order: { id: "ASC" },
            take: AUDIT_RETENTION_BATCH_SIZE,
          });
          if (victims.length === 0) return 0;
          const result = await auditRepo.delete({
            id: In(victims.map((v) => v.id)),
          });
          return result.affected ?? 0;
        }),
    });
  }

  async log(payload: AuditLogPayload): Promise<void> {
    const entry = this.repo.create({
      ...payload,
      result: payload.result ?? "success",
    });
    await this.repo.save(entry);
  }

  /** Q7: Daily at 2:05am, clean up audit logs older than 180 days */
  @Cron("0 5 2 * * *")
  async cleanupOldAuditLogs(): Promise<void> {
    // ARCH-31 §5: 多实例下仅 cron Leader 执行（详见 LeaderGateService）
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    const oneEightyDaysAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
    // SEC-10: 走 bypass 事务（append-only 触发器唯一放行点），替代原
    // 直连 repo.delete（迁移 1790000000006 后会被触发器拒绝）。
    const affected = await this.retentionDelete(oneEightyDaysAgo);
    if (affected > 0) {
      // Log the cleanup itself — but don't create an audit log entry to avoid recursion
      this.logger.log(
        `Q7 Cleanup: removed ${affected} audit logs older than 180 days`,
      );
    }
  }

  /**
   * Export audit logs as CSV.
   * Applies the same filters as findAll but streams all matching rows (no pagination cap).
   * Returns a CSV string with headers.
   */
  async exportCsv(options: {
    action?: string;
    resource?: string;
    resourceId?: string;
    username?: string;
    startTime?: string;
    endTime?: string;
    userId?: number;
  }): Promise<string> {
    const { action, resource, userId } = options;
    const qb = this.repo
      .createQueryBuilder("log")
      .orderBy("log.createdAt", "DESC");

    if (action) {
      // API-09：放宽原来的 `^[a-zA-Z0-9_.\-\s]+$` 白名单（那会让中文 / `:` / `/`
      // 等合法搜索直接吃 400，而注入风险早已由绑定参数消除），改为只限长度 +
      // 转义 LIKE 元字符。见 escapeLikePattern 注释。
      const sanitizedAction = action.trim().slice(0, 100);
      qb.andWhere("log.action ILIKE :action", {
        action: `%${escapeLikePattern(sanitizedAction)}%`,
      });
    }
    if (resource) qb.andWhere("log.resource = :resource", { resource });
    // AUTH-05: exact match on the identifier column — the DTO field is a
    // plain string, but a bound-parameter cap keeps oversized query-string
    // needles from reaching PG at all.
    if (options.resourceId) {
      qb.andWhere("log.resourceId = :resourceId", {
        resourceId: options.resourceId.slice(0, 100),
      });
    }
    if (userId) qb.andWhere("log.userId = :userId", { userId });
    this.applyExtraFilters(qb, options);

    // Cap export at 10 000 rows; select raw columns only to avoid loading
    // entities and the heavy jsonb `detail` column into memory
    const rows = await qb
      .select("log.id", "id")
      .addSelect("log.userId", "userId")
      .addSelect("log.username", "username")
      .addSelect("log.action", "action")
      .addSelect("log.resource", "resource")
      .addSelect("log.resourceId", "resourceId")
      .addSelect("log.result", "result")
      .addSelect("log.ip", "ip")
      .addSelect("log.createdAt", "createdAt")
      .limit(10_000)
      .getRawMany();

    // S8: CSV formula injection. Spreadsheet apps (Excel, LibreOffice,
    // Google Sheets) interpret cells whose text starts with = + - @ (and
    // tab/CR variants) as formulas when a CSV is opened, so a value like
    // `=HYPERLINK(...)` recorded in an audit field would execute on export
    // open. Defense per OWASP "CSV Injection": prefix such cells with a
    // single quote, which is the only mitigation that is honored safely by
    // both Excel and Google Sheets (a leading apostrophe is rendered as
    // literal text and is not itself displayed). The quote is applied
    // BEFORE RFC 4180 quoting so commas/quotes/newlines still escape
    // correctly on top of it.
    const FORMULA_CHARS = /^[=+\-@\t\r]/;
    const escape = (v: unknown) => {
      if (v === null || v === undefined) return "";
      let s = String(v);
      if (FORMULA_CHARS.test(s)) {
        s = `'${s}`;
      }
      if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const header =
      "id,userId,username,action,resource,resourceId,result,ip,createdAt";
    const lines = rows.map((r) =>
      [
        r.id,
        r.userId ?? "",
        r.username ?? "",
        r.action,
        r.resource ?? "",
        r.resourceId ?? "",
        r.result ?? "",
        r.ip ?? "",
        r.createdAt?.toISOString() ?? "",
      ]
        .map(escape)
        .join(","),
    );
    return [header, ...lines].join("\n");
  }

  async findAll(options: {
    page?: number;
    pageSize?: number;
    action?: string;
    resource?: string;
    resourceId?: string;
    username?: string;
    startTime?: string;
    endTime?: string;
    userId?: number;
  }): Promise<{ data: AuditLog[]; total: number }> {
    const { page = 1, pageSize = 20, action, resource, userId } = options;
    const qb = this.repo
      .createQueryBuilder("log")
      .orderBy("log.createdAt", "DESC");

    // API-09（本轮体验审查）：放宽 SEC-03 的白名单。
    //
    // 原实现要求 `^[a-zA-Z0-9_.\-\s]+$`，否则 400。但：
    //   · 注入风险早已由**绑定参数**消除（值从不拼进 SQL，`ILIKE :action`），
    //     该白名单对安全没有增量；
    //   · 它只剩副作用——用户输入中文、`:`、`/` 这类**完全正常**的搜索词会吃
    //     400 + 英文技术报错，而用户期待的是"没有匹配"或结果列表。
    //
    // 改为只限长度（防 DoS），并转义 LIKE 元字符保证 `%`/`_` 按字面量匹配。
    // 与 exportCsv 的同款判断逐条对齐（R4 P1-2 要求两条路径同一过滤集）。
    if (action) {
      const sanitizedAction = action.trim().slice(0, 100);
      qb.andWhere("log.action ILIKE :action", {
        action: `%${escapeLikePattern(sanitizedAction)}%`,
      });
    }

    if (resource) qb.andWhere("log.resource = :resource", { resource });
    // AUTH-05: exact match, same bound-parameter cap as exportCsv — both
    // paths honour the identical filter set (R4 P1-2 parity).
    if (options.resourceId) {
      qb.andWhere("log.resourceId = :resourceId", {
        resourceId: options.resourceId.slice(0, 100),
      });
    }
    if (userId) qb.andWhere("log.userId = :userId", { userId });
    this.applyExtraFilters(qb, options);
    // Q12: cap pageSize to prevent full-table scans regardless of caller input
    const safePageSize = Math.min(pageSize, 100);
    const [data, total] = await qb
      .skip((page - 1) * safePageSize)
      .take(safePageSize)
      .getManyAndCount();
    return { data, total };
  }

  /**
   * R4 P1-2: shared username / time-range filters, used by both findAll and
   * exportCsv so the CSV export honours the same filter set as the list page.
   * All values are bound as query parameters (no string interpolation).
   */
  private applyExtraFilters(
    qb: import("typeorm").SelectQueryBuilder<AuditLog>,
    options: { username?: string; startTime?: string; endTime?: string },
  ): void {
    if (options.username) {
      // API-09：转义 LIKE 元字符，使 `_` / `%` 按字面量匹配（见
      // escapeLikePattern 的注释——未转义时搜 `zhang_san` 会命中 `zhangXsan`）。
      qb.andWhere("log.username ILIKE :username", {
        username: `%${escapeLikePattern(options.username.slice(0, 100))}%`,
      });
    }
    if (options.startTime) {
      qb.andWhere("log.createdAt >= :startTime", {
        startTime: new Date(options.startTime),
      });
    }
    if (options.endTime) {
      qb.andWhere("log.createdAt <= :endTime", {
        endTime: new Date(options.endTime),
      });
    }
  }
}
