#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# QA-06 混沌/故障注入演练（docker compose 拓扑，覆盖计划四场景）
#
# 每个场景 = 注入 → 断言 → 恢复 → 二次断言；退出码 = 失败场景数。
#
# 用法：
#   bash scripts/chaos-drill.sh                        # 全部场景（D 自动跳过）
#   bash scripts/chaos-drill.sh --scenario A           # 单场景
#   bash scripts/chaos-drill.sh --scenario a,b         # 逗号组合
#   bash scripts/chaos-drill.sh --scenario B --with-task
#   bash scripts/chaos-drill.sh --scenario B --pause-seconds 30  # 短断网变体
#
# 可覆盖环境变量（默认对齐 docker-compose.yml 服务名与实现缺省值）：
#   CHAOS_API_URL            admin-api 地址（默认 http://localhost:3105）
#   CHAOS_API2_URL           第二 admin 实例地址（场景 C，默认 http://localhost:3106）
#   CHAOS_USERNAME/PASSWORD  管理员凭据（默认 admin / Admin@123456 = compose 缺省）
#   CHAOS_REDIS_CONTAINER / CHAOS_ADMIN_CONTAINER / CHAOS_ADMIN2_CONTAINER /
#   CHAOS_EXECUTOR_CONTAINER 容器名覆盖（缺省按 compose label
#                            com.docker.compose.service 自动发现）
#   CHAOS_PAUSE_SECONDS      场景 B 注入时长（默认 150）
#   CHAOS_OFFLINE_THRESHOLD_SEC  判离线阈值（默认 90 =
#                            EXECUTOR_HEARTBEAT_INTERVAL 30s ×
#                            EXECUTOR_HEARTBEAT_TIMEOUT_MULTIPLIER 3，见
#                            apps/admin-api/src/config/configuration.ts）
#   CHAOS_SCAN_INTERVAL_SEC  markStaleOffline 扫描周期（默认 30s cron）
#   CHAOS_OUTAGE_OBSERVE_SEC 场景 A 停机观察窗（默认 30）
#   CHAOS_RECOVERY_SEC       恢复后二次断言轮询预算（默认 90）
#   CHAOS_LEADER_TTL_MS / CHAOS_LEADER_RETRY_MS   Leader 锁参数（默认
#                            30000 / 15000，对齐 scheduler.service.ts 常量）
#   CHAOS_HTTP_TIMEOUT       单次 curl --max-time（默认 10）
#   CHAOS_LOG_ROOT           日志根目录（默认 /tmp，Git-Bash 约定同 e2e-full.sh）
#
# 设计注记（场景语义已对 apps/admin-api/src 实现核实）：
#   - Redis fail-open：RedisLockService.readyClient 3s 有界等待超时抛错 →
#     SchedulerService.tryAcquireLeadership catch → isLeader=true 降级继续
#     调度（scheduler.service.ts）。注入前已持锁的实例不重复打
#     "degrading to leader" 日志——降级日志仅作 best-effort 观测，硬断言
#     落在 /api/health 存活与恢复后的队列深度回归上。
#   - Leader 锁：SCHEDULER_LEADER_TTL_MS=30s，watchdog 以 TTL/3 续期；
#     非 Leader 每 SCHEDULER_LEADER_RETRY_MS=15s 竞选 → 接管 ≤45s，
#     断言窗口取 TTL+retry+缓冲=60s（chaos_leader_takeover_budget）。
#   - 判离线：executor.service.markStaleOffline 每 30s cron，cutoff =
#     心跳间隔×乘数=90s → 场景 B 注入时长默认 150s（30s 短断网在阈值内，
#     走「不误判离线」反向断言）。
#   - 容器操作只 stop/pause/restart/start/unpause，绝不 rm——对象是用户的
#     compose 容器；trap（含 Ctrl-C）只做逆操作还原注入前状态。
#   - 本机无 docker 时无法真跑：纯函数自检见 scripts/chaos-drill.selftest.sh
#     （bash -n + library 模式 source 断言），真机确认边界见
#     docs/operations.md「混沌演练」。
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

# 本机代理会把 localhost 的 curl 打到远程代理（对齐 e2e-full.sh 同款绕过）
export no_proxy="localhost,127.0.0.1,::1"
export NO_PROXY="$no_proxy"

# ---------------------------------------------------------------------------
# 纯函数区（scripts/chaos-drill.selftest.sh 以 CHAOS_DRILL_LIBRARY=1 source
# 本文件后逐个断言；不得引用 docker/curl/LOG_DIR 等运行时状态）
# ---------------------------------------------------------------------------

