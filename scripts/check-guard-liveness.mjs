#!/usr/bin/env node
/**
 * R73（2026-11-06）：**死判据守卫（V8 运行期覆盖率版）**。
 *
 * ## 为什么不用静态分析
 * R72 试过"剥字符串 + 统计引用"：在含大量正则字面量的脚本上**行号/引用对齐全坏**（83 项误报）。
 * 「从未执行」才是"死判据"的定义 ⇒ **用运行期事实判定**：
 * 对若干 `check-*.mjs` 跑 `NODE_V8_COVERAGE=<tmp> node <script> --selftest`，读 V8 coverage JSON，
 * 找出**顶层函数里 `count === 0`** 的那些（模板字符串/正则统统无关）。
 *
 * ## 覆盖面（2026-11-27 大刀阔斧扩面，不再靠 20 个脚本撑门面）
 * 事实源 = 仓库里**实际存在**的 `scripts/check-*.mjs`（动态列目录），不是手写白名单。
 * 门槛：被 V8 真跑过的脚本数 / 事实源总数 ≥ `MIN_COVERAGE_RATIO`（60%）。
 * 未覆盖的每一个都必须在 `UNCOVERED_REGISTRY` 里逐条给出 `reason + owner + review_by`；
 * 缺一条 / 登记过期 / 已覆盖却还赖在登记表里 ⇒ 红。
 * `LIVENESS_COVERED` 仍可缩小面做探路，但缩到 60% 以下立刻红（自检不再拿 2 个当正例）。
 *
 * ## 判定与豁免
 * · 只看 `functionName` 匹配 `/assert|[Jj]udg|check|verify/i` 的顶层函数（收窄面试探，见 R73 回执）：
 *   这些正是"判据函数"；`main`/钩子等基础设施**不在面内**，不需要豁免条；
 * · 额外豁免：函数体首行含 `// liveness-exempt: <≥12 字理由>`（极少用）。
 *
 * ## 用法
 *   node scripts/check-guard-liveness.mjs [--selftest] [--root=<dir>]
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

printCoverageBanner(import.meta.url, "push");

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(dirname(HERE), "..");
/**
 * 本仓能在这台机器上**快速跑完 selftest 且零误报**的 `check-*` 子集（20 个，实测 ~23s）。
 *
 * ## 未覆盖的 65 个为什么跳过（R84 实测分类，**不许静默**）
 * · **需要 docker / 本地 PG / 外部服务**：`check-compose-*`、`check-race-*`、`check-env-drift` 等；
 * · **需要完整构建产物 / 30s+ 长跑**：`check-desktop-*`、`check-failure-classifiers*`、`check-protocol-*`、`check-cross-end-*`（要跑三端）、`check-guards-wired`；
 * · **本身是本守卫或与之同源**：`check-guard-liveness.mjs` 自身递归跑会翻倍，未纳入。
 * 扩面原则（你定的）：**每加一个必须先验证真仓库零误报**，宁可慢扩。
 */
/** 可用 `LIVENESS_COVERED=a.mjs,b.mjs` 覆盖（扩面探路用；CI 不设置该变量）。 */
export const MIN_COVERAGE_RATIO = 0.6;
export const SELF_SCRIPT = "check-guard-liveness.mjs";

/**
 * 本仓能零依赖、离线、秒级跑完 `--selftest` + 主跑的脚本（2026-11-27 实测候选面）。
 * 这是**覆盖清单**，不是事实源：事实源由 `listGuardScripts()` 动态列目录得到；
 * 清单里的脚本若不再存在会被过滤，并从分母里消失（登记同步回收）。
 */
