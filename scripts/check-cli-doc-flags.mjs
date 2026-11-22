#!/usr/bin/env node
/**
 * onboarding 文档里的 `acf <cmd> [<sub>] --flag` ↔ CLI 源码注册的**旗标对账守卫**。
 *
 * 背景（R465）：CLI 命令面持续变动（R278 弃用 --json、R289 补 --yes、NETOPT-2 补
 * --wait-timeout），但没有任何机器守卫校验文档里的 flag 是否真实存在。已有的
 * `check-cli-doc.mjs` 只守命令计数/父命令存在，头注明确写着「刻意不判子命令选项」；
 * `check:task-examples` 只守示例 JSON 载荷。实证事故：docs/development.md:217 写了
 * `acf login … --username admin`，而 login.ts:152 只注册 `--user <username>`（:140/:177
 * 的提示文案也都是 `--user`）——照文档敲就是 unknown option（exit 2）。
 *
 * 判据（只做确定能判的事）：
 *   ① 事实源 = packages/acf-cli/src/index.ts（config 等父命令 + 全局选项）+
 *      packages/acf-cli/src/commands/*.ts（每个文件的 `new Command('name')` 与
 *      `.option('--xxx …')`），长名与短名都收集（`-f, --file <path>` ⇒ `-f` + `--file`）；
 *   ② 扫描面 = 6 份 onboarding 核心文档（**不含** AGENT_HANDOFF 等内部文档），逐行抽
 *      `acf <cmd> … --flag`，flag 必须在 `<cmd>` 对应的命令文件里注册；
 *   ③ 白名单仅 commander 内置 `--help` / `-h` / `--version` / `-V`；
 *   ④ 命令映射不确定（文档写了一个源码里没有的父命令）→ 明确计数、打印「跳过」，
 *      且**带 flag 的那一处不许静默放行**（转判据红，要求补注册或改文档）。
 *
 * 反假绿四条下界：6 份文档全在 / 抽到 ≥15 处 acf 命令 / ≥8 个命令源文件 /
 * ≥12 个已注册父命令 + ≥25 个已注册 flag；任一不成立即**结构红（exit 2）**。
 * 事实源读不到同样是结构红，绝不退化成「0 条 = 全绿」。
 *
 * 退出码：0 通过 / 1 判据失败 / 2 结构错。import 时不实扫、不 process.exit。
 *
 * 用法：`node scripts/check-cli-doc-flags.mjs [--selftest] [--root <dir>]`
 *   --selftest：临时 fixture 树里跑真脚本子进程（7 条用例，含注入不存在的 flag 转红、
 *              文档读不到 / 命令数归零 / 命令文件塌方三条结构反证）；
 *   --root    ：只给 selftest 用，把 fixture 当仓库根（默认 process.cwd()）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";
// 与 check-cli-doc.mjs 同款纪律：覆盖计数行必须在任何依赖之前落到管道里。
printCoverageBanner(import.meta.url, "subprocess");

export const CMD_DIR_REL = "packages/acf-cli/src/commands";
export const INDEX_REL = "packages/acf-cli/src/index.ts";
/** 只扫 onboarding 核心 6 份；AGENT_HANDOFF / 验收报告等内部文档不在面内。 */
export const DOC_RELS = [
  "docs/quickstart.md",
  "docs/sdk-guide.md",
  "docs/development.md",
  "examples/daily-report/README.md",
  "examples/desktop-data-entry/README.md",
  "examples/intranet-inspection/README.md",
];

/** commander 自带的旗标，任何命令都合法。 */
export const BUILTIN_FLAGS = ["--help", "-h", "--version", "-V"];

