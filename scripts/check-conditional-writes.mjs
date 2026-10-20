#!/usr/bin/env node
/**
 * ADR-026 静态守卫：**状态写必须条件化**的「只减不增」棘轮。
 *
 * 背景（ADR-026）：本仓反复出现同一类缺陷——一次状态写入只带 `WHERE id`，
 * 并发或长窗口下把别人刚写完的状态按旧快照盖回去（已吊销 token 复活、禁用失效、
 * 改密被撤销、已成功的部署被回滚成失败、SOP 终态被改回）。这类缺陷**在测试里永远绿**
 * （单线程无并发时两种写法行为相同），只能靠纪律与守卫拦。
 *
 * 判据（刻意保守，只抓最典型的形态）：`.update({ id: … }, …)` —— 即 where 对象
 * 的**顶层键只有 id**。这类调用没有任何前置断言，是缺陷的充分形态之一。
 * 带 `status` / `version` / `attempt` 等前置键的调用自动通过。
 *
 * 为什么用「只减不增 + 基线」而不是「一律为 0」：存量里仍有大量合法调用（例如该表
 * 根本没有并发写者、或写的是与状态无关的列）。要求一次性清零不现实，会逼出「改成
 * 两个单键更新」这类假修。基线把方向定死：**新代码不许再增加**，改到一处就降一处。
 *
 * 用法：
 *   node scripts/check-conditional-writes.mjs            # 守卫（CI）
 *   node scripts/check-conditional-writes.mjs --report   # 列清单 + 建议基线
 *   node scripts/check-conditional-writes.mjs --selftest # 验证判据本身有牙
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SCAN_DIR = join("apps", "admin-api", "src", "modules");

/**
 * 存量基线（只减不增）。**只能下调**：改掉一处就把这个数字减一。
 * 上调需要在提交信息里写明为什么这处新增是安全的（例如该表无并发写者）。
 */
const BASELINE = 14;

/** 豁免标记：在调用的前 3 行内出现该注释即跳过（必须写理由）。 */
const EXEMPT_MARKER = "adr-026-exempt";

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name === "__tests__" || e.name === "node_modules" || e.name === "dist") continue;
      walk(join(dir, e.name), out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts") && !e.name.endsWith(".d.ts")) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

/** 抹掉注释与字符串字面量（保留换行，行号不漂）。与 check-error-migration 同思路。 */
function stripNonCode(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  let state = "code";
  const SQ = String.fromCharCode(39), DQ = String.fromCharCode(34);
  const BT = String.fromCharCode(96), BS = String.fromCharCode(92), NL = String.fromCharCode(10);
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === "code") {
      if (c === "/" && c2 === "/") { state = "line"; out.push(" ", " "); i += 2; continue; }
      if (c === "/" && c2 === "*") { state = "block"; out.push(" ", " "); i += 2; continue; }
      if (c === SQ || c === DQ || c === BT) { state = c === SQ ? "sq" : c === DQ ? "dq" : "tpl"; out.push(" "); i += 1; continue; }
      out.push(c); i += 1; continue;
    }
    if (state === "line") { if (c === NL) { state = "code"; out.push(NL); } else { out.push(" "); } i += 1; continue; }
    if (state === "block") {
      if (c === "*" && c2 === "/") { state = "code"; out.push(" ", " "); i += 2; continue; }
      out.push(c === NL ? NL : " "); i += 1; continue;
    }
    if (c === BS) { out.push(" ", " "); i += 2; continue; }
    const closer = state === "sq" ? SQ : state === "dq" ? DQ : BT;
    if (c === closer) { state = "code"; out.push(" "); i += 1; continue; }
    out.push(c === NL ? NL : " "); i += 1;
  }
  return out.join("");
}

/** 从 `{` 起读平衡花括号，返回 [内容, 结束下标]。 */
function readBraced(s, start) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") { depth--; if (depth === 0) return [s.slice(start + 1, i), i]; }
  }
  return [null, s.length];
}

/** 取顶层键（逗号按 ()/{} /[] 深度切分，只认 `key:` 形态）。 */
function topLevelKeys(body) {
  const keys = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) { keys.push(cur); cur = ""; continue; }
    cur += ch;
  }
  keys.push(cur);
  return keys
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => {
      const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/.exec(k);
      if (m) return m[1];
      const shorthand = /^([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(k);
      return shorthand ? shorthand[1] : "(expr)";
    });
}

