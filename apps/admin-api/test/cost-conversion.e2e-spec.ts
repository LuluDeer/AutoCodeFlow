import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";
import { createTestApp, loginAsAdmin } from "./helpers/app.helper";
import { priceKey } from "../src/modules/capability-activation/price.service";
import {
  PRICE_KEY_PREFIX,
  type PricingConfig,
} from "../src/modules/capability-activation/price.dto";

/**
 * 折算接线让看板出数 —— AGENTS §4.4 第 3 级（真 PG + 真 Nest + supertest）。
 *
 * 硬指标：造真非零 token 样本 + 真配价目，断言 GET /capability-activation/stats
 * 的 dualBasis.currencyValue 是真实折算值（不是 null / 不是 0）、priceReason='OK'。
 *
 * 与 impl-convert 对齐的口径（其 selectTokenByProviderModel）：
 *  - 全局扫 agent_steps，按 provider/model 聚合 (tokensIn>0 OR tokensOut>0) 的行；
 *   返回 {provider, model, in, out, steps}；不走 capability_activation_log、不吃时间窗。
 *  - 折算 convertToAmount(tokens, priceMap, provider, model)：每百万 token 单价；
 *    同币种 OK 组求和；异币种不相加（主币种组 = in+out 最大者）。
 *  - fail-soft：零样本 / 端口缺席 / 折算异常 → currencyValue=null + 非 OK reason。
 *
 * 隔离：所有 provider/model 带唯一 runId；只 PUT 本 runId 的价目；afterAll 按
 * 同一 runId 前缀精确 DELETE（steps / sessions / system_configs / config_history）并复查 0。
 */
