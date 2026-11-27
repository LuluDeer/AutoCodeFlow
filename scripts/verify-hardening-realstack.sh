#!/usr/bin/env bash
# 真 PG/真 Redis 进程内集成验证：临时库供给 → 迁移 → 单 Jest 进程 → 清理。
# 只操作 HARDENING_DB_NAME 指定的 throwaway 库与 HARDENING_STAMP 前缀的 Redis 键。
# 证据落盘：artifacts/verification/hardening-realstack-<timestamp>/{commands.txt,jest.log,result.json}
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
API_DIR="$ROOT/apps/admin-api"
ENV_FILE="$ROOT/.env"
cd "$ROOT"

export API_DIR

read_env() {
  local key="$1"
  node --input-type=module - "$key" "$ENV_FILE" <<'NODE'
import { readEnvFileValue } from "./scripts/lib/selftest-hermetic.mjs";
const [, , key, file] = process.argv;
const value = readEnvFileValue(file, key);
if (value != null) process.stdout.write(value);
NODE
}

STAMP="$(date -u +%Y%m%d%H%M%S)_$$_${RANDOM}"
export HARDENING_STAMP="$STAMP"
export HARDENING_DB_NAME="autoflow_hardening_${STAMP}"

# ── 落盘证据：每次运行一个目录，沿用 L4 既有命名风格 ──────────────────────
# 目录名 hardening-realstack-YYYYMMDD-HHMMSS 与 hardening-browser-* / fullstack-workbench-* 对齐。
EVIDENCE_TS="$(date -u +%Y%m%d-%H%M%S)"
EVIDENCE_DIR="$ROOT/artifacts/verification/hardening-realstack-${EVIDENCE_TS}"
mkdir -p "$EVIDENCE_DIR"
COMMANDS_LOG="$EVIDENCE_DIR/commands.txt"
JEST_LOG="$EVIDENCE_DIR/jest.log"
RESULT_JSON="$EVIDENCE_DIR/result.json"
EVIDENCE_HELPER="$SCRIPT_DIR/hardening-evidence.mjs"
: > "$COMMANDS_LOG"
: > "$JEST_LOG"

# 合并字段进 result.json（助手失败不阻断验收，但显式告警，保证证据写入失败可见）
evidence_set() {
  node "$EVIDENCE_HELPER" "$RESULT_JSON" "$@" || \
    echo "[verify-hardening] WARN: result.json 写入失败 ($RESULT_JSON)" >&2
}
# 与既有 L4 commands.txt 一致的 "<命令> :: exit=<码>" 行
log_cmd() {
  printf '%s :: exit=%s\n' "$1" "$2" >> "$COMMANDS_LOG" || true
}

export SELFTEST_SKIP_ENV_FILE=1
export NODE_ENV=test

export DB_HOST="${DB_HOST:-$(read_env DB_HOST)}"
export DB_PORT="${DB_PORT:-$(read_env DB_PORT)}"
export DB_USERNAME="${DB_USERNAME:-$(read_env DB_USERNAME)}"
export DB_PASSWORD="${DB_PASSWORD:-$(read_env DB_PASSWORD)}"
export DB_DATABASE="$HARDENING_DB_NAME"
export DB_POOL_SIZE="${DB_POOL_SIZE:-20}"

export REDIS_HOST="${REDIS_HOST:-$(read_env REDIS_HOST)}"
export REDIS_PORT="${REDIS_PORT:-$(read_env REDIS_PORT)}"
export REDIS_PASSWORD="${REDIS_PASSWORD:-$(read_env REDIS_PASSWORD)}"
export REDIS_DB="${REDIS_DB:-0}"

export JWT_SECRET="test-jwt-secret-0123456789abcdef0123"
export JWT_REFRESH_SECRET="test-jwt-refresh-secret-0123456789ab"
export EXECUTOR_SECRET="test-executor-secret-16"
export INITIAL_ADMIN_PASSWORD="HardeningAdmin!2026"
export ADMIN_TEST_USER="admin"
export ADMIN_TEST_PASS="$INITIAL_ADMIN_PASSWORD"

# 初始 result.json：记录时间、throwaway 标识、jest/cleanup 占位（后续各阶段增量合并）
evidence_set \
  "status=RUNNING" \
  "evidenceDir=$EVIDENCE_DIR" \
  "startedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "startedAtEpoch=$(date +%s)" \
  "dbName=$HARDENING_DB_NAME" \
  "stamp=$HARDENING_STAMP" \
  "redisPattern=slot-release:*${STAMP}*" \
  "pg=${DB_HOST}:${DB_PORT}/${DB_USERNAME}" \
  "redis=${REDIS_HOST}:${REDIS_PORT}" \
  "jestExitCode=null" \
  "jestRan=false" \
  "cleanupStatus=PENDING" \
  "cleanup={}" \
  "scriptExitCode=null"

if [[ -z "${DB_HOST}" || -z "${DB_PORT}" || -z "${DB_USERNAME}" || -z "${DB_PASSWORD}" ]]; then
  echo "[verify-hardening] PG 连接信息不足：DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD" >&2
  evidence_set "status=FAIL" "failReason=pg_env_incomplete" \
    "scriptExitCode=2" "finishedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  exit 2
fi
if [[ -z "${REDIS_HOST}" || -z "${REDIS_PORT}" ]]; then
  echo "[verify-hardening] Redis 连接信息不足：REDIS_HOST/REDIS_PORT" >&2
  evidence_set "status=FAIL" "failReason=redis_env_incomplete" \
    "scriptExitCode=2" "finishedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  exit 2
fi

