#!/usr/bin/env bash
#
# verify-smoke-firepoint.sh —— 场景 2：A6b「提前触发并消耗下一个 cron 计划落点」
# 的**真链路**验证（不勾选 / 勾选 / 重复勾选 409 / 重启后仍有效）。
#
# 与单测层的差别：本脚本打的是**真 HTTP 端点**（POST /api/tasks/:id/trigger），
# 走真 PG（登记落 tasks.consumedFirePointAt 列）+ 真 Redis + 真 cron 定时器
# （node-cron 在 admin-api 进程内），并**真等落点到来**观察是否被跳过。
#
# 场景表：
#   ① 不勾选 consumeNextFirePoint 手动触发 ⇒ **落点仍被补偿补跑**（A6 核心语义）
#   ② 勾选 ⇒ 登记生效、到点**跳过一次**、**下一个落点正常触发**（非永久 mute）
#   ③ 重复勾选 ⇒ 409
#   ④ 重启 admin-api ⇒ 登记仍有效（持久化，不是内存）
#
# 用法：./scripts/verify-smoke-firepoint.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${ACF_SMOKE_ENV_FILE:-/tmp/acf-smoke-env.sh}"
[[ -f "$ENV_FILE" ]] || { echo "✗ $ENV_FILE not found — run scripts/verify-smoke-stack.sh up first" >&2; exit 2; }
# shellcheck disable=SC1090
source "$ENV_FILE"

PASS=0; FAIL=0
ok()  { printf '  ✓ %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  ✗ %s\n' "$*"; FAIL=$((FAIL+1)); }
step(){ printf '\n=== %s ===\n' "$*"; }

API="http://127.0.0.1:${SMOKE_API_PORT}/api"
TOKEN_FILE="/tmp/acf-smoke-token.txt"

login() {
  curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$SMOKE_ADMIN_PW\"}" \
    | jq -r '.data.accessToken'
}
TOKEN="$(login)"
[[ -n "$TOKEN" && "$TOKEN" != "null" ]] || { echo "✗ login failed" >&2; exit 2; }

psql_q() { docker exec -i "$SMOKE_PG_CONTAINER" psql -U "$SMOKE_PG_USER" -d "$SMOKE_PG_DB" -tAX -c "$1"; }
api_logs() { docker logs "$SMOKE_API_CONTAINER" 2>&1; }
# JSON 日志里按消息片段过滤（admin-api 用 JSON 结构化日志）
log_count() { api_logs | grep -c "$1" || true; }
log_has()   { api_logs | grep -F "$1" | tail -3 || true; }

# 下一个整分钟（cron 落点对齐到分钟）
next_minute() { date -d '+1 minute' '+%Y-%m-%d %H:%M:00'; }

create_cron_task() {
  # $1 = 任务名, $2 = cron 表达式
  curl -s -X POST "$API/tasks" -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $TOKEN" -d "{
      \"name\": \"$1\",
      \"triggerType\": \"cron\",
      \"cronExpression\": \"$2\",
      \"runtime\": \"node\",
      \"timeout\": 30,
      \"maxRetry\": 0,
      \"glueSource\": \"console.log('smoke');\",
      \"glueLanguage\": \"javascript\"
    }" | jq -r '.data.id'
}

fire_point_of() { psql_q "select coalesce(to_char(\"consumedFirePointAt\", 'YYYY-MM-DD HH24:MI:SS'), 'NULL') from tasks where id='$1';"; }
exec_count()   { psql_q "select count(*) from task_executions where \"taskId\"='$1';"; }
exec_triggers(){ psql_q "select coalesce(string_agg(distinct \"triggerType\", ','), '-') from task_executions where \"taskId\"='$1';"; }

# ── 场景 ①：cron 任务在**未登记**时的基准行为 ─────────────────────────
step "0. 建一个 cron 任务（*/1 * * * *，每分钟一拍）并等它自然跑一拍"
TASK_A="$(create_cron_task smoke-fp-cron-a '*/1 * * * *')"
[[ -n "$TASK_A" && "$TASK_A" != "null" ]] || { bad "任务创建失败"; exit 1; }
ok "任务 smoke-fp-cron-a id=$TASK_A"
# ⚠️ 等待上界必须够：任务是在 **reload tick**（@Cron(EVERY_MINUTE)）里被注册
# 定时器的。最坏情况 = 任务刚建好就错过本分钟的 reload ⇒ 要等**下一个整分钟**
# 才注册 ⇒ 再等**下一个 cron 落点**（`*/1` = 再一个整分钟）才跑第一拍
# ⇒ 最坏 ~120s+。⇒ 这里等 200s。
for i in $(seq 1 200); do
  [[ "$(exec_count "$TASK_A")" != "0" ]] && break
  sleep 1