export const COVERED_DEFAULT = [
  "check-admin-api-lock-consistency.mjs",
  "check-agent-event-causation.mjs",
  "check-agent-event-limits.mjs",
  "check-agent-index-names.mjs",
  "check-agent-stub-fidelity.mjs",
  "check-agent-write-sanitize.mjs",
  "check-alerts-rules.mjs",
  "check-api-error-format.mjs",
  "check-atlas-counts.mjs",
  "check-audit-actions-doc.mjs",
  "check-brand-drift.mjs",
  "check-brand-drift.selftest.mjs",
  "check-categories-single-source.mjs",
  "check-cli-doc-flags.mjs",
  "check-cli-doc.mjs",
  "check-collaborator-self-call.mjs",
  "check-compose-sandbox.mjs",
  "check-compose-service-env.mjs",
  "check-conditional-writes.mjs",
  "check-config-reload-parity.mjs",
  "check-constant-time-compare.mjs",
  "check-consumer-routes.mjs",
  "check-coverage-floor.mjs",
  "check-credential-columns.mjs",
  "check-cron-guard.mjs",
  "check-cron-leader-gate.mjs",
  "check-cross-end-consistency.mjs",
  "check-dependency-review.mjs",
  "check-desktop-agent-packaging.mjs",
  "check-desktop-bundle-drift.mjs",
  "check-desktop-rollback-path.mjs",
  "check-desktop-selftests-wired.mjs",
  "check-desktop-update-chain.mjs",
  "check-destructive-global-commands.mjs",
  "check-enum-consumers.mjs",
  "check-enum-drift.mjs",
  "check-env-drift.mjs",
  "check-env-entry-sweep.mjs",
  "check-env-switch-default-policy.mjs",
  "check-error-i18n.mjs",
  "check-error-migration.mjs",
  "check-examples-code.mjs",
  "check-executor-node-env-hermetic.mjs",
  "check-executor-shell-runtime.mjs",
  "check-failure-classifiers.mjs",
  "check-failure-reasons.mjs",
  "check-handwritten-copies.mjs",
  "check-image-pinned.mjs",
  "check-index-drift.mjs",
  "check-infra-doc-counts.mjs",
  "check-interface-maps.mjs",
  "check-jest-cli-flags.mjs",
  "check-lint-gates.mjs",
  "check-live-probes-intact.mjs",
  "check-live-probes-intact.selftest.mjs",
  "check-live-specs-wired.mjs",
  "check-mcp-error-hints.mjs",
  "check-metric-docs.mjs",
  "check-migration-symmetry.mjs",
  "check-migrations.mjs",
  "check-mutation-residue.mjs",
  "check-no-hoisting.mjs",
  "check-openapi-response-schema.mjs",
  "check-ops-runbook.mjs",
  "check-optional-dep-silent-noop.mjs",
  "check-package-adoption.mjs",
  "check-password-policy-sync.mjs",
  "check-posture-matrix-tables.mjs",
  "check-protocol-breaking.mjs",
  "check-protocol-three-way.mjs",
  "check-publishable-wiring.mjs",
  "check-query-param-required.mjs",
  "check-race-selftests-wired.mjs",
  "check-reserved-slots-consumer.mjs",
  "check-runner-labels.mjs",
  "check-sandbox-limit-order.mjs",
  "check-sanitize-parity.mjs",
  "check-script-main-guard.mjs",
  "check-sdk-docs-truthfulness.mjs",
  "check-selftests-wired.mjs",
  "check-shared-cache-lock.mjs",
  "check-shell-multibyte-var.mjs",
  "check-size-caps.mjs",
  "check-source-text-contracts.mjs",
  "check-spec-coupling-surfaces.mjs",
  "check-ssrf-deny-parity.mjs",
  "check-ssrf-three-way-matrix.mjs",
  "check-template-manifest.mjs",
  "check-throttler-whitelist.mjs",
  "check-typecheck-covers-specs.mjs",
  "check-updatedapp-parity.mjs",
  "check-upgrade-notes.mjs",
  "check-user-facing-language.mjs",
  "check-version-line.mjs",
  "check-web-type-drift.mjs",
  "check-web-type-field-drift.mjs",
  "check-windows-gui-script.mjs",
  "check-workflow-actions-pinned.mjs",
  "check-workflow-yaml.mjs",
];

