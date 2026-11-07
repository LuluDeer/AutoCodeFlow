#!/usr/bin/env node
/**
 * 三端 SSRF **判定**矩阵守卫（R10，2026-11-05）。
 *
 * ## 与旧守卫（`check-ssrf-deny-parity.mjs`）的关系
 *
 * | | 旧守卫（`check:ssrf-parity`） | 本守卫（本文件） |
 *---|---|---|
 * | 比什么 | **地址清单**是否镜像（漏项） | **同地址的判定**是否一致（漂移） |
 * | 输入源 | 三端各自的 `DANGER_ADDRESSES` 测试清单 | **契约 `networkPolicy`**（`addresses.*.examples` + `metadataAddresses`）—— 单一事实源 |
 * | 能否抓到「三端都列了、但判定不同」 | **不能**（它只看清单里有没有这个地址） | **能**（真跑三端实现比标签） |
 *
 * 二者**并存**（不替换）：旧守卫抓"漏"，本守卫抓"判得不一样"。
 *
 * ## 为什么必须真跑实现
 *
 * 清单比对看不见**判定**。R09 就在这上面栽过：三端清单里都有 `192.0.0.192`，
 * 但三端分别判 `public` / `null` / `None` ⇒ 旧守卫**全绿**，而这个地址四姿态全放行。
 * 本守卫用 `scripts/ssrf-category-matrix.mjs` 的探针**真跑**三端实现（admin/node 用
 * 各自 `node_modules` 的 `ts-node/register` 跑真 TS；python 用裸 `python3` 跑真实现），
 * 再逐地址比标签。
 *
 * ## 标签归一
 *
 * 三端的标签命名不同（admin `private-lan`/`link-local` vs node/python `privateIPv4`/`linkLocal`），
 * 且**分类粒度**也不同（admin 把 `0.0.0.0/8` 归 `reserved`、把 multicast 归 `reserved`；
 * node/python 分成 `unspecified`/`multicast`）。守卫比的是**归一后的标签**，
 * 归一表见 `ssrf-category-matrix.mjs` 的 `CATEGORY_ALIASES`。
 *
 * ## 反向豁免（默认应为空）
 *
 * 确有语言/实现差异时（例如某地址在 python 侧因 `ipaddress` 语义不同而合法不同），
 * 登记在 `scripts/ssrf-category-parity-exemptions.json`：
 * `{ "addr": "...", "sides": ["python"], "why": "≥20 字理由", "review_by": "YYYY-MM-DD" }`。
 * 三条纪律：**why 必须写清"为什么这个差异是合理的"**；**review_by 过期即红**；**默认表为空**
 * （空表 ⇒ 零豁免 ⇒ 任何差异都必须现场修）。
 *
 * 用法：`node scripts/check-ssrf-three-way-matrix.mjs [--selftest] [--root <dir>]`
 */
import { existsSync, readFileSync } from "node:fs";
import path, { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";
import { collectMatrix, decisionFor, ROOT } from "./ssrf-category-matrix.mjs";

printCoverageBanner(import.meta.url, "push");

export const SIDES = ["admin", "node", "python"];
export const EXEMPTIONS_REL = "scripts/ssrf-category-parity-exemptions.json";

/** 矩阵条目数下界（实测：契约 `networkPolicy` 的 examples + metadataAddresses = 27）。 */
export const MIN_MATRIX_ENTRIES = 20;

/**
 * 读反向豁免表；**结构问题即红**（豁免表自己有洞时不能拿来豁免别人）。
 *
 * 返回 `{ entries, errors }`。
 */
export function readExemptions(root) {
  const errors = [];
  const abs = join(root, EXEMPTIONS_REL);
  if (!existsSync(abs)) {
    // 表**不存在** = 零豁免（默认应为空），不是错。
    return { entries: [], errors };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    return { entries: [], errors: [`${EXEMPTIONS_REL} 不可解析：${err.message}`] };
  }
  const entries = Array.isArray(raw?.entries) ? raw.entries : null;
  if (!entries) {
    return { entries: [], errors: [`${EXEMPTIONS_REL} 缺 entries 数组`] };
  }
  const seen = new Set();
  for (const [i, e] of entries.entries()) {
    const tag = `entries[${i}]`;
    if (typeof e?.addr !== "string" || !e.addr.trim()) errors.push(`${tag} 缺 addr`);
    if (!Array.isArray(e?.sides) || e.sides.length === 0) errors.push(`${tag} 缺 sides（非空数组）`);
    else {
      for (const s of e.sides) {
        if (!SIDES.includes(s)) errors.push(`${tag} 的 side "${s}" 不在 ${SIDES.join("/")} 里`);
      }
    }
    if (typeof e?.why !== "string" || e.why.trim().length < 20) {
      errors.push(`${tag} 的 why 太短（必须写清"为什么这个差异是合理的"，≥20 字）`);
    }
    if (typeof e?.review_by !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.review_by)) {
      errors.push(`${tag} 的 review_by 不是 YYYY-MM-DD`);
    }
    const key = `${e?.addr}|${(e?.sides ?? []).join(",")}`;
    if (seen.has(key)) errors.push(`${tag} 与前面某条重复登记`);
    seen.add(key);
  }
  return { entries, errors };
}

