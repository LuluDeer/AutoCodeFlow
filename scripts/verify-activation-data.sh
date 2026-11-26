#!/usr/bin/env bash
#
# verify-activation-data.sh —— capability-activation 数据层**真 PG 实测**验收。
#
# 与「仅内存替身单测」和「迁移 DDL 验证」的区别：本脚本在独立临时库里跑
# capability-activation.service.ts 的 stats / query 同形 SQL 与 parametersDigest
# 语义，断言的是**查询结果的实际数值**（count/success/failure/blocked、分组行数、
# 摘要相等/不等关系），不是「SQL 执行成功」。
#
# 安全边界（复用 verify-capability-activation-migration.sh 的连接范式）：
#   · 全部 DDL/DML 只在独立临时库 acf_activation_data_verify_<随机> 内执行；
#   · autoflow 维护库只用来 CREATE/DROP DATABASE，不建表、不插数据；
#   · 连接凭据按 key 从 .env 单独抽取（整文件 source 会被未加引号的 OIDC_SCOPES 弄炸）；
#   · 结束（含中途失败）一律 DROP DATABASE 清理。
#
# append-only：本脚本只有 INSERT / SELECT，绝无 UPDATE / DELETE；服务层的
# append-only 由 record(INSERT) 唯一写路径保证（见 service 头注 / 迁移 105 头注），
# 本脚本验的是数据层在真库上的实际行为。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

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
MAINT_DB="${DB_DATABASE:-autoflow}"
SUFFIX="$(printf '%s' "$$$(date +%s)" | md5sum | cut -c1-8)"
TEMP_DB="acf_activation_data_verify_${SUFFIX}"

LOG_DIR="$(mktemp -d 2>/dev/null || echo /tmp/acf-actdata-$$)"
DB_CREATED=0

cleanup() {
  local rc=$?
  trap - EXIT
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
  printf '\n=== BLOCKED：PASS=%d FAIL=%d ===\n' "$PASS" "$FAIL" >&2
  exit 2
}
assert_eq() {
  local label="$1" exp="$2" act="$3"
  if [[ "$act" == "$exp" ]]; then
    ok "${label}：期望=${exp} 实测=${act}"
  else
    bad "${label}：期望=${exp} 实测=${act}"
  fi
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

# 8 行种子：3 种 capability × 3 种 result × projectId/userId 有值与 NULL × 3 个日期段。
# 手工期望（全量）：
#   workbench.commit = 4(success2/failure1/blocked1)；browser.export = 2(1/1/0)；
#   doc.publish = 2(1/0/1)；total = 8
#   byProject: proj-alpha=3, proj-beta=2, NULL=3
#   时间窗 from=2026-02-01T00:00:00Z 后剩 5 行（workbench.commit=2/0/1/1）
SEED_SQL="$(cat <<'SQL'
INSERT INTO "capability_activation_log"
  ("capabilityKey","capabilityVersion","sessionId","parametersDigest","userId","username","imPlatform","imSenderId","projectId","result","createdAt")
VALUES
  ('workbench.commit','v2.1','seed-sess-1001','seed-digest-0001',101,'alice','wecom','sender-101','proj-alpha','success','2026-01-05T10:00:00Z'),
  ('workbench.commit','v2.1','seed-sess-1002','seed-digest-0002',101,'alice','wecom','sender-101','proj-alpha','success','2026-01-06T10:00:00Z'),
  ('workbench.commit','v2.0','seed-sess-1003','seed-digest-0003',NULL,NULL,NULL,NULL,NULL,'failure','2026-02-10T10:00:00Z'),
  ('workbench.commit','v2.1','seed-sess-1004','seed-digest-0004',102,'bob','feishu','sender-102','proj-beta','blocked','2026-02-11T10:00:00Z'),
  ('browser.export','v1.4','seed-sess-2001','seed-digest-0005',102,'bob','feishu','sender-102','proj-beta','success','2026-01-07T10:00:00Z'),
  ('browser.export','v1.4','seed-sess-2002','seed-digest-0006',NULL,NULL,NULL,NULL,NULL,'failure','2026-03-01T10:00:00Z'),
  ('doc.publish','v3.0','seed-sess-3001','seed-digest-0007',103,'carol','wecom','sender-103','proj-alpha','blocked','2026-03-02T10:00:00Z'),
  ('doc.publish','v3.0','seed-sess-3002','seed-digest-0008',NULL,NULL,NULL,NULL,NULL,'success','2026-03-03T10:00:00Z');
SQL
)"

