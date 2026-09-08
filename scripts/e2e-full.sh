#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# 根级 43 例 Playwright e2e 全链编排（CI 与本地同一入口）
#
# 链路：PG + Redis → admin-api(:3105) → executor-node(:8002 注册在线)
#       → admin-web vite(:5176) → 根级 e2e-full.spec.js（43 例，chromium）
#
# 前置：bash + docker + node>=20 + apps/*/node_modules 已安装
#       （CI job 与本脚本各自保证；playwright chromium 由脚本兜底 install）
#
# 用法：
#   bash scripts/e2e-full.sh                    # docker 一次性 PG/Redis（默认，本地/CI 通用）
#   SKIP_DOCKER=1 bash scripts/e2e-full.sh      # 复用本机已有 PG/Redis（凭据用 E2E_* 覆盖）
#
# 可覆盖环境变量（SKIP_DOCKER 模式常用）：
#   E2E_DB_HOST/E2E_DB_PORT/E2E_DB_USER/E2E_DB_PASS/E2E_DB_NAME
#   E2E_REDIS_HOST/E2E_REDIS_PORT/E2E_REDIS_PASS
#   E2E_API_BASE  # admin-api 地址漂移时覆盖（默认 http://localhost:3105）
#
# 设计注记（对齐 windows-findings W-22 教训——一律真实进程环境，不依赖 .env）：
#   - 每次全新 DB：迁移链真实空库跑一遍，admin seed / 任务 / 执行记录零残留，
#     断言不漂移（docker 模式 drop+create 重建，SKIP_DOCKER 模式要求空库）。
#   - LOGIN_THROTTLE_LIMIT / THROTTLE_LIMIT 显式放大：43 例 ~60 次登录 +
#     高频 API 轮询，默认 20/60 必级联 429（Windows 首跑 W-22 同根）。
#   - EXECUTION_CALLBACK_SECRET 两端同值：显式配置消除 fallback 语义漂移。
#   - EXECUTOR_ALLOW_PRIVATE_NETWORK=true：派发目标 localhost:8002 是回环地址，
#     safe-http SSRF 守卫默认阻断回环（round-9 VERIFY 同款配置）。
#   - 全部子进程 exec 化 + trap 清理：容器 / 三服务 / 日志不落残留。
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

# 本机代理（http_proxy 等）会把 curl/浏览器的 localhost 请求转发到远程代理
# 造成 502——e2e 全链都是 localhost 通信，统一绕过。CI 无代理，设置无副作用。
export no_proxy="localhost,127.0.0.1,::1"
export NO_PROXY="$no_proxy"

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

PG_PORT="${E2E_DB_PORT:-15432}"
REDIS_PORT="${E2E_REDIS_PORT:-16379}"
DB_HOST="${E2E_DB_HOST:-localhost}"
DB_USER="${E2E_DB_USER:-autoflow}"
DB_PASS="${E2E_DB_PASS:-test}"
DB_NAME="${E2E_DB_NAME:-autoflow_e2e_ci_$(date +%s)}"
REDIS_HOST="${E2E_REDIS_HOST:-localhost}"
REDIS_PASS="${E2E_REDIS_PASS:-}"

PORT_API=3105
PORT_WEB=5176
PORT_EXECUTOR=8002
# Executor 任务工作目录：默认 POSIX /tmp；Windows runner 传 E2E_WORK_DIR=
# C:/tmp/... （node 在 win32 把 "/tmp" 解析为当前盘根，故须给绝对盘符路径）。
EXEC_WORK_DIR="${E2E_WORK_DIR:-/tmp/acf-e2e-tasks}"
# 日志根：ubuntu 默认 /tmp；Windows Git-Bash 的 /tmp≠MSYS 之外可见路径，
# CI windows job 显式指到 C:/tmp 与 artifacts 采集路径对齐。
LOG_ROOT="${E2E_LOG_ROOT:-/tmp}"
LOG_DIR="$(mktemp -d "$LOG_ROOT"/acf-e2e-logs.XXXXXX)"

PG_CONTAINER=acf-e2e-pg-$$
REDIS_CONTAINER=acf-e2e-redis-$$
DOCKER_MODE=1
[[ "${SKIP_DOCKER:-0}" == "1" ]] && DOCKER_MODE=0

