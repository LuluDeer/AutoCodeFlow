#!/usr/bin/env bash
#
# verify-smoke-rollout-claim.sh —— 场景 9：灰度 claim 的**真实部分唯一索引**
# 在**真 PG** 上的语义验证。
#
# ## 为什么必须真机（这一条是本脚本存在的全部理由）
#
# `apps/admin-api/src/modules/application/__tests__/app-deployment.rollout-claim.spec.ts`
# 的头注自己写明了原因：上一版 25 条测试**全绿**，真机上多机灰度**全线失效** ——
# 因为 `repo` 是 mock，**数据库的部分唯一索引根本不在测试环境里**，23505 永远不会
# 发生。该 spec 现在的做法是 `enforceClaimUniqueness` **手动复刻**约束并**主动抛
# 23505**：测法本身正确（它挡的是"服务层忘了处理 23505"），但它**证明不了**：
#
#   · 索引真的被建出来了（迁移可能没跑 / 名字被改 / 谓词被改成全表唯一）；
#   · 谓词真的是 `WHERE "rolloutBatchClaimId" IS NOT NULL`（若是全表唯一，
#     多行 canary 里第 2 行就撞 23505 ⇒ **多机灰度必然失效**，这正是被否决的旧方案）；
#   · PG 在 **UPDATE**（不是只有 INSERT）时真的做冲突检查；
#   · 两个连接**同时** claim 同一应用时，DB 层真的会挡住第二个。
#
# ⇒ 本脚本连的是**真 PG16**，索引由**admin-api 自己的迁移链**在 boot 时建成
# （不是脚本里手工 `CREATE INDEX` —— 那只会验"我会写 DDL"）。
#
# ## 六个场景（与任务清单一一对应）
#
#   A1 索引真的存在，且**定义**里的 `WHERE` 子句是 `IS NOT NULL`（不是全表唯一）
#   A2 同应用**第二个非空 claim ⇒ 必须 23505**（UPDATE / INSERT / 同 batchId / 诊断四路）
#   A3 **NULL 不受约束**：同应用可以有多行 claim IS NULL（部分索引的关键）
#   A4 **释放后可再 claim**：置 NULL ⇒ 再 claim 另一批次 ⇒ 成功
#   A5 **不同应用可各自 claim**（索引是 per-applicationId，不是全局单飞）
#   A6 **并发**：两连接同时 claim 同一应用 ⇒ 一个成功、一个 23505（多机灰度真实场景）
#
# ## A6 怎么"造出真并发"（不是顺序重试）
#
#   · 连接 A：`BEGIN; UPDATE 行1 SET claim='batch-D-A'; SELECT pg_sleep(4); COMMIT;`
#     ⇒ 事务**真的**开着，且已持有该唯一索引项的插入锁。
#   · 轮询 `pg_stat_activity` 直到 A 的 `SELECT pg_sleep(4)` 处于 active
#     ⇒ 确认"A 的 UPDATE 已执行、事务未提交"（不靠 sleep 猜）。
#   · 此时起连接 B：`UPDATE 行2 SET claim='batch-D-B'` ⇒ 它在**可见性**上过（A 的行
#     未提交、对它不可见），到**索引插入**时撞 A 的事务 ⇒ **阻塞**。
#   · 轮询 `pg_locks where not granted` 到 1 ⇒ DB 侧直接证据"B 真的在等 A"。
#   · A COMMIT ⇒ B 醒来重查，报 23505。⇒ 一个成功、一个 23505，且**时间上重叠**。
#
# ## 可重入
#
# 步骤 0a **跑前清理**：按 `applications.name` 的确定性前缀 `smoke-claim-` 删掉
# 本脚本自己造的应用行 + 其 `app_deployments` 行（子表按 applicationId 反查 ⇒
# 与主表严格同源），并**验证清理生效**（计数 = 0）。每句 DELETE 都带 WHERE
# （`verify-smoke-selftest.sh --static-only` 会扫这条）。
# `smoke_preclean_tasks` 也照例调用：本场景目前不建 tasks 行，但统一契约不能破
# （前缀恒定 ⇒ 将来本场景若要建任务，清理已就位；且它自己会验"残留 = 0"）。
#
# ## 时区纪律
#
# 一切**时间点**都用 DB 侧 `now()` / `clock_timestamp()`（宿主 CST、容器/PG UTC）。
# 本脚本只比较**时长**（A 持锁 4s、B 阻塞多久），不做跨时区的绝对时刻比较。
#
# ## 不碰部署实例
#
# 只用 `acfsmoke-*` 隔离栈（容器/网络/卷/端口全独立）。**绝不**连接
# `acf-postgres-1` / `acf-redis-1` / 任何 `acf-*` 现网容器。
#
# 用法：
#   ./scripts/verify-smoke-stack.sh up            # 先起隔离栈（迁移链会在 boot 跑完）
#   ACF_SMOKE_ENV_FILE=/tmp/acf-smoke-env.sh ./scripts/verify-smoke-rollout-claim.sh
#   # 或经统一入口：./scripts/verify-smoke-all.sh --only=r5-rollout-claim
#
# 前置：`scripts/verify-smoke-stack.sh up`（已起栈）+ 镜像**本仓当前源码**构建
#       （`docker build --no-cache -f apps/admin-api/Dockerfile -t acf-smoke-admin-api:r5 apps/admin-api`）。
#
# 退出码：0 = 全部断言通过；1 = 有断言失败。
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

