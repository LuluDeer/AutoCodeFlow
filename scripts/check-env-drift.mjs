#!/usr/bin/env node
/**
 * 审计二轮 B-6：`.env.example` 覆盖守卫（代码消费面 ⊆ 文档面）。
 *
 * `.env.example` 是部署配置的「文档面」，但代码消费面（configuration.ts /
 * config.ts / config.py）新增键时它没有任何机制强制同步——键只在代码里被
 * 读取、`.env.example` 无从体现，部署方不知道它能调什么（这正是本轮审计抓到
 * TASK_SANDBOX / CLAMD_* / SSE_MAX_STREAMS_* 等一批键漂移的根因）。本守卫把
 * 「代码消费的 env 键 ⊆ .env.example 覆盖的键」钉成静态断言：
 *
 *   · 提取 `process.env.XXX` / `process.env["XXX"]` / `envInt("XXX")` 与
 *     **动态键 helper 的实参**（见下）、以及 executor-python config.py 的 pydantic
 *     字段声明（snake_case 字段 ↔ UPPER_SNAKE env 键，pydantic-settings 默认映射）；
 *   · 解析 `.env.example` 中 `KEY=` 与 `# KEY=` 两种形态（注释行=「已文档化但
 *     默认关闭」——与本文件用注释行写可选项的既有风格一致）；
 *   · 断言覆盖，白名单豁免内部派生/高级调优键（每个键必须写明理由）。
 *
 * ## T4（第 4 轮守卫自检审计）修掉的假绿
 *
 *   · **动态键 helper 的实参是盲区**：`executor-node/src/config.ts` 里有三个
 *     `function envXxx(name, fallback)`，体内都是 `process.env[name]` 动态取值。
 *     旧实现只认 `envInt(`，于是 `parsePositiveIntEnv('PACKAGE_DOWNLOAD_MAX_BYTES')`
 *     与 `parseDiskPercent('DISK_WARN_PERCENT')` 读的键**对判据完全不存在**——
 *     今天它们恰好被 `.env.example` 覆盖所以是静默的，但「新增一个走该 helper 的键
 *     而不写文档」永远不会红。现在：先扫出「体内动态取 env」的顶层 helper 名，再把
 *     它们的第一个字符串实参当键（前缀误配/静默跳过的同一族）。
 *   · **pydantic 字段类型解析不了就静默丢弃**：`timeout: Optional[int] = None`
 *     不在 `str|int|bool|float|list|dict` 名单里 → 该字段对应的 env 键从判据里消失
 *     （与 check-migrations 的「14 位时间戳被 filter(Boolean) 丢掉」同构）。现在这类
 *     行一律**结构红**，逼人把它纳入或显式豁免。
 *   · **只数条数**：「0 个键 = 0 漂移」是永真断言。现在三个源各自的键数、合计键数、
 *     `.env.example` 键数都有下界，任一塌陷即结构红。
 *   · **崩溃 ≠ 红灯**：事实源缺失/不可读时旧实现直接抛 ENOENT 栈（像环境抖动）。
 *     现在结构红 + 点名路径与键数。
 *   · **豁免必须可证**：白名单项①理由不能为空②键必须仍被代码消费（陈旧豁免要回收）。
 *   · `--root` + 导出 `check()`：模块级 `import.meta.dirname` 收成参数，`import` 时
 *     不实扫、不 `process.exit`；`--selftest` 改跑**真子进程**（旧版 `import` 就会实扫
 *     真仓库，判据的绿/红根本没进断言）。
 *
 * 退出码：0 = 无漂移；1 = 结构错误，或代码消费了 `.env.example` 未覆盖且未豁免的键。
 *
 * 用法：`node scripts/check-env-drift.mjs [--selftest] [--root <dir>]`
 *   --selftest：在临时 fixture 树里跑真脚本；每条断言退出码 + 关键文本 + <1s。
 *   --root    ：只给 selftest 用：把 fixture 树当仓库根（默认 process.cwd()）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

// ── 扫描源（与守卫名目一致：三端 config 单文件；新增配置入口时同步登记）──────
export const SOURCES = [
  "apps/admin-api/src/config/configuration.ts",
  "apps/executor-node/src/config.ts",
  "apps/executor-python/config.py",
];
export const EXAMPLE_FILE = ".env.example";

/**
 * 扫描面下界（2026-10-29 实测：175 / 51 / 47 个键，`.env.example` 223 个键）。
 * 「0 个键 = 0 漂移」是永真断言，所以塌到下界以下一律**结构红**。
 */
