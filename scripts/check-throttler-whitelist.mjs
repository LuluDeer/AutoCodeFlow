#!/usr/bin/env node
// 限流白名单同源守卫（PLAN-SECURITY-HARDENING §1.1）
//
// 背景：SEC-THROTTLE-BUCKET（审计 P1-1）把 `x-executor-address` 头的可信面
// 收窄到 `EXECUTOR_MACHINE_PATH_PATTERNS` 白名单内的路由——白名单之外一律
// 按出口 IP 计桶。这条修复的**正确性完全依赖白名单与真实机器面路由同源**：
// 新增一个执行器入站端点却忘了登记，该端点会静默退回 IP 计桶，多执行器共享
// NAT 出口时被叠加限流（B-2 要修的原始故障形态：回调/日志/配置热更新被 429）。
//
// 本仓已经为同类"漏登记"付过代价：SEC-THROTTLE-WHITELIST-GAP 就是
// `/executors/config` 与 `/executors/:address/terminal-states` 两条真实机器面
// 路由漏在白名单外。人的记性不是判据，静态对账才是。
//
// 判据（四条，缺一即红）：
//   ① **源码锚点存在**：白名单常量仍叫 EXECUTOR_MACHINE_PATH_PATTERNS、仍由
//      isExecutorMachinePath 消费——守卫被重命名/重构时本脚本必须红，而不是
//      因为找不到字面量就静默放行（"0 个匹配 → 0 个缺失"的永真陷阱）。
//   ② **已知机器面全命中**：KNOWN_EXECUTOR_MACHINE_ROUTES 里每条真实路由都要
//      被白名单里某条正则匹配（在源码里用真正则跑，不猜）。
//   ③ **守卫自检**：每条正则都能编译，且白名单不为空。
//   ④ **锚点纪律（T4 新增）**：每条正则都必须以 `$` 锚定尾部。守卫自己的修法
//      提示写着"补一条以 `$` 锚定尾部的正则"，但旧实现**从不检查**这件事——
//      于是 `/\/executors\/config/`（无锚点）会「命中」`/api/executors/config`，
//      对账报绿，而它同时把 `/api/executors/config-history`、`/api/executors/
//      configuration` 这类**人操作面**路由也划进了机器面：这些路由上的
//      `x-executor-address` 头从此可信（按地址而非 IP 计桶），等于把
//      SEC-THROTTLE-BUCKET 关掉的绕过面又打开一条。前缀匹配还会掩盖真的漏登记
//      （写成 `/executors` 就能"覆盖"全部执行器路由，对账永远绿）。
//
// ## T4（第 4 轮守卫自检审计）修掉的假绿
//
//   · **只测函数，不测闸门**：旧 `--selftest` 调 `validateWhitelistSource()` 断言
//     关键词，**从不跑真进程**。把 `process.exit(scanReal())` 删掉、或让
//     `scanReal()` 恒返回 0，`--selftest` 依然全绿——而这是本仓最贵的一类失效
//     （报告在说话，闸不关门）。现在在临时 fixture 树里跑真子进程，逐条断言
//     退出码 + 关键报错文本。
//   · **只数条数**：旧抽取断言是 `patterns.length === 1`——抽取器把**所有**认不出的
//     行 `continue` 掉时，只要样本里还剩一条能解析，条数照样对得上。现在抽取器
//     把认不出的**正则字面量行**单列到 `unparsed`，由判据升级为**结构红**
//     （`抽取口径与源码风格失配`）——「少认了几条」不再是静默。
//   · **前缀误配**：见上面判据 ④（旧实现把这条写成了一条"证明匹配是真的"的
//     自述型用例，实际没判任何东西）。
//   · **`import` 即执行**：旧文件末尾无条件 `process.exit(...)`，任何 import 它的
//     脚本都会顺手跑一遍守卫并退出（还可能带出一个不该有的退出码）。现在只在被
//     直接执行时跑。
//   · **`--root` 缺失 + 事实源缺失不成结构**：旧实现把根钉死在脚本上级目录，
//     selftest 只能喂内存字符串；守卫文件读不出来时也只打一行 `无法读取`，
//     与"判据红"混在同一输出形态里。现在路径相对 `root`，缺文件是**结构红**
//     并点名路径（退出码 1），selftest 因此能验证「守卫真的在扫盘」。
//
// 关于"从 controller 自动提取路由"的取舍：计划草案建议扫 executor.controller.ts
// 的全部 @Get/@Post 去和调用点比对。实际**做不到静态判定**——`/executors/pull`
// 与 `/executors/picker`、`/executors/config` 与 `/executors/runtime-config`
// 在装饰器形态上完全同型，"哪些是人操作面"只有出站调用点知道（executor-node
// pull.ts / callback.ts / scheduler.ts、executor-python routers/*.py）。
// 因此判据锚在**出站调用点清单**上：这份 KNOWN 清单是人工核对后的契约，新增
// 机器面端点时在这里加一行——比让脚本猜"是不是机器面"更可靠，也更能承载
// "为什么它是机器面"的理由。
//
// 退出码：0 = 全绿；1 = 任一判据失败，**或判据本身不可信**（结构错）。
//
// 用法：node scripts/check-throttler-whitelist.mjs [--selftest] [--root <dir>]
//   （根 package.json 的 check:throttler-whitelist = --selftest + 实扫）
//   --selftest：在临时 fixture 树上跑真子进程验证判据本身（不扫真实代码库）。
//   --root    ：把该目录当仓库根（selftest 专用）。

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 默认仓库根：脚本位于 `<repo>/scripts/`，由脚本位置推出，不依赖调用方 cwd。 */
export const DEFAULT_ROOT = resolve(HERE, "..");

