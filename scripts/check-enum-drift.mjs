#!/usr/bin/env node
// PK-26（DEEP_REVIEW 0ef3bbe / A8）：TS 枚举 ⊆ PG 枚举 静态守卫
//
// N2 教训结构性复演——scheduler 写路径枚举（BlockStrategy、ExecutionStatus、
// FailureReason 等）零真机校验。单测全程 mock，e2e 零命中，TS 枚举与 PG enum
// 漂移只能在生产踩坑（PK-01 已是第三次重演）。本脚本落地 A8 静态守卫：
//
//   ① 扫描 `apps/admin-api/src/migrations/*.ts` 的 CREATE TYPE / ALTER TYPE ADD VALUE，
//      得到每个 PG enum 的全部 label；
//   ② 扫描 `apps/admin-api/src/**` 的**所有枚举形态**（`enum X {`、
//      `const X = {…} as const`、`Object.freeze({…})`），得到每个声明的值集合；
//   ③ **覆盖自检**：每个声明的枚举必须要么在 `TS_TO_PG` 映射里（⇒ 参与 ①② 的比对），
//      要么在 `ALLOWLIST` 里**带理由**登记（⇒ 明确声明"为何不与 PG 比对"）。
//      两者都没有 ⇒ 红。这条把原先"手维护 13 条映射＝覆盖边界"变成"覆盖边界必须显式"。
//   ④ 映射项：TS 值集合 ⊆ 对应 PG enum 值集合。
//
// ## 第 4 轮审计（docs/archive/audits/2026-10-29-round4/test-guard-quality.md §2.5）实证的三个洞
//
//   1. **映射表是唯一覆盖边界**：新加一个 `export enum Foo`，只要不进 `TS_TO_PG`
//      就完全不受护，而没有任何判据要求"必须登记或被豁免"。实跑输出的
//      「13 个 TS enum 全部 ⊆」里那个 13 是手抄的，不是扫出来的。
//      ⇒ 现在扫出来的**每一个**声明都要么映射、要么豁免，否则红；
//      且豁免必须是**活着的**（枚举已删除/改名 ⇒ 豁免条目失效 ⇒ 红），
//      与语言守卫的"基线只减不增"同一纪律。
//   2. **const-object 形态枚举扫不到**：`export const X = { A: "a" } as const`
//      在首版 `scanTsEnums` 里返回空（只认 `export enum`）。
//      ⇒ 现在识别 `as const` / `Object.freeze` **对象**（含 `as const satisfies …`）。
//      刻意**不**把 `const X = […] as const` 元组纳入本守卫（边界写在 ALLOWLIST 上方）——
//      本仓 20+ 个这类声明绝大多数是白名单/CSV 表头/指标 label 名，不是"值域"，
//      纳进来只会把真正的枚举告警埋掉。
//   3. **`[^}]*` 截断会静默丢值**：`export enum Weird { A = "a", B = fn({k:1}), C = "c" }`
//      只提取到 `["a"]`，`"c"` 丢失——而"TS 值 ⊆ PG 值"最怕的就是漏值（漏进去的值
//      永远不比对）。⇒ 枚举体/对象体一律**括号配平**抽取（与 `check-cron-guard.mjs`
//      的 `maskNonCode` + `matchBracket` 同款：先把注释与字符串内容掩成空格，
//      再做括号配对，这样 `"}"`、`// }` 都不会破坏配对），值提取在**只剥注释、
//      保留字符串**的副本上做，嵌套对象里的字符串值也收进值集合。
//
// ## selftest 纪律（审计 §2.5 的另一条批评）
//
// 首版 `selftest()` 直接构造两个 `Set` 喂 `check()`，**从不调用 scanPgEnums /
// scanTsEnums**——于是上面第 2、3 条缺陷都在自检视野之外（regex 坏了自检照样绿）。
// 现在 `--selftest` 用 `mkdtemp` 造**真实目录树**（.ts 源码 + 迁移 DDL）跑真 scanner，
// 覆盖：嵌套对象取值、截断回归、const-object 识别、未覆盖枚举、豁免命中/失效、
// 映射目标缺失、前端字面量漂移。
//
// 退出码：0 = 无漂移且覆盖完整；1 = 漂移 / 未覆盖 / 豁免失效，
//         **或判据本身不可信**（扫描面为空 / 事实源缺失）。
//
// 用法：node scripts/check-enum-drift.mjs [--selftest] [--report] [--root <dir>]
//   --selftest：用临时 fixture 验证判据本身（扫描器单测 + 真子进程断言退出码）。
//   --report  ：打印所有声明与其覆盖去向（映射 / 豁免 / 未覆盖），不进入比对。
//   --root    ：把该目录当仓库根（selftest 专用；默认由脚本位置推出）。
//
// ## T4（第 4 轮守卫自检审计）对**执行层**的收口
//
// 上一轮把 scanner 从「喂两个 Set」改成了「真目录 fixture 跑真 scanner」，但执行层
// 仍是「函数返回数组 + 手搓 `ok(cond)` 布尔」——于是三类假绿留下来：
//   1. **只测函数，不测闸门**：`main` 里的 `process.exit(1)`、`--report` 的出口、
//      以及「结构红」与「漂移红」是否分开，`--selftest` 全都没看过。现在有
//      **真子进程用例**：`--root` 指向 fixture 树，断言退出码 + 关键文本。
//   2. **`--report` 吞结构错**：`report()` 无条件 `return 0`——migrations 目录没了
//      也照打「枚举声明共 N 个」并报绿（`N` 可以是 0）。现在 `report` 与 `run`
//      共用 `scanSurface()`，事实源缺失 / 扫描面低于下界一律**结构红**。
//   3. **扫描面塌方 = 永真绿**：`scanPgEnums` 目录不存在时返回 `{}`、
//      `scanEnumDeclarations` 目录不存在时返回 `[]`，两者都让上层「0 个漂移」。
//      现在有 `MIN_PG_ENUMS` / `MIN_DECLARATIONS` 下界（实测 16 / 36），
//      低于下界即结构红。
// 另外 `checkFrontend()` 的文件路径原先相对 **cwd**，`--root` 下必然「target missing」
// ——现在相对 `root` 解析，selftest 才能在另一棵树上验证前端闸门。
import {
  readdirSync,
  readFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 默认仓库根：脚本位于 `<repo>/scripts/`，由脚本位置推出，不依赖调用方 cwd。 */
export const DEFAULT_ROOT = resolve(HERE, "..");

const MIGRATIONS_DIR = "apps/admin-api/src/migrations";
const SRC_DIR = "apps/admin-api/src";

/**
 * 扫描面下界（实测：16 个 PG enum / 36 个枚举声明）。
 *
 * 留余量取 12 / 30：钉的是「正则还能不能从迁移 DDL 与 TS 源码里读出东西」，
 * 不是「枚举有几个」。低于下界时「0 个漂移」只是「一处都没比」。
 */
export const MIN_PG_ENUMS = 12;
export const MIN_DECLARATIONS = 30;

// ─────────────────────────────────────────────────────────────────────────
// 词法掩码（照抄 check-cron-guard.mjs 的做法）
//
// 为什么必须掩码再做括号配对：
//   · 枚举成员初值里可以有 `}`（`B = fn({ k: 1 })`）——本守卫首版正是被它截断；
//   · 注释里的 `}` / 字符串里的 `"}"` 同样会破坏配对；
//   · 掩码**保留换行**，所以行号、偏移量都不变（报错定位照旧准）。
// ─────────────────────────────────────────────────────────────────────────
export function maskNonCode(src) {
  const out = src.split("");
  const hide = (i) => {
    if (i >= 0 && i < out.length && out[i] !== "\n") out[i] = " ";
  };
  let state = "code"; // code | line | block | single | double | template
  const tplStack = []; // 模板 `${ … }` 里的花括号深度
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

/**
 * 只剥注释、**保留字符串内容**（与 `maskNonCode` 互补）。
 *
 * 掩码版把字符串内容也抹成空格，无法从中读值；值提取必须用这一版。
 * 保留换行 ⇒ 偏移量与原文一一对应，可以拿掩码版算出的括号位置直接切片。
 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let inS = null;
  let inTpl = false;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (inS) {
      out += c;
      if (c === "\\") {
        out += c2 ?? "";
        i += 2;
        continue;
      }
      if (c === inS) inS = null;
      i += 1;
      continue;
    }
    if (inTpl) {
      out += c;
      if (c === "\\") {
        out += c2 ?? "";
        i += 2;
        continue;
      }
      if (c === "`") inTpl = false;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      inS = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "`") {
      inTpl = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (c === "/" && c2 === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += "  ";
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 从 `open` 处的开括号找配对的闭括号，返回下标（在掩码源上跑）。 */
export function matchBracket(masked, open, openCh, closeCh) {
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
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
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

// ── TS enum → PG enum name 映射（手维护，新增 PG enum 时同步）─────────────────
// 键 = TS 声明名；值 = PG enum 名称，或 `{ pg, valueSource }`：
//   · valueSource: "values"（默认）= 用声明里的字面量值；
//   · valueSource: "keys-lowercase" = 用**成员名小写**（数字枚举专用：PG label
//     是字符串，TS 侧是 1..4 —— 见 task.entity.ts 的 normalizeTaskPriority 长注释）。
// 反斜线：TS 侧的**值集合**必须 ⊆ PG label 集合。PG 侧可以有 TS 还没用到的 label
// （扩 PG 先于扩 TS 是安全的），反之即漂移。
const TS_TO_PG = {
  UserRole: "user_role_enum",
  TaskStatus: "task_status_enum",
  TaskTriggerType: "task_triggertype_enum",
  TaskRuntime: "task_runtime_enum",
  BlockStrategy: "task_blockstrategy_enum",
  MisfireStrategy: "task_misfirestrategy_enum",
  ExecutorStatus: "executor_status_enum",
  ExecutorType: "executor_type_enum",
  ExecutionStatus: "execution_status_enum",
  ApplicationStatus: "application_status_enum",
  ExecuteMode: "task_execute_mode_enum",
  DeploymentStatus: "app_deployments_status_enum",
  RunMode: "app_deployments_run_mode_enum",
  // 第 4 轮审计补：PG 侧**早就有**这两个 enum，映射表却漏了它们 ⇒
  // `TaskCodeSource` 加个 "jar"、`ExecutorOfflineReason` 加个 "crash" 都不会红。
  TaskCodeSource: "tasks_codeSource_enum",
  ExecutorOfflineReason: "executors_offlineReason_enum",
  // 数字枚举：TS 1..4 ↔ PG label low/normal/high/critical（成员名小写即 label）。
  TaskPriority: { pg: "task_priority_enum", valueSource: "keys-lowercase" },
};

/**
 * **豁免清单**：不参与 TS↔PG 比对的枚举声明。每条必须写理由。
 *
 * 这不是"忽略列表"，而是**覆盖声明**：写在这里等于说"我知道这个枚举存在，
 * 它之所以不与 PG enum 比对，是因为 <理由>"。理由不再成立的条目必须删除——
 * 条目指向一个不存在的声明时，守卫会判红（豁免过期），防止清单腐烂成噪音。
 */
const ALLOWLIST = [
  // ── 列是 varchar（非 PG enum），没有可比对的 PG 类型 ──────────────────────
  {
    name: "ExecutionFailureReason",
    reason:
      "task_executions.failureReason 列是 varchar（执行器上报的机器码，见 failure-reasons 守卫），PG 侧无 enum 可比",
  },
  {
    name: "AppDeploymentEventType",
    reason:
      "app_deployment_events.eventType 列是 varchar（事件是历史事实，加值不重建类型），PG 侧无 enum 可比",
  },
  {
    name: "DeploymentApprovalStatus",
    reason:
      "app_deployments.approvalStatus 是 varchar 可空列（DEP-04 刻意不扩 DeploymentStatus 枚举），PG 侧无 enum 可比",
  },
  {
    name: "RolloutState",
    reason: "app_deployments.rolloutState 是 varchar 可空列（DEP-02/03 灰度批次），PG 侧无 enum 可比",
  },
  {
    name: "DeploymentTriggerType",
    reason:
      "app_deployments.triggerType 是 varchar 可空列（对齐 task.triggerType 的取值，但刻意复用 varchar 以免 PG enum ALTER 扩值成本），PG 侧无 enum 可比",
  },
  // ── 非持久化（内存 / 配置 / 告警面）────────────────────────────────────
  {
    name: "AlertLevel",
    reason: "告警级别只在内存静默规则与通知载荷里流转（AlertSilence 无 entity、不落库），无 PG 列",
  },
  {
    name: "AlertChannel",
    reason: "告警渠道只在内存静默规则与通知配置里流转，无 PG 列（消费方清单由 check-enum-consumers 守）",
  },
  // ── PG 侧是**隐式**建立的 enum（迁移文本里没有 CREATE TYPE，扫不到）──────
  {
    name: "ExecutorPackageType",
    reason:
      "executor_packages.type 是 TypeORM `type: \"enum\"` 列，PG 类型由 createTable 隐式建出（迁移文本无 CREATE TYPE），本守卫的 PG 扫描面看不到；真要对比需解析 TypeORM 建表调用",
  },
  {
    name: "ExecutorPackageStatus",
    reason: "同上（executor_packages.status，隐式 enum，迁移文本无 CREATE TYPE）",
  },
  // ── const-object 形态：不是"列的取值域"，而是常量表（仍需登记，防静默新增）──
  {
    name: "COMMON_CODES",
    reason: "错误码目录分片：值是 {status,zh,en} 对象（i18n 词典），不是 DB 列值域",
  },
  {
    name: "EXECUTOR_CODES",
    reason: "错误码目录分片（同上），值是 {status,zh,en} 对象",
  },
  {
    name: "TASK_CODES",
    reason: "错误码目录分片（同上），值是 {status,zh,en} 对象",
  },
  {
    name: "PROJECT_CODES",
    reason: "错误码目录分片（同上），值是 {status,zh,en} 对象",
  },
  {
    name: "AUTH_CODES",
    reason: "错误码目录分片（同上），值是 {status,zh,en} 对象",
  },
  {
    name: "APPLICATION_CODES",
    reason: "错误码目录分片（同上），值是 {status,zh,en} 对象",
  },
  {
    name: "ERROR_CATALOG",
    reason: "错误码总表（…spread 合并 6 个分片）：合并点，不是值域；分片各自已登记",
  },
  {
    name: "DOMAIN_EVENTS",
    reason: "domain event 名常量表（outbox/订阅面的事件名，如 execution.completed），不是 DB 列值域；译了会断订阅匹配",
  },
  {
    name: "SSRF_DENY_HOST_PATTERNS",
    reason: "SSRF 拒绝网段表（内层 Object.freeze 数组），是安全策略常量，不是枚举值域",
  },
  {
    name: "OIDC_CODE_TO_PAGE_ERROR",
    reason:
      "OIDC 错误码 → 落地页错误标识的映射表（`as const satisfies Record<string,string>`，非导出模块常量）；值是落地页 query 参数，不是 DB 列值域",
  },
  {
    name: "MEDIA_UPLOAD_LIMITS",
    reason: "上传上限常量对象（fileSize 数字），不是枚举，无值集合可比",
  },
];

// ── 扫描 PG 迁移：收集每个 enum type 的所有取值 ──────────────────────────────
export function scanPgEnums(migrationsDir) {
  const enums = {}; // { enumName: Set<string> }
  if (!existsSync(migrationsDir)) return enums;

  for (const file of readdirSync(migrationsDir)) {
    if (!file.endsWith(".ts") || file.endsWith(".spec.ts")) continue;
    const text = readFileSync(join(migrationsDir, file), "utf8");

    // CREATE TYPE "name" AS ENUM ('v1', 'v2', ...)  — 单行或跨行。
    // 枚举 label 里不可能出现 `)`，故这里用 `[^)]*` 取体是安全的（不需要配平）；
    // 真正需要配平的是 **TS 枚举体**（成员初值可含嵌套对象/调用）。
    const createRe = /CREATE\s+TYPE\s+"?(\w+)"?\s+AS\s+ENUM\s*\(([^)]*)\)/gis;
    let m;
    while ((m = createRe.exec(text)) !== null) {
      const name = m[1];
      const vals = extractQuoted(m[2]);
      if (!enums[name]) enums[name] = new Set();
      for (const v of vals) enums[name].add(v);
    }

    // ALTER TYPE "name" ADD VALUE [IF NOT EXISTS] 'val'
    const alterRe = /ALTER\s+TYPE\s+"?(\w+)"?\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'([^']+)'/gi;
    while ((m = alterRe.exec(text)) !== null) {
      const name = m[1];
      if (!enums[name]) enums[name] = new Set();
      enums[name].add(m[2]);
    }
  }
  return enums;
}

