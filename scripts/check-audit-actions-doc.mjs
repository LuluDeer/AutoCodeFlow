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
 *   · `--selftest`：跑真脚本的子进程，12 条用例逐条断言退出码 + 关键文本（含上述假绿的反证）。
 *
 * ## T5：头部那两个手写数字也纳入判据（`共 N 个 action / M 个域`）
 *
 * 上述判据只管「代码里的 action ⊆ 表格」，**文档头部那句 `共 N 个 action / M 个域` 谁都不管**：
 * 2026-10-29 那轮手工把 68 改成 73，下次加 action 又漂——与 cli-doc / atlas-counts 同族的腐烂点
 * （数字是手写的，但它描述的对象由守卫维护，于是「有一半是机器事实、另一半是手抄」）。
 *
 * 现在：
 *   · **表格是事实源**：从 `## 谁在写审计` 的表格解析出「action 项总数」与「域（首列）行数」；
 *   · 头部那句必须与之**逐字对上**，不一致即红，文案点名「头部写 X / 表格实为 Y」（只报一个数
 *     等于让人自己去猜哪边错）；
 *   · **解析不到那句话也红**（结构红）：守的是「句子还在」——把句子改写成「本表覆盖 12 个域」、
 *     或者干脆删掉，数字照样漂，守卫却因为「没找到 = 没什么可比的」而变绿（永真）。
 *     所以缺句子 → 红，出现多次（不知道该信哪句）→ 也红。
 *   · 表格解析出 0 行 → 结构红（表格被删时 `0 == 0` 同样是永真）。
 *
 * 注意口径：头部数的是**表格里列出的** action，不是代码里实扫到的个数——两者本来就可能差几条：
 *   · 反向不校验，所以已下线的历史动作可以留在表里（见上文）；
 *   · 扫描盲区里的动作（透传 / 变量拼的 action）在表里、却扫不到（例如本仓 2026-10-29 的
 *     `executor.rotate_token`：它经 `auditHighRisk(action, …)` 透传进 `log()`，形如
 *     `auditHighRisk("executor.rotate_token", …)`，不匹配 `action: "…"`）。
 * 所以「代码里 N 个」不写进文档头部（那是新的手写事实，且本身就是少算的），它只出现在守卫的绿字里；
 * 文档头部从表格来，表格由「补文档」这件事维护。
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
export const ACTION_RE = /action:\s*"([A-Za-z0-9_]+\.[A-Za-z0-9_.]+)"/g;
/**
 * 头部那句计数：`共 **73** 个 action / **16** 个域`。
 * 粗体可选（去粗体是格式调整，不是漂移）；`/` 兼容全角 `／`；其余措辞**不放宽**——
 * 这正是判据要钉的形状，改写它就会红（见文件头 T5）。
 */
export const HEAD_COUNT_RE = /共\s*\*{0,2}(\d+)\*{0,2}\s*个\s*action\s*[／/]\s*\*{0,2}(\d+)\*{0,2}\s*个\s*域/g;
/** 清单表格的一行：`| \`域\` | \`a\` · \`b\` |`（首列必须带反引号；表头/分隔行由此天然排除）。 */
export const TABLE_ROW_RE = /^\|\s*`([^`]+)`\s*\|(.*)\|\s*$/;

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

/**
 * 解析清单表格：每行 `| \`域\` | \`a\` · \`b\` |`，返回 `{ rows, domains, actions }`。
 *
 * `rows` 保留每行的域与 action 列表（报错时能说清是哪个域），`actions` 是**项数之和**
 * （同一 action 在表里出现两次就算两次——重复本身是表格的错，不在本判据的职责内，
 * 但至少不会让头部数字「对得上」）。
 */