export const MIN_SOURCE_KEYS = 5;
export const MIN_TOTAL_KEYS = 20;
export const MIN_DOCUMENTED_KEYS = 20;

// ── TS 源提取 ────────────────────────────────────────────────────────────────

/**
 * 扫出**体内用动态索引读 env** 的顶层 helper（`function f(name) { process.env[name] }`）。
 *
 * 为什么要它：这类 helper 的调用点形如 `envInt('KEY', 10)` —— 键不在
 * `process.env.X` 位置上，静态正则看不见。它们是「键的第二个入口」，漏掉就是盲区。
 *
 * @param {string} text
 * @returns {string[]} helper 名
 */
export function listDynamicEnvHelpers(text) {
  const names = [];
  const fnRe = /(?:^|\n)function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = fnRe.exec(text)) !== null) {
    const start = m.index + m[0].length;
    // 本仓 style：顶层函数以「行首 }」收尾。取不到就退化为文件剩余部分。
    const end = text.indexOf("\n}", start);
    const body = text.slice(start, end < 0 ? text.length : end);
    // `process.env[` 后跟标识符 = 动态键；跟引号是静态键（已被静态正则覆盖）。
    if (/process\.env\[\s*[A-Za-z_$]/.test(body)) names.push(m[1]);
  }
  return names;
}

/**
 * 动态 helper 的第一个字符串实参 —— 就是它要读的 env 键。
 *
 * @param {string} text
 * @param {string[]} [helperNames]
 * @returns {Set<string>}
 */
export function extractHelperEnvKeys(text, helperNames = listDynamicEnvHelpers(text)) {
  const keys = new Set();
  for (const name of helperNames) {
    const re = new RegExp(`\\b${name}\\s*\\(\\s*["']([A-Z][A-Z0-9_]*)["']`, "g");
    let m;
    while ((m = re.exec(text)) !== null) keys.add(m[1]);
  }
  return keys;
}

/** 静态形态：`process.env.KEY` / `process.env["KEY"]` / `envInt("KEY")`。 */
export function extractStaticTsEnvKeys(text) {
  const keys = new Set();
  const patterns = [
    /\bprocess\.env\.([A-Z][A-Z0-9_]*)/g,
    /\bprocess\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
    // executor-node config.ts 的 envInt("KEY", fallback) helper
    /\benvInt\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) keys.add(m[1]);
  }
  return keys;
}

/** TS 侧全部 env 键 = 静态形态 ∪ 动态 helper 实参。 */
export function extractTsEnvKeys(text) {
  const keys = extractStaticTsEnvKeys(text);
  for (const k of extractHelperEnvKeys(text)) keys.add(k);
  return keys;
}

// ── python（pydantic-settings）提取：字段声明 → UPPER_SNAKE env 键 ───────────
// 只认 `    field: str|int|bool|float|list|dict = ...` 形态的真字段声明（缩进
// 4 格、注释行不匹配）——config.py 里的文档注释/正则/字符串都可能含 "xxx:"
// 形态，放宽就会把散文当键名。
export function extractPyEnvKeys(text) {
  const keys = new Set();
  const fieldRe = /^[ \t]+([a-z][a-z0-9_]+):[ \t]*(?:str|int|bool|float|list|dict)\b/gm;
  let m;
  while ((m = fieldRe.exec(text)) !== null) {
    keys.add(m[1].toUpperCase());
  }
  return keys;
}

