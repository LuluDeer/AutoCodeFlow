/**
 * R278 · 待办收件箱的**服务端聚合**（S1）。
 *
 * ## 为什么需要这个 service（产品问题，不是重构）
 *
 * 运营的日常动作是「进待办，把等人处置的活干完」。此前这条路径由**前端**拼出来
 * （`apps/admin-web/src/api/inbox.ts`）：先拉 50 个 `waiting_input` 会话，再**逐个**
 * 拉审批单。三个可感知缺陷同一个根因：
 *
 * | 现象 | 根因 |
 * |---|---|
 * | 顶栏「3」而列表「7」行 | 徽标按**会话**计、列表按**审批单**行计（同一会话可多单） |
 * | 第 51 个之后的会话凭空消失 | 取 50 个会话后客户端聚合，截断**无标记** |
 * | 转圈很久 / 偶发「读取失败」 | 51 次请求落在同一个 60/min 限流桶里 |
 *
 * 把聚合搬到服务端 ⇒ 一次请求拿到「审批单行 + 两个计数 + 截断标记 + 降级标记」。
 *
 * ## 三条不变量（本文件的全部价值都在这三条上）
 *
 * ① **`total` 必须是独立计数，不是 `items.length`**。审批单总数走 `count()`，
 *    会话数走 `COUNT(DISTINCT sessionId)`；`find()` 的长度只是 `returned`。
 *    （把 `items.length` 当 total 会让「被 limit 截断」与「一共就这么多」同形。）
 * ② **`truncated = returned < total`**；`total` 未知时 truncated 只能是 false，
 *    而「未知」由 `degraded` 表达 —— 三个字段各自只说自己的事。
 * ③ **失败绝不渲染成 0**：任一子查询抛错 ⇒ 该字段 `null` + `degraded: true`，
 *    HTTP 仍 200（部分可用）。「没读到」渲染成「没有」是本仓主导缺陷类。
 *
 * ## 为什么是新文件（不挂到 `AgentApprovalsService` / `AgentSessionService`）
 *
 * ① 两个既有文件都在 `check:size-caps` 的**逐文件只减不增**基线上（approvals 服务
 *    亦在其中）⇒ 就地新增必然破顶；② 职责不同：那是「审批单的写面 / 会话的读写」，
 *    这里是「**为收件箱做只读聚合**」，且要同时读 4 个域（审批单、会话、队列、部署）；
 * ③ controller 只加两条薄路由，回滚是单文件级。
 *
 * ## 错误码选择（不新造码）
 *
 * 装配缺失（`@Optional()` 注入为 null，只可能发生在测试装配里）⇒ 抛既有
 * `DEPENDENCY_UNAVAILABLE`（503，文案「依赖服务暂不可用，请稍后重试」）。
 * 为什么不复用三条 `AGENT_*_CHECK_UNAVAILABLE`：那三条的文案分别断言了
 * 「这不代表没有积压 / 队列正常 / 队列在正常消费」——用在「收件箱聚合不可用」
 * 上会**说一句错的事实**。通用码的文案自足且不断言任何具体结论，语义正确。
 * 新造码需要跑 `gen-error-i18n` 重生成物，本轮不做。
 */
import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { In, MoreThanOrEqual, Repository } from "typeorm";

import { AppError } from "../../../common/errors/app-error";
import { ErrorCode } from "../../../common/errors/error-codes";
import type { AuthUser } from "../../../common/interfaces/auth-user.interface";
import { UserRole } from "../../users/entities/user.entity";
import { AppDeploymentService } from "../../application/app-deployment.service";
import { DeploymentApprovalStatus } from "../../application/entities/app-deployment.entity";
import { AgentApproval } from "../entities/agent-approval.entity";
import { AgentSession } from "../entities/agent-session.entity";
import type {
  AgentInboxCountsResponseDto,
  AgentPendingApprovalItemDto,
  AgentPendingApprovalsResponseDto,
} from "../dto/agent-inbox.dto";
import { AgentBacklogService } from "./agent-backlog.service";
import { AgentQueueStallService } from "./agent-queue-stall.service";
import { AgentSessionService } from "./agent-session.service";

