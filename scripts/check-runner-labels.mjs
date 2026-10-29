#!/usr/bin/env node
/**
 * CIR-07：GitHub Actions 的 runner 标签不许用 `-latest`（用固定版本标签）。
 *
 * ## 为什么这是问题而不是风格
 *
 * 2026-10-19 起 GitHub 把 `ubuntu-latest` 从 Ubuntu 24.04 **迁到 Ubuntu 26**
 * （actions/runner-images#14748）。这条迁移的破坏形态与「tag 是可变的」完全同型：
 * 仓库零改动、workflow 零改动，某天开始跑在另一套镜像上——glibc / 预装工具链 /
 * 内核参数都可能变，而 CI 的红绿只会表现为「莫名其妙挂了几个 job」。
 * 本仓对 action 固定到 40 位 SHA、对镜像固定到 digest，runner 标签是**同一个
 * 供应链问题**的第三处，之前没有守卫。
 *
 * ## 判据
 *
 * 扫 `.github/workflows/*.yml|*.yaml`，剥掉 YAML 注释后，对每一处 runner 取值
 * （`runs-on:` 标量 / 列表项，以及 matrix 里的 `os:` / `runner:` 列表项）：
 *
 *   ① 以 `-latest` 结尾且不在 `ALLOW` 里 → 红（点名 `file:line: label`）；
 *   ② `ubuntu-*` 必须是 `ubuntu-<YY>.<MM>[-arm]` 形态（`ubuntu-24.04` /
 *      `ubuntu-24.04-arm`）；写成 `ubuntu`、`ubuntu-current` 之类同样红；
 *   ③ `ALLOW` 里的标签必须**仍被使用**，否则红（豁免腐烂）；
 *   ④ `ALLOW` 带复查日，过期即红（避免豁免变成永久关灯键）；
 *   ⑤ 扫描面下界：workflow 文件 ≥ 5、runner 取值 ≥ 20。目录改名 / 正则失配 /
 *      cwd 不对时「0 处违规」不是「全固定」，而是「一处都没判」。
 *
 * 为什么放行 `windows-latest` / `macos-latest`（带复查日）：这两个标签目前没有
 * 公布同类的**破坏性**迁移日，而把它们一起钉死会让 Windows/macOS 的 job 在
 * 镜像换代时静默停在旧镜像上（同样是漂移，只是方向相反）。它们的迁移公告
 * 一旦出现，把对应条目从 ALLOW 里删掉、标签改固定版本即可——守卫会逼你做这件事
 * （条目腐烂即红）。
 *
 * ## 为什么不解析 YAML
 *
 * 零依赖是硬约束（本仓 40+ 守卫都不引 yaml 包）。这里只做「逐行看键 + 取列表项」，
 * 覆盖本仓实际用到的三种写法；解析不到就**结构红**，而不是静默跳过。
 */
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);

/** 允许保留的 `-latest` 标签：理由 + 复查日（过期即红，逼着重新裁决）。 */
const ALLOW = new Map([
  [
    "windows-latest",
    {
      reason: "暂无公布破坏性迁移日的 Windows 镜像标签；钉死反而会在镜像换代时静默停在旧镜像",
      review: "2027-06-30",
    },
  ],
  [
    "macos-latest",
    {
      reason: "同上（macOS 镜像换代暂无破坏性公告）；出现公告后改固定版本并删本条目",
      review: "2027-06-30",
    },
  ],
]);

const MIN_WORKFLOW_FILES = 5;
const MIN_RUNNER_TOKENS = 20;