PREFIX="smoke-claim-"
PAT="${PREFIX}%"
IDX="uq_app_deployments_rollout_claim"
TMP="/tmp/acf-smoke-claim"

psql_q() { smoke_psql_q "$1"; }

# 执行一句 SQL 并**捕获**退出码与输出（含 stderr）。
# ⚠️ 必须 `set +e`：`$( )` 失败时在 `set -e` 下会直接中止整个脚本 ⇒ 拿不到
#    "这条 SQL 到底报了什么"。这正是本脚本要断言的东西。
# ⚠️ `-v VERBOSITY=verbose` ⇒ 错误行带 **SQLSTATE 前缀**（`ERROR:  23505: ...`），
#    且主消息里含**约束/索引名** ⇒ 两条断言（错误码 + 约束名）都可从同一输出取。
SQL_RC=0; SQL_OUT=""
sql_try() {
  set +e
  SQL_OUT="$(docker exec -i "$SMOKE_PG_CONTAINER" psql \
    -U "$SMOKE_PG_USER" -d "$SMOKE_PG_DB" -tAX \
    -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$1" 2>&1)"
  SQL_RC=$?
  set -e
}

mk_app() {  # $1 = 后缀 ⇒ 打印 application id
  # ⚠️ `INSERT ... RETURNING` 在 `-tAX` 下仍会多打一行命令标签（`INSERT 0 1`）
  #    ⇒ 必须只取第一行，否则 id 里混进 "\nINSERT 0 1"（本轮实测踩到）。
  psql_q "insert into applications (name, version, runtime, status)
          values ('${PREFIX}${1}', '0.0.0-smoke', 'node', 'active') returning id;" | awk 'NR==1'
}
mk_dep() {  # $1 = applicationId，$2 = 地址后缀 ⇒ 打印 deployment id
  # ⚠️ `status` 刻意用 'stopped'（**不是**默认的 'pending'）：同表还有另一个
  #    部分唯一索引 `uq_app_deployments_application_in_flight`
  #    = UNIQUE("applicationId") WHERE status IN ('pending','deploying')
  #    （1789000000000，实测谓词为 `status = ANY (ARRAY['pending','deploying'])`）。
  #    本场景一个应用要多行 ⇒ 若用 'pending'，第 2 行就撞**另一个**索引，
  #    A2 的"23505 归因到 claim 索引"会**错误归因**（这正是本题要防的形态）。
  #    `rolloutState` 也留 NULL（不在任何部分唯一索引的谓词里）。
  psql_q "insert into app_deployments (\"applicationId\", \"executorAddress\", status)
          values ('$1', '${PREFIX}$2', 'stopped') returning id;" | awk 'NR==1'
}
claim_of() {  # $1 = deployment id
  psql_q "select coalesce(\"rolloutBatchClaimId\", '<NULL>') from app_deployments where id='$1';"
}
nn_count() {  # $1 = applicationId ⇒ 该应用非空 claim 行数
  psql_q "select count(*) from app_deployments where \"applicationId\"='$1' and \"rolloutBatchClaimId\" is not null;"
}

# ── 0a. 跑前清理（幂等的前提）────────────────────────────────────────────
step "0a. 跑前清理（只删本脚本自己造的 smoke-claim-* 数据）"
if smoke_preclean_tasks "$PREFIX" "本脚本不建 tasks 行；此处满足统一清理契约并验证残留 = 0"; then
  ok "tasks 跑前清理完成（本前缀残留 = 0）"
else
  bad "tasks 跑前清理失败 ⇒ 中止（不带着脏数据继续跑）"
  exit 1
fi

clean_own_rows() {
  # 子表优先：部署行（按本前缀应用的 id 反查）→ 应用。每句都带 WHERE。
  psql_q "delete from app_deployments where \"applicationId\" in (select id from applications where name like '${PAT}');" >/dev/null
  psql_q "delete from applications where name like '${PAT}';" >/dev/null
  local apps deps
  apps="$(psql_q "select count(*) from applications where name like '${PAT}';")"
  deps="$(psql_q "select count(*) from app_deployments where \"executorAddress\" like '${PAT}';")"
  [[ "$apps" == "0" && "$deps" == "0" ]]
}
if clean_own_rows; then
  ok "应用 / 部署行跑前清理完成（两查残留 = 0）"
else
  bad "应用 / 部署行跑前清理失败（残留非 0）⇒ 中止"
  exit 1
fi

