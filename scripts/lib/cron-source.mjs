#!/usr/bin/env node
/**
 * `@Cron` 源扫描的共享词法层 —— `check-cron-guard.mjs` 与
 * `check-cron-leader-gate.mjs` 共用一份「装饰器 → 方法 → 方法体」的解析。
 *
 * ## 为什么抽成 lib（T4 第 4 轮守卫自检审计）
 *
 * 两条 cron 守卫此前各自实现了一遍「找 @Cron、截方法体」：
 *   · `check-cron-guard` 用词法掩码 + 花括号配平（做得对）；
 *   · `check-cron-leader-gate` 用 `^  \}` 断行 + 固定 40 行窗口（**假绿**：方法体
 *     若是 4 空格缩进、或收尾写成 `  };`，窗口停不下来，于是**下一个方法**的门禁
 *     被算到当前方法头上）。
 * 同一件事写两份，就必然各自腐烂；而 harness 文档里点名批评过「手抄副本与被测代码
 * 各自演化」。所以解析只留一份，两条守卫只在其上写自己的判据词。
 *
 * ## 掩码（而不是「按行删注释」）
 *
 * 把注释与字符串内容替换为空格、保留换行（行号不变）。必要性：
 *   · 注释里的 `@Cron(` 不是装饰器；注释里的 `try {` / `isLeader` 不是闸 —— 三条
 *     历史假绿全部出自「注释也算数」；
 *   · 字符串里的 `{`/`}` 不能被算进花括号配对，否则方法体边界漂移。
 *
 * 已知边界：正则字面量（`/'/`、`/}/`）不单独识别，会被当成除号/普通字符。这两条守卫
 * 面对的是 NestJS 服务文件（装饰器 + 方法体），正则字面量里同时出现引号与花括号的
 * 概率极低；而且方向是「掩码过多 ⇒ 少命中 ⇒ 报红或计数下降」而不是假绿（扫描面
 * 下界会把塌陷的计数变成结构红）。
 */

/**
 * 把注释与字符串内容替换成空格（保留 `\n`，行号不变）。
 *
 * @param {string} src
 * @returns {string} 等长、非代码位置被空格覆盖的文本
 */
export function maskNonCode(src) {
  const out = src.split("");
  const hide = (i) => {
    if (i >= 0 && i < out.length && out[i] !== "\n") out[i] = " ";
  };
  let state = "code"; // code | line | block | single | double | template
  const tplStack = []; // 模板 `${ ... }` 里的花括号深度
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

/** 从 `open` 处的 `openCh` 找配对的 `closeCh`，返回下标；未配平返回 -1。 */
export function matchBracket(masked, open, openCh, closeCh) {
  if (open < 0) return -1;
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

/** 每行起始偏移（用于 offset → 行号）。 */
export function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++)
    if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

/** offset → 1 基行号。 */
export function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** 方法签名：跳过其它装饰器与修饰符，取出方法名。 */
const SIGNATURE = new RegExp(
  "^\\s*" +
    "(?:@[A-Za-z_$][\\w$.]*\\s*(?:\\([^()]*\\))?\\s*)*" +
    "(?:(?:public|private|protected|readonly|static|override|async|declare)\\s+)*" +
    "([A-Za-z_$][\\w$]*)\\s*\\(",
);

/**
 * 扫出一个源文件里所有**真正的** `@Cron` 方法。
 *
 * 返回三部分，缺一不可：
 *   · `sites` —— 解析成功的方法：行号 + 方法名 + 掩码后的方法体文本；
 *   · `unparsed` —— **看得见 `@Cron(` 却解析不出方法体**的站点。T4 之前这些站点被
 *     一串联 `continue` 静默跳过：它既不进 `total`，也不进 `unguarded` —— 也就是说
 *     「一个写坏的 @Cron」对两条守卫都是**不存在**的。这是本仓最熟悉的假绿形态
 *     （「没被扫到 = 没问题」），所以现在单列出来，由调用方判结构红；
 *   · `nonMethod` —— 不是方法装饰器的 `@Cron`（如 `@Cron(...) field = …`），
 *     计入「已识别、非方法」而不是解析失败。
 *
 * @param {string} source 源文本
 * @returns {{sites: Array<{line: number, method: string, body: string, bodyOffset: number}>,
 *            unparsed: Array<{line: number, method: string|null, reason: string}>,
 *            nonMethod: number}}
 */
export function findCronSites(source) {
  const masked = maskNonCode(source);
  const starts = lineStarts(masked);
  const sites = [];
  const unparsed = [];
  let nonMethod = 0;

  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== "@") continue;
    if (!/^@Cron\s*\(/.test(masked.slice(i, i + 20))) continue;

    const line = lineOf(starts, i);
    const openParen = masked.indexOf("(", i);
    const closeParen = matchBracket(masked, openParen, "(", ")");
    if (closeParen < 0) {
      unparsed.push({ line, method: null, reason: "装饰器实参括号未配平" });
      continue;
    }

    const sig = SIGNATURE.exec(masked.slice(closeParen + 1, closeParen + 400));
    if (!sig) {
      // 属性/字段装饰器：`@Cron(...) foo = …`。不是方法，不算解析失败。
      nonMethod += 1;
      continue;
    }
    const method = sig[1];
    const paramOpen = closeParen + 1 + sig[0].length - 1; // 签名里 `(` 的下标
    const paramClose = matchBracket(masked, paramOpen, "(", ")");
    if (paramClose < 0) {
      unparsed.push({ line, method, reason: "方法参数表未配平" });
      continue;
    }

    // 参数表之后：可能还有返回类型注解（`Promise<void>` / `: Foo<T>`），
    // 方法体是随后第一个 `{`。裸声明（`;`）没有方法体。
    let cursor = paramClose + 1;
    while (cursor < masked.length && /[\s:]/.test(masked[cursor])) cursor += 1;
    while (
      cursor < masked.length &&
      masked[cursor] !== "{" &&
      masked[cursor] !== ";" &&
      masked[cursor] !== "="
    ) {
      cursor += 1;
    }
    if (cursor >= masked.length) {
      unparsed.push({ line, method, reason: "方法体在文件末尾仍未出现" });
      continue;
    }
    if (masked[cursor] !== "{") {
      unparsed.push({
        line,
        method,
        reason: `方法体缺失（签名后停在 ${JSON.stringify(masked[cursor])}）`,
      });
      continue;
    }
    const bodyEnd = matchBracket(masked, cursor, "{", "}");
    if (bodyEnd < 0) {
      unparsed.push({ line, method, reason: "方法体花括号未配平" });
      continue;
    }
    sites.push({
      line,
      method,
      body: masked.slice(cursor, bodyEnd + 1),
      bodyOffset: cursor,
    });
  }

  return { sites, unparsed, nonMethod };
}
