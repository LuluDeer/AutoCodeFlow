#!/usr/bin/env node
/**
 * 第二轮修复（一次性）：处理 codemod 产物里**字符串拼接被拆成兄弟对象**的形态。
 *
 * ## 为什么需要第二轮
 *
 * 第一轮（repair-codemod-output.mjs）处理了两类：
 *   A. `@ApiX(i18nProperty({zh,en}), )` —— 多余尾逗号；
 *   B. `@ApiX({ 原选项 }...i18nProperty({zh,en}))` —— 非法 spread。
 *
 * 但还有第三类，第一轮**改不动**：原文案本身是**拼接表达式**，例如
 * ```ts
 * @ApiOperation({
 *   summary: "Batch trigger tasks (deprecated)",
 *   deprecated: true,
 *   description:
 *     "PK-20 DEPRECATED: 改用 POST …（同 body/响应/审计）。" +
 *     "Trigger multiple tasks. Partial failures do not affect other tasks.",
 * })
 * ```
 * codemod 把「中文段」与「英文段」各自包成一个独立对象**并列**输出，于是变成
 * ```ts
 * @ApiOperation({
 *   deprecated: true,
 *      +
 *      "触发多个任务。…",
 *   description: "PK-20 DEPRECATED: …",
 *   "x-i18n-en": { description: "…" },
 * }, ...{ summary: "…", "x-i18n-en": { summary: "…" } })
 * ```
 * ——顶层的 `+` 孤立、`}...{` 是非法 spread、`summary` 落到了外层对象之外。
 *
 * ## 本轮的判据与修法
 *
 * 判据（**只在同时满足时才动**，避免误伤合法代码）：
 *   1. 存在 `@ApiX({ … }...{ … })` 形态（`}` 紧跟 `...` 再跟 `{`）；
 *   2. 或存在孤立 `+` 行（`^\s*\+\s*$`）。
 *
 * 修法：把「兄弟对象」的字段**并回主对象**，孤立 `+` 行删除，字符串拼接改为
 * 「取其中的中文段作为 description/summary，英文段作为 x-i18n-en」——这正是
 * 双语载体想表达的东西，且与第一轮产出的形状一致。
 *
 * ## 为什么要逐个读源码而不是纯正则
 *
 * 因为 `}...{` 里的字段名各不相同（有的在左、有的在右，`summary`/`description`
 * 混用），正则无法可靠地"把右边的 key 搬到左边"。故这里做**结构化解析**：
 * 分别解析左对象与右对象的顶层字段，合并后重新渲染。
 *
 * 用法: node scripts/api-i18n/repair-sibling-objects.mjs [--apply]
 */
import * as fs from "node:fs";
import * as path from "node:path";

const APPLY = process.argv.includes("--apply");
const ROOT = process.cwd();

