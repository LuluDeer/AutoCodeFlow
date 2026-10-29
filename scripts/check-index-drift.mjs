#!/usr/bin/env node
// NETOPT-3⑥：实体命名 @Index ⊆ 迁移 DDL 静态守卫
//
// 背景（NETOPT-3① 的结构性复演防再犯）：生产 synchronize=false（data-source.ts），
// 迁移是 schema 唯一来源。实体 @Index 声明若在迁移 DDL 里没有对应物，就是
// 纯"死声明"——task_executions 的 ["status"] / ["taskId","status"] 声明了
// 数十个迁移周期从未落库，PENDING 兜底清扫被迫 O(全表) 游走。本守卫把
// 「声明 ↔ DDL」钉死：
//
//   扫描 apps/admin-api/src/**/*.entity.ts 中所有【显式命名】的
//   @Index("name", ["col", ...]) 声明，要求迁移 DDL 里存在同名的
//   CREATE [UNIQUE] INDEX ... ON "table" ("col", ...) 或
//   CREATE TABLE 内的 CONSTRAINT "name" UNIQUE ("col", ...)，
//   且表名、列序、唯一性完全一致。
//
// 已知边界（刻意不比，防脆）：
// - 未命名的 @Index(...)（TypeORM 生成哈希名）无法与 DDL 对应——跳过并
//   在汇总里报数（NETOPT-3① 的教训是"未命名声明永不落库"，新代码应一律
//   显式命名；存量未命名声明的收敛不在本守卫强推范围内）；
// - 部分索引的 WHERE 谓词、USING 方法（gin 等）、表达式索引不参与比对，
//   只比对 名称/表/列序/唯一性；
// - 属性名 = 数据库列名（本仓库全库 camelCase 直落 PG，无 @Column rename
//   先例，已核实）；若未来引入 rename，同步扩展本脚本。
//
// 退出码：0 = 无漂移；1 = 命名声明在迁移 DDL 中缺失/不匹配（漂移）。
//
// 用法：node scripts/check-index-drift.mjs [--selftest] [--root <dir>]
//   --selftest：T4 重写——在临时 fixture 树里**跑真脚本的子进程**，逐条断言退出码与
//               关键报错文本（旧版用一份手抄的 assertSubset 当"判据"，与被测代码各自
//               演化：CLI 的 process.exit(1) 删掉它照样全绿）。
//   --root    ：只给 selftest 用：把 fixture 树当仓库根（默认 process.cwd()）。
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

const SRC_DIR = "apps/admin-api/src";
const MIGRATIONS_DIR = "apps/admin-api/src/migrations";

const utf8 = (f) => readFileSync(f, "utf8");

// ── 实体扫描：收集显式命名的 @Index 声明 ────────────────────────────────────
// 返回 [{ indexName, table, columns, unique, file }]
export function scanEntityIndexes(srcDir, read = utf8) {
  return scanEntityIndexesFromFiles(listEntityFiles(srcDir), srcDir, read);
}

export function scanEntityIndexesFromFiles(files, srcDir, read = utf8) {
  const out = [];
  for (const file of files) {
    let text;
    try {
      text = read(file);
    } catch {
      continue;
    }
    // 必须剥注释：实体头注里会引用旧写法/死声明作缺陷说明（R-19 的
    // idx_audit_log_detail_gin 死声明注释即先例），不剥会把"解释缺陷的
    // 注释"当成声明本身，红得毫无线索。
    const src = stripComments(text);
    const entityRe = /@Entity\(\s*(?:'([^']+)'|"([^"]+)")?\s*\)/g;
    const entities = [];
    let em;
    while ((em = entityRe.exec(src)) !== null) {
      entities.push({
        table: em[1] ?? em[2] ?? null,
        at: em.index,
      });
    }
    const indexRe = /@Index\(\s*(?:'([^']+)'|"([^"]+)")\s*,\s*\[([^\]]*)\]/g;
    let im;
    while ((im = indexRe.exec(src)) !== null) {
      const name = im[1] ?? im[2];
      const cols = [...im[3].matchAll(/'([^']+)'|"([^"]+)"/g)].map(
        (m) => m[1] ?? m[2],
      );
      // 同一 options 对象（同一语句内）是否声明 unique: true
      const stmtTail = src.slice(im.index, im.index + 300);
      const unique = /unique\s*:\s*true/.test(
        stmtTail.slice(0, stmtTail.indexOf(")") + 1 || undefined),
      );
      // 归属：此前最近的 @Entity（无显式表名的 @Entity() 用 null 占位，
      // 该实体无法比对，跳过）
      const owner = [...entities].reverse().find((e) => e.at < im.index);
      out.push({
        indexName: name,
        table: owner ? owner.table : null,
        columns: cols,
        unique,
        file: relative(srcDir, file).replace(/\\/g, "/"),
      });
    }
  }
  return out;
}