export const GUARD_FILE = "apps/admin-api/src/common/guards/executor-aware-throttler.guard.ts";

// ── 源码锚点（重构即红，防"找不到就静默放行"）──────────────────────────────
const WHITELIST_CONST = "EXECUTOR_MACHINE_PATH_PATTERNS";
const CONSUMER_FN = "isExecutorMachinePath";

/**
 * 白名单条数下界（2026-10-29 实测 10 条）。
 *
 * 抽取器一旦与源码风格脱节（改用 `new RegExp(...)`、多行字面量、常量被拆成
 * 多个数组），`patterns` 会变少而**判据 ② 只会报"未覆盖"** —— 这本身是红的，
 * 但若同时 KNOWN 清单也被裁剪（或守卫被改成读另一份数据），两侧一起塌就变成
 * 永久绿。下界按实测值的 8/10 取：容忍合并同类项，不容忍口径失效。
 */
export const MIN_WHITELIST_PATTERNS = 8;

/**
 * 执行器 → 中台的**入站机器面**路由清单（与出站调用点一一对应）。
 *
 * 每条的 `caller` 是它的出处，便于改调用点时同步维护；`why` 记录"为什么它
 * 属于机器面"——没有 `why` 的条目在评审时无法与"人操作面"区分，正是历史上
 * 漏登记的成因。路径用真实形态（含全局 api 前缀、含路径参数占位）。
 */
const KNOWN_EXECUTOR_MACHINE_ROUTES = [
  {
    path: "/api/executions/callback",
    caller: "executor-node src/callback.ts:303 · executor-python routers/execute.py",
    why: "执行终态回调（批量），per-execution / per-executor 令牌认证",
  },
  {
    path: "/api/executions/exec-abc-123/logs",
    caller: "executor-node src/log-stream-pusher.ts:135",
    why: "RT-LOG 增量日志上报，执行器机器面",
  },
  {
    path: "/api/executors/register",
    caller: "executor-node src/main.ts:188 · src/routes/execute.ts:2087",
    why: "注册（含 token 轮换后的重新注册）",
  },
  {
    path: "/api/executors/heartbeat",
    caller: "executor-node src/scheduler.ts:271",
    why: "心跳（CPU/内存/在跑执行/解释器池上报）",
  },
  {
    path: "/api/executors/pull",
    caller: "executor-node src/pull.ts:311",
    why: "ARCH-32 pull 模式长轮询取件（NAT 内零入站）",
  },
  {
    path: "/api/executors/command-result",
    caller: "executor-node src/pull.ts:198 · src/config.ts:454",
    why: "pull 控制命令执行结果回执",
  },
  {
    path: "/api/executors/offline",
    caller: "executor-node src/main.ts:262",
    why: "优雅下线通告",
  },
  {
    path: "/api/executors/token",
    caller: "executor-node src/auth.ts:186 · src/startup-identity.ts:6",
    why: "执行器换取 per-executor 令牌",
  },
  // SEC-THROTTLE-WHITELIST-GAP（2026-10-17 审计实证）：以下两条此前漏登记，
  // 是本次修复的对象——它们就是本脚本存在的理由。
  {
    path: "/api/executors/config",
    caller: "executor-node src/pull.ts:229（maybePullConfig）",
    why: "E-1 pull 模式配置热更新拉取；per-executor 令牌认证",
  },
  {
    path: "/api/executors/RPA5:8002/terminal-states",
    caller: "executor-node src/callback.ts:633（fetchTerminalStates）",
    why: "A6 死信回调对账（只读）；@WriteGuard scope=token",
  },
];

