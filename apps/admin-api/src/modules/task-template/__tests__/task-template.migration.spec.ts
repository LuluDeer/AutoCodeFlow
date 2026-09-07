/**
 * CORE-03：迁移 1789800000000-CreateTaskTemplates 的幂等/结构/seed-parity 断言。
 *
 * 迁移内 seed 是冻结快照（不 import 应用常量），本 spec 反向核对：
 * 迁移里的 VALUES 必须与运行时 OFFICIAL_TASK_TEMPLATES 逐项一致（漂移即红），
 * 且 key/字段/五个官方模板定位与 mcp `TASK_TEMPLATES` 对齐由常量测试保证。
 */
import * as fs from "fs";
import * as path from "path";
import { OFFICIAL_TASK_TEMPLATES } from "../task-template.constants";

const MIGRATION_FILE = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "migrations",
  "1789800000000-CreateTaskTemplates.ts",
);

const SQL = fs.readFileSync(MIGRATION_FILE, "utf8");

// 逐行捕获 VALUES：('key', 'name', 'desc', 'cat', '{...}'::jsonb, true)
const ROW_RE =
  /\('([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'(\{[^']*\})'::jsonb,\s*true\)/g;

function parseSeedRows() {
  const rows: {
    key: string;
    name: string;
    description: string;
    category: string;
    config: Record<string, unknown>;
  }[] = [];
  let m: RegExpExecArray | null;
  while ((m = ROW_RE.exec(SQL)) !== null) {
    rows.push({
      key: m[1],
      name: m[2],
      description: m[3],
      category: m[4],
      config: JSON.parse(m[5]),
    });
  }
  return rows;
}

describe("CreateTaskTemplates1789800000000 (CORE-03)", () => {
  it("迁移类可解析：name 与类名一致且 up/down 为函数", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(MIGRATION_FILE);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctor = Object.values(mod)[0] as any;
    expect(Ctor.name).toBe("CreateTaskTemplates1789800000000");
    expect(Ctor.name.endsWith("1789800000000")).toBe(true);
    const instance = new Ctor();
    expect(typeof instance.up).toBe("function");
    expect(typeof instance.down).toBe("function");
  });

  it("幂等标记：建表/索引 IF NOT EXISTS + seed ON CONFLICT DO NOTHING", () => {
    expect(SQL).toContain('CREATE TABLE IF NOT EXISTS "task_templates"');
    expect(SQL).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "uq_task_templates_key"',
    );
    expect(SQL).toContain('ON CONFLICT ("key") DO NOTHING');
    expect(SQL).toContain('DROP TABLE IF EXISTS "task_templates"');
  });

  it("seed 恰好预置 5 个官方模板，key 与定位对齐 mcp 常量", () => {
    const rows = parseSeedRows();
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.key).sort()).toEqual(
      OFFICIAL_TASK_TEMPLATES.map((t) => t.key).sort(),
    );
    for (const t of OFFICIAL_TASK_TEMPLATES) {
      expect(rows.map((r) => r.key)).toContain(t.key);
    }
  });

  it("每个官方模板的 name/category/description/config 与运行时常量逐项一致", () => {
    const rows = parseSeedRows();
    for (const t of OFFICIAL_TASK_TEMPLATES) {
      const row = rows.find((r) => r.key === t.key);
      expect(row).toBeDefined();
      expect(row!.name).toBe(t.name);
      expect(row!.category).toBe(t.category);
      expect(row!.description).toBe(t.description);
      // JSON.parse 两侧深比较，键序无关（toEqual 语义）
      expect(row!.config).toEqual(t.config);
    }
  });

  it("全部 seed 行 isOfficial=true（官方由迁移产生，端点只建自定义）", () => {
    // ROW_RE 强制末段 `, true)`，能解析出 5 行即证明 5 行均 true。
    expect(parseSeedRows()).toHaveLength(5);
  });
});
