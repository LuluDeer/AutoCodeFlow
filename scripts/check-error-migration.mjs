#!/usr/bin/env node
/**
 * LANG-ERR-01 回退守卫：admin-api 生产代码不得再出现裸内置异常 throw。
 *
 * 为什么需要：throw new BadRequestException("中文…") 照样返回 400，只是响应体
 * 少了 errorCode 字段，前端只能回落服务端中文兜底文案 —— 英文用户于是看到
 * 「英文外壳 + 中文报错」，正是「用户配了哪个语言就展示哪个语言」要消灭的形态。
 * 这类回退不报错、不红测试、只会在跨语言组合处显形，故必须由守卫拦。
 *
 * 既有 check-error-i18n.mjs 拦不到它：那道闸验「码表 ↔ 前端词条 ↔ 生成物」三者
 * 一致，不扫描调用点。
 *
 * 判据：扫 apps/admin-api/src 生产代码（排除 spec/.d.ts），去掉注释与字符串后匹配
 * throw new <XxxException>(；AppError 是唯一允许形态（构造后挂回内置原型，
 * instanceof 仍成立）。目标态恒为 0，不留基线余量。
 *
 * 用法：node scripts/check-error-migration.mjs [--selftest|--report]
 */
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SRC_DIR = join("apps", "admin-api", "src");
const ALLOWLIST = new Set([]);
const SKIP_DIR_NAMES = new Set(["__tests__", "node_modules", "dist", "generated"]);
const BT = String.fromCharCode(96);
const DQ = String.fromCharCode(34);
const SQ = String.fromCharCode(39);
const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);

export function isProdTs(name) {
  if (!name.endsWith(".ts")) return false;
  if (name.endsWith(".spec.ts") || name.endsWith(".test.ts") || name.endsWith(".d.ts")) return false;
  return true;
}

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIR_NAMES.has(e.name)) continue;
      walk(join(dir, e.name), out);
    } else if (isProdTs(e.name)) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

/** 把注释与字符串字面量抹成空格（保留换行，行号不漂）。
 *  为什么不用正则剥注释：本仓字符串里有大量 URL，其中的双斜杠会被当成注释起点，
 *  把后面真正的代码整段吃掉（假绿）。故用状态机区分代码/行注释/块注释/三种引号。
 *  已知取舍：模板串的插值不当作代码，整串视作字面量（selftest 钉住）。 */
export function stripNonCode(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  let state = "code";
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === "code") {
      if (c === "/" && c2 === "/") { state = "line"; out.push(" ", " "); i += 2; continue; }
      if (c === "/" && c2 === "*") { state = "block"; out.push(" ", " "); i += 2; continue; }
      if (c === SQ) { state = "sq"; out.push(" "); i += 1; continue; }
      if (c === DQ) { state = "dq"; out.push(" "); i += 1; continue; }
      if (c === BT) { state = "tpl"; out.push(" "); i += 1; continue; }
      out.push(c); i += 1; continue;
    }
    if (state === "line") {
      if (c === NL) { state = "code"; out.push(NL); } else { out.push(" "); }
      i += 1; continue;
    }
    if (state === "block") {
      if (c === "*" && c2 === "/") { state = "code"; out.push(" ", " "); i += 2; continue; }
      out.push(c === NL ? NL : " ");
      i += 1; continue;
    }
    if (c === BS) { out.push(" ", " "); i += 2; continue; }
    const closer = state === "sq" ? SQ : state === "dq" ? DQ : BT;
    if (c === closer) { state = "code"; out.push(" "); i += 1; continue; }
    out.push(c === NL ? NL : " ");
    i += 1;
  }
  return out.join("");
}