# 场景名解析：<csv> → 规范化 "a b c ..."；all 展开四场景；去重保序；
# 非法名或解析结果为空 → rc=1；空串/缺参 → 默认 all。
chaos_normalize_scenarios() {
  local raw="${1:-all}" out="" p want
  raw="${raw,,}"
  raw="${raw//[[:space:]]/}"
  IFS=',' read -ra parts <<< "$raw"
  for p in "${parts[@]}"; do
    [[ -n "$p" ]] || continue
    if [[ "$p" == "all" ]]; then
      out="$out a b c d"
      continue
    fi
    case "$p" in
      a|b|c|d) out="$out $p" ;;
      *) return 1 ;;
    esac
  done
  local uniq=""
  for want in $out; do
    case " $uniq " in *" $want "*) ;; *) uniq="$uniq $want" ;; esac
  done
  uniq="${uniq# }"
  printf '%s\n' "$uniq"
  [[ -n "$uniq" ]]
}

# 每场景独立日志路径：<log_dir> <场景字母(大小写均可)> → "<dir>/scenario-<s>.log"
chaos_log_path() {
  local dir="${1%/}" s="${2,,}"
  case "$s" in a|b|c|d) ;; *) return 1 ;; esac
  printf '%s/scenario-%s.log\n' "$dir" "$s"
}

# B 场景离线断言轮询预算（秒）：注入时长 ≥ 判离线阈值 → 阈值+扫描周期+缓冲
# （离线最迟在 cutoff=阈值后的下一个扫描 tick 被观测到）；短断网 → 0，
# 调用方改走「不误判离线」反向断言。
chaos_offline_poll_budget() { # <pause_sec> <threshold_sec> <scan_sec> <buffer_sec>
  if (( $1 >= $2 )); then echo $(( $2 + $3 + $4 )); else echo 0; fi
}

# B 场景注入时长是否足以触发判离线（rc0=是）
chaos_pause_is_long_enough() { # <pause_sec> <threshold_sec>
  (( $1 >= $2 ))
}

# C 场景 Leader 接管断言窗口（秒；毫秒入参向上取整）：
# 锁 TTL 自然过期 + 一次竞选重试 + 观测缓冲。
chaos_leader_takeover_budget() { # <ttl_ms> <retry_ms> <buffer_ms>
  local total=$(( $1 + $2 + $3 ))
  echo $(( (total + 999) / 1000 ))
}

# 从 JSON 文本提取首个 "key":<int> 的整数值；缺失输出空串。
# 有意不用 jq（宿主机不保证安装；对齐 e2e-full.sh 的 grep -o 取值风格）。
chaos_extract_json_int() { # <json> <key>
  local m
  m="$(printf '%s' "$1" | grep -m1 -o "\"$2\"[[:space:]]*:[[:space:]]*[0-9][0-9]*" || true)"
  if [[ -n "$m" ]]; then
    printf '%s\n' "$m" | grep -o '[0-9][0-9]*$' || true
  fi
}

# JSON 文本是否包含固定子串（rc0=包含）
chaos_json_has() { # <json> <needle>
  printf '%s' "$1" | grep -qF -- "$2"
}

# ---------------------------------------------------------------------------
# 运行时状态（main 内初始化；纯函数不得触碰）
# ---------------------------------------------------------------------------
API_URL=""; API2_URL=""
REDIS_C=""; ADMIN_C=""; ADMIN2_C=""; EXECUTOR_C=""
TOKEN=""
PAUSE_SECONDS=150
OFFLINE_THRESHOLD_SEC=90
SCAN_INTERVAL_SEC=30
OUTAGE_OBSERVE_SEC=30
RECOVERY_SEC=90
LEADER_TTL_MS=30000
LEADER_RETRY_MS=15000
HTTP_TIMEOUT=10
WITH_TASK=0
LOG_DIR=""
PASSED=0
FAILED=0
SKIPPED=0
SCENARIO_FAILED=0
SCENARIO_SKIPPED=0
RESTORE_START=()    # 被 stop 过、退出时需 docker start 还原的容器
RESTORE_UNPAUSE=()  # 被 pause 过、退出时需 docker unpause 还原的容器

log()  { echo "[chaos] $*"; }
warn() { echo "[chaos] WARN: $*" >&2; }

# 场景结果落账（不退出，让后续场景继续跑；总退出码=失败场景数）
fail_scenario() { echo "✗ 场景 ${1^^} 失败：$2" >&2; FAILED=$((FAILED + 1)); SCENARIO_FAILED=1; }
pass_scenario() { echo "✓ 场景 ${1^^} 通过"; PASSED=$((PASSED + 1)); }
skip_scenario() { echo "- 场景 ${1^^} 跳过：$2"; SKIPPED=$((SKIPPED + 1)); SCENARIO_SKIPPED=1; }