/**
 * `limit` 的钳制面（1..200，默认 100）。
 *
 * 为什么**不**复用 `clampPagination`：那是会话列表的分页钳制（`pageSize` 上限
 * **100**，语义是「翻页」）。审批单是**待办行**，上限 200 与原前端请求的
 * `pageSize: 200` 一致；共用会连带把 `page` 语义拖进来，且 `agent-pagination.ts`
 * 被 3 处依赖、动它就是动别人的契约。
 */
export const PENDING_APPROVAL_LIMIT_MAX = 200;
export const PENDING_APPROVAL_LIMIT_DEFAULT = 100;

/**
 * 把外部传进来的 `limit` 钳到 `[1, 200]`。
 *
 * NaN / ±Infinity 守卫（与 `clampPagination` 同款理由）：HTTP 层
 * `parseInt("abc") = NaN` 会穿透 `Math.max/Math.min`（`Math.max(1, NaN) = NaN`），
 * NaN 直达 `take` 会炸 500。非有限数一律视同未传 ⇒ 回落默认值，**不是 400**
 * （保持「非法深链安全回落」的既有契约）。
 */
export function clampPendingApprovalLimit(raw?: number | null): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return PENDING_APPROVAL_LIMIT_DEFAULT;
  }
  return Math.min(PENDING_APPROVAL_LIMIT_MAX, Math.max(1, Math.trunc(raw)));
}

/**
 * R279：失败会话统计窗口的**默认值**（小时）。
 *
 * 为什么是 24h：收件箱是「**今天要处理的**」，不是全 history（判据推导见
 * `docs/observability/agent-failed-session-criterion.md` §2.2）。没有窗口时一个跑了
 * 三个月的部署会累积到几千 ⇒ 徽标变成永远巨大的数字 ⇒ 运营学会忽略它。
 * 窗口外的东西在会话列表按状态筛选仍查得到，收件箱不必承担那个职责。
 */
export const FAILED_SESSION_WINDOW_HOURS_DEFAULT = 24;

/**
 * 把配置读到的窗口小时数收敛成**可用的正数**（非法/缺失 ⇒ 默认 24）。
 *
 * ⚠️ 与 `failedSessions` 的失败语义**刻意相反**：`failedSessions` 读不到必须回
 * `null`（「没读到」≠「没有」）；而窗口小时数是**配置**不是**事实** —— 它有一个
 * 确定的默认值，回 `null` 只会让 UI 无法渲染「近 N 小时」这句本来就能说的话。
 * 两者的区别是「事实 vs 约定」，不是「重要 vs 不重要」。
 */
export function resolveFailedWindowHours(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return FAILED_SESSION_WINDOW_HOURS_DEFAULT;
  return Math.trunc(n);
}

/** 计入「失败待办」的会话状态。`aborted` **刻意不在内**（见判据文档 §2.1）。 */
const FAILED_SESSION_STATUSES = ["failed", "budget_exceeded"] as const;

/** 一次子查询的结果：`value === null` 恒表示**未知**（读失败），而不是 0。 */
interface ReadResult<T> {
  value: T | null;
  degraded: boolean;
}

/**
 * GCO §5「待我审批」的只读视域：`sessionIds === null` = 全量（ADMIN / 内部调用），
 * 数组（含空数组）= 只认这些会话；`unknown` = 归属读失败，事实未知，**绝不**回落到全量。
 */
interface ViewerScope {
  sessionIds: string[] | null;
  unknown: boolean;
  degraded: boolean;
}

