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
 *     （「真仓库应全绿」+「三个常量的值基准」都钉在真仓库上），换根会让对照组失去意义。
 *     注意：自检**内部**照样 spawn 本脚本并只带 `--root`（黑盒 CLI 夹具，见文末自检小节）——
 *     互斥约束的是**人敲的命令行**，不是子进程。
 *
 * 本守卫**只读**源码，不写盘（自检的临时副本写在 `os.tmpdir()` 下），所以
 * `--root` 不需要额外的写盘重定向。
 *
 * ## 自检覆盖了什么 / 没覆盖什么（R149：补黑盒 CLI 夹具）
 *
 * 自检分三层，**第 ③ 层是 R149 新加的**（R148 的回执只验证了原型，没落盘成用例）：
 *
 *   ① **解析器**（纯函数 `parseConstNumber`）：4 种字面量形态 + 2 类拒绝；
 *   ② **判据**（进程内 `judge(root)`）：真仓库全绿 + 三个常量的**值基准** + 篡改后转红
 *      （夹具在 `mkdtemp` 里，不是真源码副本 —— 真源码只由「真仓库全绿」那条钉）；
 *   ③ **黑盒 CLI**（`runGuard(SELF, ["--root=<mkdtemp 夹具>"])`，spawn 真脚本、
 *      断言**退出码 + 文本**）：这一层测的才是**守卫**，不是它的函数。
 *
 * ③ **覆盖了的**（这些性质**只存在于 CLI 入口**，直调 `judge()` 全部绕过）：
 *   · 合规夹具 ⇒ **exit 0**，且 stdout 把三个数字原样打出来
 *     （`32 条 × 2048B × 2 = 131072B ≤ 262144B`）；
 *   · `--root <dir>` 与 `--root=<dir>` **两种形态都真的换根**（两条用例各覆盖一种）；
 *   · 批字节上限改**小**（262144 → 65536）⇒ **exit 1**，点名「不自洽」并打印
 *     `32 × 2048 × 2 = 131072 > 65536`；
 *   · 单条上限改**大**（2048 → 65536）⇒ **exit 1** —— 不等式**两个方向都有牙**
 *     （只测一个方向的话，「改大」这个更常见的漂移可以静默通过）；
 *   · 常量初始值改成**非算术字面量**（`bodyMaxFromEnv()`）⇒ exit 1：解析器失败即
 *     **结构红**，绝不猜一个数（头注「解析不了就结构红」的机械证据）；
 *   · 常量**文件缺失** ⇒ exit 1，且是**可读一句话**（`<rel> 不可读（…）——常量位置变了？`），
 *     **不是 ENOENT 栈**：用例显式 `absent` 断言输出里没有 `    at ` 栈帧、没有
 *     `node:internal/` —— 否则新人只会看到一把栈、不知道该改守卫还是改代码；
 *   · **空树**（连 `apps/` 都没有）⇒ exit 1，两个常量文件**逐条点名**（不是一句「失败」）；
 *   · `--root` 指向**不存在的目录** ⇒ **exit 2**（用法错误，不静默回落到真仓库）；
 *   · `--selftest` 与 `--root` **互斥** ⇒ **exit 2**：这条**只在入口存在**
 *     （`parseArgs` 抛在 `runSelftest` 之前），直调函数永远测不到它。
 *
 * ③ **没覆盖的**（盲区，写出来不等于没有）：
 *   · `ESCAPE_WORST_FACTOR = 2` 是**本脚本自己的常量**，夹具改不到它 ⇒
 *     「转义最坏倍数被悄悄改成 1」这个方向**没有机械证据**（要覆盖得把它做成可注入的
 *     参数，那会改主跑契约，本期不做）；
 *   · 只验「**常量值层面**的自洽」，**不验**批字节上限在实体/服务里的**实际用法**
 *     （校验点被删、改成按 UTF-16 长度算、异常被吞……都测不出来）——那是
 *     `check-agent-write-sanitize` 一类的判据面；
 *   · 夹具是**迷你 TS 片段**（只有 `export const` 那几行），不覆盖真实 TS 的
 *     `readonly` / `as const` / 多行声明 / 注释夹在中间等形态；「真仓库仍可解析」
 *     只由 ② 的一条真树用例保证，**不构成对真实文件的逐形态覆盖**；
 *   · 文件系统边界（权限位 0000 / 符号链接 / 超长路径 / 目录不可读）**一条都没测**：
 *     「空树」只是「文件不存在」的近似；
 *   · `parseConstNumber` 用 `Function()` 求值，夹具只证明「非算术字面量被拒」，
 *     **不证明**它对恶意构造安全（`__proto__` 之类）——输入全是仓内源码，威胁模型不同。
 *
 * 用法：
 *   node scripts/check-agent-event-limits.mjs                  # 真仓库
 *   node scripts/check-agent-event-limits.mjs --root <dir>     # 以 <dir> 为仓库根
 *   node scripts/check-agent-event-limits.mjs --root=<dir>     # 同上（等号形态）
 *   node scripts/check-agent-event-limits.mjs --selftest       # 自检（含反证 + 黑盒 CLI 夹具）
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// 自检的统一执行层（R148 起 4 个兄弟守卫共用）：spawn 真脚本 + 断言退出码/文本。
// ⚠️ 这意味着**主跑路径多了一个文件级依赖**；它只导出函数、无副作用，故不影响主跑输出。
import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";
// R160：覆盖计数出口。**必须在任何 require/依赖之前**打印（本文件若因缺依赖崩掉，
// 「崩了」与「零用例」必须能被哨兵分开看）。helper = 本文件真实的用例注册函数名
// （`ok(name, fn)` = 本文件 selftest 里注册一条用例的那个函数）。
printCoverageBanner(import.meta.url, "ok");

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

