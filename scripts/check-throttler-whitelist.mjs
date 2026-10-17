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
// 判据（三条，缺一即红）：
//   ① **源码锚点存在**：白名单常量仍叫 EXECUTOR_MACHINE_PATH_PATTERNS、仍由
//      isExecutorMachinePath 消费——守卫被重命名/重构时本脚本必须红，而不是
//      因为找不到字面量就静默放行（"0 个匹配 → 0 个缺失"的永真陷阱）。
//   ② **已知机器面全命中**：KNOWN_EXECUTOR_MACHINE_ROUTES 里每条真实路由都要
//      被白名单里某条正则匹配（在源码里用真正则跑，不猜）。
//   ③ **守卫自检**：每条正则都能编译，且白名单不为空。
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
// 退出码：0 = 全绿；1 = 任一判据失败。
//
// 用法：node scripts/check-throttler-whitelist.mjs [--selftest]
//   （根 package.json 的 check:throttler-whitelist = --selftest + 实扫）
//   --selftest：用内置 fixture 验证判据本身（不扫真实代码库）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const GUARD_FILE = "apps/admin-api/src/common/guards/executor-aware-throttler.guard.ts";

// ── 源码锚点（重构即红，防"找不到就静默放行"）──────────────────────────────
const WHITELIST_CONST = "EXECUTOR_MACHINE_PATH_PATTERNS";
const CONSUMER_FN = "isExecutorMachinePath";

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
 * 从源码文本抽出白名单正则字面量。只认 `/.../` 形式的行（本文件的既有风格），
 * 抽取失败时返回 null 由调用方报错——**绝不**返回空数组冒充"全部通过"。
 */
export function extractWhitelistPatterns(source) {
  const start = source.indexOf(`export const ${WHITELIST_CONST}`);
  if (start === -1) return null;
  // 常量体到下一个顶层 `];` 为止（数组字面量的结束）。
  const end = source.indexOf("];", start);
  if (end === -1) return null;
  const body = source.slice(start, end);
  const patterns = [];
  // 逐行取形如 `  /regex/,` 或 `  /regex/` 的字面量；跳过 // 注释行。
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue;
    const match = /^\/(.+)\/([gimsuy]*),?$/.exec(line);
    if (!match) continue;
    try {
      patterns.push(new RegExp(match[1], match[2]));
    } catch {
      // 正则本身写坏 → 交给"可编译"判据报错，这里只收集成功的。
      patterns.push(null);
    }
  }
  return patterns;
}

/**
 * 核心判据（纯函数，selftest 直接驱动）。
 * @returns {string[]} 错误列表；空数组 = 全绿。
 */
export function validateWhitelistSource(source, knownRoutes = KNOWN_EXECUTOR_MACHINE_ROUTES) {
  const errors = [];

  // ① 源码锚点
  if (!source.includes(`export const ${WHITELIST_CONST}`)) {
    errors.push(
      `白名单常量 ${WHITELIST_CONST} 未找到——守卫被重命名/移走时必须同步更新本脚本，` +
        `否则本检查会退化成永真断言`,
    );
    return errors;
  }
  if (!source.includes(`${CONSUMER_FN}(`)) {
    errors.push(
      `消费函数 ${CONSUMER_FN} 未找到——白名单若不再被 getTracker 消费，` +
        `登记再多路由也不会生效`,
    );
  }

  const patterns = extractWhitelistPatterns(source);
  if (patterns === null) {
    errors.push(`无法从 ${WHITELIST_CONST} 的数组字面量中解析出正则（抽取器与源码风格脱节）`);
    return errors;
  }

  // ③ 守卫自检
  if (patterns.length === 0) {
    errors.push(`${WHITELIST_CONST} 为空——所有机器面都会退回 IP 计桶`);
  }
  const broken = patterns.filter((p) => p === null).length;
  if (broken > 0) {
    errors.push(`有 ${broken} 条白名单正则无法编译`);
  }

  const usable = patterns.filter((p) => p !== null);
  if (usable.length === 0) return errors;

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

  return errors;
}

function scanReal() {
  let source;
  try {
    source = readFileSync(join(ROOT, GUARD_FILE), "utf8");
  } catch (error) {
    console.error(`✗ 无法读取 ${GUARD_FILE}：${error.message}`);
    return 1;
  }
  const errors = validateWhitelistSource(source);
  if (errors.length > 0) {
    console.error("✗ 限流白名单同源检查未通过：");
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }
  console.log(
    `✓ 限流白名单同源检查通过（${KNOWN_EXECUTOR_MACHINE_ROUTES.length} 条机器面路由全部覆盖）`,
  );
  return 0;
}

