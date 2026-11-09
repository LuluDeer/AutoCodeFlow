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
 *   node scripts/check-spec-coupling-surfaces.mjs --out <path>    # 报告写成 JSON（拆分批次留档）
 *   node scripts/check-spec-coupling-surfaces.mjs --root <dir>    # 以 <dir> 为仓库根（也认 --root=<dir>）
 *
 * ## 仓库根从哪来（`--root`）
 *
 * 扫描面（`apps/` + `packages/` 下的 spec）是**仓库相对**的，所以「根」是本脚本
 * 唯一的输入口径：
 *
 *   · 不传 `--root` ⇒ 根 = `REPO_ROOT`（`<repo>/scripts/` 的上一级），**与引入
 *     `--root` 之前逐字节等价**（不读 `process.cwd()`）；
 *   · `--root <dir>` / `--root=<dir>` 两种形态都认 ⇒ 扫描根换成 `<dir>`（给
 *     selftest 夹具 / 反证用：在临时目录造一个假仓库，绝不碰真仓库）；
 *   · `--root` 缺值 / 空值 / 指向不存在的目录 ⇒ **exit 2**（用法错误）。
 *     **不许静默回落到真仓库**——「以为在跑夹具、实际跑的是真仓库」是最坏的假绿；
 *   · `--selftest` 与 `--root` **互斥** ⇒ exit 2：自检的对照组就是**真仓库**
 *     （多条用例断言「真实仓库」的 R1 分桶与各形式覆盖），换根会让对照组失去意义。
 *
 * **两类路径基准别混**：`--out <path>` 是**用户路径**，按 `process.cwd()` 解析
 * （`resolve(outPath)`，与 `--file` / `--member` 一样是「用户敲在哪就在哪」）；
 * `--root` 只管「仓库自己的扫描面」。本脚本**不往仓库内写盘**：`--out` 是用户
 * 指定的目标，自检的临时报告写到 `os.tmpdir()`。
 *
 * ## 为什么要有 `--out`（Lead 2026-11-04 要求）
 *
 * 每刀拆分**开工前**要跑一次 `--report` 看耦合面。但「跑了」不等于「留下了」——
 * 复盘时要能回答「这刀开工时 R1 有几处、三刀之后少了没有」。
 * `--out` 把结果写成 JSON（默认建议放 `artifacts/`，那个目录 gitignored，
 * 不往 `docs/` 里再手抄一份数字 —— 手抄的数字一定会腐烂，这正是本仓反复抓到的病）。
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

import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * **复用** `check-source-text-contracts.mjs` 的判据，不复制路径解析逻辑（Lead 硬要求）。
 *
 * 复用的是 `looksLikeImplementationRead(lines, idx)` —— 「这一行是否指向**实现源码**」
 * （`.ts`/`.tsx`/`.css`/`.py`，且不是 json/log）这件事它已经判定了，含多行正向写法
 * （A9-① 的正向 lookahead）、迁移 spec、`SRC_ROOT` 等全部既有口径。
 * 若我自己再写一套「这个路径是不是实现文件」，就是第二份真相 —— 且必然与它漂移。
 *
 * **如实说明复用边界**：我只复用**「路径是否指向实现源码」**这一个判定；
 * 「这段源码文本被哪个 expect 消费、是正向还是负向」是**新的一维**，它不在
 * source-text-contracts 的判据里（那边只关心「谁读了实现源码」，不关心断言极性），
 * 所以这部分是本脚本新写的，不是复制。
 */
import { looksLikeImplementationRead } from "./check-source-text-contracts.mjs";
import { fileURLToPath } from "node:url";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";
// R165：覆盖计数出口。helper = 本文件 selftest 里真实的一次调用=一条用例的注册函数 `ok`
// （实测 30 个 `ok("` 调用点 == `--selftest` 的 30 例）⇒ floor 取一半，删用例必然降计数。
printCoverageBanner(import.meta.url, "ok");

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
  sourceTextAssertion: "⑥ 源码文本断言（readFileSync(实现) → expect(源码)）",
};

/**
 * 第 6 种形式的**极性**（决定危险等级 —— 这是本形式的核心分类）。
 *
 *   · **正向**（`toMatch` / `toContain`）：实现搬走 ⇒ 源码里没这段文本 ⇒ 断言**失败** ⇒
 *     **红**。安全（会被发现），但仍需修（它绑定了实现形状）。
 *   · **负向**（`not.toMatch` / `not.toContain`）：实现搬走 ⇒ 源码里也没这段文本 ⇒
 *     断言**恒真** ⇒ **静默假过**。**这是「永真门槛」**——测试报绿，但它守的东西已经没了。
 *
 * 实证（2026-11-04，`app-deployment.rollout-claim.spec.ts:149`）：
 *   `expect(src).not.toMatch(/release[A-Za-z]*\(\s*[^)]*this\.rolloutBatches\.get\(/)`
 * 守的是 G-D 那个致命缺陷（finishBatch 先删内存态 ⇒ release 现取恒 undefined ⇒
 * claim 永不释放 ⇒ 该应用永久开不了灰度）。实现搬进协作者后，service 源文本里
 * **再无** `this.rolloutBatches.get(` ⇒ 这条「禁止现取内存态」的门槛**永远通过**。
 * 比 R1 更隐蔽：R1 至少能 grep 到 `not.toHaveBeenCalled()`，这个连扫描器都不列。
 */
