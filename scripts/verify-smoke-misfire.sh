#!/usr/bin/env bash
#
# verify-smoke-misfire.sh —— 场景 3：A6「补偿窗口起点收紧到最近错失落点」
# + 「抑制可观测（warn 级 + 按任务 30 分钟限流）」的真链路验证。
#
# ## 被验语义（A6，commit 230e3b54）
#
# 补偿链的**闸 3**（"窗口内已有执行 ⇒ 不补偿"）的窗口起点：
#   · A6 **前**：= lastTriggerTime（最近一次**定时**触发时刻）
#     ⇒ 进入补偿的前提是 gap > 2×周期 ⇒ 窗口天然可长达数天
#     ⇒ "过去 N 天内这任务跑过**任意一次**"就被判成"已覆盖"
#     ⇒ 真正漏掉的计划落点被静默吞掉（且改前只有 debug 日志，生产不可见）。
#   · A6 **后**：= **最近一个被错失的计划落点**（cron 反查闸 2 的同一份结果）
#     ⇒ 语义变成"**这个**落点已被执行"，而不是"窗口内任意执行"。
#
# ## 本脚本验三件事
#
#   ① **不吞点**：漏掉落点之前的**无关执行**（落在落点之前）**不得**阻止补偿
#      ⇒ 补偿必须真的发生（产生 triggerType='misfire' 的执行行）
#   ② **warn 级可见**：闸 3 真命中（落点确实已被执行覆盖）时，必须出
#      **warn** 级日志（不是 debug）
#   ③ **限流**：同一任务 30 分钟内**不得**重复刷 warn（第二次退回 debug）
#
# ## 三个必须注意的时区/时序陷阱（本脚本踩过）
#
#   ① **宿主时区 ≠ 容器/PG 时区**：宿主是 CST(UTC+8)，admin-api 容器与 PG 是
#      UTC。`timestamp without time zone` 列里若写宿主墙钟时间，会比应用
#      看到的 now **早 8 小时**（=未来）⇒ `gap > threshold` 恒不成立 ⇒
#      补偿根本不触发（假 FAIL）。⇒ 本脚本的所有时间戳**一律用 DB 侧
#      `now()` 算**，绝不用宿主 `date`。
#   ② **cron 表达式选 `0 3 * * *`（每日 03:00）而不是 `0 * * * *`**：
#      小时级 cron 的"最近一个错失落点"会**随小时滚动**，测试跨越整点时
#      窗口起点会变 ⇒ 既可能假 FAIL 也可能测不到限流。日级 cron 的错失落点
#      在一整天内**恒定**，两个场景（首扫 + 限流复扫）窗口一致 ⇒ 稳定可测。
#   ③ **限流表在内存里**（`misfireSuppressWarnAt` Map）⇒ **重启会清空它** ⇒
#      限流那一轮**绝不能重启**，必须等自然 tick（@Cron("0 */5 * * * *")）。
#
# 用法：./scripts/verify-smoke-misfire.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${ACF_SMOKE_ENV_FILE:-/tmp/acf-smoke-env.sh}"
[[ -f "$ENV_FILE" ]] || { echo "✗ $ENV_FILE not found — run scripts/verify-smoke-stack.sh up first" >&2; exit 2; }
# shellcheck disable=SC1090
source "$ENV_FILE"
# shellcheck disable=SC1091
source "$ROOT/scripts/verify-smoke-common.sh"

PASS=0; FAIL=0
ok()  { printf '  ✓ %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  ✗ %s\n' "$*"; FAIL=$((FAIL+1)); }
step(){ printf '\n=== %s ===\n' "$*"; }

API="http://127.0.0.1:${SMOKE_API_PORT}/api"

