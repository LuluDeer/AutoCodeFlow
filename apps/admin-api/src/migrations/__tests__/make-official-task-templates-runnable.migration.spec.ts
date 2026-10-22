import * as fs from "fs";
import * as path from "path";
import { MakeOfficialTaskTemplatesRunnable1790000000060 } from "../1790000000060-MakeOfficialTaskTemplatesRunnable";

/**
 * 官方模板可运行化迁移的**结构断言**（无真机 PG 的单测约定：调 up/down 捕获 SQL，
 * 先例 fill-task-template-owner-keys.migration.spec）。
 *
 * 这条迁移最危险的失败模式不是「跑不动」，而是：
 *  - 误伤用户自建模板（漏了 isOfficial / key 守卫）；
 *  - 把 glueSource 的换行/引号写坏（SQL 转义错 ⇒ jsonb 解析失败，迁移整体回滚）；
 *  - 顺手改了 key/name/category 或 updatedAt（定位漂移、审计时间被污染）。
 * 因此下面把守卫子句、脚本标记与「只改 config/description」逐条钉住。
 * 数值 parity（常量 ↔ SQL 逐字一致、down 恢复旧值）由
 * modules/task-template/__tests__/task-template.migration.spec.ts 覆盖。
 */

const FILE = path.join(
  __dirname,
  "..",
  "1790000000060-MakeOfficialTaskTemplatesRunnable.ts",
);

const LEGACY_KEYS = [
  "scheduled_backup",
  "health_check",
  "data_sync",
  "log_cleanup",
  "webhook_ping",
];

async function capture(): Promise<{ up: string; down: string }> {
  const migration = new MakeOfficialTaskTemplatesRunnable1790000000060();
  const queries: string[] = [];
  const runner = {
    query: async (sql: string) => {
      queries.push(sql);
    },
  };
  await migration.up(runner as any);
  await migration.down(runner as any);
  expect(queries).toHaveLength(2);
  return { up: queries[0], down: queries[1] };
}

describe("MakeOfficialTaskTemplatesRunnable1790000000060", () => {
  it("可被 TypeORM 解析（name/up/down 契约）", () => {
    const migration = new MakeOfficialTaskTemplatesRunnable1790000000060();
    expect(migration.name).toBe(
      "MakeOfficialTaskTemplatesRunnable1790000000060",
    );
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
    // 文件名 timestamp 与类名后缀一致（TypeORM 排序依赖）。
    expect(path.basename(FILE)).toBe(
      "1790000000060-MakeOfficialTaskTemplatesRunnable.ts",
    );
  });

  it("up：只 UPDATE config/description，不改 schema、不动 name/category/updatedAt", async () => {
    const { up } = await capture();
    expect(up).toContain('UPDATE "task_templates"');
    expect(up).toContain('SET "config" = v."config"');
    expect(up).toContain('"description" = v."description"');
    expect(up).not.toMatch(
      /ALTER TABLE|CREATE (INDEX|TABLE)|DROP (INDEX|TABLE)/,
    );
    const setClause = up.split("FROM (VALUES")[0];
    expect(setClause).not.toContain('"name"');
    expect(setClause).not.toContain('"category"');
    expect(setClause).not.toContain('"updatedAt"');
  });

  it("up：5 行全部改成内联脚本（glueSource/glueLanguage，无 entrypoint）", async () => {
    const { up } = await capture();
    expect(up.match(/"glueSource":/g)).toHaveLength(5);
    expect(up.match(/"glueLanguage":/g)).toHaveLength(5);
    expect(up).not.toContain('"entrypoint":');
    // 断言到具体语言：node → javascript，python → python。
    expect(up).toContain('"runtime":"node","glueLanguage":"javascript"');
    expect(up).toContain('"runtime":"python","glueLanguage":"python"');
  });

  it("up/down：只命中 isOfficial=true 且 key 命中的行（幂等、不误伤自定义模板）", async () => {
    const { up, down } = await capture();
    for (const sql of [up, down]) {
      expect(sql).toContain('t."isOfficial" = true');
      expect(sql).toContain('WHERE t."key" = v."key"');
      for (const key of LEGACY_KEYS) {
        expect(sql).toContain(`('${key}'`);
      }
      // 官方 key 之外不出现别的 key 字面量。
      expect(sql.match(/\('[a-z_]+',/g)).toHaveLength(5);
    }
  });

  it("down：恢复旧形态（entrypoint 回来、glueSource 退场）", async () => {
    const { down } = await capture();
    expect(down.match(/"entrypoint":/g)).toHaveLength(5);
    expect(down).not.toContain('"glueSource":');
    // 与初始 seed 完全相同的 entrypoint 文件名。
    for (const entry of [
      "backup.sh",
      "check.sh",
      "sync.py",
      "cleanup.sh",
      "ping.js",
    ]) {
      expect(down).toContain(`"entrypoint":"${entry}"`);
    }
  });

  it("up 可重放：连续两次 up 产生逐字节相同的 SQL（SET 固定值 + 键匹配）", async () => {
    const migration = new MakeOfficialTaskTemplatesRunnable1790000000060();
    const run = async () => {
      const queries: string[] = [];
      await migration.up({
        query: async (sql: string) => {
          queries.push(sql);
        },
      } as any);
      return queries[0];
    };
    expect(await run()).toBe(await run());
  });

  it("SQL 用 String.raw 内联（否则 jsonb 里的 \\n 会被 TS 模板解释成真换行）", () => {
    const source = fs.readFileSync(FILE, "utf8");
    expect(source.match(/queryRunner\.query\(String\.raw`/g)).toHaveLength(2);
    expect(source).not.toContain("queryRunner.query(`");
  });
});
