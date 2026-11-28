#!/usr/bin/env bash
# Agent 实时流 / 跨副本控制 L3 验证入口。
#
# 隔离策略：
#   · PostgreSQL：只在现有 PG service 上 CREATE/DROP 一次性的
#     autoflow_agent_rt_e2e_<stamp> 库；迁移只在新库跑，绝不写主库业务表。
#   · Redis：选择一个 1..14 的一次性逻辑库（REDIS_DB，不用 0），trap 只按
#     acf:agent-* / bull:agent-jobs:* 前缀 SCAN+DEL，不 FLUSHALL。
#   · 端口：PORT 由 env 或进程内随机数生成；两个 Nest 实例是进程内
#     createTestApp()，不监听端口，PORT 仅用于消除配置层歧义。
# 条件不足（依赖缺失、DB/Redis 不可达、断言摘要缺失或跳过）一律非零退出。
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
API_DIR="$ROOT_DIR/apps/admin-api"
ENV_FILE="$ROOT_DIR/.env"
SPEC_FILE="$API_DIR/test/agent-realtime-cross-instance.e2e-spec.ts"

read_env() {
  local key="$1"
  node --input-type=module - "$key" "$ENV_FILE" <<'NODE'
import { readEnvFileValue } from "./scripts/lib/selftest-hermetic.mjs";
const [, , key, file] = process.argv;
const value = readEnvFileValue(file, key);
if (value != null) process.stdout.write(value);
NODE
}

STAMP="${AGENT_REALTIME_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}}"
ARTIFACT_REL="artifacts/verification/agent-realtime-${STAMP}"
ARTIFACT_DIR="$ROOT_DIR/$ARTIFACT_REL"
mkdir -p "$ARTIFACT_DIR"
LOG_FILE="$ARTIFACT_DIR/commands.txt"
ASSERTIONS_FILE="$ARTIFACT_DIR/assertions.json"
RESULT_FILE="$ARTIFACT_DIR/result.json"
exec > >(tee -a "$LOG_FILE") 2>&1

DB_NAME="${AGENT_REALTIME_DB_NAME:-autoflow_agent_rt_e2e_${STAMP//[^A-Za-z0-9_-]/_}}"
MAINTENANCE_DB="${DB_DATABASE:-$(read_env DB_DATABASE)}"
MAINTENANCE_DB="${MAINTENANCE_DB:-autoflow_test}"
REDIS_DB="${AGENT_REALTIME_REDIS_DB:-$(( (RANDOM % 14) + 1 ))}"
export REDIS_DB
PORT="${AGENT_REALTIME_PORT:-$((39000 + RANDOM % 20000))}"

CREATED_DB=0
FINALIZED=0
TEST_EXIT=1

export NODE_ENV=test
export SELFTEST_SKIP_ENV_FILE=1
export DB_HOST="${DB_HOST:-$(read_env DB_HOST)}"
export DB_PORT="${DB_PORT:-$(read_env DB_PORT)}"
export DB_USERNAME="${DB_USERNAME:-$(read_env DB_USERNAME)}"
export DB_PASSWORD="${DB_PASSWORD:-$(read_env DB_PASSWORD)}"
export REDIS_HOST="${REDIS_HOST:-$(read_env REDIS_HOST)}"
export REDIS_PORT="${REDIS_PORT:-$(read_env REDIS_PORT)}"
export REDIS_PASSWORD="${REDIS_PASSWORD:-$(read_env REDIS_PASSWORD)}"
export JWT_SECRET="${JWT_SECRET:-test-jwt-secret-32chars-long-here}"
export JWT_REFRESH_SECRET="${JWT_REFRESH_SECRET:-test-refresh-secret-32chars-long}"
export EXECUTOR_SECRET="${EXECUTOR_SECRET:-test-executor-secret}"
export EXECUTION_CALLBACK_SECRET="${EXECUTION_CALLBACK_SECRET:-$EXECUTOR_SECRET}"
export INITIAL_ADMIN_USERNAME="${INITIAL_ADMIN_USERNAME:-admin}"
export INITIAL_ADMIN_PASSWORD="${INITIAL_ADMIN_PASSWORD:-admin123}"
export AI_PROVIDER=disabled
export THROTTLE_ENABLED=false
export THROTTLE_LIMIT=100000
export LOGIN_THROTTLE_LIMIT=100000
export SEC_SECRETS_KEY="${SEC_SECRETS_KEY:-4a6b8c0d2e1f3a5b7c9d0e2f4a6b8c0d2e1f3a5b7c9d0e2f4a6b8c0d2e1f3a5b}"

