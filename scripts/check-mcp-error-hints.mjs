#!/usr/bin/env node
/**
 * R146：**MCP「已知后端错误码 → 成因 + 下一步」表 ↔ 后端错误码字典** 的漂移守卫。
 *
 * ## 治的是什么（缺口是 R145 自己写在头注里的）
 *
 * R145（`dc23ad9b`）在 `packages/mcp-server/src/error-hints.ts` 立了第二份事实源：
 * 「已知后端错误码 → cause + nextStep」。它是**结构性不可复制过来**的取舍（MCP 包
 * `tsconfig` 的 `rootDir: ./src` ⇒ 跨树相对导入 TS6059；发布物只有 `dist`），头注
 * 因此写了「**新增/改名错误码时两边都要看**」。
 *
 * 「两边都要看」靠人记 = **没有守卫**：后端新增/改名一个 A6b 码，MCP 表**静默过期**
 * —— 那个码退回裸 HTTP 文案（`API error (409): <后端文案>`），没有成因、没有下一步，
 * 而**没有任何信号**。本守卫就是把这句话变成一条会红的判据。
 *
 * ## 判据（三条 + 三类结构红）
 *
 * ① **MCP 表里的每个码，必须在后端码表里真实存在**（合并全部分片后的并集）。
 *    反向形态＝「为一个还不存在的错误写了建议」——用户永远不会读到它，而它会一直
 *    跟着码表腐烂（后端哪天真的用了这个名字，语义还未必一样）。
 * ② **后端 A6b 族的每一个码（`TASK_FIRE_POINT_*`）必须在 MCP 表里出现**。
 *    漏了＝「用户撞到它却没有成因与下一步」。
 * ③ **后端码的 `status` 必须与 MCP 表里记录的一致**（仅当该条记了 `status`）。
 *
 * 结构红（判据面塌了 ⇒ 本守卫的绿不可信，一律 exit 1，绝不退化成「0 项漂移」）：
 *   · 后端码表读不出来 / 分片条目数与解析数不一致（由 `scripts/lib/error-catalog.mjs` 抛）；
 *   · MCP 表文件缺失、`BACKEND_ERROR_HINTS` 声明找不到、对象字面量不闭合；
 *   · MCP 表里出现**非裸标识符键**（`"CODE": {` / `[CODE]: {`）、`...` 展开、值不是
 *     对象字面量 —— 都是「本守卫的解析口径读不到它」的形状，必须点名而不是静默跳过；
 *   · MCP 表解析出 0 条（分母塌方）；
 *   · 后端 A6b 家族解析出 0 个码（家族前缀被改名 ⇒ 判据② 会退化成永远空）。
 *
 * ## 为什么判据面**必须**限定在 A6b 族（本守卫最容易写错的地方）
 *
 * 后端码表有 **450+** 个码，MCP 表**刻意只收**「裸 HTTP 状态会误导」的那几条
 * （头注明写「刻意不做全量码表：三百多个码逐条写成因必然腐化」，CLI 侧同款结论）。
 * 若把判据②写成「后端每个码都要在 MCP 表里」，本守卫第一天就会红 447 条、并且
 * **永远红**——一个永远红的守卫等于没有守卫。所以：
 *
 *   · 判据①（MCP → 后端）**不限族**：表里出现什么码就核什么码（这才是「表不能写
 *     后端没有的码」）；
 *   · 判据②（后端 → MCP）**只核 `TASK_FIRE_POINT_*`**：这一族是 R145 建表时的**全部
 *     内容**，也是「不给成因就会误导模型」的判定面（A6b 的三个拒绝原因各不相同，
 *     模型无法从 409/400 反推该改什么）。selftest 用例②是这条边界的**控制组**：
 *     一个非 A6b 的后端码不在 MCP 表里，必须**exit 0**。
 *   · 新增 A6b 码时，把它加进 MCP 表；新增**其它域**的码，本守卫不管（要不要进
 *     MCP 表是产品判断，不是漂移）。
 *
 * ## 事实源与解析方式
 *
 * | 事实 | 位置 | 怎么读 |
 * |---|---|---|
 * | 错误码 → `status` / `zh` / `en`（**真值源**） | `apps/admin-api/src/common/errors/catalog/*.ts`（分片，`task.ts` 是 A6b 所在分片） | `scripts/lib/error-catalog.mjs` 的 `readCatalog()`（与 `gen:error-i18n` / `check:error-i18n` **同一份口径**，不另写正则） |
 * | MCP 表（第二份，只收精选码） | `packages/mcp-server/src/error-hints.ts` | 本文件的结构化扫描（见下） |
 *
 * **为什么不用 TypeScript compiler API**：本守卫挂在**零依赖**的 `test:guards` 面上
 * （CI 那个 job 没有 `npm ci`，`node_modules` 不存在），`typescript` 解析器不可用——
 * 与 `scripts/lib/error-catalog.mjs` 头注里同一条理由。故：后端侧复用共享的**正则
 * 分片解析器**（它自带「声明条数 vs 解析条数」逐条核对，是防口径失配的那道锁）；
 * MCP 侧用一个**深度扫描器**（不是单行正则）：先把注释与字符串/模板字面量的**内容**
 * 抹成等长空白（注释里的示例 `TASK_X: {` 因此不会被当成条目、模板里的 `status: 400`
 * 不会被当成字段），再定位 `BACKEND_ERROR_HINTS = {` 的花括号配对，只在**深度 1**
 * 上认 `裸标识符 : 对象字面量`。这样：缩进改变不影响、注释不影响、条目体里的箭头
 * 函数与嵌套对象不会串位；而**形状变了**（引号键、计算键、spread、值不是字面量）
 * 会**结构红**而不是静默少读一条。
 *
 * 已知的解析边界（写清是为了能被反证，不是为了免责）：
 *   · 键必须是**裸标识符**（`CODE: {`），大小写敏感、不做归一（表本身也是精确查表）；
 *   · `status` / `category` 取**条目体内第一次**出现的那一处（当前每个条目只有一处）；
 *   · 只读**字面量**：条目值若改成引用（`TASK_X: SOME_HINT,`）⇒ 结构红，因为本守卫
 *     没有类型信息去追引用（宁可红，不猜）。
 *
 * ## 复核命令（本表与后端漂移时先跑这几条，再看要不要改哪一侧）
 *
 * ```bash
 * node scripts/check-mcp-error-hints.mjs                 # 主判据
 * node scripts/check-mcp-error-hints.mjs --selftest      # 判据本身能不能红
 * grep -n "TASK_FIRE_POINT_" apps/admin-api/src/common/errors/catalog/task.ts
 * grep -nE "^  TASK_FIRE_POINT_[A-Z0-9_]+: \{" packages/mcp-server/src/error-hints.ts
 * ```
 *
 * ## 盲区（本守卫**不**管什么，别把它当全覆盖）
 *
 *   · **文案**：后端改了 `zh` / `en`，或 MCP 表的 `cause` / `nextStep` 措辞过期 ——
 *     **不会触发**。本守卫只看**码**与**状态码**（「说得准不准」不是静态可判的）。
 *   · **`category`**：不做任何判定。MCP 只有 `conflict` / `validation` 两类，而状态码
 *     到类别**不是**一一映射（CLI 的 `AI_SOP_QUESTIONS_EXHAUSTED` 就是 400 却归
 *     conflict），按状态码反推类别会造出一条与既有口径冲突的假判据。
 *   · **A6b 族以外的码**：不在 MCP 表里**不算漂移**（见上「判据面」）；是否该收进表
 *     是产品判断。
 *   · **后端抛点**：码在表里、status 对得上，但 `task.service.ts` 抛它时 `params` 的
 *     形状变了（`cause` 里插值的键名对不上）⇒ 这里看不出来（文案层，同第一条）。
 *   · **MCP 侧接线**：`api.ts` 有没有真的调用 `formatBackendErrorHint` 不由本守卫判
 *     （那是 `packages/mcp-server` 的 jest 面，见 `src/__tests__/api.test.ts`）。
 *
 * ## 用法 / 退出码
 *
 *   node scripts/check-mcp-error-hints.mjs                 # 守卫（真仓库）
 *   node scripts/check-mcp-error-hints.mjs --selftest      # 10 例（含 2 条正例控制组）
 *   node scripts/check-mcp-error-hints.mjs --root <dir>    # 把该目录当仓库根（只给 selftest 用）
 *
 * 退出码：0 = 一致；1 = 存在漂移**或判据本身不可信**（结构红）；2 = 用法错误
 * （未知参数 / `--root` 指向不存在的目录）——不吞参数，也不把用法错误报成「一致」。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readCatalog } from "./lib/error-catalog.mjs";
import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";
// R163：覆盖计数出口。**必须在任何 require/依赖之前**打印 —— 本文件若因缺依赖崩掉，
// 「崩了」与「零用例」必须能被哨兵分开看（`scripts/lib/agent-coverage.mjs` 头注同款纪律）。
printCoverageBanner(import.meta.url, "expectExit");

const HERE = dirname(fileURLToPath(import.meta.url));

/** 默认仓库根：脚本位于 `<repo>/scripts/`。**由脚本位置推出，不依赖调用方 cwd。** */
export const REPO_ROOT = resolve(HERE, "..");

