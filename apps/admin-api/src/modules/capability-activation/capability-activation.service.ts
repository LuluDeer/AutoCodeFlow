import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { createHash } from "crypto";
import {
  Between,
  FindOptionsWhere,
  LessThanOrEqual,
  MoreThanOrEqual,
  Repository,
  SelectQueryBuilder,
} from "typeorm";
import { AppError } from "../../common/errors/app-error";
import { ErrorCode } from "../../common/errors/error-codes";
import { PaginatedEnvelope, paginate } from "../../common/dto/pagination.dto";
import { CreateActivationDto } from "./dto/create-activation.dto";
import {
  ActivationOutcome,
  ActivationResult,
  CapabilityActivationLog,
} from "./entities/activation-log.entity";
import type { HardLimitDecision } from "./quota-limit";
import {
  QUOTA_HARD_LIMIT_GATE,
  type QuotaHardLimitGate,
} from "./quota-limit.gate";
import {
  CAPABILITY_SCOPE_GATE,
  type CapabilityScopeGate,
  type CapabilityScopeSet,
} from "./capability-scope.gate";
import {
  meterActivations,
  type CapabilityMeterRow,
  type DualMeterBasis,
  type MeasurementNote,
  type ProjectMeterRow,
  type RawActivationLog,
} from "./dual-meter";
import type { PriceReason, TokenSample } from "./price.dto";

/** 深度钳位：与 agent 域 canonicalJson 同款，避免恶意深嵌套参数爆栈。 */
const STABLE_MAX_DEPTH = 32;

/**
 * 确定性 JSON 序列化：**键排序**，故 `{a:1,b:2}` 与 `{b:2,a:1}` 得到同一串。
 *
 * 只做摘要输入，不承担 JSON 完整性（`undefined`/函数会被丢弃、`BigInt`/环引用
 * 不在调用方契约内）。数组保序；`undefined` 属性跳过（与 JSON.stringify 的
 * 对象行为一致）。超深嵌套折叠成哨兵串，保证边界闸之前不抛 RangeError。
 */
export function stableStringify(value: unknown, depth = 0): string {
  if (depth > STABLE_MAX_DEPTH) return '"[DEEP_NESTED]"';
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v, depth + 1)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v, depth + 1)}`)
    .join(",")}}`;
}

/** 参数摘要：sha256 hex（64 字符，恰落 varchar(64)），键序无关。 */
export function parametersDigest(parameters: unknown): string {
  return createHash("sha256")
    .update(stableStringify(parameters ?? {}))
    .digest("hex");
}

export interface ActivationQueryOptions {
  capabilityKey?: string;
  sessionId?: string;
  userId?: number;
  projectId?: string;
  username?: string;
  result?: ActivationResult;
  outcome?: ActivationOutcome;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface ActivationStatsEntry {
  capabilityKey: string;
  count: number;
  success: number;
  failure: number;
  blocked: number;
}

export interface ActivationProjectStat {
  projectId: string | null;
  count: number;
}

/**
 * N20 双口径统计（新增可选字段，既有 total/byCapability/byProject 逐字不变）。
 *
 * invocations = result ∈ {success,failure,blocked} 的调用次数；
 * successfulDeliveries = 仅 result=success 的次数；token/货币值恒 null。
 */
export interface ActivationStatsDualBasis {
  readonly basis: DualMeterBasis;
  readonly invocations: number;
  readonly successfulDeliveries: number;
  readonly skipped: number;
  readonly byCapability: CapabilityMeterRow[];
  readonly byProject: ProjectMeterRow[];
  readonly note: MeasurementNote;
  /** 成本归责：有 provider 实测样本才非 null；零样本/无关联一律 null（不编造）。 */
  readonly tokenSample: TokenSample | null;
  readonly currencyValue: number | null;
  readonly priceReason: PriceReason;
  readonly allocationNote: string;
}

export interface ActivationStats {
  total: number;
  byCapability: ActivationStatsEntry[];
  byProject: ActivationProjectStat[];
  /** N20：双口径计数；缺席即旧契约，前端既有看板不依赖此字段。 */
  dualBasis?: ActivationStatsDualBasis;
}

/**
 * N20：attributeCost 需要外部权重（相对份额）输入，当前没有业务权重来源；
 * 本批只暴露可复算计数，不编造分摊结果。
 */
const ALLOCATION_NOTE =
  "attributeCost 未接线：相对份额分摊需外部权重配置，当前无业务权重来源；本字段只提供可复算的双口径计数。";

function toDate(value: string): Date {
  return new Date(value);
}

/**
 * N15：运行时能力激活日志服务。
 *
 * **append-only 是代码层契约**：本服务只暴露 `record`（INSERT）+ `query`/`stats`
 * （只读），**没有也不提供 update/delete**。不引入 DB 触发器（见迁移
 * 1790000000105 头注）——`audit_logs` 靠触发器守 append-only，本表靠「唯一写
 * 路径就是 append」达成同等语义：没有任何代码能改/删历史激活行。
 *
 * 明文参数不落库：`record` 只把 `parametersDigest` 交给 repo，`parameters`
 * 本身既不写列也不进 detail（本表无 detail 列）。
 *
 * N20 硬阈值：`record` 在 save 之前问轻量 gate（可选注入的结构面 token）。
 * 命中则先落一行 result='blocked' 审计"谁被拦了"，再抛 AppError；gate 缺席
 * 或任何判定异常一律 fail-open 放行（与 N14 代际/审计写入纪律一致）。
 */
@Injectable()
export class CapabilityActivationService {
  private readonly logger = new Logger(CapabilityActivationService.name);

