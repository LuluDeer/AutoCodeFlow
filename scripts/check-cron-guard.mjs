#!/usr/bin/env node
/**
 * 守卫：**每个 `@Cron` 方法体都必须有顶层异常闸**（`try` 或 `guardedCron(`）。
 *
 * ## 为什么这条守卫存在（rt-5，审计 2026-10-29 第 3 轮）
 *
 * `@nestjs/schedule` 的 cron 回调**不 await** 方法返回的 Promise。方法体裸奔时，
 * 体内任何一次 `await` 的 DB 操作 reject（连接池排队超时 / statement_timeout /
 * 序列化冲突 / PG failover）→ 未处理的 Promise rejection → `main.ts` 的
 * `process.on("unhandledRejection")` → `gracefulFatalShutdown()` → `exit(1)`。
 * 一次瞬态抖动 = **整实例**退出（所有 API 503 + 所有 SSE 断流 + worker 重连）。
 *
 * 2026-10-17 的 CRON-GUARD 只修了 `scheduler.service.ts`（`guardTick`），注释里
 * 写「现在所有 cron 体都经本方法包裹」——那只在**该文件内**成立。rt-5 机械扫描
 * 发现另外 5 个模块的方法体裸奔。本守卫把「以后新增 cron 不许再漏」钉成机器判据。
 *
 * ## 判据（文本级，如实写出边界）
 *
 * 对每个 `@Cron(` 装饰器，向下解析到**方法体**（花括号配对，不是固定行窗口），
 * 方法体（已剥注释/字符串）里必须出现以下之一：
 *   - `try {`            —— 站点自带的顶层 try/catch；
 *   - `guardedCron(`     —— `common/utils/cron-guard.util.ts` 的公共闸；
 *   - `guardTick(`       —— scheduler 的重入闸，**它内部委托 guardedCron**
 *                          （`guardTickDelegatesToGuardedCron` 单独校验这条委托，
 *                          否则 guardTick 就只是一个能通过检查的空词）。
 *
 * 已知边界：这是**文本判据**，不是语义分析。`try` 写在方法体内很深的箭头函数里、
 * 或写成 `try{`（无空格）都由判据放行；它挡的是「新增 @Cron 时整个忘了包」，
 * 不是「包错了位置」。
 *
 * ## 用法
 *   node scripts/check-cron-guard.mjs              # 扫 apps/admin-api/src
 *   node scripts/check-cron-guard.mjs --selftest   # 判据自检（零依赖、零 DB）
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "apps", "admin-api", "src");

/** 判据词：顶层异常闸的三种既有形态。 */
const TRY = /\btry\s*\{/;
const GUARD_CALL = /\b(?:guardedCron|guardTick)\s*\(/;

/** 扫不到这么多就是扫描器坏了（当前 26 个，去掉 agent 域 3 个 = 23）。 */
const MIN_EXPECTED_CRONS = 20;

/**
 * **显式排除清单**（不是静默跳过）。
 *
 * 每一项都必须带理由，并被打印出来——「排除」和「漏扫」在本仓是两个概念：
 * 后者是缺陷，前者是待办。缺了 visible 打印，未来没人会想起来这 3 个 @Cron
 * 从未被这条守卫覆盖过。
 */
const EXCLUDED_PREFIXES = [
  {
    prefix: "apps/admin-api/src/modules/agent/",
    reason:
      "modules/agent/** 待热区解锁后纳入（该目录正由并发 agent 修改，本守卫的强制面暂不覆盖；解锁后**必须**删掉本条并让扫描变红——按现状该目录 4 个 @Cron 中 sweepAggregator 仍无闸，审计 rt-5 已记）",
  },
];

// ─────────────────────────────────────────────────────────────────────────
// 词法掩码：把注释与字符串内容替换成空格（保留换行 ⇒ 行号不变）
//
// 为什么要掩码而不是「按行删注释」：
//   · 注释里的 `@Cron(` 不能被当成装饰器（既有代码里有大量示例注释）；
//   · 注释里的 `try {` 不能被当成闸（首版守卫就是这么假绿的）；
//   · 字符串里的 `{`/`}` 不能被算进花括号配对（否则方法体边界漂移）。
// ─────────────────────────────────────────────────────────────────────────
function maskNonCode(src) {
  const out = src.split("");
  const hide = (i) => {
    if (i >= 0 && i < out.length && out[i] !== "\n") out[i] = " ";
  };
  let state = "code"; // code | line | block | single | double | template
  const tplStack = []; // 模板 `${ ... }` 里的花括号深度
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        i += 1;
        continue;
      }
      hide(i);
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && d === "/") {
        hide(i);
        hide(i + 1);
        i += 2;
        state = "code";
        continue;
      }
      hide(i);
      i += 1;
      continue;
    }
    if (state === "single" || state === "double") {
      const q = state === "single" ? "'" : '"';
      if (c === "\\") {
        hide(i);
        hide(i + 1);
        i += 2;
        continue;
      }
      if (c === q) {
        hide(i);
        i += 1;
        state = "code";
        continue;
      }
      hide(i);
      i += 1;
      continue;
    }
    if (state === "template") {
      if (c === "\\") {
        hide(i);
        hide(i + 1);
        i += 2;
        continue;
      }
      if (c === "`") {
        hide(i);
        i += 1;
        state = "code";
        continue;
      }
      if (c === "$" && d === "{") {
        hide(i);
        hide(i + 1);
        tplStack.push({ depth: 0 });
        state = "code";
        i += 2;
        continue;
      }
      hide(i);
      i += 1;
      continue;
    }
    // state === "code"
    if (c === "/" && d === "/") {
      state = "line";
      hide(i);
      hide(i + 1);
      i += 2;
      continue;
    }
    if (c === "/" && d === "*") {
      state = "block";
      hide(i);
      hide(i + 1);
      i += 2;
      continue;
    }
    if (c === "'") {
      state = "single";
      hide(i);
      i += 1;
      continue;
    }
    if (c === '"') {
      state = "double";
      hide(i);
      i += 1;
      continue;
    }
    if (c === "`") {
      state = "template";
      hide(i);
      i += 1;
      continue;
    }
    const top = tplStack[tplStack.length - 1];
    if (top) {
      if (c === "{") top.depth += 1;
      else if (c === "}") {
        if (top.depth === 0) {
          tplStack.pop();
          state = "template";
          hide(i);
          i += 1;
          continue;
        }
        top.depth -= 1;
      }
    }
    i += 1;
  }
  return out.join("");
}

