#!/usr/bin/env node
/**
 * failureReason 分类器的**单轨守卫**：
 * 把生成物行为、三端 wrapper 接线与审计向量作为唯一判据。
 *
 * ## 它判什么（按顺序）
 *
 * ① **生成物行为**：真跑 `packages/contract-fixtures/generated/failure-classifier.{mjs,py}`
 *    与 `contract.json` 的 `failureClassification.vectors`，比对 node/python 两侧结果、
 *    契约 `expected` 与重叠域一致（executor 非 null 时必须等于 admin）。
 *
 * ② **审计向量**：生成物规则表（id/order/code/appliesTo）逐条对齐 protocol.json，
 *    fallback 对齐 `executor: null` / `admin: unknown`；禁用构造扫描仍只作用于规则体。
 *
 * ③ **三端 wrapper 接线**：admin / node / python 必须 import 并调用生成物，绝不再持有
 *    手写分类器规则；executor 阶段 null/None 让位，callback 省略 failureReason；
 *    bwrap 启动失败仍走独立日志入口；admin 的 errorCode / no-match / exitCode 三条
 *    非文本判据仍成立且相对生成物的先后次序不变。
 *
 * ④ **D-13 单源无漂移**：重跑生成器应逐字一致；node 两份生成物行为等价；
 *    admin 生成物与守卫 .mjs 行为等价；python 两份生成物逐字节一致。
 *
 * ⑤ **差异登记**：收敛后的 `divergenceRegistry` 只保留**仍真实存在**的非文本/能力差异，
 *    每条都有 owner/review_by/why + 可证 evidence；证据消失即红，基线消失/新增也红。
 *
 * ⑥ **D-16 消费声明**：protocol.json 的 `failureReason.xConsumption` 必须与真实消费面
 *    一致（单轨后是 runtime），且 note 必须点名三端 wrapper 消费点。
 *
 * 用法：
 *   node scripts/check-failure-classifiers.mjs [--selftest] [--report] [--root <dir>]
 */

import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";
printCoverageBanner(import.meta.url, "run");

import {
  compareEntry,
  readRatchetBaseline,
  renderExpired,
  utcDay,
} from "./lib/ratchet-baseline.mjs";

export const PROTOCOL_REL = "packages/executor-protocol/protocol.json";
export const FIXTURES_REL = "packages/contract-fixtures/contract.json";
export const BASELINE_REL = "scripts/failure-classifier-divergence-baseline.json";
export const GEN_MJS_REL = "packages/contract-fixtures/generated/failure-classifier.mjs";
export const GEN_PY_REL = "packages/contract-fixtures/generated/failure-classifier.py";

export const ADMIN_WRAPPER_REL =
  "apps/admin-api/src/common/failure-classification/failure-patterns.ts";
export const NODE_WRAPPER_REL = "apps/executor-node/src/routes/execute.ts";
export const PY_WRAPPER_REL = "apps/executor-python/routers/execute.py";

export const ADMIN_GEN_REL =
  "apps/admin-api/src/common/failure-classification/generated/failure-classifier.ts";
export const NODE_GEN_REL = "apps/executor-node/src/generated/failure-classifier.ts";
export const PY_GEN_REL = "apps/executor-python/generated/failure_classifier.py";
export const GENERATOR_REL = "scripts/generate-failure-classifiers.mjs";
export const GUARD_PROBE_REL = "packages/contract-fixtures/generated/.__guard_probe.py";

/** 三端 wrapper 消费声明的核对面。 */
export const SEGMENT_DERIVED_ARTIFACTS = {
  schemas: ["generated/protocol.schemas", "generated/protocol_schemas"],
  failureReason: [
    "generated/failure-classifier",
    "generated/failure_classifier",
    "generated.failure_classifier",
  ],
};

/** 派生产物自身不算消费者（它就是契约的展开）。 */
export const DERIVED_ARTIFACT_FILES = [
  ADMIN_GEN_REL,
  NODE_GEN_REL,
  PY_GEN_REL,
  GEN_MJS_REL,
  GEN_PY_REL,
  "apps/executor-node/src/generated/protocol.schemas.ts",
  "apps/executor-python/generated/protocol_schemas.py",
];

export const DIRECT_PROTOCOL_READ_PATTERNS = [
  /readFileSync\([^)]*protocol\.json/i,
  /require\([^)]*protocol\.json/i,
  /import\s+[^;]*from\s+["'][^"']*protocol\.json/i,
];

export const NON_RUNTIME_FILES = [
  "package.json",
  FIXTURES_REL,
  "packages/executor-protocol/device-identity.vectors.json",
  GEN_MJS_REL,
  GEN_PY_REL,
];

export const SPEC_PATH_MARKERS = [
  ".spec.",
  ".test.",
  "__tests__",
  "/tests/",
  "test_",
  "_test.py",
];

/** 旧手写分类器常量：单轨后任何一个回来都说明 wrapper 退回了第二事实源。 */
const RETIRED_HANDWRITTEN_RULES = [
  "SCRIPT_ERROR_PATTERN",
  "PACKAGE_FETCH_PATTERN",
  "GIT_FETCH_PATTERN",
  "DEPENDENCY_INSTALL_PATTERN",
  "RUNTIME_MISSING_PATTERN",
  "SANDBOX_UNAVAILABLE_PATTERN",
];

const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

const readText = (abs) => {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
};

function readJson(abs) {
  const text = readText(abs);
  if (text === null) return { error: `读不到 ${abs}` };
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: `${abs} 不是合法 JSON（${error.message}）` };
  }
}

const countMatches = (src, re) => [...String(src).matchAll(re)].length;

// ── 通用工具 ────────────────────────────────────────────────────────────────

export function listSourceFiles(root) {
  const skip = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".codegraph", "coverage"]);
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.(ts|tsx|js|mjs|py|json|ya?ml)$/.test(e.name)) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

export function isSpecFile(rel) {
  const base = rel.split("/").pop() ?? "";
  return SPEC_PATH_MARKERS.some((m) => rel.includes(m) || base.includes(m));
}

/** D-16：逐段核对 `xConsumption` 声明与实际消费面。 */
export function auditSegmentConsumption(root, protocol) {
  const files = listSourceFiles(root);
  const segments = Object.keys(protocol).filter((k) => !k.startsWith("$"));
  const declared = {};
  const actual = {};
  for (const seg of segments) declared[seg] = protocol[seg]?.xConsumption ?? null;

  for (const seg of segments) {
    perSegment: {
      const hits = [];
      const anchors = SEGMENT_DERIVED_ARTIFACTS[seg] ?? [];
      for (const f of files) {
        const rel = f.replace(root + "/", "");
        if (rel === PROTOCOL_REL) continue;
        if (DERIVED_ARTIFACT_FILES.includes(rel)) continue;
        if (NON_RUNTIME_FILES.includes(rel)) continue;
        if (rel.startsWith("scripts/")) continue;
        let src;
        try {
          src = readFileSync(f, "utf8");
        } catch {
          continue;
        }
        const derivedHit = anchors.some((a) => src.includes(a));
        const directHit = DIRECT_PROTOCOL_READ_PATTERNS.some((re) => re.test(src));
        if (!(derivedHit || directHit) || isSpecFile(rel)) continue;
        hits.push(rel);
      }
      actual[seg] = hits;
      break perSegment;
    }
  }

  const mismatches = [];
  // 本守卫只负责 failureReason 分类器与 selftest 钉住的 schemas 消费声明；
  // 其他协议段（timeout/networkPolicy/...）由 protocol-three-way 等守卫负责，
  // 不应因为本守卫没有它们的消费点锚点而误红。
  const CHECKED_SEGMENTS = new Set(["failureReason", "schemas"]);
  for (const seg of segments) {
    if (!CHECKED_SEGMENTS.has(seg)) continue;
    const d = declared[seg];
    const hasRuntime = actual[seg].length > 0;
    if (d === null) {
      mismatches.push({ seg, declared: d, actual: actual[seg], why: "缺 xConsumption 声明" });
    } else if (d === "runtime" && !hasRuntime) {
      mismatches.push({ seg, declared: d, actual: actual[seg], why: "声明 runtime 但找不到非 spec 消费者" });
    } else if (d === "guard-only" && hasRuntime) {
      mismatches.push({ seg, declared: d, actual: actual[seg], why: "声明 guard-only 但存在非 spec 消费者" });
    }
  }
  return { declared, actual, mismatches };
}

