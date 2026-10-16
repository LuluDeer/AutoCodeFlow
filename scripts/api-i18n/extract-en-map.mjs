#!/usr/bin/env node
/**
 * 从**源码现状**抽取 `中文 → 英文` 映射，并与既有 map 合并（不丢任何已有翻译）。
 *
 * ## 为什么需要它
 *
 * 设计变更为「英文不内联在装饰器里，改为导出期注入」之后，源码里那些
 * `"x-i18n-en"` 值就成了**唯一的一份英文**——必须先落盘到 map，再删源码键，
 * 否则这批翻译（实测上千条）会随清理一起消失。
 *
 * 抽取面覆盖两种形态：
 *   · `description: "中文", "x-i18n-en": "English"`                      → 键=中文
 *   · `description: "中文", "x-i18n-en": { value: "English" }`           → 键=中文
 *   · `summary: "中文", "x-i18n-en": { summary: "English" }`             → 键=中文
 *   · `description: "中文", "x-i18n-en": { description: "English" }`     → 键=中文
 *
 * 合并策略（**只增不改**，且冲突时保留既有）：
 *   · 既有 map 里的中文键**不被覆盖**——人工/早前批次的译文优先，避免用
 *     自动化产物把已审过的文案改掉；
 *   · 新键直接加入；
 *   · 冲突（同中文键两种英文）如实报告，便于人工抽查。
 *
 * 用法: node scripts/api-i18n/extract-en-map.mjs [--apply]
 */
import * as fs from "node:fs";
import * as path from "node:path";

const APPLY = process.argv.includes("--apply");
const ROOT = process.cwd();
const MAP_PATH = path.join(ROOT, "scripts/api-i18n/data/openapi-en-map.json");
const EXTRACTED_PATH = path.join(
  ROOT,
  "scripts/api-i18n/data/openapi-en-map.extracted.json",
);

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

/**
 * 还原 TS 字符串字面量里的转义。
 *
 * ⚠️ 必须**单趟**扫描，不能连续 `replace`：连续替换时 `\\"`（反斜杠+引号）
 * 会先被 `\\"`→`"` 吃掉反斜杠，再被 `\\\\`→`\\` 二次处理，结果与源码不符。
 * 单趟扫描按「遇到反斜杠就看下一个字符」处理，语义与 JS 解析器一致。
 */
function unesc(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "\\") {
      out += s[i];
      continue;
    }
    const n = s[i + 1];
    if (n === undefined) {
      out += "\\";
      break;
    }
    if (n === "n") out += "\n";
    else if (n === "t") out += "\t";
    else if (n === "r") out += "\r";
    else out += n; // \" \' \\ \` 等一律取字面字符
    i++;
  }
  return out;
}

/** 从一段 options 文本里取简单字符串字段。 */
function simpleField(seg, name) {
  const re = new RegExp(`${name}\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const m = re.exec(seg);
  return m ? unesc(m[1]) : null;
}

const found = new Map();
const conflicts = [];

for (const file of walk(path.join(ROOT, "apps/admin-api/src"))) {
  const src = fs.readFileSync(file, "utf8");
  if (!src.includes('"x-i18n-en"')) continue;

  // 逐个装饰器扫描
  let i = 0;
  for (;;) {
    const d = /@Api[A-Za-z]*\(/.exec(src.slice(i));
    if (!d) break;
    const openIdx = i + d.index + d[0].length - 1;
    const closeIdx = matchBracket(src, openIdx);
    if (closeIdx === -1) break;
    const arg = src.slice(openIdx + 1, closeIdx);
    i = closeIdx + 1;
    if (!arg.includes('"x-i18n-en"')) continue;

    const bStart = arg.indexOf("{");
    if (bStart === -1) continue;
    const bEnd = matchBracket(arg, bStart);
    if (bEnd === -1) continue;
    const inner = arg.slice(bStart + 1, bEnd);
    const segs = splitTop(inner);

    // 该 options 里的中文（description / summary）与英文载体
    let zhDesc = null;
    let zhSummary = null;
    let enNode = null;
    for (const seg of segs) {
      if (/^\s*description\s*:/.test(seg)) zhDesc = simpleField(seg, "description");
      else if (/^\s*summary\s*:/.test(seg)) zhSummary = simpleField(seg, "summary");
      else if (/^\s*"x-i18n-en"\s*:/.test(seg)) {
        const after = seg.replace(/^[^:]*:/, "").trim();
        if (after.startsWith("{")) {
          const ie = matchBracket(after, 0);
          const body = ie === -1 ? "" : after.slice(1, ie);
          const o = {};
          for (const s2 of splitTop(body)) {
            if (/^\s*value\s*:/.test(s2)) o.value = simpleField(s2, "value");
            else if (/^\s*summary\s*:/.test(s2)) o.summary = simpleField(s2, "summary");
            else if (/^\s*description\s*:/.test(s2))
              o.description = simpleField(s2, "description");
          }
          enNode = o;
        } else {
          enNode = { value: simpleField(seg, '"x-i18n-en"') };
        }
      }
    }
    if (!enNode) continue;

    const put = (zh, en) => {
      if (!zh || !en) return;
      if (found.has(zh) && found.get(zh) !== en) {
        conflicts.push({ zh, kept: found.get(zh), other: en });
        return;
      }
      found.set(zh, en);
    };
    // 属性面：value 对应 description
    if (enNode.value !== undefined) put(zhDesc, enNode.value);
    // operation 面：summary/description 分别对应
    if (enNode.summary !== undefined) put(zhSummary, enNode.summary);
    if (enNode.description !== undefined) put(zhDesc, enNode.description);
  }
}

// 合并：既有优先，只增不改
const existing = fs.existsSync(MAP_PATH)
  ? JSON.parse(fs.readFileSync(MAP_PATH, "utf8"))
  : {};
let added = 0;
let keptExisting = 0;
const merged = { ...existing };
for (const [zh, en] of found) {
  if (Object.prototype.hasOwnProperty.call(existing, zh)) {
    keptExisting++;
    if (existing[zh] !== en) {
      conflicts.push({ zh, kept: existing[zh], other: en });
    }
    continue;
  }
  merged[zh] = en;
  added++;
}

console.log(
  JSON.stringify(
    {
      extractedFromSource: found.size,
      existingMapEntries: Object.keys(existing).length,
      added,
      keptExisting,
      mergedTotal: Object.keys(merged).length,
      conflicts: conflicts.length,
      conflictSamples: conflicts.slice(0, 10),
    },
    null,
    2,
  ),
);

if (APPLY) {
  fs.writeFileSync(MAP_PATH, JSON.stringify(merged, null, 2) + "\n", "utf8");
  // 另存一份"本次从源码抽出的"，便于核对与回滚
  fs.writeFileSync(
    EXTRACTED_PATH,
    JSON.stringify(Object.fromEntries(found), null, 2) + "\n",
    "utf8",
  );
  console.log("APPLIED → " + path.relative(ROOT, MAP_PATH));
} else {
  console.log("DRY RUN (pass --apply to write)");
}
