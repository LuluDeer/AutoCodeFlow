#!/usr/bin/env node
/**
 * ADR-026 静态守卫：**状态写必须条件化**的「只减不增」棘轮。
 *
 * 背景（ADR-026）：本仓反复出现同一类缺陷——一次状态写入只带 `WHERE id`，
 * 并发或长窗口下把别人刚写完的状态按旧快照盖回去（已吊销 token 复活、禁用失效、
 * 改密被撤销、已成功的部署被回滚成失败、SOP 终态被改回）。这类缺陷**在测试里永远绿**
 * （单线程无并发时两种写法行为相同），只能靠纪律与守卫拦。
 *
 * ## 判据（四类，全部有牙；第 4 轮测试质量审计 T2 扩面）
 *
 *   A. **`.update({ id }, …)` 单键**（原有判据，红）
 *      where 对象的顶层键恰为 `['id']`。这类调用没有任何前置断言。
 *
 *   B. **`createQueryBuilder().update(X).set({…})…where(…)` 链**（新增，红/黄两级）
 *      链路里**所有** where/andWhere/orWhere 的谓词文本都不含状态列、也没有
 *      `IS [NOT] NULL` / `IS NOT DISTINCT FROM` 这类条件，且 `.set({…})` 里被写的列
 *      含**终态类列** → 红；只含**租约/计数器类列** → warn（见下面两张常量表）。
 *      这是审计实测的形态 ①（第 4 轮 §2.7：真实仓库 46 个 createQueryBuilder 站点
 *      此前 0 命中）。
 *
 *   C. **裸 SQL `UPDATE <t> … SET …`**（新增，红/warn）
 *      字符串字面量（含模板串）里出现 `UPDATE … SET`，而该语句的**谓词部分**（CTE 前缀 +
 *      SET 子句之后的 WHERE/RETURNING 之后文本）没有状态谓词：
 *        · SET 里赋的是终态类列 → **红**（`UPDATE tasks SET status='failed' WHERE id=$1`
 *          就是 ADR-026 表格里"部署被回滚成失败"那条的 SQL 形态）；
 *        · SET 只碰非状态列（计数器自增等） → warn。
 *      **迁移目录豁免**（`apps/admin-api/src/migrations/**`）：迁移里的无条件 UPDATE 是
 *      数据回填/DDL 的正当用法，不该被本闸拦（审计形态 ⑥）。
 *
 *   D. **整行回写 `repo.save(<裸标识符>)`**（原有「仅报告」升级为**基线棘轮**）
 *      `save` 同时也是创建路径的写法，语法上无法区分「插入」与「陈旧快照回写」，所以
 *      **不逐条判红**，而是把命中数纳入基线：超过基线才红（只减不增），基线内只打印摘要。
 *      这修掉了审计指出的「`--report-saves` 不在 CI ⇒ 整行回写这条线索完全没进闸」。
 *
 * ## 状态类列的来源（不是拍脑袋列的）
 *
 * 两张表都从 `apps/admin-api/src/**\/*.entity.ts` 的实体列里抄出来，**取列名不取类型**：
 * 只有"这一列的值本身就是状态/生命周期语义"才入表。新增实体列时按同口径补。
 *
 *   终态/生命周期列（写这些必须条件化）：status（task / task-execution / executor /
 *   executor-package / application / app-deployment / sop / sop-assignment / agent-session /
 *   agent-approval / agent-tool-call / ai-sop-session）、approvalStatus（app-deployment）、
 *   rolloutState（app-deployment）、finishedAt / startedAt（agent-session）、deployedAt /
 *   lastHeartbeat（app-deployment）、isActive / sessionVersion（user）、revoked（refresh token）、
 *   revokedAt（api-key）、deadLettered（event-outbox）、enabled。
 *
 *   租约/计数器列（无条件写常见且多为刻意，只 warn 不红）：leaseUntil / leaseToken /
 *   dispatchedAt（event-outbox）、pulledAt / attempt（sop-assignment）、turnLockedAt
 *   （ai-sop-session）、lockedUntil（user）、lastTriggerTime（task）、attempts（outbox-dead-letter）、
 *   version、updatedAt。
 *
 * ## 为什么用「只减不增 + 基线」而不是「一律为 0」
 *
 * 存量里仍有大量合法调用（例如该表根本没有并发写者、或写的是与状态无关的列）。要求一次性
 * 清零不现实，会逼出「改成两个单键更新」这类假修。基线把方向定死：**新代码不许再增加**，
 * 改到一处就降一处（`scripts/conditional-writes-baseline.json`，与
 * `check-user-facing-language.mjs` / `check-metric-docs.mjs` 同款棘轮）。
 *
 * ## 已知盲区（**必须知道**，否则会误以为「守卫绿 = 没有状态写缺陷」）
 *
 *   ① 整行回写只做**计数棘轮**，不逐条判定（见判据 D）。
 *   ② 多键但无状态谓词的 `repo.update({ id, name }, patch)`（TypeORM Repository.update 的
 *      where 形态）仍是盲区：它的 where 不是对象字面量时判据 A 不命中。判据 B 只覆盖
 *      queryBuilder 链。审计实测这一形态 0 命中，属**剩余**盲区（保守选择：误红代价更高）。
 *   ③ 首参不是对象字面量 / 被赋给变量后分离调用的链（`qb = repo.createQueryBuilder();
 *      …; qb.update(X)…`）可能漏判——判据 B 会向前找同名变量的 `createQueryBuilder` 赋值，
 *      但跨函数传递仍看不见。
 *   ④ `.set(patch)`（非字面量）看不到被写列 ⇒ 一律放行（宁可漏，不误红）。
 *   ⑤ 事务内先 `findOne(…, { lock: "pessimistic_write" })` 再按 id 写：本守卫**看不见行锁**，
 *      这类（读后写窗口已被锁关闭）没有状态谓词也会被判红/黄——请加
 *      `adr-026-exempt: <理由>`（ADR-026 认可行锁，见附录判定口径第 2 问）。
 *   ⑥ 拼接出来的 SQL（`query("UPDATE " + t + " SET …")`）看不见：本守卫只在**同一个字面量**
 *      里找 `UPDATE … SET`。这类须靠评审。
 *
 * **绿不等于没有这类缺陷——只等于这几类没有新增。**
 *
 * 用法：
 *   node scripts/check-conditional-writes.mjs                # 守卫（CI）
 *   node scripts/check-conditional-writes.mjs --report        # 列全部命中 + 基线对照
 *   node scripts/check-conditional-writes.mjs --report-saves  # 只列整行 save 候选（免判据红，**不免结构红**）
 *   node scripts/check-conditional-writes.mjs --selftest      # 判据有牙（43 条：27 函数级 + 15 子进程级 + 1 根解析）
 *   node scripts/check-conditional-writes.mjs --root <dir>    # 以 <dir> 为仓库根（selftest/反证用）
 *   node scripts/check-conditional-writes.mjs --root=<dir>    # 同上（等号形态，两种都认）
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_ROOT, expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

const SELF = fileURLToPath(import.meta.url);
/**
 * 缺省根 = **仓库根**（按本脚本位置锚定），不是 `process.cwd()`。
 *
 * 曾经是 `process.cwd()`：从 `apps/` 之类子目录跑（或任何 cwd ≠ 仓库根的调用面）
 * 时 `walk(<cwd>/apps/admin-api/src)` 直接空转 —— 判据模式下靠「扫不到文件」侥幸红，
 * 但 `--report-saves` 会打印「整行 save 0 处」然后 exit 0：**报告在说话，闸不关门**。
 * 与另外 40 多个守卫的 `DEFAULT_ROOT = resolve(import.meta.dirname, "..")` 对齐。
 */
