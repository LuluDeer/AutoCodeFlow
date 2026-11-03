#!/usr/bin/env node
/**
 * DOC-STYLE：文档规范化守卫（结构面）。
 *
 * 为什么需要它：`docs/DOCS-STYLE.md` 写了规范，但**规范本身不会自动生效**——
 * 没有判据的规范等于愿望：三个月后又是 90 个文件没有「最后核对」标记、
 * 长文继续膨胀、空表格行继续堆积，而没人知道它们是「没做」还是「本来就这样」。
 * 本脚本把可机械判定的部分变成 CI 红灯。
 *
 * 判据（可用 --only=<name> 单独跑）：
 *   ① heading     —— 结构：单个 H1、H2/H3 层级不跳级、空表格行不留。
 *                     README 三语产物（README.md / README.en.md / README.zh.md）
 *                     **豁免**：它们是同一篇的双语切片，一个文件里出现两个
 *                     「语言区块标题」是刻意的（第二个 H1 是中文区块起点）。
 *   ② freshness   —— 面向使用者的文档必须带「最后核对 / 最后更新」日期标记，
 *                     且日期必须**到日**（`YYYY-MM-DD`）；`2026-09` 这种月粒度、
 *                     以及正文里顺口提到「最后核对」四个字，都不算声明。
 *                     豁免：自动生成物（CHANGELOG、release-please 桩）、
 *                     模板与规则文件（.github/**）、代码树内的局部 README。
 *                     扫描面 = USER_FACING 清单 + `docs/atlas/**`（目录级纳入：
 *                     131 篇逐模块文档用行内格式 `> 所属: … · 最后核对: 2026-11-01`，
 *                     逐个列进常量会让「新增页面就要改守卫」，与判据目的无关）。
 *   ③ fence-lang  —— 代码围栏必须标语言（bash/ts/json/yaml/text…）。
 *                     `text` 用于 ASCII 架构图；无法判定时用 `text` 而不是留空。
 *
 * 设计纪律（与本仓其它守卫一致）：
 *   · **结构红**：判据面本身消失（目录读不到 / 文件读不到）时判红，绝不
 *     退化成「零违规＝全绿」；
 *   · **豁免要显式**：每条豁免都写进 EXEMPT 常量并在注释里说明理由，
 *     不靠「跳过某目录」这种无痕口径；
 *   · 扫描面给下界（MIN_*）：扫到 0 个文件不等于事实都合规。
 *
 * 用法：node scripts/docs/check-doc-style.mjs [--only=heading|freshness|fence-lang] [--json]
 * 自检：node scripts/docs/check-doc-style.selftest.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");

/**
 * 不参与扫描的目录：依赖 / 产物 / 本地索引 / 第三方包 / 虚拟环境 / 工作草稿。
 *
 * `artifacts`（2026-11-03，R2-3a-2）：与 `check-docs.mjs` 的 `SKIP_DIR` **同源同理由**。
 * 该目录被 `.gitignore:234` 忽略 ⇒ CI 里不存在，只是本地 agent 轮次报告；
 * 但本守卫扫全仓 `*.md`，于是那些报告里的**证据贴片段**（抓来的命令输出 / 别的仓库源码）
 * 会被判「围栏未标语言」⇒ 每轮 agent 产出都把 `npm run test:docs` 打红，而 CI 是绿的。
 * 判据要管的是**仓库里的文档**，不是「我此刻磁盘上有什么」。
 * 排除后仍有 496 篇 ≥ `MIN_MD_FILES`(300)，扫描面下界不受影响。
 */
export const SKIP_DIR = new Set([
  "node_modules", ".git", ".codegraph", ".turbo", "dist", "coverage",
  ".vitepress", "dist-electron", "dist-selftest", "build", ".next",
  "test-results", "playwright-report", ".pytest_cache", ".cache",
  ".venv", "venv", "site-packages", ".zcode", ".workbuddy",
  "artifacts",
]);

/**
 * 扫描面下界：仓库里至少要有这么多篇 Markdown。
 * 低于下界说明扫描面本身塌了（读不到目录 / glob 写错）→ 结构红。
 */