/** 从 `open` 处的 `(`(或 `{`) 找配对的闭括号，返回下标（已掩码源上仍可用）。 */
function matchBracket(masked, open, openCh, closeCh) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === openCh) depth += 1;
    else if (masked[i] === closeCh) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++)
    if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** 方法签名：跳过其它装饰器与修饰符，取出方法名。 */
const SIGNATURE = new RegExp(
  "^\\s*" +
    "(?:@[A-Za-z_$][\\w$.]*\\s*(?:\\([^()]*\\))?\\s*)*" +
    "(?:(?:public|private|protected|readonly|static|override|async|declare)\\s+)*" +
    "([A-Za-z_$][\\w$]*)\\s*\\(",
);

/**
 * 判定单个源文件里哪些 `@Cron` 方法体没有顶层异常闸。**纯函数**，
 * `--selftest` 用内联 fixture 直接驱动（这条守卫自己必须先被守卫）。
 *
 * @param {string} source 源文本
 * @param {{path?: string, excludedPrefixes?: Array<{prefix: string, reason: string}>}} opts
 *   `path` 只需是可匹配排除前缀的仓库相对路径（selftest 用它验证排除面）。
 * @returns {{total: number, unguarded: Array<{line: number, method: string}>,
 *            excluded: Array<{line: number, method: string, reason: string}>}}
 */
