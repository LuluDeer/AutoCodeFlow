#!/usr/bin/env bash
#
# verify-smoke-migration.sh —— 场景 1：迁移 `1790000000096-AddTaskConsumedFirePointAt`
# 在**真实 PG** 上的 up / 幂等 / down 三态验证。
#
# 验证点（逐条都有可复现的 DB 证据）：
#   ① 存量行 `consumedFirePointAt` 全为 NULL（metadata-only、零回填）
#   ② `ADD COLUMN IF NOT EXISTS` 重复执行不报错（幂等）
#   ③ down 后列消失，且**数据无损**（tasks 表行数与内容不变）
#
# 与"单测层验证"的区别：本脚本连的是**真 PG16 容器**，走的是
# **admin-api 自己的 migration-lock-cli**（pg_advisory_lock 互斥 + TypeORM
# 迁移执行器），不是 mock。
#
# 依赖：scripts/verify-smoke-stack.sh up 已起好栈。
# 用法：./scripts/verify-smoke-migration.sh
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
ok()   { printf '  ✓ %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  ✗ %s\n' "$*"; FAIL=$((FAIL+1)); }
step() { printf '\n=== %s ===\n' "$*"; }

psql_q() { docker exec -i "$SMOKE_PG_CONTAINER" psql -U "$SMOKE_PG_USER" -d "$SMOKE_PG_DB" -tAX -c "$1"; }

# ── 跑前清理（幂等的前提）───────────────────────────────────────────────
# 本脚本造的行：tasks(name like 'smoke-mig-%') + 它们的 task_executions /
# execution_log_lines / task.* 审计行。
#
# ⚠️ **为什么必须"跑前"**：上一轮实测跑到一半失败（步骤 5 的 down 失败等）
#   会残留 smoke-mig-* 行 ⇒ 二次跑时步骤 1 的 INSERT 会撞唯一索引
#   `idx_tasks_name_unique` ⇒ **步骤 1 就失败** ⇒ 脚本在脏 DB 上不可重入。
#   ⇒ 跑**开始时**按前缀清干净并验证计数 = 0 ⇒ 上次失败能被下次自动修复。
step "0a. 跑前清理（只删本脚本自己造的 smoke-mig-* 数据）"
if smoke_preclean_tasks "smoke-mig-" "本脚本只造 smoke-mig-a/b/c/d 四个任务及其子行"; then
  ok "跑前清理完成（本前缀残留 = 0）"
else
  bad "跑前清理失败 ⇒ 中止（不带着脏数据继续跑）"
  exit 1
fi

# admin-api 容器里跑迁移 CLI（dist/migration-lock-cli.js 已随镜像构建）
migrate() {
  # $1 = up|down
  docker exec \
    -e DB_HOST="$SMOKE_PG_CONTAINER" -e DB_PORT=5432 \
    -e DB_USERNAME="$SMOKE_PG_USER" -e DB_PASSWORD="$SMOKE_PG_PASSWORD" \
    -e DB_DATABASE="$SMOKE_PG_DB" -e NODE_ENV=production \
    "$SMOKE_API_CONTAINER" node dist/migration-lock-cli.js "$1"
}

step "0. 前置：确认迁移已在 boot 时应用（up 的初始态）"
COL_EXISTS="$(psql_q "select count(*) from information_schema.columns where table_name='tasks' and column_name='consumedFirePointAt';")"
if [[ "$COL_EXISTS" == "1" ]]; then
  ok "tasks.consumedFirePointAt 存在（boot 期迁移链已跑到 1790000000096）"
else
  bad "tasks.consumedFirePointAt 不存在（boot 迁移未跑完？）"
fi
LEDGER="$(psql_q "select name from migrations where name='AddTaskConsumedFirePointAt1790000000096';")"
[[ "$LEDGER" == "AddTaskConsumedFirePointAt1790000000096" ]] \
  && ok "migrations 台账含 AddTaskConsumedFirePointAt1790000000096" \
  || bad "migrations 台账缺 1790000000096（得到 '$LEDGER'）"

