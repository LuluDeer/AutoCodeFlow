#!/usr/bin/env node
// WEB-TYPE-DRIFT：admin-web 手写 API 类型的**只减不增**棘轮守卫（第 47 条守卫）。
//
// ## 这条棘轮挡的是什么腐烂
//
// 契约面早已单源：`apps/admin-web/package.json:18` 的 `gen:api-types` 由
// `apps/admin-api/openapi.json` 生成 `src/types/generated/api-types.ts`（14,982 行、
// 242 个 `components['schemas']`），CI 还有两道「生成物 vs 契约」的 diff 闸
// （`.github/workflows/ci.yml:2165,2210-2231`）。**但生成物是"可选事实源"**：
// `apps/admin-web/src/api/*.ts` 里另有一套手写 interface（会话、审批、应用、执行器……），
// 它们与生成物同名/同义，**tsc 与既有守卫都看不见**——后端把 `status` 从 `running`
// 改成 `in_progress` 时，手写类型照旧编译通过，前端静默读到 `undefined`。
// `check-enum-drift.mjs:844-851` 的注释已经把这个盲区写在脸上（它的前端面
// `FRONTEND_STATUS_SCANS` 覆盖 N=1，且刻意排除 `as const` 元组）。
//
// 本守卫**不迁存量**（主会话裁定 R11：迁移被否决，133 处手写类型原地不动），
// 只把"漂移"变成一道显式的、可数的闸：
//
//   ① 手写类型**数量与名字集合冻结在基线里**（`scripts/web-type-drift-baseline.json`）；
//      出现基线里没有的手写类型 ⇒ 红（新增即红）；
//   ② 基线里登记过、现在**已经不存在**的声明 ⇒ 红（"基线陈旧"：改成合同派生、
//      或直接删掉都是好事，但必须把基线一起收紧，否则基线会烂成一张没人看的豁免单）；
//   ③ `allowlist` 是唯一的**有理由的增长通道**：一条新类型要么**来自**生成合同
//      （`components['schemas']`，按定义不算手写），要么带理由登记进豁免表；
//      豁免必须是活着的（声明被删 ⇒ 豁免失效 ⇒ 红）；
//   ④ 判据**不可静态判读 ⇒ 结构红**（不是判绿）：api 目录/生成物/基线缺失、
//      扫描面塌方（文件数/声明数/生成 schema 数低于下界）一律红。
//
// ## 判据（人能复核的规则）
//
//   扫描面：`apps/admin-web/src/api/*.ts`（**仅该目录，不递归**；排除
//           `*.spec.ts` / `*.test.ts` / `*.d.ts`）。
//   计数对象：该目录下**顶格**（第 0 列）的类型声明
//           —— `interface NAME …` 与 `type NAME = …`，导出与否都算。
//   刻意**不**统计（三类，见 `classify()`）：
//     · **合同派生**：RHS 或 `extends` 子句里出现 `components['schemas']`
//       （含 `= components['schemas']['XDto']` 这类直接别名）⇒ 它的事实源本来就是
//       生成物，是本守卫要促成的形态，不冻结、不红；
//     · **字面量镜像**：`type X = (typeof LOCAL_TUPLE)[number]…` ⇒ 它镜像的是本文件的
//       `as const` 元组，不是 OpenAPI 视图模型；与 `check-enum-drift.mjs:28` 刻意排除
//       `as const` 元组的边界保持一致；
//     · **嵌套声明**：缩进在函数体 / `namespace` / `declare module` 里的 interface/type
//       （实测 `client.ts:33 RequestConfig`、`:213 PersistedAuthState`、
//       `sse-client.ts:42 SseStatusListener`、`sse.ts:35 SseTicketResponse` 这类
//       **模块内部辅助类型**）——它们不是对外 API 面，第 0 列的规则把它们排除。
//   另：`enum`、`const`、函数、`export type { X } from './y'` 之类的重导出**不是声明**，
//   本来就不在计数面内。
//
// ## 与生成物的关系（只报现状，不判红）
//
// `--report` 额外列出「手写名与生成物同名」的处数（剥 `Dto/ResponseDto` 后缀后比对）。
// 这是 S3-C4 迁移面的大小，本守卫**不**据此判红（R11：不迁存量）。
//
// ## 2026-11-04：接共用件 `scripts/lib/ratchet-baseline.mjs`
//
// 「读基线 + 判形状」交给共用件（`readRatchetBaseline`），「登记是否有主有期限」
// 交给共用件（`compareEntry` / `renderExpired`，措辞「复核期限已过」统一定义一次）。
// **「怎么量」仍在本守卫**：key 形状、allowlist 的领域形状（file/name/reason）、
// 增/减/豁免失效/重复登记四组差值 —— 那些是本守卫的判据，共用件不接管。
//
// 基线条目形态随之从**纯字符串**升级为**结构化对象**：
//   { "key": "<相对路径>\t<类型名>", "owner": "<谁负责>", "review_by": "<YYYY-MM-DD>" }
// 一条登记就是一张豁免单（手写类型被冻结 = 允许它不来自生成合同），豁免单必须
// 有主有期限：缺 owner / 缺 review_by ⇒ 结构红；review_by 过期 ⇒ 红。
// 旧格式（纯字符串）仍可读但**判红**（那正是欠账本身）。
//
// 退出码：0 = 无新增/无陈旧/豁免活着且判据可信；1 = 漂移 / 基线陈旧 / 豁免失效 /
//         **判据不可信**（结构红）。
//
// 用法：node scripts/check-web-type-drift.mjs [--report] [--root <dir>]
//       node scripts/check-web-type-drift.mjs --selftest
//   --report：打印现状（分类明细 + 棘轮差值 + 同名读数），**漂移不判红**，结构红照判。
//   --root  ：把该目录当仓库根（selftest 专用；默认由脚本位置推出）。
//   --selftest：用临时 fixture 树跑真子进程，逐条断言退出码 + 报错文本（含正例控制组）。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";
// R163：覆盖计数出口。**必须在任何 require/依赖之前**打印 —— 本文件若因缺依赖崩掉，
// 「崩了」与「零用例」必须能被哨兵分开看（`scripts/lib/agent-coverage.mjs` 头注同款纪律）。
printCoverageBanner(import.meta.url, "expectExit");
import {
  compareEntry,
  readRatchetBaseline,
  renderExpired,
  utcDay,
} from "./lib/ratchet-baseline.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 默认仓库根：脚本位于 `<repo>/scripts/`，由脚本位置推出，不依赖调用方 cwd。 */
export const DEFAULT_ROOT = resolve(HERE, "..");