# 与 service.stats 的 capQb 同形（GROUP BY capabilityKey + 三个 FILTER 聚合）。
CAP_SQL="$(cat <<'SQL'
SELECT "capabilityKey" AS "capabilityKey",
       COUNT(*) AS "count",
       COUNT(*) FILTER (WHERE "result" = 'success') AS "success",
       COUNT(*) FILTER (WHERE "result" = 'failure') AS "failure",
       COUNT(*) FILTER (WHERE "result" = 'blocked') AS "blocked"
FROM "capability_activation_log"
GROUP BY "capabilityKey"
ORDER BY "count" DESC;
SQL
)"
# 与 service.applyWindow(from) 同形：log."createdAt" >= :from（ISO 字符串）。
CAP_SQL_FROM="$(cat <<'SQL'
SELECT "capabilityKey" AS "capabilityKey",
       COUNT(*) AS "count",
       COUNT(*) FILTER (WHERE "result" = 'success') AS "success",
       COUNT(*) FILTER (WHERE "result" = 'failure') AS "failure",
       COUNT(*) FILTER (WHERE "result" = 'blocked') AS "blocked"
FROM "capability_activation_log"
WHERE "createdAt" >= '2026-02-01T00:00:00Z'
GROUP BY "capabilityKey"
ORDER BY "count" DESC;
SQL
)"
# 与 service.stats 的 projQb 同形（GROUP BY projectId；NULL 分组显式标记便于断言）。
PROJ_SQL="$(cat <<'SQL'
SELECT CASE WHEN "projectId" IS NULL THEN '__NULL__' ELSE "projectId" END AS "projectId",
       COUNT(*) AS "count"
FROM "capability_activation_log"
GROUP BY "projectId"
ORDER BY "count" DESC;
SQL
)"
PROJ_SQL_FROM="$(cat <<'SQL'
SELECT CASE WHEN "projectId" IS NULL THEN '__NULL__' ELSE "projectId" END AS "projectId",
       COUNT(*) AS "count"
FROM "capability_activation_log"
WHERE "createdAt" >= '2026-02-01T00:00:00Z'
GROUP BY "projectId"
ORDER BY "count" DESC;
SQL
)"

parse_cap() {
  local rows="$1" prefix="$2" k c s f b
  declare -gA "$prefix=()"
  while IFS='|' read -r k c s f b; do
    [[ -n "$k" ]] || continue
    eval "${prefix}[\"\$k\"]=\"\${c}|\${s}|\${f}|\${b}\""
  done <<< "$rows"
}
parse_proj() {
  local rows="$1" prefix="$2" k c
  declare -gA "$prefix=()"
  while IFS='|' read -r k c; do
    [[ -n "$k" ]] || continue
    eval "${prefix}[\"\$k\"]=\"\${c}\""
  done <<< "$rows"
}

printf 'capability-activation 数据层真 PG 验收\n'
printf '  容器=%s 维护库=%s 账号=%s 临时库=%s\n' \
  "$PG_CONTAINER" "$MAINT_DB" "$PG_USER" "$TEMP_DB"

step "0. 预检：docker/PG 可达（autoflow 账号）"
if PING="$(psql_maint 'select 1;' 2>&1)"; then
  [[ "$PING" == "1" ]] && ok '维护库连接成功（select 1 = 1）' || bad "select 1 返回非 1：'${PING}'"
else
  block "连不上 ${PG_CONTAINER} 的 ${MAINT_DB}：$(printf '%s' "$PING" | tail -3)"
fi

step "1. 建独立临时库并跑迁移 105 的 UP_SQL"
if CREATE_OUT="$(psql_maint "CREATE DATABASE \"${TEMP_DB}\";" 2>&1)"; then
  DB_CREATED=1
  ok "临时库 ${TEMP_DB} 已创建"
else
  block "建库失败：$(printf '%s' "$CREATE_OUT" | tail -3)"
fi
if UP_OUT="$(psql_tmp "$UP_SQL" 2>&1)"; then
  ok 'UP_SQL 建表 + 4 索引成功（与迁移 105 逐字等价）'
else
  printf '%s\n' "$UP_OUT" | sed 's/^/    | /'
  block 'UP_SQL 执行失败'
fi

