#!/usr/bin/env node
/**
 * 一致性闸：四方失败原因枚举必须互相对齐。
 *
 * 为什么需要：`failureReason` 在**四个**地方各有一份清单，任何一处漏改都会
 * 造成静默故障——最严重的是 admin 回调 DTO 的 `@IsIn`：执行器上报了一个
 * 未登记的值会让**整批**回调 400 被拒（不是单条失败），任务永远停在运行中。
 *
 *   ① packages/executor-protocol/protocol.json  （唯一事实源）
 *   ② apps/admin-api .../task-execution.entity.ts （TS 枚举）
 *   ③ packages/autoflow-sdk/.../callback.py       （Python SDK 校验集）
 *   ④ apps/executor-node/src/callback.ts          （客户端执行器可上报集）
 *
 * 纯静态读取，不需要 npm ci / PG / Redis。
 *
 * ## T4（第 4 轮守卫自检审计）修掉的假绿 / 假红
 *
 *   · **事实源被清空 = 永真断言**：旧实现没有任何规模断言。`protocol.json` 的
 *     `all` / `executorReportable` 一旦被清空（或键名改错成空数组），四方比对就是
 *     「[] === []」——四条判据全 OK、退出码 0，而枚举实际上已经没人守了。
 *     现在 `all` / `executorReportable` 各有下界，不足即**结构红**。
 *   · **注释算数**：旧实现把「从变量名往后 900 字符里的第一个 `{…}`」整段当集合，
 *     再用 `'([a-z_]+)'|"([a-z_]+)"` 抽值——于是**注释里**写的 `# "timeout" 待补`
 *     （Python）或 `// 'timeout'`（TS）会被当成真实成员：漏改的那一端因此**假绿**。
 *     反方向同样坏：admin 枚举的块注释里出现 `OLD = "old_reason"` 会把一个不存在
 *     的取值算成成员（假红，逼人往契约里塞垃圾）。现在先剥注释（Python `#` /
 *     TS `//`、`/* *​/`）再抽值。
 *   · **窗口式抽取（`{0,900}?`）会认错集合**：变量名在注释/字符串里先出现一次时，
 *     抽取的是**别处**的 `{…}`。现在锚定到「变量名 + `=` + 第一个括号」，并用括号
 *     配对取整块（`frozenset({…})` 这类嵌套也能取对）。
 *   · **崩溃 ≠ 红灯**：事实源读不到 / 解析不到时旧实现 `throw new Error(...)` 抛栈，
 *     与「算出来不一致」混在同一个退出通道（退出码都是 1，但文案不可读、CI 日志像
 *     脚本崩了）。现在结构错误单独成形、单独文案，且判据停止在「不可信」这一步。
 *   · `--root` + 导出 `check()`：模块级 `import.meta.url` 推出的仓库根收成参数，
 *     `import` 时不实扫、不 `process.exit`。
 *   · `--selftest`：跑真脚本的子进程，12 条用例逐条断言退出码 + 关键文本
 *     （含上述三种假绿的直接反证）。
 *
 * 用法：`node scripts/check-failure-reasons.mjs [--selftest] [--root <dir>]`
 *   --selftest：在临时 fixture 树里跑真脚本（需要仓库根布局：packages/ + apps/）。
 *   --root    ：只给 selftest 用：把 fixture 树当仓库根（默认 process.cwd()）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

export const PROTOCOL_REL = "packages/executor-protocol/protocol.json";
export const ENTITY_REL = "apps/admin-api/src/modules/task/entities/task-execution.entity.ts";
export const SDK_PY_REL = "packages/autoflow-sdk/autoflow_sdk/callback.py";
export const EXECUTOR_TS_REL = "apps/executor-node/src/callback.ts";

/**
 * 规模下界（2026-10-29 实测：all 15 / executorReportable 12）。
 * 「0 条 vs 0 条」是永真断言，塌到下界以下一律**结构红**。
 */
export const MIN_ALL_REASONS = 10;
export const MIN_REPORTABLE_REASONS = 5;

const uniqSorted = (list) => [...new Set(list)].sort();
const readText = (abs) => {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
};

