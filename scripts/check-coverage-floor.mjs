#!/usr/bin/env node
/**
 * R137（2026-11-07）：**覆盖率下限棘轮**（`check:coverage-floor`）。
 *
 * ## 为什么
 * 仓库此前只有「尺寸棘轮」（`source-size-baseline.json` + `check:size-caps`），
 * **没有任何守卫阻止覆盖率下滑** —— `docs/health-baseline.md` 只是记录，掉下去也没人红。
 *
 * ## 判据
 * 基线 `scripts/coverage-floor-baseline.json` 的 `ends.<端>.floor` 与**实测**比较：
 * · 实测 **<** floor ⇒ **红**，报文含「实测 vs 基线 vs 差多少」+ 两条改法（补测试 / 下调基线并写 why + 批准）；
 * · 实测 **>** floor ⇒ 绿，并**提示可上调**（棘轮只往紧的方向走）；
 * · **拿不到数据**（`docs/health-baseline.json` 缺该端或 `coveragePct` 为 null）⇒ **红**并教怎么跑 —— 不许静默绿；
 * · **测量本身失败**（该 step 的 `code !== 0` 或 `signal` 非空）⇒ **红**，报文点名「pct 不可信」。
 *   R138 实测到的真缺陷：旧实现只取 `summary.coveragePct` 看数字，**从不看 `step.code`** ⇒ 测试套件
 *   跑挂（甚至被 SIGTERM 杀）时，只要台账里留着上次数值就照样判绿 —— 那是「拿一次失败的测量去
 *   证明覆盖率没掉」。现在先判测量是否成立，再判数字。
 *
 * 用法：node scripts/check-coverage-floor.mjs [--root=<dir>] [--selftest]
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

printCoverageBanner(import.meta.url, "subprocess");

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(dirname(HERE), "..");
export const BASELINE_REL = "scripts/coverage-floor-baseline.json";
export const HEALTH_REL = "docs/health-baseline.json";
/** 基线端名 → `docs/health-baseline.json` 里的 step label 关键词。 */
export const END_LABEL_HINTS = {
  "executor-python": "executor-python",
  // R138：executor-node 是第二条接进棘轮的端（此前只有 python 一端有 floor ⇒ 棘轮半只眼）
  "executor-node": "executor-node",
};

/**
 * 基线端名 → 「该端的实测数据怎么来」的跑法（报文里教人的那一条，**按端取**）。
 *
 * R138 修的是旧报文的错教：以前所有端共用一句 `cd apps/executor-python && python3 -m pytest --cov`，
 * 对 node 端那是**跑不通的药方**（node 端没有 pytest）。缺一条就退到全量体检，绝不硬塞别端的命令。
 */
export const END_RUN_HINTS = {
  "executor-python": "`cd apps/executor-python && python3 -m pytest --cov`",
  "executor-node": "`npm run coverage:node`（真跑 `npx jest --coverage --coverageReporters=json-summary` 并回写 `coveragePct`）",
};

const runHint = (end) => END_RUN_HINTS[end] ?? "该端尚无单端快照脚本（见 `scripts/health-snapshot.mjs` 对应步）";

