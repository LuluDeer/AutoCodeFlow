#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# QA-05/BUG-19 容量压测编排——与 e2e-full.sh 同一栈形态，末段驱动 load-test.mjs
#
# 链路：PG + Redis → admin-api(:3105) → executor-node(:8002 注册 online)
#       → scripts/load-test.mjs（tasks/sse/callback 三场景，参数透传）
#
# 用法：
#   bash scripts/load-test-stack.sh                    # docker 一次性 PG/Redis
#   SKIP_DOCKER=1 bash scripts/load-test-stack.sh      # 复用本机已有 PG/Redis
#   # load-test 参数透传追加：
#   bash scripts/load-test-stack.sh --scenario tasks --count 50 --concurrency 20
#
# 设计注记（与 e2e-full.sh 对齐，W-22 起一律真实进程环境）：
#   - 空库全新迁移，任务/执行零残留；客户端限速显式放大（默认
#     LOAD_TEST_MAX_RPM/WRITE_RPM 覆盖 load-test 默认 55/40 的算法限制——
#     load-test 默认值是为回归防爆设计的，容量档位须显式拉开）。
#   - THROTTLE_LIMIT 放大到 10000：容量档位压的是调度/DB 水位，
#     不把 API 限流当瓶颈（服务端限流分域 SEC-09 已有专项测试）。
#   - 全部子进程 exec 化 + trap 清理，不落残留。
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

export no_proxy="localhost,127.0.0.1,::1"
export NO_PROXY="$no_proxy"

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

PG_PORT="${E2E_DB_PORT:-15432}"
REDIS_PORT="${E2E_REDIS_PORT:-16379}"
DB_HOST="${E2E_DB_HOST:-localhost}"
DB_USER="${E2E_DB_USER:-autoflow}"
DB_PASS="${E2E_DB_PASS:-test}"
DB_NAME="${E2E_DB_NAME:-autoflow_loadtest_$(date +%s)}"
REDIS_HOST="${E2E_REDIS_HOST:-localhost}"
REDIS_PASS="${E2E_REDIS_PASS:-}"

PORT_API=3105
PORT_EXECUTOR=8002
EXEC_WORK_DIR="${E2E_WORK_DIR:-/tmp/acf-loadtest-tasks}"
LOG_ROOT="${E2E_LOG_ROOT:-/tmp}"
LOG_DIR="$(mktemp -d "$LOG_ROOT"/acf-loadtest-logs.XXXXXX)"

PG_CONTAINER=acf-lt-pg-$$
REDIS_CONTAINER=acf-lt-redis-$$
DOCKER_MODE=1
[[ "${SKIP_DOCKER:-0}" == "1" ]] && DOCKER_MODE=0

LT_ENV=(
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
  # QA-05：容量档压调度/DB 水位，不把分域限流当瓶颈——三档显式放大
  #（SEC-09 分域矩阵 semantics 不变，仅数值抬升至压测量级）
  "THROTTLE_ENABLED=true"
  "THROTTLE_AUTH_LIMIT=10000"
  "THROTTLE_OPS_LIMIT=10000"
  "METRICS_STREAM_MAX_GLOBAL=${LT_SSE_MAX_GLOBAL:-128}"
)

PIDS=()
cleanup() {
  # 服务端水位采样器（若在跑）先收尾，避免它继续写文件
  if [[ -n "${SAMPLER_PID:-}" ]]; then kill "$SAMPLER_PID" 2>/dev/null || true; fi
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  sleep 1
  for p in "${PIDS[@]:-}"; do kill -9 "$p" 2>/dev/null || true; done
  if [[ "$DOCKER_MODE" == "1" ]]; then
    docker rm -f "$PG_CONTAINER" "$REDIS_CONTAINER" >/dev/null 2>&1 || true
  fi
}

