import * as fs from "fs";
import * as path from "path";
import { NormalizeUploadedVersionStatus1790000000037 } from "../1790000000037-NormalizeUploadedVersionStatus";

/**
 * 迁移 1790000000037 结构断言（无真机 PG 的单测环境约定——SQL 文本逐段断言，
 * 先例 add-executor-heartbeat-misses.migration.spec）。
 *
 * 本迁移修的是「zip 上传的版本无法回滚」：把 recordUploadVersion 当初写下的
 * status='uploaded' 存量行归一为 'released'。
 */

const MIGRATIONS_DIR = path.join(__dirname, "..");
const FILE = path.join(
  MIGRATIONS_DIR,
  "1790000000037-NormalizeUploadedVersionStatus.ts",
);

describe("NormalizeUploadedVersionStatus1790000000037（zip 上传版本可回滚）", () => {
  let sql: string;
  let migration: NormalizeUploadedVersionStatus1790000000037;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new NormalizeUploadedVersionStatus1790000000037();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("NormalizeUploadedVersionStatus1790000000037");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：把 status='uploaded' 归一为 'released'", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('UPDATE "application_versions"');
    expect(upPart).toMatch(/SET "status" = 'released'/);
    expect(upPart).toMatch(/WHERE "status" = 'uploaded'/);
  });

  it("范围闸：只碰上传来源的行（sourceDeploymentId IS NULL）", () => {
    // 部署路径产生的行 status 由部署生命周期驱动（deploying/released/failed）。
    // 若不限定 sourceDeploymentId IS NULL，本迁移会把在途/失败的部署版本一并
    // 误标成 released——那会让回滚面接受一个从未成功发布过的版本。
    const upPart = sql.split("public async down")[0];
    expect(upPart).toMatch(/"sourceDeploymentId" IS NULL/);
  });

  it("down 为有意空操作（不把缺陷取值写回去）", () => {
    const downPart = sql.split("public async down")[1];
    // 断言 down 内不含任何 UPDATE——还原 'uploaded' 等于重新制造该 bug。
    expect(downPart).not.toMatch(/UPDATE\s+"application_versions"/);
  });
});
