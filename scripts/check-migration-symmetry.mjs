#!/usr/bin/env node
/**
 * 迁移 `up()` / `down()` 对称性棘轮（第 4 轮测试质量审计 T3）。
 *
 * ## 由来
 * 审计实测：122 个迁移里 68 个**没有任何 spec**；有 spec 的 54 个里，**51 个的 `down()`
 * 只做文本断言**（`expect(typeof down).toBe("function")` 之类），**仅 3 个真正执行 down**。
 * 也就是说「迁移写了 down 但根本跑不通」这件事，测试面基本看不见。审计用「down 必须与 up
 * 的 DDL 对象对称」口径扫过全部 122 个，**违规 0**——因此这里可以直接上棘轮：先锁住现状，
 * 只允许变好。
 *
 * 守卫解决的是**静态**那一半：up 造出来的对象，down 有没有对应的拆除语句。它**不**证明
 * down 真的能跑（那需要 DB + 真正执行 down，见文末「未覆盖形态」）。
 *
 * ## 判据（对每个 `apps/admin-api/src/migrations/*.ts`，排除 `*.spec.ts` / `*.d.ts`）
 *
 * up() 里的**可逆对象**（6 类；前 4 类是审计口径，后 2 类是本守卫补的：
 * 「建了函数/触发器不拆」同样是泄漏，且 1790000000006/1790000000057 两条防线迁移
 * 全靠它们）：
 *   · `CREATE TABLE [IF NOT EXISTS] "x"`                     → 对象 `table:x`
 *   · `CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] "x"` → 对象 `index:x`
 *   · `ALTER TABLE "t" ADD [COLUMN] [IF NOT EXISTS] "c"`     → 对象 `column:t.c`
 *   · `CREATE TYPE "x"`                                     → 对象 `type:x`
 *   · `CREATE [OR REPLACE] FUNCTION "x"`                    → 对象 `function:x`
 *   · `CREATE [OR REPLACE] TRIGGER "x"`                     → 对象 `trigger:x`
 *
 * 对应的拆除语句（在 down() 里）：
 *   · `DROP TABLE [IF EXISTS] "x"`
 *   · `DROP INDEX [CONCURRENTLY] [IF EXISTS] "x"`
 *   · `ALTER TABLE "t" DROP [COLUMN] [IF EXISTS] "c"`
 *   · `DROP TYPE [IF EXISTS] "x"`
 *   · `DROP FUNCTION [IF EXISTS] "x"`
 *   · `DROP TRIGGER [IF EXISTS] "x"`
 *
 * 判定：
 *   ① **up 有、down 无** → 违规（`IF NOT EXISTS` 与 `IF EXISTS` 视为同一对象：两边的
 *      `IF` 子句只是幂等修饰，不改变对象身份）。
 *   ② **CONCURRENTLY 必须两边一致**：up 用 `CREATE INDEX CONCURRENTLY`、down 用普通
 *      `DROP INDEX` → 违规，理由「回滚会锁表」。CONCURRENTLY 的意义就是不在表上持
 *      SHARE/ACCESS EXCLUSIVE 锁；down 退回普通 DROP，回滚时会把整表写流量挡住——
 *      大表上这是**升级事故的反向重演**（1790000000053/0055/0056/0061/0075/0076/0077
 *      已经按同口径写；实测存量里还有 5 条不符，见基线）。
 *   ③ **索引随表/列消失也算对称**：若 down `DROP TABLE` 了索引所在表，或 `DROP COLUMN`
 *      掉索引定义里的任一列，该索引视为已拆除（PG 语义：删表/删列会级联删除依赖它的
 *      索引）。不做这条会产出大量假红（例：1717473142680 建表 + 2 索引，down 只
 *      DROP TABLE；1717473142684 的 `idx_tasks_applicationId` 随列被删而消失）。
 *
 * 明确允许的例外（每一类都在下面代码里就地注释）：
 *   · **分区表**：`CREATE TABLE ... PARTITION OF ...` 是分区子表，不属于独立对象——
 *     回滚由父表的 `DROP TABLE` 带走整棵分区树。计入 `partition` 豁免，不要求 down 逐个子表
 *     DROP（子表名还常是运行期循环拼出来的动态名，见 1789900000002）。
 *   · **纯数据迁移**：up 里没有任何 DDL、只有 `INSERT/UPDATE/DELETE`（如数据回填、
 *     去重）——没有对象可拆，down 天然只需数据语义。计入 `data-only` 豁免。
 *     判定要求「无对象 **且** 无 CREATE/ALTER/DROP **且** 有 DML」三件事同时成立，
 *     否则 `ALTER TYPE ... ADD VALUE` 这类会被误吞成纯数据。
 *   · **不可逆迁移**：允许 down() 显式抛「不可逆」，但**必须**在 down 方法体里有 `throw`
 *     且带理由字符串（≥ 8 字符）；计入 `irreversible` 清单并在 `--report` 里逐条打印，
 *     让人知道有多少不可逆。写了 `throw` 却没理由 → 违规。
 *
 * ## 基线棘轮（`scripts/migration-symmetry-baseline.json`）
 * 记录当前违规（审计口径「对象对称」实测 0；本守卫额外判 CONCURRENTLY 一致性，
 * 实测存量 **5 条**不符，如实记入基线，**绝不改迁移去凑 0**）。规则是**集合精确相等**：
 *   · 出现基线里没有的违规 → 红（新增）；
 *   · 基线里有、但当前已不存在的违规 → 红（「基线陈旧」：改好了就要把条目删掉，
 *     否则基线会慢慢变成一张没人看的豁免单，棘轮失效）。
 * 不可逆清单同样登记在基线里（新增/删除都要显式改基线），这样「又有一个迁移放弃回滚」
 * 会出现在 diff 里，而不是静默消失在 --report 的滚动日志里。
 *
 * ## 扫描实现
 * 1. 按方法名取 `up`/`down` 方法体（括号配平，跳过字符串/注释里的括号），并把方法体里
 *    `this.foo(...)` 调用到的**本类私有方法**体并入（`1790000000054` 的 DROP 写在
 *    `dropAddressUniqueIndex` helper 里，不展开就是假红）。
 * 2. 抹掉注释与单引号字符串内容、把 `"identifier"` 的引号换成空格（等长替换，行号不漂），
 *    再做正则提取——这样注释里提到的 `CREATE TABLE "x"`（本仓很多）不会被当成 DDL。
 *    状态用栈而非单一变量（`模板 → 双引号标识符 → 回到模板` 必须还原）。
 * 3. 动态名（`"${name}"` 这类模板插值）不参与判据，计入 `dynamic` 计数。
 * 4. TypeORM builder 形态按字面名建模：`createTable(new Table({name:"x"}))` /
 *    `createIndex(...)` / `addColumn(...)` 与 `dropTable` / `dropColumn` / `dropIndex`。
 * 5. up 里有 CREATE/ALTER/DROP 但落在建模范围外（列类型变更、`ALTER TYPE ... ADD VALUE`、
 *    仅 DROP 既有对象）时，计入 `unmodeledDdl` 并在 `--report` 里列出——**不判红**
 *    （判据只覆盖可拆对象），但也绝不静默当成「零对象全绿」。
 *
 * ## 未覆盖形态（**必须知道**，否则会误以为「守卫绿 = down 一定能回滚」）
 *   · **只比名字，不比语义**：up 建 partial unique index、down 重建 global unique index
 *     （`1790000000054`）在名字层面通过，但两者语义不同。
 *   · **baseline 里的 5 条是真实存量**：3 个迁移的 `CREATE INDEX CONCURRENTLY` 配了
 *     普通 `DROP INDEX`——本守卫发现、由 owner 决定怎么修，守卫只负责不让它变多。
 *   · **`createTable` 隐式建的 enum 类型**不计数（`1717473142694` 的 down 注释即
 *     「enum 类型由 createTable 创建，此处不回删」）——这条路径上的类型泄漏不可见。
 *   · **rename 不算创建/删除**：`ALTER TABLE a RENAME TO b` 两侧都不建模。
 *   · **`ALTER TYPE ... ADD VALUE` 不可逆**（PG 无法删枚举值）：只计入 `unmodeledDdl`，
 *     不要求 down 抛不可逆（仓内 1790000000020 的 down 是 no-op + 注释说明）。
 *   · **down 是否能真的跑通**：本守卫不连库、不执行 down；语句顺序错、依赖外部对象、
 *     锁/超时、数据非空导致失败都看不见（审计里「51/54 只做文本断言」正是这个盲区）。
 *   · **up 之外的 DDL**（构造函数、装饰器、data-source 选项）不扫。
 *
 * 用法：
 *   node scripts/check-migration-symmetry.mjs              # 守卫（CI）
 *   node scripts/check-migration-symmetry.mjs --report     # 不可逆清单 + 每迁移对称对象数
 *   node scripts/check-migration-symmetry.mjs --selftest   # 验证判据本身有牙
 *   node scripts/check-migration-symmetry.mjs --root <dir> # 换根（自检/反证用临时树）
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

const MIGRATIONS_REL = join("apps", "admin-api", "src", "migrations");
const BASELINE_REL = join("scripts", "migration-symmetry-baseline.json");

/** 真实仓库规模下界：扫描面收窄（目录改名/正则失效）时不能静默「零个迁移全绿」。 */
const DEFAULT_ROOT_MIN_MIGRATIONS = 100;

