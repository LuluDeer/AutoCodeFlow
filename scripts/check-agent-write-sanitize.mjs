#!/usr/bin/env node
/**
 * Agent 主表**写入点脱敏**守卫：防止 `agent_steps.content` /
 * `agent_steps.summary`、`agent_tool_calls.errorMessage` 以及 `agent_sessions` 的
 * `resultJson` / `summary` / `errorMessage` / `contextJson` 再次变成明文长期留存面。
 *
 * 第三批（S7-G1 第七阶段）扩了两列，理由都不是「顺手」：
 *   · `agent_steps.summary`（折叠摘要）与 `agent_sessions.contextJson`（用户上下文）
 *     这两列此前**零脱敏**，而它们正好是投影最后补上的两类正文的来源列——正文进
 *     事件（脱敏副本）之后，主表若仍是明文，两侧对同一句话就有两份原文：投影切上
 *     读路径的那一天，模型看到的内容会静默地变一次（明文 → `[REDACTED]`）。
 *     第 3 节「为什么主表的泄密面比事件表更大」对它俩同样成立，且更重：
 *     `agent_sessions` 的行**永不删除**。
 *
 * ## 这条缺陷是怎么长出来的（本脚本存在的理由）
 *
 * `apps/admin-api/src/modules/agent/entities/agent-step.entity.ts` 的列注释逐字写着
 * 「消息正文。**已脱敏**（复用 `AiService.sanitizeLogs` 的脱敏口径）」，
 * 而实现是 `content: input.content ?? null`——**原样写入、零脱敏**。
 * 全模块 grep 下来，脱敏实现只有 tool-executor 一处，且只作用于 args/result。
 *
 * 也就是说：**注释承诺的安全控制在代码里不存在**。这是本仓纪律 R2b 的标本
 * （不许留一句与代码相反的注释）。
 *
 * ## 第二批扩面：会话行的三列（`agent_sessions`）
 *
 * 上一批修的是步骤/台账两列，实施方同时上报了**相邻面**：会话行的
 * `resultJson`（`{ conclusion: 模型最终结论 }`）、`summary`（结论首行 200 字）、
 * `errorMessage` 三列同样原样入库。这不是「顺手补一下」——
 * **`agent_sessions` 的行永不删除**（保留期只清 steps / tool_calls /
 * approvals / events，谓词里会话表只作为存在性判断出现）⇒ 明文一旦写入就是
 * **永久留存**，没有任何窗口会把它带走。三个字段还各有外发读面：
 * `conclusion` 被执行详情/导出 API 原样返回、`summary` 与 `errorMessage`
 * 进通知正文（出口层有兜底，**库里的原文没有**）。
 *
 * 扩面方式与第一批**同一套判据**（从 `@InjectRepository` 绑定推仓储写入 →
 * 对象字面量顶层属性 → 值表达式里必须有脱敏调用），只是多登记三个
 * 「实体 + 属性」。判据本身没有放宽，也没有另写一套。
 *
 * 为什么主表的泄密面比事件表更大（不是「顺手补一下」）
 *
 * 事件表 `agent_events` 的正文自 S7-G1 第五阶段起就走 `redactEventBodyText`
 * （= 共享实现的 `sanitizeString`）。但**主表**此前是明文：
 *   · **保留期**：事件表固定 180 天；主表是**分档且不完整**的——终态会话的
 *     steps 只留 90 天、read 档 tool_calls 只留 30 天，而**非终态会话**的
 *     steps / read 档 tool_calls 压根不在清理谓词内（谓词要求会话终态）
 *     ⇒ 那部分事实上**没有保留期**。write/dangerous 档 180 天。
 *     明文在主表里的暴露窗口不短于事件表，在无保留期那部分反而更长。
 *   · **读面**：主表是**被读回来再外发**的权威源——`rebuildMessages` 把
 *     `step.content` 与台账行 `errorMessage` 回灌给模型、`GET
 *     /agent/sessions/:id/export` 与详情 API 原样返回 steps / toolCalls、
 *     投影在事件正文缺失时回读主表行来渲染。事件表那份脱敏副本管不到这三跳。
 *
 * ## 判据（三条；任何一条不满足即红）
 *
 *   ① **写入点必须存在且可定位**：定位 `agent_steps` / `agent_tool_calls` /
 *      `agent_sessions` 这三张表在仓储层上的**写入调用**（`repo.create(…)` /
 *      `repo.update(…, { … })` / `em.create(Entity, { … })`），再在它们的对象
 *      字面量里找被守的属性（`content` / `errorMessage` / `resultJson` / `summary`）。
 *      定位不到 ⇒ **结构红**（正则失配 / 扫描面塌陷），**不许**静默通过。
 *
 *   ② **写入表达式必须过脱敏函数**：该属性的**值表达式**里必须出现
 *      `sanitize*` / `redact*` 的调用。判据是**结构**的（表达式里有没有那个
 *      调用），不是「这个文件 import 了什么」——import 了但没在写入处用，
 *      同样是明文。
 *
 *   ③ **脱敏函数必须真的存在且被扫到**：扫描面里必须能找到至少一个脱敏函数
 *      的**定义**（`sanitize*` / `redact*`），且本守卫扫过的文件数不得低于
 *      规模下界。找不到 ⇒ **结构红**（扫描面塌陷）。
 *
 * ## 为什么只认「仓储写入调用」这种形态（判据不宽的取舍）
 *
 * `content:` / `errorMessage:` 这两个属性名在 agent 模块里**到处**都是：
 * DTO 字段声明、实体列声明、LLM 消息对象 `{ role, content }`、投影渲染对象……
 * 若按属性名全局匹配，会把 90+ 处**根本不是写库**的地方判成「明文写入点」
 * （实测如此）。所以判据必须**锚在写入调用上**：
 *   · 仓储变量由 `@InjectRepository(Entity)` 绑定（`this.steps` /
 *     `this.toolCalls`）——从绑定关系推出「哪个变量写哪张表」；
 *   · 事务内的 `em.create(Entity, { … })` 由**实体名**锚定。
 * 这样「表 → 写入调用 → 目标属性」是一条**可追溯的链**，而不是同名属性的
 * 全局 grep。
 *
 * ## 结构红的三种形态（都必须红，不许当绿）
 *   · 写入点找不到（正则失配 / 改名 / 写入表达式形状变了）；
 *   · 脱敏函数找不到（规则被搬走 / 改名 / 扫描面塌陷）；
 *   · 扫描文件数低于下界（目录改名 / 扫描路径失效）。
 *
 * 这三种「红」与「发现明文写入点」是**不同的错**，报告里分开说——
 * 前者是守卫瞎了，后者是代码漏了。
 *
 * ## 已知盲区（如实）
 *   · 只认「仓储写入调用 + 对象字面量属性」这一种形态。若把列值先存进变量
 *     再以变量名传入（`const c = input.content; repo.create({ content: c })`），
 *     本守卫**看不见**——那种形态在 TypeORM 写入点里罕见，但**不是零**。
 *   · 判据是「表达式里出现脱敏调用」，不判「脱敏是不是在调用**之后**」，
 *     也不判「脱敏函数内部有没有规则」。后者由
 *     `scripts/check-sanitize-parity.mjs` 守（规则集只允许有一份）。
 *   · **同名两列，纪律不同**：`agent_tool_calls.resultJson` **不**在本守卫的
 *     判据里——它是工具结果，上游（`ToolExecutorService`）已过 `sanitizeResult`，
 *     本层**故意不**再脱敏（幂等但浪费，且结构脱敏跑第二遍会把成品再打一次码）；
 *     守卫若把它也判成「必须脱敏」，就会逼着人加一次**冗余**脱敏。
 *     而 `agent_sessions.resultJson` **在**判据里——那一列的上游是模型原文、
 *     零脱敏。名单按「实体 + 属性」登记，所以两列能被分开判。
 *   · QueryBuilder 形态（`createQueryBuilder().update(AgentSession).set({ … })`）
 *     不在判据里：agent 模块里该形态只写 status / 计数类列，不写正文。将来若
 *     有人用它写正文列，本守卫**看不见**——与「先存变量再传入」同类的盲区。
 *
 * 用法：
 *   node scripts/check-agent-write-sanitize.mjs              # 守卫（真仓库）
 *   node scripts/check-agent-write-sanitize.mjs --selftest    # 守卫自检（含反证）
 *   node scripts/check-agent-write-sanitize.mjs --root <dir>  # 以 <dir> 为仓库根
 *
 * 零依赖：只用 node 内置模块 + 本仓的 `scripts/lib/guard-selftest.mjs`。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  REPO_ROOT,
  expectExit,
  makeFixtureRepo,
  reportCases,
  runGuard,
} from "./lib/guard-selftest.mjs";

const SELF = fileURLToPath(import.meta.url);
/** 缺省根 = 仓库根（按本脚本位置锚定），不是 `process.cwd()`。 */
const DEFAULT_ROOT = REPO_ROOT;

