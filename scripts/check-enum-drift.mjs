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
// 退出码：0 = 无漂移且覆盖完整；1 = 漂移 / 未覆盖 / 豁免失效。
//
// 用法：node scripts/check-enum-drift.mjs [--selftest] [--report]
//   --selftest：用临时 fixture 验证判据本身（不扫真实代码库）。
//   --report  ：打印所有声明与其覆盖去向（映射 / 豁免 / 未覆盖），不进入比对。
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
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MIGRATIONS_DIR = "apps/admin-api/src/migrations";
const SRC_DIR = "apps/admin-api/src";
const SELF = "scripts/check-enum-drift.mjs";

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
  pgEnums,
  scans = FRONTEND_STATUS_SCANS,
  read = (f) => readFileSync(f, "utf8"),
}) {
  const errors = [];
  for (const scan of scans) {
    if (!existsSync(scan.file)) {
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

// ── selftest：用真目录 fixture 跑真 scanner ─────────────────────────────────
function selftest() {
  let fail = 0;
  const t = (name, cond, detail) => {
    if (cond) console.log(`  ✔ ${name}`);
    else {
      fail++;
      console.error(`  ✘ ${name}${detail ? `\n      ${detail}` : ""}`);
    }
  };
  console.log(`enum-drift selftest（跑真 scanner，fixture 在 mkdtemp 里）:`);

  const root = mkdtempSync(join(tmpdir(), "enum-drift-selftest-"));
  const srcDir = join(root, "src");
  const migDir = join(root, "migrations");
  mkdirSync(join(srcDir, "modules", "ghost"), { recursive: true });
  mkdirSync(migDir, { recursive: true });

  try {
    // 迁移：两个 enum（其中一个跨行 + ALTER 扩值）
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

    // ① 正常枚举；② 嵌套对象初值（截断回归）；③ const-object；④ Object.freeze 元组
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
        "const LOCAL_CONST_OBJ = { X: \"x\" } as const;", // 非法：未导出、非列首？→ 列首且未导出 ⇒ 收录
        "",
        "export const Strings = [\"alpha\", \"beta\"] as const;", // 元组形态：刻意不扫（见文件头边界）
        "export const Numbers = [1, 2] as const;",
        "export const PlainObj = { a: \"red\" };", // 无 as const：普通对象，不收录
        "const localCamel = { y: \"q\" } as const;", // 小写模块常量：配置对象，不收录
      ].join("\n"),
    );

    // 未覆盖枚举的"消费面"，验证错误信息能指到 controller/dto
    writeFileSync(
      join(srcDir, "modules", "ghost", "ghost.controller.ts"),
      "import { Shapes } from './ghost.entity';\nexport class GhostController { m() { return Shapes.CIRCLE; } }\n",
    );
    writeFileSync(
      join(srcDir, "modules", "ghost", "ghost.dto.ts"),
      "export class GhostDto { shape!: string; }\n",
    );
    writeFileSync(
      join(root, "src", "unused.ts"),
      "export enum Uncovered { X = \"x\" }\n",
    );

    const pgEnums = scanPgEnums(migDir);
    const decls = scanEnumDeclarations(srcDir);
    const byName = new Map(decls.map((d) => [d.name, d]));

    // ── 判据 A：PG 扫描（跨行 CREATE TYPE + ALTER ADD VALUE）──────────────
    t(
      "PG 扫描：跨行 CREATE TYPE 与 ALTER TYPE ADD VALUE 都收到",
      pgEnums.shape_enum && pgEnums.shape_enum.size === 3 && pgEnums.colour_enum?.has("green"),
      `实际: ${JSON.stringify(Object.fromEntries(Object.entries(pgEnums).map(([k, v]) => [k, [...v]])))}`,
    );

    // ── 判据 B：enum 形态 + 值集合 ────────────────────────────────────────
    t(
      "enum 扫描：普通枚举的值集合正确",
      byName.get("Colour")?.values.size === 2 && byName.get("Colour").values.has("green"),
    );
    t(
      "截断回归：嵌套调用 `B = pick({…})` 之后的 C 不丢（首版 [^}]* 截断在 `}` 处，只能拿到 red）",
      byName.get("Weird") && byName.get("Weird").values.has("blue") && byName.get("Weird").values.size === 2,
      `实际: ${[...(byName.get("Weird")?.values ?? [])].join(",")}`,
    );
    t(
      "嵌套对象里的字符串值被收进值集合",
      byName.get("Nested")?.values.has("green") === true,
      `实际: ${[...(byName.get("Nested")?.values ?? [])].join(",")}`,
    );
    t(
      "注释/JSDoc 里的花括号不破坏配对（Colour 之后仍能扫到 Weird/Nested）",
      byName.has("Colour") && byName.has("Weird") && byName.has("Nested"),
    );

    // ── 判据 C：const-object / Object.freeze / 元组 形态 ─────────────────
    t(
      "`as const` 对象被识别（键 + 值）",
      byName.get("Shapes")?.kind === "const-object" &&
        byName.get("Shapes").values.has("circle") &&
        byName.get("Shapes").keys.includes("SQUARE"),
    );
    t(
      "`Object.freeze({…})` 被识别",
      byName.get("FrozenShapes")?.kind === "const-object" &&
        byName.get("FrozenShapes").values.has("triangle"),
    );
    t(
      "边界钉：`as const` 元组/普通对象/小写模块常量**不**纳入（避免白名单/CSV 表头把信号埋掉）",
      !byName.has("Strings") && !byName.has("Numbers") && !byName.has("PlainObj") && !byName.has("localCamel"),
      `实际收集到: ${[...byName.keys()].join(",")}`,
    );
    t("数字枚举的成员被记录（供 keys-lowercase 映射）", byName.get("Numeric")?.numeric.size === 2);

    // ── 判据 D：映射比对（含 keys-lowercase 与 const-object 参与比对）─────
    const mapping = {
      Colour: "colour_enum",
      Weird: "colour_enum", // Weird 有 red/green/blue ⇒ 恰好在 colour_enum 里
      Shapes: "shape_enum",
      FrozenShapes: "shape_enum",
      Numeric: { pg: "shape_enum", valueSource: "keys-lowercase" },
    };
    const drift = checkDrift({ pgEnums, declarations: decls, mapping });
    t(
      "映射比对：const-object / keys-lowercase 参与比对且逐值 ⊆ PG（Numeric 的 low/high 不在 shape_enum ⇒ 1 条漂移）",
      drift.length === 1 && drift[0].includes("Numeric") && drift[0].includes("low"),
      drift.join(" | "),
    );

    const goodDrift = checkDrift({
      pgEnums,
      declarations: decls.filter((d) => d.name !== "Numeric"),
      mapping: { Colour: "colour_enum", Weird: "colour_enum", Shapes: "shape_enum", FrozenShapes: "shape_enum" },
    });
    t("映射比对：全部 ⊆ PG 时不报错", goodDrift.length === 0, goodDrift.join(" | "));

    const missingPg = checkDrift({
      pgEnums,
      declarations: decls,
      mapping: { Colour: "nope_enum" },
    });
    t(
      "映射目标缺失（PG 类型不存在）→ 红",
      missingPg.length === 1 && missingPg[0].includes("nope_enum"),
      missingPg.join(" | "),
    );

    // ── 判据 E：覆盖自检 ────────────────────────────────────────────────
    // 映射与豁免互斥（同名同时出现会被判"口径冲突"），故这里分开登记：
    // 5 个走映射，4 个走豁免（模拟"列是 varchar"那批）。
    const covAllow = ["Nested", "LOCAL_CONST_OBJ", "Uncovered"].map((name) => ({
      name,
      reason: "fixture：仅自检用，理由足够长以通过门槛",
    }));
    const consumersOf = makeConsumersResolver(srcDir);
    t(
      "覆盖自检：全部登记（映射或豁免）→ 零报错",
      checkCoverage({ declarations: decls, mapping, allowlist: covAllow, consumersOf }).length === 0,
      checkCoverage({ declarations: decls, mapping, allowlist: covAllow, consumersOf }).join(" | "),
    );

    const uncoveredErrors = checkCoverage({
      declarations: decls,
      mapping: { Colour: "colour_enum" },
      allowlist: covAllow.filter((a) => a.name !== "Uncovered"),
      consumersOf,
    });
    t(
      "未覆盖枚举 → 红，且点名 文件:行（unused.ts:1 没有任何消费面时也能定位）",
      uncoveredErrors.some((e) => e.includes("Uncovered") && e.includes("src/unused.ts:1")),
      uncoveredErrors.join("\n      "),
    );
    t(
      "未覆盖枚举 → 红，且打印相关 controller/DTO（帮人判断该映射还是该豁免）",
      uncoveredErrors.some((e) => e.includes("Shapes") && e.includes("ghost.controller.ts")),
      uncoveredErrors.join("\n      "),
    );

    t(
      "豁免命中（带理由）→ 不报未覆盖",
      checkCoverage({ declarations: decls, mapping, allowlist: covAllow, consumersOf }).length === 0,
    );

    const staleAllow = checkCoverage({
      declarations: decls,
      mapping,
      allowlist: [...covAllow, { name: "DeletedThing", reason: "这是一条已经过期的豁免理由" }],
      consumersOf,
    });
    t(
      "豁免过期（声明已不存在）→ 红（清单只减不增）",
      staleAllow.some((e) => e.includes("DeletedThing") && e.includes("失效")),
      staleAllow.join(" | "),
    );

    const noReason = checkCoverage({
      declarations: decls,
      mapping: {},
      allowlist: [{ name: "Colour", reason: "" }],
      consumersOf: () => [],
    });
    t(
      "豁免缺理由 → 红",
      noReason.some((e) => e.includes("Colour") && e.includes("理由")),
      noReason.join(" | "),
    );

    t(
      "同一名字既映射又豁免 → 红（口径冲突）",
      checkCoverage({
        declarations: decls,
        mapping: { Colour: "colour_enum" },
        allowlist: [{ name: "Colour", reason: "fixture：故意与映射冲突的理由文本" }],
        consumersOf: () => [],
      }).some((e) => e.includes("冲突")),
    );

    // ── 判据 F：前端字面量（保留原有反证）────────────────────────────────
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
    const goodVals = scanFrontendStatusOptions(goodJsx, blockRe);
    t(
      "前端扫描：status options 的 value 被取出",
      Boolean(goodVals && goodVals.has("online") && goodVals.has("offline")),
    );
    const pgForFe = { executor_status_enum: new Set(["online", "offline"]) };
    const inlineScan = { pgEnum: "executor_status_enum", file: SELF, blockRe };
    const feErrors = checkFrontend({
      pgEnums: pgForFe,
      read: () => goodJsx.replace("'offline'", "'busy'"),
      scans: [inlineScan],
    });
    t(
      "前端漂移：value 'busy' 不在 PG enum → 红",
      feErrors.length === 1 && feErrors[0].includes("busy"),
      feErrors.join(" | "),
    );
    t(
      "前端锚点丢失 → 红（守卫失明不能静默通过）",
      checkFrontend({ pgEnums: pgForFe, read: () => "<Select />", scans: [inlineScan] }).some((e) =>
        e.includes("anchor not found"),
      ),
    );

    // ── 判据 G：掩码器自身（防止"掩码过度 ⇒ 值全丢"这种反向失效）────────
    const maskedSample = maskNonCode('enum X { A = "a", B = "b" } // }\n');
    t(
      "掩码器：字符串内容被抹掉、代码结构保留、换行不丢",
      !maskedSample.includes('"a"') &&
        maskedSample.includes("enum X") &&
        maskedSample.split("\n").length === 2,
    );
    t(
      "stripComments：字符串保留、注释被抹（等长，偏移不变）",
      (() => {
        const s = 'const a = "keep /* not comment */"; // drop\n';
        const r = stripComments(s);
        return r.length === s.length && r.includes("keep") && !r.includes("drop");
      })(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log(fail === 0 ? "\n✔ enum-drift selftest 全通过" : `\n✘ enum-drift selftest ${fail} 项失败`);
  return fail === 0 ? 0 : 1;
}

// ── report：列出所有声明及其覆盖去向 ────────────────────────────────────────
function report() {
  const pgEnums = scanPgEnums(MIGRATIONS_DIR);
  const decls = scanEnumDeclarations(SRC_DIR);
  const allowed = new Map(ALLOWLIST.map((a) => [a.name, a.reason]));
  const mapped = new Set(Object.keys(TS_TO_PG));
  const rows = decls
    .slice()
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  console.log(`枚举声明共 ${decls.length} 个（PG enum ${Object.keys(pgEnums).length} 个）：`);
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

// ── main ────────────────────────────────────────────────────────────────────
// 只有被**直接执行**时才跑扫描：本文件导出 scanner/判据，供 selftest、
// `--report` 与排障时 import 单独调用。没有这道守卫时 `import` 会立刻执行
// 全量扫描并 exit（首版没有，实测排障探针只打印一行"OK"就退出，看不到判据内部状态）。
const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (!invokedDirectly) {
  // import 场景：什么都不做，让调用方自己用导出的函数。
} else if (process.argv.includes("--selftest")) {
  process.exit(selftest());
} else if (process.argv.includes("--report")) {
  process.exit(report());
} else {
  const pgEnums = scanPgEnums(MIGRATIONS_DIR);
  const declarations = scanEnumDeclarations(SRC_DIR);
  const errors = [
    ...checkDrift({ pgEnums, declarations }),
    ...checkCoverage({
      declarations,
      consumersOf: makeConsumersResolver(SRC_DIR),
    }),
  ];
  // P2-4 guard extension: also assert web-client status literals ⊆ PG enums.
  errors.push(...checkFrontend({ pgEnums }));
  if (errors.length > 0) {
    console.error("PK-26 enum drift guard FAIL:");
    for (const e of errors) console.error("  ✗ " + e);
    process.exit(1);
  }
  console.log(
    `PK-26 enum drift guard OK: ${declarations.length} 个枚举声明（${Object.keys(TS_TO_PG).length} 映射 / ${ALLOWLIST.length} 豁免）全部 ⊆ 对应 PG enum，覆盖自检通过`,
  );
}

export { TS_TO_PG, ALLOWLIST, FRONTEND_STATUS_SCANS };
