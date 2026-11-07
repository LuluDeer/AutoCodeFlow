#!/usr/bin/env node
/**
 * 机械守卫：**测试替身必须保真**（ADR-027）。
 *
 * ## 这条守卫防的是哪一类事故
 *
 * 2026-11-01 develop 的 CI，`selftests` job 红：
 *
 *      TypeError: this.sessionService.tryAppendEvent is not a function
 *
 * 根因不是生产代码，是**测试替身**：G1 给 `AgentSessionService` 加了
 * `tryAppendEvent`，生产 `agent-runtime.service.ts` 也调了它，但
 * `scripts/agent-runtime-check.mjs` 里手写的那个 `sessionService` 对象字面量
 * 没跟上。而那个脚本里**逐字写着**「替身必须保真（ADR-027）」——
 * **纪律在、守卫不在，所以它腐烂了。** 注释不会让 CI 变红，只有断言会。
 *
 * 更阴的一点：生产侧那次调用是**换行写的**
 *
 *       await this.sessionService
 *         .tryAppendEvent(sessionId, { … })
 *
 * 所以「用 `grep "this.sessionService."` 肉眼看一眼」也查不出来（本守卫的
 * 正则是跨行的，selftest 里专门有一条复刻这个形态的用例）。
 *
 * ## 判据（三步，全部可人工复核）
 *
 *   ① **找替身**：`scripts/agent-*.mjs` 里**手写的对象字面量**，且方法数 ≥ 2，
 *      并按下面的规则判角色（`sessionService` / `boundary` / `approvals`）：
 *        · 命名信号：工厂名/变量名（`makeSessionService`、`makeBoundary`、`approvals`…）
 *          归一后含 `sessionservice`/`session`、`boundary`、`approval`；
 *        · 结构信号：方法名与生产调用集的**交集 ≥ 2**（工厂被改名也抓得住；
 *          `makeAi` 这类无关替身交集为 0 ⇒ 自动排除）。
 *      **为什么要求「方法简写 ≥ 2」**：`makeSession()`（造一行会话数据）这种
 *      纯数据对象不该被当成替身——它没有方法，交集天然为 0。
 *
 *   ② **找生产调用**：`apps/admin-api/src/modules/agent/` 下（排除 `__tests__`
 *      与 `*.spec.ts`）匹配 `this.<角色>.<方法>(`。三条硬规则：
 *        · **跨行**：`this.sessionService\n  .foo(` 必须命中（2026-11-01 的实际形态）；
 *        · **排除 `?.`**：`this.sessionService?.foo(` 是「可以没有」的显式声明，
 *          不是契约（否则可选依赖会把替身要求撑成假的）；
 *        · **排除注释**：注释里的 `this.sessionService.foo(` 不算调用（否则文档
 *          会把守卫喂成假红）；
 *        · **排除 TypeORM 仓储**：`agent-approvals.service.ts` /
 *          `agent-session-retention.service.ts` 里的 `this.approvals` 声明类型是
 *          `Repository<AgentApproval>`——它是**仓储**，不是 `AgentApprovalsService`。
 *          判据取自同文件构造函数里的类型标注，不是文件名白名单。
 *
 *   ③ **双向比对**：
 *        · 生产调用的每个方法，该角色的替身**必须**有 ⇒ 缺了**红**（这就是那次 CI）；
 *        · 替身有、生产不用的 ⇒ **warn**（不红：可能是预留，也可能是生产侧还没接）。
 *
 * ## 结构红（绝不判绿）
 *
 *   · `--root` 指向的树不完整（缺 `scripts/` 或 `apps/admin-api/src/modules/agent/`）；
 *   · 一个替身都找不到（正则/命名面失效——「0 个替身 = 全部保真」是假绿）；
 *   · 生产调用一处都找不到（扫描面塌陷）；
 *   · 某个**有替身**的角色在生产侧零调用（同一类塌陷，只是收窄到角色）。
 *
 * ## 明确不做
 *
 *   · **不做 TS 级类型检查**（那是 `tsc` 的事，且替身在 `.mjs` 里是裸对象）；
 *   · **不覆盖所有替身**：只扫 `scripts/agent-*.mjs` 这一族——它们是「绕过 jest
 *     直接起运行时」的高危面（替身一错，测的就不是生产语义，而且崩在 CI 上）。
 *     `*.spec.ts` 里的 jest mock 由 `jest.fn()` 的形状兜着，不在本守卫范围；
 *   · 不改生产代码、不改既有替身。
 *
 * ## 已知盲区（**必须知道**，否则会误以为「绿 = 替身都保真」）
 *
 *   ① 间接调用看不见：`const s = this.sessionService; s.foo()`、
 *      `this["sessionService"].foo()`、把服务传给别的函数再调——本守卫只认
 *      `this.<角色>.<方法>(` 这一个形状。这类要靠评审。
 *   ② 角色靠命名/方法交集判定：工厂名既不含角色词、方法又与生产零交集的替身会被
 *      跳过（但它也不会被当成「该有方法」的对象，所以不会制造假绿——只有
 *      **一个替身都找不到**时才结构红）。
 *   ③ 只比对**方法名**，不比对参数/返回值语义：`async foo()` 空实现也算「有」。
 *      保真度（返回 `false` 而不是 `undefined` 这种）只能靠 harness 自己的断言。
 *   ④ 替身里同名但被赋值成**非函数**（`foo: 1`）不会被识破——它不算方法，
 *      于是会以「缺方法」的形式红；但如果生产侧也从不调它，就看不见。
 *   ⑤ 判据锚定的是**属性名**：同一个 `AgentSessionService` 在 `agent.controller.ts`
 *      里以 `this.sessions.` 注入（`reopenForResume` 等），另一处可能换个名字注入。
 *      那些调用**不在**判据内——本守卫只覆盖「替身要满足的那几个契约面」，即
 *      `this.sessionService` / `this.boundary` / `this.approvals`。这不是遗漏：
 *      把 controller 的调用也算进来，会让替身被要求实现它根本不该承担的方法（假红）。
 *      代价是：生产侧若把属性**改名**（`private readonly ss: AgentSessionService`），
 *      判据会静默变窄——`structuralProblems()` 里「有替身的角色零调用」是唯一的报警口。
 *
 * **最可能被绕过的方式**：把生产调用改成间接形态（`const s = this.sessionService; s.foo()`）
 * 或 `this.sessionService?.foo()`——两者都在判据外，前者是盲区①，后者是**刻意的**
 * 豁免（「可以没有」）。所以「绿」只证明「直接调用点都有对应方法」，不证明替身语义正确。
 *
 * 用法：
 *   node scripts/check-agent-stub-fidelity.mjs                 # 守卫（CI）
 *   node scripts/check-agent-stub-fidelity.mjs --selftest      # 判据有牙（含正例控制组）
 *   node scripts/check-agent-stub-fidelity.mjs --root <dir>    # 以 <dir> 为仓库根（selftest/反证用）
 *   node scripts/check-agent-stub-fidelity.mjs --root=<dir>    # 同上（等号形态）
 *   node scripts/check-agent-stub-fidelity.mjs --verbose       # 列出被跳过的对象字面量
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_ROOT, expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";
// R163：覆盖计数出口。**必须在任何 require/依赖之前**打印 —— 本文件若因缺依赖崩掉，
// 「崩了」与「零用例」必须能被哨兵分开看（`scripts/lib/agent-coverage.mjs` 头注同款纪律）。
printCoverageBanner(import.meta.url, "expectExit");

const SELF = fileURLToPath(import.meta.url);
/** 缺省根按**脚本位置**锚定，不用 `process.cwd()`（否则从子目录跑会扫空目录 ⇒ 假绿）。 */
const DEFAULT_ROOT = REPO_ROOT;