/** 取文本里所有引号字符串字面量（'…' / "…" / `…`，含转义）。 */
function extractQuoted(block) {
  const vals = [];
  const re = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g;
  let m;
  while ((m = re.exec(block)) !== null) vals.push(m[1] ?? m[2] ?? m[3] ?? "");
  return vals;
}

// ── 扫描 TS 源码：所有枚举形态的声明 ────────────────────────────────────────
/**
 * 识别四类"枚举形态"声明：
 *   · `enum X { … }`（含 `export`/`declare`/`const enum`）；
 *   · `const X = { … } as const`（模块顶层，导出或列首）；
 *   · `const X = Object.freeze({ … })`；
 *   · `const X = [ "a", "b" ] as const`（全字符串元组——本仓更常见的"封闭集合"写法）。
 *
 * 返回数组，每项：
 *   { name, kind, file, line, exported, keys, values, nestedValues, numeric }
 *     values：`enum` 为**体内全部字符串字面量（含嵌套对象里的）**——宁可多收也不漏；
 *             `const-object` 为**顶层**字面量值；`const-tuple` 为元素字面量。
 *     keys  ：成员名 / 顶层键 / 元组无键。
 */
export function scanEnumDeclarations(srcDir) {
  const decls = [];
  if (!existsSync(srcDir)) return decls;

  for (const file of listTsFiles(srcDir)) {
    const src = readFileSync(file, "utf8");
    const masked = maskNonCode(src);
    const clean = stripComments(src);
    const starts = lineStarts(src);
    const rel = toRel(file);

    const push = (d) => decls.push({ ...d, file: rel });

    // ① enum X { … }
    const enumRe = /\benum\s+([A-Za-z_$][\w$]*)\s*\{/g;
    let m;
    while ((m = enumRe.exec(masked)) !== null) {
      const open = masked.indexOf("{", m.index);
      const close = matchBracket(masked, open, "{", "}");
      if (close < 0) continue; // 语法破损交给 tsc，不在这里报
      const bodyClean = clean.slice(open + 1, close);
      const bodyMasked = masked.slice(open + 1, close);
      // 键/数值只在**顶层**取（嵌套调用 `pick({ red: 1 })` 里的标识符不是成员）
      const keys = [];
      const numeric = new Set();
      for (const r of splitTopLevel(bodyMasked)) {
        const seg = bodyMasked.slice(r.start, r.end);
        const km = /^\s*([A-Za-z_$][\w$]*)\s*(?:=|,|$)/.exec(seg);
        if (km) keys.push(km[1]);
        const nm = /^\s*[A-Za-z_$][\w$]*\s*=\s*(\d+)\s*$/.exec(seg);
        if (nm) numeric.add(nm[1]);
      }
      const values = new Set(extractQuoted(bodyClean));
      push({
        name: m[1],
        kind: "enum",
        line: lineOf(starts, m.index),
        exported: isExported(masked, m.index),
        keys,
        values,
        nestedValues: new Set(),
        numeric,
      });
    }

    // ②/③ const X = { … } as const | Object.freeze({ … })
    const objRe = /(?:^|\n)[ \t]*(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]{1,160})?=\s*(Object\.freeze\s*\(\s*)?\{/g;
    while ((m = objRe.exec(masked)) !== null) {
      const declStart = m.index + m[0].indexOf("const");
      const open = masked.indexOf("{", m.index);
      const close = matchBracket(masked, open, "{", "}");
      if (close < 0) continue;
      const frozen = Boolean(m[3]);
      const tail = masked.slice(close + 1, close + 60);
      const constAsserted = /^\s*(?:\)\s*)?as\s+const\b/.test(tail);
      if (!frozen && !constAsserted) continue; // 普通对象字面量：不是枚举形态
      // 非导出声明只认**列首**（模块顶层），避免把函数内的局部常量当枚举。
      const exported = Boolean(m[1]);
      const col = declStart - starts[lineOf(starts, declStart) - 1];
      if (!exported && col !== 0) continue;
      // 命名边界：本仓枚举形态一律大写开头（PascalCase / UPPER_SNAKE）。
      // `const pagination = {…} as const` 这类小写模块常量是**配置对象**，不是值域。
      if (!/^[A-Z]/.test(m[2])) continue;
      const bodyClean = clean.slice(open + 1, close);
      const bodyMasked = masked.slice(open + 1, close);
      const { keys, values, nestedValues } = splitTopLevelEntries(bodyClean, bodyMasked);
      push({
        name: m[2],
        kind: "const-object",
        line: lineOf(starts, declStart),
        exported,
        keys,
        values,
        nestedValues,
        numeric: new Set(),
      });
    }

  }
  return decls;
}

function isExported(masked, index) {
  return /\bexport\s+$/.test(masked.slice(Math.max(0, index - 40), index));
}

function toRel(p) {
  return p.split("\\").join("/");
}

function listTsFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", "__tests__", ".git"].includes(entry.name)) continue;
      listTsFiles(full, acc);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".spec.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      acc.push(full);
    }
  }
  return acc;
}