/** TS/JS 注释剥掉（`//` 与 `/* … *​/`）。方向是「少剥」：误剥只会误红，不会误绿。 */
export function stripTsComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "")
    .replace(/([^:"'])\/\/[^\n]*/g, "$1");
}

/** Python 注释剥掉（`#` 到行尾）。取值都是 `[a-z_]+` 字面量，字符串里不会出现 `#`。 */
export function stripPyComments(src) {
  return String(src)
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");
}

/**
 * 从 `from` 起找第一个括号并配对取整块内容（支持 `frozenset({…})` 这类嵌套）。
 * 返回 `{ inner, end }`，找不到返回 null。
 */
export function bracketBlock(src, from) {
  const openers = "([{";
  const closers = ")]}";
  let start = -1;
  for (let i = from; i < src.length; i += 1) {
    if (openers.includes(src[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (openers.includes(c)) depth += 1;
    else if (closers.includes(c)) {
      depth -= 1;
      if (depth === 0) return { inner: src.slice(start + 1, i), end: i + 1 };
    }
  }
  return null;
}

/**
 * 抽一个「变量名 = <括号块>」里登记的取值。
 *
 * 锚定「变量名 + `=`」而不是「变量名之后 900 字符内的第一个括号」：后者在变量名
 * 先出现在注释/字符串里时会认错集合（T4 修掉的假绿）。
 *
 * @param {string} src 已剥注释的源码
 * @param {RegExp} assignmentRe 锚定「变量名 + 等号 + 空白」的正则（调用处见 ③④）
 * @returns {string[]|null} null = 连赋值都没找到（调用方判结构红）
 */
export function collectAssignedValues(src, assignmentRe) {
  const m = assignmentRe.exec(src);
  if (!m) return null;
  const block = bracketBlock(src, m.index + m[0].length);
  if (!block) return null;
  return [...block.inner.matchAll(/(['"])([a-z_]+)\1/g)].map((x) => x[2]);
}

/**
 * 判据本体。返回 `{ structure, results, counts }`：
 *   · structure = 结构性（事实源读不到 / 解析不到 / 规模塌了）——「判据本身不可信」；
 *   · results   = 四方比对结果（structure 非空时为空，因为此时比对已不可信）。
 */
export function check({ root = process.cwd() } = {}) {
  const structure = [];
  const results = [];
  const counts = { all: 0, reportable: 0, internal: 0 };

  // ── ① 事实源 ────────────────────────────────────────────────────────────
  const protoText = readText(join(root, PROTOCOL_REL));
  if (protoText === null) {
    structure.push(`读不到 ${PROTOCOL_REL} —— 事实源不见了，四方比对无从谈起。`);
    return { structure, results, counts };
  }
  let proto;
  try {
    proto = JSON.parse(protoText);
  } catch (error) {
    structure.push(`${PROTOCOL_REL} 不是合法 JSON（${error.message}）—— 事实源已不可解析。`);
    return { structure, results, counts };
  }
  const bucket = proto?.failureReason;
  if (!bucket || typeof bucket !== "object") {
    structure.push(`${PROTOCOL_REL} 缺 failureReason 段 —— 键名/结构变了，判据已经瞎了。`);
    return { structure, results, counts };
  }
  const all = bucket.all;
  const reportable = bucket.executorReportable;
  const internal = bucket.adminInternalOnly ?? [];
  for (const [name, value] of [
    ["failureReason.all", all],
    ["failureReason.executorReportable", reportable],
    ["failureReason.adminInternalOnly", internal],
  ]) {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      structure.push(`${PROTOCOL_REL} 的 ${name} 不是字符串数组 —— 事实源格式变了。`);
    }
  }
  if (structure.length > 0) return { structure, results, counts };

  counts.all = all.length;
  counts.reportable = reportable.length;
  counts.internal = internal.length;
  if (all.length < MIN_ALL_REASONS) {
    structure.push(
      `protocol.failureReason.all 只有 ${all.length} 项（下界 ${MIN_ALL_REASONS}）—— 事实源被清空了，四方比对会变成「[] === []」的永真断言。`,
    );
  }
  if (reportable.length < MIN_REPORTABLE_REASONS) {
    structure.push(
      `protocol.failureReason.executorReportable 只有 ${reportable.length} 项（下界 ${MIN_REPORTABLE_REASONS}）—— 同上，三端集合比对会恒真。`,
    );
  }
  if (structure.length > 0) return { structure, results, counts };

  const compare = (name, actual, expected) => {
    const a = uniqSorted(actual);
    const e = uniqSorted(expected);
    results.push({ name, ok: JSON.stringify(a) === JSON.stringify(e), actual: a, expected: e });
  };

  // ① 自洽性：reportable 必须是 all 去掉 admin 内部专用后的集合。
  compare("protocol: all minus adminInternalOnly === executorReportable", all.filter((r) => !internal.includes(r)), reportable);

  // ── ② admin TS 枚举 ─────────────────────────────────────────────────────
  const entityRaw = readText(join(root, ENTITY_REL));
  if (entityRaw === null) {
    structure.push(`读不到 ${ENTITY_REL} —— 枚举面不存在了（不是「枚举为空」）。`);
    return { structure, results, counts };
  }
  const entitySrc = stripTsComments(entityRaw);
  const enumHead = /enum\s+ExecutionFailureReason\s*\{/.exec(entitySrc);
  if (!enumHead) {
    structure.push(`${ENTITY_REL} 里找不到 \`enum ExecutionFailureReason\` —— 判据失配（不是「枚举没问题」）。`);
    return { structure, results, counts };
  }
  const enumBlock = bracketBlock(entitySrc, enumHead.index + enumHead[0].length - 1);
  const enumValues = enumBlock ? [...enumBlock.inner.matchAll(/=\s*"([a-z_]+)"/g)].map((m) => m[1]) : [];
  if (enumValues.length < MIN_REPORTABLE_REASONS) {
    structure.push(
      `只解析出 ${enumValues.length} 个 ExecutionFailureReason 枚举值（下界 ${MIN_REPORTABLE_REASONS}）—— 成员写法变了，比对不可信。`,
    );
    return { structure, results, counts };
  }
  compare("admin ExecutionFailureReason === protocol.all", enumValues, all);

  // ── ③ Python SDK 校验集（只认执行器可上报子集）────────────────────────
  const pyRaw = readText(join(root, SDK_PY_REL));
  if (pyRaw === null) {
    structure.push(`读不到 ${SDK_PY_REL} —— SDK 校验集不存在了。`);
    return { structure, results, counts };
  }
  const pyValues = collectAssignedValues(stripPyComments(pyRaw), /\bVALID_FAILURE_REASONS\s*(?::[^=\n]*)?=\s*/);
  if (pyValues === null) {
    structure.push(`${SDK_PY_REL} 里找不到 \`VALID_FAILURE_REASONS = …\` —— 判据失配。`);
    return { structure, results, counts };
  }
  if (pyValues.length < MIN_REPORTABLE_REASONS) {
    structure.push(
      `只解析出 ${pyValues.length} 个 VALID_FAILURE_REASONS（下界 ${MIN_REPORTABLE_REASONS}）—— 写法变了或集合被清空，比对会恒真。`,
    );
    return { structure, results, counts };
  }
  compare("autoflow-sdk VALID_FAILURE_REASONS === protocol.executorReportable", pyValues, reportable);

  // ── ④ 客户端执行器可上报集 ──────────────────────────────────────────────
  const cbRaw = readText(join(root, EXECUTOR_TS_REL));
  if (cbRaw === null) {
    structure.push(`读不到 ${EXECUTOR_TS_REL} —— 执行器可上报集不存在了。`);
    return { structure, results, counts };
  }
  const cbValues = collectAssignedValues(stripTsComments(cbRaw), /\bCALLBACK_FAILURE_REASONS\s*(?::[^=\n]*)?=\s*/);
  if (cbValues === null) {
    structure.push(`${EXECUTOR_TS_REL} 里找不到 \`CALLBACK_FAILURE_REASONS = […] \` —— 判据失配。`);
    return { structure, results, counts };
  }
  if (cbValues.length < MIN_REPORTABLE_REASONS) {
    structure.push(
      `只解析出 ${cbValues.length} 个 CALLBACK_FAILURE_REASONS（下界 ${MIN_REPORTABLE_REASONS}）—— 写法变了或集合被清空，比对会恒真。`,
    );
    return { structure, results, counts };
  }
  compare("executor-node CALLBACK_FAILURE_REASONS === protocol.executorReportable", cbValues, reportable);

  return { structure, results, counts };
}

// ── 自检（T4：全部跑真脚本子进程）─────────────────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

// fixture 事实源：12 个执行器可上报值 + 3 个 admin 内部专用值（all=15，过两条下界）。
const INTERNAL = ["stale_recovered", "application_missing", "never_dispatched"];
const REPORTABLE = [
  "package_fetch_failed",
  "script_error",
  "timeout",
  "executor_offline",
  "executor_restart",
  "dependency_install_failed",
  "git_fetch_failed",
  "runtime_missing",
  "sandbox_unavailable",
  "interpreter_unavailable",
  "killed",
  "unknown",
];
const ALL = [...REPORTABLE, ...INTERNAL];

const protocolFile = ({ all = ALL, reportable = REPORTABLE, internal = INTERNAL } = {}) => ({
  failureReason: {
    $comment: "fixture 事实源",
    all,
    adminInternalOnly: internal,
    executorReportable: reportable,
  },
});

const entityFile = (values) =>
  [
    "export enum ExecutionFailureReason {",
    ...values.map((v) => `  ${v.toUpperCase()} = "${v}",`),
    "}",
    "",
  ].join("\n");

const pyFile = (values, comments = []) =>
  ["VALID_FAILURE_REASONS = frozenset({", ...comments, ...values.map((v) => `    "${v}",`), "})", ""].join("\n");

const tsFile = (values, comments = []) =>
  [
    "export const CALLBACK_FAILURE_REASONS = [",
    ...comments,
    ...values.map((v) => `  '${v}',`),
    "] as const;",
    "",
  ].join("\n");

function reasonTree({ protocol, entity, py, ts, drop = [] } = {}) {
  const files = {
    [PROTOCOL_REL]: protocol ?? protocolFile(),
    [ENTITY_REL]: entity ?? entityFile(ALL),
    [SDK_PY_REL]: py ?? pyFile(REPORTABLE),
    [EXECUTOR_TS_REL]: ts ?? tsFile(REPORTABLE),
  };
  for (const d of drop) delete files[d];
  return files;
}

const omit = (list, v) => list.filter((x) => x !== v);

/**
 * 自检：12 条用例，全部 `spawn` 真脚本（`--root` 指向 fixture 树）。
 *
 * 旧版**没有 selftest**（模块级直接执行 + `throw` 抛栈），所以「事实源被清空 → 永真绿」
 * 与「注释里的值被算成成员」这两处假绿没有任何东西钉住。
 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "failure-reasons-selftest-" });
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

  subprocess("① 干净树：四方一致（all=15 / reportable=12）→ 绿", reasonTree(), {
    code: 0,
    contains: [
      "failure-reason alignment OK: all=15, reportable=12",
      "OK   protocol: all minus adminInternalOnly === executorReportable  (12)",
      "OK   admin ExecutionFailureReason === protocol.all  (15)",
      "OK   autoflow-sdk VALID_FAILURE_REASONS === protocol.executorReportable  (12)",
      "OK   executor-node CALLBACK_FAILURE_REASONS === protocol.executorReportable  (12)",
    ],
    absent: ["FAIL ", "结构错误", "drift(s) detected"],
  });

  subprocess("② admin 枚举漏一个值 → 红并给出 actual/expected", reasonTree({ entity: entityFile(omit(ALL, "timeout")) }), {
    code: 1,
    contains: ["FAIL admin ExecutionFailureReason === protocol.all", "timeout", "drift(s) detected"],
    absent: ["alignment OK"],
  });

  // ③ 修掉的假绿：值从 Python 集合里删掉、但把它写在**注释**里（旧实现从注释里抽到了它）
  subprocess(
    "③ 【反证·注释算数】Python 集合少一个值、注释里还写着它 → 仍红（注释不算成员）",
    reasonTree({
      py: pyFile(omit(REPORTABLE, "timeout"), ['    # 待补： "timeout"（旧实现把这里当成成员 → 假绿）']),
    }),
    {
      code: 1,
      contains: ["FAIL autoflow-sdk VALID_FAILURE_REASONS === protocol.executorReportable", "timeout"],
      absent: ["alignment OK"],
    },
  );

  subprocess(
    "④ 【反证·注释算数】executor-node 数组少一个值、注释里还写着它 → 仍红",
    reasonTree({ ts: tsFile(omit(REPORTABLE, "killed"), ["  // 'killed' 将在下个版本补回"]) }),
    {
      code: 1,
      contains: ["FAIL executor-node CALLBACK_FAILURE_REASONS === protocol.executorReportable", "killed"],
      absent: ["alignment OK"],
    },
  );

  // ⑤ 反方向：枚举里的块注释含 `X = "y"` 不是成员（旧实现会把注释里的值算成成员 → 假红）
  subprocess(
    "⑤ 【反证·注释算数】admin 枚举的块注释里出现 `X = \"y\"` → 不算成员，绿",
    reasonTree({
      entity:
        "export enum ExecutionFailureReason {\n" +
        '  /* 历史写法：OLD_REASON = "old_reason" —— 已下线，勿加回 */\n' +
        ALL.map((v) => `  ${v.toUpperCase()} = "${v}",`).join("\n") +
        "\n}\n",
    }),
    { code: 0, contains: ["alignment OK: all=15, reportable=12"], absent: ["old_reason", "FAIL ", "结构错误"] },
  );

  subprocess(
    "⑥ 事实源被清空（all / executorReportable 都是 []）→ 结构红（旧实现恒真绿）",
    reasonTree({
      protocol: protocolFile({ all: [], reportable: [], internal: [] }),
      entity: entityFile([]),
      py: pyFile([]),
      ts: tsFile([]),
    }),
    {
      code: 1,
      contains: ["结构错误", `下界 ${MIN_ALL_REASONS}`, "永真断言"],
      absent: ["alignment OK", "FAIL"],
    },
  );

  subprocess("⑦ 事实源不可解析（protocol.json 写成非 JSON）→ 结构红", reasonTree({ protocol: "{ not json" }), {
    code: 1,
    contains: ["结构错误", "不是合法 JSON"],
    absent: ["alignment OK"],
  });

  subprocess("⑧ 事实源缺失（protocol.json 被删）→ 结构红且点名路径", reasonTree({ drop: [PROTOCOL_REL] }), {
    code: 1,
    contains: ["结构错误", `读不到 ${PROTOCOL_REL}`],
    absent: ["alignment OK", "Error:", "ENOENT"],
  });

  subprocess(
    "⑨ 解析失败：admin 枚举改名 → 结构红（不是崩栈）",
    reasonTree({
      entity: entityFile(ALL).replace("ExecutionFailureReason", "ExecutionFailureCause"),
    }),
    { code: 1, contains: ["结构错误", "找不到 `enum ExecutionFailureReason`"], absent: ["alignment OK"] },
  );

  subprocess(
    "⑩ 解析失败：Python 变量改名 → 结构红",
    reasonTree({ py: pyFile(REPORTABLE).replace("VALID_FAILURE_REASONS", "ALLOWED_FAILURE_REASONS") }),
    { code: 1, contains: ["结构错误", "找不到 `VALID_FAILURE_REASONS"], absent: ["alignment OK"] },
  );

  // ⑪ 修掉的假绿：变量名在**注释**里先出现一次，旧实现按「900 字符窗口」认错了集合
  subprocess(
    "⑪ 【反证·窗口抽取】变量名先出现在注释里 → 仍锚定到真赋值，绿",
    reasonTree({
      ts:
        "// CALLBACK_FAILURE_REASONS 与 protocol.json 的 executorReportable 逐值一致（注释里先出现一次）\n" +
        tsFile(REPORTABLE),
    }),
    { code: 0, contains: ["alignment OK: all=15, reportable=12"], absent: ["FAIL ", "结构错误"] },
  );

  subprocess(
    "⑫ 解析失败：executor-node 数组改名 → 结构红",
    reasonTree({ ts: tsFile(REPORTABLE).replace("CALLBACK_FAILURE_REASONS", "CLIENT_FAILURE_REASONS") }),
    { code: 1, contains: ["结构错误", "找不到 `CALLBACK_FAILURE_REASONS"], absent: ["alignment OK"] },
  );

  const failed = reportCases(cases, { title: "check-failure-reasons selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    const root = resolve(argValue(process.argv, "--root") ?? process.cwd());
    const { structure, results, counts } = check({ root });

    if (structure.length > 0) {
      console.error("");
      console.error("✖ 失败原因枚举守卫结构错误（判据本身不可信）：");
      for (const e of structure) console.error("  · " + e);
      console.error("");
      process.exit(1);
    }

    let failed = 0;
    for (const r of results) {
      if (r.ok) {
        console.log(`OK   ${r.name}  (${r.actual.length})`);
      } else {
        failed += 1;
        console.log(`FAIL ${r.name}`);
        console.log(`     actual  : ${r.actual.join(', ')}`);
        console.log(`     expected: ${r.expected.join(', ')}`);
      }
    }
    if (failed) {
      console.error(`\n${failed} failure-reason enum drift(s) detected`);
      process.exit(1);
    }
    console.log(`\nfailure-reason alignment OK: all=${counts.all}, reportable=${counts.reportable}`);
  }
}