# ── 服务端水位采样（QA-05 §2「资源与观测」）──────────────────────────────
# 客户端报告只是「通过率」，容量白皮书还需要服务端水位。采样列（每 2s）：
#   ts,rss_kb,cpu_avg,pg_conns,redis_clients,pool_active,pool_idle,pool_waiting,
#   elv_lag_s,heap_mb,queue_depth,sched_last_tick_ms
# 数据来源：本地 /proc（RSS/CPU，无需鉴权） + PG psql + redis-cli +
# admin-api 自身 /api/metrics（Prometheus text，需 JWT——采样器自行登录一次）。
# 任一来源不可用时该列写空，不中断采样。
start_server_sampler() { # start_server_sampler <pid> <输出文件>
  local pid="$1" out="$2"
  local api_port="${PORT_API:-3105}"
  (
    local prev_ticks="" prev_ts="" sum_cpu=0 n=0
    local token=""
    for _ in $(seq 1 30); do
      token=$(curl -sf -X POST "http://localhost:$api_port/api/auth/login" \
        -H 'Content-Type: application/json' \
        -d '{"username":"admin","password":"admin123"}' \
        | grep -o '"accessToken":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
      [[ -n "$token" ]] && break
      sleep 1
    done
    local metrics_file="$LOG_DIR/prom-metrics-last.txt"

    while kill -0 "$pid" 2>/dev/null; do
      local rss ticks ts cpu_now pg redis pool_active pool_idle pool_waiting elv heap qdepth stick
      rss=$(awk '/VmRSS/{print $2}' "/proc/$pid/status" 2>/dev/null || echo 0)
      ticks=$(awk '{print $14+$15}' "/proc/$pid/stat" 2>/dev/null || echo "")
      ts=$(date +%s%3N)
      if [[ -n "$prev_ticks" && -n "$ticks" && "$ticks" -ge "$prev_ticks" ]]; then
        local dt_ms=$((ts - prev_ts))
        if [[ $dt_ms -gt 0 ]]; then
          # USER_HZ=100（Linux 默认）：ticks→秒 → CPU% = Δcpu_秒 / Δt
          sum_cpu=$(awk -v s="$sum_cpu" -v d="$((ticks - prev_ticks))" -v dt="$dt_ms" \
            'BEGIN{printf "%.6f", s + (d/100)/(dt/1000)}')
          n=$((n + 1))
        fi
      fi
      prev_ticks="$ticks"; prev_ts="$ts"
      cpu_now=$(awk -v c="$sum_cpu" -v n="$n" 'BEGIN{printf "%.4f", (n>0? c/n:0)}')

      # PG 连接数（本库）
      if [[ "$DOCKER_MODE" == "1" ]]; then
        pg=$(docker exec "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A \
          -c "select count(*) from pg_stat_activity where datname='$DB_NAME'" 2>/dev/null || echo "")
      else
        pg=$(PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$PG_PORT" -U "$DB_USER" -d "$DB_NAME" -t -A \
          -c "select count(*) from pg_stat_activity where datname='$DB_NAME'" 2>/dev/null || echo "")
      fi
      # Redis 连接数
      if [[ "$DOCKER_MODE" == "1" ]]; then
        redis=$(docker exec "$REDIS_CONTAINER" redis-cli info clients 2>/dev/null \
          | awk -F: '/connected_clients/{print $2}' | tr -d '\r' || echo "")
      else
        redis=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ${REDIS_PASS:+-a "$REDIS_PASS"} info clients 2>/dev/null \
          | awk -F: '/connected_clients/{print $2}' | tr -d '\r' || echo "")
      fi
      # admin-api 自身指标（Prometheus text）
      if [[ -n "$token" ]] && curl -sf "http://localhost:$api_port/api/metrics" \
        -H "Authorization: Bearer $token" -o "$metrics_file"; then
        pool_active=$(awk '/^autoflow_db_pool_active_connections/{print $2}' "$metrics_file" | head -1)
        pool_idle=$(awk '/^autoflow_db_pool_idle_connections/{print $2}' "$metrics_file" | head -1)
        pool_waiting=$(awk '/^autoflow_db_pool_waiting_requests/{print $2}' "$metrics_file" | head -1)
        elv=$(awk '/^nodejs_eventloop_lag_seconds/{print $2}' "$metrics_file" | head -1)
        heap=$(awk '/^nodejs_heap_size_used_bytes/{print $2}' "$metrics_file" | head -1)
        qdepth=$(awk '/^autoflow_queue_depth/{print $2}' "$metrics_file" | head -1)
        stick=$(awk '/^autoflow_scheduler_last_tick_duration_ms/{print $2}' "$metrics_file" | head -1)
        [[ -n "$heap" ]] && heap=$(awk -v b="$heap" 'BEGIN{printf "%.1f", b/1048576}')
      fi

      echo "$ts,$rss,$cpu_now,${pg:-},${redis:-},${pool_active:-},${pool_idle:-},${pool_waiting:-},${elv:-},${heap:-},${qdepth:-},${stick:-}" >>"$out"
      sleep 2
    done
  ) &
  SAMPLER_PID=$!
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

echo "══ [1/5] 依赖服务：PG + Redis ══"
if [[ "$DOCKER_MODE" == "1" ]]; then
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
  docker exec "$PG_CONTAINER" psql -U autoflow -d postgres \
    -c "DROP DATABASE IF EXISTS \"$DB_NAME\";" >/dev/null
  docker exec "$PG_CONTAINER" psql -U autoflow -d postgres \
    -c "CREATE DATABASE \"$DB_NAME\";" >/dev/null
  echo "PG/Redis 容器就绪，空库 $DB_NAME 已建"
else
  command -v psql >/dev/null || { echo "SKIP_DOCKER 模式需要 psql 客户端"; exit 1; }
  export PGPASSWORD="$DB_PASS"
  psql -h "$DB_HOST" -p "$PG_PORT" -U "$DB_USER" -d postgres \
    -c "DROP DATABASE IF EXISTS \"$DB_NAME\";" >/dev/null || true
  psql -h "$DB_HOST" -p "$PG_PORT" -U "$DB_USER" -d postgres \
    -c "CREATE DATABASE \"$DB_NAME\";" >/dev/null \
    || fail_with_log "$LOG_DIR/no-pg.log" "建库失败（凭据错误或权限不足）"
  echo "复用本机 PG/Redis，空库 $DB_NAME 已建"
fi

echo "══ [2/5] admin-api 构建 + 空库迁移链 ══"
(
  cd apps/admin-api
  [[ -d node_modules ]] || { echo "admin-api/node_modules 缺失，npm ci"; npm ci; }
  # 产物新鲜度兜底（本轮实测踩到）：nest build 配了 deleteOutDir=true，在带
  # 「批量删除保护」的环境里清理 dist 会被拦，构建**静默失败但退出码 0**，脚本
  # 于是拿旧 dist 继续跑（现象：改了代码，压测/e2e 结果却完全不变）。
  # 先按项目脚本构建（与 CI 一致），再用 tsc 兜底刷一遍（nest-cli.json 无
  # assets，两者产物等价）。
  npm run build >/dev/null || true
  npx tsc -p tsconfig.build.json
  env "${LT_ENV[@]}" npm run migration:run
) >"$LOG_DIR/admin-api-build.log" 2>&1 \
  || fail_with_log "$LOG_DIR/admin-api-build.log" "admin-api 构建/迁移失败"

echo "══ [3/5] 启动 admin-api(:$PORT_API) ══"
(
  cd apps/admin-api
  exec env "${LT_ENV[@]}" PORT=$PORT_API node dist/main.js
) >"$LOG_DIR/admin-api.log" 2>&1 &
PIDS+=($!)
wait_http "http://localhost:$PORT_API/api/health" 60 "admin-api" "$LOG_DIR/admin-api.log"
echo "admin-api /api/health OK"

echo "══ [4/5] 启动 executor-node(:$PORT_EXECUTOR) ══"
(
  cd apps/executor-node
  [[ -d node_modules ]] || { echo "executor-node/node_modules 缺失，npm ci"; npm ci; }
  npm run build >/dev/null
  exec env "${LT_ENV[@]}" \
    APP_NAME=executor-node-loadtest \
    PORT=$PORT_EXECUTOR \
    EXECUTOR_ADDRESS=localhost:$PORT_EXECUTOR \
    ADMIN_API_URL=http://localhost:$PORT_API \
    WORK_DIR=$EXEC_WORK_DIR \
    ${LT_MAX_CONCURRENT:+MAX_CONCURRENT_TASKS=$LT_MAX_CONCURRENT} \
    node dist/main.js
) >"$LOG_DIR/executor-node.log" 2>&1 &
PIDS+=($!)
wait_http "http://localhost:$PORT_EXECUTOR/health" 60 "executor-node" "$LOG_DIR/executor-node.log"
echo "executor-node /health OK"

mkdir -p "$EXEC_WORK_DIR"
REG_OK=0
for _ in $(seq 1 40); do
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
[[ $REG_OK == 1 ]] || fail_with_log "$LOG_DIR/executor-node.log" "执行器 40s 内未注册 online"
echo "executor-node 已注册 online"

echo "══ [5/5] load-test.mjs（参数透传）══"
# 服务端水位采样：admin-api 是 PIDS[0]（先启动）；采样文件随报告一起打印
SERVER_METRICS_FILE="$LOG_DIR/server-metrics.csv"
if [[ -n "${PIDS[0]:-}" ]]; then
  echo "timestamp_ms,rss_kb,avg_cpu_percent" >"$SERVER_METRICS_FILE"
  start_server_sampler "${PIDS[0]}" "$SERVER_METRICS_FILE"
fi
set +e
# 追加默认的容量档位限速（CLI 可覆盖：脚本只透传 "$@" 前先拼默认值，
# 重复参数按 load-test 的后到优先语义覆盖；默认 600/400 远高于回归默认 55/40）
node scripts/load-test.mjs \
  --max-rpm "${LOAD_TEST_MAX_RPM:-600}" \
  --write-rpm "${LOAD_TEST_WRITE_RPM:-400}" \
  --base-url "http://localhost:$PORT_API" \
  --username "${LOAD_TEST_USERNAME:-admin}" \
  --password "${LOAD_TEST_PASSWORD:-admin123}" \
  "$@" >"$LOG_DIR/load-test.log" 2>&1
RC=$?
set -e
echo "── load-test 报告 ──" >&2
cat "$LOG_DIR/load-test.log" >&2 || true

# 服务端水位（等采样器落完最后一次统计）
if [[ -n "${SAMPLER_PID:-}" ]]; then
  kill "$SAMPLER_PID" 2>/dev/null || true
  wait "$SAMPLER_PID" 2>/dev/null || true
  SAMPLER_PID=""
fi
if [[ -f "$SERVER_METRICS_FILE" ]]; then
  # 采样器被 SIGTERM 收尾时来不及打汇总行——直接从 CSV 现算（第 3 列已是全窗口
  # 累计均值，其余列取最大值；空单元格自然被数值比较忽略）。
  echo "── 服务端水位（admin-api，每 2s 采样）──" >&2
  awk -F, 'NR>1 && $2 ~ /^[0-9]+$/ {
      n++;
      if ($2 > maxrss) maxrss = $2;
      lastcpu = $3;
      if ($4+0 > pg) pg = $4+0;
      if ($5+0 > rd) rd = $5+0;
      if ($6+0 > pa) pa = $6+0;
      if ($7+0 > pim) pim = $7+0;
      if ($8+0 > pw) pw = $8+0;
      if ($9+0 > elv) elv = $9+0;
      if ($10+0 > heap) heap = $10+0;
      if ($11+0 > qd) qd = $11+0;
      if ($12+0 > tick) tick = $12+0;
    } END {
      printf "峰值 RSS: %d MB   平均 CPU: %.2f%%（单核）   采样 %d 次\n", maxrss/1024, lastcpu*100, n;
      printf "PG 连接峰值: %d   Redis 连接峰值: %d   DB 连接池 active/idle/waiting 峰值: %d/%d/%d\n", pg, rd, pa, pim, pw;
      printf "事件循环延迟峰值: %.4f s   堆占用峰值: %.1f MB   BullMQ 队列深度峰值: %d   调度 tick 峰值: %.1f ms\n", elv, heap, qd, tick;
    }' "$SERVER_METRICS_FILE" >&2
  echo "（原始采样 CSV：$SERVER_METRICS_FILE） " >&2
fi

if [[ $RC == 0 ]]; then
  echo "✓ load-test 通过（日志目录：$LOG_DIR；压测库：$DB_NAME）"
else
  echo "✗ load-test exit=$RC（日志目录：$LOG_DIR）" >&2
  echo "── admin-api 日志尾部 ──" >&2
  tail -30 "$LOG_DIR/admin-api.log" >&2 || true
  echo "── executor-node 日志尾部 ──" >&2
  tail -30 "$LOG_DIR/executor-node.log" >&2 || true
fi
exit $RC