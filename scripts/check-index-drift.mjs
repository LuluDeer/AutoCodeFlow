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
// 用法：node scripts/check-index-drift.mjs [--selftest]
//   --selftest：用内置 fixture 验证判据本身（不扫真实代码库）。
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";

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
      /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"\s+ON\s+"([^"]+)"(?:\s+USING\s+\w+)?\s*\(([^)]*)\)/gis;
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

// ── 自检（fixture 驱动，不依赖真实代码库形态）──────────────────────────────
export function selftest() {
  const fixtureEntity = `
    // 死声明示例：@Index("idx_dead_from_comment", ["x"]) —— 剥注释后必须被忽略
    /* @Index("idx_dead_from_block", ["y"]) */
    @Entity("fx_table")
    @Index("idx_fx_plain", ["a", "b"])
    @Index("uq_fx_unique", ["a"], { unique: true })
    @Index()
    @Index({ unique: true })
    @Index(["skipme"]) // 未命名——不比对
    export class Fx {}
    @Entity()
    @Index("idx_fx_unnamed_table", ["c"])
    export class Fx2 {}
  `;
  const fixtureMigration = `
    export class Fx {
      async up(q) {
        await q.query(\`CREATE INDEX IF NOT EXISTS "idx_fx_plain" ON "fx_table" ("a", "b")\`);
        await q.query(\`CREATE UNIQUE INDEX IF NOT EXISTS "uq_fx_unique" ON "fx_table" ("a")\`);
      }
    }
  `;
  const entityFiles = ["fixtures/fx.entity.ts"];
  const scan = scanEntityIndexesFromFiles(entityFiles, "fixtures", () => fixtureEntity);
  if (scan.length !== 3) {
    console.error(`selftest FAIL: expected 3 named @Index (comments stripped), got ${scan.length}`);
    process.exit(1);
  }
  if (countUnnamedIndexesFromFiles(entityFiles, () => fixtureEntity) !== 3) {
    console.error(
      `selftest FAIL: expected 3 unnamed @Index (bare/options/cols form), got ${countUnnamedIndexesFromFiles(entityFiles, () => fixtureEntity)}`,
    );
    process.exit(1);
  }

  // check() 走 FromFiles 组合：DDL 扫描用真实目录形态不依赖——直接以
  // fixture 内容喂 read，"目录"传一个不存在路径并注入 ddl 参数不可行，
  // 故这里用 scan* + 手工比对复刻 check 的断言面。
  const ddl = scanMigrationIndexesFromFiles(["migrations/fx.ts"], () => fixtureMigration);
  if (ddl.size !== 2) {
    console.error(`selftest FAIL: expected 2 DDL indexes, got ${ddl.size}`);
    process.exit(1);
  }
  const assertSubset = (declFiles, ddlMap, expectErrs) => {
    const decls = scanEntityIndexesFromFiles(declFiles, "fixtures", () => fixtureEntity);
    const errors = [];
    let checked = 0;
    for (const decl of decls) {
      if (!decl.table) continue;
      checked += 1;
      const found = ddlMap.get(decl.indexName);
      if (!found) {
        errors.push(`missing: ${decl.indexName}`);
        continue;
      }
      if (found.table !== decl.table || found.columns.join(",") !== decl.columns.join(",") || found.unique !== decl.unique) {
        errors.push(`mismatch: ${decl.indexName}`);
      }
    }
    if (errors.length !== expectErrs) {
      console.error(`selftest FAIL: expected ${expectErrs} errors, got ${JSON.stringify(errors)}`);
      process.exit(1);
    }
    return checked;
  };

  const checked = assertSubset(entityFiles, ddl, 0);
  if (checked !== 2) {
    console.error(`selftest FAIL: expected 2 checked (explicit-table entities), got ${checked}`);
    process.exit(1);
  }

  // 漂移分支：改名 / 改列序 / 改唯一性 各必须红
  const ddlRenamed = scanMigrationIndexesFromFiles(["migrations/fx.ts"], () => fixtureMigration.replace(/idx_fx_plain/g, "idx_fx_renamed"));
  assertSubset(entityFiles, ddlRenamed, 1);
  const ddlOrder = scanMigrationIndexesFromFiles(["migrations/fx.ts"], () => fixtureMigration.replace('("a", "b")', '("b", "a")'));
  assertSubset(entityFiles, ddlOrder, 1);
  const ddlUnique = scanMigrationIndexesFromFiles(["migrations/fx.ts"], () => fixtureMigration.replace("CREATE UNIQUE INDEX", "CREATE INDEX"));
  assertSubset(entityFiles, ddlUnique, 1);

  // 约束形态：CREATE TABLE 内 CONSTRAINT UNIQUE 也算 DDL 落地
  const constraintMigration = `
    export class Fx {
      async up(q) {
        await q.query(\`CREATE INDEX IF NOT EXISTS "idx_fx_plain" ON "fx_table" ("a", "b")\`);
        await q.query(\`CREATE TABLE "fx_table" ("a" uuid, CONSTRAINT "uq_fx_unique" UNIQUE ("a"))\`);
      }
    }
  `;
  const ddlConstraint = scanMigrationIndexesFromFiles(["migrations/fx.ts"], () => constraintMigration);
  if (ddlConstraint.size !== 2) {
    console.error(`selftest FAIL: expected 2 DDL entries (index + constraint), got ${ddlConstraint.size}`);
    process.exit(1);
  }
  assertSubset(entityFiles, ddlConstraint, 0);

  console.log("selftest OK: index drift detector works (comments stripped, missing/order/unique drift flagged, constraint-backed UNIQUE honoured)");
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    const { errors, checked, unnamed } = check();
    console.log(`check-index-drift: ${checked} 个命名 @Index 声明已比对迁移 DDL；${unnamed} 个未命名声明不比对（新代码应显式命名）`);
    if (errors.length > 0) {
      console.error(`实体 @Index 声明与迁移 DDL 漂移（${errors.length} 项）：`);
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    console.log("✔ 无漂移");
  }
}
