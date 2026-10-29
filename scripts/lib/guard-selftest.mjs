#!/usr/bin/env node
/**
 * 守卫 selftest 共享 harness（零依赖）。
 *
 * ## 为什么需要它
 *
 * 第 4 轮守卫自检审计（T4）实测：40+ 个 `scripts/check-*.mjs` 的 `--selftest`
 * 质量参差。多数只断言「不抛」——即把守卫的核心函数抽出来、喂一份内存 fixture、
 * `assert(x.length === 2)`，然后打印 OK。这类 selftest 有一个共同的失效模式：
 * **它测的是函数，不是守卫**。真正会坏的东西不在函数里：
 *
 *   · CLI 入口的 `process.exit(1)` 被删掉 / 改错 → 判据算对了但退出码恒 0，
 *     CI 全绿（这是最贵的一种「假绿」：报告在说话，闸不关门）；
 *   · 报错文本改了两个字符 → 依赖文本的接线/文档从此失配，没人发现；
 *   · 参数解析（`--root` 之类）把路径吃掉 → 扫的是空目录，「0 条 = 没问题」；
 *   · selftest 自己抄了一份判据（`check-index-drift` 的 `assertSubset` 就是
 *     先例：手抄副本与被测代码各自演化，副本绿 ≠ 守卫绿）。
 *
 * 所以本 harness 的立场是：**selftest 必须把守卫当黑盒跑子进程**，断言
 * ①退出码 ②关键报错文本 ③这些文本在「该绿」的树上不出现。任何一条断言都必须
 * **有本事失败**——`expectExit` 抛错而不是返回 false，就是为了让「忘了检查返回值」
 * 这种写法无法静默通过。
 *
 * ## API
 *
 *   runGuard(scriptPath, { args, cwd, env, timeoutMs })
 *     → { code, stdout, stderr, signal, timedOut, durationMs, script, argv, cwdName }
 *     用 `spawnSync(process.execPath, [script, ...args])` 跑**真脚本**。
 *     · 默认 cwd = 仓库根（由本文件位置推出，不依赖调用方的 cwd）；
 *     · 脚本不存在时**立即抛错**（而不是让 node 回一句 MODULE_NOT_FOUND，
 *       那种失败信息会被误读成「守卫崩了」）；
 *     · `code` 为 `null` 表示没正常退出（超时被杀 / 被信号打断），
 *       `timedOut` 单独给出布尔，别用 `code === null` 猜。
 *
 *   expectExit(result, { code, contains, absent, withinMs, label })
 *     → result（成功时原样返回，便于链式）；失败时**抛带可读 diff 的 Error**。
 *     · `code`：`0|1` 或数组（必须显式给，缺省即抛——空断言等于没断言）；
 *     · `contains`：string | string[]，stdout+stderr 合并面里必须出现；
 *     · `absent`：string | string[]，出现即失败（用于「该绿的树不许报红」）；
 *     · `withinMs`：该用例耗时上限（默认不设；三条迁移守卫用它钉 `<1s`）；
 *     · `label`：失败信息里的用例名。
 *
 *   makeFixtureRepo(files, { prefix })
 *     → { dir, cleanup() }
 *     在 `mkdtempSync` 里造最小树。`files` 是 `{ "相对路径": 内容 }`（内容非
 *     string 时按 JSON 写，方便造 package.json）。`cleanup()` 幂等。
 *
 *   reportCases([{ name, fn }], { title })
 *     → failed 条数；`fn` 抛错即判该条红。统一 ✔/✘ 输出与汇总行。
 *
 *   REPO_ROOT
 *     → 仓库根绝对路径（本文件位于 `<repo>/scripts/lib/`）。
 *
 * ## 自检
 *
 *   node scripts/lib/guard-selftest.selftest.mjs
 *
 * harness 自己的每条断言都被反证过（见该文件用例名：退出码不符 / contains 缺失 /
 * absent 命中 / 超时 / 脚本不存在 / fixture 清理），且带一条正例控制组——否则
 * 「expectExit 永远抛」也能让全部负例通过。
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 仓库根：`<repo>/scripts/lib/guard-selftest.mjs` 往上两级。 */
export const REPO_ROOT = resolve(HERE, "..", "..");

const DEFAULT_TIMEOUT_MS = 20_000;
const OUTPUT_TAIL = 2_000;

const toArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

function tail(text) {
  const s = String(text ?? "");
  if (s.length <= OUTPUT_TAIL) return s.trimEnd();
  return `…（前 ${s.length - OUTPUT_TAIL} 字符已省略）\n` + s.slice(-OUTPUT_TAIL).trimEnd();
}