const SCRIPTS_DIR = "scripts";
const STUB_FILE_RE = /^agent-.*\.mjs$/;
const PROD_DIR = join("apps", "admin-api", "src", "modules", "agent");

/** 三个角色 = 生产侧被 `this.<role>.` 调用的三个协作者。 */
const ROLE_SPECS = [
  {
    key: "sessionService",
    what: "AgentSessionService",
    nameRe: /sessionservice|session/i,
    note: "会话仓储（AgentSessionService）",
  },
  {
    key: "boundary",
    what: "AgentBoundaryService",
    nameRe: /boundary/i,
    note: "边界闸门（AgentBoundaryService）",
  },
  {
    key: "approvals",
    what: "AgentApprovalsService",
    nameRe: /approvals?/i,
    note: "审批服务（AgentApprovalsService）",
  },
];

const ROLE_BY_KEY = new Map(ROLE_SPECS.map((r) => [r.key, r]));

/**
 * 对象字面量里「看起来像方法定义」的位置，但其实是控制结构关键字。
 * `if (x) {` / `for (…) {` / `switch (x) {` 在词法上与 `foo() {` 同形。
 */
const CONTROL_WORDS = new Set([
  "if", "for", "while", "switch", "catch", "with", "do", "else", "function", "return",
  "typeof", "new", "delete", "void", "in", "of", "instanceof", "try", "finally", "class",
  "extends", "import", "export", "await", "yield", "case", "default", "break", "continue",
  "throw", "var", "let", "const", "async",
]);

/** 出现在这些 token 之后的 `/` 是正则字面量，而不是除号。 */
const REGEX_AFTER_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "case", "delete", "void", "throw",
  "new", "do", "else", "yield", "await",
]);
const REGEX_AFTER_PUNCT = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^",
]);
const MULTI_PUNCT = [
  "...", "=>", "?.", "??", "&&", "||", "==", "!=", "<=", ">=", "++", "--",
  "+=", "-=", "*=", "/=", "%=", "**", "<<", ">>",
];

// ══════════════════════════════════════════════════════════════════════════
// 词法：把 JS 切成 token（跳过注释），顺带给出注释区间用于「生产侧剥注释」
// ══════════════════════════════════════════════════════════════════════════

/** 跳过 `${ … }` 表达式（含嵌套字符串/模板/花括号），返回 `}` 之后的下标。 */
function skipTemplateExpression(src, braceIdx) {
  let i = braceIdx;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") { i = skipQuoted(src, i); continue; }
    if (c === "{") { depth++; i++; continue; }
    if (c === "}") {
      depth--;
      i++;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  return i;
}

/** 跳过成对引号（含模板串的 `${}`），返回收尾引号之后的下标。 */
function skipQuoted(src, i) {
  const quote = src[i];
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (quote === "`" && c === "$" && src[i + 1] === "{") { i = skipTemplateExpression(src, i + 1); continue; }
    if (c === quote) return i + 1;
    i++;
  }
  return i;
}

/**
 * 扫描 JS/TS 源码。
 *
 * @param {string} src
 * @returns {{tokens: Array<{type: string, value: string, start: number, end: number}>,
 *            comments: Array<[number, number]>}}
 */
