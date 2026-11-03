#!/usr/bin/env node
/**
 * 「协作者 self-call」守卫 —— 治「**协作者内部直调自己的方法**」这一**类**。
 *
 * ## 为什么这是一个真问题（不是洁癖）
 *
 * Facade 转发层有一个容易忽视的价值：**它是 spy 拦截面**。
 *
 * 既有 spec 大量使用「实现级断言」：
 *   `jest.spyOn(service, "cleanupOldTaskExecutions")` ⇒ 断言「确实走了这个方法」
 *   `jest.spyOn(service, "storeLogLines")`            ⇒ 断言「确实落库了日志」
 *
 * 一旦把实现搬进协作者、而协作者内部**直调自己的同名方法**（self-call），
 * 那么 Facade 上的 spy **拦不到协作者内部的这次调用** ⇒
 * **既有的实现级断言静默失效**（不是报错，是悄悄地永远通过）。
 *
 * 本项目已实测过一次：B1a 的 `recordDeploymentEvent` 与 B2 的
 * `cleanupOldTaskExecutions` 都是「一搬就静默失效」的形态。
 *
 * ## 判据
 *
 * 扫 `*.collaborator.ts`（协作者文件的命名约定），找出**对自身 public 方法的
 * 直接调用** `this.<name>(`，其中 `<name>` 是本类自己声明的方法 ⇒ 红。
 *
 * **不算违规的**（逐条说明，避免误伤）：
 *   · `this.<私有方法>(` —— 私有计算不参与外部 spy（spy 装在 Facade 上，
 *     私有方法本来就不该被外部断言）；
 *   · `this.<字段>` / `this.deps.<x>` —— 不是方法调用；
 *   · 构造函数里的初始化。
 *
 * ⇒ 判据精确到「**本类声明的非 private 方法**」这一集合。
 *
 * ## 豁免
 *
 * 行内 `ALLOW: <理由>`（理由 ≥12 字符，照抄 `check-size-caps.mjs` 的先例）。
 * 光秃秃的 `ALLOW:` 仍然红。
 *
 * ## 用法
 *   node scripts/check-collaborator-self-call.mjs            # 判据
 *   node scripts/check-collaborator-self-call.mjs --report   # 人读清单
 *   node scripts/check-collaborator-self-call.mjs --selftest # 自检
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

/** 协作者文件的命名约定（与 B1a/B1b/X5 的实际命名一致）。 */
const COLLABORATOR_SUFFIX = ".collaborator.ts";

/** 扫描根（只扫源码目录）。 */
const SCAN_ROOTS = ["apps", "packages"];

/** 跳过的目录。 */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  "generated",
]);

/** `ALLOW:` 理由的最小长度（照抄 check-size-caps.mjs）。 */
const MIN_ALLOW_REASON = 12;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(COLLABORATOR_SUFFIX) && !e.name.endsWith(".spec.ts")) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 抽取「本类声明的 public/非 private 方法名」。
 *
 * 极简静态分析（不引 TS 编译器：本脚本要在**零依赖**的 guards job 里跑）：
 *   · 匹配 `^  (async )?<name>(<` 形态的方法声明；
 *   · 排除同行或前一行有 `private`/`protected` 的；
 *   · 排除 `constructor`。
 *
 * 为什么不用 TS AST：`scripts/` 侧守卫刻意零依赖（见 `test:guards:repo` 的
 * 注释：不引 apps 的 typescript 依赖）。这个判据的形态足够规整，正则可达。
 */
export function extractSelfCallTargets(source) {
  const lines = source.split("\n");
  const methods = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = /^ {2}(static\s+)?(async\s+)?([A-Za-z_$][\w$]*)\s*[(<]/.exec(line);
    if (!m) continue;
    const name = m[3];
    if (name === "constructor") continue;
    const isStatic = Boolean(m[1]);
    // 往上看 3 行找修饰符（含行内）
    const ctx = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
    const isPrivate = /\b(private|protected)\b/.test(ctx);
    if (isPrivate) continue;
    methods.push({ name, line: i + 1, isStatic });
  }
  return methods;
}