/** 顶层逗号切分（用掩码串定位，掩码串里字符串内容已是空格 ⇒ 分隔符不会被误判）。 */
function splitTopLevel(maskedBody) {
  const ranges = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < maskedBody.length; i++) {
    const c = maskedBody[i];
    if (c === "{" || c === "[" || c === "(") depth += 1;
    else if (c === "}" || c === "]" || c === ")") depth -= 1;
    else if (c === "," && depth === 0) {
      ranges.push({ start, end: i });
      start = i + 1;
    }
  }
  if (maskedBody.slice(start).trim()) ranges.push({ start, end: maskedBody.length });
  return ranges;
}

/** 对象体：顶层键 + 顶层字面量值 + 嵌套对象里的字符串值（单独收集，不参与比对）。 */
function splitTopLevelEntries(bodyClean, bodyMasked) {
  const keys = [];
  const values = new Set();
  const nestedValues = new Set();
  for (const r of splitTopLevel(bodyMasked)) {
    const cleanSlice = bodyClean.slice(r.start, r.end);
    const maskedSlice = bodyMasked.slice(r.start, r.end);
    const km = /^\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z_$][\w$]*))\s*:/.exec(cleanSlice);
    const key = km ? (km[1] ?? km[2] ?? km[3]) : null;
    if (key) keys.push(key);
    const vm = /^\s*(?:"[^"]*"|'[^']*'|[A-Za-z_$][\w$]*)\s*:\s*(['"`])([\s\S]*)\1\s*$/.exec(
      cleanSlice,
    );
    if (vm) {
      values.add(vm[2]);
      continue;
    }
    // 值是嵌套对象/表达式：其内的字符串不进顶层值集合（否则错误码目录那种
    // 双语表会把上百条文案当成"枚举值"），但要单独留痕供报告与失败提示。
    for (const s of extractQuoted(cleanSlice)) nestedValues.add(s);
    if (/\{/.test(maskedSlice) && !vm) nestedValues.add("\u0000nested-object");
  }
  return { keys, values, nestedValues };
}

/** 映射项 → { pg, valueSource }。 */
function normalizeSpec(spec) {
  return typeof spec === "string" ? { pg: spec, valueSource: "values" } : { valueSource: "values", ...spec };
}

/**
 * 声明 → 参与比对的 TS 值集合。
 *
 * `keys-lowercase`：数字枚举的成员名小写即 PG label（TaskPriority.LOW=1 ↔ 'low'）。
 * 这是**唯一**允许的"值变换"——不做任意代码求值，变换规则写死在映射里。
 */
export function declarationValues(decl, spec) {
  const { valueSource } = normalizeSpec(spec);
  if (valueSource === "keys-lowercase") {
    return new Set(decl.keys.map((k) => k.toLowerCase()));
  }
  return new Set(decl.values);
}

// ── 核心校验 ①：TS enum 值 ⊆ PG enum 值 ────────────────────────────────────
export function checkDrift({ pgEnums, declarations, mapping = TS_TO_PG }) {
  const errors = [];
  const byName = indexByName(declarations);
  for (const [tsName, rawSpec] of Object.entries(mapping)) {
    const spec = normalizeSpec(rawSpec);
    const declList = byName.get(tsName) ?? [];
    if (declList.length === 0) {
      errors.push(`映射项 ${tsName} → "${spec.pg}"：源码里找不到该声明（映射表过期？）`);
      continue;
    }
    if (declList.length > 1) {
      errors.push(
        `映射项 ${tsName} 在多处声明（${declList.map((d) => `${d.file}:${d.line}`).join(", ")}）——无法确定比对哪一份`,
      );
      continue;
    }
    const decl = declList[0];
    const pgVals = pgEnums[spec.pg];
    if (!pgVals) {
      errors.push(
        `PG enum "${spec.pg}" 未找到（迁移扫描为空）——${tsName} 的 PG 类型缺失？`,
      );
      continue;
    }
    const tsVals = declarationValues(decl, spec);
    if (tsVals.size === 0) {
      errors.push(
        `映射项 ${tsName}（${decl.file}:${decl.line}）提取到的值集合为空——扫描器失效，不能当成"没有问题"`,
      );
      continue;
    }
    if (decl.kind === "const-object" && decl.values.size !== tsVals.size) {
      errors.push(
        `映射项 ${tsName}（${decl.file}:${decl.line}）有成员不是字面量值（${[...decl.nestedValues].filter((v) => v !== "\u0000nested-object").length} 个嵌套字符串）——无法逐值比对`,
      );
    }
    const extra = [...tsVals].filter((v) => !pgVals.has(v));
    if (extra.length > 0) {
      errors.push(
        `漂移：TS 声明 ${tsName}（${decl.file}:${decl.line}）包含 PG enum "${spec.pg}" 中不存在的值: ${extra.join(", ")}` +
          `（PG 仅有: ${[...pgVals].join(", ")}）`,
      );
    }
  }
  return errors;
}

function indexByName(declarations) {
  const m = new Map();
  for (const d of declarations) {
    if (!m.has(d.name)) m.set(d.name, []);
    m.get(d.name).push(d);
  }
  return m;
}

// ── 核心校验 ②：覆盖自检（每个声明必须映射或带理由豁免）───────────────────
/**
 * 覆盖边界必须**显式**：扫出来的每个枚举形态声明都要么在 `mapping`，
 * 要么在 `allowlist`。三者之外 ⇒ 红（并打印它与哪些 controller/DTO 相关，
 * 帮人判断"该不该映射"）。
 *
 * 同时反查 allowlist 自身：
 *   · 条目必须带理由（理由空了就等于没有）；
 *   · 条目必须**还有对应的声明**（枚举删了/改名了 ⇒ 豁免过期 ⇒ 红）——
 *     否则清单会像只增不减的基线一样腐烂，最终没人敢动。
 *   · 同一条目不得既映射又豁免（两份口径必有一份是错的）。
 */
export function checkCoverage({
  declarations,
  mapping = TS_TO_PG,
  allowlist = ALLOWLIST,
  consumersOf = () => [],
}) {
  const errors = [];
  const mapped = new Set(Object.keys(mapping));
  const byName = indexByName(declarations);
  const allowByName = new Map();

  for (const entry of allowlist) {
    if (!entry || typeof entry.name !== "string" || !entry.name) {
      errors.push("ALLOWLIST 条目缺少 name");
      continue;
    }
    if (!entry.reason || entry.reason.trim().length < 10) {
      errors.push(`ALLOWLIST 条目 ${entry.name} 缺少足够理由（>=10 字符）——豁免必须有依据`);
    }
    if (mapped.has(entry.name)) {
      errors.push(`ALLOWLIST 条目 ${entry.name} 同时出现在 TS_TO_PG 映射里——两份口径冲突`);
    }
    allowByName.set(entry.name, entry);
    if (!byName.has(entry.name)) {
      errors.push(
        `ALLOWLIST 条目 ${entry.name} 失效：源码里已没有该枚举声明（删了/改名了？）——请删除这条豁免`,
      );
    }
  }

  for (const decl of declarations) {
    if (mapped.has(decl.name) || allowByName.has(decl.name)) continue;
    const consumers = consumersOf(decl.name);
    errors.push(
      `未覆盖的枚举声明：${decl.name}（${decl.kind}，${decl.file}:${decl.line}）` +
        (decl.values.size > 0 ? `，值: ${[...decl.values].join("/")}` : "") +
        (consumers.length > 0 ? `\n      相关消费面: ${consumers.join(", ")}` : "") +
        `\n      处置：若它对应 PG enum → 加进 TS_TO_PG；若列是 varchar/非持久化 → 加进 ALLOWLIST 并写理由`,
    );
  }
  return errors;
}

/**
 * 找该枚举的消费面（controller / dto / service / entity），用于未覆盖时的定位提示。
 * 只在**有未覆盖项时**才被调用（红的时候才付这份 IO）。
 */
export function makeConsumersResolver(srcDir) {
  const cache = new Map();
  return function consumersOf(name) {
    const re = new RegExp(`\\b${name}\\b`);
    const hits = [];
    for (const f of listTsFiles(srcDir)) {
      let text = cache.get(f);
      if (text === undefined) {
        text = stripComments(readFileSync(f, "utf8"));
        cache.set(f, text);
      }
      if (!re.test(text)) continue;
      const rel = toRel(f);
      // 优先级：controller > dto > service > entity > 其它
      const rank = /\.controller\.ts$/.test(rel)
        ? 0
        : /\.dto\.ts$|dto\//.test(rel)
          ? 1
          : /\.service\.ts$/.test(rel)
            ? 2
            : /\.entity\.ts$/.test(rel)
              ? 3
              : 4;
      hits.push({ rel, rank });
    }
    return hits
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 4)
      .map((h) => h.rel);
  };
}

// ── 前端字面量扫描（P2-4 守卫扩展，保留原样）────────────────────────────────
// The TS-enum ⊆ PG-enum check above only covers admin-api. admin-web hand-
// writes its API interfaces and asserts them via `client.get(...) as
// Promise<T>`, so a status literal the backend can never produce (the dead
// 'busy' executor filter option, P2-4) is invisible to tsc AND to this guard.
// Each entry below anchors ONE user-facing options block in the web client
// and asserts its `value: '...'` literals are a subset of the corresponding
// PG enum. Add an entry when the web client gains another status filter.
const FRONTEND_STATUS_SCANS = [
  {
    pgEnum: "executor_status_enum",
    file: "apps/admin-web/src/pages/ExecutorListPage.tsx",
    // The status-filter Select: from value={statusFilter} through its
    // options={[ ... ]} array. Anchored (not a whole-file scan) so that
    // unrelated literals such as i18n keys can never trip the guard.
    blockRe: /value=\{statusFilter\}[\s\S]*?options=\{\[([\s\S]*?)\]\}/,
  },
];

