#!/usr/bin/env bash
#
# verify-smoke-s3-fallback.sh —— 场景 4（附加）：**S3 不可用时的回退路径**。
#
# ## 为什么必须验这条
#
# S3 写入路径的设计（execution-log.collaborator.ts:160-183）：`s3.put` 抛错 ⇒
# warn ⇒ 改写 DB 行 ⇒ **把执行行指针收回 db**（`logStorage='db'`、`logObjectKey=null`）。
# 这条回退是「对象存储挂了，日志查看器仍然能用」的保证 ⇒ 若它失效，用户在
# RustFS 故障期间**完全看不到日志**。而它只被替身 spec 覆盖过。
#
# ## 做法
#
# 真把 RustFS 容器 **stop 掉**（不是 mock 掉 minio）⇒ 真连接失败 ⇒ 走真回退分支。
#
# 用法：./scripts/verify-smoke-s3-fallback.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${ACF_SMOKE_ENV_FILE:-/tmp/acf-smoke-env.sh}"
[[ -f "$ENV_FILE" ]] || { echo "✗ $ENV_FILE not found — run scripts/verify-smoke-s3-stack.sh up first" >&2; exit 2; }
# shellcheck disable=SC1090
source "$ENV_FILE"
# shellcheck disable=SC1091
source "$ROOT/scripts/verify-smoke-common.sh"

PASS=0; FAIL=0
ok()  { printf '  ✓ %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  ✗ %s\n' "$*"; FAIL=$((FAIL+1)); }
step(){ printf '\n=== %s ===\n' "$*"; }

API="http://127.0.0.1:${SMOKE_API_PORT}/api"
psql_q() { docker exec -i "$SMOKE_PG_CONTAINER" psql -U "$SMOKE_PG_USER" -d "$SMOKE_PG_DB" -tAX -c "$1"; }
login() {
  curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$SMOKE_ADMIN_PW\"}" | jq -r '.data.accessToken'
}
TOKEN="$(login)"

# ── 跑前清理（幂等的前提）───────────────────────────────────────────────
# 本脚本造的行：tasks(name = 'smoke-s3-fallback') + 它的 task_executions
# + execution_log_lines（回退路径会写 2 行 DB 日志）+ task.* 审计行。
#
# ⚠️ **为什么必须"跑前"**：本脚本步骤 2 会**真停 RustFS 容器** ⇒ 中途失败
#   （或被 Ctrl-C）会让 RustFS 停着 + DB 残留 ⇒ 二次跑时步骤 1 建任务
#   **撞唯一索引**（`idx_tasks_name_unique`）直接失败 ⇒ 不可重入。
#   ⇒ 跑**开始时**按前缀清干净并验证计数 = 0。
#   ⇒ 另外：**RustFS 必须在跑**（本场景要把它停掉制造真故障）⇒ 跑前
#     顺手确保它是 running（上一轮残留成 stopped 会让步骤 0 直接失败）。
step "0a. 跑前清理（只删本脚本自己造的 smoke-s3-fallback-* 数据）"
if smoke_preclean_tasks "smoke-s3-fallback" "本脚本只造一个 smoke-s3-fallback 任务及其子行"; then
  ok "跑前清理完成（本前缀残留 = 0）"
else
  bad "跑前清理失败 ⇒ 中止（不带着脏数据继续跑）"
  exit 1
fi
# RustFS 必须处于 running（上一轮残留成 stopped ⇒ 步骤 0 会失败）
if [[ "$(docker inspect -f '{{.State.Running}}' "$SMOKE_RUSTFS_CONTAINER" 2>/dev/null)" != "true" ]]; then
  docker start "$SMOKE_RUSTFS_CONTAINER" >/dev/null 2>&1 || true
  for i in $(seq 1 30); do
    curl -fsS "http://127.0.0.1:${SMOKE_RUSTFS_PORT}/health" >/dev/null 2>&1 && break
    sleep 1
  done
  ok "RustFS 已确保处于 running（上一轮残留成 stopped ⇒ 已被拉起）"
else
  ok "RustFS 已在 running"
fi

step "0. 前置：RustFS 健康"
curl -fsS "http://127.0.0.1:${SMOKE_RUSTFS_PORT}/health" >/dev/null 2>&1 \
  && ok "RustFS 健康（准备把它停掉制造真故障）" \
  || { bad "RustFS 不健康"; exit 1; }

step "1. 建任务 + 触发 ⇒ 拿到 PENDING 执行行"
TASK_ID="$(curl -s -X POST "$API/tasks" -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"smoke-s3-fallback","triggerType":"manual","runtime":"node","timeout":30,"maxRetry":0}' | jq -r '.data.id')"
EXEC_ID="$(curl -s -X POST "$API/tasks/$TASK_ID/trigger" -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d '{}' | jq -r '.data.id')"
ok "task=$TASK_ID execution=$EXEC_ID"
# 摆成「已派发且在跑」（回调面拒收「未派发的 PENDING」——R-16/B-7）
psql_q "UPDATE task_executions SET status='running', \"executorAddress\"='smoke-exec-addr', \"logStorage\"=NULL, \"logObjectKey\"=NULL, \"endTime\"=NULL WHERE id='$EXEC_ID';" >/dev/null