const API_DIR = "apps/admin-web/src/api";
const GENERATED_REL = "apps/admin-web/src/types/generated/api-types.ts";
const BASELINE_REL = "scripts/web-type-drift-baseline.json";

/**
 * 扫描面下界（实测：26 个 api 文件 / 133 处顶层声明 / 242 个生成 schema）。
 *
 * 留足余量，钉的是「正则与解析器还能不能从这两份文件里读出东西」，不是「有几条」。
 * 低于下界时「0 处漂移」只是一句没有宾语的实话——一处都没看，当然没有漂移。
 */
export const MIN_API_FILES = 20;
export const MIN_DECLARATIONS = 100;
export const MIN_GENERATED_SCHEMAS = 120;

/** 生成物里的合同引用：`components['schemas']['XDto']` / `components["schemas"]["XDto"]`。 */
const CONTRACT_RE = /components\s*\[\s*['"]schemas['"]\s*\]/;

/** 字面量镜像：`(typeof X)[number]`（允许链条后缀，如 `[number]['value']`）。 */
const MIRROR_RE = /\(\s*typeof\s+[A-Za-z_$][\w$]*\s*\)\s*\[\s*number\s*\]/;

// ── 词法小工具（零依赖，偏移量保持：掩码只把字符换成空格，不动换行）────────────

/**
 * 只掩注释、**保留字符串内容**（RHS 里的 `components['schemas']` 必须留着）。
 * 掩码后偏移量与原文一致，`^` 行锚点仍然可用（注释行变成空白，不会被误判成声明）。
 */
export function stripComments(src) {
  const out = src.split("");
  const hide = (i) => {
    if (i >= 0 && i < out.length && out[i] !== "\n") out[i] = " ";
  };
  let state = "code"; // code | line | block | single | double | template
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (state === "code") {
      if (c === "/" && d === "/") {
        hide(i);
        hide(i + 1);
        state = "line";
        i += 2;
        continue;
      }
      if (c === "/" && d === "*") {
        hide(i);
        hide(i + 1);
        state = "block";
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") state = c;
      i++;
      continue;
    }
    if (state === "line") {
      if (c === "\n") state = "code";
      else hide(i);
      i++;
      continue;
    }
    if (state === "block") {
      if (c === "*" && d === "/") {
        hide(i);
        hide(i + 1);
        state = "code";
        i += 2;
        continue;
      }
      hide(i);
      i++;
      continue;
    }
    // 字符串内部：保留内容，只跟踪引号闭合（含转义）。
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === state) state = "code";
    i++;
  }
  return out.join("");
}

/** 掩注释**与字符串内容**：括号配平必须看不见 `"}"`（照抄 check-enum-drift 的做法）。 */
export function maskNonCode(src) {
  const out = src.split("");
  const hide = (i) => {
    if (i >= 0 && i < out.length && out[i] !== "\n") out[i] = " ";
  };
  let state = "code";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (state === "code") {
      if (c === "/" && d === "/") {
        hide(i);
        hide(i + 1);
        state = "line";
        i += 2;
        continue;
      }
      if (c === "/" && d === "*") {
        hide(i);
        hide(i + 1);
        state = "block";
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        hide(i);
        state = c;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (state === "line") {
      if (c === "\n") state = "code";
      else hide(i);
      i++;
      continue;
    }
    if (state === "block") {
      if (c === "*" && d === "/") {
        hide(i);
        hide(i + 1);
        state = "code";
        i += 2;
        continue;
      }
      hide(i);
      i++;
      continue;
    }
    // 字符串内部：整段掩掉（含转义）。
    hide(i);
    if (c === "\\") {
      hide(i + 1);
      i += 2;
      continue;
    }
    if (c === state) state = "code";
    i++;
  }
  return out.join("");
}

/**
 * 从 `from`（指向 `{` / `(` / `[`）起括号配平，返回闭括号下标；配平在
 * **maskNonCode** 过的文本上做，字符串与注释不会破坏配对。找不到时返回 -1。
 */
export function matchBracket(masked, from) {
  const open = masked[from];
  const close = { "{": "}", "(": ")", "[": "]" }[open];
  if (!close) return -1;
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 从声明名字之后读到语句结尾（`;`，深度 0；`interface` 则在第一个深度 0 的 `{` 停下）。
 * 输入是 **stripComments** 过的文本（字符串保留），扫描本身引号感知。
 *
 * @returns {{text: string, end: number}} text = 名字与结束符之间的原文片段。
 */
export function readDeclTail(src, from, stopAtBrace) {
  let i = from;
  let depth = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      i++;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      if (stopAtBrace && c === "{" && depth === 0) {
        return { text: src.slice(from, i), end: i };
      }
      depth++;
      i++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      i++;
      continue;
    }
    if (c === ";" && depth === 0) return { text: src.slice(from, i), end: i };
    i++;
  }
  return { text: src.slice(from), end: src.length };
}

// ── 扫描：生成物里的 components['schemas'] 名字集合 ──────────────────────────

/**
 * 解析 `src/types/generated/api-types.ts` 的 `components { schemas { … } }`，
 * 返回 schema 名字集合（只取 block 深度 0 的成员名）。
 */
export function parseGeneratedSchemas(text) {
  const masked = maskNonCode(text);
  const m = /(^|\n)\s*schemas\s*:\s*\{/.exec(masked);
  if (!m) return new Set();
  const braceAt = masked.indexOf("{", m.index + m[1].length);
  if (braceAt < 0) return new Set();
  const end = matchBracket(masked, braceAt);
  if (end < 0) return new Set();
  const body = masked.slice(braceAt + 1, end);
  const names = new Set();
  // 只看 block 内**深度 0** 的 `Name:` / `Name?:`；字符串已被掩成空格，值里的
  // `'a' | 'b'` 不会误命中，嵌套字段（深度 ≥1）也不会。
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{" || c === "(" || c === "[") {
      depth++;
      continue;
    }
    if (c === "}" || c === ")" || c === "]") {
      depth--;
      continue;
    }
    if (depth !== 0) continue;
    const mm = /([A-Za-z_$][\w$]*)\s*\??\s*:/y;
    mm.lastIndex = i;
    const hit = mm.exec(body);
    if (!hit) continue;
    const nameAt = i;
    // 排除索引签名 `[key: string]: …`（名字前紧贴 `[`）。
    const prev = nameAt > 0 ? body[nameAt - 1] : "";
    if (prev !== "[") names.add(hit[1]);
    i = mm.lastIndex - 1;
  }
  return names;
}

// ── 扫描：api/*.ts 的顶层类型声明 ────────────────────────────────────────────

/** 扫描面 = `api/` 下非递归的 `*.ts`（排除 spec/test/d.ts）。 */
export function listApiFiles(root) {
  const dir = join(root, API_DIR);
  if (!existsSync(dir)) return null;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => !/\.(spec|test|d)\.ts$/.test(f))
    .sort();
}

/**
 * 判定一条声明属于哪个桶：
 *   · contract —— RHS/extends 引用 `components['schemas']`（来自生成合同）；
 *   · mirror   —— `(typeof LOCAL)[number]`（本文件 as const 元组的字面量镜像）；
 *   · handwritten —— 其余（**被棘轮冻结的**那个集合）。
 */
export function classify(decl) {
  const hay = `${decl.rhs}\n${decl.extendsText}`;
  if (CONTRACT_RE.test(hay)) return "contract";
  if (MIRROR_RE.test(decl.rhs)) return "mirror";
  return "handwritten";
}

/**
 * 扫出 `api/*.ts` 的顶层（第 0 列）interface / type 声明。
 *
 * 返回 `{ file, line, name, kind, rhs, extendsText, bucket }[]`。
 * 注意：只有**第 0 列**的声明算数——缩进在函数/namespace/declare module 里的
 * 辅助类型不是 API 面（边界写在文件头注释里）。
 */
export function scanApiDeclarations(root) {
  const files = listApiFiles(root);
  if (files === null) return null;
  const decls = [];
  const re = /^(?:export\s+)?(interface|type)\s+([A-Za-z_$][\w$]*)/gm;
  for (const file of files) {
    const raw = readFileSync(join(root, API_DIR, file), "utf8");
    const src = stripComments(raw);
    const rel = `${API_DIR}/${file}`;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) {
      const kind = m[1];
      const name = m[2];
      const after = m.index + m[0].length;
      const tail = readDeclTail(src, after, kind === "interface");
      const rhs = kind === "type" ? tail.text : "";
      const extendsText = kind === "interface" ? tail.text : "";
      const decl = {
        file: rel,
        name,
        kind,
        line: src.slice(0, m.index).split("\n").length,
        rhs: rhs.trim(),
        extendsText: extendsText.trim(),
      };
      decl.bucket = classify(decl);
      decls.push(decl);
    }
  }
  return decls;
}

// ── 基线 ─────────────────────────────────────────────────────────────────────

/** 基线里的键：`相对路径\t类型名`（人可复核、可 diff）。 */
export const keyOf = (d) => `${d.file}\t${d.name}`;

/**
 * 读基线。**结构损坏一律抛错**（由调用方转成结构红）——旧病是把坏基线静默当空基线，
 * 于是「基线里什么都没有」=「有 133 处新增」或「全绿」，两种误判都很贵。
 *
 * ── 2026-11-04：接共用件 `scripts/lib/ratchet-baseline.mjs` ──
 *
 * 「读文件 + 判形状」这一层交给共用件（`readRatchetBaseline`）：文件缺失 /
 * 不可解析 / 顶层非对象 / `known`·`allowlist` 不是数组 ⇒ **结构红**（共用件的
 * `error` 文案）。**「怎么量」仍在本守卫**（key 形状、allowlist 的领域形状、
 * 增/减/豁免失效三组差值）—— 那些是本守卫的领域判据，共用件不接管。
 *
 * ── 基线条目形态升级（2026-11-04）──
 *
 * `known` 的条目从**纯字符串**（`"相对路径\t类型名"`）升级为**结构化对象**：
 *
 *   { "key": "<相对路径>\t<类型名>", "owner": "<谁负责>", "review_by": "<YYYY-MM-DD>" }
 *
 * 原因：一条基线登记就是一张**豁免单**（手写类型被冻结在基线里 = 允许它不来自
 * 生成合同）。豁免单必须**有主有期限**，否则它就是一张没人看的永久白名单。
 *
 * **兼容旧格式**：纯字符串条目仍可读（规整成 `{key, legacy: true}`），
 * 但守卫会把 legacy 条目**判红**——旧格式没有 owner/review_by，正是欠账本身。
 * （判红由共用件的字段层统一给出：缺 owner/review_by ⇒ 结构红。）
 */
export function loadBaseline(root) {
  // 两次调用共用件的读+形状校验：一张基线文件里有两张表（known / allowlist），
  // 共用件一次只校验一张表的形态。第一张表的 error 优先（文件缺失/坏 JSON 时
  // 两次都会报，报一次就够）。
  const knownRead = readRatchetBaseline({
    root,
    rel: BASELINE_REL,
    kind: "array",
    entriesKey: "known",
    label: "基线",
  });
  if (knownRead.error) {
    const err = new Error(knownRead.error);
    err.structural = true;
    throw err;
  }
  const json = knownRead.raw;
  // allowlist 是同一文件里的**第二张表**：数组性也交给共用件判（措辞统一）。
  // ⚠️ 「键缺失 ⇒ 空表」这条改造前的语义保留（本仓基线一直带 allowlist 键；
  // 缺键时按空表处理，不新增一条与本轮无关的判红）。
  const allowRead = readRatchetBaseline({
    root,
    rel: BASELINE_REL,
    kind: "array",
    entriesKey: "allowlist",
    label: "基线",
  });
  if (allowRead.error && json.allowlist !== undefined) {
    const err = new Error(allowRead.error);
    err.structural = true;
    throw err;
  }
  const allowRaw = json.allowlist === undefined ? [] : json.allowlist;

  const known = [];
  const knownEntries = [];
  const dupKnown = [];
  const seen = new Set();
  for (const item of json.known) {
    const entry = normalizeKnownEntry(item);
    if (seen.has(entry.key)) {
      dupKnown.push(entry.key);
      continue;
    }
    seen.add(entry.key);
    knownEntries.push(entry);
  }
  // `known` = **唯一真相 `knownEntries` 的 key 投影**（不另存一份，避免两份真相
  // 各自演化：棘轮差值用 key 串比较，字段/期限校验用对象）。
  known.push(...knownEntries.map((e) => e.key));
  const allow = [];
  const badAllow = [];
  for (const item of allowRaw) {
    if (
      item === null ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.file !== "string" ||
      typeof item.name !== "string"
    ) {
      const err = new Error(
        `基线 allowlist 条目非法（应为 { file, name, reason, owner, review_by }）：${JSON.stringify(item)}（${BASELINE_REL}）`,
      );
      err.structural = true;
      throw err;
    }
    const key = `${item.file}\t${item.name}`;
    const reason = typeof item.reason === "string" ? item.reason.trim() : "";
    allow.push({
      key,
      file: item.file,
      name: item.name,
      reason,
      // owner / review_by 原样带出（共用件判「有主有期限」用；规整时丢掉会让
      // 所有 allowlist 条目看起来都缺 owner ⇒ 全部判红）。
      owner: item.owner,
      review_by: item.review_by,
    });
    if (reason.length === 0) badAllow.push(key);
    if (seen.has(key)) dupKnown.push(key);
  }
  return { known, knownEntries, allow, dupKnown, badAllow, path: BASELINE_REL };
}

/**
 * 把一条 `known` 基线条目规整成 `{key, owner, review_by, legacy}`。
 *
 * 字符串形态（旧基线）→ `legacy: true`，owner/review_by 缺省 ⇒ 后面判红
 * （旧格式缺 reason/owner/review_by ＝ 欠账本身，不是「历史遗留所以先放过」）。
 */
function normalizeKnownEntry(raw) {
  if (typeof raw === "string") {
    if (!raw.includes("\t")) {
      const err = new Error(
        `基线 known 条目非法（应为 "相对路径\\t类型名"）：${JSON.stringify(raw)}（${BASELINE_REL}）`,
      );
      err.structural = true;
      throw err;
    }
    return { key: raw, owner: undefined, review_by: undefined, legacy: true };
  }
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    typeof raw.key !== "string"
  ) {
    const err = new Error(
      `基线 known 条目非法（应为 { key: "相对路径\\t类型名", owner, review_by } 或旧格式字符串）：` +
        `${JSON.stringify(raw)}（${BASELINE_REL}）`,
    );
    err.structural = true;
    throw err;
  }
  if (!raw.key.includes("\t")) {
    const err = new Error(
      `基线 known 条目 key 非法（应为 "相对路径\\t类型名"）：${JSON.stringify(raw.key)}（${BASELINE_REL}）`,
    );
    err.structural = true;
    throw err;
  }
  return {
    key: raw.key,
    owner: raw.owner,
    review_by: raw.review_by,
    legacy: false,
  };
}