export function docTableCounts(section) {
  const rows = [];
  for (const line of section.split("\n")) {
    const m = TABLE_ROW_RE.exec(line);
    if (m === null) continue;
    if (m[1] === "域") continue; // 表头（`| 域 | action |`）本身没反引号，双保险
    const actions = (m[2].match(/`[^`]+`/g) ?? []).map((s) => s.slice(1, -1));
    rows.push({ domain: m[1], actions });
  }
  return {
    rows,
    domains: rows.length,
    actions: rows.reduce((n, r) => n + r.actions.length, 0),
  };
}

/**
 * 找头部那句计数，返回 `[{ actions, domains, index, line }]`。
 *
 * 一个都不返回 = 句子被改写/删除；返回多个 = 文档里有两句「共 N 个 action / M 个域」，
 * 不知道该信哪句。两种都是结构红（调用方判断），不是「没有可比的东西就算了」。
 */
export function docHeadCounts(doc) {
  const hits = [];
  HEAD_COUNT_RE.lastIndex = 0;
  let m;
  while ((m = HEAD_COUNT_RE.exec(doc)) !== null) {
    hits.push({
      actions: Number(m[1]),
      domains: Number(m[2]),
      index: m.index,
      line: doc.slice(0, m.index).split("\n").length,
    });
  }
  return hits;
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
 * 判据本体。返回 `{ errors, problems, headerProblems, found, counts }`：
 *   · errors         = 结构性（扫描面塌了 / 事实源读不到 / 解析出 0 条）——「判据本身不可信」；
 *   · problems       = 文档漂移（代码里存在、清单里没有）；
 *   · headerProblems = 头部那句计数与表格不符（表格是事实源）。
 * 命中面**只算 `## 谁在写审计` 一节的表格**（T4 修掉的假绿，见文件头）。
 */
export function check({ root = process.cwd() } = {}) {
  const errors = [];
  const problems = [];
  const headerProblems = [];
  const found = new Map(); // action -> ["<file>:<line>", …]
  const counts = {
    files: 0,
    actions: 0,
    sectionChars: 0,
    root,
    tableActions: 0,
    tableDomains: 0,
    headActions: null,
    headDomains: null,
    headLine: null,
  };

  // ① 文档与其清单小节
  let section = null;
  let table = null;
  let head = null;
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

      // ①-a 表格 = 事实源
      table = docTableCounts(section);
      counts.tableActions = table.actions;
      counts.tableDomains = table.domains;
      if (table.domains === 0 || table.actions === 0) {
        errors.push(
          `「${DOC_SECTION}」小节里解析出 ${table.domains} 行、${table.actions} 项清单表格 —— ` +
            "表被删掉或换了形状（首列应是带反引号的域），判据已瞎（不是「表格没问题」）。",
        );
      }

      // ①-b 头部那句手写计数
      const hits = docHeadCounts(doc);
      if (hits.length === 0) {
        errors.push(
          "头部找不到「共 N 个 action / M 个域」这句计数（被改写或删掉了？）—— " +
            "句子不在，头部数字就没人核对；当前表格是 " +
            table.actions +
            " 个 action / " +
            table.domains +
            " 个域，请把头部恢复成「共 **" +
            table.actions +
            "** 个 action / **" +
            table.domains +
            "** 个域」，不要改守卫。",
        );
      } else if (hits.length > 1) {
        errors.push(
          `「共 N 个 action / M 个域」在文档里出现 ${hits.length} 次（第 ` +
            hits.map((h) => h.line).join("、") +
            " 行）—— 不知道该信哪句；只保留一处（与表格一致的那句）。",
        );
      } else {
        head = hits[0];
        counts.headActions = head.actions;
        counts.headDomains = head.domains;
        counts.headLine = head.line;
      }
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

  if (errors.length > 0) return { errors, problems, headerProblems, found, counts };

  // ③ 清单比对（只在生成表小节内算命中）
  const missing = [...found.keys()].filter((a) => !section.includes("`" + a + "`")).sort();
  for (const a of missing) {
    problems.push({ action: a, at: found.get(a).slice(0, 3) });
  }

  // ④ 头部计数 vs 表格（表格是事实源；两边各自算，绝不拿代码个数顶替）
  if (head !== null && table !== null) {
    if (head.actions !== table.actions || head.domains !== table.domains) {
      headerProblems.push({
        headActions: head.actions,
        headDomains: head.domains,
        tableActions: table.actions,
        tableDomains: table.domains,
        line: head.line,
      });
    }
  }
  return { errors, problems, headerProblems, found, counts };
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
  head = null,
  headLine = null,
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
  files[DOC_REL] = auditDoc({ omit, header, prose, head, headLine });
  Object.assign(files, extra);
  for (const d of drop) delete files[d];
  return files;
}

/**
 * audit.md 的最小形态：`## 谁在写审计` 里的表格 + 后面的散文小节。
 *
 * 头部那句计数的**默认值来自渲染出来的表格**（而不是 ACTIONS.length）——否则 `omit`
 * 用例会顺带把头部也弄红，测的就不是它本来要测的东西了。
 *   · `head`     ：故意写错的数（`{ actions, domains }`），用来反证头部判据；
 *   · `headLine` ：整句替换，用来模拟「句子被改写/删除」。
 */
function auditDoc({
  omit = [],
  header = DOC_SECTION + "（**由代码生成，勿手改**）",
  prose = [],
  head = null,
  headLine = null,
} = {}) {
  const rendered = DOMAINS.map((d) => ({
    domain: d,
    actions: ACTIONS.filter((a) => a.startsWith(d + ".") && !omit.includes(a)),
  }));
  const rows = rendered.map(
    (r) => "| `" + r.domain + "` | " + r.actions.map((a) => "`" + a + "`").join(" · ") + " |",
  );
  const tableActions = rendered.reduce((n, r) => n + r.actions.length, 0);
  const sentence =
    headLine ??
    `共 **${head?.actions ?? tableActions}** 个 action / **${head?.domains ?? DOMAINS.length}** 个域。`;
  return [
    "# audit 模块 — 审计日志",
    "",
    "## 职责",
    "",
    "平台级操作留痕。",
    "",
    header,
    "",
    sentence,
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
 * 自检：12 条用例，全部 `spawn` 真脚本（`--root` 指向 fixture 树）。
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

  // ⑩ 2026-10-29：旧正则 `[a-z0-9_]+\.[a-z0-9_.]+` 只认小写，`task.killExecution` 这类
  // camelCase action **从来没被扫到过**——代码在写审计、文档没记、守卫却一路绿。实仓当时
  // 漏了 5 个（task.analyzeExecution / killExecution / rollbackToVersion / updateGlue /
  // subscription.deadLetter.delete）。这条用例把「识别 camelCase」钉住。
  subprocess(
    "⑩ 【反证·camelCase】代码里的 camelCase action 也必须被识别（旧正则只认小写）",
    auditTree({
      extra: {
        [`${SRC_REL}/modules/task/camel-probe.ts`]:
          'export const probe = { action: "task.killExecution" };\n',
      },
    }),
    { code: 1, contains: ["task.killExecution"], absent: ["清单一致"] },
  );

  // ⑪ T5：头部手写计数。表格 60 行项 / 12 域，头部故意写成 99 / 7（两个数都错），
  // 报错**必须同时点名四个数**（头部写什么 / 表格实为多少）——只报一个数等于让人自己猜。
  subprocess(
    "⑪ 【反证·头部计数】头部写 99 个 action / 7 个域（表格实为 60 / 12）→ 红并点名两值",
    auditTree({ head: { actions: 99, domains: 7 } }),
    {
      code: 1,
      contains: [
        "头部计数与表格不一致",
        "头部写 99 个 action / 7 个域",
        "表格实为 60 个 action / 12 个域",
      ],
      absent: ["清单一致", "漂移"],
    },
  );

  // ⑫ T5：句子形状被绕开。这里是**改写**（数字还写对了 60/12，但句式不再匹配）；
  // 「整句删掉」走的是同一条 `hits.length === 0` 分支，所以这条同时钉住两种绕法。
  // 老实现（没有这条判据）在两种情况下都是绿的：没人找句子 = 没人比对。
  subprocess(
    "⑫ 【反证·句子被改写】「共 N 个 action / M 个域」这句话被换掉 → 结构红（不是绿）",
    auditTree({ headLine: "本表共 60 条动作、覆盖 12 个域。" }),
    {
      code: 1,
      contains: ["结构错误", "头部找不到「共 N 个 action / M 个域」", "表格是 60 个 action / 12 个域"],
      absent: ["清单一致"],
    },
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
    const { errors, problems, headerProblems, counts } = check({ root });

    if (errors.length > 0) {
      console.error("");
      console.error("✖ 审计动作守卫结构错误（判据本身不可信）：");
      for (const e of errors) console.error("  · " + e);
      console.error("");
      process.exit(1);
    }

    if (headerProblems.length > 0) {
      console.error("");
      console.error("✖ 审计文档头部计数与表格不一致（表格是事实源）：");
      for (const hp of headerProblems) {
        console.error(
          "  头部写 " +
            hp.headActions +
            " 个 action / " +
            hp.headDomains +
            " 个域，表格实为 " +
            hp.tableActions +
            " 个 action / " +
            hp.tableDomains +
            " 个域（头部在第 " +
            hp.line +
            " 行）",
        );
      }
      console.error("");
      console.error("  修法：把 audit.md 里那句「共 N 个 action / M 个域」改成上表实有的项数/域数。");
      console.error("  **不要**为了对齐头部去删表格行，也不要改守卫来放行。");
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
        counts.files + " 个文件）；头部计数与表格一致（" + counts.tableActions + " 个 action / " +
        counts.tableDomains + " 个域）。",
    );
  }
}