/** 后端码表分片目录（真值源；`task.ts` 是 A6b 族所在分片）。 */
export const CATALOG_DIR = "apps/admin-api/src/common/errors/catalog";

/** MCP 侧的第二份表。 */
export const MCP_HINTS_REL = "packages/mcp-server/src/error-hints.ts";

/** MCP 表在源码里的对象名。 */
export const TABLE_NAME = "BACKEND_ERROR_HINTS";

/** A6b 家族前缀（判据② 的判据面边界，见头注）。 */
export const A6B_PREFIX = "TASK_FIRE_POINT_";

/**
 * 判据面下界：A6b 族至少要有 1 个码、MCP 表至少要有 1 条。
 *
 * 低于下界 ⇒ 结构红（不是「都合规」）。家族前缀哪天被改名，判据② 会退化成「空集合
 * 的每个元素都满足」——那是本守卫最安静的失效形态。
 */
export const MIN_A6B_CODES = 1;
export const MIN_MCP_ENTRIES = 1;

export const EXIT_DRIFT = 1;
export const EXIT_USAGE = 2;

/** 结构红（判据面塌了）。与「漂移」分开：漂移可以说「改哪一侧」，结构红只能说「修守卫/修事实源」。 */
export class StructureError extends Error {
  constructor(message) {
    super(message);
    this.name = "StructureError";
  }
}

