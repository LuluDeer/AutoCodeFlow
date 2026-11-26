#!/usr/bin/env bash
#
# verify-capability-activation-migration.sh —— 迁移 1790000000105-CreateCapabilityActivationLog 的
# **真 PG up / 幂等 / down 往返**验收（不是语法对称、不是接口 200）。
#
# 安全边界：
#   · 全部 DDL/DML 只在独立临时库 acf_cap_activation_verify_<随机> 内执行；
#   · 绝不读写 autoflow 业务库的任何表（只用它做 CREATE/DROP DATABASE 的维护连接）；
#   · 连接账号沿用 .env 的 DB_USERNAME / DB_PASSWORD，不猜 postgres 超级用户密码；
#   · 结束（含中途失败）一律 DROP DATABASE 清理。
#
# 迁移实现是 QueryRunner.raw SQL（CREATE TABLE / INDEX IF NOT EXISTS，
# down 逆序 DROP IF EXISTS），下面的 UP_SQL / DOWN_SQL 与其逐字等价。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 自建连接参数：独立于 /tmp/acf-smoke-env.sh
# .env 里有未加引号的 `OIDC_SCOPES=openid profile email`，整文件 source 会炸；
# 只按 key 抽取需要的三行（值不打印、不 export 到全局环境）。
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
DB_USERNAME="$(load_env_var DB_USERNAME)"; DB_USERNAME="${DB_USERNAME:-autoflow}"
DB_PASSWORD="$(load_env_var DB_PASSWORD)"
DB_DATABASE="$(load_env_var DB_DATABASE)"; DB_DATABASE="${DB_DATABASE:-autoflow}"

PG_CONTAINER="${CAP_ACT_VERIFY_PG_CONTAINER:-1Panel-postgresql-cFrN}"
PG_USER="${DB_USERNAME:-autoflow}"
# 维护库：只用来 CREATE/DROP DATABASE，不在里面建表/插数据
MAINT_DB="${DB_DATABASE:-autoflow}"
SUFFIX="$(printf '%s' "$$$(date +%s)" | md5sum | cut -c1-8)"
TEMP_DB="acf_cap_activation_verify_${SUFFIX}"

LOG_DIR="$(mktemp -d 2>/dev/null || echo /tmp/acf-capactverify-$$)"
DB_CREATED=0

cleanup() {
  local rc=$?
  trap - EXIT
  # 停库/无权限时也要清；IF EXISTS 保证重复无害
  if [[ "$DB_CREATED" == "1" ]]; then
    docker exec -i -e PGPASSWORD="${DB_PASSWORD:-}" "$PG_CONTAINER" \
      psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$MAINT_DB" -tAX \
      -c "DROP DATABASE IF EXISTS \"${TEMP_DB}\";" >/dev/null 2>&1 || true
  fi
  rm -rf "$LOG_DIR" 2>/dev/null || true
  exit "$rc"
}
trap cleanup EXIT

psql_maint() {
  docker exec -i -e PGPASSWORD="${DB_PASSWORD:-}" "$PG_CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$MAINT_DB" -tAX -c "$1"
}
psql_tmp() {
  docker exec -i -e PGPASSWORD="${DB_PASSWORD:-}" "$PG_CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$TEMP_DB" -tAX -c "$1"
}

PASS=0; FAIL=0
ok()   { printf '  ✓ %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  ✗ %s\n' "$*"; FAIL=$((FAIL+1)); }
step() { printf '\n=== %s ===\n' "$*"; }
block() {
  printf '\n  ✗ BLOCK: %s\n' "$*" >&2
  printf '\n=== BLOCKED（未伪造通过）：PASS=%d FAIL=%d ===\n' "$PASS" "$FAIL" >&2
  exit 2
}

