/**
 * R286 · 切片 A：**「滞后的 blocked 工单」只读观测面**。
 *
 * ## 缺陷（逐行核过，不是推测）
 *
 * | 位置 | 事实 |
 * |---|---|
 * | `sop.service.ts:1015-1026` | maxRounds 触顶 ⇒ 落一条 `escalated_to_human` 澄清，再把 assignment CAS 置 `blocked` |
 * | `sop.service.ts:1544-1546` | 超时扫描 `find({ where: { status: In(['assigned','in_progress']) } })` ⇒ **`blocked` 被整体豁免** |
 * | `sop.service.ts:1745-1752` | 另一条升级路径 `blocked → in_progress`（有兜底，**本轮不动**） |
 *
 * ⇒ maxRounds 这条工单**永远停在 blocked**：没有扫描、没有状态边、没有任何列表
 * 能看见它。生产上它看起来像「正在等人工」，而实际上没有人在等。
 *
 * ## 为什么只做只读观测（不改状态机）
 *
 * 产品裁决：`blocked` 的语义就是「等人工」，把它改回 `in_progress` 会让这个信号
 * 消失（另一条路径正是这么做的，于是它「看起来已处理」）。本轮**只补可见性**：
 * 让人能看见卡了多久、卡在哪一轮，处置留给人。
 *
 * ⚠️ 因此：本文件**不写库**、不 import `SopService`（不引运行时耦合），只读三张表。
 *
 * ## 三条不变量（与 R280 `sop-clarification-inbox.service.ts` 同一条纪律）
 *
 * ① `total` 是**独立 `getCount()`**，不是 `items.length`（后者被行数上限截断）
 * ② `truncated = returned < total`；`total` 未知时只能 `false`，「未知」由 `degraded` 说
 * ③ **失败绝不渲染成 0**：任一子查询抛错 ⇒ 对应字段 `null` + `degraded: true`，
 *    HTTP 仍 200（部分可用不等于整页失败）
 *
 * ## 为什么 items 与 total 走**同一个 QueryBuilder 谓词**
 *
 * 口径若在两处各写一遍，改一处忘另一处就会得到「列表 7 行、总数 3」——那正是
 * R278 修掉的那类缺陷（徽标与列表不同源）。故 `baseQuery()` 是**唯一**的谓词来源：
 * items 是它 + `limit()`，total 是它 + `getCount()`。
 *
 * ## 为什么是新文件（不挂到 `SopService`）
 *
 * ① `sop.service.ts` 在 `check:size-caps` 的**逐文件棘轮**上**顶格**
 *    （baseline `ceiling.nonCommentLines = 1708`）⇒ 就地新增必然破顶；
 * ② 职责不同：那是「SOP 的读写与状态机」，这里是「**为收件箱做只读聚合**」；
 * ③ controller 只加一条薄路由，回滚是单文件级。
 *
 * ## 错误码选择（不新造码）
 *
 * 装配缺失（`@Optional()` 注入为 `null`，只可能发生在测试装配里）⇒ 抛既有
 * `DEPENDENCY_UNAVAILABLE`（503，文案「依赖服务暂不可用，请稍后重试」）。该通用码
 * 的文案**不断言任何具体结论**，用在「聚合不可用」上语义正确；新造码需要跑
 * `gen-error-i18n` 重生成物，本轮不做。
 */
import { Injectable, Logger, Optional } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository, SelectQueryBuilder } from "typeorm";

import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import { Sop } from "./entities/sop.entity";
import { SopAssignment } from "./entities/sop-assignment.entity";
import { SopClarification } from "./entities/sop-clarification.entity";
import type {
  SopAssignmentLagItemDto,
  SopAssignmentLagResponseDto,
} from "./sop-assignment-lag.dto";

/**
 * 观测窗口的钳制面（小时）。默认 24 = 一天没动静的 blocked 就值得看一眼。
 *
 * 为什么上限是 720（30 天）：再长的窗口在生产上等于「全量扫描 blocked 表」，
 * 而 `blocked` 行数一旦大起来，`updatedAt` 单列索引帮不上 `status = ... AND
 * updatedAt <= ...` 的复合选择——给一个明确上界，比让调用方传 `hours=999999`
 * 把数据库拖垮要诚实。
 */
export const LAG_HOURS_DEFAULT = 24;
export const LAG_HOURS_MIN = 1;
export const LAG_HOURS_MAX = 720;

