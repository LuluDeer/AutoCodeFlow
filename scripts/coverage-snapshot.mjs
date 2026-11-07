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
 * ## R142（2026-11-06）：扩到 admin-api（第三端）+ **确定性选步**（不许靠「碰巧第一个是我要的」）
 * admin-api 的覆盖率配置与 CI 步骤**早就都开着**（`apps/admin-api/package.json` 的 collectCoverageFrom /
 * coverageDirectory `../coverage` / coverageThreshold.global 76/81/88/87；`.github/workflows/ci.yml` 已在跑
 * `npx jest --coverage --maxWorkers=2`），缺的只是这条接线 ⇒ 该端从来没有 `coveragePct`。
 *
 * 两条硬口径：
 * ① **必须 `--maxWorkers=2`**：本机 12 核 ⇒ 默认起 12 worker，swap 满时会被 SIGTERM（R28 两次实证；
 *    `scripts/health-snapshot.mjs` 的既有注释记的同一件事）。admin-api 全量无 coverage 实测 141s，
 *    插桩系数约 2.2× ⇒ 带 coverage 是分钟级，worker 数不压住就会「跑到一半被杀」。
 * ② **admin-api 还必须带 `--node-options=--experimental-vm-modules`**（与它 `package.json` 的 `test`/`test:cov`
 *    脚本同款）：spec 里 import 了 ESM-only 的包，缺这个 node 选项 ⇒ jest 把 ESM 当 CommonJS ⇒ 全部套件红
 *    （实测 `createRequireEsmError`）。**这不是可选加速项，是能不能跑起来的开关。**
 *    另加 CI 同款的内存三件套（`--max-old-space-size=4096` / `--workerIdleMemoryLimit=1536MB` /
 *    `--retryTimes=2`）：本机 swap 已满，实测缺它们会 **2 个套件 OOM 崩 + 1 个套件断言红**。
 * ③ **选步必须确定**：`docs/health-baseline.json` 里有**两个**含 "admin-api" 的 step：
 *    ① `admin-api 全量（默认环境，\`npm test -- --maxWorkers=2\`）` ← 本端要写的就是它
 *    ② `admin-api 全量（\`SELFTEST_SKIP_ENV_FILE=1\`，夹具干净态）` ← **另一套环境变量**下的另一条测量
 *    旧规则 `steps.find(s => label.includes(hint))` 只取**第一个命中** —— 碰巧取对了，但那不是判据：
 *    换一次手写重排（或新增一条同名步）就会静默写到错的测量上。故本脚本的规则是
 *    `ENDS["admin-api"].select = { includes: "admin-api 全量（默认环境", excludes: ["SELFTEST_SKIP_ENV_FILE"] }`：
 *    **同时**要求 label 含足够特异的子串、且**不含** SELFTEST 标记；命中 **> 1 步 ⇒ exit 1**（绝不猜）。
 *    于是「命中哪一步」是规则推出来的，不是数组顺序碰出来的。
 *    （`scripts/check-coverage-floor.mjs` 的 `END_LABEL_HINTS` / `END_LABEL_EXCLUDES` 是同一套规则。）
 *
 * 用法：
 *   node scripts/coverage-snapshot.mjs --end=executor-node   # 或 `--end=admin-api`（= `npm run coverage:api`）
 *
 * ## R143：本文件的 `ENDS` 是**单一事实源**（全量体检也 import 它）
 * `scripts/health-snapshot.mjs` 的 admin-api 默认环境步**不再是第二份内联命令** —— 它直接
 * `import { ENDS }` 取 `ENDS["admin-api"]` 的 `cmd/args/cwdRel/summaryRel` 与本文件的
 * `labelHint`/`labelExclude`。改这里的 args（ESM 开关 / 内存参数 / worker 数）或 summary 落点，
 * 全量体检自动同口径；**不要**在 `health-snapshot.mjs` 里再抄一份（两份副本迟早漂移）。
 * 同理，`select` 规则与 `check-coverage-floor.mjs` 的 `END_LABEL_HINTS`/`END_LABEL_EXCLUDES`
 * 是同一套（三处头注互指）：改 label 契约必须同批改三侧。
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
    // executor-node 只有一个 step 含该 label ⇒ 默认 hint（=端名）够用；仍走同一条 selectStep 规则。
    select: { includes: "executor-node", excludes: [] },
  },
  // R142：admin-api（第三端）。**必须 `--maxWorkers=2`**（12 worker 会被 SIGTERM，见头注）；
  // json-summary 落点是 jest `coverageDirectory: "../coverage"`（相对 rootDir=`src`）⇒ `apps/admin-api/coverage/`。
  //
  // ⚠ **必须带 `--node-options=--experimental-vm-modules`**（与 `apps/admin-api/package.json` 的
  // `test`/`test:cov` 脚本同款）：admin-api 的 spec 里 import 了 ESM-only 的包（如 `faker`），
  // 少了这个 node 选项 jest 会把 ESM 语法当 CommonJS 直接报错 ⇒ **全部套件失败**（实测：
  // `createRequireEsmError`，1 个套件就红）。这不是「可选加速项」，是能不能跑起来的开关。
  //
  // ⚠ **内存三件套必须与 CI 一致**（`--max-old-space-size=4096` / `--workerIdleMemoryLimit=1536MB`
  // / `--retryTimes=2`）：本机 swap 已 100% 满（8G 全用），插桩后 worker 堆涨 ⇒ 实测
  // **2 个套件 "Jest worker ran out of memory and crashed"**（`executor-register-columns.collaborator`
  // / `create-projects.migration`）+ 1 个套件断言红（`health.service.spec.ts` 的「healthy path」
  // 期望 healthy 实得 degraded —— 堆水位检查算出的 `heapUsedPercent` 越过 85% 的 degraded 阈值）。
  // CI（`.github/workflows/ci.yml` 的 admin-api-coverage job）跑的就是这三个参数 ⇒ 本脚本与 CI 同口径，
  // 不自造一套「本地更宽松」的参数（那会得到一个 CI 复现不了的数字）。
  "admin-api": {
    cwdRel: "apps/admin-api",
    cmd: "npx",
    args: [
      "--node-options=--max-old-space-size=4096 --experimental-vm-modules",
      "jest",
      "--coverage",
      "--coverageReporters=json-summary",
      "--maxWorkers=2",
      "--workerIdleMemoryLimit=1536MB",
      "--retryTimes=2",
    ],
    summaryRel: "coverage/coverage-summary.json",
    metric: "total.lines.pct",
    // 双 step 陷阱（头注 R142 ②）：**默认环境**那步 = 含特异子串 且 不含 SELFTEST 标记。命中多个 ⇒ 拒绝写。
    select: { includes: "admin-api 全量（默认环境", excludes: ["SELFTEST_SKIP_ENV_FILE"] },
  },
};

