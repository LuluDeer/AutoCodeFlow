#!/usr/bin/env node
/**
 * Jest CLI flag 守卫 —— 拦「CI/script 里写了 Jest 根本不认识的 flag」。
 *
 * ## 由来（必须记住的失败形态）
 * Jest 30.5.2 对未知的长选项**静默忽略**：`npx jest --retryTimes=2 --listTests`
 * EXIT 0、不报 "unrecognized option"，`--showConfig` 里也没有任何 retry 痕迹。
 * 黑盒 fail-once 探针实测：带该 flag 只执行 1 次就红；`jest.retryTimes(2)` 才执行 2 次转绿。
 * 也就是说，一个「看着像兜底」的 flag 可以长期写在 CI 命令和注释里，既没生效也没人知道。
 * 本仓纪律是「有意不加 --retry」（重试会把 flake 洗成「看起来稳定」），所以删除它是
 * 零行为变化的诚实修复；本守卫负责让后来者再也塞不进别的无效 flag。
 *
 * ## 判据
 * ① 支持面：`spawnSync(<root>/apps/admin-api/node_modules/.bin/jest --help)`，
 *    只从**选项声明行**（行首缩进 + 可选短旗 + `--long-name`）解析长选项名。
 *    描述文字里出现的 `--xxx`（如反引号里的别名）不算声明，避免把散文当支持面。
 * ② 白名单：`FLAG_ALLOWLIST` 只放「help 不列、但用真子进程证明生效」的 flag，
 *    每条必须写理由。当前只有 `workerIdleMemoryLimit`：它是 Jest 配置期权，
 *    `--workerIdleMemoryLimit=1536MB --showConfig` 实测输出 1536000000，确实生效，
 *    只是 `--help` 没列（CLI 经 config 通道透传）；CI 的内存三件套依赖它。
 *    新增白名单项必须先证明生效、再写 ≥8 字理由，不能靠「好像能跑」。
 * ③ 扫描面：`.github/workflows/ci.yml` 与 `scripts/coverage-snapshot.mjs`。
 *    先剥注释（YAML 整行/行内 `#`；JS 行注释与块注释，字符串与模板字面量原样保留），
 *    再定位每一个独立的 `jest` 命令 token，只取它**之后**的 `--flag=…` / `--flag …`，
 *    因此 `npx --node-options=… jest …` 里的 npx 旗标不会被误当 jest 旗标。
 *    既支持单行 `run: npx jest --coverage`，也支持数组里 `"jest",` 后续元素逐行铺开。
 * ④ 判红：flag 不在①且不在② ⇒ `file:line` + flag 点名判红。
 *    结构红（反永真）：help 解析出 0 项 / 扫描文件读不到 / 任一文件扫不到 jest 命令 /
 *    全仓扫不到任何 jest flag token ⇒ exit 1。
 * ⑤ SKIP：找不到 `apps/admin-api/node_modules/.bin/jest` ⇒ 打印说明并 exit 0，
 *    避免非 admin-api 环境（守卫 job 不装 admin-api 依赖）稳定红。
 *
 * 用法：
 *   node scripts/check-jest-cli-flags.mjs                 # 真仓库
 *   node scripts/check-jest-cli-flags.mjs --selftest      # 真子进程 + 临时夹具自检（5 例）
 *   node scripts/check-jest-cli-flags.mjs --root <dir>    # 只给 selftest 用：把夹具当根扫
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SELF = fileURLToPath(import.meta.url);
const JEST_REL = "apps/admin-api/node_modules/.bin/jest";
const SCAN_FILES = [".github/workflows/ci.yml", "scripts/coverage-snapshot.mjs"];
const HELP_TIMEOUT_MS = 20_000;

/** help 不列但确实生效的 flag：key = flag 名（不带 --），value = 必填理由（≥8 字）。 */
export const FLAG_ALLOWLIST = {
  workerIdleMemoryLimit:
    "Jest 30 配置期权：`--workerIdleMemoryLimit=1536MB --showConfig` 实测输出 1536000000，确实生效，只是未列入 --help；CI 内存三件套依赖它。",
};

