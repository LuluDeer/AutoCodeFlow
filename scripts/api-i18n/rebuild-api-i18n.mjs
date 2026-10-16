#!/usr/bin/env node
/**
 * 第三轮（最终）修复：以**整个装饰器实参**为单位重建双语 options。
 *
 * ## 为什么前两轮不够
 *
 * 第一轮 `repair-codemod-output.mjs` 以**单个 `i18nProperty/i18nOperation` 调用**
 * 为单位处理。但 codemod 在"原文案是拼接表达式"的站点会产出**两个并列的
 * i18nOperation 调用**：
 * ```ts
 * @ApiOperation({
 *   deprecated: true,
 *      +
 *      "触发多个任务。部分失败不影响其他任务。",
 * }...i18nOperation({ descriptionZh: "…", descriptionEn: "…" }), ...i18nOperation({ summaryZh: "…", summaryEn: "…" }))
 * ```
 * 第一轮只合并了**第一个**，把第二个留成兄弟对象；第二轮又只能看到 `}, ...`，
 * 于是合并出了 `body:` 这类越界字段。**根因是切分单位错了**：正确的单位是
 * 「`@ApiX(` 到它配对的 `)`」这**整个实参**。
 *
 * ## 本轮的算法
 *
 * 1. 定位每个 `@Api<Name>(`，用括号配对取出其完整实参文本；
 * 2. 在实参内找出**所有** `i18nProperty(` / `i18nOperation(` 调用并逐个取出其
 *    zh/en 字段（`zh`/`en` 或 `summaryZh`/`summaryEn`/`descriptionZh`/`descriptionEn`）；
 * 3. 把这些调用从实参里**整段删除**，再删掉遗留的 `...`、孤立 `+` 行；
 * 4. 剩下的是"原有 options"——若它是对象字面量，则把双语字段**并入**它
 *    （已存在的同名键以"不覆盖"为准，避免丢原有 `deprecated` 等）；
 *    若已无内容，则直接生成新对象；
 * 5. 去重对象里的重复键（codemod 会把 `"x-i18n-en"` 写两遍）。
 *
 * ## 为什么从备份重跑而不是在当前树上增量修
 *
 * 当前树已被前两轮**部分改写**，形态混杂；而备份是 codemod 的**原始产物**，
 * 形态一致、可重复推导。备份只读、未被我改过，故它是可靠的重跑源。
 *
 * 用法: node scripts/api-i18n/rebuild-api-i18n.mjs <backup-dir> [--apply]
 */
import * as fs from "node:fs";
import * as path from "node:path";

const DIR = process.argv[2];
const APPLY = process.argv.includes("--apply");
if (!DIR) {
  console.error("用法: node rebuild-api-i18n.mjs <backup-dir> [--apply]");
  process.exit(2);
}
const ROOT = process.cwd();

/**
 * 匹配 `open`…配对闭合符（跳过字符串），返回配对下标。
 *
 * ⚠️ 必须同时处理 `(`/`{`/`[` 三种括号——首版只按 `(`/`)` 计数，于是在对象
 * 字面量（`{ ... }`）上永远配不上，全线报 `unbalanced object`。这三种括号在
 * 装饰器实参里是**混用**的（`@ApiBody({ schema: { … } })`），只数圆括号不够。
 */