function lineAt(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

/**
 * 把**注释**与**字符串/模板字面量的内容**抹成等长空白（保留换行与定界符）。
 *
 * 为什么必须抹：本守卫按「花括号深度 + 裸标识符键」解析源码文本。
 *   · 注释里有反例（本文件自己的头注就写着 `TASK_X: {`），不抹就会被当成条目；
 *   · 模板里可以有 `status: 400` 之类的字样，不抹就会串到字段核对里；
 *   · 抹成**等长**空白是为了让偏移量与原文一一对应（字段值仍从原文取，见 `fieldAt`）。
 *
 * 模板里的 `${ … }` 内部按「代码」处理（会再压一层模式栈），这样嵌套模板/嵌套对象
 * 不会把外层模板提前闭合。
 */
export function blankLiterals(src) {
  const out = src.split("");
  const n = out.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k += 1) {
      if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
    }
  };
  /** 模式栈：`code` 是代码（`braces` 仅用于模板内 `${…}` 的配对计数），其余是字面量。 */
  const modes = [{ kind: "code" }];
  let i = 0;
  while (i < n) {
    const top = modes[modes.length - 1];
    const ch = src[i];
    if (top.kind === "code") {
      if (ch === "'") { modes.push({ kind: "sq" }); i += 1; continue; }
      if (ch === '"') { modes.push({ kind: "dq" }); i += 1; continue; }
      if (ch === "`") { modes.push({ kind: "tpl" }); i += 1; continue; }
      if (ch === "/" && src[i + 1] === "/") {
        const end = src.indexOf("\n", i);
        const stop = end === -1 ? n : end;
        blank(i, stop);
        i = stop;
        continue;
      }
      if (ch === "/" && src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        const stop = end === -1 ? n : end + 2;
        blank(i, stop);
        i = stop;
        continue;
      }
      if (top.braces !== undefined) {
        if (ch === "{") top.braces += 1;
        else if (ch === "}") {
          if (top.braces === 0) {
            // `${ … }` 的收尾 `}` 属于**字面量语法**，不是对象结构：必须一起抹掉，
            // 否则它会在结构扫描里被当成一个对象的闭合（实测：`${a ? `x${b}` : "y"}` 把
            // 条目提前闭合，表中后续内容被当成「深度 1 的裸 token」）。
            blank(i, i + 1);
            modes.pop();
          } else top.braces -= 1;
        }
      }
      i += 1;
      continue;
    }
    if (top.kind === "tpl") {
      if (ch === "\\") { blank(i, i + 2); i += 2; continue; }
      if (ch === "`") { modes.pop(); i += 1; continue; }
      if (ch === "$" && src[i + 1] === "{") {
        blank(i, i + 2);
        modes.push({ kind: "code", braces: 0 });
        i += 2;
        continue;
      }
      blank(i, i + 1);
      i += 1;
      continue;
    }
    // sq / dq
    if (ch === "\\") { blank(i, i + 2); i += 2; continue; }
    if ((top.kind === "sq" && ch === "'") || (top.kind === "dq" && ch === '"')) {
      modes.pop();
      i += 1;
      continue;
    }
    blank(i, i + 1);
    i += 1;
  }
  return out.join("");
}

/** 在 `[from, to)` 里定位 `name:`，返回值的起始偏移（原文/空白串同长，故可直接取自原文）。 */
function fieldAt(blank, from, to, name) {
  const re = new RegExp(`(?:^|[^\\w$])${name}\\s*:\\s*`, "g");
  const region = blank.slice(from, to);
  const m = re.exec(region);
  if (!m) return -1;
  return from + m.index + m[0].length;
}