export const SOURCE_TEXT_POLARITY = {
  positive: "正向（搬走会变红，安全但需修）",
  negative: "负向（搬走恒真 ⇒ **永真门槛**）",
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
 * @param {Set<string>} [mockVars] 本文件里被声明为 jest mock/spy 的变量名（用于识别
 *   `recv.member = someMockVar` 这种**变量 RHS** 的覆写；缺省空集合 ⇒ 只认直接量）
 * @returns {Array<{form: keyof FORMS, member: string|null, snippet: string}>}
 */
export function scanLine(line, mockVars = new Set()) {
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

  // ③ 赋值式覆写：`service.x = jest.fn(...)` / `service.x = enqueue`（右侧是 mock 变量）
  //    ⚠️ 必须排除 `===` / `==`（比较，不是赋值）。
  //
  // ## 两种 RHS 形态（A9-②·计数修正，2026-11-04）
  //
  //   · **直接量**：`= jest.fn(...)` / `= async () => ...` —— 一行就能判定；
  //   · **变量**：`= enqueue`（`const enqueue = jest.fn(...)` 在上一行声明）—— 同行
  //     看不出来，必须靠**文件级**上下文（`mockVars`）。
  //
  // 为什么必须修：旧正则只认直接量 ⇒ 实测漏了 4 处（`h.service.enqueueLlmResume = enqueue;`
  // ⇒ 真实 assign 总数 15 而非 11）。**计数错了会按数量误判优先级** —— 而这 4 处里
  // 有 3 处正是 R1 要抓的「负向断言」形态，漏掉就等于漏掉 3/4 的真实风险。
  //
  // 反方向的边界（Lead 要求 fixture 覆盖）：**只声明不算**。`const enqueue = jest.fn(...)`
  // 本身是声明/初始化，不是「覆写某个成员」；只有 `recv.member = <mockVar>` 才算。
  const assignDirect = new RegExp(
    `(?:${RECV_ALT})\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*=(?!=)\\s*` +
      `(?:jest\\.fn|jest\\.spyOn|\\(\\)|async|function|vi\\.fn)`,
  ).exec(line);
  if (assignDirect) push("assign", assignDirect[1], line);
  else {
    // RHS 是裸标识符，且该标识符在本文件里被声明为 jest mock / spy ⇒ 也算 assign
    const assignVar = new RegExp(
      `(?:${RECV_ALT})\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*=(?!=)\\s*([A-Za-z_$][\\w$]*)\\s*;?\\s*$`,
    ).exec(line);
    if (assignVar && mockVars.has(assignVar[2])) push("assign", assignVar[1], line);
  }

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
 * 收集「**持有实现源码文本的变量名**」（第 6 种形式的识别基础）。
 *
 * 三步（都基于**本文件内**的静态证据，不跨文件猜）：
 *   ① 找出**实现源码路径常量**：`const SERVICE_SRC = join(__dirname, "...", "x.ts")`
 *      —— 用 `looksLikeImplementationRead` 判（复用它，不自己写路径口径）；
 *   ② 找出**读源码的入口**：`readFileSync(P)` 直接调用，或本地 helper
 *      `const read = (p) => readFileSync(p, "utf8")`（`x.service.spec.ts` 的常见形态）；
 *   ③ 找出**承载源码文本的变量**：`const src = read(SERVICE_SRC)` /
 *      `const src = stripComments(read(SERVICE_SRC))` / `const src = serviceCode()`
 *      （后者是「返回源码的函数」，需递归一层）。
 *
 * 返回 `Map<变量名, {implFile, line}>`。方向安全：认不出就不算（少报而非误报）。
 *
 * @param {string[]} lines
 * @returns {Map<string, {implFile: string|null, line: number}>}
 */
export function collectSourceTextVars(lines) {
  /** 路径常量名 → 指向的实现文件名（取路径最后一段，够报告用） */
  const pathConsts = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:join|resolve|path\.join|path\.resolve)?\s*\(?/.exec(
      lines[i],
    );
    if (!m) continue;
    // 该常量所在的「语句窗口」（多行 join 要往下看几行）
    const end = Math.min(lines.length, i + 8);
    const window = lines.slice(i, end).join("\n");
    // ⚠️ 必须对**窗口内每一行**都试 `looksLikeImplementationRead`，不能只试首行：
    // `const SERVICE_SRC = join(` 这一行本身没有 `.ts` 字面量（它在第 3 行），
    // 只看首行会漏掉整条多行路径常量 —— 而本仓最危险的 `serviceCode()` 正是这种写法。
    if (!Array.from({ length: end - i }, (_, k) => i + k).some((j) => looksLikeImplementationRead(lines, j))) {
      continue;
    }
    const fileM = /["'`]([^"'`/\\]+\.(?:ts|tsx|py|css))["'`]/.exec(window);
    pathConsts.set(m[1], { implFile: fileM ? fileM[1] : null, line: i + 1 });
  }

  /** 读源码的入口：helper 名（`const read = (p) => readFileSync(p, "utf8")`） */
  const readHelpers = new Set();
  for (const line of lines) {
    const m = /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*\(?[^=]*\)?\s*=>\s*[^;]*readFileSync/.exec(line);
    if (m) readHelpers.add(m[1]);
  }
  /** 返回源码文本的函数名：`const serviceCode = () => stripComments(read(SERVICE_SRC))` */
  const srcFns = new Map();
  for (const line of lines) {
    const m = /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*\(?[^=]*\)?\s*=>\s*(.*)$/.exec(line);
    if (!m) continue;
    for (const pc of pathConsts.keys()) {
      if (new RegExp(`\\b${esc(pc)}\\b`).test(m[2])) {
        const via = pathConsts.get(pc);
        srcFns.set(m[1], { implFile: via.implFile, line: via.line });
        break;
      }
    }
  }

  const vars = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$/.exec(lines[i]);
    if (!m) continue;
    const [, name, rhs] = m;
    // 直接 readFileSync(<路径常量>) / readFileSync(__dirname ...)
    for (const [pc, via] of pathConsts) {
      if (new RegExp(`\\b${esc(pc)}\\b`).test(rhs)) {
        vars.set(name, { implFile: via.implFile, line: i + 1 });
        break;
      }
    }
    if (vars.has(name)) continue;
    // read("<字面路径>.ts") / readFileSync("<字面路径>.ts") —— 实参直接是路径字面量
    // （如 `const src = read("apps/.../users.controller.ts")`）。这条也要认，
    // 否则这类 spec 会被判成「没读实现源码」而静默消失（实测漏了 pagination-layering 一族）。
    const litPath = /["'`]([^"'`\n]+\.(?:ts|tsx|py|css))["'`]/.exec(rhs);
    if (litPath && /\b(?:read|readFileSync)\s*\(/.test(rhs)) {
      vars.set(name, { implFile: litPath[1].split("/").pop(), line: i + 1 });
      continue;
    }
    // read(SERVICE_SRC) / stripComments(read(SERVICE_SRC)) —— helper 形态
    for (const h of readHelpers) {
      if (new RegExp(`\\b${esc(h)}\\s*\\(`).test(rhs)) {
        for (const [pc, via] of pathConsts) {
          if (new RegExp(`\\b${esc(pc)}\\b`).test(rhs)) {
            vars.set(name, { implFile: via.implFile, line: i + 1 });
            break;
          }
        }
      }
    }
    if (vars.has(name)) continue;
    // 返回源码的函数：const src = serviceCode()
    for (const [fn, via] of srcFns) {
      if (new RegExp(`\\b${esc(fn)}\\s*\\(\\s*\\)`).test(rhs)) {
        vars.set(name, { implFile: via.implFile, line: i + 1 });
        break;
      }
    }
  }
  return vars;
}

/**
 * 收集本文件里**声明为 jest mock / spy 的变量名**（用于识别 `recv.member = someMockVar`）。
 *
 * 只认「裸声明」：`const X = jest.fn(...)` / `let X = jest.spyOn(...)` / `X = vi.fn(...)`。
 * **纯声明不算覆写**（Lead 2026-11-04 的边界要求）：`const enqueue = jest.fn(...)` 本身
 * 是初始化，只有「把该变量赋给某个接收者的成员」才是覆写。
 *
 * 方向：漏收 ⇒ 少报（安全）；多收 ⇒ 只会在 RHS 恰好同名时多报（可接受，R1 才是判红项）。
 */
export function collectMockVars(lines) {
  const vars = new Set();
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:jest\.fn|jest\.spyOn|vi\.fn)/;
  for (const line of lines) {
    if (isCommentLine(line)) continue;
    const m = re.exec(line);
    if (m) vars.add(m[1]);
  }
  return vars;
}

/**
 * **R1 已知项基线**（脚本内常量，沿用 `check-publishable-wiring.mjs` 的
 * `UNWIRED_BASELINE` 形态 —— 不另建 JSON 文件，因为这条基线会随每次拆分变动，
 * 放在判定脚本里才能让「改了判据」和「改了豁免」在同一个 diff 里被看见）。
 *
 * 语义（与 sibling 守卫一致的三条棘轮）：
 *   · 在基线里 ⇒ **不判红**，但**每次 --report 里点名列出**（可见，不静默）；
 *   · 不在基线里 ⇒ **判红**（新增即红：这条配对意味着「搬走即静默假过」）；
 *   · 基线里的条目**已不存在** ⇒ **判红**（棘轮收紧：修好了就把登记删掉，
 *     否则基线只增不减，最后变成永久豁免）。
 *
 * 为什么当前有 4 条：R1 是 2026-11-04 才立的判据，这 4 处是**存量**（先于判据存在）。
 * 按本仓纪律「首跑红灯只落基线、不改别人代码迁就守卫」处理 —— `apps/**` 不在我的
 * 写入范围，修它们（把负向断言改成正向 / 断真实可观测量）是 spec owner 的活。
 */
const R1_BASELINE = new Map([
  [
    "apps/admin-api/src/modules/task/__tests__/execution-attempt-seq.spec.ts:storeLogLines:576",
    "C5：覆写在 makeService 工厂 :576、负向断言在 it :602。真实意图是「迟到回合的日志不许写进新回合」，" +
      "改法是断落库值/出参，而不是断「替身没被调用」。owner 待派（task 模块）。",
  ],
  [
    "apps/admin-api/src/modules/agent/runtime/agent-runtime.service.spec.ts:enqueueLlmResume:1590",
    "覆写 L1590 + 负向断言 L1595（确定性失败 ⇒ 不排 job）。owner 待派（agent 模块）。",
  ],
  [
    "apps/admin-api/src/modules/agent/runtime/agent-runtime.service.spec.ts:enqueueLlmResume:1605",
    "覆写 L1605 + 负向断言 L1610（额度已用掉 ⇒ 不排 job）。owner 待派（agent 模块）。",
  ],
  [
    "apps/admin-api/src/modules/agent/runtime/agent-runtime.service.spec.ts:enqueueLlmResume:1629",
    "覆写 L1629 + 负向断言 L1634（墙钟剩余不足 ⇒ 不排 job）。owner 待派（agent 模块）。",
  ],
]);

/**
 * 负向断言的形态：`expect(...).not.toHaveBeenCalled()` / `.not.toBeCalled()` / `.toHaveBeenCalledTimes(0)`。 */
const NEGATIVE_ASSERT_RE =
  /\bnot\s*\.\s*toHaveBeenCalled\s*\(|\.not\s*\.\s*toBeCalled\s*\(|toHaveBeenCalledTimes\s*\(\s*0\s*\)/;

/**
 * **第 6 种形式**：源码文本断言（`readFileSync(实现)` → `expect(源码).toMatch(...)`）。
 *
 * @param {string} file 相对路径
 * @param {string[]} lines
 * @returns {Array<{file,line,form,member,implFile,polarity,snippet}>}
 */
export function findSourceTextAssertions(file, lines) {
  const srcVars = collectSourceTextVars(lines);
  if (srcVars.size === 0) return [];
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isCommentLine(line)) continue;
    // 期望形态：expect(<源码变量>) 或 expect(<表达式含源码变量>).toMatch/toContain
    const m = /expect\s*\(([^)]*)\)\s*\.\s*(not\s*\.\s*)?(toMatch|toContain|toBe|toEqual)\s*\(/.exec(line);
    if (!m) continue;
    const [, subject, notFlag, matcher] = m;
    if (matcher !== "toMatch" && matcher !== "toContain") continue;
    let hit = null;
    for (const [name, via] of srcVars) {
      if (!via.implFile) continue; // 解析不出实现文件 ⇒ 不判（见 collectSourceTextVars 头注）
      if (new RegExp(`\\b${esc(name)}\\b`).test(subject)) {
        hit = { name, via };
        break;
      }
    }
    if (!hit) continue;
    out.push({
      file,
      line: i + 1,
      form: "sourceTextAssertion",
      member: hit.via.implFile ?? hit.name,
      implFile: hit.via.implFile,
      polarity: notFlag ? "negative" : "positive",
      snippet: line.trim().slice(0, 160),
    });
  }
  return out;
}

/**
 * **R1 判据**：`assign` 覆写 + **同一成员**的**负向断言** ⇒ 静默假过风险（Lead 2026-11-04 批准立项）。
 *
 * ## 为什么这个配对危险（一句话的机制）
 *
 * 成员搬到协作者之后，Facade 上被覆写的属性**再没人调用**：
 *   · 正向断言 `toHaveBeenCalledWith` ⇒ 桩没被调用 ⇒ **失败**（红，安全，会被发现）；
 *   · 负向断言 `not.toHaveBeenCalled()` ⇒ 桩没被调用 ⇒ **通过**（**静默假过**）。
 * 后者正是「真实协作者照样执行副作用，而测试报绿」。
 *
 * ## 只命中配对，不一刀切禁 assign（Lead 明确要求的边界）
 *
 * 9 处无断言的隔离替身是**正当用法**：作用是阻断副作用让用例聚焦被测逻辑，本身
 * 不声称任何行为。禁掉它们这些 spec 就写不出来了。
 *
 * ## 匹配面
 *
 * 同一文件内，若成员 M 被 `recv.M = <mock>` 覆写，且存在断言同时提到 M 且是负向
 * ⇒ 判违规。断言可以写成 `service["M"]` / `service.M` / `expect(enqueue)`（变量形）
 * —— 最后一种靠「该变量正是被赋给 M 的那个」来关联。
 *
 * @returns {Array<{file, member, assignLine, assertLine, snippet}>}
 */
export function findR1Pairs(file, lines, findings) {
  const out = [];
  const allAssigns = findings.filter((f) => f.form === "assign" && f.member);
  if (allAssigns.length === 0) return out;

  /**
   * **按测试块（`it(...)` / `test(...)`）划界**——这是本判据正确性的关键。
   *
   * 为什么必须划界：实测（2026-11-04）`agent-runtime.service.spec.ts` 有 4 个
   * `it()` 各自写 `h.service.enqueueLlmResume = enqueue;`，其中 1 个用**正向**断言、
   * 3 个用**负向**。若按「整个文件」配对，会把「第 1 个块的 assign」和「第 2 个块的
   * 负向断言」配成一对 —— **报出来的行号是错的**，而错误行号比漏报更坏（人会去错的地方看）。
   *
   * 划界规则（够用且不引入解析器）：从 `it(` / `test(` 那一行起，到下一个 `it(` / `test(`
   * 之前为止为一个块；块外的行归入「无块」桶（仍参与配对，行号以 0 计）。
   */
  /**
   * 块 = `it(`/`test(` 起，到**花括号配平**为止（不是「到下一个 it( 之前」）。
   *
   * 为什么要配平而不是「下一个 it(」：`makeService()` 这类 fixture 工厂定义在
   * **两个 it 之间**（文件作用域）。用「最近的前一个 it(」会把工厂里的行误判成
   * 属于上一个 it —— 于是 C5 那处（覆写在工厂、断言在 it）就配不上，正好漏掉。
   * 实测踩过：`execution-attempt-seq.spec.ts` 的 `makeService` 在 `it` 511 之后、
   * `it` 587 之前，纯「前一个 it」口径给出错误的块归属。
   */
  const blockRanges = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*(?:it|test)(?:\.\w+)?\s*\(/.test(lines[i])) continue;
    let depth = 0;
    let started = false;
    let end = i;
    for (let j = i; j < lines.length; j += 1) {
      for (const ch of lines[j]) {
        if (ch === "{") {
          depth += 1;
          started = true;
        } else if (ch === "}") depth -= 1;
      }
      if (started && depth <= 0) {
        end = j;
        break;
      }
      end = j;
    }
    blockRanges.push([i, end]);
  }
  const blockOf = (lineNo) => {
    const idx = lineNo - 1; // 1-based → 0-based
    for (const [start, end] of blockRanges) {
      if (idx >= start && idx <= end) return start;
    }
    return -1; // 块外（fixture 工厂 / 模块作用域）
  };
  const assigns = allAssigns;

  // 变量形：`recv.M = enqueue;` ⇒ varToMember["enqueue"] = M
  const varToMember = new Map();
  for (const a of assigns) {
    const m = /=\s*([A-Za-z_$][\w$]*)\s*;?\s*$/.exec(lines[a.line - 1] ?? "");
    if (m) varToMember.set(m[1], a.member);
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isCommentLine(line) || !NEGATIVE_ASSERT_RE.test(line)) continue;
    // 断言里提到了哪个成员？
    const assertBlock = blockOf(i + 1);
    for (const a of assigns) {
      /**
       * 配对规则（两条，缺一不可）：
       *   ① assign 在**某个** `it()` 块内 ⇒ 必须与断言同块；
       *   ② assign 在**块外**（fixture 工厂 / makeService 之类）⇒ 视为**该文件全局**，
       *      与任何块的断言都配得上。
       *
       * 为什么要 ②：实测 C5（`execution-attempt-seq.spec.ts`）的覆写在 `makeService()`
       * 工厂里（块外），断言在 `it()` 里（块内）。只按「同块」会把这一处**漏掉** ——
       * 而它正是 R1 最典型的样本。只按「整文件」又会跨块配错行号（见 blockOf 头注）。
       * 两条并用才既准又全。
       */
      const assignBlock = blockOf(a.line);
      if (assignBlock !== -1 && assignBlock !== assertBlock) continue;
      const M = a.member;
      const mentions =
        new RegExp(`\\[\\s*["'\`]${esc(M)}["'\`]\\s*\\]`).test(line) ||
        new RegExp(`\\.${esc(M)}\\b`).test(line) ||
        [...varToMember.entries()].some(
          ([v, mm]) => mm === M && new RegExp(`\\b${esc(v)}\\b`).test(line),
        );
      if (!mentions) continue;
      out.push({
        file,
        member: M,
        assignLine: a.line,
        assertLine: i + 1,
        assertText: line.trim().slice(0, 160),
      });
      break;
    }
  }
  return out;
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
  const r1Violations = [];
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
    const mockVars = collectMockVars(lines);
    const fileFindings = [];
    for (let i = 0; i < lines.length; i += 1) {
      for (const hit of scanLine(lines[i], mockVars)) {
        if (options.member && hit.member !== options.member) continue;
        const f = { file: rel, line: i + 1, ...hit };
        findings.push(f);
        fileFindings.push(f);
      }
    }
    r1Violations.push(...findR1Pairs(rel, lines, fileFindings));
    // 第 6 种形式：源码文本断言（独立于 scanLine —— 它需要「变量持有源码文本」这个上下文）
    for (const hit of findSourceTextAssertions(rel, lines)) {
      if (options.member && hit.member !== options.member) continue;
      findings.push(hit);
      fileFindings.push(hit);
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

  // ── R1 判定：新增即红 / 基线内不红但点名 / 基线腐烂即红 ──────────────
  //
  // `--root` 指向**别的树**时基线整张不适用：`R1_BASELINE` 的键是**本仓**某几行 spec
  // 的仓库相对路径，把根换成夹具后它们既匹配不到、也不该被判成「腐烂」（那 4 条
  // 在真仓库里仍然成立）。⇒ 基线只在「根就是本仓」时生效，并**打印一行说明**
  // （不静默改判据：外来树上 R1 命中一律进 failing，仍然红）。
  const baselineApplies = root === REPO_ROOT;
  const r1Failures = [];
  const r1Baselined = [];
  const notes = [];
  if (!baselineApplies) {
    notes.push(
      `R1 基线未生效：--root=${root} 不是本仓 ⇒ 基线登记的 ${R1_BASELINE.size} 条不参与判定` +
        `（外来树上的 R1 命中一律判红）`,
    );
  }
  const seen = new Set();
  for (const v of r1Violations) {
    const key = `${v.file}:${v.member}:${v.assignLine}`;
    if (baselineApplies && R1_BASELINE.has(key)) {
      seen.add(key);
      r1Baselined.push({ ...v, key, why: R1_BASELINE.get(key) });
    } else {
      r1Failures.push({
        ...v,
        key,
        message:
          `R1：\`${v.member}\` 被 **assign 覆写**（L${v.assignLine}）且同块存在**负向断言**（L${v.assertLine}）—— ` +
          `成员搬走后桩恒不被调用 ⇒ 该断言**恒真** ⇒ 真实协作者照样执行副作用而测试报绿（静默假过）。` +
          `修法：改为**正向**断言（断言副作用应当以某参数发生），或断**真实可观测量**（落库值/出参）。`,
      });
    }
  }
  for (const key of baselineApplies ? R1_BASELINE.keys() : []) {
    if (!seen.has(key)) {
      r1Failures.push({
        key,
        file: key.split(":")[0],
        message:
          `R1 基线腐烂：登记的 \`${key}\` 已不再命中 —— 要么已修好（**删掉这条登记**，棘轮只减不增），` +
          `要么判据漏了它（查 scanLine/findR1Pairs）。`,
      });
    }
  }

  return { files: files.length, findings, byForm, byMember, r1Violations, r1Failures, r1Baselined, notes };
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

/**
 * 把扫描结果写成 JSON（`--out <path>`）。
 *
 * 设计取舍（刻意窄）：
 *   · **只写机器可读的原始结果**，不做「结论摘要」——摘要会变成第二份人工维护的数字；
 *   · **带 `generatedAt` / `commitHint` 便于复盘对齐**，但不带「跟上一刀比少了几个」——
 *     差分是复盘时算的，不是采集时算的（采集时算差分要把上一份读进来，多一个失败模式）；
 *   · 目录不存在会自动建（`artifacts/rounds/` 之类）。
 *
 * @returns {string} 实际写入的绝对路径
 */
export function writeJsonReport(result, outPath) {
  const abs = resolve(outPath);
  mkdirSync(dirname(abs), { recursive: true });
  const payload = {
    $comment:
      "spec 耦合面快照（check-spec-coupling-surfaces.mjs --out）。每刀拆分开工前跑一次，" +
      "复盘时对比 R1 数量与 assign 分布。**本文件不含「结论」，只有采集结果** —— " +
      "结论在 report 正文里，避免两份数字各自演化。",
    generatedAt: new Date().toISOString(),
    files: result.files,
    totals: {
      findings: result.findings.length,
      byForm: result.byForm,
      r1Violations: (result.r1Violations ?? []).length,
      r1Baselined: (result.r1Baselined ?? []).length,
      r1Failures: (result.r1Failures ?? []).length,
    },
    byMember: result.byMember,
    // R1 明细（含基线内外标记）——拆分批次最关心这一块
    r1: (result.r1Violations ?? []).map((v) => {
      const key = `${v.file}:${v.member}:${v.assignLine}`;
      const baselined = (result.r1Baselined ?? []).some((b) => b.key === key);
      return {
        file: v.file,
        member: v.member,
        assignLine: v.assignLine,
        assertLine: v.assertLine,
        assertText: v.assertText,
        status: baselined ? "baselined" : "failing",
      };
    }),
    // 全量命中（可按 form 过滤，量大的话用 --file/--member 收窄）
    findings: result.findings,
  };
  writeFileSync(abs, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return abs;
}

/** 用法错误退出码（与「报告型脚本恒 0」分开，口径同 `check-mcp-error-hints.mjs`）。 */
const EXIT_USAGE = 2;

/**
 * 解析仓库根。**只认** `--root`（`--root <dir>` / `--root=<dir>` 两种形态）。
 *
 * `--root` 缺值即抛（入口报 exit 2）：把末尾裸写的 `--root` 当成 `.` 会让根落到
 * `process.cwd()` —— 那句「以为在跑夹具」会直接掉进真仓库。
 */
function parseRoot(argvs, { selftest: selftestMode = false } = {}) {
  let root = REPO_ROOT;
  let explicit = false;
  for (let i = 0; i < argvs.length; i += 1) {
    const a = argvs[i];
    if (a === "--root" || a.startsWith("--root=")) {
      const v = a === "--root" ? argvs[++i] : a.slice("--root=".length);
      if (!v || v.startsWith("--")) {
        throw new Error("`--root` 需要一个目录参数（`--root <dir>` 或 `--root=<dir>`）");
      }
      root = resolve(v);
      explicit = true;
    }
  }
  if (!explicit) return REPO_ROOT;
  if (selftestMode) {
    throw new Error(
      "`--selftest` 与 `--root` 互斥：自检的对照组就是**真仓库**（R1 分桶 / 各形式覆盖都钉在真数据上）",
    );
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`\`--root\` 指向的目录不存在：${root}`);
  }
  return root;
}

function main() {
  const argv = process.argv.slice(2);
  const selftestMode = argv.includes("--selftest");
  let root;
  try {
    root = parseRoot(argv, { selftest: selftestMode });
  } catch (err) {
    console.error(`✘ 用法错误：${err.message}`);
    process.exit(EXIT_USAGE);
  }
  if (selftestMode) {
    selftest();
    return;
  }
  const fileIdx = argv.indexOf("--file");
  const memberIdx = argv.indexOf("--member");
  const outIdx = argv.indexOf("--out");
  const options = {
    root,
    file: fileIdx >= 0 ? argv[fileIdx + 1] : undefined,
    member: memberIdx >= 0 ? argv[memberIdx + 1] : undefined,
  };
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  if (outIdx >= 0 && (!outPath || outPath.startsWith("--"))) {
    console.error("✖ --out 需要一个路径，例如 --out artifacts/rounds/coupling.json");
    process.exit(1);
  }
  const result = check(options);
  // 口径说明（例如「R1 基线不适用于外来 --root」）——打印出来，不静默改变判据。
  for (const note of result.notes ?? []) console.log(`notice: ${note}`);
  if (argv.includes("--report")) printReport(result, options);
  if (outPath) {
    const abs = writeJsonReport(result, outPath);
    console.log(`\n📄 报告已写入 ${abs}`);
  }

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
  // ── ⑥ 负向断言（**永真门槛**）——必须单独看见，不能被 322 条正向淹没 ──────
  const stAll = result.findings.filter((f) => f.form === "sourceTextAssertion");
  const stNeg = stAll.filter((f) => f.polarity === "negative");
  console.log(
    `\n── ⑥ 源码文本断言：负向（**永真门槛**，${stNeg.length} 处 / 共 ${stAll.length} 处）`,
  );
  if (stNeg.length === 0) {
    console.log("   （无）");
  } else {
    console.log(
      "   这些是「实现搬走后**恒真**」的断言：源码里没那段文本 ⇒ not.toMatch 永远通过 ⇒ 测试报绿但门槛已失效。",
    );
    for (const x of stNeg) {
      console.log(`   ${x.file}:${x.line}  → 断言的是 ${x.implFile}`);
      console.log(`      ${x.snippet}`);
    }
  }

  // ── R1 命中（Lead 2026-11-04 批准立项的**唯一判红项**）────────────────
  const r1 = result.r1Violations ?? [];
  console.log(`\n── R1 · assign 覆写 + 同成员负向断言（${r1.length} 处，**这一项判红**）`);
  if (r1.length === 0) {
    console.log("   （无 ⇒ 没有「搬走即静默假过」的配对）");
  } else {
    for (const v of r1) {
      console.log(`   ${v.file}`);
      console.log(`      成员 ${v.member}：覆写 L${v.assignLine} + 负向断言 L${v.assertLine}`);
      console.log(`      ${v.assertText}`);
      console.log(
        `      ⚠️ 成员搬走 ⇒ 桩恒不被调用 ⇒ 该负向断言**恒真** ⇒ 真实协作者照样执行副作用而测试报绿`,
      );
    }
  }

  console.log(
    "\nℹ️ 除 R1 外**只报告不判红**（刻意）：判红需要「哪些成员允许被哪种形式耦合」的" +
      "策略表（R2 那种成员级白名单），而那要等积累 2–3 刀的真实数据再定 —— " +
      "且白名单会随每次拆分过期（同 source-size-baseline 棘轮要解决的问题）。",
  );

  // ── R1 结论进退出码（这是本脚本**唯一判红**的判据）──────────────────
  const baseline = result.r1Baselined ?? [];
  if (baseline.length > 0) {
    console.log(`\nR1 基线内（不判红，但可见 —— 修好后请删登记）：${baseline.length} 处`);
    for (const b of baseline) console.log(`  · ${b.key}`);
  }
  const r1f = result.r1Failures ?? [];
  if (r1f.length > 0) {
    console.error(`\n✖ R1 失败 ${r1f.length} 项（assign 覆写 + 同成员负向断言 ⇒ 搬走即静默假过）：`);
    for (const f of r1f) {
      console.error(`  · ${f.file ?? f.key}`);
      console.error(`    ${f.message}`);
    }
    process.exit(1);
  }
}

// ── 自检：判据本身有牙（往合成样本里塞各形式 ⇒ 必须命中；注释/比较运算 ⇒ 必须不命中）
function selftest() {
  const assert = (c, m) => {
    if (!c) throw new Error(m);
  };
  const has = (line, form, member) =>
    scanLine(line).some((h) => h.form === form && h.member === member);
  const has2 = (line, form, member, mockVars) =>
    scanLine(line, mockVars).some((h) => h.form === form && h.member === member);
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

  // ── A9-② 计数修正：变量 RHS 的 assign ────────────────────────────────
  //
  // 旧正则只认直接量（`= jest.fn(...)`）⇒ 漏了 `= enqueue;`（变量）4 处。
  // 但宽化时必须守住边界：**纯声明不算覆写**（Lead 明确要求这条 fixture）。
  ok("③b assign：右侧是**变量**且该变量在本文件声明为 jest.fn ⇒ 命中", () => {
    const mockVars = new Set(["enqueue"]);
    assert(
      has2(`h.service.enqueueLlmResume = enqueue;`, "assign", "enqueueLlmResume", mockVars),
      "变量 RHS 的 assign 应命中（旧正则会漏）",
    );
  });
  ok("③c 【边界】纯声明 `const enqueue = jest.fn()` ⇒ **不算** assign", () => {
    const mockVars = new Set(["enqueue"]);
    assert(
      !has2(`const enqueue = jest.fn(async () => true);`, "assign", "enqueue", mockVars),
      "裸声明不是「覆写某个成员」，不该算 assign",
    );
    assert(
      !has2(`const enqueue = jest.fn();`, "assign", "enqueue", mockVars),
      "无参 jest.fn() 的声明同样不算",
    );
  });
  ok("③d 【边界】右侧变量**未**声明为 mock（如 `service.execRepo = gate.repo`）⇒ 不算 assign", () => {
    const mockVars = new Set(["enqueue"]);
    assert(
      !has2(`service.execRepo = gate.repo;`, "assign", "execRepo", mockVars),
      "右侧是普通对象变量，不是 mock ⇒ 不算覆写",
    );
  });

  // ── R1 判据（Lead 批准立项）：assign + 同成员负向断言 ⇒ 红 ─────────────
  //
  // 三条用例是 Lead 明确要求的「有牙三件套」：
  //   ㉔ 配对 ⇒ 红；㉕ 无断言 ⇒ 不红（正当用法）；㉖ 正向断言 ⇒ 不红（会变红，安全）。
  const r1Of = (text, file = "x.spec.ts") => {
    const lines = text.split("\n");
    const mockVars = collectMockVars(lines);
    const findings = [];
    lines.forEach((l, i) => {
      for (const hit of scanLine(l, mockVars)) findings.push({ file, line: i + 1, ...hit });
    });
    return findR1Pairs(file, lines, findings);
  };

  ok("㉔ 【R1·有牙】assign 覆写 + 同成员 not.toHaveBeenCalled ⇒ **必须红**", () => {
    const v = r1Of(
      [
        "it('x', () => {",
        "  service.storeLogLines = jest.fn();",
        "  expect(service['storeLogLines']).not.toHaveBeenCalled();",
        "});",
      ].join("\n"),
    );
    assert(v.length === 1, `应命中 1 处 R1，实得 ${v.length}`);
    assert(v[0].member === "storeLogLines", "成员识别错");
  });
  ok("㉕ 【R1·正当用法】assign 覆写但**无断言** ⇒ 不红（9 处隔离替身属此类）", () => {
    const v = r1Of(
      [
        "it('x', () => {",
        "  service.storeLogLines = jest.fn();",
        "  await service.handleCallback([cb]);",
        "  expect(res.success).toBe(true);",
        "});",
      ].join("\n"),
    );
    assert(v.length === 0, `无断言的隔离替身不该判红，实得 ${v.length}`);
  });
  ok("㉖ 【R1·安全】assign 覆写 + **正向**断言 ⇒ 不红（搬走会变红，本身就是安全的）", () => {
    const v = r1Of(
      [
        "it('x', () => {",
        "  service.releaseExecutorSlot = jest.fn();",
        "  expect(service['releaseExecutorSlot']).toHaveBeenCalledWith('a');",
        "});",
      ].join("\n"),
    );
    assert(v.length === 0, `正向断言不该判红，实得 ${v.length}`);
  });
  ok("㉗ 【R1·跨块不误配】A 块 assign + B 块负向断言 ⇒ 不红（防报错行号）", () => {
    const v = r1Of(
      [
        "it('a', () => {",
        "  service.storeLogLines = jest.fn();",
        "  expect(service['storeLogLines']).toHaveBeenCalled();",
        "});",
        "it('b', () => {",
        "  expect(service['storeLogLines']).not.toHaveBeenCalled();",
        "});",
      ].join("\n"),
    );
    assert(v.length === 0, `跨块不该配对（会报错行号），实得 ${v.length}`);
  });
  ok("㉘ 【R1·变量形】`= enqueue` + `expect(enqueue).not.toHaveBeenCalled()` ⇒ 红（真实形态）", () => {
    const v = r1Of(
      [
        "it('x', () => {",
        "  const enqueue = jest.fn();",
        "  h.service.enqueueLlmResume = enqueue;",
        "  expect(enqueue).not.toHaveBeenCalled();",
        "});",
      ].join("\n"),
    );
    assert(v.length === 1, `变量形配对应命中，实得 ${v.length}`);
    assert(v[0].member === "enqueueLlmResume", "成员应通过变量关联到 enqueueLlmResume");
  });
  ok("㉙ 【R1·反证】`toHaveBeenCalledTimes(0)` 也算负向断言", () => {
    const v = r1Of(
      [
        "it('x', () => {",
        "  service.storeLogLines = jest.fn();",
        "  expect(service.storeLogLines).toHaveBeenCalledTimes(0);",
        "});",
      ].join("\n"),
    );
    assert(v.length === 1, `toHaveBeenCalledTimes(0) 应算负向，实得 ${v.length}`);
  });

  ok("真实仓库：R1 全部命中项要么在基线内、要么已报红（不允许有第三个桶）", () => {
    const r = check({ root: REPO_ROOT });
    const total = (r.r1Violations ?? []).length;
    const bucketed = (r.r1Baselined ?? []).length + (r.r1Failures ?? []).length;
    assert(total === bucketed, `命中 ${total} 处，但分桶后 ${bucketed} 处（有遗漏）`);
  });

  // ── --out（拆分批次留档，Lead 2026-11-04 要求）─────────────────────────
  // 自检的临时报告写 **os.tmpdir()**（不是仓库根）：本守卫对被测树只读这条不变量
  // 必须对自检也成立 —— 否则 `--selftest` 会在真仓库里留下 `.tmp-coupling-*`。
  const selfTestTmp = mkdtempSync(join(tmpdir(), "coupling-selftest-"));

  ok("㉚ 【--out】JSON 报告可写、结构完整、且 R1 明细带 baselined/failing 标记", () => {
    const tmp = join(selfTestTmp, ".tmp-coupling-selftest.json");
    try {
      const r = check({ root: REPO_ROOT });
      const abs = writeJsonReport(r, tmp);
      const payload = JSON.parse(readFileSync(abs, "utf8"));
      assert(typeof payload.generatedAt === "string", "缺 generatedAt");
      assert(payload.files === r.files, "files 数不一致");
      assert(payload.totals.findings === r.findings.length, "findings 数不一致");
      assert(Array.isArray(payload.r1), "r1 必须是数组");
      // R1 明细必须与 r1Violations 一一对应，且每条都有明确 status（不允许第三个桶）
      assert(payload.r1.length === (r.r1Violations ?? []).length, "r1 明细条数不符");
      for (const item of payload.r1) {
        assert(
          item.status === "baselined" || item.status === "failing",
          `status 非法：${item.status}`,
        );
        assert(typeof item.assignLine === "number" && typeof item.assertLine === "number", "缺行号");
      }
    } finally {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
    }
  });
  ok("㉛ 【--out·反证】写进不存在的嵌套目录也能成功（自动建目录）", () => {
    const dir = join(selfTestTmp, ".tmp-coupling-nest", "a", "b");
    const tmp = join(dir, "r.json");
    try {
      const abs = writeJsonReport(check({ root: REPO_ROOT }), tmp);
      assert(existsSync(abs), "嵌套目录未自动创建");
      JSON.parse(readFileSync(abs, "utf8"));
    } finally {
      try {
        rmSync(join(selfTestTmp, ".tmp-coupling-nest"), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  // ── ⑥ 源码文本断言（Lead 2026-11-04 新增判据）：四类 fixture ────────────
  //
  // 要求：①正向 ②负向 ③读非实现文件 ④读实现但不用于断言 ⇒ 只有 ①② 命中，
  //       且 ② 必须进「永真门槛」段。
  const stOf = (text) => findSourceTextAssertions("x.spec.ts", text.split("\n"));

  ok("⑥a 【正向】readFileSync(实现) 后 expect(src).toMatch ⇒ 命中 positive", () => {
    const hits = stOf(
      [
        'const SERVICE_SRC = join(__dirname, "..", "svc.service.ts");',
        "const read = (p: string) => readFileSync(p, \"utf8\");",
        "const src = read(SERVICE_SRC);",
        "expect(src).toMatch(/foo\\(/);",
      ].join("\n"),
    );
    assert(hits.length === 1, `应命中 1 处，实得 ${hits.length}`);
    assert(hits[0].polarity === "positive", `极性应为 positive，实得 ${hits[0].polarity}`);
    assert(hits[0].implFile === "svc.service.ts", `实现文件识别错：${hits[0].implFile}`);
  });

  ok("⑥b 【负向·永真门槛】expect(src).not.toMatch ⇒ 命中 negative", () => {
    const hits = stOf(
      [
        'const SERVICE_SRC = join(__dirname, "..", "svc.service.ts");',
        "const src = readFileSync(SERVICE_SRC, \"utf8\");",
        "expect(src).not.toMatch(/forbidden/);",
      ].join("\n"),
    );
    assert(hits.length === 1, `应命中 1 处，实得 ${hits.length}`);
    assert(hits[0].polarity === "negative", "必须标记为 negative（永真门槛）");
  });

  ok("⑥c 【反证】读**非实现文件**（json/ts 数据）⇒ 不命中", () => {
    const hits = stOf(
      [
        'const DATA = join(__dirname, "..", "fixtures", "openapi.json");',
        'const data = readFileSync(DATA, "utf8");',
        "expect(data).toMatch(/x/);",
      ].join("\n"),
    );
    assert(hits.length === 0, `读 json 不该算源码文本断言，实得 ${hits.length}`);
  });

  ok("⑥d 【反证】读了实现源码但**未用于断言** ⇒ 不命中", () => {
    const hits = stOf(
      [
        'const SERVICE_SRC = join(__dirname, "..", "svc.service.ts");',
        'const src = readFileSync(SERVICE_SRC, "utf8");',
        "console.log(src.length);",
        "expect(1).toBe(1);",
      ].join("\n"),
    );
    assert(hits.length === 0, `未用于断言不该命中，实得 ${hits.length}`);
  });

  ok("⑥e 【反证】expect 的是普通数组、不是源码文本 ⇒ 不命中（防 322 条那种噪音）", () => {
    const hits = stOf(
      [
        "const props = declaredProps(PAGE_DTO, 'P');",
        "expect(props).toContain('f');",
        "expect(props).not.toContain('g');",
      ].join("\n"),
    );
    assert(hits.length === 0, `普通数组断言不该命中，实得 ${hits.length}`);
  });

  ok("⑥f 真实仓库：负向断言（永真门槛）必须被单列且非空（本仓实测 42 处）", () => {
    const r = check({ root: REPO_ROOT });
    const st = r.findings.filter((f) => f.form === "sourceTextAssertion");
    const neg = st.filter((f) => f.polarity === "negative");
    assert(st.length > 0, "本仓应扫到源码文本断言");
    assert(neg.length > 0, "本仓应存在负向断言（永真门槛）—— 若为 0 说明判据瞎了");
  });

  // 自检的临时目录统一清理（幂等；用例自己也会清各自的子路径）。
  try {
    rmSync(selfTestTmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  console.log(`\n✔ spec 耦合形式扫描自检通过（${n} 例）`);
}

const _invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (_invokedDirectly) main();
