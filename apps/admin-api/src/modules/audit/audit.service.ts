import { Injectable, Logger, Optional } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository, LessThan, In } from "typeorm";
import { Cron } from "@nestjs/schedule";
import { AuditLog } from "./entities/audit-log.entity";
// ARCH-31 §5: cron 维护任务统一 Leader 门禁（@Optional——既有单测直接 new
// 装配时 gate 缺席 → null → 门禁不生效，先例同 TracingService）。
import { LeaderGateService } from "../../common/leader-gate/leader-gate.service";
// rt-5（CRON-GUARD）：@Cron 方法体的顶层异常闸（全仓唯一实现）
import { guardedCron } from "../../common/utils/cron-guard.util";
// NETOPT-8④: 分批 DELETE 循环的轮数/墙钟双闸（LOG-RETENTION-01 回移植）
import { cappedBatchedDelete } from "../../common/utils/capped-batched-delete.util";
// §2.1 keyset 游标：`audit_logs.id` 是 integer（**不是** uuid），故用整型游标
// 解码器——前半段（base64url / ISO 时间 + 日历回读）与 uuid 版**共用同一份**
// 实现（splitCursorPayload），只有 id 判据不同。
import {
  decodeNumericKeysetCursor,
  nextNumericKeysetCursor,
} from "../../common/utils/keyset-cursor.util";

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

/** A-9: CSV 导出行上限（达上限即追加截断注释行，保持「有痕截断」）。 */
const AUDIT_EXPORT_ROW_CAP = 10_000;

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

/**
 * 审计域的**过滤条件集合**（不含分页参数）。
 *
 * 抽成具名类型而不是在三处各写一遍内联字面量：`findAll` / `exportCsv` /
 * `findAllByKeyset` 的入参必须**结构完全一致**，否则"CSV 与列表同滤"这条
 * 承诺在类型层面就无法被 `tsc` 守住（少一个字段只会静默不过滤）。
 */
export interface AuditFilterOptions {
  action?: string;
  resource?: string;
  resourceId?: string;
  username?: string;
  startTime?: string;
  endTime?: string;
  userId?: number;
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
            select: { id: true },
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

  /**
   * Q7: Daily at 2:05am, clean up audit logs older than 180 days
   *
   * rt-5（CRON-GUARD）：**顶层异常闸**。cron 回调不 await 返回的 Promise，
   * 方法体裸奔时一次瞬态 DB 错误（bypass 事务里 SET LOCAL / 分批 DELETE 任一
   * 次 reject）即 unhandledRejection → main.ts 的 gracefulFatalShutdown →
   * 整实例 exit(1)。异常改由 guardedCron 兜住（warn + 下一拍重试，retention
   * 幂等）。**就地闭包而不抽 Body 方法**：audit-append-only.spec 用
   * `Object.getOwnPropertyNames(AuditService.prototype)` 断言「公开方法面 =
   * { log, findAll, exportCsv, cleanupOldAuditLogs }，无其他写删入口」——
   * 抽出新原型方法会迫使那条 SEC-10 断言放宽白名单，等于为了修 cron 闸去
   * 削弱一条更贵的守卫。
   */
  @Cron("0 5 2 * * *")
  async cleanupOldAuditLogs(): Promise<void> {
    await guardedCron("audit.cleanupOldAuditLogs", this.logger, async () => {
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
    });
  }

  /**
   * Export audit logs as CSV.
   * Applies the same filters as findAll but streams all matching rows (no pagination cap).
   * Returns a CSV string with headers.
   */
  async exportCsv(options: AuditFilterOptions): Promise<string> {
    const qb = this.repo
      .createQueryBuilder("log")
      // A-8: 同事务批量写的时间戳常碰撞（PG 默认微秒精度下同批行同值），
      // 仅按 createdAt 排序翻页会重复/丢行——补 id 次级键保证全序（findAll 同改）。
      .orderBy("log.createdAt", "DESC")
      .addOrderBy("log.id", "DESC");

    // §2.1（审计域收口）：过滤条件**全部**经这一个方法下发。
    // 改造前这里在本方法内联了 action/resource/resourceId/userId 四条谓词，
    // findAll 里**又抄了一遍同样四条**（只有后四条走 applyExtraFilters）——
    // 见 applyAuditFilters 的头注（那是 R4 P1-2 "两条路径同一过滤集" 承诺的
    // 真实漏点：改一处忘另一处不会被任何断言发现）。
    this.applyAuditFilters(qb, options);

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
      .limit(AUDIT_EXPORT_ROW_CAP)
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
    // A-9: 达到行上限时在导出末尾追加注释行——「no pagination cap」的承诺
    // 以「有痕截断」兑现：打开 CSV 的运维能看见截断发生，而不是把 10 000 行
    // 误当全量。`#` 前缀不在 S8 公式字符集内，表格软件按文本/注释处理。
    const truncatedMarker =
      rows.length >= AUDIT_EXPORT_ROW_CAP
        ? [`# truncated at ${AUDIT_EXPORT_ROW_CAP} rows`]
        : [];
    return [header, ...lines, ...truncatedMarker].join("\n");
  }