UP_SQL="$(cat <<'SQL'
CREATE TABLE IF NOT EXISTS "capability_activation_log" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "capabilityKey" varchar(128) NOT NULL,
  "capabilityVersion" varchar(32),
  "sessionId" varchar(128),
  "parametersDigest" varchar(64) NOT NULL,
  "userId" int,
  "username" varchar,
  "imPlatform" varchar(16),
  "imSenderId" varchar(128),
  "projectId" varchar,
  "result" varchar(16) NOT NULL DEFAULT 'success',
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pk_capability_activation_log" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_cap_activation_key_created_at"
ON "capability_activation_log" ("capabilityKey", "createdAt");
CREATE INDEX IF NOT EXISTS "idx_cap_activation_user_created_at"
ON "capability_activation_log" ("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "idx_cap_activation_project_created_at"
ON "capability_activation_log" ("projectId", "createdAt");
CREATE INDEX IF NOT EXISTS "idx_cap_activation_session"
ON "capability_activation_log" ("sessionId");
SQL
)"
DOWN_SQL="$(cat <<'SQL'
DROP INDEX IF EXISTS "idx_cap_activation_session";
DROP INDEX IF EXISTS "idx_cap_activation_project_created_at";
DROP INDEX IF EXISTS "idx_cap_activation_user_created_at";
DROP INDEX IF EXISTS "idx_cap_activation_key_created_at";
DROP TABLE IF EXISTS "capability_activation_log";
SQL
)"

printf '迁移 1790000000105-CreateCapabilityActivationLog 真 PG 验收\n'
printf '  容器=%s 维护库=%s 账号=%s 临时库=%s\n' \
  "$PG_CONTAINER" "$MAINT_DB" "$PG_USER" "$TEMP_DB"

step "0. 预检：docker/PG 可达（autoflow 账号）"
if PING="$(psql_maint 'select 1;' 2>&1)"; then
  [[ "$PING" == "1" ]] && ok "维护库连接成功（select 1 = 1）" || bad "select 1 返回非 1：'${PING}'"
else
  block "连不上 ${PG_CONTAINER} 的 ${MAINT_DB}（docker/PG 不可达或凭据错）：$(printf '%s' "$PING" | tail -3)"
fi

step "1. 建独立临时库（不碰 autoflow 业务数据）"
if CREATE_OUT="$(psql_maint "CREATE DATABASE \"${TEMP_DB}\";" 2>&1)"; then
  DB_CREATED=1
  ok "临时库 ${TEMP_DB} 已创建"
else
  block "autoflow 账号建库失败（无 CREATEDB 或 PG 异常），不强试 postgres：$(printf '%s' "$CREATE_OUT" | tail -3)"
fi

step "2. up：在临时库执行迁移 105 的 raw SQL"
if UP_OUT="$(psql_tmp "$UP_SQL" 2>&1)"; then
  ok "up DDL 执行成功（CREATE TABLE + 4 × CREATE INDEX IF NOT EXISTS）"
else
  printf '%s\n' "$UP_OUT" | sed 's/^/    | /'
  bad "up DDL 执行失败"
fi

step "3. 断言表与四个索引真实存在"
TBL="$(psql_tmp "select count(*) from information_schema.tables where table_schema='public' and table_name='capability_activation_log';")"
[[ "$TBL" == "1" ]] && ok 'capability_activation_log 表存在（information_schema）' || bad "capability_activation_log 表不存在（count=${TBL}）"
for IDX in idx_cap_activation_key_created_at idx_cap_activation_user_created_at idx_cap_activation_project_created_at idx_cap_activation_session; do
  N="$(psql_tmp "select count(*) from pg_indexes where schemaname='public' and tablename='capability_activation_log' and indexname='${IDX}';")"
  [[ "$N" == "1" ]] && ok "索引 ${IDX} 存在" || bad "索引 ${IDX} 不存在（count=${N}）"
done

