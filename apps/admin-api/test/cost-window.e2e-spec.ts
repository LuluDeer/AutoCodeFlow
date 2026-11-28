import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";
import { createTestApp, loginAsAdmin } from "./helpers/app.helper";
import {
  PRICE_KEY_PREFIX,
  type PricingConfig,
} from "../src/modules/capability-activation/price.dto";

/**
 * 折算出数跟随时间窗 —— AGENTS §4.4 第 3 级（真 PG + 真 Nest + supertest，测副作用）。
 *
 * 硬指标：**同一批 agent_steps + 同一份价目**，仅改变 GET stats 的 from/to，
 * dualBasis.currencyValue 必须不同（窗外组必须被排除，不是全局恒定值）。
 *
 * 数据布局（每组独立 provider/model，避免 mix；createdAt 直接 INSERT 指定）：
 *   A 近窗内：1e6 in + 0.5e6 out，in=2 / out=3 CNY → 3.5，createdAt = BASE
 *   B 窗外：  2e6 in，in=1.5 CNY → 3.0，createdAt = BASE - 10d
 *   C 边界：  2×1e6 in，in=1 CNY → 2.0，createdAt 恰等于 from / to（闭区间）
 *
 * 期望：全局 8.5；主窗 [BASE-3d, BASE+3d] 5.5（B 被剔除，差值 3.0）；
 *       边界专用窗 2.0（若实现用开区间则变 null）；空窗 null / NO_TOKEN_SAMPLE。
 *
 * 隔离：provider/model 带唯一 runId；只 PUT 本 runId 价目；afterAll 精确 DELETE
 * （steps / sessions / system_configs / config_history）并复查 0。
 */