/** 去掉整行注释与行内注释（`#` 前必须有空白，避免切掉 `#` 作为 yaml 值的场景）。 */
export function stripComments(text) {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("#")) return "";
      const idx = line.search(/\s#/);
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

const RUNNER_TOKEN = /(?:^|[\s[,"'])([a-z][a-z0-9]*(?:-[a-z0-9.]+)+)(?=$|[\s\],"'])/g;

/**
 * 从剥注释后的 workflow 文本里取「runner 取值」。
 * 覆盖：`runs-on: X`、`runs-on: [X, Y]`、matrix 的 `os:` / `runner:` 列表项与行内数组、
 * 以及 `- os: X` 这类列表项里的键值。
 */
export function collectRunnerTokens(text) {
  const out = [];
  const lines = stripComments(text).split("\n");
  let inRunnerKey = false;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.replace(/\r$/, "");
    const keyMatch = line.match(/^\s*(?:-\s*)?(runs-on|os|runner):\s*(.*)$/);
    if (keyMatch) {
      const [, key, value] = keyMatch;
      if (key === "runs-on") {
        // 只取 `runs-on:` 的标量/数组；支持 `${{ matrix.x }}` 时跳过（由 matrix 行覆盖）
        if (value && !value.includes("${{")) {
          for (const m of value.matchAll(RUNNER_TOKEN)) out.push({ line: i + 1, token: m[1] });
        }
        inRunnerKey = !value;
      } else if (key === "os" || key === "runner") {
        if (value && !value.includes("${{")) {
          for (const m of value.matchAll(RUNNER_TOKEN)) out.push({ line: i + 1, token: m[1] });
        }
        inRunnerKey = !value;
      } else {
        inRunnerKey = false;
      }
      continue;
    }
    // 列表项：`- ubuntu-latest` / `- os: ubuntu-latest` / `- runner: ubuntu-latest`
    const listMatch = line.match(/^\s*-\s*(?:(?:os|runner):\s*)?([a-z][a-z0-9]*(?:-[a-z0-9.]+)+)\s*$/);
    if (listMatch && inRunnerKey) {
      out.push({ line: i + 1, token: listMatch[1] });
      continue;
    }
    // 缩进更深或非空行即退出列表态
    if (line.trim() && !/^\s*-\s/.test(line)) inRunnerKey = false;
  }
  return out;
}

function readWorkflows(root) {
  const dir = join(root, ".github", "workflows");
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    return { error: `读不到 ${dir}：${err instanceof Error ? err.message : String(err)}` };
  }
  return {
    files: names
      .filter((n) => /\.ya?ml$/.test(n))
      .sort()
      .map((n) => ({ name: n, text: readFileSync(join(dir, n), "utf8") })),
  };
}

export function check(root, today = new Date()) {
  const problems = [];
  const warnings = [];
  const loaded = readWorkflows(root);
  if (loaded.error) return { problems: [loaded.error], warnings, tokens: 0, files: 0 };

  if (loaded.files.length < MIN_WORKFLOW_FILES) {
    problems.push(
      `扫描面塌方：只找到 ${loaded.files.length} 个 workflow（下界 ${MIN_WORKFLOW_FILES}）——` +
        `目录改名 / cwd 不对时「0 处违规」不是「全固定」`,
    );
  }

  const seenAllowed = new Set();
  let tokens = 0;
  for (const file of loaded.files) {
    for (const { line, token } of collectRunnerTokens(file.text)) {
      tokens += 1;
      if (ALLOW.has(token)) {
        seenAllowed.add(token);
        const { review } = ALLOW.get(token);
        if (new Date(`${review}T23:59:59Z`).getTime() < today.getTime()) {
          problems.push(
            `${file.name}:${line} 豁免已过复查日（${token}，复查 ${review}）——` +
              `重新裁决：要么改固定版本，要么更新 ALLOW 的复查日并写清理由`,
          );
        }
        continue;
      }
      if (token.endsWith("-latest")) {
        problems.push(
          `${file.name}:${line}: runner 用了可变的 \`${token}\`——` +
            `改用固定版本（如 ubuntu-24.04），或在 ALLOW 里登记理由+复查日`,
        );
        continue;
      }
      if (token.startsWith("ubuntu-") && !/^ubuntu-\d{2}\.\d{2}(-arm)?$/.test(token)) {
        problems.push(
          `${file.name}:${line}: \`${token}\` 不是受支持的固定形态（期望 ubuntu-<YY>.<MM>[-arm]）`,
        );
      }
    }
  }

  if (tokens < MIN_RUNNER_TOKENS) {
    problems.push(
      `扫描面塌方：只解析到 ${tokens} 处 runner 取值（下界 ${MIN_RUNNER_TOKENS}）——` +
        `正则失配时不会报「全固定」，必须报结构错`,
    );
  }
  for (const label of ALLOW.keys()) {
    if (!seenAllowed.has(label)) {
      problems.push(
        `ALLOW 里的 \`${label}\` 已没有任何 workflow 使用——豁免腐烂，` +
          `删掉该条目（留着会让下一个人以为它还在被裁决）`,
      );
    }
  }
  return { problems, warnings, tokens, files: loaded.files.length };
}

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "acf-runner-labels-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, ".github", "workflows", name), body, "utf8");
  }
  return root;
}

