#!/usr/bin/env node
/**
 * R31（2026-11-05）：**全仓健康基线**重建器 —— 一条命令跑完四端全量 + 全链 + 度量，产出可重复基线。
 *
 * ## 为什么需要
 * 近 30 轮我们只**单独**跑过各 app 全量（R24 web/python/node、R28 admin-api 两态），
 * **从没有一次「四端 + 全链 + 度量」的合并基线**。没有基线，后续任何退步都看不出来。
 *
 * ## 每一步都记**真实 exit code**
 * 不用「第 N 步跑完就假定前面都对」；每一步的 `exit` 与关键数字都来自子进程的真实输出
 * （从汇总行正则提取），跑不动就写「未测 + 原因」，**绝不填预期值**（R27 教训㊽）。
 *
 * ## 关键工程约束
 * · admin-api 全量必须 `--maxWorkers=2`：默认按 12 核起 worker，本机 swap 已满 ⇒ 两次被 SIGTERM（R28）；
 * · 本脚本**不进** `test:guards:chain`：全量要 30–40 分钟，把链从 13 分钟变成 45 分钟等于毁掉
 *   「提交前跑一遍」的可用性（链是每次改动都要跑的，全量是周期性的）。故只作 `npm run health:snapshot`。
 *
 * ## 用法
 *   node scripts/health-snapshot.mjs                  # 跑全部（约 30–40 分钟）
 *   node scripts/health-snapshot.mjs --skip-heavy     # 只跑度量 + 写骨架（秒级，用于自检脚本本身）
 *   node scripts/health-snapshot.mjs --only=metrics   # 同上，更明确
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const OUT = join(ROOT, "docs/health-baseline.md");
/**
 * 机器可读基线（**入库**，与 md 同级）。
 *
 * 为什么读这份而不是解析 md：md 是给人看的，排版会变（加列/换措辞都会让正则失配）；
 * JSON 是稳定、可 diff 的比较源。为什么不用 `artifacts/health-baseline.prev.json`：
 * `artifacts/` 在 `.gitignore` 里 —— 换个 clone/CI 就没有"上次"，比较能力等于没落地。
 */
const OUT_JSON = join(ROOT, "docs/health-baseline.json");
const argv = process.argv.slice(2);
const SKIP_HEAVY = argv.includes("--skip-heavy") || argv.includes("--only=metrics");
const TODAY = new Date().toISOString().slice(0, 10);

/** 跑一条命令，返回 { code, out, ms }。不抛错——失败也要留证据。 */
function run(label, cmd, args, opts = {}) {
  const t0 = Date.now();
  process.stderr.write(`[health] ${label} … `);
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 60 * 60_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  const ms = Date.now() - t0;
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const code = r.status ?? 1;
  process.stderr.write(`exit ${code}（${Math.round(ms / 1000)}s）\n`);
  return { code, out, ms };
}

/** 从 jest 输出里取汇总行。 */
function jestSummary(out) {
  const suites = out.match(/Test Suites:\s*(\d+) failed,\s*(\d+) passed,\s*(\d+) total/) ??
    out.match(/Test Suites:\s*(\d+) passed,\s*(\d+) total/);
  const tests = out.match(/Tests:\s*(?:([\d,]+) failed,\s*)?(?:([\d,]+) skipped,\s*)?([\d,]+) passed,\s*([\d,]+) total/);
  return {
    suitesPassed: suites ? Number(suites[suites.length - 2] ?? suites[1]) : null,
    suitesTotal: suites ? Number(suites[suites.length - 1]) : null,
    testsPassed: tests ? Number(tests[3].replace(/,/g, "")) : null,
    testsFailed: tests ? Number((tests[1] ?? "0").replace(/,/g, "")) : null,
    testsSkipped: tests && tests[2] ? Number(tests[2].replace(/,/g, "")) : 0,
    testsTotal: tests ? Number(tests[4].replace(/,/g, "")) : null,
  };
}

/** 从 pytest 输出里取汇总（passed/skipped）。 */
function pytestSummary(out) {
  const m = out.match(/([\d,]+) passed(?:, ([\d,]+) skipped)?[^\n]* in [\d.]+s/);
  return m ? { passed: Number(m[1].replace(/,/g, "")), skipped: m[2] ? Number(m[2].replace(/,/g, "")) : 0 } : { passed: null, skipped: null };
}

/** 从 vitest 输出里取汇总。 */
function vitestSummary(out) {
  const m = out.match(/Tests\s+(\d+) passed(?:\s*\|\s*(\d+) skipped)?\s*\((\d+)\)/);
  return m ? { passed: Number(m[1]), skipped: m[2] ? Number(m[2]) : 0, total: Number(m[3]) } : { passed: null, skipped: null, total: null };
}

