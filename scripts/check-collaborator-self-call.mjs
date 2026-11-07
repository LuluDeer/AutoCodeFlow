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
 * ## 仓库根从哪来（`--root`）
 *
 * 扫描面 `apps/` + `packages/` 是**仓库相对**的，所以「根」是本守卫唯一的输入口径：
 *
 *   · 不传 `--root` ⇒ 根 = 本脚本所在树的上一级（`<repo>/scripts/` → `<repo>`），
 *     **与引入 `--root` 之前逐字节等价**（也不读 `process.cwd()`：从子目录误跑
 *     不会扫空目录 ⇒ 不会假绿）；
 *   · `--root <dir>` / `--root=<dir>` 两种形态都认 ⇒ 根换成 `<dir>`，这给
 *     **selftest 夹具**用（在临时目录造一个假仓库，绝不碰真仓库）；
 *   · `--root` 缺值 / 空值 / 指向不存在的目录 ⇒ **exit 2**（用法错误）。
 *     **不许静默回落到真仓库**——「以为在跑夹具、实际跑的是真仓库」是最坏的假绿；
 *   · `--selftest` 与 `--root` **互斥** ⇒ exit 2：自检的对照组就是真仓库。
 *
 * 结构红（不是判据）：`--root` 的树里一个 `*.collaborator.ts` 都扫不到 ⇒ exit 1
 * ——「0 个文件、0 处违规」不等于判据通过（`walk()` 会吞 ENOENT）。
 *
 * 只读、不写盘。`check({ repoRoot })` 照旧导出，供自检/其它脚本传夹具根。
 *
 * ## 用法
 *   node scripts/check-collaborator-self-call.mjs            # 判据
 *   node scripts/check-collaborator-self-call.mjs --root <dir>   # 以 <dir> 为仓库根
 *   node scripts/check-collaborator-self-call.mjs --root=<dir>   # 同上（等号形态）
 *   node scripts/check-collaborator-self-call.mjs --report   # 人读清单
 *   node scripts/check-collaborator-self-call.mjs --selftest # 自检（真仓库对照组 + 黑盒夹具）
 *
 * ## 自检覆盖了什么 / 没覆盖什么（R148 补黑盒夹具后如实登记）
 *
 * **覆盖**：`--selftest` 现在有 **15** 条用例（R148 前是 9），其中 **6** 条是**黑盒 CLI 夹具**
 * （`runGuard(SELF, ["--root=<mkdtemp 夹具>"]`，spawn 真脚本、断言退出码 + 报错文本）：
 *   · 合规夹具（apps/ + packages/ **两个前缀各一个**协作者，其中一个有 private self-call）⇒ 0；
 *   · 违规夹具（夹具里一个 public 方法直调自身）⇒ 1，且点名 `文件:行` + `this.<方法>()`；
 *   · ALLOW 带理由 ⇒ 0（豁免在 CLI 面上也生效）；ALLOW 无理由 ⇒ 1；
 *   · **扫到 0 个协作者 ⇒ 结构红 1**（R147 新增的那条判据；此前**只在真仓库上跑过**，
 *     没有任何东西证明「0 个文件 ⇒ 0 处违规 ⇒ 绿」这个退化形态真的会红）；
 *   · `--root` 指向没有 apps/ 与 packages/ 的树 ⇒ 结构红 1；指向不存在的目录 ⇒ 2。
 *
 * **没覆盖**（盲区，别把这里读成「拦得住一切」）：
 *   · 判据仍是**正则启发式**——多行声明、装饰器、箭头属性方法、`this["x"]()` 这类形态
 *     夹具与真仓库都验不到（`findSelfCalls` 的已知边界，见 `extractSelfCallTargets` 注释）；
 *   · 夹具的 class 形状是**本自检手写的最小样本**，不是从真实协作者生成的 ⇒ 「真源码里
 *     第 3 种写法」这类问题只能靠真仓库主跑（`check()`）兜底，夹具不代劳；
 *   · **`--root` 与 `--selftest` 互斥 ⇒ exit 2** 这条 CLI 判据没有专门的夹具用例
 *     （它测的是参数解析、不需要仓库树；`--selftest` 自身分支里已隐式经过 `parseRoot`）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, runGuard } from "./lib/guard-selftest.mjs";

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

  // ── ⑨–⑭ 黑盒 CLI 夹具（R148）──────────────────────────────────────────
  //
  // 上面 ①–⑧ 测的是**函数**；这一段测的是**守卫**：spawn 真脚本、只给 `--root=<夹具>`，
  // 断言退出码 + 报错文本。夹具建在 `os.tmpdir()` 的 `mkdtemp` 下（`makeFixtureRepo`），
  // 用完即删 —— **绝不往仓库写任何文件**。
  //
  // 为什么必须是 CLI 而不是直调 `check()`：`--root` 的解析、退出码映射、
  // 「扫到 0 个 ⇒ 结构红」这三处**只在入口存在**。直调 `check({repoRoot})` 时它们
  // 全都被绕过 —— 那正是 R147 之前的状态（判据有牙，入口没牙）。
  const SELF = fileURLToPath(import.meta.url);

  /** 一个合规的协作者：public `record()` 走注入依赖，private `helper()` 可被直调。 */
  const GOOD_COLLAB = [
    "export class AuditCollaborator {",
    "  async record(): Promise<void> {",
    "    await this.deps.repo.save();",
    "    this.helper();",
    "  }",
    "",
    "  private helper(): void {}",
    "}",
    "",
  ].join("\n");

  /** 违规协作者：public `record()` **直调自身**的 public `persist()`。 */
  const BAD_COLLAB = [
    "export class AuditCollaborator {",
    "  async record(): Promise<void> {",
    "    await this.persist();",
    "  }",
    "",
    "  async persist(): Promise<void> {}",
    "}",
    "",
  ].join("\n");

  ok("⑨ CLI `--root=<合规夹具>` ⇒ 0（apps/ 与 packages/ **两个前缀都扫到**）", () => {
    const repo = makeFixtureRepo(
      {
        "apps/x/audit.collaborator.ts": GOOD_COLLAB,
        "packages/y/infra.collaborator.ts":
          "export class InfraCollaborator {\n  async a(): Promise<void> {}\n}\n",
      },
      { prefix: "collab-good-" },
    );
    try {
      expectExit(runGuard(SELF, { args: [`--root=${repo.dir}`] }), {
        code: 0,
        contains: ["扫 2 个 *.collaborator.ts", "未豁免 self-call 0 处"],
        absent: ["守卫失败"],
        label: "CLI --root=<合规夹具>",
      });
    } finally {
      repo.cleanup();
    }
  });

  ok("⑩ CLI `--root=<违规夹具>` ⇒ 1，且点名 `文件:行` 与 `this.<方法>()`", () => {
    const repo = makeFixtureRepo(
      { "apps/x/audit.collaborator.ts": BAD_COLLAB },
      { prefix: "collab-bad-" },
    );
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1,
        contains: [
          "协作者 self-call 守卫失败（1 项）",
          "apps/x/audit.collaborator.ts:3",
          "this.persist()",
          "实现级断言会静默失效",
        ],
        label: "CLI --root=<违规夹具>",
      });
    } finally {
      repo.cleanup();
    }
  });

  ok("⑪ CLI `--root=<带 ALLOW 理由的夹具>` ⇒ 0；无理由 ⇒ 1（豁免必须可证）", () => {
    const withReason = [
      "export class AuditCollaborator {",
      "  async record(): Promise<void> {",
      "    // ALLOW: 该调用是纯计算，外部没有任何 spy 依赖",
      "    await this.persist();",
      "  }",
      "",
      "  async persist(): Promise<void> {}",
      "}",
      "",
    ].join("\n");
    const bare = [
      "export class AuditCollaborator {",
      "  async record(): Promise<void> {",
      "    // ALLOW:",
      "    await this.persist();",
      "  }",
      "",
      "  async persist(): Promise<void> {}",
      "}",
      "",
    ].join("\n");

    const okRepo = makeFixtureRepo(
      { "apps/x/audit.collaborator.ts": withReason },
      { prefix: "collab-allow-" },
    );
    try {
      expectExit(runGuard(SELF, { args: [`--root=${okRepo.dir}`] }), {
        code: 0,
        contains: ["未豁免 self-call 0 处"],
        label: "CLI 夹具：ALLOW 带理由",
      });
    } finally {
      okRepo.cleanup();
    }

    const bareRepo = makeFixtureRepo(
      { "apps/x/audit.collaborator.ts": bare },
      { prefix: "collab-allow-bare-" },
    );
    try {
      expectExit(runGuard(SELF, { args: [`--root=${bareRepo.dir}`] }), {
        code: 1,
        contains: ["守卫失败（1 项）", "this.persist()"],
        label: "CLI 夹具：ALLOW 无理由",
      });
    } finally {
      bareRepo.cleanup();
    }
  });

  ok("⑫ CLI `--root=<有 apps/ 但 0 个协作者>` ⇒ **结构红 1**（扫描面塌陷）", () => {
    // R147 补的那条判据：`walk()` 吞 ENOENT ⇒ 「0 个文件、0 处违规」会被当成绿。
    // 这条夹具是它**唯一**的机械证据。
    const repo = makeFixtureRepo(
      { "apps/x/README.md": "不是协作者文件\n" },
      { prefix: "collab-empty-" },
    );
    try {
      expectExit(runGuard(SELF, { args: [`--root=${repo.dir}`] }), {
        code: 1,
        contains: ["结构红", "扫到 0 个 *" + ".collaborator.ts", "扫描面塌陷"],
        absent: ["未豁免 self-call 0 处"],
        label: "CLI 夹具：0 个协作者",
      });
    } finally {
      repo.cleanup();
    }
  });

  ok("⑬ CLI `--root=<既无 apps/ 也无 packages/>` ⇒ 结构红 1（拿不到扫描面就不许判绿）", () => {
    const repo = makeFixtureRepo(
      { "docs/note.md": "这棵树不是本仓形状\n" },
      { prefix: "collab-noroots-" },
    );
    try {
      expectExit(runGuard(SELF, { args: [`--root=${repo.dir}`] }), {
        code: 1,
        contains: ["结构红", "没有扫描面", "apps/ 与 packages/"],
        label: "CLI 夹具：缺扫描根",
      });
    } finally {
      repo.cleanup();
    }
  });

  ok("⑭ CLI `--root=<不存在的目录>` ⇒ 2（用法错误，不静默回落到真仓库）", () => {
    expectExit(
      runGuard(SELF, { args: [`--root=${join(REPO_ROOT, "不存在的夹具-" + process.pid)}`] }),
      { code: 2, contains: ["用法错误", "指向的目录不存在"], label: "CLI --root=<不存在>" },
    );
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

/** 用法错误退出码（与「判据红 = 1」分开，口径同 `check-mcp-error-hints.mjs`）。 */
const EXIT_USAGE = 2;

/**
 * 解析仓库根（`--root <dir>` / `--root=<dir>`，两种形态都认）。
 *
 * `--root` 缺值即抛（入口报 exit 2）：把末尾裸写的 `--root` 当成 `.` 会让根落到
 * `process.cwd()` —— 那句「以为在跑夹具」会直接掉进真仓库。
 */
function parseRoot(argv_, { selftest: selftestMode = false } = {}) {
  let root = REPO_ROOT;
  let explicit = false;
  for (let i = 0; i < argv_.length; i += 1) {
    const a = argv_[i];
    if (a === "--root" || a.startsWith("--root=")) {
      const v = a === "--root" ? argv_[++i] : a.slice("--root=".length);
      if (!v || v.startsWith("--")) {
        throw new Error("`--root` 需要一个目录参数（`--root <dir>` 或 `--root=<dir>`）");
      }
      root = resolve(v);
      explicit = true;
    }
  }
  if (!explicit) return REPO_ROOT;
  if (selftestMode) {
    // 自检的对照组**就是真仓库**（用例 ⑦ 在真协作者源码上注入、⑧ 复核真仓库全绿），
    // 换根会让对照组失去意义 ⇒ 显式互斥，比「静默忽略 --root」诚实。
    throw new Error(
      "`--selftest` 与 `--root` 互斥：自检的对照组就是**真仓库**（真协作者源码）",
    );
  }
  return root;
}

if (!IS_MAIN) {
  // imported as a module — 不执行副作用
} else if (argv.includes("--selftest")) {
  // 自检的对照组**就是真仓库本身**（用例 ⑦/⑧ 在真源码上注入/复核）⇒
  // `--selftest` 与 `--root` 显式互斥（exit 2），不静默忽略一个用户明确给的参数。
  try {
    parseRoot(argv, { selftest: true });
  } catch (err) {
    console.error(`✘ 用法错误：${err.message}`);
    process.exit(EXIT_USAGE);
  }
  selftest();
} else {
  let repoRoot;
  try {
    repoRoot = parseRoot(argv);
  } catch (err) {
    console.error(`✘ 用法错误：${err.message}`);
    process.exit(EXIT_USAGE);
  }
  if (!existsSync(repoRoot)) {
    console.error(`✘ 用法错误：\`--root\` 指向的目录不存在：${repoRoot}`);
    process.exit(EXIT_USAGE);
  }
  // 结构自证（不是判据）：`walk()` 会吞掉 ENOENT，根指到「像仓库但不是」的树
  // （或指到一棵没有协作者的树）时，扫描面会塌陷成「扫 0 个 ⇒ 0 失败 ⇒ 绿」——
  // 那正是 `--root` 最危险的假绿。真仓库必有协作者文件，这条对主跑无影响。
  // 与 `check-agent-stub-fidelity.mjs` 的「扫描面塌陷 ⇒ 结构红」同口径。
  const absentScanRoots = SCAN_ROOTS.filter((rel) => !existsSync(join(repoRoot, rel)));
  if (absentScanRoots.length === SCAN_ROOTS.length) {
    console.error(
      `\n✘ 结构红：\`--root\` 指向的树没有扫描面（缺 ${SCAN_ROOTS.map((r) => `${r}/`).join(" 与 ")}）` +
        `—— 扫不到协作者文件就没有资格判绿（--root 指错了树？）`,
    );
    process.exit(1);
  }
  const result = check({ repoRoot });
  if (result.scanned.length === 0) {
    console.error(
      `\n✘ 结构红：在 ${repoRoot} 下扫到 0 个 *${COLLABORATOR_SUFFIX}（扫描面塌陷）` +
        `—— 「0 个文件、0 处违规」不等于判据通过（--root 指错了树？）`,
    );
    process.exit(1);
  }
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
