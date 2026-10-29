#!/usr/bin/env node
/**
 * ARCH-29：迁移时间戳分配表一致性校验（撞号拦截）。
 *
 * 规则：
 *  1. `apps/admin-api/src/migrations/*.ts`（排除 spec / d.ts）中每个文件名的时间戳必须全局唯一；
 *  2. 每个在盘时间戳必须在 `docs/PLAN-CLAIMS.md`「## 迁移时间戳分配表」注册（行内出现该时间戳）；
 *  3. 注册表里「预留段」允许尚未落盘（预留即占号），但在盘必须已注册；
 *  4. CONCURRENTLY 迁移必须显式豁免 `statement_timeout` 并复位（2026-10-29 审计 db-1）：
 *     连接池带 `statement_timeout=30s`，而 CONCURRENTLY 是单条语句——大表构建超时会被取消，
 *     并留下 `indisvalid=false` 的同名索引；重跑时 `IF NOT EXISTS` 命中它直接跳过，
 *     迁移记为已应用，索引**永远不会建起来**（0050 丢的是 tasks.name 唯一约束）。
 *     `SET LOCAL` 在 `transaction=false` 时无效，必须会话级 SET + finally RESET
 *     （连接归还池，污染后续查询）。
 *
 * ## T4（第 4 轮守卫自检审计）修掉的假绿
 *
 *   · **解析失败静默跳过**：`scanMigrations` 用 `^(\d{13})-` 抽时间戳，抽不到就 `filter(Boolean)`
 *     丢掉——一个手写成 14 位 / 12 位 / 带前缀的迁移文件**从此完全不被校验**：它既不进撞号
 *     检查，也不进「在盘必须已注册」检查。这是本仓最熟悉的形态（「没被扫到 = 没问题」）。
 *     现在无法解析文件名的 `.ts` 一律**结构红**。
 *   · **注册表命中只看子串**：旧 `parseRegistry` 用 `text.indexOf(heading)` 定位段首、并对段内
 *     任意行做 `| 13 位数字 |` 匹配。于是①文档里**顺口提到**标题（如变更日志里写
 *     「见 `## 迁移时间戳分配表`」）会把段首挪到文末；②围栏代码块里的示例行、HTML 注释
 *     （`<!-- | 178… | -->`）里的行**都算已注册**——一份被注释掉/只作示例的表格足以让闸放行。
 *     现在段首必须**行级**命中标题，围栏块与 HTML 注释先剥掉。
 *   · **扫描面下界只有「0 个文件」**：目录改名、过滤器写宽成「0 个迁移」时，
 *     「0 个 = 0 冲突」是永真断言。现在在盘迁移数与注册表行数各有下界，两者都为**结构红**。
 *   · **崩溃 ≠ 红灯**：目录/认领板读不到时旧实现是 `existsSync` 静默跳过后继续算
 *     （→「没问题的绿」或一句「认领板不存在」混在漂移里）。现在结构错误单独成形、单独文案。
 *   · `--root` + 导出 `check()`：模块级 `process.cwd()` 收成参数，`import` 时不实扫、不 `process.exit`。
 *   · `--selftest`：跑真脚本的子进程，13 条用例（原伴生 `check-migrations.selftest.mjs` 的
 *     全部用例已并入此处，判据逐条保留）逐条断言退出码 + 关键文本。
 *
 * 用法：`node scripts/check-migrations.mjs [--selftest] [--root <dir>]`
 *   --selftest：在临时 fixture 树里跑真脚本（需要仓库根布局：apps/admin-api/src/migrations + docs/PLAN-CLAIMS.md）。
 *   --root    ：只给 selftest 用：把 fixture 树当仓库根（默认 process.cwd()）。
 *
 * 退出码：0=通过，1=违规（CI 拦截）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

export const DEFAULT_MIGRATIONS_REL = "apps/admin-api/src/migrations";
export const DEFAULT_REGISTRY_REL = "docs/PLAN-CLAIMS.md";
export const REGISTRY_HEADING = "## 迁移时间戳分配表";

/**
 * 扫描面下界（2026-10-29 实测：在盘 100+ 个迁移、注册表 122 行）。只增不减。
 * 「0 个 = 0 冲突」是永真断言，所以只要塌到下界以下就判**结构红**，不是判绿。
 */
export const MIN_ON_DISK = 20;
export const MIN_REGISTRY_ROWS = 20;

const relOf = (root, abs) => relative(root, abs).split(sep).join("/");