/** 扫描面：agent 模块的非测试 TS。 */
const AGENT_REL = join("apps", "admin-api", "src", "modules", "agent");

/**
 * 规模下界：真实仓库的 agent 模块有 29 个非测试 TS。
 * 扫描面收窄（目录改名 / 正则失效）不能静默变成「零命中全绿」。
 */
const MIN_SCANNED_FILES = 20;

/**
 * 被守的表与列：实体名 → 该表上必须脱敏的属性。
 *
 * 这些属性在代码里都以**属性名**出现（TypeORM 的 `create(Entity, { content: … })` /
 * `update(…, { errorMessage: … })`），表名只出现在实体声明与仓储注入处。
 * 按「实体 → 写入调用 → 属性」这条链定位，才能覆盖全部写入点又不误伤 DTO。
 *
 * `agent_sessions` 的三列为什么也在名单里（第二批扩面）：
 *   · 该表**行永不删除** ⇒ 明文即永久留存，比带保留期的步骤行更严重；
 *   · `resultJson.conclusion` 进执行详情/导出 API、`summary` / `errorMessage`
 *     进通知正文——三条外发路径都没有第二份副本可救。
 */
const GUARDED_ENTITIES = [
  {
    entity: "AgentStep",
    id: "agent_steps.content",
    prop: "content",
    /** 写入形态（出现在报告里，让红字自带上下文）。 */
    writeHint: "Repository<AgentStep>.create(…) / .update(…, { … })",
  },
  {
    // 第三批（S7-G1 第七阶段）：折叠步的摘要正文。
    //
    // 为什么突然要守它：此前它只进 `rebuildMessages`（回灌给模型），第七阶段起
    // 它**同时**进 `agent_events.payload.body.summary`（脱敏副本）。两处对同一句话
    // 给出不同文本的那一刻，投影与快照重建就对不上——而这不是「渲染差异」，是
    // 「同一事实两份原文」。规则只有一份（`redactForStorage`：只打码、不截断），
    // 两侧各调一次，判别式因此恒成立。
    entity: "AgentStep",
    id: "agent_steps.summary",
    prop: "summary",
    writeHint: "Repository<AgentStep>.create(…)（appendStepOnce 的折叠摘要写入）",
  },
  {
    entity: "AgentToolCall",
    id: "agent_tool_calls.errorMessage",
    prop: "errorMessage",
    writeHint: "Repository<AgentToolCall>.create(…) / .update(…, { … })",
  },
  {
    entity: "AgentSession",
    id: "agent_sessions.resultJson",
    prop: "resultJson",
    writeHint:
      "Repository<AgentSession>.update(…, { … })（finish() 的终态写入）",
  },
  {
    entity: "AgentSession",
    id: "agent_sessions.summary",
    prop: "summary",
    writeHint:
      "Repository<AgentSession>.update(…, { … })（finish() 的终态写入）",
  },
  {
    entity: "AgentSession",
    id: "agent_sessions.errorMessage",
    prop: "errorMessage",
    writeHint:
      "Repository<AgentSession>.update(…, { … })（finish() / sweepStaleRunning）",
  },
  {
    // 第三批（S7-G1 第七阶段）：会话上下文（用户提供的数据）。
    //
    // 三跳外发：`rebuildMessages` 拼进首条 system 消息再发给 provider、导出/详情
    // API 原样返回、投影回读它渲染。而本表**行永不删除** ⇒ 明文即永久留存。
    // 脱敏用**结构**规则（`redactContextForStorage` → `sanitizeResult`），与写进
    // `payload.body.context` 的掩码同一份。
    entity: "AgentSession",
    id: "agent_sessions.contextJson",
    prop: "contextJson",
    writeHint: "Repository<AgentSession>.create(…)（create() 的会话创建写入）",
  },
];