/**
 * 纯判定：比对三端矩阵。
 *
 * @returns {{errors: string[], diffs: object[], exempted: object[], entries: number}}
 */
export function checkMatrix({ root, today = "2026-11-05" }) {
  const errors = [];
  const { entries: exemptions, errors: exErrors } = readExemptions(root);
  errors.push(...exErrors);

  let matrix;
  let addresses;
  try {
    ({ addresses, matrix } = collectMatrix({ root }));
  } catch (err) {
    errors.push(`三端矩阵采集失败（探针跑不起来）：${err.message}`);
    return { errors, diffs: [], exempted: [], labelDiffs: [], entries: 0 };
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    errors.push("契约 networkPolicy 里解析出 0 个矩阵地址 —— 契约被清空了（此时「零差异」是永真断言）");
    return { errors, diffs: [], exempted: [], labelDiffs: [], entries: 0 };
  }
  if (addresses.length < MIN_MATRIX_ENTRIES) {
    errors.push(
      `矩阵只解析到 ${addresses.length} 个地址（下界 ${MIN_MATRIX_ENTRIES}）—— ` +
        "契约 networkPolicy 的 examples/metadataAddresses 被清空或被注释掉了。",
    );
  }

  const bySide = {};
  for (const side of SIDES) {
    const rows = matrix[side] ?? [];
    if (rows.length === 0) {
      errors.push(`${side} 侧矩阵为空 —— 该端探针没跑出结果（不是「零差异」）`);
    }
    bySide[side] = new Map(rows.map((r) => [r.addr, r.category]));
  }

  const diffs = [];
  const exempted = [];
  const labelDiffs = [];
  for (const addr of addresses) {
    const values = {};
    for (const side of SIDES) values[side] = bySide[side].get(addr) ?? "(缺)";
    const distinct = new Set(Object.values(values));
    if (distinct.size <= 1) continue;
    // **决策轴**优先：标签不同但**行为相同**（admin 把 unspecified/multicast 并进
    // reserved）⇒ 只算「标签差异」，不算行为漂移；行为不同（allow vs deny）才是真缺陷。
    const decisions = {};
    for (const side of SIDES) decisions[side] = decisionFor(values[side]);
    const decisionSet = new Set(Object.values(decisions));
    if (decisionSet.size === 1) {
      labelDiffs.push({ addr, values });
      continue;
    }
    const hit = exemptions.find(
      (e) => e.addr === addr && Array.isArray(e.sides) && e.sides.length > 0,
    );
    if (hit) {
      // 豁免只覆盖它登记的 side：未被登记的 side 之间的差异仍然红。
      const covered = SIDES.filter((s) => hit.sides.includes(s));
      const uncovered = SIDES.filter((s) => !hit.sides.includes(s));
      if (uncovered.length > 0) {
        const sub = {};
        for (const s of uncovered) sub[s] = decisions[s];
        if (new Set(Object.values(sub)).size > 1) {
          diffs.push({ addr, values, detail: `豁免只覆盖 ${covered.join("/")}，但 ${uncovered.join("/")} 彼此不同` });
          continue;
        }
      }
      if (hit.review_by && hit.review_by < today) {
        diffs.push({
          addr,
          values,
          detail: `豁免已过期（review_by=${hit.review_by} < ${today}）—— 到期即红，先复核再续期`,
        });
        continue;
      }
      exempted.push({ addr, values, why: hit.why, sides: hit.sides });
      continue;
    }
    diffs.push({ addr, values, detail: "未登记豁免" });
  }

  return { errors, diffs, exempted, labelDiffs, entries: addresses.length };
}