/** 剥注释但保留行号/列号；字符串字面量与模板字面量原样保留。 */
export function stripComments(text, kind) {
  if (kind === "yml") {
    return text
      .split("\n")
      .map((line) => {
        if (/^\s*#/.test(line)) return " ".repeat(line.length);
        let quote = null;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (quote) {
            if (ch === "\\") {
              i++;
              continue;
            }
            if (ch === quote) quote = null;
            continue;
          }
          if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
          }
          if (ch === "#" && /\s/.test(line[i - 1] ?? "")) {
            return line.slice(0, i) + " ".repeat(line.length - i);
          }
        }
        return line;
      })
      .join("\n");
  }
  const out = [];
  let state = "code";
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") {
        out.push("  ");
        i++;
        state = "line";
        continue;
      }
      if (ch === "/" && next === "*") {
        out.push("  ");
        i++;
        state = "block";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        state = "string";
      }
      out.push(ch);
      continue;
    }
    if (state === "line") {
      if (ch === "\n") {
        out.push("\n");
        state = "code";
      } else {
        out.push(" ");
      }
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        out.push("  ");
        i++;
        state = "code";
        continue;
      }
      out.push(ch === "\n" ? "\n" : " ");
      continue;
    }
    // string / template：原样保留，里面的 `//`、`--flag` 都算命令文本
    out.push(ch);
    if (ch === "\\" && i + 1 < text.length) {
      out.push(text[i + 1]);
      i++;
      continue;
    }
    if (ch === quote) {
      quote = null;
      state = "code";
    }
  }
  return out.join("");
}