export const MIN_MD_FILES = 300;

/** README 三语产物：结构豁免（H1 数量与围栏语言都不按单篇判）。 */
export const README_SLICES = new Set(["README.md", "README.en.md", "README.zh.md"]);

/**
 * 「面向使用者」的文档分层。判据 ②（freshness）只管这些。
 * 说明：内部流程文档（PLAN-CLAIMS / AGENT_HANDOFF / OPEN-DECISIONS）与
 * 归档区（docs/archive/）不要求日期标记——它们的「最后核对」由提交历史表达，
 * 硬塞日期反而会变成「为了绿而更新日期」的假动作。
 */
export const USER_FACING = [
  "docs/README.md",
  "docs/quickstart.md",
  "docs/deployment.md",
  "docs/operations.md",
  "docs/development.md",
  "docs/sdk-guide.md",
  "docs/api-reference.md",
  "docs/app-development-guide.md",
  "docs/UPGRADING.md",
  "docs/ROADMAP.md",
  "docs/release-checklist.md",
  "docs/rollback-semantics.md",
  "docs/DOCS-STYLE.md",
  "docs/observability/README.md",
  "docs/tutorials/index.md",
  "docs/tutorials/01-first-scheduled-task.md",
  "docs/tutorials/02-private-registry-deps.md",
  "docs/tutorials/03-multi-executor-scaling.md",
  "docs/tutorials/04-alerting-oncall.md",
  "docs/tutorials/05-sop-agent-demo.md",
  "docs/skills/README.md",
  "docs/skills/manifest-contract.md",
  "README.md",
  "README.en.md",
  "README.zh.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "SUPPORT.md",
  // 应用 / 部署 / 示例 README：都是「照着做就能跑」的用户入口
  "apps/admin-web/README.md",
  "apps/executor-desktop/README.md",
  "apps/registry-npm/README.md",
  "apps/registry-pypi/README.md",
  "deploy/README.md",
  "deploy/frp/README.md",
  "examples/README.md",
  "examples/callback-report/README.md",
  "examples/callback-report-node/README.md",
  "examples/desktop-automation/README.md",
  "examples/private-registry-deps/README.md",
  "examples/private-registry-deps-node/README.md",
];

/**
 * 判据 ② 的豁免：自动生成物 / 规则模板 / 包级 README。
 * 理由逐条写清（无痕豁免会让「规范」变成「看心情」）。
 */
export const FRESHNESS_EXEMPT = new Set([
  // 自动生成：release-please 写入，日期由它自己管
  "CHANGELOG.md",
  "packages/acf-cli/CHANGELOG.md",
  "packages/mcp-server/CHANGELOG.md",
  "packages/autocodeflow-node-sdk/CHANGELOG.md",
  "packages/autoflow-sdk/CHANGELOG.md",
  "packages/autocodeflow-ai/CHANGELOG.md",
  "packages/autocodeflow-db/CHANGELOG.md",
  "packages/autocodeflow-http/CHANGELOG.md",
  "packages/autocodeflow-notify/CHANGELOG.md",
  // 规则模板：Issue / PR 模板与守卫脚本的规格说明
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/cost-monitor.md",
  "scripts/check-release-hygiene.md",
  // 包级 README：内容随发布走（版本由 release-please 广播），单独维护日期会与
  // 包版本说明打架；它们由 docs/sdk-guide.md 与文档站统一对外。
  "packages/acf-cli/README.md",
  "packages/mcp-server/README.md",
  "packages/autocodeflow-node-sdk/README.md",
  "packages/autoflow-sdk/README.md",
  "packages/autocodeflow-ai/README.md",
  "packages/autocodeflow-db/README.md",
  "packages/autocodeflow-http/README.md",
  "packages/autocodeflow-notify/README.md",
  "packages/executor-protocol/README.md",
  "packages/contract-fixtures/README.md",
  "packages/docs-site/README.md",
  "packages/docs-site/index.md",
  "packages/docs-site/getting-started.md",
  "packages/docs-site/sdk-node.md",
  "packages/docs-site/sdk-python.md",
  "packages/docs-site/capability-matrix.md",
  "packages/docs-site/contract.md",
  "packages/docs-site/examples.md",
  "packages/docs-site/release.md",
  "packages/docs-site/tutorials.md",
  "packages/docs-site/tutorial-01-first-task.md",
  "packages/docs-site/tutorial-02-private-registry-deps.md",
  "packages/docs-site/tutorial-03-multi-executor-scaling.md",
  "packages/docs-site/tutorial-04-alerting-oncall.md",
  "packages/docs-site/tutorial-05-sop-agent-demo.md",
  // 内部流程 / 归档：见 USER_FACING 注释
  "docs/PLAN-CLAIMS.md",
  "docs/AGENT_HANDOFF.md",
  "docs/OPEN-DECISIONS.md",
  "docs/DEVELOPMENT-PLAN-2026-10.md",
  "docs/audit-playbook.md",
  "docs/feature-dev-workflow.md",
  "docs/AGENT-SWARM-PLAYBOOK.md",
  "docs/ARCH-MULTI-INSTANCE-MATRIX.md",
  "docs/ARCH-28b-turbo-adoption.md",
  "docs/arch-28-workspace-evaluation.md",
  "docs/autoapp-skill.md",
  "docs/VERIFY-MATRIX.md",
  "docs/SECURITY-REDLINE-CHECKLIST.md",
  "docs/DEPENDENCY-REVIEW-LOG.md",
  "docs/CAPACITY-WHITEPAPER.md",
  "docs/QA-05-capacity-boundaries.md",
  "docs/DB-LEAST-PRIVILEGE.md",
]);

