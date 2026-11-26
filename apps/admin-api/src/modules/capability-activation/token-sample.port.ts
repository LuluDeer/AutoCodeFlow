/**
 * 成本归责第一步：按 sessionId 取真实 token 的「诚实采样端口」（零 Nest / 零 ORM）。
 *
 * 设计纪律（与 dual-meter.ts 同款：纯判定 + 注入式最小 DS）：
 * - 不 JOIN 猜测：只用调用方给的 sessionId 精确查 agent_sessions.id；
 *   capability_activation_log.sessionId 是 Workbench/SOP id，与 agent_sessions.id
 *   同为 UUID、无前缀区分、库内无可靠桥，查不中就是查不中，不按形状推断归属。
 * - 不把 0 当样本：只有 provider 实测 token 为正的 step 才计入样本轮数。
 * - 不用 RU / 相对预算反推成本：本文件没有任何金额、单价、系数换算，
 *   currencyValue 在所有路径恒为 null。
 * - 无关联 / 零样本 / 缺样本一律标缺（tokens = null），绝不编造 0 或估算值。
 *
 * 注入方式：主控用 @InjectDataSource 拿真 DataSource，包一层满足
 * TokenSampleDataSource 的只读 adapter 后 new TokenSamplePort(adapter) 即可；
 * 本文件不 import typeorm / @nestjs/*，便于单测用内存替身。
 */
import type {
  TokenSampleBasis,
  TokenSampleReasonCode,
  TokenSampleStatus,
  TokenSampleView,
} from "./dto/token-sample.dto";

/**
 * 最小样本轮数：与 scripts/agent-context-token-audit.mjs 的 MIN_SAMPLES 同值同义
 * （低于此轮数不下「token 可用」结论、不产出 token 值）。不 import 那个脚本，
 * 避免其顶层副作用；如需调整由构造参数覆盖，不在此另造判据。
 */
export const TOKEN_SAMPLE_MIN_SAMPLES = 30;

/** agent_sessions 的最小读取面。列可空以容纳脏行，判定时归零而非当成样本。 */
export interface AgentSessionTotalsRow {
  id: string;
  totalTokensIn: number | null;
  totalTokensOut: number | null;
}

/** agent_steps 的最小读取面：只取 provider 实测 token 两列。 */
export interface StepUsageRow {
  tokensIn: number | null;
  tokensOut: number | null;
}

/** DataSource 最小 select 面：两个精确查询，不暴露写、不暴露宽表 join。 */
export interface TokenSampleDataSource {
  selectAgentSessionTotals(
    sessionId: string,
  ): Promise<AgentSessionTotalsRow | null>;
  selectStepUsages(agentSessionId: string): Promise<readonly StepUsageRow[]>;
}

export interface TokenSamplePortOptions {
  /** 覆盖最小样本轮数；非正数 / 非有限值回落到 TOKEN_SAMPLE_MIN_SAMPLES。 */
  minSamples?: number;
}

/** UUID 形状只用于「排除」：非 UUID 必不是 agent_sessions.id。 */
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 固定文案：只说明口径，不含金额、单价、数字估算。 */
const NOTES: Record<TokenSampleReasonCode | "OK", string> = {
  NO_SESSION_ID: "会话标识为空，无法关联真实 token 样本，按无关联标缺",
  SOP_ID_NAMESPACE: "会话标识不具备 agent 会话形状，按无关联标缺，不推断归属",
  NO_AGENT_SESSION_ROW:
    "未命中 agent_sessions 行，无可用 token 样本，按缺样本标缺",
  ALL_STEPS_ZERO: "会话累计与 provider 实测 token 均为零，按零样本标缺",
  STEPS_PRUNED: "步骤明细已清理，采用会话累计 token 口径，非 provider 逐轮实测",
  BELOW_MIN_SAMPLES:
    "provider 实测轮数低于最小样本门槛，按缺样本标缺，不产出 token 值",
  OK: "provider 逐轮实测 token，样本充足",
};