/** 度量（不跑测试，纯静态）。 */
function collectMetrics() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const chain = pkg.scripts["test:guards:chain"] ?? "";
  const segments = chain.split("&&").map((s) => s.trim()).filter(Boolean).length;

  const gapsPath = join(ROOT, "scripts/env-switch-known-gaps.json");
  const gaps = existsSync(gapsPath)
    ? (JSON.parse(readFileSync(gapsPath, "utf8")).gaps ?? []).length
    : 0;

  const playbook = readFileSync(join(ROOT, "docs/AGENT-SWARM-PLAYBOOK.md"), "utf8");
  const blocked = (playbook.match(/记 blocked|记 \*\*blocked\*\*/g) ?? []).length;

  const sizePath = join(ROOT, "scripts/source-size-baseline.json");
  const sizeBase = JSON.parse(readFileSync(sizePath, "utf8"));
  // 体量棘轮的实际条目 = `files`/`entries` 里的条目数（顶层还有 version/why 之类的元键，不能拿顶层键数冒充）
  const sizeEntries = Object.keys(sizeBase.files ?? sizeBase.entries ?? {}).length;

  const migDir = join(ROOT, "apps/admin-api/src/migrations");
  const migrations = readdirSync(migDir).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".spec.ts") && !f.endsWith(".d.ts"),
  ).length;

  return { segments, gaps, blocked, sizeEntries, migrations };
}

/** 读上次基线（不存在 ⇒ null = 首份）。 */
function readPrev() {
  if (!existsSync(OUT_JSON)) return null;
  try {
    return JSON.parse(readFileSync(OUT_JSON, "utf8"));
  } catch {
    return null; // 坏文件按"首份"处理，但会在自检里提示（不阻塞重建）
  }
}

/** 差值展示：+N / −N / —（两边都无值或相等时为 —）。 */
function delta(now, prev) {
  if (now === null || now === undefined) return "—";
  if (prev === null || prev === undefined) return "（无上次值）";
  const d = Number(now) - Number(prev);
  if (Number.isNaN(d)) return "—";
  if (d === 0) return "—";
  return d > 0 ? `+${d}` : `−${Math.abs(d)}`;
}

function main() {
  const steps = [];
  const metrics = collectMetrics();

  if (!SKIP_HEAVY) {
    // admin-api 两态（R28：必须 --maxWorkers=2，否则默认 12 worker 在本机会被 SIGTERM）
    const apiDefault = run("admin-api 全量（默认环境）", "npm", ["test", "--", "--maxWorkers=2"], { cwd: join(ROOT, "apps/admin-api") });
    steps.push({ label: "admin-api 全量（默认环境，`npm test -- --maxWorkers=2`）", code: apiDefault.code, summary: jestSummary(apiDefault.out), secs: Math.round(apiDefault.ms / 1000) });

    const apiSwitch = run("admin-api 全量（SELFTEST_SKIP_ENV_FILE=1）", "npm", ["test", "--", "--maxWorkers=2"], {
      cwd: join(ROOT, "apps/admin-api"),
      env: { SELFTEST_SKIP_ENV_FILE: "1" },
    });
    steps.push({ label: "admin-api 全量（`SELFTEST_SKIP_ENV_FILE=1`，夹具干净态）", code: apiSwitch.code, summary: jestSummary(apiSwitch.out), secs: Math.round(apiSwitch.ms / 1000) });

    const web = run("admin-web 全量", "npx", ["vitest", "run"], { cwd: join(ROOT, "apps/admin-web") });
    steps.push({ label: "admin-web 全量（`npx vitest run`）", code: web.code, summary: vitestSummary(web.out), secs: Math.round(web.ms / 1000) });

    const node = run("executor-node 全量", "npm", ["test"], { cwd: join(ROOT, "apps/executor-node") });
    steps.push({ label: "executor-node 全量（`npm test`）", code: node.code, summary: jestSummary(node.out), secs: Math.round(node.ms / 1000) });

    const py = run("executor-python 全量", "python3", ["-m", "pytest", "-q"], { cwd: join(ROOT, "apps/executor-python") });
    // 本仓 pytest 配置下**不打印** "N passed" 汇总行（实测：末尾是 coverage 表）⇒ 汇总只靠 exit code 权威；
    // 用例规模用 `--collect-only`（秒级）取"收集数"，写进基线时明确标注这一点（不许把收集数说成通过数）。
    const pyCollect = run("executor-python 收集数", "python3", ["-m", "pytest", "--collect-only", "-q", "--no-cov"], {
      cwd: join(ROOT, "apps/executor-python"),
    });
    const collected = (pyCollect.out.match(/^tests\/.*:\s*(\d+)$/gm) ?? [])
      .map((l) => Number(l.split(":").pop().trim()))
      .reduce((a, b) => a + b, 0);
    const cov = (py.out.match(/Total coverage:\s*([\d.]+)%/) ?? [])[1] ?? null;
    steps.push({
      label: "executor-python 全量（`python3 -m pytest -q`）",
      code: py.code,
      summary: { collected: collected || null, coveragePct: cov ? Number(cov) : null },
      secs: Math.round(py.ms / 1000),
    });

    const chain = run("全链 guards:repo", "npm", ["run", "test:guards:repo"]);
    const chainSelf = chain.out.match(/解析 (\d+) 段 \/ 执行 (\d+) 段 \/ diff (空|非空)/);
    steps.push({
      label: "全链 `npm run test:guards:repo`",
      code: chain.code,
      summary: { parsed: chainSelf ? Number(chainSelf[1]) : null, executed: chainSelf ? Number(chainSelf[2]) : null, diff: chainSelf ? chainSelf[3] : null },
      secs: Math.round(chain.ms / 1000),
    });
  }

  const prev = readPrev();
  // `--skip-heavy`：不跑全量，但**必须沿用**上次的全量结果（并在文件里显著标注"沿用"），
  // 否则每次只重建度量都会把全量数字擦空 —— 那等于把基线弄坏（R32 首版正是这样，被自检抓到）。
  const effectiveSteps = steps.length > 0 ? steps : (prev?.steps ?? []);
  const reused = steps.length === 0 && (prev?.steps?.length ?? 0) > 0;
  writeBaseline({ steps: effectiveSteps, metrics, prev, reused });
  // 写**effectiveSteps**（--skip-heavy 时是沿用的上次全量结果）—— 写空 steps 会把可复用的全量数据擦掉
  writeFileSync(
    OUT_JSON,
    `${JSON.stringify({ generatedAt: TODAY, steps: effectiveSteps, metrics }, null, 2)}\n`,
    "utf8",
  );
  const selfCheckErrors = verifyOutputs({ hadPrev: prev !== null });
  if (selfCheckErrors.length > 0) {
    for (const e of selfCheckErrors) process.stderr.write(`[health] 自检失败：${e}\n`);
    return 1;
  }
  return effectiveSteps.some((s) => s.code !== 0) ? 1 : 0;
}

