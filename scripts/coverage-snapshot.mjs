#!/usr/bin/env node
/**
 * R138（2026-11-07）：**单端覆盖率快照** —— 真跑测试 → 读 `json-summary` → 写进 `docs/health-baseline.json`。
 *
 * ## 为什么需要
 * 覆盖率棘轮（`scripts/check-coverage-floor.mjs`）唯一的数据来源是
 * `docs/health-baseline.json` 里各 step 的 `summary.coveragePct`。三端的覆盖率配置、阈值、CI 步骤
 * **早就都开着**（R138 评估实测：admin-api `package.json:136-143`、admin-web `vite.config.ts:274-286`、
 * executor-node `package.json:68-75`），但体检器 `scripts/health-snapshot.mjs` 跑 executor-node 时
 * **没传 `--coverage`** ⇒ 该端从来没有 `coveragePct` ⇒ 棘轮无数据可读。本脚本是那条缺掉的接线，
 * 而且**按端可单独跑**（不必等 30–40 分钟的全量体检）：`npm run coverage:node`。
 *
 * ## 三个不许省的口径
 * ① **必须真跑测试**：`--coverage` 只能来自真实执行；不读上一次留下的文件、不读别处的数字。
 *    故跑之前**先删** `coverage/coverage-summary.json` —— 否则「本次跑挂了但文件是旧的」会
 *    把一个陈旧 pct 当成实测（这正是棘轮最怕的假绿）。
 * ② **只读 `total.lines.pct`（JSON）**：**不解析文本覆盖表格**。表格列宽随数字位数抖动、排版
 *    一改正则就失配 —— 与「基线用 JSON 而不是解析 md」是同一条理由。
 * ③ **合并进既有 step，不重排不丢步**：该 step 的其它字段（suites/tests/exit/…) 原样保留，
 *    整个文件其它内容原样保留；找不到该 step 才**新增**一条，并在 label 里写清来源。
 *
 * ## 失败面（不许静默）
 * · 测试失败（jest exit≠0 / 被信号杀）⇒ **exit 1**，打印实测 exit 与修复建议，**不写** pct
 *   （套件都挂了，覆盖率数字不可信）；
 * · 读不到 `json-summary` / 形状不符 ⇒ **exit 1**，同样打印 exit code 与建议。
 *
 * 用法：
 *   node scripts/coverage-snapshot.mjs --end=executor-node
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(dirname(HERE), "..");
export const HEALTH_REL = "docs/health-baseline.json";

/**
 * 端 → 跑法。`summaryRel` 是**相对端目录**的 json-summary 落点（jest `coverageDirectory`）。
 * 加新端（如 admin-api / admin-web）时**必须**同时给出「真跑测试」的命令与 json-summary 路径，
 * 不许留空壳（空壳会让棘轮读不到数据却以为已经接好了）。
 */
export const ENDS = {
  "executor-node": {
    cwdRel: "apps/executor-node",
    cmd: "npx",
    args: ["jest", "--coverage", "--coverageReporters=json-summary"],
    summaryRel: "coverage/coverage-summary.json",
    metric: "total.lines.pct",
  },
};

/** `docs/health-baseline.json` 里该端 step 的 label 关键词（与 `check-coverage-floor.mjs` 的 END_LABEL_HINTS 同口径）。 */
export const labelHint = (end) => end;

/** 读 jest json-summary 的 `total.lines.pct`。形状失配/读不到 ⇒ `{ pct:null, why }`（不伪装成 0）。 */
export function readLinesPct(abs) {
  if (!existsSync(abs)) return { pct: null, why: `读不到 ${abs}（本次运行没有产出 json-summary）` };
  let json;
  try {
    json = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    return { pct: null, why: `${abs} 不是合法 JSON：${e.message}` };
  }
  const pct = Number(json?.total?.lines?.pct);
  if (!Number.isFinite(pct)) return { pct: null, why: `${abs} 里没有可用的 total.lines.pct（形状失配）` };
  return { pct, why: null };
}

/**
 * 把 pct 合并进 label 含 `hint` 的 step；**保留**该 step 其它字段、**不改**其它 step 的顺序。
 * 找不到 ⇒ 新增一条（label 写明来源）。返回 { step, added }；调用方用它断言「没丢步」。
 */
export function mergeCoveragePct(health, { hint, pct, code, signal, secs }) {
  const steps = Array.isArray(health.steps) ? health.steps : [];
  health.steps = steps;
  const existing = steps.find((s) => String(s?.label ?? "").includes(hint));
  if (existing) {
    existing.summary = { ...(existing.summary ?? {}), coveragePct: pct };
    return { step: existing, added: false };
  }
  const added = {
    label: `${hint} 覆盖率（\`npx jest --coverage --coverageReporters=json-summary\` 的 total.lines.pct，R138 新增）`,
    code,
    signal: signal ?? null,
    summary: { coveragePct: pct },
    secs,
  };
  steps.push(added);
  return { step: added, added: true };
}