export function findUnguardedCrons(source, opts = {}) {
  const { path = "", excludedPrefixes = EXCLUDED_PREFIXES } = opts;
  const normPath = path.split("\\").join("/");
  const exclusion = excludedPrefixes.find((e) => normPath.startsWith(e.prefix));

  const masked = maskNonCode(source);
  const starts = lineStarts(masked);
  const unguarded = [];
  const excluded = [];
  let total = 0;

  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== "@") continue;
    if (!/^@Cron\s*\(/.test(masked.slice(i, i + 16))) continue;

    const line = lineOf(starts, i);
    const openParen = masked.indexOf("(", i);
    const closeParen = matchBracket(masked, openParen, "(", ")");
    if (closeParen < 0) continue; // 语法破损的文件交给 tsc，不在这里报

    const sig = SIGNATURE.exec(masked.slice(closeParen + 1, closeParen + 400));
    if (!sig) continue; // 不是方法装饰器（属性/字段），跳过
    const method = sig[1];
    const paramOpen = closeParen + 1 + sig[0].length - 1; // 签名里 `(` 的下标
    const paramClose = matchBracket(masked, paramOpen, "(", ")");
    if (paramClose < 0) continue;

    // 参数表之后：可能还有返回类型注解（`Promise<void>` / `: Foo<T>`），
    // 方法体是随后第一个 `{`。裸声明（`;`）没有方法体，跳过。
    let cursor = paramClose + 1;
    while (cursor < masked.length && /[\s:]/.test(masked[cursor])) cursor += 1;
    // 吃掉返回类型（到 `{` 或 `;` 为止；类型里的 `<>`/`[]` 不影响花括号判定）
    while (
      cursor < masked.length &&
      masked[cursor] !== "{" &&
      masked[cursor] !== ";" &&
      masked[cursor] !== "="
    ) {
      cursor += 1;
    }
    if (masked[cursor] !== "{") continue;
    const bodyEnd = matchBracket(masked, cursor, "{", "}");
    if (bodyEnd < 0) continue;
    const body = masked.slice(cursor, bodyEnd + 1);

    if (exclusion) {
      excluded.push({ line, method, reason: exclusion.reason });
      continue;
    }
    total += 1;
    if (!TRY.test(body) && !GUARD_CALL.test(body)) {
      unguarded.push({ line, method });
    }
  }

  return { total, unguarded, excluded };
}

/**
 * `guardTick(` 是 scheduler 的重入闸而非异常闸——它之所以能作为判据词，**只**
 * 因为 `guardTick` 内部把异常委托给了 `guardedCron`。这条独立性由本函数钉住：
 * 一旦有人把 guardTick 的 try/catch 写回去（或删掉 guardedCron 调用），判据词
 * 立刻失效，这里必须红。**否则「guardTick」就是一个能通过检查的空词。**
 */
