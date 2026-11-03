#!/usr/bin/env node
/**
 * 「**spec 对被测 service 的耦合形式**」扫描器（T2-B4 方法学的可复用落点）。
 *
 * ## 由来（一句话）
 *
 * B4 第二刀（回调簇出仓）里发现：**判断「某个方法能不能搬走」，不能只看「有没有
 * 报错」**。spec 对成员有**五种**耦合形式，失效后果各不相同 —— 有的**变红**
 * （安全，会被发现），有的**假过**（危险，测试仍绿但断言形同虚设）。
 *
 * | # | 形式 | 典型写法 | 搬走成员后 |
 * |---|---|---|---|
 * | ① | **直调** public API | `service.handleCallback([...])` | 变红（转发即修复） |
 * | ② | **spyOn / any 断言** | `jest.spyOn(service, "x")`、`(service as any).x` | **假过**（spy 打在 Facade，协作者内部调用拦不到） |
 * | ③ | **赋值式覆写** | `service.x = jest.fn()` | **假过**（覆写打到没人调用的属性 ⇒ 隔离性静默丢失） |
 * | ④ | **括号式访问** | `expect(service["x"]).toHaveBeenCalled()`、`service["x"](...)` | 变红（实测）或**假过**（取决于是否转发）；**括号调用**还会绕过 TS 的 private 检查 |
 * | ⑤ | **索引型断言** | `(service as any).repo.mock.results[0]` | **假过**（多一次调用就让索引指向别处，断言把别人的结果当本次的） |
 *
 * 三种「假过」的共同点：**测试不会告诉你它失效了**。所以搬迁前必须先扫一遍。
 *
 * ## 本脚本只**报告**，不判红（刻意）
 *
 * 判红需要「哪些成员允许被哪种形式耦合」的策略表，而那要等积累 2–3 刀的真实数据
 * 才定得下来（否则就是把今天的偶然形态固化成规则）。⇒ 本脚本当前是**报告型**：
 * 输出每个 spec 文件 × 每种形式的出现处 + 指向的成员名，供搬迁前人工核对。
 *
 * ## 用法
 *   node scripts/check-spec-coupling-surfaces.mjs             # 汇总（各形式计数）
 *   node scripts/check-spec-coupling-surfaces.mjs --report    # 逐条清单
 *   node scripts/check-spec-coupling-surfaces.mjs --file <path>  # 只看某个 spec
 *   node scripts/check-spec-coupling-surfaces.mjs --member <name> # 只看某个成员
 *   node scripts/check-spec-coupling-surfaces.mjs --selftest  # 判据自证有牙
 *
 * ## 零依赖
 *
 * 只 import `node:fs` / `node:path` / `node:url` —— 与仓内其他守卫一致，不引
 * TypeScript 编译器、不解析 AST：**正则 + 行扫描**足够，且对「守卫脚本自己也要
 * 能被守卫」这一约束友好（AST 解析器会把本脚本变成 300+ 行）。
 *
 * ## 已知盲区（如实声明，避免下一个人以为它全能）
 *
 * · **跨行调用不认**：`service\n  .handleCallback(` 这种换行写法扫不到（本仓无此写法，
 *   实测 0 处；若将来出现需改用多行拼接窗口）。
 * · **动态成员名不认**：`service[name](...)` / `service[`${x}`]` 扫不到。
 * · **不区分「哪个 service」的别名**：`svc` / `sut` / `target` 这些局部别名靠
 *   「接收者标识符形状」识别（见 RECEIVER_NAMES），不做数据流分析。漏识别的
 *   后果是**少报**（不会多报）——方向安全：少报只是回到「人工扫」，多报会制造噪声
 *   而被加进豁免。
 * · **tests/e2e 目录不扫**：只扫 `*.spec.ts` / `*.test.ts(x)`（与 jest 收集口径一致）。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..");

/** 扫描根（只扫源码目录；scripts/ 与 docs/ 不是被测面）。 */
export const SCAN_ROOTS = ["apps", "packages"];

/** 跳过的目录（与 jest 收集口径对齐）。 */
export const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "generated",
  ".git",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
  "e2e",
]);

/** spec 文件的识别（与 jest 默认 testMatch 对齐）。 */
export const SPEC_RE = /\.(spec|test)\.(ts|tsx|js|mjs|cjs)$/;