/**
 * pydantic 字段里**类型解析不了**的行（如 `timeout: Optional[int] = None`）。
 *
 * 旧实现静默丢弃这类字段 ⇒ 它对应的 env 键从判据里消失（「没被扫到 = 没问题」）。
 * 这里只认「类型以大写字母开头」的行（`Optional[…]` / `List[…]` / `Settings`），
 * 避免把 `try:` 之类的 Python 语句误判成字段。
 *
 * @param {string} text
 * @returns {Array<{line: number, text: string}>}
 */
export function extractPyUnparsedFields(text) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^[ \t]+([a-z][a-z0-9_]+):[ \t]+([A-Z][A-Za-z0-9_\[\], |]*)/.exec(lines[i]);
    if (m) out.push({ line: i + 1, text: lines[i].trim() });
  }
  return out;
}

// ── .env.example 覆盖面提取 ─────────────────────────────────────────────────
// `KEY=value`（启用）与 `# KEY=value`（文档化的可选项）都算「已覆盖」。
// 行首锚定：散文里顺口提到 `FOO=1`（`# 例：可以用 FOO=1 打开`）**不算**覆盖——
// 那是本仓最容易被当成「已文档化」的假绿形态。
export function extractDocumentedKeys(text) {
  const keys = new Set();
  const lineRe = /^[ \t]*#?[ \t]*([A-Z][A-Z0-9_]+)[ \t]*=/gm;
  let m;
  while ((m = lineRe.exec(text)) !== null) keys.add(m[1]);
  return keys;
}

// ── 白名单（豁免内部派生/高级调优键——每个键必须带理由）───────────────────────
// 新增豁免前先问一遍：这个键部署方真的需要知道吗？能写进 .env.example 就不要
// 往这里塞。
export const WHITELIST = {
  // —— 运行环境/容器注入，非部署方手写 ——
  NODE_ENV: "由 compose / 启动方式注入（production 语义由代码判定）",
  HOSTNAME: "容器运行时自动注入",
  PORT: "compose 按服务分别注入（8001/8002/3105），根 .env 无单一语义",
  APP_NAME: "执行器实例名（默认 executor-node-1 / executor-python-1 即单实例语义）",
  APP_PROTOCOL: "executor-desktop 内部协议键，非部署面",
  // —— 执行器多实例/注册拓扑，默认值即文档行为 ——
  GROUP_NAME: "执行器分组（可留空 = 默认组）",
  EXECUTOR_GROUP: "GROUP_NAME 的旧别名（executor-node config.ts 兼容读取）",
  EXECUTOR_ID: "缺省自动生成，多实例显式命名时才需要",
  EXECUTOR_ADDRESS: "compose 服务拓扑默认值（executor-node:8002 等）",
  EXECUTOR_ADDRESS_PUBLIC: "留空回落 EXECUTOR_ADDRESS（.env.example 已注明的派生键）",
  ADMIN_API_URL: "默认 http://admin-api:3105（compose 内固定拓扑）",
  ADMIN_API_URLS: "admin 多地址容灾（默认回落 ADMIN_API_URL_INTERNAL）",
  ALLOW_PRIVATE_NETWORK: "python 侧 pydantic 字段名——部署面语义键是 EXECUTOR_ALLOW_PRIVATE_NETWORK / AI_ALLOW_PRIVATE_NETWORK（.env.example 已覆盖）",
  // —— admin-api 高级调优（默认值即文档值，收敛在 configuration.ts 注释）——
  DB_SYNCHRONIZE: "危险的开发调试开关（自动改 schema），刻意不进 .env.example 鼓励使用",
  REDIS_HOST: "compose 拓扑键（容器内固定 redis）",
  REDIS_PORT: "compose 拓扑键（6379）",
  REDIS_DB: "Redis 逻辑库号（默认 0）",
  CHANNEL_CONFIG_REFRESH_MS: "渠道配置刷新周期（默认值即文档值）",
  SILENCE_REFRESH_MS: "告警静默刷新周期（默认值即文档值）",
  EXECUTIONS_STREAM_IDLE_PING_MS: "SSE idle ping 周期（默认值即文档值）",
  METRICS_STREAM_IDLE_PING_MS: "指标流 idle ping 周期（默认值即文档值）",
  METRICS_STREAM_INTERVAL_MS: "指标流采样周期（默认值即文档值）",
  METRICS_PROMETHEUS_ENABLED: "Prometheus 端点开关（默认开）",
  METRICS_PROMETHEUS_DEFAULT_METRICS_ENABLED: "默认指标集开关（默认开）",
  OTEL_ENABLED: "OpenTelemetry 导出开关（默认关，接入 OTel 后端时按 docs 配置）",
  REQUEST_TIMEOUT_MS: "admin 出站请求超时（ARCH-27，默认值即文档值）",
  LOG_PARTITION_ENABLED: "日志按日分区开关（默认值即文档值）",
  LOG_STORAGE_REGION: "S3 region（MinIO 部署无需）",
  EXECUTOR_CANDIDATE_POOL_SIZE: "调度候选池大小（默认值即文档值）",
  EXECUTOR_CMD_TTL_MS: "控制命令 TTL（默认值即文档值）",
  EXECUTOR_DEPLOYMENT_POLICY: "执行器部署策略（默认值即文档值）",
  EXECUTOR_PREFER_DEPLOYED: "调度偏好（默认值即文档值）",
  EXECUTOR_STALE_OFFLINE_CONFIRMATIONS: "stale 判离线确认数（默认值即文档值）",
  EXECUTOR_HEARTBEAT_INTERVAL: "admin 侧心跳评估周期（与执行器 HEARTBEAT_INTERVAL_SECONDS 分属两端）",
  EXECUTOR_HEARTBEAT_TIMEOUT_MULTIPLIER: "心跳超时倍数（默认值即文档值）",
  // —— executor-python 调优（默认值 = 此前硬编码，行为不变）——
  GIT_CLONE_TIMEOUT_SECONDS: "python 侧 git clone 超时（默认 120s）",
  CALLBACK_LOGS_MAX_CHARS: "回调日志截断长度（默认 10000 字符）",
  UV_PYTHON_SHA256_PINS: "内部聚合字段——部署面用 UV_PYTHON_SHA256_<主>_<次> 键（见 config.py 注释）",
  TASK_MEMORY_WATCHDOG_INTERVAL_MS: "内存看门狗采样间隔（默认 2000ms，测试/调试用）",
};