/** 脱敏函数的**名字形状**：判据②/③ 认这个前缀（`sanitize*` / `redact*`）。 */
const SANITIZER_RE = /\b(?:sanitize|redact)[A-Za-z0-9_]*\s*\(/;

/** 脱敏函数的**定义**形状（判据③：扫描面里必须能找到定义，不是只有调用）。 */
const SANITIZER_DEF_RE =
  /(?:export\s+)?(?:function|const|let)\s+((?:sanitize|redact)[A-Za-z0-9_]*)/g;

/** 注释里的字面量不算写入点（注释会说「content: …」的形态）。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 递归列出目录下所有 .ts 文件（跳过 spec 与 node_modules）。 */
function walkTs(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      walkTs(p, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 解析一次调用的实参（按**顶层**逗号切分）。
 *
 * @param {string} code 源码
 * @param {number} openIdx `(` 的下标
 * @returns {{text: string, start: number, end: number}[]} 各实参
 */
function parseCallArgs(code, openIdx) {
  const args = [];
  let i = openIdx + 1;
  let depth = 0;
  let inStr = null;
  let argStart = i;
  while (i < code.length) {
    const ch = code[i];
    if (inStr) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === inStr) inStr = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      i += 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) {
        args.push({ text: code.slice(argStart, i).trim(), start: argStart, end: i });
        return args;
      }
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === "," && depth === 0) {
      args.push({ text: code.slice(argStart, i).trim(), start: argStart, end: i });
      argStart = i + 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return args;
}

/**
 * 找出源码里**顶层**对象字面量的属性赋值。
 *
 * 只认字面量**第一层**的属性（`{ content: … }`）——嵌套一层（`{ meta: { content: … } }`）
 * 不会被误认。
 *
 * @param {string} literal 字面量文本（不含外层花括号）
 * @returns {{prop: string, value: string}[]}
 */
function topLevelProps(literal) {
  const out = [];
  let i = 0;
  let depth = 0;
  let inStr = null;
  while (i < literal.length) {
    const ch = literal[i];
    if (inStr) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === inStr) inStr = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      i += 1;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0) {
      const m = /^([A-Za-z_$][\w$]*)\s*:\s*/.exec(literal.slice(i));
      if (m) {
        const valueStart = i + m[0].length;
        // 取值表达式：从 valueStart 到**顶层**逗号/结束
        const value = readValueExpr(literal, valueStart);
        out.push({ prop: m[1], value: value.text });
        i = value.end;
        continue;
      }
      // **简写属性**（`{ errorMessage }`）：值就是属性名本身。
      // 漏掉它 = 漏掉一整类写入形态——`update(where, { status, errorMessage })`
      // 这种写法在本仓真实存在（settleToolCallByApprovalId）。
      const s = /^([A-Za-z_$][\w$]*)\s*(?=,|$)/.exec(literal.slice(i));
      if (s) {
        out.push({ prop: s[1], value: s[1] });
        i += s[0].length;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

/** 从 `start` 起读一个值表达式（到顶层逗号或字面量结束为止）。 */
function readValueExpr(literal, start) {
  let i = start;
  let depth = 0;
  let inStr = null;
  while (i < literal.length) {
    const ch = literal[i];
    if (inStr) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === inStr) inStr = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      i += 1;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      if (depth === 0) break;
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === "," && depth === 0) break;
    i += 1;
  }
  return { text: literal.slice(start, i).trim(), end: i };
}

/**
 * 找出「哪个仓储变量写哪张表」。
 *
 * 依据是 Nest 的注入语法：`@InjectRepository(AgentStep)` 紧跟着
 * `private readonly steps: Repository<AgentStep>`。变量名与实体名的对应关系
 * **由代码本身**给出，守卫不猜。
 *
 * @returns {Map<string, string>} 变量名 → 实体名
 */
function findRepoBindings(code) {
  const bindings = new Map();
  const re =
    /@InjectRepository\(\s*([A-Za-z_$][\w$]*)\s*\)[\s\S]{0,120}?(?:private|public|protected)?\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*:\s*Repository\s*<\s*\1\s*>/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    bindings.set(m[2], m[1]);
  }
  return bindings;
}

/**
 * 在一份源码里找出某实体在某属性上的**全部写入点**。
 *
 * 定位链：`repo.create({ … })` / `repo.update(where, { … })` /
 * `em.create(Entity, { … })` → 对象字面量 → 目标属性。
 *
 * @returns {{file: string, line: number, value: string, sanitized: boolean}[]}
 */
function findWritePoints(code, relPath, spec) {
  const points = [];
  const bindings = findRepoBindings(code);
  const literals = [];

  // ① 仓储写入：`alias.create(...)` / `alias.update(...)`
  for (const [alias, entity] of bindings) {
    if (entity !== spec.entity) continue;
    const re = new RegExp(`\\b${alias}\\s*\\.\\s*(create|update)\\s*\\(`, "g");
    let m;
    while ((m = re.exec(code)) !== null) {
      const openIdx = m.index + m[0].length - 1;
      const args = parseCallArgs(code, openIdx);
      if (m[1] === "create") {
        // `create({ … })` 或 `create(Entity, { … })`
        const literalArg = args.find((a) => a.text.startsWith("{"));
        if (!literalArg) continue;
        literals.push(literalArg);
      } else {
        // `update(where, { … })`：取最后一个对象字面量实参
        const literalArg = args.filter((a) => a.text.startsWith("{")).pop();
        if (!literalArg) continue;
        literals.push(literalArg);
      }
    }
  }

  // ② 事务内写入：`em.create(Entity, { … })`（实体名显式给出）
  const createRe = new RegExp(
    `\\.\\s*create\\s*\\(\\s*${spec.entity}\\s*\\,`,
    "g",
  );
  let cm;
  while ((cm = createRe.exec(code)) !== null) {
    const openIdx = code.indexOf("(", cm.index);
    const args = parseCallArgs(code, openIdx);
    const literalArg = args.find((a) => a.text.startsWith("{"));
    if (!literalArg) continue;
    literals.push(literalArg);
  }

  for (const lit of literals) {
    // 字面量文本（去掉外层花括号）
    const inner = lit.text.slice(1, -1);
    for (const prop of topLevelProps(inner)) {
      if (prop.prop !== spec.prop) continue;
      if (prop.value.length === 0) continue;
      points.push({
        file: relPath,
        line: code.slice(0, lit.start).split("\n").length,
        value: prop.value,
        sanitized: SANITIZER_RE.test(prop.value),
      });
    }
  }
  return points;
}

/**
 * 扫一遍仓库，返回判据结果。
 *
 * @returns {{scannedFiles: number, sanitizerDefinitions: number,
 *            sanitizersFound: string[],
 *            columns: {id: string, prop: string, writeHint: string,
 *                      points: object[], unsanitized: object[]}[]}}
 */
export function scanRepo(root) {
  const agentDir = join(root, AGENT_REL);
  const files = walkTs(agentDir);
  const sanitizersFound = new Set();
  let sanitizerDefinitions = 0;

  const columns = GUARDED_ENTITIES.map((spec) => {
    const points = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const code = stripComments(src);
      const relPath = relative(root, file).split(sep).join("/");
      for (const m of code.matchAll(SANITIZER_DEF_RE)) {
        sanitizerDefinitions += 1;
        sanitizersFound.add(`${relPath}:${m[1]}`);
      }
      points.push(...findWritePoints(code, relPath, spec));
    }
    return {
      id: spec.id,
      prop: spec.prop,
      writeHint: spec.writeHint,
      points,
      unsanitized: points.filter((p) => !p.sanitized),
    };
  });

  return {
    scannedFiles: files.length,
    sanitizerDefinitions,
    sanitizersFound: [...sanitizersFound].sort(),
    columns,
  };
}