/** 取一个字符串字段（`"…"` / `'…'` 两种引号）；没有该字段 ⇒ null；有但不是字面量 ⇒ 结构红。 */
function stringField(src, blank, from, to, name, code) {
  const at = fieldAt(blank, from, to, name);
  if (at < 0) return null;
  const quote = src[at];
  if (quote !== '"' && quote !== "'") {
    throw new StructureError(
      `\`${code}\` 的 \`${name}\` 不是字符串字面量（第 ${lineAt(src, at)} 行）——本守卫只读字面量`,
    );
  }
  let k = at + 1;
  while (k < src.length && src[k] !== quote) {
    if (src[k] === "\\") k += 1;
    k += 1;
  }
  return src.slice(at + 1, k);
}

/** 取一个数字字段；没有 ⇒ null；有但不是数字字面量 ⇒ 结构红（绝不静默当「没记」）。 */
function numberField(src, blank, from, to, name, code) {
  const at = fieldAt(blank, from, to, name);
  if (at < 0) return null;
  const digits = /^\d+/.exec(blank.slice(at, at + 16));
  if (!digits) {
    throw new StructureError(
      `\`${code}\` 的 \`${name}\` 不是数字字面量（第 ${lineAt(src, at)} 行）——本守卫只读字面量`,
    );
  }
  return Number(digits[0]);
}

/**
 * 解析 MCP 表：`CODE → { line, status, category }`。
 *
 * 键必须是**裸标识符**（深度 1）；形状不符 ⇒ `StructureError`（点名是哪一行、哪种形状）。
 * `status` 缺失是**合法**的（表当前不记状态码）——判据③ 因此在那条上空跑。
 */