/**
 * 判据 ①（H1）的豁免：这些文件**按设计**没有 H1，或 H1 不在预期位置。
 * 逐条给理由，避免「跳过某目录」式的无痕豁免。
 */
export const HEADING_EXEMPT = new Set([
  // GitHub Issue/PR 模板：正文由 GitHub 预填，没有独立标题（标题另填）
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/cost-monitor.md",
  // VitePress 首页：layout: home 由 frontmatter 驱动，没有 Markdown H1
  "packages/docs-site/index.md",
]);

/**
 * 目录级纳入新鲜度判据的前缀 + 扫描面下界。
 *
 * 为什么按目录而不是逐条列进 USER_FACING：`docs/atlas/` 有 131 篇逐模块 / 逐页面
 * 文档，新增一页就得回来改常量，而常量漏改的后果是「新页面永远不检查」——
 * 判据会悄悄变窄。按前缀纳入 + 给下界，才能既覆盖新增、又在目录被搬空时报红。
 */
export const ATLAS_PREFIX = "docs/atlas/";
export const MIN_ATLAS_FILES = 100;
export const FRESHNESS_DIR_PREFIX = [ATLAS_PREFIX];

/** 日期标记的正则：中文「最后核对 / 最后更新」，英文「Last checked / Last updated」。 */
const DATE_MARKER = /(最后(核对|更新)|Last (checked|updated))/i;

/**
 * **标记 + 完整日期**，两者必须贴在一起。
 *
 * 为什么不能只判「文件里出现过标记词」：实测 `docs/atlas/README.md` 的规则正文里
 * 就有一句「同步更新对应文档的"最后核对"日期」——按词判会把**提到规则**当成
 * **遵守规则**。为什么也不能只判「文件里出现过任意 YYYY-MM-DD」：`2026-09（P4）`
 * 这种月粒度声明旁边常有别的日期（`对应代码:`、正文举例），同样会假绿。
 *
 * 中间允许的字符只有 `*`、空白、冒号、`·`（覆盖 `**最后核对**：2026-11-02`
 * 与 `· 最后核对: 2026-11-01 ·` 两种写法）；出现括号或其它字词即断开，
 * 因为那说明日期属于另一个字段。
 */
const MARKER_WITH_DATE = /(?:最后(?:核对|更新)|Last\s+(?:checked|updated))[\s*:：·]{0,6}(20\d{2})-(\d{2})-(\d{2})/i;