step "1. 造存量数据（迁移前就存在的 tasks 行）"
# 建 3 条任务行（走真实 API 还是直接 SQL？→ 直接 SQL 更可控，且能保证
# createdAt 早于迁移时刻，模拟"存量"）。
psql_q "
INSERT INTO tasks (name, \"triggerType\", runtime, status, \"blockStrategy\", \"misfireStrategy\", \"createdAt\", \"updatedAt\")
VALUES
  ('smoke-mig-a','manual','node','active','serial','ignore', now() - interval '10 days', now()),
  ('smoke-mig-b','cron','node','active','serial','fire_once', now() - interval '10 days', now()),
  ('smoke-mig-c','fixed_rate','node','active','serial','ignore', now() - interval '10 days', now());
" >/dev/null
TASKS_BEFORE="$(psql_q "select count(*) from tasks where name like 'smoke-mig-%';")"
ok "存量 tasks 行数 = ${TASKS_BEFORE}（name like 'smoke-mig-%'）"

step "2. ① 存量行的 consumedFirePointAt 必须全为 NULL"
NON_NULL="$(psql_q "select count(*) from tasks where name like 'smoke-mig-%' and \"consumedFirePointAt\" is not null;")"
[[ "$NON_NULL" == "0" ]] \
  && ok "存量 3 行 consumedFirePointAt 全为 NULL（零回填，metadata-only）" \
  || bad "存量行有 $NON_NULL 行 consumedFirePointAt 非 NULL（应为 0）"
# 列无 DEFAULT ⇒ 后续 INSERT 也不会自动填
psql_q "INSERT INTO tasks (name, \"triggerType\", runtime, status, \"blockStrategy\", \"misfireStrategy\", \"createdAt\", \"updatedAt\") VALUES ('smoke-mig-d','manual','node','active','serial','ignore', now(), now());" >/dev/null
DNULL="$(psql_q "select count(*) from tasks where name='smoke-mig-d' and \"consumedFirePointAt\" is null;")"
[[ "$DNULL" == "1" ]] \
  && ok "迁移后新增行 consumedFirePointAt 为 NULL（列无 DEFAULT）" \
  || bad "迁移后新增行 consumedFirePointAt 不为 NULL"
