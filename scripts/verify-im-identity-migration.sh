#!/usr/bin/env bash
#
# verify-im-identity-migration.sh —— 迁移 1790000000104-CreateImIdentities 的
# **真 PG up / 幂等 / down 往返**验收（不是语法对称、不是接口 200）。
#
# 安全边界：
#   · 全部 DDL/DML 只在独立临时库 acf_im_identity_verify_<随机> 内执行；
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

PG_CONTAINER="${IM_VERIFY_PG_CONTAINER:-1Panel-postgresql-cFrN}"
PG_USER="${DB_USERNAME:-autoflow}"
# 维护库：只用来 CREATE/DROP DATABASE，不在里面建表/插数据
MAINT_DB="${DB_DATABASE:-autoflow}"
SUFFIX="$(printf '%s' "$$$(date +%s)" | md5sum | cut -c1-8)"
TEMP_DB="acf_im_identity_verify_${SUFFIX}"

LOG_DIR="$(mktemp -d 2>/dev/null || echo /tmp/acf-imverify-$$)"
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
CREATE TABLE IF NOT EXISTS "im_identities" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "platform" varchar(16) NOT NULL,
  "imSenderId" varchar(128) NOT NULL,
  "platformUserId" int,
  "projectId" varchar,
  "projectRole" varchar(16),
  "verified" boolean NOT NULL DEFAULT false,
  "createdBy" varchar(64),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pk_im_identities" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_im_identities_platform_sender"
ON "im_identities" ("platform", "imSenderId");
CREATE INDEX IF NOT EXISTS "idx_im_identities_platform_user_id"
ON "im_identities" ("platformUserId");
SQL
)"
DOWN_SQL="$(cat <<'SQL'
DROP INDEX IF EXISTS "idx_im_identities_platform_user_id";
DROP INDEX IF EXISTS "uq_im_identities_platform_sender";
DROP TABLE IF EXISTS "im_identities";
SQL
)"

printf '迁移 1790000000104-CreateImIdentities 真 PG 验收\n'
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

step "2. up：在临时库执行迁移 104 的 raw SQL"
if UP_OUT="$(psql_tmp "$UP_SQL" 2>&1)"; then
  ok "up DDL 执行成功（CREATE TABLE + UNIQUE INDEX + INDEX IF NOT EXISTS）"
else
  printf '%s\n' "$UP_OUT" | sed 's/^/    | /'
  bad "up DDL 执行失败"
fi

step "3. 断言表与两个索引真实存在"
TBL="$(psql_tmp "select count(*) from information_schema.tables where table_schema='public' and table_name='im_identities';")"
[[ "$TBL" == "1" ]] && ok 'im_identities 表存在（information_schema）' || bad "im_identities 表不存在（count=${TBL}）"
for IDX in uq_im_identities_platform_sender idx_im_identities_platform_user_id; do
  N="$(psql_tmp "select count(*) from pg_indexes where schemaname='public' and tablename='im_identities' and indexname='${IDX}';")"
  [[ "$N" == "1" ]] && ok "索引 ${IDX} 存在" || bad "索引 ${IDX} 不存在（count=${N}）"
done
UQ_UNIQUE="$(psql_tmp "select count(*) from pg_indexes where schemaname='public' and indexname='uq_im_identities_platform_sender' and indexdef like '%UNIQUE%';")"
[[ "$UQ_UNIQUE" == "1" ]] && ok 'uq_im_identities_platform_sender 确为 UNIQUE 索引' || bad 'uq_im_identities_platform_sender 不是 UNIQUE 索引'

step "4. 插样例行：验证字段默认值 + (platform, imSenderId) 唯一约束"
if psql_tmp "INSERT INTO \"im_identities\" (\"platform\",\"imSenderId\",\"platformUserId\") VALUES ('telegram','sender-001',42);" >"${LOG_DIR}/insert.log" 2>&1; then
  ok "样例 im_identity 行插入成功（NOT NULL 字段齐全）"
else
  sed 's/^/    | /' "${LOG_DIR}/insert.log"
  bad "样例行插入失败"
