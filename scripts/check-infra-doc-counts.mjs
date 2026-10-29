#!/usr/bin/env node
/**
 * DOC-GUARD：`docs/atlas/06-infra/deployment-and-ci.md` 的**四个自述数字** +
 * `docs/deployment.md` 的**常驻服务数**（第 5 项） vs 代码事实。
 *
 * ## 为什么需要它（DT-04 的原样复现）
 *
 * 第 3 轮 docs-truth 审计的 DT-04 发现：这篇文档的 5 个数字**全错**
 * （workflow 5→10、job 37→38、`deploy.sh` 129→1963 行、迁移 25→119），
 * 而 `check-docs` / `check-atlas-counts` / `check-cli-doc` / `check-api-reference`
 * **四道守卫全绿**。审计 agent 的反证很干净：把数字**全部改回旧值**，四道守卫依旧绿。
 *
 * 原因不是守卫写坏了，而是**没有一道守卫看这篇文档的数字**：
 *   · `check-docs` 只管链接/结构/死亡锚点；
 *   · `check-atlas-counts` 管的是 `01-apps/admin-api/README.md` 与 `atlas/README.md`；
 *   · `check-cli-doc` / `check-api-reference` 管的是 CLI 命令表与 REST 端点附录。
 * 于是「CI 有几个 job」「deploy.sh 多长」这类**手写数字**单向腐烂，且完全静默——
 * 文档读起来像权威事实，实际停在几周前。
 *
 * ## 事实源（四个，缺一即红；全部零依赖、无 DB/网络）
 *
 *   · workflow 数：`ls .github/workflows/*.yml`（`.yaml` 同算）；
 *   · job 数：`.github/workflows/ci.yml` 的**顶层 `jobs:` 块的直接子键**。
 *     刻意不用 `^  [a-z-]+:` 之类的粗匹配——`steps:` 也是两空格缩进？不，`steps:` 是
 *     **四**空格；但粗匹配会把任何两空格缩进的东西都算进去，一旦有人把 job 内键缩进
 *     改成两空格（或 YAML 被格式化），job 数立刻虚高且**没有症状**。这里的实现是
 *     「先定位顶格 `jobs:` 行，再只收恰好两空格缩进、形如 `key:` 且带冒号结尾的行，
 *     遇到下一个顶格键即出块」，块内的 `steps:` / `runs-on:`（四空格）天然不计入；
 *   · `deploy.sh` 行数：与 `wc -l` 同口径（数 `\n`，不因「末行没换行」少算一行）；
 *   · 迁移数：`ls apps/admin-api/src/migrations/*.ts | grep -v spec`
 *     （= 目录下 `.ts` 且排除 `*.spec.ts` / `*.d.ts`；与 `check-atlas-counts.mjs`
 *     和 `01-apps/admin-api/README.md` 用的是同一口径，实测 122）。
 *
 * ## 判据（每一条都有齿）
 *
 *   A. **定点抽取**：文档里 5 处断言点各有专属正则（见 `CLAIMS`）：
 *        ① 头注「.github/workflows/（共 N 个：…）」
 *        ② 「## Workflow 文件总览（.github/workflows/，N 个）」
 *        ③ ci.yml 表格行「N 个 job 的全量质量门禁」
 *        ④ CI 面板「共 **N 个 job**」
 *        ⑤ 「（deploy.sh，N 行）」
 *        ⑥ 「空库全链 N 个迁移」
 *      每处**必须命中**；命中即逐数字与事实源比对。报错给 `文档行 + 文档值 + 实际值 + 修法`。
 *   B. **解析不到 = 红**（本守卫的核心，不是副产品）：把「共 10 个」改写成「十个」、
 *      把「38 个 job」改成「三十八个 job」、或整句重写，正则失配 → **红**，并指名是哪一处
 *      断言点、锚点在哪一行。这条防的是「守卫瞎掉」：只做「有数字就比、没数字就跳过」的
 *      守卫，会被人**改写句子**绕过——文档看起来更新了，判据其实一条都没跑。
 *   C. **自失效 = 红**：事实源缺失（`ci.yml` / `deploy.sh` / 迁移目录 / 文档被挪走）、
 *      或规模低于下界（扫描面失效 → 零发现 → 假绿）都直接红，且**不把缺失当 0 放过**。
 *
 * ## 第 5 项：`docs/deployment.md` 的「N 个服务里 M 个在 profile 下；K 个常驻服务」
 *
 * 同一张病理：这行数字（以及 `06-infra/README.md` 那句「8 个常驻服务」）是**手写的**，
 * 而事实由根 `docker-compose.yml` 决定。改回旧值（把 8 写成 9）时全仓守卫曾经全绿。
 *
 * ## 为什么不引 YAML 解析器（`yaml.safe_load` 那条路的替代）
 *
 * 本脚本是**零依赖** Node 脚本（CI 只保证 node，没有 PyYAML / js-yaml 也不该为此加依赖）；
 * 且 compose 的 override 文件用了 `!override` / `!reset` 这类**非标准标签**（见
 * `docker-compose.demo.yml` / `docker-compose.ha.yml`），把文本丢给严格 YAML 解析器会直接抛
 * `could not determine a constructor for the tag`。所以这里选**正则 + 缩进状态机**：
 *   · 只认顶格 `services:` 块内**恰好两空格**缩进的服务名（`steps:` 式的四空格子键天然不计）；
 *   · 每个服务块内的 `profiles:`（行内 `['a']` 或块状 `- a`）决定它是否「非常驻」；
 *   · 任何 YAML 标签（`!override` / `!reset`）都只是普通文本，不参与结构判断 —— 换个说法：
 *     解析器**故意**看不见标签，它只看缩进与键名。
 * 代价（如实记）：不认识锚点/合并键（`<<: *default`）这类写法；本仓 compose 未使用，
 * 若将来引入，`parseComposeServices` 会多数/少数服务，但**不会静默**——数字对不上就红。
 *
 * ## 刻意不做的事
 *
 *   · 不改写文档措辞来迁就正则。若某处只是**说法变了**（例如「共 10 个」→「合计 10 个」），
 *     先放宽 `CLAIMS` 的正则面（多认几种写法）；只有确属**事实错误**才改文档数字。
 *   · 不校验表中 workflow 名单与文件名的逐项一致（那是另一族判据，见 `check-docs` 的
 *     死链面）；本守卫只钉四个数字。
 *
 * 用法：
 *   node scripts/check-infra-doc-counts.mjs               # 守卫（exit 0 / 1）
 *   node scripts/check-infra-doc-counts.mjs --selftest    # 验证判据本身（22 条用例）
 *   node scripts/check-infra-doc-counts.mjs --root <dir>  # 只给 selftest 用：在任意临时树上跑
 *   node scripts/check-infra-doc-counts.mjs --root=<dir>  # 同上（等号形态，两种都认）
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

const SELF = import.meta.filename;
const DEFAULT_ROOT = resolve(import.meta.dirname, "..");

const DOC_REL = "docs/atlas/06-infra/deployment-and-ci.md";
const WORKFLOWS_DIR = ".github/workflows";
const CI_REL = ".github/workflows/ci.yml";
const DEPLOY_REL = "deploy.sh";
const MIGRATIONS_DIR = "apps/admin-api/src/migrations";
/** 第 5 项：常驻服务数的两个来源（`deployment.md` 的三元组 + atlas 那句「K 个常驻服务」）。 */
const DEPLOY_DOC_REL = "docs/deployment.md";
const INFRA_DOC_REL = "docs/atlas/06-infra/README.md";
const COMPOSE_REL = "docker-compose.yml";