http_get() { # <url> → body 输出；仅 2xx rc0
  curl -sf --max-time "$HTTP_TIMEOUT" "$1"
}

# 登录取 JWT（对齐 e2e-full.sh 的 grep 取 token 风格；调用方检查 rc）
login() {
  TOKEN="$(curl -sf --max-time "$HTTP_TIMEOUT" -X POST "$API_URL/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"${CHAOS_USERNAME:-admin}\",\"password\":\"${CHAOS_PASSWORD:-Admin@123456}\"}" \
    | grep -o '"accessToken":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
  [[ -n "$TOKEN" ]]
}

# 按 compose service label 发现容器名；显式覆盖名（$2）优先生效
discover_container() { # <label值> <覆盖名(可为空)> <用途说明>
  if [[ -n "${2:-}" ]]; then
    if docker inspect "$2" >/dev/null 2>&1; then
      echo "$2"
      return 0
    fi
    warn "覆盖容器 $2 不存在（$3）"
    return 1
  fi
  local name
  name="$(docker ps --filter "label=com.docker.compose.service=$1" \
    --format '{{.Names}}' | head -1 || true)"
  if [[ -z "$name" ]]; then
    warn "未发现 compose service=$1 容器（$3）；可用环境变量覆盖容器名"
    return 1
  fi
  echo "$name"
}

mark_stopped()  { RESTORE_START+=("$1"); docker stop "$1" >/dev/null; }
mark_unpaused() { RESTORE_UNPAUSE+=("$1"); docker pause "$1" >/dev/null; }

restore_containers() { # 只做逆操作还原，绝不 rm（对象是用户的 compose 容器）
  local c
  for c in "${RESTORE_UNPAUSE[@]:-}"; do
    [[ -n "$c" ]] && docker unpause "$c" >/dev/null 2>&1 || true
  done
  for c in "${RESTORE_START[@]:-}"; do
    [[ -n "$c" ]] && docker start "$c" >/dev/null 2>&1 || true
  done
}

wait_redis_ping() { # <容器> <超时秒>
  local deadline=$(( SECONDS + $2 ))
  while (( SECONDS < deadline )); do
    docker exec "$1" redis-cli ping 2>/dev/null | grep -q PONG && return 0
    sleep 2
  done
  return 1
}

leader_lock_exists() { # rc0 = scheduler:leader 锁在 Redis 中存在
  [[ -n "$REDIS_C" ]] \
    && docker exec "$REDIS_C" redis-cli --raw EXISTS "lock:scheduler:leader" 2>/dev/null \
      | grep -q '^1$'
}

leader_takeover_observed() { # <since时长如10m> <容器...> 任一容器新日志含接管日志
  local since="$1"; shift
  local c
  for c in "$@"; do
    [[ -n "$c" ]] || continue
    docker logs "$c" --since "$since" 2>&1 | grep -q "leadership acquired" && return 0
  done
  return 1
}