export function parseMcpHints(src) {
  const blank = blankLiterals(src);
  const decl = new RegExp(`\\b${TABLE_NAME}\\b\\s*:[^=]*=\\s*\\{`).exec(blank);
  if (!decl) {
    throw new StructureError(
      `读不到 \`export const ${TABLE_NAME}: … = { … }\` 的对象字面量声明 —— ` +
        `表被改名 / 改成引用 / 搬到别的文件了？本守卫的取数面失效，判据不可信`,
    );
  }
  const tableOpen = decl.index + decl[0].length - 1;
  const entries = new Map();
  const braces = [];
  let depth = 0;
  let pending = null;
  let tableClose = -1;
  let i = tableOpen;
  while (i < blank.length) {
    const ch = blank[i];
    if (ch === "{") {
      depth += 1;
      braces.push(i);
      if (depth === 2) {
        if (pending === null) {
          throw new StructureError(
            `第 ${lineAt(blank, i)} 行：表里出现一个**没有裸标识符键**的对象字面量` +
              `（带引号的键 \`"CODE": {\`、计算键 \`[CODE]: {\` 都是这种形状）。` +
              `本守卫只认 \`CODE: {\` —— 请把键改回裸标识符，或同步改本守卫的解析口径`,
          );
        }
        entries.set(pending.name, { line: pending.line, open: i, close: -1 });
        pending = null;
      }
      i += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      const justOpened = braces.pop();
      if (depth === 1) {
        for (const e of entries.values()) if (e.open === justOpened) e.close = i;
      }
      if (depth === 0) {
        tableClose = i;
        break;
      }
      if (depth < 0) break;
      i += 1;
      continue;
    }
    if (depth !== 1) {
      i += 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === ",") {
      i += 1;
      continue;
    }
    if (ch === ".") {
      throw new StructureError(
        `第 ${lineAt(blank, i)} 行：表里出现 \`...\` 展开 —— 本守卫只读**字面量清单**，` +
          `拼装的表请把它摊平，否则「哪些码收了」不再是一眼可见的事实`,
      );
    }
    if (ch === ":") {
      throw new StructureError(
        `第 ${lineAt(blank, i)} 行：表里出现孤立的 \`:\` —— 键不是裸标识符（见带引号/计算键形状）`,
      );
    }
    if (ch === '"' || ch === "'") {
      throw new StructureError(
        `第 ${lineAt(blank, i)} 行：键写成了**字符串字面量**（\`"CODE": { … }\`）—— ` +
          `本守卫只认裸标识符 \`CODE: { … }\`。请把键改回裸标识符，或同步改本守卫的解析口径`,
      );
    }
    if (ch === "[") {
      throw new StructureError(
        `第 ${lineAt(blank, i)} 行：键写成了**计算键**（\`[CODE]: { … }\`）—— ` +
          `本守卫只认裸标识符 \`CODE: { … }\`。请把键改回裸标识符，或同步改本守卫的解析口径`,
      );
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(blank.slice(i, i + 200));
    if (!word) {
      throw new StructureError(
        `第 ${lineAt(blank, i)} 行：表里出现无法识别的 token（\`${src[i]}\`）—— 解析口径失配`,
      );
    }
    const name = word[0];
    const keyLine = lineAt(blank, i);
    let j = i + name.length;
    while (j < blank.length && /\s/.test(blank[j])) j += 1;
    if (blank[j] !== ":") {
      throw new StructureError(`第 ${keyLine} 行：\`${name}\` 后面不是 \`:\` —— 表的结构不是 \`CODE: { … }\``);
    }
    j += 1;
    while (j < blank.length && /\s/.test(blank[j])) j += 1;
    if (blank[j] !== "{") {
      throw new StructureError(
        `第 ${keyLine} 行：\`${name}\` 的值不是对象字面量（可能写成了引用 / spread）—— ` +
          `本守卫读不到它的 cause / nextStep / status`,
      );
    }
    pending = { name, line: keyLine, index: i };
    i = j;
  }
  if (tableClose === -1) {
    throw new StructureError(`\`${TABLE_NAME}\` 的对象字面量没有闭合 —— 文件被截断？`);
  }
  const unclosed = [...entries.entries()].filter(([, e]) => e.close < 0);
  if (unclosed.length > 0) {
    throw new StructureError(
      `表里有 ${unclosed.length} 条没有闭合（${unclosed.map(([c]) => c).join(', ')}）—— 解析口径失配`,
    );
  }
  const out = new Map();
  for (const [code, e] of entries) {
    out.set(code, {
      line: e.line,
      category: stringField(src, blank, e.open, e.close, "category", code),
      status: numberField(src, blank, e.open, e.close, "status", code),
    });
  }
  return out;
}

/** 从 MCP 表里读出的条目。 */
/** @typedef {{ line: number, category: string | null, status: number | null }} McpHintEntry */

/**
 * 全量判据。
 *
 * @param {string} root 仓库根
 * @returns {{ drifts: string[], structural: string[], stats: null | { catalogSize: number, a6b: number, mcp: number, statusChecked: number } }}
 */
export function check(root = REPO_ROOT) {
  /** @type {string[]} */ const drifts = [];
  /** @type {string[]} */ const structural = [];

  let catalog;
  try {
    catalog = readCatalog(root, CATALOG_DIR);
  } catch (err) {
    structural.push(`后端码表读不出来（\`${CATALOG_DIR}\`）：${err.message}`);
    return { drifts, structural, stats: null };
  }

  /** @type {Map<string, McpHintEntry>} */ let entries;
  try {
    const hintsPath = join(root, MCP_HINTS_REL);
    if (!existsSync(hintsPath)) throw new StructureError(`事实源文件不存在：\`${MCP_HINTS_REL}\``);
    entries = parseMcpHints(readFileSync(hintsPath, "utf8"));
  } catch (err) {
    structural.push(`MCP 表读不出来（\`${MCP_HINTS_REL}\`）：${err.message}`);
    return { drifts, structural, stats: null };
  }

  const family = [...catalog.keys()].filter((c) => c.startsWith(A6B_PREFIX)).sort();
  if (family.length < MIN_A6B_CODES) {
    structural.push(
      `后端码表里以 \`${A6B_PREFIX}\` 开头的错误码 **0 个** —— A6b 家族前缀被改名了？` +
        `判据② 的判据面会因此静默塌成「空集合」并永远报绿。先确认家族前缀，再同步本守卫的 \`A6B_PREFIX\``,
    );
  }
  if (entries.size < MIN_MCP_ENTRIES) {
    structural.push(
      `MCP 表 \`${MCP_HINTS_REL}\` 解析出 **0 条** —— 分母塌了不等于事实都合规（表被清空/改成非字面量？）`,
    );
  }
  if (structural.length > 0) {
    return { drifts, structural, stats: null };
  }

  // ① MCP → 后端：表里不许写一个后端没有的码。
  for (const [code, entry] of entries) {
    if (catalog.has(code)) continue;
    drifts.push(
      `MCP 表里的 \`${code}\`（${MCP_HINTS_REL}:${entry.line}）**后端已不存在** —— ` +
        `后端码表（${CATALOG_DIR}/*.ts，共 ${catalog.size} 个码）里没有这个码。\n` +
        `    修法：**改 MCP 侧** —— 删掉 \`${MCP_HINTS_REL}\` 里这一条（给一个不会发生的错误写成因，` +
        `等于给永远不会出现的失败写建议）。若后端只是**改名**：先 ` +
        `\`grep -rn "${code.startsWith(A6B_PREFIX) ? A6B_PREFIX : code}" ${CATALOG_DIR}/\` 找新名，再改这一条的键与新名对齐`,
    );
  }

  // ② 后端 A6b 族 → MCP：家族里每个码都必须在表里（**只核这一族**，理由见头注）。
  for (const code of family) {
    if (entries.has(code)) continue;
    const status = catalog.get(code)?.status;
    drifts.push(
      `后端的 \`${code}\`（status ${status}）**未进 MCP 表** —— ${MCP_HINTS_REL} 的 \`${TABLE_NAME}\` 里没有它。\n` +
        `    修法：**改 MCP 侧** —— 在表里补一条（\`category\` + \`cause\` + \`nextStep\`）。漏了它，模型撞到该码时` +
        `只拿到裸 \`API error (${status})\`：**没有成因、没有下一步**，只能自己猜`,
    );
  }

  // ③ 状态码：仅当该条记录了 status（表当前不记 ⇒ 这条在真仓库上空跑，见头注）。
  let statusChecked = 0;
  for (const [code, entry] of entries) {
    const def = catalog.get(code);
    if (!def || entry.status === null) continue;
    statusChecked += 1;
    if (def.status === entry.status) continue;
    drifts.push(
      `\`${code}\` 的**状态码不一致**：后端 ${def.status} vs MCP 表 ${entry.status}` +
        `（${MCP_HINTS_REL}:${entry.line}）。\n` +
        `    修法：**改 MCP 侧** —— 把这一条的 \`status\` 改成 ${def.status}。` +
        `若确认是后端写错，改 \`${CATALOG_DIR}/task.ts\`（后端侧）——但码表是状态码的真值源，先假设错在 MCP`,
    );
  }

  return {
    drifts,
    structural,
    stats: { catalogSize: catalog.size, a6b: family.length, mcp: entries.size, statusChecked },
  };
}

/** 打印判据报告并返回退出码。 */
export function report(result) {
  const { drifts, structural, stats } = result;
  if (structural.length > 0) {
    process.stdout.write(`\n✘ MCP 错误提示表守卫：判据面不可信（结构红）\n\n`);
    for (const s of structural) process.stdout.write(`  · ${s}\n`);
    process.stdout.write(
      `\n  这不是「表没问题」，是**本守卫读不到事实** ⇒ 修事实源或修解析口径（别把判据改成跳过）。\n`,
    );
    return EXIT_DRIFT;
  }
  if (stats) {
    process.stdout.write(
      `\nMCP 错误提示表守卫（\`${MCP_HINTS_REL}\` ↔ \`${CATALOG_DIR}\`）\n` +
        `  后端码表 ${stats.catalogSize} 个码 · A6b 族（\`${A6B_PREFIX}*\`）${stats.a6b} 个 · ` +
        `MCP 表 ${stats.mcp} 条 · 记录 status 并可核的 ${stats.statusChecked} 条\n`,
    );
  }
  if (drifts.length > 0) {
    process.stdout.write(`\n✘ 漂移 ${drifts.length} 项：\n\n`);
    for (const d of drifts) process.stdout.write(`  · ${d}\n\n`);
    process.stdout.write(
      `  判据面：① MCP 表里每个码必须在后端存在（不许多）· ② 后端 ${A6B_PREFIX}* 每个码必须在 MCP 表里（不许漏）· ` +
        `③ 两边都记 status 时必须一致。\n` +
        `  **A6b 族以外的后端码不在 MCP 表里不算漂移** —— 那张表刻意只收「裸 HTTP 状态会误导」的码。\n`,
    );
    return EXIT_DRIFT;
  }
  process.stdout.write(
    `\n✔ MCP 表与后端码表一致：0 项漂移（\`${A6B_PREFIX}*\` 全在表里；表里的码后端全都存在）\n`,
  );
  return 0;
}

/** 解析 argv；未知参数 ⇒ 抛（由 main 转成 exit 2），不静默忽略。 */
export function parseArgs(argv) {
  const opts = { selftest: false, root: REPO_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--selftest") opts.selftest = true;
    else if (a === "--root") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) throw new Error("`--root` 后面缺目录参数");
      opts.root = resolve(v);
      i += 1;
    } else if (a.startsWith("--root=")) opts.root = resolve(a.slice("--root=".length));
    else throw new Error(`未知参数 \`${a}\`（只认 --selftest / --root <dir>）`);
  }
  return opts;
}

