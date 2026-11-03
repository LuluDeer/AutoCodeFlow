import { In } from "typeorm";
import type { Repository, SelectQueryBuilder } from "typeorm";

import {
  executionListSelectMap,
  executionListSelectColumnsAliased,
} from "./execution-list-projection";
import {
  executionCsvHeaderRow,
  executionToCsvRow,
} from "./execution-csv";
import { csvTruncationMarker } from "../../common/utils/csv-export.util";
import {
  decodeExecutionCursor,
  nextExecutionCursor,
} from "../../common/utils/keyset-cursor.util";
import { paginate, PaginationDto } from "../../common/dto/pagination.dto";
import { buildExecutionTimeline } from "./execution-timeline.util";
import { TaskExecution, ExecutionStatus } from "./entities/task-execution.entity";
import { ExecutionReport } from "../metrics/entities/execution-report.entity";
import { AppError } from "../../common/errors/app-error";
// NETOPT-3⑤：LIKE 元字符转义（getAllExecutions 的 taskName/executorAddress
// 两个 ILIKE 必须走它，否则 `_`/`%` 被当通配符、搜索结果静默变宽）。
import { escapeLikePattern } from "../audit/audit.service";

/**
 * 导出行的硬上限。
 *
 * 为什么是 5 万：导出是运维事实表，1 万行在中等规模实例上连三天都不到，导出
 * 会变成「永远被截断」——一个永远触发截断提示的能力等于没有能力。5 万行 ×
 * 平均 300 字节 ≈ 15 MB，对一个手动触发的 ADMIN 导出是可接受的量级；真需要
 * 更多请按 `startTime`/`endTime` 分段导出。
 *
 * （T2-B4 第一刀随 `streamExecutionsCsv` 一同迁入协作者；Facade 侧**再导出**
 * 同名常量，保持既有 import 面不变。）
 */
export const EXECUTION_EXPORT_ROW_CAP = 50_000;

/**
 * 导出时的单次 DB 取数页大小。
 *
 * 与行上限解耦：它是「每次往返拿多少行进内存」的量，不是「导出多少行」。1000
 * 行足以摊薄往返开销，又不会让单页文本大到撑爆背压窗口（约 300 KB/页）。
 */
const EXECUTION_CSV_PAGE_SIZE = 1_000;

/**
 * T2-B4 第一刀：**执行记录读面与导出**协作者。
 *
 * ## 这一刀搬了什么（9 个 Facade 公共方法 + 5 个内部辅助）
 *
 * 公共读面：`getExecutions` / `getExecutionsByKeyset` / `getAllExecutions` /
 * `getAllExecutionsByKeyset` / `streamExecutionsCsv` / `getExecutionStats` /
 * `getExecution` / `getExecutionReport`（8 个 Facade 公共方法）+
 * 内部辅助：`applyAllExecutionsFilters` / `backfillExecutionTaskNames` /
 * `executionStatsSelect` / `findExecution`。
 *
 * ## 为什么这刀适合当第一刀（都是**纯读**）
 *
 * · **无事务**：整簇没有一个 `dataSource.transaction` ⇒ 不存在「跨协作者拆事务」
 *   的风险（T2-B4 第 3 条约束自动满足）。
 * · **无写**：全簇零 `save`/`update`/`insert`/`delete` ⇒ 搬走不改变任何写路径。
 *   ⚠️ 特别澄清 `backfillExecutionTaskNames`：**名字里的 backfill 指「回填
 *   **响应对象**的 taskName 字段」，不是回填数据库**——它只 `taskRepo.find`，
 *   零写操作**（Lead 第 2 条约束已核实：本刀**没有**夹带写路径）。
 * · **无私有字段断言**：`executions-export.spec.ts:705` 那条
 *   `(service as any).execRepo.createQueryBuilder.mock.results[0]` 走的是
 *   `streamExecutionsCsv`；本协作者**按原顺序、原次数**调用 `execRepo`
 *   ⇒ `results[0]` 仍指向同一次调用。
 *
 * ## ⚠️ `execRepo` 调用顺序不变量（Lead 第 3 条约束）
 *
 * `streamExecutionsCsv` 的既有 spec 用 `mock.results[0]` 断言「绝不使用 OFFSET」
 * ——**索引型断言不会因为「多一次调用」而红，它会把别的调用结果当成本次的结果，
 * 断言假过**。⇒ Facade 转发层**绝不允许**在转发前「预检一次」；
 * 协作者内 `execRepo` 的调用**顺序与次数**与搬迁前逐条一致。
 *
 * ## self-call 禁令
 *
 * 协作者内部**不得**直调自己的 **public** 方法（Facade 转发层是 spy 拦截面，
 * 内部 self-call 会让既有实现级断言**静默失效**）。
 * 本簇的内部互调一律指向 **private** 方法：
 * `getExecutions` → `getExecutionsByKeyset`（private）、
 * `getAllExecutions` → `getAllExecutionsByKeyset`/`applyAllExecutionsFilters`/
 * `backfillExecutionTaskNames`（均 private）、
 * `getExecutionStats` → `executionStatsSelect`（private）、
 * `getExecution`/`getExecutionReport` → `findExecution`（private）。
 *
 * ⚠️ `getExecution` 与 `getExecutionReport` **都是 public**（Facade 各有转发，
 * 且 `getExecutionReport` 是全仓**唯一被 spy 的**簇方法）⇒ 两者**都不得**
 * 互调 ⇒ 抽出共用的 private `findExecution`。
 */

