import * as fs from "fs";
import * as path from "path";

/**
 * AUTH-03: 迁移 1790000000000 存在性 / 幂等性 / 时间戳避让断言。
 * 声明占用：002/AUTH-03（此前最高 1789900000003=OBS-01）。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "..", "migrations");
const TARGET = "1790000000000-CreateApiKeys.ts";

describe("AUTH-03 迁移 1790000000000（api_keys 表）", () => {
  const sql = () =>
    fs.readFileSync(path.join(MIGRATIONS_DIR, TARGET), "utf8");

  it("迁移文件存在且类名后缀与时间戳一致", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(path.join(MIGRATIONS_DIR, TARGET));
    const proto: any = Object.values(mod)[0] as any;
    const instance = proto?.prototype ? new proto() : proto;
    expect(instance.name).toBe("CreateApiKeys1790000000000");
    expect(typeof instance.up).toBe("function");
    expect(typeof instance.down).toBe("function");
  });

  it("时间戳严格晚于此前最高 1789900000003（OBS-01）且未被占用", () => {
    const stamp = Number(TARGET.split("-")[0]);
    expect(stamp).toBeGreaterThan(1789900000003);
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{13}-/.test(f));
    const stamps = files.map((f) => Number(f.split("-")[0]));
    expect(stamps.filter((s) => s === 1790000000000).length).toBe(1);
  });

  it("api_keys 列完整（userId/name/keyPrefix/keyHash/scope/expiresAt/revokedAt/lastUsedAt）且幂等", () => {
    const body = sql();
    expect(body).toContain('CREATE TABLE IF NOT EXISTS "api_keys"');
    expect(body).toContain('"userId" INTEGER NOT NULL');
    expect(body).toContain('"name" VARCHAR(100) NOT NULL');
    expect(body).toContain('"keyPrefix" VARCHAR(16) NOT NULL');
    expect(body).toContain('"keyHash" VARCHAR(64) NOT NULL');
    expect(body).toContain('"scope" VARCHAR(16) NOT NULL DEFAULT \'readonly\'');
    expect(body).toContain('"expiresAt" TIMESTAMPTZ NULL');
    expect(body).toContain('"revokedAt" TIMESTAMPTZ NULL');
    expect(body).toContain('"lastUsedAt" TIMESTAMPTZ NULL');
  });

  it("keyHash 唯一索引 + userId 索引幂等创建且 down 可回滚", () => {
    const body = sql();
    expect(body).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "idx_api_keys_key_hash"');
    expect(body).toContain('CREATE INDEX IF NOT EXISTS "idx_api_keys_user_id"');
    expect(body).toContain('DROP INDEX IF EXISTS "idx_api_keys_key_hash"');
    expect(body).toContain('DROP INDEX IF EXISTS "idx_api_keys_user_id"');
    expect(body).toContain('DROP TABLE IF EXISTS "api_keys"');
  });
});