/**
 * 单次返回的行数上限（服务端常量，**不是**查询参数）。
 *
 * 为什么不暴露 `limit`：本端点是「观测面」，前端只判断「有没有 / 有多少」；
 * 暴露 `limit` 会让「翻页」与「截断」两种语义混在一起，而这里真正需要的
 * 只是「别把整表搬进响应」。超出的部分由 `truncated` + `total` 表达。
 */
export const LAG_ROW_LIMIT = 200;

/**
 * 本端点观测的状态（**字面量常量**，不是白名单数组）。
 *
 * 写成单值常量而不是 `In(['blocked'])`：`status` 是 VARCHAR(16) 列，单值等值
 * 比较能吃到 `idx_sop_assignments_status_createdAt` 的前缀，`IN (...)` 在
 * 退化成一个值时不保证同样的计划。更重要的是——**它是一份口径**，不是一组
 * 可扩展的枚举：放宽它意味着这个端点的语义变了。
 */
const LAGGING_ASSIGNMENT_STATUS = "blocked" as const;

/** 用来取「该工单最近一条升级澄清」的处置态。 */
const ESCALATED_RESOLUTION = "escalated_to_human" as const;

/**
 * 一次子查询的结果：`value === null` 恒表示**未知**（读失败），而不是 0 / 空。
 */
interface ReadResult<T> {
  value: T | null;
  degraded: boolean;
}

/**
 * 把外部传进来的 `hours` 钳到 `[1, 720]`。
 *
 * NaN / ±Infinity 守卫：HTTP 层 `parseInt("abc") = NaN` 会穿透 `Math.max/Math.min`
 * （`Math.max(1, NaN) = NaN`），NaN 进 `Date` 计算会得到 `Invalid Date`，而
 * `new Date(NaN).toISOString()` 会**抛 RangeError** ⇒ 500。非有限数一律视同未传
 * ⇒ 回落默认值，**不是 400**（本仓既有契约是「非法深链安全回落、绝不 400」）。
 *
 * 小数（`hours=3.9`）按 `Math.trunc` 取整：窗口边界不需要亚小时精度，统一截断
 * 比让调用方猜「3.9 是 3 还是 4」更可预测。
 *
 * ⚠️ 注意 `hours=0` / 负数**不是**「无窗口」的意思：`0` 会钳到 `1`。想让窗口
 * 尽可能小就传 `1`；没有「看全部」的开关（那会是全表扫描，见 `LAG_HOURS_MAX`）。
 */
export function clampLagHours(raw?: number | null): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return LAG_HOURS_DEFAULT;
  }
  return Math.min(LAG_HOURS_MAX, Math.max(LAG_HOURS_MIN, Math.trunc(raw)));
}

@Injectable()
export class SopAssignmentLagService {
  private readonly logger = new Logger(SopAssignmentLagService.name);

  constructor(
    /**
     * 指派仓储（本端点的**数据源 + 谓词锚点**）。
     *
     * `@Optional()` + **末位**：既有 spec 用**定位参数**装配 `SopController`
     * （`new SopController(sops, media, executors)` / 加过 inbox 的 4 参形态），
     * 插在中间会让它们全部错位。缺席 ⇒ 方法入口显式抛 503，**不**返回空信封。
     */
    @Optional()
    @InjectRepository(SopAssignment)
    private readonly assignments?: Repository<SopAssignment> | null,
    /** SOP 仓储：批量取标题（`In(...)`，消除 N+1）。 */
    @Optional()
    @InjectRepository(Sop)
    private readonly sops?: Repository<Sop> | null,
    /** 澄清仓储：批量取「最近一条升级澄清」的 id 与轮次。 */
    @Optional()
    @InjectRepository(SopClarification)
    private readonly clarifications?: Repository<SopClarification> | null,
  ) {}