/** 未覆盖清单：逐条 `reason + owner + review_by`，过期红、腐烂红、已覆盖还赖着红。 */
export const UNCOVERED_REGISTRY = {
  [SELF_SCRIPT]: {
    reason: "自指递归：本守卫若覆盖自己，V8 子进程会再拉起本守卫形成翻倍/死循环",
    owner: "guard-smith",
    review_by: "2099-12-31",
  },
  "check-guards-wired.mjs": {
    reason:
      "互指递归（2026-11-28 事故根因）：wired 的 coverage-registry 也登记了本守卫" +
      "（runGuard 探针），本守卫若再覆盖 wired 就形成 wired→liveness→wired→… 递归对——" +
      "wired main() 176s > wired 对子进程的 120s SIGKILL ⇒ 每次全量跑必杀掉一层" +
      "liveness（SIGKILL 下 finally rmSync 不执行 ⇒ 泄漏一个 acf-live-* 目录 + " +
      "一批孤儿探针进程）。掐断方向：registry 里 liveness 条目已改 args:[--selftest]，" +
      "本侧不再覆盖 wired。",
    owner: "guard-smith",
    review_by: "2027-05-31",
  },
  "check-npm-audit-exemptions.mjs": {
    reason: "主跑需要 npm registry 网络（离线门禁只跑 --selftest，真实审计在 CI npm-audit job）",
    owner: "guard-smith",
    review_by: "2099-12-31",
  },
  "check-release-hygiene.mjs": {
    reason: "主跑需要 GITHUB_TOKEN 与网络，由 release-hygiene.yml 周跑；本地只跑离线 selftest",
    owner: "guard-smith",
    review_by: "2099-12-31",
  },
  "check-callback-contract-drift.mjs": {
    reason: "没有 --selftest 入口且主跑依赖三端生成产物，由 check:callback-contract-drift 单独执行",
    owner: "guard-smith",
    review_by: "2099-12-31",
  },
  "check-failure-classifiers-reverse-proof.mjs": {
    reason: "反向探针脚本（故意构造反例），由 check:failure-classifiers:reverse-proof 单独执行",
    owner: "guard-smith",
    review_by: "2099-12-31",
  },
  "check-release-config.mjs": {
    reason: "V8 实测 checkRepo 判据 count=0（死判据），需业务 owner 接线；不得靠 liveness-exempt 掩盖",
    owner: "guard-smith",
    review_by: "2026-12-31",
  },
};

/** 事实源：实际存在的 `scripts/check-*.mjs`（动态列，不用手写分母）。 */
export function listGuardScripts(root = REPO_ROOT) {
  try {
    return readdirSync(join(root, "scripts"))
      .filter((f) => /^check-.*\.mjs$/.test(f))
      .sort();
  } catch {
    return null;
  }
}

/** 调用时求值：`LIVENESS_COVERED` 可缩小面（自检用），默认 = COVERED_DEFAULT。 */
export function coveredList(root = REPO_ROOT) {
  const envList = (process.env.LIVENESS_COVERED ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const list = envList.length > 0 ? envList : COVERED_DEFAULT;
  return list.filter((f) => existsSync(join(root, "scripts", f)));
}

/** 覆盖面/登记表自洽判据（不跑子进程，供 selftest 与 main 共用）。 */
export function inventoryProblems(root = REPO_ROOT, {
  registry = UNCOVERED_REGISTRY,
  minRatio = MIN_COVERAGE_RATIO,
  minUniverse = 50,
  covered = coveredList(root),
  universe = listGuardScripts(root),
} = {}) {
  const errors = [];
  if (universe === null || universe.length < minUniverse) {
    return [`事实源塌方：scripts/check-*.mjs 只列出 ${universe?.length ?? 0} 个（下界 ${minUniverse}）—— 分母不可信`];
  }
  const universeSet = new Set(universe);
  const coveredSet = new Set(covered);
  const ratio = coveredSet.size / universe.length;
  if (ratio < minRatio) {
    errors.push(
      `覆盖面只有 ${coveredSet.size}/${universe.length}（${(ratio * 100).toFixed(1)}%）< 门槛 ${(minRatio * 100).toFixed(0)}%` +
        `—— 判据面被缩小（LIVENESS_COVERED 或 COVERED_DEFAULT 塌方），不许静默绿`,
    );
  }
  for (const script of universe) {
    if (coveredSet.has(script)) continue;
    const entry = registry?.[script];
    if (!entry) {
      errors.push(`未覆盖且未登记：scripts/${script} —— 逐条补 reason + owner + review_by，或纳入覆盖清单`);
      continue;
    }
    for (const field of ["reason", "owner", "review_by"]) {
      if (typeof entry[field] !== "string" || entry[field].trim().length < (field === "review_by" ? 10 : 6)) {
        errors.push(`未覆盖登记 scripts/${script} 的 ${field} 缺失/过短 —— 无理由的后门不许放行`);
      }
    }
    if (typeof entry.review_by === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.review_by)) {
      if (entry.review_by < new Date().toISOString().slice(0, 10)) {
        errors.push(`未覆盖登记 scripts/${script} 的 review_by=${entry.review_by} 已过期 —— 复核期限已过`);
      }
    }
  }
  for (const [script, entry] of Object.entries(registry ?? {})) {
    if (!universeSet.has(script)) {
      errors.push(`未覆盖登记 ${script} 已无对应脚本（登记腐烂）—— 请回收；entry=${JSON.stringify(entry)}`);
    } else if (coveredSet.has(script)) {
      errors.push(`scripts/${script} 已被覆盖却仍留在未覆盖登记表 —— 登记该回收了`);
    }
  }
  errors.meta = { universe: universe.length, covered: coveredSet.size, ratio };
  return errors;
}

