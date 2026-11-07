#!/usr/bin/env node
/**
 * 守卫覆盖哨兵（S6-6-4）的**计数出口**与**计数解析器**（零依赖）。
 *
 * ## 为什么要它
 *
 * 病是同一个：**「零条断言」=「全部通过」**。`scripts/agent-trigger-check.mjs`
 * 这类守卫里，用例被整体删除或注释掉时，守卫照样打印「=== 全部触发器断言通过 ===」
 * 并退出 0 —— CI 全绿，而它保护的东西已经一个都不剩了。
 *
 * 哨兵必须挂在**守卫的守卫**（`scripts/check-guards-wired.mjs`）上，而不是挂在
 * 某一个守卫里：守卫自己判「我有没有用例」，永远需要一个**与被测对象无关**的
 * 第二只眼；同族的守卫互查也会漏（两两互查 ⇒ 一起被删就一起绿）。仓库已经有一只
 * 「守卫的守卫」（`check-guards-wired.mjs` 管「守卫有没有被跑到」），覆盖哨兵是
 * 同一只眼的第二个视野：「它被跑到了，但它还剩下用例吗」。
 *
 * ## 「用例计数」的真实口径
 *
 * 口径 = **本文件源码里断言调用点的个数**（`check(` / `must(` 这类断言函数的
 * 调用点），**不是**运行期被执行了多少次。两条理由：
 *
 *   ① **依赖无关**：这四个 agent 守卫要 `apps/admin-api` 的 typescript /
 *      reflect-metadata 才能跑完（没有它们就在 `require()` 处直接崩）。计数行
 *      必须在**崩之前**就已经打出来，否则「机器没装依赖」会被误读成「零用例」，
 *      或者反过来把「守卫崩了」误读成「守卫没覆盖」。
 *   ② **可判定**：运行期执行次数受循环影响（同一个调用点执行 N 次），不适合当
 *      「删光了没有」的分母；调用点数是**源码的事实**，删掉用例就一定会掉。
 *
 * 调用点数**小于**运行期执行次数是正常的（循环展开），两者不是一回事，本模块
 * 只承诺前者。
 *
 * ## 计数行长什么样
 *
 *    COVERAGE_CASES: 79
 *
 * 单独一行、独占一行、无前后缀 —— 哨兵按这一行解析。格式变了（改了前缀、少了
 * 冒号、值不是整数）⇒ 哨兵**结构红**（不许「解析不出来就算过」）。
 *
 * ## 为什么用 writeSync 而不是 console.log
 *
 * 计数行必须在守卫**崩溃前**也能落到管道里。`console.log` 往管道（子进程 stdout
 * 是管道）是异步写，进程被未捕获异常打断时可能丢；`fs.writeSync(1, …)` 是同步
 * 写，保证「打出来了就一定被父进程读到」。
 */

import { readFileSync, writeSync } from "node:fs";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 计数行的前缀（哨兵按整行解析，改它 = 改契约）。 */
export const COVERAGE_PREFIX = "COVERAGE_CASES:";

/**
 * 覆盖登记表：**哪些守卫的「用例计数」被哨兵盯着**。
 *
 * 表格本体是**数据文件** `scripts/coverage-registry.json`（不是代码里的字面量）——
 * 因为这张表会随守卫增删长期变动，放成数据才能让「守卫的守卫」那个单写者敏感
 * 文件只**引用**它（改表不动判据本体），也让 fixture 树能自带一张表。
 *
 * 每条 = 一个可证的事实：
 *   · `helper`：断言函数名（`check` / `must`）——决定「用例」在这个守卫里长什么样；
 *   · `floor`：用例数下界，低于它即红（取历史规模的一半左右 ⇒ 「删光」「删大半」
 *     会红，正常增删不会红）；
 *   · `args`：跑这个守卫要带的参数（`[]` = 主跑形态）。
 *
 * 本轮只覆盖 `agent-*.mjs` 一族（规格要求「先只覆盖 agent-*.mjs 一族，
 * 不做全仓改造」）。其余守卫**显式未覆盖**，差额见文档盘点。
 */
