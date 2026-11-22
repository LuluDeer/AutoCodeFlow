#!/usr/bin/env node
/**
 * R287：**`in: query` 的 `required: true` 必须与运行期实现一致**守卫。
 *
 * ## 真问题（本轮实测取证，不是推测）
 *
 * `apps/admin-api/openapi.json` 里 **162 个 query 参数中有 36 个标了 `required: true`**，
 * 而绝大多数运行期**真的可选**：controller 里写的是 `@Query("page") page?: string`，
 * service 里 `page ? parseInt(page, 10) : undefined`，非法值安全回落、绝不 400。
 *
 * 根因在 Swagger 的推断规则：`@Query("name") x?: string` 这种**具名参数**会被
 * `@nestjs/swagger` 判成 `required: true`（它只读 `design:paramtypes` 的反射类型，
 * 拿不到「有没有 `?`」这个 TS 语法信息）；而 `@Query() dto: SomeDto` 取整个 DTO 时
 * 不会。于是**语法上可选、契约上必填**成为默认形态。
 *
 * 危害不是「文档不好看」，而是**契约承诺了运行期不存在的约束**：
 * 调用方少传一个 `page` 照样 200，照着 `openapi.json` 写的 SDK / 前端类型却要求必传；
 * 反过来，真有必填的端点（`/ai/media/{mediaId}/{fileName}` 的 `exp`/`sig`、
 * `/auth/oidc/callback` 的 `code`/`state`）混在同一批红色里，**没人能从生成物上分辨**。
 *
 * ## 为什么是判据而不是手工修 36 处
 *
 * 一刀切改成 `required: false` 会把 `exp`/`sig` 这类**真正必填**一起放松
 * （缺签名恒 403/410，放松后契约就是在教人「不传也对」）；而放着不管，
 * 这 36 处就继续静默存在，下一轮审计再从零数一遍。⇒ 把**分类**变成判据：
 *
 *   ① 扫 `openapi.json` 所有 `in: query` 且 `required: true` 的参数；
 *   ② 按 `operationId`（`Class_handler`）定位 controller 文件与 handler；
 *   ③ 在 handler **签名**里找 `@Query("<name>")` 绑定，读它的类型：
 *      · `x?: T` 或 `x: T | undefined` ⇒ **运行期可选**；
 *      · `x: T`（无 `?`、无 `| undefined`）⇒ **真必填**（静态已自证，绿）；
 *      · 定位不到 / 不是具名 `@Query` ⇒ **无法判定**（不许当绿）；
 *   ④ 「契约说必填 + 实现说可选」或「无法判定」⇒ **红并点名**
 *      `路径 + 方法 + 参数名 + controller 文件:行`，除非在显式清单里登记。
 *
 * ## 豁免清单 `scripts/query-param-required-allowlist.json`
 *
 * 每条 = 一处**有主的欠账或一次签字**，key 为 `"<METHOD> <path> :: <name>"`：
 *
 *   · `class: "semantic-required"`：签名类型虽可选，但**语义上必填**
 *     （缺值走 403/410 或失败重定向，不会 200）⇒ 契约没错，签字确认；
 *   · `class: "runtime-optional"`：确实可选，属于**待修欠账**
 *     （修法：controller 加 `@ApiQuery({ name, required: false })` 并重跑
 *     `npm run swagger:export`）；
 *   · `class: "undecidable"`：静态定位不到（DTO 绑定 / 动态分发），人工判定过。
 *
 * 纪律（与仓内其它登记表同款，全部 fail-closed）：
 *   · 缺 `reason` 或 `reason` 不足 `MIN_REASON`(12) 字 ⇒ 红（光秃秃的条目是关灯键）；
 *   · **陈旧条目**（登记了但此刻并不红）⇒ 红：修好必须回收，否则清单变成永久豁免；
 *   · 文件级 `owner` / `reviewBy`（`YYYY-MM-DD`）缺失或**已过期** ⇒ 红
 *     —— 「这张表该由谁在多长时间内复核一次」必须写在表上。
 *
 * 本守卫**不跑 `swagger:export`**（要真环境、会大改生成物）：它把 36 处变成
 * 「可见、有主、可回收」的欠账，生成物由主会话统一重导出后条目自然回收。
 *
 * ## 用法
 *
 *   node scripts/check-query-param-required.mjs              # 判据（CI / 守卫链）
 *   node scripts/check-query-param-required.mjs --report     # 人读三分类清单
 *   node scripts/check-query-param-required.mjs --root <dir> # 以 <dir> 为仓库根（夹具）
 *   node scripts/check-query-param-required.mjs --selftest   # 自检（真子进程 + 夹具）
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

// 覆盖计数行（判据④：守卫必须报出可解析的用例数，0 即红）。helper 名 `push`
// 与下面的用例注册函数逐字相同 —— 登记表 scripts/coverage-registry.json 里也是它。
printCoverageBanner(import.meta.url, "push");

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(dirname(HERE), "..");

/** 事实源与登记表（相对仓库根；`--root` 只改根，不改结构）。 */
export const OPENAPI_REL = "apps/admin-api/openapi.json";
export const SRC_REL = "apps/admin-api/src";
export const ALLOWLIST_REL = "scripts/query-param-required-allowlist.json";