export const JUDGE_NAME_RE = /assert|[Jj]udg|check|verify/i;

function lineOf(src, offset) {
  return src.slice(0, offset).split("\n").length;
}

/** coverage 临时目录的落点：可配置（ACF_COVERAGE_TMPDIR），默认 /dev/shm。
 *  为什么不直接用 tmpdir()：2026-11-28 事故——/tmp 是带 usrquota 的 tmpfs（6.5G），
 *  guard-liveness 全量跑会产生 ~99 个 acf-live-* 目录（每个 60-100M coverage
 *  JSON）。正常 finally 能清；但链 runner 被强杀（SIGKILL/SIGTERM 时 npm→sh→node
 *  子树里 detached 的 liveness 存活成孤儿）或 90s timeout 杀掉子进程时，残留
 *  无人回收，累积到 5.2G 触发 EDQUOT，dsh 的 bash/write 工具全体失效。
 *  /dev/shm 同为 tmpfs 但默认无 usrquota，且同机还有 DSH 工具链写 /tmp——
 *  把 coverage 挪走是单一最有效隔离。脚本不受影响：V8 只要求目录可写。 */
export function coverageTmpRoot() {
  return process.env.ACF_COVERAGE_TMPDIR || "/dev/shm";
}

/** 兜底清扫：把本族残留（超过 maxAgeMs 或全局超预算）按代际删掉。
 *  只删 `acf-live-` 前缀 + 本用户的目录，绝不越界。 */
function sweepStaleLiveDirs(maxAgeMs = 30 * 60_000) {
  const base = coverageTmpRoot();
  try {
    const now = Date.now();
    for (const name of readdirSync(base)) {
      if (!name.startsWith("acf-live-")) continue;
      const abs = join(base, name);
      try {
        if (now - statSync(abs).mtimeMs < maxAgeMs) continue;
        rmSync(abs, { recursive: true, force: true });
      } catch { /* ignore：他人目录/竞态删除 */ }
    }
  } catch { /* base 不可读：结构红会由后续 mkdtemp 失败兜住 */ }
}

