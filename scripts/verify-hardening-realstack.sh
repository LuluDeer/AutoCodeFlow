#!/usr/bin/env bash
# 真 PG/真 Redis 进程内集成验证：临时库供给 → 迁移 → 单 Jest 进程 → 清理。
# 只操作 HARDENING_DB_NAME 指定的 throwaway 库与 HARDENING_STAMP 前缀的 Redis 键。
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

if [[ -z "${DB_HOST}" || -z "${DB_PORT}" || -z "${DB_USERNAME}" || -z "${DB_PASSWORD}" ]]; then
  echo "[verify-hardening] PG 连接信息不足：DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD" >&2
  exit 2
fi
if [[ -z "${REDIS_HOST}" || -z "${REDIS_PORT}" ]]; then
  echo "[verify-hardening] Redis 连接信息不足：REDIS_HOST/REDIS_PORT" >&2
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
  cleanup_redis || rc=1
  cleanup_db || rc=1
  exit "$rc"
}
trap cleanup EXIT INT TERM

echo "[verify-hardening] DB=${HARDENING_DB_NAME} stamp=${HARDENING_STAMP}"
echo "[verify-hardening] PG=${DB_HOST}:${DB_PORT}/${DB_USERNAME} Redis=${REDIS_HOST}:${REDIS_PORT}"

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

(
  cd "$API_DIR"
  npm run migration:run
)

echo "[verify-hardening] migrations applied to ${HARDENING_DB_NAME}"
echo "[verify-hardening] jest --runInBand --runTestsByPath attemptseq-pg,broadcast-slot-e2e,timeout-policy,task-paused"

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
)
JEST_RC=$?
set -e
echo "[verify-hardening] jest exit code: ${JEST_RC}"
exit "$JEST_RC"