# ---------------------------------------------------------------------------
# 场景 A：Redis 宕机 → /api/health 存活（fail-open 路径可观测）→ 恢复 →
# 队列深度 series 回归
# ---------------------------------------------------------------------------
scenario_a_body() {
  local body queue0 seen i q svc q_ok healthy
  body="$(http_get "$API_URL/api/health" || true)"
  chaos_json_has "$body" '"status"' \
    || { fail_scenario a "注入前 /api/health 即不可用，基线不成立"; return; }
  queue0="$(chaos_extract_json_int "$(http_get "$API_URL/api/health/metrics" || true)" queueSize)"
  log "[A] 基线 /api/health 200，queueSize=${queue0:-n/a}"

  log "[A] 注入：docker stop $REDIS_C"
  if ! mark_stopped "$REDIS_C"; then
    fail_scenario a "docker stop $REDIS_C 失败"; return
  fi

  # 断言 A1：观察窗内 /api/health 至少一次 200（进程存活、fail-open 不停摆）。
  # 诚实注记：HealthService 各检查自行 catch，Redis 宕机不应 5xx；但 BullMQ
  # 连接可能拖慢单次响应——窗口内取到一次 200 即判存活，完整响应（含 redis
  # 组件 unhealthy 详情）落场景日志供真机复核。
  seen=0
  for ((i = 0; i < OUTAGE_OBSERVE_SEC; i += 5)); do
    body="$(http_get "$API_URL/api/health" || true)"
    if chaos_json_has "$body" '"status"'; then
      seen=1
      echo "$body" >>"${CHAOS_SCENARIO_LOG:-/dev/null}"
      break
    fi
    sleep 5
  done
  if (( seen == 1 )); then
    log "[A] 断言 A1 通过：Redis 停机期间 /api/health 存活（响应落日志）"
  else
    fail_scenario a "A1 Redis 停机 ${OUTAGE_OBSERVE_SEC}s 内 /api/health 无一次 200"
  fi

  # 断言 A2（fail-open 可观测）：admin 日志必现 "Redis connection error"
  # （RedisLockService 的 ioredis error 钩子）；"degrading to leader" 仅当
  # 注入前该实例非 Leader 才出现（已持锁实例保持 isLeader=true 继续调度，
  # 语义即 fail-open）——降级日志缺失不算失败，落日志供真机复核。
  if [[ -n "$ADMIN_C" ]] \
    && docker logs "$ADMIN_C" --since "${OUTAGE_OBSERVE_SEC}s" 2>&1 \
      | grep -q "Redis connection error"; then
    log "[A] 断言 A2 通过：admin 日志观测到 Redis connection error（锁客户端感知故障）"
  else
    warn "[A] A2 未观测到 Redis connection error（无本地 admin 容器或日志未及刷新）——真机确认项"
  fi
  if [[ -n "$ADMIN_C" ]]; then
    docker logs "$ADMIN_C" --since "$((OUTAGE_OBSERVE_SEC + 30))s" 2>&1 \
      | grep -m1 "degrading to leader" >>"${CHAOS_SCENARIO_LOG:-/dev/null}" 2>/dev/null \
      || log "[A] 观测：注入前已持锁的实例不重复打 degrading 日志（fail-open 语义=保持 isLeader）——真机确认项"
  fi

  # 恢复
  log "[A] 恢复：docker start $REDIS_C"
  if ! docker start "$REDIS_C" >/dev/null; then
    fail_scenario a "docker start $REDIS_C 失败（请手工恢复）"; return
  fi
  if wait_redis_ping "$REDIS_C" 30; then
    log "[A] redis-cli PONG（Redis 已恢复）"
  else
    fail_scenario a "Redis 启动后 30s 无 PONG"; return
  fi

  # 二次断言 A3（队列深度 series 回归）：/api/health/metrics 的 queueSize
  # 恢复为可读数字，且 /api/health/services 的 queue 组件回到 healthy
  # （BullMQ 重连成功、getWaitingCount 可用）。
  q_ok=0; healthy=0
  for ((i = 0; i < RECOVERY_SEC; i += 5)); do
    body="$(http_get "$API_URL/api/health/metrics" || true)"
    q="$(chaos_extract_json_int "$body" queueSize)"
    [[ -n "$q" ]] && q_ok=1
    svc="$(http_get "$API_URL/api/health/services" || true)"
    chaos_json_has "$svc" '"queue":{"status":"healthy"' && healthy=1
    (( q_ok == 1 && healthy == 1 )) && break
    sleep 5
  done
  if (( q_ok == 1 )); then
    log "[A] 断言 A3a 通过：恢复后 queueSize series 可读（基线 ${queue0:-n/a}）"
  else
    fail_scenario a "A3a 恢复后 ${RECOVERY_SEC}s 内 queueSize 仍不可读（BullMQ 未重连？）"
  fi
  if (( healthy == 1 )); then
    log "[A] 断言 A3b 通过：queue 组件 status=healthy"
  else
    fail_scenario a "A3b 恢复后 ${RECOVERY_SEC}s 内 queue 组件未回到 healthy"
  fi
}