/**
 * 从源码文本抽出白名单正则字面量。
 *
 * 返回值刻意**不是**「成功解析的那几条」：`unparsed` 收集所有"看起来是正则字面量
 * 却没解析出来"的行（`/.../` 写法变了、行尾注释、跨行拼接…）。调用方据此报
 * **结构红** —— 抽取器少认几条不能静默，否则「漏登记」会被"抽取器眼瞎"掩盖。
 *
 * @returns {{patterns: (RegExp|null)[], unparsed: string[]} | null}
 *   `null` = 连常量体都没找到（调用方按锚点缺失报错，绝不返回空数组冒充全部通过）。
 */
export function extractWhitelistPatterns(source) {
  const start = source.indexOf(`export const ${WHITELIST_CONST}`);
  if (start === -1) return null;
  // 常量体到下一个顶层 `];` 为止（数组字面量的结束）。
  const end = source.indexOf("];", start);
  if (end === -1) return null;
  const body = source.slice(start, end);
  const patterns = [];
  const unparsed = [];
  // 逐行取形如 `  /regex/,` 或 `  /regex/` 的字面量；跳过注释行。
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue;
    // 数组首行（`export const X = [`）与空行不是候选。
    if (line === "" || line.startsWith("export const") || line.startsWith("[")) continue;
    const match = /^\/(.+)\/([gimsuy]*)\s*,?\s*$/.exec(line);
    if (!match) {
      // 只有「像正则/正则应写在这里」的行才算 unparsed：`/` 开头或 `new RegExp(`。
      if (line.startsWith("/") || line.startsWith("new RegExp(")) unparsed.push(line);
      continue;
    }
    try {
      patterns.push(new RegExp(match[1], match[2]));
    } catch {
      // 正则本身写坏 → 交给"可编译"判据报错，这里只收集成功的。
      patterns.push(null);
    }
  }
  return { patterns, unparsed };
}

/**
 * 核心判据。
 *
 * @param {string} source 守卫源码
 * @param {{path: string, caller: string, why: string}[]} [knownRoutes]
 * @returns {{errors: string[], structure: string[]}}
 *   `errors` = 真实漏登记/锚点违规；`structure` = **判据本身不可信**（抽取口径失配）。
 */
export function validateWhitelistSource(source, knownRoutes = KNOWN_EXECUTOR_MACHINE_ROUTES) {
  const errors = [];
  const structure = [];

  // ① 源码锚点
  if (!source.includes(`export const ${WHITELIST_CONST}`)) {
    errors.push(
      `白名单常量 ${WHITELIST_CONST} 未找到——守卫被重命名/移走时必须同步更新本脚本，` +
        `否则本检查会退化成永真断言`,
    );
    return { errors, structure };
  }
  if (!source.includes(`${CONSUMER_FN}(`)) {
    errors.push(
      `消费函数 ${CONSUMER_FN} 未找到——白名单若不再被 getTracker 消费，` +
        `登记再多路由也不会生效`,
    );
  }

  const extracted = extractWhitelistPatterns(source);
  if (extracted === null) {
    errors.push(`无法从 ${WHITELIST_CONST} 的数组字面量中解析出正则（抽取器与源码风格脱节）`);
    return { errors, structure };
  }
  const { patterns, unparsed } = extracted;

  // 结构：抽取口径失配 —— 「少认了几条」必须显形，否则漏登记会被抽取器眼瞎掩盖。
  if (unparsed.length > 0) {
    structure.push(
      `抽取口径与源码风格失配：${unparsed.length} 行像正则字面量却解析不出 —— ` +
        `把这几行改成 \`  /<re>/,\` 单行形态（或同步更新 extractWhitelistPatterns）：` +
        unparsed.map((l) => `\n        ${l}`).join(""),
    );
  }

  // ③ 守卫自检
  if (patterns.length === 0) {
    errors.push(`${WHITELIST_CONST} 为空——所有机器面都会退回 IP 计桶`);
  } else if (patterns.length < MIN_WHITELIST_PATTERNS) {
    structure.push(
      `只抽出 ${patterns.length} 条白名单正则（下界 ${MIN_WHITELIST_PATTERNS}）—— ` +
        `抽取口径与源码已失配；这种分母下「已知路由全命中」毫无意义。`,
    );
  }
  const broken = patterns.filter((p) => p === null).length;
  if (broken > 0) {
    errors.push(`有 ${broken} 条白名单正则无法编译`);
  }

  const usable = patterns.filter((p) => p !== null);
  if (usable.length === 0) return { errors, structure };

  // ④ 锚点纪律：未以 `$` 结尾的正则做的是前缀匹配 —— 会把人操作面路由也划进
  //    机器面（`x-executor-address` 头在这些路由上变得可信），同时掩盖真漏登记。
  for (const re of usable) {
    if (!re.source.endsWith("$")) {
      errors.push(
        `白名单正则 /${re.source}/ 未以 $ 锚定尾部 —— 它做的是**前缀匹配**：` +
          `既会把人操作面路由（如 /api/executors/config-history）误划进机器面，` +
          `也会让「漏登记」被前缀"覆盖"掩盖（写成 /\\/executors/ 就能对账全绿）。` +
          `请补尾部 $。`,
      );
    }
  }

  // ② 已知机器面全命中
  for (const route of knownRoutes) {
    if (!usable.some((re) => re.test(route.path))) {
      errors.push(
        `机器面路由未被白名单覆盖：${route.path}\n` +
          `      调用点：${route.caller}\n` +
          `      理由：${route.why}\n` +
          `      → 在 ${WHITELIST_CONST} 补一条以 \`$\` 锚定尾部的正则`,
      );
    }
  }

  return { errors, structure };
}