export const COVERAGE_REGISTRY_REL = "scripts/coverage-registry.json";

/**
 * 本轮覆盖范围的前缀（规格要求「先只覆盖 agent-*.mjs 一族，不做全仓改造」）。
 *
 * 登记表里出现**族外**的路径时，哨兵会打 `⚠`（不是红）——因为「扩大覆盖面」是
 * 好事，不该因为「登记超出本轮范围」把人拦下来；但它必须被看见，避免
 * 「悄悄把范围改了」。
 */
export const COVERAGE_SCOPE_PREFIX = "agent-";

/**
 * 读登记表（数据文件）。
 *
 * @param {string} root 仓库根
 * @returns {{ok: true, registry: object, scopePrefix: string}
 *          | {ok: false, reason: string}}
 *   读不到 / 解析不了 ⇒ `ok:false`（哨兵据此判**结构红**：登记表烂了，
 *   判据④ 就没法执行，「没法判」绝不能当成「没问题」）。
 */
export function loadCoverageRegistry(root) {
  const rel = COVERAGE_REGISTRY_REL;
  let text;
  try {
    text = readFileSync(join(root, rel), "utf8");
  } catch (e) {
    return { ok: false, reason: `读不到覆盖登记表 ${rel}：${e.message}` };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `覆盖登记表 ${rel} 不是合法 JSON：${e.message}` };
  }
  const covered = data?.covered;
  if (!covered || typeof covered !== "object" || Array.isArray(covered)) {
    return { ok: false, reason: `覆盖登记表 ${rel} 缺 "covered" 对象` };
  }
  return {
    ok: true,
    registry: covered,
    // `scopePrefix` 可以是**单个字符串**（旧形态，行为不变）或**字符串数组**（多族）。
    // 为什么加数组：登记表从「只覆盖 agent-* 一族」扩到「agent-* + 若干高风险 check-*」后，
    // 单一前缀无法表达这件事，只能二选一（要么放弃提示、要么把 check-* 全判成「族外」）。
    // 数组的语义仍是**提示不判红**：只要命中任一前缀就算「本轮范围内」。
    scopePrefix:
      typeof data.scopePrefix === "string"
        ? data.scopePrefix
        : Array.isArray(data.scopePrefix) && data.scopePrefix.every((p) => typeof p === "string")
          ? data.scopePrefix
          : COVERAGE_SCOPE_PREFIX,
  };
}

/**
 * 剥掉注释、字符串字面量与正则字面量，只留**代码**。
 *
 * 为什么要剥：断言函数的调用点必须在**代码**里数——写在注释里（文档举例）、
 * 写在字符串里（错误文案）都不算；写在正则里更不算。否则「把用例注释掉」这种
 * 最常见的删除形态反而数不出来（注释里的 `check(` 还留着 ⇒ 计数不掉 ⇒ 假绿）。
 *
 * 为什么要连正则一起剥：JS 里 `/["']/` 这种正则里带引号，朴素的「字符串优先」
 * 扫描器会把后面的源码误当成字符串吞掉 —— 那会让计数**偏小**，进而可能把
 * 「用例还在」判成「用例没了」。正则字面量的起点用「前一个有效字符」启发式
 * 判断（标识符/数字/右括号之后是除号，其余是正则）。
 */
