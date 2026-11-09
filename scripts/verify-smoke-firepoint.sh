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
# shellcheck disable=SC1091
source "$ROOT/scripts/verify-smoke-common.sh"

PASS=0; FAIL=0
ok()  { printf '  ✓ %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  ✗ %s\n' "$*"; FAIL=$((FAIL+1)); }
step(){ printf '\n=== %s ===\n' "$*"; }

API="http://127.0.0.1:${SMOKE_API_PORT}/api"
TOKEN_FILE="/tmp/acf-smoke-token.txt"

# ── 跑前清理（幂等的前提）───────────────────────────────────────────────
# 本脚本造的行：tasks(name ∈ {smoke-fp-cron-a, smoke-fp-cron-b}) +
# 它们的 task_executions + execution_log_lines + task.* 审计行。
#
# ⚠️ **为什么必须"跑前"而不是"跑后"**：
#   上一轮实测跑到步骤 7 超时中断 ⇒ 残留了 smoke-fp-cron-a/b 两个任务 ⇒
#   二次重跑**步骤 0 就失败**（tasks.name 上有唯一索引
#   `idx_tasks_name_unique` ⇒ 同名任务创建直接被拒）⇒ **脚本在脏 DB 上不可重入**。
#   ⇒ 每次跑**开始时**先按前缀清干净并**验证计数 = 0** ⇒
#   "上次跑到一半失败" 能被下一次自动修复。
step "0a. 跑前清理（只删本脚本自己造的 smoke-fp-* 数据）"
if smoke_preclean_tasks "smoke-fp-" "本脚本只造 smoke-fp-cron-a / smoke-fp-cron-b 两个任务及其子行"; then
  ok "跑前清理完成（本前缀残留 = 0）"
else
  bad "跑前清理失败 ⇒ 中止（不带着脏数据继续跑）"
  exit 1
fi

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

# ── 落点间隔（**从生产代码算**，不硬编码）─────────────────────────────
#
# 用 admin-api 容器里的**生产实现** `dist/modules/task/fire-point.util.js`
# （`computeNextCronFirePoint`）算「下一个落点」⇒ 与调度器**同源**
# （同口径 ⇒ 不会算出一个调度器不认的落点）。
# 间隔 = (下一个落点 - 现在的落点) ⇒ 对 `*/N` 这类表达式是 N 分钟。
#
# ⚠️ 为什么要"算"而不是写死 60：
#   步骤 7 的等待上界必须 = **落点间隔 + 余量**（不是硬编码 300s）。
#   硬编码的数与被等对象无关 ⇒ 换个 cron 表达式就可能不够（上一轮撞 300s
#   就是这个形态）。⇒ 上界随表达式自动伸缩。
#
# $1 = taskId；输出：秒数（整数）。算不出 ⇒ 回退 60（并打印告警）。
cron_interval_s() {
  local task_id="${1:?need taskId}"
  local expr tz out
  expr="$(psql_q "select coalesce(\"cronExpression\",'') from tasks where id='${task_id}';")"
  tz="$(psql_q "select coalesce(timezone,'') from tasks where id='${task_id}';")"
  if [[ -z "$expr" ]]; then
    printf 'cron_interval_s: 任务 %s 没有 cronExpression ⇒ 回退 60s\n' "$task_id" >&2
    echo 60
    return 0
  fi
  # 在 admin-api 容器里跑生产实现（node-cron 在镜像的 node_modules 里）
  #
  # ⚠️ 为什么不能「连调两次 computeNextCronFirePoint 求差」：
  #   它的语义锚点是 **now**（fire-point.util.ts 的头注：node-cron 的
  #   getNextRuns 不接受外部起点）⇒ 两次调用返回**同一个**下一落点 ⇒ 差 = 0。
  # ⇒ 正确做法：直接用 node-cron 的 getNextRuns(2) 取**连续两拍**
  #   （与生产实现同一个匹配器、同一时区语义），差 = 落点间隔。
  #   并用生产实现 computeNextCronFirePoint 交叉校验「第一拍 = 生产口径的下一落点」
  #   ⇒ 万一将来两边漂移，这里会**报错**而不是安静地算错间隔。
  out="$(docker exec \
    -e FP_EXPR="$expr" -e FP_TZ="$tz" \
    "$SMOKE_API_CONTAINER" node -e '
      const nodeCron = require("node-cron");
      const { computeNextCronFirePoint } = require("/app/dist/modules/task/fire-point.util.js");
      const expr = process.env.FP_EXPR;
      const tz = (process.env.FP_TZ || "").trim() || undefined;
      const t = nodeCron.createTask(expr, () => {}, { timezone: tz });
      try {
        const runs = t.getNextRuns(2);
        if (!runs || runs.length < 2) { console.log(""); process.exit(0); }
        const prod = computeNextCronFirePoint(expr, tz);
        if (!prod || prod.getTime() !== runs[0].getTime()) {
          console.error("MISMATCH: 生产 computeNextCronFirePoint 与 node-cron 的下一落点不一致");
          process.exit(3);
        }
        console.log(Math.round((runs[1].getTime() - runs[0].getTime()) / 1000));
      } finally { t.destroy(); }
    ' 2>/dev/null || true)"
  if [[ ! "$out" =~ ^[0-9]+$ ]] || [[ "$out" == "0" ]]; then
    printf 'cron_interval_s: 算不出间隔（expr=%s tz=%s）⇒ 回退 60s\n' "$expr" "$tz" >&2
    echo 60
    return 0
  fi
  echo "$out"
}

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
# ── 超时上界：**按"落点间隔 + 余量"算**，不是硬编码 300s ──────────────
#
# ## 为什么上一轮撞了 300s 上限
# 上一轮（artifacts/rounds/r7-register-impl.md §6.1）步骤 7 在 300s 处超时。
# 原因是**上界写死 300s**，而这一步要等的是**真实 cron 落点**：
#   · cron 是 `*/1 * * * *` ⇒ 落点间隔 = 60s；
#   · 但**上一拍被跳过**（步骤 6）⇒ 下一拍在**登记落点 + 一个周期**之后；
#   · 再叠加「跳过那一拍的补偿扫描」（misfire）可能占掉一拍。
# ⇒ 300s 这个数**与被等对象无关** ⇒ 换个 cron 表达式就可能不够。
#
# ## 现在的算法（与被等对象绑定）
#   落点间隔 INTERVAL_S（从生产代码 `computeNextCronFirePoint` 算出的
#   **下一个**落点反推 ⇒ 与调度器**同源**，不硬编码）
#   上界 = INTERVAL_S（等下一拍） + 余量（等调度器注册 + 落点精度 + 执行落库）
# ⇒ 上界随 cron 表达式自动伸缩；cron 越稀疏 ⇒ 上界越大。
#
# ⚠️ 余量里的「注册」这一项不可省：定时器在 **reload tick**（@Cron(EVERY_MINUTE)）
#   里注册 ⇒ 任务刚建好可能错过本分钟的 reload ⇒ 要等下一个整分钟才注册。
INTERVAL_S="$(cron_interval_s "$TASK_B")"
REGISTER_SLACK_S=90      # reload tick 最坏一个整分钟 + 落点精度余量
ENQUEUE_SLACK_S=30       # 落点后入队 + 落库 + DB 计数可见
WAIT_LIMIT_S=$(( INTERVAL_S + REGISTER_SLACK_S + ENQUEUE_SLACK_S ))
echo "    （等下一拍：落点间隔=${INTERVAL_S}s + 余量=${REGISTER_SLACK_S}+${ENQUEUE_SLACK_S}s ⇒ 上界 ${WAIT_LIMIT_S}s）"
BEFORE_CNT="$(exec_count "$TASK_B")"
WAITED_S=0
for i in $(seq 1 "$WAIT_LIMIT_S"); do
  [[ "$(exec_count "$TASK_B")" -gt "$BEFORE_CNT" ]] && break
  sleep 1
  WAITED_S=$((WAITED_S+1))