# ── 0b. 镜像与 /app/dist 核实（否则测的是旧代码 = 假通过）────────────────
step "0b. 镜像重建核实 + /app/dist 是否为当前源码"
IMG_CREATED="$(docker image inspect -f '{{.Created}}' "$SMOKE_IMAGE" 2>/dev/null || true)"
IMG_EPOCH="$(date -d "$IMG_CREATED" +%s 2>/dev/null || echo 0)"
# ⚠️ 只算**真正进 dist** 的源码：`tsconfig.build.json` 排除 `src/**/__tests__/**`
#    与 `**/*.spec.ts`（实测 `docker run ... ls /app/dist/modules/application/__tests__`
#    为空）。若把测试文件也算进来，「别的会话并发改一个 spec」就会把本断言弄红 ——
#    那是**假红**（本轮实测踩到：同一 checkout 里另一会话正在改
#    `scheduler/__tests__/*.spec.ts`）。测试文件单独统计，只提示不判红。
SRC_EPOCH="$(find "$ROOT/apps/admin-api/src" -type f -name '*.ts' \
  ! -path '*/__tests__/*' ! -name '*.spec.ts' -printf '%T@\n' | sort -n | tail -1 | cut -d. -f1)"
TEST_EPOCH="$(find "$ROOT/apps/admin-api/src" -type f -name '*.ts' \
  \( -path '*/__tests__/*' -o -name '*.spec.ts' \) -printf '%T@\n' | sort -n | tail -1 | cut -d. -f1)"
printf '    | 镜像 %s Created=%s (epoch=%s)\n' "$SMOKE_IMAGE" "${IMG_CREATED}" "${IMG_EPOCH}"
printf '    | 进 dist 的源码最新 mtime epoch=%s / 测试文件最新 mtime epoch=%s（测试不进 dist）\n' \
  "${SRC_EPOCH:-?}" "${TEST_EPOCH:-?}"
if [[ "$IMG_EPOCH" -ge "${SRC_EPOCH:-0}" ]]; then
  ok "镜像 Created 晚于「进 dist 的源码」最新改动 ⇒ 镜像包含当前源码"
else
  bad "镜像 Created 早于源码最新改动（img=${IMG_EPOCH} < src=${SRC_EPOCH}）⇒ 测的是旧代码（必须 docker build --no-cache，不能 ACF_SMOKE_SKIP_BUILD=1）"
fi
if [[ -n "${TEST_EPOCH:-}" && "${TEST_EPOCH}" -gt "$IMG_EPOCH" ]]; then
  printf '    | （提示）测试文件 mtime 晚于镜像；它们**不进** dist，故不判红\n'
fi

# /app/dist 里那两条**本场景依赖的源码事实**必须可命中：
#   ① 迁移产物含索引名与 IS NOT NULL 谓词（否则镜像里的迁移是旧版）；
#   ② 实体产物含同名索引声明（`where: "\"rolloutBatchClaimId\" IS NOT NULL"`）。
DIST_MIG="/app/dist/migrations/1790000000095-AddRolloutBatchClaim.js"
DIST_ENT="/app/dist/modules/application/entities/app-deployment.entity.js"
for f in "$DIST_MIG" "$DIST_ENT"; do
  if docker exec "$SMOKE_API_CONTAINER" test -f "$f" 2>/dev/null; then
    ok "/app/dist 内含 ${f##*/}"
  else
    bad "/app/dist 缺 ${f} ⇒ 镜像不是本仓当前源码"
  fi
done
for pair in "$DIST_MIG:$IDX" "$DIST_ENT:$IDX" "$DIST_MIG:IS NOT NULL"; do
  f="${pair%%:*}"; marker="${pair#*:}"
  n="$(docker exec "$SMOKE_API_CONTAINER" grep -c -F "$marker" "$f" 2>/dev/null || echo 0)"
  if [[ "${n}" -gt 0 ]]; then
    ok "/app/dist/$(basename "$f") 含源码标记「${marker}」（命中 ${n} 处）"
  else
    bad "/app/dist/$(basename "$f") 缺源码标记「${marker}」⇒ dist 与 src 不同源"
  fi
done

# ── 1. A1：索引真的存在，且谓词是 IS NOT NULL ──────────────────────────
step "1. A1 索引真实存在 + 定义/谓词原文（防「索引没建」与「建成全表唯一」两种形态）"
LEDGER="$(psql_q "select name from migrations where name='AddRolloutBatchClaim1790000000095';")"
[[ "$LEDGER" == "AddRolloutBatchClaim1790000000095" ]] \
  && ok "migrations 台账含 AddRolloutBatchClaim1790000000095（索引来自 boot 期真实迁移链）" \
  || bad "migrations 台账缺 1790000000095（得到 '${LEDGER}'）⇒ 索引来路不明"

COL_DEF="$(psql_q "select data_type||'/'||is_nullable from information_schema.columns where table_name='app_deployments' and column_name='rolloutBatchClaimId';")"
[[ "$COL_DEF" == "character varying/YES" ]] \
  && ok "列 rolloutBatchClaimId = character varying 且可空（${COL_DEF}）" \
  || bad "列定义不符（得到 '${COL_DEF}'，期望 character varying/YES）"

