#!/usr/bin/env node
/**
 * scripts/check-npm-audit-exemptions.mjs — `npm audit` **豁免判定的单一事实源**。
 *
 * ## 由来（审计 CIR-03）
 *
 * 此前豁免判据有两份、且只有一份活着：
 *   · CI（ci.yml 的 npm-audit job）：`npm audit` 非零后，把命中的 GHSA 与
 *     `known='...'` 清单比对，**全部命中已登记豁免即放行**并打印复查日期；
 *   · 本地（scripts/ci-local.sh 的 job_npm_audit）：直接跑裸 `npm audit`，
 *     非零即 FAIL。
 * 于是一棵**干净树**（命中项全部是已裁决豁免）上，本地必红、CI 绿。任何人跑
 * ci-local.sh 都会看到 npm-audit FAIL，而唯一的应对手段是永远加 `--skip-audit`
 * ——整条 audit 面从本地彻底消失。这正是「同一判据写两遍」的经典结局：
 * 两份实现里必有一份没人维护。
 *
 * 现在判据只有这一份：本文件。CI 与 ci-local.sh 都调用它，**不再各自解析清单**。
 *
 * ## CI 接线
 *
 * CI 接线由 ci.yml 的 npm-audit job 承载（本脚本自身不判断「有没有被 CI 调用」；
 * 那条判定归 scripts/check-guards-wired.mjs）。建议的 job 内替换：
 *
 *     - run: node scripts/check-npm-audit-exemptions.mjs --dir . --retries 3
 *
 * （job 里已有 `working-directory: ${{ matrix.project }}` 时用上面这行；若把 step 提到
 * 仓库根、不带 matrix，则用 `node scripts/check-npm-audit-exemptions.mjs` —— 默认就是
 * 那 5 个 audit 面，与 matrix 一一对应。）
 *
 * 即把「重试 3 次 npm audit + known='...' + comm -23 heredoc」整段换成一次调用；
 * 退避重试、::notice:: 输出、::error:: 失败信息都在本脚本内实现（见下方「退出码」）。
 * 重试语义比原实现更窄：**只重试 npm 自身的瞬时失败**（503 / EAI_AGAIN / 超时），
 * 真实命中与确定性失败（ENOLOCK、JSON 畸形、缺 lockfile）不重试 —— 原实现无差别重试
 * 整段脚本，会让一条确定性红灯白等 90 秒、也分不清「registry 抖了」和「真有人加了洞」。
 *
 * ## 判据
 *
 * 对每个 audit 面执行（与 ci.yml 的 matrix 逐字一致）：
 *
 *     npm audit --registry=https://registry.npmjs.org --omit=dev \
 *               --audit-level=moderate --json
 *
 * 用 `vulnerabilities[].via[].url` 里的 GHSA 编号作判定键（**不用包名**：模块名
 * 会随链路变化，GHSA 是稳定身份），与下方 EXEMPTIONS 比对：
 *
 *   · 命中的 GHSA **全部**已登记 → exit 0，打印「全部为已裁决豁免」+ 下次复查日期；
 *   · 命中**未登记**的 GHSA     → exit 1，逐条打印 `GHSA / 包名 / severity / title`；
 *   · npm 自身失败（ENOLOCK/EAI_AGAIN/registry 5xx…）或 JSON 不可解析 → exit 1。
 *
 * **fail-closed**：命令失败、输出畸形、结构不符（缺 `vulnerabilities` 字段）一律
 * 当失败，绝不当成「无漏洞」。把「跑不起来」和「没漏洞」混为一谈，是审计闸最
 * 常见的自我阉割方式。
 *
 * ## 退出码
 *
 *   0 = 全部命中的 GHSA 均为已裁决豁免（或确实无 moderate+ 命中）
 *   1 = 存在未登记漏洞 / npm 失败 / JSON 不可解析 / 目标目录不存在
 *   2 = 用法错误（未知参数、参数组合非法）
 *
 * ## 用法
 *
 *   node scripts/check-npm-audit-exemptions.mjs                  # 默认 5 个 audit 面
 *   node scripts/check-npm-audit-exemptions.mjs --dir apps/admin-api
 *   node scripts/check-npm-audit-exemptions.mjs --selftest       # 离线自检，不联网、不跑 npm
 *   node scripts/check-npm-audit-exemptions.mjs --dir X --retries 3          # 只在 npm 瞬时失败时退避重试
 *   node scripts/check-npm-audit-exemptions.mjs --dir X --replay audit.json   # 复放已捕获的 --json 输出
 *
 * 零外部依赖：只用 node 内建模块（child_process / fs / path / url）。
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
/** 临时目录（不引 node:os 也能跨平台：Windows 有 TEMP，其余 TMPDIR//tmp）。 */
const TMP_ROOT = process.env.TMPDIR || process.env.TEMP || '/tmp';

/**
 * audit 面：与 ci.yml `npm-audit.matrix.project` **逐条对齐**。
 * 增删这里必须同批改 ci.yml 的 matrix，否则本地与 CI 的覆盖面又分叉。
 */
export const AUDIT_TARGETS = [
  'apps/admin-api',
  'apps/executor-node',
  'apps/executor-desktop',
  'packages/acf-cli',
  'packages/mcp-server',
];