/** 扫描面下界（2026-11-22 实测：6 文档 / 24 处 acf / 13 个命令文件 / 16 个父命令）。只增不减。 */
export const MIN_DOCS = 6;
export const MIN_ACF_COMMANDS = 15;
export const MIN_COMMAND_FILES = 8;
export const MIN_REGISTERED_COMMANDS = 12;
export const MIN_REGISTERED_FLAGS = 25;
/** R472 review：flag 抽取全塌（FLAG_RE 失配 / 文档 flag 被删空）时 flagUses→0 Must红。实测 19，留余量。 */
export const MIN_FLAG_USES = 15;

function readText(abs) {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/** commands/ 下的 .ts（排除 .test.ts）；目录不存在返回 []，由下界判据报红。 */
function commandFiles(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort();
  } catch {
    return [];
  }
}

/** `.option('-f, --file <path>', …)` 的首参 → ['-f', '--file']；占位符 `<path>` 不是旗标。 */
function flagsFromOptionArg(arg) {
  const out = [];
  for (const token of String(arg).split(/[\s,]+/)) {
    const t = token.replace(/,+$/, "");
    if (/^--[A-Za-z][A-Za-z0-9-]*$/.test(t) || /^-[A-Za-z]$/.test(t)) out.push(t);
  }
  return out;
}