export function guardTickDelegatesToGuardedCron(schedulerSource) {
  const masked = maskNonCode(schedulerSource);
  return /\bguardedCron\s*\(/.test(masked);
}

// ─────────────────────────────────────────────────────────────────────────
// --selftest：判据自检。用例全部是**反证打出来**的形态——注释、邻方法、
// 多行签名、排除面，每一个都曾在别的守卫里造成过假绿/假红。
// ─────────────────────────────────────────────────────────────────────────
function selftest() {
  const cases = [
    {
      name: "命中未加闸 → 红（给出 file:line 方法名）",
      src: [
        "class A {",
        '  @Cron("* * * * *")',
        "  async tick() {",
        "    await this.repo.delete({});",
        "  }",
        "}",
      ].join("\n"),
      expectUnguarded: [{ line: 2, method: "tick" }],
      expectTotal: 1,
    },
    {
      name: "命中已加 try/catch → 绿",
      src: [
        "class A {",
        '  @Cron("* * * * *")',
        "  async tick() {",
        "    try {",
        "      await this.repo.delete({});",
        "    } catch (err) {",
        "      this.logger.warn(String(err));",
        "    }",
        "  }",
        "}",
      ].join("\n"),
      expectUnguarded: [],
      expectTotal: 1,
    },
    {
      name: "命中 guardedCron → 绿（公共 util 形态）",
      src: [
        "class A {",
        '  @Cron("* * * * *")',
        "  async tick() {",
        '    await guardedCron("a.tick", this.logger, () => this.tickBody());',
        "  }",
        "}",
      ].join("\n"),
      expectUnguarded: [],
      expectTotal: 1,
    },
    {
      name: "注释里的 @Cron 不算、注释里的 try 也不算（首版守卫的假绿现场）",
      src: [
        "class A {",
        '  // @Cron("* * * * *")',
        "  /**",
        '   * @Cron("0 0 * * * *")  示例，不是真装饰器',
        "   */",
        '  @Cron("0 0 * * * *")',
        "  async tick() {",
        "    // try { await this.repo.delete({}); } catch (e) {}",
        "    await this.repo.delete({});",
        "  }",
        "}",
      ].join("\n"),
      expectUnguarded: [{ line: 6, method: "tick" }],
      // 三个 @Cron 文本里只有一个是真装饰器
      expectTotal: 1,
    },
    {
      name: "多行装饰器实参 + 多行方法签名 → 仍正确定位（不靠固定行窗口）",
      src: [
        "class A {",
        "  @Cron(",
        '    "0 0 2 * * *",',
        '    { timeZone: "UTC" },',
        "  )",
        "  async",
        "  cleanup(",
        "    cutoff: Date,",
        "    batch: number,",
        "  ): Promise<void> {",
        "    await this.repo.delete(cutoff);",
        "  }",
        "}",
      ].join("\n"),
      expectUnguarded: [{ line: 2, method: "cleanup" }],
      expectTotal: 1,
    },
    {
      name: "排除前缀（modules/agent/**）→ 进 excluded 并带理由，不是静默跳过",
      src: [
        "class A {",
        '  @Cron("0 */10 * * * *")',
        "  sweepAggregator() {",
        "    this.aggregator.sweep();",
        "  }",
        "}",
      ].join("\n"),
      path: "apps/admin-api/src/modules/agent/trigger/agent-trigger.service.ts",
      expectUnguarded: [],
      expectTotal: 0,
      expectExcluded: 1,
      expectReasonIncludes: "待热区解锁后纳入",
    },
    {
      name: "非排除路径（agent 之外的模块）→ 同样的代码必须红（排除面不能外溢）",
      src: [
        "class A {",
        '  @Cron("0 */10 * * * *")',
        "  sweepAggregator() {",
        "    this.aggregator.sweep();",
        "  }",
        "}",
      ].join("\n"),
      path: "apps/admin-api/src/modules/sop/sop.service.ts",
      expectUnguarded: [{ line: 2, method: "sweepAggregator" }],
      expectTotal: 1,
    },
    {
      name: "guardTick 别名 → 绿（scheduler 既有写法；委托关系另有独立校验）",
      src: [
        "class A {",
        '  @Cron("* * * * *")',
        "  async tick() {",
        '    await this.guardTick("tick", () => this.tickBody());',
        "  }",
        "}",
      ].join("\n"),
      expectUnguarded: [],
      expectTotal: 1,
    },
    {
      name: "下一个方法的 try 不算（窗口止于方法体）",
      src: [
        "class A {",
        '  @Cron("* * * * *")',
        "  sweep() {",
        "    this.a();",
        "  }",
        "  next() {",
        "    try {",
        "      this.b();",
        "    } catch {}",
        "  }",
        "}",
      ].join("\n"),
      expectUnguarded: [{ line: 2, method: "sweep" }],
      expectTotal: 1,
    },
    {
      name: "字符串里的 @Cron( 不算（假阳性防护）",
      src: [
        'const doc = "@Cron(\\"* * * * *\\") 需要闸";',
        "class A {",
        "}",
      ].join("\n"),
      expectUnguarded: [],
      expectTotal: 0,
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const got = findUnguardedCrons(c.src, { path: c.path ?? "" });
    const problems = [];
    if (JSON.stringify(got.unguarded) !== JSON.stringify(c.expectUnguarded)) {
      problems.push(
        `unguarded 期望 ${JSON.stringify(c.expectUnguarded)} 实际 ${JSON.stringify(got.unguarded)}`,
      );
    }
    if (c.expectTotal !== undefined && got.total !== c.expectTotal) {
      problems.push(`total 期望 ${c.expectTotal} 实际 ${got.total}`);
    }
    if (
      c.expectExcluded !== undefined &&
      got.excluded.length !== c.expectExcluded
    ) {
      problems.push(
        `excluded 期望 ${c.expectExcluded} 实际 ${got.excluded.length}`,
      );
    }
    if (
      c.expectReasonIncludes &&
      !got.excluded.some((e) => e.reason.includes(c.expectReasonIncludes))
    ) {
      problems.push(`excluded.reason 未含「${c.expectReasonIncludes}」`);
    }
    if (problems.length > 0) {
      failed += 1;
      console.error(`✖ SELFTEST 失败：${c.name}`);
      for (const p of problems) console.error(`    ${p}`);
    }
  }

  // guardTick 委托校验自身也要有齿：缺 guardedCron 的 scheduler 必须判红。
  const delegOk = guardTickDelegatesToGuardedCron(
    "class S { private async guardTick(n, b) { try { await b(); } catch (e) { this.logger.warn(e); } } }",
  );
  if (delegOk) {
    failed += 1;
    console.error(
      "✖ SELFTEST 失败：guardTick 未委托 guardedCron 时，委托校验竟然判绿（判据词 guardTick 会沦为摆设）",
    );
  }
  if (
    !guardTickDelegatesToGuardedCron(
      'class S { private async guardTick(n, b) { await guardedCron("s." + n, this.logger, b); } }',
    )
  ) {
    failed += 1;
    console.error(
      "✖ SELFTEST 失败：guardTick 已委托 guardedCron，委托校验却判红",
    );
  }

  const totalCases = cases.length + 1;
  if (failed > 0) {
    console.error(
      `\n✖ check-cron-guard selftest：${totalCases - failed}/${totalCases} 通过`,
    );
    process.exit(1);
  }
  console.log(
    `✔ check-cron-guard selftest：${totalCases}/${totalCases} 通过` +
      `（含「注释里的 @Cron/try」「多行签名」「邻方法」「排除面」四类历史假绿/假红）`,
  );
}

if (process.argv.includes("--selftest")) {
  selftest();
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts"))
      files.push(p);
  }
})(SRC);