# 与 ci.yml admin-api-test env 块逐一对齐（测试专用值，非生产机密）
E2E_ENV=(
  "NODE_ENV=development"
  "DB_HOST=$DB_HOST" "DB_PORT=$PG_PORT"
  "DB_USERNAME=$DB_USER" "DB_PASSWORD=$DB_PASS" "DB_DATABASE=$DB_NAME"
  "REDIS_HOST=$REDIS_HOST" "REDIS_PORT=$REDIS_PORT"
  ${REDIS_PASS:+"REDIS_PASSWORD=$REDIS_PASS"}
  "JWT_SECRET=test-jwt-secret-32chars-long-here"
  "JWT_REFRESH_SECRET=test-refresh-secret-32chars-long"
  "EXECUTOR_SECRET=test-executor-secret"
  "EXECUTION_CALLBACK_SECRET=test-executor-secret"
  "EXECUTOR_ALLOW_PRIVATE_NETWORK=true"
  "INITIAL_ADMIN_USERNAME=admin" "INITIAL_ADMIN_PASSWORD=admin123"
  "AI_PROVIDER=disabled"
  "LOGIN_THROTTLE_LIMIT=10000"
  "THROTTLE_LIMIT=10000"
)

PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  sleep 1
  for p in "${PIDS[@]:-}"; do kill -9 "$p" 2>/dev/null || true; done
  if [[ "$DOCKER_MODE" == "1" ]]; then
    docker rm -f "$PG_CONTAINER" "$REDIS_CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

fail_with_log() { # fail_with_log <日志文件> <消息>
  echo "✗ $2（日志尾部如下）" >&2
  tail -40 "$1" >&2 || true
  exit 1
}

wait_http() { # wait_http <url> <超时秒> <名称> <日志文件>
  local url="$1" timeout="$2" name="$3" logfile="$4"
  for _ in $(seq 1 "$timeout"); do
    curl -sf -o /dev/null "$url" && return 0
    sleep 1
  done
  fail_with_log "$logfile" "$name 在 ${timeout}s 内未就绪: $url"
}

echo "══ [1/6] 依赖服务：PG + Redis ══"
if [[ "$DOCKER_MODE" == "1" ]]; then
  docker rm -f "$PG_CONTAINER" "$REDIS_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$PG_CONTAINER" -e POSTGRES_USER=autoflow \
    -e POSTGRES_PASSWORD=test -e POSTGRES_DB=autoflow_test \
    -p "$PG_PORT:5432" postgres:16-alpine >/dev/null
  docker run -d --name "$REDIS_CONTAINER" -p "$REDIS_PORT:6379" redis:7-alpine >/dev/null
  for _ in $(seq 1 30); do
    docker exec "$PG_CONTAINER" pg_isready -U autoflow >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "$PG_CONTAINER" pg_isready -U autoflow >/dev/null \
    || fail_with_log "$LOG_DIR/no-pg.log" "PG 容器 30s 未就绪"
  # 全新库：drop+create 幂等（时间戳库名理论不撞，drop 兜底手改 DB_NAME 的重跑）
  docker exec "$PG_CONTAINER" psql -U autoflow -d postgres \
    -c "DROP DATABASE IF EXISTS \"$DB_NAME\";" >/dev/null
  docker exec "$PG_CONTAINER" psql -U autoflow -d postgres \
    -c "CREATE DATABASE \"$DB_NAME\";" >/dev/null
  echo "PG/Redis 容器就绪，空库 $DB_NAME 已建"
else
  command -v psql >/dev/null || { echo "SKIP_DOCKER 模式需要 psql 客户端"; exit 1; }
  export PGPASSWORD="$DB_PASS"
  psql -h "$DB_HOST" -p "$PG_PORT" -U "$DB_USER" -d postgres \
    -c "CREATE DATABASE \"$DB_NAME\";" >/dev/null \
    || fail_with_log "$LOG_DIR/no-pg.log" "建库失败（$DB_NAME 已存在或凭据错误）"
  echo "复用本机 PG/Redis，空库 $DB_NAME 已建"
fi