INDEXDEF="$(psql_q "select indexdef from pg_indexes where schemaname='public' and indexname='${IDX}';")"
printf '    | pg_indexes.indexdef 原文：\n      %s\n' "${INDEXDEF:-<空>}"
grep -q 'CREATE UNIQUE INDEX' <<<"$INDEXDEF" \
  && ok "索引 ${IDX} **存在**且是 UNIQUE INDEX（不是普通索引）" \
  || bad "索引 ${IDX} 不存在或不是 UNIQUE（indexdef='${INDEXDEF}'）"
grep -Eq 'USING btree \("applicationId"\)' <<<"$INDEXDEF" \
  && ok "索引列恰为单列 (\"applicationId\")（per-applicationId，不是复合键）" \
  || bad "索引列不是单列 (\"applicationId\")（indexdef='${INDEXDEF}'）"

# 谓词原文：这是本场景**最核心**的一条。`IS NOT NULL` 在 ⇒ 只约束携带 claim 的行；
# 不在（indpred 为 NULL）⇒ 变成"每应用全表只能一行" ⇒ **多行 canary 直接失效**。
PRED="$(psql_q "select pg_get_expr(i.indpred, i.indrelid) from pg_index i join pg_class c on c.oid=i.indexrelid where c.relname='${IDX}';")"
printf '    | pg_get_expr(indpred) 原文：%s\n' "${PRED:-<NULL>}"
if [[ -n "$PRED" ]]; then
  ok "索引是**部分索引**（indpred 非 NULL，不是全表唯一）"
else
  bad "索引 indpred 为 NULL ⇒ 被建成了**全表唯一**（每应用只能一行）⇒ 多行 canary 必然失效"
fi
grep -q 'rolloutBatchClaimId' <<<"$PRED" \
  && ok "谓词引用列 rolloutBatchClaimId" \
  || bad "谓词不引用 rolloutBatchClaimId（谓词='${PRED}'）"
grep -qi 'IS NOT NULL' <<<"$PRED" \
  && ok "谓词含 IS NOT NULL（原文：${PRED}）" \
  || bad "谓词不含 IS NOT NULL（谓词='${PRED}'）⇒ 未 claim 的行也被约束"

# 同表另一个部分唯一索引必须仍在、且谓词不同（否则"claim 索引"可能被它顶替）
INFLIGHT_PRED="$(psql_q "select coalesce(pg_get_expr(i.indpred, i.indrelid),'<NULL>') from pg_index i join pg_class c on c.oid=i.indexrelid where c.relname='uq_app_deployments_application_in_flight';")"
printf '    | 旁证：uq_app_deployments_application_in_flight 的谓词 = %s\n' "${INFLIGHT_PRED}"
if [[ "$INFLIGHT_PRED" != "<NULL>" && "$INFLIGHT_PRED" != *'rolloutBatchClaimId'* ]]; then
  ok "同表既有 in-flight 索引谓词基于 status(pending/deploying)（与 claim 索引是两个不同的载体）"
else
  bad "in-flight 索引谓词异常（'${INFLIGHT_PRED}'）⇒ 两个索引的归因会互相污染"
fi

# ── 2. 造数据：一个应用 5 行（模拟 canary 首批 5 台，只有 owner 行携带 claim）──
step "2. 造数据：应用 A 5 行 canary + 应用 B/C1/C2/D（status='stopped'、rolloutState=NULL）"
APP_A="$(mk_app "a")"
APP_B="$(mk_app "b")"
APP_C1="$(mk_app "c1")"
APP_C2="$(mk_app "c2")"
APP_D="$(mk_app "d")"
[[ -n "$APP_A" && -n "$APP_B" && -n "$APP_C1" && -n "$APP_C2" && -n "$APP_D" ]] \
  && ok "5 个应用已建（id 前缀分别 ${APP_A:0:8} / ${APP_B:0:8} / ${APP_C1:0:8} / ${APP_C2:0:8} / ${APP_D:0:8}）" \
  || { bad "应用创建失败 ⇒ 中止"; exit 1; }

A_ROWS=()
for i in 1 2 3 4 5; do A_ROWS+=("$(mk_dep "$APP_A" "a${i}")"); done
D_R1="$(mk_dep "$APP_D" "d1")"; D_R2="$(mk_dep "$APP_D" "d2")"
N_A_ROWS="$(psql_q "select count(*) from app_deployments where \"applicationId\"='${APP_A}';")"
[[ "$N_A_ROWS" == "5" ]] \
  && ok "应用 A 有 5 行部署行（多行 canary 的真实形状）" \
  || bad "应用 A 部署行数 = ${N_A_ROWS}（期望 5）"

# ── 3. A3：NULL 不受约束（部分索引的关键）────────────────────────────────
step "3. A3 同一应用可以有多行 rolloutBatchClaimId IS NULL"
NULL_A="$(psql_q "select count(*) from app_deployments where \"applicationId\"='${APP_A}' and \"rolloutBatchClaimId\" is null;")"
NN_A="$(nn_count "$APP_A")"
[[ "$NULL_A" == "5" && "$NN_A" == "0" ]] \
  && ok "应用 A 的 5 行 claim 全为 NULL（唯一索引**不参与**这 5 行）" \
  || bad "应用 A：NULL=${NULL_A} / 非空=${NN_A}（期望 5 / 0）"