export function stripCommentsAndStrings(src) {
  const s = String(src ?? "");
  const n = s.length;
  let out = "";
  let i = 0;
  /** 上一个「有效」字符（用于区分除号与正则起点）。 */
  let prev = "";
  /** 上一个「有效」单词（用于识别 return / case 之后的正则）。 */
  let prevWord = "";

  const blank = (ch) => (ch === "\n" ? "\n" : " ");
  const pushWord = (ch) => {
    if (/[A-Za-z0-9_$]/.test(ch)) prevWord += ch;
    else prevWord = "";
  };

  while (i < n) {
    const c = s[i];
    const c2 = s[i + 1];

    // 行注释
    if (c === "/" && c2 === "/") {
      while (i < n && s[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }

    // 块注释
    if (c === "/" && c2 === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(s[i] === "*" && s[i + 1] === "/")) {
        out += blank(s[i]);
        i += 1;
      }
      out += "  ";
      i += 2;
      continue;
    }

    // 普通字符串
    if (c === '"' || c === "'") {
      const q = c;
      out += " ";
      i += 1;
      while (i < n) {
        if (s[i] === "\\") {
          out += blank(s[i]) + blank(s[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (s[i] === q) {
          out += " ";
          i += 1;
          break;
        }
        out += blank(s[i]);
        i += 1;
      }
      prev = q;
      prevWord = "";
      continue;
    }

    // 模板字符串（插值部分保守地整段抹掉：断言调用不会藏在插值里）
    if (c === "`") {
      out += " ";
      i += 1;
      while (i < n) {
        if (s[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        if (s[i] === "`") {
          out += " ";
          i += 1;
          break;
        }
        if (s[i] === "$" && s[i + 1] === "{") {
          out += "  ";
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (s[i] === "{") depth += 1;
            else if (s[i] === "}") depth -= 1;
            out += blank(s[i]);
            i += 1;
          }
          continue;
        }
        out += blank(s[i]);
        i += 1;
      }
      prev = "`";
      prevWord = "";
      continue;
    }

    // 正则字面量 vs 除号
    if (c === "/") {
      const keywordBefore = /^(?:return|case|typeof|void|delete|in|of|new|do|else|yield|await|instanceof)$/.test(
        prevWord,
      );
      const regexAllowed =
        prev === "" ||
        keywordBefore ||
        !/[A-Za-z0-9_$)\]}]/.test(prev);
      if (regexAllowed) {
        out += " ";
        i += 1;
        let inClass = false;
        while (i < n) {
          if (s[i] === "\\") {
            out += "  ";
            i += 2;
            continue;
          }
          if (s[i] === "[") inClass = true;
          else if (s[i] === "]") inClass = false;
          else if (s[i] === "/" && !inClass) {
            out += " ";
            i += 1;
            break;
          } else if (s[i] === "\n") {
            break; // 不是正则（行尾还没闭合）⇒ 放弃，当普通字符处理
          }
          out += blank(s[i]);
          i += 1;
        }
        prev = "/";
        prevWord = "";
        continue;
      }
      out += c;
      i += 1;
      prev = c;
      prevWord = "";
      continue;
    }

    out += c;
    i += 1;
    if (!/\s/.test(c)) {
      prev = c;
      pushWord(c);
    }
  }
  return out;
}

/**
 * 数源码里断言函数的**调用点**个数。
 *
 * 排除：函数定义（`function check(`）、方法调用（`svc.check(` / `boundary.check(`）。
 * 保留：裸调用（`check(`），无论前面是不是行首 —— 有的用例写在循环里、有的写在
 * 表达式中间。
 */
/**
 * 只抹掉**注释**、保留字符串字面量（用于「有没有实现 `--selftest` 开关」这类判定）。
 *
 * ## 为什么需要它（与 `stripCommentsAndStrings` 的区别）
 *
 * `stripCommentsAndStrings` 连**字符串**一起抹掉（它服务于「数断言调用点」——
 * 断言名出现在字符串里不算调用）。但「守卫有没有 `--selftest` 开关」问的是
 * **字面量**：实现必然写成 `argv.includes("--selftest")`，而**注释里**提到
 * `--selftest`（本仓极常见：头注里写「用法：… --selftest」）**不算实现**。
 *
 * `check-guards-wired.mjs` 的 `detectSelftest` 此前用**裸正则**扫全文
 * ⇒ 注释里出现 `--selftest` 就算「有自检」⇒ 判据与它自己的文档口径
 * （头注第 20–21 行：「纯注释/纯文档里的 `--selftest` 不算」）**相反**。
 * 本函数提供「只去注释、留字面量」的判据面，供它改用。
 *
 * 边界：字符串里的转义引号按 `\` 处理；模板字符串按普通引号处理（保守：
 * 模板里的 `--selftest` 会被**保留**，即可能被判成「有开关」——宁可多判，
 * 也不能把真有开关的守卫判成没有）。
 */
export function stripCommentsKeepStrings(src) {
  const s = String(src ?? "");
  const n = s.length;
  let out = "";
  let i = 0;
  while (i < n) {
    const c = s[i];
    const c2 = s[i + 1];
    // 行注释
    if (c === "/" && c2 === "/") {
      while (i < n && s[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    // 块注释
    if (c === "/" && c2 === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(s[i] === "*" && s[i + 1] === "/")) {
        out += s[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += "  ";
      i += 2;
      continue;
    }
    // 字符串（含转义）：**原样保留**（这是本函数与 stripCommentsAndStrings 的关键差别）
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out += c;
      i += 1;
      while (i < n) {
        if (s[i] === "\\") {
          out += s[i] + (s[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += s[i];
        if (s[i] === q) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 数一张**数据驱动用例表**的条目数（R168）。
 *
 * ## 为什么需要它（判据④ 的一等形态）
 *
 * 有些守卫的用例是**表**（例 `scripts/check-metric-docs.mjs` 的 `SELFTEST_CASES` 表 20 条 +
 * 表外 `cases.push` 2 条 = 22 条）。对这类守卫：
 * · `helper` 指向的**断言助手**（如 `must`）的调用点数是「**断言语句数**」，
 *   **删掉用例表它纹丝不动** ⇒ 用它当 floor 就是**假保护**（R163 的教训，方法学 314）；
 * · 而守卫若自己打印 `cases.length`，哨兵的**交叉核对**（`countAssertionCallSites(helper)`）
 *   **数不出表长** ⇒ 要么报错「断言函数名非法」，要么**放弃交叉核对**（那会丢掉
 *   「防把计数写死」的唯一机制）。
 *
 * ⇒ 本函数提供**第三种**口径：哨兵**自己**在源码里定位那张表并数它的条目，
 * 与守卫打印的数字**独立**求得 ⇒ **交叉核对依然成立**。
 *
 * ## 口径（必须是「结构」而不是「文本计数」）
 *
 * 只数**顶层数组字面量**的元素：找到 `const <表名> = [`（或 `let`/`var`）后，
 * 用**括号配平**扫描到配对的 `]`，其间**深度为 1**的位置上、值以 `{` 开头的元素各计 1。
 * ⚠️ **不**按 `name:` 出现次数数（注释里出现 `name:` 就会多算）·
 * ⚠️ **不**把嵌套对象/数组的元素算进去（只数顶层）。
 *
 * @param {string} src 源码全文
 * @param {string} tableName 表名（不含 `$` / `_` 之类）
 * @returns {number} 顶层元素数；**找不到表** ⇒ 抛错（哨兵据此判「登记指向的表不存在」）
 */
export function countTableEntries(src, tableName) {
  const name = String(tableName ?? "").trim();
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error(`用例表名非法：${JSON.stringify(tableName)}`);
  }
  // **先剥注释与字符串再做结构计数** —— 这是本函数唯一可靠的做法：
  // 手写状态机要同时正确处理 `//`、`/* */`、`'…'`、`"…"`、`` `…` ``、`\` 转义与**正则字面量**，
  // 漏一种就会把「字符串里的 `[`」当成结构括号 ⇒ 计数随机漂移（R168 实测踩到：
  // 同一份文件两次调用得到 20 与 15）。共用件里的 `stripCommentsAndStrings` 已经把这六种都处理过
  // （它服务于「数断言调用点」），**复用同一份**是唯一不会分叉的做法。
  const text = stripCommentsAndStrings(String(src ?? ""));
  // ⚠️ 剥掉字符串后，`const X = [` 的 `[` 仍在（它是结构），所以定位不受影响。
  const decl = new RegExp(`(?:^|\\n)[ \\t]*(?:const|let|var)[ \\t]+${name}[ \\t]*(?::[^=]+)?=[ \\t]*\\[`, "m");
  const m = decl.exec(text);
  if (!m) throw new Error(`源码里找不到用例表：${name}`);
  const start = m.index + m[0].length - 1; // 指向 `[`
  let depth = 0;
  let elements = 0;
  let expectValue = true;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "[" || ch === "{" || ch === "(") {
      depth += 1;
      // 顶层数组的**元素**：深度 2 且期待一个值的位置上遇到开括号
      if (depth === 2 && expectValue) {
        elements += 1;
        expectValue = false;
      }
      continue;
    }
    if (ch === "]" || ch === "}" || ch === ")") {
      depth -= 1;
      if (depth === 0) return elements;
      continue;
    }
    if (depth === 1 && ch === ",") {
      expectValue = true;
      continue;
    }
  }
  throw new Error(`用例表 ${name} 的括号没有配平（源码被截断？）`);
}

export function countAssertionCallSites(src, helper) {
  const name = String(helper ?? "").trim();
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error(`断言函数名非法：${JSON.stringify(helper)}`);
  }
  const code = stripCommentsAndStrings(src);
  const re = new RegExp(`(?<![.\\w$])${name}\\s*\\(`, "g");
  let calls = 0;
  for (const m of code.matchAll(re)) {
    const before = code.slice(0, m.index);
    if (/\bfunction\s*$/.test(before)) continue; // 函数定义不是调用点
    calls += 1;
  }
  return calls;
}

/**
 * 读一个守卫脚本的断言调用点数（哨兵侧的**交叉核对**用同一套口径）。
 *
 * @param {string} abs 守卫脚本绝对路径
 * @param {string} helper 断言函数名
 * @returns {number} 调用点数（读不到文件 ⇒ 0；哨兵会把 0 与「计数行缺失」一并结构红）
 */
export function readGuardAssertionCount(abs, helper) {
  try {
    return countAssertionCallSites(readFileSync(abs, "utf8"), helper);
  } catch {
    return 0;
  }
}

/**
 * 打印计数行（守卫侧出口）。
 *
 * 用 `writeSync(1, …)` 而不是 `console.log`：守卫可能在**下一行**就因缺依赖崩掉，
 * 管道上的异步写会丢，同步写不会。崩之前已经报出「本守卫声明了多少用例」，
 * 于是「缺依赖」与「零用例」在哨兵眼里是两件事。
 *
 * @param {string|URL} moduleUrl 守卫自己的模块 URL（传 `import.meta.url`）
 * @param {string} helper 断言函数名（`check` / `must` …）
 */
export function printCoverageBanner(moduleUrl, helper) {
  // R163：**只在「本模块就是进程入口」时打印**。
  //
  // 病：守卫之间会 **import 彼此**（例：`check-dependency-review` import
  // `check-npm-audit-exemptions`；`check-spec-coupling-surfaces` import
  // `check-source-text-contracts`；`check-web-type-field-drift` import
  // `check-web-type-drift`）。banner 在**模块顶层**执行 ⇒ 被 import 时也打印
  // ⇒ 一次运行出现**两行 `COVERAGE_CASES`**（各说各的数）⇒ 哨兵判**结构红**
  // 「输出里有互相冲突的计数行（6 / 13）」，且**这个红与判据质量无关**。
  //
  // 修法：用 `process.argv[1]` 判定「本次进程是不是在跑这个文件」——
  // 是 ⇒ 打印（正常情形）；不是（被别的守卫 import）⇒ **静默不打印**，
  // 让**入口那个守卫**的计数成为唯一权威。计数仍照常返回（调用方可复用）。
  //
  // 这也是**唯一一类**能让「批量加计数行」整体失效的坑：**被 import 的守卫
  // 不能有 banner**，而「谁 import 谁」是隐式的、批量脚本看不见。
  try {
    const self = fileURLToPath(moduleUrl);
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : null;
    if (entry !== null && path.resolve(self) !== entry) return 0;
  } catch {
    // 判不出入口就照常打印（宁可多一行，也不要因为环境怪而静默丢掉计数行）。
  }
  let count = 0;
  try {
    const file = fileURLToPath(moduleUrl);
    count = countAssertionCallSites(readFileSync(file, "utf8"), helper);
  } catch {
    // 数不出来就报 0：哨兵会据此判红（结构红），比悄悄报一个假数字安全。
    count = 0;
  }
  const line = `${COVERAGE_PREFIX} ${count}\n`;
  try {
    writeSync(1, line);
  } catch {
    // stdout 不可写（极端环境）时退回普通写；写不出去就什么也不做（哨兵会结构红）。
    try {
      process.stdout.write(line);
    } catch {
      /* ignore */
    }
  }
  return count;
}

/**
 * 解析守卫输出里的计数行（哨兵侧）。
 *
 * @returns {{ok: true, count: number} | {ok: false, reason: string}}
 *   `ok:false` ⇒ **结构红**：输出里没有计数行、格式坏了、或出现多个互相冲突的值。
 *   绝不把「解析不出来」当成「通过」。
 */
/**
 * 打印**数据驱动用例表**的覆盖计数行（R168 的一等形态）。
 *
 * ## 格式（哨兵侧解析）
 *
 *   COVERAGE_CASES: 22
 *   COVERAGE_TABLE: SELFTEST_CASES=20,EXTRA_SELFTEST_CASES=2
 *
 * `COVERAGE_TABLE` 把**表名与各自长度**都打出来 ⇒ 哨兵能**独立**去源码里数那张表
 * （`countTableEntries`）并与守卫打印的数字**对照** ⇒ **交叉核对依然成立**
 * （防「把计数写死」与「换一张表」两件事）。
 *
 * ⚠️ 必须与 `printCoverageBanner` **互斥**：哨兵 `parseCoverageCount` 遇到**两行**互相冲突的
 * `COVERAGE_CASES` 会判结构红 ⇒ 一个守卫**只能有一种**计数出口。
 *
 * @param {Record<string, number>} tables 表名 → 长度（由调用方现算）
 */
export function printTableCoverageBanner(tables) {
  const entries = Object.entries(tables ?? {});
  const total = entries.reduce((acc, [, n]) => acc + (Number(n) || 0), 0);
  const lines = [`${COVERAGE_PREFIX} ${total}\n`, `COVERAGE_TABLE: ${entries.map(([k, n]) => `${k}=${n}`).join(",")}\n`];
  for (const line of lines) {
    try {
      writeSync(1, line);
    } catch {
      try {
        process.stdout.write(line);
      } catch {
        /* ignore */
      }
    }
  }
  return total;
}

export function parseCoverageCount(output) {
  const text = String(output ?? "");
  const re = new RegExp(`^\\s*${COVERAGE_PREFIX}[ \\t]*([^\\s]*)[ \\t]*$`, "gm");
  const values = [];
  let m;
  while ((m = re.exec(text)) !== null) values.push(m[1]);
  if (values.length === 0) {
    return { ok: false, reason: `输出里没有 ${COVERAGE_PREFIX} 计数行` };
  }
  const distinct = [...new Set(values)];
  if (distinct.length > 1) {
    return {
      ok: false,
      reason: `输出里有互相冲突的计数行（${distinct.join(" / ")}）`,
    };
  }
  const raw = distinct[0];
  if (!/^\d+$/.test(raw)) {
    return { ok: false, reason: `计数行不是非负整数：${JSON.stringify(raw)}` };
  }
  return { ok: true, count: Number.parseInt(raw, 10) };
}