/** 与 ci.yml 的 `--audit-level=moderate` 及 registry pin 逐字一致。 */
export const NPM_AUDIT_ARGS = [
  'audit',
  '--registry=https://registry.npmjs.org',
  '--omit=dev',
  '--audit-level=moderate',
  '--json',
];

/** 下次复查日期（对齐 ci.yml 注释里的人工承诺，两处必须同批更新）。 */
export const REVIEW_BY = '2026-12-30';

/**
 * 豁免清单 —— **唯一事实源**。原样迁移自 ci.yml npm-audit job 的 `known='...'`
 * （5 条，2026-10-29 迁移；迁移前 CI 侧即这 5 条，无增无减）。
 *
 * 新增豁免必须在此登记 `chain`（链路）+ `reason`（为什么不能修）+ `reviewBy`
 * （到期日）；只往数组里塞个 GHSA 编号不算登记 —— 没有原因的豁免就是无限续期。
 * 到期/清偿的续期与删除由 scripts/check-dependency-review.mjs 常设守卫（它读
 * 本文件的 EXEMPTIONS 作为注册表；见该文件头注）。
 */
export const EXEMPTIONS = [
  {
    ghsa: 'GHSA-528h-pc64-c93x',
    package: 'stream-json',
    severity: 'moderate',
    chain: 'apps/admin-api minio@8.0.7 → stream-json@1.9.1',
    reason:
      'stream-json ≤3.4.0 O(depth²) DoS。minio 8.x 钉 stream-json ^1.8，其 notification.js 硬依赖 ' +
      '`stream-json/jsonl/Parser.js`（v1 路径 + 大写 P）；**N-13 实测不可 override 强升**：' +
      'stream-json@3 把文件改名为 src/jsonl/parser.js 并加 exports map，且 minio.js 第 32 行无条件 ' +
      'eager require notification.js，于是 `require("minio")` 本身即抛 MODULE_NOT_FOUND，整条 S3 日志链全废。' +
      '到期动作=续期豁免或换 S3 客户端，不得 override',
    reviewBy: REVIEW_BY,
  },
  {
    ghsa: 'GHSA-hqr4-qq8f-hg3x',
    package: 'stream-json',
    severity: 'moderate',
    chain: 'apps/admin-api minio@8.0.7 → stream-json@1.9.1',
    reason:
      'stream-json ≤3.5.0 JSONC 解析器对累积注释每次输入整段重扫（O(n²)）。修复版 3.5.1 在 v3，' +
      '与 GHSA-528h 同一不可 override 约束；通知链仅消费 admin 私服内部 MinIO 事件，非公网输入面',
    reviewBy: REVIEW_BY,
  },
  {
    ghsa: 'GHSA-mjw6-4jj6-33hc',
    package: 'stream-json',
    severity: 'moderate',
    chain: 'apps/admin-api minio@8.0.7 → stream-json@1.9.1',
    reason:
      'stream-json <3.6.0 Assembler 原型污染（this.current[this.key] 写在 Object.prototype 上）。' +
      '修复版 3.6.0 在 v3，与 GHSA-528h 同一不可 override 约束；通知链仅消费 admin 私服内部 MinIO 事件，非公网输入面',
    reviewBy: REVIEW_BY,
  },
  {
    ghsa: 'GHSA-7pqw-9j4j-h8q3',
    package: 'extract-zip',
    severity: 'high',
    chain: 'apps/admin-web devDep @lhci/cli@0.15.1 → @puppeteer/browsers → extract-zip@2.0.1',
    reason:
      '符号链接归档条目可导致任意文件写入。**上游无修复版**：extract-zip 最新即 2.0.1（vulnerable ' +
      'range 含 2.0.1），@lhci/cli 最新 0.15.1 无法再升；该链仅 Lighthouse CI 性能审计用，' +
      '不进任何生产构建产物。到期动作=复查上游是否发版或换链，无目标版本不得 override',
    reviewBy: REVIEW_BY,
  },
  {
    ghsa: 'GHSA-jmr9-qjv8-65gv',
    package: 'extract-zip',
    severity: 'high',
    chain: 'apps/admin-web devDep @lhci/cli@0.15.1 → @puppeteer/browsers → extract-zip@2.0.1',
    reason:
      '未校验的符号链接路径穿越。与 GHSA-7pqw-9j4j-h8q3 同一不可修复约束（上游停更，2.0.1 即最新）；' +
      '同样仅 Lighthouse CI 工具链可达',
    reviewBy: REVIEW_BY,
  },
];

/** 命中项里出现的 GHSA 编号（正则口径对齐原 CI 的 `/GHSA-[A-Za-z0-9-]+/`）。 */
const GHSA_RE = /GHSA-[A-Za-z0-9-]{6,}/;

/**
 * 解析 `npm audit --json` 的输出。
 * 容忍 stdout 前面被塞了非 JSON 噪声（只从首个 `{` 起重试一次）；截断/畸形 → null。
 * @returns {{report: object|null, error: string|null}}
 */
export function parseAuditJson(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return { report: null, error: 'npm audit 无任何输出（stdout 为空）' };
  const candidates = [raw];
  const firstBrace = raw.indexOf('{');
  if (firstBrace > 0) candidates.push(raw.slice(firstBrace));
  let lastErr = null;
  for (const cand of candidates) {
    try {
      return { report: JSON.parse(cand), error: null };
    } catch (e) {
      lastErr = e;
    }
  }
  return { report: null, error: `npm audit 输出不是合法 JSON：${lastErr?.message ?? 'unknown'}` };
}