# ① 先让 owner 行持有 claim（真实顺序：claim 之后再落 canary 行）
sql_try "update app_deployments set \"rolloutBatchClaimId\"='batch-A1' where id='${A_ROWS[0]}';"
[[ "$SQL_RC" == "0" ]] \
  && ok "A3-① 应用 A 的 owner 行 claim='batch-A1' 落库成功（此时该应用已有 1 条非空）" \
  || bad "A3-① 首次 claim 失败（rc=${SQL_RC} 输出=${SQL_OUT}）"

# ② 在 claim **已存在**的前提下，同应用**新增** NULL 行必须仍然允许
for i in 6 7; do mk_dep "$APP_A" "a${i}" >/dev/null; done
NULL_A2="$(psql_q "select count(*) from app_deployments where \"applicationId\"='${APP_A}' and \"rolloutBatchClaimId\" is null;")"
NN_A2="$(nn_count "$APP_A")"
[[ "$NULL_A2" == "6" && "$NN_A2" == "1" ]] \
  && ok "A3-② claim 存在时再插 2 行 NULL 仍成功（NULL=6 / 非空=1）⇒ 未 claim 的行完全不受约束" \
  || bad "A3-② 期望 NULL=6 / 非空=1，实测 NULL=${NULL_A2} / 非空=${NN_A2}"

# ③ 另一应用整批 3 行全 NULL 也必须允许（不依赖是否存在 claim）
for i in 1 2 3; do mk_dep "$APP_B" "b${i}" >/dev/null; done
NULL_B0="$(psql_q "select count(*) from app_deployments where \"applicationId\"='${APP_B}' and \"rolloutBatchClaimId\" is null;")"
[[ "$NULL_B0" == "3" ]] \
  && ok "A3-③ 应用 B 连插 3 行 NULL 全部成功（部分索引对全 NULL 应用零约束）" \
  || bad "A3-③ 应用 B 的 NULL 行数 = ${NULL_B0}（期望 3）"

# ── 4. A2：同应用第二个非空 claim ⇒ 必须被 PG 拒（23505）───────────────
step "4. A2 同应用第二个非空 claim ⇒ 23505（四条独立路径）"
A2_CASE_PASS=0; A2_CASE_TOTAL=0
a2() {  # $1=说明  $2=SQL  $3=期望（ok/bad 已在内部处理）
  A2_CASE_TOTAL=$((A2_CASE_TOTAL+1))
  sql_try "$2"
  local label="$1"
  if [[ "$SQL_RC" != "0" ]] && grep -q '23505' <<<"$SQL_OUT" \
     && grep -q "$IDX" <<<"$SQL_OUT"; then
    A2_CASE_PASS=$((A2_CASE_PASS+1))
    ok "${label}：被拒（psql rc=${SQL_RC}，23505，约束名 ${IDX} 出现在错误里）"
  else
    bad "${label}：**未被正确拒绝**（rc=${SQL_RC} 输出=${SQL_OUT}）"
  fi
  printf '      | 错误原文首行：%s\n' "$(head -1 <<<"$SQL_OUT")"
}

# ① UPDATE：另一行（不同 batchId）—— 这正是两实例各抢不同 owner 行的真实形态
a2 "A2-① UPDATE 第 2 行 claim='batch-A2'" \
   "update app_deployments set \"rolloutBatchClaimId\"='batch-A2' where id='${A_ROWS[1]}';"
# ② INSERT：新行直接带非空 claim（同一应用第 2 条）
a2 "A2-② INSERT 新行 claim='batch-A3'" \
   "insert into app_deployments (\"applicationId\", \"executorAddress\", status, \"rolloutBatchClaimId\") values ('${APP_A}', '${PREFIX}a-insert', 'stopped', 'batch-A3');"
# ③ 同 batchId 也不允许（证明约束是"per-applicationId"，不是"per-batchId"）
a2 "A2-③ UPDATE 第 3 行 claim='batch-A1'（与 owner 行**同值**）" \
   "update app_deployments set \"rolloutBatchClaimId\"='batch-A1' where id='${A_ROWS[2]}';"

# ④ 机读版：走 plpgsql 诊断，直接取 SQLSTATE 与 CONSTRAINT_NAME
#    ⚠️ 与③的 UPDATE 不同：这里**吞掉**异常并打印诊断 ⇒ 断言不依赖错误文案格式。
sql_try "DO \$\$
DECLARE c text; s text;
BEGIN
  BEGIN
    UPDATE app_deployments SET \"rolloutBatchClaimId\"='batch-A-diag' WHERE id='${A_ROWS[3]}';
    RAISE EXCEPTION 'EXPECTED_23505_NOT_RAISED';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS c = CONSTRAINT_NAME, s = RETURNED_SQLSTATE;
    RAISE NOTICE 'claim_violation sqlstate=% constraint=%', s, c;
  END;