step "4. 插样例行：默认值 / parametersDigest NOT NULL / 无明文参数列"
PLAIN_COLS="$(psql_tmp "select count(*) from information_schema.columns where table_schema='public' and table_name='capability_activation_log' and lower(column_name) in ('parameters','detail','params','payload','content','arguments','input','rawparameters','parametersjson');")"
[[ "$PLAIN_COLS" == "0" ]] && ok '表无 parameters/detail 等明文参数列（只存 parametersDigest）' || bad "发现 ${PLAIN_COLS} 个疑似明文参数列"
DIGEST_NULLABLE="$(psql_tmp "select is_nullable from information_schema.columns where table_schema='public' and table_name='capability_activation_log' and column_name='parametersDigest';")"
[[ "$DIGEST_NULLABLE" == "NO" ]] && ok 'parametersDigest 列 NOT NULL（is_nullable=NO）' || bad "parametersDigest 可空（is_nullable=${DIGEST_NULLABLE}）"
CREATED_DEFAULT="$(psql_tmp "select count(*) from information_schema.columns where table_schema='public' and table_name='capability_activation_log' and column_name='createdAt' and column_default like '%now()%';")"
[[ "$CREATED_DEFAULT" == "1" ]] && ok 'createdAt 默认值含 now()（information_schema）' || bad 'createdAt 默认值不是 now()'
if psql_tmp "INSERT INTO \"capability_activation_log\" (\"capabilityKey\") VALUES ('acf-verify-cap-act-missing-digest');" >"${LOG_DIR}/missing-digest.log" 2>&1; then
  bad '缺少 parametersDigest 竟然插入成功 ⇒ NOT NULL 未生效'
elif grep -Eqi 'not[- ]null' "${LOG_DIR}/missing-digest.log"; then
  ok '缺 parametersDigest 插入被 NOT NULL 约束拒绝'
else
  sed 's/^/    | /' "${LOG_DIR}/missing-digest.log"
  bad '缺 parametersDigest 插入失败但报错不是 not null 约束'
fi
if psql_tmp "INSERT INTO \"capability_activation_log\" (\"capabilityKey\",\"parametersDigest\") VALUES ('acf-verify-cap-act-001','sha256-verify-digest-001');" >"${LOG_DIR}/insert.log" 2>&1; then
  ok "样例行插入成功（仅必填列，依赖其余列默认值）"
else
  sed 's/^/    | /' "${LOG_DIR}/insert.log"
  bad "样例行插入失败"
fi
ROW="$(psql_tmp "select (\"id\" is not null)::text||'|'||\"capabilityKey\"||'|'||coalesce(\"capabilityVersion\",'NULL')||'|'||coalesce(\"sessionId\",'NULL')||'|'||\"parametersDigest\"||'|'||\"result\"||'|'||(\"createdAt\" is not null)::text||'|'||coalesce(\"userId\"::text,'NULL')||'|'||coalesce(\"username\",'NULL')||'|'||coalesce(\"imPlatform\",'NULL')||'|'||coalesce(\"imSenderId\",'NULL')||'|'||coalesce(\"projectId\",'NULL') from \"capability_activation_log\" where \"capabilityKey\"='acf-verify-cap-act-001';" 2>/dev/null || true)"
[[ "$ROW" == "true|acf-verify-cap-act-001|NULL|NULL|sha256-verify-digest-001|success|true|NULL|NULL|NULL|NULL|NULL" ]] \
  && ok "默认值实测：${ROW}（result=success + uuid/createdAt 默认命中，可空列为 NULL）" \
  || bad "默认值不符（得到 '${ROW}'）"

step "5. 幂等：重复 up 3 次，不报错且数据不丢"
IDEM_ERR=0
for i in 1 2 3; do
  if psql_tmp "$UP_SQL" >"${LOG_DIR}/idem-${i}.log" 2>&1; then :; else
    IDEM_ERR=$((IDEM_ERR+1)); sed 's/^/    | /' "${LOG_DIR}/idem-${i}.log"
  fi