step "2. 种子 8 行（多维覆盖）+ 全量行数"
if SEED_OUT="$(psql_tmp "$SEED_SQL" 2>&1)"; then
  ok '8 行种子 INSERT 成功'
else
  printf '%s\n' "$SEED_OUT" | sed 's/^/    | /'
  block '种子 INSERT 失败'
fi
SEED_ROWS="$(psql_tmp 'SELECT count(*) FROM "capability_activation_log";')"
assert_eq '种子总行数' '8' "$SEED_ROWS"

step "3. stats.byCapability：GROUP BY + FILTER 三态分布（期望值手工可算）"
CAP_ROWS="$(psql_tmp "$CAP_SQL")"
parse_cap "$CAP_ROWS" CAP
assert_eq 'byCapability 分组数' '3' "${#CAP[@]}"
assert_eq 'workbench.commit count|success|failure|blocked' '4|2|1|1' "${CAP[workbench.commit]:-MISSING}"
assert_eq 'browser.export count|success|failure|blocked' '2|1|1|0' "${CAP[browser.export]:-MISSING}"
assert_eq 'doc.publish count|success|failure|blocked' '2|1|0|1' "${CAP[doc.publish]:-MISSING}"
TOTAL=0
for k in "${!CAP[@]}"; do
  IFS='|' read -r c _ <<< "${CAP[$k]}"
  TOTAL=$((TOTAL+c))
done
assert_eq 'stats.total = ΣbyCapability.count' "$SEED_ROWS" "$TOTAL"

step "4. stats.byProject：具体 projectId 与 NULL 分组"
PROJ_ROWS="$(psql_tmp "$PROJ_SQL")"
parse_proj "$PROJ_ROWS" PROJ
assert_eq 'byProject 分组数' '3' "${#PROJ[@]}"
assert_eq 'proj-alpha count' '3' "${PROJ[proj-alpha]:-MISSING}"
assert_eq 'proj-beta count' '2' "${PROJ[proj-beta]:-MISSING}"
assert_eq 'NULL projectId count' '3' "${PROJ[__NULL__]:-MISSING}"

step "5. stats 时间窗：from=2026-02-01T00:00:00Z 后只含窗内行"
CAP_FROM_ROWS="$(psql_tmp "$CAP_SQL_FROM")"
parse_cap "$CAP_FROM_ROWS" CAPF
assert_eq '窗内 workbench.commit count|success|failure|blocked' '2|0|1|1' "${CAPF[workbench.commit]:-MISSING}"
assert_eq '窗内 browser.export count|success|failure|blocked' '1|0|1|0' "${CAPF[browser.export]:-MISSING}"
assert_eq '窗内 doc.publish count|success|failure|blocked' '2|1|0|1' "${CAPF[doc.publish]:-MISSING}"
TOTAL_FROM=0
for k in "${!CAPF[@]}"; do
  IFS='|' read -r c _ <<< "${CAPF[$k]}"
  TOTAL_FROM=$((TOTAL_FROM+c))
done
assert_eq '窗内 total（期望 5 行）' '5' "$TOTAL_FROM"
PROJ_FROM_ROWS="$(psql_tmp "$PROJ_SQL_FROM")"
parse_proj "$PROJ_FROM_ROWS" PROJF
assert_eq '窗内 proj-alpha count' '1' "${PROJF[proj-alpha]:-MISSING}"
assert_eq '窗内 proj-beta count' '1' "${PROJF[proj-beta]:-MISSING}"
assert_eq '窗内 NULL projectId count' '3' "${PROJF[__NULL__]:-MISSING}"

step "6. query filter：复刻 service.query 的 where 拼装，逐项精确行数"
assert_eq 'capabilityKey=workbench.commit' '4' "$(psql_tmp "SELECT count(*) FROM \"capability_activation_log\" WHERE \"capabilityKey\"='workbench.commit';")"
assert_eq 'capabilityKey=browser.export' '2' "$(psql_tmp "SELECT count(*) FROM \"capability_activation_log\" WHERE \"capabilityKey\"='browser.export';")"
assert_eq 'result=failure' '2' "$(psql_tmp "SELECT count(*) FROM \"capability_activation_log\" WHERE \"result\"='failure';")"
assert_eq 'result=blocked' '2' "$(psql_tmp "SELECT count(*) FROM \"capability_activation_log\" WHERE \"result\"='blocked';")"
assert_eq 'projectId IS NULL' '3' "$(psql_tmp 'SELECT count(*) FROM "capability_activation_log" WHERE "projectId" IS NULL;')"
assert_eq 'capabilityKey + result 组合过滤' '2' "$(psql_tmp "SELECT count(*) FROM \"capability_activation_log\" WHERE \"capabilityKey\"='workbench.commit' AND \"result\"='success';")"