cleanup_redis() {
  node --input-type=module <<'NODE'
import { createRequire } from "node:module";
const require = createRequire(process.env.API_DIR + "/noop.js");
const Redis = require("ioredis");
const client = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT),
  password: process.env.REDIS_PASSWORD || undefined,
  db: Number(process.env.REDIS_DB || 0),
  lazyConnect: false,
});
const pattern = `slot-release:*${process.env.HARDENING_STAMP}*`;
let cursor = "0";
let deleted = 0;
try {
  do {
    const [next, keys] = await client.scan(cursor, "MATCH", pattern, "COUNT", 500);
    if (keys.length) deleted += await client.del(...keys);
    cursor = next;
  } while (cursor !== "0");
  console.log(`[verify-hardening] cleanup redis pattern=${pattern} deleted=${deleted}`);
} finally {
  await client.quit();
}
NODE
}

cleanup_db() {
  node --input-type=module <<'NODE'
import { createRequire } from "node:module";
const require = createRequire(process.env.API_DIR + "/noop.js");
const { Client } = require("pg");
const db = process.env.HARDENING_DB_NAME;
const client = new Client({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: "postgres",
});
await client.connect();
try {
  await client.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [db],
  );
  await client.query(`DROP DATABASE IF EXISTS "${db}"`);
  console.log(`[verify-hardening] cleanup database ${db} dropped`);
} finally {
  await client.end();
}
NODE
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM

  # 逐项执行清理并记录退出码；任一项失败 => 显式 FAIL，且脚本最终非 0
  local redis_rc=0 db_rc=0
  cleanup_redis || redis_rc=$?
  log_cmd "cleanup redis pattern=slot-release:*${STAMP}*" "$redis_rc"
  cleanup_db || db_rc=$?
  log_cmd "cleanup database ${HARDENING_DB_NAME}" "$db_rc"

  local cleanup_status="ok"
  if (( redis_rc != 0 || db_rc != 0 )); then
    cleanup_status="FAIL"
    rc=1
  fi

  local final_status="PASS"
  if (( rc != 0 )); then final_status="FAIL"; fi

  # 把清理结果写回 result.json（含可机器判定的逐项退出码）
  evidence_set \
    "cleanupStatus=$cleanup_status" \
    "cleanup={\"redisExitCode\":${redis_rc},\"databaseExitCode\":${db_rc},\"status\":\"${cleanup_status}\"}" \
    "status=$final_status" \
    "scriptExitCode=$rc" \
    "finishedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "finishedAtEpoch=$(date +%s)"

  echo "[verify-hardening] evidence: $EVIDENCE_DIR"
  exit "$rc"
}
trap cleanup EXIT INT TERM

echo "[verify-hardening] DB=${HARDENING_DB_NAME} stamp=${HARDENING_STAMP}"
echo "[verify-hardening] PG=${DB_HOST}:${DB_PORT}/${DB_USERNAME} Redis=${REDIS_HOST}:${REDIS_PORT}"

set +e
node --input-type=module <<'NODE'
import { ensureDatabase } from "./scripts/pg-provision.lib.mjs";
await ensureDatabase({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  dbName: process.env.HARDENING_DB_NAME,
  dropFirst: true,
});
console.log(`[verify-hardening] provisioned ${process.env.HARDENING_DB_NAME}`);
NODE
PROV_RC=$?
set -e
log_cmd "create throwaway database ${HARDENING_DB_NAME}" "$PROV_RC"
evidence_set "provisionExitCode=$PROV_RC"
if (( PROV_RC != 0 )); then
  evidence_set "status=FAIL" "failReason=provision_failed"
  exit "$PROV_RC"
fi

set +e
(
  cd "$API_DIR"
  npm run migration:run
)
MIG_RC=$?
set -e
log_cmd "admin-api npm run migration:run" "$MIG_RC"
evidence_set "migrationExitCode=$MIG_RC"
if (( MIG_RC != 0 )); then
  evidence_set "status=FAIL" "failReason=migration_failed"
  exit "$MIG_RC"
fi

echo "[verify-hardening] migrations applied to ${HARDENING_DB_NAME}"
echo "[verify-hardening] jest --runInBand --runTestsByPath attemptseq-pg,broadcast-slot-e2e,timeout-policy,task-paused"

# jest 全量 stdout/stderr 落盘 jest.log，同时仍在终端输出（验收语义不变）
set +e
(
  cd "$API_DIR"
  npx --node-options="--experimental-vm-modules --max-old-space-size=4096" jest \
    --config ./test/jest-e2e.json \
    --globals '{"ts-jest":{"tsconfig":"<rootDir>/../tsconfig.json","diagnostics":false}}' \
    --testRegex '(\.e2e-spec|-e2e\.spec)\.ts$' \
    --runInBand \
    --runTestsByPath \
    ./test/attemptseq-pg.e2e-spec.ts \
    ./test/broadcast-slot-e2e.spec.ts \
    ./test/timeout-policy.e2e-spec.ts \
    ./test/task-paused.e2e-spec.ts
) 2>&1 | tee "$JEST_LOG"
JEST_RC=${PIPESTATUS[0]}
set -e
log_cmd "npx jest --runInBand --runTestsByPath attemptseq-pg,broadcast-slot-e2e,timeout-policy,task-paused" "$JEST_RC"
# jest exit code 写入 result.json（非 0 由下方 exit 保持脚本非 0 退出）
evidence_set "jestExitCode=$JEST_RC" "jestRan=true"
echo "[verify-hardening] jest exit code: ${JEST_RC}"
exit "$JEST_RC"
