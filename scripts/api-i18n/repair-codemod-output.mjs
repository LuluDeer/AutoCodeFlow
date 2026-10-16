#!/usr/bin/env node
/**
 * 修复 apply-codemod.mjs 留下的**非法语法**（一次性工具，修完即可删）。
 *
 * ## 背景（为什么要写这个脚本）
 *
 * `scripts/api-i18n/apply-codemod.mjs` 把双语载体写成了非法语法，实测
 * `tsc` **1025 处错误**，并且把 `alerts.controller.ts` **截断成 0 字节**
 * （8585 字节内容丢失）。它的产物不能直接用，但**内容是好的**——zh 与 en
 * 都在，只是包装错了。故本脚本只做**语法层**修复，不碰任何文案。
 *
 * ## 修复的两类形态
 *
 * 形态 A（装饰器实参就是 i18n 调用，多一个尾逗号）：
 * ```
 * @ApiProperty(i18nProperty({ zh: "A", en: "B" }), )
 * @ApiOperation(i18nOperation({ summaryZh: "A", summaryEn: "B" }), )
 * ```
 * → 去掉多余的 `, `，并**内联**成裸 options：
 * ```
 * @ApiProperty({ description: "A", "x-i18n-en": "B" })
 * @ApiOperation({ summary: "A", "x-i18n-en": { summary: "B" } })
 * ```
 *
 * 形态 B（原有 options 对象后面接了 `}...i18nProperty(...)`，非法 spread）：
 * ```
 * @ApiProperty({
 *     nullable: true,
 *     format: "uuid",
 *   }...i18nProperty({ zh: "A", en: "B" }))
 * ```
 * → 把双语字段**并进原有对象**：
 * ```
 * @ApiProperty({
 *     nullable: true,
 *     format: "uuid",
 *     description: "A",
 *     "x-i18n-en": "B",
 *   })
 * ```
 *
 * ## 为什么不保留 `i18nProperty` 包装，而是内联成裸 options
 *
 * · 裸扩展键是本仓**唯一**同时作用于 `@ApiProperty` 与 `@ApiOperation` 的机制
 *   （`@ApiExtension` 在属性/类上被静默丢弃——已由真实引导 Nest 实测确认）；
 *   内联后产物就是文档站直接读得到的形态，**少一层间接**；
 * · 84 个文件的 import 行也被 codemod 改坏，内联后无需再依赖那些 import；
 * · 内联是**逐处确定性**的，而修一个坏掉的 wrapper 调用要同时推断
 *   "原 options 该并到哪、逗号该不该补"，出错面更大。
 * · `api-i18n.ts` 的 `readI18nEn` / `I18N_EN_KEY` 仍然保留给文档站与守卫用。
 *
 * ## 用法
 *   node scripts/api-i18n/repair-codemod-output.mjs <dir-of-backup-files> [--apply]
 *   不带 --apply 只报告，不写盘。
 */
import * as fs from "node:fs";
import * as path from "node:path";

const DIR = process.argv[2];
const APPLY = process.argv.includes("--apply");
if (!DIR) {
  console.error("用法: node repair-codemod-output.mjs <backup-dir> [--apply]");
  process.exit(2);
}

/** 从备份文件名还原仓库相对路径（备份把 / 和 \ 都换成了 __）。 */
function toRepoPath(name) {
  // apps__admin-api__src__... → apps/admin-api/src/...
  return name.replace(/__/g, "/");
}

/** 扫描出 `name(` 的配对右括号下标；找不到返回 -1。 */
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

/** 取对象字面量里的某个字符串字段（支持单/双引号，含转义）。 */
function field(objText, name) {
  const re = new RegExp(
    `(?:^|[,{\\s])${name}:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)')`,
  );
  const m = re.exec(objText);
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2];
}