# ── 跑前清理（幂等的前提）───────────────────────────────────────────────
# 本脚本造的行：tasks(name ∈ {smoke-misfire-c, smoke-misfire-d}) +
# 它们的 task_executions（含手工 insert_exec 造的"无关执行"）+
# execution_log_lines + task.* 审计行。
#
# ⚠️ **为什么必须"跑前"**：本脚本步骤 2 会 **restart admin-api**、步骤 5 会
#   **等自然 tick（最长 5 分钟）** ⇒ 中途失败/被 Ctrl-C 的概率不低 ⇒ 残留
#   smoke-misfire-c/d 两个任务（名字唯一 ⇒ 二次跑**步骤 0 建任务就失败**）。
#   ⇒ 跑**开始时**按前缀清干净并验证计数 = 0 ⇒ 上次失败能被下次自动修复。
#
# ⚠️ 清理**只删本前缀**：绝不 `DELETE FROM tasks`。
step "0a. 跑前清理（只删本脚本自己造的 smoke-misfire-* 数据）"
if smoke_preclean_tasks "smoke-misfire-" "本脚本只造 smoke-misfire-c / smoke-misfire-d 两个任务及其子行"; then
  ok "跑前清理完成（本前缀残留 = 0）"
else
  bad "跑前清理失败 ⇒ 中止（不带着脏数据继续跑）"
  exit 1
fi

login() {
  curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$SMOKE_ADMIN_PW\"}" | jq -r '.data.accessToken'
}
TOKEN="$(login)"

psql_q() { docker exec -i "$SMOKE_PG_CONTAINER" psql -U "$SMOKE_PG_USER" -d "$SMOKE_PG_DB" -tAX -c "$1"; }
api_logs() { docker logs "$SMOKE_API_CONTAINER" 2>&1; }

# 日级 cron `0 3 * * *` 的"最近一个已过的落点"（DB 侧算，与应用同源同时区）
FIRE_POINT_SQL="case when date_trunc('day', now()) + interval '3 hours' <= now()
                          then date_trunc('day', now()) + interval '3 hours'
                          else date_trunc('day', now()) - interval '21 hours' end"

create_cron_task() {
  curl -s -X POST "$API/tasks" -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $TOKEN" -d "{
      \"name\": \"$1\", \"triggerType\": \"cron\", \"cronExpression\": \"$2\",
      \"runtime\": \"node\", \"timeout\": 30, \"maxRetry\": 0,
      \"misfireStrategy\": \"$3\",
      \"glueSource\": \"console.log('smoke');\", \"glueLanguage\": \"javascript\"
    }" | jq -r '.data.id'
}

# 插一条"历史执行行"（模拟"窗口内已有执行"这个事实）
# $1=taskId $2=startTime SQL 表达式
insert_exec() {
  psql_q "INSERT INTO task_executions (id, \"taskId\", \"taskName\", status, \"startTime\", \"endTime\", \"createdAt\", \"triggerType\")
          VALUES (gen_random_uuid(), '$1', 'smoke-misfire', 'success', ($2), ($2), ($2), 'manual');" >/dev/null
}

misfire_exec_count() { psql_q "select count(*) from task_executions where \"taskId\"='$1' and \"triggerType\"='misfire';"; }
total_exec_count()  { psql_q "select count(*) from task_executions where \"taskId\"='$1';"; }

wait_api() {
  for i in $(seq 1 90); do
    curl -fsS "$API/health/live" >/dev/null 2>&1 && return 0
    sleep 1
  done
  bad "admin-api 未在 90s 内就绪"; return 1
}

# 重启 admin-api ⇒ 触发 boot 期 checkMisfires 扫描
restart_api() {
  docker restart "$SMOKE_API_CONTAINER" >/dev/null
  wait_api
  TOKEN="$(login)"
  sleep 8   # boot 期扫描异步，等它跑完
}

step "0. 建两个 cron 任务（0 3 * * * 每日 03:00 一拍 ⇒ 错失落点一整天恒定）"
TASK_C="$(create_cron_task smoke-misfire-c '0 3 * * *' fire_once)"
TASK_D="$(create_cron_task smoke-misfire-d '0 3 * * *' fire_once)"
[[ -n "$TASK_C" && "$TASK_C" != "null" && -n "$TASK_D" && "$TASK_D" != "null" ]] \
  || { bad "任务创建失败"; exit 1; }
