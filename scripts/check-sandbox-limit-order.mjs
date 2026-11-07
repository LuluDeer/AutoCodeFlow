#!/usr/bin/env node
/**
 * 内存上限次序不变量守卫：**任务上限 < 容器上限**（S4 横切分析 §C1，2026-10-31）。
 *
 * ## 这条判据挡的是什么事故
 *
 * 两侧执行器都各自有 per-task 内存上限（python 是 `task_memory_limit_mb`
 * → RLIMIT_AS；node 是 `TASK_MEMORY_LIMIT_MB` → 任务进程树 RSS 看门狗），
 * 容器又有一道 mem_limit。两者次序一旦**倒挂**（任务上限 ≥ 容器上限），
 * 任务级上限就**永远不会先触发**：内存涨到容器 cap 时接手的是**内核 cgroup
 * OOM killer**，它按内核自己的规则挑受害者——可能是同容器里另一个任务的
 * 进程，甚至执行器自身（`apps/executor-node/src/routes/execute.ts:3336-3380`
 * 只能事后说「SIGKILL 只能由外部发出」）。后果是 ① 归因丢失，
 * ② 邻任务陪葬。次序正确时，先触发的是**我们自己的**进程树杀 + 专属文案，
 * 只死一个任务、并且知道是谁。
 *
 * 首跑实测（2026-10-31，本次修复**前**）：`docker-compose.yml` 两个执行器容器
 * 都是 `mem_limit: 1G`（当时在 :405/:551），而 compose **没有**给它们注入
 * `TASK_MEMORY_LIMIT_MB` → 容器内回落到代码默认 2048MB
 * （`apps/executor-python/config.py:476`、`apps/executor-node/src/config.ts:461`）
 * ⇒ 2048 > 1024，**倒挂**，两侧的任务级上限在默认 compose 下是死代码。
 * `docker-compose.staging.yml` 还把容器减半到 768m，倒挂更甚（同文件已为
 * admin-api / executor-node 的堆上限处理过同一类事故，见 `STAGING-HEAP`
 * 注释——内存上限必须**成组**下调）。修复后基线注入 768（容器 1G）、staging
 * 注入 512（容器 768m）；改任一侧时本守卫会红。
 *
 * ## 判据（基于真实配置来源，不写死数值清单）
 *
 * 对每个 executor 服务（`executor-python` / `executor-node`）：
 *
 *   容器上限 = compose 服务块的 `mem_limit`；缺省回落到
 *              `deploy.resources.limits.memory`；
 *   任务上限 = 服务块 `environment` 里的 `TASK_MEMORY_LIMIT_MB`（**字面量**
 *              `768` / `768m`）；**缺省回落到该端代码里的默认常量**
 *              （python `config.py` 的 `task_memory_limit_mb`、node
 *              `config.ts` 的 `taskMemoryLimitMb` getter）；
 *   断言     = 任务上限 **严格小于** 容器上限，且任务上限 ≠ 0（0 = 不限，
 *              等价于「没有任务上限」，在容器 cap 下仍是倒挂）。
 *
 * overlay（根目录下除基础文件以外的 `docker-compose*.yml`）按 compose 的
 * 合并语义参与：overlay 若给某个 executor 设了 `mem_limit`，容器上限取
 * overlay 的；其 `environment` 覆盖基础值。「容器减半、任务上限没跟着减」
 * 正是最容易漏的一类倒挂，所以 overlay 单独判一次。
 *
 * **数值漂移不判红**：把某端默认从 2048 调到 1536 之类，只要仍 < 容器上限就
 * 一路绿；只有**次序反转**（≥）才红。本判据刻意**不**检查：
 *
 *   · 执行器**自身**的堆上限（`NODE_OPTIONS=--max-old-space-size`）与容器上限
 *     的关系——那是另一个同类问题（staging overlay 已为 admin-api /
 *     executor-node 单独特判）。因此更强的「任务上限 + 执行器自身占用 <
 *     容器上限」账本，本守卫**不验**（见文件末「已知薄弱处」）；
 *   · per-process（RLIMIT_AS 虚拟地址空间）与 per-tree（RSS 采样）的**口径
 *     差异**，也不验采样间隔、瞬时尖峰、cgroup 具体行为；
 *   · 裸机 / systemd / 桌面执行器：没有容器 cap，不变量真空成立，本守卫不看；
 *   · 非 executor 服务（postgres / redis / admin-api 的内存与堆关系）；
 *   · CPU / pids / nofile / 磁盘上限（各有自己的限制，不在本条）。
 *
 * ## 判据不可信时判「结构红」，不判绿
 *
 * 事实源缺失、`services:` 解析不出、服务数塌到下界、内存值形态无法静态判读
 * （非内存字面量、以及任何 `${…}` 插值——插值的默认值会被 `.env` 静默覆盖，
 * 守卫只看到一半真相，报绿就是假绿）、代码默认常量解析不出——一律结构红，
 * 文案说明「判据瞎了」，绝不静默当合规。**两个数都请写死**：它们本该在同一个
 * 服务块里成对出现，一个 diff 就能复核次序。
 *
 * 纯静态读取，不需要 docker / npm ci。解析约定（服务块边界、行内注释剥离、
 * environment 取值）与 `scripts/check-compose-sandbox.mjs` 同形，便于两处对照。
 *
 * ## 已知薄弱处
 *
 * node 的代码默认值是**在 `config.ts` 源码里正则抓的**（getter 内
 * `!Number.isFinite(raw)) return <n>;`）。它比读配置项脆：重构 getter 的
 * 写法会让本守卫报结构红（对着改即可，不会假绿），但换一种「默认值来自别处」
 * 的写法时可能抓不到——用 `--selftest` 的 ⑭ 用例钉住这种失败必须是**显式结构红**。
 *
 * 用法：`node scripts/check-sandbox-limit-order.mjs [--selftest] [--root <dir>]`
 *   --selftest：在临时 fixture 树里跑**真脚本**（子进程），逐条断言退出码 +
 *               关键报错文本 + <1s；含两条正例控制组。
 *   --root    ：把该目录当仓库根（默认 process.cwd()）；selftest 专用。
 *
 * 退出码：全通过 0；任一失败（含结构红）1。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";
// R163：覆盖计数出口。**必须在任何 require/依赖之前**打印 —— 本文件若因缺依赖崩掉，
// 「崩了」与「零用例」必须能被哨兵分开看（`scripts/lib/agent-coverage.mjs` 头注同款纪律）。
printCoverageBanner(import.meta.url, "subprocess");

export const BASE_COMPOSE_REL = "docker-compose.yml";

/** 扫描面下界（基础 compose 实测 20+ 个服务）。塌到下界以下 = 判据失效，不是全绿。 */
export const MIN_COMPOSE_SERVICES = 10;