/* ────────────────────────────── selftest ────────────────────────────── */

/** 造一份后端分片（`readCatalog` 认的形态：2 空格缩进 + `CODE: { … },`）。 */
function catalogFixture(codes) {
  const body = codes
    .map(
      ({ code, status }) =>
        `  ${code}: {\n    status: ${status},\n    zh: "文案 ${code}",\n    en: 'Text ${code}',\n  },`,
    )
    .join("\n");
  return `import type { ErrorCodeDef } from "../error-code-def";\n\nexport const TASK_CODES = {\n${body}\n};\n`;
}

/** 造一份 MCP 表。`status` 缺省即「没记状态码」（与真仓库同形）。 */
function hintsFixture(entries) {
  const body = entries
    .map(({ code, category = "validation", status }) => {
      const statusLine = status === undefined ? "" : `    status: ${status},\n`;
      return (
        `  ${code}: {\n` +
        `    category: "${category}",\n` +
        statusLine +
        `    cause: (params) => \`why \${params?.x ?? "y"}\`,\n` +
        `    nextStep: "what",\n` +
        `  },`
      );
    })
    .join("\n");
  return (
    `export const BACKEND_ERROR_HINTS: Readonly<Record<string, BackendErrorHint>> = {\n${body}\n};\n`
  );
}

