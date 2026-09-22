import * as fs from "fs";
import * as path from "path";
import { AddExecutorHeartbeatMisses1790000000036 } from "../1790000000036-AddExecutorHeartbeatMisses";

/**
 * NETOPT-G P1-7：迁移 1790000000036 结构断言（无真机 PG 的单测环境约定——
 * SQL 文本逐段断言，先例 add-app-deployment-version.migration.spec）。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000036-AddExecutorHeartbeatMisses.ts",
);

describe("AddExecutorHeartbeatMisses1790000000036（NETOPT-G P1-7）", () => {
  let sql: string;
  let migration: AddExecutorHeartbeatMisses1790000000036;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new AddExecutorHeartbeatMisses1790000000036();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("AddExecutorHeartbeatMisses1790000000036");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：executors 加 consecutiveHeartbeatMisses INTEGER NOT NULL DEFAULT 0", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('ALTER TABLE "executors"');
    expect(upPart).toContain(
      'ADD COLUMN IF NOT EXISTS "consecutiveHeartbeatMisses" integer NOT NULL DEFAULT 0',
    );
  });

  it("默认 0：存量行不因迁移被判成已错过一轮（否则上线即误判）", () => {
    const upPart = sql.split("public async down")[0];
    // DEFAULT 0 是安全前提：sweep 的跃迁谓词是 ">= requiredMisses"，
    // 若存量行默认成非 0，迁移后首个 sweep 轮就会把在线执行器判死。
    expect(upPart).toMatch(/DEFAULT 0/);
  });

  it("幂等：up 用 ADD COLUMN IF NOT EXISTS、down 用 DROP COLUMN IF EXISTS", () => {
    // 只断言**执行语句**的形态，不做全文计数——本文件 docstring 在散文里也
    // 提到了同样的短语，计数会把注释算进去（首版即踩此坑）。
    const upPart = sql.split("public async down")[0];
    const downPart = sql.split("public async down")[1];
    // up 里唯一的 ALTER 语句必须带 IF NOT EXISTS（可重复执行）
    expect(upPart).toMatch(
      /ALTER TABLE "executors"\s+ADD COLUMN IF NOT EXISTS "consecutiveHeartbeatMisses"/,
    );
    // down 必须带 IF EXISTS（revert 重放无副作用）
    expect(downPart).toMatch(
      /ALTER TABLE "executors" DROP COLUMN IF EXISTS "consecutiveHeartbeatMisses"/,
    );
  });

  it("down 删列 consecutiveHeartbeatMisses", () => {
    const downPart = sql.split("public async down")[1];
    expect(downPart).toContain(
      'DROP COLUMN IF EXISTS "consecutiveHeartbeatMisses"',
    );
  });
});