/** 豁免理由的字面下限（与 check-size-caps 的 MIN_ALLOW_REASON 同口径）。 */
export const MIN_REASON = 12;
/**
 * 扫描面下界：query 参数总数低于此值即「扫描面塌方」。
 * 实测当前 162；取 100 是为了「openapi.json 被截断/结构变了」立刻红，
 * 而不把正常的增删卡住。
 */
export const MIN_QUERY_PARAMS = 100;

/** 三种执行分类（报文与 `--report` 的唯一词汇表）。 */
export const KIND = {
  required: "runtime-required",
  optional: "runtime-optional",
  undecidable: "undecidable",
};

const KIND_LABEL = {
  [KIND.required]: "真必填",
  [KIND.optional]: "实际可选",
  [KIND.undecidable]: "无法判定",
};

export const ALLOWED_CLASSES = new Set(["semantic-required", "runtime-optional", "undecidable"]);

const toPosix = (p) => p.split("\\").join("/");

export function allowlistKey(method, path, name) {
  return `${String(method).toUpperCase()} ${path} :: ${name}`;
}

function readJson(abs) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(abs, "utf8")) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function walkControllers(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name === "generated") continue;
      walkControllers(abs, out);
    } else if (entry.name.endsWith(".controller.ts")) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * 把注释**按字符替换成空格**（保留换行与总长度）。
 *
 * 为什么必须先遮住注释：① 注释里的 `(` / `)` 会让括号配平错位（`@Query("since")`
 * 上方那段 JSDoc 就把整个签名括歪了，实测 21 处被误判成「无法判定」）；
 * ② 参数声明里的注释会被误当成类型文本（`/** R279 … *\/ since?: string`）。
 * 长度不变 ⇒ 行号仍与源码逐行对齐，报错点名的 `file:line` 不改。
 */
export function maskComments(text) {
  const src = String(text ?? "");
  let out = "";
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === quote && src[i - 1] !== "\\") quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < src.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * 括号配平扫描：从 `from`（指向 `(`）返回配对的 `)` 下标。
 * 返回 -1 表示该片段未闭合（源码被截断/改写）⇒ 调用方按「无法判定」处理。
 */