ok "任务 smoke-misfire-c id=${TASK_C}（验 ① 不吞点）"
ok "任务 smoke-misfire-d id=${TASK_D}（验 ② warn ③ 限流）"

FIRE_POINT="$(psql_q "select $FIRE_POINT_SQL;")"
ok "当前 cron 错失落点（DB 侧算）= ${FIRE_POINT}（容器/PG 时区 = UTC）"

# 停机模拟：lastTriggerTime 拨到 5 天前 ⇒ gap(5d) > threshold(2×24h=48h)
psql_q "UPDATE tasks SET \"lastTriggerTime\" = now() - interval '5 days' WHERE id in ('$TASK_C','$TASK_D');" >/dev/null
ok "两个任务 lastTriggerTime = now() - 5 days ⇒ 满足 gap > 2×周期(48h)"

step "1. ① 造一次「无关执行」（落在**错失落点之前**）——这是 A6 修复的核心场景"
insert_exec "$TASK_C" "$FIRE_POINT_SQL - interval '1 hour'"
ok "任务 C 插入无关执行（startTime = 错失落点 - 1h）⇒ 旧口径会判『已覆盖』，A6 后不该"
insert_exec "$TASK_D" "greatest(now(), $FIRE_POINT_SQL + interval '1 second')"
ok "任务 D 插入落在落点之后的执行 ⇒ 闸 3 应命中"

step "2. 触发补偿扫描（重启 admin-api ⇒ boot 期 checkMisfires）"
restart_api
sleep 4

step "3. ① 断言：任务 C 的漏掉落点**没有被**那条无关执行吞掉 ⇒ 补偿真的发生"
MISFIRE_C="$(misfire_exec_count "$TASK_C")"
TOTAL_C="$(total_exec_count "$TASK_C")"
if [[ "$MISFIRE_C" -ge 1 ]]; then
  ok "任务 C 产生了 $MISFIRE_C 条 triggerType='misfire' 的执行行（总行数 ${TOTAL_C}）"
  psql_q "select id, \"triggerType\", status, \"createdAt\" from task_executions where \"taskId\"='$TASK_C' order by \"createdAt\" desc limit 3;" | sed 's/^/    | /'
else
  bad "任务 C 没有任何 misfire 补偿执行行 ⇒ 漏掉的落点被『窗口内无关执行』吞掉了（A6 缺陷仍在！）"
  psql_q "select id, \"triggerType\", status, \"startTime\", \"createdAt\" from task_executions where \"taskId\"='$TASK_C';" | sed 's/^/    | /'
fi
if api_logs | grep -F "smoke-misfire-c" | grep -F "SUPPRESSED" | grep -q .; then
  bad "任务 C 出现了 SUPPRESSED 日志 ⇒ 无关执行仍被判成覆盖"
  api_logs | grep -F "smoke-misfire-c" | grep -F "SUPPRESSED" | tail -2 | sed 's/^/    | /'
else
  ok "任务 C 无 SUPPRESSED 日志 ⇒ 无关执行没被判成覆盖"
fi
MC_WARN="$(api_logs | grep -F "smoke-misfire-c" | grep -F "Misfire detected" | tail -1)"
if echo "$MC_WARN" | grep -q '"level":"warn"'; then
  ok "补偿告警是 warn 级：$(echo "$MC_WARN" | head -c 190)"
else
  bad "补偿告警不是 warn 级（或没有补偿告警）：$MC_WARN"
fi