const BASE_CATALOG = [
  { code: "TASK_NOT_FOUND", status: 404 },
  { code: "TASK_NAME_EXISTS", status: 409 },
  { code: "TASK_FIRE_POINT_NOT_CRON", status: 400 },
  { code: "TASK_FIRE_POINT_ALREADY_CONSUMED", status: 409 },
];
const BASE_HINTS = [
  { code: "TASK_FIRE_POINT_NOT_CRON" },
  { code: "TASK_FIRE_POINT_ALREADY_CONSUMED", category: "conflict" },
];

function makeRepo({ catalog = BASE_CATALOG, hints = BASE_HINTS, rawHints = null } = {}) {
  return makeFixtureRepo({
    [`${CATALOG_DIR}/task.ts`]: catalogFixture(catalog),
    [`${MCP_HINTS_REL}`]: rawHints ?? hintsFixture(hints),
  });
}

export function selftest() {
  const guard = join(REPO_ROOT, "scripts/check-mcp-error-hints.mjs");
  const run = (repo, extra = []) =>
    runGuard(guard, { args: ["--root", repo.dir, ...extra], cwd: REPO_ROOT });

  const cases = [];
  const withRepo = (name, spec, fn) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeRepo(spec);
        try {
          fn(repo);
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  // ① 正例控制组：表与码表一致 ⇒ exit 0。
  withRepo("正例：A6b 全在表里、表里的码后端全都存在 ⇒ exit 0", {}, (repo) => {
    const r = run(repo);
    expectExit(r, { code: 0, contains: ["0 项漂移", "A6b 族"], label: "正例" });
  });

  // ② 边界控制组（本守卫最容易写错的地方）：非 A6b 的后端码**不许**被要求进 MCP 表。
  withRepo(
    "控制组：非 A6b 的后端码不在 MCP 表里 ⇒ 仍 exit 0（判据面限定在 A6b 族）",
    {},
    (repo) => {
      const r = run(repo);
      expectExit(r, {
        code: 0,
        contains: ["0 项漂移"],
        absent: ["TASK_NOT_FOUND", "TASK_NAME_EXISTS", "未进 MCP 表"],
        label: "非 A6b 不算漏",
      });
    },
  );

  // ③ 判据①：MCP 表多出一个后端没有的码 ⇒ 红并点名。
  withRepo(
    "反证①：MCP 表里加一个后端没有的码 ⇒ exit 1 且点名「后端已不存在」",
    {
      hints: [
        ...BASE_HINTS,
        { code: "TASK_FIRE_POINT_GHOST", status: undefined },
      ],
    },
    (repo) => {
      const r = run(repo);
      expectExit(r, {
        code: 1,
        contains: ["TASK_FIRE_POINT_GHOST", "后端已不存在", "改 MCP 侧"],
        absent: ["未进 MCP 表"],
        label: "多出的码",
      });
    },
  );

  // ④ 判据②：后端多出一个 MCP 没有的 A6b 码 ⇒ 红并点名。
  withRepo(
    "反证②：后端加一个 A6b 码但 MCP 表没加 ⇒ exit 1 且点名「未进 MCP 表」",
    {
      catalog: [...BASE_CATALOG, { code: "TASK_FIRE_POINT_BRAND_NEW", status: 400 }],
    },
    (repo) => {
      const r = run(repo);
      expectExit(r, {
        code: 1,
        contains: ["TASK_FIRE_POINT_BRAND_NEW", "未进 MCP 表", "status 400"],
        absent: ["后端已不存在"],
        label: "漏的码",
      });
    },
  );

  // ⑤ 判据③：两边都记 status 时不一致 ⇒ 红并给出「后端 X vs MCP Y」。
  withRepo(
    "反证③：MCP 表记 status 400 而后端是 409 ⇒ exit 1 且点名「状态码不一致（后端 409 vs MCP 400）」",
    {
      hints: [
        { code: "TASK_FIRE_POINT_NOT_CRON" },
        { code: "TASK_FIRE_POINT_ALREADY_CONSUMED", category: "conflict", status: 400 },
      ],
    },
    (repo) => {
      const r = run(repo);
      expectExit(r, {
        code: 1,
        contains: [
          "状态码不一致",
          "后端 409 vs MCP 表 400",
          "TASK_FIRE_POINT_ALREADY_CONSUMED",
        ],
        label: "状态码不一致",
      });
    },
  );

  // ⑥ 形状反证：键带引号（形状不同）必须被抓住，而不是被静默少读一条。
  withRepo(
    "反证④：MCP 表的键写成带引号（形状不同）⇒ exit 1 结构红，不许静默少读",
    {
      rawHints:
        `export const BACKEND_ERROR_HINTS: Readonly<Record<string, BackendErrorHint>> = {\n` +
        `  "TASK_FIRE_POINT_NOT_CRON": {\n    category: "validation",\n    cause: () => "why",\n    nextStep: "what",\n  },\n` +
        `  TASK_FIRE_POINT_ALREADY_CONSUMED: {\n    category: "conflict",\n    cause: () => "why",\n    nextStep: "what",\n  },\n};\n`,
    },
    (repo) => {
      const r = run(repo);
      expectExit(r, {
        code: 1,
        contains: ["结构红", "裸标识符", "字符串字面量"],
        absent: ["0 项漂移"],
        label: "带引号的键",
      });
    },
  );

  // ⑦ 分母塌方：表被清空 ⇒ 结构红（不是「0 条漂移」）。
  withRepo(
    "反证⑤：MCP 表被清空 ⇒ exit 1 结构红「0 条」，不许报「一致」",
    { rawHints: `export const BACKEND_ERROR_HINTS: Readonly<Record<string, BackendErrorHint>> = {};\n` },
    (repo) => {
      const r = run(repo);
      expectExit(r, { code: 1, contains: ["结构红", "0 条"], absent: ["0 项漂移"], label: "空表" });
    },
  );

  // ⑧ 家族塌方：后端把 A6b 前缀改名 ⇒ 判据② 的判据面变成空集合，必须红。
  withRepo(
    "反证⑥：后端 A6b 家族前缀被改名（家族 0 个码）⇒ exit 1 结构红「家族前缀」",
    {
      catalog: [
        { code: "TASK_NOT_FOUND", status: 404 },
        { code: "TASK_FIREPOINT_NOT_CRON", status: 400 },
      ],
      rawHints: `export const BACKEND_ERROR_HINTS: Readonly<Record<string, BackendErrorHint>> = {\n  TASK_FIREPOINT_NOT_CRON: {\n    category: "validation",\n    cause: () => "why",\n    nextStep: "what",\n  },\n};\n`,
    },
    (repo) => {
      const r = run(repo);
      expectExit(r, {
        code: 1,
        contains: ["结构红", "TASK_FIRE_POINT_", "0 个"],
        absent: ["0 项漂移"],
        label: "家族塌方",
      });
    },
  );

  // ⑨ 用法错误不许被报成「一致」。
  cases.push({
    name: "用法：未知参数 ⇒ exit 2（不许静默忽略后报绿）",
    fn: () => {
      const repo = makeRepo();
      try {
        expectExit(run(repo, ["--bogus"]), {
          code: 2,
          contains: ["未知参数", "--bogus"],
          absent: ["0 项漂移"],
          label: "未知参数",
        });
      } finally {
        repo.cleanup();
      }
    },
  });

  cases.push({
    name: "用法：`--root` 指向不存在的目录 ⇒ exit 2",
    fn: () => {
      expectExit(runGuard(guard, { args: ["--root", join(REPO_ROOT, ".no-such-dir-r146")] }), {
        code: 2,
        contains: ["--root"],
        label: "root 不存在",
      });
    },
  });

  const failed = reportCases(cases, { title: "check-mcp-error-hints selftest" });
  process.exit(failed === 0 ? 0 : EXIT_DRIFT);
}

/* ────────────────────────────── entry ────────────────────────────── */

export function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`✘ 用法错误：${err.message}\n`);
    return EXIT_USAGE;
  }
  if (opts.selftest) {
    // 不混用：`--selftest` 只跑自检（与 `--root` 混用无意义 ⇒ 这里允许但因为用不到而忽略）。
    selftest();
    return 0;
  }
  if (!existsSync(opts.root)) {
    process.stderr.write(`✘ 用法错误：\`--root\` 指向的目录不存在：${opts.root}\n`);
    return EXIT_USAGE;
  }
  return report(check(opts.root));
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exit(main());
}