/**
 * 校验基线条目的**字段/期限**（共用件层）。
 *
 * 每条登记都必须有主有期限：`owner`（谁负责）+ `review_by`（什么时候复核）。
 * 缺任一 ⇒ 结构红（一条没主的登记等于没人看的白名单）；`review_by` 过期 ⇒ 红
 * （措辞「复核期限已过」，由 `scripts/lib/ratchet-baseline.mjs` 统一定义一次）。
 *
 * **旧格式字符串条目**（`legacy: true`）本来就缺 owner/review_by ⇒ 同一处
 * 判红，不叠加第二条（同一个问题报两遍会把真正的第一条淹掉）。
 *
 * @returns {{incomplete: string[], expired: string[]}}
 */
export function reviewBaselineEntries(baseline, { today = utcDay() } = {}) {
  const incomplete = [];
  const expired = [];
  for (const entry of baseline.knownEntries ?? []) {
    const at = `基线 known 条目 ${entry.key}`;
    const shape = compareEntry({
      at,
      noun: "登记",
      entry,
      rel: BASELINE_REL,
      label: "基线",
      requiredFields: ["owner", "review_by"],
      today,
    });
    if (shape.incomplete !== null) incomplete.push(shape.incomplete);
    if (shape.badDate !== null) incomplete.push(shape.badDate);
    if (shape.expired) {
      expired.push(renderExpired({ at, noun: "登记", entry, today }));
    }
  }
  for (const entry of baseline.allow ?? []) {
    const at = `基线 allowlist 条目 ${entry.key}`;
    const shape = compareEntry({
      at,
      noun: "豁免",
      entry,
      rel: BASELINE_REL,
      label: "基线",
      requiredFields: ["file", "name", "owner", "review_by"],
      today,
    });
    if (shape.incomplete !== null) incomplete.push(shape.incomplete);
    if (shape.badDate !== null) incomplete.push(shape.badDate);
    if (shape.expired) {
      expired.push(renderExpired({ at, noun: "豁免", entry, today }));
    }
  }
  return { incomplete, expired };
}