/**
 * 扫真实守卫文件。
 *
 * @param {string} [root]
 * @returns {{errors: string[], structure: string[], stats: {patterns: number, routes: number}}}
 */
export function check(root = DEFAULT_ROOT) {
  const errors = [];
  const structure = [];
  const abs = join(root, GUARD_FILE);
  if (!existsSync(abs)) {
    structure.push(
      `事实源缺失：${GUARD_FILE} —— 守卫文件不在，白名单无从对账（路径改名/包被移走` +
        `都会这样，不是「同源」）。`,
    );
    return { errors, structure, stats: { patterns: 0, routes: 0 } };
  }
  const source = readFileSync(abs, "utf8");
  const result = validateWhitelistSource(source);
  const extracted = extractWhitelistPatterns(source);
  return {
    errors: result.errors,
    structure: [...structure, ...result.structure],
    stats: { patterns: extracted?.patterns.length ?? 0, routes: KNOWN_EXECUTOR_MACHINE_ROUTES.length },
  };
}

/**
 * 跑一次守卫（供 CLI 与 selftest 共用）。
 *
 * @param {{root?: string}} [options]
 * @returns {number} 退出码
 */
export function run({ root = DEFAULT_ROOT } = {}) {
  const { errors, structure, stats } = check(root);

  if (structure.length > 0) {
    console.error("");
    console.error("✘ 限流白名单同源检查结构错误（判据本身不可信，先修抽取口径/事实源）：");
    for (const s of structure) console.error(`   · ${s}`);
    console.error("");
    return 1;
  }
  if (errors.length > 0) {
    console.error("✗ 限流白名单同源检查未通过：");
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }
  console.log(
    `✓ 限流白名单同源检查通过（${stats.routes} 条机器面路由全部覆盖，` +
      `${stats.patterns} 条白名单正则均以 $ 锚定尾部）`,
  );
  return 0;
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

/** 与真实守卫逐字同源的 10 条正则（`String.raw` 保留反斜杠）。 */
const PATTERN_SOURCES = [
  String.raw`\/executions\/callback$`,
  String.raw`\/executions\/[^/]+\/logs$`,
  String.raw`\/executors\/register$`,
  String.raw`\/executors\/heartbeat$`,
  String.raw`\/executors\/pull$`,
  String.raw`\/executors\/command-result$`,
  String.raw`\/executors\/offline$`,
  String.raw`\/executors\/token$`,
  String.raw`\/executors\/config$`,
  String.raw`\/executors\/[^/]+\/terminal-states$`,
];

/** 造守卫源码：`patterns` 是正则源串数组；`constName` 可改（验证锚点判据）。 */
function guardSource({ patterns = PATTERN_SOURCES, constName = WHITELIST_CONST } = {}) {
  return [
    `export const ${constName}: readonly RegExp[] = [`,
    ...patterns.map((p) => `  /${p}/,`),
    "];",
    "",
    "export function isExecutorMachinePath(normalizedPath: string): boolean {",
    `  return ${constName}.some((re) => re.test(normalizedPath));`,
    "}",
    "",
  ].join("\n");
}

/** fixture 树：守卫文件默认合规，`source` 可替换。 */
function tree({ source = guardSource(), omit = false } = {}) {
  const files = { "package.json": { name: "fixture", private: true } };
  if (!omit) files[GUARD_FILE] = source;
  return files;
}

/** 自检：真子进程，逐条断言退出码 + 关键文本 + <1s。 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "throttler-selftest-" });
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

  subprocess("① 合规守卫（10 条已锚定正则覆盖全部已知路由）→ 绿", tree(), {
    code: 0,
    contains: ["限流白名单同源检查通过", "10 条机器面路由全部覆盖", "均以 $ 锚定尾部"],
    absent: ["结构错误", "未通过"],
  });

  subprocess(
    "② 漏登记一条真实机器面（本次修复的形态）→ 红（点名路径 + 调用点 + 理由）",
    tree({ source: guardSource({ patterns: PATTERN_SOURCES.filter((p) => !p.includes("executors\\/config$")) }) }),
    {
      code: 1,
      contains: [
        "机器面路由未被白名单覆盖：/api/executors/config",
        "调用点：executor-node src/pull.ts:229",
        "理由：E-1 pull 模式配置热更新拉取",
      ],
      absent: ["限流白名单同源检查通过"],
    },
  );

  subprocess(
    "③ 【反证·前缀误配】正则去掉尾部 $（前缀匹配）→ 红（会把人操作面划进机器面）",
    tree({
      source: guardSource({
        patterns: PATTERN_SOURCES.map((p) => (p.includes("executors\\/config$") ? String.raw`\/executors\/config` : p)),
      }),
    }),
    {
      code: 1,
      contains: ["未以 $ 锚定尾部", "前缀匹配", "config-history"],
      absent: ["限流白名单同源检查通过"],
    },
  );

  subprocess(
    "④ 【反证·注释算数】把 /executors/config 那条注释掉 → 红（注释里的正则不算登记）",
    tree({
      source: guardSource().replace("  /\\/executors\\/config$/,\n", "  // /\\/executors\\/config$/,\n"),
    }),
    {
      code: 1,
      contains: ["机器面路由未被白名单覆盖：/api/executors/config"],
      absent: ["限流白名单同源检查通过"],
    },
  );

  subprocess(
    "⑤ 常量被重命名 → 红（防永真：找不到字面量不能静默放行）",
    tree({ source: guardSource({ constName: "EXECUTOR_ROUTES" }) }),
    {
      code: 1,
      contains: ["白名单常量 EXECUTOR_MACHINE_PATH_PATTERNS 未找到", "永真断言"],
      absent: ["限流白名单同源检查通过"],
    },
  );

  subprocess(
    "⑥ 消费函数消失 → 红（登记了但没人消费 = 不生效）",
    tree({ source: guardSource().replace("isExecutorMachinePath(", "someOtherName(") }),
    {
      code: 1,
      contains: ["消费函数 isExecutorMachinePath 未找到"],
      absent: ["限流白名单同源检查通过"],
    },
  );

  subprocess(
    "⑦ 白名单为空 → 红（所有机器面退回 IP 计桶）",
    tree({ source: guardSource({ patterns: [] }) }),
    {
      code: 1,
      contains: ["为空——所有机器面都会退回 IP 计桶"],
      absent: ["限流白名单同源检查通过"],
    },
  );

  subprocess(
    "⑧ 【反证·抽取静默跳过】正则行写法失配（行尾带注释）→ 结构红，不是「全部覆盖」",
    tree({ source: guardSource().replace("  /\\/executors\\/token$/,", "  /\\/executors\\/token$/, // 换取令牌") }),
    {
      code: 1,
      contains: ["结构错误", "抽取口径与源码风格失配", "executors\\/token$/"],
      absent: ["限流白名单同源检查通过"],
    },
  );

  subprocess("⑨ 事实源缺失（守卫文件不在）→ 结构红并点名路径", tree({ omit: true }), {
    code: 1,
    contains: ["结构错误", `事实源缺失：${GUARD_FILE}`],
    absent: ["限流白名单同源检查通过", "ENOENT", "Error:"],
  });

  const failed = reportCases(cases, { title: "check-throttler-whitelist selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    selftest();
  } else {
    const rootArg = argValue(argv, "--root");
    process.exit(run({ root: rootArg ? resolve(rootArg) : DEFAULT_ROOT }));
  }
}