/** 从 index.ts + commands/*.ts 建「父命令 → 已注册旗标集合」的事实表。 */
function buildRegistry(root, errors, counts) {
  const registry = new Map();
  const files = commandFiles(join(root, CMD_DIR_REL));
  counts.sourceFiles = files.length;
  if (files.length < MIN_COMMAND_FILES) {
    errors.push(
      `${CMD_DIR_REL} 只读到 ${files.length} 个 .ts（下界 ${MIN_COMMAND_FILES}）—— 目录改名或全被排除了？`,
    );
  }

  const sources = files.map((f) => ({ rel: `${CMD_DIR_REL}/${f}`, text: readText(join(root, CMD_DIR_REL, f)) }));
  sources.push({ rel: INDEX_REL, text: readText(join(root, INDEX_REL)) });

  const allFlags = new Set();
  for (const { rel, text } of sources) {
    if (text === null) {
      errors.push(`读不到 ${rel} —— 事实源缺失，旗标对账已经瞎了。`);
      continue;
    }
    const names = [...text.matchAll(/new Command\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    if (names.length === 0) {
      errors.push(`无法从 ${rel} 解析父命令名（new Command('…') 写法变了）—— 该文件里的选项无人认领。`);
      continue;
    }
    const flags = new Set();
    // \s* 兼容多行 `.option(\n  '--wait-timeout <n>', …)`。
    for (const m of text.matchAll(/\.option\(\s*(['"])([^'"]*)\1/g)) {
      for (const flag of flagsFromOptionArg(m[2])) {
        flags.add(flag);
        allFlags.add(flag);
      }
    }
    for (const name of names) {
      if (!registry.has(name)) registry.set(name, { file: rel, flags: new Set() });
      for (const flag of flags) registry.get(name).flags.add(flag);
    }
  }

  counts.registeredCommands = registry.size;
  counts.registeredFlags = allFlags.size;
  if (registry.size < MIN_REGISTERED_COMMANDS) {
    errors.push(
      `只解析到 ${registry.size} 个父命令（下界 ${MIN_REGISTERED_COMMANDS}）—— 事实源解析塌了，不能当「文档没写错」。`,
    );
  }
  if (allFlags.size < MIN_REGISTERED_FLAGS) {
    errors.push(
      `只解析到 ${allFlags.size} 个已注册旗标（下界 ${MIN_REGISTERED_FLAGS}）—— .option() 正则失配或源码被清空。`,
    );
  }
  return registry;
}

/**
 * 逐行抽 `acf <cmd> … --flag`。命令片段止于反引号 / 表格竖线 / shell 注释 `#` / 分号，
 * 避免把同一行后文散文里的 `--body` 错算到前一个命令头上（quickstart.md:21 就有这种行）。
 */
const ACF_RE = /\bacf\s+([a-z][a-z0-9-]*)/g;
const SPAN_STOP_RE = /[`|#；;]/;
// R472 review：前瞻放宽到 `=` / 逗号 / 右括号 / 分号——commander 支持 --url=http://x，
// 旧前瞻只认空白/行尾会漏掉 --flag=value 形态（写错的也漏报）。
const FLAG_RE = /(?:^|\s)(--[A-Za-z][A-Za-z0-9-]*|-[A-Za-z])(?=\s|$|=|[,;)])/g;

function extractDocUses(root, errors, counts) {
  const uses = [];
  for (const rel of DOC_RELS) {
    const text = readText(join(root, rel));
    if (text === null) {
      errors.push(`读不到 ${rel} —— 文档改名/删掉了，对账面塌了。`);
      continue;
    }
    counts.docsRead += 1;
    text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(ACF_RE)) {
        const tail = line.slice(m.index);
        const stop = tail.search(SPAN_STOP_RE);
        const span = stop < 0 ? tail : tail.slice(0, stop);
        const after = tail.slice(m[0].length);
        const sub = /^\s+([a-z][a-z0-9-]*)(?=\s|$)/.exec(after)?.[1] ?? null;
        const flags = [...span.matchAll(FLAG_RE)].map((f) => f[1]);
        uses.push({ doc: rel, line: i + 1, cmd: m[1], sub, flags, span: span.trim() });
      }
    });
  }
  counts.commands = uses.length;
  if (counts.docsRead < MIN_DOCS) {
    errors.push(`只读到 ${counts.docsRead}/${DOC_RELS.length} 份 onboarding 文档（下界 ${MIN_DOCS}）。`);
  }
  if (counts.commands < MIN_ACF_COMMANDS) {
    errors.push(
      `只抽到 ${counts.commands} 处 acf 命令（下界 ${MIN_ACF_COMMANDS}，实测 24）—— 文档格式变了或正则失配，不能当「零错全绿」。`,
    );
  }
  return uses;
}

/**
 * 判据本体。返回 `{ errors, problems, skipped, counts, uses }`：
 *   · errors   = 结构性问题（扫描面/解析失败）→ exit 2；
 *   · problems = 文档与源码不一致（未注册旗标 / 映射不确定却带 flag）→ exit 1；
 *   · skipped  = 映射不确定且不带 flag 的出处，逐条打印，绝不静默跳过。
 */
export function check({ root = process.cwd() } = {}) {
  const errors = [];
  const problems = [];
  const skipped = [];
  const counts = {
    docsRead: 0,
    commands: 0,
    sourceFiles: 0,
    registeredCommands: 0,
    registeredFlags: 0,
    flagUses: 0,
    flagsChecked: 0,
    builtins: 0,
    skipped: 0,
  };

  const registry = buildRegistry(root, errors, counts);
  const uses = extractDocUses(root, errors, counts);
  if (errors.length > 0) return { errors, problems, skipped, counts, uses };

  for (const u of uses) {
    const where = `${u.doc}:${u.line}`;
    const entry = registry.get(u.cmd);
    if (!entry) {
      counts.skipped += 1;
      skipped.push(`${where}  acf ${u.cmd} —— 映射不到命令源文件，跳过旗标对账`);
      if (u.flags.length > 0) {
        problems.push(
          `${where}  acf ${u.cmd} 的命令映射不确定，旗标 ${u.flags.join(" ")} 无法对账（不是放行：请补注册或改文档）。`,
        );
      }
      continue;
    }
    for (const flag of u.flags) {
      counts.flagUses += 1;
      if (BUILTIN_FLAGS.includes(flag)) {
        counts.builtins += 1;
      } else if (entry.flags.has(flag)) {
        counts.flagsChecked += 1;
      } else {
        problems.push(
          `${where}  acf ${u.cmd}${u.sub ? " " + u.sub : ""} 使用了未在源码注册的旗标 ${flag}（事实源：${entry.file}）。`,
        );
      }
    }
  }
  // R472 review：flag 抽取全塌（FLAG_RE 失配 / 文档 flag 被删空）时 flagUses→0，
  // 而文档数/命令数仍正常 ⇒ 过去会 problems=[] 静默绿。补下界，归零即结构红。
  // 必须在上面循环累加 flagUses 之后再判，否则恒为 0。
  if (counts.flagUses < MIN_FLAG_USES) {
    errors.push(`结构错误：只抽到 ${counts.flagUses} 次 flag 引用（下界 ${MIN_FLAG_USES}）——FLAG_RE 失配或文档 flag 被删空，零 flag 会让对账静默通过`);
  }
  return { errors, problems, skipped, counts, uses };
}

// ── 自检（全部跑真脚本子进程）─────────────────────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

const FIX_CMDS = [
  "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa",
  "lambda", "mu", "nu", // 13 个命令文件 + index.ts 的 config = 14 个父命令（> 下界 12）
];
/** 每份 fixture 命令文件都注册的旗标（含短名 -f）。 */
const FIX_FLAGS = ["--url <url>", "-f, --file <path>", "--user <username>", "--wait", "--body <json>"];
/** 只在 index.ts 的 config 上补够 flag 扫描面（全局去重后 > 下界 25），避免 fixture 撑得过长。 */
const FIX_EXTRA_FLAGS = [
  "--json", "-y, --yes", "--page <n>", "--limit <n>", "--tail <n>", "--executor <id>",
  "--code <code>", "--output <file>", "-o, --out <file>", "--name <name>", "--scope <scope>",
  "--status <status>", "--strategy <strategy>", "--timeout <n>", "--from-line <n>", "--ids <ids>",
  "--version <v>", "--description <text>", "--language <lang>", "--kind <kind>",
];
const optionLines = (specs) =>
  specs.map((spec, i) => `    .option(${JSON.stringify(spec)}, 'fixture option ${i}')`).join("\n");

const FIX_INDEX =
  `import { Command } from 'commander';\n` +
  `new Command('config')\n` +
  optionLines(["--json", ...FIX_EXTRA_FLAGS]).replace(/^    /gm, "  ") + `;\n`;

const fixCommand = (name) =>
  `import { Command } from 'commander';\n` +
  `export function ${name}Command(): Command {\n` +
  `  return new Command('${name}')\n` +
  optionLines(FIX_FLAGS) + `;\n` +
  `}\n`;

/** 每份 fixture 文档 5 处 acf（共 30 处），gamma 在第 4 行 —— 反证注入点。 */
const fixDoc = (n) =>
  [
    `# fixture doc ${n}`,
    `acf alpha --url http://localhost:3105`,
    `acf beta --file task.json`,
    `acf gamma --user admin`,
    `acf delta --wait`,
    `acf epsilon --body '{"k":"v"}'`,
    "",
  ].join("\n");

function fixtureTree({ dropDocs = [], docOverride = {}, dropCommands = false } = {}) {
  const files = { [INDEX_REL]: FIX_INDEX };
  if (!dropCommands) for (const name of FIX_CMDS) files[`${CMD_DIR_REL}/${name}.ts`] = fixCommand(name);
  DOC_RELS.forEach((rel, i) => {
    if (!dropDocs.includes(rel)) files[rel] = docOverride[rel] ?? fixDoc(i);
  });
  return files;
}

/** 自检：7 条用例，全部 `spawn` 真脚本（退出码 + 关键文本双向断言）。 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "cli-doc-flags-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
            withinMs: 2000,
            label: name,
            ...expect,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  subprocess("① 干净 fixture：6 文档 / 30 处 acf / 已注册 flag 全命中 → 绿", fixtureTree(), {
    code: 0,
    contains: ["CLI 文档旗标对账一致", "6 份文档", "30 处 acf 命令"],
    absent: ["未在源码注册", "结构错误", "跳过"],
  });

  subprocess(
    "② 注入不存在的 --username（development.md:4）→ 红且点名文件:行",
    fixtureTree({
      docOverride: {
        "docs/development.md": fixDoc(2).replace("acf gamma --user admin", "acf gamma --username admin"),
      },
    }),
    { code: 1, contains: ["docs/development.md:4", "--username", "未在源码注册"], absent: ["CLI 文档旗标对账一致"] },
  );

  subprocess(
    "③ 【反证·文档】一份 onboarding 文档读不到 → 结构红（exit 2）",
    fixtureTree({ dropDocs: ["docs/quickstart.md"] }),
    { code: 2, contains: ["结构错误", "读不到 docs/quickstart.md"], absent: ["CLI 文档旗标对账一致"] },
  );

  subprocess(
    "④ 【反证·文档】命令数归零（文档只剩标题）→ 结构红（exit 2）",
    fixtureTree({ docOverride: Object.fromEntries(DOC_RELS.map((rel) => [rel, "# 没有命令\n"])) }),
    { code: 2, contains: ["结构错误", "只抽到 0 处 acf 命令"], absent: ["CLI 文档旗标对账一致"] },
  );

  subprocess(
    "⑤ 【反证·事实源】commands 目录一个 .ts 都没有 → 结构红（exit 2）",
    fixtureTree({ dropCommands: true }),
    { code: 2, contains: ["结构错误", "只读到 0 个 .ts"], absent: ["CLI 文档旗标对账一致"] },
  );

  subprocess(
    "⑥ 短名 -f 与内置 --help / -h 白名单 → 绿",
    fixtureTree({
      docOverride: {
        "docs/quickstart.md": "# f & builtins\nacf zeta -f task.json\nacf eta --help\nacf theta -h\n",
      },
    }),
    { code: 0, contains: ["CLI 文档旗标对账一致"], absent: ["未在源码注册", "结构错误"] },
  );

  subprocess(
    "⑦ 未注册的短名 -z → 红，点名文件:行",
    fixtureTree({
      docOverride: { "docs/sdk-guide.md": "# bad short\nacf iota -z value\n" },
    }),
    { code: 1, contains: ["docs/sdk-guide.md:2", "-z", "未在源码注册"], absent: ["CLI 文档旗标对账一致"] },
  );

  const failed = reportCases(cases, { title: "check-cli-doc-flags selftest" });
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
    const root = resolve(argValue(process.argv, "--root") ?? process.cwd());
    const { errors, problems, skipped, counts } = check({ root });

    if (errors.length > 0) {
      console.error("");
      console.error("✖ CLI 文档旗标守卫结构错误（判据本身不可信）：");
      for (const e of errors) console.error("  · " + e);
      console.error("");
      process.exit(2);
    }

    if (problems.length > 0) {
      console.error("");
      console.error("✖ CLI 文档旗标与源码注册不一致：");
      for (const p of problems) console.error("  · " + p);
      console.error("");
      console.error("  修法：改文档里的 flag（或补 CLI 源码注册）。**不要**改守卫放行。");
      console.error("");
      process.exit(1);
    }

    console.log(
      "✔ CLI 文档旗标对账一致：" + counts.docsRead + " 份文档 / " + counts.commands +
        " 处 acf 命令 / " + counts.flagUses + " 次 flag 引用：" + counts.flagsChecked +
        " 个命中源码注册 + " + counts.builtins + " 个 commander 内置。",
    );
    console.log(
      "  事实源扫描面：" + counts.sourceFiles + " 个命令文件 / " + counts.registeredCommands +
        " 个父命令 / " + counts.registeredFlags + " 个已注册 flag。",
    );
    if (skipped.length > 0) {
      console.log("  跳过（命令映射不确定）" + counts.skipped + " 处：");
      for (const s of skipped) console.log("  · " + s);
    }
  }
}
