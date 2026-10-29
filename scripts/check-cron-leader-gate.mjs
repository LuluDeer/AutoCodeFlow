#!/usr/bin/env node
/**
 * 守卫：**每个 `@Cron` 都必须有 leader 门禁**。
 *
 * 由来：本仓踩过「同一修法只落一半」的一整族缺陷（markOffline vs setOfflineById、heartbeat vs register、
 * publish vs draft……）。`@Cron` 是下一个高风险面：多副本部署下，**忘了门禁 = N 个实例各跑一遍**，
 * 表现为重复扫描、重复置态、N 倍 LLM 配额消耗 —— 而它**只在多副本时才显形**，单机开发永远看不到。
 *
 * 25 个 `@Cron` 目前全都有门禁，但表达方式有**三种写法**：
 *   - `this.leaderGate.isLeader` / `this.leaderGate?.isLeader`（直接注入）
 *   - `this.isLeader`（scheduler 的 getter）
 *   - `this.isLeader()` / `this.isSchedulerLeader()`（包装方法）
 * 所以判据必须是**这三种 idiom 的并集**，且按「方法体」而不是「紧跟的几行」判 ——
 * 首版用 25 行窗口 + 只认 `leaderGate` 字面量，**假报了 7 处**（全是包装方法形态）。
 *
 * ## T4（第 4 轮守卫自检审计）修掉的假绿
 *
 *   · **`^  \}` 断行 ⇒ 窗口越界**：旧实现靠「下一个 2 空格缩进的 `}`」结束方法体，
 *     于是 4 空格缩进（嵌套类/不同风格的模块）或 `  };` 收尾时**窗口停不下来**，
 *     40 行窗口把**下一个方法**的门禁算到当前方法头上 —— 与首版 25 行的假绿同源。
 *     现在与 `check-cron-guard` 共用 `scripts/lib/cron-source.mjs`：词法掩码 + 花括号
 *     配对截方法体，边界由语法决定，不由缩进决定。
 *   · **行内尾注释算门禁**（注释算数）：旧实现只删「整行 `//`」与块注释，
 *     `await this.scan(); // if (!this.isLeader) return;` 里的门禁照样命中。掩码后不再。
 *   · **门禁名前缀误配**：`isLeadership` / `isLeaderCache` / `leaderGatekeeper` 都能满足
 *     子串 `isLeader`/`leaderGate`。现在两侧要求词边界（`(?![\w$])`）。
 *   · **`@Cron(` 逐行匹配 + 注释算数**：注释里的 `@Cron(...)` 会被计入 `total`
 *     （顺手把「扫描面下界」喂饱），而 `@Cron` 与 `(` 分行时又漏掉。现在走共享解析器。
 *   · **解析失败静默跳过**（`continue` 跳块）：现在单列 `unparsed` 并判结构红。
 *   · **崩溃 ≠ 红灯**：扫描根不存在时旧实现 `readdirSync` 抛栈。现在结构红 + 点名路径。
 *   · **豁免必须可证**：`ALLOWLIST` 从「行号 → 借口」改成 `rel:line → 理由`，且
 *     ① 理由不能为空 ② 键必须仍然对得上一个**真的没门禁**的站点（陈旧豁免要回收）。
 *   · `--root` + 导出 `check()`：`import` 时不实扫、不 `process.exit`；`--selftest` 改跑真子进程。
 *
 * 已知边界（如实写出）：这是**文本判据**，不是语义分析。门禁写在方法体里很深的分支、
 * 或者写在被调用方（而不是入口）里，本判据分辨不了。
 *
 * 用法：`node scripts/check-cron-leader-gate.mjs [--selftest] [--root <dir>]`
 *   --selftest：在临时 fixture 树里跑真脚本；每条断言退出码 + 关键文本 + <1s。
 *   --root    ：只给 selftest 用：把 fixture 树当仓库根扫（默认 process.cwd()）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { findCronSites } from "./lib/cron-source.mjs";
import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

export const SRC_REL = "apps/admin-api/src";

/**
 * 门禁 idiom（三种写法，都是本仓实际在用的）。
 *
 * 两侧都要求词边界（`(?<![\w$])` / `(?![\w$])`）：否则 `isLeaderCache`、
 * `leaderGatekeeper`、`isLeadership` 这类**更长**的标识符会把「没门禁」判成有门禁
 * （前缀误配，T4 修掉的假绿）。
 */