export AGENT_REALTIME_E2E=1
export AGENT_REALTIME_STAMP="$STAMP"
export AGENT_REALTIME_DB_NAME="$DB_NAME"
export AGENT_REALTIME_REDIS_DB="$REDIS_DB"
export AGENT_REALTIME_PORT="$PORT"
export AGENT_REALTIME_ASSERTIONS_FILE="$ASSERTIONS_FILE"

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

run() {
  log "+ $*"
  "$@"
}

write_result() {
  local code="$1"
  local reason="${2:-}"
  RESULT_CODE="$code" RESULT_REASON="$reason" \
  RESULT_FILE="$RESULT_FILE" ASSERTIONS_FILE="$ASSERTIONS_FILE" \
  RESULT_STAMP="$STAMP" RESULT_DB="$DB_NAME" RESULT_REDIS_DB="$REDIS_DB" \
  RESULT_ARTIFACT="$ARTIFACT_REL" \
    node <<'NODE' || true
const fs = require("node:fs");
let assertions = null;
try {
  assertions = JSON.parse(fs.readFileSync(process.env.ASSERTIONS_FILE, "utf8"));
} catch {
  assertions = null;
}
const code = Number(process.env.RESULT_CODE);
const payload = {
  status: code === 0 ? "passed" : "failed",
  exitCode: code,
  reason: process.env.RESULT_REASON,
  stamp: process.env.RESULT_STAMP,
  database: process.env.RESULT_DB,
  redisDb: Number(process.env.RESULT_REDIS_DB),
  artifacts: process.env.RESULT_ARTIFACT,
  assertions,
  finishedAt: new Date().toISOString(),
};
fs.writeFileSync(process.env.RESULT_FILE, `${JSON.stringify(payload, null, 2)}\n`);
NODE
}

finish() {
  local code="$1"
  local reason="${2:-}"
  FINALIZED=1
  write_result "$code" "$reason"
  if [ "$code" -eq 0 ]; then
    log "PASS: $reason"
  else
    log "FAIL: $reason"
  fi
  exit "$code"
}

clean_redis_keys() {
  log "cleanup: Redis db=$REDIS_DB 前缀精确清理"
  (cd "$API_DIR" && node - "$REDIS_DB" <<'NODE' || true
const Redis = require("ioredis");
const db = Number(process.argv[2]);
const prefixes = [
  "acf:agent-abort:",
  "acf:agent-steer:",
  "acf:agent-steer-inbox:",
  "bull:agent-jobs:",
];
const client = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT),
  password: process.env.REDIS_PASSWORD || undefined,
  db,
  lazyConnect: true,
  enableOfflineQueue: false,
  commandTimeout: 3000,
});
(async () => {
  await client.connect();
  for (const prefix of prefixes) {
    let cursor = "0";
    do {
      const [next, keys] = await client.scan(
        cursor,
        "MATCH",
        `${prefix}*`,
        "COUNT",
        200,
      );
      cursor = next;
      if (keys.length) await client.del(...keys);
    } while (cursor !== "0");
  }
  await client.quit();
})().catch((err) => {
  console.warn(`cleanup redis warn: ${err?.message ?? err}`);
  try { client.disconnect(); } catch { /* best effort */ }
  process.exit(0);
});
NODE
  )
}