/** 会话归属列的既有取值形如 `user:<username>`，兼容历史 `user:<id>` / 裸值。 */
function viewerOwnerTokens(viewer: AuthUser): string[] {
  const tokens = new Set<string>();
  const username =
    typeof viewer.username === "string" ? viewer.username.trim() : "";
  if (username) {
    tokens.add(username);
    tokens.add(`user:${username}`);
  }
  if (viewer.id !== undefined && viewer.id !== null) {
    const id = String(viewer.id);
    tokens.add(id);
    tokens.add(`user:${id}`);
  }
  return [...tokens];
}

/**
 * 空可见视域用的**类型正确**哨兵：全零 uuid。
 *
 * 为什么不能用裸字符串（`'__no_visible_session__'`）：`agent_approvals.sessionId`
 * 是 `uuid` 列（`1790000000040-AddAgentRuntimeTables.ts`），裸字符串进 `In(...)`
 * 会被 PG 在**参数解析期**直接拒掉 —— `invalid input syntax for type uuid`。后果是
 * `items` / `total` / `sessionTotal` 三个子查询一起失败 ⇒ 全 null + `degraded: true`，
 * 把「这个用户一条待办都没有」渲染成「读不到」。事实是**零条**，不是读不到。
 * 全零 uuid 是合法 uuid 字面量且不可能出现在 `gen_random_uuid()` 生成的主键里，
 * 语义等价于 `1=0`，同时保住「谓词只有一个构造点」。
 */
export const NO_VISIBLE_SESSION_ID = "00000000-0000-0000-0000-000000000000";

/** items / total / sessionTotal / counts 共用的**唯一**谓词构造点。 */
function pendingWhere(scope: ViewerScope) {
  return {
    status: "pending" as const,
    scope: "once" as const,
    ...(scope.sessionIds
      ? {
          sessionId: In(
            scope.sessionIds.length
              ? scope.sessionIds
              : [NO_VISIBLE_SESSION_ID],
          ),
        }
      : {}),
  };
}

@Injectable()
export class AgentInboxService {
  private readonly logger = new Logger(AgentInboxService.name);

  constructor(
    /**
     * 审批单仓储（聚合的数据源）。
     *
     * `@Optional()`：本 service 是**新增** provider，既有 spec 用定位参数装配
     * `AgentController`（R202/R205/R207 三次教训：改必填参数会让既有文件整片
     * 错位）。缺席 ⇒ 方法入口显式抛 503，**不**返回空信封。
     */
    @Optional()
    @InjectRepository(AgentApproval)
    private readonly approvals?: Repository<AgentApproval> | null,
    /** 会话仓储（批量取标题，消除 N+1）。缺席 ⇒ 同上。 */
    @Optional()
    @InjectRepository(AgentSession)
    private readonly sessionRepo?: Repository<AgentSession> | null,
    /**
     * 会话服务：「等待输入」与「卡住」两个计数复用它的**既有判据**
     * （`buildStalledPredicate` + 钳制），不在这里抄第二份口径。
     */
    @Optional()
    private readonly sessionService?: AgentSessionService | null,
    /** 积压对账（判据见 `docs/observability/agent-backlog-criterion.md`）。 */
    @Optional()
    private readonly backlog?: AgentBacklogService | null,
    /** 队列停摆观测（判据见 `docs/observability/agent-queue-stall-criterion.md`）。 */
    @Optional()
    private readonly queueStall?: AgentQueueStallService | null,
    /** 部署审批待办计数（DEP-04 的既有查询面，`take: 1` 只为拿 `total`）。 */
    @Optional()
    private readonly deployments?: AppDeploymentService | null,
    /**
     * R279：配置面（失败会话的统计窗口 `agent.failedSessionWindowHours`）。
     *
     * ⚠️ **同样放在末位且 `@Optional`**：既有 spec 用定位参数装配本 service，
     * 插在中间会让它们全部错位（与前面几个依赖同一纪律）。缺席 ⇒ 窗口回落默认
     * 24h（**不**抛 503）—— 窗口是配置，缺它仍能给出正确的失败计数。
     */
    @Optional()
    private readonly config?: ConfigService | null,
  ) {}