export function check(root = REPO_ROOT) {
  const errors = [];
  const hints = [];
  const baselinePath = join(root, BASELINE_REL);
  if (!existsSync(baselinePath)) return [`读不到基线 ${BASELINE_REL} —— 覆盖率棘轮失去对象（先按模板建一份）`];
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch (e) {
    return [`${BASELINE_REL} 不是合法 JSON：${e.message}`];
  }
  const ends = baseline.ends ?? {};
  if (Object.keys(ends).length === 0) return [`${BASELINE_REL} 的 ends 为空 —— 判据面塌方`];

  const healthPath = join(root, HEALTH_REL);
  if (!existsSync(healthPath)) {
    return [
      `读不到 ${HEALTH_REL}（覆盖率实测来源）⇒ **不许静默绿**。` +
        `跑法：\`npm run health:snapshot\`（全量体检，各端步会产出 coveragePct）或该端的单端快照脚本（见下）`,
    ];
  }
  let health;
  try {
    health = JSON.parse(readFileSync(healthPath, "utf8"));
  } catch (e) {
    return [`${HEALTH_REL} 不是合法 JSON：${e.message}`];
  }
  const steps = health.steps ?? [];

  for (const [end, cfg] of Object.entries(ends)) {
    const floor = Number(cfg.floor);
    if (!Number.isFinite(floor)) {
      errors.push(`${BASELINE_REL} 的 \`ends.${end}.floor\` 不是数字：${cfg.floor}`);
      continue;
    }
    const hint = END_LABEL_HINTS[end] ?? end;
    const step = steps.find((s) => String(s.label ?? "").includes(hint));
    // R138 新判据：**先判测量成立，再判数字**。step 在但 code≠0（或被信号杀）⇒ pct 不可信。
    // 旧实现只看 pct ⇒ 「套件跑挂 + 台账留着上次数值」照样绿，那是最贵的一种假绿。
    const stepCode = step?.code;
    const stepFailed =
      Boolean(step && step.signal) ||
      (stepCode !== undefined && stepCode !== null && Number(stepCode) !== 0);
    if (stepFailed) {
      errors.push(
        `${end}：**测量本身失败，pct 不可信**（\`${HEALTH_REL}\` 的 step「${step.label}」实测 exit ${stepCode}` +
          `${step.signal ? ` / signal ${step.signal}` : ""}）⇒ 覆盖率门不许在测试套件挂着的时候判绿。` +
          `跑法：${runHint(end)}（先把该端测试跑到 exit 0，再谈覆盖率）`,
      );
      continue;
    }
    const actual = Number(step?.summary?.coveragePct);
    if (!step || !Number.isFinite(actual)) {
      errors.push(
        `${end}：**拿不到覆盖率数据**（\`${HEALTH_REL}\` 里没有含「${hint}」且带 \`coveragePct\` 的 step）⇒ 不许静默绿。` +
          `跑法：${runHint(end)}；或 \`npm run health:snapshot\`（全量体检）`,
      );
      continue;
    }
    if (actual < floor) {
      errors.push(
        `${end} 覆盖率**低于基线**：实测 ${actual}% < 基线 ${floor}%（差 ${(floor - actual).toFixed(2)}pt）⇒ ` +
          `改法①补测试把覆盖率补回去；改法②确需下调 ⇒ 改 \`${BASELINE_REL}\` 的 floor 并写 \`why\` + 谁批准（下调=放宽棘轮，需评审可见）`,
      );
    } else if (actual > floor) {
      hints.push(`${end} 实测 ${actual}% > 基线 ${floor}% ⇒ **可上调基线**（棘轮只往紧的方向走）：把 floor 改成 ${actual}`);
    }
  }
  console.log(`（覆盖率棘轮：比较 ${Object.keys(ends).length} 端；实测来源 ${HEALTH_REL}）`);
  for (const h of hints) console.log(`   · ${h}`);
  errors.meta = { ends: Object.keys(ends).length, hints: hints.length };
  return errors;
}