/**
 * 判据（纯函数，便于 selftest 喂变异源码）。
 *
 * @returns {{kind: "structural"|"leak", message: string}[]} 空数组 = 绿
 */
export function evaluate(scan) {
  const problems = [];

  // ── 判据③：扫描面 / 脱敏函数不得塌陷（结构红）────────────────────────
  if (scan.scannedFiles < MIN_SCANNED_FILES) {
    problems.push({
      kind: "structural",
      message:
        `扫描面塌陷：只扫到 ${scan.scannedFiles} 个 agent 模块 TS 文件（下界 ${MIN_SCANNED_FILES}）` +
        "——目录改名或扫描路径失效，判据已失效（不许静默通过）",
    });
  }
  if (scan.sanitizerDefinitions === 0) {
    problems.push({
      kind: "structural",
      message:
        "扫描面里找不到任何脱敏函数的**定义**（sanitize* / redact*）——" +
        "规则被搬走或改名了，判据已失效（不许静默通过）",
    });
  }

  // ── 判据①/②：写入点必须存在，且必须过脱敏────────────────────────────
  for (const col of scan.columns) {
    if (col.points.length === 0) {
      problems.push({
        kind: "structural",
        message:
          `找不到 ${col.id} 的写入点（形态：${col.writeHint}）——` +
          "正则失配或写入形状变了，判据已失效（不许静默通过）",
      });
      continue;
    }
    for (const p of col.unsanitized) {
      problems.push({
        kind: "leak",
        message:
          `${col.id} 的写入点未脱敏：${p.file}:${p.line} ` +
          `${col.prop}: ${p.value.replace(/\s+/g, " ").slice(0, 120)}`,
      });
    }
  }

  return problems;
}

