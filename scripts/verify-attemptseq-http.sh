#!/usr/bin/env bash
# attemptSeq 真 admin HTTP + 真 executor-node 子进程端到端验证。
#
# 只操作 throwaway DB（DB_DATABASE=autoflow_attemptseq_http_<stamp>）与
# stamp 前缀 Redis 哨兵键；trap 统一清理 DB / Redis / 子进程 / 临时目录。
# 单 Jest 进程，不跑全量构建或测试，不改默认 autoflow 库。
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
export ATTEMPTSEQ_HTTP_STAMP="$STAMP"
export HARDENING_STAMP="$STAMP"
DB_NAME="autoflow_attemptseq_http_${STAMP}"

export SELFTEST_SKIP_ENV_FILE=1
export NODE_ENV=test

export DB_HOST="${DB_HOST:-$(read_env DB_HOST)}"
export DB_PORT="${DB_PORT:-$(read_env DB_PORT)}"
export DB_USERNAME="${DB_USERNAME:-$(read_env DB_USERNAME)}"
export DB_PASSWORD="${DB_PASSWORD:-$(read_env DB_PASSWORD)}"
export DB_DATABASE="$DB_NAME"
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

# push 派发的执行器地址取宿主非回环 IPv4；私网地址需要这个开关。
export EXECUTOR_ALLOW_PRIVATE_NETWORK=true
export ATTEMPTSEQ_HTTP_TMP="${ATTEMPTSEQ_HTTP_TMP:-/tmp/opencode/attemptseq-http-${STAMP}}"
mkdir -p "$ATTEMPTSEQ_HTTP_TMP"

if [[ -z "${DB_HOST}" || -z "${DB_PORT}" || -z "${DB_USERNAME}" || -z "${DB_PASSWORD}" ]]; then
  echo "[attemptseq-http] PG 连接信息不足：DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD" >&2
  exit 2
fi
if [[ -z "${REDIS_HOST}" || -z "${REDIS_PORT}" ]]; then
  echo "[attemptseq-http] Redis 连接信息不足：REDIS_HOST/REDIS_PORT" >&2
  exit 2
fi

cleanup_child() {
  local rc=0 pid_file="$ATTEMPTSEQ_HTTP_TMP/executor.pid" pid=""
  if [[ -f "$pid_file" ]]; then
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "[attemptseq-http] cleanup: killing leftover executor child pid=${pid}"
      kill -TERM "$pid" 2>/dev/null || true
      sleep 2
      if kill -0 "$pid" 2>/dev/null; then
        kill -KILL "$pid" 2>/dev/null || true
        sleep 1
      fi
    fi
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "[attemptseq-http] cleanup FAIL: executor child pid=${pid} still alive" >&2
      rc=1
    else
      echo "[attemptseq-http] cleanup: executor child pid=${pid} exited"
    fi
  fi
  return "$rc"
}

cleanup_redis() {
  node --input-type=module <<'NODE'
import { createRequire } from "node:module";
const require = createRequire(process.env.API_DIR + "/noop.js");
const Redis = require("ioredis");
const stamp = process.env.ATTEMPTSEQ_HTTP_STAMP;
const client = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT),
  password: process.env.REDIS_PASSWORD || undefined,
  db: Number(process.env.REDIS_DB || 0),
  lazyConnect: false,
});
const patterns = [
  `acf:pull:*${stamp}*`,
  `acf:cmd:*${stamp}*`,
  `acf:cmdmeta:*${stamp}*`,
  `acf:cmdres:*${stamp}*`,
  `slot-release:*${stamp}*`,
];
let deleted = 0;
try {
  for (const pattern of patterns) {
    let cursor = "0";
    do {
      const [next, keys] = await client.scan(cursor, "MATCH", pattern, "COUNT", 500);
      if (keys.length) deleted += await client.del(...keys);
      cursor = next;
    } while (cursor !== "0");
  }
  let remaining = 0;
  for (const pattern of patterns) {
    let cursor = "0";
    do {
      const [next, keys] = await client.scan(cursor, "MATCH", pattern, "COUNT", 500);
      remaining += keys.length;
      cursor = next;
    } while (cursor !== "0");
  }
  console.log(`[attemptseq-http] cleanup redis stamp=${stamp} deleted=${deleted} remaining=${remaining}`);
  if (remaining !== 0) process.exitCode = 1;
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
const db = process.env.DB_DATABASE;
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
  const check = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [db]);
  console.log(`[attemptseq-http] cleanup database ${db} dropped=${check.rowCount === 0}`);
  if (check.rowCount !== 0) process.exitCode = 1;
} finally {
  await client.end();
}
NODE
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  cleanup_child || rc=1
  cleanup_redis || rc=1
  cleanup_db || rc=1
  rm -rf "$ATTEMPTSEQ_HTTP_TMP"
  exit "$rc"
}
trap cleanup EXIT INT TERM

echo "[attemptseq-http] DB=${DB_NAME} stamp=${STAMP} tmp=${ATTEMPTSEQ_HTTP_TMP}"
echo "[attemptseq-http] PG=${DB_HOST}:${DB_PORT}/${DB_USERNAME} Redis=${REDIS_HOST}:${REDIS_PORT}"

node --input-type=module <<'NODE'
import { ensureDatabase } from "./scripts/pg-provision.lib.mjs";
await ensureDatabase({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  dbName: process.env.DB_DATABASE,
  dropFirst: true,
});
console.log(`[attemptseq-http] provisioned ${process.env.DB_DATABASE}`);
NODE

(
  cd "$API_DIR"
  npm run migration:run
)

echo "[attemptseq-http] migrations applied to ${DB_NAME}"
echo "[attemptseq-http] jest --runInBand --runTestsByPath test/attemptseq-http.e2e-spec.ts"

set +e
(
  cd "$API_DIR"
  npx --node-options="--experimental-vm-modules --max-old-space-size=4096" jest \
    --config ./test/jest-e2e.json \
    --globals '{"ts-jest":{"tsconfig":"<rootDir>/../tsconfig.json","diagnostics":false}}' \
    --runInBand \
    --runTestsByPath \
    ./test/attemptseq-http.e2e-spec.ts
)
JEST_RC=$?
set -e
echo "[attemptseq-http] jest exit code: ${JEST_RC}"
exit "$JEST_RC"
