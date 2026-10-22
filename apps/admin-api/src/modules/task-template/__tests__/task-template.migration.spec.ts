/**
 * CORE-03：迁移 1789800000000-CreateTaskTemplates 的幂等/结构/seed-parity 断言，
 * 以及后续迁移 1790000000060「官方模板可运行化」的覆盖校验。
 *
 * 初始迁移是**冻结快照**（不 import 应用常量）：它 seed 的是历史 config
 * （entrypoint 指向并不存在的 backup.sh/check.sh/...）。可运行化由后续 data-only
 * 迁移完成，因此本 spec 的口径是：
 *
 * 1. 初始迁移的 key/name/category 仍必须与运行时 OFFICIAL_TASK_TEMPLATES 一致
 *    （模板定位不许漂移）；
 * 2. 初始迁移的 config/description **允许**被后续迁移覆盖——断言它保持旧形态
 *    （entrypoint、无 glueSource），以此证明「没有偷改历史迁移」；
 * 3. 新迁移 up 的 SQL 必须逐字包含运行时常量的当前 config JSON 与 description
 *    （冻结快照与单一事实源真正对齐，而不是各写各的）；
 * 4. 新迁移 down 必须逐字恢复初始迁移的 config/description（可逆）。
 *
 * 第 3/4 条通过调用迁移的 up/down 并捕获 SQL 实现（比正则解析 17KB SQL 更可靠：
 * glueSource 里有大量单引号/花括号，文本解析极易误判）。
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

const RUNNABLE_MIGRATION_FILE = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "migrations",
  "1790000000060-MakeOfficialTaskTemplatesRunnable.ts",
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

/** 与迁移内 SQL 转义同口径：单引号 → 两个单引号。 */
const esc = (s: string) => s.replace(/'/g, "''");

/** 调 up/down 并收集 SQL（不连真库；data-only 迁移只发 UPDATE）。 */
async function captureSql(): Promise<{ up: string; down: string }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(RUNNABLE_MIGRATION_FILE);
  const Ctor = Object.values(mod).find(
    (v) => typeof v === "function" && /1790000000060$/.test((v as any).name),
  ) as any;
  expect(Ctor).toBeDefined();
  const migration = new Ctor();
  const queries: string[] = [];
  const runner = {
    query: async (sql: string) => {
      queries.push(sql);
    },
  };
  await migration.up(runner);
  await migration.down(runner);
  expect(queries).toHaveLength(2);
  return { up: queries[0], down: queries[1] };
}

describe("CreateTaskTemplates1789800000000 (CORE-03)", () => {
  it("迁移类可解析：name 与类名一致且 up/down 为函数", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(MIGRATION_FILE);

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

  it("seed 恰好预置 5 个官方模板，key 与定位对齐运行时常量", () => {
    const rows = parseSeedRows();
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.key).sort()).toEqual(
      OFFICIAL_TASK_TEMPLATES.map((t) => t.key).sort(),
    );
    for (const t of OFFICIAL_TASK_TEMPLATES) {
      const row = rows.find((r) => r.key === t.key);
      expect(row).toBeDefined();
      expect(row!.name).toBe(t.name);
      expect(row!.category).toBe(t.category);
    }
  });

  it("初始 seed 保持冻结旧形态：带 entrypoint、无 glueSource（未被追改）", () => {
    const rows = parseSeedRows();
    for (const row of rows) {
      expect(typeof row.config.entrypoint).toBe("string");
      expect(row.config).not.toHaveProperty("glueSource");
      expect(row.config).not.toHaveProperty("glueLanguage");
    }
  });

  it("全部 seed 行 isOfficial=true（官方由迁移产生，端点只建自定义）", () => {
    // ROW_RE 强制末段 `, true)`，能解析出 5 行即证明 5 行均 true。
    expect(parseSeedRows()).toHaveLength(5);
  });
});

describe("MakeOfficialTaskTemplatesRunnable1790000000060：覆盖 parity", () => {
  it("up SQL 逐字包含 5 个官方模板的当前 config 与 description", async () => {
    const { up } = await captureSql();
    for (const t of OFFICIAL_TASK_TEMPLATES) {
      // 冻结快照与运行时常量必须逐字一致（含 glueSource 全文与键序）。
      expect(up).toContain(`'${esc(JSON.stringify(t.config))}'::jsonb`);
      expect(up).toContain(`'${esc(t.description)}'`);
    }
    expect(up).toContain('"glueSource"');
    expect(up).not.toContain('"entrypoint"');
  });

  it("down SQL 逐字恢复初始迁移的旧 config / description（可逆）", async () => {
    const { down } = await captureSql();
    for (const row of parseSeedRows()) {
      expect(down).toContain(`'${esc(JSON.stringify(row.config))}'::jsonb`);
      expect(down).toContain(`'${esc(row.description)}'`);
    }
    expect(down).toContain('"entrypoint"');
  });

  it("up/down 的 jsonb 字面量都是合法 JSON（SQL 转义/换行不会写坏脚本）", async () => {
    const { up, down } = await captureSql();
    // 行形如：('key',\n         '{"...":"..."}'::jsonb,\n         'desc')
    // JSON 内的单引号已被替换为 ''，且 String.raw 保证 \n 仍是两字符（不是真换行），
    // 因此非贪婪匹配到 '::jsonb 是安全的。
    const rowRe = /\('([a-z_]+)',\n\s*'([\s\S]*?)'::jsonb,/g;
    for (const sql of [up, down]) {
      const parsed: { key: string; config: Record<string, unknown> }[] = [];
      let m: RegExpExecArray | null;
      while ((m = rowRe.exec(sql)) !== null) {
        const jsonText = m[2].replace(/''/g, "'");
        expect(() => JSON.parse(jsonText)).not.toThrow();
        parsed.push({ key: m[1], config: JSON.parse(jsonText) });
      }
      expect(parsed.map((r) => r.key)).toEqual(
        OFFICIAL_TASK_TEMPLATES.map((t) => t.key),
      );
    }
  });

  it("up/down 都只命中 isOfficial=true 且 key 匹配的行（不误伤自定义模板）", async () => {
    const { up, down } = await captureSql();
    for (const sql of [up, down]) {
      expect(sql).toContain('UPDATE "task_templates"');
      expect(sql).toContain('t."isOfficial" = true');
      expect(sql).toContain('WHERE t."key" = v."key"');
      for (const t of OFFICIAL_TASK_TEMPLATES) {
        expect(sql).toContain(`('${t.key}'`);
      }
    }
  });
});
