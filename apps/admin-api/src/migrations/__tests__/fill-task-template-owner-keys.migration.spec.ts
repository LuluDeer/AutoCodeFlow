import * as fs from "fs";
import * as path from "path";
import { FillTaskTemplateOwnerKeys1790000000058 } from "../1790000000058-FillTaskTemplateOwnerKeys";

/**
 * R39-A1 后续：属主键回填迁移的**结构断言**（无真机 PG 的单测约定——SQL 文本逐段断言，
 * 先例 add-api-key-task-trigger-scope.migration.spec）。
 *
 * 这类 data-only 迁移最危险的失败模式不是「跑不动」，而是「跑动了但写坏数据」：
 * 截断把 id 段切掉 ⇒ 该行从「按 id 判定」悄悄退回 legacy（等于迁移白做且更难发现）；
 * 幂等谓词写错 ⇒ 重放时二次改写。所以下面把三条关键子句都钉住。
 */

const FILE = path.join(__dirname, "..", "1790000000058-FillTaskTemplateOwnerKeys.ts");

describe("FillTaskTemplateOwnerKeys1790000000058（R39-A1 后续）", () => {
  let sql: string;
  let migration: FillTaskTemplateOwnerKeys1790000000058;

  beforeAll(() => {
    sql = fs.readFileSync(FILE, "utf8");
    migration = new FillTaskTemplateOwnerKeys1790000000058();
  });

  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    expect(migration.name).toBe("FillTaskTemplateOwnerKeys1790000000058");
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
  });

  it("up：只 UPDATE task_templates 的 createdBy，不动任何 schema", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('UPDATE "task_templates"');
    expect(upPart).toContain('SET "createdBy"');
    // data-only：不许出现任何 DDL
    expect(upPart).not.toMatch(/ALTER TABLE|CREATE (INDEX|TABLE)|DROP (INDEX|TABLE)/);
  });

  it("up：只升级「属主仍存在」的行（JOIN users ON username）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain('FROM "users" u');
    expect(upPart).toContain('t."createdBy" = u.username');
  });

  it("up：键形态 = user:<id>|<username>，且**截断只作用于尾部**（id 段绝不会被切）", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain("'user:' || u.id::text || '|' || u.username");
    // left(...,100) 必须包住整个拼接串：先拼后截 ⇒ 只会裁 username 尾巴。
    expect(upPart).toMatch(/left\(\s*'user:' \|\| u\.id::text \|\| '\|' \|\| u\.username\s*,\s*100\s*\)/);
  });

  it("up：幂等——已升级的行（^user:<digits>|）不被二次处理", () => {
    const upPart = sql.split("public async down")[0];
    expect(upPart).toContain("!~ '^user:[0-9]+\\|'");
  });

  it("down：把键还原成裸 username（可逆）", () => {
    const downPart = sql.split("public async down")[1] ?? "";
    expect(downPart).toContain("regexp_replace");
    expect(downPart).toContain("~ '^user:[0-9]+\\|'");
  });
});