// ── 汇总：结构判读（不可静态判读 ⇒ 结构红）──────────────────────────────────

/**
 * 采集全部事实源。任何一处**读不到**都记进 `problems`，由调用方判结构红。
 * `--report` 与 `run()` 共用它：报告里那句「手写类型 133 处」只有在事实源都在时才有主语。
 */
export function scanSurface(root) {
  const problems = [];
  const files = listApiFiles(root);
  if (files === null) {
    problems.push(`API 目录不存在或不可读：${API_DIR}`);
  }
  const generatedPath = join(root, GENERATED_REL);
  if (!existsSync(generatedPath)) problems.push(`生成物缺失：${GENERATED_REL}`);
  let generated = new Set();
  if (existsSync(generatedPath)) {
    generated = parseGeneratedSchemas(readFileSync(generatedPath, "utf8"));
    if (generated.size < MIN_GENERATED_SCHEMAS) {
      problems.push(
        `生成物 schemas 只解析出 ${generated.size} 个（下界 ${MIN_GENERATED_SCHEMAS}）：` +
          `${GENERATED_REL} 的 components['schemas'] 解析器瞎了，或生成物被清空`,
      );
    }
  }
  let decls = null;
  if (files !== null) {
    decls = scanApiDeclarations(root);
    if (files.length < MIN_API_FILES) {
      problems.push(
        `api 目录只扫到 ${files.length} 个 .ts 文件（下界 ${MIN_API_FILES}）：扫描面塌方`,
      );
    }
    if (decls.length < MIN_DECLARATIONS) {
      problems.push(
        `只扫到 ${decls.length} 处顶层类型声明（下界 ${MIN_DECLARATIONS}）：判据瞎了` +
          `（扫到 0 处不是「没有漂移」，是「一处都没看」）`,
      );
    }
  }
  let baseline = null;
  try {
    baseline = loadBaseline(root);
  } catch (e) {
    problems.push(String(e.message ?? e));
  }
  return { files, decls, generated, baseline, problems };
}