/** 未命名 @Index 声明计数（不判漂移，只给可见性） */
export function countUnnamedIndexes(srcDir, read = utf8) {
  return countUnnamedIndexesFromFiles(listEntityFiles(srcDir), read);
}

export function countUnnamedIndexesFromFiles(files, read = utf8) {
  let count = 0;
  for (const file of files) {
    const src = stripComments(read(file));
    // 未命名形态：@Index() / @Index({ ... }) / @Index(["col", ...])——
    // 开头不是名字符串（名字符串开头的是命名声明，由命名扫描负责）
    const re = /@Index\(\s*(?!\s*['"`])(?:\{[^)]*\}|\[[^\]]*\])?\s*\)/g;
    count += [...src.matchAll(re)].length;
  }
  return count;
}

// ── 迁移扫描：收集 DDL 索引（含 CREATE TABLE 内 UNIQUE 约束）────────────────
// 返回 Map<indexName, { table, columns, unique }>
export function scanMigrationIndexes(migrationsDir, read = utf8) {
  const ddl = new Map();
  if (!existsSync(migrationsDir)) return ddl;
  const files = readdirSync(migrationsDir)
    .filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".spec.ts") && !f.endsWith(".d.ts"),
    )
    .map((f) => join(migrationsDir, f));
  return scanMigrationIndexesFromFiles(files, read);
}

export function scanMigrationIndexesFromFiles(files, read = utf8) {
  const ddl = new Map();
  for (const file of files) {
    const src = stripComments(read(file));

    // CREATE [UNIQUE] INDEX [IF NOT EXISTS] "name" ON "table" [USING x] ("col", ...)
    const createRe =
      /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"\s+ON\s+"([^"]+)"(?:\s+USING\s+\w+)?\s*\(([^)]*)\)/gis;
    let m;
    while ((m = createRe.exec(src)) !== null) {
      const columns = [...m[4].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
      ddl.set(m[2], {
        table: m[3],
        columns,
        unique: Boolean(m[1]),
      });
    }

    // CREATE TABLE "table" ( ... CONSTRAINT "name" UNIQUE ("col", ...) ... )
    // 按 CREATE TABLE 切片，约束解析限定在各自表体内（避免跨表误配）。
    const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi;
    const tables = [];
    let tm;
    while ((tm = tableRe.exec(src)) !== null) {
      tables.push({ table: tm[1], at: tm.index });
    }
    for (let i = 0; i < tables.length; i++) {
      const start = tables[i].at;
      const end = i + 1 < tables.length ? tables[i + 1].at : src.length;
      const body = src.slice(start, end);
      const constraintRe = /CONSTRAINT\s+"([^"]+)"\s+UNIQUE\s*\(([^)]*)\)/gis;
      let cm;
      while ((cm = constraintRe.exec(body)) !== null) {
        const columns = [...cm[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
        ddl.set(cm[1], {
          table: tables[i].table,
          columns,
          unique: true,
        });
      }
    }
  }
  return ddl;
}

/** 断言每个命名实体 @Index ⊆ 迁移 DDL（名称精确匹配 + 表 + 列序 + 唯一性） */
export function check({ srcDir = SRC_DIR, migrationsDir = MIGRATIONS_DIR, read = utf8 } = {}) {
  const errors = [];
  const ddl = scanMigrationIndexes(migrationsDir, read);
  if (ddl.size === 0) {
    errors.push(`迁移目录未解析到任何索引 DDL：${migrationsDir} — guard is blind`);
  }
  const declared = scanEntityIndexes(srcDir, read);
  let checked = 0;
  for (const decl of declared) {
    if (!decl.table) continue; // @Entity() 无显式表名——无法比对，跳过
    checked += 1;
    const found = ddl.get(decl.indexName);
    if (!found) {
      errors.push(
        `${decl.file}: @Index("${decl.indexName}") [${decl.columns.join(", ")}] 在迁移 DDL 中不存在（synchronize=false 下这是死声明）——补迁移或删声明`,
      );
      continue;
    }
    if (found.table !== decl.table) {
      errors.push(
        `${decl.file}: @Index("${decl.indexName}") 表不匹配——实体在 "${decl.table}"，DDL 在 "${found.table}"`,
      );
      continue;
    }
    const sameCols =
      found.columns.length === decl.columns.length &&
      found.columns.every((c, i) => c === decl.columns[i]);
    if (!sameCols) {
      errors.push(
        `${decl.file}: @Index("${decl.indexName}") 列序不匹配——实体 [${decl.columns.join(", ")}] vs DDL [${found.columns.join(", ")}]`,
      );
      continue;
    }
    if (found.unique !== decl.unique) {
      errors.push(
        `${decl.file}: @Index("${decl.indexName}") 唯一性不匹配——实体 ${decl.unique ? "UNIQUE" : "非 UNIQUE"} vs DDL ${found.unique ? "UNIQUE" : "非 UNIQUE"}`,
      );
    }
  }
  const unnamed = countUnnamedIndexes(srcDir, read);
  return { errors, checked, unnamed, declared: declared.length };
}

// ── 工具 ───────────────────────────────────────────────────────────────────
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function listEntityFiles(srcDir) {
  const out = [];
  if (!existsSync(srcDir)) return out;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".entity.ts")) out.push(p);
    }
  };
  walk(srcDir);
  return out;
}