// ── 核心判据 ────────────────────────────────────────────────────────────────
export function check({ keys, documented, whitelist = WHITELIST }) {
  const errors = [];
  for (const key of [...keys].sort()) {
    if (documented.has(key)) continue;
    if (whitelist[key]) continue;
    errors.push(
      `${key} 被代码消费但 .env.example 未覆盖（也未豁免）——补一行文档或给出豁免理由`,
    );
  }
  return errors;
}

/**
 * 白名单自身的可证性（T4：豁免必须可证，否则它只是把红改绿）。
 *
 * ① 理由不能为空；② 键必须仍被代码消费（陈旧豁免要回收——否则它会在无人察觉时
 * 长期豁免一个已经不存在的键，等那个键回来时立刻静默放行）。
 */
export function validateWhitelist({ keys, whitelist = WHITELIST }) {
  const structure = [];
  for (const [key, reason] of Object.entries(whitelist)) {
    if (!reason || String(reason).trim().length === 0) {
      structure.push(`白名单缺理由：${key}（豁免必须可证）`);
    }
    if (!keys.has(key)) {
      structure.push(`陈旧白名单（代码已不消费该键）：${key} —— 豁免必须回收`);
    }
  }
  return structure;
}

/**
 * 全量扫描 + 判据。返回 `{ keys, documented, perSource, errors, structure }`。
 *
 * `structure` = 判据本身不可信（事实源缺失/不可读、扫描面塌方、pydantic 字段
 * 解析不了、白名单不合法），与 `errors`（真的漂移）分开报。
 *
 * @param {string} [root] 仓库根
 * @param {{whitelist?: Record<string, string>}} [opts]
 */