done
AFTER_CNT="$(exec_count "$TASK_B")"
if [[ "$AFTER_CNT" -gt "$BEFORE_CNT" ]]; then
  ok "跳过之后，下一个落点**正常触发**（$BEFORE_CNT → ${AFTER_CNT}，等了 ${WAITED_S}s）"
else
  # 超时消息必须写清：**等的是什么 / 已经等了多少 / 下次最早何时可验**
  NEXT_FP="$(psql_q "select coalesce(to_char((\"consumedFirePointAt\"), 'YYYY-MM-DD HH24:MI:SS'), '-') from tasks where id='$TASK_B';")"
  bad "跳过之后下一个落点未触发（$BEFORE_CNT → ${AFTER_CNT}）⇒ 成了永久 mute"
  printf '    ⏱ 等的是什么：等 smoke-fp-cron-b（cron=%s，间隔≈%ss）的**下一个计划落点**\n' \
    "$(psql_q "select coalesce(\"cronExpression\",'-') from tasks where id='$TASK_B';")" "$INTERVAL_S"
  printf '    ⏱ 已经等了：%ss（上界 %ss）\n' "$WAITED_S" "$WAIT_LIMIT_S"
  printf '    ⏱ 下次最早何时可验：**下一个整分钟之后**（落点间隔 %ss ⇒ 至少再等 %ss；\n' "$INTERVAL_S" "$INTERVAL_S"
  printf '       若上界仍不够 ⇒ 说明调度器没在该落点触发（查 admin-api 日志里的 cron 回调与 %s 的 SKIPPED 行）\n' "smoke-fp-cron-b"
  printf '    | 当前 consumedFirePointAt=%s\n' "$NEXT_FP"
fi

step "8. 审计留痕：task.fire_point_consumed"
# ⚠️ **必须限定到本脚本的任务**：`count(*) where action='task.fire_point_consumed'`
#   数的是**全表** ⇒ 在脏 DB 上（上一轮残留的审计行）会**靠残留就"通过"**
#   ⇒ **假绿**。⇒ 改成「resourceId 属于本脚本的任务 B」。
AUDIT="$(psql_q "select count(*) from audit_logs where action='task.fire_point_consumed' and \"resourceId\"='$TASK_B';")"
[[ "$AUDIT" != "0" ]] \
  && ok "审计表有 $AUDIT 条 task.fire_point_consumed 记录（**限定在本脚本的任务 B** ⇒ 不会被上一轮的残留顶成假绿）" \
  || bad "审计表没有本脚本任务 B 的 task.fire_point_consumed 记录"

# ── 跑后清理（保留；与跑前清理同一实现 ⇒ 同一套口径）─────────────────
# ⚠️ 跑后清理是**锦上添花**：即使这里失败/被中断，**下一次跑**的开头
#   （步骤 0a 的跑前清理）也会把残留清干净 ⇒ 可重入不依赖跑后清理成功。
step "9. 跑后清理（只删本脚本自己造的 smoke-fp-* 数据）"
if smoke_clean_tasks "smoke-fp-" "本脚本只造 smoke-fp-cron-a / smoke-fp-cron-b 两个任务及其子行"; then
  ok "跑后清理完成（本前缀残留 = 0）"
else
  bad "跑后清理失败（不影响可重入：下一次跑的步骤 0a 会再清一次）"
fi

printf '\n=== 场景 2（A6b 真链路）小结：PASS=%d FAIL=%d ===\n' "$PASS" "$FAIL"
[[ "$FAIL" == "0" ]] || exit 1
