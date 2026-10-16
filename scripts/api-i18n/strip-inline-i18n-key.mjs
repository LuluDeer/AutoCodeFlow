#!/usr/bin/env node
/**
 * 移除源码装饰器里内联的 `"x-i18n-en"` 键（设计变更后的清理，跑完即可删）。
 *
 * ## 为什么改设计
 *
 * 原设计把英文**内联**进每个装饰器的 options（`"x-i18n-en": …`）。实测代价：
 * `@nestjs/swagger` 的 options 类型里没有这个键，而它们**大多是 type 别名**
 * （`type ApiPropertyOptions = A | (A & {…})`），**无法用 `declare module` 增强**
 * ——对别名写 `interface 同名` 只会新建同名接口并报 `TS2300: Duplicate identifier`。
 * 实测：1318 处 `TS2353`，加增强文件后变成 1323 处（多了 5 条重复标识符，
 * 键**依然**不被接受）。
 *
 * 且能增强的只有 `ApiHeaderOptions` / `ApiResponseCommonMetadata` 两个（导出接口），
 * 其余（`@ApiProperty` 走未导出的 `SchemaObjectCommonMetadata`；`@ApiParam`/
 * `@ApiQuery` 走 type 别名）**在库的类型设计上就封死了**。
 *
 * 结论：内联载体要么给全仓数百个调用点加 `as` 断言（丢类型安全、噪声大），
 * 要么和库的类型定义搏斗。**都不值得**——因为英文完全可以不放在源码里。
 *
 * ## 新设计（本脚本是它的第一步）
 *
 * 英文集中放在 `scripts/api-i18n/data/openapi-en-map.json`（**以中文原文为键**，
 * 已有 1237 条），由 `inject-openapi-en.mjs` 在 `swagger:export` 之后注入
 * `x-i18n-en`。这样：
 *   · **源码零改动** —— 不碰 963 个装饰器，没有类型摩擦、没有语法风险；
 *   · 以中文原文为键 ⇒ **重复文案自动共用一条英文**（去重免费得到）；
 *   · 新增中文文案若没有对应英文 ⇒ 注入后的守卫**如实报缺**（有牙）；
 *   · 生成物 `openapi.json` 里依然是「中英同行携带」，文档站消费方式不变。
 *
 * ## 本脚本做什么
 *
 * 从装饰器 options 里**按括号配对**删除 `"x-i18n-en": <值>` 及其相邻逗号，
 * 恢复成合法的、无该键的 options。删除而非保留，是因为新设计下它属于
 * **生成期注入**，源码里留着就是第二份真值（必然漂移）。
 *
 * 用法: node strip-inline-i18n-key.mjs [--apply]
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

/** 从 openIdx（必须是开括号）找到配对闭合下标。 */
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

const stats = { files: 0, filesChanged: 0, removed: 0, leftovers: 0 };

for (const file of walk(path.join(ROOT, "apps/admin-api/src"))) {
  const src = fs.readFileSync(file, "utf8");
  if (!src.includes('"x-i18n-en"')) continue;
  stats.files++;
  let out = src;
  let touched = false;

  // 反复删除，直到没有该键（每次删除都会改变后续下标，故重新扫描）
  for (let guard = 0; guard < 20000; guard++) {
    const m = /"x-i18n-en"\s*:/.exec(out);
    if (!m) break;
    const keyStart = m.index;
    const colon = m.index + m[0].length;

    // 值：从冒号后第一个非空白字符开始，按其括号/字面量找到结束
    let vStart = colon;
    while (vStart < out.length && /\s/.test(out[vStart])) vStart++;
    const vc = out[vStart];
    let vEnd;
    if (vc === "{" || vc === "[" || vc === "(") {
      vEnd = matchBracket(out, vStart);
      if (vEnd === -1) {
        stats.leftovers++;
        break;
      }
    } else if (vc === '"' || vc === "'" || vc === "`") {
      let i = vStart + 1;
      while (i < out.length) {
        if (out[i] === "\\") i += 2;
        else if (out[i] === vc) break;
        else i++;
      }
      vEnd = i;
    } else {
      // 其它（数字/标识符/字符串拼接）：吃到行尾或 `}`/`,` 为止
      let i = vStart;
      while (i < out.length && !",}\n".includes(out[i])) i++;
      vEnd = i - 1;
    }

    // 连同**前后逗号**一起删掉，保证不留下 `{, }` 或 `, ,`
    let s = keyStart;
    let e = vEnd + 1;
    // 向前吃掉紧邻的逗号与空白
    let bs = s - 1;
    while (bs >= 0 && /\s/.test(out[bs])) bs--;
    const hasPrevComma = out[bs] === ",";
    // 向后吃掉紧邻的逗号与空白
    let ae = e;
    while (ae < out.length && /\s/.test(out[ae])) ae++;

    if (hasPrevComma) {
      s = bs; // 删掉前导逗号
    } else if (out[ae] === ",") {
      e = ae + 1; // 首项：删掉后随逗号
    }
    out = out.slice(0, s) + out.slice(e);
    stats.removed++;
    touched = true;
  }

  // 收尾：清理 `{,` / `, }` / 空行残留造成的 `{,}`
  out = out.replace(/\{\s*,/g, "{").replace(/,\s*\}/g, " }");
  out = out.replace(/,\s*,/g, ",");

  if (touched && out !== src) {
    stats.filesChanged++;
    if (APPLY) fs.writeFileSync(file, out, "utf8");
  }
}

console.log(JSON.stringify(stats, null, 2));
console.log(APPLY ? "APPLIED" : "DRY RUN");