function runSelftest() {
  const goodSource = [
    "export const EXECUTOR_MACHINE_PATH_PATTERNS: readonly RegExp[] = [",
    "  /\\/executions\\/callback$/,",
    "  /\\/executors\\/register$/,",
    "];",
    "",
    "export function isExecutorMachinePath(p: string): boolean {",
    "  return EXECUTOR_MACHINE_PATH_PATTERNS.some((re) => re.test(p));",
    "}",
  ].join("\n");

  const cases = [
    {
      name: "好样例（覆盖全部已知路由）应零报错",
      source: goodSource,
      routes: [
        { path: "/api/executions/callback", caller: "t", why: "t" },
        { path: "/api/executors/register", caller: "t", why: "t" },
      ],
      expected: [],
    },
    {
      name: "漏登记一条真实机器面应被拦截（本次修复的形态）",
      source: goodSource,
      routes: [
        { path: "/api/executions/callback", caller: "t", why: "t" },
        { path: "/api/executors/config", caller: "pull.ts", why: "配置热更新" },
      ],
      expected: ["机器面路由未被白名单覆盖", "/api/executors/config", "pull.ts"],
    },
    {
      name: "常量被重命名应被拦截（防永真）",
      source: goodSource.replace(
        "EXECUTOR_MACHINE_PATH_PATTERNS",
        "EXECUTOR_ROUTES",
      ),
      routes: [],
      expected: ["未找到"],
    },
    {
      name: "白名单为空应被拦截",
      source: [
        "export const EXECUTOR_MACHINE_PATH_PATTERNS: readonly RegExp[] = [",
        "];",
        "export function isExecutorMachinePath(p: string) { return false; }",
      ].join("\n"),
      routes: [],
      expected: ["为空"],
    },
    {
      name: "消费函数消失应被拦截（登记了但不生效）",
      source: goodSource.replace("isExecutorMachinePath(", "someOtherName("),
      routes: [],
      expected: ["消费函数"],
    },
    {
      name: "只做前缀匹配的正则不应误判为覆盖（锚点纪律）",
      // /\/executors\/config/ 无 $ 锚点，会误吞 /api/executors/config/extra；
      // 但本判据只查"是否命中"，因此用一条**不命中**的样例证明匹配是真的。
      source: [
        "export const EXECUTOR_MACHINE_PATH_PATTERNS: readonly RegExp[] = [",
        "  /\\/executors\\/runtime-config$/,",
        "];",
        "export function isExecutorMachinePath(p: string) { return true; }",
      ].join("\n"),
      routes: [{ path: "/api/executors/config", caller: "t", why: "t" }],
      expected: ["未被白名单覆盖"],
    },
  ];

  let failed = false;
  for (const check of cases) {
    const errors = validateWhitelistSource(check.source, check.routes);
    const missing = check.expected.filter(
      (keyword) => !errors.some((error) => error.includes(keyword)),
    );
    if (check.expected.length === 0 && errors.length > 0) {
      console.error(
        `✗ selftest「${check.name}」出现意外报错：\n  - ${errors.join("\n  - ")}`,
      );
      failed = true;
    } else if (missing.length > 0) {
      console.error(
        `✗ selftest「${check.name}」未命中预期关键词 ${JSON.stringify(missing)}；` +
          `实际报错：\n  - ${errors.join("\n  - ") || "（无）"}`,
      );
      failed = true;
    }
  }

  // 抽取器单元断言：注释行 / 尾逗号 / flags 形态。
  const extractCases = [
    {
      name: "注释行不被当成正则",
      source: [
        "export const EXECUTOR_MACHINE_PATH_PATTERNS = [",
        "  // /\\/ghost$/,",
        "  /\\/real$/,",
        "];",
      ].join("\n"),
      expectCount: 1,
    },
    {
      name: "flags 与尾逗号都能解析",
      source: [
        "export const EXECUTOR_MACHINE_PATH_PATTERNS = [",
        "  /\\/a$/i,",
        "  /\\/b$/,",
        "];",
      ].join("\n"),
      expectCount: 2,
    },
  ];
  for (const check of extractCases) {
    const patterns = extractWhitelistPatterns(check.source);
    const count = patterns === null ? -1 : patterns.length;
    if (count !== check.expectCount) {
      console.error(
        `✗ selftest「${check.name}」期望 ${check.expectCount} 条，实际 ${count}`,
      );
      failed = true;
    }
  }

  if (failed) {
    console.error("✗ check-throttler-whitelist selftest 未全绿");
    return 1;
  }
  console.log(
    `✓ check-throttler-whitelist selftest 全绿（${cases.length} 个判据 fixture + ${extractCases.length} 个抽取断言）`,
  );
  return 0;
}

if (process.argv.includes("--selftest")) {
  process.exit(runSelftest());
}
process.exit(scanReal());