/** `docs/health-baseline.json` 里该端 step 的 label 关键词（与 `check-coverage-floor.mjs` 的 END_LABEL_HINTS 同口径）。 */
export const labelHint = (end) => ENDS[end]?.select?.includes ?? end;

/** 与 `labelHint` 配对的**排除**子串（默认环境步 vs `SELFTEST_SKIP_ENV_FILE` 夹具态步的判别式）。 */
export const labelExclude = (end) => ENDS[end]?.select?.excludes ?? [];

/**
 * 按 `{ includes, excludes }` **确定性**挑出该端的 step —— 返回**全部**候选（调用方据此断唯一性）。
 *
 * 为什么返回数组而不是一个：命中 0 步要「新增」、命中 1 步要「合并」、命中 >1 步必须**拒绝**
 * （两条测量都自称是默认环境 ⇒ 选谁都是猜，而猜错会静默把另一套环境变量的数字当成默认环境）。
 */
export function selectStep(steps, { includes, excludes = [] }) {
  return (Array.isArray(steps) ? steps : []).filter((s) => {
    const label = String(s?.label ?? "");
    return label.includes(includes) && !excludes.some((x) => label.includes(x));
  });
}

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
 * 把 pct 合并进按 `{ hint, exclude }` **确定性**选中的 step；**保留**该 step 其它字段、
 * **不改**其它 step 的顺序。找不到 ⇒ 新增一条（label 写明来源）。
 *
 * 返回 `{ step, added, candidates }`：`candidates.length > 1` 时 `step` 为 `null`（歧义 ⇒ 调用方必须 exit 1）。
 */
export function mergeCoveragePct(health, { hint, exclude = [], pct, code, signal, secs }) {
  const steps = Array.isArray(health.steps) ? health.steps : [];
  health.steps = steps;
  const candidates = selectStep(steps, { includes: hint, excludes: exclude });
  if (candidates.length > 1) return { step: null, added: false, candidates };
  const existing = candidates[0];
  if (existing) {
    existing.summary = { ...(existing.summary ?? {}), coveragePct: pct };
    return { step: existing, added: false, candidates };
  }
  const added = {
    label: `${hint} 覆盖率（\`npx jest --coverage --coverageReporters=json-summary\` 的 total.lines.pct，R138 新增）`,
    code,
    signal: signal ?? null,
    summary: { coveragePct: pct },
    secs,
  };
  steps.push(added);
  return { step: added, added: true, candidates };
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
  const hint = labelHint(end);
  const exclude = labelExclude(end);
  const { step, added, candidates } = mergeCoveragePct(health, { hint, exclude, pct, code, signal: null, secs });
  // 选步必须唯一（头注 R142 ②）：命中多步 ⇒ 选谁都是猜，而猜错会把另一套环境变量的测量当成默认环境。
  if (!step) {
    return fail([
      `✘ ${end}：**选步规则命中 ${candidates.length} 步，拒绝写入**（提示词「${hint}」/ 排除「${exclude.join("、") || "无"}」）⇒ 不许猜：`,
      ...candidates.map((c) => `   · ${JSON.stringify(String(c?.label ?? ""))}`),
      `   修法：把「默认环境」那步的 label 改得更特异，或把另一条也加进 \`ENDS["${end}"].select.excludes\`。`,
    ]);
  }
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