export function scan(root = process.cwd(), { whitelist = WHITELIST } = {}) {
  const structure = [];
  const keys = new Set();
  const perSource = [];

  for (const src of SOURCES) {
    const abs = join(root, src);
    if (!existsSync(abs)) {
      structure.push(`事实源缺失：${src} —— 路径/文件名变了，该端口的键对判据已经瞎了。`);
      perSource.push({ src, count: 0, missing: true });
      continue;
    }
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch (error) {
      structure.push(`事实源不可读：${src}（${error?.code ?? error?.message ?? error}）`);
      perSource.push({ src, count: 0, missing: true });
      continue;
    }
    const isPy = src.endsWith(".py");
    const found = isPy ? extractPyEnvKeys(text) : extractTsEnvKeys(text);
    perSource.push({ src, count: found.size, missing: false });
    for (const k of found) keys.add(k);

    if (isPy) {
      const unparsed = extractPyUnparsedFields(text);
      if (unparsed.length > 0) {
        structure.push(
          `${src} 有 ${unparsed.length} 个 pydantic 字段类型解析不了 —— 它们的 env 键既不入判据也不入豁免：` +
            unparsed.map((u) => `第 ${u.line} 行 \`${u.text}\``).join("；"),
        );
      }
    }

    if (found.size < MIN_SOURCE_KEYS) {
      structure.push(
        `${src} 只提取到 ${found.size} 个 env 键（下界 ${MIN_SOURCE_KEYS}）—— 提取器失效了（不是「这个端口没配置」）。`,
      );
    }
  }

  if (keys.size < MIN_TOTAL_KEYS) {
    structure.push(
      `三个源合计只提取到 ${keys.size} 个 env 键（下界 ${MIN_TOTAL_KEYS}）—— 「0 个键 = 0 漂移」是永真断言，扫描面已失效。`,
    );
  }

  const exampleAbs = join(root, EXAMPLE_FILE);
  const documented = new Set();
  if (!existsSync(exampleAbs)) {
    structure.push(`事实源缺失：${EXAMPLE_FILE} —— 文档面不存在时「无漂移」无从成立。`);
  } else {
    let exampleText;
    try {
      exampleText = readFileSync(exampleAbs, "utf8");
    } catch (error) {
      structure.push(`事实源不可读：${EXAMPLE_FILE}（${error?.code ?? error?.message ?? error}）`);
      exampleText = null;
    }
    if (exampleText !== null) {
      for (const k of extractDocumentedKeys(exampleText)) documented.add(k);
      if (documented.size < MIN_DOCUMENTED_KEYS) {
        structure.push(
          `${EXAMPLE_FILE} 只解析到 ${documented.size} 个键（下界 ${MIN_DOCUMENTED_KEYS}）—— 解析器失效了（不是「文档很干净」）。`,
        );
      }
    }
  }

  structure.push(...validateWhitelist({ keys, whitelist }));

  // 结构错误优先：判据不可信时再报「漂移」只会误导人去改代码。
  const errors = structure.length > 0 ? [] : check({ keys, documented, whitelist });
  return {
    keys,
    documented,
    perSource,
    errors,
    structure,
    whitelistCount: Object.keys(whitelist).length,
  };
}

// ── 自检（T4：真子进程 + 退出码 + 关键文本 + <1s）────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

const CONFIG_REL = SOURCES[0];
const NODE_REL = SOURCES[1];
const PY_REL = SOURCES[2];

const pad = (n) => String(n).padStart(2, "0");

/** 22 个 admin 键（过 MIN_SOURCE_KEYS），全部会被文档化。 */
const ADMIN_KEYS = Array.from({ length: 22 }, (_, i) => `ADMIN_FILLER_${pad(i)}`);

/** 6 个 executor-node 键（走动态 helper 与 process.env 两种形态）。 */
const NODE_KEYS = Array.from({ length: 6 }, (_, i) => `NODE_FILLER_${pad(i)}`);

