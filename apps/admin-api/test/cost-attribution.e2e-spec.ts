import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";
import { createTestApp, loginAsAdmin } from "./helpers/app.helper";
import { priceKey } from "../src/modules/capability-activation/price.service";

/**
 * AGENTS §4.4 第 3 级：真 PG + 真 Nest + 真 HTTP（supertest）。
 * 成本归责诚实标缺：① PUT price 落 system_configs（valueType=json、价目>0）；
 * ② stats 在零样本夹具下 currencyValue=null、priceReason=NO_TOKEN_SAMPLE（有价目也不编造）；
 * ③ token-sample 对 SOP id 返回 no_link、tokens null（不把 SOP id 当 agent session）。
 * 随机 key/model 隔离，afterAll 精确清理自建配置。
 */
describe("Cost attribution honesty (real PG e2e)", () => {
  let app: INestApplication;
  let db: DataSource;
  let admin: string;

  const runId = `${Date.now()}`;
  const provider = `e2e-provider-${runId}`;
  const model = `e2e-model-${runId}`;
  const configKey = priceKey(provider, model, "in");
  const priceCfg = {
    provider,
    model,
    direction: "in",
    pricePerMillionTokens: 2.5,
    currency: "CNY",
  };

  beforeAll(async () => {
    const dbName = process.env.DB_DATABASE ?? "";
    if (!/(^|_)(test|e2e)(_|$)/i.test(dbName)) {
      throw new Error(
        `cost attribution e2e 需要 test/e2e 库（收到 ${dbName || "<empty>"}）`,
      );
    }
    app = await createTestApp();
    db = app.get(DataSource);
    admin = await loginAsAdmin(app);
  });

  afterAll(async () => {
    await db.query("DELETE FROM system_configs WHERE key = $1", [configKey]);
    await app?.close();
  });

  it("PUT price 落库且 stats/token-sample 对零样本诚实标缺（不编造 0 元）", async () => {
    // 1) 价目落库副作用
    await request(app.getHttpServer())
      .put("/capability-activation/price")
      .set("Authorization", `Bearer ${admin}`)
      .send(priceCfg)
      .expect(200);
    const rows = await db.query(
      'SELECT value, "valueType" FROM system_configs WHERE key = $1',
      [configKey],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].valueType).toBe("json");
    expect(JSON.parse(rows[0].value).pricePerMillionTokens).toBe(2.5);

    // 2) stats 零样本诚实标缺：即使有价目，金额仍 null（e2e 测试库无真实 usage 样本）
    const stats = await request(app.getHttpServer())
      .get("/capability-activation/stats")
      .set("Authorization", `Bearer ${admin}`)
      .expect(200);
    const basis = stats.body?.dualBasis ?? stats.body?.data?.dualBasis;
    expect(basis).toBeDefined();
    expect(basis.currencyValue).toBeNull();
    expect(basis.priceReason).not.toBe("OK");

    // 3) token-sample 对 SOP id（非 UUID 命名空间）返回 no_link、tokens null
    const sample = await request(app.getHttpServer())
      .get("/capability-activation/token-sample")
      .query({ sessionId: "sop-not-an-agent-session" })
      .set("Authorization", `Bearer ${admin}`)
      .expect(200);
    const view = sample.body?.data ?? sample.body;
    expect(view.status).toBe("no_link");
    expect(view.tokensIn).toBeNull();
    expect(view.resolvedAgentSessionId).toBeNull();
  });
});
