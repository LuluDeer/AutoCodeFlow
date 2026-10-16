#!/usr/bin/env node
/**
 * 第四轮（收尾）：修「孤立字符串当对象键」。
 *
 * ## 形态
 *
 * codemod 把拼接表达式里的字符串段切出来后，有的段**既不是 key 也不是合法
 * 值**，落成了对象里的一条裸字符串：
 * ```ts
 * @ApiOperation({
 *   deprecated: true,
 *   "触发多个任务。部分失败不影响其他任务。",     ← 裸字符串（非法）
 *   description: "PK-20 DEPRECATED: …",
 * })
 * ```
 * 这段裸字符串**原本就是中文 description 的一部分**（原文案是
 * `descZh + descEn` 的拼接），故正确处置是：**把它并入 description**（英文段
 * 已在 `x-i18n-en.description` 里），而不是丢弃——丢弃会静默少一段文案。
 *
 * ## 判据（保守，只在明确形态上动手）
 *
 * 在**对象字面量的顶层**出现「仅由字符串字面量构成」的片段（无 `key:`）时，
 * 视为裸字符串段：将其追加到同层 `description` 的值尾；若该层没有
 * `description`，则新建一条 `description`。
 *
 * 用法: node scripts/api-i18n/fix-bare-strings.mjs [--apply]
 */
import * as fs from "node:fs";
import * as path from "node:path";

const APPLY = process.argv.includes("--apply");
const ROOT = process.cwd();

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

const OPEN = { "(": ")", "{": "}", "[": "]" };
const CLOSE = { ")": "(", "}": "{", "]": "[" };

function matchBracket(src, openIdx) {
  const stack = [];
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
    if (OPEN[c]) stack.push(c);
    else if (CLOSE[c]) {
      if (!stack.length) return -1;
      if (OPEN[stack[stack.length - 1]] !== c) return -1;
      stack.pop();
      if (!stack.length) return i;
    }
  }
  return -1;
}

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

/** 片段是否整体就是一个字符串字面量（可跨行拼接）。 */
function bareStringValue(seg) {
  const t = seg.trim();
  if (!t) return null;
  // 形如 "a" 或 "a" + "b"
  const parts = t.split("+").map((s) => s.trim());
  let acc = "";
  for (const p of parts) {
    const m = /^"((?:[^"\\]|\\.)*)"$/.exec(p);
    if (!m) return null;
    acc += m[1];
  }
  return acc;
}

function q(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

const stats = { files: 0, filesChanged: 0, merged: 0, created: 0, skipped: [] };

for (const file of walk(path.join(ROOT, "apps/admin-api/src"))) {
  const src = fs.readFileSync(file, "utf8");
  if (!src.includes("@Api")) continue;
  stats.files++;
  let out = src;
  let touched = false;

  // 从后往前找所有 `@Api…( { … } )`，处理其**顶层**裸字符串
  const spans = [];
  {
    let i = 0;
    for (;;) {
      const d = /@Api[A-Za-z]*\(/.exec(out.slice(i));
      if (!d) break;
      const at = i + d.index + d[0].length - 1;
      const end = matchBracket(out, at);
      if (end === -1) break;
      spans.push([at, end]);
      i = end + 1;
    }
  }

  for (let s = spans.length - 1; s >= 0; s--) {
    const [openIdx, closeIdx] = spans[s];
    let arg = out.slice(openIdx + 1, closeIdx);
    const bStart = arg.indexOf("{");
    if (bStart === -1) continue;
    const bEnd = matchBracket(arg, bStart);
    if (bEnd === -1) continue;
    const inner = arg.slice(bStart + 1, bEnd);
    const segs = splitTop(inner).map((x) => x.trim()).filter(Boolean);

    const bares = [];
    const kept = [];
    for (const seg of segs) {
      if (/^"?[A-Za-z_$][\w$]*"?\s*:/.test(seg) || /^"x-i18n-en"\s*:/.test(seg)) {
        kept.push(seg);
        continue;
      }
      const v = bareStringValue(seg);
      if (v !== null) bares.push(v);
      else kept.push(seg); // 不明形态 → 原样保留，不猜
    }
    if (!bares.length) continue;

    // 并入 description（同层）；没有就新建
    const di = kept.findIndex((k) => /^\s*description\s*:/.test(k));
    const add = bares.join(" ");
    if (di !== -1) {
      const m = /^\s*description\s*:\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(kept[di]);
      if (m) {
        kept[di] = `description: ${q(m[1] + add)}`;
        stats.merged++;
      } else {
        stats.skipped.push(path.basename(file) + ": description not a simple literal");
      }
    } else {
      kept.push(`description: ${q(add)}`);
      stats.created++;
    }

    const lineStart = arg.lastIndexOf("\n", bStart) + 1;
    const ind = (arg.slice(lineStart, bStart).match(/^[ \t]*/) || [""])[0];
    const body = kept.map((x) => `\n${ind}  ${x},`).join("");
    const objText = `{${body}\n${ind}}`;
    arg = arg.slice(0, bStart) + objText + arg.slice(bEnd + 1);
    out = out.slice(0, openIdx + 1) + arg + out.slice(closeIdx);
    touched = true;
  }

  if (touched && out !== src) {
    stats.filesChanged++;
    if (APPLY) fs.writeFileSync(file, out, "utf8");
  }
}

console.log(JSON.stringify(stats, null, 2));
console.log(APPLY ? "APPLIED" : "DRY RUN");
