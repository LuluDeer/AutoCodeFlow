#!/usr/bin/env bash
# ============================================================================
# scripts/e2e-local.sh —— 在本机把 admin-api 的 e2e 跑起来（WS-D / DevEx §1.1）
#
# ## 为什么需要这个脚本
#
# `npm run test:e2e` 需要三件本机通常没有的东西，缺任何一件都会表现为
# **一堆 401 失败**（而不是一句「环境没准备好」）：
#
#   1. 一个**干净的**库 —— 老库残留半截 schema 时 `migration:run` 会死在
#      `relation "users" already exists`，而 e2e 本身照样启动、只是登录全 401；
#   2. `INITIAL_ADMIN_PASSWORD` —— 迁移里的 admin seed 读它建用户；不设则
#      `users` 表为空 → `loginAsAdmin` 拿不到 token → 除 401 用例外全红；
#   3. 先跑过一次 `migration:run` —— e2e 的 `helper` 不会自己建表。
#
# 本脚本把这三步做掉，并**显式区分环境问题与真实失败**：迁移没跑通就立即
# 退出（不跑 e2e），因为"库没准备好"和"代码坏了"的排查成本差一个数量级。
#
# ## 用法
#
#   bash scripts/e2e-local.sh              # 用默认凭据（见下）
#   bash scripts/e2e-local.sh --recreate   # 先 DROP 并重建测试库（干净起点）
#   E2E_DB_NAME=my_test bash scripts/e2e-local.sh
#
# 默认凭据与 docker-compose / CI 对齐（DB postgres/postgres，Redis 无密码）。
# 本机 Redis 若设了 requirepass，用 REDIS_PASSWORD 传入。
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RECREATE=0
for arg in "$@"; do
  case "$arg" in
    --recreate) RECREATE=1 ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 1 ;;
  esac
done

export DB_HOST="${DB_HOST:-127.0.0.1}"
export DB_PORT="${DB_PORT:-5432}"
export DB_USERNAME="${DB_USERNAME:-postgres}"
export DB_PASSWORD="${DB_PASSWORD:-postgres}"
export E2E_DB_NAME="${E2E_DB_NAME:-autoflow_test}"
export DB_DATABASE="$E2E_DB_NAME"
export REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
export REDIS_PORT="${REDIS_PORT:-6379}"
export JWT_SECRET="${JWT_SECRET:-test-jwt-secret-32chars-long-here}"
export JWT_REFRESH_SECRET="${JWT_REFRESH_SECRET:-test-refresh-secret-32chars-long}"
export EXECUTOR_SECRET="${EXECUTOR_SECRET:-test-executor-secret}"
export INITIAL_ADMIN_PASSWORD="${INITIAL_ADMIN_PASSWORD:-admin123}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

# ---- 前置探测：先证明依赖可达，再谈跑测试 -------------------------------
say "探测依赖"
if command -v pg_isready >/dev/null 2>&1; then
  pg_isready -h "$DB_HOST" -p "$DB_PORT" >/dev/null 2>&1 \
    || die "PostgreSQL 不可达（$DB_HOST:$DB_PORT）。先起库：docker compose up -d postgres"
  echo "    PostgreSQL OK ($DB_HOST:$DB_PORT)"
else
  echo "    (pg_isready 不在 PATH，跳过探测，交给迁移报错)"
fi
if command -v redis-cli >/dev/null 2>&1; then
  if [ -n "${REDIS_PASSWORD:-}" ]; then
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -a "$REDIS_PASSWORD" --no-auth-warning ping 2>/dev/null | grep -q PONG \
      || die "Redis 不可达（$REDIS_HOST:$REDIS_PORT）"
  else
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping 2>/dev/null | grep -q PONG \
      || die "Redis 不可达（$REDIS_HOST:$REDIS_PORT）"
  fi
  echo "    Redis OK ($REDIS_HOST:$REDIS_PORT)"
else
  echo "    (redis-cli 不在 PATH，跳过探测)"
fi

# ---- 可选：重建库 --------------------------------------------------------
if [ "$RECREATE" = "1" ]; then
  say "重建测试库 $E2E_DB_NAME"
  PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USERNAME" -d postgres \
    -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$E2E_DB_NAME\" WITH (FORCE);"
  PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USERNAME" -d postgres \
    -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$E2E_DB_NAME\";"
  echo "    已重建"
fi

# ---- 迁移（含 admin seed）-----------------------------------------------
# 迁移失败就停下：不跑 e2e。否则会得到一串看似"代码坏了"的 401。
say "跑迁移（含 admin seed）"
cd "$ROOT/apps/admin-api"
if ! npm run migration:run; then
  die "migration:run 失败。若报 'relation ... already exists'，说明库里残留半截 schema
   —— 用 bash scripts/e2e-local.sh --recreate 重建一个干净库再试。"
fi

# ---- 跑 e2e -------------------------------------------------------------
# ⚠️ 另一个实测踩到的坑：apps/admin-api/.env 若存在，dotenv 会读它，可能与
#    本脚本导出的 E2E 库/凭据冲突（"迁移跑到东边、e2e 连西边"）。若发现库不对，
#    先确认没有 .env 在抢。同理 apps/executor-node/.env 里的 EXECUTOR_SHARED_TOKEN
#    会盖掉外部注入的 EXECUTOR_SECRET，导致执行器注册 401（见 e2e-full.sh 场景）。
say "跑 e2e"
npm run test:e2e
STATUS=$?

if [ "$STATUS" -eq 0 ]; then
  say "e2e 全部通过"
  # ⚠️ 重要：e2e 套件里含 test/openapi-export.e2e-spec.ts，它会把
  # apps/admin-api/openapi.json 重写成**纯中文**（剥掉全部 x-i18n-en）。
  # 只有 `npm run swagger:export` 会串联注入英文。所以跑完 e2e 后
  # openapi.json 一定显示巨大 diff —— 那是假象，不是你的改动。
  # 恢复方法（需同样的 DB/Redis 环境）：
  #   cd apps/admin-api && npm run swagger:export
  say "提示：openapi.json 已被 e2e 重写为纯中文；提交前请跑 swagger:export 恢复"
else
  die "e2e 有失败（exit=$STATUS）。注意：若大面积 401，先确认 admin 用户是否建出来了
   （INITIAL_ADMIN_PASSWORD 是否生效、users 表是否非空），而不是先怀疑鉴权代码。"
fi