/**
 * 扫在盘迁移（只看文件名，不读内容）。
 *
 * 无法解析出 13 位时间戳的 `.ts`（非 spec / 非 d.ts）会推进 `unparsed`——
 * 调用方必须把它当**结构错误**，否则该文件从此不受任何校验（见文件头）。
 *
 * @param {string} dir 迁移目录
 * @param {string[]} [unparsed] 收集「文件名无法解析」的说明
 * @returns {{timestamp: string, file: string}[]}
 */
export function scanMigrations(dir, unparsed = []) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts") && !f.endsWith(".d.ts"))
    .sort();
  const out = [];
  for (const f of files) {
    const m = /^(\d{13})-/.exec(basename(f));
    if (!m) {
      unparsed.push(
        `无法解析迁移文件名 ${basename(f)}（期望 \`<13 位毫秒时间戳>-<名字>.ts\`）—— 该文件不会进撞号/注册校验。`,
      );
      continue;
    }
    out.push({ timestamp: m[1], file: basename(f) });
  }
  return out;
}

/**
 * 剥掉围栏代码块与 HTML 注释。
 *
 * 目标只有一个：**示例/注释里的登记行不算登记**。旧实现把围栏块里的示例表格、
 * `<!-- | 178… | -->` 里被注释掉的行都算成「已注册」，于是一份被注释掉的注册行
 * 足以让「在盘未注册」这条判据放行。
 */
export function stripRegistryNoise(text) {
  const kept = [];
  let inFence = false;
  for (const line of String(text).split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) kept.push(line);
  }
  return kept.join("\n").replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * 解析认领板的「迁移时间戳分配表」段。
 *
 * 段首必须**整行**命中 `REGISTRY_HEADING`（标题行本身允许带后缀，
 * 例如「（ARCH-29 常设段）」）；正文里顺口提到标题不算段首。
 *
 * @param {string} text
 * @returns {{found: boolean, rows: {timestamp: string, line: string}[]}}
 */
export function parseRegistry(text) {
  const lines = stripRegistryNoise(text).split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith(REGISTRY_HEADING)) {
      start = i;
      break;
    }
  }
  if (start < 0) return { found: false, rows: [] };
  const rows = [];
  // 表行形如 | 1789500000000 | AddTaskTimeoutPolicy | CORE-04 | ... |
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("## ")) break; // 进入下一节
    const m = /^\s*\|\s*(\d{13})\s*\|/.exec(line);
    if (m) rows.push({ timestamp: m[1], line: line.trim() });
  }
  return { found: true, rows };
}

/**
 * 判据本体。返回 `{ errors, structure, onDiskCount, registryRows, nextSuggestion }`：
 *   · structure = 结构性（目录/认领板读不到、文件名解析失败、扫描面塌了）——「判据本身不可信」；
 *   · errors    = 全部（structure 在前 + 撞号/漏登/CONCURRENTLY 漂移），保持旧调用面的形状。
 */