function matchParen(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 按**顶层**分隔符切分（忽略括号/泛型/字符串里的分隔符）。 */
function splitTopLevel(text, sep = ",") {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth -= 1;
    else if (ch === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** 去掉一段参数声明里的装饰器（跳过其中可能嵌套的括号，如 `ParseIntPipe({…})`）。 */
function stripDecorators(piece) {
  let out = "";
  let i = 0;
  while (i < piece.length) {
    const at = piece.indexOf("@", i);
    if (at === -1) {
      out += piece.slice(i);
      break;
    }
    out += piece.slice(i, at);
    // `@Name(...)` 或裸 `@Name`
    let j = at + 1;
    while (j < piece.length && /[\w$.]/.test(piece[j])) j += 1;
    while (j < piece.length && /\s/.test(piece[j])) j += 1;
    if (piece[j] === "(") {
      const close = matchParen(piece, j);
      j = close === -1 ? piece.length : close + 1;
    }
    i = j;
  }
  return out;
}

/** 取一条装饰器调用里的**第一个字符串字面量**实参（`@Query("page")` → `page`）。 */
function decoratorFirstStringArg(piece, decorator) {
  const idx = piece.indexOf(`@${decorator}`);
  if (idx === -1) return null;
  const open = piece.indexOf("(", idx);
  if (open === -1) return null;
  const close = matchParen(piece, open);
  if (close === -1) return null;
  const args = piece.slice(open + 1, close);
  const m = args.match(/^\s*(["'`])([^"'`]+)\1/);
  return m ? m[2] : null;
}

/** 在 handler 签名里找 `@Query("<name>")` 绑定；返回分类与证据。 */
export function classifyQueryBinding(signatureBody, name) {
  const pieces = splitTopLevel(signatureBody);
  for (const piece of pieces) {
    const bound = decoratorFirstStringArg(piece, "Query");
    if (bound !== name) continue;
    const decl = stripDecorators(piece).trim().replace(/\s+/g, " ");
    const declMatch = decl.match(/^([\w$]+)\s*(\?)?\s*:/);
    if (!declMatch) {
      return {
        kind: KIND.undecidable,
        evidence: decl || piece.trim(),
        why: `@Query("${name}") 后面的声明形态认不出（不是 \`name: T\`）`,
      };
    }
    const optionalMark = Boolean(declMatch[2]);
    const unionUndefined = /\|\s*undefined\b/.test(decl);
    const kind = optionalMark || unionUndefined ? KIND.optional : KIND.required;
    return { kind, evidence: decl, why: optionalMark ? "签名写作 `?:`" : unionUndefined ? "签名写作 `| undefined`" : "签名是非可选类型" };
  }
  return null;
}

/**
 * 建类名 → 文件索引；并按 `operationId` 定位 handler。
 *
 * 返回 `{ file, rel, line, body }` 或 `null`（调用方按「无法判定」处理）。
 */
export function locateHandler(index, operationId) {
  const [className, handlerName] = String(operationId ?? "").split("_");
  if (!className || !handlerName) return null;
  const entry = index.get(className);
  if (!entry) return null;
  const text = entry.text;
  const classAt = text.search(new RegExp(`\\bclass\\s+${className}\\b`));
  if (classAt === -1) return null;
  // 只认「方法声明」形态：行首（可有 async/public/private/protected 前缀）紧跟 `name(`。
  // 不能用「第一次出现」：同名 token 会先在注释、`this.svc.findAll(`、`@Foo(list)` 里出现
  // ——原实现因此把 metrics/executor 一族全判成「定位不到 handler」。
  const re = new RegExp(
    `^[ \\t]*(?:(?:public|private|protected|static|async|override)\\s+)*${handlerName}\\s*(?:<[^>]*>)?\\s*\\(`,
    "gm",
  );
  re.lastIndex = classAt;
  const m = re.exec(text);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = matchParen(text, open);
  if (close === -1) return null;
  return {
    file: entry.file,
    rel: entry.rel,
    line: text.slice(0, open).split("\n").length,
    body: text.slice(open + 1, close),
  };

}

/** 扫描全部 controller，建 className → { file, rel, text }。 */
export function buildControllerIndex(root) {
  const index = new Map();
  for (const abs of walkControllers(join(root, SRC_REL))) {
    const text = readFileSync(abs, "utf8");
    const rel = toPosix(relative(root, abs));
    const masked = maskComments(text);
    for (const m of masked.matchAll(/(?:export\s+)?(?:default\s+)?class\s+([A-Za-z0-9_]+)/g)) {
      if (!index.has(m[1])) index.set(m[1], { file: abs, rel, text: masked });
    }
  }
  return index;
}

/** 从 openapi.json 抽出所有 `in: query` 参数（含 path 级 parameters）。 */
export function extractQueryParams(doc) {
  const rows = [];
  for (const [path, ops] of Object.entries(doc?.paths ?? {})) {
    if (!ops || typeof ops !== "object") continue;
    const shared = Array.isArray(ops.parameters) ? ops.parameters : [];
    for (const [method, op] of Object.entries(ops)) {
      if (!op || typeof op !== "object" || method === "parameters") continue;
      const params = [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])];
      for (const param of params) {
        if (!param || param.in !== "query") continue;
        rows.push({
          method: method.toUpperCase(),
          path,
          name: param.name,
          required: param.required === true,
          operationId: op.operationId,
        });
      }
    }
  }
  return rows;
}

/** 校验登记表本身（结构/理由/期限）；返回 { entries, errors, meta }。 */
export function validateAllowlist(raw, { today = new Date() } = {}) {
  const errors = [];
  const entries = new Map();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push(`${ALLOWLIST_REL} 必须是对象（含 owner / reviewBy / entries）`);
    return { entries, errors };
  }
  for (const field of ["owner", "reviewBy"]) {
    if (typeof raw[field] !== "string" || raw[field].trim() === "") {
      errors.push(`${ALLOWLIST_REL} 缺字段 ${field}（这张表该由谁负责 / 何时必须复核）`);
    }
  }
  if (typeof raw.reviewBy === "string") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.reviewBy)) {
      errors.push(`${ALLOWLIST_REL} 的 reviewBy 不是可解析的 YYYY-MM-DD：${raw.reviewBy}`);
    } else if (new Date(`${raw.reviewBy}T23:59:59Z`).getTime() < today.getTime()) {
      errors.push(`${ALLOWLIST_REL} 的 reviewBy 已过期（${raw.reviewBy}）——到点必须有人重新签字`);
    }
  }
  const table = raw.entries;
  if (!table || typeof table !== "object" || Array.isArray(table)) {
    errors.push(`${ALLOWLIST_REL} 缺 entries 对象`);
    return { entries, errors };
  }
  for (const [key, entry] of Object.entries(table)) {
    if (!/^[A-Z]+ \/\S* :: \S+$/.test(key)) {
      errors.push(`登记键格式非法（应为 "<METHOD> <path> :: <name>"）：${key}`);
      continue;
    }
    if (!entry || typeof entry !== "object") {
      errors.push(`登记条目必须是对象：${key}`);
      continue;
    }
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    if (reason.length < MIN_REASON) {
      errors.push(
        `登记条目理由不足 ${MIN_REASON} 字（当前 ${reason.length}）：${key} —— 光秃秃的条目不产生任何证据`,
      );
    }
    if (!ALLOWED_CLASSES.has(entry.class)) {
      errors.push(
        `登记条目 class 非法（只能 ${[...ALLOWED_CLASSES].join(" / ")}）：${key}（收到 ${JSON.stringify(entry.class)}）`,
      );
    }
    entries.set(key, { ...entry, reason });
  }
  return { entries, errors };
}