function writeBaseline({ steps, metrics, prev, reused = false }) {
  const cell = (v) => (v === null || v === undefined ? "未测" : String(v));
  const lines = [];
  lines.push("# 全仓健康基线（health baseline）");
  lines.push("");
  lines.push(`> 最后更新：${TODAY}（由 \`npm run health:snapshot\` 生成，**不要手改数字**）`);
  lines.push("");
  lines.push("本文件是**可重复**的全仓健康基线：四端全量 + 全链 + 度量，**每一步都记录真实 exit code**。");
  lines.push("判据是「与上一次基线相比没有退步」，而不是「某个数字好看」。");
  lines.push("");
  lines.push("## 用法");
  lines.push("");
  lines.push("```bash");
  lines.push("npm run health:snapshot            # 全量重建（约 30–40 分钟）");
  lines.push("npm run health:snapshot -- --skip-heavy   # 只重建度量段（秒级）");
  lines.push("```");
  lines.push("");
  lines.push("## 全量结果");
  lines.push("");
  if (steps.length === 0) {
    lines.push("| 检查项 | exit | 关键数字 | 耗时 |");
    lines.push("|---|---|---|---|");
    lines.push("| （本次以 `--skip-heavy` 运行，未跑全量） | — | — | — |");
  } else {
    lines.push("| 检查项 | exit | 关键数字 | 耗时 |");
    lines.push("|---|---|---|---|");
    for (const s of steps) {
      const num = Object.entries(s.summary ?? {})
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `${k}=${v}`)
        .join(" / ");
      lines.push(`| ${s.label} | **${s.code}** | ${num || "—"} | ${s.secs}s |`);
    }
  }
  if (reused) {
    lines.push("");
    lines.push(
      `> ⚠️ **全量数字沿用上次基线**（\`${prev?.generatedAt ?? "?"}\`）：本次以 \`--skip-heavy\` 运行，**没有重跑**四端全量。`,
    );
  }
  lines.push("");
  lines.push(
    "> **python 项的 `collected` 是「收集数」，不是通过数**：本仓 pytest 配置下不打印 `N passed` 汇总行（末尾是 coverage 表），" +
      "所以「是否全过」以 `exit` 为权威、规模用 `--collect-only` 的收集数表示。**不要**把它当通过数用于对比（那会让 +N 看起来像新增通过用例）。",
  );
  lines.push("");
  lines.push("## 度量（静态，不跑测试）");
  lines.push("");
  lines.push("| 指标 | 值 | 说明 |");
  lines.push("|---|---|---|");
  lines.push(`| 守卫链段数（\`test:guards:chain\` 按 \`&&\` 切分） | **${metrics.segments}** | 链的每一段都会被执行，矩阵入口逐条报告 |`);
  lines.push(`| \`scripts/env-switch-known-gaps.json\` 条目数 | **${metrics.gaps}** | 约定缺口；**应为 0**（非 0 即有登记的技术债） |`);
  lines.push(`| blocked 条目数（PLAYBOOK 内「记 blocked」） | **${metrics.blocked}** | 已正式登记为阻塞的立项数 |`);
  lines.push(`| \`source-size-baseline.json\` 登记条目 | **${metrics.sizeEntries}** | 体量棘轮逐文件登记数（\`files\` 键下的条目） |`);
  lines.push(`| 迁移文件数（\`apps/admin-api/src/migrations/*.ts\`，不含 spec） | **${metrics.migrations}** | 由 \`check:migrations\` 守着注册表 |`);
  lines.push("");
  lines.push("## 与上次基线对比");
  lines.push("");
  if (!prev) {
    lines.push("**首份基线，无可比项**（`docs/health-baseline.json` 尚不存在；下一次重建会自动产出对比列）。");
  } else {
    lines.push(`上次基线生成于 \`${prev.generatedAt ?? "（未知日期）"}\`（读 \`docs/health-baseline.json\`）。`);
    lines.push("");
    lines.push("| 指标 | 上次 | 本次 | 差值 |");
    lines.push("|---|---|---|---|");
    const prevSteps = new Map((prev.steps ?? []).map((x) => [x.label, x]));
    for (const s of steps) {
      const p = prevSteps.get(s.label);
      const pick = (k) => {
        const mine = s.summary?.[k];
        if (mine === undefined) return [null, null];
        return [mine, p?.summary?.[k] ?? null];
      };
      for (const key of ["testsPassed", "suitesTotal", "passed", "collected", "parsed"]) {
        const [now, was] = pick(key);
        if (now === null) continue;
        lines.push(`| ${s.label} · ${key} | ${was ?? "（无）"} | ${now} | ${delta(now, was)} |`);
      }
      lines.push(`| ${s.label} · exit | ${p?.code ?? "（无）"} | ${s.code} | ${delta(s.code, p?.code)} |`);
    }
    const pm = prev.metrics ?? {};
    for (const key of ["segments", "gaps", "blocked", "sizeEntries", "migrations"]) {
      lines.push(`| 度量 · ${key} | ${pm[key] ?? "（无）"} | ${metrics[key]} | ${delta(metrics[key], pm[key])} |`);
    }
  }
  lines.push("");
  lines.push("## 已知限制");
  lines.push("");
  lines.push("- **admin-api 全量必须 `--maxWorkers=2`**：默认按 CPU 核数起 worker（本机 12），swap 已满时会被 SIGTERM（R28 实测）；");
  lines.push("- 本脚本**不在** `test:guards:chain` 里：全量 30–40 分钟，接进链会让「提交前跑一遍」不可用（链 13 分钟用途不同）；");
  lines.push("- 跑不动的一端写「未测」+ 原因，**不许**用历史数字冒充满血当前（R27 教训㊽）。");
  lines.push("");
  writeFileSync(OUT, lines.join("\n"), "utf8");
  process.stderr.write(`[health] 基线已写入 ${OUT.replace(ROOT + "/", "")}\n`);
}