/**
 * selftest 单条用例的耗时上限（喂给 `expectExit({ withinMs })`）。
 * 一个迁移文件的子进程实测 ~50ms，留 20 倍余量：它拦的是「扫描面/正则退化成
 * 指数回溯」这类**耗时形态**（一个迁移文件就超 1s 说明解析器坏了），不是抖动。
 */
const SELFTEST_CASE_BUDGET_MS = 1000;

/**
 * 不是对象名的关键字。正则的可选组（`IF NOT EXISTS` / `CONCURRENTLY`）在遇到
 * **动态名**（`"${name}"`）时会回溯，把 `IF` 捕成「表名」（实测过）——
 * 这些词一律丢弃。
 */
const NON_OBJECT_KEYWORDS = new Set([
  "IF",
  "NOT",
  "EXISTS",
  "TABLE",
  "INDEX",
  "UNIQUE",
  "CONCURRENTLY",
  "TYPE",
  "COLUMN",
]);

/**
 * 拆列/加列语句里，紧跟 `ADD` / `DROP` 之后但不是列名的关键字。
 * `ALTER TABLE "x" ADD CONSTRAINT ...` 若不过滤，会把 `CONSTRAINT` 当成列名。
 */
const NON_COLUMN_KEYWORDS = new Set([
  "CONSTRAINT",
  "PRIMARY",
  "UNIQUE",
  "FOREIGN",
  "CHECK",
  "EXCLUDE",
  "COLUMN",
]);

/** 索引定义里 `( ... )` 中不是列名的词（排序/操作符类修饰）。 */
const NON_COLUMN_WORDS = new Set([
  "ASC",
  "DESC",
  "NULLS",
  "FIRST",
  "LAST",
  "USING",
  "WHERE",
  "WITH",
  "COLLATE",
  "TEXT_PATTERN_OPS",
]);

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_$]*/g;

/* ─────────────────────────── 源码处理 ─────────────────────────── */

/**
 * 等长「清洗」：注释 → 空格（换行保留）、单引号字符串内容 → 空格、
 * `"标识符"` 的引号 → 空格（内容保留，供正则当裸标识符读）。
 *
 * 为什么等长替换：报错要给行号，长度一变行号就漂。为什么必须洗注释：本仓大量
 * 迁移头注里写着 `CREATE TABLE "app_deployments"` / `DROP uq_executors_address`
 * 这类**散文**，不洗会伪造出根本不存在的 DDL。
 *
 * 反引号（TS 模板 = SQL 载体）里的内容按代码继续扫描，但**不**把 `//` 当注释
 * （SQL 不用 `//`；模板里可能内联 JS 脚本，`1790000000060` 就是），避免把
 * `https://` 之后整行抹掉。
 */
function sanitize(src, { keepStrings = false } = {}) {
  const out = new Array(src.length);
  let i = 0;
  const n = src.length;
  // 状态栈：`"标识符"` / `'字符串'` 结束时要回到**进入前的状态**（可能仍在模板里），
  // 单层 prev 变量在 `tpl → dq → tpl` 这种最常见的形态上就会失配（实测把整个 down
  // 方法体后半段当成注释/字符串洗掉，helper 里的 DROP INDEX 因此「消失」）。
  let state = "code"; // code | tpl | sq | dq
  const stack = [];
  const enter = (next) => {
    stack.push(state);
    state = next;
  };
  const exit = () => {
    state = stack.pop() ?? "code";
  };

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (state === "sq") {
      if (c === "'" && c2 === "'") {
        out[i] = keepStrings ? "'" : " ";
        out[i + 1] = keepStrings ? "'" : " ";
        i += 2;
        continue;
      }
      if (c === "'") {
        out[i] = keepStrings ? "'" : " ";
        exit();
        i += 1;
        continue;
      }
      out[i] = keepStrings ? c : c === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (state === "dq") {
      if (c === "\\") {
        out[i] = " ";
        out[i + 1] = src[i + 1] === "\n" ? "\n" : " ";
        i += 2;
        continue;
      }
      if (c === '"') {
        out[i] = keepStrings ? '"' : " ";
        exit();
        i += 1;
        continue;
      }
      out[i] = c;
      i += 1;
      continue;
    }

    // code / tpl
    if (c === "/" && c2 === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out[i] = src[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < n) {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    if (c === "-" && c2 === "-") {
      // SQL 行注释（TS 里的 `--` 只可能出现在已洗掉的字符串/注释里）
      while (i < n && src[i] !== "\n") {
        out[i] = " ";
        i += 1;
      }
      continue;
    }
    if (state === "code" && c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") {
        out[i] = " ";
        i += 1;
      }
      continue;
    }
    if (c === "'") {
      out[i] = keepStrings ? "'" : " ";
      enter("sq");
      i += 1;
      continue;
    }
    if (c === '"') {
      out[i] = keepStrings ? '"' : " ";
      enter("dq");
      i += 1;
      continue;
    }
    if (c === "`") {
      if (state === "code") {
        out[i] = " ";
        enter("tpl");
        i += 1;
        continue;
      }
      out[i] = " ";
      exit();
      i += 1;
      continue;
    }
    out[i] = c;
    i += 1;
  }
  return out.join("");
}

/** 从 `{` 起做字符串/注释感知的括号配平，返回 [bodyStart, bodyEnd)。 */
function matchBrace(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const closer = c;
      i += 1;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === closer) {
          // SQL/JS 的 '' 双写转义
          if (closer === "'" && src[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return [openIdx + 1, i];
    }
    i += 1;
  }
  return [openIdx + 1, n];
}

/** 取 `methodName(...) { ... }` 的方法体区间；找不到返回 null。 */
function findMethodRange(src, methodName) {
  // 必须带可见性/async 修饰：迁移里 `-- 同 up()：...` 这类 SQL 注释中的散文
  // `up()` 不能被当成方法定义（否则会从注释位置开始括号配平，抓到完全无关的体）。
  const re = new RegExp(
    String.raw`(?:^|[\s;}])(?:(?:public|private|protected)\s+(?:async\s+)?|async\s+)` +
      methodName +
      String.raw`\s*\(`,
    "g",
  );
  let m;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length; // 指向 '(' 之后
    let depth = 1;
    // 参数列表：保守逐字符，跳过字符串
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "'" || c === '"' || c === "`") {
        const closer = c;
        i += 1;
        while (i < src.length && src[i] !== closer) {
          if (src[i] === "\\") i += 1;
          i += 1;
        }
      } else if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      i += 1;
    }
    const open = src.indexOf("{", i);
    if (open === -1) continue;
    // 返回类型注解里可能含 `{}`（对象类型），这里只接受 `: Promise<void>` / 空
    const between = src.slice(i, open);
    if (between.includes(";") || between.includes("=")) continue;
    const [bodyStart, bodyEnd] = matchBrace(src, open);
    return { bodyStart, bodyEnd };
  }
  return null;
}

