/**
 * R280 · 「升级到人工」澄清的**跨 SOP 聚合读面**（S1）。
 *
 * ## 这个 service 存在的理由（产品问题，不是重构）
 *
 * `sop_clarifications.resolution = 'escalated_to_human'` 是**真实存在**的状态
 * （`sop-clarification.entity.ts` 的 `SOP_CLARIFICATION_RESOLUTIONS`），写入点
 * 在超时兜底扫描（`sop.service.ts` 的 CAS UPDATE）。它表示「执行器按规则把问题
 * 交给人」，但此前**这个人收不到任何能查的东西**，三条独立通道全部失效：
 *
 * | 通道 | 失效方式 |
 * |---|---|
 * | 收件箱七小节 | 完全不涉及 SOP 澄清（无小节读它） |
 * | `status=blocked` 筛选 | **筛不到**：升级后立刻 `blocked → in_progress`（「升级即复核完毕」） |
 * | 升级通知 | 可被 `scope=global` 的静默规则吞掉（`notifyEscalation` 不传 `taskId`） |
 *
 * ⇒ 本端点读**库**、不读通知：它是权威可见面，不受静默规则影响。
 *
 * ## 口径（写死，与 brief §二 D1 逐字一致）
 *
 * 计入：`clarifications.resolution = 'escalated_to_human'`
 *   **AND** 所属 assignment `status NOT IN ('completed','cancelled')`。
 *
 * 为什么不计入 `resolution IS NULL`：那是**等执行器/复核 Agent** 的（机器还没答），
 * 本条是「机器答不了，要你上」。两者不可混淆——混在一起会让「机器正常工作中」
 * 看起来像「有人要你处理」，运营学会忽略之后，真升级也一起被忽略。
 *
 * 为什么排除 `completed` / `cancelled`：工单已交付或已被人取消 ⇒ 「待答复」已无
 * 意义——那是历史，不是待办。`blocked` **刻意不排除**（它正是升级前后的可疑态之一，
 * 且升级路径会把它改走）。
 *
 * ⚠️ **`failed` 也刻意不排除**：它在这里不是「结束」而是「等人接管」——执行器收到
 * `escalated_to_human` 后主动回报 `failed` 并在 `stopMessage` 里写「请在 Admin Web
 * 处理后重派」。逐条理由见 `NON_PENDING_ASSIGNMENT_STATUSES` 上方（**改之前必读**，
 * 那里写了为什么不能把三项终态「统一」回去）。
 *
 * 为什么**无时间窗**：升级澄清没处理就一直挂着，不会自然衰减。加窗口会让
 * 「上周升级还没人管」的东西**消失**——那正是最该被看见的。
 *
 * ## 三条不变量（与 `agent-inbox.service.ts` 同一条纪律）
 *
 * ① `total` 是**独立 `getCount()`**，不是 `items.length`（后者被 `limit` 截断）
 * ② `truncated = returned < total`；`total` 未知时只能 false，「未知」由 `degraded` 说
 * ③ **失败绝不渲染成 0**：任一子查询抛错 ⇒ 对应字段 `null` + `degraded: true`，
 *    HTTP 仍 200（部分可用不等于整页失败）
 *
 * ## 为什么 items 与 total 走**同一个 QueryBuilder 谓词**
 *
 * 口径若在两处各写一遍，改一处忘另一处就会得到「列表 7 行、总数 3」——那正是
 * R278 修掉的那类缺陷（徽标与列表不同源）。故 `baseQuery()` 是**唯一**的谓词来源：
 * items 是它 + `take()`，total 是它 + `getCount()`。
 *
 * ## 为什么是新文件（不挂到 `SopService`）
 *
 * ① `sop.service.ts` 在 `check:size-caps` 的**逐文件只减不增**基线上**顶格**
 *    （注释里已写明「下次再加必须先外提」）⇒ 就地新增必然破顶；
 * ② 职责不同：那是「SOP 的读写与状态机」，这里是「**为收件箱做只读聚合**」，
 *    且需要同时读三个域（澄清 / 指派 / SOP）；
 * ③ controller 只加一条薄路由，回滚是单文件级。
 *
 * ## 错误码选择（不新造码）
 *
 * 装配缺失（`@Optional()` 注入为 null，只可能发生在测试装配里）⇒ 抛既有
 * `DEPENDENCY_UNAVAILABLE`（503，文案「依赖服务暂不可用，请稍后重试」）。
 * 该通用码的文案**不断言任何具体结论**，用在「聚合不可用」上语义正确；新造码
 * 需要跑 `gen-error-i18n` 重生成物，本轮不做。
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
  SopPendingClarificationItemDto,
  SopPendingClarificationsResponseDto,
} from "./sop-clarification-inbox.dto";

/**
 * `limit` 的钳制面（1..200，默认 100）——与 `GET /agent/approvals/pending`
 * 同一组数（两端点都是「待办行」）。
 *
 * 为什么**不** import `agent-pagination.ts` 的 `clampPagination`：那是 agent
 * 模块的分页钳制（`pageSize` 上限 100、语义是「翻页」）。跨模块 import 会造出
 * 一条 sop → agent 的**运行时耦合**，而 sop 模块只在装配期经 forwardRef 依赖
 * agent 模块——为一个小纯函数引入新耦合不划算。判据本身只有三行，抄的是**判据**
 * 不是**实现**（本文件单测逐条钉住它）。
 */