/**
 * 「看起来像被测 service 的接收者标识符」。
 *
 * 为什么需要白名单而不是「任意标识符」：`expect(...)` / `jest.fn()` / `console.log()`
 * 也是 `标识符.成员(`，全认会把整个仓的普通函数调用都算成耦合（实测会是数万条）。
 * 白名单的代价是**漏报**（某个 spec 用了奇怪别名时扫不到）——方向安全。
 */
export const RECEIVER_NAMES = [
  "service",
  "svc",
  "sut",
  "target",
  "taskService",
  "schedulerService",
  "executorService",
  "applicationService",
  "appService",
  "agentService",
  "subject",
  "instance",
];

/** 五种耦合形式（顺序即报告顺序）。 */
export const FORMS = {
  directCall: "① 直调 public API",
  spyOn: "② spyOn / as-any 断言",
  assign: "③ 赋值式覆写",
  bracket: "④ 括号式访问（断言或调用）",
  indexed: "⑤ 索引型断言（mock.results[N] / mock.calls[N]）",
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const RECV_ALT = RECEIVER_NAMES.map(esc).join("|");

/**
 * 该行是否为注释行（`//` / `*` 开头 / 整行块注释）。
 *
 * 为什么要判：本仓 spec 的注释里大量**引用**真实写法作说明（如
 * `// 用 jest.spyOn(service, "x") 断言`），把注释算进来会让报告被说明性文字淹没。
 */
export function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/**
 * 扫描**一行**文本，返回命中的耦合形式数组。
 *
 * 导出供自检直接调用（不读盘就能证判据有牙）。
 *
 * @param {string} line 单行文本
 * @returns {Array<{form: keyof FORMS, member: string|null, snippet: string}>}
 */
export function scanLine(line) {
  if (!line || isCommentLine(line)) return [];
  const hits = [];
  const push = (form, member, snippet) =>
    hits.push({ form, member, snippet: snippet.trim().slice(0, 160) });

  // ⑤ 索引型断言：`mock.results[N]` / `mock.calls[N][M]` —— 先于 ④ 判（它常与 ② 同现）
  //    成员名取 `.results` 前那一段（如 `execRepo`）。
  const indexed = new RegExp(
    `(?:${RECV_ALT})(?:\\s+as\\s+any)?\\s*\\)?\\s*\\.\\s*([A-Za-z_$][\\w$]*)` +
      `\\s*\\.\\s*(?:createQueryBuilder|findOne|find|count|save|update|delete|insert)?` +
      `[\\w$.]*?\\.(?:mock)?\\.(?:results|calls)\\s*\\[`,
  ).exec(line);
  if (indexed) push("indexed", indexed[1], line);

  // ④ 括号式断言：`service["x"]` / `service['x']`
  const bracket = new RegExp(
    `(?:${RECV_ALT})\\s*\\[\\s*["'\`]([A-Za-z_$][\\w$]*)["'\`]\\s*\\]`,
  ).exec(line);
  if (bracket) push("bracket", bracket[1], line);

  // ③ 赋值式覆写：`service.x = jest.fn(...)` / `service.x = async () => ...`
  //    ⚠️ 必须排除 `===` / `==`（比较，不是赋值）。
  const assign = new RegExp(
    `(?:${RECV_ALT})\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*=(?!=)\\s*` +
      `(?:jest\\.fn|jest\\.spyOn|\\(\\)|async|function|vi\\.fn)`,
  ).exec(line);
  if (assign) push("assign", assign[1], line);

  // ② spyOn / as-any 断言：`jest.spyOn(service, "x")` / `(service as any).x`
  const spy = new RegExp(
    `spyOn\\(\\s*(?:${RECV_ALT})\\s*(?:as any)?\\s*,\\s*["'\`]([A-Za-z_$][\\w$]*)["'\`]`,
  ).exec(line);
  if (spy) push("spyOn", spy[1], line);
  const asAny = new RegExp(
    `\\(\\s*(?:${RECV_ALT})\\s+as\\s+(?:any|unknown)[^)]*\\)\\s*\\.\\s*([A-Za-z_$][\\w$]*)`,
  ).exec(line);
  if (asAny) push("spyOn", asAny[1], line);

  // ① 直调：`service.xxx(` —— 但排除已被上面认过的（避免同一处报 3 遍）
  const direct = new RegExp(
    `(?:${RECV_ALT})\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`,
  ).exec(line);
  if (direct) {
    // `(service as any).x(` 已算 ②，不再算 ①
    const isAsAny = /as\s+(?:any|unknown)/.test(
      line.slice(0, line.indexOf(direct[0]) + direct[0].length),
    );
    if (!isAsAny) push("directCall", direct[1], line);
  }
  return hits;
}

/** 递归收集 spec 文件。 */
export function collectSpecFiles(root = REPO_ROOT) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs);
      else if (SPEC_RE.test(name)) out.push(abs);
    }
  };
  for (const r of SCAN_ROOTS) walk(join(root, r));
  return out.sort();
}