/** 协作者依赖（全部最小面）。 */
export interface ExecutionReadDeps {
  /** 执行记录仓库（读面唯一入口）。 */
  execRepo: Repository<TaskExecution>;
  /** 任务仓库（`backfillExecutionTaskNames` 取任务名；`getExecutionStats` 取任务）。 */
  taskRepo: Repository<{ id: string; name: string }>;
  /** 当日聚合报告仓库（`getExecutionReport`；可为 null = 仓储未注册）。 */
  reportRepo: Repository<ExecutionReport> | null;
}

export class ExecutionRead {
  private readonly deps: ExecutionReadDeps;

  constructor(deps: ExecutionReadDeps) {
    this.deps = deps;
  }

  /**
   * GET /tasks/:id/executions 的读实现。
   *
   * PLAN-BACKEND-ARCHITECTURE §2.1「游标分页」——**加性过渡**，两条路径严格分离：
   *
   *   · `p.cursor` **未传** → 走下方**原有**的 `findAndCount` + skip/take（OFFSET
   *     分支）。这一支的代码路径、SQL 形态、返回对象全部与引入游标之前逐字节
   *     相同（`paginate` 不传 options，信封里连 `nextCursor` 键都不出现）。
   *   · `p.cursor` **已传** → 走 `getExecutionsByKeyset`（见其注释）。
   *
   * 为什么用"参数是否存在"而不是"page 是否 > 1"来分流：游标语义与页码无关，
   * 调用方可能只想给一个全新入口（永远不传 page）。两种模式混用会得到彼此矛盾
   * 的页（keyset 的"第 2 页"不等于 OFFSET 的第 2 页），故只要带了 cursor 就
   * **忽略 page**（响应里的 page 回显 1，见 keyset 分支注释）。
   *
   * ## 空的 `cursor=` 是**显式的「从最新一行开始 keyset」标记**
   *
   * 这是本方案唯一的"引导入口"，不解决它调用方永远进不了 keyset 模式：OFFSET
   * 分支出于逐字节不变的硬要求**不返回** `nextCursor`，所以客户端拿不到第一个
   * 游标。故约定 `?cursor=`（值为空串）表示"以 keyset 模式从第一页开始"——服务端
   * 照常下发 `nextCursor`，客户端此后只需原样回传即可一直翻到底。
   *
   * ⚠️ 这与"坏游标静默退回第一页"**必须区分开**：那是**未声明的**降级（客户端
   * 以为自己在中途，服务端悄悄给了开头 → 死循环）；这里是调用方**显式声明**的
   * 起点。故 `""` 在进入 keyset 分支后直接表示"无下界"，而任何**非空**的畸形
   * 游标一律 400（`decodeExecutionCursor` 不放松，它仍然拒绝空串——起点语义只
   * 存在于服务层的这个入口判断里）。
   */
  async getExecutions(
    taskId: string,
    p: PaginationDto & { status?: string; cursor?: string },
  ) {
    if (p.cursor !== undefined && p.cursor !== null) {
      return this.getExecutionsByKeyset(taskId, p, p.cursor);
    }

    const where: Record<string, unknown> = { taskId };
    if (p.status) where["status"] = p.status;

    const [list, total] = await this.deps.execRepo.findAndCount({
      where,
      // PERF-03（本轮体验审查）：必须显式排除重型文本列。
      // task_executions.logs 是 text 列，回调 DTO 允许单条 512_000 字符
      // （execution-callback.dto.ts 的 @MaxLength(512_000)）——一页 20 行满载
      // 时仅 logs 就接近 10 MB，全部经 JSON 序列化、网络传输、再被前端丢弃：
      //   · TaskDetailPage 执行历史表只渲染 status/executorAddress/startTime/
      //     duration/errorMessage（第 268-320 行），**从不读 logs**；
      //   · 执行详情页的日志走独立端点 GET .../logs（按行分页）与 SSE 流，
      //     不依赖列表响应里的 logs；
      //   · aiAnalysis（同样 text）只在详情页 / 报告端点展示。
      // 故排除它们对功能零影响，却把该端点的响应体缩小一到两个数量级。
      // 注：TypeORM 1.x 已移除 find 选项 select 的字符串数组形态
      // （0.3.x 时代靠 FindOptionsSelectByString 勉强可用），改用对象形态，
      // 列名仍由元数据运行时派生（见 execution-list-projection.ts）。
      select: executionListSelectMap(this.deps.execRepo),
      skip: (p.page - 1) * p.pageSize,
      take: p.pageSize,
      // FIX-5.3: id 决胜键——createdAt 非唯一（同刻批量提交/同任务并发行），
      // 单键排序下 OFFSET 翻页会漏行/重行（与 scheduler stale sweep 翻页同
      // 教训——该处已加决胜键，读端点此前未同步）。
      order: { createdAt: "DESC", id: "DESC" },
    });
    return paginate(list, total, p.page, p.pageSize);
  }