END \$\$;"
A2_CASE_TOTAL=$((A2_CASE_TOTAL+1))
DIAG_LINE="$(grep -o 'claim_violation sqlstate=[^ ]* constraint=[^ ]*' <<<"$SQL_OUT" || true)"
if [[ "$DIAG_LINE" == "claim_violation sqlstate=23505 constraint=${IDX}" ]]; then
  A2_CASE_PASS=$((A2_CASE_PASS+1))
  ok "A2-④ plpgsql 诊断：SQLSTATE=23505 且 CONSTRAINT_NAME=${IDX}（机读，不依赖文案格式）"
else
  bad "A2-④ plpgsql 诊断不符（实测 '${DIAG_LINE:-<无>}'，rc=${SQL_RC}）"
fi

[[ "$A2_CASE_PASS" == "$A2_CASE_TOTAL" ]] \
  && ok "A2 汇总：${A2_CASE_PASS}/${A2_CASE_TOTAL} 条拒绝路径全部生效（UPDATE / INSERT / 同 batchId / 诊断）" \
  || bad "A2 汇总：只有 ${A2_CASE_PASS}/${A2_CASE_TOTAL} 条路径生效"

# 失败后**不留部分状态**：仍只有 owner 行非空，其余仍 NULL
NN_A3="$(nn_count "$APP_A")"
N_A_ALL="$(psql_q "select count(*) from app_deployments where \"applicationId\"='${APP_A}';")"
C2="$(claim_of "${A_ROWS[1]}")"; C3="$(claim_of "${A_ROWS[2]}")"
[[ "$NN_A3" == "1" && "$C2" == "<NULL>" && "$C3" == "<NULL>" ]] \
  && ok "A2-⑤ 四次拒绝后状态干净：应用 A 仅 1 条非空 claim，被拒的行仍为 NULL（${N_A_ALL} 行总数不变）" \
  || bad "A2-⑤ 拒绝后状态不干净：非空=${NN_A3} 行2='${C2}' 行3='${C3}'"

# ── 5. A4：释放（置 NULL）后可再 claim ──────────────────────────────────
step "5. A4 释放（置 NULL）后可再 claim 另一批次"
B1="$(psql_q "select id from app_deployments where \"applicationId\"='${APP_B}' order by \"executorAddress\" limit 1;")"
B2="$(psql_q "select id from app_deployments where \"applicationId\"='${APP_B}' order by \"executorAddress\" offset 1 limit 1;")"
sql_try "update app_deployments set \"rolloutBatchClaimId\"='batch-B1' where id='${B1}';"
[[ "$SQL_RC" == "0" ]] && ok "A4-① 应用 B 首次 claim='batch-B1' 成功" || bad "A4-① 首次 claim 失败（${SQL_OUT}）"
sql_try "update app_deployments set \"rolloutBatchClaimId\"=NULL where id='${B1}';"
NN_B_REL="$(nn_count "$APP_B")"
[[ "$SQL_RC" == "0" && "$NN_B_REL" == "0" ]] \
  && ok "A4-② 释放成功：claim 置 NULL 后应用 B 非空 claim = 0（唯一索引项已消失）" \
  || bad "A4-② 释放失败（rc=${SQL_RC} 非空=${NN_B_REL}）"
sql_try "update app_deployments set \"rolloutBatchClaimId\"='batch-B2' where id='${B2}';"
B2_CLAIM="$(claim_of "$B2")"
[[ "$SQL_RC" == "0" && "$B2_CLAIM" == "batch-B2" ]] \
  && ok "A4-③ 释放后**另一行**claim='batch-B2' 成功（B2 实测值=${B2_CLAIM}）⇒ 释放-再 claim 闭环" \
  || bad "A4-③ 释放后再 claim 失败（rc=${SQL_RC} 实测 '${B2_CLAIM}'）"

# ── 6. A5：不同应用可各自 claim ─────────────────────────────────────────
step "6. A5 不同应用各自 claim（per-applicationId，不是全局单飞）"
C1_ROW="$(mk_dep "$APP_C1" "c1-1")"
C2_ROW="$(mk_dep "$APP_C2" "c2-1")"
sql_try "update app_deployments set \"rolloutBatchClaimId\"='batch-C' where id='${C1_ROW}';"
RC_C1="$SQL_RC"; OUT_C1="$SQL_OUT"
sql_try "update app_deployments set \"rolloutBatchClaimId\"='batch-C' where id='${C2_ROW}';"
RC_C2="$SQL_RC"; OUT_C2="$SQL_OUT"
[[ "$RC_C1" == "0" && "$RC_C2" == "0" ]] \
  && ok "A5-① 两个不同应用各自 claim（**同一个** batchId 字符串）都成功 ⇒ 唯一性是 per-applicationId" \
  || bad "A5-① 跨应用 claim 失败（C1 rc=${RC_C1} ${OUT_C1} / C2 rc=${RC_C2} ${OUT_C2}）"
XAPP_N="$(psql_q "select count(*) from app_deployments where \"applicationId\" in ('${APP_C1}','${APP_C2}') and \"rolloutBatchClaimId\"='batch-C';")"
[[ "$XAPP_N" == "2" ]] \
  && ok "A5-② 表里同时存在 2 条 'batch-C' 的非空 claim（分属 2 个应用）" \
  || bad "A5-② 期望 2 条，实测 ${XAPP_N}"