export const SOP_PENDING_CLARIFICATION_LIMIT_MAX = 200;
export const SOP_PENDING_CLARIFICATION_LIMIT_DEFAULT = 100;

/** 计入「待人工答复」的澄清处置态（**唯一一个**，不是「所有非 NULL」）。 */
const ESCALATED_RESOLUTION = "escalated_to_human" as const;

/**
 * 排除的 assignment 状态（**只有这两项**，且刻意与「终态三项」不同）。
 *
 * ## 逐项理由（这段是下一个改这里的人最该读的）
 *
 *   · `completed` —— 工单已交付，升级澄清已成历史 ⇒ 不该再占待办；
 *   · `cancelled` —— 人主动取消 ⇒ 已决定，不是待办；
 *   · **`failed` 刻意不在内**（见下，别把它「修正」回去）。
 *
 * ## 为什么 `failed` 必须**计入**（本文件最容易改错的一处）
 *
 * 直觉上 `failed` 是终态，但它在这里不是「结束」而是「**等人接管**」：
 *
 *   · `SopService.completeAssignment` 只「落账、不做验收判定」——它不区分
 *     语义上的成功/失败，`failed` 只是执行器回报的一个状态值；
 *   · 执行器在 `apps/executor-desktop/src/main/agent/agent-host.ts` 收到
 *     `escalated_to_human` 后**主动**回报 `status: 'failed'` +
 *     `outcome: 'escalated_to_human'`，`stopMessage` 逐字写着「澄清已升级人工，
 *     无自动答复——请在 Admin Web 处理后重派」。
 *
 * ⇒ **执行器报的 `failed` 恰恰是「请运维去 Admin Web 处理」这个动作的触发条件。**
 *   把它排除，那个入口就不存在了：这条升级澄清在收件箱没有、按 `blocked` 筛不到
 *   （升级后已 `blocked → in_progress`）、通知又可被 `scope=global` 静默规则吞掉
 *   ——**三通道全失效 = 本端点要消灭的缺陷本身**。
 *
 * 判据来源：与既有 `completed/failed/cancelled` 三项终态**刻意不同**（那三处是
 * 「这张单还活不活」的判据，本处是「还有没有人要为此动手」的判据——同一个词在
 * 两个问题下答案相反）。别看到不一致就统一回去：真机已复核，统一会让待办消失。
 *
 * ## ⚠️ 别改成「活跃白名单」
 *
 * `SOP_ASSIGNMENT_STATUSES` 有 7 个值，写成活跃白名单（`assigned/in_progress/...`）
 * 时，将来加一个新的进行中状态（比如 `paused`）会让它**静默漏出**待办面。
 * 黑名单则只会让新状态默认**可见**（多显示优于少显示——漏掉的升级澄清没有任何
 * 别的地方能看到）。**只删这一项，形态不动。**
 */
const NON_PENDING_ASSIGNMENT_STATUSES = ["completed", "cancelled"] as const;

/**
 * 把外部传进来的 `limit` 钳到 `[1, 200]`。
 *
 * NaN / ±Infinity 守卫：HTTP 层 `parseInt("abc") = NaN` 会穿透 `Math.max/Math.min`
 * （`Math.max(1, NaN) = NaN`），NaN 直达 `take` 会炸 500。非有限数一律视同未传
 * ⇒ 回落默认值，**不是 400**（本仓既有契约是「非法深链安全回落、绝不 400」）。
 *
 * 小数（`limit=3.9`）按 `Math.trunc` 取整，与 `clampPendingApprovalLimit` 同款：
 * `take` 收到小数在不同驱动下行为不一致，统一截断比让数据库决定更可预测。
 */
