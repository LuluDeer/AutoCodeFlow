#!/usr/bin/env node
/**
 * 守卫：**每个 `@Cron` 方法体都必须有顶层异常闸**（`try/catch` 或 `guardedCron(`）。
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
 * 对每个 `@Cron(` 装饰器，向下解析到**方法体**（词法掩码 + 花括号配对，不是固定
 * 行窗口），方法体里必须出现以下之一：
 *   - `try { … } catch` —— 站点自带的顶层 try/catch；
 *   - `guardedCron(`     —— `common/utils/cron-guard.util.ts` 的公共闸；
 *   - `guardTick(`       —— scheduler 的重入闸，**它内部委托 guardedCron**
 *                          （`guardTickDelegatesToGuardedCron` 单独校验这条委托，
 *                          否则 guardTick 就只是一个能通过检查的空词）。
 *
 * 已知边界：这是**文本判据**，不是语义分析。`try/catch` 写在方法体内很深的箭头
 * 函数里、或写成 `try{`（无空格）都由判据放行；它挡的是「新增 @Cron 时整个忘了包」，
 * 不是「包错了位置」。
 *
 * ## T4（第 4 轮守卫自检审计）修掉的假绿
 *
 *   · **`continue` 跳块**：旧实现里五个 `continue`（装饰器括号未配平 / 无签名 /
 *     参数表未配平 / 签名后不是 `{` / 方法体未配平）把「写坏的 @Cron」**静默跳过**：
 *     它既不进 `total`、也不进 `unguarded` —— 对守卫来说这个站点不存在。现在这些
 *     站点单列 `unparsed` 并判**结构红**（「没被扫到 = 没问题」是本仓最熟的形态）。
 *   · **`try` 无 `catch` 也算闸**：`try { … } finally { … }` 不吞 rejection —— 异常
 *     照样冒到 `unhandledRejection`，闸的作用为零。现在必须是 `try/catch`。
 *   · **排除前缀没写 `/`**：`apps/admin-api/src/modules/agent` 这种前缀会把
 *     `agent-*` 兄弟目录一并豁免（前缀误配）。现在前缀必须以 `/` 结尾，且每条排除
 *     必须带理由，否则结构红。
 *   · **崩溃 ≠ 红灯**：扫描根不存在时旧实现直接 `readdirSync` 抛栈（看起来像环境
 *     抖动，而不是「判据瞎了」）。现在事实源缺失 / 扫描面塌到下界 / 站点解析失败
 *     三种情况各自成型、各自文案。
 *   · `--root` + 导出 `check()`：模块级 `process.cwd()` 收成参数，`import` 时不实扫、
 *     不 `process.exit`。
 *   · `--selftest`：从「函数级 + 手搓 ok 布尔」改为**跑真脚本的子进程**，逐条断言
 *     退出码 + 关键文本（旧版删掉 `process.exit(1)` 也照样全绿）。
 *
 * 用法：`node scripts/check-cron-guard.mjs [--selftest] [--root <dir>]`
 *   --selftest：在临时 fixture 树里跑真脚本；每条断言退出码 + 关键文本 + <1s。
 *   --root    ：只给 selftest 用：把 fixture 树当仓库根扫（默认 process.cwd()）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { findCronSites, maskNonCode, matchBracket } from "./lib/cron-source.mjs";
import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

export const SRC_REL = "apps/admin-api/src";
export const SCHEDULER_REL = "apps/admin-api/src/modules/scheduler/scheduler.service.ts";

/** 判据词：顶层异常闸的三种既有形态。 */
const GUARD_CALL = /\b(?:guardedCron|guardTick)\s*\(/;
const TRY_OPEN = /(?<![\w$.])try\s*\{/g;

/** 扫不到这么多就是扫描器坏了（当前 21 个方法体 + 4 个显式排除）。 */
export const MIN_EXPECTED_CRONS = 20;

/**
 * **显式排除清单**（不是静默跳过）。
 *
 * 每一项都必须带理由，并被打印出来——「排除」和「漏扫」在本仓是两个概念：
 * 后者是缺陷，前者是待办。缺了 visible 打印，未来没人会想起来这 4 个 @Cron
 * 从未被这条守卫覆盖过。
 */
export const EXCLUDED_PREFIXES = [
  {
    prefix: "apps/admin-api/src/modules/agent/",
    reason:
      "modules/agent/** 待热区解锁后纳入（该目录正由并发 agent 修改，本守卫的强制面暂不覆盖；解锁后**必须**删掉本条并让扫描变红——按现状该目录 4 个 @Cron 中 sweepAggregator 仍无闸，审计 rt-5 已记）",
  },
];

/**
 * 方法体里是否有**真正吞掉异常**的 `try/catch`。
 *
 * T4 修正：旧实现只认 `try {`。`try { … } finally { … }` 会让异常继续冒泡到
 * `unhandledRejection`（finally 不处理 rejection），闸等于没加——这是本判据词
 * 最容易自我满足的一种写法（读起来「有 try」）。所以要求 `try` 的配对右括号之后
 * 紧跟 `catch`。
 *
 * @param {string} body 掩码后的方法体文本（含最外层花括号）
 */
export function hasTryWithCatch(body) {
  TRY_OPEN.lastIndex = 0;
  let m;
  while ((m = TRY_OPEN.exec(body)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(body, open, "{", "}");
    if (close < 0) continue;
    if (/^\s*catch\b/.test(body.slice(close + 1, close + 64))) return true;
  }
  return false;
}

/** 方法体是否已有顶层异常闸（三种既有形态）。 */
export function hasExceptionGuard(body) {
  if (GUARD_CALL.test(body)) return true;
  return hasTryWithCatch(body);
}

/**
 * 判定单个源文件里哪些 `@Cron` 方法体没有异常闸。
 *
 * 纯函数（不读盘）。判据的绿/红**仍由子进程断言**，因为真正会坏的是 CLI 的
 * `process.exit` 与报错文本（见 harness 头注）。
 *
 * @param {string} source 源文本
 * @param {{path?: string, excludedPrefixes?: Array<{prefix: string, reason: string}>}} opts
 *   `path` 只需是可匹配排除前缀的仓库相对路径。
 * @returns {{total: number,
 *            unguarded: Array<{line: number, method: string, hint: string}>,
 *            excluded: Array<{line: number, method: string, reason: string}>,
 *            unparsed: Array<{line: number, method: string|null, reason: string}>}}
 */
export function findUnguardedCrons(source, opts = {}) {
  const { path = "", excludedPrefixes = EXCLUDED_PREFIXES } = opts;
  const normPath = path.split("\\").join("/");
  const exclusion = excludedPrefixes.find((e) => normPath.startsWith(e.prefix));
  const { sites, unparsed } = findCronSites(source);

  if (exclusion) {
    return {
      total: 0,
      unguarded: [],
      excluded: sites.map((s) => ({ line: s.line, method: s.method, reason: exclusion.reason })),
      // 排除面内的文件**刻意**不参与判据，故其中的解析失败也不上报。
      unparsed: [],
    };
  }

  const unguarded = [];
  for (const site of sites) {
    if (hasExceptionGuard(site.body)) continue;
    TRY_OPEN.lastIndex = 0;
    const hasTry = TRY_OPEN.test(site.body);
    unguarded.push({
      line: site.line,
      method: site.method,
      hint: hasTry ? "try 无 catch（finally 不吞 rejection）" : "整个方法体裸奔",
    });
  }
  return { total: sites.length, unguarded, excluded: [], unparsed };
}

/**
 * `guardTick(` 是 scheduler 的重入闸而非异常闸——它之所以能作为判据词，**只**
 * 因为 `guardTick` 内部把异常委托给了 `guardedCron`。这条独立性由本函数钉住：
 * 一旦有人把 guardTick 的 try/catch 写回去（或删掉 guardedCron 调用），判据词
 * 立刻失效，这里必须红。**否则「guardTick」就是一个能通过检查的空词。**
 */
export function guardTickDelegatesToGuardedCron(schedulerSource) {
  // 先掩码再匹配：把委托调用**注释掉**（`// await guardedCron(...)`）后，剩下的
  // 只有 `try/catch` —— 而 try/catch 并不吞 cron 回调的 rejection，判据词会失效。
  return /\bguardedCron\s*\(/.test(maskNonCode(schedulerSource));
}

function walkTs(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      out.push(...walkTs(p));
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) {
      out.push(p);
    }
  }
  return out;
}

const relOf = (root, abs) => relative(root, abs).split(sep).join("/");

/**
 * 全量判据。返回 `{ total, unguarded, excludedHits, structure }`。
 *
 * `structure` 是**判据本身不可信**的错误（扫描根不存在、扫描面塌方、站点解析
 * 失败、事实源缺失），与「真的有 cron 没加闸」区分开：前者要说「守卫瞎了」，
 * 后者要说「代码有问题」，两者的修法完全不同。
 *
 * @param {string} [root] 仓库根
 */
export function check(root = process.cwd()) {
  const structure = [];
  const unguarded = [];
  const excludedHits = [];

  for (const e of EXCLUDED_PREFIXES) {
    if (!e.reason || e.reason.trim().length === 0) {
      structure.push(`排除项缺理由：${e.prefix}`);
    }
    // 前缀必须带尾斜杠：`…/modules/agent` 会豁免 `…/modules/agent-trigger`。
    if (!e.prefix.endsWith("/")) {
      structure.push(
        `排除前缀必须以 "/" 结尾（否则兄弟目录会被一并豁免）：${e.prefix}`,
      );
    }
  }

  const srcAbs = join(root, SRC_REL);
  const files = walkTs(srcAbs);
  if (files.length === 0) {
    structure.push(
      `扫描根不存在或没有 .ts 文件：${SRC_REL} —— 目录改名/清空时「0 个 = 全加了闸」是假绿。`,
    );
  }

  let total = 0;
  const unparsedHits = [];
  for (const f of files) {
    const rel = relOf(root, f);
    const res = findUnguardedCrons(readFileSync(f, "utf8"), { path: rel });
    total += res.total;
    for (const u of res.unguarded) unguarded.push({ file: rel, ...u });
    for (const x of res.excluded) excludedHits.push({ file: rel, ...x });
    for (const p of res.unparsed) unparsedHits.push({ file: rel, ...p });
  }

  if (unparsedHits.length > 0) {
    structure.push(
      `${unparsedHits.length} 个 @Cron 站点解析不出方法体 —— 它们既不进总数也不进判据（旧版在这里静默 continue）：` +
        unparsedHits
          .map((p) => `${p.file}:${p.line}${p.method ? " " + p.method : ""}（${p.reason}）`)
          .join("；"),
    );
  }
  if (total < MIN_EXPECTED_CRONS) {
    structure.push(
      `只扫到 ${total} 个 @Cron 方法体（下界 ${MIN_EXPECTED_CRONS}）—— 扫描器失效了（不是「全加了闸」）。`,
    );
  }

  if (total > 0) {
    const schedulerAbs = join(root, SCHEDULER_REL);
    if (!existsSync(schedulerAbs)) {
      structure.push(
        `scheduler 事实源不存在：${SCHEDULER_REL} —— 判据词 guardTick 的前提（委托 guardedCron）无从校验。`,
      );
    } else if (!guardTickDelegatesToGuardedCron(readFileSync(schedulerAbs, "utf8"))) {
      structure.push(
        "scheduler.service.ts 的 guardTick 没有委托 guardedCron —— 判据词 guardTick 沦为摆设，" +
          "本守卫对 scheduler 的 @Cron 实际上是瞎的。",
      );
    }
  }

  return { total, unguarded, excludedHits, structure };
}

// ── 自检（T4：真子进程 + 退出码 + 报错文本 + <1s）────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

/** fixture 里的「合规」方法（try/catch 形态）。 */
const guardedMethod = (name, indent = "  ") => [
  `${indent}@Cron("0 0 3 * * *")`,
  `${indent}async ${name}() {`,
  `${indent}  try {`,
  `${indent}    await this.repo.sweep();`,
  `${indent}  } catch (err) {`,
  `${indent}    this.logger.warn(String(err));`,
  `${indent}  }`,
  `${indent}}`,
];

const serviceClass = (methods, className = "FillerService") =>
  [`class ${className} {`, ...methods.flat(), "}", ""].join("\n");

/** 22 个合规方法 ≈ 真实规模（下界 20）。 */
const fillerService = (count = 22) =>
  serviceClass(
    Array.from({ length: count }, (_, i) => guardedMethod(`sweep${String(i).padStart(2, "0")}`)),
    "CoreService",
  );

/** scheduler 事实源：`guardTick` 是否真的委托 guardedCron。 */
const schedulerService = ({ delegates = true } = {}) =>
  [
    "class SchedulerService {",
    "  async guardTick(name: string, body: () => Promise<void>) {",
    delegates
      ? '    await guardedCron("scheduler." + name, this.logger, body);'
      : "    try { await body(); } catch (err) { this.logger.warn(String(err)); }",
    "  }",
    "}",
    "",
  ].join("\n");

const CASE_FILE = `${SRC_REL}/modules/task/scan.service.ts`;

/** 造一棵 fixture 仓库树（默认：22 个合规方法 + 一个合规的 case 文件 + scheduler）。 */
function cronTree({
  extra = {},
  filler = fillerService(),
  scheduler = schedulerService(),
  bare = false,
} = {}) {
  if (bare) return { "package.json": { name: "fixture", private: true } };
  return {
    "package.json": { name: "fixture", private: true },
    [`${SRC_REL}/modules/core/core.service.ts`]: filler,
    [SCHEDULER_REL]: scheduler,
    [CASE_FILE]: serviceClass([guardedMethod("scan")], "TaskService"),
    ...extra,
  };
}

/**
 * 自检：13 条子进程用例，每条断言「退出码 + 该绿/该红的关键文本」。
 *
 * 为什么不用函数级断言：本脚本的历史事故形态全在 **CLI 层** —— `process.exit` 是否
 * 真的执行、报错文本是否还在、`--root` 是否把路径吃掉。旧版 selftest 是「调纯函数 +
 * 比 JSON」，把 `process.exit(1)` 删掉它照样全绿（这正是 harness 头注里的「报告在
 * 说话，闸不关门」）。
 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "cron-guard-selftest-" });
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

  subprocess("① 干净树：22 个 try/catch + 1 个 guardedCron → 绿（报出总数与排除面）", cronTree(), {
    code: 0,
    contains: ["@Cron 顶层异常闸齐备：23 个方法体全部有闸", "排除面 0 个"],
    absent: ["✖"],
  });

  subprocess(
    "② 方法体裸奔 → 红（给出 file:line 方法名与「裸奔」提示）",
    cronTree({
      extra: {
        [CASE_FILE]: serviceClass(
          [
            [
              '  @Cron("* * * * *")',
              "  async sweep() {",
              "    await this.repo.delete({});",
              "  }",
            ],
          ],
          "TaskService",
        ),
      },
    }),
    {
      code: 1,
      contains: [
        "1 个 @Cron 方法体没有顶层异常闸",
        `${CASE_FILE}:2  sweep`,
        "整个方法体裸奔",
        "guardedCron(",
      ],
      absent: ["顶层异常闸齐备"],
    },
  );

  // ③ 历史假绿现场：注释里的 try/catch 与 guardedCron
  subprocess(
    "③ 【反证·注释算数】注释里的 try/catch 与 guardedCron 不算闸 → 红",
    cronTree({
      extra: {
        [CASE_FILE]: serviceClass(
          [
            [
              '  @Cron("* * * * *")',
              "  async sweep() {",
              "    // try { await this.repo.delete({}); } catch (e) {}",
              "    /* await guardedCron('x', this.logger, () => this.sweepBody()); */",
              "    await this.repo.delete({});",
              "  }",
            ],
          ],
          "TaskService",
        ),
      },
    }),
    {
      code: 1,
      contains: [`${CASE_FILE}:2  sweep`, "1 个 @Cron 方法体没有顶层异常闸"],
      absent: ["顶层异常闸齐备"],
    },
  );

  // ④ T4 新修的假绿：try/finally 不吞 rejection
  subprocess(
    "④ 【反证·try 无 catch】只有 try/finally 的方法体 → 红（finally 不吞 rejection）",
    cronTree({
      extra: {
        [CASE_FILE]: serviceClass(
          [
            [
              '  @Cron("* * * * *")',
              "  async sweep() {",
              "    try {",
              "      await this.repo.delete({});",
              "    } finally {",
              "      this.done = true;",
              "    }",
              "  }",
            ],
          ],
          "TaskService",
        ),
      },
    }),
    {
      code: 1,
      contains: [`${CASE_FILE}:2  sweep`, "try 无 catch（finally 不吞 rejection）"],
      absent: ["顶层异常闸齐备"],
    },
  );

  subprocess(
    "⑤ 多行装饰器实参 + 多行方法签名 → 仍正确定位（不靠固定行窗口）",
    cronTree({
      extra: {
        [CASE_FILE]: [
          "class TaskService {",
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
          "",
        ].join("\n"),
      },
    }),
    {
      code: 1,
      contains: [`${CASE_FILE}:2  cleanup`, "1 个 @Cron 方法体没有顶层异常闸"],
      absent: ["顶层异常闸齐备"],
    },
  );

  subprocess(
    "⑥ 字符串里的 @Cron( 不算装饰器 → 绿，且总数不多算",
    cronTree({
      extra: {
        [CASE_FILE]: [
          'const doc = "@Cron(\\"* * * * *\\") 需要闸";',
          serviceClass([guardedMethod("scan")], "TaskService"),
        ].join("\n"),
      },
    }),
    {
      code: 0,
      contains: ["23 个方法体全部有闸"],
      absent: ["24 个方法体", "✖"],
    },
  );

  subprocess(
    "⑦ 排除面（modules/agent/**）→ 绿，且**打印**排除项与理由（不是静默跳过）",
    cronTree({
      extra: {
        [`${SRC_REL}/modules/agent/trigger/agent-trigger.service.ts`]: serviceClass(
          [
            [
              '  @Cron("0 */10 * * * *")',
              "  sweepAggregator() {",
              "    this.aggregator.sweep();",
              "  }",
            ],
          ],
          "AgentTriggerService",
        ),
      },
    }),
    {
      code: 0,
      contains: [
        "显式排除",
        "apps/admin-api/src/modules/agent/",
        "待热区解锁后纳入",
        "排除面 1 个",
      ],
      absent: ["✖"],
    },
  );

  subprocess(
    "⑧ 【反证·排除面外溢】同样的代码放在 agent 之外的模块 → 红",
    cronTree({
      extra: {
        [`${SRC_REL}/modules/agent-trigger/agent-trigger.service.ts`]: serviceClass(
          [
            [
              '  @Cron("0 */10 * * * *")',
              "  sweepAggregator() {",
              "    this.aggregator.sweep();",
              "  }",
            ],
          ],
          "AgentTriggerService",
        ),
      },
    }),
    {
      code: 1,
      contains: ["modules/agent-trigger/agent-trigger.service.ts:2  sweepAggregator"],
      absent: ["顶层异常闸齐备"],
    },
  );

  subprocess(
    "⑨ 【反证·扫描面】只剩 3 个合规方法体 → 结构红（不是「全加了闸」）",
    cronTree({ filler: fillerService(3) }),
    {
      code: 1,
      contains: [
        "@Cron 扫描结构错误",
        "只扫到 4 个 @Cron 方法体",
        `下界 ${MIN_EXPECTED_CRONS}`,
        "扫描器失效",
      ],
      absent: ["顶层异常闸齐备"],
    },
  );

  subprocess(
    "⑩ 事实源缺失（apps/admin-api/src 整个不在）→ 结构红，不是崩栈也不是绿",
    cronTree({ bare: true }),
    {
      code: 1,
      contains: ["@Cron 扫描结构错误", `扫描根不存在或没有 .ts 文件：${SRC_REL}`],
      absent: ["顶层异常闸齐备", "Error:", "ENOENT"],
    },
  );

  // ⑪ T4 新修的假绿：解析不了就 continue（站点对守卫「不存在」）
  subprocess(
    "⑪ 【反证·continue 跳块】方法体花括号未配平 → 结构红并点名站点",
    cronTree({
      extra: {
        [CASE_FILE]: [
          "class TaskService {",
          '  @Cron("* * * * *")',
          "  async sweep() {",
          "    if (this.enabled) {",
          "      await this.repo.delete({});",
          "  }",
          "",
        ].join("\n"),
      },
    }),
    {
      code: 1,
      contains: [
        "@Cron 扫描结构错误",
        `${CASE_FILE}:2 sweep`,
        "解析不出方法体",
        "方法体花括号未配平",
      ],
      absent: ["顶层异常闸齐备"],
    },
  );

  subprocess(
    "⑫ guardTick 未委托 guardedCron → 结构红（判据词会沦为摆设）",
    cronTree({ scheduler: schedulerService({ delegates: false }) }),
    {
      code: 1,
      contains: ["结构错误", "guardTick 没有委托 guardedCron", "沦为摆设"],
      absent: ["顶层异常闸齐备"],
    },
  );

  subprocess(
    "⑬ 【反证·注释算数】委托调用只写在注释里 → 结构红（判据词会沦为摆设）",
    cronTree({
      scheduler: [
        "class SchedulerService {",
        "  async guardTick(name: string, body: () => Promise<void>) {",
        '    // await guardedCron("scheduler." + name, this.logger, body);',
        "    try { await body(); } catch (err) { this.logger.warn(String(err)); }",
        "  }",
        "}",
        "",
      ].join("\n"),
    }),
    {
      code: 1,
      contains: ["结构错误", "guardTick 没有委托 guardedCron", "沦为摆设"],
      absent: ["顶层异常闸齐备"],
    },
  );

  const failed = reportCases(cases, { title: "check-cron-guard selftest" });
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
    const { total, unguarded, excludedHits, structure } = check(root);

    if (structure.length > 0) {
      console.error("");
      console.error("✖ @Cron 扫描结构错误（判据本身不可信，先修扫描面）：");
      for (const e of structure) console.error("  · " + e);
      console.error("");
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
        const reason = EXCLUDED_PREFIXES.find((e) => e.prefix === prefix)?.reason ?? "";
        console.log(`  · ${prefix}  ${hits.length} 个 @Cron`);
        console.log(`    理由：${reason}`);
        for (const h of hits) console.log(`     - ${h.file}:${h.line} ${h.method}`);
      }
    }

    if (unguarded.length > 0) {
      console.error("");
      console.error(
        `✖ ${unguarded.length} 个 @Cron 方法体没有顶层异常闸（一次瞬态 DB 错误 = 整实例 exit(1)）：`,
      );
      for (const u of unguarded) {
        console.error(`  · ${u.file}:${u.line}  ${u.method}   ← ${u.hint}`);
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
        "    2) 方法体内自带顶层 try/catch（catch 里 logger.warn 记栈，不上抛；**try/finally 不算**）",
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
  }
}
