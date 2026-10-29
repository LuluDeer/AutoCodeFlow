#!/usr/bin/env node
/**
 * CLI 命令地图（docs/atlas/05-interfaces/cli.md）与 `acf` 实际注册的命令之间的**计数守卫**。
 *
 * 背景：那份文档的每一节标题都带一个手写计数（`### task（23）— commands/tasks.ts`），
 * 总数又在标题里写死（`# CLI 命令地图（acf，67 个子命令）`）。R69 发现它**整整漏掉**了
 * `acf mutex` 一节（4 个子命令）—— 而计数「63」恰好就是「漏掉 mutex」的那个数，说明数字本身
 * 也在跟着错。手写计数没有任何东西校验，就一定会漂。
 *
 * 判据（两条，都只做**确定能判**的事）：
 *   ① 每个含 `.command(` 的 commands/*.ts，其父命令名在文档里必须有一节，且**计数与代码一致**；
 *   ② 文档标题里的总数 = 全部 `.command(` 数 + `login.ts` 里用 `new Command` 注册的根命令数。
 *
 * 刻意**不判**的：
 *   · `login.ts` 不按节判（它的 3 个根命令与 `config` 的 3 个子命令合写在 `login / config（6）`
 *     一节里，1:1 映射不成立）；它的存在性由 ② 的总数间接覆盖。
 *   · 子命令的**选项/描述**是否与文档一致 —— 那是描述性内容，不是清单，不做机械比对。
 *
 * ## T4（第 4 轮守卫自检审计）补的四道防线
 *
 *   · **扫描面下界**：旧实现没有任何规模断言 —— commands 目录改名、`index.ts` 读不到、
 *     正则失配，都会让「0 个命令 = 文档 0 错」一路 ✔（本仓反复踩的形态）。现在三条下界
 *     （command 文件数 / 命令总数 / 文档小节数）+ 事实源读不到即结构红。
 *   · **父命令解析失败不再静默跳过**：旧实现 `if (!parentMatch) continue`，一个写法变了的
 *     commands 文件会整块退出校验，它的子命令只被算进总数、没人按节核对。现在结构红。
 *   · `--root`：模块级 `process.cwd()` 收成参数，`import` 时不实扫、不 `process.exit`。
 *   · `--selftest`：跑真脚本的子进程，9 条用例逐条断言退出码 + 关键文本（含上述假绿的反证）。
 *
 * 用法：`node scripts/check-cli-doc.mjs [--selftest] [--root <dir>]`
 *   --selftest：在临时 fixture 树里跑真脚本（事实源需要仓库根布局：packages/acf-cli + docs/atlas）。
 *   --root    ：只给 selftest 用：把 fixture 树当仓库根（默认 process.cwd()）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

export const CMD_DIR_REL = "packages/acf-cli/src/commands";
export const INDEX_REL = "packages/acf-cli/src/index.ts";
export const DOC_REL = "docs/atlas/05-interfaces/cli.md";

/** 扫描面下界（2026-10-29 实测：commands 13 个文件 / 69 个命令 / 文档 13 节）。只增不减。 */
export const MIN_COMMAND_FILES = 8;
export const MIN_TOTAL_COMMANDS = 40;
export const MIN_DOC_SECTIONS = 8;

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

/**
 * 判据本体。返回 `{ errors, problems, counts }`：
 *   · errors   = 结构性（扫描面/解析失败）——「判据本身不可信」，优先级高于 problems；
 *   · problems = 文档与代码不一致（缺节 / 计数不符 / 总数不符）。
 */