/**
 * 主判据。
 *
 * @returns {{errors: string[], warnings: string[], meta: object}}
 */
export function check({ root = REPO_ROOT, today = new Date() } = {}) {
  const errors = [];
  const warnings = [];
  const facts = [];

  // ── 事实源 ────────────────────────────────────────────────
  const openapiAbs = join(root, OPENAPI_REL);
  if (!existsSync(openapiAbs)) {
    return { errors: [`读不到事实源 ${OPENAPI_REL} —— 没有它就没有判据（不是「没问题」）`], warnings, facts, meta: {} };
  }
  const doc = readJson(openapiAbs);
  if (!doc.ok) {
    return { errors: [`${OPENAPI_REL} 不是合法 JSON：${doc.reason}`], warnings, facts, meta: {} };
  }
  const rows = extractQueryParams(doc.value);
  if (rows.length < MIN_QUERY_PARAMS) {
    return {
      errors: [
        `扫描面塌方：只解析到 ${rows.length} 个 query 参数（下界 ${MIN_QUERY_PARAMS}）——` +
          `候选多半是 openapi.json 被截断/结构变了。此前的实测规模是 162。`,
      ],
      warnings,
      facts,
      meta: { scanned: rows.length },
    };
  }

  // ── 登记表 ────────────────────────────────────────────────
  const allowAbs = join(root, ALLOWLIST_REL);
  if (!existsSync(allowAbs)) {
    errors.push(`读不到登记表 ${ALLOWLIST_REL} —— 豁免必须显式，缺表即结构红`);
  }
  const allowRaw = existsSync(allowAbs) ? readJson(allowAbs) : { ok: false, reason: "文件不存在" };
  if (existsSync(allowAbs) && !allowRaw.ok) {
    errors.push(`${ALLOWLIST_REL} 不是合法 JSON：${allowRaw.reason}`);
  }
  const { entries, errors: allowErrors } = validateAllowlist(allowRaw.ok ? allowRaw.value : null, { today });
  errors.push(...allowErrors);

  // ── 逐个判定 ──────────────────────────────────────────────
  const index = buildControllerIndex(root);
  if (index.size === 0) {
    errors.push(`扫描面塌方：${SRC_REL} 下一个 *.controller.ts 都没找到 —— 判据无法定位实现`);
  }

  const seen = new Set();
  const counts = { total: 0, required: 0, flagged: 0, allowlisted: 0 };
  for (const row of rows) {
    if (!row.required) continue;
    counts.required += 1;
    const key = allowlistKey(row.method, row.path, row.name);
    let kind = KIND.undecidable;
    let where = "（未定位）";
    let evidence = "";
    let why = "";

    const located = row.operationId ? locateHandler(index, row.operationId) : null;
    if (!row.operationId) {
      why = "openapi.json 里该 operation 没有 operationId";
    } else if (!located) {
      why = `按 operationId=${row.operationId} 定位不到 handler`;
    } else {
      where = `${located.rel}:${located.line}`;
      const binding = classifyQueryBinding(located.body, row.name);
      if (!binding) {
        why = `handler 签名里没有 @Query("${row.name}") —— 可能走 @Query() DTO / @Req 原始 query`;
      } else {
        kind = binding.kind;
        evidence = binding.evidence;
        why = binding.why;
      }
    }

    const entry = entries.get(key);
    if (entry) seen.add(key);
    counts.total += 1;

    if (kind === KIND.required) {
      // 静态即自证：契约说必填，实现也确实必填。
      if (entry) {
        errors.push(
          `陈旧登记：${key} 已不需豁免（签名 ${evidence || "?"} 是非可选类型，静态已自证必填）——请从 ${ALLOWLIST_REL} 回收`,
        );
      }
      facts.push({ key, kind, where, evidence });
      continue;
    }

    if (entry) {
      counts.allowlisted += 1;
      const semantic = entry.class === "semantic-required";
      facts.push({ key, kind, semantic, allowlisted: true, entry, where, evidence });
      continue;
    }

    counts.flagged += 1;
    errors.push(
      `${key} —— 契约 \`required: true\`，但实现是${KIND_LABEL[kind]}` +
        `（${why}${evidence ? `：\`${evidence}\`` : ""}）` +
        (where === "（未定位）" ? "" : ` ⇒ ${where}`) +
        `。⇒ 要么改实现（真必填），要么在 ${ALLOWLIST_REL} 登记 ${key} 并给 ≥${MIN_REASON} 字理由`,
    );
    facts.push({ key, kind, where, evidence, why, flagged: true });
  }

  // ── 陈旧条目（棘轮：修好必须回收） ────────────────────────
  for (const key of entries.keys()) {
    if (seen.has(key)) continue;
    errors.push(
      `陈旧登记：${key} 已不在「契约必填」清单里（参数被删/改成可选/路径改了）——` +
        `豁免必须回收，否则 ${ALLOWLIST_REL} 退化成永久关灯键`,
    );
  }

  const byKind = { [KIND.required]: 0, [KIND.optional]: 0, [KIND.undecidable]: 0 };
  for (const fact of facts) {
    // 「真必填」= 静态自证（签名非可选）**或**登记为语义必填（缺值恒拒绝，不会 200）
    if (fact.kind === KIND.required || fact.semantic) byKind[KIND.required] += 1;
    else if (fact.kind === KIND.optional) byKind[KIND.optional] += 1;
    else byKind[KIND.undecidable] += 1;
  }

  return {
    errors,
    warnings,
    facts,
    meta: { scanned: rows.length, ...counts, entries: entries.size, byKind },
  };
}

function printReport(meta, facts) {
  const bucket = { [KIND.required]: [], [KIND.optional]: [], [KIND.undecidable]: [] };
  for (const fact of facts) {
    const slot = fact.semantic ? KIND.required : fact.kind;
    (bucket[slot] ?? bucket[KIND.undecidable]).push(fact);
  }
  console.log(
    `契约必填的 query 参数 ${meta.total ?? 0} 处 —— 真必填 ${bucket[KIND.required].length} / ` +
      `实际可选 ${bucket[KIND.optional].length} / 无法判定 ${bucket[KIND.undecidable].length}` +
      `（已登记 ${meta.allowlisted ?? 0} 条 / 登记表共 ${meta.entries ?? 0} 条）`,
  );
  for (const kind of [KIND.required, KIND.optional, KIND.undecidable]) {
    console.log(`\n── ${KIND_LABEL[kind]}（${bucket[kind].length}）──`);
    for (const fact of bucket[kind]) {
      const tail = fact.allowlisted
        ? `[登记 ${fact.entry.class}]`
        : fact.flagged
          ? "[红·未登记]"
          : "[静态自证]";
      console.log(`  · ${fact.key}  \`${fact.evidence || fact.why || "?"}\`  ${fact.where}  ${tail}`);
    }
  }
}