// ── 自检（T4：驱动真扫描器 + 真子进程，禁止手抄判据）────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

const ENTITY_REL = "apps/admin-api/src/modules/fx/fx.entity.ts";
const MIGRATION_REL = "apps/admin-api/src/migrations/1790000000000-fx.ts";

const entitySource = (extra = "") =>
  `import { Entity, Index } from "typeorm";\n\n@Entity("fx_table")\n` +
  `@Index("idx_fx_plain", ["a", "b"])\n` +
  `@Index("uq_fx_unique", ["a"], { unique: true })\n` +
  (extra ? extra + "\n" : "") +
  `export class Fx {}\n`;

const migrationSource = (statements) =>
  `export class Fx {\n  async up(q) {\n` +
  statements.map((sql) => `    await q.query(\`${sql}\`);`).join("\n") +
  `\n  }\n}\n`;

const BASE_DDL = [
  'CREATE INDEX IF NOT EXISTS "idx_fx_plain" ON "fx_table" ("a", "b")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "uq_fx_unique" ON "fx_table" ("a")',
];

/** 造 fixture 树；只传需要变的部分。 */
const driftTree = ({ entity = entitySource(), migration = migrationSource(BASE_DDL) } = {}) => ({
  [ENTITY_REL]: entity,
  [MIGRATION_REL]: migration,
});