// 每个 fixture 文件 5 处 runner 取值 × 5 个文件 = 25 ≥ MIN_RUNNER_TOKENS（20），
// 这样用例断言的是「判据本身」，不会被扫描面下界误伤。
const PINNED = `name: t
on: [push]
jobs:
  a:
    runs-on: ubuntu-24.04
  b:
    runs-on: ubuntu-24.04-arm
  c:
    runs-on: windows-latest
  d:
    runs-on: macos-latest
  e:
    runs-on: ubuntu-24.04
`;

function runSelf(argv) {
  const cases = [];
  const base = {
    "a.yml": PINNED,
    "b.yml": PINNED,
    "c.yml": PINNED,
    "d.yml": PINNED,
    "e.yml": PINNED,
  };
  cases.push({
    name: "① 干净树：ubuntu 固定 + 两个 ALLOW 标签 → 绿",
    files: base,
    wantCode: 0,
    wantText: [],
  });
  cases.push({
    name: "② ubuntu-latest → 红，点名 file:line 与标签",
    files: { ...base, "a.yml": PINNED.replace("ubuntu-24.04", "ubuntu-latest") },
    wantCode: 1,
    wantText: ["a.yml:5", "runner 用了可变的 `ubuntu-latest`"],
  });
  cases.push({
    name: "③ 注释里的 ubuntu-latest 不算（剥注释生效）",
    files: { ...base, "a.yml": `# runs-on: ubuntu-latest\n${PINNED}` },
    wantCode: 0,
    wantText: [],
  });
  cases.push({
    name: "④ 未登记的 -latest 标签（如 ubuntu-22.04-latest）→ 红",
    files: { ...base, "b.yml": PINNED.replace("ubuntu-24.04", "ubuntu-22.04-latest") },
    wantCode: 1,
    wantText: ["ubuntu-22.04-latest"],
  });
  cases.push({
    name: "⑤ ubuntu 形态不对（ubuntu-current）→ 红",
    files: { ...base, "c.yml": PINNED.replace("ubuntu-24.04", "ubuntu-current") },
    wantCode: 1,
    wantText: ["ubuntu-current"],
  });
  cases.push({
    name: "⑥ ALLOW 腐烂（没有 windows-latest 了）→ 红",
    files: Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v.replace("windows-latest", "windows-2025")])),
    wantCode: 1,
    wantText: ["豁免腐烂"],
  });
  cases.push({
    name: "⑦ 扫描面塌方（空 workflows 目录）→ 红，而不是「无违规」",
    files: {},
    wantCode: 1,
    wantText: ["扫描面塌方"],
  });

  let pass = 0;
  for (const c of cases) {
    const root = fixture(c.files);
    const r = spawnSync(process.execPath, [SELF, "--root", root], { encoding: "utf8" });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const textOk = c.wantText.every((t) => out.includes(t));
    const codeOk = r.status === c.wantCode;
    if (codeOk && textOk) {
      pass += 1;
      console.log(`  ✔ ${c.name}`);
    } else {
      console.log(`  ✖ ${c.name}\n    exit=${r.status}（期望 ${c.wantCode}）\n    输出：${out.trim()}`);
    }
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`\n${pass}/${cases.length} 条用例通过`);
  return pass === cases.length ? 0 : 1;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    if (argv.includes("--root")) {
      console.error("--selftest 与 --root 不能同时用（自检自己造 fixture 树）");
      return 2;
    }
    return runSelf(argv);
  }
  const rootIdx = argv.indexOf("--root");
  const root = rootIdx === -1 ? process.cwd() : resolve(argv[rootIdx + 1] ?? ".");
  const { problems, tokens, files } = check(root);
  if (problems.length > 0) {
    console.error(`✖ runner 标签守卫失败（${problems.length} 项，扫了 ${files} 个 workflow / ${tokens} 处取值）：`);
    for (const p of problems) console.error(`  · ${p}`);
    console.error("\n修法：把 `-latest` 换成固定版本（ubuntu-24.04 / windows-2025 / macos-15）；");
    console.error("      确需保留的写进 ALLOW 并带理由+复查日；不要关守卫。");
    return 1;
  }
  console.log(
    `✔ runner 标签守卫通过：${files} 个 workflow / ${tokens} 处取值，` +
      `全部为固定版本或已登记豁免（${[...ALLOW.keys()].join(", ")}）。`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SELF)) {
  process.exit(main());
}