/** Extract `value: 'x'` (or double-quoted) literals from an options block. */
export function scanFrontendStatusOptions(fileText, blockRe) {
  const m = blockRe.exec(fileText);
  if (!m) return null; // anchor missing → caller treats this as a failure
  const vals = new Set();
  const re = /value:\s*['"]([^'"]+)['"]/g;
  let vm;
  while ((vm = re.exec(m[1])) !== null) vals.add(vm[1]);
  return vals;
}

/** Assert every anchored frontend options block ⊆ its PG enum. */
export function checkFrontend({
  root = DEFAULT_ROOT,
  pgEnums,
  scans = FRONTEND_STATUS_SCANS,
  read = (f) => readFileSync(join(root, f), "utf8"),
}) {
  const errors = [];
  for (const scan of scans) {
    // 路径相对 **root**（旧实现相对 cwd：`--root` 下必然 target missing，
    // 于是前端闸门在 selftest 里永远只能「因缺文件而红」，判据本体从未被验证）。
    if (!existsSync(join(root, scan.file))) {
      errors.push(`frontend guard target missing: ${scan.file}`);
      continue;
    }
    const pgVals = pgEnums[scan.pgEnum];
    if (!pgVals) {
      errors.push(
        `PG enum "${scan.pgEnum}" not found (migration scan empty) — frontend guard for ${scan.file} cannot run`,
      );
      continue;
    }
    const vals = scanFrontendStatusOptions(read(scan.file), scan.blockRe);
    if (vals === null) {
      errors.push(
        `${scan.file}: status-filter anchor not found (value={statusFilter} ... options={[ ... ]}) — guard is blind, update check-enum-drift.mjs`,
      );
      continue;
    }
    const extra = [...vals].filter((v) => !pgVals.has(v));
    if (extra.length > 0) {
      errors.push(
        `frontend drift: ${scan.file} filter offers value(s) ${extra.join(", ")} that do not exist in PG enum "${scan.pgEnum}" (PG only has: ${[...pgVals].join(", ")})`,
      );
    }
  }
  return errors;
}