/** 跑一个脚本的 selftest 并返回其 coverage 里的"零执行判据函数"。 */
export function deadJudgesIn(root, script) {
  let dir;
  try {
    dir = mkdtempSync(join(coverageTmpRoot(), "acf-live-"));
  } catch {
    // /dev/shm 不可写（容器裁剪等）→ 回落 tmpdir()，并先扫一次陈年残留
    sweepStaleLiveDirs();
    dir = mkdtempSync(join(tmpdir(), "acf-live-"));
  }
  try {
    const abs = join(root, "scripts", script);
    if (!existsSync(abs)) return { skipped: `脚本不存在：${script}` };
    // **两种入口都要跑**：`--selftest` 覆盖自检路径，**不带参数**覆盖 `main()` 路径；
    // 只跑 `--selftest` 会把 `check()` 本身算成 0 执行（R73 实测的假阳），因为它由 `main()` 调用。
    for (const args of [["--selftest"], []]) {
      spawnSync("node", [abs, ...args], {
        cwd: root,
        env: { ...process.env, NODE_V8_COVERAGE: dir },
        encoding: "utf8",
        timeout: 90_000,
      });
    }
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) return { skipped: `没有产出 coverage（可能无 --selftest 或崩溃）` };
    const src = readFileSync(abs, "utf8");
    // **跨多次运行聚合**：`--selftest` 与 `main()` 各产出一份 coverage，
    // 某函数可能只在前者或后者里被执行 ⇒ 必须取**最大值**再判死（R73 实测：只看单次会误报 `check`）。
    const counts = new Map();
    for (const f of files) {
      const cov = JSON.parse(readFileSync(join(dir, f), "utf8"));
      for (const entry of cov.result ?? []) {
        if (!String(entry.url ?? "").endsWith(`/scripts/${script}`)) continue;
        for (const fn of entry.functions ?? []) {
          const name = String(fn.functionName ?? "");
          if (!name || name === "anonymous") continue;
          if (!JUDGE_NAME_RE.test(name)) continue;
          const count = (fn.ranges ?? []).reduce((a, r) => a + (r.count ?? 0), 0);
          const line = lineOf(src, fn.ranges?.[0]?.startOffset ?? 0);
          const prev = counts.get(name);
          counts.set(name, {
            count: Math.max(count, prev?.count ?? 0),
            line: prev?.line ?? line,
          });
        }
      }
    }
    const dead = [...counts.entries()]
      .filter(([, v]) => v.count === 0)
      .map(([name, v]) => ({ name, line: v.line }));
    return { dead };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export function check(root = REPO_ROOT, options = {}) {
  const inventory = inventoryProblems(root, options);
  if (inventory.length > 0) {
    inventory.meta = inventory.meta ?? {};
    inventory.meta.registered = Object.keys(options.registry ?? UNCOVERED_REGISTRY).length;
    return inventory;
  }
  const registry = options.registry ?? UNCOVERED_REGISTRY;
  const errors = [];
  const COVERED = options.covered ?? coveredList(root);
  let covered = 0;
  const skipped = [];
  for (const script of COVERED) {
    const res = deadJudgesIn(root, script);
    if (res.skipped) {
      // 旧实现把它当软跳过 —— 正是「覆盖面 20/104 却报绿」的成因之一。
      errors.push(
        `scripts/${script} 列入覆盖清单却${res.skipped} —— 要么修好入口，要么移入未覆盖登记（带理由）`,
      );
      skipped.push(`${script}：${res.skipped}`);
      continue;
    }
    covered += 1;
    for (const d of res.dead) {
      errors.push(
        `scripts/${script}:${d.line} 判据函数 \`${d.name}\` **在执行期间从未被调用** —— ` +
          `死判据（V8 覆盖率 count=0）。请接线，或在函数体首行写 \`// liveness-exempt: <≥12 字理由>\``,
      );
    }
  }
  if (covered === 0) errors.push(`没有任何脚本产出可用覆盖率 —— 判据面为空（不许静默跳过）`);
  errors.meta = {
    covered,
    skipped,
    universe: inventory.meta.universe,
    ratio: inventory.meta.ratio,
    registered: Object.keys(registry).length,
  };
  return errors;
}

function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try { fn(); } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

/** 造一棵 N 个假 check 脚本的夹具树；covered 之外的进登记表。 */
function livenessFixture({ count = 10, covered = 7, deadAt = -1, expiry = "2099-12-31" } = {}) {
  const names = Array.from({ length: count }, (_, i) => `check-fixture-${i}.mjs`);
  const files = { "package.json": { scripts: {} } };
  names.forEach((name, i) => {
    const body = i === deadAt
      ? `function checkDeadFixture() { return 1; }\nconsole.log("COVERAGE_CASES: 1");\n`
      : `function checkProbeFixture() { return ${i}; }\ncheckProbeFixture();\nconsole.log("COVERAGE_CASES: 1");\n`;
    files[`scripts/${name}`] = body;
  });
  const registry = Object.fromEntries(
    names.slice(covered).map((name) => [name, {
      reason: "fixture 脚本需要外部服务，未纳入 V8 覆盖面",
      owner: "fixture-owner",
      review_by: expiry,
    }]),
  );
  return { names, files, registry };
}

function runSelftest() {
  const cases = [];
  const push = (name, fn) => cases.push({ name, fn });
  const must = (cond, msg) => { if (!cond) throw new Error(msg); };

  push("正例控制组：10 个脚本覆盖 7 个（70%）⇒ 零误报（不再缩到 2 个）", () => {
    const fx = livenessFixture();
    const repo = makeFixtureRepo(fx.files, { prefix: "liveness-fixture-" });
    try {
      withEnv("LIVENESS_COVERED", fx.names.slice(0, 7).join(","), () => {
        const errs = check(repo.dir, { registry: fx.registry, minUniverse: 10 });
        must(errs.length === 0, `期望零误报，实得 ${errs.length} 项：${errs.slice(0, 2).join("；")}`);
      });
    } finally { repo.cleanup(); }
  });

  push("反例①：覆盖面 5/10 = 50% < 60% ⇒ 红", () => {
    const fx = livenessFixture({ covered: 5 });
    const repo = makeFixtureRepo(fx.files, { prefix: "liveness-ratio-" });
    try {
      withEnv("LIVENESS_COVERED", fx.names.slice(0, 5).join(","), () => {
        const errs = check(repo.dir, { registry: fx.registry, minUniverse: 10 });
        must(errs.some((e) => e.includes("覆盖面只有")), `errs=${errs.join("；")}`);
      });
    } finally { repo.cleanup(); }
  });

  push("反例②：未覆盖脚本没写 reason/owner/review_by ⇒ 红", () => {
    const fx = livenessFixture();
    const repo = makeFixtureRepo(fx.files, { prefix: "liveness-signoff-" });
    try {
      withEnv("LIVENESS_COVERED", fx.names.slice(0, 7).join(","), () => {
        const errs = check(repo.dir, { registry: Object.fromEntries(Object.entries(fx.registry).slice(1)), minUniverse: 10 });
        must(errs.some((e) => e.includes("未覆盖且未登记")), `errs=${errs.join("；")}`);
      });
    } finally { repo.cleanup(); }
  });

  push("反例③：登记的 review_by 过期 ⇒ 红（后门不许常青）", () => {
    const fx = livenessFixture({ expiry: "2000-01-01" });
    const repo = makeFixtureRepo(fx.files, { prefix: "liveness-expired-" });
    try {
      withEnv("LIVENESS_COVERED", fx.names.slice(0, 7).join(","), () => {
        const errs = check(repo.dir, { registry: fx.registry, minUniverse: 10 });
        must(errs.some((e) => e.includes("review_by") && e.includes("已过期")), `errs=${errs.join("；")}`);
      });
    } finally { repo.cleanup(); }
  });

  push("反例④：覆盖清单里的判据函数 V8 count=0 ⇒ 红（死判据有牙）", () => {
    const fx = livenessFixture({ deadAt: 0 });
    const repo = makeFixtureRepo(fx.files, { prefix: "liveness-dead-" });
    try {
      withEnv("LIVENESS_COVERED", fx.names.slice(0, 7).join(","), () => {
        const errs = check(repo.dir, { registry: fx.registry, minUniverse: 10 });
        must(errs.some((e) => e.includes("从未被调用")), `errs=${errs.join("；")}`);
      });
    } finally { repo.cleanup(); }
  });

  push("真仓库：默认覆盖面 ≥60%，且未覆盖逐条登记（静态盘点，不缩面）", () => {
    const errs = inventoryProblems(REPO_ROOT);
    must(errs.length === 0, `真仓库盘点红：${errs.slice(0, 3).join("；")}`);
    must(errs.meta.ratio >= MIN_COVERAGE_RATIO, `ratio=${errs.meta.ratio}`);
  });

  push("反例⑤：LIVENESS_COVERED 置空 ⇒ 回落默认清单（空 ≠ 关闭检查）", () => {
    withEnv("LIVENESS_COVERED", "", () => {
      const list = coveredList(REPO_ROOT);
      must(list.length >= 60, `回落清单只有 ${list.length} 个脚本`);
    });
  });

  push("CLI：把覆盖面缩到 2 个 → main exit 1（钉住 process.exit 接线）", () => {
    withEnv("LIVENESS_COVERED", "check-script-main-guard.mjs,check-posture-matrix-tables.mjs", () => {
      expectExit(runGuard(HERE), {
        code: 1,
        contains: ["覆盖面只有"],
        absent: ["死判据守卫通过"],
        withinMs: 5000,
        label: "CLI 覆盖面缩到 2 个",
      });
    });
  });

  const failed = reportCases(cases, { title: "check-guard-liveness selftest" });
  process.exit(failed === 0 ? 0 : 1);
}

function main() {
  const errors = check(REPO_ROOT);
  const meta = errors.meta ?? {};
  if (errors.length === 0) {
    console.log(
      `✔ 死判据守卫通过：${meta.covered}/${meta.universe} 个脚本（${((meta.ratio ?? 0) * 100).toFixed(1)}% ≥ 60%）` +
        `的判据函数在执行期间全部被调用（V8 覆盖率 count>0）；未覆盖登记 ${meta.registered ?? 0} 条。`,
    );
    return 0;
  }
  console.error(`✘ 死判据守卫：${errors.length} 项（覆盖 ${meta.covered ?? 0}/${meta.universe ?? "?"}）`);
  for (const e of errors) console.error(`   · ${e}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) {
  process.exit(process.argv.includes("--selftest") ? runSelftest() : main());
}
