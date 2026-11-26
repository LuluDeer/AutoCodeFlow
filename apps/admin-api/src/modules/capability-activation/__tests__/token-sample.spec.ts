/**
 * 成本归责第一步：token-sample 端口单测（零 Nest / 零真实 DB，内存替身）。
 *
 * 覆盖验收六项 + 反证锚点：
 *  1) SOP id / 空 sessionId → no_link、tokens null、resolved null；
 *     SOP id 特意造同名 agent_sessions 行作诱饵，端口必须先按命名空间排除、不查库。
 *  2) 命中会话且 provider 实测 step tokensIn > 0 → ok / provider_usage / tokensIn > 0。
 *  3) 全 0 steps（复刻 139 条）→ zero_sample、tokens null。
 *  4) 会话总额 > 0 但 steps 已清 → ok + STEPS_PRUNED / agent_sessions.totals。
 *  5) 样本 < MIN_SAMPLES → insufficient，且不调系数（不产出 token 值、无系数字段）。
 *  6) sampleMany 批量不串号（含空值 / SOP id / 命中 / 未命中混合）。
 *
 * 反证：把 no_link 判定（UUID 形状排除）去掉后，用例 1 的 SOP 诱饵行会被当成
 * agent session 查中，tokens 从 null 变成正数、status 从 no_link 变 ok → 真红；
 * 还原后转绿。sha256 见交付报告。
 */
import {
  TOKEN_SAMPLE_MIN_SAMPLES,
  TokenSamplePort,
  type AgentSessionTotalsRow,
  type StepUsageRow,
  type TokenSampleDataSource,
} from "../token-sample.port";
import type { TokenSampleView } from "../dto/token-sample.dto";

const AGENT_A = "11111111-1111-4111-8111-111111111111";
const AGENT_B = "22222222-2222-4222-8222-222222222222";
const SOP_ID = "sop-5001";

class FakeDs implements TokenSampleDataSource {
  readonly sessionCalls: string[] = [];
  readonly stepCalls: string[] = [];

  constructor(
    private readonly sessions: Map<string, AgentSessionTotalsRow> = new Map(),
    private readonly steps: Map<string, StepUsageRow[]> = new Map(),
  ) {}

  async selectAgentSessionTotals(
    sessionId: string,
  ): Promise<AgentSessionTotalsRow | null> {
    this.sessionCalls.push(sessionId);
    return this.sessions.get(sessionId) ?? null;
  }

  async selectStepUsages(
    agentSessionId: string,
  ): Promise<readonly StepUsageRow[]> {
    this.stepCalls.push(agentSessionId);
    return this.steps.get(agentSessionId) ?? [];
  }
}

function steps(
  count: number,
  tokensIn: number,
  tokensOut: number,
): StepUsageRow[] {
  return Array.from({ length: count }, () => ({ tokensIn, tokensOut }));
}

function sessionRow(
  id: string,
  totalTokensIn: number,
  totalTokensOut: number,
): AgentSessionTotalsRow {
  return { id, totalTokensIn, totalTokensOut };
}