/** 棘轮差值：新增 / 基线陈旧 / 豁免失效 / 重复登记 / 缺理由。 */
export function ratchet(surface) {
  const decls = surface.decls ?? [];
  const baseline = surface.baseline;
  const hand = decls.filter((d) => d.bucket === "handwritten");
  const handKeys = new Set(hand.map(keyOf));
  const known = new Set(baseline ? baseline.known : []);
  const allow = new Map((baseline?.allow ?? []).map((a) => [a.key, a]));

  const added = hand.filter((d) => !known.has(keyOf(d)) && !allow.has(keyOf(d)));
  const stale = (baseline?.known ?? []).filter((k) => !handKeys.has(k));
  const deadAllow = (baseline?.allow ?? []).filter((a) => !handKeys.has(a.key));
  const dup = baseline?.dupKnown ?? [];
  const badAllow = baseline?.badAllow ?? [];
  return { hand, added, stale, deadAllow, dup, badAllow };
}

// ── 输出 ─────────────────────────────────────────────────────────────────────

const byFile = (list) => {
  const map = new Map();
  for (const d of list) {
    if (!map.has(d.file)) map.set(d.file, []);
    map.get(d.file).push(d);
  }
  return map;
};

/** 手写名与生成物同名（剥 `Dto/ResponseDto/Response` 后比对）——只报现状，不判红。 */
export function sameAsGenerated(hand, generated) {
  const out = [];
  for (const d of hand) {
    const candidates = [d.name, `${d.name}Dto`, `${d.name}ResponseDto`];
    const hit = candidates.find((c) => generated.has(c));
    if (hit) out.push({ ...d, schema: hit });
  }
  return out;
}

function printStructureProblems(problems) {
  console.error("✖ 结构红：判据不可静态判读，拒绝判绿（不是「没有漂移」）：");
  for (const p of problems) console.error(`  · ${p}`);
  console.error("  处置：先修事实源/扫描面（生成物、api 目录、基线文件），再谈棘轮。");
}

export function report(opts) {
  const root = opts.root ?? DEFAULT_ROOT;
  const surface = scanSurface(root);
  console.log("── WEB-TYPE-DRIFT 现状报告（只读；漂移不判红，结构问题照判）──");
  console.log(`仓库根：${root}`);
  console.log("");
  console.log("── 判据 ──");
  console.log(`扫描面：${API_DIR}/*.ts（非递归，排除 *.spec.ts/*.test.ts/*.d.ts）`);
  console.log("计数对象：第 0 列的 interface / type 声明（导出与否都算）");
  console.log(
    "排除：合同派生（components['schemas']）/ 字面量镜像（(typeof X)[number]）/ 嵌套辅助类型",
  );
  if (surface.problems.length > 0) {
    console.log("");
    printStructureProblems(surface.problems);
    return 1;
  }
  const { files, decls, generated, baseline } = surface;
  const r = ratchet(surface);
  const contract = decls.filter((d) => d.bucket === "contract");
  const mirror = decls.filter((d) => d.bucket === "mirror");
  const same = sameAsGenerated(r.hand, generated);

  console.log("");
  console.log("── 扫描面 ──");
  console.log(`api 文件：${files.length} 个`);
  console.log(`顶层类型声明：${decls.length} 处`);
  console.log(`生成物 components['schemas']：${generated.size} 个`);
  console.log("");
  console.log("── 分类 ──");
  console.log(`合同派生（components['schemas']）：${contract.length} 处`);
  console.log(`字面量镜像（(typeof X)[number]） ：${mirror.length} 处`);
  console.log(`棘轮面（手写类型，被冻结）        ：${r.hand.length} 处`);
  console.log("");
  console.log(`── 棘轮面明细（基线 ${baseline.known.length} + 豁免 ${baseline.allow.length}）──`);
  for (const [file, list] of byFile(r.hand)) {
    console.log(`  ${file}（${list.length}）`);
    console.log(`    ${list.map((d) => d.name).join(", ")}`);
  }
  console.log("");
  console.log("── 棘轮差值 ──");
  console.log(`新增（未被基线登记）：${r.added.length} 处`);
  for (const d of r.added) console.log(`  + ${keyOf(d)}`);
  console.log(`基线陈旧（已不存在，请收紧基线）：${r.stale.length} 处`);
  for (const k of r.stale) console.log(`  - ${k}`);
  console.log(`豁免失效（声明已删）：${r.deadAllow.length} 处`);
  for (const a of r.deadAllow) console.log(`  ! ${a.key}`);
  console.log("");
  console.log("── 与生成物同名（S3-C4 的迁移面读数；本守卫不据此判红）──");
  console.log(`同名读数：${same.length} 处 / 手写 ${r.hand.length} 处`);
  for (const d of same) console.log(`  ~ ${d.name} → components['schemas']['${d.schema}']`);
  console.log("");
  console.log("── 合同派生明细（合法形态）──");
  for (const [file, list] of byFile(contract)) {
    console.log(`  ${file}（${list.length}）：${list.map((d) => d.name).join(", ")}`);
  }
  console.log("");
  console.log("── 字面量镜像明细 ──");
  for (const d of mirror) console.log(`  ${keyOf(d)}`);
  return 0;
}