export const GATE = /(?<![\w$])(?:leaderGate|isSchedulerLeader|isLeader)(?![\w$])/;

/** 扫不到这么多就是扫描器坏了（当前 25 个）。 */
export const MIN_EXPECTED_CRONS = 15;

/**
 * 允许**不带**门禁的 `@Cron`，键是 `仓库相对路径:行号`（装饰器所在行），值必须写明理由。
 * 例如「每实例都必须跑的本地清理」—— 但目前一个都没有，故为空。
 */
export const ALLOWLIST = new Map([]);

function walkTs(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      out.push(...walkTs(p));
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) {
      out.push(p);
    }
  }
  return out;
}

const relOf = (root, abs) => relative(root, abs).split(sep).join("/");

/**
 * 判定单个源文件里哪些 `@Cron` 没有门禁。**纯函数**（不读盘）。
 *
 * 两个判据都是被反证打出来的：
 *  ① **先剥注释再判** —— 否则「把门禁注释掉」或「行尾注释里写一句门禁」都能通过；
 *  ② **方法体由花括号配对截出** —— 固定行窗口会越过方法边界，把下一个方法的门禁
 *     算到当前方法头上（首版 25 行、次版 40 行 + `^  \}` 都栽在这里）。
 *
 * @param {string} source 源文本
 * @param {{allowedLines?: Set<number>}} [opts] 豁免掉的装饰器行号（1 基）
 * @returns {{total: number, ungated: Array<{line: number, method: string}>,
 *            unparsed: Array<{line: number, method: string|null, reason: string}>}}
 */
export function findUngatedCrons(source, { allowedLines = new Set() } = {}) {
  const { sites, unparsed } = findCronSites(source);
  const ungated = [];
  const exempted = [];
  let total = 0;
  for (const site of sites) {
    total += 1;
    const gated = GATE.test(site.body);
    if (allowedLines.has(site.line)) {
      // 被豁免的站点也一并回报 `gated`：豁免若挂在一个**已经有门禁**的站点上，
      // 它就是陈旧的（借口该回收），调用方据此判结构红。
      exempted.push({ line: site.line, method: site.method, gated });
      continue;
    }
    if (!gated) ungated.push({ line: site.line, method: site.method });
  }
  return { total, ungated, exempted, unparsed };
}

/**
 * 全量判据。返回 `{ total, missing, structure, allowUsed }`。
 *
 * `structure` = 判据本身不可信（扫描根不存在 / 扫描面塌方 / 站点解析失败 /
 * 豁免不合法），与 `missing`（真的有 cron 漏了门禁）分开报：两者的修法完全不同。
 *
 * 豁免键是 `rel:line`，所以 fixture 树（`--root`）必须按空豁免跑（见 CLI 注释）。
 *
 * @param {string} [root]
 * @param {{allowlist?: Map<string, string>}} [opts]
 */