// ── 自检 ────────────────────────────────────────────────────

const FIXTURE_OPENAPI = (params, { operationId = "FixturesController_list", path = "/fixtures", method = "get" } = {}) => ({
  openapi: "3.0.0",
  paths: {
    [path]: {
      [method]: {
        operationId,
        parameters: params.map((p) =>
          typeof p === "string"
            ? { name: p, in: "query", required: true, schema: { type: "string" } }
            : { in: "query", schema: { type: "string" }, ...p },
        ),
      },
    },
  },
});

const FIXTURE_ALLOW = (entries = {}, extra = {}) => ({
  owner: "arch-core",
  reviewBy: "2099-12-31",
  entries,
  ...extra,
});

const fixtureController = (paramsLiteral) =>
  `import { Controller, Get, Query } from "@nestjs/common";\n\n@Controller("fixtures")\nexport class FixturesController {\n  @Get()\n  async list(\n${paramsLiteral}\n  ) {\n    return [];\n  }\n}\n`;

/** 造一个「满足扫描面下界」的夹具：N 个无关 query 参数 + 被测参数。 */
function fixtureRepo({ openapi, controller, allow, skipAllow = false, skipOpenapi = false } = {}) {
  const files = {
    "apps/admin-api/src/modules/fixtures/fixtures.controller.ts":
      controller ?? fixtureController('    @Query("page") page?: string,'),
  };
  if (!skipOpenapi) files[OPENAPI_REL] = JSON.stringify(openapi, null, 2);
  if (!skipAllow && allow !== null) files[ALLOWLIST_REL] = JSON.stringify(allow ?? FIXTURE_ALLOW(), null, 2);
  return makeFixtureRepo(files);
}