export function run(opts) {
  const root = opts.root ?? DEFAULT_ROOT;
  const surface = scanSurface(root);
  if (surface.problems.length > 0) {
    printStructureProblems(surface.problems);
    return 1;
  }
  const { baseline } = surface;

  // ── 2026-11-04：基线条目必须有主有期限（共用件层）────────────────────────
  // 缺 owner / 缺 review_by / review_by 非法 ⇒ **结构红**（一条没主的登记等于
  // 没人看的白名单）；review_by 过期 ⇒ 红（措辞「复核期限已过」，共用件定义一次）。
  // 这是本守卫**原先不存在**的判据：原先 known 只是一串字符串，登记可以无限期挂着。
  const review = reviewBaselineEntries(baseline);
  if (review.incomplete.length > 0) {
    printStructureProblems(review.incomplete);
    return 1;
  }
  if (review.expired.length > 0) {
    console.error("✖ WEB-TYPE-DRIFT：基线登记的复核期限已过：");
    for (const p of review.expired) console.error(`  ${p}`);
    console.error("  处置：复核后显式改 review_by（留下一次人为决策的痕迹），或把该条目删掉。");
    return 1;
  }

  const r = ratchet(surface);
  const failures = [];

  if (r.dup.length > 0) {
    failures.push(
      `基线重复登记 ${r.dup.length} 条（同一名字既在 known 又在 allowlist，或 known 内重复）：`,
      ...r.dup.map((k) => `  · ${k}`),
    );
  }
  if (r.badAllow.length > 0) {
    failures.push(
      `豁免缺理由 ${r.badAllow.length} 条（allowlist 的每一条都必须写清「为何不能来自 components['schemas']」）：`,
      ...r.badAllow.map((k) => `  · ${k}`),
    );
  }
  if (r.added.length > 0) {
    failures.push(
      `✖ 新增手写类型 ${r.added.length} 处（未被基线登记）——棘轮只减不增：`,
      ...r.added.map((d) => `  + ${keyOf(d)}`),
      "  处置（二选一）：",
      "    ① 改成合同派生：`type X = components['schemas']['XDto']`（推荐；这不算手写）；",
      `    ② 确实无对应 schema（视图模型）⇒ 在 ${BASELINE_REL} 的 allowlist 里带 reason 登记。`,
    );
  }
  if (r.stale.length > 0) {
    failures.push(
      `✖ 基线陈旧：${r.stale.length} 条已不存在，但仍留在基线里 —— 棘轮不收紧就会烂成豁免单：`,
      ...r.stale.map((k) => `  - ${k}`),
      `  处置：从 ${BASELINE_REL} 的 known 里删掉这些条目（收紧是好事，但必须落回基线）。`,
    );
  }
  if (r.deadAllow.length > 0) {
    failures.push(
      `✖ 豁免失效：${r.deadAllow.length} 条 allowlist 对应的声明已不存在 —— 死豁免必须删：`,
      ...r.deadAllow.map((a) => `  ! ${a.key}`),
    );
  }

  if (failures.length > 0) {
    console.error("✖ WEB-TYPE-DRIFT 未通过：");
    for (const line of failures) console.error(line);
    return 1;
  }

  const contract = (surface.decls ?? []).filter((d) => d.bucket === "contract").length;
  const mirror = (surface.decls ?? []).filter((d) => d.bucket === "mirror").length;
  console.log(
    `✔ WEB-TYPE-DRIFT 通过：手写类型 ${r.hand.length} 处（基线 ${baseline.known.length} + 豁免 ${baseline.allow.length}）` +
      `，合同派生 ${contract} 处，字面量镜像 ${mirror} 处，生成 schema ${surface.generated.size} 个。`,
  );
  return 0;
}

// ── selftest：用临时 fixture 树跑**真子进程**，断言退出码 + 报错文本 ──────────
//
// 纪律（第 4 轮守卫自检审计 T4）：selftest 必须把守卫当黑盒跑，否则「process.exit(1)
// 被删掉」「正则坏了」这类失效模式全在自检视野之外。故每条用例都是
// `runGuard(script, { args: ["--root", fixture.dir] })` + `expectExit`。
// 并且必须有**正例控制组**（完整树 ⇒ 绿），否则「守卫永远红」也能让全部负例通过。

/**
 * fixture 基线条目（2026-11-04 起是**结构化对象** `{key, owner, review_by}`）。
 *
 * 默认带上未过期的期限（2099-12-31）——测试里要的是「判据本身」的红绿，
 * 不是「期限」的红绿；期限的红绿由专门用例覆盖。
 */
function fixtureKnown(key) {
  return { key, owner: "arch-core", review_by: "2099-12-31" };
}

/** fixture 的 allowlist 条目（同样必须带 owner / review_by）。 */
function fixtureAllow(file, name, reason) {
  return { file, name, reason, owner: "arch-core", review_by: "2099-12-31" };
}

/** 造一棵「刚好高于下界」的最小仓库树；`mutate` 可在写盘前篡改文件表。 */
function fixtureRepo(mutate) {
  const files = {};
  // 下界：MIN_API_FILES=20 / MIN_DECLARATIONS=100 / MIN_GENERATED_SCHEMAS=120。
  const apiNames = [];
  for (let f = 0; f < 20; f++) {
    const body = [];
    for (let d = 0; d < 5; d++) {
      const name = `Filler${f}_${d}`;
      body.push(`export interface ${name} { id: string; }`);
      apiNames.push(`${API_DIR}/f${String(f).padStart(2, "0")}.ts\t${name}`);
    }
    files[`${API_DIR}/f${String(f).padStart(2, "0")}.ts`] = body.join("\n") + "\n";
  }
  files[`${API_DIR}/a.ts`] = [
    "const LOCAL = ['x', 'y'] as const;",
    "export type MirrorOne = (typeof LOCAL)[number];",
    "export type DerivedOne = components['schemas']['Schema0Dto'];",
    "export interface HandOne { id: string; }",
    "export interface Deeply { nested: { inner: string } }",
    "",
  ].join("\n");
  apiNames.push(`${API_DIR}/a.ts\tHandOne`, `${API_DIR}/a.ts\tDeeply`);
  const schemas = [];
  for (let s = 0; s < 150; s++) schemas.push(`        Schema${s}Dto: { a: string };`);
  files[GENERATED_REL] = [
    "export interface components {",
    "    schemas: {",
    ...schemas,
    "    };",
    "}",
    "",
  ].join("\n");
  files[BASELINE_REL] = {
    $comment: "fixture",
    known: [...apiNames].sort().map((k) => fixtureKnown(k)),
    allowlist: [],
  };
  if (mutate) mutate(files, { apiNames });
  return makeFixtureRepo(files, { prefix: "web-type-drift-" });
}

const SCRIPT = fileURLToPath(import.meta.url);

function runFixture(files, mutate, args = []) {
  const repo = fixtureRepo(mutate);
  try {
    return runGuard(SCRIPT, { args: ["--root", repo.dir, ...args] });
  } finally {
    repo.cleanup();
  }
}