/**
 * 方法体 + 它 `this.foo(...)` 调用的本类方法体（深度受 seen 限制）。
 * reasons: helper 里的 DROP 也算 down 的拆除动作（真实用例 1790000000054）。
 */
function collectMethodText(src, methodName, seen = new Set()) {
  if (seen.has(methodName)) return null;
  seen.add(methodName);
  const range = findMethodRange(src, methodName);
  if (!range) return null;
  const body = src.slice(range.bodyStart, range.bodyEnd);
  let text = body;
  const calls = new Set();
  const callRe = /this\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  let cm;
  while ((cm = callRe.exec(body)) !== null) calls.add(cm[1]);
  for (const called of calls) {
    const sub = collectMethodText(src, called, seen);
    if (sub) text += "\n" + sub;
  }
  return text;
}

/** 行号（1 基）。 */
function lineAt(src, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === "\n") line += 1;
  return line;
}

/* ─────────────────────────── DDL 提取 ─────────────────────────── */

/**
 * 对象名：SQL 标识符，或模板插值形态 `${name}`（动态名）。
 * 动态名把 `IF NOT EXISTS` 的可选组往回顶，若不显式支持会捕到 `IF` 当表名
 * （实测过）；这里显式匹配，随后跳过并计入 dynamic。
 */
const NAME = String.raw`(?:\$\{[^}]*\}|[A-Za-z_][A-Za-z0-9_$]*)`;

const RE_CREATE_TABLE = new RegExp(
  String.raw`\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${NAME})`,
  "gi",
);
const RE_CREATE_INDEX = new RegExp(
  String.raw`\bCREATE\s+(UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${NAME})`,
  "gi",
);
const RE_CREATE_TYPE = new RegExp(String.raw`\bCREATE\s+TYPE\s+(${NAME})`, "gi");
// 函数/触发器：审计的 4 类里没有，但它们是**可逆对象**——建了不拆同样是泄漏，
// 且 1790000000006/1790000000057 两条防线迁移全靠它（不建模就会被误判成纯数据）。
const RE_CREATE_FUNCTION = new RegExp(
  String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+(${NAME})`,
  "gi",
);
const RE_CREATE_TRIGGER = new RegExp(
  String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(${NAME})`,
  "gi",
);
const RE_ADD_COLUMN = new RegExp(
  String.raw`\bALTER\s+TABLE\s+(?:ONLY\s+)?(${NAME})\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${NAME})`,
  "gi",
);