  async findAll(
    options: AuditFilterOptions & {
      page?: number;
      pageSize?: number;
      /**
       * §2.1：**可选**不透明游标。语义与 task 域三个端点逐条一致：
       * 省略 → OFFSET 分支（响应**逐字节不变**，连 `nextCursor` 这个键都不出现）；
       * 传入（含空串，表示 keyset 起点）→ keyset 分支并**追加** `nextCursor`。
       */
      cursor?: string;
    },
  ): Promise<{ data: AuditLog[]; total: number; nextCursor?: string | null }> {
    // §2.1：不带 cursor 时下面一行都不执行，旧路径**逐字节不变**。
    if (options.cursor !== undefined && options.cursor !== null) {
      return this.findAllByKeyset(options, options.cursor);
    }

    const { page = 1, pageSize = 20 } = options;
    const qb = this.repo
      .createQueryBuilder("log")
      // A-8: createdAt 同值碰撞（同事务批量写）下仅按时间排序会让翻页重复/
      // 丢行——补 id 次级键保证确定性全序（exportCsv 同改）。
      .orderBy("log.createdAt", "DESC")
      .addOrderBy("log.id", "DESC");

    // 过滤条件：与 exportCsv / keyset 分支**共用同一份**装配（见 applyAuditFilters）。
    this.applyAuditFilters(qb, options);

    // Q12: cap pageSize to prevent full-table scans regardless of caller input
    const safePageSize = Math.min(pageSize, 100);
    const [data, total] = await qb
      .skip((page - 1) * safePageSize)
      .take(safePageSize)
      .getManyAndCount();
    return { data, total };
  }

  /**
   * R67-A1：GET /audit/actions 的数据源——**去重后的 action 列表**。
   *
   * 解决的问题不是"能不能筛"，而是"**筛得到吗**"：审计动作已有 61 个（19 个域），
   * 页面上的 action 过滤器长期是自由文本输入框，用户必须**先知道**动作名（还得分
   * 大小写/点号写法）才能筛。能筛，但只有把名字背下来的管理员能用。
   *
   * ## 为什么是 DB 侧 DISTINCT，而不是把行拉回来再 new Set()
   *
   * audit_logs 是**只增表**（180 天 retention 之外不删），量级与部署时长成正比。
   * 取 distinct 的朴素写法（find 全表 → Set）会把整张表连同 jsonb 的 detail 列搬进
   * 内存，只为了取几十个字符串——既是 O(表) 内存，也是把 DB 往网络里倒灌。
   * 故 DISTINCT 与 ORDER BY **都下推到 SQL**，返回值只有"动作种数"那么几行。
   *
   * ## 成本与索引现状（先查实体/迁移，不靠猜）
   *
   * 本表**已有** action 索引，本端点无需新迁移：
   *   · idx_audit_logs_action（单列 action，迁移 1717473142683-AddPerformanceIndexes）；
   *   · idx_audit_logs_action_created_at（action + createdAt 复合索引，迁移
   *     1790000000022，为「按 action 过滤 + createdAt DESC 排序」而建，见实体 @Index）。
   *
   * 所以 SELECT DISTINCT action FROM audit_logs ORDER BY action 可以走
   * **index-only scan**（只读索引页、不回表），再对已按 action 排好序的索引输出做
   * Unique/Group：成本约 O(action 索引大小)，与表行宽（detail jsonb、ip 等）无关；
   * 排序也由索引顺序免费获得，不需要额外 Sort 节点。
   *
   * 但仍要正视：它**是**一次全索引扫描，不是 O(1)。故本方法只被 GET /audit/actions
   * 消费（页面首屏一次），**绝不**进列表查询路径；若要再压成本，正确方向是给该端点
   * 加短 TTL 缓存（动作集合变化极慢），而不是把它塞进 findAll。
   *
   * ## 顺序与形状
   *
   * 按 action 字母序返回（下拉直接照序渲染，前端不用再排）；非字符串/空串行被丢弃
   * ——action 列在实体上是 NOT NULL，但历史数据与手工修库不能假设干净，一个 null
   * 混进下拉会让前端选项渲染直接崩掉。响应形状见 AuditActionsDto（{ actions }）。
   */
  async listDistinctActions(): Promise<string[]> {
    const rows = await this.repo
      .createQueryBuilder("log")
      .select("log.action", "action")
      // DISTINCT 下推（PG: SELECT DISTINCT）——不是 JS 侧去重，见方法头注。
      .distinct(true)
      // 排序键与 select 列同源：PG 对 SELECT DISTINCT 要求 ORDER BY 表达式出现在
      // select 列表里，而 log.action 正是被 select 的那一列，故合法。
      .orderBy("log.action", "ASC")
      .getRawMany<{ action: string | null }>();

    return rows
      .map((row) => row.action)
      .filter(
        (action): action is string =>
          typeof action === "string" && action.length > 0,
      );
  }

