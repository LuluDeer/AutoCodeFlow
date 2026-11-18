/**
 * R263（→ 478）：**注释剥离的唯一实现** —— 供守卫统一使用。
 *
 * ## 为什么要有共用件（三次同族事故的收口）
 *
 * 本仓守卫多次栽在「**注释被当成代码**」上：
 * - **R253**：`ciText` 把 YAML 注释里提到的路径判成「已接线」；
 * - **R255**：`package.json` 的 `//` 注释键被当成依赖引用；
 * - **R262**：`check-cli-doc` 数 `.command(` 时未剥注释（当前 0 处，风险已记录）。
 *
 * 而全仓当时有 **16 份各自实现的 `stripComments`**，其中 **4 份是正则版**：
 *
 * ```js
 * text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
 * ```
 *
 * ⚠️ **它只剥「行首」的行注释**（`^\s*\/\/`），**行尾注释(b)` 完全漏剥**：
 *
 * ```js
 * const a = 1;      // 这里提到 .command( 只是说明
 * ```
 * 上面这一行在正则版下 `.command(` 仍存在 ⇒ **计数多 1**。实测（R263）：
 * 同一段样本，正则版得 1、字符机版得 0 —— 前者会让「文档数字与代码不符」这类判据**误报**。
 *
 * ## 本实现的语义（与 `check-agent-event-causation` 的原版一致）
 *
 * - 逐字符扫描，**正确处理字符串字面量**（`'` / `"` / `` ` ``，含 `\` 转义）——
 *   字符串里的 `//` / `/*` **不是**注释；
 * - 剥掉的部分用**等长空格**填充（换行保留）⇒ **行号与列号不变**，
 *   调用方按行/按位置断言时不会错位；
 * - 行注释（`//` 到行尾）与块注释（`/* … *\/`，可跨行）都剥。
 *
 * ## 用法
 *
 * ```js
 * import { stripComments } from "./lib/strip-comments.mjs";
 * const code = stripComments(readFileSync(file, "utf8"));
 * ```
 */

/**
 * 剥掉 JS/TS 源码里的注释，字符串字面量原样保留。
 *
 * @param {string} src 源码全文
 * @returns {string} 与输入**等长**（含换行位置）的文本，注释位置变成空格
 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    // 行注释：`//` 到行尾（**不限行首** —— 这是正则版漏掉的那一半）
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    // 块注释：`/* … */`，跨行时保留换行
    if (ch === "/" && next === "*") {
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
    // 字符串字面量：整段原样带出（内部 `//` / `/*` 不算注释）
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        const c = src[i];
        if (c === "\\") {
          out += c + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += c;
        i += 1;
        if (c === quote) break;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