drop_throwaway_db() {
  if [ "$CREATED_DB" -ne 1 ]; then
    return 0
  fi
  log "cleanup: DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE)"
  (cd "$API_DIR" && node - "$DB_NAME" "$MAINTENANCE_DB" <<'NODE' || true
const { Client } = require("pg");
const target = process.argv[2];
if (!/^autoflow_agent_rt_e2e_[A-Za-z0-9_-]+$/.test(target)) {
  console.error("refusing to drop unexpected database name");
  process.exit(1);
}
const client = new Client({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.argv[3],
  connectionTimeoutMillis: 5000,
});
(async () => {
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`);
  await client.end();
})().catch((err) => {
  console.warn(`cleanup pg warn: ${err?.message ?? err}`);
  process.exit(0);
});
NODE
  )
}

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  log "cleanup: start (exit=$code)"
  drop_throwaway_db || true
  clean_redis_keys || true
  if [ "$FINALIZED" -ne 1 ]; then
    write_result "$code" "unexpected exit during verification"
  fi
  log "cleanup: done; artifacts=$ARTIFACT_REL"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log "agent-realtime L3 verify: stamp=$STAMP db=$DB_NAME redisDb=$REDIS_DB port=$PORT"
log "artifacts=$ARTIFACT_REL (commands.txt / assertions.json / result.json)"

# ── 0. 前置条件（缺任一即红，不 skip） ─────────────────────────────────
for cmd in node npm npx; do
  command -v "$cmd" >/dev/null 2>&1 || finish 1 "缺少命令: $cmd"
done
[ -f "$SPEC_FILE" ] || finish 1 "spec 不存在: $SPEC_FILE"
[ -x "$API_DIR/node_modules/.bin/jest" ] || finish 1 "apps/admin-api 依赖未安装（jest 缺失）"

if [[ ! "$DB_NAME" =~ ^autoflow_agent_rt_e2e_[A-Za-z0-9_-]+$ ]]; then
  finish 1 "throwaway DB 名非法: $DB_NAME"
fi
if [[ ! "$REDIS_DB" =~ ^[0-9]+$ ]] || [ "$REDIS_DB" -lt 1 ] || [ "$REDIS_DB" -gt 14 ]; then
  finish 1 "throwaway Redis DB 必须是 1..14: $REDIS_DB"
fi
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  finish 1 "PORT 非法: $PORT"
fi

(cd "$API_DIR" && node - "$MAINTENANCE_DB" <<'NODE'
const { Client } = require("pg");
const client = new Client({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.argv[2],
  connectionTimeoutMillis: 5000,
});
(async () => {
  await client.connect();
  await client.query("SELECT 1");
  await client.end();
})().catch((err) => {
  console.error(`PG 不可达: ${err?.message ?? err}`);
  process.exit(1);
});
NODE
) || finish 1 "PG 前置检查失败（$DB_HOST:$DB_PORT/${MAINTENANCE_DB}）"

(cd "$API_DIR" && node <<'NODE'
const Redis = require("ioredis");
const client = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT),
  password: process.env.REDIS_PASSWORD || undefined,
  db: Number(process.env.AGENT_REALTIME_REDIS_DB),
  lazyConnect: true,
  enableOfflineQueue: false,
  commandTimeout: 3000,
});
(async () => {
  await client.connect();
  const pong = await client.ping();
  if (pong !== "PONG") throw new Error(`unexpected ping: ${pong}`);
  await client.quit();
})().catch((err) => {
  console.error(`Redis 不可达: ${err?.message ?? err}`);
  try { client.disconnect(); } catch { /* best effort */ }
  process.exit(1);
});
NODE
) || finish 1 "Redis 前置检查失败（$REDIS_HOST:$REDIS_DB db=${REDIS_DB}）"

# ── 1. 建 throwaway 库并迁移 ───────────────────────────────────────────
(cd "$API_DIR" && node - "$DB_NAME" "$MAINTENANCE_DB" <<'NODE'
const { Client } = require("pg");
const target = process.argv[2];
if (!/^autoflow_agent_rt_e2e_[A-Za-z0-9_-]+$/.test(target)) process.exit(1);
const client = new Client({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.argv[3],
  connectionTimeoutMillis: 5000,
});
(async () => {
  await client.connect();
  await client.query(`CREATE DATABASE "${target}"`);
  await client.end();
})().catch((err) => {
  console.error(`CREATE DATABASE 失败: ${err?.message ?? err}`);
  process.exit(1);
});
NODE
) || finish 1 "无法创建 throwaway DB: $DB_NAME"
CREATED_DB=1
export DB_DATABASE="$DB_NAME"

(cd "$API_DIR" && run npm run migration:run) || finish 1 "throwaway DB 迁移失败"

# ── 2. 单 Jest 进程跑 L3 spec ──────────────────────────────────────────
log "+ npx jest --config ./test/jest-e2e.json --runInBand --runTestsByPath $SPEC_FILE"
set +e
(
  cd "$API_DIR"
  npx --node-options="--experimental-vm-modules --max-old-space-size=4096" \
    jest --config ./test/jest-e2e.json --runInBand --runTestsByPath "$SPEC_FILE"
)
TEST_EXIT=$?
set -e
if [ "$TEST_EXIT" -ne 0 ]; then
  finish "$TEST_EXIT" "jest 失败（exit=${TEST_EXIT}）"
fi

# ── 3. 反 skip 闸：必须有 5 组真实断言摘要 ────────────────────────────
[ -f "$ASSERTIONS_FILE" ] || finish 1 "断言摘要缺失（spec 可能未运行或被 skip）"
node - "$ASSERTIONS_FILE" <<'NODE' || finish 1 "断言摘要不全或存在未通过项（拒绝 skip 报绿）"
const fs = require("node:fs");
const required = [
  "cross-instance-delta-and-snapshot",
  "replay-over-5000-truncation",
  "terminal-append-zero-side-effects",
  "cross-instance-abort-signal-and-db",
  "cross-instance-steer-single-drain",
];
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (data.passed !== true) process.exit(1);
if (!Array.isArray(data.assertions) || data.assertions.length !== required.length) process.exit(1);
const names = data.assertions.map((a) => a.name);
if (required.some((name) => !names.includes(name))) process.exit(1);
if (data.assertions.some((a) => a.passed !== true)) process.exit(1);
NODE

finish 0 "5 组 L3 断言全过；artifacts=$ARTIFACT_REL"