/**
 * 需要参与次序判定的服务：任务级内存上限的两端。
 *
 * `runtime` 决定从哪份源码抓「compose 没注入时的默认常量」；`codeDefaultRel`
 * 是代码默认值的事实源，也是「判据无从校验」时的定位信息。
 */
export const EXECUTOR_SERVICES = [
  {
    name: "executor-python",
    runtime: "python",
    codeDefaultRel: "apps/executor-python/config.py",
  },
  {
    name: "executor-node",
    runtime: "node",
    codeDefaultRel: "apps/executor-node/src/config.ts",
  },
];

/** 任务级上限的环境变量名（两侧同名同义）。 */
export const TASK_LIMIT_ENV = "TASK_MEMORY_LIMIT_MB";

const MB = 1024 * 1024;
const UNITS = { "": 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024, t: 1024 ** 4 };

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 剥掉 YAML **行内**注释（`#` 未落在引号里且其前是行首/空白）。
 * 与 `check-compose-sandbox.mjs` 的 `stripInlineComment` 同一语义：
 * `mem_limit: 1G # 容器上限` 是配置，`# mem_limit: 1G` 不是。
 */
export function stripInlineComment(value) {
  const raw = String(value ?? "");
  let quote = null;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "#" && (i === 0 || /[ \t]/.test(raw[i - 1]))) {
      return raw.slice(0, i).trimEnd();
    }
  }
  return raw.trim();
}

/**
 * 解析 compose 的顶层服务名清单（`services:` 下两空格缩进的键）。
 * @returns {string[]|null} 无 `services:` 块时 null（调用方判结构红）
 */
