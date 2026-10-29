#!/usr/bin/env node
/**
 * 审计动作清单与文档的一致性守卫。
 *
 * 背景：`docs/atlas/01-apps/admin-api/modules/audit.md` 的「谁在写审计」一节，长期是**手写清单**——
 * 于是它自然地落后于代码：SOP 加了 10 个动作、订阅/项目/成员各加了几个，文档里一个字都没有，
 * 头部还写着「task 模块（下一批次）」（实际早已落地 16 个）。
 *
 * 这类文档的危害不是「不准确」，而是**看起来像权威清单**：读的人会以为「审计只覆盖这几个域」。
 * 所以不修文档，而是把清单改成**由代码生成 + 守卫**：
 *
 *   ① 从 apps/admin-api/src 下所有 .ts（跳过 .spec.ts）里抽 `action: "<域>.<动作>"` 字面量；
 *   ② 每个抽到的 action 必须出现在 audit.md 的「谁在写审计」一节里；缺一个就失败并列出缺的；
 *   ③ **反向不校验**：文档可以保留历史动作（迁移/下线后仍值得记录），这不是漂移。
 *
 * ## 已知盲区（**必须知道**）
 *
 * 判据是「源码里出现 `action: "<域>.<动作>"` 字面量」。所以**动态拼出来的 action 对本守卫隐形**：
 * 例如 `action: isCreate ? "config.create" : "config.update"` —— 两个动作确实在写，但一条也扫不到，
 * 文档表里也不会有它们，而守卫照样绿。
 *
 * 这类隐形在 R83 落地时真实发生过（config 的 create/update 起初就是三元拼的，守卫只看到 delete）。
 * 处置：**审计调用处一律写 action 字面量**；需要分支就分成两个调用（复用同一份 detail 构造），
 * 不要用三元/变量拼。透传包装（如 application.service 的 `action: payload.action`）不受影响，
 * 因为它的**调用点**是字面量，守卫扫的是那些点。
 *
 * 为什么不做成「动态即报错」：`action: query.action` 这类**读取/查询**用法的形状与写入完全相同，
 * 静态区分不了，硬判会产出大量假红。
 *
 * ## T4（第 4 轮守卫自检审计）修掉的假绿 / 假红
 *
 *   · **假绿·文档里任何位置出现即算**：旧实现 `doc.includes("`" + a + "`")` 在整篇 audit.md 里
 *     找子串——而同一篇文档的散文里就散落着 `` `auth.login` ``、`` `apikey.create` ``（「常见改动场景」
 *     小节）。于是**表格行被删掉、散文里还留着**时，守卫照样绿：清单不再是清单，只是「这个词在
 *     文档里出现过」。现在只在 `## 谁在写审计` 小节的**生成表**里算命中（三处 68 条实测均在该节内，
 *     主跑不变）。
 *   · **假红·代码注释里的字面量也算「谁在写审计」**：旧实现按行正则，行注释（`// action: "sop.draft"`）
 *     与块注释（`slash-star action: "x.y" star-slash`）里的字面量都会被当成真实写入点——于是文档被迫
 *     记录一个**并不发生**的动作，而「补文档」这个动作又把假红固化进文档。现在先剥注释（字符串感知，不碰字面量本身）再匹配。
 *   · **扫描面下界只有「0 个文件」**：旧实现 `files.length === 0` 一条。`src` 下的子树改名/
 *     大面积排除时文件数仍在，而 `_RE` 又只匹配双引号；现在三条下界（文件数 / 动作数）+
 *     目录、文件读不到即**结构红**。
 *   · **崩溃 ≠ 红灯**：文档/目录读不到时旧实现是 `readFileSync` 抛栈（`Error: ENOENT`），
 *     与「判据算出来不一致」混在同一个退出通道里。现在结构错误单独成形、单独文案。
 *   · `--root`：模块级 `process.cwd()` 收成参数，`import` 时不实扫、不 `process.exit`。
 *   · `--selftest`：跑真脚本的子进程，9 条用例逐条断言退出码 + 关键文本（含上述假绿的反证）。
 *
 * 用法：`node scripts/check-audit-actions-doc.mjs [--selftest] [--root <dir>]`
 *   --selftest：在临时 fixture 树里跑真脚本（事实源需要仓库根布局：apps/admin-api/src + docs/atlas）。
 *   --root    ：只给 selftest 用：把 fixture 树当仓库根（默认 process.cwd()）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

export const SRC_REL = join("apps", "admin-api", "src").split(sep).join("/");
export const DOC_REL = join("docs", "atlas", "01-apps", "admin-api", "modules", "audit.md")
  .split(sep)
  .join("/");
/** 清单所在的二级标题；只有这一节里的表格算「被文档收录」。 */
export const DOC_SECTION = "## 谁在写审计";
/** action 字面量：`<域>.<动作>`，允许动作段再带点（如 sop.timeout.unclaimed）。 */
export const ACTION_RE = /action:\s*"([a-z0-9_]+\.[a-z0-9_.]+)"/g;