export function check({ root = process.cwd() } = {}) {
  const errors = [];
  const problems = [];
  const counts = { files: 0, docSections: 0, totalCommands: 0, rootCommands: 0 };

  const doc = readText(join(root, DOC_REL));
  if (doc === null) {
    return { errors: [`读不到 ${DOC_REL} —— 路径/文件名变了，本判据已经瞎了。`], problems, counts };
  }
  const indexSrc = readText(join(root, INDEX_REL));
  if (indexSrc === null) {
    return {
      errors: [`读不到 ${INDEX_REL} —— index.ts 里的 config 子命令无从计数，总数必然错。`],
      problems,
      counts,
    };
  }

  const files = commandFiles(join(root, CMD_DIR_REL));
  counts.files = files.length;
  if (files.length < MIN_COMMAND_FILES) {
    return {
      errors: [
        `${CMD_DIR_REL} 只读到 ${files.length} 个 .ts（下界 ${MIN_COMMAND_FILES}）—— 目录改名或全被排除了？`,
      ],
      problems,
      counts,
    };
  }

  /** 文档里所有 `### …（N）…` 标题里的 name→count（支持「与」拼起来的合并标题）。 */
  const docCounts = new Map();
  for (const line of doc.split("\n")) {
    if (!line.startsWith("### ")) continue;
    for (const m of line.matchAll(/([a-z][a-z0-9-]*)（(\d+)）/g)) {
      docCounts.set(m[1], Number(m[2]));
    }
  }
  counts.docSections = docCounts.size;

  let totalCommands = (indexSrc.match(/\.command\(/g) ?? []).length;
  let rootCommands = 0;

  for (const f of files) {
    const src = readText(join(root, CMD_DIR_REL, f)) ?? "";
    const subCount = (src.match(/\.command\(/g) ?? []).length;
    totalCommands += subCount;

    // login.ts 是三个**根命令**（login / whoami / logout）的工厂，不是子命令集合：
    // 它们与 config 的 3 个子命令合写在 `login / config（6）` 一节，1:1 映射不成立。
    if (f === "login.ts") {
      rootCommands += (src.match(/new Command\(/g) ?? []).length;
      continue;
    }

    const parentMatch = /new Command\(\s*['"]([^'"]+)['"]/.exec(src);
    if (!parentMatch) {
      // 旧实现这里 `continue`：文件的子命令只进了总数，从没按节核对过。
      errors.push(
        `无法解析 ${CMD_DIR_REL}/${f} 的父命令名（缺少 new Command("…") 或写法变了）—— 该文件里的 ${subCount} 个子命令无人按节校验。`,
      );
      continue;
    }
    const parent = parentMatch[1];
    if (parent === "config") continue; // 合写在 login / config 一节，见文件头「刻意不判的」
    if (subCount === 0) continue;

    const documented = docCounts.get(parent);
    if (documented === undefined) {
      problems.push(`缺少「${parent}」一节（代码里 ${subCount} 个子命令，来自 commands/${f}）`);
    } else if (documented !== subCount) {
      problems.push(`「${parent}」计数不符：文档 ${documented}，代码 ${subCount}（commands/${f}）`);
    }
  }

  counts.totalCommands = totalCommands;
  counts.rootCommands = rootCommands;
  const actualTotal = totalCommands + rootCommands;

  if (actualTotal < MIN_TOTAL_COMMANDS) {
    errors.push(
      `命令总数只数到 ${actualTotal} 个（下界 ${MIN_TOTAL_COMMANDS}）—— 扫描面塌了，不是命令变少了。`,
    );
  }
  if (docCounts.size < MIN_DOC_SECTIONS) {
    errors.push(
      `文档只解析到 ${docCounts.size} 个「### 名（N）」小节（下界 ${MIN_DOC_SECTIONS}）—— 标题格式变了，逐节核对已对不上号。`,
    );
  }
  if (errors.length > 0) return { errors, problems, counts };

  const headerMatch = /#\s*CLI\s*命令地图（acf，(\d+)\s*个子命令）/.exec(doc);
  const headerTotal = headerMatch ? Number(headerMatch[1]) : null;
  if (headerTotal === null) {
    problems.push("标题里找不到「（acf，N 个子命令）」——标题格式变了，守卫需要同步（不是放宽）");
  } else if (headerTotal !== actualTotal) {
    problems.push(
      `标题总数不符：文档 ${headerTotal}，代码 ${actualTotal}（${totalCommands} 个 .command( + ${rootCommands} 个根命令）`,
    );
  }

  return { errors, problems, counts };
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

// fixture 的事实源：9 个父命令 × 5 个子命令 + index.ts 的 3 个 config 子命令 + login 的 3 个根命令。
const CMDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota"].map((n) => [n, 5]);
const TOTAL = CMDS.length * 5 + 3 + 3;

const commandFile = (name, n) =>
  `import { Command } from "commander";\n\n` +
  `export const ${name} = new Command("${name}");\n\n` +
  Array.from({ length: n }, (_, i) => `${name}.command("${name}:${i}").action(() => {});`).join("\n") +
  "\n";

const loginFile = () =>
  ["login", "whoami", "logout"].map((n) => `export const ${n} = new Command("${n}");`).join("\n") + "\n";

const indexFile = () =>
  Array.from({ length: 3 }, (_, i) => `program.command("config:${i}").action(() => {});`).join("\n") + "\n";

const cliDocText = ({ total = TOTAL } = {}) =>
  [
    `# CLI 命令地图（acf，${total} 个子命令）`,
    "",
    `共 ${total} 个子命令。`,
    "",
    ...CMDS.map(([n, c]) => `### ${n}（${c}）— commands/${n}.ts`),
    "",
    "### login / config（6）",
    "",
  ].join("\n");

/** 造一棵最小 CLI 文档 fixture 树（packages/acf-cli + docs/atlas）。 */
function cliTree({
  commands = CMDS,
  doc = cliDocText(),
  index = indexFile(),
  login = loginFile(),
  extra = {},
  drop = [],
} = {}) {
  const files = {
    [INDEX_REL]: index,
    [DOC_REL]: doc,
  };
  for (const [name, n] of commands) files[`${CMD_DIR_REL}/${name}.ts`] = commandFile(name, n);
  files[`${CMD_DIR_REL}/login.ts`] = login;
  Object.assign(files, extra);
  for (const d of drop) delete files[d];
  return files;
}

/**
 * 自检：9 条用例，全部 `spawn` 真脚本。
 *
 * 旧版**没有 selftest**（R70 是「写判据 + 手工反证」，反证没留下）。上面那两条结构红
 * （扫描面下界 / 父命令解析失败）是本次新增的，必须被逐条钉住。
 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "cli-doc-selftest-" });
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

  subprocess("① 干净树：13 节计数与代码相符、总数一致 → 绿", cliTree(), {
    code: 0,
    contains: [
      "CLI 命令地图一致",
      `总数 ${TOTAL}`,
      `48 个 .command( + 3 个根命令`,
    ],
    absent: ["不一致", "结构错误"],
  });

  subprocess(
    "② 某节计数不符（文档 beta 4 / 代码 5）→ 红",
    cliTree({ doc: cliDocText().replace("### beta（5）", "### beta（4）") }),
    { code: 1, contains: ["「beta」计数不符：文档 4，代码 5"], absent: ["CLI 命令地图一致"] },
  );

  subprocess(
    "③ 缺一节（文档删掉 gamma 节）→ 红，点名缺哪个父命令",
    cliTree({ doc: cliDocText().replace("### gamma（5）— commands/gamma.ts\n", "") }),
    { code: 1, contains: ["缺少「gamma」一节", "代码里 5 个子命令"], absent: ["CLI 命令地图一致"] },
  );

  subprocess(
    "④ 标题总数不符（文档 50 / 代码 51）→ 红，且报出分解式",
    cliTree({ doc: cliDocText({ total: 50 }) }),
    { code: 1, contains: ["标题总数不符：文档 50，代码 51", "48 个 .command( + 3 个根命令"], absent: ["CLI 命令地图一致"] },
  );

  subprocess(
    "⑤ 标题格式变了（「（acf，N 个子命令）」不见了）→ 红，要求同步而不是放宽",
    cliTree({ doc: cliDocText().replace("# CLI 命令地图（acf，51 个子命令）", "# CLI 命令地图（acf 命令）") }),
    { code: 1, contains: ["标题里找不到「（acf，N 个子命令）」", "不是放宽"], absent: ["CLI 命令地图一致"] },
  );

  // ⑥ 修掉的假绿：旧实现没有下界，commands 目录改名 → 0 个文件 → 「0 错」全绿
  subprocess(
    "⑥ 【反证·扫描面】commands 目录改名（一个 .ts 都读不到）→ 结构红",
    cliTree({ commands: [], drop: [`${CMD_DIR_REL}/login.ts`] }),
    { code: 1, contains: ["结构错误", "只读到 0 个 .ts", `下界 ${MIN_COMMAND_FILES}`], absent: ["CLI 命令地图一致"] },
  );

  subprocess(
    "⑦ 扫描面下界：命令总数只剩 15 个（文档写得再准也不可信）→ 结构红",
    cliTree({
      commands: CMDS.map(([name]) => [name, 1]),
      doc: cliDocText({ total: 15 }).replace(/（5）/g, "（1）"),
    }),
    { code: 1, contains: ["结构错误", "命令总数只数到 15 个", `下界 ${MIN_TOTAL_COMMANDS}`], absent: ["CLI 命令地图一致"] },
  );

  // ⑧ 修掉的假绿：旧实现 `if (!parentMatch) continue` —— 该文件的子命令从没按节核对过
  subprocess(
    "⑧ 【反证·解析失败】某 commands 文件缺少 new Command(\"…\") → 结构红（不再静默跳过）",
    cliTree({
      doc: cliDocText().replace("### alpha（5）— commands/alpha.ts\n", ""),
      extra: { [`${CMD_DIR_REL}/omega.ts`]: `omega.command("omega:0").action(() => {});\n` },
    }),
    { code: 1, contains: ["结构错误", "无法解析", "omega.ts"], absent: ["CLI 命令地图一致"] },
  );

  subprocess("⑨ 事实源缺失（index.ts 被删）→ 结构红且点名路径", cliTree({ drop: [INDEX_REL] }), {
    code: 1,
    contains: [`读不到 ${INDEX_REL}`],
    absent: ["CLI 命令地图一致"],
  });

  const failed = reportCases(cases, { title: "check-cli-doc selftest" });
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
    const { errors, problems, counts } = check({ root });

    if (errors.length > 0) {
      console.error("");
      console.error("✖ CLI 命令地图守卫结构错误（判据本身不可信）：");
      for (const e of errors) console.error("  · " + e);
      console.error("");
      process.exit(1);
    }

    if (problems.length > 0) {
      console.error("");
      console.error("✖ CLI 命令地图与代码不一致：");
      for (const p of problems) console.error("  · " + p);
      console.error("");
      console.error("  修法：改 docs/atlas/05-interfaces/cli.md（补节 / 改计数 / 改标题总数）。**不要**改守卫放行。");
      process.exit(1);
    }

    console.log(
      "✔ CLI 命令地图一致：" + counts.docSections + " 节计数与代码相符，总数 " +
        (counts.totalCommands + counts.rootCommands) + " = " + counts.totalCommands + " 个 .command( + " +
        counts.rootCommands + " 个根命令。",
    );
  }
}
