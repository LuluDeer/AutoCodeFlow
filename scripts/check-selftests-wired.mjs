#!/usr/bin/env node
/**
 * R251（→ 470）：**`*.selftest.*` 命名即接线契约** —— 每个自检脚本必须
 * ① 被某个入口真的执行，或 ② 在**它自己的头注里**写明「为什么不能进链」。
 *
 * ## 为什么需要它（R249/R250 的两次人工审计）
 *
 * 本仓用 `.selftest.` 后缀标记「这是自检，应该被某个门禁跑」。
 * R249 发现 `reset-admin-password.selftest.sh` 头注写着「**safe in CI**」
 * 却从未被跑；R250 系统性扫出 **7 个无人执行**，接上 4 个、留下 3 个。
 *
 * **问题**：那 3 个「不接」的结论当时只写在**台账文档**里。
 * 下一个人（或下一轮的我）重跑同样的审计，会把它们当成「忘了接」而顺手接上 ——
 * 而那三个需要 docker / PG / 分钟级矩阵，接上去会让整条链变慢或变红。
 *
 * ⇒ 把「处置」变成**机器判据**：**每个 selftest 要么可达、要么自带理由**。
 *
 * ## 判据
 *
 * 对 `scripts/` 下每个名字含 `selftest` 的脚本文件：
 *   ① 从 `test:guards:chain` / `test:unit` / `test:guards:selftests` /
 *      `typecheck:all` 出发做**递归可达性分析**（并集 CI 里直接 `node`/`bash` 的调用），
 *      命中 ⇒ 通过；
 *   ② 未命中 ⇒ 要求**该文件自己的头注**（前 `HEADER_LINES` 行）里出现
 *      **真机理由的关键词**（`needs-env` / `docker` / `分钟` / `连跑` / `真机`…）⇒ 通过；
 *   ③ 两者皆无 ⇒ **红**，并点名「它叫 selftest 却没人跑，也没有说明为什么」。
 *
 * ## 为什么是「头注」而不是「豁免清单」
 *
 * 469：**「不接」的理由要留在被执行的对象旁边**。
 * 若理由写在单独的 json 里，读者要先知道「有那个 json」；写在脚本头注里，
 * **打开脚本就能看到** —— 而且它与代码**同生共死**（挪走脚本，理由也跟着走）。
 *
 * ## 反证（`--selftest` 逐条证明它会红）
 *
 * ① 删掉某条目的接线 ⇒ 红；② 把理由从该脚本头注里删掉 ⇒ 红；
 * ③ 头注里有理由但没人跑 ⇒ **绿**（正确形态）。
 *
 * 用法：`node scripts/check-selftests-wired.mjs [--selftest] [--root=<dir>]`
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  expectExit,
  makeFixtureRepo,
  reportCases,
  runGuard,
} from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

printCoverageBanner(import.meta.url, "push");

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

/** 同时决定「什么算入口」与「查几层」—— 入口越少越不容易误判为已覆盖（466）。 */
const ENTRY_SCRIPTS = [
  "test:guards:chain",
  "test:unit",
  "test:guards:selftests",
  "typecheck:all",
];

/** 理由只需出现在头注里（不在正文里捞，避免把「碰巧提到 docker」当成理由）。 */
const HEADER_LINES = 30;

/**
 * 「为什么不能进链」的可识别关键词。
 *
 * ⚠️ 这套词表故意收得很窄：宽到「只要是注释就行」等于没有判据。
 * 每条都对应一类**真实的不可离线理由**（R250 实测的三个正好各占一类）。
 */
const WHY_KEYWORDS = [
  "needs-env",
  "docker",
  "真机",
  "分钟",
  "连跑",
  "端到端",
  "起真实",
  "需要真实",
];

/** 递归收集某个 npm script 可达的全部 npm script 名。 */
function collectReachable(scripts, entries = ENTRY_SCRIPTS) {
  const reach = new Set();
  const walk = (name, depth) => {
    if (depth > 8 || reach.has(name)) return;
    const body = scripts[name];
    if (typeof body !== "string") return;
    reach.add(name);
    for (const m of body.matchAll(/npm run ([\w:-]+)/g)) walk(m[1], depth + 1);
  };
  for (const e of entries) walk(e, 0);
  return reach;
}

/**
 * 跑判据。
 *
 * @returns `{{ errors: string[], printed: string[] }}`
 */