done
CNT="$(exec_count "$TASK_A")"
[[ "$CNT" != "0" ]] \
  && ok "基准：cron 任务已自然触发（executions=${CNT}，triggerType=$(exec_triggers "$TASK_A")）" \
  || bad "基准：200 秒内 cron 未触发任何执行"

step "1. ① 不勾选 consumeNextFirePoint 手动触发 ⇒ 不产生登记"
BEFORE_FP="$(fire_point_of "$TASK_A")"
RESP="$(curl -s -o /tmp/acf-smoke-trig.json -w '%{http_code}' -X POST "$API/tasks/$TASK_A/trigger" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d '{}')"
AFTER_FP="$(fire_point_of "$TASK_A")"
[[ "$RESP" == "201" ]] && ok "手动触发成功（HTTP ${RESP}）" || bad "手动触发失败（HTTP ${RESP}）：$(cat /tmp/acf-smoke-trig.json | head -c 200)"
[[ "$AFTER_FP" == "NULL" ]] \
  && ok "未勾选 ⇒ tasks.consumedFirePointAt 仍为 NULL（无登记写入）" \
  || bad "未勾选却产生了登记：$AFTER_FP"

step "2. ① 手动触发**不覆盖**计划落点 ⇒ 下一个落点仍被调度器触发"
# 等到下一个整分钟之后再看执行数是否增加（手动那一拍 + cron 那一拍）
BEFORE_CNT="$(exec_count "$TASK_A")"
for i in $(seq 1 150); do
  [[ "$(exec_count "$TASK_A")" -gt "$BEFORE_CNT" ]] && break
  sleep 1
done
AFTER_CNT="$(exec_count "$TASK_A")"
[[ "$AFTER_CNT" -gt "$BEFORE_CNT" ]] \
  && ok "手动触发后，下一个 cron 落点**仍被触发**（$BEFORE_CNT → ${AFTER_CNT}）——落点没有被手动触发吞掉" \
  || bad "手动触发后下一个落点未触发（$BEFORE_CNT → ${AFTER_CNT}）——落点被吞了（A6 语义被破坏）"

step "3. ② 勾选 consumeNextFirePoint ⇒ 登记写入 DB"
TASK_B="$(create_cron_task smoke-fp-cron-b '*/1 * * * *')"
ok "任务 smoke-fp-cron-b id=$TASK_B"
# 等调度器注册上（否则到点不会触发）
for i in $(seq 1 150); do
  STATS="$(curl -s "$API/tasks/scheduler/stats" -H "Authorization: Bearer $TOKEN" | jq -r '.data.activeCronTasks')"
  [[ "$STATS" -ge 2 ]] && break
  sleep 1
done
RESP2="$(curl -s -o /tmp/acf-smoke-trig2.json -w '%{http_code}' -X POST "$API/tasks/$TASK_B/trigger" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"consumeNextFirePoint":true}')"
[[ "$RESP2" == "201" ]] && ok "勾选后手动触发成功（HTTP ${RESP2}）" || bad "勾选后手动触发失败（HTTP ${RESP2}）：$(head -c 300 /tmp/acf-smoke-trig2.json)"
FP_B="$(fire_point_of "$TASK_B")"
[[ "$FP_B" != "NULL" ]] \
  && ok "登记生效：tasks.consumedFirePointAt = ${FP_B}（落点已落库，非内存）" \
  || bad "勾选后登记未写入（consumedFirePointAt 仍 NULL）"
# 登记的落点必须是**未来**的下一个落点
FP_EPOCH="$(psql_q "select extract(epoch from \"consumedFirePointAt\")::bigint from tasks where id='$TASK_B';")"
NOW_EPOCH="$(date +%s)"
[[ "$FP_EPOCH" -gt "$NOW_EPOCH" ]] \
  && ok "登记的落点在未来（$(date -d "@$FP_EPOCH" '+%H:%M:%S') > now $(date '+%H:%M:%S')）" \
  || bad "登记的落点不在未来（FP=$FP_EPOCH now=${NOW_EPOCH}）"

step "4. ③ 重复勾选 ⇒ 409"
RESP3="$(curl -s -o /tmp/acf-smoke-trig3.json -w '%{http_code}' -X POST "$API/tasks/$TASK_B/trigger" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"consumeNextFirePoint":true}')"
[[ "$RESP3" == "409" ]] \
  && ok "重复勾选被拒（HTTP 409）" \
  || bad "重复勾选未返回 409（得到 ${RESP3}）：$(head -c 300 /tmp/acf-smoke-trig3.json)"