  /**
   * §2.1 keyset 分支：`(createdAt, id) < (cursorCreatedAt, cursorId)` 的元组游标
   * 翻页。
   *
   * ## 游标的非法处理
   *
   * `decodeExecutionCursor` 是**唯一**的合法性判定点（纯函数 + 独立单测），任何
   * 畸形输入都在这里抛 400 `VALIDATION_FAILED`。**绝不**把非法游标当成"没传游标"
   * 降级到 OFFSET 分支——那会让客户端陷入"带着坏游标请求、每次拿回第 1 页、
   * 每次都是 200"的死循环（详见 keyset-cursor.util.ts 头注）。
   *
   * ## 为什么 SQL 里用"行值比较 + 子查询取游标行"，而不是毫秒区间
   *
   * PostgreSQL 支持行值比较 `(a, b) < (:at, :id)`，正是这里要的形状。但**不能**
   * 把 `:at` 绑成"实体读出的毫秒 Date"或游标里的 ISO 串——两版都已被实测证伪：
   *
   *   · `task_executions."createdAt"` 的列类型是 `TIMESTAMP`（无时区，PG 精度
   *     **微秒**，`now()` 生成），而 JS `Date` 只有**毫秒**；
   *   · 执行行写入时**不显式给 createdAt**（executor/scheduler/task 三处
   *     `execRepo.create({...})` 都不带该列），取数据库默认值 `now()` = **事务
   *     开始时间**。同事务批量插入共享同一微秒值，但**跨事务**的同毫秒插入会
   *     得到不同的微秒值（`.000456` 这种），在高频执行面上很常见。
   *
   * ### 已证伪的写法：毫秒半开区间
   *
   *      (createdAt < :at OR (createdAt < :atNext AND id < :cursorId))
   *
   * 分支②隐含"同一毫秒内的行排序完全由 id 决定"，**只在同毫秒行的微秒值恰好
   * 相等时成立**。
   *
   * #### 精确触发条件（本缺陷最有价值的部分）
   *
   * 同毫秒内存在「**微秒更小**（时间上在游标之后）但 **id 更大**（`> cursorId`）」
   * 的行 → 分支② 的 `id < cursorId` 把它判为"不满足" → **静默漏行**。
   * 反向同样成立：微秒更大（时间上在游标之前）但 `id < cursorId` 的行会被误返回
   * （游标行本身被再次返回 → 翻页原地打转）。
   *
   * ⚠️ **id 与微秒同序时不显形**——这正是它能同时通过 CI、既有单测与人工冒烟的
   * 原因：只有当 uuid 的随机字典序与微秒的写入顺序**反着**时才会漏行。
   *
   * #### 实测（真 PG，Asia/Shanghai，同毫秒 4 行）
   *
   *     id…50  .0004  ← 游标行
   *     id…10  .0003
   *     id…40  .0002
   *     id…60  .0001
   *
   *     期望下一页          : 10, 40, 60
   *     半开区间（旧实现）  : 10, 40      ← 漏 id…60（在游标之后，但 60 > 50）
   *     行值比较（现实现）  : 10, 40, 60  ✅
   *
   * 另一组同毫秒 4 行（微秒 .000100/.000200/.000300/.000400，取 .000400 做游标）：
   * 半开区间返回 **4 行**（含游标行本身）❌，行值比较返回 **3 行** ✅。
   *
   * ### 现在的写法（正确）
   *
   *      (e.createdAt, e.id) < (
   *        SELECT c."createdAt", c.id FROM task_executions c WHERE c.id = :cursorId
   *      )
   *
   * 游标只带 `id`，精确时间由子查询按主键从库里取**原值**（含微秒）——DB 值比
   * DB 值，JS 的毫秒截断完全不参与运算，零精度损失。子查询是主键单行查找，外层
   * 仍走 (createdAt, id) 范围扫描。
   *
   * 游标行被并发删除时：子查询无行 → 行值比较得 NULL → WHERE 为假 → 本页为空，
   * 调用方看到 `nextCursor: null` 即视为翻完。这是**安全地提前结束**（不错行、
   * 不重复），比"用毫秒近似值硬续"安全得多。
   *
   * ### 附带修掉的时区陷阱（保留记录）
   *
   * 早期实现把 `cursor.createdAt`（UTC 形态的 `'…T16:58:01.357Z'`）**当字符串**
   * 绑定。`task_executions."createdAt"` 是 **naive** `timestamp`（无时区）；PG 把
   * 带 `Z` 的文本强转成 naive timestamp 时**丢弃时区**、按**会话本地墙钟**解释，
   * 于是 `TimeZone=Asia/Shanghai` 时比较值比真实值**早 8 小时**。实测（同一游标
   * 行，`WHERE "createdAt" < $1` 命中行数，真值 2 行）：字符串参数 → **0 行**
   * （静默漏行），`Date` 参数 → **2 行**（正确）。正偏移时区漏行、负偏移时区重复
   * 返回，`TZ=UTC` 容器里完全隐形——故测试必须用**与时区无关**的断言。
   *
   * 现行写法里时间完全不下传（由子查询取库内值），这类时区/精度问题被从根上
   * 消除；游标载荷仍保留 ISO 串（毫秒）只为**排障可读**与 forward-compat，
   * 不参与比较运算。
   *
   * ## `total`：仍然给真实总数（不撒谎）
   *
   * keyset 分支复用**同条件**的 `COUNT`。为什么不按"keyset 不需要总数"省掉它：
   * `total` 的类型是 `number` 且四端都在渲染"共 N 条"（分页器、CLI 输出、MCP 工具
   * 载荷）。返回 `-1`/近似值/上一次的值都是**撒谎**——`total` 没有任何字段级的
   * "这是估算"标记，调用方无从分辨。代价是一次 COUNT（`(taskId, ...)` 上有索引，
   * 且与 OFFSET 分支本来就在做的 `findAndCount` 是同一量级），换来的是语义正确。
   * 若将来真需要省这一条，正确做法是新增 `totalExact: false` 之类的显式标记，
   * 而不是悄悄改 `total` 的含义。
   *
   * ## 为什么 `page` 回显 1
   *
   * keyset 与 OFFSET 的"第 N 页"不是同一套坐标系（前者是无状态的"从游标继续"，
   * 后者是"跳过前 N-1 页"）。回显调用方的 `p.page` 会让响应看起来像 OFFSET 的
   * 第 N 页——那正是最容易让调用方把两种模式混用、进而漏页的误解。回显 1
   * （= "本次是从某个位置继续取的第一页"）诚实且不会诱导混用；`page` 的类型与
   * 是否出现都没变（仍是 `number`），只影响 keyset 分支下的取值。
   */
  private async getExecutionsByKeyset(
    taskId: string,
    p: PaginationDto & { status?: string },
    rawCursor: string,
  ) {
    // 空串 = 调用方显式声明的 keyset 起点（见 getExecutions 注释）；非空则必须
    // 是合法游标，否则 400。
    const cursor = rawCursor === "" ? null : decodeExecutionCursor(rawCursor);

    const where: Record<string, unknown> = { taskId };
    if (p.status) where["status"] = p.status;

    const qb = this.deps.execRepo
      .createQueryBuilder("e")
      .select(executionListSelectColumnsAliased(this.deps.execRepo))
      // 排序键与游标元组必须同源（createdAt DESC, id DESC），否则"继续"的
      // 起点与结果集排序不符，翻页会漏/重。
      .orderBy("e.createdAt", "DESC")
      .addOrderBy("e.id", "DESC")
      .where("e.taskId = :taskId", { taskId });

    if (cursor) {
      // 元组游标——**行值比较**，游标那一行的精确值由子查询从库里取回。
      //
      // 为什么不能再用"毫秒半开区间"（704f749e 的原实现，已实测证伪）：
      // 原实现是
      //     (createdAt < :at OR (createdAt < :atNext AND id < :cursorId))
      // 其中 `:at` 来自实体读出的 JS `Date`（**毫秒**，微秒被截断），而列是
      // 微秒精度。分支②隐含假设"同一毫秒内的行排序完全由 id 决定"——**该假设
      // 只在同毫秒行的微秒值恰好相等时成立**。同毫秒但微秒不同时（跨事务写出的
      // 行很常见；`now()` 是事务开始时间，同事务批量插入才会共享微秒）：
      //   · 该行时间上在游标**之后**、却 `id > cursorId` → 被判不满足 → **漏行**；
      //   · 该行时间上在游标**之前**、却 `id < cursorId` → 被判满足 → **返回游标
      //     之前的行**（实测：游标行本身被再次返回，翻页原地打转）。
      //
      // 真 PG 实测（autoflow_test，同毫秒 4 行微秒 .000100/.000200/.000300/.000400，
      // 取 .000400 那行做游标）：
      //   半开区间谓词 → 返回 4 行（含游标行本身） ❌
      //   行值比较     → 返回 3 行，与期望逐项一致 ✅
      //
      // 故改为 `(createdAt, id) < (游标行的精确 (createdAt, id))`，由子查询按主键
      // 取游标行的**库内原值**（含微秒）——DB 值比 DB 值，JS 的毫秒截断完全不
      // 参与运算，没有任何精度损失。子查询是主键单行查找，外层仍是
      // (createdAt, id) 上的范围扫描。
      //
      // 游标行被并发删除时：子查询无行 → 行值比较得 NULL → WHERE 为假 → 本页为
      // 空（此时调用方看到 `nextCursor: null` 即视为翻完）。这是**安全地提前
      // 结束**，不会错行/重复——比"用毫秒近似值继续"要安全得多。
      qb.andWhere(
        `(e.createdAt, e.id) < (
           SELECT c."createdAt", c.id FROM task_executions c WHERE c.id = :cursorId
         )`,
        { cursorId: cursor.id },
      );
    }
    // 多取一行：用"有没有第 N+1 行"判断 hasMore，避免额外的 exists 查询。
    qb.take(p.pageSize + 1);

    if (p.status) qb.andWhere("e.status = :status", { status: p.status });

    const [rows, total] = await Promise.all([
      qb.getMany(),
      this.deps.execRepo.count({ where: where as never }),
    ]);

    const hasMore = rows.length > p.pageSize;
    const list = hasMore ? rows.slice(0, p.pageSize) : rows;
    return paginate(list, total, 1, p.pageSize, {
      // 还有下一页 → 用本页最后一行编游标；否则显式 null（末页标记）。
      nextCursor: hasMore ? nextExecutionCursor(list) : null,
    });
  }