# ── 7. A6：并发（两连接同时 claim 同一应用）─────────────────────────────
step "7. A6 并发：两连接**同时**claim 同一应用 ⇒ 一个成功、一个 23505"
HOLD_SEC=4
cat >"${TMP}-a.sql" <<SQL
BEGIN;
UPDATE "app_deployments" SET "rolloutBatchClaimId" = 'batch-D-A' WHERE "id" = '${D_R1}';
SELECT pg_sleep(${HOLD_SEC});
COMMIT;
SQL
cat >"${TMP}-b.sql" <<SQL
UPDATE "app_deployments" SET "rolloutBatchClaimId" = 'batch-D-B' WHERE "id" = '${D_R2}';
SQL

# 连接 A：真事务 + 真持锁（后台）
set +e
docker exec -i "$SMOKE_PG_CONTAINER" psql -U "$SMOKE_PG_USER" -d "$SMOKE_PG_DB" -tAX \
  -v ON_ERROR_STOP=1 < "${TMP}-a.sql" >"${TMP}-a.out" 2>&1 &
A_PID=$!
set -e

# 等到"A 的 UPDATE 已执行、事务未提交"：DB 侧看到 pg_sleep 处于 active
A_SLEEPING=0
for _ in $(seq 1 50); do
  n="$(psql_q "select count(*) from pg_stat_activity where state='active' and query like 'SELECT pg_sleep%' and pid <> pg_backend_pid();" 2>/dev/null || echo 0)"
  if [[ "${n:-0}" -ge 1 ]]; then A_SLEEPING=1; break; fi
done
[[ "$A_SLEEPING" == "1" ]] \
  && ok "A6-① 连接 A 已 UPDATE 且事务仍开着（pg_stat_activity 看到 pg_sleep active）" \
  || bad "A6-① 没观察到 A 的持锁事务 ⇒ 并发场景没造出来"

# 连接 B：在 A 的事务**未提交**时发起（后台，便于同时观察阻塞）
B_START_MS="$(date +%s%3N)"
set +e
docker exec -i "$SMOKE_PG_CONTAINER" psql -U "$SMOKE_PG_USER" -d "$SMOKE_PG_DB" -tAX \
  -v ON_ERROR_STOP=1 -v VERBOSITY=verbose < "${TMP}-b.sql" >"${TMP}-b.out" 2>&1 &
B_PID=$!
set -e

# 阻塞证据：pg_locks 里出现 not granted 的锁（B 在等 A 的事务）
MAX_WAITERS=0
for _ in $(seq 1 40); do
  w="$(psql_q "select count(*) from pg_locks where not granted;" 2>/dev/null || echo 0)"
  [[ "${w:-0}" -gt "$MAX_WAITERS" ]] && MAX_WAITERS="$w"
  kill -0 "$B_PID" 2>/dev/null || break
  sleep 0.2
done

set +e
wait "$B_PID"; B_RC=$?
wait "$A_PID"; A_RC=$?
set -e
B_ELAPSED_MS=$(( $(date +%s%3N) - B_START_MS ))
B_OUT="$(cat "${TMP}-b.out" 2>/dev/null || true)"
printf '      | A rc=%s / B rc=%s（B 阻塞时长 ≈ %sms）/ 观测到的 not-granted 锁峰值 = %s\n' \
  "$A_RC" "$B_RC" "$B_ELAPSED_MS" "$MAX_WAITERS"
printf '      | B 的错误原文首行：%s\n' "$(head -1 <<<"$B_OUT")"

[[ "$A_RC" == "0" ]] \
  && ok "A6-② 先持锁的连接 A 提交成功（rc=0）⇒ 它是赢家" \
  || bad "A6-② 连接 A 失败（rc=${A_RC} 输出=$(cat "${TMP}-a.out" 2>/dev/null)）"
[[ "$B_RC" != "0" ]] && grep -q '23505' <<<"$B_OUT" && grep -q "$IDX" <<<"$B_OUT" \
  && ok "A6-③ 并发的连接 B 被 PG 拒：23505 + 约束名 ${IDX}" \
  || bad "A6-③ 连接 B 未被正确拒绝（rc=${B_RC} 输出='${B_OUT}'）"
[[ "${MAX_WAITERS:-0}" -ge 1 ]] \
  && ok "A6-④ DB 侧直接证据：B 阻塞期间 pg_locks 出现 ${MAX_WAITERS} 个 not-granted 锁 ⇒ 两个 claim **时间上重叠**（不是顺序重试）" \
  || bad "A6-④ 未观察到 not-granted 锁 ⇒ 两个连接其实没重叠（本断言不成立，不能算并发）"

D_NN="$(nn_count "$APP_D")"
D2_CLAIM="$(claim_of "$D_R2")"; D1_CLAIM="$(claim_of "$D_R1")"
[[ "$D_NN" == "1" && "$D1_CLAIM" == "batch-D-A" && "$D2_CLAIM" == "<NULL>" ]] \
  && ok "A6-⑤ 终态：应用 D 恰 1 条非空 claim（赢家 'batch-D-A'），输家那行仍 NULL（${D_NN} / ${D1_CLAIM} / ${D2_CLAIM}）" \
  || bad "A6-⑤ 终态不符（非空=${D_NN} D1='${D1_CLAIM}' D2='${D2_CLAIM}'）"