function scanJs(src) {
  const tokens = [];
  const comments = [];
  let i = 0;
  const n = src.length;
  const last = () => (tokens.length > 0 ? tokens[tokens.length - 1] : null);
  const push = (type, value, start) => tokens.push({ type, value, start, end: start + value.length });

  while (i < n) {
    const c = src[i];
    if (c === "\n" || c === "\r" || c === " " || c === "\t" || c === "\f" || c === "\v") { i++; continue; }

    if (c === "/" && src[i + 1] === "/") {
      const start = i;
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? n : nl;
      comments.push([start, i]);
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const start = i;
      const close = src.indexOf("*/", i + 2);
      i = close < 0 ? n : close + 2;
      comments.push([start, i]);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const start = i;
      i = skipQuoted(src, i);
      push(c === "`" ? "tpl" : "str", src.slice(start, i), start);
      continue;
    }
    if (c === "/") {
      const prev = last();
      const regexAllowed = !prev
        || (prev.type === "punct" && REGEX_AFTER_PUNCT.has(prev.value))
        || (prev.type === "id" && REGEX_AFTER_KEYWORDS.has(prev.value));
      if (regexAllowed) {
        const start = i;
        i++;
        let inClass = false;
        while (i < n) {
          const ch = src[i];
          if (ch === "\\") { i += 2; continue; }
          if (ch === "[") { inClass = true; i++; continue; }
          if (ch === "]") { inClass = false; i++; continue; }
          if (ch === "/" && !inClass) { i++; break; }
          if (ch === "\n") break;
          i++;
        }
        while (i < n && /[a-z]/i.test(src[i])) i++; // flags
        push("regex", src.slice(start, i), start);
        continue;
      }
      push("punct", "/", i);
      i++;
      continue;
    }
    if (/[A-Za-z_$\u0080-\uffff]/.test(c)) {
      const start = i;
      i++;
      while (i < n && /[\w$\u0080-\uffff]/.test(src[i])) i++;
      push("id", src.slice(start, i), start);
      continue;
    }
    if (/[0-9]/.test(c)) {
      const start = i;
      i++;
      while (i < n && /[\w.]/.test(src[i])) i++;
      push("num", src.slice(start, i), start);
      continue;
    }
    let multi = null;
    for (const p of MULTI_PUNCT) {
      if (src.startsWith(p, i)) { multi = p; break; }
    }
    if (multi) { push("punct", multi, i); i += multi.length; continue; }
    push("punct", c, i);
    i++;
  }
  return { tokens, comments };
}

/** 把注释区间替换成空格（保留换行 ⇒ 行号不变），用于生产侧正则扫描。 */
function maskComments(src, comments) {
  if (comments.length === 0) return src;
  const chars = src.split("");
  for (const [start, end] of comments) {
    for (let k = start; k < end; k++) {
      if (chars[k] !== "\n" && chars[k] !== "\r") chars[k] = " ";
    }
  }
  return chars.join("");
}

/** 行号索引：offset → 1-based 行号。 */
function makeLineOf(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 替身提取（scripts/agent-*.mjs）
// ══════════════════════════════════════════════════════════════════════════

function matchPairs(tokens, open, close) {
  const pair = new Array(tokens.length).fill(-1);
  const stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "punct") continue;
    if (t.value === open) stack.push(i);
    else if (t.value === close && stack.length > 0) {
      const o = stack.pop();
      pair[o] = i;
      pair[i] = o;
    }
  }
  return pair;
}

/**
 * `{` 前面出现这些 ⇒ 它是**对象字面量**，不是语句块/类体/函数体。
 *
 * 反例（都必须被排除）：`if (x) {`（前一个是 `)`）、`() => {`（前一个是 `=>`）、
 * `function f() {`（前一个是 `)`）、`class X {`（前一个是标识符）、`else {`。
 */
const LITERAL_PREV_PUNCT = new Set(["(", "=", ",", ":", "[", "{"]);

const LITERAL_PREV_ID = new Set(["return", "yield"]);

function looksLikeObjectLiteral(tokens, openIdx) {
  const prev = tokens[openIdx - 1];
  if (!prev) return true; // 文件以 `{` 开头 (不可能，但别崩)
  if (prev.type === "id") return LITERAL_PREV_ID.has(prev.value);
  if (prev.type === "punct") return LITERAL_PREV_PUNCT.has(prev.value);
  return false;
}

/**
 * 取对象字面量的**第一层**成员里「方法形态」的那些：
 *   `async foo(a) { … }` / `foo(a) { … }` / `get foo() { … }` /
 *   `foo: async (a) => …` / `foo: function (a) { … }`
 */
function membersOf(tokens, open, close, bracePair, parenPair, lineOf) {
  const out = [];
  let k = open + 1;
  while (k < close) {
    const t = tokens[k];
    if (t.type === "punct" && t.value === "{") {
      const nested = bracePair[k];
      k = nested > k ? nested + 1 : k + 1;
      continue;
    }
    let j = k;
    let isAsync = false;
    if (tokens[j] && tokens[j].type === "id" && tokens[j].value === "async") { isAsync = true; j++; }
    let accessor = null;
    if (tokens[j] && tokens[j].type === "id" && (tokens[j].value === "get" || tokens[j].value === "set")) {
      accessor = tokens[j].value;
      j++;
    }
    if (tokens[j] && tokens[j].type === "punct" && tokens[j].value === "*") j++;

    const keyTok = tokens[j];
    if (!keyTok) break;
    const isKey = keyTok.type === "id" || keyTok.type === "str" || keyTok.type === "num";
    if (!isKey) { k++; continue; }
    const name = keyTok.type === "str" ? keyTok.value.slice(1, -1) : keyTok.value;

    // 形态 A：方法简写 name(...) { ... }
    if (tokens[j + 1] && tokens[j + 1].type === "punct" && tokens[j + 1].value === "(") {
      const closeParen = parenPair[j + 1];
      const bodyOpen = closeParen > 0 ? tokens[closeParen + 1] : null;
      if (bodyOpen && bodyOpen.type === "punct" && bodyOpen.value === "{") {
        const bodyClose = bracePair[closeParen + 1];
        if (!CONTROL_WORDS.has(name)) {
          out.push({ name, isAsync, accessor, line: lineOf(keyTok.start) });
        }
        k = bodyClose > closeParen ? bodyClose + 1 : closeParen + 1;
        continue;
      }
      k = closeParen > 0 ? closeParen + 1 : j + 2;
      continue;
    }

    // 形态 B：属性名后跟函数值 name: [async] [function] (...) => …
    if (tokens[j + 1] && tokens[j + 1].type === "punct" && tokens[j + 1].value === ":") {
      let m = j + 2;
      if (tokens[m] && tokens[m].value === "async") m++;
      if (tokens[m] && tokens[m].value === "function") {
        m++;
        if (tokens[m] && tokens[m].type === "id") m++;
      }
      if (tokens[m] && tokens[m].type === "punct" && tokens[m].value === "(") {
        const cp = parenPair[m];
        const after = cp > 0 ? tokens[cp + 1] : null;
        if (after && after.type === "punct" && (after.value === "=>" || after.value === "{")) {
          if (!CONTROL_WORDS.has(name)) out.push({ name, isAsync: true, accessor, line: lineOf(keyTok.start) });
        }
        k = cp > 0 ? cp + 1 : m + 1;
        continue;
      }
    }
    k++;
  }
  return out;
}

