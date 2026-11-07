#!/usr/bin/env node
/**
 * 事件写入的**尺寸上限之间的一致性**守卫。
 *
 * ## 为什么需要这条（候选 N13）
 *
 * 我们有三条尺寸约束：
 * - `AGENT_EVENT_BATCH_MAX = 32`（一批最多多少条事件）
 * - `AGENT_EVENT_BODY_MAX_BYTES = 2048`（单条正文上限，实体侧）
 * - `AGENT_EVENT_BATCH_MAX_BYTES = 256 * 1024`（一批的字节上限）
 *
 * 批字节上限的**推导**写在 `agent-session.service.ts` 的注释里：
 * 「≥ 32 条 × 2 KiB × 转义最坏倍数（约 2 倍）仍有余量」。
 *
 * ⚠ **问题**：这个推导是**单向依赖**——它依赖 `AGENT_EVENT_BATCH_MAX` 与
 * `AGENT_EVENT_BODY_MAX_BYTES` 的取值，但**没有任何东西钉住它**：
 * 若将来有人把单条正文上限从 2 KiB 调到 8 KiB（或把条数上限从 32 调到 64），
 * 「32×2KiB×2 < 256KiB」的推导**自动失效**，而代码**不会报错**：
 * - 推导偏松 ⇒ 单批实际可能远超预期（bytes 闸形同虚设）；
 * - 推导偏紧 ⇒ **正常批次被误拒**，表现为「事件静默丢弃」——
 *   而事件丢弃是**旁路 fail-open**，只留一条 warn（正是我们这几轮在补可观测性的那类问题）。
 *
 * ⇒ 这条守卫把「**只存在于注释里**的推导」变成**机械保证**。
 *
 * ## 判据（纯数值比较，稳）
 *
 * 断言下面这个不等式**恒成立**：
 * ```
 * AGENT_EVENT_BATCH_MAX × AGENT_EVENT_BODY_MAX_BYTES × ESCAPE_WORST_FACTOR ≤ AGENT_EVENT_BATCH_MAX_BYTES
 * ```
 * 其中 `ESCAPE_WORST_FACTOR = 2`（jsonb 转义最坏倍数：每个字符最坏变成 `\uXXXX`）。
 *
 * **数值从源码解析**（不复制）：三个常量都从各自的声明处读，
 * 解析不到 ⇒ **结构红**（判据瞎了，不许静默通过）。
 *
 * ## 为什么不做「动态导入」
 *
 * 这几个常量在 TS 文件里，且 `agent-session.service.ts` 有 Nest 依赖（不能直接 require）。
 * ⇒ 用**文本解析**读 `export const X = <数字表达式>` 的字面值，
 * 并**只支持**四种形态：`123` / `123 * 1024` / `0x1f` / `2 ** 10`。
 * 解析不了就**结构红**（提示人改守卫，而不是猜一个数）。
 *
 * ## 仓库根从哪来（`--root`）
 *
 * 三个常量的位置全是**仓库相对路径**，所以「根」是本守卫唯一的输入口径：
 *
 *   · 不传 `--root` ⇒ 根 = 本脚本所在树的上一级（`<repo>/scripts/` → `<repo>`），
 *     **与引入 `--root` 之前逐字节等价**（不依赖 `process.cwd()`：从子目录误跑
 *     不会扫空目录 ⇒ 不会假绿）；
 *   · `--root <dir>` / `--root=<dir>` 两种形态都认，根换成 `<dir>` —— 这是给
 *     **selftest 夹具**用的：夹具在临时目录造一个假仓库，绝不碰真仓库；
 *   · `--root` 缺值 / 空值 / 指向不存在的目录 ⇒ **exit 2**（用法错误）。
 *     **不许静默回落到真仓库**——「以为在跑夹具、实际跑的是真仓库」是最坏的假绿；
 *   · `--selftest` 与 `--root` **互斥** ⇒ exit 2：自检的对照组就是真仓库
 *     （③「真仓库应全绿」+ ④ 用真源码造变异副本），换根会让对照组失去意义。
 *
 * 本守卫**只读**源码，不写盘（自检的临时副本写在 `os.tmpdir()` 下），所以
 * `--root` 不需要额外的写盘重定向。
 *
 * 用法：
 *   node scripts/check-agent-event-limits.mjs                  # 真仓库
 *   node scripts/check-agent-event-limits.mjs --root <dir>     # 以 <dir> 为仓库根
 *   node scripts/check-agent-event-limits.mjs --root=<dir>     # 同上（等号形态）
 *   node scripts/check-agent-event-limits.mjs --selftest       # 自检（含反证）
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const SOURCES = {
  "AGENT_EVENT_BATCH_MAX": "apps/admin-api/src/modules/agent/runtime/agent-session.service.ts",
  "AGENT_EVENT_BATCH_MAX_BYTES":
    "apps/admin-api/src/modules/agent/runtime/agent-session.service.ts",
  "AGENT_EVENT_BODY_MAX_BYTES":
    "apps/admin-api/src/modules/agent/entities/agent-event.entity.ts",
};

/** jsonb 转义最坏倍数：每个字符最坏变成 `\uXXXX`（6 字节）。 */
const ESCAPE_WORST_FACTOR = 2;

