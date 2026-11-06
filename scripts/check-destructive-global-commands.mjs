#!/usr/bin/env node
/**
 * R114（2026-11-06）：**禁止「通配/前缀式破坏性命令」守卫**（多 agent 并行下的互杀源）。
 *
 * ## 为什么
 * R113 实测：`scripts/heartbeat-dispatch-race-selftest.mjs` 启动时 `docker rm -f acf-r16-*`
 * **杀掉了并发实例的活容器** ⇒ 对方 `exit 137`/`No such container`，并让本仓把 1/20 的假违反
 * 误判成"产品残窗"。同类形态还有 `docker system prune -f`、`pkill -f`、`killall`、`rm -rf <通配>`。
 * 这类命令的问题不是"危险"，而是**作用域是全局的、却写在某个具体任务的脚本里**。
 *
 * ## 判据
 * 扫描 `scripts/**`（含子目录）与 `scripts/lib/**` 的 `.mjs/.js/.sh`：命中即红，并**给出精确改法**。
 * 命中形态：`docker rm -f <含 * 或 $(...) 的名字>`、`docker container prune`、`docker system prune`、
 *           `pkill -f`、`killall`、`rm -rf <含 * 的路径>`。
 * 豁免：该行（或上一行）写 `// destructive-global-ok: <≥12 字理由>`，**豁免数每次运行都打印**。
 *
 * 用法：node scripts/check-destructive-global-commands.mjs [--root=<dir>] [--selftest]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

printCoverageBanner(import.meta.url, "subprocess");

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(dirname(HERE), "..");

export const RULES = [
  { id: "docker-rm-glob", re: /docker\s+rm\s+(-f\s+)?[^\n]*(\*|\$\()/ },
  { id: "docker-prune", re: /docker\s+(system|container|image)\s+prune/ },
  { id: "pkill-f", re: /\bpkill\s+-f\b/ },
  { id: "killall", re: /\bkillall\b/ },
  { id: "rm-rf-glob", re: /\brm\s+-[rf]{1,2}\s+[^\n]*\*/ },
];
export const EXEMPT_RE = /destructive-global-ok:\s*(.+)$/;
export const FIX_HINT =
  "改成**只操作自己创建的精确名字**（例如容器名带 `Date.now()`/PID），或先检测并发实例再 `exit 2`；" +
  "确需全局清理就走人工，并在该行写 `// destructive-global-ok: <≥12 字理由>`";

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      walk(abs, out);
    } else if (/\.(mjs|js|sh|bash)$/.test(e.name)) out.push(abs);
  }
  return out;
}

export function check(root = REPO_ROOT) {
  const errors = [];
  const printed = [];
  const files = walk(join(root, "scripts"));
  if (files.length < 20) return [`扫描面塌方：只找到 ${files.length} 个脚本`];
  for (const abs of files) {
    const rel = relative(root, abs).split("\\").join("/");
    const lines = readFileSync(abs, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/^\s*(\*|\/\/|#)/.test(line)) return; // 注释行不判（文档可以提到这些命令）
      if (/id:\s*"[a-z-]+",\s*re:/.test(line)) return; // 判据自身的规则定义行不判（自匹配）
      const hit = RULES.find((r) => r.re.test(line));
      if (!hit) return;
      const exempt = EXEMPT_RE.test(line) || (i > 0 && EXEMPT_RE.test(lines[i - 1]));
      if (exempt) {
        printed.push(`${rel}:${i + 1} 豁免（${hit.id}）`);
        return;
      }
      errors.push(`${rel}:${i + 1} 出现**通配/前缀式破坏性命令**（${hit.id}）：\`${line.trim()}\` ⇒ ${FIX_HINT}`);
    });
  }
  console.log(`（破坏性命令判据：扫描 ${files.length} 个脚本；豁免 ${printed.length} 处）`);
  for (const p of printed) console.log(`   · ${p}`);
  errors.meta = { files: files.length, exempt: printed.length };
  return errors;
}

function runSelftest() {
  const cases = [];
  const push = (name, fn) => cases.push({ name, fn });
  const baseTree = (extra) => {
    const t = {};
    for (let i = 0; i < 25; i += 1) t[`scripts/ok-${i}.mjs`] = "console.log('hello');\n";
    return { ...t, ...extra };
  };
  push("正例控制组：干净脚本 ⇒ exit 0", () => {
    const repo = makeFixtureRepo(baseTree({}));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), { code: 0, withinMs: 20000, label: "正例" });
    } finally { repo.cleanup(); }
  });
  push("反例①：前缀式 docker rm -f ⇒ exit 1 且给出精确改法", () => {
    const repo = makeFixtureRepo(
      baseTree({ "scripts/bad.mjs": 'run("docker", ["rm", "-f", "acf-r16-*"]);\n' }),
    );
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1, contains: ["通配/前缀式破坏性命令", "只操作自己创建的精确名字"], withinMs: 20000, label: "docker rm 通配",
      });
    } finally { repo.cleanup(); }
  });
  push("反例②：豁免行放行且打印", () => {
    const repo = makeFixtureRepo(
      baseTree({ "scripts/ok-exempt.mjs": '// destructive-global-ok: 人工确认全局清理唯一实例\nrun("docker", ["rm", "-f", "acf-x-*"]);\n' }),
    );
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), { code: 0, withinMs: 20000, label: "豁免" });
    } finally { repo.cleanup(); }
  });
  const failed = reportCases(cases, { title: "check-destructive-global-commands selftest" });
  process.exit(failed === 0 ? 0 : 1);
}

function main(argv) {
  const eq = argv.find((a) => a.startsWith("--root="));
  const errors = check(eq ? resolve(eq.slice("--root=".length)) : REPO_ROOT);
  if (errors.length === 0) {
    console.log(`✔ 无通配/前缀式破坏性命令：${errors.meta?.files ?? 0} 个脚本（豁免 ${errors.meta?.exempt ?? 0} 处已打印）。`);
    return 0;
  }
  console.error(`✘ 破坏性命令判据：${errors.length} 项`);
  for (const e of errors) console.error(`   · ${e}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) {
  process.exit(process.argv.includes("--selftest") ? runSelftest() : main(process.argv.slice(2)));
}