/** 替身块的「归属名」：最近的具名 `function` + 最近的 `const/let/var` 变量名。 */
function ownerNamesOf(tokens, openIdx) {
  const names = [];
  for (let j = openIdx - 1; j >= 0; j--) {
    const t = tokens[j];
    if (t.type === "id" && t.value === "function") {
      let k = j + 1;
      if (tokens[k] && tokens[k].value === "*") k++;
      if (tokens[k] && tokens[k].type === "id") names.push(tokens[k].value);
      break;
    }
  }
  for (let j = openIdx - 1; j >= 0; j--) {
    const t = tokens[j];
    if (t.type === "id" && (t.value === "const" || t.value === "let" || t.value === "var")) {
      const k = j + 1;
      if (tokens[k] && tokens[k].type === "id") names.push(tokens[k].value);
      break;
    }
  }
  return names;
}

/**
 * 从一个 `scripts/agent-*.mjs` 里抽出「方法包」候选（≥2 个方法简写的对象字面量）。
 */
function extractStubCandidates(relFile, src) {
  const { tokens } = scanJs(src);
  const bracePair = matchPairs(tokens, "{", "}");
  const parenPair = matchPairs(tokens, "(", ")");
  const lineOf = makeLineOf(src);
  const candidates = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "punct" || t.value !== "{") continue;
    const close = bracePair[i];
    if (close < 0) continue;
    if (!looksLikeObjectLiteral(tokens, i)) continue;
    const methods = membersOf(tokens, i, close, bracePair, parenPair, lineOf);
    if (methods.length < 2) continue;
    candidates.push({
      file: relFile,
      line: lineOf(t.start),
      methods,
      ownerNames: ownerNamesOf(tokens, i),
    });
  }
  return candidates;
}

const normName = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * 角色归属：先看命名，再看「与生产调用集的方法名交集 ≥ 2」（工厂被改名时的兜底）。
 *
 * @returns {{role: object, by: string}|null}
 */
function attributeRole(candidate, prodMethods) {
  const owners = candidate.ownerNames.map(normName);
  for (const role of ROLE_SPECS) {
    if (owners.some((o) => role.nameRe.test(o))) return { role, by: "命名" };
  }
  const scored = ROLE_SPECS.map((role) => {
    const set = prodMethods.get(role.key) || new Map();
    const hit = candidate.methods.filter((m) => set.has(m.name)).length;
    return { role, hit };
  }).sort((a, b) => b.hit - a.hit);
  if (scored[0] && scored[0].hit >= 2 && (scored.length === 1 || scored[0].hit > scored[1].hit)) {
    return { role: scored[0].role, by: `方法名交集 ${scored[0].hit}` };
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════
// 生产调用面（apps/admin-api/src/modules/agent）
// ══════════════════════════════════════════════════════════════════════════

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      walkFiles(abs, out);
    } else {
      out.push(abs);
    }
  }
  return out;
}

/**
 * 同文件构造函数里的属性类型标注 → 用来把 TypeORM 仓储认出来。
 * `private readonly approvals: Repository<AgentApproval>` ⇒ 仓储，不是服务。
 */
function declaredTypeOf(maskedSrc, role) {
  const re = new RegExp(`(?:readonly|private|public|protected)\\s+${role}\\s*:\\s*([^,)\\n]+)`);
  const m = re.exec(maskedSrc);
  return m ? m[1].trim() : null;
}

const isRepositoryType = (type) => type !== null && /^Repository\s*</.test(type);

/**
 * 收集生产调用：`this.<role>.<method>(`。
 *
 * 正则要点（都是踩过的坑，别改窄）：
 *   · `this\\s*\\.\\s*<role>` —— 名字与点之间允许换行/空格；
 *   · `\\s*\\.\\s*` **之后再要求**方法名 —— `?.` 天然不匹配（`?` 不是 `.`），
 *     这就是「排除可选链」的实现；
 *   · `\\s*(` —— 方法名与括号之间允许换行（`this.sessionService\\n.foo(`）。
 */