describe("Cost conversion makes stats produce real money (real PG e2e)", () => {
  let app: INestApplication;
  let db: DataSource;
  let admin: string;

  const runId = randomUUID().replace(/-/g, "").slice(0, 12);

  // 第一组：1e6 in + 0.5e6 out，价目 in=2 / out=3 CNY → 2 + 1.5 = 3.5
  const providerA = `e2e-conv-a-${runId}`;
  const modelA = `model-x-${runId}`;
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
  const keyAIn = priceKey(providerA, modelA, "in");
  const keyAOut = priceKey(providerA, modelA, "out");

  // 第二组：2e6 in + 0 out，价目 in=1.5 CNY → 3.0；同币种求和 3.5 + 3.0 = 6.5
  const providerB = `e2e-conv-b-${runId}`;
  const modelB = `model-y-${runId}`;
  const sessionB = randomUUID();
  const priceBIn: PricingConfig = {
    provider: providerB,
    model: modelB,
    direction: "in",
    pricePerMillionTokens: 1.5,
    currency: "CNY",
  };

  // 所有本用例写入的 key 都以 runId 收尾段区分；LIKE 精确命中，不碰别的用例。
  const keyLike = `${PRICE_KEY_PREFIX}e2e-conv-%-${runId}.%`;
  const sessionIds = [sessionA, sessionB];

  const unwrapBasis = (body: any): any =>
    body?.dualBasis ?? body?.data?.dualBasis;

  const getStats = async (): Promise<any> => {
    const res = await request(app.getHttpServer())
      .get("/capability-activation/stats")
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
       VALUES ($1, 'chat', 'succeeded', 'e2e-cost-conversion', now(), now())`,
      [id],
    );
  };

  const insertStep = async (
    sessionId: string,
    provider: string,
    model: string,
    tokensIn: number,
    tokensOut: number,
  ): Promise<void> => {
    await db.query(
      `INSERT INTO agent_steps
         ("sessionId", seq, role, "tokensIn", "tokensOut", provider, model)
       VALUES ($1, 1, 'assistant', $2, $3, $4, $5)`,
      [sessionId, tokensIn, tokensOut, provider, model],
    );
  };

  const countSteps = async (): Promise<number> => {
    const r = await db.query(
      'SELECT count(*)::int AS n FROM agent_steps WHERE "sessionId" = ANY($1::uuid[])',
      [sessionIds],
    );
    return Number(r[0]?.n ?? r.rows?.[0]?.n ?? 0);
  };

  const countKeys = async (): Promise<number> => {
    const r = await db.query(
      "SELECT count(*)::int AS n FROM system_configs WHERE key LIKE $1",
      [keyLike],
    );
    return Number(r[0]?.n ?? r.rows?.[0]?.n ?? 0);
  };

  beforeAll(async () => {
    const dbName = process.env.DB_DATABASE ?? "";
    if (!/(^|_)(test|e2e)(_|$)/i.test(dbName)) {
      throw new Error(
        `cost conversion e2e 需要显式 test/e2e 库（收到 ${dbName || "<empty>"}）`,
      );
    }
    app = await createTestApp();
    db = app.get(DataSource);
    admin = await loginAsAdmin(app);
    expect(admin).toBeTruthy();
  });

  afterAll(async () => {
    try {
      if (db) {
        // 精确清理：只删本 runId 的 session/step/价目/config_history。
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
        const keysLeft = await countKeys();
        const sessionsLeft = await db.query(
          "SELECT count(*)::int AS n FROM agent_sessions WHERE id = ANY($1::uuid[])",
          [sessionIds],
        );
        const sessionsN = Number(
          sessionsLeft[0]?.n ?? sessionsLeft.rows?.[0]?.n ?? 0,
        );
        const histLeft = await db.query(
          'SELECT count(*)::int AS n FROM config_history WHERE "configKey" LIKE $1',
          [keyLike],
        );
        const histN = Number(histLeft[0]?.n ?? histLeft.rows?.[0]?.n ?? 0);
        console.log(
          `[cost-conv] runId=${runId} cleanup remaining: steps=${stepsLeft} sessions=${sessionsN} configs=${keysLeft} history=${histN}`,
        );
        expect(stepsLeft).toBe(0);
        expect(sessionsN).toBe(0);
        expect(keysLeft).toBe(0);
        expect(histN).toBe(0);
      }
    } finally {
      await app?.close();
    }
  });

  it("① 零样本诚实（baseline）：配了价目但无 token → currencyValue=null / NO_TOKEN_SAMPLE", async () => {
    // 只配价目，不插任何样本；折算不得因价目存在而编造金额。
    await putPrice(priceAIn);
    await putPrice(priceAOut);

    const before = await countSteps();
    expect(before).toBe(0);

    const basis = await getStats();
    console.log(
      `[cost-conv] ① baseline currencyValue=${basis.currencyValue} priceReason=${basis.priceReason}`,
    );
    expect(basis.currencyValue).toBeNull();
    expect(basis.priceReason).toBe("NO_TOKEN_SAMPLE");
  });

  it("② 出数（硬指标）：真插非零 token + 真配价目 → currencyValue=3.5 / priceReason=OK", async () => {
    await insertSession(sessionA);
    await insertStep(sessionA, providerA, modelA, 1_000_000, 500_000);
    // 幂等 upsert，确保价目在场（① 已落，这里复写同值）。
    await putPrice(priceAIn);
    await putPrice(priceAOut);

    // 副作用对账：真库里确有本 runId 的非零 token 行。
    const rows = await db.query(
      `SELECT "tokensIn", "tokensOut", provider, model FROM agent_steps
        WHERE "sessionId" = $1`,
      [sessionA],
    );
    const found = rows[0] ?? rows.rows?.[0];
    expect(found).toBeDefined();
    expect(Number(found.tokensIn)).toBe(1_000_000);
    expect(Number(found.tokensOut)).toBe(500_000);
    expect(found.provider).toBe(providerA);
    expect(found.model).toBe(modelA);

    const basis = await getStats();
    console.log(
      `[cost-conv] ② ${providerA}/${modelA} currencyValue=${basis.currencyValue} priceReason=${basis.priceReason} tokenSample=${JSON.stringify(basis.tokenSample)}`,
    );
    // 1e6/1e6×2 + 0.5e6/1e6×3 = 2 + 1.5 = 3.5 —— 本轮最关键断言。
    expect(basis.currencyValue).toBe(3.5);
    expect(basis.priceReason).toBe("OK");
  });

  it("③ 缺价目诚实：有 token 但删掉该 provider/model 的价目 → null / PRICE_MISSING", async () => {
    await db.query("DELETE FROM system_configs WHERE key IN ($1, $2)", [
      keyAIn,
      keyAOut,
    ]);
    const keysAfterDelete = await countKeys();
    expect(keysAfterDelete).toBe(0);

    const basis = await getStats();
    console.log(
      `[cost-conv] ③ price-missing currencyValue=${basis.currencyValue} priceReason=${basis.priceReason}`,
    );
    expect(basis.currencyValue).toBeNull();
    expect(basis.priceReason).toBe("PRICE_MISSING");
  });

  it("④ 多 provider 聚合：两行不同 provider/model 同币种 → 金额求和 6.5 / OK", async () => {
    // 恢复 A 组价目 + 插 B 组样本与价目。
    await putPrice(priceAIn);
    await putPrice(priceAOut);
    await insertSession(sessionB);
    await insertStep(sessionB, providerB, modelB, 2_000_000, 0);
    await putPrice(priceBIn);

    const basis = await getStats();
    console.log(
      `[cost-conv] ④ multi-provider currencyValue=${basis.currencyValue} priceReason=${basis.priceReason} note=${basis.allocationNote}`,
    );
    // A=3.5（CNY）+ B=3.0（CNY）= 6.5；同币种必须相加。
    expect(basis.currencyValue).toBe(6.5);
    expect(basis.priceReason).toBe("OK");
  });
});