  /**
   * §2.1（推广到 `GET /audit`）keyset 分支：`(createdAt, id)` 行值比较翻页。
   *
   * ## 为什么与 task 域三个端点用**完全一样**的谓词
   *
   * 唯一差别是 `audit_logs.id` 的类型。已实测（真 PG，`information_schema`）：
   *
   *     audit_logs."createdAt"        timestamp without time zone, precision 6
   *     audit_logs.id                 integer（`nextval('audit_logs_id_seq')`）
   *
   * 时间列与 `task_executions."createdAt"` **逐字段相同**（都是微秒精度），故那套
   * "毫秒半开区间会漏行"的论证对本表逐字成立；唯一需要换的是 id 的判据
   * （`decodeNumericKeysetCursor`，见其注释）。
   *
   * 实测佐证（本机 autoflow_test，同毫秒 4 行、id 与微秒**反序**、取 id=3 那一行
   * 做游标）：
   *   行值比较 `(createdAt, id) < (SELECT c."createdAt", c.id ...)` → `[4]` ✅
   *   毫秒半开区间                                                → `[1, 2]` ❌
   * 即半开区间既**漏掉** 4（时间上在游标之后，但 id 4 > 3 被判"不满足"），又
   * **返回了** 1、2（游标之前的行，翻页原地打转）。构造见
   * `audit-keyset-pagination.spec.ts` 的"id 与微秒反序"用例。
   *
   * ## 与 OFFSET 分支唯一的有意差异
   *
   * `pageSize` **不**在这里再 `Math.min(…, 100)` 一次：`applyAuditFilters` 不含
   * 分页，`safePageSize` 是 OFFSET 分支的局部量。这里改用同一套上限（见下），
   * 保证两条路径对 `pageSize=9999` 给出同样大的页。
   */
  private async findAllByKeyset(
    options: AuditFilterOptions & { pageSize?: number },
    rawCursor: string,
  ): Promise<{ data: AuditLog[]; total: number; nextCursor: string | null }> {
    // 空串 = 调用方显式声明的 keyset 起点（与 task 域三端点同款约定）；
    // 非空则必须是合法游标，否则 400 —— 绝不降级到 OFFSET 分支（那会造成
    // "带着坏游标反复拿回第 1 页、每次都是 200"的翻页死循环）。
    const cursor =
      rawCursor === "" ? null : decodeNumericKeysetCursor(rawCursor);

    const safePageSize = Math.min(options.pageSize ?? 20, 100);

    const qb = this.repo
      .createQueryBuilder("log")
      // 排序键与游标元组必须同源（createdAt DESC, id DESC），否则"继续"的
      // 起点与结果集排序不符，翻页会漏/重。
      .orderBy("log.createdAt", "DESC")
      .addOrderBy("log.id", "DESC");

    // 过滤条件：与 OFFSET / exportCsv 共用同一份装配（单份真值源，杜绝漂移）。
    this.applyAuditFilters(qb, options);

    if (cursor) {
      // 元组游标——**行值比较**，游标那一行的精确 (createdAt, id) 由子查询按
      // 主键从库里取回（含微秒）。论证见 task.service.getExecutionsByKeyset 头注；
      // 本表的实测结论见本方法头注。
      //
      // 子查询里的 `$1` 是**字符串**，由 PG 按 `integer` 解析（`'42'::integer`
      // 合法）；这是刻意的——载荷保持字符串可容纳超过 2^53 的序列值而不丢精度
      // （见 decodeNumericKeysetCursor）。
      //
      // 游标行被并发删除时：子查询无行 → 行值比较得 NULL → WHERE 为假 → 本页为
      // 空（调用方看到 `nextCursor: null` 即视为翻完）。这是**安全地提前结束**，
      // 不会错行/重复。审计日志虽为 append-only，但 180 天 retention 会真删行。
      qb.andWhere(
        `(log."createdAt", log.id) < (
           SELECT c."createdAt", c.id FROM audit_logs c WHERE c.id = :cursorId
         )`,
        { cursorId: cursor.id },
      );
    }

    // 多取一行：用"有没有第 N+1 行"判断 hasMore，避免额外的 exists 查询。
    qb.take(safePageSize + 1);

    // total 用独立的 COUNT（同过滤条件、**不含**游标下界）——语义与 OFFSET 分支
    // 的 `getManyAndCount` 返回值一致：真实总数，不是"剩余条数"、也不是 -1。
    // 两次查询**顺序**执行（不 Promise.all 同一个 qb）：getCount 会改写
    // expressionMap.queryEntity，与并发的 getMany 抢同一个可变对象不安全。
    const rows = await qb.getMany();
    const total = await qb.getCount();

    const hasMore = rows.length > safePageSize;
    const data = hasMore ? rows.slice(0, safePageSize) : rows;
    return {
      data,
      total,
      // 还有下一页 → 用本页最后一行编游标；否则显式 null（末页标记）。
      // 注意 `null` 与"键不出现"是两种语义：keyset 分支的末页必须**出现**该键。
      nextCursor: hasMore ? nextNumericKeysetCursor(data) : null,
    };
  }