/**
 * 全量扫描。
 *
 * @returns {{ files: number, findings: Array<{file:string,line:number,form:string,member:string|null,snippet:string}>,
 *             byForm: Record<string, number>, byMember: Array<{member:string,forms:Record<string,number>,count:number}> }}
 */
export function check(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const files = collectSpecFiles(root);
  const findings = [];
  for (const abs of files) {
    const rel = relative(root, abs).split(sep).join("/");
    if (options.file && !rel.includes(options.file)) continue;
    let text;
    try {
      text = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      for (const hit of scanLine(lines[i])) {
        if (options.member && hit.member !== options.member) continue;
        findings.push({ file: rel, line: i + 1, ...hit });
      }
    }
  }
  const byForm = {};
  for (const k of Object.keys(FORMS)) byForm[k] = 0;
  const memberMap = new Map();
  for (const f of findings) {
    byForm[f.form] += 1;
    if (!f.member) continue;
    const e = memberMap.get(f.member) ?? { member: f.member, forms: {}, count: 0 };
    e.forms[f.form] = (e.forms[f.form] ?? 0) + 1;
    e.count += 1;
    memberMap.set(f.member, e);
  }
  const byMember = [...memberMap.values()].sort((a, b) => b.count - a.count);
  return { files: files.length, findings, byForm, byMember };
}

function printReport(result, options) {
  console.log(`\n扫描 ${result.files} 个 spec 文件，命中 ${result.findings.length} 处耦合。\n`);
  for (const [form, label] of Object.entries(FORMS)) {
    const rows = result.findings.filter((f) => f.form === form);
    if (rows.length === 0) continue;
    console.log(`── ${label}（${rows.length} 处）`);
    for (const r of rows.slice(0, options.limit ?? 200)) {
      console.log(`   ${r.file}:${r.line}  → ${r.member ?? "(未识别)"}`);
      console.log(`      ${r.snippet}`);
    }
    if (rows.length > (options.limit ?? 200)) {
      console.log(`   … 另有 ${rows.length - (options.limit ?? 200)} 处`);
    }
    console.log("");
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    selftest();
    return;
  }
  const fileIdx = argv.indexOf("--file");
  const memberIdx = argv.indexOf("--member");
  const options = {
    file: fileIdx >= 0 ? argv[fileIdx + 1] : undefined,
    member: memberIdx >= 0 ? argv[memberIdx + 1] : undefined,
  };
  const result = check(options);
  if (argv.includes("--report")) printReport(result, options);

  // 汇总（无论是否 --report 都打）
  console.log(`spec 耦合形式扫描：${result.files} 个 spec，命中 ${result.findings.length} 处`);
  for (const [form, label] of Object.entries(FORMS)) {
    console.log(`  ${label}: ${result.byForm[form]}`);
  }
  if (result.byMember.length > 0) {
    console.log("\n被耦合最多的成员（top 15）：");
    for (const m of result.byMember.slice(0, 15)) {
      const detail = Object.entries(m.forms)
        .map(([f, n]) => `${f}×${n}`)
        .join(" ");
      console.log(`  ${m.member}: ${m.count} 处（${detail}）`);
    }
  }
  console.log(
    "\nℹ️ 本脚本**只报告不判红**（刻意）：判红需要「哪些成员允许被哪种形式耦合」的" +
      "策略表，而那要等积累 2–3 刀的真实数据再定。搬迁前请人工核对本清单。",
  );
}