/**
 * 从源码里读 `export const <NAME> = <字面量>` 的数值。
 * 支持：`123` / `123 * 1024` / `0x1f` / `2 ** 10` / 上述的括号组合。
 * @returns {{ value: number } | { error: string }}
 */
export function parseConstNumber(source, name) {
  const re = new RegExp(
    `export\\s+const\\s+${name}\\s*=\\s*([^;\\n]+)`,
  );
  const m = source.match(re);
  if (!m) return { error: `找不到 \`export const ${name}\`` };
  const expr = m[1].trim();

  // 只允许纯算术字面量：数字 / 十六进制 / 乘方 / 乘法
  if (!/^[\d\sxXa-fA-F*+()^.-]+$/.test(expr)) {
    return { error: `${name} 的初始值不是纯算术字面量（读到 "${expr}"）` };
  }
  try {
    // eslint-disable-next-line no-new-func
    const value = Function(`"use strict"; return (${expr});`)();
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { error: `${name} 求值结果不是有限数（${expr}）` };
    }
    return { value };
  } catch (err) {
    return { error: `${name} 求值失败：${err instanceof Error ? err.message : err}` };
  }
}

/** 判据主体：返回问题清单（空数组 = 全绿）。 */
export function judge(root = ROOT) {
  const problems = [];
  const values = {};

  for (const [name, rel] of Object.entries(SOURCES)) {
    let src = "";
    try {
      src = readFileSync(join(root, rel), "utf8");
    } catch (err) {
      problems.push(
        `${rel} 不可读（${err instanceof Error ? err.message : err}）——常量位置变了？`,
      );
      continue;
    }
    const parsed = parseConstNumber(src, name);
    if ("error" in parsed) {
      problems.push(`${name}：${parsed.error}（守卫需要跟着常量位置走）`);
      continue;
    }
    values[name] = parsed.value;
  }

  if (problems.length > 0) return { ok: false, problems, values };

  const {
    AGENT_EVENT_BATCH_MAX,
    AGENT_EVENT_BODY_MAX_BYTES,
    AGENT_EVENT_BATCH_MAX_BYTES,
  } = values;

  const worstCase = AGENT_EVENT_BATCH_MAX * AGENT_EVENT_BODY_MAX_BYTES * ESCAPE_WORST_FACTOR;
  if (worstCase > AGENT_EVENT_BATCH_MAX_BYTES) {
    problems.push(
      `批字节上限与「条数 × 单条上限 × 转义最坏倍数」不自洽：` +
        `${AGENT_EVENT_BATCH_MAX} × ${AGENT_EVENT_BODY_MAX_BYTES} × ${ESCAPE_WORST_FACTOR} = ${worstCase} > ` +
        `AGENT_EVENT_BATCH_MAX_BYTES = ${AGENT_EVENT_BATCH_MAX_BYTES}。` +
        `⇒ 正常批次可能被误拒（表现为事件被静默丢弃）；` +
        `要么调大批字节上限，要么调小条数/单条上限——**别只改一个**。`,
    );
  }

  return { ok: problems.length === 0, problems, values, worstCase };
}

/** 用法错误（`--root` 缺值 / 指向不存在的目录）——与判据红分开，不混成一个退出码。 */
const EXIT_USAGE = 2;

/**
 * 解析命令行。**只认** `--root` / `--selftest` 两个有意义的参数；其余参数照旧忽略
 * （引入 `--root` 之前它们也是忽略的，这里不改那个行为）。
 *
 * `--root` 缺值即抛（交给 `main` 报 exit 2）：把 `--root` 末尾裸写当成 `.`
 * 会让根落到 `process.cwd()` —— 从那句「以为在跑夹具」的坑里直接掉进真仓库。
 */