/** 找出对自身 public 方法的 self-call。 */
export function findSelfCalls(source) {
  const lines = source.split("\n");
  const targets = new Set(extractSelfCallTargets(source).map((m) => m.name));
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // 跳过注释行（`//` / `*` 开头）
    const trimmed = line.trim();
    // 跳过注释行：`//` / `/*` / `*`（JSDoc 中段与收尾）/ `*/`
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*")
    ) {
      continue;
    }
    for (const name of targets) {
      const re = new RegExp(`this\\.${name}\\s*\\(`);
      if (!re.test(line)) continue;
      hits.push({ name, line: i + 1, text: trimmed });
    }
  }
  return { hits, targets: [...targets] };
}

/** 该行（或其上方 3 行的注释块）是否有带理由的 `ALLOW:`。 */
function hasAllowWithReason(lines, lineNo) {
  const ctx = lines
    .slice(Math.max(0, lineNo - 4), lineNo)
    .join("\n");
  // ⚠️ 必须用 [ \t]*（不能用 \s*）：\s 含换行，会把**下一行代码**当成理由
  const m = /ALLOW:[ \t]*(.*)$/m.exec(ctx);
  if (!m) return false;
  return m[1].trim().length >= MIN_ALLOW_REASON;
}

export function check({ repoRoot = REPO_ROOT } = {}) {
  const failures = [];
  const notes = [];
  const scanned = [];
  for (const root of SCAN_ROOTS) {
    for (const abs of walk(join(repoRoot, root))) {
      const rel = relative(repoRoot, abs).split("\\").join("/");
      const source = readFileSync(abs, "utf-8");
      const lines = source.split("\n");
      const { hits, targets } = findSelfCalls(source);
      scanned.push({ file: rel, targets: targets.length, hits: hits.length });
      if (targets.length === 0) {
        notes.push(`${rel}: 未解析出 public 方法（可能全是 private/箭头属性）`);
      }
      for (const h of hits) {
        if (hasAllowWithReason(lines, h.line)) {
          notes.push(`${rel}:${h.line} self-call \`this.${h.name}()\` 已 ALLOW 豁免`);
          continue;
        }
        failures.push(
          `${rel}:${h.line} 协作者直接调用自身的 public 方法 \`this.${h.name}()\` —— ` +
            `Facade 上的 spy 拦不到这次调用，**既有的实现级断言会静默失效**。` +
            `改法：经注入的回调走 Facade，或把该逻辑改成私有纯计算。` +
            `（确属必要就加 \`ALLOW: <≥${MIN_ALLOW_REASON} 字理由>\`）`,
        );
      }
    }
  }
  return { failures, notes, scanned };
}

function printReport(result) {
  console.log("\n协作者 self-call 扫描（*.collaborator.ts）：");
  for (const s of result.scanned) {
    console.log(`  ${s.file}  public 方法 ${s.targets} 个 / self-call ${s.hits} 处`);
  }
  if (result.notes.length > 0) {
    console.log("\n备注：");
    for (const n of result.notes) console.log(`  · ${n}`);
  }
  console.log("");
}