/**
 * 自检：8 条用例，全部跑真脚本（`--root` 指向 fixture 树）。
 *
 * 旧版的三处问题（审计 3 分的来源）：
 *   ① 用 `assertSubset`——一份**手抄**的判据副本——当 oracle，真 `check()` 只被
 *      间接摸到；副本与被测代码可以各自演化（先例：列序比对在副本里用
 *      `join(",")` 比较、真码逐列比对，两者对空列/含逗号列名的行为不同）。
 *   ② 断言写死 `process.exit(1)`，第一条不符即中止，后面的用例根本不跑。
 *   ③ 完全不碰 CLI：把 `process.exit(1)` 从 CLI 删掉，selftest 依旧全绿。
 * 现在三条都不成立：判据只有一份（子进程里的真脚本），退出码与报错文本逐条断言。
 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "index-drift-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), { ...expect, withinMs: 1000, label: name });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  // ① 命名一致 → 绿
  subprocess("① 实体命名 @Index 与迁移 DDL 逐项一致 → 绿", driftTree(), {
    code: 0,
    contains: ["2 个命名 @Index 声明已比对迁移 DDL", "0 个未命名声明不比对", "✔ 无漂移"],
    absent: ["漂移（", "guard is blind"],
  });

  // ② 实体声明了、DDL 里没有（死声明）→ 红
  subprocess(
    "② 多一个 DDL 里不存在的命名索引 → 红（死声明）",
    driftTree({ entity: entitySource(`@Index("idx_fx_missing", ["c"])`) }),
    {
      code: 1,
      contains: ["idx_fx_missing", "在迁移 DDL 中不存在", "synchronize=false 下这是死声明"],
      absent: ["✔ 无漂移"],
    },
  );

  // ③ 列序不匹配 → 红
  subprocess(
    "③ 列序不匹配（实体 [a,b] vs DDL [b,a]）→ 红",
    driftTree({
      migration: migrationSource([
        'CREATE INDEX IF NOT EXISTS "idx_fx_plain" ON "fx_table" ("b", "a")',
        BASE_DDL[1],
      ]),
    }),
    { code: 1, contains: ["idx_fx_plain", "列序不匹配", "DDL [b, a]"], absent: ["✔ 无漂移"] },
  );

  // ④ 唯一性不匹配 → 红
  subprocess(
    "④ 唯一性不匹配（实体 UNIQUE vs DDL 非 UNIQUE）→ 红",
    driftTree({
      migration: migrationSource([
        BASE_DDL[0],
        'CREATE INDEX IF NOT EXISTS "uq_fx_unique" ON "fx_table" ("a")',
      ]),
    }),
    { code: 1, contains: ["uq_fx_unique", "唯一性不匹配"], absent: ["✔ 无漂移"] },
  );

  // ⑤ 未命名 @Index：只计数、不判漂移（既有边界，T4 不改判据，只钉住它别悄悄变了）
  subprocess(
    "⑤ 未命名 @Index 只计数不比对（已知边界）→ 绿且报数",
    driftTree({ entity: entitySource(`@Index(["unnamed_col"])\n@Index({ unique: true })`) }),
    {
      code: 0,
      contains: ["2 个命名 @Index", "2 个未命名声明不比对", "✔ 无漂移"],
      absent: ["漂移（"],
    },
  );

  // ⑥ 注释里的 @Index 不算声明（剥注释）；这是旧 selftest 里唯一值得保留的断言，
  //    现在通过真扫描器验证：注释里那两条不许被算进 "2 个命名"。
  subprocess(
    "⑥ 注释里的 @Index 不算声明（行注释 + 块注释）→ 绿且仍只算 2 条",
    driftTree({
      entity: entitySource(
        `// @Index("idx_dead_line_comment", ["x"])\n/* @Index("idx_dead_block_comment", ["y"]) */`,
      ),
    }),
    { code: 0, contains: ["2 个命名 @Index"], absent: ["idx_dead_line_comment", "idx_dead_block_comment"] },
  );

  // ⑦ partial WHERE 差异 —— **已知盲区**：本守卫只比 名称/表/列序/唯一性，不比 WHERE
  //    谓词。这条用例断言的是「当前不报」，用来把盲区钉成显式契约：哪天有人补上
  //    WHERE 比对，这条用例会转红，届时把它改成「必须报」并把盲区从报告里划掉。
  subprocess(
    "⑦ 【已知盲区】partial WHERE 差异当前不报（守卫不比谓词）",
    driftTree({
      entity: entitySource(
        `@Index("idx_fx_partial", ["deleted_at"], { where: "deleted_at IS NULL" })`,
      ),
      migration: migrationSource([
        ...BASE_DDL,
        // 少了 WHERE 子句：语义上是「全量索引 vs 部分索引」，当前判据看不见
        'CREATE INDEX IF NOT EXISTS "idx_fx_partial" ON "fx_table" ("deleted_at")',
      ]),
    }),
    { code: 0, contains: ["3 个命名 @Index", "✔ 无漂移"], absent: ["漂移（", "列序不匹配"] },
  );

  // ⑧ 扫描面失效：迁移里一条 DDL 都解析不到 → 结构性红（否则「0 条 = 无漂移」永真）
  subprocess(
    "⑧ 迁移 DDL 一条都解析不到 → 结构性红（guard is blind）",
    driftTree({ migration: "export class Fx { async up() {} }\n" }),
    { code: 1, contains: ["未解析到任何索引 DDL", "guard is blind"], absent: ["✔ 无漂移"] },
  );

  const failed = reportCases(cases, { title: "check-index-drift selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    const root = resolve(argValue(process.argv, "--root") ?? process.cwd());
    const { errors, checked, unnamed } = check({
      srcDir: join(root, SRC_DIR),
      migrationsDir: join(root, MIGRATIONS_DIR),
    });
    console.log(`check-index-drift: ${checked} 个命名 @Index 声明已比对迁移 DDL；${unnamed} 个未命名声明不比对（新代码应显式命名）`);
    if (errors.length > 0) {
      console.error(`实体 @Index 声明与迁移 DDL 漂移（${errors.length} 项）：`);
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    console.log("✔ 无漂移");
  }
}
