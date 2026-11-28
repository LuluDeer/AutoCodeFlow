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
 * 对 `scripts/`、`examples/scripts` 直接层与 `examples/<子目录>/scripts` 下每个
 * 名字含 `selftest` 的脚本文件：
 *   ① 从 `test:guards:chain` / `test:unit` / `test:guards:selftests` /
 *      `typecheck:all` 出发做**递归可达性分析**（并集 CI 里直接 `node`/`bash` 的调用），
 *      命中 ⇒ 通过；
 *   ② 未命中 ⇒ 要求**该文件自己的头注**（前 `HEADER_LINES` 行）里出现
 *      **真机理由的关键词**（`needs-env` / `docker` / `分钟` / `连跑` / `真机`…）⇒ 通过；
 *   ③ 两者皆无 ⇒ **红**，并点名「它叫 selftest 却没人跑，也没有说明为什么」。
 *
 * ## R163：examples/ 也进扫描面（防孤儿，但判据口径不变）
 *
 * `examples/scripts/check-task-examples.mjs` 的 `--selftest` 写在**脚本内**
 *（`argv.includes("--selftest")`），文件名并不含 selftest ⇒ 本守卫按**文件名**
 * 识别的判据看不到它，扩面到 examples 也看不到。它的脚本内自检由
 * `check-guards-wired` 的判据③ 覆盖（实测全仓 110 个守卫自检面全绿，含它）。
 * 这里**刻意不把「脚本内含 --selftest」也算成 selftest 文件**：那会把全仓所有
 * 带自检开关的普通守卫都拖进本判据，逼它们补头注理由或接线 —— 那是改判据造绿。
 *
 * examples/ 下将来若出现**独立** `*.selftest.*` 文件（命名即接线契约），它必须
 * 同样受本判据管辖。所以扫描面扩到 `examples/scripts` 直接层与 examples 各子目录
 * 的 `scripts/`，与 `check-guards-wired` 的 examples 扫描面同口径。
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
function collectReachable(scripts, entries = ENTRY_SCRIPTS, root = resolve(HERE, "..")) {
  const reach = new Set();
  let stepsCache;
  // W2（链指针化）：`test:guards:chain` / `test:guards:repo` 的 body 都只剩一句 node 命令，
  // 链段本体在 scripts/guards-chain-steps.json（与 runner / matrix 共用同一事实源）。
  // 读不到 ⇒ null（fail-closed：可达面塌缩会让本判据把大量 selftest 误判为「没人跑」）。
  const chainStepsText = () => {
    if (stepsCache === undefined) {
      try {
        const steps = JSON.parse(
          readFileSync(join(root, "scripts", "guards-chain-steps.json"), "utf8"),
        )?.steps;
        stepsCache =
          Array.isArray(steps) && steps.length > 0
            ? steps.map((s) => String(s).trim()).filter(Boolean).join("\n")
            : null;
      } catch {
        stepsCache = null;
      }
    }
    return stepsCache;
  };
  const walk = (name, depth) => {
    if (depth > 8 || reach.has(name)) return;
    const body = scripts[name];
    if (typeof body !== "string") return;
    reach.add(name);
    // W2：入口指针（矩阵/runner）⇒ 等价代入链段本体再继续展开（与 R22 手法一致）。
    let source = body;
    if (/scripts\/(guards-repo-matrix|run-guards-chain)\.mjs/.test(body)) {
      const stepsText = chainStepsText();
      if (stepsText) source = `${body}\n${stepsText}`;
    }
    for (const m of source.matchAll(/npm run ([\w:-]+)/g)) walk(m[1], depth + 1);
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
  // ⚠️ R255（476 的同族加固）：**排除 `//` 注释键**。
  // `package.json` 允许 `//xxx` 形式的注释键（本仓有 45 个）。它们的正文是
  // **人读的说明**，可能提到 `npm run foo` 或某个脚本路径 —— 若混进 reachBodies，
  // 就会把「注释里提到」判成「真的被引用」。
  // 实测当前无实际影响（45 个注释键里 0 个含 selftest 路径），但**形态是对的才安全**：
  // 与 `ciText` 剥 YAML 注释（R253）同一条纪律 —— **注释不能当代码用**。
  const reachBodies = [...reach]
    .filter((n) => !n.startsWith("//"))
    .map((n) => scripts[n])
    .join("\n");

  const ciDir = join(root, ".github", "workflows");
  let ciText = "";
  if (existsSync(ciDir)) {
    for (const f of readdirSync(ciDir)) {
      if (/\.ya?ml$/.test(f)) {
        // ⚠️ R253（474 的反证本轮抓出）：**必须剥掉 YAML 注释**。
        // 原实现直接 `ciText += 整个文件` ⇒ 注释里出现 `scripts/x.selftest.mjs`
        // 也会命中 ⇒ 判成「已接线」。而我自己的 R250 注释里**正好**写了
        // 「demo-seed / demo-failure-seed / demo」三个名字 —— 若写成带路径的形态，
        // 这守卫就会把「只在注释里提到」判成「真的被跑」。
        // 这与它要防的错（「看起来有覆盖、实际没有」）**完全同型**。
        const raw = readFileSync(join(ciDir, f), "utf8");
        ciText += raw
          .split("\n")
          .filter((line) => !/^\s*#/.test(line))
          .join("\n");
      }
    }
  }

  const scriptsDir = join(root, "scripts");
  if (!existsSync(scriptsDir)) {
    return { errors: ["读不到 scripts/ —— 判据失去对象"], printed };
  }
  // R163：examples/ 下的**独立** `*.selftest.*` 也要进判据。与 check-guards-wired
  // 同口径：examples/scripts 直接层（check-task-examples.mjs 就在这一层）+ examples
  // 各子目录的 scripts/。判据仍按**文件名**含 selftest 识别 —— 脚本内 `--selftest`
  // 由 check-guards-wired 的判据③ 覆盖，不在本守卫改判据（避免假绿）。
  const files = [];
  const collect = (dir, relDir) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (f.includes("selftest")) files.push({ rel: `${relDir}/${f}`, abs: join(dir, f) });
    }
  };
  collect(scriptsDir, "scripts");
  collect(join(root, "examples", "scripts"), "examples/scripts");
  let exampleChildren = [];
  try {
    exampleChildren = readdirSync(join(root, "examples"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // examples/ 不存在 ⇒ 没有子目录可扫；scripts/ 的规模下界仍钉住扫描面。
  }
  for (const child of exampleChildren) {
    collect(join(root, "examples", child, "scripts"), `examples/${child}/scripts`);
  }

  // 规模下界：若 somehow 扫不到文件，上面 existsSync 已红；这里再兜一层
  // ——「目录改名 ⇒ 零命中 ⇒ 一句 ✔」是本仓反复踩过的形态。
  if (files.length < 10) {
    errors.push(
      `只扫到 ${files.length} 个 selftest 文件（预期 ≥10）⇒ 扫描面退化，判据不可信`,
    );
    return { errors, printed };
  }

  for (const { rel, abs } of files.sort((a, b) => a.rel.localeCompare(b.rel))) {
    // ① 可达：被某个可达 npm script 或 CI 直接调用
    const wired = reachBodies.includes(rel) || ciText.includes(rel);
    if (wired) {
      printed.push(`${rel}：已接线`);
      continue;
    }
    // ② 未可达 ⇒ 头注必须有理由
    const head = readFileSync(abs, "utf8")
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

  push("反例③：只在 **YAML 注释**里提到路径 ⇒ 仍判「没人跑」（剥注释）", () => {
    const files = baseFiles();
    // 把唯一可达的那条从 CI 里拿掉，改成**只出现在注释里**
    files[".github/workflows/ci.yml"] = "# run: node scripts/wired.selftest.mjs\n";
    const scripts = baseScripts();
    const repo = makeFixtureRepo({
      ...files,
      "package.json": JSON.stringify({ scripts }, null, 2),
    });
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1,
        contains: ["wired.selftest.mjs", "叫 selftest 却没人跑"],
        withinMs: 20000,
        label: "注释不算接线",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例④：只在 **package.json 注释键**里提到路径 ⇒ 仍判「没人跑」（排除 // 键）", () => {
    const files = baseFiles();
    files[".github/workflows/ci.yml"] = "run: echo hi\n"; // CI 不接线
    const scripts = baseScripts();
    // 注释键里提到 wired 的路径（旧实现会把它当成「被引用」）
    scripts["//note"] = "历史说明：node scripts/wired.selftest.mjs 曾经用过";
    const repo = makeFixtureRepo({
      ...files,
      "package.json": JSON.stringify({ scripts }, null, 2),
    });
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1,
        contains: ["wired.selftest.mjs", "叫 selftest 却没人跑"],
        withinMs: 20000,
        label: "注释键不算接线",
      });
    } finally {
      repo.cleanup();
    }
  });

  // ── R163：examples/ 扫描面的反证（独立 selftest 文件）─────────────────────
  // 判据按文件名含 selftest 识别，所以夹具必须是独立 *.selftest.* 文件。
  // 两条路径分别钉住 examples/scripts 直接层（真实缺口所在层）与
  // examples/<子目录>/scripts（同款遍历）；控制组证明红不是 fixture 自身坏了。
  const EXAMPLE_DIRECT = "examples/scripts/orphan-example.selftest.mjs";
  const EXAMPLE_NESTED = "examples/demo/scripts/orphan-nested.selftest.mjs";
  const exampleRepo = (rel, { wired = false } = {}) => {
    const files = baseFiles();
    files[".github/workflows/ci.yml"] =
      "run: node scripts/wired.selftest.mjs\n" + (wired ? `run: node ${rel}\n` : "run: echo hi\n");
    files[rel] = "// 故意不写理由，也没被任何入口执行\n";
    return makeFixtureRepo({
      ...files,
      "package.json": JSON.stringify({ scripts: baseScripts() }, null, 2),
    });
  };
  const expectExampleRed = (rel, label) => {
    const repo = exampleRepo(rel);
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1,
        contains: [rel, "叫 selftest 却没人跑"],
        withinMs: 20000,
        label,
      });
    } finally {
      repo.cleanup();
    }
  };
  // 写成两条独立 push（而非循环）：本脚本的 COVERAGE_CASES 是静态数 push 调用点，
  // 循环会让「打印数」与「实际跑的用例数」脱钩，正是 R168 要防的形态。
  push("反例⑤【R163】examples/scripts 直接层的 selftest 未接线且无理由 ⇒ 红", () =>
    expectExampleRed(EXAMPLE_DIRECT, "examples 直接层 orphan 未接线"),
  );
  push("反例⑤【R163】examples/<子目录>/scripts 的 selftest 未接线且无理由 ⇒ 红", () =>
    expectExampleRed(EXAMPLE_NESTED, "examples 子目录 orphan 未接线"),
  );
  push("反例⑥【R163】直接层 orphan selftest 接进 CI ⇒ 绿（证明上一条的红不是 fixture 自身坏了）", () => {
    const repo = exampleRepo(EXAMPLE_DIRECT, { wired: true });
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 0,
        contains: ["selftest 接线判据通过", `${EXAMPLE_DIRECT}：已接线`],
        withinMs: 20000,
        label: "examples orphan 已接线",
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