fi
ROW="$(psql_tmp "select ((\"id\") is not null)::text||'|'||\"platform\"||'|'||\"imSenderId\"||'|'||\"verified\"::text||'|'||((\"createdAt\") is not null)::text||'|'||((\"updatedAt\") is not null)::text||'|'||coalesce(\"platformUserId\"::text,'NULL')||'|'||coalesce(\"projectId\",'NULL')||'|'||coalesce(\"projectRole\",'NULL')||'|'||coalesce(\"createdBy\",'NULL') from \"im_identities\" where \"platform\"='telegram' and \"imSenderId\"='sender-001';" 2>/dev/null || true)"
[[ "$ROW" == "true|telegram|sender-001|false|true|true|42|NULL|NULL|NULL" ]] \
  && ok "默认值实测：${ROW}（verified=false + uuid/时间戳默认命中，可空列为 NULL）" \
  || bad "默认值不符（得到 '${ROW}'）"
if psql_tmp "INSERT INTO \"im_identities\" (\"platform\",\"imSenderId\",\"platformUserId\") VALUES ('telegram','sender-001',99);" >"${LOG_DIR}/dup.log" 2>&1; then
  bad "重复 (platform, imSenderId) 竟然插入成功 ⇒ uq_im_identities_platform_sender 未生效"
elif grep -qi 'duplicate key' "${LOG_DIR}/dup.log"; then
  ok "重复 (platform, imSenderId) 被 uq_im_identities_platform_sender 拒绝（duplicate key value violates unique constraint）"
else
  sed 's/^/    | /' "${LOG_DIR}/dup.log"
  bad "重复 (platform, imSenderId) 插入失败但报错不是 unique 冲突"
fi

step "5. 幂等：重复 up 3 次，不报错且数据不丢"
IDEM_ERR=0
for i in 1 2 3; do
  if psql_tmp "$UP_SQL" >"${LOG_DIR}/idem-${i}.log" 2>&1; then :; else
    IDEM_ERR=$((IDEM_ERR+1)); sed 's/^/    | /' "${LOG_DIR}/idem-${i}.log"
  fi
done
[[ "$IDEM_ERR" == "0" ]] && ok '重复 up 3 次全部成功（IF NOT EXISTS 幂等）' || bad "重复 up 有 ${IDEM_ERR} 次报错"
ROWS="$(psql_tmp 'select count(*) from "im_identities";')"
[[ "$ROWS" == "1" ]] && ok "重复 up 后样例行仍为 1 行（数据未丢、未重建）" || bad "重复 up 后行数变为 ${ROWS}（应为 1）"

step "6. down：DROP 后表与索引消失"
if psql_tmp "$DOWN_SQL" >"${LOG_DIR}/down.log" 2>&1; then
  ok "down DDL 执行成功（逆序 DROP IF EXISTS）"
else
  sed 's/^/    | /' "${LOG_DIR}/down.log"
  bad "down DDL 执行失败"
fi
TBL_AFTER="$(psql_tmp "select count(*) from information_schema.tables where table_schema='public' and table_name='im_identities';")"
[[ "$TBL_AFTER" == "0" ]] && ok 'down 后 im_identities 表已消失' || bad "down 后表仍存在（count=${TBL_AFTER}）"
IDX_AFTER="$(psql_tmp "select count(*) from pg_indexes where schemaname='public' and tablename='im_identities';")"
[[ "$IDX_AFTER" == "0" ]] && ok 'down 后两个索引一并消失' || bad "down 后仍有 ${IDX_AFTER} 个索引残留"

step "7. 往返：down 后再 up，表/索引恢复且无旧数据"
if psql_tmp "$UP_SQL" >"${LOG_DIR}/reup.log" 2>&1; then
  TBL_RE="$(psql_tmp "select count(*) from information_schema.tables where table_schema='public' and table_name='im_identities';")"
  IDX_RE="$(psql_tmp "select count(*) from pg_indexes where schemaname='public' and tablename='im_identities' and indexname in ('uq_im_identities_platform_sender','idx_im_identities_platform_user_id');")"
  ROWS_RE="$(psql_tmp 'select count(*) from "im_identities";')"
  [[ "$TBL_RE" == "1" && "$IDX_RE" == "2" && "$ROWS_RE" == "0" ]] \
    && ok "down→up 往返成功：表 1 / 索引 2 / 旧样例行 0（新表干净）" \
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

printf '\n=== 迁移 1790000000104 真 PG 验收：PASS=%d FAIL=%d ===\n' "$PASS" "$FAIL"
[[ "$FAIL" == "0" ]] || exit 1
exit 0