export function check(root = resolve(HERE, "..")) {
  const errors = [];
  const printed = [];

  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) {
    return { errors: ["读不到 package.json —— 判据失去对象"], printed };
  }
  let scripts;
  try {
    scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {};
  } catch (e) {
    return { errors: [`package.json 不是合法 JSON：${e.message}`], printed };
  }
  const reach = collectReachable(scripts);

  // 所有可达 npm script 的**正文**（用来判「某个脚本文件是否被它们直接调用」）
  const reachBodies = [...reach].map((n) => scripts[n]).join("\n");

  const ciDir = join(root, ".github", "workflows");
  let ciText = "";
  if (existsSync(ciDir)) {
    for (const f of readdirSync(ciDir)) {
      if (/\.ya?ml$/.test(f)) ciText += readFileSync(join(ciDir, f), "utf8");
    }
  }

  const scriptsDir = join(root, "scripts");
  if (!existsSync(scriptsDir)) {
    return { errors: ["读不到 scripts/ —— 判据失去对象"], printed };
  }
  const files = readdirSync(scriptsDir).filter((f) => f.includes("selftest"));

  // 规模下界：若 somehow 扫不到文件，上面 existsSync 已红；这里再兜一层
  // ——「目录改名 ⇒ 零命中 ⇒ 一句 ✔」是本仓反复踩过的形态。
  if (files.length < 10) {
    errors.push(
      `只扫到 ${files.length} 个 selftest 文件（预期 ≥10）⇒ 扫描面退化，判据不可信`,
    );
    return { errors, printed };
  }

  for (const f of files.sort()) {
    const rel = `scripts/${f}`;
    // ① 可达：被某个可达 npm script 或 CI 直接调用
    const wired = reachBodies.includes(rel) || ciText.includes(rel);
    if (wired) {
      printed.push(`${rel}：已接线`);
      continue;
    }
    // ② 未可达 ⇒ 头注必须有理由
    const head = readFileSync(join(root, rel), "utf8")
      .split("\n")
      .slice(0, HEADER_LINES)
      .join("\n");
    const why = WHY_KEYWORDS.find((k) => head.includes(k));
    if (why) {
      printed.push(`${rel}：未接线，**头注已说明理由**（含「${why}」）`);
      continue;
    }
    errors.push(
      `${rel} **叫 selftest 却没人跑，也没有说明为什么**。` +
        `（方法学 468：命名即接线契约 —— 叫 selftest 却不被跑，比叫 demo 更误导，` +
        `它会让读者以为有覆盖。）处置二选一：① 接进 test:guards:chain / ci.yml；` +
        `② 若确实不能离线（需 docker / PG / 分钟级），**在它自己的头注里写明**` +
        `（可识别关键词：${WHY_KEYWORDS.join(" / ")}）—— 理由要留在被执行的对象旁边（469）。`,
    );
  }

  return { errors, printed };
}

// ── 自检 ────────────────────────────────────────────────────────────────────
function baseScripts(extra = {}) {
  return {
    "test:guards:chain": "npm run check:placeholder",
    "check:placeholder": "node scripts/check-some.mjs",
    ...extra,
  };
}

function baseFiles(reason) {
  const files = {
    "package.json": "",
    ".github/workflows/ci.yml": "",
    "scripts/check-some.mjs": "// guard\n",
    // 10 个 selftest 满足规模下界：1 个可达 + 9 个带理由
    "scripts/wired.selftest.mjs": "// x\n",
  };
  for (let i = 0; i < 9; i += 1) {
    files[`scripts/why${i}.selftest.mjs`] = `// needs-env：需 docker + PG\n`;
  }
  return files;
}

function buildRepo(overrides = {}) {
  const files = baseFiles();
  const scripts = baseScripts();
  // ⚠️ 必须在 baseFiles() **之后**写：它自己会给 ci.yml 塞一行，
  // 覆盖顺序错了「删接线」就删不掉（R251 首次运行踩到）。
  files[".github/workflows/ci.yml"] = "run: node scripts/wired.selftest.mjs\n";
  if (overrides.dropWiring) files[".github/workflows/ci.yml"] = "run: echo hi\n";
  if (overrides.dropReason) files["scripts/why0.selftest.mjs"] = "// 没有说明\n";
  return makeFixtureRepo({
    ...files,
    "package.json": JSON.stringify({ scripts }, null, 2),
  });
}

function runSelftest() {
  const cases = [];
  const push = (name, fn) => cases.push({ name, fn });

  push("正例：1 个可达 + 9 个头注带理由 ⇒ exit 0", () => {
    const repo = buildRepo();
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 0,
        withinMs: 20000,
        label: "正例",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例①：把唯一可达的接线删掉（它头注也没理由）⇒ exit 1", () => {
    const repo = buildRepo({ dropWiring: true });
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1,
        contains: ["wired.selftest.mjs", "叫 selftest 却没人跑"],
        withinMs: 20000,
        label: "删接线",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例②：把某条的头注理由删掉 ⇒ exit 1 并点名该文件", () => {
    const repo = buildRepo({ dropReason: true });
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1,
        contains: ["why0.selftest.mjs", "没有说明为什么"],
        withinMs: 20000,
        label: "删理由",
      });
    } finally {
      repo.cleanup();
    }
  });

  const failed = reportCases(cases, { title: "check-selftests-wired selftest" });
  process.exit(failed === 0 ? 0 : 1);
}

function main(argv) {
  // ⚠️ 两种形态都要认：`--root=<dir>` **和** `--root <dir>`。
  // 首版只认等号形态，而 `runGuard(SELF, { args: ["--root", dir] })` 传的是
  // **空格分隔** ⇒ `--root` 被忽略、判据跑在**真实仓库**上（那里全绿）
  // ⇒ 三条反例全部「退出码 0（期望 1）」。这是自检自己抓到的：**判据没跑在被测对象上**。
  const eqArg = argv.find((a) => a.startsWith("--root="));
  const spIdx = argv.indexOf("--root");
  const root = eqArg
    ? resolve(eqArg.slice("--root=".length))
    : spIdx >= 0 && argv[spIdx + 1]
      ? resolve(argv[spIdx + 1])
      : resolve(HERE, "..");
  const { errors, printed } = check(root);
  for (const p of printed) console.log(`  · ${p}`);
  if (errors.length === 0) {
    console.log(
      `✔ selftest 接线判据通过：每个 *.selftest.* 要么可达、要么头注已说明不可离线的理由`,
    );
    process.exit(0);
  }
  console.error("✘ selftest 接线判据失败：");
  for (const e of errors) console.error(`  · ${e}`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SELF)) {
  process.exit(process.argv.includes("--selftest") ? runSelftest() : main(process.argv.slice(2)));
}