function collectProduction(root) {
  const dir = join(root, PROD_DIR);
  const files = walkFiles(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"));
  const calls = new Map(ROLE_SPECS.map((r) => [r.key, new Map()])); // role → method → [site]
  const repoSkips = [];
  const relOf = (abs) => abs.slice(dir.length + 1).split(sep).join("/");

  for (const abs of files) {
    const raw = readFileSync(abs, "utf8");
    const { comments } = scanJs(raw);
    const masked = maskComments(raw, comments);
    const lineOf = makeLineOf(masked);
    for (const role of ROLE_SPECS) {
      const re = new RegExp(`this\\s*\\.\\s*${role.key}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, "g");
      const hits = [];
      let m;
      while ((m = re.exec(masked)) !== null) {
        hits.push({ method: m[1], file: relOf(abs), line: lineOf(m.index) });
      }
      if (hits.length === 0) continue;
      const type = declaredTypeOf(masked, role.key);
      if (isRepositoryType(type)) {
        repoSkips.push({ role: role.key, file: relOf(abs), type, count: hits.length });
        continue;
      }
      const bucket = calls.get(role.key);
      for (const hit of hits) {
        const sites = bucket.get(hit.method) || [];
        sites.push({ file: hit.file, line: hit.line });
        bucket.set(hit.method, sites);
      }
    }
  }
  return { files, calls, repoSkips, dir };
}

// ══════════════════════════════════════════════════════════════════════════
// 判据
// ══════════════════════════════════════════════════════════════════════════

function parseArgs(argv = []) {
  const opts = { root: DEFAULT_ROOT, rootExplicit: false, selftest: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") { opts.root = resolve(argv[++i] ?? "."); opts.rootExplicit = true; }
    else if (a.startsWith("--root=")) { opts.root = resolve(a.slice("--root=".length)); opts.rootExplicit = true; }
    else if (a === "--selftest") opts.selftest = true;
    else if (a === "--verbose") opts.verbose = true;
  }
  return opts;
}

/**
 * 结构面（一）：树完整性。
 *
 * **必须在任何扫描之前判**：`collectProduction()` 在缺目录时会抛 ENOENT，
 * 被 catch 成「生产侧扫描失败」——报错形态从「树不完整（用错 --root）」变成
 * 「守卫自己坏了」，人会被引到错误的排查方向。
 */
function treeProblems(root) {
  const missingDirs = [];
  for (const rel of [SCRIPTS_DIR, PROD_DIR]) {
    const abs = join(root, rel);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) missingDirs.push(rel);
  }
  if (missingDirs.length === 0) return [];
  return [
    `✖ 结构红：--root 指向的树不完整（缺目录 ${missingDirs.join("、")}）——扫不到事实就没有资格判绿`,
  ];
}

/** 结构面（二）：替身为 0 / 生产调用为 0 / 有替身的角色零调用。 */
function structuralProblems(opts, stubs, prod, stubScripts) {
  const problems = [];
  if (stubScripts === 0) {
    problems.push(`✖ 结构红：${SCRIPTS_DIR}/agent-*.mjs 一个都没扫到（扫描面塌陷）`);
  }
  if (prod.files.length === 0) {
    problems.push(`✖ 结构红：生产侧扫不到任何 TS（${PROD_DIR}）——扫描面塌陷`);
  }
  if (problems.length > 0) return problems;

  const totalCalls = [...prod.calls.values()].reduce((acc, m) => acc + m.size, 0);
  if (totalCalls === 0) {
    problems.push(
      "✖ 结构红：生产侧一处 this.<角色>.<方法>( 都没抓到——正则失效或扫描面塌陷（0 处 ≠ 没问题）",
    );
  }
  if (stubs.length === 0) {
    problems.push(
      "✖ 结构红：一个替身都没找到（scripts/agent-*.mjs 里没有 ≥2 方法的手写对象字面量，或命名/交集判定失效）——" +
        "「0 个替身 = 全部保真」是假绿",
    );
  }
  for (const stub of stubs) {
    const prodSet = prod.calls.get(stub.role.key) || new Map();
    if (prodSet.size === 0) {
      problems.push(
        `✖ 结构红：角色 ${stub.role.key} 有替身（${stub.file}:${stub.line}）却零生产调用——` +
          `要么扫描面塌陷，要么这个替身已无人使用（均需人工确认）`,
      );
    }
  }
  return problems;
}

function collectStubs(root, prod) {
  const scriptsDir = join(root, SCRIPTS_DIR);
  const files = existsSync(scriptsDir)
    ? readdirSync(scriptsDir).filter((f) => STUB_FILE_RE.test(f)).sort()
    : [];
  const stubs = [];
  const skipped = [];
  for (const file of files) {
    const rel = `${SCRIPTS_DIR}/${file}`;
    let candidates;
    try {
      candidates = extractStubCandidates(rel, readFileSync(join(scriptsDir, file), "utf8"));
    } catch (err) {
      skipped.push({ file: rel, reason: `解析失败：${err.message}` });
      continue;
    }
    for (const cand of candidates) {
      const attributed = attributeRole(cand, prod.calls);
      if (!attributed) {
        skipped.push({ file: rel, line: cand.line, reason: `非三类替身（${cand.methods.length} 个方法，归属名 ${cand.ownerNames.join("/") || "?"}）` });
        continue;
      }
      stubs.push({ ...cand, role: attributed.role, by: attributed.by });
    }
  }
  return { files, stubs, skipped };
}

function compare(stubs, prod) {
  const reds = [];
  const warns = [];
  for (const stub of stubs) {
    const prodSet = prod.calls.get(stub.role.key) || new Map();
    const stubNames = new Set(stub.methods.map((m) => m.name));
    for (const [method, sites] of [...prodSet.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (stubNames.has(method)) continue;
      reds.push({
        role: stub.role.key,
        method,
        stubFile: stub.file,
        stubLine: stub.line,
        site: sites[0],
        sites: sites.length,
      });
    }
    for (const m of stub.methods) {
      if (prodSet.has(m.name)) continue;
      warns.push({ role: stub.role.key, method: m.name, file: stub.file, line: m.line });
    }
  }
  return { reds, warns };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selftest) {
    selftest();
    return;
  }

  const tree = treeProblems(opts.root);
  if (tree.length > 0) {
    console.error(tree.join("\n"));
    process.exit(1);
  }

  let prod;
  try {
    prod = collectProduction(opts.root);
  } catch (err) {
    console.error(`✖ 结构红：生产侧扫描失败（${PROD_DIR}）：${err.message}`);
    process.exit(1);
  }
  const { files: stubScripts, stubs, skipped } = collectStubs(opts.root, prod);
  const problems = structuralProblems(opts, stubs, prod, stubScripts.length);

  console.log("\n=== 测试替身保真守卫（ADR-027：替身必须保真）===\n");
  console.log("判据：scripts/agent-*.mjs 里手写的 sessionService / boundary / approvals 对象字面量");
  console.log("      ⇄ apps/admin-api/src/modules/agent/ 下 this.<角色>.<方法>( 的生产调用（跨行匹配、排除 ?. 与注释）");
  console.log("      生产调用的方法替身必须有（缺即红）；替身多出的方法只 warn（可能是预留）。\n");

  console.log(`扫描面：${stubScripts.length} 个脚本（scripts/agent-*.mjs）· ${prod.files.length} 个生产 TS（${PROD_DIR}）`);

  console.log("\n替身清单：");
  if (stubs.length === 0) console.log("  （无）");
  for (const stub of stubs) {
    const owner = stub.ownerNames[0] ? `${stub.ownerNames[0]}()` : "（匿名）";
    console.log(
      `  · ${stub.file}:${stub.line}  ${owner} → ${stub.role.key}（按${stub.by}判定）  ${stub.methods.length} 个方法`,
    );
  }
  if (opts.verbose) {
    for (const s of skipped) console.log(`  ℹ 跳过 ${s.file}${s.line ? `:${s.line}` : ""} — ${s.reason}`);
  } else if (skipped.length > 0) {
    console.log(`  ℹ 另有 ${skipped.length} 个对象字面量不属于这三类替身（--verbose 看明细）`);
  }

  console.log("\n生产调用面：");
  for (const role of ROLE_SPECS) {
    const set = prod.calls.get(role.key) || new Map();
    const sites = [...set.values()].reduce((acc, v) => acc + v.length, 0);
    const skippedRepo = prod.repoSkips.filter((r) => r.role === role.key);
    const repoNote = skippedRepo.length > 0
      ? `（另跳过 ${skippedRepo.reduce((a, r) => a + r.count, 0)} 处：${skippedRepo.map((r) => `${r.file}=${r.type}`).join("、")}，仓储不是服务）`
      : "";
    console.log(`  · ${role.key} ${set.size} 个方法 / ${sites} 处调用${repoNote}`);
  }

  const { reds, warns } = compare(stubs, prod);

  const rolesWithStub = new Set(stubs.map((s) => s.role.key));
  for (const role of ROLE_SPECS) {
    if (rolesWithStub.has(role.key)) continue;
    const set = prod.calls.get(role.key) || new Map();
    if (set.size === 0) continue;
    console.log(
      `  ℹ 角色 ${role.key} 在本族没有替身可比对（生产 ${set.size} 个方法）——新增替身会被自动纳入；` +
        `这条不判红（本守卫只覆盖「有替身」的面）`,
    );
  }

  for (const stub of stubs) {
    const prodSet = prod.calls.get(stub.role.key) || new Map();
    const covered = [...prodSet.keys()].filter((m) => stub.methods.some((s) => s.name === m)).length;
    console.log(`  ${covered === prodSet.size ? "✔" : "✘"} ${stub.role.key} 保真 ${covered}/${prodSet.size}（${stub.file}:${stub.line}）`);
  }

  if (warns.length > 0) {
    console.log("\n⚠ warn（替身有、生产不用；不阻断，可能是预留）：");
    for (const w of warns) console.log(`  · ${w.role}.${w.method} — ${w.file}:${w.line}`);
  }

  if (problems.length > 0) {
    console.error("");
    for (const p of problems) console.error(p);
    process.exit(1);
  }

  if (reds.length > 0) {
    console.error("\n✘ 缺方法（替身跟不上生产 ⇒ 测试测的不是生产语义，真跑时崩在 CI）：");
    for (const r of reds) {
      console.error(
        `  · ${r.role}.${r.method} — 生产 ${r.site.file}:${r.site.line} 调了（共 ${r.sites} 处），` +
          `替身 ${r.stubFile}:${r.stubLine} 没有`,
      );
    }
    console.error("");
    console.error(`✖ 测试替身已腐烂：${reds.length} 个生产方法在替身里找不到（ADR-027）。`);
    console.error("  修法：在对应替身里补上同名方法（语义要**照生产契约**，不是随便返回 undefined）——");
    console.error("        2026-11-01 的 TypeError: this.sessionService.tryAppendEvent is not a function 就是这个形态。");
    console.error("  不要把生产调用改成 ?. 来「修绿」：那是把契约改成可选，事故照旧发生在真机上。");
    process.exit(1);
  }

  console.log(
    `\n✔ 测试替身保真：${stubs.length} 个替身 / ${[...prod.calls.values()].reduce((a, m) => a + m.size, 0)} 个生产方法全部覆盖（ADR-027）\n`,
  );
}

// ══════════════════════════════════════════════════════════════════════════
// selftest：真子进程跑**真脚本**（断言退出码 + 文本），每条负例配正例控制组
// ══════════════════════════════════════════════════════════════════════════

/** 造一棵最小仓库树：一个带替身的脚本 + 一个生产调用文件。 */
function fixtureFiles({
  stubName = "makeSessionService",
  stubMethods = ["requireById", "appendStep"],
  prodLines = ["this.sessionService.requireById(id);", "this.sessionService.appendStep(id, {});"],
  role = "sessionService",
  declType = "AgentSessionService",
  extraScripts = {},
  extraProd = {},
} = {}) {
  const stubBody = stubMethods
    .map((m) => `    async ${m}(a, b) { return null; },`)
    .join("\n");
  const stubScript = [
    "// fixture: 手写替身（形态照 scripts/agent-runtime-check.mjs）",
    `function ${stubName}() {`,
    "  return {",
    stubBody,
    "  };",
    "}",
    "",
    `const stub = ${stubName}();`,
    "export { stub };",
    "",
  ].join("\n");
  const prodFile = [
    "export class DemoRuntimeService {",
    "  constructor(",
    `    private readonly ${role}: ${declType},`,
    "  ) {}",
    "",
    "  async run(id: string) {",
    ...prodLines.map((l) => `    ${l}`),
    "  }",
    "}",
    "",
  ].join("\n");
  return {
    "package.json": { name: "fixture", private: true },
    "scripts/agent-demo-check.mjs": stubScript,
    [`apps/admin-api/src/modules/agent/runtime/demo-runtime.service.ts`]: prodFile,
    ...extraScripts,
    ...extraProd,
  };
}

function withFixture(files, fn) {
  const repo = makeFixtureRepo(files, { prefix: "stub-fidelity-" });
  try {
    fn(repo);
  } finally {
    repo.cleanup();
  }
}

const run = (root, extraArgs = []) => runGuard(SELF, { args: ["--root", root, ...extraArgs] });

function selftest() {
  const cases = [];

  // 0. 正例控制组：全部保真必须绿（否则「expectExit 永远红」也能让下面全过）
  cases.push({
    name: "正例控制组：替身覆盖全部生产调用 ⇒ 绿（code 0）",
    fn: () => withFixture(fixtureFiles(), (repo) => {
      const r = run(repo.dir);
      expectExit(r, { code: 0, contains: ["✔ 测试替身保真", "sessionService 保真 2/2"], absent: ["缺方法"], label: "控制组" });
    }),
  });

  // 1. 反证：删掉一个方法 ⇒ 必须红（这就是 2026-11-01 的形态，单行调用）
  cases.push({
    name: "反证：替身缺 requireById ⇒ 红，并点名「缺方法」",
    fn: () => withFixture(fixtureFiles({ stubMethods: ["appendStep", "findById"] }), (repo) => {
      const r = run(repo.dir);
      expectExit(r, { code: 1, contains: ["缺方法", "sessionService.requireById"], label: "缺方法（单行）" });
    }),
  });

  // 2. 反证（复刻事故形态）：生产调用**换行**写 ⇒ 仍必须抓到
  cases.push({
    name: "反证：生产调用换行（this.sessionService\\n  .tryAppendEvent(）⇒ 仍抓到",
    fn: () => withFixture(
      fixtureFiles({
        stubMethods: ["requireById", "findById"],
        prodLines: ["this.sessionService.requireById(id);", "await this.sessionService", "  .tryAppendEvent(id, {});"],
      }),
      (repo) => {
        const r = run(repo.dir);
        expectExit(r, { code: 1, contains: ["缺方法", "sessionService.tryAppendEvent"], label: "缺方法（换行）" });
      },
    ),
  });

  // 3. 可选链是显式的「可以没有」⇒ 不要求替身有
  cases.push({
    name: "判据边界：?. 可选链不算契约（替身没有也绿）",
    fn: () => withFixture(
      fixtureFiles({ prodLines: ["this.sessionService.requireById(id);", "this.sessionService?.optionalProbe?.(id);"] }),
      (repo) => {
        const r = run(repo.dir);
        expectExit(r, { code: 0, contains: ["✔ 测试替身保真"], absent: ["缺方法", "optionalProbe"], label: "?. 排除" });
      },
    ),
  });

  // 4. 注释里的调用不算（否则文档会把守卫喂成假红）
  cases.push({
    name: "判据边界：注释里的 this.sessionService.ghost( 不算调用",
    fn: () => withFixture(
      fixtureFiles({ prodLines: ["// this.sessionService.ghost(id);", "this.sessionService.requireById(id);"] }),
      (repo) => {
        const r = run(repo.dir);
        expectExit(r, { code: 0, contains: ["✔ 测试替身保真"], absent: ["缺方法", "ghost"], label: "注释排除" });
      },
    ),
  });

  // 5. 替身多出的方法 ⇒ 只 warn，不红
  cases.push({
    name: "双向：替身多出的方法只 warn（预留），退出码仍 0",
    fn: () => withFixture(
      fixtureFiles({ stubMethods: ["requireById", "appendStep", "claimAutoResume"] }),
      (repo) => {
        const r = run(repo.dir);
        expectExit(r, { code: 0, contains: ["warn", "claimAutoResume"], absent: ["缺方法"], label: "warn" });
      },
    ),
  });

  // 6. 结构红：找不到替身
  cases.push({
    name: "结构红：脚本里没有手写替身（方法 < 2）⇒ 红，不许「0 个替身 = 全绿」",
    fn: () => withFixture(
      fixtureFiles({ stubMethods: ["requireById"] }),
      (repo) => {
        const r = run(repo.dir);
        expectExit(r, { code: 1, contains: ["结构红", "一个替身都没找到"], label: "无替身" });
      },
    ),
  });

  // 7. 结构红：生产调用面塌陷
  cases.push({
    name: "结构红：生产侧零调用（扫描面塌陷）⇒ 红",
    fn: () => withFixture(
      fixtureFiles({ prodLines: ["return id;"] }),
      (repo) => {
        const r = run(repo.dir);
        expectExit(r, { code: 1, contains: ["结构红", "扫描面塌陷"], label: "生产零调用" });
      },
    ),
  });

  // 8. 结构红：--root 指向的树不完整
  cases.push({
    name: "结构红：--root 树不完整（缺 apps/admin-api/src/modules/agent）⇒ 红",
    fn: () => withFixture(
      { "package.json": { name: "bare" }, "scripts/agent-demo-check.mjs": "export const x = 1;\n" },
      (repo) => {
        const r = run(repo.dir);
        expectExit(r, { code: 1, contains: ["结构红", "树不完整"], label: "树不完整" });
      },
    ),
  });

  // 9. TypeORM 仓储排除 + 正例对照（同形，只换**声明类型**）
  //
  // 真树里的形态：`this.approvals` 在两个文件里是**两个不同的东西**——
  // `runtime/agent-approvals.service.ts` 里是 `Repository<AgentApproval>`（仓储，
  // `create/save/findOne/update/insert` 全是 TypeORM 的方法），
  // `agent.controller.ts` 里才是 `AgentApprovalsService`。判据必须按**声明类型**分，
  // 不能按文件名白名单，也不能把两边的调用并成一个集合。
  const approvalsFixture = (repoDeclType) => ({
    "package.json": { name: "fixture", private: true },
    "scripts/agent-demo-check.mjs": [
      "function makeApprovals() {",
      "  return {",
      "    async listForSession(id) { return []; },",
      "    async hasPendingForSession(id) { return false; },",
      "  };",
      "}",
      "export { makeApprovals };",
      "",
    ].join("\n"),
    "apps/admin-api/src/modules/agent/runtime/agent-approvals.service.ts": [
      `export class AgentApprovalsService {`,
      "  constructor(",
      `    private readonly approvals: ${repoDeclType},`,
      "  ) {}",
      "",
      "  async request(sessionId: string) {",
      "    this.approvals.create({ sessionId });",
      "  }",
      "}",
      "",
    ].join("\n"),
    "apps/admin-api/src/modules/agent/agent.controller.ts": [
      "export class AgentController {",
      "  constructor(",
      "    private readonly approvals: AgentApprovalsService,",
      "  ) {}",
      "",
      "  async list(id: string) {",
      "    return this.approvals.listForSession(id);",
      "  }",
      "}",
      "",
    ].join("\n"),
  });
  cases.push({
    name: "判据：this.approvals 声明为 Repository<…> ⇒ 视为仓储，不要求替身有 create",
    fn: () => withFixture(approvalsFixture("Repository<AgentApproval>"), (repo) => {
      const r = run(repo.dir);
      expectExit(r, { code: 0, contains: ["✔ 测试替身保真", "仓储不是服务"], absent: ["缺方法"], label: "仓储排除" });
    }),
  });
  cases.push({
    name: "判据对照：同一形态把类型换成 AgentApprovalsService ⇒ 必须红（排除有齿）",
    fn: () => withFixture(approvalsFixture("AgentApprovalsService"), (repo) => {
      const r = run(repo.dir);
      expectExit(r, { code: 1, contains: ["缺方法", "approvals.create"], label: "仓储排除对照" });
    }),
  });

  // 10. 工厂改名也抓得住（靠方法名交集的兜底判定）
  cases.push({
    name: "判据：替身工厂改名为 makeHarness ⇒ 按方法名交集仍判定角色并报缺",
    fn: () => withFixture(
      fixtureFiles({
        stubName: "makeHarness",
        stubMethods: ["requireById", "appendStep"],
        prodLines: ["this.sessionService.requireById(id);", "this.sessionService.appendStep(id, {});", "this.sessionService.tryAppendEvent(id, {});"],
      }),
      (repo) => {
        const r = run(repo.dir);
        expectExit(r, { code: 1, contains: ["缺方法", "sessionService.tryAppendEvent", "方法名交集"], label: "改名兜底" });
      },
    ),
  });

  // 11. 无关替身（makeAi 形态）不得被误认成三类替身之一
  cases.push({
    name: "范围：makeAi 这类无关替身（与生产零交集）不被当成会话替身",
    fn: () => withFixture(
      fixtureFiles({
        stubMethods: ["requireById", "appendStep"],
        extraScripts: {
          "scripts/agent-demo-extra.mjs": [
            "function makeAi() {",
            "  return {",
            "    async chatMultimodal(req) { return req; },",
            "    async getActiveRoute() { return { provider: 'qwen' }; },",
            "  };",
            "}",
            "export { makeAi };",
            "",
          ].join("\n"),
        },
      }),
      (repo) => {
        const r = run(repo.dir);
        expectExit(r, { code: 0, contains: ["✔ 测试替身保真", "1 个替身"], absent: ["chatMultimodal"], label: "无关替身" });
      },
    ),
  });

  // 12. 根解析不跟 cwd：从临时目录（不是仓库根）跑，--root 仍然生效
  cases.push({
    name: "参数：--root 从任意 cwd 都生效（不吃掉路径、不回落 process.cwd()）",
    fn: () => withFixture(fixtureFiles({ stubMethods: ["appendStep", "findById"] }), (repo) => {
      const r = runGuard(SELF, { args: ["--root", repo.dir], cwd: repo.dir });
      expectExit(r, { code: 1, contains: ["缺方法", "sessionService.requireById"], label: "--root + cwd" });
    }),
  });

  cases.push({
    name: "参数：--root=<dir> 等号形态同样生效",
    fn: () => withFixture(fixtureFiles({ stubMethods: ["appendStep", "findById"] }), (repo) => {
      const r = runGuard(SELF, { args: [`--root=${repo.dir}`] });
      expectExit(r, { code: 1, contains: ["缺方法", "sessionService.requireById"], label: "--root= 形态" });
    }),
  });

  const failed = reportCases(cases, { title: "check-agent-stub-fidelity selftest" });
  if (failed > 0) process.exit(1);
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === resolve(SELF);
if (isEntry) main();

export { scanJs, extractStubCandidates, collectProduction, parseArgs, attributeRole };