/** 失败时把子进程输出落盘（与 health-snapshot 的 artifacts/health-logs 同范式），返回相对路径。 */
function dumpLog(tag, out) {
  try {
    const dir = join(REPO_ROOT, "artifacts", "health-logs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `coverage-${tag}-${Date.now()}.log`);
    writeFileSync(file, out, "utf8");
    return file.replace(`${REPO_ROOT}/`, "");
  } catch {
    return null;
  }
}

function fail(lines) {
  for (const line of lines) process.stderr.write(`${line}\n`);
  return 1;
}

export function main(argv) {
  const eq = argv.find((a) => a.startsWith("--end="));
  const at = argv.indexOf("--end");
  const end = eq ? eq.slice("--end=".length) : at >= 0 && at + 1 < argv.length ? argv[at + 1] : null;
  if (!end) return fail([`✘ 缺 \`--end=<端>\`。已接线的端：${Object.keys(ENDS).join(" / ")}`]);
  const cfg = ENDS[end];
  if (!cfg) return fail([`✘ 端「${end}」尚未接线（本脚本只支持：${Object.keys(ENDS).join(" / ")}）—— 不许假装跑过`]);

  const cwd = join(REPO_ROOT, cfg.cwdRel);
  const summaryAbs = join(cwd, cfg.summaryRel);
  if (!existsSync(cwd)) return fail([`✘ 端目录不存在：${cfg.cwdRel}`]);
  // ① 先删陈旧 summary：否则「本次跑挂 + 文件是上次的」会读出一个陈旧 pct（假绿）。
  try {
    rmSync(summaryAbs, { force: true });
  } catch {
    return fail([`✘ 删不掉陈旧 ${cfg.cwdRel}/${cfg.summaryRel} ⇒ 无法保证读到的是本次实测，拒绝继续`]);
  }

  const t0 = Date.now();
  process.stderr.write(`[coverage] ${end}：${cfg.cmd} ${cfg.args.join(" ")} … `);
  const r = spawnSync(cfg.cmd, cfg.args, {
    cwd,
    encoding: "utf8",
    timeout: 30 * 60_000,
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  });
  const secs = Math.round((Date.now() - t0) / 1000);
  const code = r.status ?? 1;
  const signal = r.signal ?? null;
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  process.stderr.write(signal ? `killed: ${signal}（${secs}s）\n` : `exit ${code}（${secs}s）\n`);

  if (code !== 0 || signal) {
    const log = dumpLog(end, out);
    // 子进程根本没起来（命令不在 PATH / 端目录没装依赖）⇒ 与「测试红了」区分开，否则报文明明写着
    // 「实测 exit 1」而实际一次测试都没跑 —— 那正是本轮要消灭的那种不可信读数。
    const spawnError = r.error ? `；子进程未启动：${r.error.message}` : "";
    return fail([
      `✘ ${end} 覆盖率快照失败：测试套件实测 exit ${code}${signal ? ` signal=${signal}` : ""}${spawnError}（${secs}s）` +
        ` ⇒ **pct 不可信，本次不写入基线**（不许静默）。`,
      `   修法：①先让测试本身绿：\`cd ${cfg.cwdRel} && npx jest\`；②若只是资源问题被信号杀，降并发重跑。`,
      log ? `   完整输出已落盘：${log}` : `   完整输出落盘失败（artifacts/ 不可写），请直接重跑上面的命令。`,
    ]);
  }

  const { pct, why } = readLinesPct(summaryAbs);
  if (pct === null) {
    return fail([
      `✘ ${end}：测试 exit 0 但**读不到覆盖率数据**（${why}）⇒ 不许静默绿。`,
      `   期望文件：${cfg.cwdRel}/${cfg.summaryRel}（jest \`--coverageReporters=json-summary\` 的产物）。`,
      `   修法：①确认 \`${cfg.cmd} ${cfg.args.join(" ")}\` 在本端真能产出该文件；②确认 jest 的 coverageDirectory 未被改到别处。`,
    ]);
  }

  const healthPath = join(REPO_ROOT, HEALTH_REL);
  let health;
  if (existsSync(healthPath)) {
    try {
      health = JSON.parse(readFileSync(healthPath, "utf8"));
    } catch (e) {
      return fail([`✘ ${HEALTH_REL} 不是合法 JSON：${e.message} ⇒ 拒绝覆盖（先修好基线文件）`]);
    }
  } else {
    health = { generatedAt: new Date().toISOString().slice(0, 10), steps: [] };
  }
  const before = Array.isArray(health.steps) ? health.steps.length : 0;
  const { step, added } = mergeCoveragePct(health, { hint: labelHint(end), pct, code, signal: null, secs });
  const after = Array.isArray(health.steps) ? health.steps.length : 0;
  if (after !== before + (added ? 1 : 0)) {
    return fail([`✘ 合并后步数异常（${before} ⇒ ${after}，新增=${added}）—— 「不重排/不丢步」被破坏，拒绝写入`]);
  }
  writeFileSync(healthPath, `${JSON.stringify(health, null, 2)}\n`, "utf8");
  console.log(`✔ ${end} 实测 lines 覆盖率 ${pct}%（来源：真实 json-summary 的 ${cfg.metric}）`);
  console.log(`   · 已写入 ${HEALTH_REL} 的 step「${step.label}」${added ? "（新增，原基线里没有该端的 step）" : "（保留该 step 其它字段）"}；耗时 ${secs}s`);
  return 0;
}

// 只有**直接执行**时才跑 main —— 否则 `import { readLinesPct }` 会连带真跑一次测试（R45 教训）。
const _invokedDirectly = process.argv[1] && resolve(process.argv[1]) === HERE;
if (_invokedDirectly) process.exit(main(process.argv.slice(2)));