/**
 * 扫描面下界。
 *   · MIN_SCANNED_FILES：src 子树被改名/整块排除时，文件数会塌到个位数，而动作数下界
 *     也可能被残留文件撑住（2026-10-29 实测：511 个 .ts / 68 个 action）；
 *   · MIN_EXPECTED_ACTIONS：正则一旦失效（例如格式化改成单引号），`found` 为 0，
 *     而「0 条 → 0 条缺失」是**永真断言**，守卫会静默变绿。宁可红。
 */
export const MIN_SCANNED_FILES = 50;
export const MIN_EXPECTED_ACTIONS = 50;

/**
 * 剥掉 JS/TS 注释（`//` 与 `/* … *​/`），保留换行与列位置（注释字符替换成空格）。
 *
 * 为什么要它：`action: "x.y"` 出现在注释里时，旧实现会把它当成**真实写入点**，于是
 * 文档被迫收录一个并不存在的动作（假红），而「补文档」又把这个假红固化下来。
 *
 * 字符串是**不透明**的：状态机跟踪 `'` / `"` / `` ` `` 与反斜杠转义，所以字符串里的
 * `//`（如 URL）不会被误当注释——方向必须保证「少剥」（误剥会导致假红，但不至于假绿）。
 */
export function stripComments(src) {
  let out = "";
  let state = "code";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : "";
    if (state === "code") {
      if (c === "/" && d === "/") {
        state = "line";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === "/" && d === "*") {
        state = "block";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === '"') state = "dquote";
      else if (c === "'") state = "squote";
      else if (c === "`") state = "template";
      out += c;
      i += 1;
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      } else {
        out += c === "\t" ? "\t" : " ";
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && d === "/") {
        state = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    // 字符串内：转义整对跳过；遇同种引号收尾。
    if (c === "\\") {
      out += c + d;
      i += 2;
      continue;
    }
    if (
      (state === "dquote" && c === '"') ||
      (state === "squote" && c === "'") ||
      (state === "template" && c === "`")
    ) {
      state = "code";
    } else if ((state === "squote" || state === "dquote") && c === "\n") {
      // 未闭合的引号（例如代码里的撇号）：容错回 code，避免把余下整文件当字符串吞掉。
      state = "code";
    }
    out += c;
    i += 1;
  }
  return out;
}

function readText(abs) {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

const relOf = (root, abs) => relative(root, abs).split(sep).join("/");

/**
 * 取 `DOC_SECTION` 那一节（到下一个同级/更高标题为止）。
 * 找不到标题返回 null —— 由调用方报结构红，而不是「整篇文档里都找不到 → 全缺」。
 */
export function docSection(doc, heading = DOC_SECTION) {
  const at = doc.indexOf(heading);
  if (at < 0) return null;
  const rest = doc.slice(at + heading.length);
  const end = rest.search(/\n#{1,2} /);
  return end < 0 ? rest : rest.slice(0, end);
}

function walk(dir, root, errors) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    errors.push(`读不到目录 ${relOf(root, dir)}（${error.code ?? error.message}）—— 扫描面不完整，判据不可信。`);
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, root, errors));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) out.push(p);
  }
  return out;
}