  async getAllExecutions(
    p: PaginationDto & {
      status?: string;
      taskId?: string;
      taskName?: string;
      executorAddress?: string;
      startTime?: string;
      endTime?: string;
      cursor?: string;
    },
  ) {
    // §2.1（推广到 GET /tasks/executions/all）: 游标分页分支。
    // 不带 cursor 时下面一行都不执行，旧路径**逐字节不变**（响应里连
    // nextCursor 这个键都不出现，见 paginate 的 options.nextCursor 契约）。
    if (p.cursor !== undefined && p.cursor !== null) {
      return this.getAllExecutionsByKeyset(p, p.cursor);
    }

    // DB-003: 原 getRawAndEntities + getCount 会产生 3 条 SQL（raw 页查询、
    // entities 页查询、count），executions 被全表扫描两次。改为：
    // 1) getManyAndCount：页查询 + count 共 2 条（仅 executions 扫描）；
    // 2) 任务名回填只对缺 taskName 的行做一次 PK IN 批量查询（join 仅在
    //    taskName 过滤时保留用于匹配 t.name）。
    // PERF-03（本轮体验审查）：同 getExecutions——排除 logs/aiAnalysis 两个
    // 重型 text 列（单条上限 512_000 字符）。列表页（ExecutionsPage）只渲染
    // taskName/status/triggerType/executorAddress/startTime/duration/
    // errorMessage，CommandPalette 只取 id/taskName/status，都不读 logs。
    const qb = this.deps.execRepo
      .createQueryBuilder("e")
      .select(executionListSelectColumnsAliased(this.deps.execRepo))
      // FIX-5.3: id 决胜键（同 getExecutions——createdAt 非唯一，OFFSET 翻页
      // 无决胜键会漏行/重行）。
      .orderBy("e.createdAt", "DESC")
      .addOrderBy("e.id", "DESC")
      .skip((p.page - 1) * p.pageSize)
      .take(p.pageSize);

    // 过滤条件：与 keyset 分支**共用同一份**装配（见 applyAllExecutionsFilters）
    this.applyAllExecutionsFilters(qb, p);

    const [list, total] = await qb.getManyAndCount();

    const items = await this.backfillExecutionTaskNames(list);
    return paginate(items, total, p.page, p.pageSize);
  }