// ── 扫描面（run / report 共用）──────────────────────────────────────────────
/** 展示用路径：相对 root（旧口径），并统一分隔符。 */
function displayPath(base, p) {
  const abs = resolve(p);
  const rootAbs = resolve(base);
  const rel = abs.startsWith(rootAbs + sep) ? abs.slice(rootAbs.length + 1) : abs;
  return rel.split("\\").join("/");
}

/**
 * 采集两面并做**扫描面自检**。
 *
 * @param {string} [root] 仓库根
 * @returns {{pgEnums: object, declarations: object[], structure: string[]}}
 *   `structure` 非空 = **判据本身不可信**（事实源缺失 / 扫描面低于下界）。
 *   它与「漂移」必须分开：漂移要改代码，结构错要修扫描器/路径。
 */
export function scanSurface(root = DEFAULT_ROOT) {
  const migrationsDir = join(root, MIGRATIONS_DIR);
  const srcDir = join(root, SRC_DIR);
  const structure = [];

  const pgEnums = scanPgEnums(migrationsDir);
  // 声明里的 `file` 只用于展示：统一成**相对 root** 的路径（旧口径），
  // 否则 `--report` 与 CI 报错会打绝对路径（换机器/换 cwd 就对不上文档）。
  const declarations = scanEnumDeclarations(srcDir).map((d) => ({
    ...d,
    file: displayPath(root, d.file),
  }));
  const pgCount = Object.keys(pgEnums).length;

  if (!existsSync(migrationsDir)) {
    structure.push(
      `事实源缺失：${MIGRATIONS_DIR} —— PG 侧一个 enum 都读不到；` +
        `「TS 全部 ⊆ PG」在没有任何 PG 类型时是一句空话。`,
    );
  } else if (pgCount < MIN_PG_ENUMS) {
    structure.push(
      `扫描面为空：从 ${MIGRATIONS_DIR} 只解析出 ${pgCount} 个 PG enum（下界 ${MIN_PG_ENUMS}）` +
        ` —— CREATE TYPE / ALTER TYPE 正则已失配，映射项会全部变成「PG 类型缺失」。`,
    );
  }

  if (!existsSync(srcDir)) {
    structure.push(`事实源缺失：${SRC_DIR} —— TS 侧一个声明都扫不到。`);
  } else if (declarations.length < MIN_DECLARATIONS) {
    structure.push(
      `扫描面为空：从 ${SRC_DIR} 只解析出 ${declarations.length} 个枚举声明（下界 ${MIN_DECLARATIONS}）` +
        ` —— 枚举形态正则已失配，「0 个未覆盖」不是「覆盖完整」。`,
    );
  }

  return { pgEnums, declarations, structure };
}

/**
 * 全量判据（供 CLI 与 selftest 共用）。
 *
 * @param {string} [root]
 * @returns {{errors: string[], structure: string[], pgEnums: object, declarations: object[]}}
 */
export function check(root = DEFAULT_ROOT) {
  const { pgEnums, declarations, structure } = scanSurface(root);
  if (structure.length > 0) {
    // 扫描面塌了就别再叠「16 个映射项找不到声明」的噪音：先修事实源。
    return { errors: [], structure, pgEnums, declarations };
  }
  const errors = [
    ...checkDrift({ pgEnums, declarations }),
    ...checkCoverage({
      declarations,
      // 消费面只在**有未覆盖项**时才被调用（红的时候才付 IO）；resolver 带缓存，建一次。
      consumersOf: (() => {
        const resolveConsumers = makeConsumersResolver(join(root, SRC_DIR));
        return (name) => resolveConsumers(name).map((p) => displayPath(root, p));
      })(),
    }),
    // P2-4 guard extension: also assert web-client status literals ⊆ PG enums.
    ...checkFrontend({ root, pgEnums }),
  ];
  return { errors, structure, pgEnums, declarations };
}

/** 跑一次守卫（CLI 与 selftest 共用）。@returns {number} 退出码 */
export function run({ root = DEFAULT_ROOT } = {}) {
  const { errors, structure, declarations } = check(root);

  if (structure.length > 0) {
    console.error("");
    console.error("✖ PK-26 enum drift 守卫结构错误（判据本身不可信，先修扫描面）：");
    for (const s of structure) console.error("  · " + s);
    console.error("");
    return 1;
  }

  if (errors.length > 0) {
    console.error("PK-26 enum drift guard FAIL:");
    for (const e of errors) console.error("  ✗ " + e);
    return 1;
  }

  console.log(
    `PK-26 enum drift guard OK: ${declarations.length} 个枚举声明（${Object.keys(TS_TO_PG).length} 映射 / ${ALLOWLIST.length} 豁免）全部 ⊆ 对应 PG enum，覆盖自检通过`,
  );
  return 0;
}

// ── report：列出所有声明及其覆盖去向 ────────────────────────────────────────
/**
 * `--report`：只报告、不比对。**但它也要过扫描面自检**——旧实现无条件
 * `return 0`，于是 migrations 目录没了也照打「枚举声明共 N 个」（N 可以是 0）并绿。
 *
 * @param {{root?: string}} [options]
 * @returns {number} 退出码
 */