const DEFAULT_ROOT = REPO_ROOT;

/**
 * 规模下界：真实仓库的 `src/modules` 下有 100+ 个非测试 TS。
 * 扫描面收窄（目录改名/正则失效）不能静默变成「零命中全绿」。
 */
const MIN_SCANNED_FILES = 100;

/** 扫描面：`apps/admin-api/src` 下的非测试 TS（判据 A/B/D 只落在 `modules/` 内）。 */
const SRC_DIR = join("apps", "admin-api", "src");
const MODULES_DIR = join(SRC_DIR, "modules");
const MODULES_PREFIX = MODULES_DIR.split(sep).join("/") + "/";
/** 迁移目录：**整体豁免**（判据 C 显式跳过；审计形态 ⑥：迁移里的无条件 UPDATE 是正当用法）。 */
const MIGRATIONS_PREFIX = join(SRC_DIR, "migrations").split(sep).join("/") + "/";
const BASELINE_REL = join("scripts", "conditional-writes-baseline.json");

/** 豁免标记：在调用的前 5 行内出现该注释即跳过（必须写理由）。 */
const EXEMPT_MARKER = "adr-026-exempt";

/**
 * 终态/生命周期列（**红**）。来源见文件头「状态类列的来源」——逐个对应实体列。
 */
const TERMINAL_STATE_COLUMNS = [
  "status", // task / task-execution / executor / executor-package / application / app-deployment / sop / sop-assignment / agent-session / agent-approval / agent-tool-call / ai-sop-session
  "state", // 约定列名（当前实体未用；新增实体按同语义登记）
  "phase", // 同上（sop 流程阶段）
  "approvalStatus", // app-deployment.entity.ts:127
  "rolloutState", // app-deployment.entity.ts（灰度批次推进状态）
  "finishedAt", // agent-session.entity.ts:190
  "deployedAt", // app-deployment.entity.ts:116
  "isActive", // user.entity.ts:37
  "sessionVersion", // user.entity.ts:62
  "revoked", // refresh-token（token 撤销即状态）
  "revokedAt", // api-key.entity.ts:97
  "deadLettered", // event-outbox.entity.ts:71
  "enabled", // 通用启用位（配置 / 订阅 / 执行器包）
];

/**
 * 租约/计数器列（**warn**）。无条件写这些列在现存实现里多为刻意（自增、best-effort 释放），
 * 误红代价高于收益；仍打印出来供评审。
 */
const LEASE_STATE_COLUMNS = [
  "leaseUntil", // event-outbox.entity.ts:63
  "leaseToken", // event-outbox（claim 令牌）
  "dispatchedAt", // event-outbox.entity.ts:51
  "pulledAt", // sop-assignment.entity.ts:83
  "attempt", // sop-assignment.entity.ts:95
  "attempts", // event-outbox(-dead-letter).entity.ts
  "turnLockedAt", // ai-sop-session.entity.ts:58
  "lockedUntil", // user.entity.ts（登录锁定）
  "lastTriggerTime", // task.entity.ts:216
  "lastHeartbeat", // executor.entity.ts:120 / app-deployment.entity.ts:111
  "startedAt", // agent-session.entity.ts:187
  "version", // executor / sop-version / task-version（乐观锁列）
  "updatedAt", // 任何实体的行时间戳
];

const TERMINAL_SET = new Set(TERMINAL_STATE_COLUMNS);
const LEASE_SET = new Set(LEASE_STATE_COLUMNS);

/**
 * 「状态谓词」的宽口径标记集合（链式谓词文本 / 裸 SQL 谓词部分都走它）。
 * 刻意**放得很宽**：`version/attempt/IS NULL/IS NOT DISTINCT FROM` 都算条件——宁可漏判，
 * 也不要把一条已经条件化的写误判成无条件写（误红的代价是守卫被无视）。
 */
const STATE_PREDICATE_RE = new RegExp(
  "(?:" +
    [
      ...TERMINAL_STATE_COLUMNS,
      ...LEASE_STATE_COLUMNS,
      "deletedAt",
      "creationTime",
    ].join("|") +
    "|IS\\s+(?:NOT\\s+)?NULL|IS\\s+NOT\\s+DISTINCT\\s+FROM|CURRENT_TIMESTAMP)",
  "i",
);