ERRCODE="$(jq -r '.errorCode // "-"' /tmp/acf-smoke-trig3.json 2>/dev/null || echo '-')"
echo "    | 409 响应 errorCode=$ERRCODE"
[[ "$ERRCODE" == "TASK_FIRE_POINT_ALREADY_CONSUMED" ]] \
  && ok "错误码正确：TASK_FIRE_POINT_ALREADY_CONSUMED" \
  || bad "错误码不是 TASK_FIRE_POINT_ALREADY_CONSUMED（得到 '$ERRCODE'）"
# 409 不得覆盖原登记
[[ "$(fire_point_of "$TASK_B")" == "$FP_B" ]] \
  && ok "409 后原登记未被覆盖（仍是 ${FP_B}）" \
  || bad "409 后登记被覆盖了"

step "5. ④ 重启 admin-api ⇒ 登记仍有效（持久化，不是内存）"
docker restart "$SMOKE_API_CONTAINER" >/dev/null
for i in $(seq 1 90); do
  curl -fsS "$API/health/live" >/dev/null 2>&1 && break
  sleep 1
done
TOKEN="$(login)"   # 重启后 token 需重取
FP_AFTER_RESTART="$(fire_point_of "$TASK_B")"
[[ "$FP_AFTER_RESTART" == "$FP_B" ]] \
  && ok "重启后登记仍在（${FP_AFTER_RESTART}）⇒ 落库持久化，非进程内存" \
  || bad "重启后登记丢失（$FP_B → ${FP_AFTER_RESTART}）"
# 重启后 409 仍应成立（登记还在）
RESP4="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/tasks/$TASK_B/trigger" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"consumeNextFirePoint":true}')"
[[ "$RESP4" == "409" ]] \
  && ok "重启后重复勾选仍是 409（登记依然生效）" \
  || bad "重启后重复勾选返回 ${RESP4}（应为 409）"

step "6. ② 到点跳过一次 ⇒ 该拍无 cron 执行；下一拍正常触发"
# 等到登记的落点过去 + 一拍
FP_EPOCH="$(psql_q "select extract(epoch from \"consumedFirePointAt\")::bigint from tasks where id='$TASK_B';")"
WAIT_S=$(( FP_EPOCH - $(date +%s) + 5 ))
[[ "$WAIT_S" -gt 0 ]] || WAIT_S=5
echo "    (等 ${WAIT_S}s 越过登记落点 + 5s)"
sleep "$WAIT_S"
SKIP_LOGS="$(log_has 'SKIPPED: it was explicitly consumed by a manual early trigger')"
if [[ -n "$SKIP_LOGS" ]]; then
  ok "到点被跳过（warn 级日志命中）："
  echo "$SKIP_LOGS" | sed 's/^/    | /'
else
  bad "到点未被跳过：找不到 SKIPPED 日志"
fi
# 跳过后登记应被清除（一次性，不是永久 mute）
FP_AFTER_SKIP="$(fire_point_of "$TASK_B")"
[[ "$FP_AFTER_SKIP" == "NULL" ]] \
  && ok "跳过消费后登记被清除（consumedFirePointAt → NULL）⇒ 一次性，不是永久 mute" \
  || bad "跳过消费后登记未清除（仍是 ${FP_AFTER_SKIP}）⇒ 永久 mute！"

step "7. ② 下一个落点正常触发（不是永久 mute）"
BEFORE_CNT="$(exec_count "$TASK_B")"
for i in $(seq 1 90); do
  [[ "$(exec_count "$TASK_B")" -gt "$BEFORE_CNT" ]] && break
  sleep 1
done
AFTER_CNT="$(exec_count "$TASK_B")"
[[ "$AFTER_CNT" -gt "$BEFORE_CNT" ]] \
  && ok "跳过之后，下一个落点**正常触发**（$BEFORE_CNT → ${AFTER_CNT}）" \
  || bad "跳过之后下一个落点未触发（$BEFORE_CNT → ${AFTER_CNT}）⇒ 成了永久 mute"

step "8. 审计留痕：task.fire_point_consumed"
AUDIT="$(psql_q "select count(*) from audit_logs where action='task.fire_point_consumed';")"
[[ "$AUDIT" != "0" ]] \
  && ok "审计表有 $AUDIT 条 task.fire_point_consumed 记录" \
  || bad "审计表没有 task.fire_point_consumed 记录"

# 清理
psql_q "DELETE FROM tasks where name in ('smoke-fp-cron-a','smoke-fp-cron-b');" >/dev/null

printf '\n=== 场景 2（A6b 真链路）小结：PASS=%d FAIL=%d ===\n' "$PASS" "$FAIL"
[[ "$FAIL" == "0" ]] || exit 1