// ── 自检：判据本身有牙（往合成样本里塞各形式 ⇒ 必须命中；注释/比较运算 ⇒ 必须不命中）
function selftest() {
  const assert = (c, m) => {
    if (!c) throw new Error(m);
  };
  const has = (line, form, member) =>
    scanLine(line).some((h) => h.form === form && h.member === member);
  const none = (line) => scanLine(line).length === 0;

  let n = 0;
  const ok = (label, fn) => {
    fn();
    n += 1;
    console.log(`  ✓ ${n}. ${label}`);
  };

  ok("① 直调 service.x( 命中 directCall", () => {
    assert(has(`await service.handleCallback([cb]);`, "directCall", "handleCallback"), "missed");
  });
  ok("①b 别名 svc / sut 也命中", () => {
    assert(has(`await svc.trigger("t1", {});`, "directCall", "trigger"), "missed svc");
    assert(has(`const r = sut.list();`, "directCall", "list"), "missed sut");
  });
  ok("② jest.spyOn(service, \"x\") 命中 spyOn", () => {
    assert(
      has(`jest.spyOn(service, "cleanupOldExecutions")`, "spyOn", "cleanupOldExecutions"),
      "missed",
    );
  });
  ok("②b (service as any).x 命中 spyOn（不是 directCall）", () => {
    const hits = scanLine(`jest.spyOn(service as any, "backfillFullLogsFromExecutor")`);
    assert(hits.some((h) => h.form === "spyOn"), "missed spyOn");
    assert(
      has(`await (service as any).somePrivate();`, "spyOn", "somePrivate"),
      "missed as-any",
    );
  });
  ok("③ service.x = jest.fn() 命中 assign", () => {
    assert(has(`service.emitTerminalEvent = jest.fn();`, "assign", "emitTerminalEvent"), "missed");
    assert(has(`service.releaseExecutorSlot = jest.fn(async () => undefined);`, "assign", "releaseExecutorSlot"), "missed async");
  });
  ok("③b 比较运算不算赋值（`===` / `==`）", () => {
    assert(none(`if (service.x === 1) return;`), "== misdetected as assign");
    assert(none(`if (service.x == 1) return;`), "== misdetected as assign");
  });
  ok("④ service[\"x\"] 命中 bracket", () => {
    assert(has(`expect(service["releaseExecutorSlot"]).toHaveBeenCalledWith(a);`, "bracket", "releaseExecutorSlot"), "missed");
    assert(has("expect(svc['foo']).toBe(1);", "bracket", "foo"), "missed single-quote");
  });
  ok("⑤ mock.results[N] 命中 indexed", () => {
    assert(
      has(
        `const qb = (service as any).execRepo.createQueryBuilder.mock.results[0].value;`,
        "indexed",
        "execRepo",
      ),
      "missed results",
    );
    assert(
      has(`expect(service.execRepo.count.mock.calls[0][0]).toEqual(x);`, "indexed", "execRepo"),
      "missed calls",
    );
  });
  ok("注释行不命中（避免说明性文字污染报告）", () => {
    assert(none(`// jest.spyOn(service, "x") 断言它`), "comment hit");
    assert(none(` * service["y"] 的说明`), "block comment hit");
  });
  ok("非 service 接收者不命中（expect/jest/console 等）", () => {
    assert(none(`expect(queue.add).toHaveBeenCalledTimes(1);`), "expect hit");
    assert(none(`console.log("x");`), "console hit");
    assert(none(`jest.fn().mockResolvedValue(1);`), "jest hit");
  });
  ok("一行多形式全报（bracket + indexed 同在）", () => {
    const hits = scanLine(
      `expect(service["t"]).toHaveBeenCalledWith((service as any).execRepo.find.mock.results[0]);`,
    );
    const forms = new Set(hits.map((h) => h.form));
    assert(forms.has("bracket"), "no bracket");
    assert(forms.has("indexed"), "no indexed");
  });
  ok("真实仓库可扫（至少扫到 1 个 spec，且五种形式都出现过）", () => {
    const r = check({ root: REPO_ROOT });
    assert(r.files > 0, "no spec files scanned");
    for (const form of Object.keys(FORMS)) {
      // 形式 ①②③④⑤ 在本仓实测都存在（否则本判据的某一路从没被真实数据验证过）
      assert(r.byForm[form] > 0, `form ${form} never matched in the real repo`);
    }
  });

  console.log(`\n✔ spec 耦合形式扫描自检通过（${n} 例）`);
}

main();