/** 裸 SQL：`UPDATE <t> [AS alias] SET`。表名可带引号/schema 前缀。 */
const RAW_UPDATE_RE = /\bUPDATE\s+(?:ONLY\s+)?(?:["`\w$]+\.)*(?:["`]\w+["`]|\w+)(?:\s+AS\s+["`]?\w+["`]?)?\s+SET\b/i;

// ── 通用文本工具 ────────────────────────────────────────────────────────────

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name === "__tests__" || e.name === "node_modules" || e.name === "dist") continue;
      walk(join(dir, e.name), out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts") && !e.name.endsWith(".d.ts")) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

/** 抹掉注释与字符串字面量（保留换行，行号不漂）。与 check-error-migration 同思路。 */
function stripNonCode(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  let state = "code";
  const SQ = String.fromCharCode(39), DQ = String.fromCharCode(34);
  const BT = String.fromCharCode(96), BS = String.fromCharCode(92), NL = String.fromCharCode(10);
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === "code") {
      if (c === "/" && c2 === "/") { state = "line"; out.push(" ", " "); i += 2; continue; }
      if (c === "/" && c2 === "*") { state = "block"; out.push(" ", " "); i += 2; continue; }
      if (c === SQ || c === DQ || c === BT) { state = c === SQ ? "sq" : c === DQ ? "dq" : "tpl"; out.push(" "); i += 1; continue; }
      out.push(c); i += 1; continue;
    }
    if (state === "line") { if (c === NL) { state = "code"; out.push(NL); } else { out.push(" "); } i += 1; continue; }
    if (state === "block") {
      if (c === "*" && c2 === "/") { state = "code"; out.push(" ", " "); i += 2; continue; }
      out.push(c === NL ? NL : " "); i += 1; continue;
    }
    if (c === BS) { out.push(" ", " "); i += 2; continue; }
    const closer = state === "sq" ? SQ : state === "dq" ? DQ : BT;
    if (c === closer) { state = "code"; out.push(" "); i += 1; continue; }
    out.push(c === NL ? NL : " "); i += 1;
  }
  return out.join("");
}

/**
 * 抹掉**注释**但**保留字符串内容**（长度、位置一字节不差）。
 *
 * 判据 B/C 需要读 `where("… status …")` 里的 SQL 文本与裸 SQL 字面量，用 `stripNonCode`
 * 会把它们一起抹空——审计正是靠这一点证明裸 SQL「永久不可见」。两个版本的字符位置完全
 * 对齐，所以结构解析（配平括号）在 `stripNonCode` 上做、内容取值在本文本上做。
 */
function stripCommentsOnly(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  let state = "code";
  const SQ = String.fromCharCode(39), DQ = String.fromCharCode(34);
  const BT = String.fromCharCode(96), BS = String.fromCharCode(92), NL = String.fromCharCode(10);
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === "code") {
      if (c === "/" && c2 === "/") { state = "line"; out.push(" ", " "); i += 2; continue; }
      if (c === "/" && c2 === "*") { state = "block"; out.push(" ", " "); i += 2; continue; }
      if (c === SQ || c === DQ || c === BT) { state = c === SQ ? "sq" : c === DQ ? "dq" : "tpl"; out.push(c); i += 1; continue; }
      out.push(c); i += 1; continue;
    }
    if (state === "line") { if (c === NL) { state = "code"; out.push(NL); } else { out.push(" "); } i += 1; continue; }
    if (state === "block") {
      if (c === "*" && c2 === "/") { state = "code"; out.push(" ", " "); i += 2; continue; }
      out.push(c === NL ? NL : " "); i += 1; continue;
    }
    if (c === BS) { out.push(c, src[i + 1] ?? ""); i += 2; continue; }
    const closer = state === "sq" ? SQ : state === "dq" ? DQ : BT;
    if (c === closer) { state = "code"; out.push(c); i += 1; continue; }
    out.push(c); i += 1;
  }
  return out.join("");
}

/** 从 `{` 起读平衡花括号，返回 [内容, 结束下标]。 */
function readBraced(s, start) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") { depth--; if (depth === 0) return [s.slice(start + 1, i), i]; }
  }
  return [null, s.length];
}

/** 从 `(` 起读平衡圆括号，返回 [内容, 结束下标]。 */
function readParens(s, start) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") { depth--; if (depth === 0) return [s.slice(start + 1, i), i]; }
  }
  return [null, s.length];
}

/** 取顶层键（逗号按 ()/{} /[] 深度切分，只认 `key:` 形态）。 */
function topLevelKeys(body) {
  const keys = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) { keys.push(cur); cur = ""; continue; }
    cur += ch;
  }
  keys.push(cur);
  return keys
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => {
      const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/.exec(k);
      if (m) return m[1];
      const shorthand = /^([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(k);
      return shorthand ? shorthand[1] : "(spread)";
    });
}

/** 顶层逗号切分（保留片段原文）。 */
function splitTopLevel(text, sepChar = ",") {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === sepChar && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

function lineOf(src, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

// ── 判据 A：`.update({ id }, …)` 单键 ───────────────────────────────────────

export function findUnconditionalUpdates(src) {
  const codeOnly = stripNonCode(src);
  const hits = [];
  const re = /\.update\s*\(/g;
  let m;
  while ((m = re.exec(codeOnly)) !== null) {
    let i = m.index + m[0].length;
    while (i < codeOnly.length && /\s/.test(codeOnly[i])) i++;
    if (codeOnly[i] !== "{") continue; // first arg 不是对象字面量 → 跳过
    const [body] = readBraced(codeOnly, i);
    if (body === null) continue;
    const keys = topLevelKeys(body);
    if (keys.length === 1 && keys[0] === "id") {
      hits.push({ index: m.index, line: lineOf(codeOnly, m.index) });
    }
  }
  return hits;
}

// ── 判据 B：createQueryBuilder().update(X).set(…).where(…) 链 ───────────────

/** 链的「语句头」：向前找到最近的 `;` / `{` / `}` 作为语句边界。 */
function statementHead(code, idx) {
  const start = Math.max(code.lastIndexOf(";", idx), code.lastIndexOf("{", idx), code.lastIndexOf("}", idx));
  return { start: start + 1, text: code.slice(Math.max(0, start + 1), idx) };
}

/** `.update(` 的接收者标识符（`this.repo.createQueryBuilder()…` / `qb.update(…)`）。 */
function receiverOf(code, idx) {
  // idx 指向 `.update(` 的那个点，取它前面的标识符（`qb` / `this.repo` 的末段）。
  const before = code.slice(Math.max(0, idx - 80), idx).replace(/\s+$/, "");
  const m = /([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(before);
  return m ? m[1] : null;
}

/**
 * 找出「queryBuilder 链里没有状态谓词」的 update。
 *
 * 链路识别：`.update(` 的语句头（或向前 3000 字符内该接收者的声明）含 `createQueryBuilder`。
 * 谓词收集：`.set(…)` 之后到 `.execute()` 为止的 where/andWhere/orWhere 参数原文
 * （**字符串内容保留**）；若链被赋给变量（`const qb = …`），再把随后 1200 字符内
 * `qb.andWhere(…)` 这类分离调用也算进来——`task.service.ts` 的 transition 写法就是这样，
 * 漏了它会把一条真条件写误报成红。
 */
export function findQueryBuilderWrites(src) {
  const code = stripNonCode(src);
  const raw = stripCommentsOnly(src);
  const hits = [];
  const re = /\.update\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const { start: stmtStart, text: head } = statementHead(code, m.index);
    const recv = receiverOf(code, m.index);
    let isBuilder = /createQueryBuilder/.test(head);
    if (!isBuilder && recv) {
      const lookback = code.slice(Math.max(0, m.index - 3000), m.index);
      isBuilder = new RegExp(
        "(?:const|let|var)\\s+" + recv + "\\s*=\\s*[^;]{0,400}?createQueryBuilder",
      ).test(lookback);
    }
    if (!isBuilder) continue;

    // 跳过 update(…) 的参数：拿到链尾位置
    let i = m.index + m[0].length;
    const [, updEnd] = readParens(code, i - 1);
    const afterUpdate = updEnd + 1;

    // `.set(` 必须是链上的下一环（允许 .where/returning 之前出现）
    const setMatch = /\.set\s*\(/.exec(code.slice(afterUpdate, afterUpdate + 600));
    if (!setMatch) continue;
    const setAt = afterUpdate + setMatch.index;
    const setArgStart = setAt + setMatch[0].length - 1;
    const [setArg] = readParens(code, setArgStart);
    let setKeys = null;
    if (setArg !== null) {
      const t = setArg.trim();
      if (t.startsWith("{")) {
        const at = setArgStart + 1 + setArg.indexOf("{");
        const [body] = readBraced(code, at);
        if (body !== null) setKeys = topLevelKeys(body);
      }
    }
    if (!setKeys || setKeys.length === 0) continue; // .set(patch) / 空 → 看不到被写列，放行

    // 收集谓词：链上 where/andWhere/orWhere，直到 .execute()
    const tail = code.slice(afterUpdate, afterUpdate + 6000);
    const execAt = tail.search(/\.execute\s*\(/);
    const limit = execAt >= 0 ? execAt : tail.length;
    const conds = [];
    const wre = /\.(?:where|andWhere|orWhere)\s*\(/g;
    let w;
    while ((w = wre.exec(tail)) !== null) {
      if (w.index > limit) break;
      const abs = afterUpdate + w.index + w[0].length - 1;
      const [arg] = readParens(code, abs);
      if (arg !== null) conds.push(raw.slice(abs + 1, abs + 1 + arg.length));
    }
    // 链被赋给变量 → 之后分离的 qb.andWhere(...) 也算谓词（保守，防误红）
    const chainVar = /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/.exec(head);
    if (chainVar) {
      const after = code.slice(afterUpdate, afterUpdate + 1500);
      const vre = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*(?:andWhere|orWhere)\s*\(/g;
      let v;
      while ((v = vre.exec(after)) !== null) {
        if (v[1] !== chainVar[1]) continue;
        const abs = afterUpdate + v.index + v[0].length - 1;
        const [arg] = readParens(code, abs);
        if (arg !== null) conds.push(raw.slice(abs + 1, abs + 1 + arg.length));
      }
    }

    const whereText = conds.join(" ").replace(/\s+/g, " ").trim();
    const hasPredicate = STATE_PREDICATE_RE.test(whereText);
    const terminalKeys = setKeys.filter((k) => TERMINAL_SET.has(k));
    const leaseKeys = setKeys.filter((k) => LEASE_SET.has(k));
    if (hasPredicate) continue;
    if (terminalKeys.length === 0 && leaseKeys.length === 0) continue; // 只写计数器/非状态列
    hits.push({
      index: m.index,
      line: lineOf(code, m.index),
      setKeys,
      terminalKeys,
      leaseKeys,
      whereText: whereText.slice(0, 160),
    });
  }
  return hits;
}

// ── 判据 C：裸 SQL `UPDATE … SET …` ────────────────────────────────────────

/** 遍历字符串字面量（单/双引号/模板串），返回 {start, end, content}（注释先抹掉）。 */
export function iterStringLiterals(src) {
  const text = stripCommentsOnly(src);
  const lits = [];
  let i = 0;
  const n = text.length;
  const BS = String.fromCharCode(92);
  while (i < n) {
    const c = text[i];
    const isQuote = c === '"' || c === "'" || c === "`";
    if (!isQuote) { i += 1; continue; }
    const closer = c;
    const start = i;
    i += 1;
    let content = "";
    while (i < n) {
      if (text[i] === BS) { content += text[i] + (text[i + 1] ?? ""); i += 2; continue; }
      if (text[i] === closer) break;
      content += text[i];
      i += 1;
    }
    lits.push({ start, end: i, content });
    i += 1;
  }
  return lits;
}

/** 取一段 SQL 文本的 SET 子句与谓词部分。 */
function analyzeSql(sql) {
  const upd = RAW_UPDATE_RE.exec(sql);
  if (!upd) return null;
  const setIdx = sql.indexOf("SET", upd.index);
  if (setIdx < 0) return null;
  const afterSet = sql.slice(setIdx + 3);
  const stopRe = /\b(WHERE|RETURNING|FROM)\b/i;
  const stop = stopRe.exec(afterSet);
  const setClause = stop ? afterSet.slice(0, stop.index) : afterSet;
  const rest = stop ? afterSet.slice(stop.index) : "";
  const columns = splitTopLevel(setClause)
    .map((a) => {
      const eq = a.indexOf("=");
      const lhs = eq >= 0 ? a.slice(0, eq) : a;
      const seg = lhs.trim().split(".").pop() ?? "";
      return seg.replace(/["`]/g, "").trim();
    })
    .filter(Boolean);
  // 谓词部分 = UPDATE 之前的 CTE 前缀 + SET 子句之后的 WHERE/RETURNING 文本。
  // **不含 SET 子句本身**——否则 `SET status = 'failed'` 会把自己判成"已有状态谓词"。
  const predicateText = sql.slice(0, upd.index) + " " + rest;
  return { columns, predicateText, sql: sql.trim() };
}

export function findRawSqlWrites(src) {
  const hits = [];
  for (const lit of iterStringLiterals(src)) {
    if (!/\bUPDATE\b/i.test(lit.content)) continue;
    const info = analyzeSql(lit.content);
    if (!info) continue;
    const terminalKeys = info.columns.filter((c) => TERMINAL_SET.has(c));
    const hasPredicate = STATE_PREDICATE_RE.test(info.predicateText);
    if (hasPredicate) continue;
    hits.push({
      index: lit.start,
      line: lineOf(src, lit.start),
      columns: info.columns,
      terminalKeys,
      sql: info.sql.replace(/\s+/g, " ").slice(0, 140),
    });
  }
  return hits;
}

// ── 判据 D：整行回写 `repo.save(<裸标识符>)` ────────────────────────────────

/**
 * 列出 `.save(<裸标识符>)` 形态——即「把一个变量（多半是方法早期读到的快照）整行写回」。
 * `save` 同时也是创建路径的写法（create → save），语法上无法区分「插入」与「陈旧快照回写」，
 * 所以**不逐条判红**，只做基线棘轮（判据 D）。
 */
export function findWholeRowSaves(src) {
  const codeOnly = stripNonCode(src);
  const hits = [];
  const re = /\.save\s*\(/g;
  let m;
  while ((m = re.exec(codeOnly)) !== null) {
    let i = m.index + m[0].length;
    while (i < codeOnly.length && /\s/.test(codeOnly[i])) i++;
    const rest = codeOnly.slice(i, i + 200);
    // 裸标识符 + `)` 或 `,`：同一行内闭合参数列表（多参数的 save 极少见，宁可漏报）
    const bare = /^([A-Za-z_$][A-Za-z0-9_$.]*)\s*[,)]/.exec(rest);
    if (!bare) continue;
    hits.push({ index: m.index, line: lineOf(codeOnly, m.index), target: bare[1] });
  }
  return hits;
}

// ── 基线 ────────────────────────────────────────────────────────────────────

const BASELINE_KEYS = ["updateIdOnly", "queryBuilderStateWrite", "rawSqlStateWrite", "wholeRowSaves"];

function loadBaseline(root) {
  const path = join(root, BASELINE_REL);
  if (!existsSync(path)) {
    return { error: "基线文件不存在：" + BASELINE_REL + "（守卫自失效=红；见文件头「只减不增」）" };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { error: "基线文件无法解析：" + BASELINE_REL + " — " + (err instanceof Error ? err.message : String(err)) };
  }
  const maxKnown = parsed?.maxKnown;
  if (!maxKnown || typeof maxKnown !== "object") return { error: "基线缺少 maxKnown 对象：" + BASELINE_REL };
  for (const k of BASELINE_KEYS) {
    if (!Number.isInteger(maxKnown[k]) || maxKnown[k] < 0) {
      return { error: "基线 maxKnown." + k + " 必须是非负整数：" + BASELINE_REL };
    }
  }
  const known = Array.isArray(parsed.known) ? parsed.known : [];
  for (const entry of known) {
    if (!entry || typeof entry.file !== "string" || typeof entry.judgment !== "string") {
      return { error: "基线 known[] 条目必须含 judgment 与 file：" + BASELINE_REL };
    }
    if (!BASELINE_KEYS.includes(entry.judgment)) {
      return { error: "基线 known[] 的 judgment 未知：" + entry.judgment };
    }
  }
  return { maxKnown, known, path };
}

// ── 扫描 ────────────────────────────────────────────────────────────────────

function isExempt(src, idx) {
  const lines = src.slice(0, idx).split("\n");
  // 窗口取 5 行：豁免标记通常需要 1-3 行说明理由，3 行窗口会让「标记 + 两行理由」
  // 恰好落在窗口外（实测踩到过一次）。
  return lines.slice(-5).some((l) => l.includes(EXEMPT_MARKER));
}

function relPosix(root, p) {
  return relative(root, p).split(sep).join("/");
}

/** 扫描一棵仓库根，返回 {files, reds, warns, saves, counts}。 */
export function collect(root) {
  const allFiles = walk(join(root, SRC_DIR));
  const moduleFiles = allFiles.filter((f) => relPosix(root, f).startsWith(MODULES_PREFIX));
  const reds = [];
  const warns = [];
  const saves = [];

  for (const f of moduleFiles) {
    const rel = relPosix(root, f);
    const src = readFileSync(f, "utf8");
    for (const h of findUnconditionalUpdates(src)) {
      if (isExempt(src, h.index)) continue;
      reds.push({
        judgment: "updateIdOnly",
        file: rel,
        line: h.line,
        detail: ".update({ id }, …)",
        hint: "WHERE 只带 id ⇒ 把读取时刻的状态挪进条件谓词（status IN (…)/version=…/IS NOT DISTINCT FROM）。",
      });
    }
    for (const h of findQueryBuilderWrites(src)) {
      if (isExempt(src, h.index)) continue;
      const isTerminal = h.terminalKeys.length > 0;
      const entry = {
        judgment: isTerminal ? "queryBuilderStateWrite" : "queryBuilderLeaseWrite",
        file: rel,
        line: h.line,
        detail:
          "update().set({" + h.setKeys.join(", ") + "}) ← " +
          (h.whereText ? "WHERE " + h.whereText : "**没有 WHERE**"),
        keys: isTerminal ? h.terminalKeys : h.leaseKeys,
        hint: isTerminal
          ? "set 里写了终态列（" + h.terminalKeys.join(",") + "），而 where 没有任何状态谓词 ⇒ 改成条件写。"
          : "set 里只写租约/计数器列（" + h.leaseKeys.join(",") + "）：确认无条件写是刻意的（best-effort 释放/自增）。",
      };
      (isTerminal ? reds : warns).push(entry);
    }
    for (const h of findWholeRowSaves(src)) {
      if (isExempt(src, h.index)) continue;
      saves.push({ judgment: "wholeRowSaves", file: rel, line: h.line, detail: ".save(" + h.target + ")", target: h.target });
    }
  }

  // 裸 SQL：扫 src 全量（含 agent/common），**迁移目录豁免**。
  for (const f of allFiles) {
    const rel = relPosix(root, f);
    if (rel.startsWith(MIGRATIONS_PREFIX)) continue; // 判据 C 的迁移豁免（审计形态 ⑥）
    const src = readFileSync(f, "utf8");
    for (const h of findRawSqlWrites(src)) {
      if (isExempt(src, h.index)) continue;
      const isTerminal = h.terminalKeys.length > 0;
      const entry = {
        judgment: isTerminal ? "rawSqlStateWrite" : "rawSqlNoPredicate",
        file: rel,
        line: h.line,
        detail: 'query(`' + h.sql + "`)",
        keys: h.terminalKeys,
        hint: isTerminal
          ? "裸 SQL 写了终态列（" + h.terminalKeys.join(",") + "）却没有状态谓词 ⇒ 加 WHERE status/version/IS NOT DISTINCT FROM。"
          : "裸 SQL 没有状态谓词，但 SET 不碰状态列（多为原子自增）：确认写者唯一即可（迁移目录整体豁免）。",
      };
      (isTerminal ? reds : warns).push(entry);
    }
  }

  const counts = {
    updateIdOnly: reds.filter((r) => r.judgment === "updateIdOnly").length,
    queryBuilderStateWrite: reds.filter((r) => r.judgment === "queryBuilderStateWrite").length,
    rawSqlStateWrite: reds.filter((r) => r.judgment === "rawSqlStateWrite").length,
    queryBuilderLeaseWrite: warns.filter((w) => w.judgment === "queryBuilderLeaseWrite").length,
    rawSqlNoPredicate: warns.filter((w) => w.judgment === "rawSqlNoPredicate").length,
    wholeRowSaves: saves.length,
  };
  return { files: moduleFiles.length, srcFiles: allFiles.length, reds, warns, saves, counts };
}

// ── 输出 ────────────────────────────────────────────────────────────────────

const JUDGMENT_LABEL = {
  updateIdOnly: "[红] .update({ id }, …)",
  queryBuilderStateWrite: "[红] queryBuilder 无条件状态写",
  rawSqlStateWrite: "[红] 裸 SQL 无条件状态写",
  queryBuilderLeaseWrite: "[warn] queryBuilder 无条件租约/计数写",
  rawSqlNoPredicate: "[warn] 裸 SQL 无状态谓词（非状态列）",
};

function printFindings(list) {
  for (const r of list) {
    console.log("  " + r.file + ":" + r.line + "  " + (JUDGMENT_LABEL[r.judgment] ?? r.judgment));
    console.log("        " + r.detail);
    if (r.hint) console.log("        → " + r.hint);
  }
}

/** 解析 CLI 参数（导出给 selftest 反证「根解析不跟 cwd」）。 */
export function parseArgs(argv = []) {
  const opts = { root: DEFAULT_ROOT, rootExplicit: false, report: false, reportSaves: false, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") { opts.root = resolve(argv[++i] ?? "."); opts.rootExplicit = true; }
    else if (a.startsWith("--root=")) { opts.root = resolve(a.slice("--root=".length)); opts.rootExplicit = true; }
    else if (a === "--report") opts.report = true;
    else if (a === "--report-saves") opts.reportSaves = true;
    else if (a === "--selftest") opts.selftest = true;
  }
  return opts;
}

/** 缺省根（`--root <dir>` 与 `--root=<dir>` 两种形态都认）。 */
export function resolveRoot(argv = []) {
  return parseArgs(argv).root;
}

/**
 * 结构错（守卫自失效）：基线读不到 + 扫描面空转/收窄。
 *
 * **报告模式与判据模式都必须是红**：报告模式只免「判据红」，不免「守卫自失效」。
 * 旧版 `--report-saves` 把坏基线/空扫描面吞成 exit 0 并打印「整行 save 0 处」——
 * 那是「报告在说话、闸不关门」的教科书形态（`--report-saves` 已在 CI 里跑）。
 */
function structuralProblems(baseline, scan, opts) {
  const problems = [];
  if (baseline.error) problems.push("✖ ADR-026 守卫自失效：" + baseline.error);
  if (scan.files === 0) problems.push("✖ 扫不到文件：" + MODULES_DIR);
  else if (!opts.rootExplicit && scan.files < MIN_SCANNED_FILES) {
    problems.push(
      "✖ 扫描面异常收窄：只扫到 " + scan.files + " 个文件（下界 " + MIN_SCANNED_FILES +
        "，src 共 " + scan.srcFiles + " 个）",
    );
  }
  return problems;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.selftest) {
    selftest();
    return;
  }

  // 结构面先判：它决定「这次运行能不能代表仓库」，与模式无关。
  const baseline = loadBaseline(opts.root);
  const scan = collect(opts.root);
  const structural = structuralProblems(baseline, scan, opts);
  if (structural.length > 0) {
    for (const p of structural) console.error(p);
    process.exit(1);
  }
  const { files, srcFiles, reds, warns, saves, counts } = scan;

  if (opts.reportSaves) {
    // 盲区①的报告模式：**不产生判据红**，只列候选供人评审（CI 也跑，纯可见性）。
    for (const r of saves) console.log("  " + r.file + ":" + r.line + "  .save(" + r.target + ")");
    console.log("");
    // 措辞要点：旧版这里写「（不失败）」，但它其实会因结构错（坏基线/空扫描面）而红——
    // 一句话说错，下一个人就会以为「结构错放行」是刻意设计，从而把 structuralProblems() 删掉。
    console.log("ℹ 报告模式（不判据红，结构错仍红）：整行 save " + saves.length + " 处（扫了 " + files + " 个文件）。");
    if (baseline.maxKnown) {
      console.log(
        "  基线 " + baseline.maxKnown.wholeRowSaves + " 处（" + BASELINE_REL + "）：只减不增，" +
          "超基线时默认模式会红。",
      );
    }
    console.log(
      "  这些是 **盲区①** 的候选：`save` 也可能是创建路径。逐条问一句「这个变量是刚 create 出来的，" +
        "还是方法早期读到的快照？」——后者就是 ADR-026 规则 4 禁止的整行回写。",
    );
    return;
  }

  const { maxKnown, known } = baseline;
  const over = [];
  if (counts.updateIdOnly > maxKnown.updateIdOnly) over.push("updateIdOnly");
  if (counts.queryBuilderStateWrite > maxKnown.queryBuilderStateWrite) over.push("queryBuilderStateWrite");
  if (counts.rawSqlStateWrite > maxKnown.rawSqlStateWrite) over.push("rawSqlStateWrite");
  if (counts.wholeRowSaves > maxKnown.wholeRowSaves) over.push("wholeRowSaves");

  // 每类「已登记欠账」不得多于基线数字（防「登记代替修复」）。
  for (const k of BASELINE_KEYS) {
    const registered = known.filter((e) => e.judgment === k).length;
    if (registered > maxKnown[k]) {
      console.error("✖ 基线 known[] 里 " + k + " 登记了 " + registered + " 条，超过 maxKnown." + k + "=" + maxKnown[k] + "（登记不能代替修复）");
      process.exit(1);
    }
  }
  // 陈旧登记只提示，不判红（文件重命名/合并属正常演进）。
  for (const e of known) {
    if (!existsSync(join(opts.root, e.file))) console.log("  ℹ 基线登记的文件已不存在（可删该条）：" + e.file);
  }

  if (reds.length > 0 || warns.length > 0 || opts.report) {
    printFindings(reds);
    printFindings(warns);
  }
  // 整行 save：基线内只打印计数（34 行的清单留给 --report-saves / --report），
  // 超基线（= 新增）时把清单打出来——新增的这几处才是要人看的东西。
  if (opts.report || over.length > 0) {
    for (const r of saves) console.log("  " + r.file + ":" + r.line + "  [warn] 整行 save " + r.detail);
  }

  console.log("");
  console.log(
    "  判据计数：单键 update " + counts.updateIdOnly + "（基线 " + maxKnown.updateIdOnly + "）· " +
      "queryBuilder 状态写 " + counts.queryBuilderStateWrite + "（基线 " + maxKnown.queryBuilderStateWrite + "）· " +
      "裸 SQL 状态写 " + counts.rawSqlStateWrite + "（基线 " + maxKnown.rawSqlStateWrite + "）· " +
      "整行 save " + counts.wholeRowSaves + "（基线 " + maxKnown.wholeRowSaves + "）",
  );
  console.log(
    "  warn（不阻断）：queryBuilder 租约/计数写 " + counts.queryBuilderLeaseWrite + " · 裸 SQL 无谓词非状态列 " + counts.rawSqlNoPredicate,
  );

  if (over.length > 0) {
    console.error("");
    console.error(
      "✖ ADR-026：无条件状态写超基线 —— " + over.map((k) => k + " " + counts[k] + " > " + maxKnown[k]).join("；") +
        "（扫了 " + files + " 个文件）",
    );
    console.error("  这类写没有任何前置状态断言；并发或长窗口下会把别人刚写完的状态盖回去（ADR-026 四起真实事故同型）。");
    console.error("  修法：把「读取时刻的状态」挪进 WHERE（status IN (…) / status NOT IN (终态) / version = … / IS NOT DISTINCT FROM），");
    console.error("        命中 0 行就 warn 让位，不要抛 500（ADR-026 决策 3）。");
    console.error("  确有并发安全理由时，在调用前 5 行内写 \"adr-026-exempt: <理由>\" 注释；");
    console.error("  整行 save 的创建路径若确认无害，把新数字写进 " + BASELINE_REL + ".maxKnown.wholeRowSaves 并在评审里说明。");
    process.exit(1);
  }

  const tighten = [];
  if (counts.updateIdOnly < maxKnown.updateIdOnly) tighten.push("updateIdOnly " + maxKnown.updateIdOnly + " → " + counts.updateIdOnly);
  if (counts.queryBuilderStateWrite < maxKnown.queryBuilderStateWrite) tighten.push("queryBuilderStateWrite " + maxKnown.queryBuilderStateWrite + " → " + counts.queryBuilderStateWrite);
  if (counts.wholeRowSaves < maxKnown.wholeRowSaves) tighten.push("wholeRowSaves " + maxKnown.wholeRowSaves + " → " + counts.wholeRowSaves);
  if (tighten.length > 0) console.log("  ℹ 基线可下调（改掉一处就降一处）：" + tighten.join("；"));

  console.log(
    "✔ ADR-026 守卫通过：无条件状态写 " + reds.length + " 处 / warn " + warns.length + " 处 / 整行 save " +
      saves.length + " 处（基线 " + maxKnown.updateIdOnly + "/" + maxKnown.queryBuilderStateWrite + "/" + maxKnown.wholeRowSaves +
      "，扫了 " + files + " 个文件，裸 SQL 面 " + srcFiles + " 个）。",
  );
}

// ── selftest：真子进程断言「退出码 + 文本 + 耗时」（判据本身有牙） ────────────
//
// T4 收编（第 12 轮）：旧实现自己攒了一套 `mkdtemp + copyFile + spawnSync +
// 手判 status/contains + problems[]`，与另外 40 多个守卫各写一份、细节互不一致
// （不设超时、`status === null`（超时/信号）会被当成普通退出码比较）。现在统一走
// `scripts/lib/guard-selftest.mjs`：
//   · `runGuard` 负责起进程（脚本/cwd 不存在立即抛错，超时给布尔）；
//   · `expectExit` 负责判（退出码 + 关键文本 + `absent` + `withinMs`，失败抛带 cwd
//     与输出尾部的错）；
//   · `makeFixtureRepo` / `reportCases` 负责造树与汇总。
// 用例语义、判据与条数一条没删（原有 27 条函数级 + 13 条子进程级全部保留）。

const FIXTURE_MODULE = join("apps", "admin-api", "src", "modules", "demo");
const FIXTURE_MODULE_POSIX = FIXTURE_MODULE.split(sep).join("/");
const BASELINE_REL_POSIX = BASELINE_REL.split(sep).join("/");
const fixture = (name) => `${FIXTURE_MODULE_POSIX}/${name}`;

/**
 * 单条子进程用例的耗时上限（喂给 `expectExit({ withinMs })`）。
 * 一次 fixture 扫描实测 ~50ms，留 20 倍余量：它拦的是「扫描面/正则退化成指数
 * 回溯」这类**耗时形态**，不是抖动。
 */
const SELFTEST_CASE_BUDGET_MS = 1000;

const BASE0 = {
  $comment: "selftest 基线",
  maxKnown: { updateIdOnly: 0, queryBuilderStateWrite: 0, rawSqlStateWrite: 0, wholeRowSaves: 0 },
  known: [],
};

/** 断言相等；失败即抛（`reportCases` 据此判红，而不是让人忘看返回值）。 */
function expectEq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}：实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
  }
}

function must(cond, message) {
  if (!cond) throw new Error(message);
}

function selftest() {
  const cases = [];
  const unit = (name, fn) => cases.push({ name, fn });

  // ── 第一层：纯函数单元（判据的边界，快） ────────────────────────────────
  unit(".update({ id }, patch) 单键 → 命中", () =>
    expectEq(findUnconditionalUpdates("await this.repo.update({ id: a.id }, { x: 1 });").length, 1, "命中数"));
  unit(".update({ id, status }) 带前置条件 → 放行", () =>
    expectEq(findUnconditionalUpdates('await this.repo.update({ id: a.id, status: "x" }, { x: 1 });').length, 0, "命中数"));
  unit("多行对象形态同样命中", () =>
    expectEq(findUnconditionalUpdates("await this.repo.update(\n  { id: a.id },\n  { x: 1 },\n);").length, 1, "命中数"));
  unit("注释里的 .update({id}) 不算", () =>
    expectEq(findUnconditionalUpdates("// await this.repo.update({ id: a.id }, {});").length, 0, "命中数"));
  unit("字符串里的 .update({id}) 不算", () =>
    expectEq(findUnconditionalUpdates('const s = "this.repo.update({ id }, {})";').length, 0, "命中数"));
  unit("嵌套对象不会误判（id 在子对象里）", () =>
    expectEq(findUnconditionalUpdates("await this.repo.update({ where: { id: 1 } }, { x: 1 });").length, 0, "命中数"));
  unit("shorthand { id } 也命中", () =>
    expectEq(findUnconditionalUpdates("await this.repo.update({ id }, { x: 1 });").length, 1, "命中数"));

  unit("queryBuilder 链 set(status) + where(id) → 命中", () =>
    expectEq(
      findQueryBuilderWrites(
        "await this.sessions\n  .createQueryBuilder()\n  .update(AgentSession)\n  .set({ status: \"running\" })\n  .where(\"id = :id\", { id })\n  .execute();",
      ).length,
      1,
      "命中数",
    ));
  unit("queryBuilder 链带 status 谓词 → 放行", () =>
    expectEq(
      findQueryBuilderWrites(
        "await this.sessions\n  .createQueryBuilder()\n  .update(AgentSession)\n  .set({ status: \"running\" })\n  .where(\"id = :id AND status <> 'running'\", { id })\n  .execute();",
      ).length,
      0,
      "命中数",
    ));
  unit("queryBuilder 链 where 拆分在 qb.andWhere 里 → 放行（防误红）", () =>
    expectEq(
      findQueryBuilderWrites(
        "const qb = this.repo.createQueryBuilder().update(Task).set({ status: to }).where('\"id\" = :id', { id });\nif (from.length) qb.andWhere('\"status\" = :from', { from });",
      ).length,
      0,
      "命中数",
    ));
  unit("queryBuilder 链只写计数器 → 不判红（租约/计数白名单）", () =>
    expectEq(
      findQueryBuilderWrites(
        "await this.repo.createQueryBuilder().update(AgentSession).set({ totalSteps: () => '\"totalSteps\" + 1' }).where(\"id = :id\", { id }).execute();",
      ).length,
      0,
      "命中数",
    ));
  unit("queryBuilder 链残留租约列 → 记 warn 级", () =>
    expectEq(
      findQueryBuilderWrites(
        "await this.repo.createQueryBuilder().update(AiSopSession).set({ turnLockedAt: null }).where(\"id = :id\", { id }).execute();",
      ).length,
      1,
      "命中数",
    ));
  unit("queryBuilder 链 set(patch) 非字面量 → 放行（宁可漏）", () =>
    expectEq(
      findQueryBuilderWrites("qb.createQueryBuilder().update(Task).set(patch).where('\"id\" = :id', { id }).execute();").length,
      0,
      "命中数",
    ));
  unit("普通 .update( 不是 builder 链 → 不归判据 B 管", () =>
    expectEq(findQueryBuilderWrites("await this.repo.update({ id }, { status: 'x' });").length, 0, "命中数"));
  unit("接收者分离（qb = createQueryBuilder(); qb.update(...)）也归判据 B", () =>
    expectEq(
      findQueryBuilderWrites(
        "const qb = (manager ?? repo).createQueryBuilder();\nreturn qb.update(TaskExecution).set({ status: 'failed' }).where('\"id\" = :id', { id }).execute();",
      ).length,
      1,
      "命中数",
    ));
  unit("分离接收者但谓词带状态 → 放行", () =>
    expectEq(
      findQueryBuilderWrites(
        "const qb = (manager ?? repo).createQueryBuilder();\nreturn qb.update(TaskExecution).set({ status: 'failed' }).where('\"id\" IN (:...ids) AND \"status\" IN (:...gate)', { ids, gate }).execute();",
      ).length,
      0,
      "命中数",
    ));

  unit("裸 SQL UPDATE status + WHERE id → 命中", () =>
    expectEq(
      findRawSqlWrites('await this.repo.query(`UPDATE "tasks" SET "status" = $1 WHERE "id" = $2`, [s, id]);').length,
      1,
      "命中数",
    ));
  unit("裸 SQL 带 status 谓词 → 放行", () =>
    expectEq(
      findRawSqlWrites('await this.repo.query(`UPDATE "tasks" SET "status" = $1 WHERE "id" = $2 AND "status" = $3`, [s, id, f]);')
        .length,
      0,
      "命中数",
    ));
  unit("裸 SQL CTE（前缀里有 IS NULL 谓词）→ 放行", () =>
    expectEq(
      findRawSqlWrites(
        'await this.ds.query(`WITH c AS (SELECT "id" FROM "event_outbox" WHERE "dispatchedAt" IS NULL) UPDATE "event_outbox" AS o SET "leaseUntil" = $1 FROM c WHERE o."id" = c."id"`);',
      ).length,
      0,
      "命中数",
    ));
  unit("裸 SQL 只写非状态列 → 不进红判据（warn）", () =>
    expectEq(
      findRawSqlWrites('await m.query(`UPDATE "executors" SET "runningTaskCount" = "runningTaskCount" + 1 WHERE "id" = $1`);').length,
      1,
      "命中数",
    ));
  unit("字符串里的 UPDATE 字样但不含 SET → 不命中", () =>
    expectEq(findRawSqlWrites('logger.log("UPDATE tasks returned nothing");').length, 0, "命中数"));
  unit("注释里的 UPDATE … SET → 不算", () =>
    expectEq(findRawSqlWrites('// `UPDATE "tasks" SET "status" = 1 WHERE "id" = 2`').length, 0, "命中数"));

  const saveCases = [
    ["save(裸标识符) → 计入候选", "await this.repos.save(sop);", 1],
    ["save(this.create(...)) → 创建路径，跳过", "await this.repos.save(this.repos.create({ a: 1 }));", 0],
    ["save({ … }) 字面量 → 跳过", "await this.repos.save({ id: 1 });", 0],
    ["注释里的 save(x) 不算", "// await this.repos.save(sop);", 0],
    ["多级属性接收者同样计入", "await this.svc.repo.save(row);", 1],
  ];
  for (const [name, src, expected] of saveCases) {
    unit(name, () => expectEq(findWholeRowSaves(src).length, expected, "命中数"));
  }

  // ── 第二层：整脚本子进程（**断言退出码 + 文本 + 耗时**，审计的核心批评） ──
  const QB_RED = [
    "export class DemoService {",
    "  async markRunning(id: string) {",
    "    return this.sessions",
    "      .createQueryBuilder()",
    "      .update(AgentSession)",
    "      .set({ status: \"running\" })",
    "      .where(\"id = :id\", { id })",
    "      .execute();",
    "  }",
    "}",
    "",
  ].join("\n");
  const QB_GREEN = QB_RED.replace('.where("id = :id", { id })', '.where("id = :id AND status <> \'running\'", { id })');
  const RAW_RED = [
    "export class DemoRepo {",
    "  async fail(id: string) {",
    "    return this.repo.query(`UPDATE \"tasks\" SET \"status\" = 'failed' WHERE \"id\" = $1`, [id]);",
    "  }",
    "}",
    "",
  ].join("\n");
  const RAW_GREEN = RAW_RED.replace('WHERE "id" = $1', 'WHERE "id" = $1 AND "status" = \'running\'');
  const COUNTER_ONLY = QB_RED.replace('.set({ status: "running" })', '.set({ totalSteps: () => \'"totalSteps" + 1\' })');
  const SAVE_ONLY = "export class S { async f() { return this.repos.save(sop); } }\n";

  let alternate = 0;
  const subprocess = (c) => {
    cases.push({
      name: c.name,
      fn: () => {
        // 基线内容：`baseline` 走 JSON 序列化（与旧 writeFileSync 等价），
        // `baselineRaw` 用于「坏基线」这类必须写成非法 JSON 的用例。
        const files = { ...c.files };
        if (c.baselineRaw !== undefined) files[BASELINE_REL_POSIX] = c.baselineRaw;
        else if (c.baseline) files[BASELINE_REL_POSIX] = c.baseline;

        const repo = makeFixtureRepo(files, { prefix: "adr026-selftest-" });
        try {
          // `--root <dir>` 与 `--root=<dir>` **交替**使用：参数解析退化（吃掉值 /
          // 只认某一种形态）时，约一半用例会红，而不是整片静默照绿。
          const rootFlag = alternate++ % 2 === 0 ? ["--root", repo.dir] : [`--root=${repo.dir}`];
          expectExit(runGuard(SELF, { args: [...rootFlag, ...(c.args ?? [])] }), {
            code: c.code,
            contains: c.contains ?? [],
            absent: c.absent ?? [],
            withinMs: SELFTEST_CASE_BUDGET_MS,
            label: c.name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  subprocess({
    name: "【子进程】queryBuilder 链 set(status) + where(id) → exit 1 且点名 file:line",
    files: { [fixture("demo.service.ts")]: QB_RED },
    baseline: BASE0,
    code: 1,
    contains: ["queryBuilder", "demo.service.ts:", "status", "基线"],
    absent: ["✔ ADR-026 守卫通过"],
  });
  subprocess({
    name: "【子进程】queryBuilder 链带 status 谓词 → exit 0",
    files: { [fixture("demo.service.ts")]: QB_GREEN },
    baseline: BASE0,
    code: 0,
    contains: ["✔ ADR-026 守卫通过"],
    absent: ["✖"],
  });
  subprocess({
    name: "【子进程】queryBuilder 只写计数器 → exit 0（保守，不误红）",
    files: { [fixture("demo.service.ts")]: COUNTER_ONLY },
    baseline: BASE0,
    code: 0,
    contains: ["✔ ADR-026 守卫通过"],
    absent: ["✖"],
  });
  subprocess({
    name: "【子进程】裸 SQL UPDATE status + WHERE id → exit 1 且点名 file:line",
    files: { [fixture("demo.repo.ts")]: RAW_RED },
    baseline: BASE0,
    code: 1,
    contains: ["裸 SQL", "demo.repo.ts:", "rawSqlStateWrite"],
    absent: ["✔ ADR-026 守卫通过"],
  });
  subprocess({
    name: "【子进程】裸 SQL 带 status 谓词 → exit 0",
    files: { [fixture("demo.repo.ts")]: RAW_GREEN },
    baseline: BASE0,
    code: 0,
    contains: ["✔ ADR-026 守卫通过"],
    absent: ["✖"],
  });
  subprocess({
    name: "【子进程】迁移目录里的无条件 UPDATE → 豁免，exit 0",
    files: {
      [fixture("demo.repo.ts")]: RAW_GREEN,
      [join("apps", "admin-api", "src", "migrations", "1790000000999-BackfillDemo.ts").split(sep).join("/")]: [
        "export class BackfillDemo1790000000999 {",
        "  async up(q: any) {",
        "    await q.query(`UPDATE \"tasks\" SET \"status\" = 'pending' WHERE \"id\" IS NOT NULL`);",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
    baseline: BASE0,
    code: 0,
    contains: ["✔ ADR-026 守卫通过"],
    absent: ["✖"],
  });
  subprocess({
    name: "【子进程】整行 save 超基线 → exit 1 且点名 file:line",
    files: { [fixture("demo.service.ts")]: SAVE_ONLY },
    baseline: { ...BASE0, maxKnown: { ...BASE0.maxKnown, wholeRowSaves: 0 } },
    code: 1,
    contains: ["整行 save", "demo.service.ts:", "wholeRowSaves"],
    absent: ["✔ ADR-026 守卫通过"],
  });
  subprocess({
    name: "【子进程】整行 save 恰在基线内 → exit 0（warn 级，不逐条红）",
    files: { [fixture("demo.service.ts")]: SAVE_ONLY },
    baseline: { ...BASE0, maxKnown: { ...BASE0.maxKnown, wholeRowSaves: 1 } },
    code: 0,
    contains: ["✔ ADR-026 守卫通过"],
    absent: ["✖"],
  });
  subprocess({
    name: "【子进程】基线文件缺失 → exit 1（守卫自失效=红）",
    files: { [fixture("demo.service.ts")]: QB_GREEN },
    code: 1,
    contains: ["守卫自失效", "基线文件不存在"],
    absent: ["✔ ADR-026 守卫通过"],
  });
  subprocess({
    name: "【子进程】单键 update({ id }) 仍红（原判据未退化）",
    files: { [fixture("demo.service.ts")]: "export class S { async f() { return this.repo.update({ id }, { status: 'x' }); } }\n" },
    baseline: BASE0,
    code: 1,
    contains: ["updateIdOnly", "demo.service.ts:"],
    absent: ["✔ ADR-026 守卫通过"],
  });
  subprocess({
    name: "【子进程】--report-saves 不产生判据红（exit 0）且列出候选",
    files: { [fixture("demo.service.ts")]: SAVE_ONLY },
    baseline: { ...BASE0, maxKnown: { ...BASE0.maxKnown, wholeRowSaves: 0 } },
    code: 0,
    args: ["--report-saves"],
    contains: [".save(sop)", "报告模式（不判据红，结构错仍红）"],
    absent: ["守卫自失效"],
  });
  subprocess({
    name: "【子进程】known[] 登记数多于基线 → exit 1（登记不能代替修复）",
    files: { [fixture("demo.service.ts")]: QB_GREEN },
    baseline: {
      ...BASE0,
      known: [{ judgment: "updateIdOnly", file: fixture("demo.service.ts"), reason: "selftest" }],
    },
    code: 1,
    contains: ["登记不能代替修复"],
    absent: ["✔ ADR-026 守卫通过"],
  });
  subprocess({
    name: "【子进程】known[] 指向已不存在的文件 → 只提示（exit 0）",
    files: { [fixture("demo.service.ts")]: QB_GREEN },
    baseline: {
      ...BASE0,
      maxKnown: { ...BASE0.maxKnown, wholeRowSaves: 1 },
      known: [{ judgment: "wholeRowSaves", file: "apps/admin-api/src/modules/demo/gone.ts", reason: "selftest" }],
    },
    code: 0,
    contains: ["基线登记的文件已不存在"],
    absent: ["✖"],
  });

  // 第 12 轮补的两条：都是「守卫自失效被吞掉」的形态（旧版一律 exit 0 / 静默）。
  subprocess({
    name: "【子进程】坏基线（非法 JSON）→ exit 1，报错可读、不甩解析栈",
    files: { [fixture("demo.service.ts")]: QB_GREEN },
    baselineRaw: '{\n  "maxKnown": { , }\n}\n',
    code: 1,
    contains: ["守卫自失效", "基线文件无法解析", BASELINE_REL_POSIX],
    absent: ["✔ ADR-026 守卫通过", "    at "],
  });
  subprocess({
    name: "【子进程】--report-saves 也不放行结构错（坏基线 → exit 1，不再假绿）",
    files: { [fixture("demo.service.ts")]: SAVE_ONLY },
    baselineRaw: "{\n",
    args: ["--report-saves"],
    code: 1,
    contains: ["守卫自失效", "基线文件无法解析"],
    absent: ["报告模式（不判据红"],
  });

  // ── 第三层（in-process）：根解析锚定脚本位置，不跟 cwd ────────────────────
  // 为一条「缺省根」断言再起一次 node 要跑一整遍真仓库（~0.5s），会吃掉本脚本的
  // 耗时预算；而这里要钉的正是 `process.cwd()` → `REPO_ROOT` 这一行。故直接切
  // cwd 调导出函数：若有人改回 `process.cwd()`，本条立刻红。
  cases.push({
    name: "根解析：缺省 = 仓库根（不跟 cwd）；`--root` 两种形态都认",
    fn: () => {
      const repo = makeFixtureRepo({ [fixture("demo.service.ts")]: QB_RED });
      const prev = process.cwd();
      try {
        process.chdir(repo.dir);
        expectEq(resolveRoot([]), REPO_ROOT, "缺省 root");
        expectEq(resolveRoot(["--root", "sub"]), resolve(repo.dir, "sub"), "--root <dir>");
        expectEq(resolveRoot(["--root=sub"]), resolve(repo.dir, "sub"), "--root=<dir>");
      } finally {
        process.chdir(prev);
        repo.cleanup();
      }
    },
  });

  const failed = reportCases(cases, { title: "check-conditional-writes selftest" });
  if (failed > 0) process.exit(1);
}


const isMain = process.argv[1] && resolve(process.argv[1]) === SELF;
if (isMain) main();