describe("Cost conversion follows stats time window (real PG e2e)", () => {
  let app: INestApplication;
  let db: DataSource;
  let admin: string;

  const runId = randomUUID().replace(/-/g, "").slice(0, 12);
  const DAY = 86_400_000;
  const BASE = Date.now() - 5 * DAY;
  const from = new Date(BASE - 3 * DAY);
  const to = new Date(BASE + 3 * DAY);
  const boundaryFrom = new Date(BASE - 2 * DAY);
  const boundaryTo = new Date(BASE - 1 * DAY);
  const emptyFrom = new Date(BASE + 10 * DAY);
  const emptyTo = new Date(BASE + 11 * DAY);

  const providerA = `e2e-win-a-${runId}`;
  const modelA = `model-a-${runId}`;
  const sessionA = randomUUID();
  const priceAIn: PricingConfig = {
    provider: providerA,
    model: modelA,
    direction: "in",
    pricePerMillionTokens: 2,
    currency: "CNY",
  };
  const priceAOut: PricingConfig = {
    ...priceAIn,
    direction: "out",
    pricePerMillionTokens: 3,
  };

  const providerB = `e2e-win-b-${runId}`;
  const modelB = `model-b-${runId}`;
  const sessionB = randomUUID();
  const priceBIn: PricingConfig = {
    provider: providerB,
    model: modelB,
    direction: "in",
    pricePerMillionTokens: 1.5,
    currency: "CNY",
  };

  const providerC = `e2e-win-c-${runId}`;
  const modelC = `model-c-${runId}`;
  const sessionC = randomUUID();
  const priceCIn: PricingConfig = {
    provider: providerC,
    model: modelC,
    direction: "in",
    pricePerMillionTokens: 1,
    currency: "CNY",
  };

  // 所有本用例写入的 key 都带本 runId；LIKE 精确命中，不碰别的用例。
  const keyLike = `${PRICE_KEY_PREFIX}e2e-win-%-${runId}.%`;
  const providerLike = `e2e-win-%-${runId}`;
  const sessionIds = [sessionA, sessionB, sessionC];

  const unwrapBasis = (body: any): any =>
    body?.dualBasis ?? body?.data?.dualBasis;

  const getStats = async (window?: {
    from?: string;
    to?: string;
  }): Promise<any> => {
    const res = await request(app.getHttpServer())
      .get("/capability-activation/stats")
      .query(window ?? {})
      .set("Authorization", `Bearer ${admin}`)
      .expect(200);
    const basis = unwrapBasis(res.body);
    expect(basis).toBeDefined();
    return basis;
  };

  const putPrice = async (cfg: PricingConfig): Promise<void> => {
    const res = await request(app.getHttpServer())
      .put("/capability-activation/price")
      .set("Authorization", `Bearer ${admin}`)
      .send(cfg);
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  };

  const insertSession = async (id: string): Promise<void> => {
    await db.query(
      `INSERT INTO agent_sessions
         (id, kind, status, "triggerSource", "createdAt", "updatedAt")
       VALUES ($1, 'chat', 'succeeded', 'e2e-cost-window', now(), now())`,
      [id],
    );
  };

  /**
   * createdAt 直接 INSERT 指定（@CreateDateColumn 的库默认 now() 被显式值覆盖）。
   * 必须显式 $7::timestamptz：agent_steps.createdAt 是 timestamp without time zone，
   * 若把 JS Date 直接交给 pg 驱动，它会按进程本地时区（+08）序列化成墙上时间，
   * 库里存成 10:xx 而非 ISO 的 02:xx，边界测试就会假红（真 PG 实测）。
   */
  const insertStep = async (
    sessionId: string,
    seq: number,
    provider: string,
    model: string,
    tokensIn: number,
    tokensOut: number,
    createdAt: Date,
  ): Promise<void> => {
    await db.query(
      `INSERT INTO agent_steps
         ("sessionId", seq, role, "tokensIn", "tokensOut", provider, model, "createdAt")
       VALUES ($1, $2, 'assistant', $3, $4, $5, $6, $7::timestamptz)`,
      [
        sessionId,
        seq,
        tokensIn,
        tokensOut,
        provider,
        model,
        createdAt.toISOString(),
      ],
    );
  };

  const rowsOf = async (sql: string, params: unknown[]): Promise<any[]> => {
    const r = await db.query(sql, params);
    return (Array.isArray(r) ? r : r.rows) as any[];
  };

  const countOf = async (sql: string, params: unknown[]): Promise<number> => {
    const rows = await rowsOf(sql, params);
    return Number(rows[0]?.n ?? 0);
  };

  const countSteps = async (): Promise<number> =>
    countOf(
      'SELECT count(*)::int AS n FROM agent_steps WHERE "sessionId" = ANY($1::uuid[])',
      [sessionIds],
    );

  const countProviderSteps = async (): Promise<number> =>
    countOf(
      "SELECT count(*)::int AS n FROM agent_steps WHERE provider LIKE $1",
      [providerLike],
    );

  const countKeys = async (): Promise<number> =>
    countOf("SELECT count(*)::int AS n FROM system_configs WHERE key LIKE $1", [
      keyLike,
    ]);

  beforeAll(async () => {
    const dbName = process.env.DB_DATABASE ?? "";
    if (!/(^|_)(test|e2e)(_|$)/i.test(dbName)) {
      throw new Error(
        `cost window e2e 需要显式 test/e2e 库（收到 ${dbName || "<empty>"}）`,
      );
    }
    app = await createTestApp();
    db = app.get(DataSource);
    admin = await loginAsAdmin(app);
    expect(admin).toBeTruthy();

    // 只配价目、先不插样本：确认本 runId 之外没有残留价目样本污染期望金额。
    await putPrice(priceAIn);
    await putPrice(priceAOut);
    await putPrice(priceBIn);
    await putPrice(priceCIn);
    const baseline = await getStats();
    console.log(
      `[cost-window] runId=${runId} baseline currencyValue=${baseline.currencyValue} priceReason=${baseline.priceReason}`,
    );
    expect(baseline.currencyValue).toBeNull();
    expect(baseline.priceReason).toBe("NO_TOKEN_SAMPLE");
  });

  afterAll(async () => {
    try {
      if (db) {
        await db.query(
          'DELETE FROM agent_steps WHERE "sessionId" = ANY($1::uuid[])',
          [sessionIds],
        );
        await db.query(
          "DELETE FROM agent_sessions WHERE id = ANY($1::uuid[])",
          [sessionIds],
        );
        await db.query("DELETE FROM system_configs WHERE key LIKE $1", [
          keyLike,
        ]);
        await db.query('DELETE FROM config_history WHERE "configKey" LIKE $1', [
          keyLike,
        ]);

        const stepsLeft = await countSteps();
        const providerStepsLeft = await countProviderSteps();
        const keysLeft = await countKeys();
        const sessionsLeft = await countOf(
          "SELECT count(*)::int AS n FROM agent_sessions WHERE id = ANY($1::uuid[])",
          [sessionIds],
        );
        const histLeft = await countOf(
          'SELECT count(*)::int AS n FROM config_history WHERE "configKey" LIKE $1',
          [keyLike],
        );
        console.log(
          `[cost-window] runId=${runId} cleanup remaining: steps=${stepsLeft} byProvider=${providerStepsLeft} sessions=${sessionsLeft} configs=${keysLeft} history=${histLeft}`,
        );
        expect(stepsLeft).toBe(0);
        expect(providerStepsLeft).toBe(0);
        expect(sessionsLeft).toBe(0);
        expect(keysLeft).toBe(0);
        expect(histLeft).toBe(0);
      }
    } finally {
      await app?.close();
    }
  });

  it("① 全局兼容：不传 from/to → 三批折算值总和 8.5（A 3.5 + B 3.0 + C 2.0）", async () => {
    await insertSession(sessionA);
    await insertStep(
      sessionA,
      1,
      providerA,
      modelA,
      1_000_000,
      500_000,
      new Date(BASE),
    );
    await insertSession(sessionB);
    await insertStep(
      sessionB,
      1,
      providerB,
      modelB,
      2_000_000,
      0,
      new Date(BASE - 10 * DAY),
    );
    await insertSession(sessionC);
    await insertStep(
      sessionC,
      1,
      providerC,
      modelC,
      1_000_000,
      0,
      boundaryFrom,
    );
    await insertStep(sessionC, 2, providerC, modelC, 1_000_000, 0, boundaryTo);

    // 副作用对账：真库里确有 4 行本 runId 的 step，且 createdAt 按造数分布落库。
    const rows = await rowsOf(
      `SELECT provider,
              to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS iso
         FROM agent_steps WHERE "sessionId" = ANY($1::uuid[])
        ORDER BY provider, seq`,
      [sessionIds],
    );
    expect(rows.length).toBe(4);
    const times = rows.map((r) => r.iso).sort();
    expect(times).toEqual(
      [
        new Date(BASE - 10 * DAY).toISOString(),
        boundaryFrom.toISOString(),
        boundaryTo.toISOString(),
        new Date(BASE).toISOString(),
      ].sort(),
    );

    const basis = await getStats();
    console.log(
      `[cost-window] ① global currencyValue=${basis.currencyValue} priceReason=${basis.priceReason}`,
    );
    expect(basis.currencyValue).toBe(8.5);
    expect(basis.priceReason).toBe("OK");
  });

  it("② 硬指标：同一批数据只传主窗 → 5.5，与全局 8.5 确有差异（窗外 B=3.0 被剔除）", async () => {
    const globalBasis = await getStats();
    const windowBasis = await getStats({
      from: from.toISOString(),
      to: to.toISOString(),
    });
    const diff =
      Number(globalBasis.currencyValue) - Number(windowBasis.currencyValue);
    console.log(
      `[cost-window] ② global=${globalBasis.currencyValue} window=${windowBasis.currencyValue} diff=${diff} windowReason=${windowBasis.priceReason}`,
    );

    expect(globalBasis.currencyValue).toBe(8.5);
    expect(windowBasis.currencyValue).toBe(5.5);
    expect(windowBasis.priceReason).toBe("OK");
    // 时间窗真的生效：不是全局兼容值的别名，且差额恰为窗外那批的折算值。
    expect(diff).toBe(3.0);
    expect(windowBasis.currencyValue).not.toBe(globalBasis.currencyValue);
  });

  it("③ 空窗标缺：窗口不含任何 step → null / NO_TOKEN_SAMPLE（不是 0）", async () => {
    const basis = await getStats({
      from: emptyFrom.toISOString(),
      to: emptyTo.toISOString(),
    });
    console.log(
      `[cost-window] ③ empty currencyValue=${basis.currencyValue} priceReason=${basis.priceReason}`,
    );
    expect(basis.currencyValue).toBeNull();
    expect(basis.priceReason).toBe("NO_TOKEN_SAMPLE");
  });

  it("④ ISO 边界：createdAt 恰等于 from / to 的两行都被纳入 → 2.0（闭区间）", async () => {
    // 副作用对账：两行的真实 createdAt 就是 from / to 的 UTC 墙上时间，不是 8 小时偏移值。
    const boundaryRows = await rowsOf(
      `SELECT seq,
              to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS iso
         FROM agent_steps WHERE "sessionId" = $1 ORDER BY seq`,
      [sessionC],
    );
    expect(boundaryRows.map((r) => r.iso)).toEqual([
      boundaryFrom.toISOString(),
      boundaryTo.toISOString(),
    ]);
    const basis = await getStats({
      from: boundaryFrom.toISOString(),
      to: boundaryTo.toISOString(),
    });
    console.log(
      `[cost-window] ④ boundary currencyValue=${basis.currencyValue} priceReason=${basis.priceReason} from=${boundaryFrom.toISOString()} to=${boundaryTo.toISOString()}`,
    );
    // 边界窗只覆盖 C 组两行；若实现用 > / < 开区间，这里变 null，断言立即转红。
    expect(basis.currencyValue).toBe(2.0);
    expect(basis.priceReason).toBe("OK");
  });
});