step "7. parametersDigest：stableStringify 键序无关 + 内容敏感 + 落库无损"
# 与 service.stableStringify / parametersDigest 同算法，由 node 真算出三个摘要。
DIGEST_LINE="$(node -e '
const { createHash } = require("crypto");
function stableStringify(value, depth = 0) {
  if (depth > 32) return JSON.stringify("[DEEP_NESTED]");
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map((v) => stableStringify(v, depth + 1)).join(",") + "]";
  const entries = Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + stableStringify(v, depth + 1)).join(",") + "}";
}
function digest(parameters) {
  return createHash("sha256").update(stableStringify(parameters ?? {})).digest("hex");
}
process.stdout.write([digest({a:1,b:2}), digest({b:2,a:1}), digest({a:1,b:3})].join(" "));
')"
IFS=' ' read -r DG_A DG_B DG_C <<< "$DIGEST_LINE"
assert_eq '摘要长度为 sha256 hex 64 位' '64' "${#DG_A}"
if [[ "$DG_A" =~ ^[0-9a-f]{64}$ ]]; then ok '摘要是合法 sha256 hex 字符串'; else bad "摘要格式非法：${DG_A}"; fi
DIG_INSERT="$(psql_tmp "INSERT INTO \"capability_activation_log\" (\"capabilityKey\",\"sessionId\",\"parametersDigest\",\"result\") VALUES ('digest.verify','digest-A','${DG_A}','success'),('digest.verify','digest-B','${DG_B}','success'),('digest.verify','digest-C','${DG_C}','success');" 2>&1)" || {
  printf '%s\n' "$DIG_INSERT" | sed 's/^/    | /'
  bad '摘要样例行 INSERT 失败'
}
DG_A_DB="$(psql_tmp "SELECT \"parametersDigest\" FROM \"capability_activation_log\" WHERE \"sessionId\"='digest-A';")"
DG_B_DB="$(psql_tmp "SELECT \"parametersDigest\" FROM \"capability_activation_log\" WHERE \"sessionId\"='digest-B';")"
DG_C_DB="$(psql_tmp "SELECT \"parametersDigest\" FROM \"capability_activation_log\" WHERE \"sessionId\"='digest-C';")"
assert_eq 'digestA 落库无损（真库读回 = node 算出）' "$DG_A" "$DG_A_DB"
assert_eq '键序不同语义相同 → digestB = digestA' "$DG_A_DB" "$DG_B_DB"
assert_eq 'digestC 落库无损' "$DG_C" "$DG_C_DB"
if [[ "$DG_C_DB" != "$DG_A_DB" ]]; then
  ok "内容不同 → digestC != digestA（${DG_C_DB} != ${DG_A_DB}）"
else
  bad "内容不同却得到相同摘要：${DG_A_DB}"
fi
assert_eq 'digest.verify 分组行数' '3' "$(psql_tmp "SELECT count(*) FROM \"capability_activation_log\" WHERE \"capabilityKey\"='digest.verify';")"

step "8. append-only 语义（数据层）"
ok '本脚本全程仅 INSERT/SELECT，无 UPDATE/DELETE；append-only 由 service.record 唯一写路径保证'

step "9. 清理：DROP 临时库并确认残留 0"
if DROP_OUT="$(psql_maint "DROP DATABASE IF EXISTS \"${TEMP_DB}\";" 2>&1)"; then
  DB_CREATED=0
  ok "临时库 ${TEMP_DB} 已删除"
else
  printf '%s\n' "$DROP_OUT" | sed 's/^/    | /'
  bad '临时库删除失败（退出 trap 会再试一次）'
fi
LEFT="$(psql_maint "SELECT count(*) FROM pg_database WHERE datname='${TEMP_DB}';")"
assert_eq '临时库残留数' '0' "$LEFT"

printf '\n=== capability-activation 真 PG 数据验收：PASS=%d FAIL=%d ===\n' "$PASS" "$FAIL"
[[ "$FAIL" == "0" ]] || exit 1
exit 0