  /**
   * 解析 viewer 的会话视域。**只读**：仅查 `AgentSession.createdBy`，
   * 不新增字段、不写任何审批/会话行。ADMIN 短路全量；归属读失败时 fail-closed。
   */
  private async resolveViewerScope(
    viewer?: AuthUser | null,
  ): Promise<ViewerScope> {
    if (!viewer || viewer.role === UserRole.ADMIN) {
      return { sessionIds: null, unknown: false, degraded: false }; // mutation-residue-ok: fail-closed 视域常量非变异体
    }
    const tokens = viewerOwnerTokens(viewer);
    if (tokens.length === 0) {
      return { sessionIds: [], unknown: true, degraded: true }; // mutation-residue-ok: fail-closed 视域常量非变异体
    }
    const owned = await this.read("pending.viewerSessions", async () => {
      const rows = await this.sessionRepo.find({
        where: { createdBy: In(tokens) },
        select: { id: true, createdBy: true },
      });
      return rows.map((r) => r.id).filter((id) => typeof id === "string");
    });
    return owned.value === null
      ? { sessionIds: [], unknown: true, degraded: true } // mutation-residue-ok: fail-closed 视域常量非变异体
      : { sessionIds: owned.value, unknown: false, degraded: owned.degraded };
  }

  /**
   * `GET /agent/approvals/pending`：待审批单的**跨会话**聚合。
   *
   * 查询次数固定为 ≤4（不随会话数增长）：① items、② total、③ 会话数、④ 批量标题。
   * 原前端实现是 `1 + N`（每会话一次审批单请求）。
   *
   * GCO §5：`viewer` 非 ADMIN 时先按 `AgentSession.createdBy` 取本人会话，
   * 再用同一个谓词贯穿 items / total / sessionTotal / truncated —— 徽标与列表同源。
   */
  async pending(
    input: {
      limit?: number | null;
      viewer?: AuthUser | null;
    } = {},
  ): Promise<AgentPendingApprovalsResponseDto> {
    this.requireWiring();

    const scope = await this.resolveViewerScope(input.viewer);
    if (scope.unknown) {
      // 归属未知 ⇒ 一条都不能露，且事实不能伪装成 0（与 read() 的纪律一致）。
      return {
        items: [],
        total: null, // mutation-residue-ok: fail-closed 视域常量非变异体
        sessionTotal: null,
        returned: 0,
        truncated: false, // mutation-residue-ok: fail-closed 视域常量非变异体
        degraded: true, // mutation-residue-ok: fail-closed 视域常量非变异体
      };
    }

    const limit = clampPendingApprovalLimit(input.limit);
    const where = pendingWhere(scope);

    // 三个独立查询并行发：彼此不依赖，串行会白等两个往返。
    const [items, total, sessionTotal] = await Promise.all([
      this.read("pending.items", () =>
        this.approvals.find({
          where,
          // 最久等待的在前：待办列表的排序语义（与 `listForSession` 的 ASC 一致）。
          order: { createdAt: "ASC" },
          take: limit,
        }),
      ),
      this.read("pending.total", () => this.approvals.count({ where })),
      this.read("pending.sessionTotal", () =>
        this.countPendingSessions(scope.sessionIds),
      ),
    ]);

    // 二次拦截：即使仓储谓词意外漏过滤，也不会把他人 reason/preview 投影出去。
    const rows = (items.value ?? []).filter(
      (r) => !scope.sessionIds || scope.sessionIds.includes(r.sessionId),
    );
    const sessionIds = [...new Set(rows.map((r) => r.sessionId))];
    // 一次 `In(...)` 批量取标题 ⇒ 查询数与会话数**无关**（消除 N+1）。
    const titles = await this.readTitles(sessionIds);

    const projected: AgentPendingApprovalItemDto[] = rows.map((row) => ({
      approvalKey: row.approvalKey,
      sessionId: row.sessionId,
      // 没有标题 / 标题读不到 ⇒ null。**绝不退回 uuid**：uuid 不是给人看的标题，
      // 前端会把 null 渲染成「（未命名会话）」而不是一长串十六进制。
      sessionTitle: titles.value?.get(row.sessionId) ?? null,
      toolName: row.toolName,
      reason: row.reason ?? null,
      createdAt: row.createdAt.toISOString(),
      // 既有实体列，写入侧已脱敏 + 已截断（`sanitizeArgs`）⇒ 直接透出，
      // **不新增序列化逻辑**（第二套脱敏规则迟早与第一套漂移）。
      preview: row.preview ?? null,
      argsDigest: row.argsDigest ?? null,
    }));

    const returned = projected.length;
    const degraded =
      scope.degraded ||
      items.degraded ||
      total.degraded ||
      sessionTotal.degraded ||
      titles.degraded;

    return {
      items: projected,
      total: total.value,
      sessionTotal: sessionTotal.value,
      returned,
      // `total` 未知 ⇒ 只能表达「未知」⇒ false；「未知」这件事由 degraded 说。
      truncated: total.value === null ? false : returned < total.value,
      degraded,
    };
  }

