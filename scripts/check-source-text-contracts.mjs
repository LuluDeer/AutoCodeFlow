#!/usr/bin/env node
/**
 * 「源码文本契约」守卫 —— 治「**spec 用正则读实现源码文本**」这一**类**。
 *
 * ## 为什么这一类需要守卫（而不是任凭它长）
 *
 * 有些 spec 不 import 符号，而是 `readFileSync` 读**实现文件源码**再用正则/
 * `toMatch` 断言实现形态。这类约束让「搬常量 / 搬函数 / 改别名 / 拆文件」从
 * **零风险重构**变成**破坏测试**，而且**在类型系统里完全静默**：
 * tsc 绿、运行时也绿，只有恰好跑到那条 spec 才红。
 *
 * B0 拆分时实测撞到过一次（`protocol-version-consistency.spec.ts` 的
 * `readTsCap()` 用正则从 `executor.service.ts` 原件里抠
 * `MAX_RUNNING_EXECUTION_IDS = <n>`）——那条 spec 是**故意的**源码级契约闸，
 * 不能改，只能把常量留在原处。
 *
 * ## 判据（四条，全部 fail-closed）
 *
 *   ① **登记表自身有效**：每条必填 `id / tier / spec / specLine / needle /
 *      reads / asserts / disposition / owner / reviewBy`；`tier ∈ {P0,P1,P2}`；
 *      `disposition ∈ {fix-before-B4, fix-before-B5, defer, keep-and-accept, no-debt}`。
 *   ② **漂移即红**：`spec` 文件必须存在；`needle` 必须仍在 `specLine` 附近
 *      （±`NEEDLE_SEARCH_RADIUS` 行）。行号漂走后登记表就烂了，这条防它。
 *   ③ **过期即红**：`reviewBy` 早于今天 ⇒ 红（与 `check-dependency-review.mjs`
 *      的 `reviewBy` 语义同款：**到点必须有人重新签字**，不能永久挂着）。
 *   ④ **新增即红（棘轮）**：扫全仓 `*.spec.ts` / `*.test.ts`，凡是「读了实现源码
 *      形态」的 spec 必须已在登记表里；扫到未登记的 ⇒ 红。
 *      —— 这条是本守卫的主价值：**不许静默新增**一类会让重构变脆的断言。
 *
 * ## 新增一条怎么办
 *
 * 在 `scripts/source-text-contracts.json` 的 `entries` 里加一条，填 `specLine`
 * 与 `needle`（该行的一小段**唯一**文本），跑 `--report` 确认命中。加条目本身
 * 就是一次「我知道这里绑了实现」的显式签字。
 *
 * ## 用法
 *
 *   node scripts/check-source-text-contracts.mjs            # 判据（CI 用）
 *   node scripts/check-source-text-contracts.mjs --report   # 人读清单（按档位分组）
 *   node scripts/check-source-text-contracts.mjs --selftest # 17 条自检（不需要仓库状态）
 *
 * ## ⚠️ 未覆盖（已知边界，显式记录不静默）
 *
 * 只扫 `apps/**`、`packages/**` 下的 `*.spec.ts` / `*.test.ts`。
 * **不扫** `scripts/check-*.mjs` 类守卫脚本 —— 它们同样读源码文本，但属
 * guard-smith 的足迹，另行登记（见 `docs/` 台账）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const REGISTRY_PATH = join(HERE, "source-text-contracts.json");

/** 档位 → 允许的处置方式。 */
const TIERS = new Set(["P0", "P1", "P2"]);
const DISPOSITIONS = new Set([
  "fix-before-B4",
  "fix-before-B5",
  "defer",
  "keep-and-accept",
  "no-debt",
]);

/** `needle` 允许漂移的搜索半径（行）。行号小幅变动不报警，大改才红。 */
const NEEDLE_SEARCH_RADIUS = 20;

/** 扫描范围（相对仓库根）。 */
const SCAN_ROOTS = ["apps", "packages"];

/** 扫描时跳过的目录。 */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  "generated",
  "__pycache__",
  ".venv",
  "assets",
]);