function runSelftest() {
  const cases = [];
  const push = (name, fn) => cases.push({ name, fn });
  const tree = (floor, actual) => ({
    [BASELINE_REL]: JSON.stringify({ ends: { "executor-python": { floor } } }, null, 2),
    [HEALTH_REL]: JSON.stringify(
      { generatedAt: "2026-11-07", steps: [{ label: "executor-python 全量（`python3 -m pytest`）", code: 0, signal: null, summary: { coveragePct: actual } }] },
      null,
      2,
    ),
  });
  push("正例：实测 == 基线 ⇒ exit 0", () => {
    const repo = makeFixtureRepo(tree(87.45, 87.45));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), { code: 0, withinMs: 20000, label: "正例" });
    } finally { repo.cleanup(); }
  });
  push("反例①：实测低于基线 ⇒ exit 1 且点名差值", () => {
    const repo = makeFixtureRepo(tree(87.95, 87.45));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1, contains: ["低于基线", "差 0.50pt"], withinMs: 20000, label: "低于基线",
      });
    } finally { repo.cleanup(); }
  });
  push("反例②：拿不到覆盖率数据 ⇒ exit 1 且教怎么跑", () => {
    const repo = makeFixtureRepo({
      [BASELINE_REL]: JSON.stringify({ ends: { "executor-python": { floor: 87.45 } } }),
      [HEALTH_REL]: JSON.stringify({ steps: [{ label: "admin-api", summary: {} }] }),
    });
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1, contains: ["拿不到覆盖率数据", "health:snapshot"], withinMs: 20000, label: "无数据",
      });
    } finally { repo.cleanup(); }
  });
  push("反例③：实测高于基线 ⇒ exit 0 且提示可上调", () => {
    const repo = makeFixtureRepo(tree(87.0, 87.45));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), { code: 0, withinMs: 20000, label: "可上调" });
    } finally { repo.cleanup(); }
  });
  // R138 新增三条：① 测量本身失败（code≠0）⇒ 红；② 两端都达标 ⇒ 绿且报「比较 2 端」；③ 缺 node 数据 ⇒ 红。
  const twoEnds = ({ pyFloor = 87.45, nodeFloor = 88.88, pyPct = 87.45, nodePct = 88.88, nodeCode = 0, nodeSignal = null } = {}) => ({
    [BASELINE_REL]: JSON.stringify(
      { ends: { "executor-python": { floor: pyFloor }, "executor-node": { floor: nodeFloor } } },
      null,
      2,
    ),
    [HEALTH_REL]: JSON.stringify(
      {
        generatedAt: "2026-11-07",
        steps: [
          { label: "executor-python 全量（`python3 -m pytest`）", code: 0, signal: null, summary: { coveragePct: pyPct } },
          { label: "executor-node 全量（`npm test -- --coverage`）", code: nodeCode, signal: nodeSignal, summary: { coveragePct: nodePct } },
        ],
      },
      null,
      2,
    ),
  });
  push("反例④：step.code≠0（测量本身失败）⇒ exit 1 且点名「pct 不可信」", () => {
    const repo = makeFixtureRepo(twoEnds({ nodeCode: 1 }));
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1, contains: ["测量本身失败", "pct 不可信", "executor-node"], withinMs: 20000, label: "测量失败",
      });
    } finally { repo.cleanup(); }
  });
  push("正例②：两端（python+node）各一档且均 ≥ floor ⇒ exit 0 且打印「比较 2 端」", () => {
    const repo = makeFixtureRepo(twoEnds());
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 0, contains: ["比较 2 端"], withinMs: 20000, label: "两端达标",
      });
    } finally { repo.cleanup(); }
  });
  push("反例⑤：缺 node 数据（只有 python 步）⇒ exit 1 且点名 executor-node + 教 `npm run coverage:node`", () => {
    const repo = makeFixtureRepo({
      [BASELINE_REL]: JSON.stringify({ ends: { "executor-node": { floor: 88.88 } } }),
      [HEALTH_REL]: JSON.stringify({ steps: [{ label: "executor-python 全量（`python3 -m pytest`）", code: 0, signal: null, summary: { coveragePct: 87.45 } }] }),
    });
    try {
      expectExit(runGuard(HERE, { args: [`--root=${repo.dir}`] }), {
        code: 1, contains: ["executor-node", "拿不到覆盖率数据", "coverage:node"], withinMs: 20000, label: "缺 node 数据",
      });
    } finally { repo.cleanup(); }
  });
  const failed = reportCases(cases, { title: "check-coverage-floor selftest" });
  process.exit(failed === 0 ? 0 : 1);
}

function main(argv) {
  const eq = argv.find((a) => a.startsWith("--root="));
  const errors = check(eq ? resolve(eq.slice("--root=".length)) : REPO_ROOT);
  if (errors.length === 0) {
    console.log(`✔ 覆盖率下限通过（${errors.meta?.ends ?? 0} 端；可上调 ${errors.meta?.hints ?? 0} 处）。`);
    return 0;
  }
  console.error(`✘ 覆盖率下限：${errors.length} 项`);
  for (const e of errors) console.error(`   · ${e}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) {
  process.exit(process.argv.includes("--selftest") ? runSelftest() : main(process.argv.slice(2)));
}