  /**
   * `GET /agent/inbox/counts`：顶栏徽标的唯一计数源。
   *
   * 六个计数并行读，各自独立降级：任一读失败只让**那一个**字段变 null。
   * 全部读不到才算整体不可用 —— 但那时 `requireWiring()` 已经在入口抛出（装配
   * 缺失），DB 抖动则仍返回 null 信封 + `degraded: true`（HTTP 200）。
   *
   * GCO §5：非 ADMIN viewer 的 `pendingApprovals` 与 `/approvals/pending` 共用
   * `pendingWhere(scope)`；归属未知时该字段为 null（未知 ≠ 0），其它计数不受影响。
   */
  async counts(
    input: { viewer?: AuthUser | null } = {},
  ): Promise<AgentInboxCountsResponseDto> {
    this.requireWiring();

    const scope = await this.resolveViewerScope(input.viewer);
    // W1-S2：waiting/stalled/failed 是**全局运营计数**，只对 ADMIN（或内部无
    // viewer 调用）可见；普通用户看到 null=不适用，不泄露全平台会话规模。
    const adminOnly = !input.viewer || input.viewer.role === UserRole.ADMIN;

    // 窗口先解析：两个新字段都要用它，且它是**配置**（同步可读）⇒ 不必进
    // `Promise.all`，也不会成为降级来源（读不到就回默认，见 resolveFailedWindowHours）。
    const failedWindowHours = resolveFailedWindowHours(
      this.config?.get("agent.failedSessionWindowHours"),
    );

    const [
      pendingApprovals,
      waitingSessions,
      stalled,
      backlog,
      stall,
      deploymentCount,
      failedSessions,
    ] = await Promise.all([
      // 口径 = **审批单**（与 `/approvals/pending` 的 total **同一谓词**，
      // 否则徽标与列表又会不等 —— D1 的全部意义就在这里）。
      scope.unknown
        ? { value: null, degraded: true } // mutation-residue-ok: fail-closed 视域常量非变异体
        : await this.read("counts.pendingApprovals", () =>
            this.approvals.count({ where: pendingWhere(scope) }),
          ),
      // W1-S2：非 ADMIN 不查这些全局计数，返回 null（不适用，非 0）。
      !adminOnly
        ? { value: null, degraded: false }
        : this.read("counts.waitingSessions", () =>
            this.sessionsTotal({ status: "waiting_input" }),
          ),
      // 判据复用既有 `list({stalled})`：`getManyAndCount` 的 COUNT 就是独立计数，
      // `pageSize: 1` 只为拿 total（不搬行体）。
      !adminOnly
        ? { value: null, degraded: false }
        : this.read("counts.stalled", () => this.sessionsTotal({ stalled: {} })),
      // 一次性把「条数 + 截断位」拿回来：截断位必须与条数**同源**，否则并发下
      // 一个请求的 `backlogged=3` 可能配上另一个请求的 `truncated`。
      this.read("counts.backlogged", () => this.backlog.findBacklogged()),
      this.read("counts.queueStall", () => this.findQueueStall()),
      this.read("counts.deployments", () => this.findPendingDeployments()),
      // R279：窗口内的失败会话（`failed` + `budget_exceeded`，**不含 `aborted`**）；
      // W1-S2：普通用户不查（全局运营计数，null=不适用）。
      !adminOnly
        ? { value: null, degraded: false }
        : this.read("counts.failedSessions", () =>
            this.countFailedSessions(failedWindowHours),
          ),
    ]);

    return {
      pendingApprovals: pendingApprovals.value,
      waitingSessions: waitingSessions.value,
      stalled: stalled.value,
      backlogged: backlog.value?.count ?? null,
      // `backlogged` 是**下界**时必须说清（对账有探测上限 200）——
      // 否则运营把 `3` 读成「一共就 3 条」。读失败时 false（未知不是「没截断」，
      // 那一层由 `backlogged: null` + `degraded` 表达）。
      backlogTruncated: backlog.value ? !!backlog.value.truncated : false,
      deployments: deploymentCount.value,
      queueStall: stall.value,
      // R279：**独立显示项**，不参与任何会话求和（D3：同一会话可能窗口内先
      // failed 后被重跑成 succeeded，相加会重复计同一份历史）。
      failedSessions: failedSessions.value,
      // 配置而非事实 ⇒ 恒为数字，永不 null（读不到回默认 24）。
      failedWindowHours,
      degraded:
        scope.degraded ||
        pendingApprovals.degraded ||
        waitingSessions.degraded ||
        stalled.degraded ||
        backlog.degraded ||
        stall.degraded ||
        deploymentCount.degraded ||
        failedSessions.degraded,
    };
  }

