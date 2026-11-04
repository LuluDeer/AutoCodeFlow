#!/usr/bin/env node
// AGENT-INDEX-NAMES：agent 域三条路径的**目标唯一索引名**，必须与**迁移 DDL 逐字一致**。
//
// ## 为什么需要这条守卫（这是一个已定位、但当时"未验证"的缺口）
//
// R9 起，agent 域的 23505 归因从「只看 code」改成**按约束名归因**
// （`apps/admin-api/src/modules/agent/runtime/agent-unique-violation.util.ts` 的
// `AGENT_UNIQUE_CONSTRAINTS`）。这三个名字**直接决定归因是否生效**：
//
// · 名字**写错** ⇒ 真实冲突也落 `unknown` ⇒ 归因**静默失效**
//   （等于回到改前行为：不会误判成别的冲突，但也不再变严）；
// · 名字**被迁移改掉**而 util 没跟 ⇒ 同上，**静默失效**。
//
// 迁移里的索引名由 `CREATE UNIQUE INDEX "..."` 决定；实体上是 `@Column({unique:true})`
// （若有人跑 `synchronize`，名字会变成 `UQ_<hash>`）。
//
// **既有守卫覆盖不到**：`check-index-drift` 比对的是「实体 `@Index`/表级 UNIQUE 声明」
// 与「迁移 DDL」的**索引集合与列**；而 agent 这三条索引是 **raw SQL 迁移**里建的
// （`1790000000040` / `1790000000067` / `1790000000089`），**不在实体声明里**
// ⇒ **名字与 util 常量的一致性从未被任何守卫覆盖**。
// util 头注当时写的是「这条风险**未验证**」—— 本守卫把它变成可验证的。
//
// ## 判据（两侧都必须有，且逐字相等）
//   左侧：`agent-unique-violation.util.ts` 的 `AGENT_UNIQUE_CONSTRAINTS` 的三个值
//   右侧：`apps/admin-api/src/migrations/*.ts` 里 `CREATE UNIQUE INDEX "<name>"` 的名字
// ⇒ 三条**逐字对应**（一个都不能多、不能少、不能拼写不同）。
//
// ## 为什么用"字面量扫描"而不是 AST
// util 的常量是 `as const` 对象，迁移里是**模板字符串**里的 DDL（`CREATE UNIQUE INDEX
// IF NOT EXISTS "name"`）。两侧形态都极稳定，用**可复现的字面量扫描**即可，
// 且**不引任何依赖**（本仓守卫的硬要求）。
//
// 用法：
//   node scripts/check-agent-index-names.mjs              # 检查真实仓库
//   node scripts/check-agent-index-names.mjs --selftest    # 验证判据本身
//   node scripts/check-agent-index-names.mjs --root <dir>   # selftest 专用
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

const HERE = join(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = join(HERE, "..");

const UTIL_REL = "apps/admin-api/src/modules/agent/runtime/agent-unique-violation.util.ts";
const MIGRATIONS_REL = "apps/admin-api/src/migrations";

/** util 侧：三个键 → 索引名（从 `as const` 对象里抽字面量）。 */
export function readUtilConstraintNames(text) {
  const start = text.indexOf("AGENT_UNIQUE_CONSTRAINTS");
  if (start < 0) return null;
  const objStart = text.indexOf("{", start);
  if (objStart < 0) return null;
  /**
   * ⚠️ **不能用 `indexOf("}")` 找结束**（2026-11-04 实测踩到）：
   * `approvalKey` 那一条的 JSDoc 里写着 ``@Column({ unique: true })`` ——
   * 里面有个 `}` ⇒ 朴素 indexOf 会把对象**截断在第 2 条之后**，
   * 于是 `approvalKey` 静默漏检（守卫报"2 条路径一致"而实际有 3 条）。
   *
   * ⇒ 用具名结束标记 `} as const`（本仓该常量的形态固定）作为**可验证结构**；
   * 找不到就返回 null（调用方判结构红），**绝不**退回朴素 indexOf。
   * 这与方法学⑤「位置推断必须用可验证结构（括号配平），不能用邻近启发式」同族 ——
   * 错位置比漏检更坏（这里就是"漏检却报绿"）。
   */
  const tail = /\}\s*as\s+const/g;
  tail.lastIndex = objStart;
  const m = tail.exec(text);
  if (!m) return null;
  const body = text.slice(objStart, m.index);
  const out = new Map();
  // 形如：  stepSeq: "idx_agent_steps_sessionId_seq",
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*["']([^"']+)["']/g;
  for (const m of body.matchAll(re)) out.set(m[1], m[2]);
  return out;
}

/** 迁移侧：所有 `CREATE UNIQUE INDEX ... "<name>"` 的索引名 → 迁移文件。 */
export function readMigrationIndexNames(text, rel) {
  const out = new Map();
  const re = /CREATE\s+UNIQUE\s+INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:CONCURRENTLY\s+)?["`]([^"`]+)["`]/gi;
  for (const m of text.matchAll(re)) {
    if (!out.has(m[1])) out.set(m[1], rel);
  }
  return out;
}