function lineOf(src, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

export function findUnconditionalUpdates(src) {
  const codeOnly = stripNonCode(src);
  const hits = [];
  const re = /\.update\s*\(/g;
  let m;
  while ((m = re.exec(codeOnly)) !== null) {
    let i = m.index + m[0].length;
    while (i < codeOnly.length && /\s/.test(codeOnly[i])) i++;
    if (codeOnly[i] !== "{") continue; // first arg 不是对象字面量 → 跳过
    const [body] = readBraced(codeOnly, i);
    if (body === null) continue;
    const keys = topLevelKeys(body);
    if (keys.length === 1 && keys[0] === "id") {
      hits.push({ index: m.index, line: lineOf(codeOnly, m.index) });
    }
  }
  return hits;
}

function isExempt(src, idx) {
  const lines = src.slice(0, idx).split("\n");
  // 窗口取 5 行：豁免标记通常需要 1-3 行说明理由，3 行窗口会让「标记 + 两行理由」
  // 恰好落在窗口外（实测踩到过一次）。
  return lines.slice(-5).some((l) => l.includes(EXEMPT_MARKER));
}

function scan() {
  const files = walk(join(ROOT, SCAN_DIR));
  if (files.length === 0) { console.error("✖ 扫不到文件：" + SCAN_DIR); process.exit(1); }
  const violations = [];
  for (const f of files) {
    const rel = relative(ROOT, f).split(sep).join("/");
    const src = readFileSync(f, "utf8");
    for (const h of findUnconditionalUpdates(src)) {
      if (isExempt(src, h.index)) continue;
      violations.push({ file: rel, line: h.line });
    }
  }
  return { files: files.length, violations };
}

function selftest() {
  let failed = 0;
  const t = (name, ok) => { ok ? console.log("  ✔ " + name) : (failed++, console.error("  ✖ " + name)); };
  const cases = [
    [".update({ id }, patch) 单键 → 命中", "await this.repo.update({ id: a.id }, { x: 1 });", 1],
    [".update({ id: a.id, status: 'x' }, …) 带前置条件 → 放行", "await this.repo.update({ id: a.id, status: \"x\" }, { x: 1 });", 0],
    ["多行对象形态同样命中", "await this.repo.update(\n  { id: a.id },\n  { x: 1 },\n);", 1],
    ["注释里的 .update({id}) 不算", "// await this.repo.update({ id: a.id }, {});", 0],
    ["字符串里的 .update({id}) 不算", "const s = \"this.repo.update({ id }, {})\";", 0],
    ["嵌套对象不会误判（id 在子对象里）", "await this.repo.update({ where: { id: 1 } }, { x: 1 });", 0],
    ["shorthand { id } 也命中", "await this.repo.update({ id }, { x: 1 });", 1],
  ];
  for (const [name, src, expected] of cases) {
    t(name, findUnconditionalUpdates(src).length === expected);
  }
  if (failed > 0) { console.error("✖ selftest 失败 " + failed + " 项"); process.exit(1); }
  console.log("✔ selftest 全部通过");
}

const argv = process.argv.slice(2);
if (argv.includes("--selftest")) {
  selftest();
} else {
  const { files, violations } = scan();
  if (argv.includes("--report") || violations.length > BASELINE) {
    for (const v of violations) console.log("  " + v.file + ":" + v.line + "  .update({ id }, …)");
  }
  if (violations.length > BASELINE) {
    console.error("");
    console.error("✖ ADR-026：无条件状态写 " + violations.length + " 处 > 基线 " + BASELINE + "（扫了 " + files + " 个文件）");
    console.error("  这类 update 只带 id，没有任何前置状态断言；并发或长窗口下会把别人刚写完的状态盖回去。");
    console.error("  修法：把「读取时刻的状态」挪进 WHERE（status IN (…)/attempt = …/version = …），命中 0 就让位并 warn。");
    console.error("  确有并发安全理由时，在调用前 3 行内写 \"adr-026-exempt: <理由>\" 注释。");
    process.exit(1);
  }
  console.log("✔ ADR-026 守卫通过：无条件状态写 " + violations.length + " 处（基线 " + BASELINE + "，扫了 " + files + " 个文件）。");
}