/** JS 字符串字面量转义（输出统一用双引号）。 */
function q(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** 依缩进生成一行。 */
function line(indent, text) {
  return `\n${indent}${text}`;
}

let stats = { files: 0, changed: 0, t1: 0, t2: 0, unresolved: [] };

function repair(src) {
  let out = src;
  let guard = 0;

  // 反复扫描，直到没有 i18nProperty/i18nOperation 残留。
  for (;;) {
    if (++guard > 5000) break;
    const m = /i18n(Property|Operation)\(/.exec(out);
    if (!m) break;

    const kind = m[1]; // Property | Operation
    const callStart = m.index;
    const openParen = callStart + m[0].length - 1;
    const closeParen = matchParen(out, openParen);
    if (closeParen === -1) {
      stats.unresolved.push("unbalanced " + kind);
      break;
    }
    const objText = out.slice(openParen + 1, closeParen);

    // 生成双语字段文本（含前导换行 + 缩进由调用处决定）
    let fields; // [{key, value}]，value 已渲染为字面量
    if (kind === "Property") {
      const zh = field(objText, "zh");
      const en = field(objText, "en");
      if (zh === null || en === null) {
        stats.unresolved.push("prop fields missing");
        break;
      }
      fields = [
        { key: "description", value: q(zh) },
        { key: '"x-i18n-en"', value: q(en) },
      ];
    } else {
      const sz = field(objText, "summaryZh");
      const se = field(objText, "summaryEn");
      const dz = field(objText, "descriptionZh");
      const de = field(objText, "descriptionEn");
      fields = [];
      const enParts = [];
      if (sz !== null) fields.push({ key: "summary", value: q(sz) });
      if (se !== null) enParts.push(`summary: ${q(se)}`);
      if (dz !== null) fields.push({ key: "description", value: q(dz) });
      if (de !== null) enParts.push(`description: ${q(de)}`);
      if (enParts.length) {
        fields.push({ key: '"x-i18n-en"', value: `{ ${enParts.join(", ")} }` });
      }
    }
    if (fields.length === 0) {
      // 没有任何可搬运字段 → 整个调用删掉即可（形态 B 下等同复原）
      out = out.slice(0, callStart) + "{}" + out.slice(closeParen + 1);
      continue;
    }

    // 形态判定：调用点之前（跳过 `...`）是否为 `}` → 形态 B
    let before = out.slice(0, callStart);
    const spreadM = /}\s*\.\.\.\s*$/.exec(before);
    const isMerge = !!spreadM;

    if (isMerge) {
      // 把 `}` 之后到 callStart 的 `...` 去掉，并在 `}` 前并入字段
      const braceIdx = spreadM.index; // 指向 `}`
      // 计算该对象的缩进（取 `}` 所在行的缩进 + 2 空格）
      const lineStart = out.lastIndexOf("\n", braceIdx) + 1;
      const closeIndent = out.slice(lineStart, braceIdx).match(/^\s*/)[0];
      const fieldIndent = closeIndent + "  ";
      // 关闭括号前的字符若是 ',' 则不再补逗号
      const beforeBrace = out.slice(0, braceIdx).replace(/\s+$/, "");
      const needComma = !beforeBrace.endsWith(",") && !beforeBrace.endsWith("{");
      let ins = "";
      for (let i = 0; i < fields.length; i++) {
        const isLast = i === fields.length - 1;
        const lead = i === 0 ? (needComma ? "," : "") : "";
        ins += line(fieldIndent, `${lead}${fields[i].key}: ${fields[i].value}${isLast ? "," : ","}`);
      }
      // 重建：`}` 前插字段；删掉 `...i18nProperty(...)`；保留原 `)`
      const afterCall = out.slice(closeParen + 1);
      out =
        out.slice(0, braceIdx) +
        ins +
        line(closeIndent, "}") +
        afterCall;
      stats.t2++;
    } else {
      // 形态 A：整段替换为裸 options
      const inline = `{ ${fields.map((f) => `${f.key}: ${f.value}`).join(", ")} }`;
      out = out.slice(0, callStart) + inline + out.slice(closeParen + 1);
      stats.t1++;
    }
  }

  // 收尾：`@ApiProperty({...}), )` 这类多余尾逗号（内联后可能出现）
  out = out.replace(/\}\),\s*\)/g, "}))");
  return out;
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".ts"));
for (const name of files) {
  const full = path.join(DIR, name);
  const src = fs.readFileSync(full, "utf8");
  if (!/i18n(Property|Operation)\(/.test(src)) continue;
  stats.files++;
  const fixed = repair(src);
  if (fixed !== src) {
    stats.changed++;
    if (APPLY) {
      const repo = toRepoPath(name);
      fs.writeFileSync(repo, fixed, "utf8");
    }
  }
}

console.log(JSON.stringify(stats, null, 2));