function selftest() {
  const results = [];
  const ok = (name, fn) => {
    try {
      fn();
      results.push([true, name]);
    } catch (err) {
      results.push([false, `${name} —— ${err.message}`]);
    }
  };
  const assert = (c, m) => {
    if (!c) throw new Error(m);
  };

  const CLS = (body, extra = "") => `export class X {
${extra}
${body}
}
`;

  ok("① public 方法 self-call ⇒ 命中", () => {
    const src = CLS(`  async a(): Promise<void> { await this.b(); }
  async b(): Promise<void> {}`);
    assert(findSelfCalls(src).hits.length === 1, "应命中 1 处");
  });

  ok("② private 方法 self-call ⇒ **不**命中（私有计算不受限）", () => {
    const src = CLS(`  async a(): Promise<void> { this.priv(); }
  private priv(): void {}`);
    assert(findSelfCalls(src).hits.length === 0, "私有 self-call 不该命中");
  });

  ok("③ 调用外部依赖的方法 ⇒ 不命中", () => {
    const src = CLS(`  async a(): Promise<void> { await this.deps.repo.find(); }`);
    assert(findSelfCalls(src).hits.length === 0, "deps.x() 不该命中");
  });

  ok("④ 注释里的 self-call 不算（`//` 与 `*` 开头）", () => {
    const src = CLS(`  async a(): Promise<void> {
    // await this.b();
    /** await this.b(); */
  }
  async b(): Promise<void> {}`);
    assert(findSelfCalls(src).hits.length === 0, "注释不该命中");
  });

  ok("⑤ ALLOW: 带理由 ⇒ 该行不算违规", () => {
    const lines = [
      "    // ALLOW: 该调用是纯计算且外部无 spy 依赖",
      "    await this.b();",
    ];
    assert(hasAllowWithReason(lines, 2), "带理由的 ALLOW 应被识别");
  });

  ok("⑥ ALLOW: 无理由 / 理由过短 ⇒ 仍红", () => {
    assert(
      !hasAllowWithReason(["    // ALLOW:", "    await this.b();"], 2),
      "空 ALLOW 不该算豁免",
    );
    assert(
      !hasAllowWithReason(["    // ALLOW: 短", "    await this.b();"], 2),
      `理由 < ${MIN_ALLOW_REASON} 字不该算豁免`,
    );
  });

  ok("⑥b 注释行内的 self-call 一律跳过（`/*` 块注释也算）", () => {
    const src = CLS(`  async a(): Promise<void> {
    /* await this.b(); */
    /** await this.b(); */
  }
  async b(): Promise<void> {}`);
    assert(findSelfCalls(src).hits.length === 0, "块注释不该命中");
  });

  ok("⑦ **自证有牙**：真实协作者里塞一个 self-call ⇒ 红", () => {
    const target = join(
      REPO_ROOT,
      "apps",
      "admin-api",
      "src",
      "modules",
      "executor",
      "executor-maintenance.collaborator.ts",
    );
    const original = readFileSync(target, "utf-8");
    // 塞一个对**自身 public 方法**的直调（`resolveS3LogStorage` 是 public）
    const injected = original.replace(
      "  resolveS3LogStorage(): S3LogStorage | null {",
      "  probeSelfCall(): void {\n    this.resolveS3LogStorage();\n  }\n\n  resolveS3LogStorage(): S3LogStorage | null {",
    );
    assert(injected !== original, "注入未生效（锚点未命中）");
    const hits = findSelfCalls(injected).hits;
    assert(
      hits.some((h) => h.name === "resolveS3LogStorage"),
      `注入的 self-call 未被检出（实得 ${JSON.stringify(hits)}）`,
    );
    // 还原不必要（只在内存里改，未写盘）
  });

  ok("⑧ 当前真实协作者全绿（无未豁免的 self-call）", () => {
    const r = check({});
    assert(
      r.failures.length === 0,
      `期望 0 失败，实得 ${r.failures.length}：${r.failures.slice(0, 2).join(" ｜ ")}`,
    );
    assert(r.scanned.length > 0, "应扫到至少一个协作者文件");
  });

  const failed = results.filter(([p]) => !p);
  for (const [pass, name] of results) console.log(`${pass ? "✓" : "✗"} ${name}`);
  console.log(`\n自检：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    console.error(`\n自检失败 ${failed.length} 条`);
    process.exit(1);
  }
}

const IS_MAIN =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);

if (!IS_MAIN) {
  // imported as a module — 不执行副作用
} else if (argv.includes("--selftest")) {
  selftest();
} else {
  const result = check({});
  if (argv.includes("--report")) printReport(result);
  if (result.failures.length > 0) {
    console.error(`\n协作者 self-call 守卫失败（${result.failures.length} 项）：`);
    for (const f of result.failures) console.error(`  · ${f}`);
    process.exit(1);
  }
  console.log(
    `协作者 self-call：扫 ${result.scanned.length} 个 *.collaborator.ts，` +
      `public 方法 ${result.scanned.reduce((s, x) => s + x.targets, 0)} 个，` +
      `未豁免 self-call 0 处 ✓`,
  );
}