# ── 8. 跑后清理 + 残留检查 ──────────────────────────────────────────────
step "8. 跑后清理（只删本脚本自己造的 smoke-claim-* 数据）"
if clean_own_rows; then
  ok "跑后清理完成（applications / app_deployments 本前缀残留均 = 0）"
else
  bad "跑后清理失败（不影响可重入：下一次跑的步骤 0a 会再清一次）"
fi
LEFT_NN="$(psql_q "select count(*) from app_deployments where \"rolloutBatchClaimId\" is not null;")"
printf '    | 清理后全表非空 claim 行数 = %s（本脚本造的行已全删；此值若 >0 属其它场景/存量数据）\n' "$LEFT_NN"
rm -f "${TMP}-a.sql" "${TMP}-b.sql" "${TMP}-a.out" "${TMP}-b.out"

# 栈级残留：本脚本**不**起任何容器/网络/卷（用调用方的 acfsmoke 隔离栈）。
# 判据分两态，避免"栈在跑"时把本栈自己当成残留（假红），也避免手工跑时漏查：
#   · 栈已销毁（PG 容器不存在）⇒ 要求四查**全空**（严格形态）；
#   · 栈在跑 ⇒ 要求"除本栈自身之外"为空，且 59000/59001 必须空闲。
step "9. 残留检查（容器 / 网络 / 卷 / 端口 55432 56379 43105 59000 59001）"
own_containers="$(printf '%s\n' "$SMOKE_API_CONTAINER" "$SMOKE_PG_CONTAINER" "$SMOKE_REDIS_CONTAINER" | sort -u)"
c_all="$(docker ps -a --filter name="${SMOKE_STACK}" --format '{{.Names}}' 2>/dev/null || true)"
stack_up=0
grep -qx "$SMOKE_PG_CONTAINER" <<<"$c_all" && stack_up=1
if [[ "$stack_up" == "1" ]]; then
  c_foreign="$(grep -vxF -f <(printf '%s\n' "$own_containers") <<<"$c_all" || true)"
  n_foreign="$(docker network ls --filter name="${SMOKE_STACK}" --format '{{.Name}}' 2>/dev/null | grep -vx "$SMOKE_NET" || true)"
  # ⚠️ 栈的卷名是 `${SMOKE_STACK}-uploads`（verify-smoke-stack.sh 的 UPLOAD_VOLUME），
  #    但 env 文件**不导出** SMOKE_UPLOAD_VOLUME ⇒ 直接引用会 `set -u` 中止（本轮实测）。
  OWN_VOL="${SMOKE_STACK}-uploads"
  v_foreign="$(docker volume ls --filter name="${SMOKE_STACK}" --format '{{.Name}}' 2>/dev/null | grep -vx "$OWN_VOL" || true)"
else
  c_foreign="$c_all"
  n_foreign="$(docker network ls --filter name="${SMOKE_STACK}" --format '{{.Name}}' 2>/dev/null || true)"
  v_foreign="$(docker volume ls --filter name="${SMOKE_STACK}" --format '{{.Name}}' 2>/dev/null || true)"
fi
port_4599="$(ss -ltn 2>/dev/null | grep -E ':(59000|59001)\b' || true)"
port_stack_ports=""
for p in 55432 56379 43105; do
  if ss -ltn 2>/dev/null | grep -qE ":${p}\b"; then
    case "$p" in
      "$SMOKE_PG_PORT"|"$SMOKE_REDIS_PORT"|"$SMOKE_API_PORT") [[ "$stack_up" == "1" ]] || port_stack_ports+="${p}(本栈端口但栈已停) " ;;
      *) port_stack_ports+="${p}(非本栈端口) " ;;
    esac
  fi
done
printf '  containers_foreign=[%s] networks_foreign=[%s] volumes_foreign=[%s] ports_bad=[%s] stack_up=%s\n' \
  "${c_foreign:- }" "${n_foreign:- }" "${v_foreign:- }" "${port_stack_ports:- }${port_4599:+59000/59001被占}" "$stack_up"
if [[ -z "${c_foreign// /}" && -z "${n_foreign// /}" && -z "${v_foreign// /}" \
      && -z "${port_stack_ports// /}" && -z "$port_4599" ]]; then
  ok "残留检查全空（本脚本未新增容器/网络/卷；本栈之外零残留；59000/59001 空闲）"
else
  bad "残留非空：containers=[${c_foreign:- }] networks=[${n_foreign:- }] volumes=[${v_foreign:- }] ports=[${port_stack_ports:- }${port_4599:-}]"
fi

printf '\n=== 场景 9（灰度 claim 部分唯一索引）小结：PASS=%d FAIL=%d ===\n' "$PASS" "$FAIL"
[[ "$FAIL" == "0" ]] || exit 1
exit 0