  /**
   * 导出执行记录为 CSV——**真正的流式**写入（`GET /tasks/executions/export`）。
   *
   * ## 为什么入口在 service 而不是 controller
   *
   * 导出要做三件互相依赖的事：按固定排序**分页拉取**（不能一次 `find` 全量）、
   * 逐行做 CSV 编码、以及把行写进响应并处理**背压**。前两件与 HTTP 无关，第三件
   * 需要一个"写一段文本"的能力——故这里只依赖一个 `write` 回调，由 controller
   * 把它绑到 `res.write` + `drain`。这样背压逻辑可被单测直接验证（见
   * `__tests__/executions-export.spec.ts` 的 drain 用例），不必起真 HTTP。
   *
   * ## 为什么必须流式（而不是"查全量 → 拼一个大字符串 → res.send"）
   *
   * 表的上限不是理由（有 5 万行硬顶，内存可控），**行宽**才是：单条
   * `errorMessage` 允许 512_000 字符，5 万行理论上是 25 GB；即便实际分布温和，
   * 拼接也意味着"整份 CSV 在内存里同时存在一份字符串 + 一份 Buffer"，
   * 且首字节要等到最后一个数据库页返回才发出（反代 60s 空闲断流先例）。
   * 流式把峰值内存压到"一页行 + 一页文本"，且第一个字节在第一次 DB 往返后
   * 就出去。
   *
   * ## 背压（这是"流式"与"往 res 里循环 write"的分水岭）
   *
   * `res.write()` 返回 false 表示内核发送缓冲已满，继续写会把整份结果堆在
   * Node 的进程内 buffer 里——OOM 的成因不是"结果太大"而是"没人等 drain"。
   * 故每次写完检查返回值，false 时 `await once(drain)`。同时监听 socket 的
   * `close`：客户端中途取消下载时立刻停止拉库，不把剩下的页空跑完。
   *
   * ## 与列表端点的过滤同源
   *
   * 六个过滤器**全部**经 `applyAllExecutionsFilters` 下发——那是
   * `GET /tasks/executions/all` 与 `GET /tasks/:id/executions` 的唯一真值源。
   * 本方法**不复制**任何 where 构造（复制一份是"导出与列表筛选结果不一致"的
   * 唯一成因，且这种不一致不会有任何报错）。
   *
   * ## 排序与列表一致（createdAt DESC, id DESC）
   *
   * 同一份 (createdAt, id) 全序键：导出文件的行序与列表页**逐行对应**，运维
   * 拿 CSV 与页面比对时不会看到"同样的筛选，顺序却不同"。分页走
   * `(createdAt, id)` **行值比较**的 keyset——不用 OFFSET，因为导出要跨几百页，
   * 深 OFFSET 随页数线性变慢，且分页期间的并发写入会让 OFFSET 漏行/重行
   * （导出比列表更需要"不漏不重"：它是要被归档的一次快照）。行值比较的
   * 微秒精度论证见 `getExecutionsByKeyset` 头注。
   */
  async streamExecutionsCsv(
    filters: {
      status?: string;
      taskId?: string;
      taskName?: string;
      executorAddress?: string;
      startTime?: string;
      endTime?: string;
    },
    write: (chunk: string) => Promise<void>,
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<{ rows: number; truncated: boolean }> {
    const cap = EXECUTION_EXPORT_ROW_CAP;
    const requested = options.limit;
    // 只允许调小（契约见 ExportExecutionsQueryDto.limit）：>硬顶一律归一，
    // 不报错——事故中回 400 比给一份"截断但有痕"的文件糟得多。
    const limit =
      typeof requested === "number" &&
      Number.isFinite(requested) &&
      requested > 0
        ? Math.min(Math.floor(requested), cap)
        : cap;

    // 表头自带换行：数据页每块都以 `\n` 结尾，表头也必须如此，否则第一条
    // 数据行会与表头拼成同一行（一个只在"恰好 0 行"时才不出现的静默错位）。
    await write(`${executionCsvHeaderRow()}\n`);

    let written = 0;
    // 上一页最后一行的 (createdAt, id)：下一页的键集下界（无 OFFSET）。
    let lastCursor: { createdAt: Date; id: string } | null = null;

    for (;;) {
      if (options.signal?.aborted) break;
      // 每页取 min(剩余额度, PAGE) —— 额度在循环里收缩，最后一页不必多取。
      const pageSize = Math.min(EXECUTION_CSV_PAGE_SIZE, limit - written);
      if (pageSize <= 0) break;

      const qb = this.deps.execRepo
        .createQueryBuilder("e")
        .select(executionListSelectColumnsAliased(this.deps.execRepo))
        .orderBy("e.createdAt", "DESC")
        .addOrderBy("e.id", "DESC")
        .take(pageSize);
      // 过滤条件：唯一真值源（**绝不**在此复写 where 构造）。
      this.applyAllExecutionsFilters(qb, filters);
      if (lastCursor) {
        // 键集续页：行值比较（DB 值比 DB 值，微秒零损失，同 getAllExecutionsByKeyset）。
        qb.andWhere(
          `(e.createdAt, e.id) < (SELECT c."createdAt", c.id FROM task_executions c WHERE c.id = :cursorId)`,
          { cursorId: lastCursor.id },
        );
      }

      const rows: TaskExecution[] = await qb.getMany();
      if (rows.length === 0) break;

      const lines = rows.map((r) => executionToCsvRow(r));
      written += rows.length;
      // 一页一次 write（不是一行一次）：每行一个 write 会把系统调用放大到
      // 行数量级，而一页通常已是几十 KB，足够摊薄调用开销。
      await write(`${lines.join("\n")}\n`);

      if (written >= limit) break;
      if (rows.length < pageSize) break; // 已到末页
      const last = rows[rows.length - 1];
      lastCursor = { createdAt: last.createdAt, id: last.id };
    }

    // 有痕截断：达到上限即追加注释行。判据用 `>=`（不是 `>`）——"恰好取满
    // limit 行"时**无法区分**是否还有更多行（本循环取满即 break，不再多探
    // 一行），这种情况必须按"可能被截断"如实标注，绝不能让人误以为是全量。
    const truncated = written >= limit;
    if (truncated) {
      await write(`${csvTruncationMarker(limit)}\n`);
    }
    return { rows: written, truncated };
  }

  /**
   * `getAllExecutions` 的过滤条件装配（**唯一**真值源，OFFSET / keyset 两条
   * 路径共用——与 `buildTaskListWhere` 之于 `findAll` 是同一个先例）。
   *
   * 为什么必须是"一份"而不是各写一份：这些过滤器全是**放宽/收窄结果集**的
   * 条件（status/taskId/taskName/executorAddress/startTime/endTime）。两份实现
   * 一旦漂移，最典型的表现不是报错而是"两种分页模式返回的集合不同"——
   * 客户端从 OFFSET 整页翻到 keyset 后结果集**静默**变宽/变窄，且没有任何
   * 信号（`total` 也会跟着变）。那正是本仓反复在修的"静默损坏"。
   *
   * 本端点的排序键恒为 `(createdAt DESC, id DESC)`（无 sortBy 参数），故
   * 游标与全部过滤器都只是 AND 关系，不需要 `assertCursorCompatibleWithQuery`
   * 那样的可组合性拒绝。
   */
  private applyAllExecutionsFilters(
    qb: SelectQueryBuilder<TaskExecution>,
    p: {
      status?: string;
      taskId?: string;
      taskName?: string;
      executorAddress?: string;
      startTime?: string;
      endTime?: string;
    },
  ): void {
    if (p.status) qb.andWhere("e.status = :status", { status: p.status });
    if (p.taskId) qb.andWhere("e.taskId = :taskId", { taskId: p.taskId });
    if (p.taskName) {
      // taskName 过滤：命中执行行自身的 taskName，或命中 tasks 表名称
      //（保留 join 仅用于此过滤场景）
      // NETOPT-3⑤: API-09 同款转义——`_`/`%` 必须按字面量匹配（搜
      // `zhang_san` 不应命中 `zhangXsan`），否则搜索结果静默变宽、运维
      // 会据错误结果集得出错误结论。
      qb.leftJoin("tasks", "t", "t.id = e.taskId");
      qb.andWhere("(e.taskName ILIKE :taskName OR t.name ILIKE :taskName)", {
        taskName: `%${escapeLikePattern(p.taskName)}%`,
      });
    }
    if (p.executorAddress)
      // NETOPT-3⑤: 同上——执行器地址常含下划线/通配符字符，转义后按字面量匹配。
      qb.andWhere("e.executorAddress ILIKE :executorAddress", {
        executorAddress: `%${escapeLikePattern(p.executorAddress)}%`,
      });
    if (p.startTime)
      qb.andWhere("e.createdAt >= :startTime", { startTime: p.startTime });
    if (p.endTime)
      qb.andWhere("e.createdAt <= :endTime", { endTime: p.endTime });
  }

  /**
   * 一次性批量补齐缺失的 taskName（替代原 leftJoin + raw Map 组装）。
   *
   * OFFSET 与 keyset 两条路径共用：两条路径的响应形状必须一致，包括
   * `taskName` 的回填语义（行自身有值则优先，否则按 taskId 批量取 tasks.name）。
   */
  private async backfillExecutionTaskNames(
    list: TaskExecution[],
  ): Promise<Array<TaskExecution & { taskName: string | null }>> {
    const missingIds = [
      ...new Set(
        list
          .filter((e) => !e.taskName && e.taskId)
          .map((e) => e.taskId as string),
      ),
    ];
    const taskNameMap = new Map<string, string>();
    if (missingIds.length > 0) {
      const tasks = await this.deps.taskRepo.find({
        where: { id: In(missingIds) },
        select: { id: true, name: true },
      });
      for (const t of tasks) taskNameMap.set(t.id, t.name);
    }

    return list.map((e) => ({
      ...e,
      taskName: e.taskName || taskNameMap.get(e.taskId) || null,
    }));
  }

  /**
   * §2.1（推广到 GET /tasks/executions/all）keyset 分支：
   * `(createdAt, id) < (游标行的库内原值)` 的元组游标翻页。
   *
   * 形态与 `getExecutionsByKeyset` / `findAllByKeyset` **逐字同款**（同一份
   * `decodeExecutionCursor` / `nextExecutionCursor`，同一个行值比较谓词），
   * 不重新设计。三处差异都是本端点固有的，不是随意的：
   *
   *   ① 过滤条件走 `applyAllExecutionsFilters`（六个全局过滤器，而不是单任务
   *      的 taskId/status）——与 OFFSET 分支共用同一份装配；
   *   ② 多取一行的判断用 `getCount()` 而不是 `getManyAndCount()`：后者在
   *      `taskName` 过滤生效时会带上 leftJoin，而 typeorm 的 `lazyCount` 在
   *      "有 join + 有 take" 时会退化成 `COUNT(DISTINCT e.id)`（见
   *      SelectQueryBuilder.lazyCount）——语义仍是"该过滤下的总行数"，但它是
   *      从**本页已取的 N+1 行**推算的，翻页越深越依赖它，白付一次 DISTINCT。
   *      拆成"页查询 getMany + 独立 getCount"则与 `getExecutionsByKeyset` 的
   *      `Promise.all([qb.getMany(), count()])` 完全同构，且 total 恒定等于
   *      同过滤条件下的全量行数（不含游标下界——游标只决定"从哪继续"）。
   *   ③ taskName 回填复用 `backfillExecutionTaskNames`（与 OFFSET 分支同源）。
   *
   * 精度：`task_executions."createdAt"` 已核实为 `timestamp without time zone`
   * （information_schema.datetime_precision = 6，微秒）。游标只带 `id`，时间由
   * 子查询按主键取**库内原值**——DB 值比 DB 值，JS Date 的毫秒截断完全不参与
   * 运算，零精度损失。**不要**改回毫秒半开区间：完整证伪论证见
   * `getExecutionsByKeyset` 头注（真 PG 实测：那版会漏行/返回游标之前的行）。
   */
  private async getAllExecutionsByKeyset(
    p: PaginationDto & {
      status?: string;
      taskId?: string;
      taskName?: string;
      executorAddress?: string;
      startTime?: string;
      endTime?: string;
    },
    rawCursor: string,
  ) {
    // 空串 = 调用方显式声明的 keyset 起点（与 getExecutions / findAll 同款约定）；
    // 非空则必须是合法游标，否则 400 —— 绝不降级到 OFFSET 分支。
    const cursor = rawCursor === "" ? null : decodeExecutionCursor(rawCursor);

    const qb = this.deps.execRepo
      .createQueryBuilder("e")
      .select(executionListSelectColumnsAliased(this.deps.execRepo))
      // 排序键与游标元组必须同源（createdAt DESC, id DESC），否则"继续"的
      // 起点与结果集排序不符，翻页会漏/重。
      .orderBy("e.createdAt", "DESC")
      .addOrderBy("e.id", "DESC");

    // 过滤条件：与 OFFSET 分支共用同一份装配（单份真值源，杜绝漂移）。
    this.applyAllExecutionsFilters(qb, p);

    // total 必须在**加游标谓词之前**取：typeorm 的 executeCountQuery 只清
    // orderBy/groupBy/offset/limit/skip/take，**WHERE 原样保留**
    // （node_modules/typeorm/query-builder/SelectQueryBuilder.js:1856 实测），
    // 所以带着游标谓词去 count 得到的是「剩余条数」——第 1 页「共 11 条」、
    // 第 2 页「共 9 条」，用户在同一个筛选条件下看着总数凭空变少。
    // 原注释写的是「不含游标下界」，与实现相反（注释是对的意图，代码是错的）。
    const total = await qb.getCount();

    if (cursor) {
      // 元组游标——**行值比较**，游标那一行的精确 (createdAt, id) 由子查询按
      // 主键从库里取回（含微秒）。论证见 getExecutionsByKeyset 头注。
      //
      // 游标行被并发删除：子查询无行 → 比较得 NULL → WHERE 为假 → 本页为空，
      // 调用方看到 nextCursor: null 即视为翻完（安全地提前结束，不错行不重复）。
      qb.andWhere(
        `(e.createdAt, e.id) < (
           SELECT c."createdAt", c.id FROM task_executions c WHERE c.id = :cursorId
         )`,
        { cursorId: cursor.id },
      );
    }

    // 多取一行：用"有没有第 N+1 行"判断 hasMore，避免额外的 exists 查询。
    qb.take(p.pageSize + 1);

    // 两次查询**顺序**执行（不 Promise.all 同一个 qb）：getMany 会改写
    // expressionMap.queryEntity，与并发的 getCount 抢同一个可变对象不安全。
    const rows = await qb.getMany();

    const hasMore = rows.length > p.pageSize;
    const list = hasMore ? rows.slice(0, p.pageSize) : rows;
    const items = await this.backfillExecutionTaskNames(list);
    return paginate(items, total, 1, p.pageSize, {
      // 还有下一页 → 用本页最后一行编游标；否则显式 null（末页标记）。
      // 内层取原始行 list（不是 items）——编游标只读 (createdAt, id)。
      nextCursor: hasMore ? nextExecutionCursor(list) : null,
    });
  }

  async getExecutionStats(taskId: string) {
    // FIX-5.1: 统计口径收口——此前 successRate 只按「最近 20 次」窗口计算，
    // 而 totalRuns 是全量口径；前端 failedRunCount = totalRuns×(1−rate) 把
    // 两个窗口混在一起派生「失败次数」（历史 500 败 + 最近 20 全成 → 显示
    // 「失败 0 次」）。现后端以一条 GROUP BY 给出**全量**计数（succeeded/
    // failed/successRate 全量口径），近窗成功率保留为 recentSuccessRate
    // （窗口标注见前端卡片），前端不再自行派生失败数。
    // FIX-5.2: recentExecutions 加读投影（复用列表读面排除 logs/aiAnalysis，
    // 并追加排除 result——jsonb 大对象列：广播执行带 acceptedResults 数组、
    // 解释器快照等，统计卡只消费 status/duration）。
    // S8（迁移 1790000000091）：**统计口径 = 真实尝试**，合成行一律排除。
    //
    // 为什么不重复造口径：`synthetic=true` 的行是 G2 为「因上游失败而没跑」的下游
    // 补的可见性记录，**从未执行**（无 startTime/exitCode/logs，duration 恒 null）。
    // 把它算进「执行次数」会让三处同时失真：total 虚高、成功率分母变大（明明没跑
    // 却被算成一次没成功）、近 20 次窗口被没跑的行挤掉真实尝试的位次。而它存在的
    // 全部价值是**列表里看得见「它没跑」**——所以这里只改统计，不动列表行集：
    // `getExecutions` / `getAllExecutions` 照旧返回合成行（见实体 synthetic 注释）。
    const [recent, statusRows, total] = await Promise.all([
      this.deps.execRepo.find({
        where: { taskId, synthetic: false },
        order: { createdAt: "DESC", id: "DESC" },
        take: 20,
        select: this.executionStatsSelect(),
      }),
      this.deps.execRepo
        .createQueryBuilder("e")
        .select("e.status", "status")
        .addSelect("COUNT(*)", "count")
        .where("e.taskId = :taskId", { taskId })
        .andWhere("e.synthetic = false")
        .groupBy("e.status")
        .getRawMany(),
      this.deps.execRepo.count({ where: { taskId, synthetic: false } }),
    ]);
    const byStatus = new Map<string, number>(
      statusRows.map((r) => [String(r.status), Number(r.count) || 0]),
    );
    const succeeded = byStatus.get(ExecutionStatus.SUCCESS) ?? 0;
    // 失败口径 = FAILED + TIMEOUT（与失败类终态语义一致；killed/cancelled
    // 是人工/调度动作，不计入任务自身的失败率）。
    const failed =
      (byStatus.get(ExecutionStatus.FAILED) ?? 0) +
      (byStatus.get(ExecutionStatus.TIMEOUT) ?? 0);
    const successRate =
      total > 0 ? Math.round((succeeded / total) * 1000) / 10 : 0;
    const recentSucceeded = recent.filter(
      (e) => e.status === ExecutionStatus.SUCCESS,
    ).length;
    const recentSuccessRate =
      recent.length > 0
        ? Math.round((recentSucceeded / recent.length) * 1000) / 10
        : 0;
    const durations = recent
      .filter((e) => e.duration != null)
      .map((e) => e.duration!);
    const avgDuration =
      durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0;
    return {
      recentExecutions: recent,
      // 近 20 次窗口口径（保留给趋势参考；字段名即窗口标注）。
      recentSuccessRate,
      // 全量口径（FIX-5.1 起为权威；successRate 语义自「近 20 次」切换为
      // 全量——消费方 TaskDetailPage 同批更新）。
      successRate,
      succeeded,
      failed,
      avgDuration,
      totalRuns: total,
    };
  }

  private executionStatsSelect(): Record<string, true> {
    const select = executionListSelectMap(this.deps.execRepo);
    delete select.result;
    return select;
  }

  /**
   * 单条执行记录（读面）。
   *
   * ⚠️ 本方法与 `getExecutionReport` **都是 public**（Facade 各有转发）⇒ 两者
   **不得互调**（public self-call 会让 Facade 上的 spy 拦不到）⇒ 共用实现放在
   * private `findExecution`。
   */
  async getExecution(id: string, taskId?: string) {
    return this.findExecution(id, taskId);
  }

  /** 内部实现（`getExecution` 与 `getExecutionReport` 共用）。 */
  private async findExecution(id: string, taskId?: string) {
    const e = await this.deps.execRepo.findOne({
      where: taskId ? { id, taskId } : { id },
    });
    if (!e) {
      throw new AppError("TASK_EXECUTION_NOT_FOUND", {
        executionId: id,
      });
    }
    return e;
  }

  /**
   * OBS-04: 执行报告端点读侧——单次响应合并三类数据，供详情页
   * 「分析报告/时间线」Tab 一次拉取渲染：
   *
   * 1. execution：task_executions 行原样返回（含 createdAt/startTime/endTime/
   *    duration/status/triggerType/executorAddress/aiAnalysis 等时间线与 AI
   *    分析字段——时间线由前端从此行的时间戳列映射，保证与 DB 一致）；
   * 2. timeline：与 mcp-server buildExecutionTimeline 同一语义的三段时刻
   *    （created→started→finished；缺省时刻 at=null，前端显示「—」）；
   * 3. report：metrics.execution_reports 当日聚合行（triggerDay=execution
   *    createdAt 的本地日期）。该表由 MetricsService.generateReport 按"日"
   *    聚合写入，与单次执行无外键关系，故只按日期粗粒度关联；无行时返回
   *    report:null（前端降级渲染——本表写入方是手动触发的 today-report
   *    读取路径，环境里常为空表，缺报告属正常态而非错误）。
   */
  async getExecutionReport(id: string, taskId?: string) {
    const execution = await this.findExecution(id, taskId);
    // execution_reports.triggerDay 是 DATE 列（无时间成分）：把执行的
    // createdAt 截到本地零点做等值匹配，避免时区偏移导致查不到当日行。
    // 仓储未注册（@Optional 回退）时同样返回 null——前端按"无报告"降级。
    let report: ExecutionReport | null = null;
    if (this.deps.reportRepo) {
      const day = new Date(execution.createdAt);
      day.setHours(0, 0, 0, 0);
      report = await this.deps.reportRepo.findOne({
        where: { triggerDay: day },
      });
    }
    return {
      execution,
      timeline: buildExecutionTimeline(execution),
      report: report ?? null,
    };
  }
}