/**
 * 判据本体。返回 `{ errors, problems, found, counts }`：
 *   · errors   = 结构性（扫描面塌了 / 事实源读不到 / 解析出 0 条）——「判据本身不可信」；
 *   · problems = 文档漂移（代码里存在、清单里没有）。
 * 命中面**只算 `## 谁在写审计` 一节的表格**（T4 修掉的假绿，见文件头）。
 */
export function check({ root = process.cwd() } = {}) {
  const errors = [];
  const problems = [];
  const found = new Map(); // action -> ["<file>:<line>", …]
  const counts = { files: 0, actions: 0, sectionChars: 0, root };

  // ① 文档与其清单小节
  let section = null;
  const doc = readText(join(root, DOC_REL));
  if (doc === null) {
    errors.push(`读不到 ${DOC_REL} —— 文档路径/文件名变了，本判据已经瞎了（不是「文档没问题」）。`);
  } else {
    section = docSection(doc);
    if (section === null) {
      errors.push(
        `找不到「${DOC_SECTION}」小节（标题被改名或删掉了）—— 清单无从核对；请恢复标题，不要改守卫。`,
      );
    } else {
      counts.sectionChars = section.length;
    }
  }

  // ② 源码扫描
  const srcDir = join(root, SRC_REL);
  if (!existsSync(srcDir)) {
    errors.push(`读不到目录 ${SRC_REL} —— 路径变了，扫描面为 0（不是「动作变少了」）。`);
  } else {
    const files = walk(srcDir, root, errors);
    counts.files = files.length;
    if (files.length === 0) {
      errors.push(`扫不到任何 .ts 文件：${SRC_REL} —— 目录改名或全被排除了？`);
    } else if (files.length < MIN_SCANNED_FILES) {
      errors.push(
        `只扫到 ${files.length} 个 .ts 文件（下界 ${MIN_SCANNED_FILES}）—— 扫描面塌了，不是源码变少了。`,
      );
    }
    for (const f of files) {
      const src = readText(f);
      const rel = relOf(root, f);
      if (src === null) {
        errors.push(`读不到 ${rel} —— 扫描面不完整，缺文件的清单不可信。`);
        continue;
      }
      // 先剥注释：注释里的 `action: "x.y"` 不是「谁在写审计」。
      const lines = stripComments(src).split("\n");
      lines.forEach((line, i) => {
        if (!line.includes("action:")) return;
        ACTION_RE.lastIndex = 0;
        let m;
        while ((m = ACTION_RE.exec(line)) !== null) {
          const a = m[1];
          if (!found.has(a)) found.set(a, []);
          found.get(a).push(rel + ":" + (i + 1));
        }
      });
    }
    counts.actions = found.size;
    if (found.size < MIN_EXPECTED_ACTIONS) {
      errors.push(
        "只解析出 " + found.size + " 个 action（下界 " + MIN_EXPECTED_ACTIONS +
          "）—— 扫描器失效了，不是动作变少了。",
      );
    }
  }

  if (errors.length > 0) return { errors, problems, found, counts };

  // ③ 清单比对（只在生成表小节内算命中）
  const missing = [...found.keys()].filter((a) => !section.includes("`" + a + "`")).sort();
  for (const a of missing) {
    problems.push({ action: a, at: found.get(a).slice(0, 3) });
  }
  return { errors, problems, found, counts };
}

// ── 自检（T4：全部跑真脚本子进程）─────────────────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

// fixture 事实源：12 个域 × 5 个动作 = 60 条（过 MIN_EXPECTED_ACTIONS=50），
// 一条一个文件（60 个 .ts，过 MIN_SCANNED_FILES=50）。
const DOMAINS = [
  "alpha", "beta", "gamma", "delta", "epsilon", "zeta",
  "eta", "theta", "iota", "kappa", "lambda", "mu",
];
const PER_DOMAIN = 5;
const ACTIONS = DOMAINS.flatMap((d) => Array.from({ length: PER_DOMAIN }, (_, i) => `${d}.${i}`));