/** 主流程：跑判据并按结果退出。 */
export function main(argv = []) {
  // 注意：入口传进来的已经是 `process.argv.slice(2)`，这里**不能再 slice**——
  // 多切一次会把 `--root <dir>` 的 `--root` 切掉，root 回落成默认仓库根，
  // 于是「扫描面塌陷」那条结构红永远不会触发（守卫变瞎）。
  const args = argv.slice();
  let root = DEFAULT_ROOT;
  const rootIdx = args.findIndex((a) => a === "--root" || a.startsWith("--root="));
  if (rootIdx >= 0) {
    const raw = args[rootIdx];
    root = resolve(
      raw === "--root"
        ? args[rootIdx + 1] ?? DEFAULT_ROOT
        : raw.slice("--root=".length),
    );
  }
  const scan = scanRepo(root);
  const problems = evaluate(scan);

  if (problems.length === 0) {
    const pointCount = scan.columns.reduce((n, c) => n + c.points.length, 0);
    console.log(
      "✔ check-agent-write-sanitize 全绿：" +
        `扫描 ${scan.scannedFiles} 个 agent 模块 TS 文件，` +
        `${pointCount} 个受守卫的写入点全部经过脱敏` +
        `（${scan.sanitizersFound.length} 个脱敏函数定义）`,
    );
    return 0;
  }

  const structural = problems.filter((p) => p.kind === "structural");
  const leaks = problems.filter((p) => p.kind === "leak");
  if (structural.length > 0) {
    console.error("✖ check-agent-write-sanitize 结构红（判据失效，不许当绿）：");
    for (const p of structural) console.error(`  · ${p.message}`);
  }
  if (leaks.length > 0) {
    console.error("✖ check-agent-write-sanitize 发现未脱敏的写入点：");
    for (const p of leaks) console.error(`  · ${p.message}`);
  }
  console.error(
    "  修法：写入点必须调用脱敏函数（复用 " +
      "apps/admin-api/src/modules/agent/tools/agent-sanitize.util.ts 的 sanitizeString、" +
      "runtime/agent-session.service.ts 的 redactEventBodyText（有界事件 payload）或 " +
      "redactForStorage / redactNullableText / redactSessionResultForStorage" +
      "（主表正文：**只打码、不截断**），不许新写规则。",
  );
  return 1;
}