  /**
   * 审计域过滤条件的**唯一真值源**：`findAll`（OFFSET）、`findAllByKeyset`、
   * `exportCsv` 三条路径全部经此装配。
   *
   * ## 为什么必须收成一份（本轮发现的真实漂移源）
   *
   * 改造前的形态是**两处各写一份**：
   *   · `findAll` 内联 action / resource / resourceId / userId 四条谓词；
   *   · `exportCsv` 内联**同样四条**（逐字复制，注释都跟着抄）；
   *   · 另有一个 `applyExtraFilters` 只装 username / startTime / endTime / result。
   *
   * 也就是说"R4 P1-2 两条路径同一过滤集"这条承诺，实际只有**后四条**真的共用
   * 一份实现，前四条靠两段复制粘贴维持一致。这不会立刻出错，但它让"改一处忘
   * 另一处"变成纯靠自觉——例如给 action 的 LIKE 转义再多转一个字符，或给
   * resourceId 的长度上限从 100 调到 80，只要漏改一侧，**列表与 CSV 会静默
   * 返回不同的行集**，而两边都不报错。这正是 `GET /tasks/executions/all` 那边
   * `applyAllExecutionsFilters` 已经收口掉的同一个问题。
   *
   * 收口后，"两条路径发出同一组谓词"成为可断言的事实：spec 里对同一组过滤参数
   * 分别走 findAll / exportCsv / keyset，逐条比对 `andWhere` 的 `(sql, params)`
   * 序列。
   *
   * ## 安全
   *
   * 全部值都是**绑定参数**（`andWhere(sql, { … })`），从不拼进 SQL 文本；
   * LIKE 元字符经 `escapeLikePattern` 转义；超长 needle 在绑定前截断。
   */
  private applyAuditFilters(
    qb: import("typeorm").SelectQueryBuilder<AuditLog>,
    options: AuditFilterOptions,
  ): void {
    const { action, resource, resourceId, userId } = options;

    if (action) {
      // API-09（本轮体验审查）：放宽 SEC-03 的白名单。
      //
      // 原实现要求 `^[a-zA-Z0-9_.\-\s]+$`，否则 400。但：
      //   · 注入风险早已由**绑定参数**消除（值从不拼进 SQL，`ILIKE :action`），
      //     该白名单对安全没有增量；
      //   · 它只剩副作用——用户输入中文、`:`、`/` 这类**完全正常**的搜索词会吃
      //     400 + 英文技术报错，而用户期待的是"没有匹配"或结果列表。
      //
      // 改为只限长度（防 DoS），并转义 LIKE 元字符保证 `%`/`_` 按字面量匹配。
      const sanitizedAction = action.trim().slice(0, 100);
      qb.andWhere("log.action ILIKE :action", {
        action: `%${escapeLikePattern(sanitizedAction)}%`,
      });
    }

    if (resource) qb.andWhere("log.resource = :resource", { resource });

    // AUTH-05: (resource, resourceId) 成对过滤。resourceId 走**精确匹配**
    // （值是 opaque uuid/整数 id，部分匹配只会带来意外命中）；DTO 字段是普通
    // 字符串，但绑定前仍截断到 100 字符，避免超长 query string 直达 PG。
    if (resourceId) {
      qb.andWhere("log.resourceId = :resourceId", {
        resourceId: resourceId.slice(0, 100),
      });
    }

    if (userId) qb.andWhere("log.userId = :userId", { userId });

    // result 筛选（success/failure）：IsIn 白名单在 DTO 层兜住非法值。
    if (options.result) {
      qb.andWhere("log.result = :result", { result: options.result });
    }
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