export function clampPendingClarificationLimit(raw?: number | null): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return SOP_PENDING_CLARIFICATION_LIMIT_DEFAULT;
  }
  return Math.min(
    SOP_PENDING_CLARIFICATION_LIMIT_MAX,
    Math.max(1, Math.trunc(raw)),
  );
}

/** 一次子查询的结果：`value === null` 恒表示**未知**（读失败），而不是 0。 */
interface ReadResult<T> {
  value: T | null;
  degraded: boolean;
}

@Injectable()
export class SopClarificationInboxService {
  private readonly logger = new Logger(SopClarificationInboxService.name);

  constructor(
    /**
     * 澄清仓储（聚合的数据源 + 谓词锚点）。
     *
     * `@Optional()` + **末位**：既有 spec 用**定位参数**装配 `SopController`
     * （`new SopController(sops, media, executors)`），插在中间会让它们全部错位。
     * 缺席 ⇒ 方法入口显式抛 503，**不**返回空信封。
     */
    @Optional()
    @InjectRepository(SopClarification)
    private readonly clarifications?: Repository<SopClarification> | null,
    /** 指派仓储：取当前 `status`（如实回给前端）。 */
    @Optional()
    @InjectRepository(SopAssignment)
    private readonly assignments?: Repository<SopAssignment> | null,
    /** SOP 仓储：批量取标题（`In(...)`，消除 N+1）。 */
    @Optional()
    @InjectRepository(Sop)
    private readonly sops?: Repository<Sop> | null,
  ) {}