/** 给 openapi 补足到 `MIN_QUERY_PARAMS` 个合法（required:false）参数。 */
function padToFloor(openapi, n = MIN_QUERY_PARAMS + 5) {
  const params = openapi.paths["/fixtures"].get.parameters;
  let i = 0;
  // 注意：条件是 `params.length < n`，不是 `params.length + i < n`——后者一次推两个
  // 计数 ⇒ 只造出一半参数（夹具自己踩过：105 下界只造出 53 个，十一个用例集体误红）。
  while (params.length < n) {
    params.push({ name: `pad${i}`, in: "query", required: false, schema: { type: "string" } });
    i += 1;
  }
  return openapi;
}

function runSelftest() {
  const cases = [];
  const push = (name, fn) => cases.push({ name, fn });

  push("正例对照组：契约必填 + 签名非可选 ⇒ exit 0（不该报红）", () => {
    const repo = fixtureRepo({
      openapi: padToFloor(FIXTURE_OPENAPI(["id"])),
      controller: fixtureController("    @Query(\"id\") id: string,"),
    });
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), { code: 0, withinMs: 20000, label: "正例" });
    } finally {
      repo.cleanup();
    }
  });

  push("反例①：契约必填 + 签名 `?:` ⇒ exit 1 并点名 path+method+param+file:line", () => {
    const repo = fixtureRepo({ openapi: padToFloor(FIXTURE_OPENAPI(["page"])) });
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1,
        contains: ["GET /fixtures :: page", "契约 `required: true`", "实际可选", "fixtures.controller.ts:6"],
        withinMs: 20000,
        label: "反例①",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例②：签名写 `| undefined`（exp/sig 形态）同样红", () => {
    const repo = fixtureRepo({
      openapi: padToFloor(FIXTURE_OPENAPI(["sig"])),
      controller: fixtureController("    @Query(\"sig\") sig: string | undefined,"),
    });
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1,
        contains: ["GET /fixtures :: sig", "| undefined", "实际可选"],
        withinMs: 20000,
        label: "反例②",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例③：走 `@Query()` DTO（无具名绑定）⇒ 无法判定，不许当绿", () => {
    const repo = fixtureRepo({
      openapi: padToFloor(FIXTURE_OPENAPI(["page"])),
      controller: fixtureController("    @Query() dto: Record<string, string>,"),
    });
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1,
        contains: ["GET /fixtures :: page", "无法判定", "没有 @Query(\"page\")"],
        withinMs: 20000,
        label: "反例③",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例④：operationId 指向不存在的 handler ⇒ 无法判定并点名 operationId", () => {
    const repo = fixtureRepo({
      openapi: padToFloor(FIXTURE_OPENAPI(["page"], { operationId: "GhostController_list" })),
    });
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1,
        contains: ["无法判定", "GhostController_list"],
        withinMs: 20000,
        label: "反例④",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("正例②：登记 `class: semantic-required` + 理由 ⇒ exit 0 且打印登记分类", () => {
    const repo = fixtureRepo({
      openapi: padToFloor(FIXTURE_OPENAPI(["sig"])),
      controller: fixtureController("    @Query(\"sig\") sig: string | undefined,"),
      allow: FIXTURE_ALLOW({
        "GET /fixtures :: sig": {
          class: "semantic-required",
          reason: "缺 sig 由 verifySignedMediaUrl 恒 403，契约必填语义成立",
        },
      }),
    });
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`, "--report"] }), {
        code: 0,
        contains: ["真必填", "[登记 semantic-required]"],
        withinMs: 20000,
        label: "正例②",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例⑤：登记理由为空 ⇒ exit 1（光秃秃的条目 = 关灯键）", () => {
    const repo = fixtureRepo({
      openapi: padToFloor(FIXTURE_OPENAPI(["page"])),
      allow: FIXTURE_ALLOW({ "GET /fixtures :: page": { class: "runtime-optional", reason: "" } }),
    });
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1,
        contains: ["理由不足 12 字"],
        withinMs: 20000,
        label: "反例⑤",
      });
    } finally {
      repo.cleanup();
    }
  });

  push(`反例⑥：理由短于 ${MIN_REASON} 字 ⇒ exit 1`, () => {
    const repo = fixtureRepo({
      openapi: padToFloor(FIXTURE_OPENAPI(["page"])),
      allow: FIXTURE_ALLOW({ "GET /fixtures :: page": { class: "runtime-optional", reason: "待修" } }),
    });
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1,
        contains: ["理由不足 12 字"],
        withinMs: 20000,
        label: "反例⑥",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例⑦：陈旧登记（该参数已不红）⇒ exit 1（棘轮：修好必须回收）", () => {
    const repo = fixtureRepo({
      openapi: padToFloor(FIXTURE_OPENAPI(["id"])),
      controller: fixtureController("    @Query(\"id\") id: string,"),
      allow: FIXTURE_ALLOW({
        "GET /fixtures :: id": { class: "runtime-optional", reason: "这条应该已经被回收（修好之后必须删）" },
      }),
    });
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1,
        contains: ["陈旧登记", "GET /fixtures :: id"],
        withinMs: 20000,
        label: "反例⑦",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例⑧：登记 class 非法 ⇒ exit 1", () => {
    const repo = fixtureRepo({
      openapi: padToFloor(FIXTURE_OPENAPI(["page"])),
      allow: FIXTURE_ALLOW({ "GET /fixtures :: page": { class: "whatever", reason: "长度够但分类非法的登记条目" } }),
    });
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1,
        contains: ["class 非法"],
        withinMs: 20000,
        label: "反例⑧",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("结构红①：openapi.json 缺失 ⇒ exit 1（不抛 node 栈）", () => {
    const repo = fixtureRepo({ skipOpenapi: true });
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1,
        contains: ["读不到事实源", OPENAPI_REL],
        absent: ["at Object."],
        withinMs: 20000,
        label: "结构红①",
      });
    } finally {
      repo.cleanup();
    }
  });

  push(`结构红②：扫描面塌方（query 参数 < ${MIN_QUERY_PARAMS}）⇒ exit 1，不许当「0 条 = 通过」`, () => {
    const repo = fixtureRepo({ openapi: FIXTURE_OPENAPI(["page"]) });
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1,
        contains: ["扫描面塌方"],
        withinMs: 20000,
        label: "结构红②",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("结构红③：登记表缺失 / 坏 JSON / 缺 owner 或 reviewBy ⇒ exit 1", () => {
    const bad = [
      fixtureRepo({ openapi: padToFloor(FIXTURE_OPENAPI(["page"])), allow: null }),
      fixtureRepo({ openapi: padToFloor(FIXTURE_OPENAPI(["page"])), allow: FIXTURE_ALLOW({}, { owner: "" }) }),
      fixtureRepo({ openapi: padToFloor(FIXTURE_OPENAPI(["page"])), allow: FIXTURE_ALLOW({}, { reviewBy: "2000-01-01" }) }),
    ];
    try {
      expectExit(runGuard(HERE, { args: [`--root=${bad[0].dir}`] }), {
        code: 1,
        contains: ["读不到登记表"],
        withinMs: 20000,
        label: "结构红③-a",
      });
      expectExit(runGuard(HERE, { args: [`--root=${bad[1].dir}`] }), {
        code: 1,
        contains: ["缺字段 owner"],
        withinMs: 20000,
        label: "结构红③-b",
      });
      expectExit(runGuard(HERE, { args: [`--root=${bad[2].dir}`] }), {
        code: 1,
        contains: ["reviewBy 已过期"],
        withinMs: 20000,
        label: "结构红③-c",
      });
    } finally {
      bad.forEach((r) => r.cleanup());
    }
  });

  push("真仓库对照组：随仓库交付的登记表与该 openapi.json 必须自洽 ⇒ exit 0", () => {
    expectExit(runGuard(HERE, { args: [] }), { code: 0, withinMs: 20000, label: "真仓库对照组" });
  });

  const failed = reportCases(cases, { title: "check-query-param-required selftest" });
  process.exit(failed === 0 ? 0 : 1);
}

function main(argv) {
  if (argv.includes("--selftest")) return runSelftest();
  // 两种写法都认：`--root <dir>` 与 `--root=<dir>`（夹具里两种都会被用到；
  // 只认一种会让 selftest 静默跑真仓库 —— 那是「夹具绿、判据没被执行」的假绿）。
  const eqForm = argv.find((a) => a.startsWith("--root="));
  const at = argv.indexOf("--root");
  let root = REPO_ROOT;
  if (at !== -1 || eqForm) {
    const value = eqForm ? eqForm.slice("--root=".length) : argv[at + 1];
    if (!value) {
      console.error("✘ --root 需要一个目录参数");
      return 2;
    }
    root = resolve(value);
    if (!existsSync(root)) {
      console.error(`✘ --root 指向的目录不存在：${root}`);
      return 2;
    }
  }
  const result = check({ root });
  if (argv.includes("--report")) printReport(result.meta, result.facts);
  if (result.errors.length === 0) {
    const m = result.meta;
    const byKind = m.byKind ?? {};
    console.log(
      `✔ query 参数必填契约一致：${m.scanned ?? 0} 个 query 参数中 ${m.required ?? 0} 个标 required:true — ` +
        `真必填 ${byKind[KIND.required] ?? 0} / 实际可选 ${byKind[KIND.optional] ?? 0} / 无法判定 ${byKind[KIND.undecidable] ?? 0}；` +
        `未登记的账 0 条，登记表 ${m.entries ?? 0} 条全部有理由且未陈旧。`,
    );
    return 0;
  }
  console.error(`✘ query 参数必填契约不一致：${result.errors.length} 项`);
  for (const err of result.errors) console.error(`   · ${err}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) {
  process.exit(main(process.argv.slice(2)));
}