/** 只从选项声明行解析长选项名（107 项 @ Jest 30.5.2）；描述里的 `--x` 不算。 */
export function parseHelpFlags(helpText) {
  const names = new Set();
  for (const line of String(helpText ?? "").split(/\r?\n/)) {
    const m = /^\s{2,}(?:-[A-Za-z],\s+)?--([A-Za-z][A-Za-z0-9-]*)\b/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

/**
 * 定位每个独立 `jest` token 的命令窗口：本行余下 + 后续「像命令续行」的行
 * （`"--flag",` / `--flag` / `],`），上限 20 行，避免把无关代码块吞进来。
 */
export function findJestCommands(stripped) {
  const lines = String(stripped ?? "").split("\n");
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let from = 0;
    while (from < line.length) {
      const m = /(^|[^A-Za-z0-9_./-])jest(?![A-Za-z0-9_./-])/.exec(line.slice(from));
      if (!m) break;
      const col = from + m.index + m[1].length;
      let window = line.slice(col);
      for (let j = i + 1; j < Math.min(lines.length, i + 21); j++) {
        const t = lines[j].trim();
        // 数组元素 `"--flag",` / `'--flag',` / `--flag`，或收尾 `],` / `}`：都算同一条命令的续行。
        if (!/^(?:"--|'--|--)/.test(t) && !/^[\]}],?$/.test(t)) break;
        window += "\n" + lines[j];
      }
      found.push({ line: i + 1, col: col + 1, window });
      from = col + 4;
    }
  }
  return found;
}

/** 从命令窗口取 `--flag` token；`--flag=value` 的 value 整段跳过（value 里的 -- 不是新 flag）。 */
export function extractFlags(window) {
  const flags = [];
  const re = /--([A-Za-z][A-Za-z0-9-]*)/g;
  let m;
  while ((m = re.exec(window)) !== null) {
    const before = m.index === 0 ? "" : window[m.index - 1];
    if (before !== "" && !/[\s"'=(,;|]/.test(before)) continue;
    flags.push(m[1]);
    if (window[re.lastIndex] === "=") {
      let end = re.lastIndex + 1;
      while (end < window.length && !/[\s"'`,)]/.test(window[end])) end++;
      re.lastIndex = end;
    }
  }
  return flags;
}

/** 主判据：返回 { status: "ok"|"error"|"skip", problems, commands, supported }。 */
export function checkRepo(root) {
  const jestBin = join(root, JEST_REL);
  if (!existsSync(jestBin)) {
    return {
      status: "skip",
      problems: [],
      commands: [],
      supported: 0,
      reason: `${JEST_REL} 不存在 —— 非 admin-api 环境（守卫 job 不装该端依赖），本守卫优雅跳过，exit 0。`,
    };
  }
  const help = spawnSync(jestBin, ["--help"], {
    cwd: join(root, "apps", "admin-api"),
    encoding: "utf8",
    timeout: HELP_TIMEOUT_MS,
  });
  if (help.error || (help.status !== 0 && help.status !== null)) {
    return {
      status: "error",
      problems: [
        `结构红：jest --help 执行失败（status=${help.status}${help.error ? `, error=${help.error.message}` : ""}）—— 判据①无法执行。`,
      ],
      commands: [],
      supported: 0,
    };
  }
  const supported = parseHelpFlags(`${help.stdout ?? ""}\n${help.stderr ?? ""}`);
  if (supported.size === 0) {
    return {
      status: "error",
      problems: ["结构红：jest --help 解析出 0 个长选项 —— 支持面塌了，绝不当成「无违规=绿」。"],
      commands: [],
      supported: 0,
    };
  }

  const problems = [];
  const commands = [];
  for (const rel of SCAN_FILES) {
    const abs = join(root, rel);
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch (e) {
      problems.push(`结构红：读不到 ${rel}（${e.message}）—— 扫描面失效。`);
      continue;
    }
    const stripped = stripComments(text, rel.endsWith(".yml") ? "yml" : "mjs");
    const found = findJestCommands(stripped);
    if (found.length === 0) {
      problems.push(`结构红：${rel} 里没扫到任何 jest 命令 —— 扫描面塌了，判据不能当绿。`);
    }
    for (const cmd of found) {
      for (const flag of extractFlags(cmd.window)) {
        commands.push({ rel, line: cmd.line, flag });
        if (!supported.has(flag) && !Object.hasOwn(FLAG_ALLOWLIST, flag)) {
          problems.push(
            `${rel}:${cmd.line} —— jest 命令用了 \`--${flag}\`，既不在 jest --help 支持面（${supported.size} 项），也不在带理由的白名单里 ⇒ 静默无效 flag。`,
          );
        }
      }
    }
  }
  if (commands.length === 0) {
    problems.push("结构红：两个扫描文件里一条 jest flag token 都没扫到 —— 反永真，判红。");
  }
  return {
    status: problems.length === 0 ? "ok" : "error",
    problems,
    commands,
    supported: supported.size,
  };
}

function runGuard(args) {
  const r = spawnSync(process.execPath, [SELF, ...args], {
    encoding: "utf8",
    timeout: HELP_TIMEOUT_MS * 2,
  });
  return { code: r.status ?? -1, text: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

const TMP_BASE = existsSync("/tmp/opencode") ? "/tmp/opencode" : tmpdir();

function makeFixture(files, helpFlags = ["help", "version", "shard", "coverage", "maxWorkers", "coverageReporters"]) {
  const root = join(TMP_BASE, `acf-jest-flags-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "apps", "admin-api", "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(root, ".github/workflows/ci.yml"), files.ci);
  writeFileSync(join(root, "scripts/coverage-snapshot.mjs"), files.cov);
  const helpBody = helpFlags.map((f) => `      --${f}                            [布尔]`).join("\n");
  const bin = join(root, "apps", "admin-api", "node_modules", ".bin", "jest");
  writeFileSync(bin, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(`选项：\n${helpBody}\n`)});\n`);
  chmodSync(bin, 0o755);
  return root;
}

const FIX_CI = `jobs:
  test:
    steps:
      - run: npx --node-options=--experimental-vm-modules jest --shard=1/4 --coverage
`;
const FIX_COV = `const ENDS = {
  "admin-api": {
    args: [
      "jest",
      "--coverage",
      "--maxWorkers=2",
      "--workerIdleMemoryLimit=1536MB",
    ],
  },
};
`;

/** --selftest：5 例，全部走真子进程（不是内存替身），夹具经 --root 注入。 */
export function runSelftest() {
  const cases = [];
  const ok = (name, fn) => cases.push({ name, fn });

  ok("① 真仓库全绿（真 jest --help，真 ci.yml / coverage-snapshot.mjs）", () => {
    const r = runGuard([]);
    return { pass: r.code === 0, got: `exit=${r.code}`, want: "exit=0", tail: r.text };
  });

  ok("② 夹具塞假 flag `--not-a-jest-flag=1` ⇒ 判红并点名 file:line", () => {
    const root = makeFixture({
      ci: FIX_CI.replace("--coverage\n", "--coverage --not-a-jest-flag=1\n"),
      cov: FIX_COV,
    });
    try {
      const r = runGuard(["--root", root]);
      const pass = r.code === 1 && /ci\.yml:4/.test(r.text) && /--not-a-jest-flag/.test(r.text);
      return { pass, got: `exit=${r.code}`, want: "exit=1 + ci.yml:4 + flag 名", tail: r.text };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  ok("③ help 解析为空 ⇒ 结构红（反永真）", () => {
    const root = makeFixture({ ci: FIX_CI, cov: FIX_COV }, []);
    try {
      const r = runGuard(["--root", root]);
      const pass = r.code === 1 && r.text.includes("结构红");
      return { pass, got: `exit=${r.code}`, want: "exit=1 + 结构红", tail: r.text };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  ok("④ 扫不到任何 jest 命令 ⇒ 结构红（反永真）", () => {
    const root = makeFixture({
      ci: "jobs:\n  test:\n    steps:\n      - run: echo ok\n",
      cov: "const ENDS = {};\n",
    });
    try {
      const r = runGuard(["--root", root]);
      const pass = r.code === 1 && r.text.includes("结构红");
      return { pass, got: `exit=${r.code}`, want: "exit=1 + 结构红", tail: r.text };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  ok("⑤ 白名单 flag + 仅出现在注释里的假 flag ⇒ 绿（不误报、注释已剥）", () => {
    const root = makeFixture({
      ci: `${FIX_CI}      # 注释里提到 --not-a-jest-flag=1，不是命令，不该判红\n`,
      cov: FIX_COV,
    });
    try {
      const r = runGuard(["--root", root]);
      const pass = r.code === 0;
      return { pass, got: `exit=${r.code}`, want: "exit=0", tail: r.text };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  let failed = 0;
  for (const c of cases) {
    let res;
    try {
      res = c.fn();
    } catch (e) {
      res = { pass: false, got: `抛错 ${e.message}`, want: "正常返回", tail: "" };
    }
    if (res.pass) {
      console.log(`✔ ${c.name}（${res.got}）`);
    } else {
      failed++;
      console.error(`✘ ${c.name}：实得 ${res.got}，期望 ${res.want}`);
      console.error(res.tail.split("\n").filter(Boolean).slice(-8).join("\n"));
    }
  }
  console.log(`COVERAGE_CASES: ${cases.length}`);
  console.log(`自检 ${cases.length} 例：${cases.length - failed} 过 / ${failed} 败`);
  return failed === 0 ? 0 : 1;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) return runSelftest();
  let root = REPO_ROOT;
  const at = argv.indexOf("--root");
  if (at >= 0) {
    if (!argv[at + 1]) {
      console.error("✘ --root 缺参数");
      return 1;
    }
    root = resolve(argv[at + 1]);
  }
  const result = checkRepo(root);
  if (result.status === "skip") {
    console.log(`SKIP：${result.reason}`);
    return 0;
  }
  if (result.status === "error") {
    console.error("✘ Jest CLI flag 守卫判红：");
    for (const p of result.problems) console.error(`  - ${p}`);
    console.error(`  （jest --help 支持面 ${result.supported} 项；白名单 ${Object.keys(FLAG_ALLOWLIST).length} 项，均需理由）`);
    return 1;
  }
  console.log(
    `✔ Jest CLI flag 守卫：扫到 ${result.commands.length} 个 jest flag token（help 支持面 ${result.supported} 项 + 带理由白名单 ${Object.keys(FLAG_ALLOWLIST).length} 项），未发现静默无效 flag。`,
  );
  return 0;
}

// R45/main-guard：本文件导出可测函数，import 时绝不许连带跑主判据（否则 import 就 exit）。
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(main());
}
