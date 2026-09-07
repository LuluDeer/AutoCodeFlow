import * as fs from "fs";
import * as path from "path";

/**
 * SEC-03: 迁移 1789800000001 存在性 / 幂等性 / 时间戳避让断言。
 * 声明占用：002/SEC-03（004/CORE-03 声明 1789800000000，须避开）。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "..", "migrations");
const TARGET = "1789800000001-AddUserTotpAndSessionMeta.ts";

describe("SEC-03 迁移 1789800000001（users TOTP 列 + refresh_tokens 会话元数据）", () => {
  const sql = () =>
    fs.readFileSync(path.join(MIGRATIONS_DIR, TARGET), "utf8");

  it("迁移文件存在且类名后缀与时间戳一致", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(path.join(MIGRATIONS_DIR, TARGET));
    // ts-jest 编译产物是 prototype 方法（非类静态），取第一个导出后查原型。
    const proto: any = Object.values(mod)[0] as any;
    const instance = proto?.prototype ? new proto() : proto;
    expect(instance.name).toBe("AddUserTotpAndSessionMeta1789800000001");
    expect(typeof instance.up).toBe("function");
    expect(typeof instance.down).toBe("function");
  });

  it("时间戳严格避开 1789800000000（004/CORE-03 声明）且晚于既有最高 1789600000000", () => {
    const stamp = Number(TARGET.split("-")[0]);
    expect(stamp).toBeGreaterThan(1789800000000);
    expect(stamp).toBeGreaterThan(1789600000000);
  });

  it("users.totpSecret / users.totpEnabled 列幂等添加（IF NOT EXISTS）且 down 可回滚", () => {
    const body = sql();
    expect(body).toContain('ADD COLUMN IF NOT EXISTS "totpSecret"');
    expect(body).toContain('ADD COLUMN IF NOT EXISTS "totpEnabled"');
    expect(body).toContain("BOOLEAN NOT NULL DEFAULT false");
    expect(body).toContain('DROP COLUMN IF EXISTS "totpSecret"');
    expect(body).toContain('DROP COLUMN IF EXISTS "totpEnabled"');
  });

  it("refresh_tokens.userAgent / refresh_tokens.ip 会话展示列幂等添加且 down 可回滚", () => {
    const body = sql();
    expect(body).toContain('"refresh_tokens"');
    expect(body).toContain('ADD COLUMN IF NOT EXISTS "userAgent"');
    expect(body).toContain('ADD COLUMN IF NOT EXISTS "ip"');
    expect(body).toContain('DROP COLUMN IF EXISTS "userAgent"');
    expect(body).toContain('DROP COLUMN IF EXISTS "ip"');
  });
});