const writer = (action, quote = '"') =>
  [
    'import type { AuditService } from "../audit/audit.service";',
    "",
    "export async function write(svc: AuditService, resourceId: number) {",
    `  return svc.log({ action: ${quote}${action}${quote}, resource: "thing", resourceId });`,
    "}",
    "",
  ].join("\n");

/** 60 个写入点 + 一个不该被扫的 .spec.ts（里面有个清单里没有的动作）。 */
function auditTree({
  quote = '"',
  omit = [],
  header = DOC_SECTION + "（**由代码生成，勿手改**）",
  prose = [],
  extra = {},
  noSrc = false,
  drop = [],
} = {}) {
  const files = {};
  if (!noSrc) {
    for (const a of ACTIONS) {
      const [domain] = a.split(".");
      const i = a.split(".")[1];
      files[`${SRC_REL}/modules/${domain}/writer-${i}.ts`] = writer(a, quote);
    }
    files[`${SRC_REL}/modules/alpha/writer-0.spec.ts`] = writer("spec.only");
  }
  files[DOC_REL] = auditDoc({ omit, header, prose });
  Object.assign(files, extra);
  for (const d of drop) delete files[d];
  return files;
}

/** audit.md 的最小形态：`## 谁在写审计` 里的表格 + 后面的散文小节。 */
function auditDoc({ omit = [], header = DOC_SECTION + "（**由代码生成，勿手改**）", prose = [] } = {}) {
  const rows = DOMAINS.map(
    (d) =>
      "| `" +
      d +
      "` | " +
      ACTIONS.filter((a) => a.startsWith(d + ".") && !omit.includes(a))
        .map((a) => "`" + a + "`")
        .join(" · ") +
      " |",
  );
  return [
    "# audit 模块 — 审计日志",
    "",
    "## 职责",
    "",
    "平台级操作留痕。",
    "",
    header,
    "",
    `共 **${ACTIONS.length}** 个 action / **${DOMAINS.length}** 个域。`,
    "",
    "| 域 | action |",
    "|---|---|",
    ...rows,
    "",
    "补充约定：",
    "",
    '- `result: "failure"` 用于鉴权失败类事件。',
    "",
    "## 与其他模块的关系",
    "",
    "- **被广泛依赖（被依赖方）**：各 controller/service 注入 `AuditService`。",
    ...prose,
    "",
  ].join("\n");
}

