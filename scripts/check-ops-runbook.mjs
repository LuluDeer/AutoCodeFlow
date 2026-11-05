#!/usr/bin/env node
/**
 * R15（2026-11-05）：**运维手册段落 + 启动告警接线**的机读守卫。
 *
 * ## 为什么要有它
 *
 * R14 把 ADR-030 ②′ 落地后留下一条运维债：换派生密钥的语义/流程/失效半径**没有任何地方
 * 告诉运维**。R15 写了 `docs/operations.md` 的一节 —— 但"文档写了"不等于"文档在、且说得全"：
 * 本仓反复出现「写了没人跑 / 写了没人查」（见 `check:guards-wired`、`check:race-selftests-wired`）。
 * 故这里把三件事钉死：
 *
 *   ① **段落存在**：`docs/operations.md` 有「轮换 per-executor 令牌派生密钥」这一节；
 *   ② **三要素齐全**：语义（不吊销已签发令牌 / 跨实例幂等受影响）、流程（灰度→全量→回退）、
 *      失效半径（表格 + 「不要在高峰做」）；
 *   ③ **接线存在**：`apps/admin-api/src/main.ts` 真的调用 `tokenDerivationPostureWarning()`，
 *      且 `EXECUTOR_TOKEN_EPOCH_MODE` 这个开关名在告警模块里被引用（不是空函数）。
 *
 * ## 反向验证（判据的牙齿）
 *
 * `--selftest` 在 fixture 上逐条断言「删要素 ⇒ 红且点名缺什么」：
 * 删整节 / 删「回退」/ 删失效半径表 / 删 main.ts 接线 —— 四种都必须 exit 1。
 *
 * 用法：`node scripts/check-ops-runbook.mjs [--selftest] [--root=<dir>]`
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

printCoverageBanner(import.meta.url, "subprocess");

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(HERE, "..", "..");

export const OPS_DOC = "docs/operations.md";
export const POSTURE_MODULE = "apps/admin-api/src/config/token-derivation-posture.ts";
export const BOOTSTRAP = "apps/admin-api/src/main.ts";

/** 三要素的判据（每条 = 一个必须出现在该节里的可读事实）。 */
export const REQUIRED_BLOCKS = [
  {
    id: "semantics",
    label: "语义",
    // 要点：换密钥**不吊销**已签发令牌（这正是 ADR-030 §5.5 的实测修正），且指出幂等面受影响。
    any: [/不会吊销已签发的令牌/, /跨实例幂等/],
    why: "必须写明「换密钥不吊销已签发令牌 + 影响的是跨实例幂等」，否则运维会按『全机队 401』预案误操作",
  },
  {
    id: "procedure",
    label: "流程",
    any: [/灰度一台/, /全量/, /回退/],
    why: "必须给出「灰度一台 → 全量 → 回退」三段可执行步骤",
  },
  {
    id: "blast-radius",
    label: "失效半径",
    any: [/失效半径|失败半径/, /不要在.*高峰|不要.*高峰/],
    why: "必须有失效半径（谁受影响/多久自愈/有无数据丢失）与『不要在高峰做』",
  },
];

/**
 * R47：**改动检查单**的机读判据 —— 四条「改完必须立刻做」的命令必须逐条出现在
 * `docs/operations.md` 的「改动检查单」一节里（每条都要是一行可复制命令）。
 *
 * 为什么需要守卫：这四条都是**踩过的坑**（R28 SIGTERM / R29 digest 摩擦 / R46 CI 假红 / R45 教训㊺），
 * 写在文档里但没人照着做 = 白写；把它们变成 `exit 1` 才是真的"记住了"。
 */