// ── selftest ────────────────────────────────────────────────────────────

const SERVICE_REL =
  "apps/admin-api/src/modules/agent/runtime/agent-session.service.ts";
const UTIL_REL = "apps/admin-api/src/modules/agent/tools/agent-sanitize.util.ts";

/**
 * fixture 树：最小 agent 模块。
 *
 * 写入点用的是**真实形状**（`@InjectRepository` 绑定 + `Repository<T>.create`），
 * 否则守卫会因「找不到写入点」而只测到结构红、测不到「发现明文」。
 *
 * 三张表都要有（含 `AgentSession`）：判据①对**每个**登记列都要求「写入点存在」，
 * fixture 若缺一张表，正例控制组会直接变成结构红——那会让「发现明文」这一类
 * 反证永远测不到。
 */
function fixtureFiles(overrides = {}) {
  const base = {
    [SERVICE_REL]: [
      "import { InjectRepository } from '@nestjs/typeorm';",
      "import { Repository } from 'typeorm';",
      "import { AgentStep } from '../entities/agent-step.entity';",
      "import { AgentToolCall } from '../entities/agent-tool-call.entity';",
      "import { AgentSession } from '../entities/agent-session.entity';",
      "import { sanitizeString } from '../tools/agent-sanitize.util';",
      "",
      "export function redactEventBodyText(raw: string): string {",
      "  return sanitizeString(raw);",
      "}",
      "",
      "export function redactNullableText(raw: string | null): string | null {",
      "  return raw == null ? null : redactEventBodyText(raw);",
      "}",
      "",
      "export function redactSessionResultForStorage(raw: any) {",
      "  return raw == null ? null : { ...raw, conclusion: redactEventBodyText(raw.conclusion ?? '') };",
      "}",
      "",
      "export function redactContextForStorage(raw: any) {",
      "  return raw == null ? null : JSON.parse(sanitizeString(JSON.stringify(raw)));",
      "}",
      "",
      "export class AgentSessionService {",
      "  constructor(",
      "    @InjectRepository(AgentStep)",
      "    private readonly steps: Repository<AgentStep>,",
      "    @InjectRepository(AgentToolCall)",
      "    private readonly toolCalls: Repository<AgentToolCall>,",
      "    @InjectRepository(AgentSession)",
      "    private readonly sessions: Repository<AgentSession>,",
      "  ) {}",
      "",
      "  async create(context: any) {",
      "    return this.sessions.create({",
      "      contextJson: redactContextForStorage(context),",
      "    });",
      "  }",
      "",
      "  async appendStep(content: string | null, summary: string | null) {",
      "    const step = this.steps.create({",
      "      content: redactEventBodyText(content ?? ''),",
      "      summary: summary == null ? null : redactEventBodyText(summary),",
      "    });",
      "    return step;",
      "  }",
      "",
      "  async recordToolCall(errorMessage: string | null) {",
      "    const row = this.toolCalls.create({",
      "      errorMessage: redactEventBodyText(errorMessage ?? ''),",
      "    });",
      "    return row;",
      "  }",
      "",
      "  async finish(result: any, summary: string | null, errorMessage: string | null) {",
      "    return this.sessions.update(",
      "      { id: 'x' },",
      "      {",
      "        resultJson: redactSessionResultForStorage(result),",
      "        summary: redactNullableText(summary),",
      "        errorMessage: redactNullableText(errorMessage),",
      "      },",
      "    );",
      "  }",
      "}",
    ].join("\n"),
    [UTIL_REL]: [
      "export function sanitizeString(s: string): string {",
      "  return s;",
      "}",
    ].join("\n"),
  };
  return { ...base, ...overrides };
}