  /**
   * `GET /sop/assignments/lagging?hours=N`：滞留的 blocked 工单。
   *
   * 查询次数固定为 ≤3（**不随行数增长**）：
   *   ① items（`baseQuery()` + `limit()`）
   *   ② total（同一 `baseQuery()` + `getCount()`）
   *   ③ 批量 SOP 标题（`In(sopIds)`）
   *   ④ 批量升级澄清（`In(assignmentIds)`）
   * ——②与①并行发；③④各自一次。**SOP 数从 1 变 200，查询次数不变**（单测钉住）。
   */
  async lagging(
    input: {
      hours?: number | null;
      now?: number;
    } = {},
  ): Promise<SopAssignmentLagResponseDto> {
    this.requireWiring();

    const hours = clampLagHours(input.hours);
    // `now` 可注入是**为了可测**：单测不该依赖真实时钟。生产调用方不传。
    const now = input.now ?? Date.now();
    const cutoff = new Date(now - hours * 60 * 60 * 1000);

    // items 与 total 并行发：彼此不依赖，串行会白等一个往返。
    const [rows, total] = await Promise.all([
      this.read("lagging.items", () => this.findLagging(cutoff)),
      this.read("lagging.total", () => this.countLagging(cutoff)),
    ]);

    const assignments = rows.value ?? [];
    const sopIds = [...new Set(assignments.map((a) => a.sopId))];
    const assignmentIds = assignments.map((a) => a.id);

    const [titles, escalations] = await Promise.all([
      this.readSopTitles(sopIds),
      this.readLatestEscalations(assignmentIds),
    ]);

    const projected: SopAssignmentLagItemDto[] = [];
    let droppedUnparseable = 0;
    for (const a of assignments) {
      const since = toIsoOrNull(a.updatedAt);
      // `updatedAt` 是 `@UpdateDateColumn()` NOT NULL，且谓词本身要求它 `<= cutoff`
      // ⇒ 到这里为 null 只可能是脏数据（手工改库 / 驱动返回字符串且不可解析）。
      // 此时**丢弃该行**并置 degraded：编一个假时刻（比如拿 now 顶上）会让前端
      // 渲染出「已阻塞 0 小时」，那是一个具体的假事实。
      if (since === null) {
        droppedUnparseable += 1;
        continue;
      }
      const esc = escalations.value?.get(a.id);
      projected.push({
        assignmentId: a.id,
        sopId: a.sopId,
        // 没有标题 / 标题读不到 ⇒ null。**绝不退回 uuid**：uuid 不是给人看的
        // 标题，前端会把 null 渲染成「（未命名 SOP）」而不是一长串十六进制。
        sopName: titles.value?.get(a.sopId) ?? null,
        status: a.status,
        blockedSince: since,
        staleClarificationId: esc?.clarificationId ?? null,
        // 没有升级澄清（或那批没读到）⇒ null = **未知或无**，不是「第 0 轮」。
        round: esc?.round ?? null,
      });
    }

    const returned = projected.length;
    if (droppedUnparseable > 0) {
      this.logger.warn(
        `lagging: dropped ${droppedUnparseable} row(s) with unparseable updatedAt`,
      );
    }
    const degraded =
      rows.degraded ||
      total.degraded ||
      titles.degraded ||
      escalations.degraded ||
      droppedUnparseable > 0;

    return {
      items: projected,
      total: total.value,
      returned,
      // `total` 未知 ⇒ 只能表达「未知」⇒ false；「未知」这件事由 degraded 说。
      truncated: total.value === null ? false : returned < total.value,
      degraded,
    };
  }

  // ── 子查询 ────────────────────────────────────────────────────────────────

  /**
   * **唯一的谓词来源**：口径 = `status = 'blocked'` **AND** `updatedAt <= cutoff`。
   *
   * ⚠️ 用**原生列名**（带双引号）而不是属性路径：本查询**不用 `take()`**，
   * 走的是普通 `getMany()`（没有 `distinctAlias` 重写），此时 TypeORM 不做属性名
   * → 列名替换 ⇒ 写 `a.updatedAt` 会得到 `column a.updatedAt does not exist`。
   * （R280 那份实现相反：它用了 `take()`，所以必须写属性路径 `c.createdAt`。
   * 两处的写法**故意不同**，理由在各自的 `orderBy`/`take` 上下文里，别统一。）
   *
   * 为什么把窗口放在 SQL 而不是取回后过滤：后者会让窗口外的行**白占**行数上限
   * 预算 ⇒ 明明还有滞留工单却提前 `truncated`。
   */
  private baseQuery(cutoff: Date): SelectQueryBuilder<SopAssignment> {
    return this.assignments
      .createQueryBuilder("a")
      .where("a.status = :status", { status: LAGGING_ASSIGNMENT_STATUS })
      .andWhere('a."updatedAt" <= :cutoff', { cutoff });
  }

  /** 一页滞留工单（卡得最久的在前）。 */
  private async findLagging(cutoff: Date): Promise<SopAssignment[]> {
    return (
      this.baseQuery(cutoff)
        // 原生列名（理由同上）。`updatedAt` 相同时用 `id` 兜底排序：没有稳定
        // 次序的 `LIMIT` 会让「这 200 条」在两次调用之间漂移，截图对不上。
        .orderBy('a."updatedAt"', "ASC")
        .addOrderBy("a.id", "ASC")
        .limit(LAG_ROW_LIMIT)
        .getMany()
    );
  }