/** 取 `--root <dir>` / `--root=<dir>` 两种形态（与旧守卫 `argValue` 同款）。 */
function rootArg(argv) {
  const eq = argv.find((a) => a.startsWith("--root="));
  if (eq) return eq.slice("--root=".length);
  const at = argv.indexOf("--root");
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  const root = resolve(rootArg(argv) ?? process.cwd());
  const { errors, diffs, exempted, labelDiffs, entries } = checkMatrix({ root });

  if (errors.length > 0) {
    console.error("");
    console.error("✖ 三端 SSRF 判定矩阵守卫结构错误（判据本身不可信）：");
    for (const e of errors) console.error("  · " + e);
    console.error("");
    process.exit(1);
  }
  if (diffs.length > 0) {
    console.error("");
    console.error(`✖ 三端 SSRF 判定矩阵未对齐：${diffs.length} 个地址的判定不一致`);
    for (const d of diffs) {
      const vals = SIDES.map((s) => `${s}=${d.values[s]}`).join(" / ");
      console.error(`  · ${d.addr}：${vals}（${d.detail}）`);
    }
    console.error("");
    console.error("  修法：改**判定不一致的那一端**（三端都必须与契约 networkPolicy 一致）；");
    console.error("        确有语言/实现差异时登记到 " + EXEMPTIONS_REL + "（why + review_by 必填）。");
    console.error("  **不要**改守卫放行，也不要改契约来迁就实现。");
    console.error("");
    process.exit(1);
  }
  const labelNote =
    labelDiffs.length > 0
      ? `；${labelDiffs.length} 条**标签不同但行为相同**（admin 的标签体系更粗，如 unspecified/multicast 并入 reserved）`
      : "";
  console.log(
    `✔ 三端 SSRF 判定矩阵一致：契约 networkPolicy 的 ${entries} 个 IP 字面量，` +
      `admin / node / python 的**决策**（放行/开关放行/恒拒）逐条相同` +
      (exempted.length > 0 ? `（${exempted.length} 条已登记豁免）` : "（零豁免）") +
      labelNote + "。",
  );
}

// ── 自检（真子进程 + 退出码 + 报错文本 + 有本事失败）────────────────────────
const SELF = fileURLToPath(import.meta.url);

function runSelftest() {
  const cases = [];
  const push = (name, fn) => cases.push({ name, fn });

  push("自检：真仓库上三端判定一致 ⇒ exit 0（正例控制组）", () => {
    expectExit(runGuard(SELF, { args: [], cwd: ROOT }), {
      code: 0,
      withinMs: 120000,
      label: "正例",
    });
  });

  push("自检：豁免表结构坏（why 太短）⇒ exit 1 且点名 why", () => {
    const repo = makeFixtureRepo({
      [EXEMPTIONS_REL]: JSON.stringify({
        entries: [{ addr: "1.2.3.4", sides: ["python"], why: "短", review_by: "2026-12-01" }],
      }),
    });
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1,
        contains: ["why 太短"],
        withinMs: 120000,
        label: "豁免结构",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("自检：豁免表缺 review_by ⇒ exit 1 且点名", () => {
    const repo = makeFixtureRepo({
      [EXEMPTIONS_REL]: JSON.stringify({
        entries: [{ addr: "1.2.3.4", sides: ["python"], why: "这是一条足够长的理由说明为什么差异是合理的" }],
      }),
    });
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1,
        contains: ["review_by"],
        withinMs: 120000,
        label: "豁免期限",
      });
    } finally {
      repo.cleanup();
    }
  });

  const failed = reportCases(cases, { title: "check-ssrf-three-way-matrix selftest" });
  process.exit(failed === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--selftest")) runSelftest();
  else main();
}