# 重新取基线（此时已有 4 行：a/b/c + d），并取**内容指纹**用于 down 后比对
TASKS_BEFORE="$(psql_q "select count(*) from tasks where name like 'smoke-mig-%';")"
TASKS_FINGERPRINT_BEFORE="$(psql_q "select md5(string_agg(name||'|'||\"triggerType\"||'|'||coalesce(\"cronExpression\",'-')||'|'||\"createdAt\", ',' order by name)) from tasks where name like 'smoke-mig-%';")"
ok "基线：tasks 行数=${TASKS_BEFORE}，内容指纹=$TASKS_FINGERPRINT_BEFORE"

step "3. ② 幂等：重复执行 ADD COLUMN IF NOT EXISTS 不报错"
# 走**真实迁移 SQL**（与迁移文件里逐字相同的 DDL），重复 3 次
IDEM_ERR=0
for i in 1 2 3; do
  if ! docker exec -i "$SMOKE_PG_CONTAINER" psql -U "$SMOKE_PG_USER" -d "$SMOKE_PG_DB" -v ON_ERROR_STOP=1 -c \
    'ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "consumedFirePointAt" TIMESTAMP NULL;' >/tmp/acf-smoke-idem-$i.log 2>&1; then
    IDEM_ERR=$((IDEM_ERR+1))
    echo "    (第 $i 次报错输出)"; cat /tmp/acf-smoke-idem-$i.log
  fi
done
[[ "$IDEM_ERR" == "0" ]] \
  && ok "ADD COLUMN IF NOT EXISTS 重复执行 3 次全部成功（0 报错）" \
  || bad "ADD COLUMN IF NOT EXISTS 有 $IDEM_ERR 次报错"

# 再跑一次完整迁移链 up（无 pending ⇒ no-op，不得炸）
step "4. ② 幂等：整链 migration:run 再跑一次（no-op）"
if OUT="$(migrate up 2>&1)"; then
  ok "migration:run 二次执行成功（no-op）"
  echo "$OUT" | grep -E "No migrations are pending|advisory lock" | sed 's/^/    | /'
else
  bad "migration:run 二次执行失败"; echo "$OUT" | tail -20 | sed 's/^/    | /'
fi

step "5. ③ down：列消失 + 数据无损"
DN_OUT="$(migrate down 2>&1)" || { bad "migration:revert 失败"; echo "$DN_OUT" | tail -20 | sed 's/^/    | /'; }
COL_AFTER_DOWN="$(psql_q "select count(*) from information_schema.columns where table_name='tasks' and column_name='consumedFirePointAt';")"
[[ "$COL_AFTER_DOWN" == "0" ]] \
  && ok "down 后 tasks.consumedFirePointAt 列已消失" \
  || bad "down 后列仍存在（count=${COL_AFTER_DOWN}）"
TASKS_AFTER="$(psql_q "select count(*) from tasks where name like 'smoke-mig-%';")"
TASKS_FINGERPRINT_AFTER="$(psql_q "select md5(string_agg(name||'|'||\"triggerType\"||'|'||coalesce(\"cronExpression\",'-')||'|'||\"createdAt\", ',' order by name)) from tasks where name like 'smoke-mig-%';")"
[[ "$TASKS_AFTER" == "$TASKS_BEFORE" ]] \
  && ok "down 后 tasks 行数不变（$TASKS_BEFORE → ${TASKS_AFTER}，数据无损）" \
  || bad "down 后 tasks 行数变了（$TASKS_BEFORE → ${TASKS_AFTER}）"
[[ "$TASKS_FINGERPRINT_AFTER" == "$TASKS_FINGERPRINT_BEFORE" ]] \
  && ok "down 后 tasks 内容指纹不变（${TASKS_FINGERPRINT_AFTER}）——不只是行数，字段值也无损" \
  || bad "down 后 tasks 内容指纹变了（$TASKS_FINGERPRINT_BEFORE → ${TASKS_FINGERPRINT_AFTER}）"
# down 幂等：再 down 一次（此时最后一条迁移是 1790000000095）
echo "    (二次 down 会回滚 1790000000095，属预期；此处只验证不炸)"
if migrate down >/tmp/acf-smoke-down2.log 2>&1; then
  ok "二次 down 成功（说明 down 路径本身幂等/可重复，不抛异常）"
else
  bad "二次 down 失败"; tail -10 /tmp/acf-smoke-down2.log | sed 's/^/    | /'
fi

step "6. 复原：把 1790000000096 及其后的迁移重新 up 回去"
if migrate up >/tmp/acf-smoke-up2.log 2>&1; then
  COL_BACK="$(psql_q "select count(*) from information_schema.columns where table_name='tasks' and column_name='consumedFirePointAt';")"
  [[ "$COL_BACK" == "1" ]] \
    && ok "复原完成：tasks.consumedFirePointAt 列重新存在（up 幂等可重放）" \
    || bad "复原后列仍不存在"
else
  bad "复原 up 失败"; tail -20 /tmp/acf-smoke-up2.log | sed 's/^/    | /'
fi

# ── 跑后清理（保留；与跑前清理同一实现 ⇒ 同一套口径）─────────────────
# ⚠️ 跑后清理是**锦上添花**：即使这里失败/被中断，**下一次跑**的开头
#   （步骤 0a 的跑前清理）也会把残留清干净 ⇒ 可重入不依赖跑后清理成功。
step "7. 跑后清理（只删本脚本自己造的 smoke-mig-* 数据）"
if smoke_clean_tasks "smoke-mig-" "本脚本只造 smoke-mig-a/b/c/d 四个任务及其子行"; then
  ok "跑后清理完成（本前缀残留 = 0）"
else
  bad "跑后清理失败（不影响可重入：下一次跑的步骤 0a 会再清一次）"
fi

printf '\n=== 场景 1（迁移 1790000000096）小结：PASS=%d FAIL=%d ===\n' "$PASS" "$FAIL"
[[ "$FAIL" == "0" ]] || exit 1