  /**
   * 滞留**总数**（独立计数，绝不 `find()` 的长度）。
   *
   * 与 items 走**同一** `baseQuery()` ⇒ 口径不可能漂移。
   */
  private async countLagging(cutoff: Date): Promise<number> {
    return this.baseQuery(cutoff).getCount();
  }

  /**
   * 批量取 SOP 标题（`In(...)`）。
   *
   * 只投影 `id` / `title`：`bodyMarkdown` / `frontMatterJson` 与本端点无关。
   */
  private async readSopTitles(
    sopIds: string[],
  ): Promise<ReadResult<Map<string, string>>> {
    if (sopIds.length === 0) {
      return { value: new Map(), degraded: false };
    }
    return this.read("lagging.sopTitles", async () => {
      const rows = await this.sops.find({
        where: { id: In(sopIds) },
        select: { id: true, title: true },
      });
      const map = new Map<string, string>();
      for (const r of rows) {
        // 空串/纯空白标题视同没有标题（前端不该渲染一个空白的标题行）。
        if (typeof r.title === "string" && r.title.trim() !== "") {
          map.set(r.id, r.title);
        }
      }
      return map;
    });
  }

  /**
   * 批量取「每个指派**最近一条** `escalated_to_human` 澄清」的 id 与轮次。
   *
   * 一次 `In(...)` 取回一批，再在内存里按 `assignmentId` 选 `round` 最大的那条
   * ——**不是**逐行查（N+1 的反证在单测里：指派数从 1 变 3，查询次数不变）。
   *
   * 为什么取「最近一条」而不是「最早一条」：maxRounds 触顶时 `round` 就是
   * `clarificationRound + 1`，多条并存说明工单被打回过不止一次 ⇒ 呈报**最新**
   * 那次更贴近「现在为什么卡着」。轮次本身不进谓词（不回退到「只取最高轮」的
   * 复杂 SQL），因为这里的量级是一条工单几条澄清。
   */
  private async readLatestEscalations(
    assignmentIds: string[],
  ): Promise<
    ReadResult<Map<string, { clarificationId: string; round: number }>>
  > {
    if (assignmentIds.length === 0) {
      return { value: new Map(), degraded: false };
    }
    return this.read("lagging.escalations", async () => {
      const rows = await this.clarifications.find({
        where: {
          assignmentId: In(assignmentIds),
          resolution: ESCALATED_RESOLUTION,
        },
        select: { id: true, assignmentId: true, round: true },
        // 轮次降序 + id 兜底：同轮不可能出现两条（`idx_..._assignmentId_round`
        // 的唯一性由写入方的 CAS 保证），兜底只防同轮脏数据让结果不确定。
        order: { round: "DESC", id: "ASC" },
      });
      const map = new Map<string, { clarificationId: string; round: number }>();
      for (const r of rows) {
        // 降序遍历 ⇒ 第一条即该指派的最大轮次，后续同 assignmentId 的直接跳过。
        if (map.has(r.assignmentId)) continue;
        map.set(r.assignmentId, { clarificationId: r.id, round: r.round });
      }
      return map;
    });
  }

  // ── 基础设施 ──────────────────────────────────────────────────────────────

  /**
   * 装配缺失 ⇒ **显式 503**，绝不回 200 空信封。
   *
   * 只可能发生在测试装配里（生产由 Nest 注入），但「服务不在 ⇒ 返回 0 条滞留」
   * 正是本仓要消灭的那类假事实：运营会以为滞留队列是空的。
   */
  private requireWiring(): void {
    if (!this.assignments || !this.sops || !this.clarifications) {
      throw new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE);
    }
  }

  /**
   * 跑一次子查询，失败 ⇒ `{ value: null, degraded: true }`（**不吞成 0**）。
   *
   * 非有限数同样按失败处理：`NaN` 进了响应体，前端 `null` 判断会全部失效。
   */
  private async read<T>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<ReadResult<T>> {
    try {
      const value = await fn();
      if (typeof value === "number" && !Number.isFinite(value)) {
        this.logger.warn(`assignment lag read produced non-finite: ${label}`);
        return { value: null, degraded: true };
      }
      return { value, degraded: false };
    } catch (err) {
      this.logger.warn(
        `assignment lag read failed: ${label} — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { value: null, degraded: true };
    }
  }
}

/**
 * `Date` / ISO 字符串 ⇒ ISO；不可解析 ⇒ `null`。
 *
 * 单列出来是因为它被**两处**语义共用（行的 `blockedSince` 与「丢弃脏行」的判据），
 * 且 `new Date(x).toISOString()` 会抛 `RangeError`——一个把脏数据变成 500 的
 * 经典写法，必须收在一处挡住。
 */
function toIsoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