export const REQUIRED_CHECKLIST = [
  {
    id: "ci-yml",
    label: "改 .github/workflows/ci.yml ⇒ check:guards-wired",
    re: /check:guards-wired/,
    why: "YAML 插入位置错会拆坏相邻步骤的 run: 块，报出来的却是「别的守卫没接线」（R46 假红）",
  },
  {
    id: "executor-node-src",
    label: "改 apps/executor-node/src/** ⇒ digest:regen",
    re: /digest:regen/,
    why: "改了 bundle 输入源码就必须回填 ① 语义摘要，否则 check:desktop-bundle-drift 红（R29）",
  },
  {
    id: "admin-api-full",
    label: "跑 admin-api 全量 ⇒ --maxWorkers=2",
    re: /--maxWorkers=2/,
    why: "默认按核数起 worker，本机 swap 满 ⇒ 会被 SIGTERM（R28 实测两次）",
  },
  {
    id: "chain-readers",
    label: "改守卫链 / package.json 脚本键 ⇒ 先 grep 读者",
    re: /guards-wired/,
    why: "链被工具解析（guards-wired / :report / 矩阵入口），改键前先找读者（R22 教训㊺）",
  },
];

/** 取某二级标题下的正文（到下一个 `## ` 为止）。 */
export function sectionOf(doc, headingNeedle) {
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## ") && l.includes(headingNeedle));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

export function check(root = REPO_ROOT) {
  const errors = [];
  const opsPath = join(root, OPS_DOC);
  if (!existsSync(opsPath)) return [`读不到 ${OPS_DOC} —— 运维手册被删了？`];
  const doc = readFileSync(opsPath, "utf8");
  const section = sectionOf(doc, "轮换 per-executor 令牌派生密钥");
  if (!section) {
    return [
      `${OPS_DOC} 里没有「轮换 per-executor 令牌派生密钥」一节 —— ` +
        `换派生密钥的语义/流程/失效半径没有任何地方写了（ADR-030 §5.5 是本守卫的事实源）`,
    ];
  }
  for (const block of REQUIRED_BLOCKS) {
    if (!block.any.every((re) => re.test(section))) {
      errors.push(`运维手册「轮换…派生密钥」缺 ${block.label} 要素：${block.why}`);
    }
  }
  // ③ 接线：main.ts 必须真的调用，且告警模块必须真的读那个开关名
  const mainPath = join(root, BOOTSTRAP);
  if (!existsSync(mainPath)) errors.push(`读不到 ${BOOTSTRAP}`);
  else if (!/tokenDerivationPostureWarning\s*\(/.test(readFileSync(mainPath, "utf8"))) {
    errors.push(
      `${BOOTSTRAP} 没有调用 tokenDerivationPostureWarning() —— 启动告警写了但没接上（"存在≠被执行"）`,
    );
  }
  const modPath = join(root, POSTURE_MODULE);
  if (!existsSync(modPath)) errors.push(`读不到 ${POSTURE_MODULE}（启动告警模块）`);
  else {
    const mod = readFileSync(modPath, "utf8");
    if (!mod.includes("EXECUTOR_TOKEN_EPOCH_MODE")) {
      errors.push(`${POSTURE_MODULE} 没有引用 EXECUTOR_TOKEN_EPOCH_MODE —— 告警条件与开关脱钩`);
    }
    if (!mod.includes("docs/operations.md")) {
      errors.push(`${POSTURE_MODULE} 的告警文案没有指向 docs/operations.md —— 运维看不到手册在哪`);
    }
  }
  // ④ UPGRADING 交叉引用（升级面的人也要能找到）
  const upPath = join(root, "docs/UPGRADING.md");
  if (existsSync(upPath)) {
    const up = readFileSync(upPath, "utf8");
    if (!up.includes("rotate-token-derivation-secret")) {
      errors.push("docs/UPGRADING.md 没有指向运维手册这一节的交叉引用（升级面找不到）");
    }
  }
  // R47：改动检查单（四条命令逐条在文档里）
  const checklist = sectionOf(doc, "改动检查单");
  if (!checklist) {
    errors.push(
      `${OPS_DOC} 里没有「改动检查单」一节 —— 四条"改完必须立刻做"的命令没有落点（R47）`,
    );
  } else {
    for (const item of REQUIRED_CHECKLIST) {
      if (!item.re.test(checklist)) {
        errors.push(`改动检查单缺「${item.label}」：${item.why}`);
      }
    }
  }

  return errors;
}

const SELF = fileURLToPath(import.meta.url);

function fixtureTree(over = {}) {
  const section = [
    "## 轮换 per-executor 令牌派生密钥",
    "",
    "换密钥**不会吊销已签发的令牌**；受影响的是**跨实例幂等**。",
    "",
    "### 流程",
    "1. 灰度一台实例",
    "2. 全量逐个重启",
    "3. 回退：写回旧值",
    "",
    "### 失效半径",
    "见表格；**不要在业务高峰**做。",
  ].join("\n");
  const base = {
    [OPS_DOC]: `${over.opsDoc ?? section}\n\n## 升级 runbook\n`,
    [BOOTSTRAP]: over.bootstrap ?? "tokenDerivationPostureWarning();\n",
    [POSTURE_MODULE]:
      over.postureModule ??
      'export const F = "EXECUTOR_TOKEN_EPOCH_MODE";\n// 手册：docs/operations.md\n',
    "docs/UPGRADING.md": over.upgrading ?? "见 operations.md#rotate-token-derivation-secret\n",
  };
  return base;
}

function runSelftest() {
  const cases = [];
  const push = (name, fn) => cases.push({ name, fn });

  push("正例控制组：段落 + 三要素 + 接线齐 ⇒ exit 0", () => {
    const repo = makeFixtureRepo(fixtureTree());
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), { code: 0, withinMs: 20000, label: "正例" });
    } finally {
      repo.cleanup();
    }
  });

  push("反例①：整节删掉 ⇒ exit 1 且点名「没有…一节」", () => {
    const repo = makeFixtureRepo(fixtureTree({ opsDoc: "## 其他小节\n无关内容\n" }));
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1, contains: ["没有「轮换 per-executor 令牌派生密钥」一节"], withinMs: 20000, label: "删整节",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例②：缺「流程」（回退被删）⇒ exit 1 且点名缺流程", () => {
    const ops = fixtureTree()[OPS_DOC]
      .replace("3. 回退：写回旧值", "3. 见上")
      .replace("2. 全量逐个重启", "2. 见上");
    const repo = makeFixtureRepo(fixtureTree({ opsDoc: ops }));
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1, contains: ["缺 流程"], withinMs: 20000, label: "缺流程",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例③：缺「失效半径」⇒ exit 1 且点名", () => {
    const ops = fixtureTree()[OPS_DOC]
      .replace("### 失效半径", "### 其他")
      .replace("见表格；**不要在业务高峰**做。", "略。");
    const repo = makeFixtureRepo(fixtureTree({ opsDoc: ops }));
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1, contains: ["缺 失效半径"], withinMs: 20000, label: "缺半径",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例④：main.ts 删掉接线 ⇒ exit 1 且点名「写了但没接上」", () => {
    const repo = makeFixtureRepo(fixtureTree({ bootstrap: "// 什么都没调用\n" }));
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1, contains: ["写了但没接上"], withinMs: 20000, label: "删接线",
      });
    } finally {
      repo.cleanup();
    }
  });

  push("反例⑤：告警文案不再指向手册 ⇒ exit 1", () => {
    const repo = makeFixtureRepo(
      fixtureTree({ postureModule: 'export const F = "EXECUTOR_TOKEN_EPOCH_MODE";\n' }),
    );
    try {
      expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
        code: 1, contains: ["没有指向 docs/operations.md"], withinMs: 20000, label: "指南脱钩",
      });
    } finally {
      repo.cleanup();
    }
  });

  const failed = reportCases(cases, { title: "check-ops-runbook selftest" });
  process.exit(failed === 0 ? 0 : 1);
}

function main(argv) {
  const eq = argv.find((a) => a.startsWith("--root="));
  const at = argv.indexOf("--root");
  const rootArg = eq ? eq.slice("--root=".length) : at >= 0 && at + 1 < argv.length ? argv[at + 1] : null;
  const errors = check(resolve(rootArg ?? REPO_ROOT));
  if (errors.length === 0) {
    console.log(
      `✔ 运维手册守卫通过：「轮换 per-executor 令牌派生密钥」一节三要素齐全（语义 / 流程 / 失效半径），` +
        `启动告警已在 main.ts 接线并指向手册，UPGRADING 有交叉引用。`,
    );
    return 0;
  }
  console.error(`✘ 运维手册守卫：${errors.length} 项`);
  for (const e of errors) console.error(`   · ${e}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) {
  process.exit(process.argv.includes("--selftest") ? runSelftest() : main(process.argv.slice(2)));
}