export function report({ root = DEFAULT_ROOT } = {}) {
  const { pgEnums, declarations, structure } = scanSurface(root);
  if (structure.length > 0) {
    console.error("");
    console.error("✖ PK-26 enum drift 守卫结构错误（--report 也不能在看不见的扫描面上出报告）：");
    for (const s of structure) console.error("  · " + s);
    console.error("");
    return 1;
  }

  const allowed = new Map(ALLOWLIST.map((a) => [a.name, a.reason]));
  const mapped = new Set(Object.keys(TS_TO_PG));
  const rows = declarations
    .slice()
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  console.log(`枚举声明共 ${declarations.length} 个（PG enum ${Object.keys(pgEnums).length} 个）：`);
  for (const d of rows) {
    const dest = mapped.has(d.name)
      ? `映射 → ${normalizeSpec(TS_TO_PG[d.name]).pg}`
      : allowed.has(d.name)
        ? "豁免"
        : "★ 未覆盖";
    console.log(`  ${dest.padEnd(24)} ${d.kind.padEnd(12)} ${d.name}  (${d.file}:${d.line})`);
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// 自检
//   A. 扫描器判据（真目录 fixture，跑真 scanner）——保留上一轮的全部语义
//   B. 闸门（真子进程 + `--root` + 退出码 + 关键文本）——本轮补的执行层
// ═══════════════════════════════════════════════════════════════════════════
const SELF_PATH = fileURLToPath(import.meta.url);

/** 声明 → 默认成员/标签（PG 侧只按**默认值**建类型，override 不会顺手把漂移值也建进 PG）。 */
function defaultMembers(tsName, spec) {
  if (spec.valueSource === "keys-lowercase") {
    return { members: ["LOW = 1", "NORMAL = 2"], labels: ["low", "normal"] };
  }
  if (tsName === "ExecutorStatus") {
    return { members: ['ONLINE = "online"', 'OFFLINE = "offline"'], labels: ["online", "offline"] };
  }
  return { members: ['V1 = "v1"', 'V2 = "v2"'], labels: ["v1", "v2"] };
}

const frontendPage = (values) =>
  `export function P() {
  return (
    <Select
      value={statusFilter}
      onChange={(v) => setStatusFilter(v)}
      options={[
${values.map((v) => `        { value: '${v}', label: '${v}' },`).join("\n")}
      ]}
    />
  );
}
`;

const frontendPageNoAnchor = `export function P() {
  return <Select options={[{ value: 'online', label: 'online' }]} />;
}
`;

/**
 * 用**真实 TS_TO_PG / ALLOWLIST** 生成一棵「全部命中」的仓库树。
 *
 * 为什么从真实映射生成而不是手抄 36 个声明：手抄的 fixture 会与守卫自己的表各自
 * 演化（「副本绿 ≠ 守卫绿」正是 harness 头注点名的那类假绿）。这里只做一件事：
 * 让真实映射表在 fixture 里**自洽**，然后每条反证用例单点破坏它。
 */
export function greenTree({
  tsOverride = null,
  omitAllow = [],
  extraTs = "",
  dropPgEnum = [],
  frontend = "ok",
  emptySrc = false,
  omitMigrations = false,
} = {}) {
  const pgLabels = new Map();
  const addLabel = (pg, label) => {
    if (!pgLabels.has(pg)) pgLabels.set(pg, new Set());
    pgLabels.get(pg).add(label);
  };

  const blocks = [];
  for (const [tsName, rawSpec] of Object.entries(TS_TO_PG)) {
    const spec = normalizeSpec(rawSpec);
    const def = defaultMembers(tsName, spec);
    for (const l of def.labels) addLabel(spec.pg, l);
    const members = tsOverride?.name === tsName ? tsOverride.members : def.members;
    blocks.push(`export enum ${tsName} {\n${members.map((m) => "  " + m + ",").join("\n")}\n}`);
  }
  if (!emptySrc) {
    for (const entry of ALLOWLIST) {
      if (omitAllow.includes(entry.name)) continue;
      blocks.push(`export enum ${entry.name} {\n  X = "x",\n}`);
    }
  }

  const ddl = [...pgLabels.entries()]
    .filter(([pg]) => !dropPgEnum.includes(pg))
    .map(
      ([pg, labels]) =>
        `    await q.query(\`CREATE TYPE "${pg}" AS ENUM (${[...labels].map((l) => `'${l}'`).join(", ")})\`);`,
    );

  const files = {
    "package.json": { name: "fixture", private: true },
    [`${MIGRATIONS_DIR}/001-init.ts`]: `export class Init1 {\n  async up(q) {\n${ddl.join("\n")}\n  }\n}\n`,
    [`${SRC_DIR}/enums.ts`]:
      (emptySrc ? "// 扫描面为空：没有任何枚举形态声明\n" : blocks.join("\n\n") + "\n") + extraTs,
    "apps/admin-web/src/pages/ExecutorListPage.tsx":
      frontend === "noanchor" ? frontendPageNoAnchor : frontendPage(
        frontend === "drift" ? ["online", "busy"] : ["online", "offline"],
      ),
  };
  // 「事实源缺失」用例：整份迁移都不写（scanPgEnums 会返回空对象）
  if (omitMigrations) delete files[`${MIGRATIONS_DIR}/001-init.ts`];
  return files;
}

/** A. 扫描器判据 fixture（与真实仓库形状无关，只喂 scanner）。 */
function scannerFixture() {
  const root = mkdtempSync(join(tmpdir(), "enum-drift-selftest-"));
  const srcDir = join(root, "src");
  const migDir = join(root, "migrations");
  mkdirSync(join(srcDir, "modules", "ghost"), { recursive: true });
  mkdirSync(migDir, { recursive: true });

  writeFileSync(
    join(migDir, "001-init.ts"),
    [
      "await q.query(`CREATE TYPE \"colour_enum\" AS ENUM ('red', 'green', 'blue')`);",
      "await q.query(`CREATE TYPE \"shape_enum\" AS ENUM (",
      "  'circle',",
      "  'square'",
      ")`);",
      "await q.query(`ALTER TYPE \"shape_enum\" ADD VALUE IF NOT EXISTS 'triangle'`);",
    ].join("\n"),
  );

  writeFileSync(
    join(srcDir, "modules", "ghost", "ghost.entity.ts"),
    [
      "// 注释里的 } 与 { 不得影响配对",
      "export enum Colour {",
      "  RED = \"red\",",
      "  GREEN = \"green\",",
      "}",
      "",
      "/** JSDoc 里的 `} }` 也不得影响配对 */",
      "export enum Weird {",
      "  A = \"red\",",
      "  B = pick({ red: 1, green: 2 }),", // ← 首版 [^}]* 在这里截断，丢掉后面的 C
      "  C = \"blue\",",
      "}",
      "",
      "export enum Nested {",
      "  A = \"red\",",
      "  B = wrap({ deep: \"green\" }),", // ← 嵌套对象里的字符串值也必须收到
      "}",
      "",
      "export const Shapes = {",
      "  CIRCLE: \"circle\",",
      "  SQUARE: \"square\",",
      "} as const;",
      "",
      "export const FrozenShapes = Object.freeze({",
      "  TRIANGLE: \"triangle\",",
      "});",
      "",
      "export enum Numeric {",
      "  LOW = 1,",
      "  HIGH = 2,",
      "}",
      "",
      "const LOCAL_CONST_OBJ = { X: \"x\" } as const;", // 未导出但列首 ⇒ 收录
      "",
      "export const Strings = [\"alpha\", \"beta\"] as const;", // 元组形态：刻意不扫
      "export const Numbers = [1, 2] as const;",
      "export const PlainObj = { a: \"red\" };", // 无 as const：普通对象，不收录
      "const localCamel = { y: \"q\" } as const;", // 小写模块常量：配置对象，不收录
    ].join("\n"),
  );

  writeFileSync(
    join(srcDir, "modules", "ghost", "ghost.controller.ts"),
    "import { Shapes } from './ghost.entity';\nexport class GhostController { m() { return Shapes.CIRCLE; } }\n",
  );
  writeFileSync(
    join(srcDir, "modules", "ghost", "ghost.dto.ts"),
    "export class GhostDto { shape!: string; }\n",
  );
  writeFileSync(join(srcDir, "unused.ts"), "export enum Uncovered { X = \"x\" }\n");

  return { root, srcDir, migDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function selftest() {
  const cases = [];

  // ── A. 扫描器判据（真 fixture + 真 scanner）──────────────────────────────
  const fx = scannerFixture();
  try {
    const pgEnums = scanPgEnums(fx.migDir);
    const decls = scanEnumDeclarations(fx.srcDir);
    const byName = new Map(decls.map((d) => [d.name, d]));
    const dump = (v) => JSON.stringify(Object.fromEntries(Object.entries(v).map(([k, s]) => [k, [...s]])));

    cases.push({
      name: "A1 PG 扫描：跨行 CREATE TYPE 与 ALTER TYPE ADD VALUE 都收到",
      fn: () => {
        if (!(pgEnums.shape_enum && pgEnums.shape_enum.size === 3 && pgEnums.colour_enum?.has("green"))) {
          throw new Error(`实际: ${dump(pgEnums)}`);
        }
      },
    });

    cases.push({
      name: "A2 enum 扫描：普通枚举的值集合正确（red/green）",
      fn: () => {
        const c = byName.get("Colour");
        if (!c || c.values.size !== 2 || !c.values.has("green")) {
          throw new Error(`实际: ${JSON.stringify([...(c?.values ?? [])])}`);
        }
      },
    });

    cases.push({
      name: "A3 截断回归：嵌套调用 `B = pick({…})` 之后的 C 不丢（且只留最后一个成员也算失败）",
      fn: () => {
        const w = byName.get("Weird");
        if (!w) throw new Error("Weird 未扫到");
        if (!w.values.has("blue") || w.values.size !== 2) {
          throw new Error(`实际: ${[...w.values].join(",")}`);
        }
        const n = byName.get("Nested");
        if (!n?.values.has("green")) throw new Error(`Nested 实际: ${[...(n?.values ?? [])].join(",")}`);
      },
    });

    cases.push({
      name: "A4 注释/JSDoc 里的花括号不破坏配对（Colour 之后仍能扫到 Weird/Nested）",
      fn: () => {
        for (const name of ["Colour", "Weird", "Nested"]) {
          if (!byName.has(name)) throw new Error(`缺 ${name}（实际: ${[...byName.keys()].join(",")}）`);
        }
      },
    });

    cases.push({
      name: "A5 const-object 形态：`as const` 与 `Object.freeze({…})` 都被识别",
      fn: () => {
        const s = byName.get("Shapes");
        if (!s || s.kind !== "const-object" || !s.values.has("circle") || !s.keys.includes("SQUARE")) {
          throw new Error(`Shapes: ${JSON.stringify(s && { kind: s.kind, keys: s.keys })}`);
        }
        const f = byName.get("FrozenShapes");
        if (!f || f.kind !== "const-object" || !f.values.has("triangle")) {
          throw new Error(`FrozenShapes: ${JSON.stringify(f && { kind: f.kind })}`);
        }
      },
    });

    cases.push({
      name: "A6 边界钉：`as const` 元组 / 普通对象 / 小写模块常量**不**纳入",
      fn: () => {
        const bad = ["Strings", "Numbers", "PlainObj", "localCamel"].filter((n) => byName.has(n));
        if (bad.length > 0) throw new Error(`不该收录: ${bad.join(",")}`);
      },
    });

    cases.push({
      name: "A7 数字枚举的成员被记录（供 keys-lowercase 映射）",
      fn: () => {
        if (byName.get("Numeric")?.numeric.size !== 2) throw new Error("Numeric.numeric 应含 2 个");
      },
    });

    const mapping = {
      Colour: "colour_enum",
      Weird: "colour_enum",
      Shapes: "shape_enum",
      FrozenShapes: "shape_enum",
      Numeric: { pg: "shape_enum", valueSource: "keys-lowercase" },
    };

    cases.push({
      name: "A8 映射比对：const-object / keys-lowercase 参与比对且逐值 ⊆ PG（Numeric 的 low 不在 shape_enum ⇒ 1 条漂移）",
      fn: () => {
        const drift = checkDrift({ pgEnums, declarations: decls, mapping });
        if (drift.length !== 1 || !drift[0].includes("Numeric") || !drift[0].includes("low")) {
          throw new Error(drift.join(" | "));
        }
        const good = checkDrift({
          pgEnums,
          declarations: decls.filter((d) => d.name !== "Numeric"),
          mapping: {
            Colour: "colour_enum",
            Weird: "colour_enum",
            Shapes: "shape_enum",
            FrozenShapes: "shape_enum",
          },
        });
        if (good.length !== 0) throw new Error(`全部 ⊆ 时不该报错: ${good.join(" | ")}`);
      },
    });

    cases.push({
      name: "A9 映射目标缺失（PG 类型不存在）→ 红",
      fn: () => {
        const e = checkDrift({ pgEnums, declarations: decls, mapping: { Colour: "nope_enum" } });
        if (e.length !== 1 || !e[0].includes("nope_enum")) throw new Error(e.join(" | "));
      },
    });

    const covAllow = ["Nested", "LOCAL_CONST_OBJ", "Uncovered"].map((name) => ({
      name,
      reason: "fixture：仅自检用，理由足够长以通过门槛",
    }));
    const consumersOf = makeConsumersResolver(fx.srcDir);

    cases.push({
      name: "A10 覆盖自检：全部登记（映射或豁免）→ 零报错；豁免命中不报未覆盖",
      fn: () => {
        const e = checkCoverage({ declarations: decls, mapping, allowlist: covAllow, consumersOf });
        if (e.length !== 0) throw new Error(e.join(" | "));
      },
    });

    cases.push({
      name: "A11 未覆盖枚举 → 红，并点名 文件:行 与相关 controller（帮人判断该映射还是该豁免）",
      fn: () => {
        const e = checkCoverage({
          declarations: decls,
          mapping: { Colour: "colour_enum" },
          allowlist: covAllow.filter((a) => a.name !== "Uncovered"),
          consumersOf,
        });
        if (!e.some((x) => x.includes("Uncovered") && x.includes("src/unused.ts:1"))) {
          throw new Error(`未点名 Uncovered/src/unused.ts:1: ${e.join(" | ")}`);
        }
        if (!e.some((x) => x.includes("Shapes") && x.includes("ghost.controller.ts"))) {
          throw new Error(`未打印消费面: ${e.join(" | ")}`);
        }
      },
    });

    cases.push({
      name: "A12 豁免过期（声明已不存在）→ 红（清单只减不增）",
      fn: () => {
        const e = checkCoverage({
          declarations: decls,
          mapping,
          allowlist: [...covAllow, { name: "DeletedThing", reason: "这是一条已经过期的豁免理由" }],
          consumersOf,
        });
        if (!e.some((x) => x.includes("DeletedThing") && x.includes("失效"))) {
          throw new Error(e.join(" | "));
        }
      },
    });

    cases.push({
      name: "A13 豁免缺理由 → 红；同一名字既映射又豁免 → 红（口径冲突）",
      fn: () => {
        const noReason = checkCoverage({
          declarations: decls,
          mapping: {},
          allowlist: [{ name: "Colour", reason: "" }],
          consumersOf: () => [],
        });
        if (!noReason.some((x) => x.includes("Colour") && x.includes("理由"))) {
          throw new Error(`缺理由未报: ${noReason.join(" | ")}`);
        }
        const conflict = checkCoverage({
          declarations: decls,
          mapping: { Colour: "colour_enum" },
          allowlist: [{ name: "Colour", reason: "fixture：故意与映射冲突的理由文本" }],
          consumersOf: () => [],
        });
        if (!conflict.some((x) => x.includes("冲突"))) throw new Error(`冲突未报: ${conflict.join(" | ")}`);
      },
    });

    const blockRe = FRONTEND_STATUS_SCANS[0].blockRe;
    const goodJsx = `
      <Select
        value={statusFilter}
        onChange={(v) => setStatusFilter(v)}
        options={[
          { value: 'online', label: 'Online' },
          { value: 'offline', label: 'Offline' },
        ]}
      />`;
    writeFileSync(join(fx.root, "page.tsx"), goodJsx);
    const inlineScan = { pgEnum: "executor_status_enum", file: "page.tsx", blockRe };
    const pgForFe = { executor_status_enum: new Set(["online", "offline"]) };

    cases.push({
      name: "A14 前端扫描：status options 的 value 被取出；锚点丢失 → 红（守卫失明不能静默通过）",
      fn: () => {
        const vals = scanFrontendStatusOptions(goodJsx, blockRe);
        if (!(vals && vals.has("online") && vals.has("offline"))) {
          throw new Error(`取出: ${JSON.stringify(vals && [...vals])}`);
        }
        const blind = checkFrontend({
          root: fx.root,
          pgEnums: pgForFe,
          read: () => "<Select />",
          scans: [inlineScan],
        });
        if (!blind.some((e) => e.includes("anchor not found"))) {
          throw new Error(`锚点丢失未报: ${blind.join(" | ")}`);
        }
      },
    });

    cases.push({
      name: "A15 前端漂移：value 'busy' 不在 PG enum → 红",
      fn: () => {
        const e = checkFrontend({
          root: fx.root,
          pgEnums: pgForFe,
          read: () => goodJsx.replace("'offline'", "'busy'"),
          scans: [inlineScan],
        });
        if (e.length !== 1 || !e[0].includes("busy")) throw new Error(e.join(" | "));
      },
    });

    cases.push({
      name: "A16 掩码器 / stripComments 自身：字符串内容被抹、结构保留、换行与偏移不变",
      fn: () => {
        const masked = maskNonCode('enum X { A = "a", B = "b" } // }\n');
        if (masked.includes('"a"') || !masked.includes("enum X") || masked.split("\n").length !== 2) {
          throw new Error(`masked: ${JSON.stringify(masked)}`);
        }
        const sample = 'const a = "keep /* not comment */"; // drop\n';
        const stripped = stripComments(sample);
        if (
          stripped.length !== sample.length ||
          !stripped.includes("keep") ||
          stripped.includes("drop")
        ) {
          throw new Error(`stripComments 偏移/内容不符: ${JSON.stringify(stripped)}`);
        }
      },
    });
  } finally {
    // 注意：fixture 必须活到 reportCases 跑完——A 组的 consumersOf() 与前端用例
    // 都是**调用时**做 IO（旧写法先 cleanup 再跑用例，于是「消费面」与「前端目标」
    // 全都变成「文件不存在」，用例红得莫名其妙）。
  }

  // ── B. 闸门（真子进程 + `--root`）──────────────────────────────────────────
  const DECLS = Object.keys(TS_TO_PG).length + ALLOWLIST.length;
  const subprocess = (name, files, expect, args = []) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "enum-drift-root-" });
        try {
          expectExit(runGuard(SELF_PATH, { args: ["--root", repo.dir, ...args] }), {
            ...expect,
            withinMs: 2000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  subprocess(
    "B1 全映射 / 全豁免自洽的 fixture → 绿（正例控制组：16 映射 + 20 豁免）",
    greenTree(),
    {
      code: 0,
      contains: [
        "PK-26 enum drift guard OK",
        `${DECLS} 个枚举声明`,
        `${Object.keys(TS_TO_PG).length} 映射 / ${ALLOWLIST.length} 豁免`,
        "覆盖自检通过",
      ],
      absent: ["FAIL", "结构错误", "✗"],
    },
  );

  subprocess(
    "B2 【反证·只留最后一个成员】漂移落在**中间**成员上 → 红（漏值就永远不比对）",
    greenTree({ tsOverride: { name: "TaskStatus", members: ['A = "v1"', 'B = "drifted"', 'C = "v2"'] } }),
    {
      code: 1,
      contains: ["PK-26 enum drift guard FAIL", "漂移：TS 声明 TaskStatus", "drifted", 'PG enum "task_status_enum"'],
      absent: ["PK-26 enum drift guard OK", "结构错误"],
    },
  );

  subprocess(
    "B3 未登记的新枚举声明 → 红（覆盖边界必须显式：映射或带理由豁免）",
    greenTree({ extraTs: 'export enum Rogue {\n  A = "a",\n}\n' }),
    {
      code: 1,
      contains: ["未覆盖的枚举声明：Rogue", "处置：若它对应 PG enum"],
      absent: ["PK-26 enum drift guard OK", "结构错误"],
    },
  );

  subprocess(
    "B4 豁免过期（ALLOWLIST 指向的声明已不存在）→ 红（清单只减不增）",
    greenTree({ omitAllow: ["COMMON_CODES"] }),
    {
      code: 1,
      contains: ["ALLOWLIST 条目 COMMON_CODES 失效", "请删除这条豁免"],
      absent: ["PK-26 enum drift guard OK"],
    },
  );

  subprocess(
    "B5 映射目标 PG 类型缺失 → 红（点名 PG enum 名）",
    greenTree({ dropPgEnum: ["task_status_enum"] }),
    {
      code: 1,
      contains: ['PG enum "task_status_enum" 未找到', "TaskStatus 的 PG 类型缺失"],
      absent: ["PK-26 enum drift guard OK", "结构错误"],
    },
  );

  subprocess(
    "B6 【反证·事实源缺失】没有 migrations 目录 → 结构红（不是「0 个漂移」）",
    greenTree({ omitMigrations: true }),
    {
      code: 1,
      contains: ["结构错误", "事实源缺失：apps/admin-api/src/migrations"],
      absent: ["PK-26 enum drift guard OK"],
    },
  );

  subprocess(
    "B7 【反证·扫描面为空】src 里没有任何枚举声明 → 结构红（0 个声明 ≠ 覆盖完整）",
    greenTree({ emptySrc: true }),
    {
      code: 1,
      contains: ["结构错误", "扫描面为空", "下界 30"],
      absent: ["PK-26 enum drift guard OK"],
    },
  );

  subprocess(
    "B8 前端字面量漂移（filter 提供 PG 里没有的 'busy'）→ 红",
    greenTree({ frontend: "drift" }),
    {
      code: 1,
      contains: ["frontend drift", "busy", "executor_status_enum"],
      absent: ["PK-26 enum drift guard OK"],
    },
  );

  subprocess(
    "B9 前端锚点丢失 → 红（守卫失明不能静默通过）",
    greenTree({ frontend: "noanchor" }),
    {
      code: 1,
      contains: ["status-filter anchor not found", "guard is blind"],
      absent: ["PK-26 enum drift guard OK"],
    },
  );

  subprocess(
    "B10 【反证·`--report` 吞结构错】扫描面塌了 → `--report` 也红（旧实现无条件 exit 0）",
    greenTree({ emptySrc: true }),
    {
      code: 1,
      contains: ["结构错误", "扫描面为空", "不能在看不见的扫描面上出报告"],
      absent: ["枚举声明共"],
    },
    ["--report"],
  );

  subprocess(
    "B11 `--report` 正常：列出声明数与覆盖去向 → 退出 0",
    greenTree({}),
    {
      code: 0,
      contains: [`枚举声明共 ${DECLS} 个`, "映射 → task_status_enum", "豁免"],
      absent: ["结构错误"],
    },
    ["--report"],
  );

  try {
    const failed = reportCases(cases, { title: "check-enum-drift selftest" });
    return failed === 0 ? 0 : 1;
  } finally {
    fx.cleanup();
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────
// 只有被**直接执行**时才跑扫描：本文件导出 scanner/判据，供 selftest、`--report`
// 与排障时 import 单独调用。没有这道守卫时 `import` 会立刻执行全量扫描并 exit。
function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

const isMain =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(SELF_PATH);

if (isMain) {
  const argv = process.argv.slice(2);
  const rootArg = argValue(argv, "--root");
  const cliRoot = rootArg ? resolve(rootArg) : DEFAULT_ROOT;
  if (argv.includes("--selftest")) {
    process.exit(selftest());
  } else if (argv.includes("--report")) {
    process.exit(report({ root: cliRoot }));
  } else {
    process.exit(run({ root: cliRoot }));
  }
}

export { TS_TO_PG, ALLOWLIST, FRONTEND_STATUS_SCANS };