function parseArgs(argv = process.argv.slice(2)) {
  const opts = { root: ROOT, selftest: false, rootExplicit: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--selftest") {
      opts.selftest = true;
      continue;
    }
    if (a === "--root" || a.startsWith("--root=")) {
      const v = a === "--root" ? argv[++i] : a.slice("--root=".length);
      if (!v || v.startsWith("--")) {
        throw new Error("`--root` 需要一个目录参数（`--root <dir>` 或 `--root=<dir>`）");
      }
      opts.root = resolve(v);
      opts.rootExplicit = true;
    }
  }
  // 自检的对照组**就是真仓库**（③ 断言「真仓库全绿」，④ 用真源码造变异副本），
  // 换根会让对照组失去意义 ⇒ 显式互斥，比「静默忽略 `--root`」诚实。
  if (opts.selftest && opts.rootExplicit) {
    throw new Error(
      "`--selftest` 与 `--root` 互斥：自检的正例控制组与反证都钉在**真仓库**上",
    );
  }
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs();
  } catch (err) {
    console.error(`✘ 用法错误：${err.message}`);
    process.exit(EXIT_USAGE);
  }
  if (opts.selftest) return runSelftest();

  if (!existsSync(opts.root)) {
    console.error(`✘ 用法错误：\`--root\` 指向的目录不存在：${opts.root}`);
    process.exit(EXIT_USAGE);
  }

  const result = judge(opts.root);
  if (!result.ok) {
    console.error("✘ 事件尺寸上限一致性守卫失败：");
    for (const p of result.problems) console.error(`  · ${p}`);
    process.exit(1);
  }
  console.log(
    `✔ 事件尺寸上限一致：${result.values.AGENT_EVENT_BATCH_MAX} 条 × ` +
      `${result.values.AGENT_EVENT_BODY_MAX_BYTES}B × ${ESCAPE_WORST_FACTOR} = ` +
      `${result.worstCase}B ≤ 批上限 ${result.values.AGENT_EVENT_BATCH_MAX_BYTES}B`,
  );
  process.exit(0);
}

/** 自检：正例控制组 + 反证（不自改仓库，用临时副本）。 */
function runSelftest() {
  let failed = false;
  const ok = (cond, msg) => {
    if (!cond) {
      console.error(`✗ selftest ${msg}`);
      failed = true;
    }
  };

  // ① 解析器：纯字面量
  const p1 = parseConstNumber("export const X = 256 * 1024;", "X");
  ok(!("error" in p1) && p1.value === 262144, "解析 `256 * 1024` 应得 262144");
  const p2 = parseConstNumber("export const Y = 0x1f;", "Y");
  ok(!("error" in p2) && p2.value === 31, "解析 `0x1f` 应得 31");
  const p3 = parseConstNumber("export const Z = 2 ** 10;", "Z");
  ok(!("error" in p3) && p3.value === 1024, "解析 `2 ** 10` 应得 1024");

  // ② 解析器：拒绝非字面量 / 缺常量
  const p4 = parseConstNumber("export const W = foo();", "W");
  ok("error" in p4, "非字面量初始值应被拒");
  const p5 = parseConstNumber("const V = 1;", "V");
  ok("error" in p5, "缺少 export const 应被拒");

  // ③ 判据：真仓库应全绿
  const real = judge();
  ok(real.ok, `真仓库应全绿（实际：${real.problems.join(" / ")}）`);

  // ④ 反证：把单条上限调大 ⇒ 判据必须红
  const src = readFileSync(
    join(ROOT, SOURCES.AGENT_EVENT_BODY_MAX_BYTES),
    "utf8",
  );
  const tampered = src.replace(
    /export const AGENT_EVENT_BODY_MAX_BYTES = 2048;/,
    "export const AGENT_EVENT_BODY_MAX_BYTES = 65536;",
  );
  ok(
    tampered !== src,
    "单条上限常量形态变了（守卫的替换前提失效）——请同步更新 selftest",
  );
  const tmp = mkdtempSync(join(tmpdir(), "acf-event-limits-"));
  // 用同样的相对布局构造一个临时 root（**只放被篡改的那一个 + 其余原文**）
  const tmpRoot = join(tmp, "root");
  mkdirSync(tmpRoot, { recursive: true });
  for (const [name, rel] of Object.entries(SOURCES)) {
    const target = join(tmpRoot, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      name === "AGENT_EVENT_BODY_MAX_BYTES"
        ? tampered
        : readFileSync(join(ROOT, rel), "utf8"),
      "utf8",
    );
  }
  const bad = judge(tmpRoot);
  ok(!bad.ok, "单条上限调到 64 KiB 后判据必须红");
  ok(
    bad.problems.some((p) => p.includes("不自洽")),
    "红的原因应说明「不自洽」",
  );
  rmSync(tmp, { recursive: true, force: true });

  if (failed) {
    console.error("✗ check-agent-event-limits selftest 未全绿");
    process.exit(1);
  }
  console.log("✔ check-agent-event-limits selftest 全绿（含反证）");
  process.exit(0);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