export function parseTopLevelServices(composeText) {
  const lines = String(composeText ?? "").split(/\r?\n/);
  const start = lines.findIndex((l) => /^services:[ \t]*(?:#.*)?$/.test(l));
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // 下一个顶层键
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const m = line.match(/^ {2}([A-Za-z0-9._-]+):[ \t]*(?:#.*)?$/);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * 取某个服务的块（含服务头行）。
 *
 * 块边界只看**缩进**（≤2 缩进的行结束本块），不看行的形态——否则
 * `  executor-python2: # 注释` 这类服务头结束不了块，兄弟服务的字段会被
 * 当成目标服务的（`check-compose-service-env.mjs` 的 T4 修过同一形态）。
 *
 * @returns {{ lines: string[], startLine: number }|null} `startLine` 为 1-based
 */
export function extractServiceBlock(composeText, serviceName) {
  const lines = String(composeText ?? "").split(/\r?\n/);
  const headRe = new RegExp(`^ {2}${escapeRe(serviceName)}:(?=[ \\t]|$)`);
  const start = lines.findIndex((l) => headRe.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i]) || /^\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { lines: lines.slice(start, end), startLine: start + 1 };
}

/**
 * 从服务块里抽 environment 映射（`KEY: value` 与 `- KEY=value` 两种形态）。
 * @returns {Record<string, {value: string, line: number}>}
 */
export function extractServiceEnv(block) {
  const { lines, startLine } = block;
  const envIdx = lines.findIndex((l) => /^ {4}environment:[ \t]*(?:#.*)?$/.test(l));
  if (envIdx === -1) return {};
  const env = {};
  for (let i = envIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const kv = line.match(/^ {6}([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/);
    if (kv) {
      env[kv[1]] = { value: stripInlineComment(kv[2]), line: startLine + i };
      continue;
    }
    const item = line.match(/^ {6}-[ \t]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (item) {
      env[item[1]] = { value: stripInlineComment(item[2]), line: startLine + i };
      continue;
    }
    break; // 出了 environment 块
  }
  return env;
}

/**
 * 从服务块里抽容器内存上限：`mem_limit` 优先，回落 `deploy.resources.limits.memory`。
 * @returns {{value: string, line: number, source: string}|null}
 */
export function extractContainerLimit(block) {
  const { lines, startLine } = block;
  const direct = lines.findIndex((l) => /^ {4}mem_limit:[ \t]*/.test(l));
  if (direct !== -1) {
    const m = lines[direct].match(/^ {4}mem_limit:[ \t]*(.*)$/);
    return { value: stripInlineComment(m?.[1] ?? ""), line: startLine + direct, source: "mem_limit" };
  }
  const deployIdx = lines.findIndex((l) => /^ {4}deploy:[ \t]*(?:#.*)?$/.test(l));
  if (deployIdx === -1) return null;
  let end = lines.length;
  for (let i = deployIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() !== "" && !/^\s*#/.test(line) && /^ {0,4}\S/.test(line)) {
      end = i;
      break;
    }
  }
  for (let i = deployIdx + 1; i < end; i += 1) {
    const m = lines[i].match(/^\s*memory:[ \t]*(.*)$/);
    if (m) {
      return {
        value: stripInlineComment(m[1]),
        line: startLine + i,
        source: "deploy.resources.limits.memory",
      };
    }
  }
  return null;
}

/**
 * 把配置里的内存值解析成字节数。**只认字面量**。
 *
 * 两个来源的**裸数字单位不同**，必须分开传：
 *   · compose `mem_limit` / `deploy…memory`：裸数字是**字节**（compose 语义），
 *     `1024k` / `768m` / `1g` 是二进制后缀 —— 传 `bareUnit: "bytes"`；
 *   · `TASK_MEMORY_LIMIT_MB` / 代码默认常量：裸数字是 **MB**（变量名自带单位，
 *     python 侧的 RLIMIT_AS 也是按 MB 换算）—— 传 `bareUnit: "mb"`。
 * 把两者混用会得到 768 字节 vs 768MB 的荒唐比较（本守卫首版就是这么错的，
 * 自检 ① 直接抓到了）。
 *
 * `${VAR:-768}` 这类插值**不解析**（返回 null = 不可判读）：插值的默认值会被
 * compose 解析期的 `.env` 静默覆盖，守卫只能看到一半真相，此时报绿就是假绿。
 * 要参与本判据请写死数值。
 *
 * @param {string} raw
 * @param {{bareUnit?: "bytes"|"mb"}} [options]
 * @returns {number|null} 字节数；null = 形态无法静态判读
 */
export function parseMemoryBytes(raw, options = {}) {
  const { bareUnit = "bytes" } = options;
  const v = stripInlineComment(raw);
  if (v === "" || v.includes("$")) return null;
  const m = v.match(/^(\d+(?:\.\d+)?)[ \t]*([kmgt])?(?:i?b)?$/i);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num)) return null;
  const unit = (m[2] ?? "").toLowerCase();
  if (unit === "") return Math.round(num * (bareUnit === "mb" ? MB : 1));
  return Math.round(num * UNITS[unit]);
}

/**
 * 从代码里读「compose 未注入时」的任务内存默认值。
 *
 * · python：`config.py` 的 `task_memory_limit_mb: int = 2048`；
 * · node  ：`config.ts` 的 `get taskMemoryLimitMb()` 体内
 *           `if (!Number.isFinite(raw)) return 2048;`。
 *
 * @returns {{mb: number, at: string}|{error: string}}
 */
export function readCodeDefault(root, service) {
  const rel = service.codeDefaultRel;
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    return {
      error:
        `事实源缺失：${rel} —— compose 未给 ${service.name} 注入 ${TASK_LIMIT_ENV}，` +
        `本应回落到该端代码默认值，现在判据无从校验（删文件/改路径都会这样，不是「没问题」）。`,
    };
  }
  const lines = readFileSync(abs, "utf8").split(/\r?\n/);

  if (service.runtime === "python") {
    for (let i = 0; i < lines.length; i += 1) {
      const m = lines[i].match(/^\s*task_memory_limit_mb\s*:\s*int\s*=\s*(\d+)/);
      if (m) return { mb: Number(m[1]), at: `${rel}:${i + 1}` };
    }
    return {
      error:
        `${rel} 里找不到 \`task_memory_limit_mb: int = <n>\` —— 代码默认值抓不到，` +
        "判据瞎了（改了字段写法就请同步本守卫的解析）。",
    };
  }

  const start = lines.findIndex((l) => /get\s+taskMemoryLimitMb\(\)/.test(l));
  if (start === -1) {
    return {
      error: `${rel} 里找不到 \`get taskMemoryLimitMb()\` —— 代码默认值抓不到，判据瞎了。`,
    };
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\}/.test(lines[i])) {
      end = i;
      break;
    }
  }
  for (let i = start; i < end; i += 1) {
    const m = lines[i].match(/!Number\.isFinite\(raw\)\)\s*return\s+(\d+)\s*;/);
    if (m) return { mb: Number(m[1]), at: `${rel}:${i + 1}` };
  }
  return {
    error:
      `${rel} 的 taskMemoryLimitMb getter 里找不到 \`!Number.isFinite(raw)) return <n>;\` ` +
      "——代码默认值抓不到，判据瞎了（换写法就请同步本守卫的解析）。",
  };
}

/** 字节 → 便于复核的 MB 文本（非整 MB 时保留一位小数）。 */
export function fmtMb(bytes) {
  const mb = bytes / MB;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB`;
}

/** 根目录下所有 compose 文件（排序稳定）。 */
function collectComposeFiles(root) {
  let entries = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries.filter((f) => /^docker-compose.*\.ya?ml$/.test(f)).sort();
}

/**
 * 组装一个「视图」：某份 compose 语义下，某个 executor 的容器上限 + 任务上限出处。
 * overlay 视图的 env 是「基础 env ← overlay env」覆盖后的结果。
 */
function buildView({ root, service, container, containerAt, env, label }) {
  const view = {
    label,
    service: service.name,
    container,
    containerAt: container ? `${containerAt}:${container.line}（${container.source}）` : null,
    task: null,
    taskAt: null,
  };
  const pinned = env[TASK_LIMIT_ENV];
  if (pinned) {
    // 裸数字 = MB（变量名自带单位），与容器侧的字节语义不同。
    const bytes = parseMemoryBytes(pinned.value, { bareUnit: "mb" });
    if (bytes === null) {
      view.unreadable = {
        message:
          `${label}：${service.name}.${TASK_LIMIT_ENV} = ${JSON.stringify(pinned.value)}` +
          `（第 ${pinned.line} 行）无法静态判读 — 只认字面量（\`768\` / \`768m\`）；` +
          "`${…}` 插值的默认值会被 .env 静默覆盖，守卫只看到一半真相 → 判结构红而不是假绿。",
      };
      return view;
    }
    view.task = bytes;
    view.taskAt = `${label}:${pinned.line}`;
    view.taskFrom = "compose";
    return view;
  }
  const fallback = readCodeDefault(root, service);
  if (fallback.error) {
    view.unreadable = { message: `${label} / ${service.name}：${fallback.error}` };
    return view;
  }
  view.task = fallback.mb * MB;
  view.taskAt = fallback.at;
  view.taskFrom = "code-default";
  return view;
}

/** 判定一个视图：任务上限必须严格小于容器上限，且不为 0（不限）。 */
function judgeView(view, errors, structure) {
  const svc = `${view.label} 的 ${view.service}`;
  if (view.unreadable) {
    structure.push(view.unreadable.message);
    return false;
  }
  if (!view.container) {
    structure.push(
      `${svc} 没有容器内存上限（既无 \`mem_limit\` 也无 ` +
        "`deploy.resources.limits.memory`）—— 次序不变量无处落地，判据无从校验。",
    );
    return false;
  }
  const containerBytes = parseMemoryBytes(view.container.value);
  if (containerBytes === null) {
    structure.push(
      `${svc} 的容器内存上限 ${JSON.stringify(view.container.value)}（${view.containerAt}）` +
        "无法静态判读 —— 判据瞎了，请改成可静态判读的形态。",
    );
    return false;
  }

  if (view.task === 0) {
    errors.push(
      `${svc} 的任务内存上限是 0（= 不限；${view.taskAt}），而容器上限是 ` +
        `${fmtMb(containerBytes)} —— 等于「没有任务上限」，达到容器 cap 时仍是内核 cgroup OOM ` +
        "killer 选受害者（邻任务陪葬 + 归因丢失）。请给一个 < 容器上限的具体值。",
    );
    return false;
  }

  if (view.task >= containerBytes) {
    errors.push(
      `${svc} 的任务内存上限 ${fmtMb(view.task)}（${view.taskAt}）≥ 容器上限 ` +
        `${fmtMb(containerBytes)}（${view.containerAt}）` +
        "—— **次序反转**：任务级上限永远不会先触发，达到容器 cap 时由内核 cgroup OOM killer " +
        "挑受害者（可能是同容器的另一个任务，甚至执行器自身），归因丢失且邻任务陪葬。" +
        "修法：把任务上限压到容器上限之下（或同步抬高 mem_limit），两者成组改；" +
        "见 docs/deployment.md「容器安全（SEC-07）」的次序不变量。",
    );
    return false;
  }

  view.ok = true;
  return true;
}

/**
 * 全量判据。
 *
 * @param {string} [root] 仓库根
 * @returns {{errors: string[], structure: string[], stats: Record<string, unknown>}}
 *   `errors` = 次序反转；`structure` = **判据本身不可信**（事实源缺失、形态读不懂）。
 */
export function check(root = process.cwd()) {
  const errors = [];
  const structure = [];
  const stats = { composeFiles: 0, services: 0, views: [] };

  const composeFiles = collectComposeFiles(root);
  stats.composeFiles = composeFiles.length;
  const baseAbs = join(root, BASE_COMPOSE_REL);
  if (!existsSync(baseAbs)) {
    structure.push(
      `事实源缺失：${BASE_COMPOSE_REL} —— 次序不变量无从校验` +
        "（目录改名/在子目录跑都会这样，不是「没问题」）。",
    );
    return { errors, structure, stats };
  }

  const base = readFileSync(baseAbs, "utf8");
  const services = parseTopLevelServices(base);
  if (services === null) {
    structure.push(`无法解析 ${BASE_COMPOSE_REL} 的顶层 services: 块 —— 结构变了，扫描器失效。`);
    return { errors, structure, stats };
  }
  stats.services = services.length;
  if (services.length < MIN_COMPOSE_SERVICES) {
    structure.push(
      `只解析到 ${services.length} 个服务（下界 ${MIN_COMPOSE_SERVICES}）—— ` +
        `${BASE_COMPOSE_REL} 的结构变了，扫描器失效（不是「全部合规」）。`,
    );
  }

  const baseViews = [];
  const envByService = {};
  for (const service of EXECUTOR_SERVICES) {
    const block = extractServiceBlock(base, service.name);
    if (!block) {
      structure.push(`${BASE_COMPOSE_REL} 里没有 \`${service.name}\` 服务块 —— 判据无处落地。`);
      continue;
    }
    const env = extractServiceEnv(block);
    envByService[service.name] = env;
    const view = buildView({
      root,
      service,
      container: extractContainerLimit(block),
      containerAt: BASE_COMPOSE_REL,
      env,
      label: BASE_COMPOSE_REL,
    });
    baseViews.push(view);
  }

  // overlay：容器上限被改 / 任务上限被改，都要单独判一次（合并语义）。
  const overlayViews = [];
  for (const file of composeFiles.filter((f) => f !== BASE_COMPOSE_REL)) {
    const text = readFileSync(join(root, file), "utf8");
    for (const service of EXECUTOR_SERVICES) {
      const block = extractServiceBlock(text, service.name);
      if (!block) continue;
      const overlayEnv = extractServiceEnv(block);
      const overlayContainer = extractContainerLimit(block);
      if (!overlayEnv[TASK_LIMIT_ENV] && !overlayContainer) continue; // 与本条判据无关的 overlay
      const baseView = baseViews.find((v) => v.service === service.name);
      const overlayView = buildView({
        root,
        service,
        container: overlayContainer ?? baseView?.container,
        // 容器上限真正的出处：overlay 没写就是基础文件里的那一行。
        containerAt: overlayContainer ? file : BASE_COMPOSE_REL,
        env: { ...(envByService[service.name] ?? {}), ...overlayEnv },
        label: file,
      });
      overlayViews.push(overlayView);
    }
  }

  for (const view of [...baseViews, ...overlayViews]) {
    if (judgeView(view, errors, structure)) {
      stats.views.push({
        label: view.label,
        service: view.service,
        taskMb: view.task / MB,
        containerMb: parseMemoryBytes(view.container.value) / MB,
        taskAt: view.taskAt,
        taskFrom: view.taskFrom,
      });
    }
  }

  return { errors, structure, stats };
}

// ── 自检（真子进程 + 退出码 + 报错文本 + 正例控制组 + <1s）────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

/** 12 个无关服务，把服务数顶到 MIN_COMPOSE_SERVICES=10 之上。 */
const fillerServices = (n = 12) =>
  Array.from(
    { length: n },
    (_, i) =>
      `  svc${String(i).padStart(2, "0")}:\n    image: busybox\n    environment:\n      LOG_LEVEL: 'info'\n`,
  ).join("");

/**
 * 基础 compose fixture。
 * @param {object} [o]
 * @param {string|null} [o.pyContainer] `null` = 不写容器上限
 * @param {string|null} [o.pyTask] 任务上限；`null` = 不注入（回落代码默认）
 * @param {boolean} [o.deployStyle] 用 deploy.resources.limits.memory 表达容器上限
 * @param {number} [o.filler]
 */
function baseCompose(o = {}) {
  const { pyContainer = "1G", pyTask = null, nodeContainer = "1G", nodeTask = null, deployStyle = false, filler = 12 } = o;
  const limit = (v, indent) =>
    deployStyle
      ? [
          `${indent}deploy:`,
          `${indent}  resources:`,
          `${indent}    limits:`,
          `${indent}      memory: ${v}`,
        ]
      : [`${indent}mem_limit: ${v}`];
  return (
    [
      "# fixture compose（注释行不算数）",
      "services:",
      "  executor-python:",
      "    image: acf/executor-python",
      ...(pyContainer === null ? [] : limit(pyContainer, "    ")),
      "    environment:",
      "      PYTHONUNBUFFERED: '1'",
      ...(pyTask === null ? [] : [`      ${TASK_LIMIT_ENV}: ${pyTask}`]),
      "  executor-node:",
      "    image: acf/executor-node",
      ...(nodeContainer === null ? [] : limit(nodeContainer, "    ")),
      "    environment:",
      "      LOG_LEVEL: 'info'",
      ...(nodeTask === null ? [] : [`      ${TASK_LIMIT_ENV}: ${nodeTask}`]),
      fillerServices(filler),
      "volumes:",
      "  data:",
    ].join("\n") + "\n"
  );
}

/** overlay fixture（只写被覆盖的字段）。 */
function overlayCompose(o = {}) {
  const { pyContainer = null, pyTask = null, nodeContainer = null, nodeTask = null } = o;
  const svc = (name, container, task) =>
    [
      `  ${name}:`,
      ...(container === null ? [] : [`    mem_limit: ${container}`]),
      ...(task === null ? [] : ["    environment:", `      ${TASK_LIMIT_ENV}: ${task}`]),
    ];
  return (
    ["services:", ...svc("executor-python", pyContainer, pyTask), ...svc("executor-node", nodeContainer, nodeTask)].join(
      "\n",
    ) + "\n"
  );
}

/** 与真实源码同形的默认值事实源（行号可预期，供报错文本断言）。 */
const pyCode = (mb = 2048) =>
  ["# fixture（截自 apps/executor-python/config.py 的形状）", "    task_sandbox: str = ''", `    task_memory_limit_mb: int = ${mb}`].join(
    "\n",
  ) + "\n";

const nodeCode = (mb = 2048) =>
  [
    "// fixture（截自 apps/executor-node/src/config.ts 的形状）",
    "  get taskMemoryLimitMb(): number {",
    "    const raw = parseInt(process.env.TASK_MEMORY_LIMIT_MB ?? '', 10);",
    `    if (!Number.isFinite(raw)) return ${mb};`,
    "    if (raw <= 0) return 0;",
    "    return Math.min(raw, 1_048_576);",
    "  },",
  ].join("\n") + "\n";

/**
 * fixture 树。
 * @param {object} [o]
 * @param {string|null} [o.base] null = 不写基础 compose
 * @param {{name?: string, body: string}|null} [o.overlay]
 * @param {string|null} [o.pyConfig] null = 不写该事实源
 * @param {string|null} [o.nodeConfig]
 */
function tree(o = {}) {
  const { base = baseCompose(), overlay = null, pyConfig = pyCode(), nodeConfig = nodeCode() } = o;
  const files = { "package.json": { name: "fixture", private: true } };
  if (base !== null) files[BASE_COMPOSE_REL] = base;
  if (overlay) files[overlay.name ?? "docker-compose.staging.yml"] = overlay.body;
  if (pyConfig !== null) files["apps/executor-python/config.py"] = pyConfig;
  if (nodeConfig !== null) files["apps/executor-node/src/config.ts"] = nodeConfig;
  return files;
}

/**
 * 自检：16 条子进程用例。
 *
 * 为什么跑子进程：本守卫的历史事故形态全在 **CLI 层**（`process.exit` 有没有
 * 真的执行、报错文本还在不在、事实源读不到时是崩栈还是结构红）。函数级
 * 断言删掉 `process.exit(1)` 也照样全绿。
 *
 * 正例控制组：①（compose 显式注入）、②（回落代码默认）——没有它们，
 * 「判据永远红/永远抛」也能让全部负例通过。
 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "sandbox-limit-order-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
            ...expect,
            withinMs: 1000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  subprocess(
    "① 【正例控制组】两侧 mem_limit 1G + 显式注入 768 → 绿（数值漂移不判红）",
    tree({ base: baseCompose({ pyTask: "768", nodeTask: "768" }), pyConfig: null, nodeConfig: null }),
    {
      code: 0,
      contains: ["次序守卫通过", "executor-python", "executor-node", "768MB", "1024MB"],
      absent: ["✖", "结构错误"],
    },
  );

  subprocess(
    "② 【正例控制组·回落代码默认】compose 不注入、代码默认 512 → 绿",
    tree({ base: baseCompose(), pyConfig: pyCode(512), nodeConfig: nodeCode(512) }),
    { code: 0, contains: ["次序守卫通过", "512MB"], absent: ["✖", "结构错误"] },
  );

  subprocess(
    "③ 现状复现：不注入 + 代码默认 2048 + 容器 1G → 红（次序反转，点名两端事实源）",
    tree({ base: baseCompose() }),
    {
      code: 1,
      contains: [
        "次序反转",
        "2048MB",
        "1024MB",
        "apps/executor-python/config.py",
        "apps/executor-node/src/config.ts",
      ],
      absent: ["守卫通过", "结构错误"],
    },
  );

  subprocess(
    "④ 相等也红：容器 1G + 任务上限 1024 → 红（判据是严格小于）",
    tree({ base: baseCompose({ pyTask: "1024", nodeTask: "768" }), pyConfig: null, nodeConfig: null }),
    { code: 1, contains: ["次序反转", "1024MB", "≥ 容器上限", "1024MB"], absent: ["守卫通过"] },
  );

  subprocess(
    "⑤ 显式 0（不限）→ 红（文案点明「等于没有任务上限」）",
    tree({ base: baseCompose({ pyTask: "0", nodeTask: "768" }), pyConfig: null, nodeConfig: null }),
    { code: 1, contains: ["= 不限", "没有任务上限"], absent: ["守卫通过"] },
  );

  subprocess(
    "⑥ 单位形态：容器 512M + 任务 768 → 红（按字节比较，不按字面量）",
    tree({ base: baseCompose({ pyContainer: "512M", pyTask: "768", nodeTask: "768" }), pyConfig: null, nodeConfig: null }),
    { code: 1, contains: ["768MB", "≥ 容器上限", "512MB"], absent: ["守卫通过"] },
  );

  subprocess(
    "⑦ 反例·overlay 把容器减半、任务上限没跟着减 → 红（点名 overlay 文件）",
    tree({
      base: baseCompose({ pyTask: "768", nodeTask: "768" }),
      overlay: { name: "docker-compose.staging.yml", body: overlayCompose({ pyContainer: "768m", nodeContainer: "768m" }) },
      pyConfig: null,
      nodeConfig: null,
    }),
    {
      code: 1,
      contains: ["docker-compose.staging.yml 的 executor-python", "≥ 容器上限", "768MB", "次序反转"],
      absent: ["守卫通过"],
    },
  );

  subprocess(
    "⑧ 正例·overlay 容器减半 + 任务上限同步下调 → 绿",
    tree({
      base: baseCompose({ pyTask: "768", nodeTask: "768" }),
      overlay: {
        name: "docker-compose.staging.yml",
        body: overlayCompose({ pyContainer: "768m", pyTask: "512", nodeContainer: "768m", nodeTask: "512" }),
      },
      pyConfig: null,
      nodeConfig: null,
    }),
    { code: 0, contains: ["次序守卫通过", "docker-compose.staging.yml", "512MB", "768MB"], absent: ["✖", "结构错误"] },
  );

  subprocess(
    "⑨ 反例·注释掉的键不算配置（回落到代码默认 2048）→ 红",
    tree({
      base: baseCompose().replace(
        "      PYTHONUNBUFFERED: '1'\n",
        `      PYTHONUNBUFFERED: '1'\n      # ${TASK_LIMIT_ENV}: 768  ← 注释掉的旧值，不算配置\n`,
      ),
      pyConfig: pyCode(2048),
      nodeConfig: nodeCode(128),
    }),
    { code: 1, contains: ["executor-python", "2048MB", "次序反转"], absent: ["守卫通过"] },
  );

  subprocess(
    "⑩ 反例·兄弟服务的值不能顶包（node 注入 128 不能替 python 免责）→ 只报 1 项",
    tree({ base: baseCompose({ nodeTask: "128" }), pyConfig: pyCode(2048) }),
    { code: 1, contains: ["（1 项）", "executor-python"], absent: ["守卫通过"] },
  );

  subprocess(
    "⑪ deploy.resources.limits.memory 形态被认（512M）+ 任务 768 → 红",
    tree({
      base: baseCompose({ pyContainer: "512M", pyTask: "768", nodeTask: "768", deployStyle: true }),
      pyConfig: null,
      nodeConfig: null,
    }),
    { code: 1, contains: ["deploy.resources.limits.memory", "512MB"], absent: ["守卫通过"] },
  );

  subprocess("⑫ 事实源缺失（无 docker-compose.yml）→ 结构红，不是崩栈也不是绿", tree({ base: null }), {
    code: 1,
    contains: ["结构错误", `事实源缺失：${BASE_COMPOSE_REL}`],
    absent: ["守卫通过", "Error:", "ENOENT"],
  });

  subprocess(
    "⑬ 【反证·扫描面】services 塌到只剩两个 executor → 结构红（不是「全部合规」）",
    tree({ base: baseCompose({ filler: 0, pyTask: "768", nodeTask: "768" }), pyConfig: null, nodeConfig: null }),
    {
      code: 1,
      contains: ["结构错误", "只解析到", `下界 ${MIN_COMPOSE_SERVICES}`],
      absent: ["守卫通过"],
    },
  );

  subprocess(
    "⑭ 结构红·代码默认值解析不出（compose 不注入 + config.py 缺失）→ 判据瞎了",
    tree({ base: baseCompose({ nodeTask: "128" }), pyConfig: null, nodeConfig: nodeCode(128) }),
    {
      code: 1,
      contains: ["结构错误", "apps/executor-python/config.py", "判据无从校验"],
      absent: ["守卫通过", "Error:"],
    },
  );

  subprocess(
    "⑮ 结构红·内存值不可静态判读（mem_limit: ${MEM_LIMIT}）→ 明说读不懂，不静默判绿",
    tree({
      base: baseCompose({ pyContainer: "${MEM_LIMIT}", pyTask: "768", nodeTask: "768" }),
      pyConfig: null,
      nodeConfig: null,
    }),
    { code: 1, contains: ["结构错误", "无法静态判读"], absent: ["守卫通过"] },
  );

  subprocess(
    "⑯ 结构红·任务上限写成带默认值的插值 → 判结构红（.env 能静默覆盖默认值，不装看得见）",
    tree({
      base: baseCompose({ pyTask: `\${${TASK_LIMIT_ENV}:-768}`, nodeTask: "768" }),
      pyConfig: null,
      nodeConfig: null,
    }),
    { code: 1, contains: ["结构错误", "无法静态判读", "静默覆盖"], absent: ["守卫通过"] },
  );

  const failed = reportCases(cases, { title: "check-sandbox-limit-order selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const invoked = process.argv[1]?.replace(/\\/g, "/").split("/").pop();

if (invoked === "check-sandbox-limit-order.mjs") {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    const root = resolve(argValue(process.argv, "--root") ?? process.cwd());
    const { errors, structure, stats } = check(root);

    if (structure.length > 0) {
      console.error("");
      console.error("✖ 沙箱内存上限次序守卫结构错误（判据本身不可信，先修扫描面）：");
      for (const e of structure) console.error("  · " + e);
      console.error("");
      process.exit(1);
    }

    if (errors.length > 0) {
      console.error("");
      console.error(`✖ 沙箱内存上限次序契约（${errors.length} 项）——任务上限必须严格小于容器上限：`);
      for (const e of errors) console.error("  · " + e);
      console.error("");
      process.exit(1);
    }

    const detail = stats.views
      .map((v) => `${v.label} 的 ${v.service} ${v.taskMb}MB < ${v.containerMb}MB（${v.taskAt}）`)
      .join("；");
    console.log(
      `✔ 沙箱内存上限次序守卫通过：${stats.views.length} 组「任务上限 < 容器上限」成立` +
        `（${stats.composeFiles} 个 compose 文件 / ${stats.services} 个服务已扫描）：${detail}`,
    );
  }
}