export function selftest() {
  const cases = [
    {
      // 正例控制组：没有它，「守卫永远红」也能让所有负例通过。
      name: "① 正例控制组：完整树 ⇒ 绿（手写 102 处全部在基线内）",
      fn: () => {
        const r = runFixture(null, null);
        expectExit(r, {
          code: 0,
          contains: ["✔ WEB-TYPE-DRIFT 通过", "手写类型 102 处（基线 102 + 豁免 0）"],
          absent: ["结构红", "✖"],
          label: "正例控制组",
        });
      },
    },
    {
      name: "② 把基线改小（删一条）⇒ 该类型立即变成「新增」⇒ 红",
      fn: () => {
        const r = runFixture(null, (files, { apiNames }) => {
          files[BASELINE_REL].known = apiNames
            .filter((k) => !k.endsWith("Filler0_0"))
            .map((k) => fixtureKnown(k));
        });
        expectExit(r, {
          code: 1,
          contains: ["✖ 新增手写类型 1 处", "Filler0_0", "棘轮只减不增"],
          absent: ["结构红"],
          label: "基线改小",
        });
      },
    },
    {
      name: "③ 新增手写类型（无生成物对应）⇒ 红，并给出两条处置路径",
      fn: () => {
        const r = runFixture(null, (files) => {
          files[`${API_DIR}/a.ts`] += "export interface BrandNewView { x: number; }\n";
        });
        expectExit(r, {
          code: 1,
          contains: ["✖ 新增手写类型 1 处", "BrandNewView", "components['schemas']['XDto']", "reason"],
          label: "新增即红",
        });
      },
    },
    {
      name: "④ 新类型改成合同派生（components['schemas']）⇒ 绿（不冻结）",
      fn: () => {
        const r = runFixture(null, (files) => {
          files[`${API_DIR}/a.ts`] += "export type BrandNewView = components['schemas']['Schema1Dto'];\n";
        });
        expectExit(r, {
          code: 0,
          contains: ["✔ WEB-TYPE-DRIFT 通过", "合同派生 2 处"],
          label: "合同派生放行",
        });
      },
    },
    {
      name: "⑤ 新类型带理由进 allowlist ⇒ 绿（豁免通道活着）",
      fn: () => {
        const r = runFixture(null, (files) => {
          files[`${API_DIR}/a.ts`] += "export interface BrandNewView { x: number; }\n";
          files[BASELINE_REL].allowlist = [
            fixtureAllow(`${API_DIR}/a.ts`, "BrandNewView", "OpenAPI 无对应视图模型"),
          ];
        });
        expectExit(r, {
          code: 0,
          contains: ["✔ WEB-TYPE-DRIFT 通过", "基线 102 + 豁免 1"],
          label: "allowlist 放行",
        });
      },
    },
    {
      name: "⑥ allowlist 缺理由（空 reason）⇒ 红",
      fn: () => {
        const r = runFixture(null, (files) => {
          files[`${API_DIR}/a.ts`] += "export interface BrandNewView { x: number; }\n";
          files[BASELINE_REL].allowlist = [
            fixtureAllow(`${API_DIR}/a.ts`, "BrandNewView", "   "),
          ];
        });
        expectExit(r, {
          code: 1,
          contains: ["豁免缺理由 1 条", "BrandNewView"],
          label: "豁免必须带理由",
        });
      },
    },
    {
      name: "⑦ 基线陈旧（声明已删但条目还在）⇒ 红，要求收紧基线",
      fn: () => {
        const r = runFixture(null, (files) => {
          files[`${API_DIR}/f00.ts`] = files[`${API_DIR}/f00.ts`].replace(
            "export interface Filler0_0 { id: string; }",
            "",
          );
        });
        expectExit(r, {
          code: 1,
          contains: ["✖ 基线陈旧", "Filler0_0", "删掉这些条目"],
          label: "基线陈旧",
        });
      },
    },
    {
      name: "⑧ 豁免失效（allowlist 指向已删声明）⇒ 红",
      fn: () => {
        const r = runFixture(null, (files) => {
          files[`${API_DIR}/a.ts`] = files[`${API_DIR}/a.ts`].replace(
            "export interface Deeply { nested: { inner: string } }",
            "",
          );
          files[BASELINE_REL].known = files[BASELINE_REL].known.filter(
            (e) => !e.key.endsWith("Deeply"),
          );
          files[BASELINE_REL].allowlist = [
            fixtureAllow(`${API_DIR}/a.ts`, "Deeply", "曾经豁免过"),
          ];
        });
        expectExit(r, {
          code: 1,
          contains: ["✖ 豁免失效", "Deeply"],
          label: "死豁免必须删",
        });
      },
    },
    {
      // 结构红：解析不到事实源时**不许**打「手写类型 0 处，全部在基线内」这句没有宾语的真话。
      name: "⑨ api 目录缺失 ⇒ 结构红（不是绿）",
      fn: () => {
        const r = runFixture(null, (files) => {
          for (const k of Object.keys(files)) {
            if (k.startsWith(API_DIR + "/")) delete files[k];
          }
        });
        expectExit(r, {
          code: 1,
          contains: ["结构红", "API 目录不存在"],
          absent: ["✔ WEB-TYPE-DRIFT 通过"],
          label: "api 目录缺失",
        });
      },
    },
    {
      name: "⑩ 生成物缺失 ⇒ 结构红（不是绿）",
      fn: () => {
        const r = runFixture(null, (files) => {
          delete files[GENERATED_REL];
        });
        expectExit(r, {
          code: 1,
          contains: ["结构红", "生成物缺失"],
          absent: ["✔ WEB-TYPE-DRIFT 通过"],
          label: "生成物缺失",
        });
      },
    },
    {
      name: "⑪ 生成物在但 schemas 解析不出（0 个）⇒ 结构红（parser 瞎了）",
      fn: () => {
        const r = runFixture(null, (files) => {
          files[GENERATED_REL] = "export interface components { schemas: {}; }\n";
        });
        expectExit(r, {
          code: 1,
          contains: ["结构红", "只解析出 0 个"],
          label: "schemas 解析面塌方",
        });
      },
    },
    {
      name: "⑫ 基线文件缺失 ⇒ 结构红（棘轮没有参照物）",
      fn: () => {
        const r = runFixture(null, (files) => {
          delete files[BASELINE_REL];
        });
        expectExit(r, {
          code: 1,
          // 2026-11-04 接共用件：结构红措辞改为共用件口径（「读不到 <文件>」）。
          contains: ["结构红", "读不到", BASELINE_REL],
          label: "基线缺失",
        });
      },
    },
    {
      name: "⑬ 基线文件损坏（非法 JSON）⇒ 结构红且点名文件，不甩解析栈",
      fn: () => {
        const r = runFixture(null, (files) => {
          files[BASELINE_REL] = "{ not json";
        });
        expectExit(r, {
          code: 1,
          // 2026-11-04 接共用件：结构红措辞改为共用件口径（「<文件> 不可解析」）。
          contains: ["结构红", "不可解析", "web-type-drift-baseline.json"],
          absent: ["    at "],
          label: "坏基线",
        });
      },
    },
    {
      name: "⑭ 声明全被注释掉 ⇒ 扫到 0 处 ⇒ 结构红（判据瞎了）",
      fn: () => {
        const r = runFixture(null, (files) => {
          for (const k of Object.keys(files)) {
            if (k.startsWith(API_DIR + "/")) {
              files[k] = files[k]
                .split("\n")
                .map((l) => (l.startsWith("export") ? `// ${l}` : l))
                .join("\n");
            }
          }
        });
        expectExit(r, {
          code: 1,
          contains: ["结构红", "只扫到 0 处"],
          label: "扫到 0 处",
        });
      },
    },
    {
      name: "⑮ --report 在正例树上：打印现状、退出 0、不改文件",
      fn: () => {
        const repo = fixtureRepo(null);
        try {
          const r = runGuard(SCRIPT, { args: ["--root", repo.dir, "--report"] });
          expectExit(r, {
            code: 0,
            contains: [
              "棘轮面（手写类型，被冻结）        ：102 处",
              "同名读数：",
              "基线 102 + 豁免 0",
            ],
            absent: ["结构红"],
            label: "report 正例",
          });
        } finally {
          repo.cleanup();
        }
      },
    },
    {
      name: "⑯ --report 也判结构红（事实源缺失时不打「现状」）",
      fn: () => {
        const r = runFixture(
          null,
          (files) => {
            delete files[GENERATED_REL];
          },
          ["--report"],
        );
        expectExit(r, {
          code: 1,
          contains: ["结构红", "生成物缺失"],
          label: "report 结构红",
        });
      },
    },
    // ── 2026-11-04：基线条目必须有主有期限（共用件层新增判据）────────────
    {
      name: "⑰ known 条目缺 owner ⇒ 结构红（一条没主的登记 = 没人看的白名单）",
      fn: () => {
        const r = runFixture(null, (files) => {
          files[BASELINE_REL].known[0] = { key: files[BASELINE_REL].known[0].key };
        });
        expectExit(r, {
          code: 1,
          contains: ["结构红", "owner", "review_by"],
          label: "known 缺 owner",
        });
      },
    },
    {
      name: "⑱ known 条目 review_by 过期 ⇒ 红（复核期限已过）",
      fn: () => {
        const r = runFixture(null, (files) => {
          files[BASELINE_REL].known[0] = {
            ...files[BASELINE_REL].known[0],
            review_by: "2020-01-01",
          };
        });
        expectExit(r, {
          code: 1,
          contains: ["复核期限已过", "review_by"],
          absent: ["结构红"],
          label: "known 过期",
        });
      },
    },
    {
      name: "⑲ known 条目 review_by 不是合法日期 ⇒ 结构红",
      fn: () => {
        const r = runFixture(null, (files) => {
          files[BASELINE_REL].known[0] = {
            ...files[BASELINE_REL].known[0],
            review_by: "明年某天",
          };
        });
        expectExit(r, {
          code: 1,
          contains: ["结构红", "review_by"],
          label: "known 日期非法",
        });
      },
    },
    {
      name: "⑳ 旧格式字符串 known 条目 ⇒ 结构红（缺 owner/review_by ＝ 欠账）",
      fn: () => {
        const r = runFixture(null, (files, { apiNames }) => {
          files[BASELINE_REL].known = [...apiNames].sort();
        });
        expectExit(r, {
          code: 1,
          contains: ["结构红", "owner", "review_by"],
          label: "旧格式条目",
        });
      },
    },
    {
      name: "㉑ allowlist 条目缺 owner/review_by ⇒ 结构红（豁免也要有主有期限）",
      fn: () => {
        const r = runFixture(null, (files) => {
          files[`${API_DIR}/a.ts`] += "export interface BrandNewView { x: number; }\n";
          files[BASELINE_REL].allowlist = [
            { file: `${API_DIR}/a.ts`, name: "BrandNewView", reason: "OpenAPI 无对应视图模型" },
          ];
        });
        expectExit(r, {
          code: 1,
          contains: ["结构红", "owner", "review_by"],
          label: "allowlist 缺主",
        });
      },
    },
    {
      name: "㉒ allowlist 条目 review_by 过期 ⇒ 红（复核期限已过）",
      fn: () => {
        const r = runFixture(null, (files) => {
          files[`${API_DIR}/a.ts`] += "export interface BrandNewView { x: number; }\n";
          files[BASELINE_REL].allowlist = [
            {
              file: `${API_DIR}/a.ts`,
              name: "BrandNewView",
              reason: "OpenAPI 无对应视图模型",
              owner: "arch-core",
              review_by: "2020-01-01",
            },
          ];
        });
        expectExit(r, {
          code: 1,
          contains: ["复核期限已过"],
          absent: ["结构红"],
          label: "allowlist 过期",
        });
      },
    },
    {
      name: "㉓ 补齐 owner/review_by 后 ⇒ 绿（判据按内容判，不是无脑红）",
      fn: () => {
        const r = runFixture(null, (files, { apiNames }) => {
          // 旧格式（纯字符串）⇒ 结构红；同一条补齐 owner/review_by ⇒ 绿。
          files[BASELINE_REL].known = apiNames.map((k) => ({
            key: k,
            owner: "arch-core",
            review_by: "2099-12-31",
          }));
        });
        expectExit(r, {
          code: 0,
          contains: ["✔ WEB-TYPE-DRIFT 通过"],
          absent: ["结构红"],
          label: "补齐后转绿",
        });
      },
    },
  ];
  const failed = reportCases(cases, { title: "check-web-type-drift selftest" });
  if (failed > 0) process.exit(1);
}

/* ─────────────────────────── 入口 ─────────────────────────── */

function parseArgs(argv) {
  const opts = { root: DEFAULT_ROOT, report: false, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--selftest") opts.selftest = true;
    else if (a === "--report") opts.report = true;
    else if (a === "--root") opts.root = argv[++i] ?? "";
    else if (a.startsWith("--root=")) opts.root = a.slice("--root=".length);
  }
  if (!opts.root) {
    console.error("✖ --root 需要一个目录参数");
    process.exit(2);
  }
  return opts;
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selftest) selftest();
  else process.exit(opts.report ? report(opts) : run(opts));
}