const THROW_RE = /\bthrow\s+new\s+([A-Za-z_$][\w$]*)\s*\(/g;

export function findViolations(filePath, src) {
  const stripped = stripNonCode(src);
  const lineStarts = [0];
  for (let i = 0; i < stripped.length; i += 1) if (stripped[i] === NL) lineStarts.push(i + 1);
  const lineOf = (idx) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  const hits = [];
  THROW_RE.lastIndex = 0;
  let m;
  while ((m = THROW_RE.exec(stripped)) !== null) {
    const cls = m[1];
    if (!cls.endsWith("Exception")) continue;
    if (cls === "AppError") continue;
    hits.push({ line: lineOf(m.index), cls });
  }
  return hits;
}

function scanReal() {
  const files = walk(join(ROOT, SRC_DIR));
  if (files.length === 0) {
    console.error("✖ 扫不到生产文件（请在仓库根执行）：" + SRC_DIR);
    process.exit(1);
  }
  const violations = [];
  for (const f of files) {
    const rel = relative(ROOT, f).split(sep).join("/");
    if (ALLOWLIST.has(rel)) continue;
    for (const v of findViolations(rel, readFileSync(f, "utf8"))) violations.push({ file: rel, line: v.line, cls: v.cls });
  }
  return { files: files.length, violations };
}

function selftest() {
  let failed = 0;
  const t = (name, ok) => {
    if (ok) { console.log("  ✔ " + name); return; }
    failed += 1;
    console.error("  ✖ " + name);
  };
  console.log("check-error-migration selftest");
  const dir = mkdtempSync(join(tmpdir(), "acf-errmig-"));
  try {
    mkdirSync(join(dir, "mods"), { recursive: true });
    const w = (name, body) => { writeFileSync(join(dir, "mods", name), body); return join(dir, "mods", name); };
    const bad = w("bad.ts", ["export function f() {", "  throw new BadRequestException('参数有误');", "}"].join(NL));
    const good = w("good.ts", ["export function f() {", "  throw new AppError('VALIDATION_FAILED');", "}"].join(NL));
    const cm = w("comments.ts", [
      "// throw new BadRequestException('注释里的不算')",
      "/* throw new ForbiddenException('块注释也不算') */",
      "const url = 'http://example.com//double-slash';",
      "const s = 'throw new NotFoundException(1)';",
      "export const ok = url + s;",
    ].join(NL));
    const mixed = w("mixed.ts", [
      "// throw new ConflictException('c')",
      "const u = 'https://a//b';",
      "export function g() {",
      "  throw new InternalServerErrorException('x');",
      "}",
    ].join(NL));
    const vBad = findViolations("bad.ts", readFileSync(bad, "utf8"));
    const vGood = findViolations("good.ts", readFileSync(good, "utf8"));
    const vCm = findViolations("comments.ts", readFileSync(cm, "utf8"));
    const vMixed = findViolations("mixed.ts", readFileSync(mixed, "utf8"));
    t("裸 BadRequestException 被抓（行号 2）", vBad.length === 1 && vBad[0].line === 2);
    t("AppError 不算违规", vGood.length === 0);
    t("行注释/块注释里的 throw 不算违规", vCm.length === 0);
    t("字符串里的 throw new 不算违规", vCm.length === 0);
    t("spec 文件不进生产扫描面", isProdTs("bad.spec.ts") === false && isProdTs("bad.ts") === true);
    t("混写场景只命中第 4 行（字符串里的双斜杠不吃掉后文）", vMixed.length === 1 && vMixed[0].line === 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (failed > 0) {
    console.error("✖ selftest 失败 " + failed + " 项");
    process.exit(1);
  }
  console.log("✔ selftest 全部通过");
}

const argv = process.argv.slice(2);
if (argv.includes("--selftest")) {
  selftest();
} else {
  const r = scanReal();
  if (argv.includes("--report") || r.violations.length > 0) {
    for (const v of r.violations) console.log("  " + v.file + ":" + v.line + "  throw new " + v.cls + "(");
  }
  if (r.violations.length > 0) {
    console.error("✖ LANG-ERR-01 回退：" + r.violations.length + " 处裸内置异常 throw（扫了 " + r.files + " 个生产文件）。");
    console.error("  裸 throw 的响应体没有 errorCode，前端只能渲染服务端中文兜底文案。");
    console.error("  修法：在 apps/admin-api/src/common/errors/catalog/<域>.ts 加码，改用 new AppError(<CODE>, params)。");
    process.exit(1);
  }
  console.log("✔ LANG-ERR-01 回退守卫通过：" + r.files + " 个生产文件中裸内置异常 throw = 0。");
}