  // ── 子查询 ────────────────────────────────────────────────────────────────

  /**
   * `COUNT(DISTINCT sessionId)` —— 待审批单涉及多少个会话。
   *
   * 为什么不能用 `items.length` 之后 `new Set()` 的长度：条数被 `limit` 截断时
   * 会话数同样被截断，而它的用途恰恰是「徽标口径差多少」的对账数字。
   *
   * `sessionIds` 与 items/total 同源：非 ADMIN viewer 只数自己会话的待审单。
   */
  private async countPendingSessions(
    sessionIds: string[] | null,
  ): Promise<number> {
    const qb = this.approvals
      .createQueryBuilder("a")
      .select("COUNT(DISTINCT a.sessionId)", "n")
      .where("a.status = :status", { status: "pending" })
      .andWhere("a.scope = :scope", { scope: "once" });
    if (sessionIds) {
      // 空视域用**类型正确**的全零 uuid 哨兵（`NO_VISIBLE_SESSION_ID`）：裸字符串
      // 进 `uuid` 列比较会在 PG 参数解析期抛 `invalid input syntax for type uuid`，
      // 把「零条」渲染成「读不到」（degraded）。全零 uuid 合法且不可能命中真行。
      qb.andWhere("a.sessionId IN (:...sessionIds)", {
        sessionIds: sessionIds.length ? sessionIds : [NO_VISIBLE_SESSION_ID],
      });
    }
    const row = await qb.getRawOne<{ n: string | number }>();
    const n = Number(row?.n);
    if (!Number.isFinite(n)) {
      // 计数查询必然返回一行；拿不到就是读失败 ⇒ 交给 `read()` 转成 null。
      // ⚠️ 这行只是**内部诊断理由**（进日志），不是用户文案：不出现散文英文。
      throw new Error("distinct-count-unusable");
    }
    return n;
  }