function matchParen(src, openIdx) {
  const OPEN = { "(": ")", "{": "}", "[": "]" };
  const CLOSE = { ")": "(", "}": "{", "]": "[" };
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
      if (stack.length === 0) return -1;
      const top = stack[stack.length - 1];
      if (OPEN[top] !== c) return -1; // 括号种类不匹配
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** 按顶层逗号切分（跳过嵌套/字符串）。 */
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

/** 片段里的简单 key。 */
function keyOf(seg) {
  const m = /^\s*"?(x-i18n-en|[A-Za-z_$][\w$]*)"?\s*:/.exec(seg);
  return m ? m[1] : null;
}

/** 取字符串字面量的值（支持单双引号）。 */
function strVal(seg) {
  const after = seg.replace(/^[^:]*:/, "");
  const m = /^\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(after);
  return m ? m[1] : null;
}

/** 把字符串里的双引号转义，统一用双引号字面量。 */
function q(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** 从 i18n* 调用实参里抽字段。 */
function readI18nArgs(argText) {
  // ⚠️ 必须先剥掉**外层那一对花括号**：`splitTop` 会把 `{`/`}` 计入嵌套深度，
  // 故直接传 `{ zh: "A", en: "B" }` 时深度恒为 1，顶层逗号永远不满足
  // `depth === 0`，于是整段被当成**一个**片段返回 → `keyOf` 认不出 key →
  // 抽出空对象 → 双语字段全部丢失（实测产出 `@ApiProperty({  })` 这种空对象，
  // 全仓 6231 处编译错误）。这是本轮最隐蔽的一个 bug：脚本"成功"跑完、
  // unresolved 为空、却什么都没搬过去。
  let t = argText.trim();
  if (t.startsWith("{") && t.endsWith("}")) t = t.slice(1, -1);
  const o = {};
  for (const seg of splitTop(t)) {
    const k = keyOf(seg);
    if (!k) continue;
    const v = strVal(seg);
    if (v !== null) o[k] = v;
  }
  return o;
}

const stats = {
  files: 0,
  filesChanged: 0,
  decorators: 0,
  callsInlined: 0,
  unresolved: [],
};

for (const name of fs.readdirSync(DIR)) {
  if (!name.endsWith(".ts")) continue;
  const src = fs.readFileSync(path.join(DIR, name), "utf8");
  if (!/i18n(Property|Operation)\(/.test(src)) continue;
  stats.files++;

  let out = src;
  let touched = false;

  /**
   * 步骤 1：**从后往前**收集所有 `@ApiX(` 的实参区间，再倒序处理。
   *
   * 为什么倒序：每次替换都会改变其后所有下标。倒序处理保证「尚未处理的区间
   * 下标」始终有效，无需任何占位/屏蔽技巧（首版用 `\u0000` 占位来自欺，
   * 既绕又错）。
   */
  const spans = [];
  {
    let i = 0;
    for (;;) {
      const rest = out.slice(i);
      const d = /@Api[A-Za-z]*\(/.exec(rest);
      if (!d) break;
      const at = i + d.index;
      const openIdx = at + d[0].length - 1;
      const closeIdx = matchParen(out, openIdx);
      if (closeIdx === -1) {
        stats.unresolved.push(name + ": unbalanced @Api call");
        break;
      }
      spans.push({ openIdx, closeIdx });
      i = closeIdx + 1;
    }
  }

  // 倒序处理，下标不失效
  for (let s = spans.length - 1; s >= 0; s--) {
    const { openIdx, closeIdx } = spans[s];
    let arg = out.slice(openIdx + 1, closeIdx);
    if (!/i18n(Property|Operation)\(/.test(arg)) continue;

    // 抽取并删除所有 i18n* 调用
    const propFields = [];
    const opFields = [];
    const en = {};
    let changed = false;
    for (;;) {
      const m = /i18n(Property|Operation)\(/.exec(arg);
      if (!m) break;
      const cs = m.index;
      const co = cs + m[0].length - 1;
      const cc = matchParen(arg, co);
      if (cc === -1) {
        stats.unresolved.push(name + ": unbalanced i18n call");
        break;
      }
      const o = readI18nArgs(arg.slice(co + 1, cc));
      if (m[1] === "Property") {
        if (o.zh !== undefined) propFields.push(["description", o.zh]);
        if (o.en !== undefined) en.value = o.en;
      } else {
        if (o.summaryZh !== undefined) opFields.push(["summary", o.summaryZh]);
        if (o.descriptionZh !== undefined)
          opFields.push(["description", o.descriptionZh]);
        if (o.summaryEn !== undefined) en.summary = o.summaryEn;
        if (o.descriptionEn !== undefined) en.description = o.descriptionEn;
      }
      arg = arg.slice(0, cs) + arg.slice(cc + 1);
      stats.callsInlined++;
      changed = true;
    }
    if (!changed) continue;

    // 清理残留：`...`、孤立 `+` 行、多余的逗号
    arg = arg.replace(/\.\.\./g, "");
    arg = arg.replace(/^[ \t]*\+[ \t]*\r?\n/gm, "");
    arg = arg.replace(/^[ \t]*\+[ \t]*$/gm, "");
    // 去掉尾部悬空逗号
    arg = arg.replace(/,\s*$/, "");
    arg = arg.replace(/^\s*,\s*/, "");

    // 双语字段（保序：原字段在前）
    const want = [...propFields, ...opFields];
    const enKeys = Object.keys(en);

    // 找出 arg 里的对象字面量
    const braceStart = arg.indexOf("{");
    let rebuiltArg;
    if (braceStart !== -1) {
      const braceEnd = matchParen(arg, braceStart);
      if (braceEnd === -1) {
        stats.unresolved.push(name + ": unbalanced object");
        break;
      }
      const inner = arg.slice(braceStart + 1, braceEnd);
      const segs = splitTop(inner)
        .map((s) => s.trim())
        .filter(Boolean);
      const existing = new Set(segs.map(keyOf).filter(Boolean));
      const merged = segs.filter((s) => keyOf(s) !== "x-i18n-en");
      for (const [k, v] of want) {
        if (existing.has(k)) continue;
        merged.push(`${k}: ${q(v)}`);
        existing.add(k);
      }
      if (enKeys.length) {
        const innerEn = enKeys
          .map((k) => `${k}: ${q(en[k])}`)
          .join(", ");
        merged.push(`"x-i18n-en": { ${innerEn} }`);
      }
      // 缩进跟随原 arg 的 `{` 所在行
      const lineStart = arg.lastIndexOf("\n", braceStart) + 1;
      const ind = (arg.slice(lineStart, braceStart).match(/^[ \t]*/) || [""])[0];
      const body = merged.map((s) => `\n${ind}  ${s},`).join("");
      const objText = `{${body}\n${ind}}`;
      rebuiltArg = arg.slice(0, braceStart) + objText + arg.slice(braceEnd + 1);
    } else {
      const fields = [...want.map(([k, v]) => `${k}: ${q(v)}`)];
      if (enKeys.length) {
        const innerEn = enKeys.map((k) => `${k}: ${q(en[k])}`).join(", ");
        fields.push(`"x-i18n-en": { ${innerEn} }`);
      }
      rebuiltArg = `{ ${fields.join(", ")} }`;
    }

    // ⚠️ 尾部切片必须是 `slice(closeIdx)`（**含**配对的那个 `)`）。
    // 首版写 `slice(closeIdx + 1)` 把右括号一起丢掉了，产出
    // `@ApiProperty({ …description… }` 这种缺 `)` 的调用——全仓 519 行、
    // 6231 处编译错误。`closeIdx` 是 `)` 自身的下标，故从它开始切才保留它。
    out = out.slice(0, openIdx + 1) + rebuiltArg + out.slice(closeIdx);
    stats.decorators++;
    touched = true;
  }

  // 去重：同一对象里重复的 "x-i18n-en" 键（保留更长者）
  for (let guard = 0; guard < 3000; guard++) {
    const re = /("x-i18n-en"\s*:\s*[^,}\n]+)\s*,\s*"x-i18n-en"\s*:\s*([^,}\n]+)/;
    const m = re.exec(out);
    if (!m) break;
    const a = m[1];
    const b = `"x-i18n-en": ${m[2]}`;
    out = out.slice(0, m.index) + (a.length >= b.length ? a : b) + out.slice(m.index + m[0].length);
    touched = true;
  }

  if (touched && out !== src) {
    stats.filesChanged++;
    if (APPLY) {
      const repo = name.replace(/__/g, "/");
      fs.writeFileSync(repo, out, "utf8");
    }
  }
}

console.log(JSON.stringify(stats, null, 2));
console.log(APPLY ? "APPLIED to " + ROOT : "DRY RUN");