  /**
   * `GET /sop/clarifications/pending`：跨 SOP 的升级澄清聚合。
   *
   * 查询次数固定为 ≤3（不随行数增长）：
   *   ① items（`baseQuery()` + `take()`）
   *   ② total（同一 `baseQuery()` + `getCount()`）
   *   ③ 批量 SOP 标题（`In(sopIds)`）
   */
  async pending(
    input: {
      limit?: number | null;
    } = {},
  ): Promise<SopPendingClarificationsResponseDto> {
    this.requireWiring();

    const limit = clampPendingClarificationLimit(input.limit);

    // items 与 total 并行发：彼此不依赖，串行会白等一个往返。
    const [rows, total] = await Promise.all([
      this.read("pending.items", () => this.findPendingClarifications(limit)),
      this.read("pending.total", () => this.countPendingClarifications()),
    ]);

    const clarifications = rows.value ?? [];
    // 指派状态是逐行展示字段（不是筛选项——筛选已在 `baseQuery()` 的 join 里做完）。
    const assignments = await this.readAssignments([
      ...new Set(clarifications.map((c) => c.assignmentId)),
    ]);
    const sopIds = [...new Set((assignments.value ?? []).map((a) => a.sopId))];
    const titles = await this.readSopTitles(sopIds);

    const byAssignment = new Map(
      (assignments.value ?? []).map((a) => [a.id, a]),
    );

    const projected: SopPendingClarificationItemDto[] = [];
    for (const c of clarifications) {
      const a = byAssignment.get(c.assignmentId);
      // 指派这批**读失败** ⇒ `assignments.value === null` ⇒ 行无法装配（没有
      // sopId/status）。此时由 `degraded` 说「这批没读到」，items 留空 —— 但
      // 绝不把「读失败」渲染成「没有行」的结论：`total` 走独立计数，仍然是数字。
      if (!a) continue;
      projected.push({
        clarificationId: c.id,
        assignmentId: c.assignmentId,
        sopId: a.sopId,
        // 没有标题 / 标题读不到 ⇒ null。**绝不退回 uuid**：uuid 不是给人看的
        // 标题，前端会把 null 渲染成「（未命名 SOP）」而不是一长串十六进制。
        sopName: titles.value?.get(a.sopId) ?? null,
        round: c.round,
        // 原样透出不截断：截断是**渲染**决策（前端按可视宽度做），服务端截断会让
        // 「点开看全文」永远拿不到全文。
        question: c.question,
        askedAt: c.createdAt.toISOString(),
        assignmentStatus: a.status,
        reviewSessionId: c.reviewSessionId ?? null,
      });
    }

    const returned = projected.length;
    const degraded =
      rows.degraded ||
      total.degraded ||
      assignments.degraded ||
      titles.degraded;

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
   * **唯一的谓词来源**：口径 = `resolution = escalated_to_human`
   * **AND** 所属 assignment 不是 `completed` / `cancelled`（⚠️ `failed` 计入，
   * 理由见 `NON_PENDING_ASSIGNMENT_STATUSES` 上方）。
   *
   * 用 `innerJoin` 而不是 `IN (SELECT ...)` 子查询：本仓实体间刻意不建 FK 关系
   * （跨模块引用用可空列 + 索引），`relations` 在这里没有可用的关系元数据，
   * 手写 `on` 条件是可读且可测的做法（`projects.service.ts` 的
   * `innerJoin(Task, "t", …)` 同款）。
   *
   * 排除放在 join 的 `andWhere` 里（不是取回后再过滤）：后者会让已结束的行
   * **白占 `limit` 预算** ⇒ 明明还有待办却提前 `truncated`。
   */
  private baseQuery(): SelectQueryBuilder<SopClarification> {
    return this.clarifications
      .createQueryBuilder("c")
      .innerJoin(SopAssignment, "a", 'a."id" = c."assignmentId"')
      .where("c.resolution = :resolution", {
        resolution: ESCALATED_RESOLUTION,
      })
      .andWhere("a.status NOT IN (:...nonPendingStatuses)", {
        nonPendingStatuses: [...NON_PENDING_ASSIGNMENT_STATUSES],
      });
  }

  /** 一页升级澄清（最久没人管的在前）。 */
  private async findPendingClarifications(
    limit: number,
  ): Promise<SopClarification[]> {
    return (
      this.baseQuery()
        // 最久没人管的排在前面：「上周升级还没人管」是最该被看见的那一条。
        // ⚠️ 用**属性路径** `c.createdAt`，不要写 `c."createdAt"`：带 `take()`
        // 的 `getMany()` 会走 `distinctAlias` 重写（先把 id 分页取回再取实体），
        // 而重写只认属性路径——写成原生列名会得到 `distinctAlias.c_"createdAt"`
        // 这种不存在的列（真机实测：`column distinctAlias.c_"createdAt" does not exist`）。
        .orderBy("c.createdAt", "ASC")
        .take(limit)
        .getMany()
    );
  }

  /**
   * 待办**总数**（独立计数，绝不 `find()` 的长度）。
   *
   * `getCount()` 与 items 走**同一** `baseQuery()` ⇒ 口径不可能漂移；
   * 而 `find().length` 有 `take` 上限，会让「被 limit 截断」与「一共就这么多」同形。
   */
  private async countPendingClarifications(): Promise<number> {
    return this.baseQuery().getCount();
  }

  /**
   * 批量取指派（`In(...)`）：一次查询拿回 `sopId` + 当前 `status`。
   *
   * 只投影 `id` / `sopId` / `status`：`resultJson` / `progressJson` /
   * `capabilitySnapshotJson` 与本端点无关，搬出来只是把大字段塞进响应路径。
   */
  private async readAssignments(
    assignmentIds: string[],
  ): Promise<ReadResult<SopAssignment[]>> {
    if (assignmentIds.length === 0) {
      return { value: [], degraded: false };
    }
    return this.read("pending.assignments", () =>
      this.assignments.find({
        where: { id: In(assignmentIds) },
        select: { id: true, sopId: true, status: true },
      }),
    );
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
    return this.read("pending.sopTitles", async () => {
      const rows = await this.sops.find({
        where: { id: In(sopIds) },
        select: { id: true, title: true },
      });
      const map = new Map<string, string>();
      for (const r of rows) {
        // 空串/空白标题视同没有标题（前端不该渲染一个空白的标题行）。
        if (typeof r.title === "string" && r.title.trim() !== "") {
          map.set(r.id, r.title);
        }
      }
      return map;
    });
  }

  // ── 基础设施 ──────────────────────────────────────────────────────────────

  /**
   * 装配缺失 ⇒ **显式 503**，绝不回 200 空信封。
   *
   * 只可能发生在测试装配里（生产由 Nest 注入），但「服务不在 ⇒ 返回 0 条待办」
   * 正是本仓要消灭的那类假事实：运营会以为没有升级在等人。
   */
  private requireWiring(): void {
    if (!this.clarifications || !this.assignments || !this.sops) {
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
        this.logger.warn(
          `clarification inbox read produced non-finite: ${label}`,
        );
        return { value: null, degraded: true };
      }
      return { value, degraded: false };
    } catch (err) {
      this.logger.warn(
        `clarification inbox read failed: ${label} — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { value: null, degraded: true };
    }
  }
}
