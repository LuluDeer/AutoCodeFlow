import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";
import { createTestApp, loginAsAdmin } from "./helpers/app.helper";
import { PRICE_KEY_PREFIX } from "../src/modules/capability-activation/price.dto";

/**
 * 价目表管理 UI 依赖端点 —— AGENTS §4.4 第 3 级（真 PG + 真 Nest + supertest）。
 *
 * 断言的是副作用：PUT 真落 system_configs（key/valueType/JSON value），
 * GET 真读回，upsert 单行更新，非法输入/非 ADMIN 零新增行，
 * afterAll 按本次 runId 前缀精确 DELETE 并复查 0 行。
 *
 * 不改任何源码；随机前缀隔离，避免碰到其它用例的键。
 */
describe("Price endpoint for management UI (real PG e2e)", () => {
  let app: INestApplication;
  let db: DataSource;
  let adminToken: string;
  let userToken: string;
  let userId: number | null = null;

  const runId = randomUUID().replace(/-/g, "").slice(0, 12);
  // 所有本用例写入的 key 都以 provider 里的 runId 开头，清理 LIKE 精确命中。
  const provider = `e2e-price-${runId}`;
  const badProvider = `e2e-price-bad-${runId}`;
  const model = `model-${runId}`;
  const direction = "in";
  const key = `${PRICE_KEY_PREFIX}${provider}.${model}.${direction}`;
  const likePattern = `${PRICE_KEY_PREFIX}e2e-price-%${runId}.%`;
  const badLikePattern = `${PRICE_KEY_PREFIX}${badProvider}.%`;

  const validDto = {
    provider,
    model,
    direction,
    pricePerMillionTokens: 2.5,
    currency: "CNY",
  };
  const updatedDto = { ...validDto, pricePerMillionTokens: 3.75 };

  const unwrap = <T>(body: any): T => (body?.data ?? body) as T;

  const rowsForRun = async (): Promise<
    Array<{ key: string; value: string; valueType: string }>
  > =>
    db.query(
      'SELECT key, value, "valueType" FROM system_configs WHERE key LIKE $1 ORDER BY key',
      [likePattern],
    );

  const rowsForBad = async (): Promise<Array<{ key: string }>> =>
    db.query("SELECT key FROM system_configs WHERE key LIKE $1", [
      badLikePattern,
    ]);

  const rowForValidKey = async () =>
    db.query(
      'SELECT key, value, "valueType" FROM system_configs WHERE key = $1',
      [key],
    );

  const expect2xx = (status: number): void => {
    expect(status).toBeGreaterThanOrEqual(200);
    expect(status).toBeLessThan(300);
  };

  beforeAll(async () => {
    const dbName = process.env.DB_DATABASE ?? "";
    if (!/(^|_)(test|e2e)(_|$)/i.test(dbName)) {
      throw new Error(
        `price endpoint e2e 需要显式 test/e2e 库（收到 DB_DATABASE=${dbName || "<empty>"}）`,
      );
    }
    app = await createTestApp();
    db = app.get(DataSource);
    adminToken = await loginAsAdmin(app);
    expect(adminToken).toBeTruthy();

    // 真注册面建一个 role=user 账号并登录，验证 ADMIN-only 闸的 403。
    const username = `e2e-price-user-${runId}`;
    const password = `Aa1!${runId}x`;
    const created = await request(app.getHttpServer())
      .post("/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        username,
        password,
        email: `${username}@example.invalid`,
        role: "user",
      })
      .expect(201);
    userId = unwrap<{ id: number }>(created.body).id ?? null;
    expect(userId).toBeTruthy();

    const loggedIn = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ username, password })
      .expect(201);
    userToken = unwrap<{ accessToken: string }>(loggedIn.body).accessToken;
    expect(userToken).toBeTruthy();
  });

  afterAll(async () => {
    try {
      if (db) {
        await db.query("DELETE FROM system_configs WHERE key LIKE $1", [
          likePattern,
        ]);
        const left = await rowsForRun();
        console.log(`[price-e2e] runId=${runId} cleanup remaining=${left.length}`);
        expect(left).toHaveLength(0); // 清理复查：system_configs 0 行

        // upsert 会产生 config_history；按同一 runId 前缀清掉，避免后续用例误读。
        await db.query(
          'DELETE FROM config_history WHERE "configKey" LIKE $1',
          [likePattern],
        );
        const histLeft = await db.query(
          'SELECT count(*)::int AS n FROM config_history WHERE "configKey" LIKE $1',
          [likePattern],
        );
        const histN = Array.isArray(histLeft)
          ? histLeft[0]?.n
          : histLeft?.rows?.[0]?.n;
        console.log(`[price-e2e] history remaining=${histN}`);
      }
      if (db && userId !== null) {
        await db.query(
          'DELETE FROM refresh_tokens WHERE "userId" = $1',
          [userId],
        );
        await db.query("DELETE FROM users WHERE id = $1", [userId]);
        console.log(`[price-e2e] user=${userId} cleaned`);
      }
    } finally {
      await app?.close();
    }
  });

  it("① ADMIN PUT 合法 DTO → 真库落一行 key/valueType=json/value 逐字段一致", async () => {
    const before = await rowsForRun();
    expect(before).toHaveLength(0);

    const res = await request(app.getHttpServer())
      .put("/capability-activation/price")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(validDto);
    expect2xx(res.status);

    const rows = await rowForValidKey();
    console.log(`[price-e2e] PUT row=${JSON.stringify(rows)}`);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe(
      `acf.showback.price.${provider}.${model}.${direction}`,
    );
    expect(rows[0].valueType).toBe("json");
    const parsed = JSON.parse(rows[0].value);
    expect(parsed).toEqual(validDto);
    expect(parsed.pricePerMillionTokens).toBe(2.5);
  });

  it("② ADMIN GET 读回 → 列表中刚 PUT 的 config 字段逐项一致", async () => {
    const res = await request(app.getHttpServer())
      .get("/capability-activation/price")
      .set("Authorization", `Bearer ${adminToken}`);
    expect2xx(res.status);

    const list = unwrap<Array<Record<string, unknown>>>(res.body);
    expect(Array.isArray(list)).toBe(true);
    const found = list.filter(
      (item) =>
        item?.provider === provider &&
        item?.model === model &&
        item?.direction === direction,
    );
    console.log(`[price-e2e] GET matched=${JSON.stringify(found)}`);
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual(validDto);
  });

  it("③ 同 key 再 PUT 不同价格 → 真库仍 1 行且 value 更新", async () => {
    const res = await request(app.getHttpServer())
      .put("/capability-activation/price")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(updatedDto);
    expect2xx(res.status);

    const rows = await rowForValidKey();
    console.log(`[price-e2e] UPSERT rows=${JSON.stringify(rows)}`);
    expect(rows).toHaveLength(1);
    const parsed = JSON.parse(rows[0].value);
    expect(parsed).toEqual(updatedDto);
    expect(parsed.pricePerMillionTokens).toBe(3.75);
    expect(rows[0].valueType).toBe("json");
  });

  it("④ 非法输入（currency/price/direction）→ 400 且真库零新增行", async () => {
    const invalidCases: Array<[string, Record<string, unknown>]> = [
      ["currency 非 3 字母", { ...validDto, currency: "US" }],
      ["price ≤ 0（零）", { ...validDto, pricePerMillionTokens: 0 }],
      ["price ≤ 0（负数）", { ...validDto, pricePerMillionTokens: -1 }],
      ["direction 非法", { ...validDto, direction: "side" }],
    ];

    for (const [label, dto] of invalidCases) {
      const countBefore = (await rowsForRun()).length;
      const badBefore = (await rowsForBad()).length;
      const res = await request(app.getHttpServer())
        .put("/capability-activation/price")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ ...dto, provider: badProvider });
      expect(res.status).toBe(400);
      const countAfter = (await rowsForRun()).length;
      const badAfter = (await rowsForBad()).length;
      console.log(
        `[price-e2e] invalid ${label}: status=${res.status} rows=${countBefore}->${countAfter} badRows=${badBefore}->${badAfter}`,
      );
      expect(countAfter).toBe(countBefore);
      expect(badAfter).toBe(badBefore);
    }
  });

  it("⑤ 非 ADMIN（USER token）PUT/GET → 403 且零副作用", async () => {
    const before = await rowsForRun();

    const put = await request(app.getHttpServer())
      .put("/capability-activation/price")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ ...validDto, pricePerMillionTokens: 99 });
    expect(put.status).toBe(403);

    const get = await request(app.getHttpServer())
      .get("/capability-activation/price")
      .set("Authorization", `Bearer ${userToken}`);
    expect(get.status).toBe(403);

    const after = await rowsForRun();
    console.log(
      `[price-e2e] user PUT=${put.status} GET=${get.status} rows=${before.length}->${after.length}`,
    );
    expect(after).toEqual(before);
    const rows = await rowForValidKey();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].value).pricePerMillionTokens).toBe(3.75);
  });
});