/** 日历日校验：`2026-02-30` / `2026-13-01` 这类格式对、日期不存在的必须拦住。 */
function isRealCalendarDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * 逐行标记「这一行是否在代码围栏内」。
 *
 * 判据必须围栏感知：`docs/DOCS-STYLE.md` 自己的写法示范里就有一个 ```markdown 块，
 * 内容是 `> **最后核对**：2026-11-02`。若把围栏里的示例也当声明，那么
 * **一篇只有「示例日期」而没有真标记的文档会被洗绿**——示例是格式说明，不是声明。
 */
function fenceFlags(text) {
  const flags = [];
  let inFence = false;
  let fenceMarker = "";
  for (const line of text.split("\n")) {
    const run = /^(`{3,}|~{3,})/.exec(line.trimStart());
    if (run) {
      const marker = run[1];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker[0] === fenceMarker[0] && marker.length >= fenceMarker.length) {
        inFence = false;
        fenceMarker = "";
      }
      flags.push(true); // 围栏行本身不算声明
      continue;
    }
    flags.push(inFence);
  }
  return flags;
}

/**
 * 判定一篇文档的新鲜度声明。
 *
 * 返回 `{ ok: true, iso }` 或 `{ ok: false, kind, detail }`，kind ∈
 * `marker-missing`（连标记词都没有）/ `date-missing`（有标记词但日期没到日）/
 * `date-invalid`（不是合法日历日）/ `date-future`（日期在今天之后）。
 *
 * @param {string} text 文档全文
 * @param {string} todayIso 今天（YYYY-MM-DD），自检时注入固定值避免随日期漂移
 */
export function inspectFreshness(text, todayIso = new Date().toISOString().slice(0, 10)) {
  let firstInvalid = null;
  let firstFuture = null;
  let sawMarkerWord = false;
  const lines = text.split("\n");
  const fenced = fenceFlags(text);
  for (let i = 0; i < lines.length; i += 1) {
    if (fenced[i]) continue; // 围栏里的示例不是声明
    const line = lines[i];
    const m = MARKER_WITH_DATE.exec(line);
    if (!m) {
      if (!sawMarkerWord && DATE_MARKER.test(line)) sawMarkerWord = true;
      continue;
    }
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    if (!isRealCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]))) {
      firstInvalid ??= iso;
      continue;
    }
    if (iso > todayIso) {
      firstFuture ??= iso;
      continue;
    }
    return { ok: true, iso };
  }
  if (firstInvalid) return { ok: false, kind: "date-invalid", detail: firstInvalid };
  if (firstFuture) return { ok: false, kind: "date-future", detail: firstFuture };
  if (sawMarkerWord) {
    const idx = lines.findIndex((l, i) => !fenced[i] && DATE_MARKER.test(l));
    const line = idx >= 0 ? lines[idx] : "";
    return { ok: false, kind: "date-missing", detail: line.trim().slice(0, 100) };
  }
  return { ok: false, kind: "marker-missing" };
}

const norm = (p) => p.replace(/\\/g, "/");

/** 递归列出仓库内的 Markdown 文件（仓库相对路径）。 */
export function listMarkdown(root = REPO_ROOT) {
  const out = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIR.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith(".md")) out.push(norm(path.relative(root, abs)));
    }
  })(root);
  return out.sort();
}

/**
 * 逐行扫描 Markdown，产出结构事实。
 * 必须**围栏感知**：代码块里的 `# comment` 不是标题，
 * ``` 里的 `|` 也不是空表格行——不剥围栏会把两者都误判（实测 README 的
 * `env` 注释块里就有 5 行 `#`，会被当成 5 个 H1）。
 */