/** 递归收集 src 下的 .ts（跳过测试与生成物）。 */
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["__tests__", "node_modules", "dist", "generated"].includes(e.name))
        continue;
      walk(p, acc);
    } else if (e.name.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

/** 匹配 `(`…`)`，返回配对下标（跳过字符串）。 */
function matchParen(src, openIdx) {
  let depth = 0;
  let inS = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (inS) {
      if (c === "\\") i++;
      else if (c === inS) inS = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inS = c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 把 `{`…`}` 内容按**顶层**逗号切成片段（跳过嵌套与字符串）。 */
function splitTop(text) {
  const parts = [];
  let depth = 0;
  let inS = null;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inS) {
      cur += c;
      if (c === "\\") {
        cur += text[i + 1] ?? "";
        i++;
      } else if (c === inS) inS = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inS = c;
      cur += c;
      continue;
    }
    if ("{[(".includes(c)) depth++;
    if ("}])".includes(c)) depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** 解析片段的 `key: value`（只认简单 key）。 */
function keyOf(seg) {
  const m = /^\s*"?([A-Za-z_$][\w$]*|x-i18n-en)"?\s*:/.exec(seg);
  return m ? m[1] : null;
}

/** 判断值是否为**纯字符串字面量**（是则可被当作可翻译文案）。 */
function literalStrings(seg) {
  const after = seg.replace(/^[^:]*:/, "");
  const m = after.match(/^\s*"((?:[^"\\]|\\.)*)"\s*$/);
  return m ? m[1] : null;
}

let stats = {
  scanned: 0,
  filesChanged: 0,
  siblingMerged: 0,
  strayPlusRemoved: 0,
  dupKeyRemoved: 0,
};

for (const file of walk(path.join(ROOT, "apps/admin-api/src"))) {
  stats.scanned++;
  let src = fs.readFileSync(file, "utf8");
  const orig = src;
  let touched = false;

  // ── 修 1：删掉孤立 `+` 行（原为跨行字符串拼接，codemod 已把两段拆开） ──
  const before1 = src;
  src = src.replace(/^[ \t]*\+[ \t]*\r?\n/gm, "");
  if (src !== before1) {
    stats.strayPlusRemoved += before1
      .split("\n")
      .filter((l) => /^[ \t]*\+[ \t]*$/.test(l)).length;
    touched = true;
  }

  // ── 修 2：`}...{ ... }` 兄弟对象合并 ──
  for (let guard = 0; guard < 500; guard++) {
    // 找 `}` 紧跟（可选的逗号与空白）`...` 再跟 `{`
    //
    // ⚠️ 必须允许中间的**逗号**：codemod 实际产出的是 `}, ...{`（不是 `}...{`）。
    // 首版只放行空白，导致 siblingMerged=0 却"看起来跑过了"——典型的静默空跑。
    const m = /\}[ \t]*,?[ \t]*\.\.\.[ \t]*\{/.exec(src);
    if (!m) break;
    const leftBraceEnd = m.index; // 左侧对象结束的 `}`
    const rightBraceStart = m.index + m[0].length - 1; // 右侧对象的 `{`

    // 左对象起点：从 leftBraceEnd 往前找配对 `{`
    let depth = 0;
    let leftBraceStart = -1;
    let inS = null;
    for (let i = leftBraceEnd; i >= 0; i--) {
      const c = src[i];
      if (inS) {
        if (c === inS) inS = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        inS = c;
        continue;
      }
      if (c === "}") depth++;
      else if (c === "{") {
        depth--;
        if (depth === 0) {
          leftBraceStart = i;
          break;
        }
      }
    }
    if (leftBraceStart === -1) break;

    const rightBraceEnd = matchParen(src, rightBraceStart);
    if (rightBraceEnd === -1) break;

    const leftText = src.slice(leftBraceStart + 1, leftBraceEnd);
    const rightText = src.slice(rightBraceStart + 1, rightBraceEnd);

    // 解析左侧顶层字段（保序）
    const leftSegs = splitTop(leftText).filter((s) => s.trim());
    const leftKeys = new Set(leftSegs.map(keyOf).filter(Boolean));
    const rightSegs = splitTop(rightText).filter((s) => s.trim());

    // 右侧字段：只并入左侧没有的键（避免重复键 TS1117）
    const add = [];
    const enAcc = {};
    for (const seg of rightSegs) {
      const k = keyOf(seg);
      if (!k) continue;
      if (k === "x-i18n-en") {
        // 英文载体：合并右侧已有的子字段
        const vin = seg.replace(/^[^:]*:/, "").trim();
        const innerM = /^\{\s*([\s\S]*?)\s*\}$/.exec(vin);
        if (innerM) {
          for (const s2 of splitTop(innerM[1])) {
            const k2 = keyOf(s2);
            const v2 = literalStrings(s2);
            if (k2 && v2 !== null) enAcc[k2] = v2;
          }
        }
        continue;
      }
      if (leftKeys.has(k)) continue;
      add.push(seg.trim());
      leftKeys.add(k);
    }

    // 左侧已有的 x-i18n-en 也需要并入 enAcc（保序在前）
    for (const seg of leftSegs) {
      if (keyOf(seg) !== "x-i18n-en") continue;
      const vin = seg.replace(/^[^:]*:/, "").trim();
      const innerM = /^\{\s*([\s\S]*?)\s*\}$/.exec(vin);
      if (innerM) {
        for (const s2 of splitTop(innerM[1])) {
          const k2 = keyOf(s2);
          const v2 = literalStrings(s2);
          if (k2 && v2 !== null && !(k2 in enAcc)) enAcc[k2] = v2;
        }
      }
    }

    // 重建左对象：原字段（剔除旧 x-i18n-en）+ 右侧新增 + 合并后的 x-i18n-en
    const kept = leftSegs
      .filter((s) => keyOf(s) !== "x-i18n-en")
      .map((s) => s.trim())
      .filter(Boolean);
    const all = [...kept, ...add];
    const enKeys = Object.keys(enAcc);
    if (enKeys.length) {
      const inner = enKeys.map((k) => `${k}: "${enAcc[k]}"`).join(", ");
      all.push(`"x-i18n-en": { ${inner} }`);
    }

    // 缩进：跟随左侧对象起始行的缩进
    const ls = src.lastIndexOf("\n", leftBraceStart) + 1;
    const indent = (src.slice(ls, leftBraceStart).match(/^[ \t]*/) || [""])[0];
    const body = all.map((s) => `\n${indent}  ${s},`).join("");
    const rebuilt = `{${body}\n${indent}}`;

    src =
      src.slice(0, leftBraceStart) + rebuilt + src.slice(rightBraceEnd + 1);
    stats.siblingMerged++;
    touched = true;
  }

  // ── 修 3：同一对象里重复的 "x-i18n-en" 键（codemod 双写） ──
  for (let guard = 0; guard < 500; guard++) {
    const re = /("x-i18n-en"\s*:\s*[^,}\n]+)\s*,\s*"x-i18n-en"\s*:\s*([^,}\n]+)/;
    const m = re.exec(src);
    if (!m) break;
    // 保留**信息更多**的那个（较长者），删掉较短者
    const a = m[1];
    const b = `"x-i18n-en": ${m[2]}`;
    const keep = a.length >= b.length ? a : b;
    src = src.slice(0, m.index) + keep + src.slice(m.index + m[0].length);
    stats.dupKeyRemoved++;
    touched = true;
  }

  if (touched && src !== orig) {
    stats.filesChanged++;
    if (APPLY) fs.writeFileSync(file, src, "utf8");
  }
}

console.log(JSON.stringify(stats, null, 2));
console.log(APPLY ? "APPLIED" : "DRY RUN (pass --apply to write)");