export function check(root = process.cwd(), { allowlist = ALLOWLIST } = {}) {
  const structure = [];
  const missing = [];
  const used = new Set();

  for (const [key, reason] of allowlist) {
    if (!reason || String(reason).trim().length === 0) {
      structure.push(`豁免缺理由：${key}（豁免必须可证，否则它只是把红改绿）`);
    }
    if (!/^.+\/[^/]+:\d+$/.test(key) && !/^[^/]+\.ts:\d+$/.test(key)) {
      structure.push(`豁免键格式必须是 "<仓库相对路径>:<行号>"：${key}`);
    }
  }

  const srcAbs = join(root, SRC_REL);
  const files = walkTs(srcAbs);
  if (files.length === 0) {
    structure.push(
      `扫描根不存在或没有 .ts 文件：${SRC_REL} —— 目录改名/清空时「0 个 = 全加了门禁」是假绿。`,
    );
  }

  let total = 0;
  const unparsedHits = [];
  for (const f of files) {
    const rel = relOf(root, f);
    const allowedLines = new Set();
    for (const key of allowlist.keys()) {
      if (!key.startsWith(rel + ":")) continue;
      const n = Number(key.slice(rel.length + 1));
      if (Number.isInteger(n)) allowedLines.add(n);
    }
    const res = findUngatedCrons(readFileSync(f, "utf8"), { allowedLines });
    total += res.total;
    for (const u of res.ungated) missing.push({ file: rel, ...u });
    for (const e of res.exempted) {
      const key = `${rel}:${e.line}`;
      used.add(key);
      if (e.gated) {
        structure.push(`陈旧豁免（该站点已经有门禁了，借口该回收）：${key}`);
      }
    }
    for (const p of res.unparsed) unparsedHits.push({ file: rel, ...p });
  }

  // 豁免键必须仍然对得上一个**真的没门禁**的站点：对不上就是陈旧的。
  for (const key of allowlist.keys()) {
    if (!used.has(key)) {
      structure.push(`陈旧豁免（没有对上一个「真的没门禁」的 @Cron 站点）：${key} —— 豁免必须回收`);
    }
  }

  if (unparsedHits.length > 0) {
    structure.push(
      `${unparsedHits.length} 个 @Cron 站点解析不出方法体 —— 它们既不进总数也不进判据（旧版在这里静默 continue）：` +
        unparsedHits
          .map((p) => `${p.file}:${p.line}${p.method ? " " + p.method : ""}（${p.reason}）`)
          .join("；"),
    );
  }
  if (total < MIN_EXPECTED_CRONS) {
    structure.push(
      `只扫到 ${total} 个 @Cron（下界 ${MIN_EXPECTED_CRONS}）—— 扫描器失效了（不是「全都有门禁」）。`,
    );
  }

  return { total, missing, structure, allowUsed: used.size };
}

// ── 自检（T4：真子进程 + 退出码 + 关键文本 + <1s）────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

const CASE_FILE = `${SRC_REL}/modules/task/scan.service.ts`;

/** 带门禁的方法（三种 idiom 之一）。 */
const gatedMethod = (name, { indent = "  ", gate = "    if (!this.isLeader) return;" } = {}) => [
  `${indent}@Cron("0 0 3 * * *")`,
  `${indent}async ${name}() {`,
  gate,
  `${indent}  await this.scan();`,
  `${indent}}`,
];

const serviceClass = (methods, className = "FillerService") =>
  [`class ${className} {`, ...methods.flat(), "}", ""].join("\n");

/** 16 个带门禁的方法（下界 15）。 */
const fillerService = (count = 16) =>
  serviceClass(
    Array.from({ length: count }, (_, i) => gatedMethod(`sweep${String(i).padStart(2, "0")}`)),
    "CoreService",
  );

/** 造一棵 fixture 仓库树。 */
function cronTree({ extra = {}, filler = fillerService(), bare = false } = {}) {
  if (bare) return { "package.json": { name: "fixture", private: true } };
  return {
    "package.json": { name: "fixture", private: true },
    [`${SRC_REL}/modules/core/core.service.ts`]: filler,
    [CASE_FILE]: serviceClass([gatedMethod("scan")], "TaskService"),
    ...extra,
  };
}