export function scanStructure(text) {
  const lines = text.split("\n");
  let inFence = false;
  // 围栏标记要记**完整反引号串**，不能只记 3 个：Markdown 允许用 4 个以上
  // 反引号包住内部的三反引号代码块（` ````markdown ` 里再写 ``` 是合法的）。
  // 只比前 3 个字符会把内层的 ``` 当成外层闭合（实测 TEMPLATE.md 就这样）。
  let fenceMarker = "";
  const headings = []; // { level, line }
  const fenceOpens = []; // { line, lang }
  const emptyTableRows = [];

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trimStart();
    const run = /^(`{3,}|~{3,})/.exec(trimmed);
    if (run) {
      const marker = run[1];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
        fenceOpens.push({ line: i + 1, lang: trimmed.slice(marker.length).trim() });
      } else if (marker[0] === fenceMarker[0] && marker.length >= fenceMarker.length) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+\S/.exec(raw);
    if (m) headings.push({ level: m[1].length, line: i + 1 });
    if (raw.trim() === "|") emptyTableRows.push(i + 1);
  }

  return { headings, fenceOpens, emptyTableRows };
}

/** 判据 ①：结构（单个 H1 / 层级不跳级 / 无空表格行）。 */
export function checkHeading(root = REPO_ROOT) {
  const errors = [];
  const files = listMarkdown(root);
  if (files.length < MIN_MD_FILES) {
    return [`扫描面塌了：只找到 ${files.length} 篇 Markdown（下界 ${MIN_MD_FILES}）——判据面消失，按结构红处理`];
  }
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    const { headings, emptyTableRows } = scanStructure(text);
    if (HEADING_EXEMPT.has(rel)) continue;
    const h1s = headings.filter((h) => h.level === 1);
    if (!README_SLICES.has(rel) && h1s.length > 1) {
      errors.push(
        `${rel}：有 ${h1s.length} 个 H1（第 ${h1s.map((h) => h.line).join(", ")} 行）——一篇文档只应有一个 H1`,
      );
    }
    if (!README_SLICES.has(rel) && h1s.length === 0) {
      errors.push(`${rel}：没有 H1——文档标题缺失`);
    }
    // 层级跳级：H1 → H3（跳过 H2）
    let prev = 0;
    for (const h of headings) {
      if (prev && h.level > prev + 1) {
        errors.push(`${rel}:${h.line}：标题层级从 H${prev} 跳到 H${h.level}（缺一级）`);
        break; // 每篇只报第一处跳级，避免刷屏
      }
      prev = h.level;
    }
    if (emptyTableRows.length > 0) {
      errors.push(
        `${rel}：${emptyTableRows.length} 行空表格行（行 ${emptyTableRows.slice(0, 5).join(", ")}）——表格不要留空 \`|\` 行`,
      );
    }
  }
  return errors;
}

/**
 * 判据 ②：面向使用者的文档必须带「最后核对 / 最后更新」日期标记，且日期到日。
 *
 * @param {string} root 仓库根
 * @param {string[]} userFacing 需要检查的文件清单（自检时注入小清单，
 *   避免用例被迫铺满整个 USER_FACING；生产调用用默认值）
 * @param {string[]} dirPrefixes 目录级纳入的前缀（默认 atlas）；自检传 `[]` 关掉，
 *   否则每个夹具都被要求再造 100 篇 atlas 文档
 */
export function checkFreshness(
  root = REPO_ROOT,
  userFacing = USER_FACING,
  dirPrefixes = FRESHNESS_DIR_PREFIX,
) {
  const errors = [];
  const files = listMarkdown(root);
  if (files.length < MIN_MD_FILES) {
    return [`扫描面塌了：只找到 ${files.length} 篇 Markdown（下界 ${MIN_MD_FILES}）——判据面消失，按结构红处理`];
  }
  const present = new Set(files);
  const today = new Date().toISOString().slice(0, 10);

  // 目录级纳入：先核扫描面。目录被改名/搬空时判红，而不是「没文件可查＝全绿」。
  const fromDirs = [];
  for (const prefix of dirPrefixes) {
    const hit = files.filter((f) => f.startsWith(prefix));
    if (hit.length < MIN_ATLAS_FILES) {
      errors.push(
        `扫描面塌了：${prefix} 下只找到 ${hit.length} 篇 Markdown（下界 ${MIN_ATLAS_FILES}）——目录级新鲜度判据失去对象，按结构红处理`,
      );
      continue;
    }
    fromDirs.push(...hit);
  }

  for (const rel of [...new Set([...userFacing, ...fromDirs])]) {
    if (!present.has(rel)) {
      errors.push(`USER_FACING 列出的 ${rel} 不存在——判据面消失（文件被删/改名），按结构红处理`);
      continue;
    }
    if (FRESHNESS_EXEMPT.has(rel)) continue;
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    const verdict = inspectFreshness(text, today);
    if (verdict.ok) continue;
    if (verdict.kind === "marker-missing") {
      errors.push(`${rel}：缺少「最后核对 / 最后更新」日期标记——面向使用者的文档必须能看出新鲜度`);
    } else if (verdict.kind === "date-missing") {
      errors.push(
        `${rel}：标记行没有到日的日期（当前：${verdict.detail}）——写 \`YYYY-MM-DD\`（如 2026-11-02）；月粒度 \`2026-09\` 不算`,
      );
    } else if (verdict.kind === "date-invalid") {
      errors.push(`${rel}：标记日期 ${verdict.detail} 不是合法日历日——不要为凑格式编日期`);
    } else {
      errors.push(`${rel}：标记日期 ${verdict.detail} 在未来（今天 ${today}）——核对日期不能超前`);
    }
  }
  return errors;
}