# ---------------------------------------------------------------------------
# 场景 B：执行器断网（pause 容器冻结进程 → 心跳停止）→ 判离线 → 恢复 online
# →（可选 --with-task）创建任务确认可派发
# ---------------------------------------------------------------------------
scenario_b_body() {
  local body online0 total0 i q budget went_offline q2 back
  login || { fail_scenario b "登录失败（凭据或 THROTTLE 限流）"; return; }
  body="$(http_get "$API_URL/api/health/metrics" || true)"
  online0="$(chaos_extract_json_int "$body" onlineExecutors)"
  total0="$(chaos_extract_json_int "$body" totalExecutors)"
  if [[ -z "$online0" || "$online0" -lt 1 ]]; then
    skip_scenario b "无 online 执行器（onlineExecutors=${online0:-n/a}），先启动执行器再演练"
    return
  fi
  log "[B] 基线 online=${online0}/${total0:-?}；注入 pause ${PAUSE_SECONDS}s（判离线阈值 ${OFFLINE_THRESHOLD_SEC}s = 心跳30s×乘数3，扫描周期 ${SCAN_INTERVAL_SEC}s）"

  log "[B] 注入：docker pause $EXECUTOR_C（进程冻结，心跳停止）"
  if ! mark_unpaused "$EXECUTOR_C"; then
    fail_scenario b "docker pause $EXECUTOR_C 失败"; return
  fi

  went_offline=0
  if [[ "$(chaos_pause_is_long_enough "$PAUSE_SECONDS" "$OFFLINE_THRESHOLD_SEC" && echo long || echo short)" == "long" ]]; then
    # 断言 B1：预算窗（阈值+扫描+缓冲，chaos_offline_poll_budget 对齐实现
    # 参数）内 onlineExecutors < 基线 → markStaleOffline 判离线
    budget="$(chaos_offline_poll_budget "$PAUSE_SECONDS" "$OFFLINE_THRESHOLD_SEC" "$SCAN_INTERVAL_SEC" 30)"
    log "[B] 断言窗口 ${budget}s（阈值${OFFLINE_THRESHOLD_SEC}+扫描${SCAN_INTERVAL_SEC}+缓冲30）"
    for ((i = 0; i < budget; i += 10)); do
      body="$(http_get "$API_URL/api/health/metrics" || true)"
      q="$(chaos_extract_json_int "$body" onlineExecutors)"
      if [[ -n "$q" && "$q" -lt "$online0" ]]; then went_offline=1; break; fi
      sleep 10
    done
    if (( went_offline == 1 )); then
      log "[B] 断言 B1 通过：${i}s 内观测到判离线（onlineExecutors ${online0}→${q}）"
    else
      fail_scenario b "B1 注入后 ${budget}s 未见判离线（阈值语义漂移？）"
    fi
  else
    # 短断网变体（--pause-seconds < 90）：阈值内不判离线 → 反向断言
    log "[B] 短断网变体：pause ${PAUSE_SECONDS}s < 阈值 ${OFFLINE_THRESHOLD_SEC}s，按实现不应判离线"
    sleep "$PAUSE_SECONDS"
    body="$(http_get "$API_URL/api/health/metrics" || true)"
    q="$(chaos_extract_json_int "$body" onlineExecutors)"
    if [[ -n "$q" && "$q" -eq "$online0" ]]; then
      log "[B] 断言 B1' 通过：短断网未误判离线（onlineExecutors 保持 ${q}）"
    else
      fail_scenario b "B1' 短断网 ${PAUSE_SECONDS}s 内执行器被判离线（online=${q:-n/a}，基线 ${online0}）——阈值语义漂移？"
    fi
  fi

  log "[B] 恢复：docker unpause $EXECUTOR_C"
  if ! docker unpause "$EXECUTOR_C" >/dev/null 2>&1; then
    fail_scenario b "docker unpause $EXECUTOR_C 失败（请手工恢复）"; return
  fi

  # 二次断言 B2：心跳恢复（executor-node 默认 30s 心跳）→ online 回归基线
  back=0
  for ((i = 0; i < RECOVERY_SEC; i += 10)); do
    body="$(http_get "$API_URL/api/health/metrics" || true)"
    q2="$(chaos_extract_json_int "$body" onlineExecutors)"
    if [[ -n "$q2" && "$q2" -ge "$online0" ]]; then back=1; break; fi
    sleep 10
  done
  if (( back == 1 )); then
    log "[B] 断言 B2 通过：恢复后 ${i}s 内 online 回归（onlineExecutors=${q2}）"
  else
    fail_scenario b "B2 恢复后 ${RECOVERY_SEC}s 内 onlineExecutors 未回归基线 ${online0}"
  fi

  # 可选断言 B3：创建并触发任务，确认恢复后可派发执行（默认 120s 终态窗）
  if (( WITH_TASK == 1 )) && (( back == 1 )); then
    local tname payload task_id exec_body exec_ok
    tname="chaos-drill-b-$(date +%s)"
    payload="$(printf '{"name":"%s","triggerType":"manual","runtime":"node","glueLanguage":"javascript","glueSource":"console.log(1+1)","timeoutSeconds":60,"maxRetry":0,"status":"active"}' "$tname")"
    log "[B] --with-task：创建任务 $tname 并触发"
    task_id="$(curl -sf --max-time "$HTTP_TIMEOUT" -X POST "$API_URL/api/tasks" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -d "$payload" | grep -m1 -o '"id":"[^"]*"' | cut -d'"' -f4 || true)"
    if [[ -z "$task_id" ]]; then
      fail_scenario b "B3 任务创建失败"; return
    fi
    curl -sf --max-time "$HTTP_TIMEOUT" -X POST "$API_URL/api/tasks/$task_id/trigger" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' >/dev/null \
      || fail_scenario b "B3 任务触发失败（task=$task_id）"
    exec_ok=0
    for ((i = 0; i < 120; i += 10)); do
      exec_body="$(curl -sf --max-time "$HTTP_TIMEOUT" \
        "$API_URL/api/tasks/$task_id/executions?page=1&pageSize=50" \
        -H "Authorization: Bearer $TOKEN" || true)"
      if chaos_json_has "$exec_body" '"status":"success"'; then exec_ok=1; break; fi
      sleep 10
    done
    if (( exec_ok == 1 )); then
      log "[B] 断言 B3 通过：恢复后任务派发执行成功（task=$task_id）"
    else
      fail_scenario b "B3 120s 内执行未达 success（task=$task_id）"
    fi
    curl -sf --max-time "$HTTP_TIMEOUT" -X DELETE "$API_URL/api/tasks/$task_id" \
      -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1 \
      || warn "[B] 清理任务 $task_id 失败（软删留档，可手工删除）"
  fi
}

# ---------------------------------------------------------------------------
# 场景 C：admin 双实例滚动重启 → 任一时刻 /api/health 可用 + Leader 锁接管
# （接管窗口对齐锁 TTL：chaos_leader_takeover_budget = TTL 30s + 竞选重试
#   15s + 缓冲 15s = 60s；watchdog 随重启进程消失，锁 ≤TTL 自然过期后由
#   幸存实例按 15s 竞选周期接管，日志锚点 "leadership acquired"）
# ---------------------------------------------------------------------------
scenario_c_body() {
  local -a admins=()
  if [[ -n "$ADMIN_C" && -n "$ADMIN2_C" ]]; then
    admins=("$ADMIN_C" "$ADMIN2_C")
  else
    local n
    while IFS= read -r n; do admins+=("$n"); done < <(
      docker ps --filter "label=com.docker.compose.service=admin-api" \
        --format '{{.Names}}' | sort || true)
  fi
  if (( ${#admins[@]} < 2 )); then
    skip_scenario c "admin 实例数 ${#admins[@]} < 2（发现：${admins[*]:-无}）——双实例拓扑搭建方法见 docs/operations.md「混沌演练」，或设 CHAOS_ADMIN_CONTAINER/CHAOS_ADMIN2_CONTAINER"
    return
  fi
  local pri="${admins[0]}" sec="${admins[1]}"
  log "[C] 双实例：primary=$pri（$API_URL）/ secondary=$sec（$API2_URL）"

  local body
  http_get "$API_URL/api/health" | grep -q '"status"' \
    || { fail_scenario c "注入前 $API_URL/api/health 不可用"; return; }
  local lock_held=0
  if leader_lock_exists; then
    lock_held=1
    log "[C] Leader 锁在 Redis（PTTL $(docker exec "$REDIS_C" redis-cli --raw PTTL lock:scheduler:leader 2>/dev/null || echo '?')ms）——重启后将断言锁接管"
  else
    warn "[C] Leader 锁不在 Redis（实例可能处于 fail-open 降级，锁不在 Redis 无从接管）——接管断言降级为观测项"
  fi

  local takeover_budget
  takeover_budget="$(chaos_leader_takeover_budget "$LEADER_TTL_MS" "$LEADER_RETRY_MS" 15000)"
  local health_ok=1 miss=0 sec_back=0 pri_back=0 up i

  # 步骤 1：重启 secondary——primary 全程对外，任一时刻 $API_URL 必须 200
  log "[C] 滚动重启 1/2：docker restart $sec"
  if ! docker restart "$sec" >/dev/null; then
    fail_scenario c "docker restart $sec 失败"; return
  fi
  for ((i = 0; i < 90; i += 5)); do
    if http_get "$API_URL/api/health" | grep -q '"status"'; then miss=0; else
      miss=$((miss + 1)); (( miss >= 2 )) && health_ok=0
    fi
    if http_get "$API2_URL/api/health" | grep -q '"status"'; then sec_back=1; break; fi
    sleep 5
  done
  (( sec_back == 1 )) || fail_scenario c "C1b secondary 重启后 90s 未在 $API2_URL 恢复 200"

  # 步骤 2：重启 primary——secondary 顶住；每一轮轮询两地址任一 200 即可
  #（允许连续 1 次瞬时抖动）；接管观测窗自本步起算 takeover_budget 秒
  log "[C] 滚动重启 2/2：docker restart $pri（接管观测窗 ${takeover_budget}s）"
  if ! docker restart "$pri" >/dev/null; then
    fail_scenario c "docker restart $pri 失败"; return
  fi
  for ((i = 0; i < 120; i += 3)); do
    up=0
    if http_get "$API_URL/api/health" | grep -q '"status"'; then up=1; pri_back=1; fi
    if http_get "$API2_URL/api/health" | grep -q '"status"'; then up=1; fi
    if (( up == 1 )); then miss=0; else
      miss=$((miss + 1)); (( miss >= 2 )) && health_ok=0
    fi
    (( pri_back == 1 && i >= takeover_budget )) && break
    sleep 3
  done
  (( pri_back == 1 )) || fail_scenario c "C1c primary 重启后 120s 未恢复 200"

  if (( health_ok == 1 )); then
    log "[C] 断言 C1 通过：滚动重启全程任一时刻 /api/health 可用（允许 1 次瞬时抖动）"
  else
    fail_scenario c "C1 滚动重启期间出现连续 2 轮双地址均不可达"
  fi

  # 断言 C2：锁持有前提下，滚动重启全程必现一次锁易主（primary 持锁→步骤 2
  # 孤儿锁由 secondary 接管；secondary 持锁→步骤 1 已触发 primary 接管），
  # 日志锚点 "Scheduler leadership acquired"
  if (( lock_held == 1 )); then
    if leader_takeover_observed 10m "$pri" "$sec"; then
      log "[C] 断言 C2 通过：观测到 Leader 锁接管（leadership acquired）"
    else
      fail_scenario c "C2 锁持有前提下全程未见 leadership acquired（窗口 ${takeover_budget}s/步，--since 10m 覆盖全程）"
    fi
  else
    log "[C] 观测：注入前锁不在 Redis（fail-open 降级），接管日志断言不适用——真机确认项"
  fi

  # 二次断言 C3：双实例同时恢复 200
  local both=0
  for ((i = 0; i < 30; i += 3)); do
    if http_get "$API_URL/api/health" | grep -q '"status"' \
      && http_get "$API2_URL/api/health" | grep -q '"status"'; then
      both=1; break
    fi
    sleep 3
  done
  if (( both == 1 )); then
    log "[C] 断言 C3 通过：双实例均恢复 200"
  else
    fail_scenario c "C3 滚动重启完成后 30s 内未双实例同时 200"
  fi
}

# ---------------------------------------------------------------------------
# 场景 D：PG 主从切换（本机 compose 单主无从库——TODO 骨架 + 诚实跳过）
# ---------------------------------------------------------------------------
scenario_d_body() {
  # TODO(QA-06 真机拓扑)：docker-compose.yml 仅单主 postgres，无从库可注入/
  # 提升——以下骨架待真机 PG 主从拓扑落地后补齐：
  #   1) 前置：从库 SELECT pg_is_in_recovery(); → t，且主库
  #      pg_stat_replication 有活跃复制流；
  #   2) 注入：docker stop <主库容器>（写路径立即中断）；
  #   3) 提升：从库 SELECT pg_promote();（PG13+；Patroni/repmgr 亦同窗）；
  #   4) 断言：admin-api DB 检查转 unhealthy（/api/health/services.database）；
  #      提升后写路径恢复（POST /api/tasks → 201；受 TypeORM
  #      retryAttempts 重连退避影响，写恢复窗口建议 ≤120s）；
  #   5) 恢复：旧主 pg_rewind / 全量重建后以从库身份 rejoin；
  #      二次断言：pg_stat_replication 复制流回归 + /api/health 恢复 healthy。
  skip_scenario d "本机 compose 无 PG 从库（单主拓扑），无从库可提升——需真机主从拓扑后按本函数 TODO 骨架补齐（已知边界见 docs/operations.md「混沌演练」）"
}

# ---------------------------------------------------------------------------
# 场景调度
# ---------------------------------------------------------------------------
run_scenario() { # <场景字母（已规范化，小写）>
  local s="$1" slog
  slog="$(chaos_log_path "$LOG_DIR" "$s")" || { warn "非法场景 $s"; return; }
  export CHAOS_SCENARIO_LOG="$slog"
  : >"$slog"
  SCENARIO_FAILED=0; SCENARIO_SKIPPED=0
  echo "════ 场景 ${s^^} 开始（$(date '+%F %T')，日志 $slog）════"
  "scenario_${s}_body" 2>&1 | tee -a "$slog" || true
  if (( SCENARIO_SKIPPED == 1 )); then
    :  # skip_scenario 已输出说明
  elif (( SCENARIO_FAILED == 0 )); then
    pass_scenario "$s"
  fi
  unset CHAOS_SCENARIO_LOG
}

print_usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

main() {
  local scenarios="all"
  while (( $# > 0 )); do
    case "$1" in
      --scenario) scenarios="${2:-}"; shift 2 ;;
      --pause-seconds) PAUSE_SECONDS="${2:-}"; shift 2 ;;
      --with-task) WITH_TASK=1; shift ;;
      --help|-h) print_usage; exit 0 ;;
      *) echo "未知参数: $1（--help 查看用法）" >&2; exit 2 ;;
    esac
  done
  [[ "$PAUSE_SECONDS" =~ ^[0-9]+$ ]] \
    || { echo "--pause-seconds 需为非负整数" >&2; exit 2; }
  local norm
  norm="$(chaos_normalize_scenarios "$scenarios")" \
    || { echo "非法场景列表: $scenarios（合法 a|b|c|d|all）" >&2; exit 2; }
  local -a scenario_list
  read -ra scenario_list <<< "$norm"

  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  command -v docker >/dev/null || { echo "需要 docker CLI" >&2; exit 2; }
  docker info >/dev/null 2>&1 || { echo "docker daemon 不可达" >&2; exit 2; }

  API_URL="${CHAOS_API_URL:-http://localhost:3105}"
  API2_URL="${CHAOS_API2_URL:-http://localhost:3106}"
  OFFLINE_THRESHOLD_SEC="${CHAOS_OFFLINE_THRESHOLD_SEC:-90}"
  SCAN_INTERVAL_SEC="${CHAOS_SCAN_INTERVAL_SEC:-30}"
  OUTAGE_OBSERVE_SEC="${CHAOS_OUTAGE_OBSERVE_SEC:-30}"
  RECOVERY_SEC="${CHAOS_RECOVERY_SEC:-90}"
  LEADER_TTL_MS="${CHAOS_LEADER_TTL_MS:-30000}"
  LEADER_RETRY_MS="${CHAOS_LEADER_RETRY_MS:-15000}"
  HTTP_TIMEOUT="${CHAOS_HTTP_TIMEOUT:-10}"
  LOG_DIR="$(mktemp -d "${CHAOS_LOG_ROOT:-/tmp}"/acf-chaos-logs.XXXXXX)"
  trap restore_containers EXIT
  trap 'restore_containers; exit 130' INT TERM

  # 容器发现（只读操作；单容器服务缺失由各场景自行降级/跳过）
  REDIS_C="$(discover_container redis "${CHAOS_REDIS_CONTAINER:-}" "场景 A 恢复验证" || true)"
  EXECUTOR_C="$(discover_container executor-node "${CHAOS_EXECUTOR_CONTAINER:-}" "场景 B" || true)"
  ADMIN_C="$(discover_container admin-api "${CHAOS_ADMIN_CONTAINER:-}" "场景 A/C 日志观测" || true)"
  ADMIN2_C="${CHAOS_ADMIN2_CONTAINER:-}"

  echo "══ AutoFlow 混沌演练 ══"
  echo "  目标: $API_URL（第二实例 $API2_URL）  场景: ${scenario_list[*]}"
  echo "  redis=$REDIS_C  admin=$ADMIN_C  executor=$EXECUTOR_C"
  echo "  pause=${PAUSE_SECONDS}s 阈值=${OFFLINE_THRESHOLD_SEC}s 扫描=${SCAN_INTERVAL_SEC}s 日志: $LOG_DIR"

  http_get "$API_URL/api/health" | grep -q '"status"' || {
    if [[ "$norm" == "d" ]]; then
      warn "admin-api 不可达——场景 D 仅需真机拓扑，继续（将跳过）"
    else
      echo "✗ admin-api $API_URL/api/health 不可达——混沌演练针对在跑栈，请先 docker compose up -d" >&2
      exit 2
    fi
  }

  local s
  for s in "${scenario_list[@]}"; do
    run_scenario "$s"
  done

  restore_containers
  echo ""
  echo "══ 混沌演练结束：通过 $PASSED / 失败 $FAILED / 跳过 $SKIPPED（日志：$LOG_DIR）══"
  exit "$FAILED"
}

# library 模式（selftest source 本文件）只暴露纯函数，不执行 main
if [[ "${CHAOS_DRILL_LIBRARY:-0}" != "1" ]]; then
  main "$@"
fi
