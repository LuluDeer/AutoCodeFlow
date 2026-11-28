#!/usr/bin/env bash
#
# verify-migrations-0108-0109-0110.sh
#
# 迁移 1790000000108 / 0109 / 0110 的 **真 PG up → 断言 → down 往返** 验收，
# 外加两条分页复合索引的 EXPLAIN 计划证据。验证级别 = integration（真 PG16
# 容器 + 真 migration-lock-cli.ts，非内存替身、非语法对称检查）。
#
# 覆盖的三条迁移（apps/admin-api/src/migrations）：
#   · 0108 AddExecutionModeSnapshot  : task_executions 加 executeMode/isBroadcast（NULL, 无默认）
#   · 0109 ExecutionArtifactsListIndexes: execution_artifacts 加两条 (维度, createdAt DESC, id DESC) 复合索引
#   · 0110 AlterTaskStatusDefaultPaused: tasks.status DEFAULT 'paused'（down → 'active'）
#
# 安全边界：
#   · 起独立 PG16 容器 acf-mig110-pg（端口 25431），POSTGRES_DB = 随机 throwaway 库；
#   · up 走项目 migration-lock-cli.ts（runMigrations 全链），down 走同一 CLI 的
#     undoLastMigration（每次只回滚最后一条），循环 3 次覆盖 0110→0109→0108；
#   · CLI 子进程用 SELFTEST_SKIP_ENV_FILE=1 + 显式 DB_* 环境变量，绝不整文件
#     source .env（仓库根 .env 的 `OIDC_SCOPES=openid profile email` 会炸 shell）；
#   · 全程只连这个临时库，绝不读写默认 autoflow 库；结束（含中途失败）trap 删容器。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 参考 scripts/verify-capability-migration.sh 的 load_env_var 骨架：按 key 抽取，
# 值不打印、不 export 到全局环境（本脚本容器凭据固定，函数保留用于对齐骨架与
# 未来复用；不整文件 source .env）。
load_env_var() {
  local key="$1" line val
  line="$(grep -m1 "^${key}=" "$ROOT/.env" 2>/dev/null || true)"
  [[ -n "$line" ]] || return 0
  val="${line#*=}"
  val="${val%$'\r'}"
  if [[ "$val" == \"*\" || "$val" == \'*\' ]]; then
    val="${val:1:${#val}-2}"
  fi
  printf '%s' "$val"
}

PG_USER="${MIG110_PG_USER:-autoflow}"
PG_PASS="${MIG110_PG_PASS:-test}"
PG_PORT="${MIG110_PG_PORT:-25431}"
PG_CONTAINER="${MIG110_PG_CONTAINER:-acf-mig110-pg}"
API_DIR="$ROOT/apps/admin-api"
SUFFIX="$(printf '%s' "$$$(date +%s%N)" | md5sum | cut -c1-8)"
DB="acf_mig110_verify_${SUFFIX}"
LOG_DIR="$(mktemp -d 2>/dev/null || echo "/tmp/acf-mig110-$$")"
CONTAINER_STARTED=0

cleanup() {
  local rc=$?
  trap - EXIT
  set +e
  if [[ "$CONTAINER_STARTED" == "1" ]]; then
    docker rm -f "$PG_CONTAINER" >/dev/null 2>&1
    printf '[cleanup] trap：临时容器 %s 已删除\n' "$PG_CONTAINER"
  fi
  rm -rf "$LOG_DIR" 2>/dev/null
  exit "$rc"
}
trap cleanup EXIT

# psql 走容器内 socket（宿主无 psql），只连 throwaway 库。
psql_db() {
  docker exec -i -e PGPASSWORD="$PG_PASS" "$PG_CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$DB" -tAX -c "$1"
}

# CLI 走 host TCP：hermetic env，跳过 .env（OIDC_SCOPES 整文件 source 会炸），
# 用显式 DB_* 把 migration-lock-cli.ts 指向 throwaway 库。
cli() {
  (cd "$API_DIR" && env \
    SELFTEST_SKIP_ENV_FILE=1 NODE_ENV=development \
    DB_HOST=127.0.0.1 DB_PORT="$PG_PORT" \
    DB_USERNAME="$PG_USER" DB_PASSWORD="$PG_PASS" DB_DATABASE="$DB" \
    ./node_modules/.bin/ts-node -r tsconfig-paths/register \
    src/migration-lock-cli.ts "$1")
}

# down 一次：只走项目 CLI。CLI 在 advisory lock 内按「台账最后一条迁移实例的
# transaction=false」动态决定 undoLastMigration 的事务模式：0109 的
# DROP INDEX CONCURRENTLY 自动得到 {transaction:"none"}，普通迁移仍走 "each"。
# 修复后不再保留任何显式 transaction:none 的绕行路径；CLI 失败即为验收失败。
DOWN_MODE=""
down_one() {
  local n="$1"
  DOWN_MODE="cli"
  if cli down >"$LOG_DIR/down-$n.log" 2>&1; then
    ok "down#$n 经 migration-lock-cli.ts 成功（无绕行路径）"
    grep -E 'Down transaction mode' "$LOG_DIR/down-$n.log" | head -1 | sed 's/^/    | /' || true
    return 0
  fi
  bad "down#$n 经 migration-lock-cli.ts 失败（无绕行路径）"
  grep -E 'cannot run|25P02|CONCURRENTLY|error:|failed|migration failed' "$LOG_DIR/down-$n.log" | head -5 | sed 's/^/    | /' || true
  tail -15 "$LOG_DIR/down-$n.log" | sed 's/^/    | /'
  return 1
}

PASS=0; FAIL=0
ok()    { printf '  ✓ %s\n' "$*"; PASS=$((PASS+1)); }
bad()   { printf '  ✗ %s\n' "$*"; FAIL=$((FAIL+1)); }
step()  { printf '\n=== %s ===\n' "$*"; }
block() { printf '\n  ✗ BLOCK: %s\n' "$*" >&2; exit 2; }

printf '迁移 0108/0109/0110 真 PG up→断言→down 往返 + 索引 EXPLAIN 验收\n'
printf '  验证级别：integration（真 PG16 容器 + 真 migration-lock-cli.ts）\n'
printf '  容器=%s 端口=%s 临时库=%s 账号=%s\n' "$PG_CONTAINER" "$PG_PORT" "$DB" "$PG_USER"

step "0. 预检"
command -v docker >/dev/null 2>&1 || block "docker 不在 PATH"
[[ -x "$API_DIR/node_modules/.bin/ts-node" ]] || block "admin-api ts-node 不可用"
N_MIG="$(find "$API_DIR/src/migrations" -maxdepth 1 -type f -name '*.ts' \
  ! -name '*.spec.ts' ! -name '*.d.ts' | wc -l | tr -d ' ')"
echo "  在盘迁移数 N=$N_MIG"

step "1. 起临时 PG16 容器（不动默认 autoflow 库）"
docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
if docker run -d --name "$PG_CONTAINER" \
  -e POSTGRES_USER="$PG_USER" -e POSTGRES_PASSWORD="$PG_PASS" \
  -e POSTGRES_DB="$DB" -p "${PG_PORT}:5432" \
  postgres:16-alpine >"$LOG_DIR/docker-run.log" 2>&1; then
  CONTAINER_STARTED=1
  ok "容器 $PG_CONTAINER 已启动（POSTGRES_DB=${DB}）"
else
  sed 's/^/    | /' "$LOG_DIR/docker-run.log"
  block "容器启动失败"
fi

step "2. 等 PG ready"
READY=0
for _ in $(seq 1 60); do
  if docker exec -i "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$DB" >/dev/null 2>&1; then
    READY=1; break
  fi
  sleep 1
done
[[ "$READY" == "1" ]] && ok "PG ready（pg_isready）" || block "PG 60s 未就绪"

step "3. up：走项目 migration-lock-cli.ts 跑全链（含 0108/0109/0110）"
if cli up >"$LOG_DIR/up.log" 2>&1; then
  ok "migration-lock-cli.ts up 成功（runMigrations 全链）"
else
  tail -50 "$LOG_DIR/up.log" | sed 's/^/    | /'
  block "up 失败，后续断言无意义"
fi
echo "  up 日志尾部摘要："
grep -E 'migration-lock|MIGRATED|PENDING|No migrations' "$LOG_DIR/up.log" | tail -10 | sed 's/^/    | /' || true

step "4. 断言 up 后三条迁移落库状态"
LEDGER="$(psql_db 'SELECT count(*)::text FROM migrations;')"
[[ "$LEDGER" == "$N_MIG" ]] \
  && ok "migrations 台账 count=$LEDGER == 在盘迁移数 $N_MIG" \
  || bad "台账 count=$LEDGER != 在盘 $N_MIG"

for COL in executeMode isBroadcast; do
  R="$(psql_db "SELECT coalesce(is_nullable,'?')||'|'||coalesce(column_default,'<NULL>') FROM information_schema.columns WHERE table_schema='public' AND table_name='task_executions' AND column_name='$COL';")"
  [[ "$R" == "YES|<NULL>" ]] \
    && ok "$COL 存在且 nullable=YES / default=NULL（实测 ${R}）" \
    || bad "$COL 列属性异常（实测 '$R'）"
done

for IDX in idx_execution_artifacts_task_created_at_id idx_execution_artifacts_application_created_at_id; do
  V="$(psql_db "SELECT pi.indisvalid::text FROM pg_index pi JOIN pg_class pc ON pc.oid=pi.indexrelid WHERE pc.relname='$IDX';")"
  [[ "$V" == "t" || "$V" == "true" ]] \
    && ok "$IDX indisvalid=$V" || bad "$IDX indisvalid=${V:-<缺失>}"
done
# PG 的 indexdef 只给需要引号的标识符加引号：小写 id 无引号，故先剥引号再比对列序/方向。
D1="$(psql_db "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='idx_execution_artifacts_task_created_at_id';" | tr -d '"')"
[[ "$D1" == *'taskId, createdAt DESC, id DESC'* ]] \
  && ok "task 索引列序/方向正确：$D1" || bad "task 索引定义异常：$D1"
D2="$(psql_db "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='idx_execution_artifacts_application_created_at_id';" | tr -d '"')"
[[ "$D2" == *'applicationId, createdAt DESC, id DESC'* ]] \
  && ok "application 索引列序/方向正确：$D2" || bad "application 索引定义异常：$D2"

SD="$(psql_db "SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='tasks' AND column_name='status';")"
[[ "$SD" == *paused* ]] \
  && ok "tasks.status default=$SD" || bad "tasks.status default 异常（'$SD'）"

step "5. 造最小可行数据 + 两条 EXPLAIN（索引证据）"
# 用 replica 角色临时绕过 FK（executionId→task_executions、applicationId→applications），
# 只为造索引选择所需数据分布；SET/INSERT/RESET 必须在同一连接（同一 psql -c）内。
psql_db "SET session_replication_role = replica;
INSERT INTO \"execution_artifacts\" (\"executionId\",\"taskId\",\"applicationId\",\"name\",\"size\",\"sha256\",\"createdAt\")
SELECT gen_random_uuid(),
  (ARRAY['11111111-1111-4111-8111-111111111111'::uuid,'22222222-2222-4222-8222-222222222222'::uuid,'33333333-3333-4333-8333-333333333333'::uuid])[(i-1)%3+1],
  (ARRAY['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid])[(i-1)%2+1],
  'art-'||i, 100, repeat('a',64),
  timestamp '2026-01-01 00:00:00' + (i::text||' seconds')::interval
FROM generate_series(1,3000) i;
RESET session_replication_role;" >"$LOG_DIR/seed.log" 2>&1 \
  && ok "造数 3000 行 execution_artifacts（3 taskId × 2 applicationId）" \
  || { sed 's/^/    | /' "$LOG_DIR/seed.log"; bad "造数失败"; }
psql_db 'ANALYZE execution_artifacts;' >/dev/null 2>&1 \
  && ok "ANALYZE execution_artifacts（统计生效）" || bad "ANALYZE 失败"

PLAN_T="$(psql_db "EXPLAIN (COSTS OFF) SELECT * FROM execution_artifacts WHERE \"taskId\" = '11111111-1111-4111-8111-111111111111' ORDER BY \"createdAt\" DESC, \"id\" DESC LIMIT 20;")"
echo "  --- EXPLAIN taskId 过滤 + ORDER BY createdAt DESC, id DESC ---"
printf '%s\n' "$PLAN_T" | sed 's/^/    | /'
if printf '%s\n' "$PLAN_T" | grep -qE 'Index (Only )?Scan using idx_execution_artifacts_task_created_at_id'; then
  ok "taskId 查询走 idx_execution_artifacts_task_created_at_id"
else
  bad "taskId 查询未走目标索引（可能 Seq Scan，数据不足或计划器不同）"
fi
if printf '%s\n' "$PLAN_T" | grep -qE '^[[:space:]]*Sort[[:space:]]'; then
  bad "taskId 查询存在外部 Sort 节点"
else
  ok "taskId 查询无外部 Sort（索引已提供顺序）"
fi

PLAN_A="$(psql_db "EXPLAIN (COSTS OFF) SELECT * FROM execution_artifacts WHERE \"applicationId\" = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' ORDER BY \"createdAt\" DESC, \"id\" DESC LIMIT 20;")"
echo "  --- EXPLAIN applicationId 过滤 + ORDER BY createdAt DESC, id DESC ---"
printf '%s\n' "$PLAN_A" | sed 's/^/    | /'
if printf '%s\n' "$PLAN_A" | grep -qE 'Index (Only )?Scan using idx_execution_artifacts_application_created_at_id'; then
  ok "applicationId 查询走 idx_execution_artifacts_application_created_at_id"
else
  bad "applicationId 查询未走目标索引（可能 Seq Scan，数据不足或计划器不同）"
fi
if printf '%s\n' "$PLAN_A" | grep -qE '^[[:space:]]*Sort[[:space:]]'; then
  bad "applicationId 查询存在外部 Sort 节点"
else
  ok "applicationId 查询无外部 Sort（索引已提供顺序）"
fi

col_present() {
  psql_db "SELECT count(*)::text FROM information_schema.columns WHERE table_schema='public' AND table_name='task_executions' AND column_name='$1';"
}
idx_present() {
  psql_db "SELECT count(*)::text FROM pg_index pi JOIN pg_class pc ON pc.oid=pi.indexrelid WHERE pc.relname='$1';"
}
status_default() {
  psql_db "SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='tasks' AND column_name='status';"
}

step "6. down ×3：undoLastMigration 逐条回滚 0110 → 0109 → 0108"

# --- down #1: 回滚 0110（status default → active）---
down_one 1 || true
S1="$(status_default)"
[[ "$S1" == *active* ]] && ok "down#1 后 tasks.status default=${S1}（0110 已回滚）" || bad "down#1 后 status default 仍非 active（'$S1'）"
[[ "$(col_present executeMode)" == "1" && "$(col_present isBroadcast)" == "1" ]] \
  && ok "down#1 后 0108 两列仍在（符合逐条回滚）" || bad "down#1 后 0108 两列异常消失"
[[ "$(idx_present idx_execution_artifacts_task_created_at_id)" == "1" && "$(idx_present idx_execution_artifacts_application_created_at_id)" == "1" ]] \
  && ok "down#1 后 0109 两索引仍在" || bad "down#1 后 0109 索引异常消失"

# --- down #2: 回滚 0109（两索引消失）---
down_one 2 || true
[[ "$(idx_present idx_execution_artifacts_task_created_at_id)" == "0" && "$(idx_present idx_execution_artifacts_application_created_at_id)" == "0" ]] \
  && ok "down#2 后 0109 两索引已消失" || bad "down#2 后 0109 索引仍残留"
[[ "$(col_present executeMode)" == "1" && "$(col_present isBroadcast)" == "1" ]] \
  && ok "down#2 后 0108 两列仍在" || bad "down#2 后 0108 两列异常消失"
S2="$(status_default)"
[[ "$S2" == *active* ]] && ok "down#2 后 status default 仍 active（'$S2'）" || bad "down#2 后 status default 异常（'$S2'）"

# --- down #3: 回滚 0108（两列消失）---
down_one 3 || true
[[ "$(col_present executeMode)" == "0" && "$(col_present isBroadcast)" == "0" ]] \
  && ok "down#3 后 0108 两列 executeMode/isBroadcast 已消失" || bad "down#3 后 0108 两列仍残留"
[[ "$(idx_present idx_execution_artifacts_task_created_at_id)" == "0" ]] \
  && ok "down#3 后 0109 索引保持消失" || bad "down#3 后 0109 索引复活"
S3="$(status_default)"
[[ "$S3" == *active* ]] && ok "down#3 后 tasks.status default=${S3}（回到 active）" || bad "down#3 后 status default 异常（'$S3'）"
LEDGER_END="$(psql_db 'SELECT count(*)::text FROM migrations;')"
EXP_END=$((N_MIG - 3))
[[ "$LEDGER_END" == "$EXP_END" ]] \
  && ok "往返后台账 count=$LEDGER_END == N-3=${EXP_END}（三条各回滚一次）" \
  || bad "往返后台账 count=$LEDGER_END != 期望 $EXP_END"

step "7. 清理临时 PG"
if docker rm -f "$PG_CONTAINER" >/dev/null 2>&1; then
  CONTAINER_STARTED=0
  ok "临时容器 $PG_CONTAINER 已删除（默认 autoflow 库全程未被读写）"
else
  bad "临时容器删除失败（trap 会再试）"
fi

printf '\n=== 迁移 0108/0109/0110 真 PG 验收：PASS=%d FAIL=%d（integration） ===\n' "$PASS" "$FAIL"
printf '  备注①：down#1/#2/#3 全部经项目 CLI migration-lock-cli.ts 完成（DOWN_MODE=%s），\n' "$DOWN_MODE"
printf '        无显式 transaction:none 绕行；0109 的 DROP INDEX CONCURRENTLY 由 CLI 依迁移实例\n'
printf '        transaction=false 自动选择 undoLastMigration({transaction:"none"})，普通迁移仍走事务。\n'
printf '  备注②：EXPLAIN 走目标索引且无外部 Sort；台账 count=N-3 验证三条各回滚一次。\n'
[[ "$FAIL" == "0" ]] || exit 1
exit 0