/**
 * 判据 ③ 的豁免前缀：归档区与 ADR。
 * 理由：归档文档是**历史证据**（审计记录、事故复盘、发布预检），规范要求
 * 「不随代码更新」——给它们补围栏语言等于改写证据原文；ADR 则是**决策记录**，
 * 同样按当时的面貌保留。它们只在**新增**时按规范写。
 */
export const FENCE_LANG_EXEMPT_PREFIX = ["docs/archive/"];

/** 判据 ③：代码围栏必须标语言。 */
export function checkFenceLang(root = REPO_ROOT) {
  const errors = [];
  const files = listMarkdown(root);
  if (files.length < MIN_MD_FILES) {
    return [`扫描面塌了：只找到 ${files.length} 篇 Markdown（下界 ${MIN_MD_FILES}）——判据面消失，按结构红处理`];
  }
  for (const rel of files) {
    if (README_SLICES.has(rel)) continue;
    if (FENCE_LANG_EXEMPT_PREFIX.some((p) => rel.startsWith(p))) continue;
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    const { fenceOpens } = scanStructure(text);
    const naked = fenceOpens.filter((f) => !f.lang);
    if (naked.length > 0) {
      errors.push(
        `${rel}：${naked.length} 处代码围栏未标语言（行 ${naked.slice(0, 5).map((f) => f.line).join(", ")}）——用 bash/ts/json/yaml；纯文本用 \`text\``,
      );
    }
  }
  return errors;
}

const CHECKS = {
  heading: { run: checkHeading, label: "结构（单 H1 / 层级 / 空表格行）" },
  freshness: { run: checkFreshness, label: "新鲜度标记" },
  "fence-lang": { run: checkFenceLang, label: "代码围栏语言" },
};

function main(argv) {
  const onlyArg = argv.find((a) => a.startsWith("--only="));
  const asJson = argv.includes("--json");
  // --path=<prefix>：只看某个目录/文件前缀下的文档。
  // 用途：并行 agent 各自只对自己那批文件负责时，能独立跑红/绿，
  // 不被别人的批次误报淹没（判据本体不变，只是过滤扫描面）。
  const pathArg = argv.find((a) => a.startsWith("--path="));
  const onlyPath = pathArg ? pathArg.slice("--path=".length) : null;
  const names = onlyArg ? onlyArg.slice("--only=".length).split(",") : Object.keys(CHECKS);
  let failed = 0;
  const report = {};
  for (const name of names) {
    const check = CHECKS[name];
    if (!check) {
      console.error(`未知判据：${name}（可选：${Object.keys(CHECKS).join(" / ")}）`);
      return 2;
    }
    let errors = check.run();
    if (onlyPath) {
      errors = errors.filter((e) => e.startsWith(onlyPath) || e.includes(` ${onlyPath}`));
    }
    report[name] = errors;
    if (errors.length) failed += 1;
    if (!asJson) {
      if (errors.length === 0) {
        console.log(`✔ ${check.label}检查通过`);
      } else {
        console.error(`✘ ${check.label}：${errors.length} 项`);
        errors.forEach((e) => console.error(`   · ${e}`));
      }
    }
  }
  if (asJson) console.log(JSON.stringify(report, null, 2));
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