/**
 * 从 audit 报告里提取 advisory 命中项（GHSA 去重，保留包名/severity/title 供打印）。
 * `via` 里的**字符串**是传递依赖的包名（不是 advisory），必须跳过 —— 原 CI 的
 * `typeof via === "object"` 判据同理。
 */
export function extractFindings(report) {
  const vulns =
    report && typeof report === 'object' && report.vulnerabilities && typeof report.vulnerabilities === 'object'
      ? Object.values(report.vulnerabilities)
      : [];
  const byKey = new Map();
  for (const v of vulns) {
    if (!v || typeof v !== 'object') continue;
    const pkg = typeof v.name === 'string' && v.name ? v.name : '(unknown)';
    for (const via of Array.isArray(v.via) ? v.via : []) {
      if (!via || typeof via !== 'object') continue;
      const m = GHSA_RE.exec(String(via.url ?? ''));
      if (!m) continue;
      const key = `${m[0]} | ${pkg}`;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        ghsa: m[0],
        package: pkg,
        severity: via.severity ?? v.severity ?? '(unknown)',
        title: via.title ?? '(no title)',
      });
    }
  }
  return [...byKey.values()].sort(
    (a, b) => a.ghsa.localeCompare(b.ghsa) || a.package.localeCompare(b.package),
  );
}

/**
 * 判据本体（纯函数，无 IO）：报告 + 注册表 → 判定结果。
 * @returns {{ok: boolean, problems: string[], findings: object[], registered: object[], unregistered: object[]}}
 */
export function evaluateAuditReport(report, exemptions = EXEMPTIONS) {
  const problems = [];
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    return {
      ok: false,
      problems: ['npm audit 输出不是 JSON 对象'],
      findings: [],
      registered: [],
      unregistered: [],
    };
  }
  // npm 失败时**仍然会往 stdout 打一个 {"error":{...}}**（实测 ENOLOCK 即如此），
  // 因此「能 parse」不等于「audit 成功」——必须显式识别 error 字段。
  if (report.error) {
    const e = report.error;
    const detail = typeof e === 'object' ? `${e.code ?? '(no code)'} — ${e.summary ?? ''}` : String(e);
    problems.push(`npm audit 自身失败：${detail.trim()}`);
  }
  const hasVulns =
    report.vulnerabilities !== undefined &&
    report.vulnerabilities !== null &&
    typeof report.vulnerabilities === 'object';
  if (!hasVulns) {
    if (problems.length === 0) {
      problems.push('npm audit 输出缺少 vulnerabilities 字段（结构不符，按失败处理，不当成「无漏洞」）');
    }
    return { ok: false, problems, findings: [], registered: [], unregistered: [] };
  }
  const findings = extractFindings(report);
  const registry = new Set(exemptions.map((e) => e.ghsa));
  const registered = findings.filter((f) => registry.has(f.ghsa));
  const unregistered = findings.filter((f) => !registry.has(f.ghsa));
  return {
    ok: problems.length === 0 && unregistered.length === 0,
    problems,
    findings,
    registered,
    unregistered,
  };
}

/** 未登记漏洞的单行格式：`GHSA / 包名 / severity / title`（可 grep 的稳定格式）。 */
export function formatFinding(f) {
  return `${f.ghsa} / ${f.package} / ${f.severity} / ${f.title}`;
}

/** 执行 npm audit（不抛异常；失败信息进返回值）。 */
export function runAudit(dir) {
  const res = spawnSync('npm', NPM_AUDIT_ARGS, {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // Windows 上 npm 是 npm.cmd，spawn 不带 shell 会 ENOENT
    shell: process.platform === 'win32',
  });
  if (res.error) {
    return { stdout: '', stderr: String(res.error.message ?? res.error), status: null, spawnError: res.error };
  }
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status, spawnError: null };
}

/**
 * npm registry 的 audit endpoint 偶发 503 / 瞬时不可用（**不是真实漏洞**）。
 * 原 CI 的做法是无差别重试 3 次整段脚本；这里只对「npm 自身失败」重试，且只认下面这些
 * 可判定为瞬时错误的信号 —— 真实命中（未登记漏洞）与确定性失败（ENOLOCK、JSON 畸形、
 * 缺 lockfile）绝不重试：把确定性失败重试 3 次只会让红灯晚 90 秒出现。
 */
const TRANSIENT_RE =
  /EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|EPIPE|E50[0-9]|socket hang up|audit endpoint returned an error/i;

/** 该失败是否值得退避重试（导出供自检钉住判据）。 */
export function isTransientNpmFailure(problems) {
  return (problems ?? []).some((p) => TRANSIENT_RE.test(String(p)));
}