echo "══ [2/6] admin-api 构建 + 空库迁移链 ══"
(
  cd apps/admin-api
  [[ -d node_modules ]] || { echo "admin-api/node_modules 缺失，npm ci"; npm ci; }
  npm run build >/dev/null
  env "${E2E_ENV[@]}" npm run migration:run
) >"$LOG_DIR/admin-api-build.log" 2>&1 \
  || fail_with_log "$LOG_DIR/admin-api-build.log" "admin-api 构建/迁移失败"

echo "══ [3/6] 启动 admin-api(:$PORT_API) ══"
(
  cd apps/admin-api
  exec env "${E2E_ENV[@]}" PORT=$PORT_API node dist/main.js
) >"$LOG_DIR/admin-api.log" 2>&1 &
PIDS+=($!)
wait_http "http://localhost:$PORT_API/api/health" 60 "admin-api" "$LOG_DIR/admin-api.log"
echo "admin-api /api/health OK"

echo "══ [4/6] 启动 executor-node(:$PORT_EXECUTOR) ══"
(
  cd apps/executor-node
  [[ -d node_modules ]] || { echo "executor-node/node_modules 缺失，npm ci"; npm ci; }
  npm run build >/dev/null
  exec env "${E2E_ENV[@]}" \
    APP_NAME=executor-node-e2e \
    PORT=$PORT_EXECUTOR \
    EXECUTOR_ADDRESS=localhost:$PORT_EXECUTOR \
    ADMIN_API_URL=http://localhost:$PORT_API \
    WORK_DIR=$EXEC_WORK_DIR \
    node dist/main.js
) >"$LOG_DIR/executor-node.log" 2>&1 &
PIDS+=($!)
wait_http "http://localhost:$PORT_EXECUTOR/health" 60 "executor-node" "$LOG_DIR/executor-node.log"
echo "executor-node /health OK"

# 注册 online 轮询：/health 只证明进程在，getFirstOnlineExecutor 要的是
# admin-api 侧 status=online（注册+首跳心跳异步完成，30s 窗口兜底）
mkdir -p "$EXEC_WORK_DIR"
REG_OK=0
for _ in $(seq 1 30); do
  TOK=$(curl -sf -X POST "http://localhost:$PORT_API/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d '{"username":"admin","password":"admin123"}' \
    | grep -o '"accessToken":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  if [[ -n "${TOK:-}" ]] && curl -sf "http://localhost:$PORT_API/api/executors" \
      -H "Authorization: Bearer $TOK" | grep -q '"status":"online"'; then
    REG_OK=1
    break
  fi
  sleep 1
done
[[ $REG_OK == 1 ]] || fail_with_log "$LOG_DIR/executor-node.log" "执行器 30s 内未注册 online"
echo "executor-node 已注册 online"

echo "══ [5/6] 启动 admin-web vite(:$PORT_WEB) ══"
(
  cd apps/admin-web
  [[ -d node_modules ]] || { echo "admin-web/node_modules 缺失，npm ci"; npm ci; }
  exec env VITE_PORT=$PORT_WEB node_modules/.bin/vite --port $PORT_WEB --strictPort
) >"$LOG_DIR/admin-web.log" 2>&1 &
PIDS+=($!)
wait_http "http://localhost:$PORT_WEB/" 60 "admin-web" "$LOG_DIR/admin-web.log"
echo "vite OK"

echo "══ [6/6] Playwright 43 例（根级 spec + 根级 config）══"
cd apps/admin-web
npx playwright install chromium >/dev/null 2>&1 || true
set +e
NODE_PATH="$(pwd)/node_modules" npx playwright test \
  --config=../../playwright.e2e.config.js \
  "$@"
RC=$?
set -e
cd "$REPO_ROOT"

echo ""
if [[ $RC == 0 ]]; then
  echo "✓ e2e 全部通过（日志目录：$LOG_DIR）"
else
  echo "✗ e2e 失败 exit=$RC（日志目录：$LOG_DIR）" >&2
  echo "── admin-api 日志尾部 ──" >&2
  tail -30 "$LOG_DIR/admin-api.log" >&2 || true
  echo "── executor-node 日志尾部 ──" >&2
  tail -30 "$LOG_DIR/executor-node.log" >&2 || true
fi
exit $RC