function indent(text, pad = "    ") {
  return String(text ?? "")
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

function firstLineContaining(output, needle) {
  for (const line of String(output ?? "").split("\n")) {
    if (line.includes(needle)) return line;
  }
  return null;
}

function describeTarget(result) {
  const rel = result.script.replace(REPO_ROOT + sep, "").replace(/\\/g, "/");
  return `${rel}${result.argv.length ? " " + result.argv.join(" ") : ""}`;
}

/**
 * 跑一个守卫脚本（真子进程）。
 *
 * @param {string} scriptPath 守卫脚本路径（相对路径按本进程 cwd 解析）
 * @param {{args?: string[], cwd?: string, env?: Record<string,string>, timeoutMs?: number}} [options]
 * @returns {{code: number|null, stdout: string, stderr: string, signal: string|null,
 *            timedOut: boolean, durationMs: number, script: string, argv: string[],
 *            cwdPath: string, timeoutMs: number}}
 */
export function runGuard(scriptPath, options = {}) {
  const { args = [], cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const script = resolve(String(scriptPath));
  if (!existsSync(script)) {
    throw new Error(
      `[guard-selftest] 守卫脚本不存在：${script}\n` +
        `  检查路径拼写；若用例需要「被改坏的守卫」，请先复制到 fixture 目录再跑。`,
    );
  }
  const cwdPath = cwd ? resolve(cwd) : REPO_ROOT;
  if (!existsSync(cwdPath)) {
    throw new Error(`[guard-selftest] cwd 不存在：${cwdPath}`);
  }
  const argv = args.map(String);
  const started = Date.now();
  const child = spawnSync(process.execPath, [script, ...argv], {
    cwd: cwdPath,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;

  const errCode = child.error?.code;
  if (errCode && errCode !== "ETIMEDOUT") {
    throw new Error(
      `[guard-selftest] 子进程启动失败（${errCode}）：${errCode === "ENOBUFS" ? "输出超过 16MB，疑似死循环打印" : child.error.message}`,
    );
  }

  return {
    code: typeof child.status === "number" ? child.status : null,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    signal: child.signal ?? null,
    timedOut: errCode === "ETIMEDOUT",
    durationMs,
    script,
    argv,
    cwdPath,
    timeoutMs,
  };
}

/**
 * 断言一次守卫运行的**观测面**（退出码 + 文本）。失败即抛错。
 *
 * 抛出的错误里带上被跑的命令、cwd 和输出尾部——selftest 失败时不需要再去
 * 手跑一遍才知道发生了什么。
 */
export function expectExit(result, expectations = {}) {
  const { code, contains = [], absent = [], withinMs, label } = expectations;

  if (code === undefined) {
    throw new Error(
      "[guard-selftest] expectExit 必须显式传 code（0/1）——不传 code 的断言是空断言。",
    );
  }
  const expectedCodes = toArray(code);
  if (expectedCodes.length === 0 || expectedCodes.some((c) => !Number.isInteger(c))) {
    throw new Error(`[guard-selftest] expectExit.code 必须是非空整数数组，收到 ${JSON.stringify(code)}`);
  }

  const output = `${result.stdout}${result.stderr}`;
  const problems = [];

  if (result.timedOut) {
    problems.push(
      `守卫超时：>${result.timeoutMs}ms 后被 SIGKILL（期望退出码 ${expectedCodes.join(" 或 ")}）`,
    );
  } else if (!expectedCodes.includes(result.code)) {
    problems.push(`退出码 ${result.code}（期望 ${expectedCodes.join(" 或 ")}）`);
  }

  for (const needle of toArray(contains)) {
    if (!output.includes(String(needle))) {
      problems.push(`输出缺少片段 ${JSON.stringify(String(needle))}`);
    }
  }

  for (const needle of toArray(absent)) {
    const hit = firstLineContaining(output, String(needle));
    if (hit !== null) {
      problems.push(`输出不该出现 ${JSON.stringify(String(needle))}，但命中了：${hit.trim()}`);
    }
  }

  if (typeof withinMs === "number" && result.durationMs > withinMs) {
    problems.push(`耗时 ${result.durationMs}ms 超过上限 ${withinMs}ms`);
  }

  if (problems.length === 0) return result;

  const title = label ? `「${label}」` : "";
  throw new Error(
    [
      `守卫断言失败${title}：${describeTarget(result)}`,
      `  cwd: ${result.cwdPath}`,
      ...problems.map((p) => `  ✘ ${p}`),
      "  ——— stdout ———",
      indent(tail(result.stdout) || "(空)"),
      "  ——— stderr ———",
      indent(tail(result.stderr) || "(空)"),
      "  —————————————",
    ].join("\n"),
  );
}

/**
 * 在临时目录里造最小仓库树。
 *
 * @param {Record<string, string|object>} files 相对路径 → 内容（非 string 走 JSON）
 * @param {{prefix?: string}} [options]
 * @returns {{dir: string, cleanup: () => void, pathOf: (rel: string) => string}}
 */
export function makeFixtureRepo(files = {}, options = {}) {
  const { prefix = "guard-fixture-" } = options;
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  let cleaned = false;

  const pathOf = (rel) => {
    const abs = resolve(dir, String(rel));
    if (abs !== dir && !abs.startsWith(dir + sep)) {
      throw new Error(`[guard-selftest] fixture 路径越界：${rel}`);
    }
    return abs;
  };

  for (const [rel, content] of Object.entries(files)) {
    const abs = pathOf(rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }

  return {
    dir,
    pathOf,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * 统一跑一批用例并打印 ✔/✘ + 汇总；返回失败条数。
 *
 * @param {{name: string, fn: () => unknown}[]} cases
 * @param {{title?: string}} [options]
 * @returns {number} failed
 */
export function reportCases(cases, options = {}) {
  const { title } = options;
  let failed = 0;
  for (const [index, c] of cases.entries()) {
    try {
      c.fn();
      console.log(`  ✔ ${c.name}`);
    } catch (error) {
      failed += 1;
      console.error(`  ✘ ${c.name}`);
      console.error(indent(error?.message ?? String(error), "      "));
    }
    if (index === cases.length - 1) console.log("");
  }
  if (failed > 0) {
    console.error(
      `✖ ${title ?? "selftest"} 失败：${failed}/${cases.length} 条用例未按预期（每条用例都必须能失败，别把判据改宽）`,
    );
  } else {
    console.log(`✔ ${title ?? "selftest"} 通过：${cases.length}/${cases.length} 条用例`);
  }
  return failed;
}