/**
 * 规模下界：事实源被改名/拆分/清空时，「解析成功但集合为空」会让守卫零发现而全绿
 * ——本仓反复出现的假绿形态（`check-guards-wired.mjs` 的 `guards.length < 20`、
 * `check-metric-docs.mjs` 的 FLOORS 都是同一个教训）。真实规模见各条注释。
 */
const FLOORS = {
  workflows: 5, // 实测 10
  jobs: 10, // 实测 38
  deployLines: 100, // 实测 1963
  migrations: 50, // 实测 122
  composeServices: 5, // 实测 21（根 docker-compose.yml）
  composeProfiled: 2, // 实测 13（带 profiles: 的服务）
  composeResident: 3, // 实测 8（不带 profiles: 的「常驻」服务）
};

// ── 事实源解析 ──────────────────────────────────────────────────────────────

/**
 * 取 `jobs:` 块的**直接子键**（两空格缩进的 `key:`）。
 *
 * 为什么不用 `^ {2}[a-z-]+:` 全文件扫：那样 `steps:` 一旦缩进成两空格、或有人在
 * 顶层写两空格缩进的其他结构，都会被当成 job；虚高的 job 数**没有任何症状**
 * （守卫只会说「文档 38、实际 39」，而人看到多出来的 `steps` 才知道是解析器错）。
 * 这里显式进出块：找顶格 `jobs:` → 只认恰好两空格 + 键 + 冒号（可带注释）→
 * 遇到下一个顶格键（`permissions:` / `concurrency:` / …）结束。
 */
export function parseJobs(ciYml) {
  const lines = ciYml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*(?:#.*)?$/.test(l));
  if (start < 0) {
    return { ok: false, reason: "找不到顶格的 `jobs:` 行（YAML 顶层结构被改写了？）" };
  }
  const names = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // 下一个顶层键 → jobs 块结束
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    // 恰好两空格缩进 = job 名；四空格的 steps/runs-on 等不会被匹配。
    const m = line.match(
      /^ {2}(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+)):[ \t]*(?:#.*)?$/,
    );
    if (m) names.push(m[1] ?? m[2] ?? m[3]);
  }
  return { ok: true, names };
}

/**
 * 取根 `docker-compose.yml` 的 `services:` 块里的**服务名 + profiles**。
 *
 * 为什么不用 YAML 解析器：见文件头「为什么不引 YAML 解析器」——零依赖，且 override 文件里的
 * `!override` / `!reset` 标签会让严格解析器抛错。这里只做两件事：
 *   · 顶格 `services:` 块内**恰好两空格**缩进、形如 `key:` 的行 = 一个服务；
 *   · 该服务块内任意缩进的 `profiles:` = 「非常驻」（行内 `['a','b']` 或块状 `- a` 都认）。
 * 遇到下一个顶格键（`volumes:` / `networks:`）即出块；`#` 注释整行跳过。
 */