/**
 * 主检查。
 *
 * @param {{root?: string}} [opts]
 * @returns {{errors: string[], structure: string[], checked: number}}
 */
export function check({ root = process.cwd() } = {}) {
  const errors = [];
  const structure = [];
  const utilPath = join(root, UTIL_REL);
  if (!existsSync(utilPath)) {
    structure.push(`读不到 ${UTIL_REL} —— 事实源不存在（不是"约束名对不上"）。`);
    return { errors, structure, checked: 0 };
  }
  const utilNames = readUtilConstraintNames(readFileSync(utilPath, "utf-8"));
  if (!utilNames || utilNames.size === 0) {
    structure.push(
      `从 ${UTIL_REL} 解析不出 AGENT_UNIQUE_CONSTRAINTS 的条目 —— 解析器失效` +
        `（或常量被改名/改形态）。**不要**因此判绿：判据瞎了就是结构红。`,
    );
    return { errors, structure, checked: 0 };
  }
  const migDir = join(root, MIGRATIONS_REL);
  if (!existsSync(migDir)) {
    structure.push(`读不到 ${MIGRATIONS_REL} —— 迁移目录不存在（不是"约束名对不上"）。`);
    return { errors, structure, checked: utilNames.size };
  }
  const migNames = new Map();
  for (const f of readdirSync(migDir).filter((x) => x.endsWith(".ts")).sort()) {
    const rel = `${MIGRATIONS_REL}/${f}`;
    for (const [name, where] of readMigrationIndexNames(readFileSync(join(migDir, f), "utf-8"), rel)) {
      if (!migNames.has(name)) migNames.set(name, where);
    }
  }
  if (migNames.size === 0) {
    structure.push(
      `从 ${MIGRATIONS_REL} 解析不出任何 CREATE UNIQUE INDEX —— 扫描面失效` +
        `（迁移里若改用别的写法，如动态拼接 SQL，本守卫需要同步扩展）。`,
    );
    return { errors, structure, checked: utilNames.size };
  }
  let checked = 0;
  for (const [key, name] of utilNames) {
    checked += 1;
    if (!migNames.has(name)) {
      const near = [...migNames.keys()].filter((n) => n.toLowerCase() === name.toLowerCase());
      errors.push(
        `util 的 \`${key}\` 写的是索引名 \`${name}\`，但**迁移里没有这个名字**` +
          (near.length ? `（大小写不同的近似：${near.join(" / ")}）` : "") +
          `。⇒ 23505 归因会落 \`unknown\` ⇒ **按约束名收窄静默失效**` +
          `（不会误判成别的冲突，但也不再变严）。` +
          `修法：改 util 的常量，或改迁移里的索引名（两者必须逐字一致）。`,
      );
    }
  }
  // 反向：util 声明的每个键都必须有**不同的**名字（防两个键写成同一个 ⇒ 一条路径的
  // 冲突会被另一条误认）。
  const seen = new Map();
  for (const [key, name] of utilNames) {
    if (seen.has(name)) {
      errors.push(
        `util 的 \`${key}\` 与 \`${seen.get(name)}\` **同名**（\`${name}\`）——` +
          `这样一条路径的冲突会被另一条路径误认为自己的 ⇒ 归因错误。`,
      );
    } else {
      seen.set(name, key);
    }
  }
  return { errors, structure, checked };
}

/**
 * 主入口。
 * @param {string[]} argv
 */
export function main(argv = process.argv.slice(2)) {
  if (argv.includes("--selftest")) return selftest();
  const rootIdx = argv.indexOf("--root");
  const root = rootIdx >= 0 ? join(argv[rootIdx + 1] ?? ".") : REPO_ROOT;
  const { errors, structure, checked } = check({ root });
  if (structure.length > 0) {
    console.error("✖ agent 索引名守卫的结构错（判据不可信）：");
    for (const s of structure) console.error(`  · ${s}`);
    return 1;
  }
  if (errors.length > 0) {
    console.error(`✖ ${errors.length} 处 agent 唯一索引名不一致：`);
    for (const e of errors) console.error(`  · ${e}`);
    return 1;
  }
  console.log(
    `✔ agent 域 ${checked} 条路径的目标唯一索引名与迁移 DDL 逐字一致` +
      `（改名会让 23505 按约束名归因静默失效，这条守卫就是防它）`,
  );
  return 0;
}