const RE_DROP_TABLE = new RegExp(
  String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?((${NAME})(?:\s*,\s*${NAME})*)`,
  "gi",
);
const RE_DROP_INDEX = new RegExp(
  String.raw`\bDROP\s+INDEX\s+(CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(${NAME})`,
  "gi",
);
const RE_DROP_TYPE = new RegExp(
  String.raw`\bDROP\s+TYPE\s+(?:IF\s+EXISTS\s+)?(${NAME})`,
  "gi",
);
const RE_DROP_FUNCTION = new RegExp(
  String.raw`\bDROP\s+(?:FUNCTION|PROCEDURE)\s+(?:IF\s+EXISTS\s+)?(${NAME})`,
  "gi",
);
const RE_DROP_TRIGGER = new RegExp(
  String.raw`\bDROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?(${NAME})`,
  "gi",
);
const RE_DROP_COLUMN = new RegExp(
  String.raw`\bALTER\s+TABLE\s+(?:ONLY\s+)?(${NAME})\s+DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(${NAME})`,
  "gi",
);

/**
 * TypeORM builder 形态（`queryRunner.createTable(new Table({name:"x"}))` 等）。
 * 仓内 1717473142694 整条迁移都走这套 API，不解析就等于「这个文件零对象全绿」。
 * 注意：`createTable` 的 enum 列会**隐式建类型**，那类类型名由 TypeORM 生成、无法
 * 静态推断，本判据不计（见文件头「未覆盖形态」）。
 * sanitize 已把 `"x"` 的引号换成空格，所以这里按裸标识符匹配。
 */
const RE_API_CREATE_TABLE = /\bcreateTable\s*\(\s*new\s+Table\s*\(\s*\{/g;
const RE_API_CREATE_INDEX =
  /\bcreateIndex\s*\(\s*(?:([A-Za-z_][A-Za-z0-9_$]*)\s*,\s*)?new\s+TableIndex\s*\(\s*\{/g;
const RE_API_ADD_COLUMN =
  /\baddColumn\s*\(\s*([A-Za-z_][A-Za-z0-9_$]*)\s*,\s*new\s+TableColumn\s*\(\s*\{/g;
const RE_API_DROP_TABLE = /\bdropTable\s*\(\s*([A-Za-z_][A-Za-z0-9_$]*)/g;
const RE_API_DROP_COLUMN =
  /\bdropColumn\s*\(\s*([A-Za-z_][A-Za-z0-9_$]*)\s*,\s*([A-Za-z_][A-Za-z0-9_$]*)/g;
const RE_API_DROP_INDEX =
  /\bdropIndex\s*\(\s*([A-Za-z_][A-Za-z0-9_$]*)\s*,\s*(?:new\s+TableIndex\s*\(\s*\{\s*name\s*:\s*)?([A-Za-z_][A-Za-z0-9_$]*)/g;

/** 取 `{ ... }` 里第一个 `name: 字面量`（API 形态的对象名）。 */
function firstObjectName(text, from) {
  const m = /\bname\s*:\s*([A-Za-z_][A-Za-z0-9_$]*)/.exec(
    text.slice(from, from + 400),
  );
  return m ? m[1] : null;
}

/** 从 CREATE INDEX 之后解析 `ON <table> [(cols)]`（拿不到就返回 null）。 */
function parseIndexTarget(text, from) {
  const slice = text.slice(from, from + 400);
  const m =
    /^\s*(?:USING\s+[A-Za-z0-9_]+,\s*)*ON\s+(?:ONLY\s+)?([A-Za-z_][A-Za-z0-9_$]*)\s*(?:USING\s+[A-Za-z0-9_]+)?\s*\(([^)]*)\)/i.exec(
      slice,
    );
  if (!m) return null;
  const columns = [];
  let cm;
  IDENT_RE.lastIndex = 0;
  while ((cm = IDENT_RE.exec(m[2])) !== null) {
    const tok = cm[0];
    if (NON_COLUMN_WORDS.has(tok.toUpperCase())) continue;
    columns.push(tok);
  }
  return { table: m[1], columns };
}

/**
 * 提取「up 造出来的对象」。
 * 返回 { objects, partition, dynamic }，objects 元素：
 *   { kind: "table"|"index"|"column"|"type", key, line, concurrently?, table?, columns? }
 */
export function extractUpObjects(src) {
  const srcText = collectMethodText(src, "up");
  if (srcText == null) return null; // 没有 up（不是迁移文件）
  const upRange = findMethodRange(src, "up");
  const upLen = upRange.bodyEnd - upRange.bodyStart;
  const text = sanitize(srcText);
  const objects = new Map(); // key -> object（同名多次出现取首次）
  const partitions = [];
  let dynamic = 0;

  const push = (obj, idxInText) => {
    if (objects.has(obj.key)) return;
    // 前 upLen 个字符来自 up 本体，可精确换算行号；helper 部分不做行号承诺
    obj.line = idxInText < upLen ? lineAt(src, upRange.bodyStart + idxInText) : null;
    objects.set(obj.key, obj);
  };

  let m;
  RE_CREATE_TABLE.lastIndex = 0;
  while ((m = RE_CREATE_TABLE.exec(text)) !== null) {
    const name = m[1];
    // 分区子表语法是 `CREATE TABLE name PARTITION OF parent`——PARTITION 紧跟表名。
    // 只看向名字之后的少量字符，否则父表的 `PARTITION BY RANGE (...)` 后面若还有
    // 子表语句，会把父表也误判成分区子表（实测自检⑤踩到）。
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 100);
    if (/^\s*PARTITION\s+OF\b/i.test(after)) {
      // 例外①：分区子表随父表 DROP 走（父表本身仍要求 down 拆）。见文件头。
      partitions.push(name);
      continue;
    }
    if (name.startsWith("${")) {
      // 动态名（循环拼出来的对象，见 1789900000002 的日分区）：无法静态判对称，
      // 单列计数，避免「静默当它不存在」。
      dynamic += 1;
      continue;
    }
    if (NON_OBJECT_KEYWORDS.has(name.toUpperCase())) continue;
    push({ kind: "table", key: "table:" + name, name }, m.index);
  }

  RE_CREATE_INDEX.lastIndex = 0;
  while ((m = RE_CREATE_INDEX.exec(text)) !== null) {
    const unique = Boolean(m[1]);
    const concurrently = Boolean(m[2]);
    const name = m[3];
    if (name.startsWith("${")) {
      dynamic += 1;
      continue;
    }
    if (NON_OBJECT_KEYWORDS.has(name.toUpperCase())) continue;
    const target = parseIndexTarget(text, m.index + m[0].length);
    push(
      {
        kind: "index",
        key: "index:" + name,
        name,
        unique,
        concurrently,
        table: target ? target.table : null,
        columns: target ? target.columns : [],
      },
      m.index,
    );
  }

  RE_CREATE_TYPE.lastIndex = 0;
  while ((m = RE_CREATE_TYPE.exec(text)) !== null) {
    if (NON_OBJECT_KEYWORDS.has(m[1].toUpperCase())) continue;
    push({ kind: "type", key: "type:" + m[1], name: m[1] }, m.index);
  }

  RE_CREATE_FUNCTION.lastIndex = 0;
  while ((m = RE_CREATE_FUNCTION.exec(text)) !== null) {
    if (NON_OBJECT_KEYWORDS.has(m[1].toUpperCase())) continue;
    push({ kind: "function", key: "function:" + m[1], name: m[1] }, m.index);
  }

  RE_CREATE_TRIGGER.lastIndex = 0;
  while ((m = RE_CREATE_TRIGGER.exec(text)) !== null) {
    if (NON_OBJECT_KEYWORDS.has(m[1].toUpperCase())) continue;
    push({ kind: "trigger", key: "trigger:" + m[1], name: m[1] }, m.index);
  }

  RE_ADD_COLUMN.lastIndex = 0;
  while ((m = RE_ADD_COLUMN.exec(text)) !== null) {
    const table = m[1];
    const col = m[2];
    if (col.startsWith("${")) {
      dynamic += 1;
      continue;
    }
    if (NON_COLUMN_KEYWORDS.has(col.toUpperCase())) continue;
    push(
      { kind: "column", key: `column:${table}.${col}`, table, name: col },
      m.index,
    );
  }

  // TypeORM builder 形态（见上方 RE_API_* 注释）
  RE_API_CREATE_TABLE.lastIndex = 0;
  while ((m = RE_API_CREATE_TABLE.exec(text)) !== null) {
    const name = firstObjectName(text, m.index + m[0].length);
    if (name) push({ kind: "table", key: "table:" + name, name }, m.index);
  }
  RE_API_CREATE_INDEX.lastIndex = 0;
  while ((m = RE_API_CREATE_INDEX.exec(text)) !== null) {
    const table = m[1] ?? null;
    const name = firstObjectName(text, m.index + m[0].length);
    if (!name) continue;
    push(
      {
        kind: "index",
        key: "index:" + name,
        name,
        // 唯一性不参与对称判据；builder 形态也不表达 CONCURRENTLY（TypeORM 无此开关）
        unique: false,
        concurrently: false,
        table,
        columns: [],
      },
      m.index,
    );
  }
  RE_API_ADD_COLUMN.lastIndex = 0;
  while ((m = RE_API_ADD_COLUMN.exec(text)) !== null) {
    const table = m[1];
    const name = firstObjectName(text, m.index + m[0].length);
    if (!name) continue;
    push(
      { kind: "column", key: `column:${table}.${name}`, table, name },
      m.index,
    );
  }

  return { objects: [...objects.values()], partition: partitions, dynamic };
}

/** 提取 down 的拆除动作。 */
export function extractDownDrops(src) {
  const downText = collectMethodText(src, "down");
  if (downText == null) return null;
  const text = sanitize(downText);
  const tables = new Set();
  const indexes = new Map(); // name -> { concurrently }
  const types = new Set();
  const functions = new Set();
  const triggers = new Set();
  const columns = new Map(); // "table.col" -> true
  let m;

  RE_DROP_TABLE.lastIndex = 0;
  while ((m = RE_DROP_TABLE.exec(text)) !== null) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim();
      if (!name) continue;
      tables.add(name);
    }
  }

  RE_DROP_INDEX.lastIndex = 0;
  while ((m = RE_DROP_INDEX.exec(text)) !== null) {
    indexes.set(m[2], { concurrently: Boolean(m[1]) });
  }

  RE_DROP_TYPE.lastIndex = 0;
  while ((m = RE_DROP_TYPE.exec(text)) !== null) {
    types.add(m[1]);
  }

  RE_DROP_FUNCTION.lastIndex = 0;
  while ((m = RE_DROP_FUNCTION.exec(text)) !== null) functions.add(m[1]);

  RE_DROP_TRIGGER.lastIndex = 0;
  while ((m = RE_DROP_TRIGGER.exec(text)) !== null) triggers.add(m[1]);

  RE_DROP_COLUMN.lastIndex = 0;
  while ((m = RE_DROP_COLUMN.exec(text)) !== null) {
    const table = m[1];
    const col = m[2];
    if (NON_COLUMN_KEYWORDS.has(col.toUpperCase())) continue;
    columns.set(`${table}.${col}`, true);
  }

  // TypeORM builder 形态的拆除（仓内 down 目前都用 SQL，但 api 形态的 up 会配 api 的 down）
  RE_API_DROP_TABLE.lastIndex = 0;
  while ((m = RE_API_DROP_TABLE.exec(text)) !== null) tables.add(m[1]);
  RE_API_DROP_INDEX.lastIndex = 0;
  while ((m = RE_API_DROP_INDEX.exec(text)) !== null) {
    indexes.set(m[2], { concurrently: false });
  }
  RE_API_DROP_COLUMN.lastIndex = 0;
  while ((m = RE_API_DROP_COLUMN.exec(text)) !== null) {
    columns.set(`${m[1]}.${m[2]}`, true);
  }

  return { tables, indexes, types, functions, triggers, columns };
}

/** down() 是否显式声明「不可逆」：返回 { declared, reason, line } 或 null。 */
export function detectIrreversible(src) {
  const range = findMethodRange(src, "down");
  if (!range) return null;
  const body = src.slice(range.bodyStart, range.bodyEnd);
  // 只洗注释、**保留字符串字面量**：理由就写在字符串里，洗掉引号就取不到理由了。
  const text = sanitize(body, { keepStrings: true });
  const throwRe = /\bthrow\b/g;
  const m = throwRe.exec(text);
  if (!m) return null;
  // 只接受带理由字符串的 throw：`throw new Error("...")` / `throw new XxxError(\`...\`)` / `throw "..."`
  const after = text.slice(m.index, m.index + 400);
  const str = /(["'`])([\s\S]*?)\1/.exec(after);
  const reason = str ? str[2].replace(/\s+/g, " ").trim() : "";
  return {
    declared: true,
    reason,
    hasReason: reason.length >= 8,
    line: lineAt(src, range.bodyStart + m.index),
  };
}

/* ─────────────────────────── 分析 ─────────────────────────── */

function listMigrationFiles(migrationsDir) {
  if (!existsSync(migrationsDir)) return [];
  return readdirSync(migrationsDir)
    .filter(
      (f) =>
        f.endsWith(".ts") &&
        !f.endsWith(".spec.ts") &&
        !f.endsWith(".d.ts") &&
        !f.endsWith(".test.ts"),
    )
    .sort();
}

/**
 * 单个迁移的分析结果：
 *   { file, upObjects: n, matched: n, violations: [{object, reason, detail, line}],
 *     partition: n, dataOnly: bool, irreversible: {reason}|null, dynamic: n }
 */
export function analyzeMigration(file, src) {
  const up = extractUpObjects(src);
  const down = extractDownDrops(src);
  const irr = detectIrreversible(src);

  if (up == null) {
    return {
      file,
      missingMethods: true,
      upObjects: 0,
      matched: 0,
      violations: [],
      partition: 0,
      dataOnly: false,
      irreversible: null,
      dynamic: 0,
    };
  }

  const base = {
    file,
    upObjects: up.objects.length,
    partition: up.partition.length,
    dynamic: up.dynamic,
    violations: [],
    matched: 0,
    dataOnly: false,
    unmodeledDdl: false,
    noObjects: false,
    irreversible: null,
  };

  if (irr && irr.declared) {
    if (!irr.hasReason) {
      base.violations.push({
        object: "down()",
        reason: "throw-without-reason",
        detail:
          "down() 抛了「不可逆」但没有理由字符串——不可逆必须写明为什么（≥ 8 字符），否则回滚失败时运维无从判断",
        line: irr.line,
      });
      return base;
    }
    // 例外③：显式声明的不可逆迁移，计入 irreversible 清单，不要求对称（见文件头）。
    base.irreversible = { reason: irr.reason, line: irr.line };
    base.matched = up.objects.length;
    return base;
  }

  if (down == null) {
    base.violations.push({
      object: "down()",
      reason: "missing-down",
      detail: "迁移没有 down() 方法，up 造的对象无法回滚",
      line: null,
    });
    return base;
  }

  // 例外②：纯数据迁移（无 DDL、只有 DML）没有对象可拆。
  // 判定必须**两边都成立**：只看「没有对象」会把 `ALTER TYPE ... ADD VALUE`、
  // `CREATE FUNCTION` 这类未建模 DDL 误判成纯数据（1790000000006 就踩过：
  // 函数体里的 `BEFORE UPDATE OR DELETE` 还会顺手让 DML 正则命中）。
  const upSan = sanitize(collectMethodText(src, "up") ?? "");
  const hasDml = /\b(?:INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM)\b/i.test(upSan);
  const hasDdl = /\b(?:CREATE|ALTER|DROP)\s+/i.test(upSan);
  if (up.objects.length === 0) {
    if (hasDml && !hasDdl) {
      base.dataOnly = true;
      return base;
    }
    if (hasDdl) {
      // 有 DDL 但不在建模范围内（例如 ALTER TYPE ... ADD VALUE，PG 无法删值）。
      // 不判红（判据只覆盖可拆对象），但**列出来**，避免「静默全绿」。
      base.unmodeledDdl = true;
      return base;
    }
    // 既无 DDL 也无 DML：空迁移、或 DDL 只以动态 SQL 出现（如
    // 1788274394054 的 `EXECUTE 'ALTER TABLE ... RENAME COLUMN ...'`）。
    // 判据无可拆对象，但列出来，避免「这个文件去哪了」。
    base.noObjects = true;
    return base;
  }

  for (const obj of up.objects) {
    const violation = checkObject(obj, down);
    if (violation) base.violations.push(violation);
    else base.matched += 1;
  }
  return base;
}

function checkObject(obj, down) {
  if (obj.kind === "table") {
    if (down.tables.has(obj.name)) return null;
    return {
      object: obj.key,
      reason: "missing-drop",
      line: obj.line,
      detail: `up 创建了表 "${obj.name}"，down 没有 DROP TABLE "${obj.name}"`,
    };
  }
  if (obj.kind === "type") {
    if (down.types.has(obj.name)) return null;
    return {
      object: obj.key,
      reason: "missing-drop",
      line: obj.line,
      detail: `up 创建了类型 "${obj.name}"，down 没有 DROP TYPE "${obj.name}"`,
    };
  }
  if (obj.kind === "function" || obj.kind === "trigger") {
    const bucket = obj.kind === "function" ? down.functions : down.triggers;
    if (bucket.has(obj.name)) return null;
    const verb = obj.kind === "function" ? "函数" : "触发器";
    return {
      object: obj.key,
      reason: "missing-drop",
      line: obj.line,
      detail: `up 创建了${verb} "${obj.name}"，down 没有 DROP ${
        obj.kind === "function" ? "FUNCTION" : "TRIGGER"
      } "${obj.name}"`,
    };
  }
  if (obj.kind === "column") {
    if (down.columns.has(`${obj.table}.${obj.name}`) || down.tables.has(obj.table)) {
      return null;
    }
    return {
      object: obj.key,
      reason: "missing-drop",
      line: obj.line,
      detail: `up 给 "${obj.table}" 加了列 "${obj.name}"，down 没有 DROP COLUMN "${obj.name}"`,
    };
  }
  if (obj.kind === "index") {
    const drop = down.indexes.get(obj.name);
    if (drop) {
      if (obj.concurrently && !drop.concurrently) {
        return {
          object: obj.key,
          reason: "concurrently",
          line: obj.line,
          detail:
            `up 用 CREATE INDEX CONCURRENTLY 建 "${obj.name}"，down 却是普通 DROP INDEX` +
            `——回滚会锁表（CONCURRENTLY 的意义就是不持写锁，down 必须同样 CONCURRENTLY）`,
        };
      }
      return null;
    }
    // 索引随表/列消失（PG 语义）：down DROP TABLE 或删掉索引列即等价拆除。
    if (obj.table && down.tables.has(obj.table)) return null;
    if (
      obj.table &&
      obj.columns.some((c) => down.columns.has(`${obj.table}.${c}`))
    ) {
      return null;
    }
    return {
      object: obj.key,
      reason: "missing-drop",
      line: obj.line,
      detail: `up 创建了索引 "${obj.name}"${
        obj.table ? `（ON "${obj.table}"）` : ""
      }，down 没有 DROP INDEX "${obj.name}"`,
    };
  }
  return null;
}

/* ─────────────────────────── 基线 ─────────────────────────── */

function entryKey(v) {
  return `${v.file}::${v.object}::${v.reason}`;
}

export function readBaseline(root) {
  const p = join(root, BASELINE_REL);
  if (!existsSync(p)) return { violations: [], irreversible: [], missing: true };
  // 事实源损坏不能抛栈（T4 收编）：裸 `JSON.parse` 抛出来的是十几行 node 内部栈，
  // 读的人分不清「基线文件写坏了」与「守卫自己崩了」，也不一定看得见是**哪个**文件。
  // 这里统一转成一句带路径 + 解析器原话的报错，由 run() 判 1（仍然 fail-closed）。
  let raw;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    throw new Error(`基线文件不可读/不可解析：${p}（${err.message}）`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`基线文件结构非法（应为对象，含 violations / irreversible 数组）：${p}`);
  }
  // 键存在但类型不对同样是事实源损坏：旧实现静默当成空数组，于是「基线里其实
  // 登记了 N 条」与「一条都没登记」在守卫眼里长得一样（前者会让全部存量一起报
  // 「新增违规」，红得莫名其妙）。现在显式判结构。
  for (const key of ["violations", "irreversible"]) {
    if (key in raw && !Array.isArray(raw[key])) {
      throw new Error(`基线文件字段类型非法：${key} 必须是数组（${p}）`);
    }
  }
  return {
    violations: Array.isArray(raw.violations) ? raw.violations : [],
    irreversible: Array.isArray(raw.irreversible) ? raw.irreversible : [],
    missing: false,
    comment: raw["$comment"],
  };
}

function scanTree(root, migrationsDir) {
  const files = listMigrationFiles(migrationsDir);
  const results = [];
  for (const file of files) {
    const src = readFileSync(join(migrationsDir, file), "utf8");
    const rel = relative(root, join(migrationsDir, file)).split(sep).join("/");
    results.push(analyzeMigration(rel, src));
  }
  const violations = [];
  const irreversible = [];
  for (const r of results) {
    for (const v of r.violations) violations.push({ file: r.file, ...v });
    if (r.irreversible) irreversible.push({ file: r.file, ...r.irreversible });
  }
  return { files, results, violations, irreversible };
}

/* ─────────────────────────── 输出 ─────────────────────────── */

function printReport(scan) {
  console.log("");
  console.log(`ℹ 不可逆迁移（${scan.irreversible.length}）：`);
  if (scan.irreversible.length === 0) {
    console.log("  （无：每个迁移都声明了可回滚路径）");
  } else {
    for (const i of scan.irreversible) {
      console.log(`  · ${i.file}${i.line ? ":" + i.line : ""} — ${i.reason}`);
    }
  }
  const unmodeled = scan.results.filter((r) => r.unmodeledDdl);
  const noObjects = scan.results.filter((r) => r.noObjects);
  console.log("");
  console.log(`ℹ 未建模 DDL（不参与判据，${unmodeled.length}）：`);
  if (unmodeled.length === 0) {
    console.log("  （无）");
  } else {
    for (const r of unmodeled) {
      console.log(
        `  · ${r.file} —— up 里有 CREATE/ALTER/DROP 但不产生可拆对象（列类型变更 / ALTER TYPE … ADD VALUE / 仅 DROP 既有对象）`,
      );
    }
  }
  console.log("");
  console.log(`ℹ 无可拆对象（${noObjects.length}）：`);
  if (noObjects.length === 0) {
    console.log("  （无）");
  } else {
    for (const r of noObjects) console.log(`  · ${r.file} —— up 里没有可拆对象（rename/动态 SQL/空迁移）`);
  }
  console.log("");
  console.log("ℹ 每迁移对称对象数（up 对象 / 已对称 / 违规 / 豁免）：");
  for (const r of scan.results) {
    if (
      r.upObjects === 0 &&
      !r.dataOnly &&
      !r.unmodeledDdl &&
      !r.noObjects &&
      r.violations.length === 0 &&
      !r.irreversible
    ) {
      continue;
    }
    const tags = [];
    if (r.dataOnly) tags.push("纯数据");
    if (r.unmodeledDdl) tags.push("未建模DDL");
    if (r.noObjects) tags.push("无可拆对象");
    if (r.irreversible) tags.push("不可逆");
    if (r.partition) tags.push(`分区表×${r.partition}`);
    if (r.dynamic) tags.push(`动态名×${r.dynamic}`);
    console.log(
      `  ${r.file}  up=${r.upObjects} 对称=${r.matched} 违规=${r.violations.length}` +
        (tags.length ? `  [${tags.join(" / ")}]` : ""),
    );
  }
  const exemptDataOnly = scan.results.filter((r) => r.dataOnly).length;
  const partitionTotal = scan.results.reduce((a, r) => a + r.partition, 0);
  console.log("");
  console.log(
    `ℹ 统计：迁移 ${scan.results.length} 个；纯数据豁免 ${exemptDataOnly} 个；` +
      `未建模 DDL ${unmodeled.length} 个；无可拆对象 ${noObjects.length} 个；` +
      `分区子表豁免 ${partitionTotal} 处；` +
      `不可逆 ${scan.irreversible.length} 个；违规 ${scan.violations.length} 条。`,
  );
}

/* ─────────────────────────── 主流程 ─────────────────────────── */

function run({ root, report, explicitRoot }) {
  const migrationsDir = join(root, MIGRATIONS_REL);
  const scan = scanTree(root, migrationsDir);
  let baseline;
  try {
    baseline = readBaseline(root);
  } catch (err) {
    console.error(`✖ ${err.message}`);
    console.error("  修法：把基线恢复成合法 JSON（或删掉它——缺失会按空基线处理并提示）。");
    return 1;
  }

  if (scan.results.length === 0) {
    console.error(`✖ 扫不到迁移文件：${migrationsDir}（路径或扩展名正则失效？）`);
    return 1;
  }
  if (!explicitRoot && scan.results.length < DEFAULT_ROOT_MIN_MIGRATIONS) {
    console.error(
      `✖ 只扫到 ${scan.results.length} 个迁移，明显少于历史规模（${DEFAULT_ROOT_MIN_MIGRATIONS}+）——扫描面可能失效。`,
    );
    return 1;
  }
  if (scan.results.some((r) => r.missingMethods)) {
    const bad = scan.results.filter((r) => r.missingMethods).map((r) => r.file);
    console.error("✖ 以下文件找不到 up() 方法（迁移文件必须有 up）：");
    for (const f of bad) console.error("  · " + f);
    return 1;
  }

  const currentViolationKeys = new Set(scan.violations.map(entryKey));
  const baselineViolationKeys = new Set(baseline.violations.map(entryKey));
  const newViolations = scan.violations.filter((v) => !baselineViolationKeys.has(entryKey(v)));
  const staleViolations = baseline.violations.filter((v) => !currentViolationKeys.has(entryKey(v)));

  const currentIrr = new Set(scan.irreversible.map(entryKey));
  const baselineIrr = new Set(baseline.irreversible.map(entryKey));
  const newIrr = scan.irreversible.filter((i) => !baselineIrr.has(entryKey(i)));
  const staleIrr = baseline.irreversible.filter((i) => !currentIrr.has(entryKey(i)));

  if (report) {
    printReport(scan);
    if (scan.violations.length) {
      console.log("");
      console.log("ℹ 违规明细：");
      for (const v of scan.violations) {
        console.log(
          `  · ${v.file}${v.line ? ":" + v.line : ""}  ${v.object}  [${v.reason}]  ${v.detail}`,
        );
      }
    }
  }

  const failureLines = [];
  if (newViolations.length > 0) {
    failureLines.push(`✖ 新增迁移对称性违规 ${newViolations.length} 条（基线 ${baseline.violations.length} 条）：`);
    for (const v of newViolations) {
      failureLines.push(`  · ${v.file}${v.line ? ":" + v.line : ""}  ${v.object}  [${v.reason}]`);
      failureLines.push(`    ${v.detail}`);
    }
    failureLines.push(
      "  修法：在 down() 里补对称的 DROP TABLE / DROP INDEX / DROP COLUMN / DROP TYPE / DROP FUNCTION / DROP TRIGGER；" +
        "确实是纯数据或分区表的形态按脚本内例外处理；确属不可逆的写 throw + 理由。",
    );
  }
  if (staleViolations.length > 0) {
    failureLines.push(
      `✖ 基线陈旧：${staleViolations.length} 条违规已修复，但仍留在 ${BASELINE_REL} —— 请删掉这些条目（棘轮只允许变好，修复必须落回基线）。`,
    );
    for (const v of staleViolations) failureLines.push(`  · ${v.file}  ${v.object}  [${v.reason}]`);
  }
  if (newIrr.length > 0) {
    failureLines.push(`✖ 新增不可逆迁移 ${newIrr.length} 个（必须显式登记，让「放弃回滚」出现在 diff 里）：`);
    for (const i of newIrr) failureLines.push(`  · ${i.file}  ${i.reason}`);
  }
  if (staleIrr.length > 0) {
    failureLines.push(`✖ 不可逆清单陈旧：${staleIrr.length} 个已不再是不可逆，但仍留在基线里：`);
    for (const i of staleIrr) failureLines.push(`  · ${i.file}`);
  }

  if (failureLines.length > 0) {
    console.error("");
    for (const line of failureLines) console.error(line);
    return 1;
  }

  const dataOnly = scan.results.filter((r) => r.dataOnly).length;
  const partitionTotal = scan.results.reduce((a, r) => a + r.partition, 0);
  const unmodeledCount = scan.results.filter((r) => r.unmodeledDdl).length;
  const noObjectsCount = scan.results.filter((r) => r.noObjects).length;
  console.log(
    `✔ 迁移 up/down 对称性棘轮通过：${scan.results.length} 个迁移，违规 ${scan.violations.length} 条` +
      `（基线 ${baseline.violations.length}），不可逆 ${scan.irreversible.length} 个，` +
      `纯数据豁免 ${dataOnly} 个，分区子表豁免 ${partitionTotal} 处，未建模 DDL ${unmodeledCount} 个，` +
      `无可拆对象 ${noObjectsCount} 个`,
  );
  if (scan.irreversible.length > 0) {
    console.log("  不可逆迁移（--report 看理由）：");
    for (const i of scan.irreversible) console.log(`  · ${i.file}`);
  }
  if (scan.violations.length > 0) {
    console.log("  已在基线中登记、待修的违规（--report 看明细）：");
    for (const v of scan.violations) console.log(`  · ${v.file}  ${v.object}  [${v.reason}]`);
  }
  if (baseline.missing) {
    console.log(`  ℹ 基线文件不存在（${BASELINE_REL}），按空基线处理。`);
  }
  return 0;
}

/* ─────────────────────────── 自检 ─────────────────────────── */

const SELFTEST_CASES = [
  {
    name: "① 对称绿：CREATE TABLE + DROP TABLE",
    status: 0,
    expect: ["✔ 迁移 up/down 对称性棘轮通过", "1 个迁移"],
    files: {
      "1770000000001-Symmetric.ts": `
import { MigrationInterface, QueryRunner } from "typeorm";
export class Symmetric1770000000001 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(\`CREATE TABLE "widgets" ("id" SERIAL PRIMARY KEY)\`);
    await q.query(\`CREATE INDEX "idx_widgets_id" ON "widgets" ("id")\`);
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(\`DROP INDEX IF EXISTS "idx_widgets_id"\`);
    await q.query(\`DROP TABLE IF EXISTS "widgets"\`);
  }
}
`,
    },
  },
  {
    name: "② up 有 down 无 → 红，点名文件与对象",
    status: 1,
    expect: [
      "新增迁移对称性违规 1 条",
      "1770000000002-MissingDrop.ts",
      "table:orphan",
      'down 没有 DROP TABLE "orphan"',
    ],
    files: {
      "1770000000002-MissingDrop.ts": `
import { MigrationInterface, QueryRunner } from "typeorm";
export class MissingDrop1770000000002 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(\`CREATE TABLE IF NOT EXISTS "orphan" ("id" SERIAL)\`);
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(\`SELECT 1\`);
  }
}
`,
    },
  },
  {
    name: "③ IF NOT EXISTS / IF EXISTS 等价（含多行 SQL）",
    status: 0,
    expect: ["✔ 迁移 up/down 对称性棘轮通过"],
    files: {
      "1770000000003-IfExists.ts": `
import { MigrationInterface, QueryRunner } from "typeorm";
export class IfExists1770000000003 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(\`
      CREATE TABLE IF NOT EXISTS "app_deployments" (
        "id" SERIAL NOT NULL
      )
    \`);
    await q.query(\`
      CREATE INDEX IF NOT EXISTS "idx_app_deployments_status"
        ON "app_deployments" ("status")
    \`);
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(\`DROP INDEX IF EXISTS "idx_app_deployments_status"\`);
    await q.query(\`DROP TABLE IF EXISTS "app_deployments"\`);
  }
}
`,
    },
  },
  {
    name: "④ CONCURRENTLY 不对称 → 红（回滚会锁表）",
    status: 1,
    expect: [
      "新增迁移对称性违规 1 条",
      "1770000000004-Concurrently.ts",
      "concurrently",
      "回滚会锁表",
    ],
    files: {
      "1770000000004-Concurrently.ts": `
import { MigrationInterface, QueryRunner } from "typeorm";
export class Concurrently1770000000004 implements MigrationInterface {
  transaction = false;
  public async up(q: QueryRunner): Promise<void> {
    await q.query(\`CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_big" ON "events" ("createdAt")\`);
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(\`DROP INDEX IF EXISTS "idx_big"\`);
  }
}
`,
    },
  },
  {
    name: "⑤ 分区表豁免（PARTITION OF 不要求逐个 DROP）",
    status: 0,
    expect: ["✔ 迁移 up/down 对称性棘轮通过", "分区子表豁免 1 处"],
    files: {
      "1770000000005-Partition.ts": `
import { MigrationInterface, QueryRunner } from "typeorm";
export class Partition1770000000005 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(\`CREATE TABLE "logs" ("id" SERIAL, "createdAt" TIMESTAMP) PARTITION BY RANGE ("createdAt")\`);
    await q.query(\`CREATE TABLE IF NOT EXISTS "logs_2026_01" PARTITION OF "logs" FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')\`);
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(\`DROP TABLE IF EXISTS "logs"\`);
  }
}
`,
    },
  },
  {
    name: "⑥ 纯数据迁移豁免（无 DDL，只有 UPDATE）",
    status: 0,
    expect: ["✔ 迁移 up/down 对称性棘轮通过", "纯数据豁免 1 个"],
    files: {
      "1770000000006-DataOnly.ts": `
import { MigrationInterface, QueryRunner } from "typeorm";
export class DataOnly1770000000006 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(\`UPDATE "task_templates" SET "config" = '{}' WHERE "key" = 'x'\`);
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(\`UPDATE "task_templates" SET "config" = '{"old":1}' WHERE "key" = 'x'\`);
  }
}
`,
    },
  },
  {
    name: "⑦ 显式不可逆计入清单（throw + 理由）",
    status: 0,
    expect: ["✔ 迁移 up/down 对称性棘轮通过", "不可逆 1 个"],
    files: {
      "1770000000007-Irreversible.ts": `
import { MigrationInterface, QueryRunner } from "typeorm";
export class Irreversible1770000000007 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(\`ALTER TABLE "users" ADD COLUMN "mergedInto" INTEGER\`);
  }
  public async down(): Promise<void> {
    throw new Error("不可逆：合并用户时旧行的密码历史已被覆写，无法还原");
  }
}
`,
    },
    baseline: {
      violations: [],
      irreversible: [
        {
          file: "apps/admin-api/src/migrations/1770000000007-Irreversible.ts",
          reason: "不可逆：合并用户时旧行的密码历史已被覆写，无法还原",
          line: 7,
        },
      ],
    },
  },
  {
    name: "⑦b down 抛「不可逆」但没写理由 → 红",
    status: 1,
    expect: ["throw-without-reason", 'down() 抛了「不可逆」但没有理由字符串'],
    files: {
      "1770000000008-NoReason.ts": `
import { MigrationInterface, QueryRunner } from "typeorm";
export class NoReason1770000000008 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(\`CREATE TABLE "x8" ("id" SERIAL)\`);
  }
  public async down(): Promise<void> {
    throw new Error();
  }
}
`,
    },
  },
  {
    name: "⑧ 基线陈旧（已修但基线没删）→ 红",
    status: 1,
    expect: ["基线陈旧", "1770000000009-Fixed.ts", "table:fixed"],
    files: {
      "1770000000009-Fixed.ts": `
import { MigrationInterface, QueryRunner } from "typeorm";
export class Fixed1770000000009 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(\`CREATE TABLE "fixed" ("id" SERIAL)\`);
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(\`DROP TABLE "fixed"\`);
  }
}
`,
    },
    baseline: {
      violations: [
        {
          file: "apps/admin-api/src/migrations/1770000000009-Fixed.ts",
          object: "table:fixed",
          reason: "missing-drop",
        },
      ],
      irreversible: [],
    },
  },
  {
    name: "⑨ 基线登记的真实违规 → 绿（棘轮放行存量）",
    status: 0,
    expect: ["✔ 迁移 up/down 对称性棘轮通过", "违规 1 条（基线 1）"],
    files: {
      "1770000000010-Known.ts": `
import { MigrationInterface, QueryRunner } from "typeorm";
export class Known1770000000010 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(\`CREATE TABLE "legacy_orphan" ("id" SERIAL)\`);
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(\`SELECT 1\`);
  }
}
`,
    },
    baseline: {
      violations: [
        {
          file: "apps/admin-api/src/migrations/1770000000010-Known.ts",
          object: "table:legacy_orphan",
          reason: "missing-drop",
        },
      ],
      irreversible: [],
    },
  },
  {
    name: "⑩ 索引随 down 的 DROP TABLE 消失 → 放行；列/类型缺失仍红",
    status: 1,
    expect: ["column:users.legacyFlag", "type:legacy_enum", "新增迁移对称性违规 2 条"],
    files: {
      "1770000000011-Partial.ts": `
import { MigrationInterface, QueryRunner } from "typeorm";
export class Partial1770000000011 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(\`CREATE TABLE "tmp_table" ("id" SERIAL)\`);
    await q.query(\`CREATE INDEX "idx_tmp_table_id" ON "tmp_table" ("id")\`);
    await q.query(\`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "legacyFlag" BOOLEAN\`);
    await q.query(\`CREATE TYPE "legacy_enum" AS ENUM ('a')\`);
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(\`DROP TABLE IF EXISTS "tmp_table"\`);
    await q.query(\`ALTER TABLE "users" DROP COLUMN IF EXISTS "otherFlag"\`);
  }
}
`,
    },
  },
  {
    name: "⑪ 注释里提到的 DDL 不算对象",
    status: 0,
    expect: ["✔ 迁移 up/down 对称性棘轮通过"],
    files: {
      "1770000000012-CommentOnly.ts": `
import { MigrationInterface, QueryRunner } from "typeorm";
/**
 * 历史注记：本仓没有任何 CREATE TABLE "ghost" / DROP TABLE "ghost"，
 * 也没有 ALTER TABLE "users" ADD COLUMN "ghostCol"。
 */
export class CommentOnly1770000000012 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // CREATE TABLE "ghost" 只在注释里
    await q.query(\`SELECT 1\`);
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(\`SELECT 1\`);
  }
}
`,
    },
  },
  {
    name: "⑫ TypeORM builder 形态（createTable/createIndex）按字面名对称 → 绿",
    status: 0,
    expect: ["✔ 迁移 up/down 对称性棘轮通过"],
    files: {
      "1770000000013-Builder.ts": `
import { MigrationInterface, QueryRunner, Table, TableIndex } from "typeorm";
export class Builder1770000000013 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.createTable(
      new Table({
        name: "api_widgets",
        columns: [{ name: "id", type: "uuid", isPrimary: true }],
      }),
      true,
    );
    await q.createIndex(
      "api_widgets",
      new TableIndex({ name: "IDX_api_widgets_name", columnNames: ["name"] }),
    );
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(\`DROP INDEX IF EXISTS "IDX_api_widgets_name"\`);
    await q.query(\`DROP TABLE IF EXISTS "api_widgets"\`);
  }
}
`,
    },
  },
  {
    name: "⑬ 触发器建了不拆 → 红（点名 trigger 对象）",
    status: 1,
    expect: ["新增迁移对称性违规 1 条", "trigger:trg_widgets_guard", "down 没有 DROP TRIGGER"],
    files: {
      "1770000000014-Trigger.ts": `
import { MigrationInterface, QueryRunner } from "typeorm";
export class Trigger1770000000014 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(\`
      CREATE OR REPLACE FUNCTION widgets_guard() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql
    \`);
    await q.query(\`
      CREATE TRIGGER trg_widgets_guard BEFORE UPDATE ON "widgets"
      FOR EACH ROW EXECUTE FUNCTION widgets_guard()
    \`);
  }
  public async down(q: QueryRunner): Promise<void> {
    await q.query(\`DROP FUNCTION IF EXISTS widgets_guard()\`);
  }
}
`,
    },
  },
];

/**
 * 把一条用例的 fixture 摊成 `makeFixtureRepo` 的文件表：迁移文件落
 * `apps/admin-api/src/migrations/`，基线落 `scripts/`（与真实树同构，--root 直接指过去）。
 */
function fixtureFiles(c) {
  const files = {};
  for (const [name, content] of Object.entries(c.files ?? {})) {
    files[`${MIGRATIONS_REL.split(sep).join("/")}/${name}`] = content;
  }
  // 基线内容非 string → makeFixtureRepo 按 JSON 写（与旧 writeFixture 的
  // `JSON.stringify(baseline, null, 2) + "\n"` 等价）。
  if (c.baseline) files[BASELINE_REL.split(sep).join("/")] = c.baseline;
  return files;
}

/**
 * selftest（T4 收编）：全部用例都跑**真子进程** + 断言退出码/关键文本/耗时。
 *
 * 旧实现自己攒了一套 `mkdtempSync + writeFixture + spawnSync + problems[]`，
 * 与另外 40 多个守卫各写一份、细节互不一致（不设超时、`code === null` 当成
 * 普通退出码比较）。现在统一走 `scripts/lib/guard-selftest.mjs`：
 *   · `runGuard` 负责起进程（脚本/cwd 不存在立即抛错，超时给布尔）；
 *   · `expectExit` 负责判（码 + 文本 + withinMs，失败抛带 cwd 与输出尾部的错）；
 *   · `makeFixtureRepo`/`reportCases` 负责造树与汇总。
 * 用例语义、条数与判据一个字都没改（`status`/`expect` 原样喂给 expectExit）。
 */
function selftest() {
  const self = fileURLToPath(import.meta.url);
  const cases = SELFTEST_CASES.map((c) => ({
    name: c.name,
    fn: () => {
      const repo = makeFixtureRepo(fixtureFiles(c), { prefix: "acf-msym-" });
      try {
        expectExit(runGuard(self, { args: ["--root", repo.dir] }), {
          code: c.status,
          contains: c.expect,
          absent: c.absent ?? [],
          withinMs: SELFTEST_CASE_BUDGET_MS,
          label: c.name,
        });
      } finally {
        repo.cleanup();
      }
    },
  }));
  // ⑭ 事实源损坏（in-process，T4 收编时加的）：`readBaseline` 是纯读取契约，为
  // 「同一个 catch 的退出码」再起一次 node（~40ms，本条 selftest 有全局耗时预算）
  // 不划算，故直接调导出函数断言：报错**点名文件**、说清「不可读/不可解析」，且不带
  // 解析器调用栈。⚠ 边界（如实）：CLI 层「坏基线 → exit 1」没有独立用例——它靠 run()
  // 里那个 catch 与上面 15 条子进程用例共用的返回路径兜着；谁动 run() 的 catch，
  // 请把它补成一条 `--root` 子进程用例（含 `absent: ["    at "]`）。
  cases.push({
    name: "⑭ 基线文件损坏 → 可读报错、点名文件（不甩解析栈）",
    fn: () => {
      const repo = makeFixtureRepo({
        [BASELINE_REL.split(sep).join("/")]: '{\n  "violations": [ , ]\n}\n',
      });
      try {
        let caught = null;
        try {
          readBaseline(repo.dir);
        } catch (err) {
          caught = err;
        }
        const must = (cond, message) => {
          if (!cond) throw new Error(message);
        };
        must(caught !== null, "损坏的基线没有报错——它会被静默当成空基线");
        must(
          caught.message.includes("基线文件不可读/不可解析"),
          `报错没说明「不可解析」：${caught.message}`,
        );
        must(
          caught.message.includes("migration-symmetry-baseline.json"),
          `报错没点名文件：${caught.message}`,
        );
        must(!caught.message.includes("    at "), "报错里带了调用栈");
      } finally {
        repo.cleanup();
      }
    },
  });

  const failed = reportCases(cases, { title: "check-migration-symmetry selftest" });
  if (failed > 0) process.exit(1);
}

/* ─────────────────────────── 入口 ─────────────────────────── */

function parseArgs(argv) {
  const opts = { root: process.cwd(), report: false, selftest: false, explicitRoot: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--selftest") opts.selftest = true;
    else if (a === "--report") opts.report = true;
    else if (a === "--root") {
      opts.root = argv[++i] ?? "";
      opts.explicitRoot = true;
    } else if (a.startsWith("--root=")) {
      opts.root = a.slice("--root=".length);
      opts.explicitRoot = true;
    }
  }
  if (!opts.root) {
    console.error("✖ --root 需要一个目录参数");
    process.exit(2);
  }
  return opts;
}

const invokedDirectly =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selftest) selftest();
  else process.exit(run(opts));
}

// 测试与排障用（子进程自检不依赖这些导出；保留给未来的 in-process 断言）。
export { findMethodRange, collectMethodText, sanitize };