export function parseComposeServices(composeYml) {
  const lines = composeYml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^services:\s*(?:#.*)?$/.test(l));
  if (start < 0) {
    return { ok: false, reason: "找不到顶格的 `services:` 行（YAML 顶层结构被改写了？）" };
  }
  const services = [];
  let cur = null;
  let pendingList = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // 下一个顶层键 → services 块结束
    if (line.trim() === "" || /^\s*#/.test(line)) continue;

    // 恰好两空格缩进 = 服务名（四空格的 image/ports/… 天然不计）。
    const svc = line.match(/^ {2}(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+)):[ \t]*(?:#.*)?$/);
    if (svc) {
      cur = { name: svc[1] ?? svc[2] ?? svc[3], profiles: [] };
      services.push(cur);
      pendingList = false;
      continue;
    }
    if (!cur) continue;

    // `profiles: ['a', 'b']`（行内）或 `profiles:` + 后续 `- a`（块状）。
    const prof = line.match(/^ {4,}profiles:[ \t]*(.*?)[ \t]*(?:#.*)?$/);
    if (prof) {
      const rest = prof[1] ?? "";
      cur.profiles = [...rest.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
      pendingList = rest === "";
      continue;
    }
    if (pendingList) {
      const item = line.match(/^\s*-\s*['"]?([A-Za-z0-9_.-]+)['"]?[ \t]*$/);
      if (item) {
        cur.profiles.push(item[1]);
        continue;
      }
      pendingList = false;
    }
  }
  return { ok: true, services };
}

function collectFacts(root) {
  const facts = {};
  const problems = [];

  // ① workflow 文件数（`ls .github/workflows/*.yml`，`.yaml` 同算）
  const wfDir = join(root, WORKFLOWS_DIR);
  if (!existsSync(wfDir)) {
    problems.push(
      `✖ 事实源缺失：${WORKFLOWS_DIR} 目录不存在 —— 被挪动/改名了？\n` +
        "  修法：恢复目录，或同步改 scripts/check-infra-doc-counts.mjs 的 WORKFLOWS_DIR。",
    );
    facts.workflows = null;
  } else {
    const files = readdirSync(wfDir)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort();
    facts.workflows = files.length;
    facts.workflowFiles = files;
    if (files.length < FLOORS.workflows) {
      problems.push(
        `✖ 规模下界：${WORKFLOWS_DIR} 只扫到 ${files.length} 个 workflow（下界 ${FLOORS.workflows}）。\n` +
          "  修法：这是「扫描面失效」的信号（目录换了/后缀变了），别把下界调低来换取绿。",
      );
    }
  }

  // ② ci.yml 的 job 数
  const ciPath = join(root, CI_REL);
  if (!existsSync(ciPath)) {
    problems.push(
      `✖ 事实源缺失：缺少 ${CI_REL} —— job 数无法核对。\n` +
        "  修法：恢复该文件；**不要**把「读不到」当作 0 或跳过（那正是假绿的入口）。",
    );
    facts.jobs = null;
  } else {
    const parsed = parseJobs(readFileSync(ciPath, "utf8"));
    if (!parsed.ok) {
      problems.push(
        `✖ 事实源解析失败：${CI_REL}: ${parsed.reason}\n` +
          "  修法：确认顶层 `jobs:` 仍是顶格键；本守卫不做 YAML 解析，只认这一种结构。",
      );
      facts.jobs = null;
    } else {
      facts.jobs = parsed.names.length;
      facts.jobNames = parsed.names;
      if (parsed.names.length < FLOORS.jobs) {
        problems.push(
          `✖ 规模下界：${CI_REL} 的 jobs: 块只解析到 ${parsed.names.length} 个 job（下界 ${FLOORS.jobs}）。\n` +
            "  修法：解析器可能只看到了部分键（缩进变了？），先修解析面再谈文档数字。",
        );
      }
    }
  }

  // ③ deploy.sh 行数（`wc -l` 口径：数换行符）
  const deployPath = join(root, DEPLOY_REL);
  if (!existsSync(deployPath)) {
    problems.push(
      `✖ 事实源缺失：缺少 ${DEPLOY_REL}。\n` +
        "  修法：恢复脚本；若部署脚本已改名，同步改脚本里的 DEPLOY_REL 与文档。",
    );
    facts.deployLines = null;
  } else {
    const text = readFileSync(deployPath, "utf8");
    // `wc -l` 数的是换行符个数；末行没换行时它少算一行，本守卫刻意与它同口径。
    facts.deployLines = (text.match(/\n/g) ?? []).length;
    if (facts.deployLines < FLOORS.deployLines) {
      problems.push(
        `✖ 规模下界：${DEPLOY_REL} 只数到 ${facts.deployLines} 行（下界 ${FLOORS.deployLines}）—— 读到的不是真脚本？`,
      );
    }
  }

  // ④ 迁移数（目录下 `.ts`，排除 *.spec.ts / *.d.ts）
  const migDir = join(root, MIGRATIONS_DIR);
  if (!existsSync(migDir)) {
    problems.push(
      `✖ 事实源缺失：${MIGRATIONS_DIR} 目录不存在。\n` +
        "  修法：恢复目录，或同步改脚本里的 MIGRATIONS_DIR。",
    );
    facts.migrations = null;
  } else {
    const files = readdirSync(migDir, { withFileTypes: true })
      .filter(
        (e) =>
          e.isFile() &&
          e.name.endsWith(".ts") &&
          !e.name.endsWith(".spec.ts") &&
          !e.name.endsWith(".d.ts"),
      )
      .map((e) => e.name)
      .sort();
    facts.migrations = files.length;
    if (files.length < FLOORS.migrations) {
      problems.push(
        `✖ 规模下界：${MIGRATIONS_DIR} 只扫到 ${files.length} 个迁移（下界 ${FLOORS.migrations}）。\n` +
          "  修法：先确认目录/后缀没变；下界只许跟着真实规模上调。",
      );
    }
  }

  // ⑤ 根 compose 的服务总数 / profile 服务数 / 常驻服务数
  const composePath = join(root, COMPOSE_REL);
  facts.composeServices = null;
  facts.composeProfiled = null;
  facts.composeResident = null;
  if (!existsSync(composePath)) {
    problems.push(
      `✖ 事实源缺失：缺少 ${COMPOSE_REL} —— 常驻服务数无法核对。\n` +
        "  修法：恢复该文件；**不要**把「读不到」当作 0 或跳过。",
    );
  } else {
    const parsed = parseComposeServices(readFileSync(composePath, "utf8"));
    if (!parsed.ok) {
      problems.push(
        `✖ 事实源解析失败：${COMPOSE_REL}: ${parsed.reason}\n` +
          "  修法：确认顶层 `services:` 仍是顶格键；本守卫不做 YAML 解析，只认这一种结构。",
      );
    } else {
      facts.composeServices = parsed.services.length;
      facts.composeProfiled = parsed.services.filter((s) => s.profiles.length > 0).length;
      facts.composeResident = parsed.services.filter((s) => s.profiles.length === 0).length;
      for (const [key, floor] of [
        ["composeServices", FLOORS.composeServices],
        ["composeProfiled", FLOORS.composeProfiled],
        ["composeResident", FLOORS.composeResident],
      ]) {
        if (facts[key] < floor) {
          problems.push(
            `✖ 规模下界：${COMPOSE_REL} 的 ${key} 只解析到 ${facts[key]}（下界 ${floor}）——` +
              "解析器可能只看到了部分服务（缩进变了？），先修解析面再谈文档数字。",
          );
        }
      }
    }
  }

  return { facts, problems };
}

// ── 文档断言点（定点正则，每处都必须命中）──────────────────────────────────

/**
 * `sites` 里每一项都是**一处断言点**：必须至少命中一次，且命中到的每个数字都要等于
 * 事实值。`hint` 用于报错时的修法提示（告诉人该保留什么措辞）。
 *
 * 放宽正则的原则：**宁可多认几种写法**（全角/半角逗号、粗体星号、空格、反引号、
 * 「TypeORM」前缀有无、`**` 粗体包裹），但绝不把「必须命中」降级成「命中才比」。
 */
export const CLAIMS = [
  {
    fact: "workflows",
    label: "workflow 文件数",
    factHint: "`ls .github/workflows/*.yml` 实测",
    sites: [
      {
        desc: "文件头注「.github/workflows/（共 N 个：…）」",
        anchor: ".github/workflows",
        hint: "「.github/workflows/（共 N 个：…）」",
        re: /\.github\/workflows\/?[^\n（(]{0,20}?[（(]\s*(?:共|合计|共计)\s*\*{0,2}\s*(\d+)\s*\*{0,2}\s*个/,
      },
      {
        desc: "小节标题「## Workflow 文件总览（.github/workflows/，N 个）」",
        anchor: "Workflow 文件总览",
        hint: "「（.github/workflows/，N 个）」",
        re: /^#{2,4}\s*Workflow 文件总览[^\n]*?[（(][^\n]{0,40}?(\d+)\s*个/m,
      },
    ],
  },
  {
    fact: "jobs",
    label: "ci.yml job 数",
    factHint: "ci.yml 的 `jobs:` 块直接子键计数",
    sites: [
      {
        desc: "ci.yml 表格行「N 个 job 的全量质量门禁」",
        anchor: "| `ci.yml` |",
        hint: "「N 个 job 的全量质量门禁」",
        re: /ci\.yml`?[^\n]*?(\d+)\s*个\s*job/i,
      },
      {
        desc: "CI 面板「共 **N 个 job**」",
        anchor: "个 job**",
        hint: "「共 **N 个 job**」",
        re: /共\s*\*{0,2}\s*(\d+)\s*\*{0,2}\s*个\s*job/i,
      },
    ],
  },
  {
    fact: "deployLines",
    label: "deploy.sh 行数",
    factHint: "`wc -l deploy.sh` 实测",
    sites: [
      {
        desc: "小节标题「（deploy.sh，N 行）」",
        anchor: "deploy.sh，",
        hint: "「（deploy.sh，N 行）」",
        re: /deploy\.sh`?\s*(?:[，,:：]\s*|共\s*)?(\d+)\s*行/,
      },
    ],
  },
  {
    fact: "migrations",
    label: "TypeORM 迁移数",
    factHint: "`ls apps/admin-api/src/migrations/*.ts | grep -v spec` 实测",
    sites: [
      {
        desc: "「空库全链 N 个迁移」",
        anchor: "个迁移",
        hint: "「N 个迁移」",
        re: /(\d+)\s*个\s*(?:TypeORM\s*)?迁移/,
      },
    ],
  },
];

/**
 * 第 5 项：根 compose 的三元组（总数 / profile 下 / 常驻）在文档里的断言点。
 *
 * 与 `CLAIMS` 的差别只有一处：**每处断言点自带文档**（`deployment.md` 的三元组，
 * 以及 `06-infra/README.md` 那句「K 个常驻服务」——同一事实的第二个手抄副本）。
 * 其余纪律完全一致：定点匹配、解析不到即红、每个命中都要等于事实值。
 */
export const SERVICE_CLAIMS = [
  {
    doc: DEPLOY_DOC_REL,
    fact: "composeServices",
    label: "compose 服务总数",
    factHint: `${COMPOSE_REL} 的 \`services:\` 直接子键计数`,
    desc: "「N 个服务里 M 个在 profile 下；K 个常驻服务」的 N",
    hint: "「N 个服务里 M 个在 profile 下；K 个常驻服务不受影响」",
    re: /(\d+)\s*个服务里/,
  },
  {
    doc: DEPLOY_DOC_REL,
    fact: "composeProfiled",
    label: "profile 下的服务数",
    factHint: `${COMPOSE_REL} 里带 \`profiles:\` 的服务计数`,
    desc: "「N 个服务里 M 个在 profile 下」的 M",
    hint: "「M 个在 profile 下」",
    re: /(\d+)\s*个在\s*profile\s*下/,
  },
  {
    doc: DEPLOY_DOC_REL,
    fact: "composeResident",
    label: "常驻服务数",
    factHint: `${COMPOSE_REL} 里**不带** \`profiles:\` 的服务计数`,
    desc: "「K 个常驻服务不受影响」的 K",
    hint: "「K 个常驻服务不受影响，默认零资源占用」",
    re: /(\d+)\s*个常驻服务/,
  },
  {
    doc: INFRA_DOC_REL,
    fact: "composeResident",
    label: "常驻服务数（atlas 第二处手抄）",
    factHint: `${COMPOSE_REL} 里**不带** \`profiles:\` 的服务计数`,
    desc: "「K 个常驻服务 + profile 服务」的 K",
    hint: "「K 个常驻服务 + profile 服务」",
    re: /(\d+)\s*个常驻服务/,
  },
];

function lineOf(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function anchorLine(text, needle) {
  const at = text.indexOf(needle);
  return at < 0 ? null : lineOf(text, at);
}

function matchesOf(text, re) {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const g = new RegExp(re.source, flags);
  return [...text.matchAll(g)].map((m) => ({
    value: Number(m[1]),
    index: m.index ?? 0,
    raw: m[0],
  }));
}

// ── 判定（纯数据：main 只负责打印与退出码，selftest 直接复用）──────────────

export function analyze(root) {
  const { facts, problems } = collectFacts(root);
  let sites = 0;

  const docPath = join(root, DOC_REL);
  let docText = null;
  if (!existsSync(docPath)) {
    problems.push(
      `✖ 事实源缺失：缺少 ${DOC_REL} —— 文档被改名/挪走了？\n` +
        "  修法：恢复文档，或同步改脚本里的 DOC_REL（别把「文档没了」当成「没有数字要核对」）。",
    );
  } else {
    docText = readFileSync(docPath, "utf8");
  }

  // 第 5 项要读另外两篇文档：按需读、只报一次「缺失」，不重复刷屏。
  const extraDocs = new Map([[DOC_REL, docText]]);
  const readDoc = (rel) => {
    if (extraDocs.has(rel)) return extraDocs.get(rel);
    const abs = join(root, rel);
    let text = null;
    if (!existsSync(abs)) {
      problems.push(
        `✖ 事实源缺失：缺少 ${rel} —— 文档被改名/挪走了？\n` +
          "  修法：恢复文档，或同步改脚本里的路径常量（别把「文档没了」当成「没有数字要核对」）。",
      );
    } else {
      text = readFileSync(abs, "utf8");
    }
    extraDocs.set(rel, text);
    return text;
  };

  if (docText !== null) {
    for (const claim of CLAIMS) {
      const expected = facts[claim.fact];
      for (const site of claim.sites) {
        sites += 1;
        const hits = matchesOf(docText, site.re);
        if (hits.length === 0) {
          // B 类：解析不到即红。绝不「跳过」——那正是「改写句子 → 守卫瞎掉」的入口。
          const at = anchorLine(docText, site.anchor);
          const where = at === null ? "锚点未找到" : `锚点在第 ${at} 行`;
          problems.push(
            `✖ ${DOC_REL} · ${claim.label}｜定位失败（${where}）：${site.desc} 处解析不到数字` +
              `——句子被改写了，还是正则面收窄了？\n` +
              `  修法：保留可机读措辞${site.hint}；若确要改写句子，放宽 ` +
              "scripts/check-infra-doc-counts.mjs 的 CLAIMS 正则（多认几种写法），**不要删断言**。",
          );
          continue;
        }
        if (expected === null) continue; // 事实源已红，不再制造误导性的「实际 undefined」
        for (const hit of hits) {
          if (hit.value === expected) continue;
          const line = lineOf(docText, hit.index);
          problems.push(
            `✖ ${DOC_REL}:${line} · ${claim.label}｜文档写「${hit.value}」，实际「${expected}」。\n` +
              `  修法：把第 ${line} 行的 ${hit.value} 改成 ${expected}（${claim.factHint}）；不要改守卫。`,
          );
        }
      }
    }
  }

  for (const claim of SERVICE_CLAIMS) {
    const text = readDoc(claim.doc);
    if (text === null) continue;
    sites += 1;
    const expected = facts[claim.fact];
    const hits = matchesOf(text, claim.re);
    if (hits.length === 0) {
      problems.push(
        `✖ ${claim.doc} · ${claim.label}｜定位失败：${claim.desc} 处解析不到数字` +
          "——句子被改写了，还是正则面收窄了？\n" +
          `  修法：保留可机读措辞${claim.hint}；不要删断言。`,
      );
      continue;
    }
    if (expected === null) continue; // 事实源已红，不再制造误导性的「实际 undefined」
    for (const hit of hits) {
      if (hit.value === expected) continue;
      const line = lineOf(text, hit.index);
      problems.push(
        `✖ ${claim.doc}:${line} · ${claim.label}｜文档写「${hit.value}」，实际「${expected}」。\n` +
          `  修法：把第 ${line} 行的 ${hit.value} 改成 ${expected}（${claim.factHint}）；不要改守卫。`,
      );
    }
  }

  return { facts, problems, sites, ok: problems.length === 0 };
}

function report(result) {
  const { facts } = result;
  if (result.problems.length > 0) {
    for (const p of result.problems) console.error(p);
    console.error("");
    console.error(
      "✖ infra 文档自述计数守卫红：" +
        `${result.problems.length} 个问题（断言点 ${result.sites} 处）。` +
        "文档数字要与代码事实对齐，且断言点必须保持可机读。",
    );
    return 1;
  }
  console.log(`✔ workflow 文件数：${facts.workflows}（${WORKFLOWS_DIR}/*.yml）`);
  console.log(`✔ ci.yml job 数：${facts.jobs}（jobs: 块直接子键）`);
  console.log(`✔ deploy.sh 行数：${facts.deployLines}（wc -l 口径）`);
  console.log(`✔ TypeORM 迁移数：${facts.migrations}（排除 *.spec.ts）`);
  console.log(
    `✔ compose 服务数：${facts.composeServices}（${facts.composeProfiled} 个在 profile 下 / ${facts.composeResident} 个常驻，${COMPOSE_REL}）`,
  );
  console.log(
    `✔ deploy-and-ci.md 的四个数字 + deployment.md 的常驻服务数：${result.sites} 处断言点全部命中且相符。`,
  );
  return 0;
}

// ── selftest ────────────────────────────────────────────────────────────────

const FIXTURE = { workflows: 10, jobs: 38, deployLines: 1963, migrations: 122 };

function fixtureCi(jobCount) {
  const lines = ["name: CI", "on:", "  push:", "jobs:"];
  for (let i = 1; i <= jobCount; i += 1) {
    lines.push(`  job-${String(i).padStart(2, "0")}:`);
    lines.push("    runs-on: ubuntu-latest");
    lines.push("    steps:");
    lines.push("      - uses: actions/checkout@v4");
    lines.push("      - name: run");
    lines.push("        run: echo ok");
  }
  lines.push("permissions:", "  contents: read", "");
  return lines.join("\n");
}

/**
 * fixture 文档刻意**照抄真文档的措辞结构**（含粗体、全角逗号、表格行），
 * 这样 selftest 验证的就是真文档会走的正则路径，而不是一条为 fixture 定制的路径。
 */
function fixtureDoc(overrides = {}) {
  const { workflows, jobs, deployLines, migrations } = {
    ...FIXTURE,
    ...overrides,
  };
  return [
    "# 部署与 CI",
    `> 所属: docs/atlas/06-infra · 最后核对: 2026-10-29 · 对应代码: deploy.sh、.github/workflows/（共 ${workflows} 个：ci.yml / release.yml）`,
    "",
    `## 怎么部署（deploy.sh，${deployLines} 行）`,
    "",
    `## Workflow 文件总览（.github/workflows/，${workflows} 个）`,
    "",
    "| Workflow | 触发 | 作用 |",
    "|---|---|---|",
    `| \`ci.yml\` | push/PR（main、develop）、手动、月度 cron | ${jobs} 个 job 的全量质量门禁（下表） |`,
    "",
    "## CI 面板（.github/workflows/ci.yml）",
    "",
    `- 并发组：\`ci-\${{\ github.ref }}\`，同分支旧跑自动取消。共 **${jobs} 个 job**：`,
    "",
    "| 分组 | Job（要点） |",
    "|---|---|",
    `| admin-api | \`admin-api-migrations\`（空库全链 ${migrations} 个迁移 + 二跑幂等守卫；schedule 轮加漂移检查） |`,
    "",
    "## 常见坑",
    "",
    "1. 月度 schedule 轮只有迁移演练 job 在跑。",
    "",
  ].join("\n");
}

/**
 * 第 5 项的 fixture：根 compose（默认 21 个服务 / 13 个在 profile 下 / 8 个常驻，与真仓同构）。
 *
 * · `promote: n` 让前 n 个 profile 服务变成常驻（造「现场变了、文档没跟」）；
 * · `tags: true` 掺入 `!reset` / `!override`（真仓 `docker-compose.ha.yml` /
 *   `docker-compose.demo.yml` 的形状）——正则解析器不认标签，因此**不会炸**；
 * · 同时覆盖两种 `profiles:` 写法（行内列表 + 块状 `- a`）。
 */
const RESIDENT_SERVICES = [
  "postgres",
  "redis",
  "admin-api",
  "admin-web",
  "executor-python",
  "executor-node",
  "registry-pypi",
  "registry-npm",
];
const PROFILE_SERVICES = [
  "postgres-replica",
  "rustfs",
  "volume-permission-helper",
  "jaeger",
  "pg-backup",
  "prometheus",
  "grafana",
  "alertmanager",
  "alertmanager-hmac-proxy",
  "postgres-exporter",
  "redis-exporter",
  "loki",
  "promtail",
];

function fixtureCompose({ promote = 0, tags = false } = {}) {
  const lines = ["networks:", "  autoflow-internal:", "    driver: bridge", "", "services:"];
  lines.push("  # ── 常驻（不带 profiles:）─────────────────────────");
  for (const name of RESIDENT_SERVICES) {
    lines.push(`  ${name}:`, `    image: example/${name}:1`, "    restart: unless-stopped");
    if (tags) lines.push("    ports: !reset []");
    lines.push("    environment:", "      FOO: bar");
  }
  lines.push("  # ── profile 服务 ─────────────────────────────────");
  PROFILE_SERVICES.forEach((name, idx) => {
    lines.push(`  ${name}:`, `    image: example/${name}:1`);
    if (idx >= promote) {
      // idx 1 用块状列表，其余用行内列表：两种写法都必须被认出来。
      if (idx === 1) lines.push("    profiles:", "      - replica");
      else lines.push(`    profiles: ['p${idx}']`);
    }
    if (tags) lines.push("    security_opt: !override", "      - no-new-privileges:true");
  });
  lines.push("", "volumes:", "  data:", "");
  return lines.join("\n");
}

/** `docs/deployment.md` 的最小形态：只保留「N 个服务里 M 个在 profile 下；K 个常驻服务」那句。 */
function fixtureDeployDoc({ services = 21, profiled = 13, resident = 8 } = {}) {
  return [
    "# 部署指南",
    "",
    "## 日志对象存储（profile: rustfs，LOG-02）",
    "",
    "```bash",
    `# 1) 起对象存储（${services} 个服务里 ${profiled} 个在 profile 下；${resident} 个常驻服务不受影响，默认零资源占用）`,
    "docker compose --profile rustfs up -d rustfs",
    "```",
    "",
  ].join("\n");
}

/** `docs/atlas/06-infra/README.md` 的最小形态：同一事实的第二处手抄（「K 个常驻服务 + profile 服务」）。 */
function fixtureInfraDoc({ resident = 8 } = {}) {
  return [
    "# 基础设施总览",
    "",
    `- 根 \`docker-compose.yml\`（1054 行）：完整部署——${resident} 个常驻服务 + profile 服务（\`rustfs\` / \`replica\` / \`jaeger\` / \`backup\` / \`monitoring\`），双网络，15 个命名卷。`,
    "",
  ].join("\n");
}

/**
 * 把一条用例的 fixture 摊成 `makeFixtureRepo` 的文件表（与真实树同构：
 * workflows 落 `.github/workflows/`、迁移落 `apps/admin-api/src/migrations/`…），
 * `--root` 直接指过去即可。
 *
 * 旧版是「一个共享 sandbox + 每例一个子目录 + 自己 mkdir/writeFile」；现在一例一棵
 * mkdtemp 树、由 harness 统一造与清（互不干扰，也不会漏删）。
 */
function buildFixtureFiles(opts = {}) {
  const cfg = { ...FIXTURE, ...opts };
  const files = {};

  // ① workflows
  const names = [];
  for (let i = 1; i <= cfg.workflows; i += 1) {
    names.push(`wf-${String(i).padStart(2, "0")}.yml`);
  }
  if (!opts.omitCi) names[0] = "ci.yml";
  for (const name of names) {
    files[`${WORKFLOWS_DIR}/${name}`] =
      name === "ci.yml"
        ? fixtureCi(cfg.jobs)
        : "name: other\non: push\njobs:\n  only:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n";
  }

  // ② deploy.sh
  if (!opts.omitDeploy) {
    const lines = [];
    for (let i = 1; i <= cfg.deployLines; i += 1) lines.push(`# deploy line ${i}`);
    files[DEPLOY_REL] = `${lines.join("\n")}\n`;
  }

  // ③ migrations
  if (!opts.omitMigrations) {
    for (let i = 0; i < cfg.migrations; i += 1) {
      files[`${MIGRATIONS_DIR}/${1717473142678 + i}-Mig${String(i).padStart(4, "0")}.ts`] =
        `export class Mig${i} {}\n`;
    }
    // 哨兵：spec 不得计入迁移数
    files[`${MIGRATIONS_DIR}/migrations.spec.ts`] = "// 哨兵：spec 不得计入迁移数\n";
  }

  // ④ 文档
  if (!opts.omitDoc) files[DOC_REL] = opts.doc ?? fixtureDoc(cfg);

  // ⑤ 根 compose + 两篇写「常驻服务数」的文档
  if (!opts.omitCompose) files[COMPOSE_REL] = opts.compose ?? fixtureCompose(opts.composeOpts ?? {});
  if (!opts.omitDeployDoc) files[DEPLOY_DOC_REL] = opts.deployDoc ?? fixtureDeployDoc();
  if (!opts.omitInfraDoc) files[INFRA_DOC_REL] = opts.infraDoc ?? fixtureInfraDoc();
  return files;
}

function slugify(name) {
  return name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function must(cond, message) {
  if (!cond) throw new Error(message);
}

/**
 * 22 条有齿用例。每条断言**退出码**与**关键报错文本**（不只是「不抛异常」）：
 * 只断言不抛的 selftest，会在判据整体失效时照样全绿。
 */
const SELFTEST_CASES = [
  {
    name: "基线：四个数字 + 常驻服务数全对 → exit 0",
    tree: {},
    expectCode: 0,
    expectText: [
      "workflow 文件数：10",
      "ci.yml job 数：38",
      "deploy.sh 行数：1963",
      "TypeORM 迁移数：122",
      "compose 服务数：21（13 个在 profile 下 / 8 个常驻",
      "10 处断言点全部命中",
    ],
  },
  {
    name: "workflow 数改错（10→9）→ 红，两处断言点各点名一次（行号+文档值+实际值+修法）",
    tree: { doc: fixtureDoc({ workflows: 9 }) },
    expectCode: 1,
    expectText: [
      "workflow 文件数",
      "文档写「9」",
      "实际「10」",
      `${DOC_REL}:2`,
      "修法：把第 2 行的 9 改成 10",
      "`ls .github/workflows/*.yml` 实测",
    ],
    expectCount: [{ text: "workflow 文件数", min: 2 }],
  },
  {
    name: "job 数改错（38→37）→ 红，表格行与面板行各点名一次",
    tree: { doc: fixtureDoc({ jobs: 37 }) },
    expectCode: 1,
    expectText: ["ci.yml job 数", "文档写「37」", "实际「38」", "`jobs:` 块直接子键计数"],
    expectCount: [{ text: "ci.yml job 数", min: 2 }],
  },
  {
    name: "deploy.sh 行数改错（1963→129）→ 红（本次审计的原始形态）",
    tree: { doc: fixtureDoc({ deployLines: 129 }) },
    expectCode: 1,
    expectText: [
      "deploy.sh 行数",
      "文档写「129」",
      "实际「1963」",
      `${DOC_REL}:4`,
      "wc -l deploy.sh",
    ],
  },
  {
    name: "迁移数改错（122→119）→ 红（本次实测发现的第二处腐烂）",
    tree: { doc: fixtureDoc({ migrations: 119 }) },
    expectCode: 1,
    expectText: [
      "TypeORM 迁移数",
      "文档写「119」",
      "实际「122」",
      "grep -v spec",
    ],
  },
  {
    name: "四个数字同时改错 → 四条独立报错（不能只报第一条就收工）",
    tree: {
      doc: fixtureDoc({ workflows: 5, jobs: 37, deployLines: 129, migrations: 25 }),
    },
    expectCode: 1,
    expectText: ["workflow 文件数", "ci.yml job 数", "deploy.sh 行数", "TypeORM 迁移数"],
    expectCount: [
      { text: "workflow 文件数", min: 2 },
      { text: "ci.yml job 数", min: 2 },
    ],
  },
  {
    name: "句子被改写（「共 10 个」→「十个」）→ 定位失败红，不许静默放行",
    tree: {
      doc: fixtureDoc().replace(
        "（共 10 个：ci.yml / release.yml）",
        "（十个：ci.yml / release.yml）",
      ),
    },
    expectCode: 1,
    expectText: ["定位失败", "文件头注", "锚点在第 2 行", "不要删断言"],
  },
  {
    name: "句子被改写（「38 个 job」→「三十八个 job」）→ 定位失败红",
    tree: {
      doc: fixtureDoc().replace("共 **38 个 job**", "共 **三十八个 job**"),
    },
    expectCode: 1,
    expectText: ["定位失败", "CI 面板「共 **N 个 job**」", "锚点在第 14 行"],
  },
  {
    name: "句子被改写（「122 个迁移」→「122 条迁移」）→ 定位失败红（迁移这处也不能瞎）",
    tree: {
      doc: fixtureDoc().replace("122 个迁移", "122 条迁移"),
    },
    expectCode: 1,
    expectText: ["定位失败", "空库全链 N 个迁移"],
  },
  {
    name: "ci.yml 的 job 真变了（38→39）而文档没跟 → 红（事实源一侧也要有齿）",
    tree: { jobs: 39, doc: fixtureDoc() },
    expectCode: 1,
    expectText: ["ci.yml job 数", "文档写「38」", "实际「39」"],
  },
  {
    name: "ci.yml 缺失 → 红（不把「读不到」当 0 或跳过）",
    tree: { omitCi: true },
    expectCode: 1,
    expectText: ["事实源缺失", "缺少 .github/workflows/ci.yml", "不要**把「读不到」当作 0"],
  },
  {
    name: "deploy.sh 缺失 → 红",
    tree: { omitDeploy: true },
    expectCode: 1,
    expectText: ["事实源缺失", "缺少 deploy.sh"],
  },
  {
    name: "文档缺失 → 红（不是「没有数字要核对」）",
    tree: { omitDoc: true },
    expectCode: 1,
    expectText: ["事实源缺失", `缺少 ${DOC_REL}`],
  },
  {
    name: "措辞变体（`deploy.sh` 共 N 行 / 无逗号）仍解析 → 绿（放宽写法，不降判据）",
    tree: {
      doc: fixtureDoc().replace(
        "## 怎么部署（deploy.sh，1963 行）",
        "## 怎么部署（`deploy.sh` 共 1963 行）",
      ),
    },
    expectCode: 0,
    expectText: ["deploy.sh 行数：1963", "10 处断言点全部命中"],
  },
  {
    name: "常驻服务数改错（8→9）→ 红（第 22 轮反证② 的原样形态）",
    tree: { deployDoc: fixtureDeployDoc({ resident: 9 }) },
    expectCode: 1,
    expectText: ["常驻服务数", "文档写「9」", "实际「8」", `${DEPLOY_DOC_REL}:6`, "不要改守卫"],
  },
  {
    name: "句子被改写（「8 个常驻服务」→「八个常驻服务」）→ 定位失败红（数字对也不算）",
    tree: { deployDoc: fixtureDeployDoc().replace("8 个常驻服务", "八个常驻服务") },
    expectCode: 1,
    expectText: ["定位失败", "K 个常驻服务不受影响", "保留可机读措辞"],
  },
  {
    name: "compose 现场变了（1 个 profile 服务转常驻）而文档没跟 → 红（两处数字各点名）",
    tree: { compose: fixtureCompose({ promote: 1 }) },
    expectCode: 1,
    expectText: [
      "profile 下的服务数",
      "文档写「13」，实际「12」",
      "常驻服务数",
      "文档写「8」，实际「9」",
      // atlas 06-infra 那句「8 个常驻服务」是同一事实的第二处手抄，也要红
      `${INFRA_DOC_REL}:3`,
    ],
    expectCount: [{ text: "常驻服务数", min: 2 }],
  },
  {
    name: "docker-compose.yml 缺失 → 红（不把「读不到」当 0 或跳过）",
    tree: { omitCompose: true },
    expectCode: 1,
    expectText: ["事实源缺失", `缺少 ${COMPOSE_REL}`],
  },
  {
    name: "compose 里没有顶格 services: 块 → 解析失败红（结构错，不是「0 个服务」）",
    tree: { compose: "networks:\n  x:\n    driver: bridge\n" },
    expectCode: 1,
    expectText: ["事实源解析失败", "找不到顶格的 `services:` 行"],
  },
  {
    name: "`!reset` / `!override` 标签不炸：正则解析器只看缩进（直接断言解析器）",
    direct: () => {
      const text = fixtureCompose({ tags: true });
      must(text.includes("!reset") && text.includes("!override"), "fixture 没掺进标签，这条用例失去意义");
      const parsed = parseComposeServices(text);
      must(parsed.ok, `parseComposeServices 失败：${parsed.reason}`);
      must(
        parsed.services.length === 21,
        `解析到 ${parsed.services.length} 个服务（期望 21）——两空格缩进的服务名被漏掉/多算`,
      );
      const profiled = parsed.services.filter((s) => s.profiles.length > 0);
      const resident = parsed.services.filter((s) => s.profiles.length === 0);
      must(profiled.length === 13, `profile 服务 ${profiled.length} 个（期望 13）`);
      must(resident.length === 8, `常驻服务 ${resident.length} 个（期望 8）`);
      must(
        resident.some((s) => s.name === "postgres") && profiled.some((s) => s.name === "rustfs"),
        "服务名解析错位（postgres / rustfs）",
      );
      // 块状 `profiles:` 列表（idx 1 = postgres-replica）必须被认出来
      must(
        profiled.some((s) => s.name === "postgres-replica"),
        "块状 profiles: 列表没被解析（postgres-replica 被当成常驻）",
      );
    },
  },
  {
    name: "jobs: 块内的 steps:/runs-on: 不算 job（直接断言解析器，专治粗匹配）",
    direct: () => {
      const parsed = parseJobs(fixtureCi(38));
      must(parsed.ok, `parseJobs 失败：${parsed.reason}`);
      must(
        parsed.names.length === 38,
        `解析到 ${parsed.names.length} 个 job（期望 38）——两空格缩进的非 job 键被误算了`,
      );
      const bogus = parsed.names.filter((n) =>
        ["steps", "runs-on", "name", "with", "env", "permissions"].includes(n),
      );
      must(bogus.length === 0, `把非 job 键当成了 job：${bogus.join(", ")}`);
      must(
        parsed.names.includes("job-38"),
        "漏掉了最后一个 job `job-38`（块边界判断有误）",
      );
    },
  },
];

/**
 * 单条子进程用例的耗时上限（喂给 `expectExit({ withinMs })`）。
 * 一例要写 122 个迁移 + 1963 行 deploy.sh，实测 ~60ms，留 20 倍余量：它拦的是
 * 「解析/扫描退化成指数回溯」这类**耗时形态**，不是抖动。
 */
const SELFTEST_CASE_BUDGET_MS = 1000;

/** 出现次数断言：`expectExit` 管「有没有」，这几条还要求「同名报错出现 ≥ N 次」。 */
function expectOccurrences(result, rules) {
  const output = `${result.stdout}${result.stderr}`;
  for (const { text, min } of rules) {
    const n = output.split(text).length - 1;
    must(n >= min, `输出里「${text}」出现 ${n} 次（至少 ${min} 次）`);
  }
}

/**
 * selftest（T4 收编，第 12 轮）：真子进程 + 断言退出码/关键文本/耗时。
 *
 * 旧实现自己攒了 `mkdtempSync + mkdir/writeFile + spawnSync + 手判 status/contains
 * + 自拼 problems[]`，与另外 40 多个守卫各写一份、细节互不一致（不设超时、
 * `status === null` 当普通退出码比较、fixture 清理只在 finally 里做一次）。
 * 现在统一走 `scripts/lib/guard-selftest.mjs`：
 *   · `runGuard` 起进程（脚本/cwd 不存在立即抛错，超时给布尔）；
 *   · `expectExit` 判（退出码 + 关键文本 + `withinMs`，失败抛带 cwd 与输出尾部的错）；
 *   · `makeFixtureRepo` / `reportCases` 造树与汇总。
 * 用例语义、条数与判据一条没删。
 */
export function runSelftest() {
  let i = 0;
  const cases = SELFTEST_CASES.map((testCase) => ({
    name: testCase.name,
    fn: () => {
      // `direct` 用例断言的是纯解析器（判据本体在函数里，再起一次 node 没有增量信息）。
      if (testCase.direct) return testCase.direct();

      const repo = makeFixtureRepo(buildFixtureFiles(testCase.tree ?? {}), {
        prefix: `infra-doc-counts-${slugify(testCase.name) || "case"}-`,
      });
      try {
        // `--root <dir>` 与 `--root=<dir>` **交替**使用：参数解析退化（吃掉值 /
        // 只认某一种形态）时约一半用例会红，而不是整片静默照绿。
        const rootFlag = i++ % 2 === 0 ? ["--root", repo.dir] : [`--root=${repo.dir}`];
        const result = expectExit(runGuard(SELF, { args: rootFlag }), {
          code: testCase.expectCode,
          contains: testCase.expectText,
          withinMs: SELFTEST_CASE_BUDGET_MS,
          label: testCase.name,
        });
        expectOccurrences(result, testCase.expectCount ?? []);
      } finally {
        repo.cleanup();
      }
    },
  }));

  // 规模下界（API 级，第 12 轮补）：`FLOORS` 是「事实源被改名/清空」时唯一的红。
  // 为它起子进程要重写一整棵 122 迁移的树（~60ms，本脚本有全局耗时预算），而判据
  // 本体 `analyze()` 是纯数据返回，可直接调。⚠ 边界（如实）：CLI 层「下界红 → exit 1」
  // 没有独立的子进程用例——它与上面三条「事实源缺失」用例共用 `report()` 的同一条
  // 返回路径；谁动了 `report()` 的返回码，请把它补成一条 `--root` 子进程用例。
  cases.push({
    name: "规模下界：deploy.sh 只剩 12 行 / 迁移只有 3 个 → 报「规模下界」（不许静默全绿）",
    fn: () => {
      const repo = makeFixtureRepo(
        buildFixtureFiles({ deployLines: 12, migrations: 3 }),
        { prefix: "infra-doc-counts-floor-" },
      );
      try {
        const result = analyze(repo.dir);
        const text = result.problems.join("\n");
        must(!result.ok, "扫描面塌了却仍判绿——规模下界失效");
        must(
          text.includes("规模下界") && text.includes(DEPLOY_REL),
          `没报 ${DEPLOY_REL} 规模下界：${text || "(无 problems)"}`,
        );
        must(
          text.includes(MIGRATIONS_DIR),
          `没报迁移规模下界：${text || "(无 problems)"}`,
        );
      } finally {
        repo.cleanup();
      }
    },
  });

  const failed = reportCases(cases, { title: "check-infra-doc-counts selftest" });
  return failed > 0 ? 1 : 0;
}

// ── 入口 ────────────────────────────────────────────────────────────────────
function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes("--selftest")) return runSelftest();
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "用法：node scripts/check-infra-doc-counts.mjs [--selftest] [--root <dir>]\n" +
        "  （无参数）     核对 docs/atlas/06-infra/deployment-and-ci.md 的四个数字 vs 代码事实\n" +
        "  --selftest     验证判据本身（22 条用例）\n" +
        "  --root <dir>   selftest 内部用：在任意临时树上跑（`--root=<dir>` 同义）",
    );
    return 0;
  }
  const root = resolve(argValue(argv, "--root") ?? DEFAULT_ROOT);
  return report(analyze(root));
}

/**
 * `isMain`：被 `import` 时**只导出**、不执行。旧实现是模块顶层直接
 * `process.exit(report(...))`——任何 import 它的人（selftest / 未来的收编方）
 * 都会被当场带走，这也是它此前没法接 harness 的原因之一。
 */
const isMain = process.argv[1] && resolve(process.argv[1]) === SELF;
if (isMain) process.exit(main());