/** 同步睡眠（零依赖：不引 timers/promises，也不阻塞逻辑正确性）。 */
function sleepSync(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 重试间隔；自检用 env 覆盖成 0，避免自检真的睡 90 秒。 */
const RETRY_DELAY_MS = Number(process.env.ACF_AUDIT_RETRY_DELAY_MS ?? 30_000);

/** 单个 audit 面的完整判定（含目录/lockfile 前置检查）。一次尝试，不含重试。 */
/**
 * 相对路径的解析口径：**先 cwd，后仓库根**。
 *   · CI 用 `working-directory: ${{ matrix.project }}` + `--dir .` ⇒ 必须落在 cwd；
 *   · 本地在仓库根跑 `--dir apps/admin-api` ⇒ cwd 就是仓库根，两者一致；
 *   · 从子目录误跑 `--dir apps/executor-node` ⇒ cwd 落空时回落到仓库根，仍然对。
 * 默认的 5 个 audit 面是仓库相对常量，永远按仓库根解析。
 * 解析失败时把两个候选都打印出来，避免「目录不存在」让人猜是哪个基准。
 */
function resolveTargetDir(targetDir) {
  const fromCwd = path.resolve(process.cwd(), targetDir);
  const fromRoot = path.resolve(ROOT, targetDir);
  for (const c of [fromCwd, fromRoot]) {
    try {
      if (existsSync(c) && statSync(c).isDirectory()) return { abs: c, candidates: [fromCwd, fromRoot] };
    } catch {
      /* ignore */
    }
  }
  return { abs: null, candidates: [...new Set([fromCwd, fromRoot])] };
}

function auditOnce(targetDir, { replayFile = null, exemptions = EXEMPTIONS, defaultTarget = false } = {}) {
  // 默认清单是仓库相对常量；显式 --dir 走 cwd 优先的解析。
  const resolved = defaultTarget
    ? { abs: path.resolve(ROOT, targetDir), candidates: [path.resolve(ROOT, targetDir)] }
    : resolveTargetDir(targetDir);
  const abs = resolved.abs;
  const header = { dir: targetDir, abs: abs ?? targetDir };

  if (!abs) {
    return {
      ...header,
      ok: false,
      npmFailure: false,
      problems: [`目录不存在：${resolved.candidates.join(' 或 ')}`],
      findings: [],
      registered: [],
      unregistered: [],
    };
  }

  let stdout = '';
  let stderr = '';
  if (replayFile) {
    try {
      const replayAbs = [path.resolve(process.cwd(), replayFile), path.resolve(ROOT, replayFile)].find((c) => existsSync(c)) ?? path.resolve(process.cwd(), replayFile);
      stdout = readFileSync(replayAbs, 'utf8');
    } catch (e) {
      return {
        ...header,
        ok: false,
        npmFailure: false,
        problems: [`--replay 读取失败：${e.message}`],
        findings: [],
        registered: [],
        unregistered: [],
      };
    }
  } else {
    // audit 只需 lockfile 解析依赖树；缺了 npm 会以 ENOLOCK 失败——这里先给可读的原因，
    // 仍然走 fail-closed（不是「跳过」）。
    if (!existsSync(path.join(abs, 'package-lock.json'))) {
      return {
        ...header,
        ok: false,
        npmFailure: false,
        problems: [`缺少 package-lock.json：npm audit 只能解析 lockfile 的依赖树（${abs}）`],
        findings: [],
        registered: [],
        unregistered: [],
      };
    }
    const r = runAudit(abs);
    stderr = r.stderr;
    if (r.spawnError) {
      const tail = stderr.split('\n').filter(Boolean).slice(-3).join(' | ');
      return {
        ...header,
        ok: false,
        npmFailure: true,
        problems: [`无法执行 npm audit：${r.spawnError.message}${tail ? `（${tail}）` : ''}`],
        findings: [],
        registered: [],
        unregistered: [],
      };
    }
    stdout = r.stdout;
  }

  const parsed = parseAuditJson(stdout);
  if (parsed.error) {
    const tail = String(stderr ?? '')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .slice(-3)
      .join(' | ');
    return {
      ...header,
      ok: false,
      npmFailure: true,
      problems: [parsed.error + (tail ? `｜npm stderr：${tail}` : '')],
      findings: [],
      registered: [],
      unregistered: [],
    };
  }

  const ev = evaluateAuditReport(parsed.report, exemptions);
  // problems 非空 = npm 报错或输出结构不符（可重试）；unregistered 非空 = 真实命中，不重试。
  return { ...header, ...ev, npmFailure: ev.problems.length > 0 };
}

/**
 * 带退避重试地审一个目录：只在「npm 自身失败且错误形态属瞬时」时重试。
 * @param {number} retries 额外重试次数（总尝试 = retries + 1）
 */
function auditWithRetries(targetDir, { replayFile = null, exemptions = EXEMPTIONS, retries = 0, defaultTarget = false } = {}) {
  const attempts = replayFile ? 1 : Math.max(0, retries) + 1;
  let result;
  for (let i = 0; i < attempts; i++) {
    result = auditOnce(targetDir, { replayFile, exemptions, defaultTarget });
    const retryable = result.npmFailure === true && isTransientNpmFailure(result.problems);
    if (!retryable || i + 1 >= attempts) break;
    const wait = RETRY_DELAY_MS * (i + 1);
    console.error(
      `   … ${targetDir}：npm audit 瞬时失败（第 ${i + 1}/${attempts} 次），${Math.round(wait / 1000)}s 后重试`,
    );
    sleepSync(wait);
  }
  return result;
}

function printResult(r) {
  console.log(`── npm audit（${r.dir}）`);
  for (const p of r.problems) console.error(`   ✘ ${p}`);
  if (r.unregistered.length > 0) {
    console.error(`   ✘ 未登记漏洞 ${r.unregistered.length} 条（fail-closed：新增豁免必须显式登记原因+复查日期）`);
    for (const f of r.unregistered) console.error(`     ${formatFinding(f)}`);
    console.error(
      `     登记处：scripts/check-npm-audit-exemptions.mjs 的 EXEMPTIONS（唯一事实源，CI 与本脚本共用）`,
    );
  }
  if (r.ok) {
    if (r.findings.length === 0) {
      console.log('   ✔ 无 moderate+ 命中（vulnerabilities 为空）');
    } else {
      const ghsas = [...new Set(r.registered.map((f) => f.ghsa))].sort();
      console.log(`   ✔ 全部为已裁决豁免：${ghsas.length} 条 GHSA（${ghsas.join(', ')}）`);
      console.log(
        `     下次复查日期：${REVIEW_BY}（登记表 ${EXEMPTIONS.length} 条，见 scripts/check-npm-audit-exemptions.mjs）`,
      );
    }
  }
}

function usage() {
  console.log('用法: node scripts/check-npm-audit-exemptions.mjs [选项]');
  console.log('');
  console.log('  --dir <path>     只审这一个目录（可重复；默认审 ' + AUDIT_TARGETS.length + ' 个 audit 面）');
  console.log('  --selftest       离线自检（内置 fixture，不联网、不跑 npm）');
  console.log('  --replay <json>  复放已捕获的 `npm audit --json` 输出（仅 --dir 单个时可用；排障/selftest 用）');
  console.log('  --retries <n>    仅对「npm 自身瞬时失败」（503/EAI_AGAIN/超时）退避重试 n 次（默认 0）');
  console.log('  -h, --help       本帮助');
  console.log('');
  console.log('退出码: 0=命中全部已登记豁免 / 1=未登记漏洞或 npm 失败 / 2=用法错误');
}

function fail(msg, code = 1) {
  console.error(`✘ ${msg}`);
  process.exit(code);
}

// ─────────────────────────────── 自检 ───────────────────────────────
// 判据的每一条都要有 fixture 钉着。**防「清单退化成死数据」**是这里最容易被忽略
// 的一条：如果 fixture 只覆盖 2 条豁免，剩下 3 条即便在真实世界里永远匹配不到，
// 也永远不会有任何测试报错——清单看起来"有 5 条"，实际生效 2 条。
function selftest() {
  let failed = 0;
  const assert = (name, cond, extra = '') => {
    if (cond) {
      console.log(`  ✔ ${name}`);
    } else {
      failed++;
      console.error(`  ✘ ${name}${extra ? `　→ ${extra}` : ''}`);
    }
  };

  // 真实形态的 fixture（2026-10-29 实测 apps/admin-api 的 audit 输出结构）：
  //   · minio 条目的 via 是字符串（传递依赖名），不含 GHSA → 不得计入；
  //   · stream-json 条目的 via 是对象数组，url 里带 3 个 GHSA。
  const realShape = {
    auditReportVersion: 2,
    vulnerabilities: {
      minio: {
        name: 'minio',
        severity: 'moderate',
        via: ['stream-json'],
        effects: [],
        range: '8.0.7',
        nodes: ['node_modules/minio'],
        fixAvailable: false,
      },
      'stream-json': {
        name: 'stream-json',
        severity: 'moderate',
        via: [
          {
            source: 1,
            name: 'stream-json',
            dependency: 'stream-json',
            title: 'stream-json is vulnerable to denial of service',
            url: 'https://github.com/advisories/GHSA-528h-pc64-c93x',
            severity: 'moderate',
            range: '<=3.4.0',
          },
          {
            source: 2,
            name: 'stream-json',
            dependency: 'stream-json',
            title: 'JSONC parser re-scans accumulated comments',
            url: 'https://github.com/advisories/GHSA-hqr4-qq8f-hg3x',
            severity: 'moderate',
            range: '<=3.5.0',
          },
          {
            source: 3,
            name: 'stream-json',
            dependency: 'stream-json',
            title: 'Assembler prototype pollution',
            url: 'https://github.com/advisories/GHSA-mjw6-4jj6-33hc',
            severity: 'moderate',
            range: '<3.6.0',
          },
        ],
        effects: ['minio'],
        range: '1.9.1',
        nodes: ['node_modules/stream-json'],
        fixAvailable: false,
      },
    },
    metadata: { dependencies: { prod: 100, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 100 } },
  };
  // dev-only 链的 fixture（admin-web 的 @lhci/cli → @puppeteer/browsers → extract-zip）。
  // 注意：`--omit=dev` 的 audit 面**永远命中不到**这两条 —— 它们只在不带 --omit=dev 的
  // 审计（Dependabot / 本地全量 npm audit）里出现。保留在清单里是因为 CI 的 known= 与
  // scripts/check-dependency-review.mjs 的注册表都有它们（两边必须一致）；fixture 必须
  // 覆盖它们，否则这 2 条就成了「永远匹配不到、也永远不会有测试报错」的死数据。
  const devChainShape = {
    auditReportVersion: 2,
    vulnerabilities: {
      'extract-zip': {
        name: 'extract-zip',
        severity: 'high',
        via: [
          {
            source: 11,
            name: 'extract-zip',
            dependency: 'extract-zip',
            title: 'extract-zip allows arbitrary file write via symlink',
            url: 'https://github.com/advisories/GHSA-7pqw-9j4j-h8q3',
            severity: 'high',
            range: '<=2.0.1',
          },
          {
            source: 12,
            name: 'extract-zip',
            dependency: 'extract-zip',
            title: 'extract-zip symlink path traversal',
            url: 'https://github.com/advisories/GHSA-jmr9-qjv8-65gv',
            severity: 'high',
            range: '<=2.0.1',
          },
        ],
        effects: [],
        range: '2.0.1',
        nodes: ['node_modules/extract-zip'],
        fixAvailable: false,
      },
    },
    metadata: { dependencies: { prod: 0, dev: 200, optional: 0, peer: 0, peerOptional: 0, total: 200 } },
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ① 全豁免 → 0
  {
    const r = evaluateAuditReport(realShape);
    assert(
      '全豁免 → ok=true（且恰好 3 条 GHSA 全部登记）',
      r.ok === true && r.unregistered.length === 0 && new Set(r.registered.map((f) => f.ghsa)).size === 3,
      `ok=${r.ok} unregistered=${r.unregistered.length} registered=${JSON.stringify(r.registered.map((x) => x.ghsa))}`,
    );
    assert('via 里的字符串（传递依赖名）不被误当 advisory', r.findings.every((f) => f.ghsa.startsWith('GHSA-')));
  }

  // ①b dev 链 fixture（extract-zip 两条）同样全豁免 → 0
  {
    const r = evaluateAuditReport(devChainShape);
    assert(
      'dev 链 fixture（extract-zip ×2）→ ok=true',
      r.ok === true && new Set(r.registered.map((f) => f.ghsa)).size === 2,
      JSON.stringify(r.unregistered),
    );
  }

  // ② 含未豁免 → 1，且逐条列出 GHSA/包名/severity/title
  {
    const withNew = clone(realShape);
    withNew.vulnerabilities['evil-pkg'] = {
      name: 'evil-pkg',
      severity: 'high',
      via: [
        {
          source: 99,
          name: 'evil-pkg',
          dependency: 'evil-pkg',
          title: 'Prototype pollution in evil-pkg',
          url: 'https://github.com/advisories/GHSA-9zzz-yyyy-xxxx',
          severity: 'high',
          range: '<1.0.0',
        },
      ],
      effects: [],
      range: '*',
      nodes: ['node_modules/evil-pkg'],
      fixAvailable: false,
    };
    const r = evaluateAuditReport(withNew);
    assert('含未豁免 GHSA → ok=false', r.ok === false);
    assert(
      '未豁免项被单独列出（不是混进已登记里）',
      r.unregistered.length === 1 && r.unregistered[0].ghsa === 'GHSA-9zzz-yyyy-xxxx',
      JSON.stringify(r.unregistered),
    );
    const line = formatFinding(r.unregistered[0]);
    assert(
      '失败行格式 = GHSA / 包名 / severity / title',
      line === 'GHSA-9zzz-yyyy-xxxx / evil-pkg / high / Prototype pollution in evil-pkg',
      line,
    );
  }

  // ③ 空 vulnerabilities → 0（「确实没有漏洞」是合法绿，不能因为空而报错）
  {
    const r = evaluateAuditReport({ auditReportVersion: 2, vulnerabilities: {}, metadata: {} });
    assert('空 vulnerabilities → ok=true', r.ok === true && r.findings.length === 0);
  }

  // ④ JSON 畸形 → 1（截断/纯文本都不能被当成「无漏洞」）
  {
    const truncated = parseAuditJson('{"vulnerabilities": {"stream-json": {');
    assert('截断 JSON → 解析失败', truncated.report === null && typeof truncated.error === 'string');
    const garbage = parseAuditJson('npm error something went wrong');
    assert('非 JSON 文本 → 解析失败', garbage.report === null);
    assert('空 stdout → 解析失败', parseAuditJson('   ').report === null);
    const r = evaluateAuditReport(null);
    assert('null 报告 → ok=false（fail-closed）', r.ok === false && r.problems.length > 0);
  }

  // ⑤ npm 自身失败（ENOLOCK 实测形态：stdout 就是 {"error":{...}}）→ 1
  {
    const parsed = parseAuditJson(
      JSON.stringify({
        error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile.', detail: 'x' },
      }),
    );
    const r = evaluateAuditReport(parsed.report);
    assert(
      'npm error 报告 → ok=false 且带错误码（不当成「无漏洞」）',
      r.ok === false && r.problems.some((p) => p.includes('ENOLOCK')),
      JSON.stringify(r.problems),
    );
    const missing = evaluateAuditReport({ auditReportVersion: 2, metadata: {} });
    assert('缺 vulnerabilities 字段 → ok=false（结构不符按失败）', missing.ok === false);
  }

  // ⑥ 注册表卫生 + fixture 覆盖（防清单退化成死数据）
  {
    const ids = EXEMPTIONS.map((e) => e.ghsa);
    assert('豁免清单无重复', new Set(ids).size === ids.length, ids.join(','));
    assert(
      '每条豁免都有 reason 与合法 reviewBy',
      EXEMPTIONS.every((e) => typeof e.reason === 'string' && e.reason.length > 20 && /^\d{4}-\d{2}-\d{2}$/.test(e.reviewBy)),
    );
    const fixtureSet = new Set([
      ...extractFindings(realShape).map((f) => f.ghsa),
      ...extractFindings(devChainShape).map((f) => f.ghsa),
    ]);
    const missingInFixture = ids.filter((id) => !fixtureSet.has(id));
    assert(
      `清单里每一条都在自检 fixture 中出现过（防止某条永远匹配不到却永远绿）`,
      missingInFixture.length === 0,
      `fixture 缺：${missingInFixture.join(', ')}`,
    );
    assert(
      '默认 audit 面与 ci.yml matrix 同规模（5 个）',
      AUDIT_TARGETS.length === 5 && AUDIT_TARGETS.includes('apps/executor-desktop'),
      AUDIT_TARGETS.join(','),
    );
  }

  // ⑦ CLI 全链路（子进程；--dir 直查 / --replay 复放，均不联网）
  {
    const tmp = mkdtempSync(path.join(TMP_ROOT, 'acf-audit-selftest-'));
    try {
      const good = path.join(tmp, 'good.json');
      writeFileSync(good, JSON.stringify(realShape), 'utf8');
      const bad = path.join(tmp, 'bad.json');
      writeFileSync(bad, '{"vulnerabilities": {"stream-json": {', 'utf8');

      const cli = (args) => spawnSync(process.execPath, [SELF, ...args], { encoding: 'utf8', timeout: 120_000 });

      const g = cli(['--dir', 'apps/admin-api', '--replay', good]);
      assert(
        'CLI: 已捕获报告（全豁免）→ exit 0 且打印「全部为已裁决豁免」+ 复查日期',
        g.status === 0 && g.stdout.includes('全部为已裁决豁免') && g.stdout.includes(REVIEW_BY),
        `status=${g.status} out=${(g.stdout || '').trim().slice(0, 200)}`,
      );

      const b = cli(['--dir', 'apps/admin-api', '--replay', bad]);
      assert(
        'CLI: JSON 畸形 → exit 1',
        b.status === 1 && (b.stderr || '').includes('不是合法 JSON'),
        `status=${b.status} err=${(b.stderr || '').trim().slice(0, 200)}`,
      );

      const n = cli(['--dir', 'apps/admin-api', '--replay', path.join(tmp, 'does-not-exist.json')]);
      assert('CLI: --replay 文件不存在 → exit 1', n.status === 1, `status=${n.status}`);

      const d = cli(['--dir', 'no/such/dir-acf-selftest']);
      assert(
        'CLI: --dir 不存在 → exit 1（且在跑 npm 之前就失败）',
        d.status === 1 && (d.stderr || '').includes('目录不存在'),
        `status=${d.status} err=${(d.stderr || '').trim().slice(0, 200)}`,
      );

      const u = cli(['--bogus-flag']);
      assert('CLI: 未知参数 → exit 2（用法错误，不伪装成审计失败）', u.status === 2, `status=${u.status}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ⑧ 重试判据：只有「npm 自身瞬时失败」才重试
  {
    assert(
      'ENOLOCK（确定性失败）不重试',
      isTransientNpmFailure(['npm audit 自身失败：ENOLOCK — This command requires an existing lockfile.']) === false,
    );
    assert('EAI_AGAIN 判为瞬时（可重试）', isTransientNpmFailure(['npm audit 自身失败：EAI_AGAIN — network']) === true);
    assert(
      'registry 503 判为瞬时（可重试）',
      isTransientNpmFailure(['npm audit 输出不是合法 JSON：audit endpoint returned an error (503)']) === true,
    );
    assert('未登记漏洞的报错文本不属瞬时（真实命中不重试）', isTransientNpmFailure([]) === false);
  }

  // ⑨ 重试链路的端到端形态：用 PATH 上的假 npm 数调用次数（不联网、不跑真 npm）
  if (process.platform === 'win32') {
    console.log('  ⚠ 跳过「重试次数」端到端子项（Windows 无 POSIX shim）');
  } else {
    const tmp = mkdtempSync(path.join(TMP_ROOT, 'acf-audit-retry-'));
    try {
      const fakeBin = path.join(tmp, 'bin');
      mkdirSync(fakeBin);
      const counter = path.join(tmp, 'calls.log');
      const proj = path.join(tmp, 'proj');
      mkdirSync(proj);
      // audit 只解析 lockfile，内容无需真实
      writeFileSync(path.join(proj, 'package-lock.json'), '{}', 'utf8');

      const writeFakeNpm = (payload) => {
        const f = path.join(fakeBin, 'npm');
        writeFileSync(f, `#!/bin/sh\necho x >> "$ACF_FAKE_COUNT"\nprintf '%s' '${payload}'\nexit 1\n`, 'utf8');
        chmodSync(f, 0o755);
      };
      const calls = () => (existsSync(counter) ? readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0);
      const reset = () => { try { rmSync(counter, { force: true }); } catch { /* ignore */ } };
      const runCli = (args, opts = {}) =>
        spawnSync(process.execPath, [SELF, ...args], {
          encoding: 'utf8',
          timeout: 120_000,
          cwd: opts.cwd,
          env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`, ACF_FAKE_COUNT: counter, ACF_AUDIT_RETRY_DELAY_MS: '0' },
        });

      writeFakeNpm('{"error":{"code":"EAI_AGAIN","summary":"request to https://registry.npmjs.org failed, reason: EAI_AGAIN"}}');
      reset();
      const r3 = runCli(['--dir', proj, '--retries', '2']);
      assert(
        '瞬时失败 + --retries 2 → 共调用 npm 3 次且 exit 1',
        r3.status === 1 && calls() === 3,
        `status=${r3.status} calls=${calls()}`,
      );

      reset();
      const r0 = runCli(['--dir', proj]);
      assert('瞬时失败但未给 --retries → 只调用 1 次（默认不拖慢本地）', r0.status === 1 && calls() === 1, `calls=${calls()}`);

      // CI 形态：`working-directory: <pkg>` + `--dir .` —— `.` 必须落在 cwd，而不是仓库根
      // （仓库根没有 package-lock.json，会把每个 matrix leg 都误报成「缺 lockfile」）。
      writeFakeNpm('{"error":{"code":"EAI_AGAIN","summary":"network"}}');
      reset();
      const rDot = runCli(['--dir', '.'], { cwd: proj });
      assert(
        'CI 形态 `--dir .`（cwd=包目录）解析到 cwd 而非仓库根',
        rDot.status === 1 && calls() === 1 && !(rDot.stderr ?? '').includes('目录不存在') && !(rDot.stderr ?? '').includes('缺少 package-lock.json'),
        `status=${rDot.status} calls=${calls()} err=${(rDot.stderr ?? '').trim().slice(0, 160)}`,
      );

      writeFakeNpm('{"error":{"code":"ENOLOCK","summary":"This command requires an existing lockfile."}}');
      reset();
      const rd = runCli(['--dir', proj, '--retries', '2']);
      assert(
        '确定性失败（ENOLOCK）+ --retries 2 → 仍只调用 1 次（不把确定性红灯拖 90 秒）',
        rd.status === 1 && calls() === 1,
        `calls=${calls()}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  if (failed > 0) {
    console.error(`\n✘ check-npm-audit-exemptions 自检失败：${failed} 条`);
    process.exit(1);
  }
  console.log('\n✔ check-npm-audit-exemptions 自检通过（判据逐条有 fixture 钉着；清单无死数据）');
  process.exit(0);
}

// ─────────────────────────────── 运行 ───────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    if (argv.length > 1 && !(argv.length === 2 && argv.includes('--selftest'))) {
      // 允许 --selftest 与其他无副作用参数共存会很乱；直接要求独占，避免误用。
      fail('--selftest 不能与其它参数同时使用', 2);
    }
    selftest();
    return;
  }
  if (argv.includes('-h') || argv.includes('--help')) {
    usage();
    return;
  }

  const targets = [];
  let replayFile = null;
  let retries = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir' || a.startsWith('--dir=')) {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      if (!v) fail('--dir 需要一个路径参数', 2);
      targets.push(v);
    } else if (a === '--replay' || a.startsWith('--replay=')) {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      if (!v) fail('--replay 需要一个文件路径', 2);
      replayFile = v;
    } else if (a === '--retries' || a.startsWith('--retries=')) {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 10) fail('--retries 需要 0..10 的整数', 2);
      retries = n;
    } else {
      fail(`未知参数：${a}（--help 看用法）`, 2);
    }
  }
  if (replayFile && targets.length !== 1) {
    fail('--replay 只能与单个 --dir 搭配使用（复放的是某一个 audit 面的输出）', 2);
  }
  const usingDefaults = targets.length === 0;
  const list = usingDefaults ? AUDIT_TARGETS : targets;

  console.log(`npm audit 豁免判定（单一事实源：scripts/check-npm-audit-exemptions.mjs）`);
  console.log(`审计面：${list.length} 个｜登记豁免：${EXEMPTIONS.length} 条｜下次复查：${REVIEW_BY}`);
  if (replayFile) console.log(`复放模式：${replayFile}（未调用 npm）`);
  console.log('');

  const results = list.map((d) => auditWithRetries(d, { replayFile, retries, defaultTarget: usingDefaults }));
  for (const r of results) printResult(r);

  const bad = results.filter((r) => !r.ok);
  console.log('');
  if (bad.length > 0) {
    const first = bad[0];
    const detail = first.unregistered.length > 0
      ? `未登记漏洞 ${first.unregistered.map((f) => f.ghsa).join(', ')}`
      : (first.problems[0] ?? 'unknown');
    console.error(`::error::npm audit 豁免判定失败（${bad.length}/${results.length} 个审计面）：${detail}`);
    console.error(`✘ npm-audit 失败：${bad.length}/${results.length} 个审计面未通过（详见上方逐条输出）`);
    process.exit(1);
  }
  console.log(
    `::notice::npm audit：${results.length} 个审计面全部为已裁决豁免（SEC-06 / CIR-03）。Next review date: ${REVIEW_BY}.`,
  );
  console.log(`✔ npm-audit 通过：${results.length} 个审计面全部为已裁决豁免，下次复查 ${REVIEW_BY}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main();
}