/** 6 个 python 字段（snake_case → UPPER_SNAKE）。 */
const PY_FIELDS = Array.from({ length: 6 }, (_, i) => `py_filler_${pad(i)}`);

const adminConfig = ({ keys = ADMIN_KEYS, extra = [] } = {}) =>
  [
    "export default () => ({",
    ...keys.map((k, i) => `  adminFiller${i}: process.env.${k} || '',`),
    ...extra,
    "});",
    "",
  ].join("\n");

/** executor-node 形态：一个动态取 env 的 helper + 它的调用点。 */
const nodeConfig = ({
  staticKeys = NODE_KEYS,
  helperCalls = [],
  helperName = "envInt",
} = {}) =>
  [
    `function ${helperName}(name: string, fallback: number): number {`,
    "  const raw = (process.env[name] ?? '').trim();",
    "  if (raw === '') return fallback;",
    "  return Number.parseInt(raw, 10);",
    "}",
    "",
    "export const config = {",
    ...staticKeys.map((k, i) => `  nodeFiller${i}: process.env.${k} || '',`),
    ...helperCalls.map((k, i) => `  helper${i}: ${helperName}('${k}', ${i + 1}),`),
    "};",
    "",
  ].join("\n");

const pyConfig = ({ fields = PY_FIELDS, extra = [], unparsedTypes = [] } = {}) =>
  [
    "class Settings(BaseSettings):",
    ...fields.map((f) => `    ${f}: str = ''`),
    ...unparsedTypes,
    ...extra,
    "",
  ].join("\n");

const envExample = ({ extra = [], drop = [] } = {}) => {
  const documented = [
    ...ADMIN_KEYS,
    ...NODE_KEYS,
    ...PY_FIELDS.map((f) => f.toUpperCase()),
  ].filter((k) => !drop.includes(k));
  return ["# fixture 文档面", ...documented.map((k) => `${k}=1`), ...extra, ""].join("\n");
};

/** 造一棵 fixture 仓库树（三端最小对 + `.env.example`）。 */
function envTree({ admin, node, py, env, drop = [], extra = {} } = {}) {
  const files = {
    "package.json": { name: "fixture", private: true },
    [CONFIG_REL]: admin ?? adminConfig(),
    [NODE_REL]: node ?? nodeConfig(),
    [PY_REL]: py ?? pyConfig(),
    [EXAMPLE_FILE]: env ?? envExample(),
    ...extra,
  };
  for (const d of drop) delete files[d];
  return files;
}