/**
 * 产物自检（R32）：把两条"文档纪律"变成**脚本内的硬断言**，删除即红。
 * ① 对比段必须存在（首份也要有「首份基线」字样）；
 * ② python 项的**收集数语义标注**必须存在 —— 防止将来被误读成"通过数"（那会让 +N 看起来像新增通过用例）。
 */
function verifyOutputs({ hadPrev }) {
  if (!existsSync(OUT)) return ["基线文件未生成"];
  const text = readFileSync(OUT, "utf8");
  const errors = [];
  if (!text.includes("## 与上次基线对比")) errors.push("缺少「## 与上次基线对比」段（对比能力被删？）");
  if (!hadPrev && !text.includes("首份基线，无可比项")) {
    errors.push("首份基线时必须写「首份基线，无可比项」（而不是空段/报错）");
  }
  if (hadPrev && !/\|\s*\+\d+|\|\s*−\d+|\|\s*—\s*\|/.test(text)) {
    errors.push("有上次基线时，对比段必须出现 +N / −N / — 形式的差值");
  }
  if (!/收集数/.test(text)) {
    errors.push(
      "python 项必须显式标注「收集数」——本仓 pytest 不打印 N passed 汇总行，收集数 **不是** 通过数",
    );
  }
  return errors;
}

process.exit(main());