export function check({ root = process.cwd(), migrationsDir, registryText } = {}) {
  const structure = [];
  const drift = [];

  const dir = migrationsDir ? resolve(String(migrationsDir)) : join(root, DEFAULT_MIGRATIONS_REL);
  const unparsed = [];
  const onDisk = scanMigrations(dir, unparsed);
  const onDiskLabel = migrationsDir ? String(migrationsDir) : relOf(root, dir) || DEFAULT_MIGRATIONS_REL;

  for (const u of unparsed) structure.push(u);
  if (!existsSync(dir)) {
    structure.push(`读不到迁移目录 ${onDiskLabel} —— 路径变了，扫描面为 0（不是「迁移都没了」）。`);
  } else if (onDisk.length === 0) {
    structure.push(`迁移目录无可用迁移文件：${onDiskLabel}`);
  } else if (onDisk.length < MIN_ON_DISK) {
    structure.push(
      `只扫到 ${onDisk.length} 个在盘迁移（下界 ${MIN_ON_DISK}）—— 目录改名或过滤器写宽了，不是迁移变少了。`,
    );
  }

  const seen = new Map();
  for (const { timestamp, file } of onDisk) {
    if (seen.has(timestamp)) {
      drift.push(`撞号：${timestamp} 同时被 ${seen.get(timestamp)} 与 ${file} 使用`);
    } else {
      seen.set(timestamp, file);
    }
  }

  // ── 认领板 ──────────────────────────────────────────────────────────────
  let registry = registryText;
  if (registry == null) {
    const abs = join(root, DEFAULT_REGISTRY_REL);
    if (existsSync(abs)) registry = readFileSync(abs, "utf8");
    else structure.push(`认领板不存在：${DEFAULT_REGISTRY_REL} —— 注册表判据无从核对。`);
  }

  let registryRows = 0;
  if (registry != null) {
    const { found, rows } = parseRegistry(registry);
    registryRows = rows.length;
    if (!found) {
      structure.push(
        `认领板缺少「${REGISTRY_HEADING}」常设段（整行标题）—— 段名/格式变了，注册判据已经瞎了。`,
      );
    } else {
      if (rows.length === 0) {
        structure.push(`「${REGISTRY_HEADING}」段里一行登记都没有 —— 解析器失效，不是「全都未注册」。`);
      } else if (rows.length < MIN_REGISTRY_ROWS) {
        structure.push(
          `只解析到 ${rows.length} 行登记（下界 ${MIN_REGISTRY_ROWS}）—— 表格格式变了，注册判据不可信。`,
        );
      }
      const registered = new Set();
      for (const r of rows) {
        if (registered.has(r.timestamp)) drift.push(`注册表内重复登记：${r.timestamp}`);
        registered.add(r.timestamp);
      }
      for (const { timestamp, file } of onDisk) {
        if (!registered.has(timestamp)) {
          drift.push(
            `在盘迁移未注册：${timestamp}（${file}）——请在 docs/PLAN-CLAIMS.md「${REGISTRY_HEADING}」补一行`,
          );
        }
      }
    }
  }

  // ── 判据 4：CONCURRENTLY 的语句级超时豁免（见文件头注）────────────────
  const concurrentlyRe = /\b(?:CREATE|DROP)\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i;
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const { file } of onDisk) {
    const src = readFileSync(join(dir, file), "utf8");
    const code = stripComments(src);
    if (!concurrentlyRe.test(code)) continue;
    if (!/SET\s+statement_timeout\s*=\s*0/i.test(code)) {
      drift.push(
        `${file}: 含 CONCURRENTLY 但未 SET statement_timeout = 0——连接池 30s 超时会取消建索引并留下 indisvalid=false 的同名索引，IF NOT EXISTS 永不修复`,
      );
    }
    if (!/RESET\s+statement_timeout/i.test(code)) {
      drift.push(`${file}: SET statement_timeout = 0 后未 RESET——连接会归还池，超时豁免会污染后续查询`);
    }
    if (!/transaction\s*=\s*false/.test(code)) {
      drift.push(`${file}: 含 CONCURRENTLY 但未声明 transaction = false——PostgreSQL 禁止在事务块内执行 CONCURRENTLY`);
    }
  }

  const maxOnDisk = onDisk.reduce((a, b) => (b.timestamp > a ? b.timestamp : a), "0");
  return {
    errors: [...structure, ...drift],
    structure,
    drift,
    onDiskCount: onDisk.length,
    registryRows,
    nextSuggestion: String(Number(maxOnDisk) + 1),
  };
}

// ── 自检（T4：全部跑真脚本子进程）─────────────────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

// fixture 事实源：24 个在盘迁移（过 MIN_ON_DISK=20）+ 24 行登记 + 1 行预留（未落盘）。
const BASE_STAMP = 1789500000000;
const STAMPS = Array.from({ length: 24 }, (_, i) => String(BASE_STAMP + i * 1000));
const LAST_STAMP = STAMPS[STAMPS.length - 1];
const RESERVED_STAMP = "1789800000000";
const MIG_REL = DEFAULT_MIGRATIONS_REL;
const REG_REL = DEFAULT_REGISTRY_REL;

function registryText({ rows = STAMPS, drop = [], extraRows = [], reserved = [RESERVED_STAMP] } = {}) {
  return [
    "# PLAN-CLAIMS",
    "",
    "## 变更日志（本节刻意放在分配表之前）",
    "",
    "之前的轮次记录。",
    "",
    "## 迁移时间戳分配表（ARCH-29 常设段）",
    "",
    "> 单一事实源：`apps/admin-api/src/migrations/` 的时间戳分配。",
    "",
    "| 时间戳 | 迁移 | 任务/归属 | 备注 |",
    "|---|---|---|---|",
    ...rows.filter((s) => !drop.includes(s)).map((s, i) => `| ${s} | M${i} | CORE | 已落盘 |`),
    ...reserved.map((s) => `| ${s} | 预留 | X | 预留未落盘（允许） |`),
    ...extraRows,
    "",
    "## 变更日志",
    "",
    "- 历史记录。",
    "",
  ].join("\n");
}

/** 一个合规的 CONCURRENTLY 迁移（SET + RESET + transaction=false）。 */
function concurrentlySql() {
  return [
    "export class AddIndex {",
    "  public async up(q) {",
    '    await q.query("SET statement_timeout = 0");',
    '    await q.query("CREATE UNIQUE INDEX CONCURRENTLY idx_a ON t (c)");',
    '    await q.query("RESET statement_timeout");',
    "  }",
    "}",
    "",
  ].join("\n");
}