step "2. **停掉 RustFS**（真故障，不是 mock）"
docker stop "$SMOKE_RUSTFS_CONTAINER" >/dev/null
sleep 2
docker ps --filter "name=${SMOKE_RUSTFS_CONTAINER}" --format '{{.Names}} {{.Status}}' | sed 's/^/    | /'
ok "RustFS 已停止"

step "3. 发终态回调（带日志）⇒ 应触发 S3 失败回退"
node -e "require('fs').writeFileSync('/tmp/acf-s3-fb.json', JSON.stringify([{executionId:process.argv[1],status:'success',logs:'[ERROR] fallback line 1\n[INFO] fallback line 2',executorAddress:'smoke-exec-addr'}]))" "$EXEC_ID"
CB="$(curl -s -X POST "$API/executions/callback" -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $SMOKE_EXEC_SECRET" --data @/tmp/acf-s3-fb.json | jq -r '.data.results[0].success')"
[[ "$CB" == "true" ]] && ok "回调被受理（success=true）——S3 故障没有让回调失败" || bad "回调被拒（success=${CB}）"

step "4. 断言：指针被**收回 db** + DB 行被写入"
STORAGE="$(psql_q "select coalesce(\"logStorage\",'NULL') from task_executions where id='$EXEC_ID';")"
KEY="$(psql_q "select coalesce(\"logObjectKey\",'NULL') from task_executions where id='$EXEC_ID';")"
[[ "$STORAGE" == "db" ]] \
  && ok "logStorage 被收回为 'db'（不是悬空的 's3'）" \
  || bad "logStorage 应为 'db'（回退收回指针），实际 '$STORAGE'"
[[ "$KEY" == "NULL" ]] \
  && ok "logObjectKey 被清空（NULL）" \
  || bad "logObjectKey 应为 NULL，实际 '$KEY'"
LINES="$(psql_q "select count(*) from execution_log_lines where \"executionId\"='$EXEC_ID';")"
[[ "$LINES" == "2" ]] \
  && ok "execution_log_lines 写入 2 行（日志没丢）" \
  || bad "execution_log_lines 行数 = ${LINES}（期望 2）"
psql_q "select \"lineNumber\",level,content from execution_log_lines where \"executionId\"='$EXEC_ID' order by \"lineNumber\";" | sed 's/^/    | /'

step "5. 断言：读面仍能取回日志（DB 回退可读）"
READ="$(curl -s "$API/tasks/executions/$EXEC_ID/logs?fromLine=0&limit=10" -H "Authorization: Bearer $TOKEN" | jq -r '.data.lines | join(" | ")')"
[[ "$READ" == "[ERROR] fallback line 1 | [INFO] fallback line 2" ]] \
  && ok "读面取回完整日志：$READ" \
  || bad "读面内容不对：$READ"

step "6. 断言：日志里出现 S3 回退的 warn"
if docker logs "$SMOKE_API_CONTAINER" 2>&1 | grep -F "S3 log upload failed" | grep -q .; then
  ok "日志里有 S3 回退的 warn："
  docker logs "$SMOKE_API_CONTAINER" 2>&1 | grep -F "S3 log upload failed" | tail -1 | sed 's/^/    | /'
else
  bad "日志里没有 S3 回退的 warn"
fi

step "7. 复原：重启 RustFS"
docker start "$SMOKE_RUSTFS_CONTAINER" >/dev/null
for i in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:${SMOKE_RUSTFS_PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:${SMOKE_RUSTFS_PORT}/health" >/dev/null 2>&1 \
  && ok "RustFS 已恢复健康" || bad "RustFS 未恢复"

# ── 跑后清理（保留；与跑前清理同一实现 ⇒ 同一套口径）─────────────────
# ⚠️ 跑后清理是**锦上添花**：即使这里失败/被中断，**下一次跑**的开头
#   （步骤 0a 的跑前清理）也会把残留清干净 ⇒ 可重入不依赖跑后清理成功。
step "8. 跑后清理（只删本脚本自己造的 smoke-s3-fallback 数据）"
if smoke_clean_tasks "smoke-s3-fallback" "本脚本只造一个 smoke-s3-fallback 任务及其子行"; then
  ok "跑后清理完成（本前缀残留 = 0）"
else
  bad "跑后清理失败（不影响可重入：下一次跑的步骤 0a 会再清一次）"
fi

printf '\n=== 场景 4（S3 故障回退到 DB）小结：PASS=%d FAIL=%d ===\n' "$PASS" "$FAIL"
[[ "$FAIL" == "0" ]] || exit 1