/**
 * 自检：12 条用例。前 10 条跑**真子进程**（`--root` 指 fixture 树），逐条断言退出码 +
 * 关键文本；后 2 条（豁免）走 API，因为 CLI 没有 `--allowlist`，给 fixture 开一个
 * 可写豁免的开关等于给判据开后门。
 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "cron-leader-gate-selftest-" });
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
  const api = (name, fn) => cases.push({ name, fn });

  subprocess("① 干净树：16 个方法体门禁 + 1 个 guardedCron 站点 → 绿", cronTree(), {
    code: 0,
    contains: ["@Cron leader 门禁齐备：17 个 @Cron 全部有门禁", "allowlist 0 个"],
    absent: ["✖"],
  });

  subprocess(
    "② 没有门禁 → 红（给出 file:line 方法名）",
    cronTree({
      extra: {
        [CASE_FILE]: serviceClass(
          [["  @Cron(\"* * * * *\")", "  async sweep() {", "    await this.scan();", "  }"]],
          "TaskService",
        ),
      },
    }),
    {
      code: 1,
      contains: ["1 个 @Cron 没有 leader 门禁", `${CASE_FILE}:2  sweep`, "leaderGate?.isLeader"],
      absent: ["门禁齐备"],
    },
  );

  // ③ 历史假绿（次版）：`^  \}` 断行不住时，窗口越界把邻居的门禁算过来
  subprocess(
    "③ 【反证·缩进】4 空格缩进的方法体（旧版窗口停不下来，会借用邻居门禁）→ 红",
    cronTree({
      extra: {
        [CASE_FILE]: [
          "class TaskService {",
          '    @Cron("* * * * *")',
          "    async sweep() {",
          "        await this.scan();",
          "    }",
          "    next() {",
          "        if (!this.isLeader) return;",
          "    }",
          "}",
          "",
        ].join("\n"),
      },
    }),
    {
      code: 1,
      contains: [`${CASE_FILE}:2  sweep`],
      absent: ["门禁齐备"],
    },
  );

  subprocess(
    "④ 门禁在**下一个方法**里（2 空格缩进）→ 红",
    cronTree({
      extra: {
        [CASE_FILE]: [
          "class TaskService {",
          '  @Cron("* * * * *")',
          "  sweep() {",
          "    this.scan();",
          "  }",
          "  next() {",
          "    if (!this.isLeader) return;",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
    }),
    { code: 1, contains: [`${CASE_FILE}:2  sweep`], absent: ["门禁齐备"] },
  );

  // ⑤ T4 新修的假绿：行内尾注释里的门禁不算
  subprocess(
    "⑤ 【反证·注释算数】行尾注释里的门禁不算 → 红",
    cronTree({
      extra: {
        [CASE_FILE]: [
          "class TaskService {",
          '  @Cron("* * * * *")',
          "  async sweep() {",
          "    await this.scan(); // if (!this.isLeader) return;",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
    }),
    { code: 1, contains: [`${CASE_FILE}:2  sweep`], absent: ["门禁齐备"] },
  );

  subprocess(
    "⑥ 块注释里的门禁不算 → 红",
    cronTree({
      extra: {
        [CASE_FILE]: [
          "class TaskService {",
          '  @Cron("* * * * *")',
          "  async sweep() {",
          "    /* if (!this.isLeader) return; */",
          "    await this.scan();",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
    }),
    { code: 1, contains: [`${CASE_FILE}:2  sweep`], absent: ["门禁齐备"] },
  );

  // ⑦ T4 新修的假绿：门禁名只差后缀
  subprocess(
    "⑦ 【反证·前缀误配】isLeaderCache / isLeadership / leaderGatekeeper 不算门禁 → 红",
    cronTree({
      extra: {
        [CASE_FILE]: [
          "class TaskService {",
          '  @Cron("* * * * *")',
          "  async sweep() {",
          "    if (this.isLeaderCache.has('x')) return;",
          "    if (this.isLeadership()) return;",
          "    if (!this.leaderGatekeeper) return;",
          "    await this.scan();",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
    }),
    { code: 1, contains: [`${CASE_FILE}:2  sweep`], absent: ["门禁齐备"] },
  );

  // ⑧ 注释掉的 @Cron 不是站点：既不该报红，也不该把「扫描面下界」喂饱
  subprocess(
    "⑧ 【反证·注释算数】被注释掉的 @Cron 不计数 → 绿，且总数不多算",
    cronTree({
      extra: {
        [CASE_FILE]: [
          "class TaskService {",
          '  // @Cron("0 0 3 * * *")',
          "  // async legacy() {",
          "  //   await this.scan();",
          "  // }",
          ...gatedMethod("scan"),
          "}",
          "",
        ].join("\n"),
      },
    }),
    { code: 0, contains: ["17 个 @Cron 全部有门禁"], absent: ["18 个 @Cron", "✖"] },
  );

  subprocess(
    "⑨ 【反证·扫描面】只剩 3 个 @Cron → 结构红（不是「全都有门禁」）",
    cronTree({ filler: fillerService(3) }),
    {
      code: 1,
      contains: [
        "@Cron leader 门禁自检结构错误",
        "只扫到 4 个 @Cron",
        `下界 ${MIN_EXPECTED_CRONS}`,
        "扫描器失效",
      ],
      absent: ["门禁齐备"],
    },
  );

  subprocess(
    "⑩ 事实源缺失（apps/admin-api/src 整个不在）→ 结构红，不是崩栈也不是绿",
    cronTree({ bare: true }),
    {
      code: 1,
      contains: ["@Cron leader 门禁自检结构错误", `扫描根不存在或没有 .ts 文件：${SRC_REL}`],
      absent: ["门禁齐备", "Error:", "ENOENT"],
    },
  );

  subprocess(
    "⑪ 【反证·continue 跳块】方法体花括号未配平 → 结构红并点名站点",
    cronTree({
      extra: {
        [CASE_FILE]: [
          "class TaskService {",
          '  @Cron("* * * * *")',
          "  async sweep() {",
          "    if (!this.isLeader) return;",
          "    if (this.enabled) {",
          "      await this.scan();",
          "  }",
          "",
        ].join("\n"),
      },
    }),
    {
      code: 1,
      contains: ["@Cron leader 门禁自检结构错误", `${CASE_FILE}:2 sweep`, "方法体花括号未配平"],
      absent: ["门禁齐备"],
    },
  );

  api("⑫ 豁免命中（真的没门禁的站点）→ 放行；陈旧豁免 → 结构红", () => {
    const repo = makeFixtureRepo(
      cronTree({
        extra: {
          [CASE_FILE]: serviceClass(
            [["  @Cron(\"* * * * *\")", "  localCleanup() {", "    this.clean();", "  }"]],
            "TaskService",
          ),
        },
      }),
      { prefix: "cron-leader-gate-selftest-" },
    );
    try {
      const key = `${CASE_FILE}:2`;

      const ok = check(repo.dir, { allowlist: new Map([[key, "本应每实例都跑的本地清理"]]) });
      if (ok.structure.length > 0 || ok.missing.length > 0) {
        throw new Error(
          `豁免命中应放行，实际 structure=${JSON.stringify(ok.structure)} missing=${JSON.stringify(ok.missing)}`,
        );
      }
      if (ok.allowUsed !== 1) {
        throw new Error(`豁免应被计入 allowUsed=1，实际 ${ok.allowUsed}`);
      }

      const stale = check(repo.dir, { allowlist: new Map([[`${CASE_FILE}:1`, "写错行号"]]) });
      if (!stale.structure.some((e) => e.includes("陈旧豁免"))) {
        throw new Error(`预期陈旧豁免结构错误，实际 ${JSON.stringify(stale.structure)}`);
      }

      const empty = check(repo.dir, { allowlist: new Map([[key, "  "]]) });
      if (!empty.structure.some((e) => e.includes("豁免缺理由"))) {
        throw new Error(`预期缺理由结构错误，实际 ${JSON.stringify(empty.structure)}`);
      }
    } finally {
      repo.cleanup();
    }
  });

  const failed = reportCases(cases, { title: "check-cron-leader-gate selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    const rootArg = argValue(process.argv, "--root");
    const root = resolve(rootArg ?? process.cwd());
    // `--root` 是 selftest 专用：ALLOWLIST 里写的是**本仓库**的 `rel:line`，套到临时树上
    // 只会被当成「陈旧豁免」而全线报错，所以显式给 `--root` 时按空豁免跑。
    // 方向是**变严**（豁免少了只可能多报问题，不可能漏报）；扫真实仓库请不带 `--root`。
    const { total, missing, structure, allowUsed } = check(
      root,
      rootArg ? { allowlist: new Map() } : {},
    );

    if (structure.length > 0) {
      console.error("");
      console.error("✖ @Cron leader 门禁自检结构错误（判据本身不可信，先修扫描面）：");
      for (const e of structure) console.error("  · " + e);
      console.error("");
      process.exit(1);
    }

    if (missing.length > 0) {
      console.error("");
      console.error(`✖ ${missing.length} 个 @Cron 没有 leader 门禁（多副本会各跑一遍）：`);
      for (const m of missing) console.error(`  · ${m.file}:${m.line}  ${m.method}`);
      console.error("");
      console.error("  修法：在方法体开头加门禁，本仓有三种既有写法可选：");
      console.error("    if (!this.leaderGate?.isLeader) return;");
      console.error("    if (!this.isLeader) return;              // scheduler 的 getter");
      console.error("    if (!this.isSchedulerLeader()) return;   // 包装方法");
      console.error("  若该 tick **本应**每实例都跑（本地清理等），加进 ALLOWLIST（键 `rel:line`）并写理由。");
      process.exit(1);
    }

    console.log(
      `✔ @Cron leader 门禁齐备：${total} 个 @Cron 全部有门禁（allowlist ${allowUsed} 个）。`,
    );
  }
}
