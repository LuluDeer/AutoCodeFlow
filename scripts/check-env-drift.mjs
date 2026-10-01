#!/usr/bin/env node
// 审计二轮 B-6：.env.example 双向漂移守卫
//
// .env.example 是部署配置的「文档面」，但代码消费面（configuration.ts /
// config.ts / config.py）新增键时它没有任何机制强制同步——键只在代码里被
// 读取、.env.example 无从体现，部署方不知道它能调什么（这正是本轮审计抓到
// TASK_SANDBOX / CLAMD_* / SSE_MAX_STREAMS_* 等一批键漂移的根因）。本守卫把
// 「代码消费的 env 键 ⊆ .env.example 覆盖的键」钉成静态断言：
//
//   · 提取 process.env.XXX / process.env["XXX"] / envInt("XXX")（executor-node
//     config.ts 的整数 helper）与 executor-python config.py 的 pydantic 字段
//     声明（snake_case 字段 ↔ UPPER_SNAKE env 键，pydantic-settings 默认映射）；
//   · 解析 .env.example 中 `KEY=` 与 `# KEY=` 两种形态（注释行=「已文档化但
//     默认关闭」——与本文件用注释行写可选项的既有风格一致）；
//   · 断言覆盖，白名单豁免内部派生/高级调优键（每个键必须写明理由）。
//
// 退出码：0 = 无漂移；1 = 代码消费了 .env.example 未覆盖且未豁免的键。
//
// 用法：node scripts/check-env-drift.mjs [--selftest]
//   --selftest：用内置 fixture 验证提取与判据本身（不扫真实代码库）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

// ── 扫描源（与守卫名目一致：三端 config 单文件；新增配置入口时同步登记）──────
const SOURCES = [
  "apps/admin-api/src/config/configuration.ts",
  "apps/executor-node/src/config.ts",
  "apps/executor-python/config.py",
];
const EXAMPLE_FILE = ".env.example";

// ── TS 源提取 ────────────────────────────────────────────────────────────────
export function extractTsEnvKeys(text) {
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

// ── .env.example 覆盖面提取 ─────────────────────────────────────────────────
// `KEY=value`（启用）与 `# KEY=value`（文档化的可选项）都算「已覆盖」。
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
const WHITELIST = {
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

// ── 自检：fixture 验证提取与判据 ────────────────────────────────────────────
function selftest() {
  const tsFixture = `
const a = process.env.FOO_BAR || 'x';
const b = process.env["BAZ_QUX"] ?? 'y';
const c = envInt('NUM_KEY', 10);
const d = process.env.lower_not_matched;
const e = process.env[dynamicName]; // 动态键名：提不出静态名，不在守卫面
const f = process.argv.indexOf('--not-env');
`;
  const tsKeys = extractTsEnvKeys(tsFixture);
  const expectTs = ["FOO_BAR", "BAZ_QUX", "NUM_KEY"];
  for (const k of expectTs) {
    if (!tsKeys.has(k)) {
      console.error(`selftest FAIL: TS 提取漏掉 ${k}`);
      process.exit(1);
    }
  }
  if (tsKeys.has("lower_not_matched") || tsKeys.has("DYNAMIC") || tsKeys.size !== 3) {
    console.error(`selftest FAIL: TS 提取混入非预期键：${[...tsKeys].join(",")}`);
    process.exit(1);
  }

  const pyFixture = `
class Settings:
    work_dir: str = '/tmp/autocodeflow/tasks'
    max_concurrent_tasks: int = 10
    require_token: bool = False
    uv_python_sha256_pins: dict = {}
    # commented_key: str = '不是字段'
    see docs at http://mirror.internal:9000/path for detail
    x = 1
`;
  const pyKeys = extractPyEnvKeys(pyFixture);
  const expectPy = ["WORK_DIR", "MAX_CONCURRENT_TASKS", "REQUIRE_TOKEN", "UV_PYTHON_SHA256_PINS"];
  for (const k of expectPy) {
    if (!pyKeys.has(k)) {
      console.error(`selftest FAIL: python 提取漏掉 ${k}`);
      process.exit(1);
    }
  }
  // 注释与散文（http://…:9000）不得被当字段
  if (pyKeys.has("COMMENTED_KEY") || pyKeys.size !== expectPy.length) {
    console.error(`selftest FAIL: python 提取混入非预期键：${[...pyKeys].join(",")}`);
    process.exit(1);
  }

  const exampleFixture = `
ACTIVE_KEY=value
# COMMENTED_KEY=value
  # INDENTED_COMMENT_KEY=1
NOT_A_KEY no equals
plain text
`;
  const documented = extractDocumentedKeys(exampleFixture);
  for (const k of ["ACTIVE_KEY", "COMMENTED_KEY", "INDENTED_COMMENT_KEY"]) {
    if (!documented.has(k)) {
      console.error(`selftest FAIL: .env.example 解析漏掉 ${k}`);
      process.exit(1);
    }
  }
  if (documented.size !== 3) {
    console.error(`selftest FAIL: .env.example 解析混入非预期键：${[...documented].join(",")}`);
    process.exit(1);
  }

  // 判据：未覆盖且未豁免 → 报错；豁免键 → 放行。fixture 中 GOOD_KEY 未覆盖
  // （唯一漂移），COMMENTED_KEY 已文档化，EXEMPTED_KEY 被豁免。
  const errors = check({
    keys: new Set(["GOOD_KEY", "COMMENTED_KEY", "EXEMPTED_KEY"]),
    documented: extractDocumentedKeys(exampleFixture),
    whitelist: { EXEMPTED_KEY: "测试豁免" },
  });
  if (errors.length !== 1 || !errors[0].includes("GOOD_KEY")) {
    console.error(`selftest FAIL: 判据结果不符预期：${errors.join("; ")}`);
    process.exit(1);
  }

  console.log("selftest OK: TS/pydantic 提取、.env.example 解析与漂移判据均正确");
}

// ── main ────────────────────────────────────────────────────────────────────
if (process.argv.includes("--selftest")) {
  selftest();
} else {
  const keys = new Set();
  for (const src of SOURCES) {
    const text = readFileSync(join(ROOT, src), "utf8");
    const found = src.endsWith(".py") ? extractPyEnvKeys(text) : extractTsEnvKeys(text);
    for (const k of found) keys.add(k);
    console.log(`  ${src}: ${found.size} 个 env 键`);
  }
  const documented = extractDocumentedKeys(readFileSync(join(ROOT, EXAMPLE_FILE), "utf8"));
  const errors = check({ keys, documented });
  if (errors.length > 0) {
    console.error(`B-6 env drift guard FAIL: ${errors.length} 个键漂移（代码消费 ⊄ .env.example）：`);
    for (const e of errors) console.error("  ✗ " + e);
    process.exit(1);
  }
  console.log(
    `B-6 env drift guard OK: 代码消费的 ${keys.size} 个 env 键全部被 .env.example 覆盖或已豁免（豁免 ${Object.keys(WHITELIST).length} 个内部/调优键）`,
  );
}