/**
 * 自检：三层 —— ① 解析器（纯函数）② 判据（进程内 `judge`）③ **黑盒 CLI**（spawn 真脚本）。
 *
 * 夹具全部建在 `os.tmpdir()` 的 `mkdtemp` 下（`makeFixtureRepo`）、用完即删，
 * **绝不往仓库写任何文件**；`--root` 只出现在**子进程**上，故与「`--selftest`/`--root`
 * 互斥」不冲突（互斥约束的是人敲的命令行）。
 *
 * 为什么非得有 ③：`--root` 的解析、`exit 1`/`exit 2` 的映射、`--selftest`+`--root`
 * 互斥这三处**只在入口存在**，直调 `judge()` 时全被绕过 —— 那正是 R147 之前的状态
 * （判据有牙，入口没牙）。
 */
function runSelftest() {
  const cases = [];
  const ok = (name, fn) => cases.push({ name, fn });
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  const SELF = fileURLToPath(import.meta.url);

  /** 夹具的相对布局**从 SOURCES 现取**（常量位置若搬家，夹具跟着搬，不手抄路径）。 */
  const REL_SERVICE = SOURCES.AGENT_EVENT_BATCH_MAX;
  const REL_ENTITY = SOURCES.AGENT_EVENT_BODY_MAX_BYTES;

  /** 合规的服务侧片段：32 条 × 2048B × 2 = 131072 ≤ 262144。 */
  const SERVICE_OK = [
    "// 夹具：与真仓库同值的合规常量（注释也在，验「解析只认声明行」）",
    "export const AGENT_EVENT_BATCH_MAX = 32;",
    "/** 一批的字节上限：≥ 32 条 × 2 KiB × 转义最坏倍数（约 2 倍）仍有余量 */",
    "export const AGENT_EVENT_BATCH_MAX_BYTES = 256 * 1024;",
    "",
  ].join("\n");

  const ENTITY_OK = ["export const AGENT_EVENT_BODY_MAX_BYTES = 2048;", ""].join("\n");

  /**
   * 造一棵「只有这两个常量文件」的迷你仓库（照真仓库的相对布局）。
   * `files` 覆盖单个文件内容；`omit` 干脆**不放**某个文件（造「文件缺失」的结构红）。
   */
  const fixture = (files = {}, options = {}) => {
    const merged = { [REL_SERVICE]: SERVICE_OK, [REL_ENTITY]: ENTITY_OK, ...files };
    for (const rel of options.omit ?? []) delete merged[rel];
    return makeFixtureRepo(merged, { prefix: "acf-event-limits-" });
  };

  /** 在夹具上跑一段；**无论抛不抛都清理**（夹具不许残留到 `os.tmpdir()`）。 */
  const withFixture = (fn, options = {}) => {
    const repo = fixture(options.files ?? {}, options);
    try {
      return fn(repo);
    } finally {
      repo.cleanup();
    }
  };

  // ── ① 解析器（纯函数）────────────────────────────────────────────────
  ok("① 解析器：`256 * 1024` ⇒ 262144", () => {
    const p = parseConstNumber("export const X = 256 * 1024;", "X");
    assert(!("error" in p) && p.value === 262144, `实得 ${JSON.stringify(p)}`);
  });

  ok("①b 解析器：`0x1f` ⇒ 31", () => {
    const p = parseConstNumber("export const Y = 0x1f;", "Y");
    assert(!("error" in p) && p.value === 31, `实得 ${JSON.stringify(p)}`);
  });

  ok("①c 解析器：`2 ** 10` ⇒ 1024", () => {
    const p = parseConstNumber("export const Z = 2 ** 10;", "Z");
    assert(!("error" in p) && p.value === 1024, `实得 ${JSON.stringify(p)}`);
  });

  ok("② 解析器：非算术字面量（`foo()`）⇒ 被拒（不猜数）", () => {
    const p = parseConstNumber("export const W = foo();", "W");
    assert("error" in p, `应被拒，实得 ${JSON.stringify(p)}`);
  });

  ok("②b 解析器：缺 `export const` ⇒ 被拒（常量改名/搬家都必须红）", () => {
    const p = parseConstNumber("const V = 1;", "V");
    assert("error" in p, `应被拒，实得 ${JSON.stringify(p)}`);
  });

  // ── ② 判据（进程内）──────────────────────────────────────────────────
  ok("③ 真仓库全绿，且三个常量的**值基准**仍是 32 / 2048 / 262144", () => {
    const real = judge();
    assert(real.ok, `真仓库应全绿，实际：${real.problems.join(" / ")}`);
    const got = [
      real.values.AGENT_EVENT_BATCH_MAX,
      real.values.AGENT_EVENT_BODY_MAX_BYTES,
      real.values.AGENT_EVENT_BATCH_MAX_BYTES,
    ].join("/");
    assert(
      got === "32/2048/262144",
      `常量值变为 ${got} —— 推导与夹具里的注释推导都失效了，请同步复核本守卫与夹具`,
    );
  });

  ok("④ 进程内反证：单条上限 2048 → 65536 ⇒ judge 红且说明「不自洽」", () => {
    withFixture(
      (repo) => {
        const bad = judge(repo.dir);
        assert(!bad.ok, "把单条上限调到 64 KiB 后 judge 仍绿 —— 判据没牙");
        assert(
          bad.problems.some((p) => p.includes("不自洽")),
          `红的原因应说明「不自洽」，实得：${bad.problems.join(" / ")}`,
        );
      },
      { files: { [REL_ENTITY]: ENTITY_OK.replace("2048", "65536") } },
    );
  });

  // ── ③ 黑盒 CLI 夹具（R149）──────────────────────────────────────────
  // 这一段测的是**守卫**，不是它的函数：spawn 真脚本、只喂 `--root=<夹具>`，
  // 断言退出码 + 文本。夹具建在 `os.tmpdir()` 的 `mkdtemp` 下，用完即删。
  ok("⑤ CLI `--root=<合规夹具>` ⇒ 0，stdout 把三个数字原样打出", () => {
    withFixture((repo) => {
      expectExit(runGuard(SELF, { args: [`--root=${repo.dir}`] }), {
        code: 0,
        contains: [
          "事件尺寸上限一致",
          "32 条 × 2048B × 2 = 131072B ≤ 批上限 262144B",
        ],
        absent: ["守卫失败", "不可读"],
        label: "CLI --root=<合规夹具>",
      });
    });
  });

  ok("⑥ CLI `--root <夹具>`（**空格形态**）+ 与真仓库**不同**的自洽数值 ⇒ 0，且打印夹具的数", () => {
    // 夹具 16 条 ⇒ 16 × 2048 × 2 = 65536：**与真仓库的 32 不同**，
    // 所以「打印 16」就是「根真的换成夹具了」的机械证据（换成真仓库会打印 32）。
    const alt = SERVICE_OK.replace(
      "export const AGENT_EVENT_BATCH_MAX = 32;",
      "export const AGENT_EVENT_BATCH_MAX = 16;",
    );
    withFixture(
      (repo) => {
        expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
          code: 0,
          contains: ["16 条 × 2048B × 2 = 65536B ≤ 批上限 262144B"],
          absent: ["32 条 ×"],
          label: "CLI --root <夹具>（空格形态）",
        });
      },
      { files: { [REL_SERVICE]: alt } },
    );
  });

  ok("⑦ CLI `--root=<批字节上限改小到 64 KiB>` ⇒ 1，点名「不自洽」+ 两个数字", () => {
    withFixture(
      (repo) => {
        expectExit(runGuard(SELF, { args: [`--root=${repo.dir}`] }), {
          code: 1,
          contains: [
            "事件尺寸上限一致性守卫失败",
            "不自洽",
            "32 × 2048 × 2 = 131072 > AGENT_EVENT_BATCH_MAX_BYTES = 65536",
            "别只改一个",
          ],
          absent: ["✔ 事件尺寸上限一致"],
          label: "CLI --root=<批上限改小>",
        });
      },
      { files: { [REL_SERVICE]: SERVICE_OK.replace("256 * 1024", "64 * 1024") } },
    );
  });

  ok("⑧ CLI `--root=<单条上限改大到 64 KiB>` ⇒ 1（不等式的**另一个方向**也有牙）", () => {
    withFixture(
      (repo) => {
        expectExit(runGuard(SELF, { args: [`--root=${repo.dir}`] }), {
          code: 1,
          contains: [
            "不自洽",
            "32 × 65536 × 2 = 4194304 > AGENT_EVENT_BATCH_MAX_BYTES = 262144",
          ],
          absent: ["✔ 事件尺寸上限一致"],
          label: "CLI --root=<单条上限改大>",
        });
      },
      { files: { [REL_ENTITY]: ENTITY_OK.replace("2048", "65536") } },
    );
  });

  ok("⑨ CLI `--root=<常量初始值不是算术字面量>` ⇒ 1（解析失败即**结构红**，不猜数）", () => {
    withFixture(
      (repo) => {
        expectExit(runGuard(SELF, { args: [`--root=${repo.dir}`] }), {
          code: 1,
          contains: [
            "不是纯算术字面量",
            "bodyMaxFromEnv()",
            "守卫需要跟着常量位置走",
          ],
          absent: ["✔ 事件尺寸上限一致"],
          label: "CLI --root=<非算术字面量>",
        });
      },
      { files: { [REL_ENTITY]: "export const AGENT_EVENT_BODY_MAX_BYTES = bodyMaxFromEnv();\n" } },
    );
  });

  ok("⑩ CLI `--root=<缺 agent-event.entity.ts>` ⇒ 1，可读一句话、**不是 ENOENT 栈**", () => {
    withFixture(
      (repo) => {
        expectExit(runGuard(SELF, { args: [`--root=${repo.dir}`] }), {
          code: 1,
          contains: [
            "事件尺寸上限一致性守卫失败",
            `${REL_ENTITY} 不可读`,
            "常量位置变了？",
          ],
          // 「不是栈」必须机械断言：否则报错退化成一把栈也没人发现。
          absent: ["    at ", "node:internal/", "Error: ENOENT"],
          label: "CLI --root=<缺常量文件>",
        });
      },
      { omit: [REL_ENTITY] },
    );
  });

  ok("⑪ CLI `--root=<空树>` ⇒ 1（两个常量文件**逐条点名**，不是一句「失败」）", () => {
    withFixture(
      (repo) => {
        expectExit(runGuard(SELF, { args: [`--root=${repo.dir}`] }), {
          code: 1,
          contains: [
            `${REL_SERVICE} 不可读`,
            `${REL_ENTITY} 不可读`,
            "事件尺寸上限一致性守卫失败",
          ],
          absent: ["✔ 事件尺寸上限一致"],
          label: "CLI --root=<空树>",
        });
      },
      { omit: [REL_SERVICE, REL_ENTITY] },
    );
  });

  ok("⑫ CLI `--root=<不存在的目录>` ⇒ 2（用法错误，不静默回落到真仓库）", () => {
    expectExit(
      runGuard(SELF, { args: [`--root=${join(ROOT, "不存在的夹具-" + process.pid)}`] }),
      {
        code: 2,
        contains: ["用法错误", "指向的目录不存在"],
        label: "CLI --root=<不存在>",
      },
    );
  });

  ok("⑬ CLI 裸 `--root`（缺值）⇒ 2（不吃下一个开关、不回落 cwd）", () => {
    expectExit(runGuard(SELF, { args: ["--root"] }), {
      code: 2,
      contains: ["用法错误", "`--root` 需要一个目录参数"],
      label: "CLI --root（缺值）",
    });
  });

  // ⑭ 会 spawn 本脚本并带 `--selftest`。**若将来「互斥」这条判据被删掉**，子进程就会跑完整
  // 自检、并在 ⑭ 处再 spawn 一次 ⇒ 无界递归 fork（既是 CI 挂死，也是「守卫自己打自己」）。
  // 用环境变量把子进程里的 ⑭ 关掉（照 `check-npm-audit-exemptions` 的
  // `ACF_GUARD_SELFTEST_META` 先例）：断言的仍然是「互斥 ⇒ exit 2」，只是子进程不再下潜。
  const CHILD_ENV = { ACF_EVENT_LIMITS_SELFTEST_CHILD: "1" };
  if (process.env.ACF_EVENT_LIMITS_SELFTEST_CHILD === "1") {
    console.log("  ⚠ 跳过 ⑭（本进程由 ⑭ 启动，防递归 spawn）");
  } else {
    ok("⑭ CLI `--selftest --root=<夹具>` ⇒ 2（互斥**只在入口存在**，直调函数测不到）", () => {
      withFixture((repo) => {
        expectExit(
          runGuard(SELF, { args: ["--selftest", `--root=${repo.dir}`], env: CHILD_ENV }),
          {
            code: 2,
            contains: ["用法错误", "互斥"],
            label: "CLI --selftest + --root",
          },
        );
      });
    });
  }

  const failed = reportCases(cases, { title: "check-agent-event-limits selftest" });
  if (failed > 0) {
    console.error("✗ check-agent-event-limits selftest 未全绿");
    process.exit(1);
  }
  console.log("✔ check-agent-event-limits selftest 全绿（含反证 + 黑盒 CLI 夹具）");
  process.exit(0);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