step "4. ② 断言：闸 3 命中 ⇒ 必须是 **warn** 级（不是 debug）"
SUPPRESS_LINES="$(api_logs | grep -F "smoke-misfire-d" | grep -F "Misfire compensation SUPPRESSED" || true)"
if [[ -n "$SUPPRESS_LINES" ]]; then
  ok "任务 D 命中闸 3 并打出 SUPPRESSED 日志："
  echo "$SUPPRESS_LINES" | tail -2 | sed 's/^/    | /'
  if echo "$SUPPRESS_LINES" | grep -q '"level":"warn"'; then
    ok "该日志 level=**warn**（A6 要求：不是 debug）"
  else
    bad "该日志不是 warn 级"
  fi
else
  bad "任务 D 没打出 SUPPRESSED 日志 ⇒ 闸 3 未命中或日志缺失"
  api_logs | grep -F "smoke-misfire-d" | tail -5 | sed 's/^/    | /'
fi

step "5. ③ 断言：同一任务 30 分钟内**不刷屏**（第二次命中退回 debug）"
WARN_BEFORE="$(api_logs | grep -F "smoke-misfire-d" | grep -F "Misfire compensation SUPPRESSED" | grep -c '"level":"warn"' || true)"
echo "    | 第一次扫描的 warn 条数 = $WARN_BEFORE"
# ⚠️ 绝不能重启（重启清空内存里的限流表）⇒ 等**自然 tick**
MIN="$(date '+%M')"
REMAIN=$(( (5 - 10#$MIN % 5) % 5 )); [[ "$REMAIN" == "0" ]] && REMAIN=5
WAIT_S=$(( REMAIN * 60 + 20 ))
echo "    (等 ${WAIT_S}s 到下一个自然 tick @Cron('0 */5 * * * *')；期间不重启 admin-api)"
SLEEP_1=$(( WAIT_S - 30 )); [[ "$SLEEP_1" -gt 0 ]] && sleep "$SLEEP_1"
insert_exec "$TASK_D" "greatest(now(), $FIRE_POINT_SQL + interval '2 seconds')"
ok "tick 前补一条执行 ⇒ 保证本轮闸 3 再次命中"
sleep 35

WARN_AFTER="$(api_logs | grep -F "smoke-misfire-d" | grep -F "Misfire compensation SUPPRESSED" | grep -c '"level":"warn"' || true)"
THROTTLED="$(api_logs | grep -F "smoke-misfire-d" | grep -F "warn throttled" || true)"
echo "    | 第二次扫描后的 warn 条数 = $WARN_AFTER"
if [[ "$WARN_AFTER" == "$WARN_BEFORE" ]]; then
  ok "30 分钟内第二次命中**没有**再出 warn（限流生效：$WARN_BEFORE → ${WARN_AFTER}）"
else
  bad "限流失效：warn 条数 $WARN_BEFORE → ${WARN_AFTER}（同任务 30 分钟内重复刷屏）"
fi
if [[ -n "$THROTTLED" ]]; then
  ok "被节流的重复命中退回 debug（保留可追溯性）："
  echo "$THROTTLED" | tail -2 | sed 's/^/    | /'
else
  bad "没找到 '(warn throttled)' 的 debug 日志"
fi

# ── 跑后清理（保留；与跑前清理同一实现 ⇒ 同一套口径）─────────────────
# ⚠️ 跑后清理是**锦上添花**：即使这里失败/被中断，**下一次跑**的开头
#   （步骤 0a 的跑前清理）也会把残留清干净 ⇒ 可重入不依赖跑后清理成功。
step "6. 跑后清理（只删本脚本自己造的 smoke-misfire-* 数据）"
if smoke_clean_tasks "smoke-misfire-" "本脚本只造 smoke-misfire-c / smoke-misfire-d 两个任务及其子行"; then
  ok "跑后清理完成（本前缀残留 = 0）"
else
  bad "跑后清理失败（不影响可重入：下一次跑的步骤 0a 会再清一次）"
fi

printf '\n=== 场景 3（A6 补偿窗口 + warn 限流）小结：PASS=%d FAIL=%d ===\n' "$PASS" "$FAIL"
[[ "$FAIL" == "0" ]] || exit 1