function selftest() {
  const SELF = fileURLToPath(import.meta.url);
  const cases = [];
  const add = (name, fn) => cases.push({ name, fn });

  const UTIL = `export const AGENT_UNIQUE_CONSTRAINTS = {
  stepSeq: "idx_agent_steps_sessionId_seq",
  eventSeq: "uq_agent_events_sessionId_seq",
  approvalKey: "UQ_agent_approvals_approvalKey",
} as const;
`;
  const MIG = (names) =>
    names
      .map((n, i) => `export class M${i} { public async up(q: any) { await q.query(\`CREATE UNIQUE INDEX IF NOT EXISTS "${n}" ON "t" ("c")\`); } }`)
      .join("\n");

  const tree = (util, mig) => ({
    [UTIL_REL]: util,
    [`${MIGRATIONS_REL}/1790000000040-x.ts`]: mig,
  });

  const runOn = (files) => {
    const repo = makeFixtureRepo(files, { prefix: "agent-index-names-selftest-" });
    const result = runGuard(SELF, { args: ["--root", repo.dir] });
    return { result, cleanup: repo.cleanup };
  };

  add("① 三名全一致 ⇒ 绿", () => {
    const { result, cleanup } = runOn(
      tree(UTIL, MIG(["idx_agent_steps_sessionId_seq", "uq_agent_events_sessionId_seq", "UQ_agent_approvals_approvalKey"])),
    );
    try {
      expectExit(result, { code: 0 });
    } finally {
      cleanup();
    }
  });

  add("② util 写错一个名字 ⇒ 红（并点名「静默失效」）", () => {
    const { result, cleanup } = runOn(
      tree(
        UTIL.replace("uq_agent_events_sessionId_seq", "uq_agent_events_session_seq"),
        MIG(["idx_agent_steps_sessionId_seq", "uq_agent_events_sessionId_seq", "UQ_agent_approvals_approvalKey"]),
      ),
    );
    try {
      expectExit(result, { code: 1, contains: ["静默失效"] });
    } finally {
      cleanup();
    }
  });

  add("③ 迁移里改了索引名（util 没跟）⇒ 红", () => {
    const { result, cleanup } = runOn(
      tree(
        UTIL,
        MIG(["idx_agent_steps_sessionId_seq", "uq_agent_events_sessionId_seq_V2", "UQ_agent_approvals_approvalKey"]),
      ),
    );
    try {
      expectExit(result, { code: 1 });
    } finally {
      cleanup();
    }
  });

  add("④ 两个键写成同一个名字 ⇒ 红（一条路径会误认另一条的冲突）", () => {
    const { result, cleanup } = runOn(
      tree(
        UTIL.replace('eventSeq: "uq_agent_events_sessionId_seq"', 'eventSeq: "idx_agent_steps_sessionId_seq"'),
        MIG(["idx_agent_steps_sessionId_seq", "uq_agent_events_sessionId_seq", "UQ_agent_approvals_approvalKey"]),
      ),
    );
    try {
      expectExit(result, { code: 1, contains: ["同名"] });
    } finally {
      cleanup();
    }
  });

  add("⑤ util 文件不存在 ⇒ 结构红（不是「零不一致」）", () => {
    const repo = makeFixtureRepo({ [`${MIGRATIONS_REL}/x.ts`]: MIG(["a"]) });
    try {
      const result = runGuard(SELF, { args: ["--root", repo.dir] });
      expectExit(result, { code: 1, contains: ["结构错"] });
    } finally {
      repo.cleanup();
    }
  });

  add("⑥ 迁移目录里没有 CREATE UNIQUE INDEX ⇒ 结构红（扫描面失效）", () => {
    const repo = makeFixtureRepo({ [UTIL_REL]: UTIL, [`${MIGRATIONS_REL}/x.ts`]: "export class M {}" });
    try {
      const result = runGuard(SELF, { args: ["--root", repo.dir] });
      expectExit(result, { code: 1, contains: ["扫描面失效"] });
    } finally {
      repo.cleanup();
    }
  });

  add("⑦ 【反证·注释里的 `}`】JSDoc 含 `@Column({...})` 时不得截断对象（否则末条静默漏检）", () => {
    const utilWithBraceInComment = `export const AGENT_UNIQUE_CONSTRAINTS = {
  stepSeq: "idx_agent_steps_sessionId_seq",
  eventSeq: "uq_agent_events_sessionId_seq",
  /** ⚠️ 实体上是 \`@Column({ unique: true })\`，名字以迁移为准。 */
  approvalKey: "UQ_agent_approvals_approvalKey",
} as const;
`;
    const { result, cleanup } = runOn(
      tree(
        utilWithBraceInComment,
        MIG(["idx_agent_steps_sessionId_seq", "uq_agent_events_sessionId_seq", "UQ_agent_approvals_approvalKey"]),
      ),
    );
    try {
      // 关键：必须报 **3** 条。若解析器被注释里的 `}` 截断，只会报 2 条 ⇒ 这条用例的意义
      // 就是把"漏检却报绿"钉死（2026-11-04 我第一版就是这么错的）。
      expectExit(result, { code: 0, contains: ["3 条路径"] });
    } finally {
      cleanup();
    }
  });

  add("⑧ 真实仓库 ⇒ 绿（控制组）", () => {
    expectExit(runGuard(SELF, { args: ["--root", REPO_ROOT] }), { code: 0 });
  });

  const failed = reportCases(cases, { title: "check-agent-index-names" });
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