  /** 会话计数（复用 `AgentSessionService.list` 的既有判据与钳制）。 */
  private async sessionsTotal(options: {
    status?: string;
    stalled?: { minutes?: number };
  }): Promise<number> {
    const res = await this.sessionService.list({
      // `status` 的枚举收窄在 service 内部（`createQueryBuilder` 的 where 参数化）
      status: options.status as never,
      stalled: options.stalled,
      page: 1,
      pageSize: 1,
    });
    return res.total;
  }

  /**
   * 队列停摆三态：`1` / `0` / `null`。
   *
   * `degraded` 的判定**不完整** ⇒ 必须回 null，不能回 0（「没判定」≠「正常」）。
   */
  private async findQueueStall(): Promise<number> {
    const report = await this.queueStall.inspect();
    if (report.degraded) {
      // 不完整判定 ≠ 正常。抛出去让 `read()` 统一记 degraded + null。
      // ⚠️ 内部诊断理由（进日志），不是用户文案。
      throw new Error("queue-stall-degraded");
    }
    return report.stalled ? 1 : 0;
  }

  /** 待审批的部署数（`take: 1` 只为拿 `total`，不搬行体）。 */
  private async findPendingDeployments(): Promise<number> {
    const res = await this.deployments.findAll(
      undefined,
      1,
      1,
      DeploymentApprovalStatus.PENDING_APPROVAL,
    );
    return res.total;
  }

  /**
   * R279：窗口内失败会话数。
   *
   * **独立 `count()`，绝不 `find().length`** —— 与 `countPendingSessions` /
   * `findPendingDeployments` 同一条纪律：`find` 有 `take` 上限，把它的长度当总数
   * 会让「被截断」与「一共就这么多」同形。这里没有截断面，所以长度恰好等于总数
   * **只是巧合**；用 `count()` 才能让「口径」这件事只有一个来源。
   *
   * 窗口下界用 `createdAt`（**不是** `updatedAt`）：判据问的是「这段时间里**新建**的
   * 会话有几个失败了」，而 `updatedAt` 会被重跑/resume 刷新 ⇒ 一条昨天失败、今天被
   * 重新打开的会话会**凭空出现在今天的窗口里**，且失败状态早已不是它的现状。
   *
   * `status` 用 `In([...])`（而非两个 `or` 分支）：与 `readTitles` 的既有写法一致，
   * 且谓词只有一处，改口径不会漏改一支。
   */
  private async countFailedSessions(windowHours: number): Promise<number> {
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    return this.sessionRepo.count({
      where: {
        status: In([...FAILED_SESSION_STATUSES]) as never,
        createdAt: MoreThanOrEqual(since),
      },
    });
  }

  /**
   * 批量取会话标题（`In(...)`）。
   *
   * 只投影 `id` / `title`：`contextJson` / `resultJson` / `steps` 与本端点无关，
   * 搬出来只是把大字段塞进响应路径。
   */
  private async readTitles(
    sessionIds: string[],
  ): Promise<ReadResult<Map<string, string>>> {
    if (sessionIds.length === 0) {
      return { value: new Map(), degraded: false };
    }
    return this.read("pending.sessionTitles", async () => {
      const rows = await this.sessionRepo.find({
        where: { id: In(sessionIds) },
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
   * 正是本仓要消灭的那类假事实：运营会以为活干完了。
   */
  private requireWiring(): void {
    if (!this.approvals || !this.sessionRepo || !this.sessionService) {
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
        this.logger.warn(`inbox read produced non-finite value: ${label}`);
        return { value: null, degraded: true };
      }
      return { value, degraded: false };
    } catch (err) {
      this.logger.warn(
        `inbox read failed: ${label} — ${err instanceof Error ? err.message : String(err)}`,
      );
      return { value: null, degraded: true };
    }
  }
}
