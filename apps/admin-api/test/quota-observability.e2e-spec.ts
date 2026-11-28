import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { DataSource } from "typeorm";
import { createTestApp, loginAsAdmin } from "./helpers/app.helper";

/**
 * AGENTS §4.4 第 3 级：真 PG + 真 Nest + 真 HTTP（supertest）。
 * 成本归责可观测性：金额闸在零样本下 fail-open，但必须**显式说明原因**——
 * quota-status 的 unit=amount 行带 amount=null + priceReason + amountNote
 * （"硬闸已跳过，未与 0 比较"），让管理员不把静默 fail-open 误读成"未超限"。
 * 随机 key 隔离，afterAll 精确清理自建配置。
 */
describe("Quota amount observability (real PG e2e)", () => {
  let app: INestApplication;
  let db: DataSource;
  let admin: string;

  const runId = randomUUID().slice(0, 8);
  const quotaKey = `acf.showback.quota.project.e2e-amount-${runId}`;

  beforeAll(async () => {
    const dbName = process.env.DB_DATABASE ?? "";
    if (!/(^|_)(test|e2e)(_|$)/i.test(dbName)) {
      throw new Error(
        `quota observability e2e 需要 test/e2e 库（收到 ${dbName || "<empty>"}）`,
      );
    }
    app = await createTestApp();
    db = app.get(DataSource);
    admin = await loginAsAdmin(app);
  });

  afterAll(async () => {
    await db.query("DELETE FROM system_configs WHERE key = $1", [quotaKey]);
    await app?.close();
  });

  it("unit=amount 零样本：quota-status 显式标'金额不可得/硬闸跳过'，不说未超限", async () => {
    await request(app.getHttpServer())
      .put("/capability-activation/quota")
      .set("Authorization", `Bearer ${admin}`)
      .send({
        scope: "project",
        target: `e2e-amount-${runId}`,
        softLimit: 1,
        hardLimit: 10,
        windowDays: 30,
        unit: "amount",
        amountHardLimit: 1,
      })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get("/capability-activation/quota-status")
      .query({ windowDays: 30 })
      .set("Authorization", `Bearer ${admin}`)
      .expect(200);
    const rows = res.body?.data ?? res.body;
    const row = rows.find(
      (r: { target?: string }) => r.target === `e2e-amount-${runId}`,
    );
    expect(row).toBeDefined();
    expect(row.unit).toBe("amount");
    expect(row.amount).toBeNull();
    // 行级 priceReason 在零样本下可能缺席（stats 顶层 dualBasis 有），核心是
    // amountNote 必须显式说明跳过——不能静默 fail-open 也不说"未超限"。
    expect(row.amountNote).toContain("硬闸已跳过");
    expect(row.amountNote).toContain("未与 0 比较");
    expect(row.amountNote).not.toContain("未超限");
  });
});