/**
 * 自检：9 条用例，全部 `spawn` 真脚本（`--root` 指向 fixture 树）。
 *
 * 旧版**没有 selftest**（判据是模块级 IIFE，`import` 就实扫真仓库），所以两处
 * 假绿（整篇文档命中即算 / 注释里的字面量算写入点）都没有被任何东西钉住。
 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "audit-actions-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
            ...expect,
            withinMs: 1000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  subprocess("① 干净树：60 个 action 全在清单表内、.spec.ts 不扫 → 绿", auditTree(), {
    code: 0,
    contains: [
      "审计动作清单一致：代码里 60 个 action 全部在 audit.md 中出现（扫了 60 个文件）",
    ],
    absent: ["漂移", "结构错误", "spec.only"],
  });

  subprocess(
    "② 清单漏一个动作（代码 beta.3 / 表格删掉）→ 红，点名动作与写入点",
    auditTree({ omit: ["beta.3"] }),
    {
      code: 1,
      contains: ["审计动作清单漂移：1 个 action", "beta.3", "writer-3.ts:"],
      absent: ["清单一致"],
    },
  );

  // ③ 修掉的假绿：旧实现 `doc.includes("`"+a+"`")` 会在**整篇**文档里找子串
  subprocess(
    "③ 【反证·整篇命中】动作只在散文里出现、表格里没有 → 红（不是子串命中）",
    auditTree({ omit: ["gamma.2"], prose: ["- （历史）`gamma.2` 曾用于灰度发布，现已下线。"] }),
    { code: 1, contains: ["审计动作清单漂移：1 个 action", "gamma.2"], absent: ["清单一致"] },
  );

  // ④ 假红修正：注释里的字面量不是「谁在写审计」，不该被要求进文档
  subprocess(
    "④ 【反证·注释】只有注释/块注释里出现的动作不算写入点 → 不算漂移",
    auditTree({
      extra: {
        [`${SRC_REL}/modules/delta/legacy.ts`]:
          '// 旧写法：svc.log({ action: "delta.9" })\n/* action: "delta.8" —— 已下线 */\nexport const legacy = 1;\n',
      },
    }),
    { code: 0, contains: ["代码里 60 个 action"], absent: ["漂移", "delta.9", "delta.8"] },
  );

  // ⑤ 解析失败：全部改成单引号 → 0 命中，必须是结构红而不是「0 条缺失 = 绿」
  subprocess("⑤ 【反证·解析失败】字面量全改单引号（正则失效）→ 结构红", auditTree({ quote: "'" }), {
    code: 1,
    contains: ["结构错误", "只解析出 0 个 action", `下界 ${MIN_EXPECTED_ACTIONS}`, "扫描器失效"],
    absent: ["清单一致"],
  });

  // ⑥ 扫描面下界：文件数塌了（子树改名/大面积排除），动作数下界也保不住
  subprocess(
    "⑥ 【反证·扫描面】只扫到 3 个 .ts 文件 → 结构红",
    auditTree({
      drop: ACTIONS.slice(3).map((a) => `${SRC_REL}/modules/${a.split(".")[0]}/writer-${a.split(".")[1]}.ts`),
    }),
    { code: 1, contains: ["结构错误", "只扫到 3 个 .ts 文件", `下界 ${MIN_SCANNED_FILES}`], absent: ["清单一致"] },
  );

  subprocess(
    "⑦ 【反证·事实源】src 目录整个不见了 → 结构红（不是崩栈、更不是绿）",
    auditTree({ noSrc: true }),
    { code: 1, contains: ["结构错误", `读不到目录 ${SRC_REL}`], absent: ["清单一致", "Error:", "ENOENT"] },
  );

  subprocess("⑧ 文档缺失（audit.md 被删）→ 结构红且点名路径", auditTree({ drop: [DOC_REL] }), {
    code: 1,
    contains: ["结构错误", `读不到 ${DOC_REL}`],
    absent: ["清单一致", "Error:", "ENOENT"],
  });

  subprocess(
    "⑨ 清单小节标题被改名 → 结构红，而不是「全缺」",
    auditTree({ header: "## 审计写入方（改名了）" }),
    { code: 1, contains: ["结构错误", `找不到「${DOC_SECTION}」小节`], absent: ["清单一致"] },
  );

  const failed = reportCases(cases, { title: "check-audit-actions-doc selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    const root = resolve(argValue(process.argv, "--root") ?? process.cwd());
    const { errors, problems, counts } = check({ root });

    if (errors.length > 0) {
      console.error("");
      console.error("✖ 审计动作守卫结构错误（判据本身不可信）：");
      for (const e of errors) console.error("  · " + e);
      console.error("");
      process.exit(1);
    }

    if (problems.length > 0) {
      console.error("");
      console.error(
        "✖ 审计动作清单漂移：" + problems.length + " 个 action 在代码里存在、文档里没有（共扫到 " +
          counts.actions + " 个）",
      );
      for (const p of problems) {
        console.error("  " + p.action + "  ← " + p.at.join(", "));
      }
      console.error("");
      console.error("  修法：把代码里新增的 action 手工补进");
      console.error("  docs/atlas/01-apps/admin-api/modules/audit.md 的「谁在写审计」表格");
      console.error("  （本仓没有生成器，那张表是手工维护的）。**不要**改守卫来放行。");
      process.exit(1);
    }

    console.log(
      "✔ 审计动作清单一致：代码里 " + counts.actions + " 个 action 全部在 audit.md 中出现（扫了 " +
        counts.files + " 个文件）。",
    );
  }
}