describe("成本归责 · token-sample 诚实采样端口", () => {
  it("MIN_SAMPLES 与既有审计脚本同值（30），不另造判据", () => {
    expect(TOKEN_SAMPLE_MIN_SAMPLES).toBe(30);
  });

  it("(1) SOP id / 空 sessionId → no_link，tokens 与 resolved 全 null，且不查库", async () => {
    // 诱饵：SOP id 恰好在 agent_sessions 里有同名行。正确实现必须先按命名空间排除。
    const ds = new FakeDs(
      new Map([[SOP_ID, sessionRow(SOP_ID, 9999, 9999)]]),
      new Map([[SOP_ID, steps(50, 100, 50)]]),
    );
    const port = new TokenSamplePort(ds);

    for (const raw of ["", "   ", null, undefined]) {
      const view = await port.sample(raw);
      expect(view.status).toBe("no_link");
      expect(view.reasonCode).toBe("NO_SESSION_ID");
      expect(view.tokensIn).toBeNull();
      expect(view.tokensOut).toBeNull();
      expect(view.resolvedAgentSessionId).toBeNull();
      expect(view.basis).toBe("none");
      expect(view.currencyValue).toBeNull();
    }
    const echoed = await port.sample("");
    expect(echoed.sessionId).toBe("");

    const sop = await port.sample(SOP_ID);
    expect(sop).toEqual<TokenSampleView>({
      sessionId: SOP_ID,
      resolvedAgentSessionId: null,
      status: "no_link",
      reasonCode: "SOP_ID_NAMESPACE",
      note: expect.any(String),
      tokensIn: null,
      tokensOut: null,
      measuredStepCount: null,
      basis: "none",
      currencyValue: null,
    });

    // UUID 形状查不中 → no_link / NO_AGENT_SESSION_ROW，查了会话但不查 steps。
    const missing = await port.sample(AGENT_B);
    expect(missing.status).toBe("no_link");
    expect(missing.reasonCode).toBe("NO_AGENT_SESSION_ROW");
    expect(missing.tokensIn).toBeNull();
    expect(missing.resolvedAgentSessionId).toBeNull();

    // 副作用断言：空值与 SOP id 绝不触发任何 SELECT；只有 UUID 形状查了一次会话。
    expect(ds.sessionCalls).toEqual([AGENT_B]);
    expect(ds.stepCalls).toEqual([]);
  });

  it("(2) 命中会话且 provider 实测 step tokensIn > 0 → ok / provider_usage / tokensIn > 0", async () => {
    const ds = new FakeDs(
      new Map([[AGENT_A, sessionRow(AGENT_A, 3000, 700)]]),
      new Map([[AGENT_A, steps(TOKEN_SAMPLE_MIN_SAMPLES, 120, 30)]]),
    );
    const view = await new TokenSamplePort(ds).sample(AGENT_A);

    expect(view.status).toBe("ok");
    expect(view.reasonCode).toBeNull();
    expect(view.resolvedAgentSessionId).toBe(AGENT_A);
    expect(view.basis).toBe("agent_steps.provider_usage");
    expect(view.tokensIn).toBe(TOKEN_SAMPLE_MIN_SAMPLES * 120);
    expect(view.tokensIn).toBeGreaterThan(0);
    expect(view.tokensOut).toBe(TOKEN_SAMPLE_MIN_SAMPLES * 30);
    expect(view.measuredStepCount).toBe(TOKEN_SAMPLE_MIN_SAMPLES);
    expect(view.currencyValue).toBeNull();
    expect(ds.sessionCalls).toEqual([AGENT_A]);
    expect(ds.stepCalls).toEqual([AGENT_A]);
  });

  it("(3) 全 0 steps（复刻 139 条）→ zero_sample，tokens null，不把 0 当样本", async () => {
    const ds = new FakeDs(
      new Map([[AGENT_A, sessionRow(AGENT_A, 0, 0)]]),
      new Map([[AGENT_A, steps(139, 0, 0)]]),
    );
    const view = await new TokenSamplePort(ds).sample(AGENT_A);

    expect(view.status).toBe("zero_sample");
    expect(view.reasonCode).toBe("ALL_STEPS_ZERO");
    expect(view.tokensIn).toBeNull();
    expect(view.tokensOut).toBeNull();
    expect(view.measuredStepCount).toBe(0);
    expect(view.basis).toBe("none");
    expect(view.currencyValue).toBeNull();
    expect(ds.stepCalls).toEqual([AGENT_A]);
  });

  it("(4) 会话总额 > 0 但 steps 已清 → ok + STEPS_PRUNED / agent_sessions.totals", async () => {
    const ds = new FakeDs(
      new Map([[AGENT_A, sessionRow(AGENT_A, 4560, 890)]]),
      new Map(),
    );
    const view = await new TokenSamplePort(ds).sample(AGENT_A);

    expect(view.status).toBe("ok");
    expect(view.reasonCode).toBe("STEPS_PRUNED");
    expect(view.basis).toBe("agent_sessions.totals");
    expect(view.tokensIn).toBe(4560);
    expect(view.tokensOut).toBe(890);
    expect(view.measuredStepCount).toBeNull();
    expect(view.currencyValue).toBeNull();
  });

  it("(5) 样本 < MIN_SAMPLES → insufficient，不产出 token 值且不调系数", async () => {
    const ds = new FakeDs(
      new Map([[AGENT_A, sessionRow(AGENT_A, 90, 20)]]),
      new Map([[AGENT_A, steps(TOKEN_SAMPLE_MIN_SAMPLES - 1, 30, 6)]]),
    );
    const view = await new TokenSamplePort(ds).sample(AGENT_A);

    expect(view.status).toBe("insufficient");
    expect(view.reasonCode).toBe("BELOW_MIN_SAMPLES");
    expect(view.tokensIn).toBeNull();
    expect(view.tokensOut).toBeNull();
    expect(view.measuredStepCount).toBe(TOKEN_SAMPLE_MIN_SAMPLES - 1);
    expect(view.basis).toBe("none");
    expect(view.currencyValue).toBeNull();
    // 不调系数的结构断言：视图恰好是契约字段，无任何系数 / 单价 / 金额字段。
    expect(Object.keys(view).sort()).toEqual(
      [
        "sessionId",
        "resolvedAgentSessionId",
        "status",
        "reasonCode",
        "note",
        "tokensIn",
        "tokensOut",
        "measuredStepCount",
        "basis",
        "currencyValue",
      ].sort(),
    );
    expect(/\d/.test(view.note)).toBe(false);
    // 副作用：只查了一次会话 + 一次 steps，没有为「调系数」额外读任何东西。
    expect(ds.sessionCalls).toEqual([AGENT_A]);
    expect(ds.stepCalls).toEqual([AGENT_A]);
  });

  it("刚好达到 MIN_SAMPLES → ok（29 insufficient / 30 ok 的门槛语义）", async () => {
    const mk = (n: number) =>
      new FakeDs(
        new Map([[AGENT_A, sessionRow(AGENT_A, 100, 100)]]),
        new Map([[AGENT_A, steps(n, 10, 2)]]),
      );
    expect((await new TokenSamplePort(mk(29)).sample(AGENT_A)).status).toBe(
      "insufficient",
    );
    expect((await new TokenSamplePort(mk(30)).sample(AGENT_A)).status).toBe(
      "ok",
    );
  });

  it("(6) sampleMany 批量不串号：逐条独立、保序、无交叉查询", async () => {
    const ds = new FakeDs(
      new Map([
        [AGENT_A, sessionRow(AGENT_A, 800, 200)],
        [AGENT_B, sessionRow(AGENT_B, 0, 0)],
      ]),
      new Map([
        [AGENT_A, steps(TOKEN_SAMPLE_MIN_SAMPLES, 50, 10)],
        [AGENT_B, steps(139, 0, 0)],
      ]),
    );
    const ids = [SOP_ID, AGENT_A, "", AGENT_B, null];
    const views = await new TokenSamplePort(ds).sampleMany(ids);

    expect(views.map((v) => v.sessionId)).toEqual([
      SOP_ID,
      AGENT_A,
      "",
      AGENT_B,
      null,
    ]);
    expect(views.map((v) => v.status)).toEqual([
      "no_link",
      "ok",
      "no_link",
      "zero_sample",
      "no_link",
    ]);
    expect(views[1]!.tokensIn).toBe(TOKEN_SAMPLE_MIN_SAMPLES * 50);
    expect(views[1]!.resolvedAgentSessionId).toBe(AGENT_A);
    expect(views[3]!.tokensIn).toBeNull();
    expect(views[3]!.resolvedAgentSessionId).toBe(AGENT_B);
    expect(views.every((v) => v.currencyValue === null)).toBe(true);

    // SOP id 与空值没查库；两个 UUID 各查一次，无串号。
    expect(ds.sessionCalls).toEqual([AGENT_A, AGENT_B]);
    expect(ds.stepCalls).toEqual([AGENT_A, AGENT_B]);
  });
});