// ───────────────────────────────────────────────────────────────────────────
// 工具
// ───────────────────────────────────────────────────────────────────────────

function toPosix(p) {
  return p.split("\\").join("/");
}

function daysBetween(fromISO, toISO) {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return Math.round((b - a) / 86_400_000);
}

function todayISO() {
  // 允许测试注入固定日期（自检用）
  return process.env.STC_TODAY ?? new Date().toISOString().slice(0, 10);
}

/** `spec` 字段是否含 glob（P2 类用 `migrations/__tests__/*.spec.ts` 形态）。 */
function isGlob(spec) {
  return spec.includes("*");
}

/** 极简 glob：只支持 `*`（匹配除 `/` 外任意字符）。 */
function globToRegExp(pattern) {
  const escaped = toPosix(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (
      (e.name.endsWith(".spec.ts") || e.name.endsWith(".test.ts")) &&
      !e.name.endsWith(".d.ts")
    ) {
      out.push(p);
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// 「读实现源码」的启发式判据
// ───────────────────────────────────────────────────────────────────────────

/**
 * 一行 `readFileSync(...)` 是否在**读实现源码**（而不是读 fixture / json / 输出产物）。
 *
 * 判据（满足任一即算「读实现源码」）：
 *   · 该行或其上 `LOOKBACK` 行内出现 `__dirname` 且出现 `.ts'` / `.ts"` / `.py'` / `.py"`
 *     （同目录源码文件的典型写法）；
 *   · 出现 `SRC_ROOT` / `SRC_DIR` / `src` 路径拼接；
 *   · 变量名以 `_TS` / `_PY` / `SRC` 结尾且该行出现 `.ts`/`.py` 字面量；
 *   · 出现 `MIGRATION` 且出现 `.ts`/`.sql`（迁移 spec 的典型写法）。
 *
 * **刻意读 JSON / .log / 输出目录的**不算（那是「读数据」不是「读实现」）。
 */
const LOOKBACK = 6;

export function looksLikeImplementationRead(lines, idx) {
  const window = lines
    .slice(Math.max(0, idx - LOOKBACK), idx + 1)
    .join("\n");
  // 明确排除：读 json / 日志 / 产出目录
  if (/readFileSync\([^)]*\.json/i.test(lines[idx] ?? "")) return false;
  const implLiteral = /\.(ts|py)['"]/.test(window);
  const hasMigration = /MIGRATION|\.sql['"]/.test(window);
  const hasSrcRoot = /SRC_ROOT|SRC_DIR|SRC_FILES|SERVICE_SRC|PY_EXECUTE_PATH/.test(
    window,
  );
  const hasDirname = /__dirname/.test(window);
  if (hasMigration && /\.sql['"]|\.ts['"]/.test(window)) return true;
  if (implLiteral && (hasDirname || hasSrcRoot)) return true;
  // 变量名本身就是源码路径（const SRC = readFileSync(p, "utf8") 之类的间接读）
  if (/const\s+SRC\s*=/.test(window) && /readFileSync/.test(window)) return true;
  return false;
}

/** 扫出「读了实现源码」的 spec 清单（相对仓库根，去重）。 */
export function discoverSourceTextReaders(repoRoot = REPO_ROOT) {
  const found = new Set();
  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(repoRoot, root))) {
      let text;
      try {
        text = readFileSync(file, "utf-8");
      } catch {
        continue;
      }
      if (!text.includes("readFileSync") && !text.includes("readFile(")) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line.includes("readFileSync") && !line.includes("readFile(")) {
          continue;
        }
        if (looksLikeImplementationRead(lines, i)) {
          found.add(toPosix(relative(repoRoot, file)));
          break; // 同一 spec 命中一次即可
        }
      }
    }
  }
  return [...found].sort();
}

// ───────────────────────────────────────────────────────────────────────────
// 判据
// ───────────────────────────────────────────────────────────────────────────

export function check({
  repoRoot = REPO_ROOT,
  registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")),
  today = todayISO(),
} = {}) {
  const failures = [];
  const notes = [];
  const entries = Array.isArray(registry.entries) ? registry.entries : [];

  if (entries.length === 0) {
    failures.push("登记表 entries 为空 —— 空登记表等于守卫被关灯");
  }

  // ── ① 结构与档位 ──
  const seenIds = new Set();
  for (const [i, e] of entries.entries()) {
    const tag = e?.id ?? `entries[${i}]`;
    for (const k of [
      "id",
      "tier",
      "spec",
      "specLine",
      "needle",
      "reads",
      "asserts",
      "disposition",
      "owner",
      "reviewBy",
    ]) {
      if (e?.[k] === undefined || e?.[k] === null || e?.[k] === "") {
        failures.push(`${tag} 缺必填字段 ${k}`);
      }
    }
    if (seenIds.has(e?.id)) failures.push(`${tag} id 重复`);
    seenIds.add(e?.id);
    if (e?.tier !== undefined && !TIERS.has(e.tier)) {
      failures.push(`${tag} tier=${e.tier} 不在 {P0,P1,P2} 内`);
    }
    if (e?.disposition !== undefined && !DISPOSITIONS.has(e.disposition)) {
      failures.push(
        `${tag} disposition=${e.disposition} 不在允许集合内（${[...DISPOSITIONS].join("/")}）`,
      );
    }
    // P0 + defer 允许（Lead 的档位表里 sop/audit 就是「P0 但本轮暂缓」），
    // 但必须写清「什么时候必须修」，否则 defer 就成了无限期豁免。
    if (
      e?.tier === "P0" &&
      e?.disposition === "defer" &&
      !String(e?.dispositionNote ?? "").trim()
    ) {
      failures.push(
        `${tag} 是 P0 却处置为 defer 且没写 dispositionNote —— P0+defer 必须说明「何时必须修」，否则 defer 是无限期豁免`,
      );
    }
    if (!Array.isArray(e?.reads) || (Array.isArray(e?.reads) && e.reads.length === 0)) {
      failures.push(`${tag} reads 必须是非空数组`);
    }
    if (
      e?.disposition === "keep-and-accept" &&
      !String(e?.dispositionNote ?? "").trim()
    ) {
      failures.push(`${tag} disposition=keep-and-accept 必须写 dispositionNote（说明为何接受）`);
    }
  }

  // ── ② 漂移：spec 文件存在 + needle 仍在附近 ──
  for (const e of entries) {
    if (isGlob(e.spec)) continue; // glob 条目在 ④ 里按覆盖关系校验
    const abs = join(repoRoot, e.spec);
    if (!existsSync(abs)) {
      failures.push(`${e.id} 登记的 spec 不存在：${e.spec}`);
      continue;
    }
    const lines = readFileSync(abs, "utf-8").split("\n");
    const center = Number(e.specLine);
    if (!Number.isInteger(center) || center < 1) {
      failures.push(`${e.id} specLine 不是正整数：${e.specLine}`);
      continue;
    }
    const lo = Math.max(0, center - 1 - NEEDLE_SEARCH_RADIUS);
    const hi = Math.min(lines.length, center - 1 + NEEDLE_SEARCH_RADIUS + 1);
    const window = lines.slice(lo, hi).join("\n");
    if (!window.includes(e.needle)) {
      failures.push(
        `${e.id} needle 在 ${e.spec}:${center} ±${NEEDLE_SEARCH_RADIUS} 行内找不到 —— ` +
          `spec 已漂走，请更新 specLine/needle（原文：${e.needle}）`,
      );
    }
  }

  // ── ③ 过期 ──
  for (const e of entries) {
    // d = reviewBy - today（正数 = 尚未到期）。⚠️ 方向别搞反：
    // 曾经写成 daysBetween(reviewBy, today)，于是「未来到期」被误报成「已到期」。
    const d = daysBetween(today, String(e.reviewBy));
    if (Number.isNaN(d)) {
      failures.push(`${e.id} reviewBy 不是合法 YYYY-MM-DD：${e.reviewBy}`);
      continue;
    }
    if (d < 0) {
      failures.push(
        `${e.id} reviewBy=${e.reviewBy} 已到期 ${-d} 天 —— ` +
          `要么处置掉（改 spec），要么重新签字（更新 reviewBy）`,
      );
    } else if (d <= 30) {
      notes.push(`${e.id} 距复查 ${e.reviewBy} 还有 ${d} 天`);
    }
  }

  // ── ④ 新增即红：未登记的「读实现源码」spec ──
  const exact = new Set(
    entries.filter((e) => !isGlob(e.spec)).map((e) => toPosix(e.spec)),
  );
  const globs = entries.filter((e) => isGlob(e.spec)).map((e) => globToRegExp(e.spec));
  // coverageBacklog：机器扫描发现但**尚未逐条甄别**的已知项。登记它们不是豁免，
  // 而是「把棘轮的起始线划在真实分布上」——新出现的未登记项仍然红，且 backlog
  // 自身也会按 reviewBy 到期（到期未甄别即红）。
  const backlog = Array.isArray(registry.coverageBacklog)
    ? registry.coverageBacklog
    : [];
  const backlogSpecs = new Set(backlog.map((b) => toPosix(b.spec)));
  for (const b of backlog) {
    if (!b?.owner || !b?.reviewBy) {
      failures.push(`coverageBacklog ${b?.spec ?? "?"} 缺 owner/reviewBy`);
      continue;
    }
    const bd = daysBetween(today, String(b.reviewBy));
    if (Number.isNaN(bd)) {
      failures.push(`coverageBacklog ${b.spec} 的 reviewBy 非法：${b.reviewBy}`);
    } else if (bd < 0) {
      failures.push(
        `coverageBacklog ${b.spec} 的 reviewBy=${b.reviewBy} 已到期 ${-bd} 天 —— ` +
          `必须逐条甄别并归入 entries（或判定非源文本契约后移出）`,
      );
    }
  }
  const discovered = discoverSourceTextReaders(repoRoot);
  const unregistered = discovered.filter(
    (f) => !exact.has(f) && !globs.some((re) => re.test(f)) && !backlogSpecs.has(f),
  );
  for (const f of unregistered) {
    failures.push(
      `${f} 读了实现源码文本但**未登记** —— 在 scripts/source-text-contracts.json 里加一条` +
        `（含 specLine + needle + 档位 + 处置）；这条断言会让重构静默变脆，必须显式签字`,
    );
  }

  return {
    failures,
    notes,
    entries,
    discovered,
    unregistered,
    stats: {
      total: entries.length,
      p0: entries.filter((e) => e.tier === "P0").length,
      p1: entries.filter((e) => e.tier === "P1").length,
      p2: entries.filter((e) => e.tier === "P2").length,
      discovered: discovered.length,
      backlog: backlog.length,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 输出
// ───────────────────────────────────────────────────────────────────────────

function printReport(registry, result) {
  const { stats, notes } = result;
  console.log("\n源码文本契约登记表（scripts/source-text-contracts.json）");
  console.log(`  owner=${registry.owner}  reviewBy=${registry.reviewBy}`);
  console.log(
    `  共 ${stats.total} 条：P0=${stats.p0} / P1=${stats.p1} / P2=${stats.p2}` +
      `  ｜ 扫描发现 ${stats.discovered} 个读实现源码的 spec（其中 ${stats.backlog} 条待甄别）`,
  );
  for (const tier of ["P0", "P1", "P2"]) {
    const group = result.entries.filter((e) => e.tier === tier);
    if (group.length === 0) continue;
    console.log(`\n── ${tier}（${group.length}）──`);
    for (const e of group) {
      console.log(`  ${e.id}  ${e.spec}:${e.specLine}`);
      console.log(`        reads   : ${(e.reads ?? []).join(", ")}`);
      console.log(`        断言     : ${String(e.asserts ?? "").slice(0, 96)}`);
      console.log(`        处置     : ${e.disposition}  reviewBy=${e.reviewBy}`);
    }
  }
  if (notes.length > 0) {
    console.log("\n近期到期提醒：");
    for (const n of notes) console.log(`  · ${n}`);
  }
  console.log("");
}

function selftest() {
  const results = [];
  const ok = (name, fn) => {
    try {
      fn();
      results.push([true, name]);
    } catch (err) {
      results.push([false, `${name} —— ${err.message}`]);
    }
  };
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  const base = (over = {}) => ({
    id: "T-1",
    tier: "P0",
    spec: "apps/admin-api/src/modules/executor/__tests__/protocol-version-consistency.spec.ts",
    specLine: 59,
    needle: 'readFileSync(path.join(repoRoot, relative), "utf-8")',
    reads: ["apps/admin-api/src/modules/executor/executor.service.ts"],
    asserts: "x",
    disposition: "keep-and-accept",
    dispositionNote: "理由",
    owner: "arch-core",
    reviewBy: "2999-01-01",
    ...over,
  });
  const runCheck = (entries, extra = {}) =>
    check({
      registry: { owner: "arch-core", reviewBy: "2999-01-01", entries },
      today: "2026-11-04",
      ...extra,
    });
  const realEntries = JSON.parse(
    readFileSync(REGISTRY_PATH, "utf-8"),
  ).entries;

  ok("① 真实登记表通过（含漂移/覆盖/backlog 判据）", () => {
    const r = check({ today: "2026-11-04" });
    assert(
      r.failures.length === 0,
      `期望 0 失败，实得 ${r.failures.length}：${r.failures.slice(0, 3).join(" ｜ ")}`,
    );
  });

  ok("② 空 entries ⇒ 红", () => {
    assert(runCheck([]).failures.some((f) => f.includes("空登记表")), "应报空登记表");
  });

  ok("③ 缺必填字段 ⇒ 红", () => {
    const r = runCheck([{ ...base(), asserts: "" }]);
    assert(r.failures.some((f) => f.includes("缺必填字段 asserts")), "应报缺字段");
  });

  ok("④ 非法 tier ⇒ 红", () => {
    assert(
      runCheck([base({ tier: "P9" })]).failures.some((f) => f.includes("tier=P9")),
      "应报非法 tier",
    );
  });

  ok("⑤ 非法 disposition ⇒ 红", () => {
    assert(
      runCheck([base({ disposition: "whatever" })]).failures.some((f) =>
        f.includes("disposition=whatever"),
      ),
      "应报非法 disposition",
    );
  });

  ok("⑥ P0 + defer 且无说明 ⇒ 红（defer 不是无限期豁免）", () => {
    assert(
      runCheck([base({ disposition: "defer", dispositionNote: "" })]).failures.some(
        (f) => f.includes("P0+defer 必须说明"),
      ),
      "应报 P0+defer 缺说明",
    );
  });

  ok("⑦ keep-and-accept 缺理由 ⇒ 红", () => {
    assert(
      runCheck([base({ dispositionNote: "" })]).failures.some((f) =>
        f.includes("必须写 dispositionNote"),
      ),
      "应报缺理由",
    );
  });

  ok("⑧ spec 文件不存在 ⇒ 红", () => {
    assert(
      runCheck([base({ spec: "apps/nope/none.spec.ts" })]).failures.some((f) =>
        f.includes("登记的 spec 不存在"),
      ),
      "应报 spec 不存在",
    );
  });

  ok("⑨ needle 漂走 ⇒ 红", () => {
    assert(
      runCheck([base({ needle: "THIS_NEEDLE_DOES_NOT_EXIST" })]).failures.some(
        (f) => f.includes("needle 在"),
      ),
      "应报 needle 漂移",
    );
  });

  ok("⑩ reviewBy 已过期 ⇒ 红", () => {
    assert(
      runCheck([base({ reviewBy: "2020-01-01" })]).failures.some((f) =>
        f.includes("已到期"),
      ),
      "应报过期",
    );
  });

  ok("⑪ reviewBy 非法日期 ⇒ 红", () => {
    assert(
      runCheck([base({ reviewBy: "not-a-date" })]).failures.some((f) =>
        f.includes("不是合法 YYYY-MM-DD"),
      ),
      "应报非法日期",
    );
  });

  ok("⑫ id 重复 ⇒ 红", () => {
    assert(
      runCheck([base(), base()]).failures.some((f) => f.includes("id 重复")),
      "应报 id 重复",
    );
  });

  ok("⑬ reads 为空数组 ⇒ 红", () => {
    assert(
      runCheck([base({ reads: [] })]).failures.some((f) =>
        f.includes("reads 必须是非空数组"),
      ),
      "应报 reads 为空",
    );
  });

  ok("⑭ 未登记的读源码 spec ⇒ 红（棘轮）", () => {
    // 用真实登记表但把 entries 换成只留一条无关条目 ⇒ 其余应全部报未登记
    const r = runCheck([base()], {});
    assert(
      r.failures.some((f) => f.includes("未登记")),
      "应报未登记的读源码 spec",
    );
  });

  ok("⑮ glob 条目能覆盖迁移 spec（不被误报未登记）", () => {
    const r = check({ today: "2026-11-04" });
    const mig = r.entries.find((e) => e.tier === "P2");
    assert(mig !== undefined, "登记表应有 P2 迁移类条目");
    assert(
      !r.unregistered.some((f) => f.includes("/migrations/")),
      `迁移 spec 不应被报未登记：${r.unregistered.filter((f) => f.includes("migrations")).slice(0, 2)}`,
    );
  });

  ok("⑯ 启发式：读 json 不算读实现源码", () => {
    const lines = ['const x = readFileSync(path.join(__dirname, "openapi.json"), "utf-8");'];
    assert(looksLikeImplementationRead(lines, 0) === false, "读 json 不应算实现源码");
  });

  ok("⑰ 启发式：__dirname + .ts 字面量算读实现源码", () => {
    const lines = ['const src = readFileSync(path.join(__dirname, "auth.ts"), "utf-8");'];
    assert(looksLikeImplementationRead(lines, 0) === true, "读 auth.ts 应算实现源码");
  });

  ok("⑱ coverageBacklog 到期 ⇒ 红（backlog 不是永久豁免）", () => {
    const reg = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
    const withExpired = {
      ...reg,
      coverageBacklog: [
        { spec: "x.spec.ts", owner: "arch-core", reviewBy: "2020-01-01" },
      ],
    };
    const r = check({ registry: withExpired, today: "2026-11-04" });
    assert(
      r.failures.some((f) => f.includes("coverageBacklog") && f.includes("已到期")),
      "应报 backlog 到期",
    );
  });

  ok("⑲ coverageBacklog 缺 owner/reviewBy ⇒ 红", () => {
    const reg = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
    const r = check({
      registry: { ...reg, coverageBacklog: [{ spec: "x.spec.ts" }] },
      today: "2026-11-04",
    });
    assert(
      r.failures.some((f) => f.includes("缺 owner/reviewBy")),
      "应报 backlog 缺字段",
    );
  });

  const failed = results.filter(([p]) => !p);
  for (const [pass, name] of results) console.log(`${pass ? "✓" : "✗"} ${name}`);
  console.log(`\n自检：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    console.error(`\n自检失败 ${failed.length} 条`);
    process.exit(1);
  }
  // 让 linter 看到真实登记表被读过（避免 "declared but never used" 风格告警）
  if (realEntries.length === 0) process.exit(1);
}

// ───────────────────────────────────────────────────────────────────────────

// 只在「被直接执行」时跑主流程（被 import 时只导出纯函数，供自检/其他脚本复用）
const IS_MAIN =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const argv = process.argv.slice(2);
if (!IS_MAIN) {
  // imported as a module — 不执行任何副作用
} else if (argv.includes("--selftest")) {
  selftest();
} else {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
  const result = check({ registry });
  if (argv.includes("--report")) printReport(registry, result);
  if (result.notes.length > 0 && !argv.includes("--report")) {
    for (const n of result.notes) console.log(`notice: ${n}`);
  }
  if (result.failures.length > 0) {
    console.error(`\n源码文本契约守卫失败（${result.failures.length} 项）：`);
    for (const f of result.failures) console.error(`  · ${f}`);
    process.exit(1);
  }
  console.log(
    `源码文本契约：${result.stats.total} 条已登记（P0=${result.stats.p0} / P1=${result.stats.p1} / P2=${result.stats.p2}），` +
      `扫描发现 ${result.stats.discovered} 个读实现源码的 spec，全部已登记 ✓`,
  );
}