/**
 * 自检：12 条用例。11 条跑**真子进程**（`--root` 指 fixture 树），断言退出码 +
 * 关键文本；1 条走 API（白名单注入，CLI 没有也不该有 `--whitelist` 开关）。
 *
 * 旧版 selftest 是「抽四个纯函数喂内存字符串 + 手搓 process.exit」：`import` 这个
 * 模块就会实扫真仓库并打印 OK，判据的绿/红从来没进过断言。
 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "env-drift-selftest-" });
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
  const api = (name, fn) => cases.push({ name, fn });

  subprocess("① 干净树：三端 34 个键全被 .env.example 覆盖 → 绿", envTree(), {
    code: 0,
    contains: ["B-6 env drift guard OK", "34 个 env 键全部被 .env.example 覆盖", "豁免 0 个"],
    absent: ["✖", "漂移"],
  });

  subprocess(
    "② 代码消费了未文档化的键 → 红（点名键）",
    envTree({ admin: adminConfig({ extra: ["  newKnob: process.env.NEW_KNOB || '',"] }) }),
    {
      code: 1,
      contains: ["B-6 env drift guard FAIL", "NEW_KNOB 被代码消费但 .env.example 未覆盖"],
      absent: ["guard OK"],
    },
  );

  // ③ 前缀误配：文档里只有更长/更短的名字，不得当成已覆盖
  subprocess(
    "③ 【反证·前缀误配】文档写 FILLER、代码读 FILLER_X → 红（子串不算覆盖）",
    envTree({
      admin: adminConfig({ extra: ["  prefixed: process.env.ADMIN_FILLER_0_X || '',"] }),
    }),
    {
      code: 1,
      contains: ["ADMIN_FILLER_0_X 被代码消费但 .env.example 未覆盖"],
      absent: ["guard OK"],
    },
  );

  // ④ T4 新修的假绿：动态 helper 的实参是键（旧实现完全看不见）
  subprocess(
    "④ 【反证·helper 盲点】parseDiskPercent('HELPER_ONLY_KEY') 走动态 helper → 红（旧版绿）",
    envTree({
      node: nodeConfig({ helperName: "parseDiskPercent", helperCalls: ["HELPER_ONLY_KEY"] }),
    }),
    {
      code: 1,
      contains: ["HELPER_ONLY_KEY 被代码消费但 .env.example 未覆盖"],
      absent: ["guard OK"],
    },
  );

  subprocess(
    "⑤ 【反证·helper 盲点】走 envInt 的键同样要进判据 → 红",
    envTree({ node: nodeConfig({ helperCalls: ["ENVINT_ONLY_KEY"] }) }),
    {
      code: 1,
      contains: ["ENVINT_ONLY_KEY 被代码消费但 .env.example 未覆盖"],
      absent: ["guard OK"],
    },
  );

  // ⑥ 散文里的 `FOO=1` 不算文档化（本仓最容易被当成「已描述」的形态）
  subprocess(
    "⑥ 【反证·注释算数】散文注释里的 `FOO=1` 不算覆盖 → 红",
    envTree({
      admin: adminConfig({ extra: ["  prose: process.env.PROSE_KEY || '',"] }),
      env: envExample({ extra: ["# 例：部署时可以用 PROSE_KEY=1 打开"] }),
    }),
    {
      code: 1,
      contains: ["PROSE_KEY 被代码消费但 .env.example 未覆盖"],
      absent: ["guard OK"],
    },
  );

  // ⑦ 既有风格：`# KEY=` 是「已文档化但默认关闭」，必须算覆盖
  subprocess(
    "⑦ `# KEY=` 形态仍算已文档化 → 绿（不误报）",
    envTree({
      admin: adminConfig({ extra: ["  commented: process.env.COMMENTED_KEY || '',"] }),
      env: envExample({ extra: ["# COMMENTED_KEY=必须默认关闭"] }),
    }),
    { code: 0, contains: ["35 个 env 键全部被 .env.example 覆盖"], absent: ["✖"] },
  );

  subprocess(
    "⑧ 【反证·扫描面】每源只剩 3 个键（单源与合计都塌到下界以下）→ 结构红，不是「无漂移」",
    envTree({
      admin: adminConfig({ keys: ADMIN_KEYS.slice(0, 3) }),
      node: nodeConfig({ staticKeys: NODE_KEYS.slice(0, 3) }),
      py: pyConfig({ fields: PY_FIELDS.slice(0, 3) }),
      env: envExample(),
    }),
    {
      code: 1,
      contains: [
        "env drift 守卫结构错误",
        `只提取到 3 个 env 键（下界 ${MIN_SOURCE_KEYS}）`,
        `合计只提取到 9 个 env 键（下界 ${MIN_TOTAL_KEYS}）`,
        "扫描面已失效",
      ],
      absent: ["guard OK"],
    },
  );

  subprocess(
    "⑨ 事实源缺失（.env.example 被删）→ 结构红且点名，不是 ENOENT 崩栈",
    envTree({ drop: [EXAMPLE_FILE] }),
    {
      code: 1,
      contains: ["结构错误", `事实源缺失：${EXAMPLE_FILE}`],
      absent: ["guard OK", "ENOENT", "Error:"],
    },
  );

  subprocess(
    "⑩ 事实源缺失（configuration.ts 被删）→ 结构红且点名",
    envTree({ drop: [CONFIG_REL] }),
    {
      code: 1,
      contains: ["结构错误", `事实源缺失：${CONFIG_REL}`, "下界"],
      absent: ["guard OK", "ENOENT"],
    },
  );

  // ⑪ T4 新修的假绿：pydantic 类型解析不了就静默丢弃
  subprocess(
    "⑪ 【反证·pydantic 类型】`timeout: Optional[int]` 解析不了 → 结构红（旧版静默丢弃）",
    envTree({
      py: pyConfig({ unparsedTypes: ["    download_timeout: Optional[int] = None"] }),
    }),
    {
      code: 1,
      contains: [
        "结构错误",
        "pydantic 字段类型解析不了",
        "download_timeout: Optional[int] = None",
      ],
      absent: ["guard OK"],
    },
  );

  api("⑫ 白名单可证性：命中放行 / 缺理由红 / 陈旧豁免红", () => {
    const keys = new Set(["DOCUMENTED_KEY", "EXEMPTED_KEY"]);
    const documented = new Set(["DOCUMENTED_KEY"]);
    // 正例控制组：没有豁免时 EXEMPTED_KEY 必须报红 —— 否则下面「豁免后放行」什么也证明不了。
    const withoutWhitelist = check({ keys, documented, whitelist: {} });
    if (withoutWhitelist.length !== 1 || !withoutWhitelist[0].includes("EXEMPTED_KEY")) {
      throw new Error(
        `无豁免时应报 EXEMPTED_KEY，实际 ${JSON.stringify(withoutWhitelist)}`,
      );
    }

    // 豁免命中 → 放行（只报真正未豁免的键，这里是 0 条）。
    const base = check({ keys, documented, whitelist: { EXEMPTED_KEY: "fixture 理由" } });
    if (base.length !== 0) {
      throw new Error(`豁免命中应放行，实际 ${JSON.stringify(base)}`);
    }

    const emptyReason = validateWhitelist({
      keys,
      whitelist: { EXEMPTED_KEY: "   " },
    });
    if (!emptyReason.some((e) => e.includes("白名单缺理由"))) {
      throw new Error(`预期缺理由结构错误，实际 ${JSON.stringify(emptyReason)}`);
    }

    const stale = validateWhitelist({ keys, whitelist: { GONE_KEY: "已经没人读了" } });
    if (!stale.some((e) => e.includes("陈旧白名单"))) {
      throw new Error(`预期陈旧白名单结构错误，实际 ${JSON.stringify(stale)}`);
    }
  });

  const failed = reportCases(cases, { title: "check-env-drift selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    const rootArg = argValue(process.argv, "--root");
    const root = resolve(rootArg ?? process.cwd());
    // `--root` 是 selftest 专用：白名单里写的是**本仓库**的键，套到 fixture 树上会
    // 全部被判「陈旧白名单」，所以显式给 `--root` 时按空白名单跑。方向是**变严**
    // （豁免少了只可能多报漂移，不可能漏报）；扫真实仓库请不带 `--root`。
    const { keys, perSource, errors, structure, whitelistCount } = scan(
      root,
      rootArg ? { whitelist: {} } : {},
    );

    if (structure.length > 0) {
      console.error("");
      console.error("✖ env drift 守卫结构错误（判据本身不可信，先修扫描面）：");
      for (const e of structure) console.error("  · " + e);
      console.error("");
      process.exit(1);
    }

    for (const p of perSource) {
      console.log(`  ${p.src}: ${p.count} 个 env 键`);
    }
    if (errors.length > 0) {
      console.error(
        `B-6 env drift guard FAIL: ${errors.length} 个键漂移（代码消费 ⊄ .env.example）：`,
      );
      for (const e of errors) console.error("  ✗ " + e);
      process.exit(1);
    }
    console.log(
      `B-6 env drift guard OK: 代码消费的 ${keys.size} 个 env 键全部被 .env.example 覆盖或已豁免（豁免 ${whitelistCount} 个内部/调优键）`,
    );
  }
}