/** 与 safeTokenCount 同口径：非有限 / 非正数归 0，但不把 0 当样本。 */
function positiveToken(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

export class TokenSamplePort {
  private readonly minSamples: number;

  constructor(
    private readonly ds: TokenSampleDataSource,
    options: TokenSamplePortOptions = {},
  ) {
    const raw = options.minSamples;
    this.minSamples =
      typeof raw === "number" && Number.isFinite(raw) && raw > 0
        ? raw
        : TOKEN_SAMPLE_MIN_SAMPLES;
  }

  /**
   * 单会话采样。sessionId 原值回显（null / undefined 回显 null），不改写。
   *
   * 判定顺序：
   *  1. 空 → no_link / NO_SESSION_ID（不查库）
   *  2. 非 UUID 形状 → no_link / SOP_ID_NAMESPACE（排除，不查库、不推断）
   *  3. UUID 形状但 agent_sessions 未命中 → no_link / NO_AGENT_SESSION_ROW
   *  4. 命中：实测样本 0 且会话总额 0 → zero_sample / ALL_STEPS_ZERO
   *  5. 命中：实测样本 0 但会话总额 > 0 → ok / STEPS_PRUNED（会话累计口径）
   *  6. 命中：0 < 实测样本 < minSamples → insufficient / BELOW_MIN_SAMPLES
   *  7. 命中：实测样本 >= minSamples → ok / provider 实测口径
   * 任何路径 currencyValue 恒 null。
   */
  async sample(sessionId: string | null | undefined): Promise<TokenSampleView> {
    const echoed: string | null = sessionId ?? null;

    if (typeof echoed !== "string" || echoed.trim() === "") {
      return this.build(
        echoed,
        null,
        "no_link",
        "NO_SESSION_ID",
        null,
        null,
        null,
        "none",
      );
    }

    if (!UUID_SHAPE.test(echoed)) {
      return this.build(
        echoed,
        null,
        "no_link",
        "SOP_ID_NAMESPACE",
        null,
        null,
        null,
        "none",
      );
    }

    const session = await this.ds.selectAgentSessionTotals(echoed);
    if (!session) {
      return this.build(
        echoed,
        null,
        "no_link",
        "NO_AGENT_SESSION_ROW",
        null,
        null,
        null,
        "none",
      );
    }

    const usages = await this.ds.selectStepUsages(session.id);
    let measuredStepCount = 0;
    let sumIn = 0;
    let sumOut = 0;
    for (const usage of usages) {
      const tokensIn = positiveToken(usage.tokensIn);
      const tokensOut = positiveToken(usage.tokensOut);
      if (tokensIn === 0 && tokensOut === 0) continue; // 不把 0 当样本
      measuredStepCount += 1;
      sumIn += tokensIn;
      sumOut += tokensOut;
    }

    const totalIn = positiveToken(session.totalTokensIn);
    const totalOut = positiveToken(session.totalTokensOut);
    const sessionTotal = totalIn + totalOut;

    if (measuredStepCount === 0 && sessionTotal === 0) {
      return this.build(
        echoed,
        session.id,
        "zero_sample",
        "ALL_STEPS_ZERO",
        null,
        null,
        0,
        "none",
      );
    }

    if (measuredStepCount === 0 && sessionTotal > 0) {
      return this.build(
        echoed,
        session.id,
        "ok",
        "STEPS_PRUNED",
        totalIn,
        totalOut,
        null,
        "agent_sessions.totals",
      );
    }

    if (measuredStepCount < this.minSamples) {
      return this.build(
        echoed,
        session.id,
        "insufficient",
        "BELOW_MIN_SAMPLES",
        null,
        null,
        measuredStepCount,
        "none",
      );
    }

    return this.build(
      echoed,
      session.id,
      "ok",
      null,
      sumIn,
      sumOut,
      measuredStepCount,
      "agent_steps.provider_usage",
    );
  }

  /** 批量采样：逐条独立查询，Promise.all 保序，绝不串号。 */
  async sampleMany(
    sessionIds: readonly (string | null | undefined)[],
  ): Promise<TokenSampleView[]> {
    return Promise.all(sessionIds.map((id) => this.sample(id)));
  }

  private build(
    sessionId: string | null,
    resolvedAgentSessionId: string | null,
    status: TokenSampleStatus,
    reasonCode: TokenSampleReasonCode | null,
    tokensIn: number | null,
    tokensOut: number | null,
    measuredStepCount: number | null,
    basis: TokenSampleBasis,
  ): TokenSampleView {
    return {
      sessionId,
      resolvedAgentSessionId,
      status,
      reasonCode,
      note: reasonCode === null ? NOTES.OK : NOTES[reasonCode],
      tokensIn,
      tokensOut,
      measuredStepCount,
      basis,
      currencyValue: null,
    };
  }
}

/** 便捷工厂，便于主控在模块里用 @InjectDataSource 适配后构造。 */
export function createTokenSamplePort(
  ds: TokenSampleDataSource,
  options?: TokenSamplePortOptions,
): TokenSamplePort {
  return new TokenSamplePort(ds, options);
}