/** 从生成物里抽出规则详情（两套发射器形态不同）。 */
export function extractGeneratedRules(src) {
  for (const pyM of src.matchAll(/json\.loads\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g)) {
    try {
      const parsed = JSON.parse(JSON.parse(`"${pyM[1]}"`));
      if (Array.isArray(parsed) && parsed.some((r) => typeof r?.id === "string")) return parsed;
    } catch {
      /* 落到 ② */
    }
  }
  const out = [];
  for (const m of src.matchAll(/\{\s*"id":\s*"((?:[^"\\]|\\.)*)"([\s\S]*?)\n\s*\}/g)) {
    const block = m[0];
    const get = (k) => {
      const x = new RegExp(`"${k}":\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(block);
      return x ? x[1] : null;
    };
    const order = /"order":\s*(\d+)/.exec(block);
    const applies = /"appliesTo":\s*\[([^\]]*)\]/.exec(block);
    out.push({
      id: m[1],
      order: order ? Number(order[1]) : null,
      code: get("code"),
      appliesTo: applies ? [...applies[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [],
    });
  }
  return out;
}

/** 生成物规则体（只用于禁用构造扫描）。 */
export function extractRuleBodies(src) {
  for (const pyM of src.matchAll(/json\.loads\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g)) {
    try {
      const parsed = JSON.parse(JSON.parse(`"${pyM[1]}"`));
      if (Array.isArray(parsed) && parsed.some((r) => typeof r?.body === "string")) {
        return parsed.map((r) => r.body).filter((b) => typeof b === "string");
      }
    } catch {
      /* 落到 ② */
    }
  }
  return [...src.matchAll(/"body":\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => {
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1];
    }
  });
}

/**
 * D-13 的行为探针：共享向量 + 重叠面探针 + 边界样本。
 * 探针不从契约复制 body，故能发现「两份生成物同时错得一样」以外的分歧。
 */
export function buildBehaviorProbes(vectors, rules = []) {
  const probes = [];
  for (const v of vectors) probes.push({ id: `vec:${v.id}`, parts: v.parts });

  if (Array.isArray(rules) && rules.length > 0) {
    const PAD = "\u0001";
    const hit = (rule, text) => {
      try {
        return new RegExp(rule.body, "u").test(PAD + text.toLowerCase() + PAD);
      } catch {
        return false;
      }
    };
    const texts = vectors.map((v) => v.parts.filter((x) => x).join("\n").toLowerCase());
    for (let i = 0; i < rules.length; i += 1) {
      for (let j = i + 1; j < rules.length; j += 1) {
        const a = rules[i];
        const b = rules[j];
        if (!a?.body || !b?.body) continue;
        const idx = texts.findIndex((t) => hit(a, t) && hit(b, t));
        if (idx < 0) continue;
        probes.push({ id: `overlap:${a.id}@${b.id}`, parts: vectors[idx].parts.filter((x) => x) });
      }
    }
  }

  const EXTRA = [
    ["edge:enotfound-standalone", ["getaddrinfo ENOTFOUND example.com"]],
    ["edge:enotfound-embedded", ["ModuleNotFoundError: No module named 'x'"]],
    ["edge:econnrefused", ["connect ECONNREFUSED 127.0.0.1:3105"]],
    ["edge:astral-in-counted-span", ["a😀😀b"]],
    ["edge:astral-single", ["😀"]],
    ["edge:uppercase-ascii", ["NO INTERPRETER FOUND FOR PYTHON"]],
    ["edge:uppercase-non-ascii", ["İNTERPRETER"]],
    ["edge:empty", [""]],
    ["edge:only-falsy", [null, undefined, ""]],
    ["edge:newline-in-text", ["line1\nNo interpreter found\nline3"]],
    ["edge:cr-only", ["a\rNo interpreter found"]],
    ["edge:leading-space", ["   No interpreter found"]],
    ["edge:trailing-space", ["No interpreter found   "]],
    ["edge:task-sandbox-token", ["task_sandbox=bwrap"]],
    ["edge:bwrap-binary", ["bwrap: setting up uid map: Permission denied"]],
    ["edge:sandbox-in-path", ["at /app/src/sandbox.ts:12"]],
    ["edge:git-failed", ["git clone failed: exit 128"]],
    ["edge:git-success", ["git clone 正在执行"]],
    ["edge:uv-venv-timeout", ["uv venv timed out after 600s"]],
    ["edge:task-timeout", ["任务执行超时（600s）"]],
    ["edge:modulenotfound", ["ModuleNotFoundError: No module named 'requests'"]],
    ["edge:invalid-npm-name", ["Invalid npm package name"]],
    ["edge:zh-sandbox", ["沙箱不可用"]],
    ["edge:zh-interpreter", ["解释器 3.9 无法获取"]],
    ["edge:zh-dependency", ["依赖安装失败"]],
    ["edge:zh-restart", ["执行器正在停机，该执行尚未开始"]],
    ["edge:task-launcher", ["资源限制启动器拒绝启动任务"]],
    ["edge:unrelated", ["some entirely unrelated failure text"]],
  ];
  for (const [id, parts] of EXTRA) probes.push({ id, parts });
  return probes;
}

/** import 可能是 .ts 的生成物，精确静音 node 的类型剥离警告。 */
async function importStrippedTypeScript(absPath) {
  const { stripTypeScriptTypes } = await import("node:module");
  const originalEmit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const name = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
    const text = typeof warning === "string" ? warning : warning?.message ?? "";
    if (name === "ExperimentalWarning" && text.includes("stripTypeScriptTypes")) return;
    return originalEmit.call(process, warning, ...rest);
  };
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const src = fs.readFileSync(absPath, "utf8");
  const stripped = stripTypeScriptTypes(src, { mode: "strip" });
  const tmp = path.join(os.tmpdir(), `dsh-failure-classifier-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(tmp, stripped, "utf8");
  try {
    return await import(`file://${tmp}`);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    process.emitWarning = originalEmit;
  }
}

// ── 三端 wrapper 接线判据 ──────────────────────────────────────────────────

export function checkWrapperWiring({ root, results, sources }) {
  const admin = sources.admin;
  const node = sources.node;
  const py = sources.python;
  const must = (name, ok, detail = []) => {
    results.push({ name: `wrapper 接线：${name}`, ok: Boolean(ok), actual: ok ? [] : detail, expected: [] });
  };

  const adminImport =
    /import\s*\{[^}]*\bclassify\s+as\s+classifyByProtocol\b[^}]*\}\s+from\s+["']\.\/generated\/failure-classifier["']/.test(
      admin ?? "",
    );
  const nodeImport =
    /import\s*\{\s*classify\s*\}\s+from\s+["']\.\.\/generated\/failure-classifier["']/.test(node ?? "");
  const pyImport = String(py ?? "").includes(
    "from generated.failure_classifier import classify as _classify_failure_reason",
  );
  must("admin 从生成物 import classifyByProtocol", adminImport, ["admin wrapper 未 import ./generated/failure-classifier"]);
  must("node 从生成物 import classify", nodeImport, ["node wrapper 未 import ../generated/failure-classifier"]);
  must("python 从生成物 import classify", pyImport, ["python wrapper 未 import generated.failure_classifier"]);

  must(
    "admin 文本分支调用生成物 admin 阶段",
    String(admin ?? "").includes('classifyByProtocol(parts, "admin")'),
    ["找不到 classifyByProtocol(parts, \"admin\")"],
  );
  must(
    "node prepareFailureReason 调用生成物 executor 阶段",
    String(node ?? "").includes("asCallbackFailureReason(classify([message], 'executor'))"),
    ["找不到 asCallbackFailureReason(classify([message], 'executor'))"],
  );
  must(
    "python _refine_failure_reason 调用生成物 executor 阶段",
    String(py ?? "").includes("return _classify_failure_reason([message], 'executor')"),
    ["找不到 return _classify_failure_reason([message], 'executor')"],
  );

  // 手写规则常量允许作为兼容导出保留（task.service.ts 与旧 spec 仍 import），
  // 但不能出现在 classifyFailure 裁决体里——那才是第二事实源复活。
  const adminBody = String(admin ?? "").slice(
    String(admin ?? "").indexOf("export function classifyFailure"),
    String(admin ?? "").indexOf("export function classifyFailure") + 2000,
  );
  const retired = RETIRED_HANDWRITTEN_RULES.filter((p) => adminBody.includes(p));
  must("admin 旧手写分类器规则常量未参与裁决", retired.length === 0, retired);
  const nodeBody = String(node ?? "").slice(
    String(node ?? "").indexOf("export function prepareFailureReason"),
    String(node ?? "").indexOf("export function prepareFailureReason") + 500,
  );
  const pyBody = String(py ?? "").slice(
    String(py ?? "").indexOf("def _refine_failure_reason"),
    String(py ?? "").indexOf("def _refine_failure_reason") + 900,
  );
  must(
    "node prepareFailureReason 不再内联正则表",
    !/\/[^\n]+\/\.test\(message\)/.test(nodeBody),
    ["prepareFailureReason 里出现内联正则判据"],
  );
  must(
    "python _refine_failure_reason 不再内联正则表",
    !/re\.(search|match)\(/.test(pyBody),
    ["_refine_failure_reason 里出现 re.search/re.match"],
  );

  // executor 阶段让位语义：null/None 不压成 'unknown'。
  must(
    "node null/非白名单码让位",
    String(node ?? "").includes("if (typeof code !== 'string') return null;") &&
      String(node ?? "").includes("CallbackPayloadSchema.shape.failureReason.safeParse(code)"),
    ["asCallbackFailureReason 丢了 null 让位"],
  );
  must(
    "python None 让位不压 unknown",
    String(py ?? "").includes("if not message:\n        return None") &&
      !pyBody.includes("return 'unknown'"),
    ["_refine_failure_reason 把 None 压成了 unknown"],
  );
  must(
    "node callback 省略 failureReason",
    countMatches(node ?? "", /\.\.\.\(failureReason \? \{ failureReason \} : \{\}\)/g) >= 2,
    ["pushCallback 未用条件展开省略 failureReason"],
  );
  must(
    "node withClassifiedFailureReason 未命中返回空对象",
    String(node ?? "").includes("return reason ? { failureReason: reason } : {};"),
    ["withClassifiedFailureReason 未命中时仍返回 failureReason"],
  );
  must(
    "python callback 省略 failureReason",
    countMatches(py ?? "", /if reason is not None:\s*\n\s*payload\['failureReason'\] = reason/g) >= 2,
    ["回调构造里没有「reason is not None 才写 failureReason」"],
  );

  // admin 非文本判据：码化优先、no-match 前置、exitCode 后置。
  const a = String(admin ?? "");
  const iCode = a.indexOf("if (input.errorCode)");
  const iNoMatch = a.indexOf("NO_MATCHING_EXECUTOR_PATTERN.test(text)");
  const iText = a.indexOf('classifyByProtocol(parts, "admin")');
  const iExit = a.indexOf('typeof input.exitCode === "number" && input.exitCode !== 0');
  must(
    "admin errorCode 码化优先",
    iCode >= 0 && iText >= 0 && iCode < iText,
    [`errorCode@${iCode}, text@${iText}`],
  );
  must(
    "admin no-match 先于生成物",
    iNoMatch >= 0 && iText >= 0 && iNoMatch < iText,
    [`no-match@${iNoMatch}, text@${iText}`],
  );
  must(
    "admin exitCode 后于生成物",
    iExit >= 0 && iText >= 0 && iText < iExit,
    [`text@${iText}, exitCode@${iExit}`],
  );
  must(
    "admin exitCode 非零归 script_error",
    /if \(typeof input\.exitCode === "number" && input\.exitCode !== 0\)\s*\{\s*return ExecutionFailureReason\.SCRIPT_ERROR/.test(a),
    ["exitCode 分支不再返回 SCRIPT_ERROR"],
  );

  // bwrap：独立日志入口，不能靠 message-only 生成物接住。
  const n = String(node ?? "");
  const p = String(py ?? "");
  const iSandbox = n.indexOf("const sandboxReason = runtimeSandboxStartupFailureReason(logs);");
  const iPrepare = n.indexOf("const reason = prepareFailureReason(message);");
  must(
    "node bwrap 日志入口独立",
    n.includes("export function runtimeSandboxStartupFailureReason") &&
      n.includes("config.taskSandbox !== 'bwrap'") &&
      n.includes("SANDBOX_STARTUP_FAILURE_RE") &&
      n.includes("return 'sandbox_unavailable'"),
    ["node 的 runtimeSandboxStartupFailureReason 入口缺失"],
  );
  must(
    "node bwrap 优先于文本分类",
    iSandbox >= 0 && iPrepare >= 0 && iSandbox < iPrepare,
    [`sandbox@${iSandbox}, prepare@${iPrepare}`],
  );
  must(
    "python bwrap 日志入口独立",
    p.includes("def _sandbox_startup_failure_reason") &&
      p.includes("settings.task_sandbox != SANDBOX_BWRAP") &&
      p.includes("_SANDBOX_STARTUP_FAILURE_RE") &&
      p.includes("沙箱不可用：bwrap"),
    ["python 的 _sandbox_startup_failure_reason 入口缺失"],
  );
}

// ── 主判据 ──────────────────────────────────────────────────────────────────

export async function check({ root = process.cwd(), report = false } = {}) {
  const structure = [];
  const results = [];
  const info = {
    vectors: 0,
    crossOk: 0,
    crossBad: [],
    wrapperChecks: 0,
    generatedRules: 0,
    registryCount: 0,
    baselineCount: 0,
    consumption: null,
  };
  const must = (name, ok, detail = []) => {
    results.push({ name, ok: Boolean(ok), actual: ok ? [] : detail, expected: [] });
  };

  const protoJ = readJson(join(root, PROTOCOL_REL));
  if (protoJ.error) {
    structure.push(protoJ.error);
    return { structure, results, info };
  }
  const proto = protoJ.value;
  const classifiers = proto?.failureReason?.classifiers;
  if (!classifiers || typeof classifiers !== "object") {
    structure.push(`${PROTOCOL_REL} 缺 failureReason.classifiers 段 —— 判据失配。`);
    return { structure, results, info };
  }
  const contractRules = classifiers.rules?.items ?? [];
  if (!Array.isArray(contractRules) || contractRules.length === 0) {
    structure.push(`${PROTOCOL_REL} 的 classifiers.rules.items 为空 —— 判据失配。`);
    return { structure, results, info };
  }
  const codes = new Set((proto.failureReason.all ?? []).map((e) => e.code));

  const fixJ = readJson(join(root, FIXTURES_REL));
  if (fixJ.error) {
    structure.push(fixJ.error);
    return { structure, results, info };
  }
  const fixtures = fixJ.value;
  const vectors = fixtures?.failureClassification?.vectors ?? [];
  if (!Array.isArray(vectors) || vectors.length === 0) {
    structure.push(`${FIXTURES_REL} 缺 failureClassification.vectors —— 没有向量可验证生成物行为。`);
    return { structure, results, info };
  }
  info.vectors = vectors.length;

  const sources = {
    admin: readText(join(root, ADMIN_WRAPPER_REL)),
    node: readText(join(root, NODE_WRAPPER_REL)),
    python: readText(join(root, PY_WRAPPER_REL)),
  };
  for (const [k, rel] of [
    ["admin", ADMIN_WRAPPER_REL],
    ["node", NODE_WRAPPER_REL],
    ["python", PY_WRAPPER_REL],
  ]) {
    if (sources[k] === null) structure.push(`读不到 ${rel} —— wrapper 接线判据失配。`);
  }

  // ── ① wrapper 接线 ───────────────────────────────────────────────────────
  if (structure.length === 0) checkWrapperWiring({ root, results, sources });
  info.wrapperChecks = results.filter((r) => r.name.startsWith("wrapper 接线：")).length;

  // ── ② 生成物存在、无漂移、结构禁令 ───────────────────────────────────────
  const generatedPaths = [GEN_MJS_REL, GEN_PY_REL, ADMIN_GEN_REL, NODE_GEN_REL, PY_GEN_REL];
  for (const rel of generatedPaths) {
    if (!existsSync(join(root, rel))) structure.push(`读不到 ${rel} —— 生成物不存在（跑 ${GENERATOR_REL}）。`);
  }
  if (structure.length > 0) return { structure, results, info };

  const drift = spawnSync(
    process.execPath,
    [join(root, GENERATOR_REL), "--check", "--no-selfcheck"],
    { cwd: root, encoding: "utf8" },
  );
  must(
    "生成物无漂移（generate-failure-classifiers --check）",
    drift.status === 0,
    drift.status === 0 ? [] : [(drift.stdout || "") + (drift.stderr || "")].filter(Boolean),
  );

  const bannedInGen = [
    { re: /\\b/, name: "\\b" },
    { re: /\\A|\\Z/, name: "\\A/\\Z" },
    { re: /\(\?<[=!]/, name: "lookbehind" },
    { re: /\\[dDsSwW]/, name: "\\d/\\w/\\s" },
    { re: /\\[pP]\{/, name: "\\p{…}" },
  ];
  for (const rel of [GEN_MJS_REL, GEN_PY_REL]) {
    const src = readText(join(root, rel)) ?? "";
    const bodies = extractRuleBodies(src);
    if (bodies.length === 0) {
      structure.push(`生成物 ${rel} 里抽不到规则体（"body" 字段）—— 判据失配。`);
      continue;
    }
    for (const b of bannedInGen) {
      must(`生成物 ${rel} 的规则体不含禁用构造 ${b.name}`, !bodies.some((body) => b.re.test(body)), [b.name]);
    }
  }
  if (structure.length > 0) return { structure, results, info };

  // ── ③ 真跑两侧生成物 ─────────────────────────────────────────────────────
  const pyProbePath = join(root, GUARD_PROBE_REL);
  const pyCode =
    readFileSync(join(root, GEN_PY_REL), "utf8") +
    "\n\nimport json, sys\n" +
    "_V = json.loads(sys.argv[1])\n" +
    "_out = []\n" +
    "for _v in _V:\n" +
    '    _out.append({"id": _v["id"], "executor": classify(_v["parts"], "executor"), "admin": classify(_v["parts"], "admin")})\n' +
    'print(json.dumps({"results": _out, "fallbacks": FALLBACKS, "rules": RULES, "ruleIds": {"executor": rule_ids("executor"), "admin": rule_ids("admin")}}, ensure_ascii=False))\n';
  writeFileSync(pyProbePath, pyCode, "utf8");
  const pyRun = spawnSync("python3", [pyProbePath, JSON.stringify(vectors)], { cwd: root, encoding: "utf8" });
  try {
    unlinkSync(pyProbePath);
  } catch {
    /* ignore */
  }
  if (pyRun.status !== 0) {
    structure.push(`python 侧生成物求值失败：\n${pyRun.stderr}`);
    return { structure, results, info };
  }

  let pyPayload;
  try {
    pyPayload = JSON.parse(pyRun.stdout.trim().split("\n").pop());
  } catch (error) {
    structure.push(`python 侧生成物输出不是合法 JSON：${error.message}`);
    return { structure, results, info };
  }
  const pyResults = pyPayload.results ?? [];
  const mjsMod = await import(`file://${join(root, GEN_MJS_REL)}?t=${Date.now()}`);
  const jsResults = vectors.map((v) => ({
    id: v.id,
    executor: mjsMod.classify(v.parts, "executor"),
    admin: mjsMod.classify(v.parts, "admin"),
  }));

  for (let i = 0; i < vectors.length; i += 1) {
    const v = vectors[i];
    const j = jsResults[i];
    const p = pyResults[i];
    const exp = v.expected ?? {};
    const same = j.executor === p.executor && j.admin === p.admin;
    const overlapOk = j.executor === null || j.executor === j.admin;
    const okExp =
      (exp.executor === undefined || exp.executor === j.executor) &&
      (exp.admin === undefined || exp.admin === j.admin);
    const ok = same && overlapOk && okExp;
    if (ok) info.crossOk += 1;
    else {
      info.crossBad.push({
        id: v.id,
        node: { executor: j.executor, admin: j.admin },
        python: { executor: p.executor, admin: p.admin },
        expected: exp,
        overlapOk,
      });
    }
    must(
      `跨语言一致 + 符合契约期望：${v.id}`,
      ok,
      ok ? [] : [`node=(${j.executor}/${j.admin}) python=(${p.executor}/${p.admin}) expected=${JSON.stringify(exp)} overlapOk=${overlapOk}`],
    );
  }

  // ── ④ 审计向量：规则表 + fallback ───────────────────────────────────────
  const normalizeRule = (r) => ({
    id: String(r?.id ?? ""),
    order: Number(r?.order),
    code: r?.code ?? null,
    appliesTo: [...(r?.appliesTo ?? [])].sort(),
  });
  const wantRules = contractRules.map(normalizeRule).sort((a, b) => a.id.localeCompare(b.id));
  const mjsRules = (mjsMod.RULES ?? []).map(normalizeRule).sort((a, b) => a.id.localeCompare(b.id));
  const pyRules = (pyPayload.rules ?? []).map(normalizeRule).sort((a, b) => a.id.localeCompare(b.id));
  info.generatedRules = wantRules.length;
  must(
    "审计向量：mjs 规则表逐条对齐契约（id/order/code/appliesTo）",
    JSON.stringify(mjsRules) === JSON.stringify(wantRules),
    JSON.stringify(mjsRules) === JSON.stringify(wantRules) ? [] : [`mjs=${JSON.stringify(mjsRules)} want=${JSON.stringify(wantRules)}`],
  );
  must(
    "审计向量：py 规则表逐条对齐契约（id/order/code/appliesTo）",
    JSON.stringify(pyRules) === JSON.stringify(wantRules),
    JSON.stringify(pyRules) === JSON.stringify(wantRules) ? [] : [`py=${JSON.stringify(pyRules)} want=${JSON.stringify(wantRules)}`],
  );

  const fb = classifiers.fallbacks ?? {};
  const fbOk =
    fb.executor === null &&
    fb.admin === "unknown" &&
    mjsMod.FALLBACKS?.executor === null &&
    mjsMod.FALLBACKS?.admin === "unknown" &&
    pyPayload.fallbacks?.executor === null &&
    pyPayload.fallbacks?.admin === "unknown";
  must(
    "审计向量：fallback executor=null / admin=unknown",
    fbOk,
    fbOk ? [] : [`protocol=${JSON.stringify(fb)} mjs=${JSON.stringify(mjsMod.FALLBACKS)} py=${JSON.stringify(pyPayload.fallbacks)}`],
  );

  for (const stage of ["executor", "admin"]) {
    const wantIds = contractRules
      .filter((r) => (r.appliesTo ?? []).includes(stage))
      .map((r) => r.id)
      .sort();
    must(
      `审计向量：mjs ruleIds(${stage}) 与契约一致`,
      JSON.stringify([...(mjsMod.ruleIds(stage) ?? [])].sort()) === JSON.stringify(wantIds),
      [`got=${JSON.stringify(mjsMod.ruleIds(stage))} want=${JSON.stringify(wantIds)}`],
    );
    must(
      `审计向量：py ruleIds(${stage}) 与契约一致`,
      JSON.stringify([...(pyPayload.ruleIds?.[stage] ?? [])].sort()) === JSON.stringify(wantIds),
      [`got=${JSON.stringify(pyPayload.ruleIds?.[stage])} want=${JSON.stringify(wantIds)}`],
    );
  }

  // ── ⑤ D-13：四处生成物 + 行为等价 ───────────────────────────────────────
  const nodeAppSrc = readText(join(root, NODE_GEN_REL));
  const adminAppSrc = readText(join(root, ADMIN_GEN_REL));
  const pyAppSrc = readText(join(root, PY_GEN_REL));
  const pyGuardSrc = readText(join(root, GEN_PY_REL));
  must(
    "D-13：admin/node 两份 .ts 与守卫 .mjs 都在",
    Boolean(nodeAppSrc && adminAppSrc),
    [nodeAppSrc ? "" : NODE_GEN_REL, adminAppSrc ? "" : ADMIN_GEN_REL].filter(Boolean),
  );
  must("D-13：python 两份生成物都在（app + 守卫）", Boolean(pyAppSrc && pyGuardSrc), []);
  if (pyAppSrc !== null && pyGuardSrc !== null) {
    must(
      "D-13：python 两份生成物逐字节一致",
      pyAppSrc === pyGuardSrc,
      pyAppSrc === pyGuardSrc ? [] : ["两份 .py 内容不同（app 那份被手改过？）"],
    );
  }

  if (nodeAppSrc && adminAppSrc) {
    const probes = buildBehaviorProbes(vectors, mjsMod.RULES ?? []);
    const nodeMod = await importStrippedTypeScript(join(root, NODE_GEN_REL));
    const adminMod = await importStrippedTypeScript(join(root, ADMIN_GEN_REL));

    const compare = (mod, label, resultName) => {
      const mismatches = [];
      for (const probe of probes) {
        for (const stage of ["executor", "admin"]) {
          const a = mod.classify(probe.parts, stage);
          const b = mjsMod.classify(probe.parts, stage);
          if (a !== b) mismatches.push(`${probe.id}@${stage}: ${label}=${a} .mjs=${b}`);
        }
      }
      must(`${resultName}（${probes.length} 条探针 × 2 阶段）`, mismatches.length === 0, mismatches.slice(0, 5));
    };
    compare(nodeMod, ".ts", "D-13：node 两份生成物行为等价");
    compare(adminMod, "admin.ts", "D-13：admin 生成物与守卫 .mjs 行为等价");
  }

  // ── ⑥ 差异登记（收敛后只剩真实存在的非文本/能力差异）────────────────────
  const registry = fixtures?.divergenceRegistry?.entries ?? [];
  if (!Array.isArray(registry)) {
    structure.push(`${FIXTURES_REL} 的 divergenceRegistry.entries 不是数组 —— 判据失配。`);
    return { structure, results, info };
  }
  info.registryCount = registry.length;
  const REQUIRED = ["reason", "why", "owner", "status", "review_by"];
  const STATUSES = new Set(["open", "accepted-by-design"]);
  for (const e of registry) {
    for (const f of REQUIRED) {
      if (typeof e?.[f] !== "string" || e[f].trim() === "") {
        structure.push(`divergenceRegistry 条目 ${JSON.stringify(e?.id)} 缺必填字段 "${f}" —— 无主/无期限/无 why 的登记等于永久豁免。`);
      }
    }
    if (e?.status && !STATUSES.has(e.status)) {
      structure.push(`divergenceRegistry 条目 ${e.id} 的 status="${e.status}" 不在 open/accepted-by-design 内。`);
    }
    if (e?.code && !codes.has(e.code)) {
      structure.push(`divergenceRegistry 条目 ${e.id} 的 code "${e.code}" 不在 failureReason.all 里。`);
    }
    if (e?.kind !== "capability") {
      structure.push(
        `divergenceRegistry 条目 ${e.id} 的 kind="${JSON.stringify(e?.kind)}" —— 单轨后分类器判据不再有手写差异；` +
          `新登记必须是 capability（非文本判据/能力差异），旧 classifier probe 已随模拟器下线。`,
      );
      continue;
    }
    const v = e.verify;
    if (!v || typeof v.file !== "string" || typeof v.mustContain !== "string" || v.mustContain === "") {
      structure.push(`divergenceRegistry 条目 ${e.id}（capability）缺 verify.file / verify.mustContain —— 差异必须可证。`);
    }
  }
  if (structure.length > 0) return { structure, results, info };

  for (const e of registry) {
    const src = readText(join(root, e.verify.file));
    const hit = src !== null && src.includes(e.verify.mustContain);
    must(
      `登记可证（证据仍在）：${e.id}`,
      hit,
      hit ? [] : [`${e.verify.file} 里找不到 ${JSON.stringify(e.verify.mustContain)}（差异消失 ⇒ 清理登记与基线）`],
    );
  }

  // ── ⑦ D-16：xConsumption 声明与实际消费面 ───────────────────────────────
  const audit = auditSegmentConsumption(root, proto);
  info.consumption = {
    declared: audit.declared,
    runtimeSegments: Object.entries(audit.actual)
      .filter(([, v]) => v.length > 0)
      .map(([k, v]) => ({ seg: k, files: v })),
  };
  for (const m of audit.mismatches) {
    must(
      `D-16：段 ${m.seg} 的 xConsumption 声明与实际一致`,
      false,
      [`${m.why}${m.actual.length ? `（消费点：${m.actual.slice(0, 3).join(", ")}）` : ""}`],
    );
  }
  const runtimeDeclared = Object.values(audit.declared).filter((v) => v === "runtime").length;
  must("D-16：至少一个段声明为 runtime", runtimeDeclared > 0, runtimeDeclared > 0 ? [] : ["没有任何段声明 runtime"]);
  const note = String(proto.failureReason?.xConsumptionNote ?? "");
  must(
    "D-16：failureReason 声明 runtime 且 note 点名三端 wrapper 消费点",
    proto.failureReason?.xConsumption === "runtime" &&
      ["admin-api/src/common/failure-classification/failure-patterns.ts", "executor-node/src/routes/execute.ts", "executor-python/routers/execute.py"].every((p) =>
        note.includes(p),
      ),
    [`declared=${proto.failureReason?.xConsumption} note=${note.slice(0, 160)}`],
  );

  // ── ⑧ 棘轮：登记只减不增，消失也红 ──────────────────────────────────────
  const baseB = readRatchetBaseline({
    root,
    rel: BASELINE_REL,
    kind: "array",
    entriesKey: "entries",
    label: "基线",
  });
  if (baseB.error) {
    structure.push(baseB.error);
    return { structure, results, info };
  }
  const baseEntries = baseB.list.map(({ entry }) => entry);
  info.baselineCount = baseEntries.length;

  const today = utcDay();
  const deadlineProblems = [];
  for (const { key, entry } of baseB.list) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      structure.push(
        `基线条目 ${key} 不是对象 —— ${BASELINE_REL} 腐烂了：条目必须能逐字段复核（谁负责 / 什么时候复核 / 为什么还在）。`,
      );
      continue;
    }
    const shape = compareEntry({
      at: `基线条目 ${key}`,
      noun: "登记",
      entry,
      rel: BASELINE_REL,
      label: "基线",
      requiredFields: ["id", "owner", "review_by", "why"],
      today,
    });
    if (shape.incomplete !== null) {
      structure.push(`${shape.incomplete}（缺 owner、review_by、why；${BASELINE_REL} 的每条登记都是「已知差异还没修」的豁免凭证 ⇒ 必须写 owner / review_by / why。）`);
    }
    if (shape.badDate !== null) structure.push(shape.badDate);
    if (shape.expired) deadlineProblems.push(renderExpired({ at: `基线条目 ${key}`, noun: "登记", entry, today }));
  }
  if (structure.length > 0) return { structure, results, info };
  must("棘轮：登记必须有主有期限有 why（到期即红）", deadlineProblems.length === 0, deadlineProblems);

  const baseIds = new Set(baseEntries.map((e) => e.id));
  const currentIds = new Set(registry.map((e) => e.id));
  const added = [...currentIds].filter((id) => !baseIds.has(id));
  const removed = [...baseIds].filter((id) => !currentIds.has(id));
  must("棘轮：登记条数不超基线（只减不增）", added.length === 0, added);
  must("棘轮：基线里的登记不得消失（差异消失 ⇒ 同步更新基线）", removed.length === 0, removed);

  return { structure, results, info };
}

// ── 自检 ────────────────────────────────────────────────────────────────────

const SAMPLE_PROTOCOL = {
  failureReason: {
    xConsumption: "runtime",
    xConsumptionNote:
      "运行时消费点：admin-api/src/common/failure-classification/failure-patterns.ts、executor-node/src/routes/execute.ts、executor-python/routers/execute.py。",
    all: [
      {
        code: "unknown",
        zh: "未知",
        en: "Unknown",
        remediationKey: "k",
        owner: "platform-ops",
        reportable: true,
      },
      {
        code: "sandbox_unavailable",
        zh: "沙箱不可用",
        en: "Sandbox unavailable",
        remediationKey: "k",
        owner: "platform-ops",
        reportable: true,
      },
    ],
    classifiers: {
      matcherSubset: { tokens: { WORD: "[A-Za-z0-9_]" } },
      normalize: {
        joinWith: "\n",
        dropFalsyParts: true,
        caseFold: "ascii-lower",
        astralFold: "replace-with-U+FFFD",
      },
      sentinel: { pad: "\u0001" },
      rules: {
        items: [
          {
            id: "r1",
            order: 10,
            code: "unknown",
            appliesTo: ["executor", "admin"],
            alternatives: ["nothing matches this"],
          },
        ],
      },
      fallbacks: { executor: null, admin: "unknown" },
    },
  },
  schemas: {
    xConsumption: "runtime",
    S: { type: "object", properties: { a: { type: "string" } } },
  },
};

const TS_GEN_FIXTURE = [
  `export const TOKENS = { WS: "[ ]" };`,
  `export const NORMALIZE = { joinWith: "\\n", dropFalsyParts: true, caseFold: "ascii-lower", astralFold: "replace-with-U+FFFD" };`,
  `export const RULES = [{ id: "r1", order: 10, code: "unknown", appliesTo: ["executor", "admin"], body: "nothing matches this" }];`,
  `export const FALLBACKS = {"executor":null,"admin":"unknown"};`,
  `export function classify(parts: readonly (string | null | undefined)[], stage: "executor" | "admin" = "executor"): string | null {`,
  `  const text = parts.filter((p): p is string => p !== null && p !== undefined && p !== "").join("\\n").toLowerCase();`,
  `  for (const rule of RULES) {`,
  `    if (stage === "admin" || (rule.appliesTo as readonly string[]).includes(stage)) {`,
  `      if (new RegExp(rule.body, "u").test(text)) return rule.code;`,
  `    }`,
  `  }`,
  `  return stage === "admin" ? "unknown" : null;`,
  `}`,
  `export function ruleIds(stage: string): string[] {`,
  `  return RULES.filter((r) => stage === "admin" || (r.appliesTo as readonly string[]).includes(stage)).map((r) => r.id);`,
  `}`,
].join("\n");

const GEN_MJS_FIXTURE = [
  `export const RULES = [`,
  `  { "id": "r1", "order": 10, "code": "unknown", "appliesTo": ["executor", "admin"], "body": "nothing matches this" },`,
  `];`,
  `export const FALLBACKS = {"executor":null,"admin":"unknown"};`,
  `export function classify(parts, stage = "executor") {`,
  `  const text = parts.filter((p) => p !== null && p !== undefined && p !== "").join("\\n").toLowerCase();`,
  `  for (const rule of RULES) {`,
  `    if (stage === "admin" || rule.appliesTo.includes(stage)) {`,
  `      if (new RegExp(rule.body, "u").test(text)) return rule.code;`,
  `    }`,
  `  }`,
  `  return stage === "admin" ? "unknown" : null;`,
  `}`,
  `export function ruleIds(stage) { return RULES.filter((r) => stage === "admin" || r.appliesTo.includes(stage)).map((r) => r.id); }`,
].join("\n");

const GEN_PY_FIXTURE = [
  "import json",
  "import re",
  "",
  `RULES = json.loads(${JSON.stringify(
    JSON.stringify([
      { id: "r1", order: 10, code: "unknown", appliesTo: ["executor", "admin"], body: "nothing matches this" },
    ]),
  )})`,
  "FALLBACKS = {\"executor\": None, \"admin\": \"unknown\"}",
  "_BY_STAGE = {",
  "    'executor': [r for r in RULES if 'executor' in r['appliesTo']],",
  "    'admin': [r for r in RULES if 'admin' in r['appliesTo']],",
  "}",
  "",
  "def classify(parts, stage='executor'):",
  "    text = '\\n'.join(p for p in parts if p is not None and p != '').lower()",
  "    for rule in _BY_STAGE.get(stage, []):",
  "        if re.search(rule['body'], text):",
  "            return rule['code']",
  "    return FALLBACKS['admin'] if stage == 'admin' else FALLBACKS['executor']",
  "",
  "def rule_ids(stage):",
  "    return [r['id'] for r in _BY_STAGE.get(stage, [])]",
].join("\n");

const ADMIN_WRAPPER_FIXTURE = [
  `import { ExecutionFailureReason } from "../../modules/task/entities/task-execution.entity";`,
  `import { ERROR_CODE_FAILURE_REASON } from "../../common/errors/error-code-failure-reason";`,
  `import { classify as classifyByProtocol } from "./generated/failure-classifier";`,
  `export const NO_MATCHING_EXECUTOR_PATTERN = /no online executors? matches? the requested/i;`,
  `function toFailureReason(code: string | null): ExecutionFailureReason | null {`,
  `  if (code === null) return null;`,
  `  const valid = Object.values(ExecutionFailureReason) as string[];`,
  `  return valid.includes(code) ? (code as unknown as ExecutionFailureReason) : null;`,
  `}`,
  `export function classifyFailure(input: { errorMessage?: string | null; logs?: string | null; exitCode?: number; errorCode?: string | null }): ExecutionFailureReason {`,
  `  if (input.errorCode) {`,
  `    const mapped = ERROR_CODE_FAILURE_REASON[input.errorCode];`,
  `    if (mapped) return mapped;`,
  `  }`,
  `  const parts = [input.errorMessage, input.logs].filter((p): p is string => typeof p === "string" && p !== "");`,
  `  const text = parts.join("\\n").toLowerCase();`,
  `  if (NO_MATCHING_EXECUTOR_PATTERN.test(text)) return ExecutionFailureReason.UNKNOWN;`,
  `  const fromText = toFailureReason(classifyByProtocol(parts, "admin"));`,
  `  if (fromText !== null) return fromText;`,
  `  if (typeof input.exitCode === "number" && input.exitCode !== 0) {`,
  `    return ExecutionFailureReason.SCRIPT_ERROR;`,
  `  }`,
  `  return ExecutionFailureReason.UNKNOWN;`,
  `}`,
].join("\n");

const NODE_WRAPPER_FIXTURE = [
  `import { classify } from '../generated/failure-classifier';`,
  `const CallbackPayloadSchema = { shape: { failureReason: { safeParse: (code: string) => ({ success: typeof code === 'string' && code !== 'unknown', data: code }) } } };`,
  `function asCallbackFailureReason(code: unknown): string | null {`,
  `  if (typeof code !== 'string') return null;`,
  `  const parsed = CallbackPayloadSchema.shape.failureReason.safeParse(code);`,
  `  return parsed.success ? (parsed.data as string) : null;`,
  `}`,
  `export function prepareFailureReason(message: string): string | null {`,
  `  return asCallbackFailureReason(classify([message], 'executor'));`,
  `}`,
  `const SANDBOX_STARTUP_FAILURE_RE = new RegExp('bwrap\\\\s.*setting up uid map', 'i');`,
  `export function runtimeSandboxStartupFailureReason(logs: string | undefined): string | null {`,
  `  if (config.taskSandbox !== 'bwrap') return null;`,
  `  if (!logs || !SANDBOX_STARTUP_FAILURE_RE.test(logs)) return null;`,
  `  return 'sandbox_unavailable';`,
  `}`,
  `export function withClassifiedFailureReason(message: string, logs?: string): Record<string, string> {`,
  `  const sandboxReason = runtimeSandboxStartupFailureReason(logs);`,
  `  if (sandboxReason) return { failureReason: sandboxReason };`,
  `  const reason = prepareFailureReason(message);`,
  `  return reason ? { failureReason: reason } : {};`,
  `}`,
  `function failStart(message: string) {`,
  `  const failureReason = prepareFailureReason(message);`,
  `  pushCallback({ status: 'failed', ...(failureReason ? { failureReason } : {}) });`,
  `  pushCallback({ status: 'failed', errorMessage: message, ...(failureReason ? { failureReason } : {}) });`,
  `}`,
].join("\n");

const PY_WRAPPER_FIXTURE = [
  `from generated.failure_classifier import classify as _classify_failure_reason`,
  `def _refine_failure_reason(message):`,
  `    if not message:`,
  `        return None`,
  `    return _classify_failure_reason([message], 'executor')`,
  ``,
  `def _sandbox_startup_failure_reason(logs):`,
  `    if settings.task_sandbox != SANDBOX_BWRAP:`,
  `        return None`,
  `    if not _SANDBOX_STARTUP_FAILURE_RE.search(logs or ""):`,
  `        return None`,
  `    return "沙箱不可用：bwrap 无法创建命名空间"`,
  ``,
  `def _run_and_callback():`,
  `    payload = {}`,
  `    reason = _refine_failure_reason('x')`,
  `    if reason is not None:`,
  `        payload['failureReason'] = reason`,
  `    reason = _refine_failure_reason('y')`,
  `    if reason is not None:`,
  `        payload['failureReason'] = reason`,
  `    return payload`,
].join("\n");

const fixtureBaselineEntry = (id) => ({
  id,
  owner: "executor-parity",
  review_by: "2027-03-01",
  why: "fixture: 真实存在的非文本差异仍未收敛",
  kind: "capability",
  status: "accepted-by-design",
});

const fixtureRegistryEntry = (id) => ({
  id,
  kind: "capability",
  code: "sandbox_unavailable",
  side: "node",
  reason: "fixture: 独立日志入口不是文本规则",
  why: "fixture: 证据未消失，差异仍真实存在",
  owner: "platform-ops",
  review_by: "2027-03-01",
  status: "accepted-by-design",
  verify: { file: NODE_WRAPPER_REL, mustContain: "runtimeSandboxStartupFailureReason" },
});

function baseFixture(overrides = {}) {
  return {
    [PROTOCOL_REL]: JSON.stringify(SAMPLE_PROTOCOL, null, 2),
    [FIXTURES_REL]: JSON.stringify(
      {
        failureClassification: {
          vectors: [{ id: "v1", parts: ["nothing matches this"], expected: { executor: "unknown", admin: "unknown" } }],
        },
        divergenceRegistry: { entries: [fixtureRegistryEntry("CLS-11@runtime-bwrap-log-entry")] },
      },
      null,
      2,
    ),
    [BASELINE_REL]: JSON.stringify(
      { entries: [fixtureBaselineEntry("CLS-11@runtime-bwrap-log-entry")] },
      null,
      2,
    ),
    [GEN_MJS_REL]: GEN_MJS_FIXTURE,
    [GEN_PY_REL]: GEN_PY_FIXTURE,
    [ADMIN_GEN_REL]: TS_GEN_FIXTURE,
    [NODE_GEN_REL]: TS_GEN_FIXTURE,
    [PY_GEN_REL]: GEN_PY_FIXTURE,
    [ADMIN_WRAPPER_REL]: ADMIN_WRAPPER_FIXTURE,
    [NODE_WRAPPER_REL]: NODE_WRAPPER_FIXTURE,
    [PY_WRAPPER_REL]: PY_WRAPPER_FIXTURE,
    [GENERATOR_REL]: "process.exit(0);\n",
    "apps/executor-node/src/consumer.ts": [
      `import { SSchema } from "./generated/protocol.schemas";`,
      `export const used = SSchema;`,
    ].join("\n"),
    "apps/executor-node/src/generated/protocol.schemas.ts": `export const SSchema = { type: "object" };`,
    ...overrides,
  };
}

export function selftest() {
  const cases = [];
  const run = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "failure-classifiers-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
            ...expect,
            withinMs: 10000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  run("① 一致树：生成物行为 + wrapper 接线 + 审计向量全绿", baseFixture(), {
    code: 0,
    contains: ["跨语言一致", "wrapper 接线", "棘轮"],
    absent: ["FAIL ", "结构错误"],
  });

  run(
    "② 【反证·wrapper 接线】node 不再调用生成物 ⇒ 红",
    baseFixture({
      [NODE_WRAPPER_REL]: NODE_WRAPPER_FIXTURE.replace(
        "return asCallbackFailureReason(classify([message], 'executor'));",
        "return 'unknown';",
      ),
    }),
    { code: 1, contains: ["wrapper 接线：node prepareFailureReason", "FAIL"], absent: ["failure-classifier consistency OK"] },
  );

  run(
    "③ 【反证·app 生成物】admin 生成物行为被改坏 ⇒ D-13 红",
    baseFixture({
      [ADMIN_GEN_REL]: TS_GEN_FIXTURE.replace(
        `stage === "admin" ? "unknown" : null;`,
        `stage === "admin" ? null : null;`,
      ),
    }),
    { code: 1, contains: ["D-13：admin 生成物与守卫 .mjs 行为等价"], absent: ["failure-classifier consistency OK"] },
  );

  run(
    "④ 【反证·差异消失】保留差异的证据标记被删掉 ⇒ 红",
    baseFixture({
      [NODE_WRAPPER_REL]: NODE_WRAPPER_FIXTURE.replace("runtimeSandboxStartupFailureReason", "legacySandboxReason"),
    }),
    { code: 1, contains: ["登记可证（证据仍在）", "CLS-11"], absent: ["failure-classifier consistency OK"] },
  );

  run(
    "⑤ 【反证·棘轮·消失】基线里有登记而当前没了 ⇒ 红",
    baseFixture({
      [FIXTURES_REL]: JSON.stringify(
        {
          failureClassification: {
            vectors: [{ id: "v1", parts: ["nothing matches this"], expected: { executor: "unknown", admin: "unknown" } }],
          },
          divergenceRegistry: { entries: [] },
        },
        null,
        2,
      ),
    }),
    { code: 1, contains: ["棘轮：基线里的登记不得消失", "CLS-11"], absent: ["failure-classifier consistency OK"] },
  );

  run(
    "⑥ 【反证·棘轮·增长】登记多于基线 ⇒ 红",
    baseFixture({
      [FIXTURES_REL]: JSON.stringify(
        {
          failureClassification: {
            vectors: [{ id: "v1", parts: ["nothing matches this"], expected: { executor: "unknown", admin: "unknown" } }],
          },
          divergenceRegistry: {
            entries: [
              fixtureRegistryEntry("CLS-11@runtime-bwrap-log-entry"),
              { ...fixtureRegistryEntry("KD-NEW"), verify: { file: PY_WRAPPER_REL, mustContain: "_sandbox_startup_failure_reason" } },
            ],
          },
        },
        null,
        2,
      ),
    }),
    { code: 1, contains: ["棘轮：登记条数不超基线", "KD-NEW"], absent: ["failure-classifier consistency OK"] },
  );

  run(
    "⑦ 【反证·基线登记合法性】缺 why ⇒ 结构红",
    baseFixture({
      [BASELINE_REL]: JSON.stringify({ entries: [{ id: "CLS-11@runtime-bwrap-log-entry", owner: "executor-parity", review_by: "2027-03-01" }] }, null, 2),
    }),
    { code: 1, contains: ["结构错误", "缺 owner、review_by、why"], absent: ["failure-classifier consistency OK"] },
  );

  run(
    "⑧ 【反证·D-16 声明失真】删掉 schemas 消费者 ⇒ runtime 声明变假 ⇒ 红",
    baseFixture({
      "apps/executor-node/src/consumer.ts": `export const used = 1;`,
    }),
    { code: 1, contains: ["D-16：段 schemas 的 xConsumption 声明与实际一致"], absent: ["failure-classifier consistency OK"] },
  );

  run(
    "⑨ 【反证·fallback】生成物 fallback 漂移 ⇒ 审计向量红",
    baseFixture({
      [GEN_MJS_REL]: GEN_MJS_FIXTURE.replace(
        `export const FALLBACKS = {"executor":null,"admin":"unknown"};`,
        `export const FALLBACKS = {"executor":"unknown","admin":"unknown"};`,
      ),
    }),
    { code: 1, contains: ["审计向量：fallback executor=null / admin=unknown"], absent: ["failure-classifier consistency OK"] },
  );

  run(
    "⑩ 【反证·旧登记形态】classifier probe 登记复活 ⇒ 结构红",
    baseFixture({
      [FIXTURES_REL]: JSON.stringify(
        {
          failureClassification: {
            vectors: [{ id: "v1", parts: ["nothing matches this"], expected: { executor: "unknown", admin: "unknown" } }],
          },
          divergenceRegistry: {
            entries: [{ ...fixtureRegistryEntry("CLS-OLD"), kind: "classifier", probe: { parts: ["x"] } }],
          },
        },
        null,
        2,
      ),
      [BASELINE_REL]: JSON.stringify({ entries: [fixtureBaselineEntry("CLS-OLD")] }, null, 2),
    }),
    { code: 1, contains: ["结构错误", "新登记必须是 capability"], absent: ["failure-classifier consistency OK"] },
  );

  const failed = reportCases(cases, { title: "check-failure-classifiers selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const isMain =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    const root = resolve(argValue(process.argv, "--root") ?? process.cwd());
    const report = process.argv.includes("--report");
    const { structure, results, info } = await check({ root, report });

    if (structure.length > 0) {
      console.error("");
      console.error("✖ 分类器守卫结构错误（判据本身不可信）：");
      for (const e of structure) console.error("  · " + e);
      console.error("");
      process.exit(1);
    }

    let failed = 0;
    for (const r of results) {
      if (r.ok) {
        if (!r.name.startsWith("跨语言一致")) console.log(`OK   ${r.name}`);
      } else {
        failed += 1;
        console.log(`FAIL ${r.name}`);
        for (const a of r.actual) console.log(`     actual  : ${a}`);
      }
    }
    console.log("");
    console.log(
      `向量 ${info.vectors} 条，跨语言一致 ${info.crossOk} 条；wrapper 接线 ${info.wrapperChecks} 项，契约规则 ${info.generatedRules} 条；差异登记 ${info.registryCount} 条 / 基线 ${info.baselineCount} 条`,
    );
    if (report) {
      console.log("");
      console.log("（--report 模式：只报告不判红）");
      process.exit(0);
    }
    if (failed) {
      console.error(`\n${failed} failure-classifier drift(s) detected`);
      process.exit(1);
    }
    console.log("failure-classifier consistency OK");
  }
}