  constructor(
    @InjectRepository(CapabilityActivationLog)
    private readonly repo: Repository<CapabilityActivationLog>,
    @Optional()
    @Inject(QUOTA_HARD_LIMIT_GATE)
    private readonly gate?: QuotaHardLimitGate,
    // N19 能力调用 scope 闸：追加到末尾（既有 spec 用定位参数装配，插中间会
    // 静默错位——R394 教训）。@Optional 缺席跳过，保持内部审计/内部调用行为。
    @Optional()
    @Inject(CAPABILITY_SCOPE_GATE)
    private readonly scopeGate?: CapabilityScopeGate,
  ) {}

  /**
   * 唯一写路径：先过 scope 闸（fail-close），再过硬阈闸，最后落一行激活事实。
   *
   * `apiKeyScope` 是**可选调用参数**：仅当本次调用确实携带 API Key scope 词集时
   * 才过闸；内部调用（workbench/commit）无 key 上下文不传此参 → 跳过，避免把
   * 「能力调用鉴权」误做成「内部审计」而打断主链。DTO 不可改（写域外），故用
   * 调用参数显式表达，不臆造字段。
   */
  async record(
    dto: CreateActivationDto,
    apiKeyScope?: CapabilityScopeSet,
  ): Promise<CapabilityActivationLog> {
    // fail-close：携带 scope 且闸判定拒绝 ⇒ 403 类错误，零 save、不落库。
    if (
      this.scopeGate &&
      apiKeyScope !== undefined &&
      !this.scopeGate.canInvokeWithScope(apiKeyScope)
    ) {
      throw new AppError("API_KEY_SCOPE_DENIED", {
        reason: `调用 API 能力「${dto.capabilityKey}」需要 readonly + trigger 或 manage scope`,
      });
    }
    if (this.gate) {
      let decision: HardLimitDecision | undefined;
      try {
        decision = await this.gate.evaluateHardLimit({
          capabilityKey: dto.capabilityKey,
          projectId: dto.projectId,
        });
      } catch (err: unknown) {
        // fail-open：配额判定故障不阻断正常激活。
        this.logger.warn(
          `[showback] hard-limit gate unavailable; fail-open for ${
            dto.capabilityKey
          }: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (decision?.blocked) {
        await this.writeBlockedAudit(dto);
        const m = decision.matched;
        const label = m
          ? `${m.scope}/${m.target} 用量 ${m.usage} ≥ 硬阈值 ${m.hardLimit}（窗口 ${m.windowDays} 天）`
          : "已配置的硬阈值";
        throw new AppError(ErrorCode.RATE_LIMITED, {
          detail: `调用超出硬阈值配额（${label}），已被拦截`,
        });
      }
    }
    return this.save(dto, dto.result ?? "success");
  }

  /** 被拦也留痕：审计写失败只 warn，不改变"这次调用被拒"的事实。 */
  private async writeBlockedAudit(dto: CreateActivationDto): Promise<void> {
    try {
      await this.save(dto, "blocked");
    } catch (err: unknown) {
      this.logger.warn(
        `[showback] blocked audit write failed for ${dto.capabilityKey}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private save(
    dto: CreateActivationDto,
    result: ActivationResult,
  ): Promise<CapabilityActivationLog> {
    const digest = parametersDigest(dto.parameters);
    const entity = this.repo.create({
      capabilityKey: dto.capabilityKey,
      capabilityVersion: dto.capabilityVersion ?? null,
      sessionId: dto.sessionId ?? null,
      parametersDigest: digest,
      userId: dto.userId ?? null,
      username: dto.username ?? null,
      imPlatform: dto.imPlatform ?? null,
      imSenderId: dto.imSenderId ?? null,
      projectId: dto.projectId ?? null,
      result,
      baselineMetric: dto.baselineMetric ?? null,
      improvement: dto.improvement ?? null,
      confirmed: dto.confirmed ?? false,
    });
    return this.repo.save(entity);
  }

  /** 只读查询：精确过滤 + createdAt 闭区间 + offset 分页（仿 audit 查询范式）。 */
  async query(
    options: ActivationQueryOptions,
  ): Promise<PaginatedEnvelope<CapabilityActivationLog>> {
    const page = options.page ?? 1;
    const pageSize = Math.min(options.pageSize ?? 20, 100);
    const where: FindOptionsWhere<CapabilityActivationLog> = {};

    if (options.capabilityKey !== undefined)
      where.capabilityKey = options.capabilityKey;
    if (options.sessionId !== undefined) where.sessionId = options.sessionId;
    if (options.userId !== undefined) where.userId = options.userId;
    if (options.projectId !== undefined) where.projectId = options.projectId;
    if (options.username !== undefined) where.username = options.username;
    if (options.result !== undefined) where.result = options.result;
    // N5 outcome 过滤：业务结果归因状态映射到 confirmed 列（与 result 正交）。
    if (options.outcome !== undefined) {
      where.confirmed = options.outcome === "confirmed";
    }

    if (options.from && options.to) {
      where.createdAt = Between(toDate(options.from), toDate(options.to));
    } else if (options.from) {
      where.createdAt = MoreThanOrEqual(toDate(options.from));
    } else if (options.to) {
      where.createdAt = LessThanOrEqual(toDate(options.to));
    }

    const [list, total] = await this.repo.findAndCount({
      where,
      order: { createdAt: "DESC", id: "DESC" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return paginate(list, total, page, pageSize);
  }

  /**
   * 只读聚合：SQL GROUP BY，一次按 capabilityKey（count + 三态分布），
   * 一次按 projectId（showback）。时间窗与列表 from/to 同语义。
   */
  async stats(
    options: { from?: string; to?: string } = {},
  ): Promise<ActivationStats> {
    const capQb = this.repo
      .createQueryBuilder("log")
      .select("log.capabilityKey", "capabilityKey")
      .addSelect("COUNT(*)", "count")
      .addSelect("COUNT(*) FILTER (WHERE log.result = 'success')", "success")
      .addSelect("COUNT(*) FILTER (WHERE log.result = 'failure')", "failure")
      .addSelect("COUNT(*) FILTER (WHERE log.result = 'blocked')", "blocked")
      .groupBy("log.capabilityKey")
      .orderBy("count", "DESC");
    this.applyWindow(capQb, options.from, options.to);
    const capRows: Record<string, string | null>[] = await capQb.getRawMany();

    const projQb = this.repo
      .createQueryBuilder("log")
      .select("log.projectId", "projectId")
      .addSelect("COUNT(*)", "count")
      .groupBy("log.projectId")
      .orderBy("count", "DESC");
    this.applyWindow(projQb, options.from, options.to);
    const projRows: Record<string, string | null>[] = await projQb.getRawMany();

    // N20 双口径：同一时间窗内取逐行最小投影（capabilityKey/projectId/result），
    // 复用 meterActivations 计数，避免与 SQL 三态各写一套口径。对账关系：
    // invocations = byCapability.count 合计 = success+failure+blocked；
    // successfulDeliveries = 三态里的 success 合计，failure/blocked 只进 invocations。
    // meterActivations 对非法 result 计 skipped，合法集合与 SQL 三态一致。
    const dualQb = this.repo
      .createQueryBuilder("log")
      .select("log.capabilityKey", "capabilityKey")
      .addSelect("log.projectId", "projectId")
      .addSelect("log.result", "result");
    this.applyWindow(dualQb, options.from, options.to);
    const dualReport = meterActivations(
      (await dualQb.getRawMany()) as RawActivationLog[],
    );

    const byCapability = capRows.map((r) => ({
      capabilityKey: String(r.capabilityKey),
      count: Number(r.count),
      success: Number(r.success ?? 0),
      failure: Number(r.failure ?? 0),
      blocked: Number(r.blocked ?? 0),
    }));
    return {
      total: byCapability.reduce((sum, r) => sum + r.count, 0),
      byCapability,
      byProject: projRows.map((r) => ({
        projectId: r.projectId === null ? null : String(r.projectId),
        count: Number(r.count),
      })),
      dualBasis: {
        basis: dualReport.basis,
        invocations: dualReport.total.invocations,
        successfulDeliveries: dualReport.total.successfulDeliveries,
        skipped: dualReport.total.skipped,
        byCapability: dualReport.byCapability,
        byProject: dualReport.byProject,
        note: dualReport.note,
        tokenSample: dualReport.tokenSample,
        currencyValue: dualReport.currencyValue,
        priceReason: dualReport.priceReason,
        allocationNote: ALLOCATION_NOTE,
      },
    };
  }

  private applyWindow<T>(
    qb: SelectQueryBuilder<T>,
    from?: string,
    to?: string,
  ): void {
    if (from) {
      qb.andWhere('log."createdAt" >= :from', {
        from: toDate(from).toISOString(),
      });
    }
    if (to) {
      qb.andWhere('log."createdAt" <= :to', { to: toDate(to).toISOString() });
    }
  }
}