/**
 * 造一个**规模足够**的 fixture 树（扫描面下界必须满足，否则只会测到
 * 「结构红」而测不到「发现明文」）。
 */
function sizedFixture(overrides = {}) {
  const files = fixtureFiles(overrides);
  for (let i = 0; i < MIN_SCANNED_FILES + 2; i += 1) {
    files[`apps/admin-api/src/modules/agent/runtime/filler-${i}.ts`] =
      `export const value${i} = ${i};\n`;
  }
  return files;
}

function withFixture(files, fn) {
  const repo = makeFixtureRepo(files, { prefix: "agent-write-sanitize-" });
  try {
    return fn(repo);
  } finally {
    repo.cleanup();
  }
}

const run = (root, extraArgs = []) =>
  runGuard(SELF, { args: ["--root", root, ...extraArgs] });

function selftest() {
  const baseService = fixtureFiles()[SERVICE_REL];
  const cases = [
    {
      name: "正例控制组：七个登记列（steps.content / steps.summary / tool_calls.errorMessage / 会话四列）都过脱敏 ⇒ 绿",
      fn: () => {
        withFixture(sizedFixture(), (repo) => {
          expectExit(run(repo.dir), { code: 0, label: "正例控制组" });
        });
      },
    },
    {
      name: "反证：步 content 去掉脱敏 ⇒ 红且点名该写入点",
      fn: () => {
        withFixture(
          sizedFixture({
            [SERVICE_REL]: baseService.replace(
              "content: redactEventBodyText(content ?? '')",
              "content: content ?? null",
            ),
          }),
          (repo) => {
            expectExit(run(repo.dir), {
              code: 1,
              contains: ["agent_steps.content", "未脱敏"],
              label: "步 content 反证",
            });
          },
        );
      },
    },
    {
      name: "反证：工具行 errorMessage 去掉脱敏 ⇒ 红且点名该写入点",
      fn: () => {
        withFixture(
          sizedFixture({
            [SERVICE_REL]: baseService.replace(
              "errorMessage: redactEventBodyText(errorMessage ?? '')",
              "errorMessage: errorMessage ?? null",
            ),
          }),
          (repo) => {
            expectExit(run(repo.dir), {
              code: 1,
              contains: ["agent_tool_calls.errorMessage", "未脱敏"],
              label: "工具行 errorMessage 反证",
            });
          },
        );
      },
    },
    {
      name: "反证：update 路径（就地更新）去掉脱敏 ⇒ 红",
      fn: () => {
        withFixture(
          sizedFixture({
            [SERVICE_REL]: baseService.replace(
              "  async recordToolCall(errorMessage: string | null) {",
              [
                "  async recordToolCall(errorMessage: string | null) {",
                "    await this.toolCalls.update(",
                "      { id: 'x' },",
                "      { errorMessage: errorMessage ?? null },",
                "    );",
              ].join("\n"),
            ),
          }),
          (repo) => {
            expectExit(run(repo.dir), {
              code: 1,
              contains: ["agent_tool_calls.errorMessage", "未脱敏"],
              label: "update 路径反证",
            });
          },
        );
      },
    },
    {
      name: "反证：会话 resultJson 去掉脱敏 ⇒ 红且只点名这一列（第二批扩面有牙）",
      fn: () => {
        withFixture(
          sizedFixture({
            [SERVICE_REL]: baseService.replace(
              "resultJson: redactSessionResultForStorage(result),",
              "resultJson: result,",
            ),
          }),
          (repo) => {
            expectExit(run(repo.dir), {
              code: 1,
              contains: ["agent_sessions.resultJson", "未脱敏"],
              // 判据按「实体 + 属性」逐列成立：另两列仍是绿的，不许连带点红
              absent: ["agent_sessions.summary", "agent_sessions.errorMessage"],
              label: "会话 resultJson 反证",
            });
          },
        );
      },
    },
    {
      name: "反证：步 summary（折叠摘要）去掉脱敏 ⇒ 红且点名这一列",
      fn: () => {
        withFixture(
          sizedFixture({
            [SERVICE_REL]: baseService.replace(
              "summary: summary == null ? null : redactEventBodyText(summary),",
              "summary: summary,",
            ),
          }),
          (repo) => {
            expectExit(run(repo.dir), {
              code: 1,
              contains: ["agent_steps.summary", "未脱敏"],
              // 判据逐列成立：另一列（content）仍绿，不许连带点红
              absent: ["agent_steps.content 的写入点未脱敏"],
              label: "步 summary 反证",
            });
          },
        );
      },
    },
    {
      name: "反证：会话 contextJson 去掉脱敏 ⇒ 红且点名（用户上下文列）",
      fn: () => {
        withFixture(
          sizedFixture({
            [SERVICE_REL]: baseService.replace(
              "contextJson: redactContextForStorage(context),",
              "contextJson: context,",
            ),
          }),
          (repo) => {
            expectExit(run(repo.dir), {
              code: 1,
              contains: ["agent_sessions.contextJson", "未脱敏"],
              label: "会话 contextJson 反证",
            });
          },
        );
      },
    },
    {
      name: "反证：会话 summary 去掉脱敏 ⇒ 红且点名（进通知正文的那一列）",
      fn: () => {
        withFixture(
          sizedFixture({
            [SERVICE_REL]: baseService.replace(
              "summary: redactNullableText(summary),",
              "summary: summary,",
            ),
          }),
          (repo) => {
            expectExit(run(repo.dir), {
              code: 1,
              contains: ["agent_sessions.summary", "未脱敏"],
              label: "会话 summary 反证",
            });
          },
        );
      },
    },
    {
      name: "反证：会话 errorMessage 去掉脱敏 ⇒ 红且点名",
      fn: () => {
        withFixture(
          sizedFixture({
            [SERVICE_REL]: baseService.replace(
              "errorMessage: redactNullableText(errorMessage),",
              "errorMessage: errorMessage,",
            ),
          }),
          (repo) => {
            expectExit(run(repo.dir), {
              code: 1,
              contains: ["agent_sessions.errorMessage", "未脱敏"],
              label: "会话 errorMessage 反证",
            });
          },
        );
      },
    },
    {
      name: "结构红：写入点消失（正则失配）⇒ 红，不许静默通过",
      fn: () => {
        withFixture(
          sizedFixture({
            [SERVICE_REL]: [
              "export function nothing() {",
              "  return 1;",
              "}",
            ].join("\n"),
          }),
          (repo) => {
            expectExit(run(repo.dir), {
              code: 1,
              contains: ["结构红", "找不到"],
              label: "写入点消失",
            });
          },
        );
      },
    },
    {
      name: "结构红：脱敏函数定义被搬走（只剩调用）⇒ 红",
      fn: () => {
        // 只留**调用**、不留**定义**——这正是「规则被搬到扫描面之外」的形态。
        // ⚠ 三/四个 `redact*` 定义必须**全摘**：只摘一个时另几个仍被扫到，
        // 判据③照样绿——那正是「这条用例失去牙齿」的形态（第二批扩面后
        // 定义从 1 个变成 3 个，只摘首个的旧写法会静默失效）。
        withFixture(
          sizedFixture({
            [SERVICE_REL]: baseService.replace(
              /export function redact\w+\([\s\S]*?\n\}/g,
              "",
            ),
            [UTIL_REL]: "export const NOT_A_SANITIZER = 1;\n",
          }),
          (repo) => {
            expectExit(run(repo.dir), {
              code: 1,
              contains: ["结构红", "脱敏函数"],
              label: "脱敏函数定义消失",
            });
          },
        );
      },
    },
    {
      name: "结构红：扫描面塌陷（文件数低于下界）⇒ 红",
      fn: () => {
        withFixture({ [SERVICE_REL]: baseService }, (repo) => {
          expectExit(run(repo.dir), {
            code: 1,
            contains: ["结构红", "扫描面塌陷"],
            label: "扫描面塌陷",
          });
        });
      },
    },
    {
      name: "注释里出现 content: 不算写入点（不许误判成明文）",
      fn: () => {
        withFixture(
          sizedFixture({
            [SERVICE_REL]: `${baseService}\n// content: input.content ?? null —— 这是注释里的形态\n`,
          }),
          (repo) => {
            expectExit(run(repo.dir), {
              code: 0,
              absent: ["未脱敏"],
              label: "注释不算写入点",
            });
          },
        );
      },
    },
    {
      name: "DTO 字段声明 content: 不算写入点（判据不宽）",
      fn: () => {
        withFixture(
          sizedFixture({
            "apps/admin-api/src/modules/agent/dto/agent-response.dto.ts":
              "export class Dto { content: string | null; errorMessage: string | null; }\n",
          }),
          (repo) => {
            expectExit(run(repo.dir), {
              code: 0,
              absent: ["未脱敏"],
              label: "DTO 字段不算写入点",
            });
          },
        );
      },
    },
    {
      name: "真仓库当前状态 ⇒ 绿（正例控制组：真代码不许被守卫判红）",
      fn: () => {
        expectExit(run(DEFAULT_ROOT), { code: 0, label: "真仓库" });
      },
    },
  ];

  const failed = reportCases(cases, { title: "check-agent-write-sanitize selftest" });
  return failed;
}

// ── 入口 ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
if (argv.includes("--selftest")) {
  process.exit(selftest() === 0 ? 0 : 1);
}
process.exit(main(argv));
