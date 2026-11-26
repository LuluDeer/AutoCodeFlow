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

export interface ActivationStats {
  total: number;
  byCapability: ActivationStatsEntry[];
  byProject: ActivationProjectStat[];
}

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
  ) {}

  /** 唯一写路径：先过硬阈闸，再落一行激活事实，返回落库后的实体。 */
  async record(dto: CreateActivationDto): Promise<CapabilityActivationLog> {
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
