#!/usr/bin/env node
/**
 * EXECUTOR-SHELL-RUNTIME：镜像必须带 shell runtime 实际使用的 bash。
 *
 * 事实链（主控 CodeGraph 已确证）：
 *   · apps/executor-node/Dockerfile 运行时基底是 node:24-alpine（busybox sh，无 bash）；
 *   · apps/executor-node/src/routes/execute.ts:2849 POSIX 分支硬编码 `cmd = 'bash'`；
 *   · apps/executor-python/routers/execute.py:1226 硬编码 `['bash', '-c', ...]`；
 *   · 后果：shell 任务派到 executor-node 后 spawn bash ENOENT/exit 127。
 *
 * 修法取向：给 alpine 运行时装 bash（保持两端 bash 语义一致），不退到 sh，
 * 也不少报 shell 能力（少报会让任务永远派不过来，更难排查）。
 *
 * 判据：
 *   ① 解析 Dockerfile，定位最后一个 FROM（运行时 stage），只看其后的 RUN 指令，
 *      必须有未落在注释里的 `apk add ... bash`；builder stage 装包不算数。
 *   ② 两端 shell 命令仍锚定 bash（剥注释后匹配）：node `cmd = 'bash'`、
 *      python `['bash', '-c', ...]`。任一改成 sh ⇒ 红，防 parity 漂移。
 *   ③ 结构红反永真：文件读不到 / 无 FROM / 运行时 stage 为空 / 锚点文件缺失
 *      ⇒ exit 1 点名原因，绝不静默判绿。
 *
 * 用法：`node scripts/check-executor-shell-runtime.mjs [--root <dir>] [--selftest]`
 * `--selftest` 用内存夹具 + 临时目录，真子进程 CLI 黑盒，5 例。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { expectExit, runGuard } from "./lib/guard-selftest.mjs";

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SELF), "..");

const DOCKERFILE_REL = "apps/executor-node/Dockerfile";
const NODE_REL = "apps/executor-node/src/routes/execute.ts";
const PY_REL = "apps/executor-python/routers/execute.py";

const NODE_ANCHOR = /\bcmd\s*=\s*['"]([^'"]+)['"]\s*;/;
const NODE_ARGS_RE = /\bargs\s*=\s*\[([^\]]*)\]/;
const NODE_BASH_BRANCH_RE =
  /\bcmd\s*=\s*['"]([^'"]+)['"]\s*;[\s\S]{0,240}?\bargs\s*=\s*\[([^\]]*)\]/g;
const PY_ANCHOR =
  /return\s*\[\s*(['"])([^'"]+)\1\s*,\s*(['"])-c\3\s*,\s*(['"])(.*?)\4\s*,\s*(['"])([^'"]+)\6\s*,\s*str\(work_dir\)\s*,\s*entrypoint\s*\]/;
const NODE_FALLBACK = /\bcmd\s*=/;
const PY_FALLBACK = /return\s*\[/;
const NODE_SH = /\bcmd\s*=\s*['"](?:sh|sh\b[^'"]*)['"]/;
const PY_SH = /\[\s*['"](?:sh|sh\b[^'"]*)['"]\s*,\s*['"]-c['"]\s*,/;
const POSITIONAL_SCRIPT_RE = /cd\s+"\$1"\s*&&\s*exec\s+"\$2"/;

/** 把注释字符替换成空格，保留行号；字符串/模板字面量里的 // 不当注释。 */
export function stripJsCommentsKeepLines(text) {
  let out = "";
  let state = "code";
  let i = 0;
  const s = String(text ?? "");
  while (i < s.length) {
    const ch = s[i];
    const next = s[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") {
        out += "  ";
        i += 2;
        state = "line";
        continue;
      }
      if (ch === "/" && next === "*") {
        out += "  ";
        i += 2;
        state = "block";
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        out += ch;
        state = ch;
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (state === "line") {
      if (ch === "\n") {
        out += "\n";
        state = "code";
      } else {
        out += " ";
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        out += "  ";
        i += 2;
        state = "code";
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    // 字符串态：保留原字符，转义对原样吞掉。
    if (ch === "\\") {
      out += ch + (next ?? "");
      i += 2;
      continue;
    }
    out += ch;
    if (ch === state) state = "code";
    i += 1;
  }
  return out;
}

/** 把 Python # 注释替换成空格，保留行号；字符串（含三引号）里的 # 不当注释。 */
export function stripPyCommentsKeepLines(text) {
  let out = "";
  let quote = null;
  let i = 0;
  const s = String(text ?? "");
  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\") {
        out += ch + (s[i + 1] ?? "");
        i += 2;
        continue;
      }
      out += ch;
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "#") {
      while (i < s.length && s[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      // 三引号文档字符串是文档不是代码：整段抹成空格（保留行号），
      // 免得 `_build_shell_cmd` docstring 里的旧 `['bash', '-c', ...]` 抢先命中。
      if (s.startsWith(ch.repeat(3), i)) {
        out += "   ";
        i += 3;
        while (i < s.length) {
          if (s.startsWith(ch.repeat(3), i)) {
            out += "   ";
            i += 3;
            break;
          }
          out += s[i] === "\n" ? "\n" : " ";
          i += 1;
        }
        continue;
      }
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Dockerfile 行级指令解析（跳过整行注释；`\` 续行合并），保留起始行号。 */
export function parseDockerInstructions(text) {
  const instructions = [];
  let pending = null;
  const lines = String(text ?? "").split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const raw = lines[idx];
    if (!pending) {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      pending = { line: idx + 1, lines: [] };
    }
    pending.lines.push(raw);
    if (!/\\\s*$/.test(raw)) {
      instructions.push({ line: pending.line, text: pending.lines.join("\n") });
      pending = null;
    }
  }
  if (pending) instructions.push({ line: pending.line, text: pending.lines.join("\n") });
  return instructions;
}

function instructionParts(inst) {
  const m = /^\s*([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(inst.text);
  return m ? { opcode: m[1].toUpperCase(), args: m[2] ?? "" } : { opcode: "", args: "" };
}

/** Dockerfile RUN 命令归一化：`\` 续行拼成一条完整指令。 */
export function normalizeDockerContinuation(text) {
  return String(text ?? "").replace(/\\\r?\n\s*/g, " ");
}

/**
 * 剥 RUN 命令里的 shell 注释；`blankQuotes` 时连引号内文本一起抹掉，
 * 免得 `echo "apk add bash"` 被误判成真的装包。保留换行以便逐行诊断。
 */
export function stripDockerComment(text, { blankQuotes = false } = {}) {
  let out = "";
  let quote = null;
  let escaped = false;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (escaped) {
      out += blankQuotes ? " " : ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += blankQuotes ? " " : ch;
      escaped = true;
      continue;
    }
    if (quote) {
      out += ch === "\n" ? "\n" : blankQuotes ? " " : ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += blankQuotes ? " " : ch;
      continue;
    }
    if (ch === "#") {
      while (i < s.length && s[i] !== "\n") {
        out += " ";
        i += 1;
      }
      i -= 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function stripQuotes(value) {
  return String(value ?? "").trim().replace(/^["']|["']$/g, "");
}

/** 收集 Dockerfile 里可静态求值的 ARG/ENV，供 `$VAR` 包名解析。 */
export function parseDockerEnv(instructions) {
  const env = new Map();
  for (const inst of instructions) {
    const { opcode, args } = instructionParts(inst);
    if (opcode !== "ARG" && opcode !== "ENV") continue;
    const body = stripDockerComment(normalizeDockerContinuation(args)).trim();
    for (const token of body.split(/\s+/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
      if (m) env.set(m[1], stripQuotes(m[2]));
    }
    if (opcode === "ENV" && !body.includes("=")) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/.exec(body);
      if (m) env.set(m[1], stripQuotes(m[2]));
    }
  }
  return env;
}

/**
 * 判一条 RUN 是否真的 `apk add ... bash`。
 * 返回 { hasBash, unresolvedVar, swallowed, nearMiss }；
 * 变量包无法静态解析成 bash 时 unresolvedVar 非空 ⇒ 调用方按结构红处理。
 */
export function analyzeApkRun(inst, env = new Map()) {
  const { opcode, args } = instructionParts(inst);
  const result = { hasBash: false, unresolvedVar: null, swallowed: false, nearMiss: null };
  if (opcode !== "RUN") return result;
  const command = stripDockerComment(normalizeDockerContinuation(args), { blankQuotes: true });
  const parts = command.split(/(&&|\|\||;|\|)/);
  for (let p = 0; p < parts.length; p += 2) {
    const tokens = parts[p]
      .trim()
      .split(/\s+/)
      .filter((t) => t && t !== "\\");
    const apkIdx = tokens.findIndex((t) => /(?:^|\/)apk$/.test(t));
    if (apkIdx < 0) continue;
    let i = apkIdx + 1;
    while (i < tokens.length && tokens[i].startsWith("-")) i += 1;
    if (tokens[i] !== "add") continue;
    let hasBash = false;
    let unresolvedVar = null;
    let nearMiss = null;
    for (i += 1; i < tokens.length; i += 1) {
      const t = tokens[i];
      if (t.startsWith("-")) continue;
      if (/^bash(?:=|@|$)/.test(t)) {
        hasBash = true;
        break;
      }
      if (/^bash[-_]/.test(t) && !nearMiss) nearMiss = t;
      const vm = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(t);
      if (vm) {
        const value = env.get(vm[1]);
        if (value && /^bash(?:=|@|$)/.test(value.split(/\s+/)[0])) hasBash = true;
        else unresolvedVar = `$${vm[1]}`;
      }
    }
    if (!hasBash && !unresolvedVar) {
      if (nearMiss) result.nearMiss = nearMiss;
      continue;
    }
    // `apk add bash || true` / `; true` 把失败吞掉：镜像里可能根本没装上 bash。
    const delimiter = parts[p + 1];
    const next = parts[p + 2] ?? "";
    if ((delimiter === "||" || delimiter === ";") && /^\s*(?:true|:)(?:\s|$)/.test(next)) {
      result.swallowed = true;
      continue;
    }
    if (unresolvedVar) {
      result.unresolvedVar = unresolvedVar;
      continue;
    }
    return { ...result, hasBash: true };
  }
  return result;
}

/** 兼容旧调用的布尔包装。 */
export function hasApkAddBash(inst, env) {
  return analyzeApkRun(inst, env).hasBash;
}

function basenameOf(spec) {
  const s = stripQuotes(spec);
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1];
}

function lineOfFirst(lines, re) {
  const idx = lines.findIndex((line) => re.test(line));
  return idx >= 0 ? idx + 1 : null;
}

function lineOf(lines, re, fallback = 1) {
  return lineOfFirst(lines, re) ?? fallback;
}

function lineAt(text, offset) {
  return String(text ?? "").slice(0, offset).split("\n").length;
}

/** node：解析真实 argv 结构，而不是裸 includes。 */
function checkNodeShell(stripped, problems) {
  const lines = stripped.split(/\r?\n/);
  const line = lineOf(lines, NODE_FALLBACK);
  let branch = null;
  for (const candidate of stripped.matchAll(NODE_BASH_BRANCH_RE)) {
    if (basenameOf(candidate[1]) === "bash") {
      branch = candidate;
      break;
    }
  }
  if (!branch) {
    problems.push(
      `${NODE_REL}:${line}: 未找到 \`cmd = ...; args = [...]\` shell 分支结构` +
        `${NODE_SH.test(stripped) ? "（检测到 sh —— sh 会静默改变脚本语义，必须恢复 bash parity）" : ""}`,
    );
    return null;
  }
  const cmdLine = lineAt(stripped, branch.index);
  const cmd = basenameOf(branch[1]);
  if (cmd !== "bash") {
    problems.push(
      `${NODE_REL}:${cmdLine}: shell 分支 cmd basename=${JSON.stringify(cmd)}，必须是 bash` +
        `${NODE_SH.test(stripped) ? "（检测到 sh —— sh 会静默改变脚本语义）" : ""}`,
    );
    return null;
  }
  if (!/\bactualEntrypoint\b/.test(branch[2])) {
    problems.push(
      `${NODE_REL}:${cmdLine}: args 未包含 entrypoint（实际 \`${branch[2].trim()}\`）—— shell 分支语义漂移`,
    );
    return null;
  }
  const safeLine = lineOfFirst(lines, /SHELL_ENTRYPOINT_SAFE_RE\s*=\s*\/\^/);
  if (safeLine === null || !/\$\/\s*;/.test(lines[safeLine - 1])) {
    problems.push(
      `${NODE_REL}:${safeLine ?? cmdLine}: SHELL_ENTRYPOINT_SAFE_RE 必须是 anchored 正则 /^...$/（不许放宽 entrypoint 白名单）`,
    );
    return null;
  }
  return cmdLine;
}

/** python：解析 argv[0] / -c 脚本 / 位置参数 / fullmatch，而不是裸 includes。 */
function checkPythonShell(stripped, problems) {
  const lines = stripped.split(/\r?\n/);
  const m = PY_ANCHOR.exec(stripped);
  const line = m ? lineAt(stripped, m.index) : lineOf(lines, PY_FALLBACK);
  if (!m) {
    problems.push(
      `${PY_REL}:${line}: 未找到 \`['bash', '-c', ..., str(work_dir), entrypoint]\` argv 结构` +
        `${PY_SH.test(stripped) ? "（检测到 sh —— sh 会静默改变脚本语义，必须恢复 bash parity）" : ""}`,
    );
    return null;
  }
  const cmd = basenameOf(m[2]);
  const script = m[5];
  const argv0 = basenameOf(m[7]);
  let ok = true;
  if (cmd !== "bash") {
    problems.push(
      `${PY_REL}:${line}: argv[0] basename=${JSON.stringify(cmd)}，必须是 bash` +
        `${PY_SH.test(stripped) ? "（检测到 sh —— sh 会静默改变脚本语义）" : ""}`,
    );
    ok = false;
  }
  if (argv0 !== "bash") {
    problems.push(`${PY_REL}:${line}: \`bash -c\` 后的 argv[0] basename=${JSON.stringify(argv0)}，必须是 bash`);
    ok = false;
  }
  if (!POSITIONAL_SCRIPT_RE.test(script)) {
    problems.push(
      `${PY_REL}:${line}: 必须保留 \`cd "$1" && exec "$2"\` 位置参数形态（实际 \`${script}\`）`,
    );
    ok = false;
  }
  const fullLine = lineOfFirst(lines, /_SHELL_ENTRYPOINT_SAFE_RE\.fullmatch\(entrypoint\)/);
  if (fullLine === null) {
    problems.push(
      `${PY_REL}:${line}: 找不到 \`_SHELL_ENTRYPOINT_SAFE_RE.fullmatch(entrypoint)\`（不许退化成 \`match\`）`,
    );
    ok = false;
  }
  return ok ? line : null;
}

/** 主判据：返回 { ok, problems, structural }。 */
export function checkRepo(root) {
  const problems = [];
  const texts = {};
  for (const rel of [DOCKERFILE_REL, NODE_REL, PY_REL]) {
    try {
      texts[rel] = readFileSync(join(root, rel), "utf8");
    } catch (err) {
      problems.push(`${rel}:1: 结构红：读不到 ${rel}（${err.message}）—— 判据面失效，不许判绿。`);
    }
  }
  if (problems.length > 0) return { ok: false, problems, structural: true };

  const instructions = parseDockerInstructions(texts[DOCKERFILE_REL]);
  const dockerEnv = parseDockerEnv(instructions);
  if (instructions.length === 0) {
    problems.push(`${DOCKERFILE_REL}:1: 结构红：Dockerfile 为空或全是注释/空行 —— 判据面失效。`);
  } else {
    const fromIndices = instructions
      .map((inst, idx) => (instructionParts(inst).opcode === "FROM" ? idx : -1))
      .filter((idx) => idx >= 0);
    if (fromIndices.length === 0) {
      problems.push(`${DOCKERFILE_REL}:1: 结构红：找不到 FROM 指令 —— 无法定位运行时 stage。`);
    } else {
      const lastFromIdx = fromIndices[fromIndices.length - 1];
      const lastFrom = instructions[lastFromIdx];
      const runtime = instructions.slice(lastFromIdx + 1);
      if (runtime.length === 0) {
        problems.push(
          `${DOCKERFILE_REL}:${lastFrom.line}: 结构红：最后一个 FROM 之后没有任何指令（运行时 stage 为空）。`,
        );
      } else {
        const analyses = runtime.map((inst) => ({ inst, info: analyzeApkRun(inst, dockerEnv) }));
        const unresolved = analyses.find((a) => a.info.unresolvedVar);
        const swallowed = analyses.find((a) => a.info.swallowed);
        const withBash = analyses.find((a) => a.info.hasBash);
        if (unresolved) {
          problems.push(
            `${DOCKERFILE_REL}:${unresolved.inst.line}: 结构红：\`apk add ... ${unresolved.info.unresolvedVar}\`` +
              ` 无法静态解析为独立 bash 包（ARG/ENV 里没有可证赋值）—— 不许把不可证的包名当已安装。`,
          );
        } else if (withBash) {
          texts.__dockerLine = withBash.inst.line;
        } else {
          const builderBash = instructions
            .slice(0, lastFromIdx)
            .some((inst) => analyzeApkRun(inst, dockerEnv).hasBash);
          const nearMiss = analyses.find((a) => a.info.nearMiss)?.info.nearMiss;
          const detail = swallowed
            ? "（\`apk add ... bash\` 后用 \`|| true\` / \`; true\` 吞掉了失败，镜像里可能没有 bash）"
            : nearMiss
              ? `（发现近似包名 \`${nearMiss}\`，不是独立 bash 包）`
              : builderBash
                ? "（只在 builder stage 装 bash 不算：运行时镜像里没有）"
                : "（alpine 默认无 bash，shell 任务会 spawn bash 失败）";
          problems.push(
            `${DOCKERFILE_REL}:${runtime[0].line}: 运行时 stage（最后一个 FROM 在第 ${lastFrom.line} 行）` +
              `没有可证的 \`apk add ... bash\`${detail}`,
          );
        }
      }
    }
  }

  const nodeStripped = stripJsCommentsKeepLines(texts[NODE_REL]);
  const pyStripped = stripPyCommentsKeepLines(texts[PY_REL]);
  const nodeLine = checkNodeShell(nodeStripped, problems);
  const pyLine = checkPythonShell(pyStripped, problems);

  if (problems.length > 0) return { ok: false, problems, structural: false };
  return {
    ok: true,
    problems: [],
    structural: false,
    message:
      `✔ executor shell runtime：${DOCKERFILE_REL}:${texts.__dockerLine} 运行时 stage 已装 bash；` +
      `${NODE_REL}:${nodeLine} / ${PY_REL}:${pyLine} 均使用 bash。`,
  };
}

/* ────────────────────────── selftest（真子进程 + 临时夹具） ─────────────────── */

const DIGEST = "node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85";

function fixtureDocker(bashAt = "runtime", runtimeBashLine = "RUN apk add --no-cache bash") {
  const builderBash = bashAt === "builder" ? "RUN apk add --no-cache bash\n" : "";
  const runtimeBash = bashAt === "runtime" ? `${runtimeBashLine}\n` : "";
  return [
    `FROM ${DIGEST} AS builder`,
    "WORKDIR /app",
    builderBash.trimEnd(),
    "RUN npm ci",
    "RUN npm run build",
    "",
    `FROM ${DIGEST}`,
    "WORKDIR /app",
    "RUN npm ci --omit=dev",
    runtimeBash.trimEnd(),
    "COPY --from=builder /app/dist ./dist",
    "USER appuser",
    'CMD ["node", "dist/main.js"]',
    "",
  ]
    .filter((line, idx, arr) => line !== "" || idx === 5)
    .join("\n");
}

// 注释里的 sh 是诱饵：剥注释后必须只看到 bash 锚点。
const FIXTURE_NODE = [
  "// 注释诱饵：// cmd = 'sh';",
  "export const SHELL_ENTRYPOINT_SAFE_RE = /^safe+$/;",
  "function spawnShell() {",
  "  cmd = 'bash';",
  "  args = [actualEntrypoint];",
  "}",
  "",
].join("\n");

const FIXTURE_PY = [
  "# 注释诱饵：# return ['sh', '-c', ...]",
  "def _validate_shell_entrypoint(entrypoint):",
  "    if not _SHELL_ENTRYPOINT_SAFE_RE.fullmatch(entrypoint):",
  "        raise ValueError('bad entrypoint')",
  "",
  "def _shell_command():",
  '    return [\'bash\', \'-c\', \'cd "$1" && exec "$2"\', \'bash\', str(work_dir), entrypoint]',
  "",
].join("\n");

function makeFixture({ docker = fixtureDocker(), node = FIXTURE_NODE, py = FIXTURE_PY } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "acf-executor-shell-"));
  try {
    for (const [rel, body] of [
      [DOCKERFILE_REL, docker],
      [NODE_REL, node],
      [PY_REL, py],
    ]) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    return dir;
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

function runSelftest() {
  const cases = [];
  const add = (name, fn) => cases.push({ name, fn });
  const blackbox = (name, overrides, expectations) =>
    add(name, () => {
      const dir = makeFixture(overrides);
      try {
        expectExit(runGuard(SELF, { args: ["--root", dir], timeoutMs: 10_000 }), {
          withinMs: 10_000,
          label: name,
          ...expectations,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

  blackbox("① 完整夹具 ⇒ exit 0", {}, {
    code: 0,
    contains: ["运行时 stage 已装 bash", "execute.ts:", "execute.py:"],
    absent: ["✖"],
  });
  blackbox("② 运行时 stage 删掉 apk add bash ⇒ exit 1 点名 Dockerfile:line", {
    docker: fixtureDocker("none"),
  }, {
    code: 1,
    contains: ["Dockerfile:", "运行时 stage", "apk add ... bash"],
  });
  blackbox("③ 只在 builder stage 加 bash ⇒ exit 1（builder 不算运行时）", {
    docker: fixtureDocker("builder"),
  }, {
    code: 1,
    contains: ["Dockerfile:", "只在 builder stage 装 bash 不算"],
  });
  blackbox("④ node 端改成 sh ⇒ exit 1 点名 execute.ts:line", {
    node: FIXTURE_NODE.replace("cmd = 'bash';", "cmd = 'sh';"),
  }, {
    code: 1,
    contains: ["execute.ts:", "检测到 sh", "shell 分支"],
  });
  blackbox("⑤ python 端改成 sh ⇒ exit 1 点名 execute.py:line", {
    py: FIXTURE_PY.replace("['bash', '-c'", "['sh', '-c'"),
  }, {
    code: 1,
    contains: ["execute.py:", "argv[0] basename", "检测到 sh"],
  });
  blackbox("⑥ runtime 的 apk add bash 后跟 `|| true` ⇒ exit 1（吞失败不算装成功）", {
    docker: fixtureDocker("runtime", "RUN apk add --no-cache bash || true"),
  }, {
    code: 1,
    contains: ["Dockerfile:", "吞掉了失败"],
  });
  blackbox("⑦ runtime 只装 bash-completion 近似名 ⇒ exit 1（不是独立 bash 包）", {
    docker: fixtureDocker("runtime", "RUN apk add --no-cache bash-completion"),
  }, {
    code: 1,
    contains: ["Dockerfile:", "bash-completion", "近似包名"],
  });

  let failed = 0;
  for (const c of cases) {
    try {
      c.fn();
      console.log(`✔ ${c.name}`);
    } catch (err) {
      failed += 1;
      console.error(`✘ ${c.name}`);
      console.error(err instanceof Error ? err.message : String(err));
    }
  }
  console.log(`executor shell runtime 自检 ${cases.length - failed}/${cases.length} 通过`);
  return failed === 0 ? 0 : 1;
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes("--selftest")) return runSelftest();
  const rootIdx = argv.indexOf("--root");
  const rootArg = rootIdx >= 0 ? argv[rootIdx + 1] : undefined;
  if (rootIdx >= 0 && (!rootArg || rootArg.startsWith("--"))) {
    console.error("✖ --root 需要一个目录路径");
    return 1;
  }
  const root = rootArg ? resolve(rootArg) : REPO_ROOT;
  if (!existsSync(root)) {
    console.error(`✖ --root 指向的目录不存在：${root}`);
    return 1;
  }
  const result = checkRepo(root);
  if (!result.ok) {
    console.error(`✖ executor shell runtime 守卫失败（退出码 1${result.structural ? "，结构红" : ""}）：`);
    for (const problem of result.problems) console.error(`  · ${problem}`);
    return 1;
  }
  console.log(result.message);
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(main());
}