done
[[ "$IDEM_ERR" == "0" ]] && ok '重复 up 3 次全部成功（IF NOT EXISTS 幂等）' || bad "重复 up 有 ${IDEM_ERR} 次报错"
ROWS="$(psql_tmp 'select count(*) from "capability_activation_log";')"
[[ "$ROWS" == "1" ]] && ok "重复 up 后样例行仍为 1 行（数据未丢、未重建）" || bad "重复 up 后行数变为 ${ROWS}（应为 1）"
IDX_IDEM="$(psql_tmp "select count(*) from pg_indexes where schemaname='public' and tablename='capability_activation_log' and indexname in ('idx_cap_activation_key_created_at','idx_cap_activation_user_created_at','idx_cap_activation_project_created_at','idx_cap_activation_session');")"
[[ "$IDX_IDEM" == "4" ]] && ok '重复 up 后仍恰为 4 个索引（未重复创建）' || bad "重复 up 后索引数为 ${IDX_IDEM}（应为 4）"

step "6. down：DROP 后表与索引消失"
if psql_tmp "$DOWN_SQL" >"${LOG_DIR}/down.log" 2>&1; then
  ok "down DDL 执行成功（逆序 DROP IF EXISTS）"
else
  sed 's/^/    | /' "${LOG_DIR}/down.log"
  bad "down DDL 执行失败"
fi
TBL_AFTER="$(psql_tmp "select count(*) from information_schema.tables where table_schema='public' and table_name='capability_activation_log';")"
[[ "$TBL_AFTER" == "0" ]] && ok 'down 后 capability_activation_log 表已消失' || bad "down 后表仍存在（count=${TBL_AFTER}）"
IDX_AFTER="$(psql_tmp "select count(*) from pg_indexes where schemaname='public' and tablename='capability_activation_log';")"
[[ "$IDX_AFTER" == "0" ]] && ok 'down 后四个索引一并消失' || bad "down 后仍有 ${IDX_AFTER} 个索引残留"

step "7. 往返：down 后再 up，表/索引恢复且无旧数据"
if psql_tmp "$UP_SQL" >"${LOG_DIR}/reup.log" 2>&1; then
  TBL_RE="$(psql_tmp "select count(*) from information_schema.tables where table_schema='public' and table_name='capability_activation_log';")"
  IDX_RE="$(psql_tmp "select count(*) from pg_indexes where schemaname='public' and tablename='capability_activation_log' and indexname in ('idx_cap_activation_key_created_at','idx_cap_activation_user_created_at','idx_cap_activation_project_created_at','idx_cap_activation_session');")"
  ROWS_RE="$(psql_tmp 'select count(*) from "capability_activation_log";')"
  [[ "$TBL_RE" == "1" && "$IDX_RE" == "4" && "$ROWS_RE" == "0" ]] \
    && ok "down→up 往返成功：表 1 / 索引 4 / 旧样例行 0（新表干净）" \
    || bad "往返后状态异常：表=${TBL_RE} 索引=${IDX_RE} 行数=${ROWS_RE}"
else
  sed 's/^/    | /' "${LOG_DIR}/reup.log"
  bad "down 后重新 up 失败"
fi

step "8. 清理：DROP 临时库"
if psql_maint "DROP DATABASE IF EXISTS \"${TEMP_DB}\";" >"${LOG_DIR}/drop.log" 2>&1; then
  DB_CREATED=0
  ok "临时库 ${TEMP_DB} 已删除（autoflow 业务库全程未被 DDL/DML 触碰）"
else
  sed 's/^/    | /' "${LOG_DIR}/drop.log"
  bad "临时库删除失败（退出 trap 会再试一次）"
fi

printf '\n=== 迁移 1790000000105 真 PG 验收：PASS=%d FAIL=%d ===\n' "$PASS" "$FAIL"
[[ "$FAIL" == "0" ]] || exit 1
exit 0
