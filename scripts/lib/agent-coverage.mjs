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
import { join } from "node:path";
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