let total = 0;
const unguarded = [];
const excludedHits = [];
for (const f of files) {
  const rel = relative(ROOT, f).split("\\").join("/");
  const res = findUnguardedCrons(readFileSync(f, "utf8"), { path: rel });
  total += res.total;
  for (const u of res.unguarded) unguarded.push({ file: rel, ...u });
  for (const x of res.excluded) excludedHits.push({ file: rel, ...x });
}

if (total < MIN_EXPECTED_CRONS) {
  console.error(
    `✖ 只扫到 ${total} 个 @Cron 方法体（下界 ${MIN_EXPECTED_CRONS}）—— 扫描器失效了（不是"全加了闸"）。`,
  );
  process.exit(1);
}

// 显式排除面：**每次都打印**，不许静默。
if (excludedHits.length > 0) {
  const byPrefix = new Map();
  for (const h of excludedHits) {
    const p = EXCLUDED_PREFIXES.find((e) => h.file.startsWith(e.prefix));
    const key = p ? p.prefix : "(unknown)";
    if (!byPrefix.has(key)) byPrefix.set(key, []);
    byPrefix.get(key).push(h);
  }
  console.log("");
  console.log("⏭ 显式排除（**未**纳入本守卫的强制面，不是漏扫）：");
  for (const [prefix, hits] of byPrefix) {
    const reason =
      EXCLUDED_PREFIXES.find((e) => e.prefix === prefix)?.reason ?? "";
    console.log(`  · ${prefix}  ${hits.length} 个 @Cron`);
    console.log(`    理由：${reason}`);
    for (const h of hits) console.log(`     - ${h.file}:${h.line} ${h.method}`);
  }
}

// guardTick 作为判据词的前提：它必须真的委托 guardedCron。
if (unguarded.length === 0 && total > 0) {
  const schedulerPath = join(
    SRC,
    "modules",
    "scheduler",
    "scheduler.service.ts",
  );
  if (!guardTickDelegatesToGuardedCron(readFileSync(schedulerPath, "utf8"))) {
    console.error(
      "✖ scheduler.service.ts 的 guardTick 没有委托 guardedCron —— 判据词 guardTick 沦为摆设，" +
        "本守卫对 scheduler 的 5 个 @Cron 实际上是瞎的。",
    );
    process.exit(1);
  }
}

if (unguarded.length > 0) {
  console.error("");
  console.error(
    `✖ ${unguarded.length} 个 @Cron 方法体没有顶层异常闸（一次瞬态 DB 错误 = 整实例 exit(1)）：`,
  );
  for (const u of unguarded) {
    console.error(`  · ${u.file}:${u.line}  ${u.method}`);
  }
  console.error("");
  console.error("  修法（三选一，推荐第一种——闸只有一份实现）：");
  console.error(
    '    1) await guardedCron("<模块>.<方法>", this.logger, () => this.<方法>Body());',
  );
  console.error(
    '       import { guardedCron } from "../../common/utils/cron-guard.util";',
  );
  console.error(
    "    2) 方法体内自带顶层 try/catch（catch 里 logger.warn 记栈，不上抛）",
  );
  console.error(
    '    3) scheduler 内的 tick：await this.guardTick("<name>", () => this.<name>Body());',
  );
  console.error("");
  console.error(
    "  根因：@nestjs/schedule 的 cron 回调不 await 返回的 Promise，未捕获异常即 unhandledRejection →",
  );
  console.error(
    "  main.ts 的 gracefulFatalShutdown → exit(1)。这些任务都是幂等扫描，正确处置就是「记日志 + 下一拍重试」。",
  );
  process.exit(1);
}

console.log(
  `✔ @Cron 顶层异常闸齐备：${total} 个方法体全部有闸` +
    `（排除面 ${excludedHits.length} 个，见上）。`,
);