function migTree({ files = {}, registry, dropRegistry = false, dropMigrations = [] } = {}) {
  const out = {};
  for (const s of STAMPS) out[`${MIG_REL}/${s}-M.ts`] = `export class M${s} {}\n`;
  Object.assign(out, files);
  for (const d of dropMigrations) delete out[d];
  if (!dropRegistry) out[REG_REL] = registry ?? registryText();
  return out;
}

const migPath = (stamp, name) => `${MIG_REL}/${stamp}-${name}.ts`;

/**
 * 自检：13 条用例，全部 `spawn` 真脚本（`--root` 指向 fixture 树）。
 *
 * ①–⑧ 是原伴生 `check-migrations.selftest.mjs` 的用例（撞号 / 注册表内重复 /
 * 在盘未注册 / 预留不报 / 缺段 / 去撞号补注册后通过 / nextSuggestion），判据保留；
 * ⑨–⑬ 是 T4 新增的结构红与「示例行/注释行不算登记」的反证。
 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "migrations-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
            ...expect,
            withinMs: 1000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  subprocess("① 干净树：24 个迁移唯一且全部已注册，预留行未落盘不报 → 绿", migTree(), {
    code: 0,
    contains: [
      `迁移注册校验通过：${STAMPS.length} 个迁移全部唯一且已注册`,
      // 预留 1789800000000 不计入「下一可用」：= 在盘最大 + 1
      `下一可用时间戳 ${Number(LAST_STAMP) + 1}`,
    ],
    absent: ["结构错误", "撞号", "未注册"],
  });

  subprocess(
    "② 撞号：同一时间戳两个文件 → 红并点名双方",
    migTree({ files: { [migPath(STAMPS[0], "Dup")]: "export class Dup {}\n" } }),
    {
      code: 1,
      contains: [`撞号：${STAMPS[0]} 同时被`, `${STAMPS[0]}-M.ts`, `${STAMPS[0]}-Dup.ts`],
      absent: ["迁移注册校验通过"],
    },
  );

  subprocess(
    "③ 注册表内重复登记（同一时间戳两行）→ 红",
    migTree({ registry: registryText({ extraRows: [`| ${STAMPS[0]} | M0-again | CORE | 重复登记 |`] }) }),
    { code: 1, contains: [`注册表内重复登记：${STAMPS[0]}`], absent: ["迁移注册校验通过"] },
  );

  subprocess(
    "④ 在盘迁移未注册（分配表少一行）→ 红并点名时间戳与文件",
    migTree({ registry: registryText({ drop: [STAMPS[7]] }) }),
    {
      code: 1,
      contains: [`在盘迁移未注册：${STAMPS[7]}（${STAMPS[7]}-M.ts）`, "补一行"],
      absent: ["迁移注册校验通过"],
    },
  );

  subprocess(
    "⑤ 预留段未落盘（多一行登记、无文件）→ 不报错",
    migTree({ registry: registryText({ reserved: [RESERVED_STAMP, "1789900000000"] }) }),
    { code: 0, contains: ["迁移注册校验通过", `下一可用时间戳 ${Number(LAST_STAMP) + 1}`], absent: ["未注册"] },
  );

  subprocess(
    "⑥ 认领板缺「## 迁移时间戳分配表」段 → 结构红",
    migTree({ registry: "# PLAN-CLAIMS\n\n## 变更日志\n\n- 没有分配表段。\n" }),
    { code: 1, contains: ["结构错误", `认领板缺少「${REGISTRY_HEADING}」常设段`], absent: ["迁移注册校验通过"] },
  );

  subprocess(
    "⑦ CONCURRENTLY 缺 SET statement_timeout = 0 → 红",
    migTree({
      files: {
        [migPath("1789530000000", "Index")]: concurrentlySql().replace('"SET statement_timeout = 0"', '"SELECT 1"'),
      },
      registry: registryText({ extraRows: ["| 1789530000000 | Index | X | 索引 |"] }),
    }),
    { code: 1, contains: ["未 SET statement_timeout = 0", "indisvalid=false"], absent: ["迁移注册校验通过"] },
  );

  subprocess(
    "⑧ CONCURRENTLY 有 SET 但缺 RESET → 红",
    migTree({
      files: { [migPath("1789530000000", "Index")]: concurrentlySql().replace('    await q.query("RESET statement_timeout");\n', "") },
      registry: registryText({ extraRows: ["| 1789530000000 | Index | X | 索引 |"] }),
    }),
    { code: 1, contains: ["未 RESET", "污染后续查询"], absent: ["迁移注册校验通过"] },
  );

  subprocess(
    "⑨ CONCURRENTLY 已有 SET+RESET 但缺 transaction = false → 红",
    migTree({
      files: { [migPath("1789530000000", "Index")]: concurrentlySql() },
      registry: registryText({ extraRows: ["| 1789530000000 | Index | X | 索引 |"] }),
    }),
    { code: 1, contains: ["未声明 transaction = false"], absent: ["迁移注册校验通过"] },
  );

  // 反向（防假红）：CONCURRENTLY 只出现在注释里 → 不该被要求豁免
  subprocess(
    "⑩ 【反证·注释算数】CONCURRENTLY 只在注释里 → 不算，绿",
    migTree({
      files: {
        [migPath("1789530000000", "Idx")]:
          "export class Idx {\n  // 历史：CREATE INDEX CONCURRENTLY idx_old ON t (c)\n  /* DROP INDEX CONCURRENTLY idx_x */\n}\n",
      },
      registry: registryText({ extraRows: ["| 1789530000000 | Idx | X | 归一 |"] }),
    }),
    { code: 0, contains: ["迁移注册校验通过"], absent: ["CONCURRENTLY"] },
  );

  // ⑪ 修掉的假绿：注册行被 HTML 注释掉（旧实现把注释里的行当已注册）
  subprocess(
    "⑪ 【反证·注释算数】注册行被 HTML 注释掉 → 仍算「在盘未注册」",
    migTree({
      registry: registryText().replace(
        `| ${STAMPS[3]} | M3 | CORE | 已落盘 |`,
        `<!-- | ${STAMPS[3]} | M3 | CORE | 已落盘 | -->`,
      ),
    }),
    { code: 1, contains: [`在盘迁移未注册：${STAMPS[3]}`], absent: ["迁移注册校验通过"] },
  );

  // ⑫ 修掉的假绿：围栏代码块里的示例表行不算登记
  subprocess(
    "⑫ 【反证·示例行】围栏代码块里的示例登记行不算注册",
    migTree({
      registry: registryText().replace(
        `| ${STAMPS[5]} | M5 | CORE | 已落盘 |`,
        ["```", `| ${STAMPS[5]} | M5 | CORE | 示例格式 |`, "```"].join("\n"),
      ),
    }),
    { code: 1, contains: [`在盘迁移未注册：${STAMPS[5]}`], absent: ["迁移注册校验通过"] },
  );

  // ⑬ 修掉的假绿：文件名不是 13 位时间戳 → 旧实现 filter(Boolean) 静默丢弃，从不受校验
  subprocess(
    "⑬ 【反证·解析失败】迁移文件名不是 13 位时间戳 → 结构红（旧实现静默跳过）",
    migTree({ files: { [`${MIG_REL}/2026-10-29-AddColumn.ts`]: "export class X {}\n" } }),
    {
      code: 1,
      contains: ["结构错误", "无法解析迁移文件名 2026-10-29-AddColumn.ts", "不会进撞号/注册校验"],
      absent: ["迁移注册校验通过"],
    },
  );

  subprocess(
    "⑭ 【反证·扫描面】只剩 3 个在盘迁移 → 结构红（不是「0 冲突」）",
    migTree({ dropMigrations: STAMPS.slice(3).map((s) => `${MIG_REL}/${s}-M.ts`) }),
    { code: 1, contains: ["结构错误", `只扫到 3 个在盘迁移（下界 ${MIN_ON_DISK}）`], absent: ["迁移注册校验通过"] },
  );

  subprocess("⑮ 事实源缺失（认领板被删）→ 结构红且点名路径", migTree({ dropRegistry: true }), {
    code: 1,
    contains: ["结构错误", `认领板不存在：${DEFAULT_REGISTRY_REL}`],
    absent: ["迁移注册校验通过", "Error:", "ENOENT"],
  });

  const failed = reportCases(cases, { title: "check-migrations selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    const root = resolve(argValue(process.argv, "--root") ?? process.cwd());
    const { errors, structure, onDiskCount, registryRows, nextSuggestion } = check({ root });

    if (structure.length) {
      console.error("");
      console.error("✖ 迁移注册守卫结构错误（判据本身不可信）：");
      for (const e of structure) console.error("  · " + e);
      console.error("");
      process.exit(1);
    }
    if (errors.length) {
      console.error(`✘ 迁移注册校验失败（${errors.length} 项）：`);
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    console.log(
      `✔ 迁移注册校验通过：${onDiskCount} 个迁移全部唯一且已注册（分配表 ${registryRows} 行）；下一可用时间戳 ${nextSuggestion}`,
    );
  }
}
