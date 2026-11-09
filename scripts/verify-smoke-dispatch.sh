#!/usr/bin/env bash
#
# verify-smoke-dispatch.sh —— 场景 8：`dispatch` 的**候选排序与偏好分区**真机验证。
#
# ## 为什么有这个脚本
#
# `artifacts/rounds/r7-dispatch-impl.md` §4 如实记下：T1-B3e 把 dispatch 的评分排序 /
# `scoredSnapshot` / 部署偏好分区 / 解释器缓存分区搬到 `ExecutorDispatchRanking`
# 协作者之后，**真机只做到「注册 3 台 + 触发任务」**——上一轮执行者用自己的临时
# docker 流程造的任务指向不存在的 `s3://b/x.zip`，执行落 `failed/script_error`、
# 容器日志里连 `dispatch.decision` 都没有 ⇒ **派发根本没走到排序环节**，
# 五条断言全部未验证。本脚本把那五条**逐条造场景 + 逐条断言**。
#
# ## 五个场景（与 §4 未验证项一一对应）
#
#   A1 落到**评分预期**的执行器（不是注册最早/最近那台，也不是「在跑任务最少」那台）
#   A2 **部署偏好分区**生效（有亲和性的执行器优先，即使它的评分更差）
#   A3 `scoredSnapshot` 在**占坑之前**截取（E-2）
#   A4 **重复派发抑制**仍在（同一任务不会被派两次）
#   A5 **失败出口**：三条分别造出来、分别断言
#        · `PINNED_EXECUTOR_AT_CAPACITY`（钉定的那台满了，其余空闲）
#        · `NO_DISPATCHABLE_EXECUTOR`（全部在线但全部满载）
#        · `NO_EXECUTOR_MATCHING_FILTERS`（没有在线执行器）
#
# ## ⚠️ 关键实现选择 1：执行器用 **pull 模式**（不是 push + 假地址）
#
# 排序/分区/决策日志全部发生在**传输分支之前**（`executor.service.ts` 的
# `logExecutionDispatchDecision` → `Dispatching task ...` → `if (matched.dispatchMode === "pull")`）。
# 上一轮的失败正是踩在传输阶段：地址指向不存在的包 ⇒ 更早就炸了。
# 本脚本若用 push + 不存在的地址，占坑会被补偿回滚（`compensateClaimedSlot`），
# **占坑后的 runningTaskCount 与占坑前无法区分** ⇒ A3（E-2）就验不了。
# pull 模式零入站依赖：dispatch 走「Redis 队列入队」而非 HTTP POST，
# **占坑保持**（不回滚），于是「日志里的占坑前读数」与「DB 里的占坑后读数」
# 可以**同时**拿到 ⇒ E-2 时序可观测（见步骤 4）。
#
# ## ⚠️ 关键实现选择 2：亲和性用 `app_deployments` 真行（不是伪造分区输入）
#
# `resolveDeploymentConstraintContext` 读的是 `app_deployments` 里
# `status='running'` 的行（全局默认 `deploymentPolicy=prefer`）⇒ 本脚本
# 真建一个应用 + 真插一条 running 部署行（指向评分**最差**的那台）
# ⇒ 若分区生效，任务必须落到那台；纯评分会选别人（同一份日志里两者都可见）。
#
# ## ⚠️ 关键实现选择 3：任务用 `glueSource`（内联 JS），**不是** zip 渠道
#
# harness 造任务的做法（`verify-smoke-firepoint.sh` 的 `create_cron_task`）就是
# `glueSource` + `glueLanguage`。⚠️ 但**只**给 `applicationId` 而不给
# `codeSource` 时，`resolveDispatchTask` 会按「存量 zip 兜底」把它当 zip 渠道
# （`codeSource == null && applicationId` 非空）⇒ 要求应用配 `packageUrl`，
# 否则派发在传输阶段前失败。故涉及 `applicationId` 的任务**必须显式**
# `codeSource: "glue"`（`TaskCodeSource.GLUE`）。
#
# ## 可重入
#
# 步骤 0a **跑前清理**：按 `tasks.name` / `applications.name` / `executors."appName"`
# 的确定性前缀 `smoke-disp-` 删掉**本脚本自己造的那批数据**（子表按本前缀任务的
# id 反查），并**验证清理生效**（计数 = 0）。每句 DELETE 都带 WHERE
# （`verify-smoke-selftest.sh` 的静态检查会扫这条）。
# ⇒ 「上一次跑到一半失败」能被下一次自动修复；连跑两次两次都 PASS。
#
# ## 时区纪律
#
# 一切时间比较都用 **DB 侧** `now()`（宿主 CST、容器/PG UTC）。本脚本把
# `lastHeartbeat` 也写成 `now()`（DB 侧），不用宿主 `date`。
#
# 用法：
#   ACF_SMOKE_ENV_FILE=/tmp/acf-smoke-env.sh ./scripts/verify-smoke-dispatch.sh
#   # 或经统一入口：./scripts/verify-smoke-all.sh --only=r5-dispatch
#
# 前置：`scripts/verify-smoke-stack.sh up`（已起栈）+ 镜像**本仓当前源码**构建。
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

API="http://127.0.0.1:${SMOKE_API_PORT}/api"
# 本脚本**全部**持久状态都落在这个前缀下（tasks.name / applications.name /
# executors."appName"）⇒ 清理与断言都只碰自己的数据。
PREFIX="smoke-disp-"
PAT="${PREFIX}%"

psql_q() { smoke_psql_q "$1"; }
api_logs() { docker logs "$SMOKE_API_CONTAINER" 2>&1; }

# 决策日志（E-2）：容器 JSON 日志里 `message` 字段是被转义的 JSON 串。
# ⚠️ **必须按 executionId 过滤**（不是任务名）：`docker logs` 是容器**全生命周期**
# 累积输出 ⇒ 上一轮同名任务的 decision 行还在 ⇒ 按名字统计会**跨轮次污染**
# （重跑时把上一轮的证据算进本轮 ⇒ 假绿/假红）。executionId 每轮新建 ⇒ 天然隔离。
decision_log_of() {
  local eid="${1:?need executionId}"
  api_logs | grep -F 'dispatch.decision' | grep -F "${eid}" | tail -1 \
    | jq -c '.message | fromjson' 2>/dev/null || true
}
# 在决策日志对象上取字段（$1 = 日志 JSON 串，$2 = jq 表达式）
# ⚠️ 空输入必须**短路**：`jq` 读到空串会报错，而 `set -e` + `pipefail` 下
#    在 `$( )` 里让它失败会让整个脚本静默中止（拿不到失败定位信息）。
lj() {
  local js="${1:-}" expr="${2:?need jq expr}"
  [[ -n "$js" ]] || { printf ''; return 0; }
  printf '%s' "$js" | jq -r "$expr" 2>/dev/null || printf ''
}

# 浮点比较（评分保留 3 位小数 ⇒ 容差 0.0015）
# ⚠️ 参数为空（jq 没取到字段）一律判否，绝不让 awk 把空串当 0 而**假绿**。
near() {
  [[ -n "${1:-}" && -n "${2:-}" ]] || return 1
  awk -v a="$1" -v b="$2" 'BEGIN{d=a-b; if(d<0)d=-d; exit !(d<=0.0015)}'
}
gt() {
  [[ -n "${1:-}" && -n "${2:-}" ]] || return 1
  awk -v a="$1" -v b="$2" 'BEGIN{exit !(a>b)}'
}

# ── 0a. 跑前清理（幂等的前提）─────────────────────────────────────────────
#
# 本脚本造的行：
#   · tasks（name ∈ smoke-disp-*）           + 它们的 task_executions
#   · applications（name ∈ smoke-disp-*）    + app_deployments（applicationId 反查）
#   · executors（appName ∈ smoke-disp-*）
#
# ⚠️ 为什么**执行器也要清**：执行器地址唯一性只在 push 模式成立
# （`uq_executors_address` 的 partial 谓词 `"dispatchMode" = 'push'`），
# 本脚本用 **pull** ⇒ 重注册会**新增同地址的第二行** ⇒ 候选池从 3 变 6
# ⇒ 评分的期望值全错。⇒ 每轮开始必须把上一轮的 3 行删干净并验证 = 0。
step "0a. 跑前清理（只删本脚本自己造的 smoke-disp-* 数据）"
if smoke_preclean_tasks "$PREFIX" "本脚本的任务：smoke-disp-rank / -aff / -dedup / -pin / -full / -none"; then
  ok "tasks 跑前清理完成（本前缀残留 = 0）"
else
  bad "tasks 跑前清理失败 ⇒ 中止（不带着脏数据继续跑）"
  exit 1
fi

clean_own_executor_rows() {
  # 子表优先：部署行 → 应用 → 执行器（每句都带 WHERE 前缀，绝不整表删）
  psql_q "delete from app_deployments where \"applicationId\" in (select id from applications where name like '${PAT}');" >/dev/null
  psql_q "delete from applications where name like '${PAT}';" >/dev/null
  psql_q "delete from executors where \"appName\" like '${PAT}';" >/dev/null
  # 验证清理生效：三张表的本前缀残留必须都是 0
  local apps execs deps
  apps="$(psql_q "select count(*) from applications where name like '${PAT}';")"
  execs="$(psql_q "select count(*) from executors where \"appName\" like '${PAT}';")"
  deps="$(psql_q "select count(*) from app_deployments where \"executorAddress\" like '10.9.9.%';")"
  [[ "$apps" == "0" && "$execs" == "0" && "$deps" == "0" ]]
}
if clean_own_executor_rows; then
  ok "执行器 / 应用 / 部署行跑前清理完成（三查残留 = 0）"
else
  bad "执行器 / 应用 / 部署行跑前清理失败（残留非 0）⇒ 中止"
  exit 1
fi

# ── 0b. 镜像与 /app/dist 核实（否则测的是旧代码 = 假通过）─────────────────
step "0b. 镜像重建核实 + /app/dist 是否为当前源码"
# 镜像是否包含当前源码：判据用 **git 内容**而不是文件 mtime（R13 统一，与
# `verify-smoke-dispatch-push.sh` 同口径）。
# ⚠️ 为什么不用 mtime：本仓是**多 agent 共用工作区**，任何一次「内容相同但重写一遍」的
#    落盘（生成器 / 另一个会话）都会把 `apps/admin-api/src` 的 mtime 顶到最新 ⇒
#    mtime 断言**假红**（R12 实测踩到：有文件被同内容重写、`git status` 干净，
#    而 mtime 断言却红 ⇒ **一次假红会让人怀疑"是不是又测了旧代码"，代价是整轮白跑**）。
# 内容判据两条：
#   · 工作区对 `apps/admin-api` 有**未提交改动** ⇒ 镜像内容不可信 ⇒ 红；
#   · 镜像 `Created` 晚于「最后一次改动 `apps/admin-api` 的**提交**时间」⇒ 绿。
IMG_CREATED="$(docker image inspect -f '{{.Created}}' "$SMOKE_IMAGE" 2>/dev/null || true)"
IMG_EPOCH="$(date -d "$IMG_CREATED" +%s 2>/dev/null || echo 0)"
LAST_COMMIT_EPOCH="$(git -C "$ROOT" log -1 --format=%ct -- apps/admin-api 2>/dev/null || echo 0)"
SRC_DIRTY="$(git -C "$ROOT" status --porcelain -- apps/admin-api 2>/dev/null | head -5)"
echo "    | 镜像 Created=${IMG_CREATED}(epoch=${IMG_EPOCH})；apps/admin-api 最后提交 epoch=${LAST_COMMIT_EPOCH}"
if [[ -n "$SRC_DIRTY" ]]; then
  bad "apps/admin-api 有未提交改动 ⇒ 镜像内容不可信（先提交/还原再跑）：$(printf '%s' "$SRC_DIRTY" | head -3 | tr '\n' ' ')"
elif [[ "$IMG_EPOCH" -ge "$LAST_COMMIT_EPOCH" && "$IMG_EPOCH" -gt 0 ]]; then
  ok "镜像 ${SMOKE_IMAGE} 晚于「最后一次改动 apps/admin-api 的提交」且工作区干净 ⇒ 镜像包含当前源码"
else
  bad "镜像 Created (epoch=${IMG_EPOCH}) 早于 apps/admin-api 最后提交 (epoch=${LAST_COMMIT_EPOCH}) ⇒ 测的是旧代码（重跑 verify-smoke-stack.sh up 且不要设 ACF_SMOKE_SKIP_BUILD=1）"
fi
# /app/dist 内容核实：排序协作者必须存在，且在本轮改动关心的三处日志/字段上可命中
DIST_COLLAB="/app/dist/modules/executor/executor-dispatch-ranking.collaborator.js"
if docker exec "$SMOKE_API_CONTAINER" test -f "$DIST_COLLAB" 2>/dev/null; then
  ok "/app/dist 内含排序协作者（${DIST_COLLAB}）"
else
  bad "/app/dist 缺排序协作者（${DIST_COLLAB}）⇒ 镜像不是本仓当前源码"
fi
for marker in "scoredSnapshot" "INTERP-CACHE" "ARCH-35"; do
  # ⚠️ `grep -c` 命中 0 时**仍会打印 0 并 exit 1** ⇒ 不能写 `|| echo 0`
  #（那样变量会变成两行 "0\n0" ⇒ `[[ 0\n0 -gt 0 ]]` 直接语法错）。
  n="$(docker exec "$SMOKE_API_CONTAINER" grep -c -- "$marker" "$DIST_COLLAB" 2>/dev/null || true)"
  n="${n:-0}"
  if [[ "${n}" -gt 0 ]]; then
    ok "/app/dist 的排序协作者含源码标记「${marker}」（命中 ${n} 处）"
  else
    bad "/app/dist 的排序协作者缺源码标记「${marker}」⇒ dist 与 src 不同源"
  fi
done

# ── 1. 登录 + 注册 3 台 pull 执行器 ───────────────────────────────────────
step "1. 登录并注册 3 台 pull 执行器（A 最早注册 / B 第二 / C 最近注册）"
TOKEN=""
for i in $(seq 1 30); do
  TOKEN="$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"$SMOKE_ADMIN_PW\"}" | jq -r '.data.accessToken // empty')"
  [[ -n "$TOKEN" ]] && break
  sleep 1
done
[[ -n "$TOKEN" ]] || { echo "✗ login failed" >&2; exit 2; }
ok "admin 登录成功"

register_executor() {
  # $1 = appName 后缀（a/b/c）；地址固定映射到 10.9.9.N:9001
  local suffix="${1:?need suffix}" addr
  case "$suffix" in
    a) addr="10.9.9.1:9001" ;;
    b) addr="10.9.9.2:9001" ;;
    c) addr="10.9.9.3:9001" ;;
    *) echo ""; return 1 ;;
  esac
  curl -s -X POST "$API/executors/register" -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $SMOKE_EXEC_SECRET" -d "{
      \"appName\": \"${PREFIX}e-${suffix}\",
      \"address\": \"${addr}\",
      \"type\": \"node\",
      \"version\": \"0.0.0-smoke\",
      \"capabilities\": [\"node\"],
      \"runtime\": [\"node\"],
      \"dispatchMode\": \"pull\",
      \"maxConcurrentTasks\": 10,
      \"groupName\": \"default\",
      \"tags\": [\"smoke\"],
      \"deviceFingerprint\": \"fp-${PREFIX}e-${suffix}\"
    }" | jq -r '.data.id // empty'
}
EXEC_A="$(register_executor a)"
EXEC_B="$(register_executor b)"
EXEC_C="$(register_executor c)"
[[ -n "$EXEC_A" && -n "$EXEC_B" && -n "$EXEC_C" ]] \
  && ok "3 台执行器注册成功（A=${EXEC_A} B=${EXEC_B} C=${EXEC_C}）" \
  || { bad "执行器注册失败（A='${EXEC_A}' B='${EXEC_B}' C='${EXEC_C}'）⇒ 中止"; exit 1; }

# register 之后回到 ONLINE；再显式按 DB 侧 now() 刷新心跳（防 stale sweep 在
# 本场景中途把它们判成 offline ⇒ 断言变成"无可用执行器"而误判）。
psql_q "update executors set status='online', \"lastHeartbeat\"=now() where \"appName\" like '${PAT}';" >/dev/null
ONLINE_N="$(psql_q "select count(*) from executors where \"appName\" like '${PAT}' and status='online' and \"dispatchMode\"='pull';")"
[[ "$ONLINE_N" == "3" ]] \
  && ok "3 台执行器在 DB 侧均为 online + pull 模式（实测 ${ONLINE_N} 行）" \
  || bad "执行器在线数不符（期望 3，实测 ${ONLINE_N}）"

# 注册顺序证据（A1 要断言"不是注册最早/最近那台"）
REG_ORDER="$(psql_q "select string_agg(\"appName\", ' -> ' order by \"createdAt\") from executors where \"appName\" like '${PAT}';")"
echo "    | 注册顺序（按 createdAt）：${REG_ORDER}"

# 设定评分输入（**确定性偏好**）：
#   score = 0.5×running/max + 0.25×cpu/100 + 0.25×mem/100 + 0.1×longTaskPenalty
#   全部 max=10、cpu/mem 显式给值 ⇒ 长任务惩罚项在本步为 0（本轮之前没有任何
#   指向这三台的 RUNNING 执行行 —— 上一步的跑前清理已删干净）。
#   A（最早注册）running=9 cpu=0  mem=0  ⇒ 0.450
#   B（第二注册）running=2 cpu=0  mem=0  ⇒ 0.100  ← 期望落点
#   C（最近注册）running=1 cpu=95 mem=95 ⇒ 0.525（在跑任务**最少**却评分最差）
set_exec_state() {
  # $1=appName 后缀 $2=running $3=max $4=cpu $5=mem（每句 UPDATE 都带 WHERE）
  psql_q "update executors set \"runningTaskCount\"=${2}, \"maxConcurrentTasks\"=${3}, \"cpuUsage\"=${4}, \"memUsage\"=${5}, status='online', \"lastHeartbeat\"=now() where \"appName\"='${PREFIX}e-${1}';" >/dev/null
}
set_exec_state a 9 10 0 0
set_exec_state b 2 10 0 0
set_exec_state c 1 10 95 95

create_glue_task() {
  # $1 = 任务名  $2 = 额外 JSON 片段（可空，形如 ,"executorId":"..."）
  local name="${1:?need name}" extra="${2:-}"
  curl -s -X POST "$API/tasks" -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${TOKEN}" -d "{
      \"name\": \"${name}\",
      \"triggerType\": \"manual\",
      \"runtime\": \"node\",
      \"timeout\": 60,
      \"maxRetry\": 0,
      \"glueSource\": \"console.log('smoke-dispatch');\",
      \"glueLanguage\": \"javascript\",
      \"codeSource\": \"glue\"${extra}
    }" | jq -r '.data.id // .errorCode // .message'
}
trigger_task() {
  local tid="${1:?need taskId}"
  curl -s -o /tmp/acf-smoke-dispatch-trig.json -w '%{http_code}' \
    -X POST "$API/tasks/${tid}/trigger" -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${TOKEN}" -d '{}'
}
# 等这次执行的派发结果落库；输出 "status|executorAddress|failureReason|errorMessage"
wait_exec() {
  local tid="${1:?need taskId}" out="" i
  for i in $(seq 1 60); do
    out="$(psql_q "select status::text || '|' || coalesce(\"executorAddress\",'') || '|' || coalesce(\"failureReason\"::text,'-') || '|' || coalesce(left(\"errorMessage\",200),'') from task_executions where \"taskId\"='${tid}' order by \"createdAt\" desc limit 1;")"
    case "${out}" in
      running\|*|failed\|*|timeout\|*|waiting\|*) break ;;
    esac
    sleep 1
  done
  printf '%s' "${out}"
}
exec_id_of() { psql_q "select id from task_executions where \"taskId\"='${1}' order by \"createdAt\" desc limit 1;"; }
exec_count_of() { psql_q "select count(*) from task_executions where \"taskId\"='${1}';"; }

# ── 2. A1：落到评分预期的执行器 ──────────────────────────────────────────
step "2. A1 落到评分预期的执行器（B：评分 0.100 最低；A 注册最早、C 注册最近、C 在跑任务最少）"
TASK_RANK="$(create_glue_task "${PREFIX}rank" "")"
[[ -n "$TASK_RANK" && "$TASK_RANK" != *"null"* ]] || { bad "任务创建失败：${TASK_RANK}"; exit 1; }
ok "任务 ${PREFIX}rank 已创建（id=${TASK_RANK}）"
# 占坑**前**的负载（DB 侧读数，供 A3 对比）
PRE_B="$(psql_q "select \"runningTaskCount\" from executors where \"appName\"='${PREFIX}e-b';")"
PRE_A="$(psql_q "select \"runningTaskCount\" from executors where \"appName\"='${PREFIX}e-a';")"
PRE_C="$(psql_q "select \"runningTaskCount\" from executors where \"appName\"='${PREFIX}e-c';")"
echo "    | 占坑前 runningTaskCount：A=${PRE_A} B=${PRE_B} C=${PRE_C}"
HTTP_TRIG="$(trigger_task "$TASK_RANK")"
[[ "$HTTP_TRIG" == "201" ]] && ok "触发成功（HTTP ${HTTP_TRIG}）" || bad "触发失败（HTTP ${HTTP_TRIG}）：$(head -c 200 /tmp/acf-smoke-dispatch-trig.json)"
EXEC_RANK="$(exec_id_of "$TASK_RANK")"
OUT_RANK="$(wait_exec "$TASK_RANK")"
ST_RANK="${OUT_RANK%%|*}"; REST="${OUT_RANK#*|}"; ADDR_RANK="${REST%%|*}"
# ⚠️ 占坑后的 DB 读数必须**当场**取：下面步骤 3 会把三台负载重新设回同样的值
#    （为了让"纯评分仍会选 B"这一前提在所有场景里一致），那会覆盖掉本次占坑的
#    +1 ⇒ 若把读数留到步骤 4 再取，A3 会看到"占坑没发生"这一假红。
POST_RTC_B="$(psql_q "select \"runningTaskCount\" from executors where \"appName\"='${PREFIX}e-b';")"
ok "执行行落库：status=${ST_RANK} executorAddress='${ADDR_RANK}'"
LOG_RANK="$(decision_log_of "$EXEC_RANK")"
if [[ -z "$LOG_RANK" ]]; then
  bad "找不到本轮 executionId=${EXEC_RANK} 的 dispatch.decision 日志 ⇒ 派发没走到排序环节（A1/A3 无法判读）"
else
  ok "拿到 dispatch.decision（executionId=${EXEC_RANK}）："
  printf '    | %s\n' "$LOG_RANK"
fi

ADDR_B="$(psql_q "select address from executors where \"appName\"='${PREFIX}e-b';")"
ADDR_A="$(psql_q "select address from executors where \"appName\"='${PREFIX}e-a';")"
ADDR_C="$(psql_q "select address from executors where \"appName\"='${PREFIX}e-c';")"

# A1-① 落点 = B（DB 侧执行行）
[[ "$ADDR_RANK" == "$ADDR_B" ]] \
  && ok "A1-① 执行行 executorAddress = B（${ADDR_B}）" \
  || bad "A1-① 执行行落在 '${ADDR_RANK}'，期望 B（${ADDR_B}）"
# A1-② 决策日志 selected = B，且 poolSize/afterFilters/scoredCount 都是 3
SEL_ADDR="$(lj "$LOG_RANK" '.selected.address')"
SEL_SCORE="$(lj "$LOG_RANK" '.selected.score')"
POOL="$(lj "$LOG_RANK" '.poolSize')"; AFTERF="$(lj "$LOG_RANK" '.afterFilters')"; SCORED="$(lj "$LOG_RANK" '.scoredCount')"
[[ "$SEL_ADDR" == "$ADDR_B" ]] \
  && ok "A1-② 决策日志 selected.address = B（${SEL_ADDR}）" \
  || bad "A1-② 决策日志 selected.address = '${SEL_ADDR}'，期望 B"
[[ "$POOL" == "3" && "$AFTERF" == "3" && "$SCORED" == "3" ]] \
  && ok "A1-③ 候选池口径：poolSize=${POOL} afterFilters=${AFTERF} scoredCount=${SCORED}（= 本脚本注册的 3 台）" \
  || bad "A1-③ 候选池口径不符（poolSize=${POOL} afterFilters=${AFTERF} scoredCount=${SCORED}，期望全 3）——机队里有非本脚本的执行器？"
# A1-④ 三台评分与公式算出的期望值一致（托底：不是"随便挑一台"）
RUNNERS="$(lj "$LOG_RANK" '.topRunners | length')"
[[ "$RUNNERS" == "3" ]] && ok "A1-④ 决策日志 topRunners 有 3 条" || bad "A1-④ topRunners 条数 = ${RUNNERS}（期望 3）"
score_of() { lj "$LOG_RANK" ".topRunners[] | select(.address==\"${1}\") | .score"; }
rtc_of()   { lj "$LOG_RANK" ".topRunners[] | select(.address==\"${1}\") | .runningTaskCount"; }
S_A="$(score_of "$ADDR_A")"; S_B="$(score_of "$ADDR_B")"; S_C="$(score_of "$ADDR_C")"
echo "    | 决策日志评分：A=${S_A} B=${S_B} C=${S_C}（期望 0.450 / 0.100 / 0.525）"
near "$S_A" 0.450 && ok "A1-⑤ A 的评分 = 0.450（公式 0.5×9/10）" || bad "A1-⑤ A 的评分 = ${S_A}，期望 0.450"
near "$S_B" 0.100 && ok "A1-⑥ B 的评分 = 0.100（公式 0.5×2/10）" || bad "A1-⑥ B 的评分 = ${S_B}，期望 0.100"
near "$S_C" 0.525 && ok "A1-⑦ C 的评分 = 0.525（0.5×1/10 + 0.25×0.95×2）—— 在跑任务最少却评分最差" || bad "A1-⑦ C 的评分 = ${S_C}，期望 0.525"
# A1-⑧ 期望落点既不是注册最早、也不是注册最近、也不是"在跑任务最少"
if [[ "$ADDR_RANK" == "$ADDR_B" && "$ADDR_B" != "$ADDR_A" && "$ADDR_B" != "$ADDR_C" ]]; then
  ok "A1-⑧ 落点 B 既不是注册最早（A）也不是最近（C），且不是 runningTaskCount 最小（C=1）⇒ 名次由加权评分决定，不是遍历/注册顺序"
else
  bad "A1-⑧ 落点无法排除「注册顺序/最小负载」两种平凡解释"
fi

# ── 3. A2：部署偏好分区 ─────────────────────────────────────────────────
step "3. A2 偏好分区：给 C（评分最差）造一条 running 部署行 ⇒ 任务必须落到 C"
APP_ID="$(curl -s -X POST "$API/applications" -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${TOKEN}" \
  -d "{\"name\":\"${PREFIX}app\",\"version\":\"1.0.0\",\"runtime\":\"node\"}" \
  | jq -r '.data.id // .errorCode // .message')"
[[ -n "$APP_ID" && "$APP_ID" != *"null"* ]] || { bad "应用创建失败：${APP_ID}"; exit 1; }
ok "应用 ${PREFIX}app 已创建（id=${APP_ID}）"
# 部署行：applicationId + executorAddress（id 兜底匹配）+ status='running'
psql_q "insert into app_deployments (\"applicationId\", \"executorAddress\", \"executorId\", status, \"deployedAt\") values ('${APP_ID}', '${ADDR_C}', '${EXEC_C}', 'running', now());" >/dev/null
DEP_N="$(psql_q "select count(*) from app_deployments where \"applicationId\"='${APP_ID}' and status='running';")"
[[ "$DEP_N" == "1" ]] && ok "app_deployments 里 1 条 running 行（executorAddress=${ADDR_C}）" || bad "部署行未落库（实测 ${DEP_N} 行）"
# 重新设定同样的负载（保证"纯评分仍会选 B"这一前提不变）
set_exec_state a 9 10 0 0
set_exec_state b 2 10 0 0
set_exec_state c 1 10 95 95
TASK_AFF="$(create_glue_task "${PREFIX}aff" ",\"applicationId\":\"${APP_ID}\"")"
[[ -n "$TASK_AFF" && "$TASK_AFF" != *"null"* ]] || { bad "亲和任务创建失败：${TASK_AFF}"; exit 1; }
ok "任务 ${PREFIX}aff 已创建（id=${TASK_AFF}，绑定应用 + codeSource=glue）"
HTTP_AFF="$(trigger_task "$TASK_AFF")"
[[ "$HTTP_AFF" == "201" ]] && ok "触发成功（HTTP ${HTTP_AFF}）" || bad "触发失败（HTTP ${HTTP_AFF}）"
EXEC_AFF="$(exec_id_of "$TASK_AFF")"
OUT_AFF="$(wait_exec "$TASK_AFF")"
ST_AFF="${OUT_AFF%%|*}"; REST="${OUT_AFF#*|}"; ADDR_AFF="${REST%%|*}"
ok "执行行落库：status=${ST_AFF} executorAddress='${ADDR_AFF}'"
LOG_AFF="$(decision_log_of "$EXEC_AFF")"
if [[ -z "$LOG_AFF" ]]; then
  bad "找不到 A2 的 dispatch.decision 日志（executionId=${EXEC_AFF}）"
else
  printf '    | %s\n' "$LOG_AFF"
  AFF_SEL="$(lj "$LOG_AFF" '.selected.address')"
  AFF_SEL_SCORE="$(lj "$LOG_AFF" '.selected.score')"
  AFF_PREF="$(lj "$LOG_AFF" '.deploymentAffinity.preferred')"
  AFF_BY_ID="$(lj "$LOG_AFF" '.deploymentAffinity.matchedByExecutorId')"
  AFF_RUNNING="$(lj "$LOG_AFF" '.deploymentAffinity.runningDeployments')"
  AFF_MIN="$(lj "$LOG_AFF" '.topRunners | map(.score) | min')"
  [[ "$ADDR_AFF" == "$ADDR_C" ]] \
    && ok "A2-① 执行行落在 C（${ADDR_C}，有亲和性那台）" \
    || bad "A2-① 执行行落在 '${ADDR_AFF}'，期望 C（${ADDR_C}）"
  [[ "$AFF_SEL" == "$ADDR_C" ]] \
    && ok "A2-② 决策日志 selected.address = C" \
    || bad "A2-② 决策日志 selected.address = '${AFF_SEL}'，期望 C"
  [[ "$AFF_PREF" == "1" && "$AFF_BY_ID" == "1" && "$AFF_RUNNING" == "1" ]] \
    && ok "A2-③ deploymentAffinity = {preferred:1, matchedByExecutorId:1, runningDeployments:1}（按 id 精确命中）" \
    || bad "A2-③ deploymentAffinity 不符（preferred=${AFF_PREF} byId=${AFF_BY_ID} running=${AFF_RUNNING}）"
  # A2-④ 反事实：C 的评分**不是**最优 ⇒ 落 C 只能是分区造成的
  if gt "$AFF_SEL_SCORE" "$AFF_MIN"; then
    ok "A2-④ 反事实成立：C 的评分 ${AFF_SEL_SCORE} > 全候选最低分 ${AFF_MIN} ⇒ 纯评分会派给别人，落 C 是偏好分区生效"
  else
    bad "A2-④ 反事实不成立：C 的评分 ${AFF_SEL_SCORE} 已是最低（${AFF_MIN}）⇒ 落 C 可由纯评分解释，分区未被证明生效"
  fi
fi

# ── 4. A3：scoredSnapshot 在占坑前截取（E-2）─────────────────────────────
step "4. A3 scoredSnapshot 占坑前截取（E-2）：同一份日志里同时可见占坑前与占坑后读数"
if [[ -z "$LOG_RANK" ]]; then
  bad "A3 无法判读：A1 的 decision 日志缺失"
else
  LOG_RTC_B="$(rtc_of "$ADDR_B")"
  SEL_RTC="$(lj "$LOG_RANK" '.selected.runningTaskCount')"
  POST_B="${POST_RTC_B}"
  echo "    | 占坑前 DB：B=${PRE_B}；日志 topRunners 里 B=${LOG_RTC_B}（快照）；日志 selected=${SEL_RTC}（占坑后实体）；占坑后 DB（当场取）：B=${POST_B}"
  # ① 快照 = 占坑前的 DB 读数
  [[ "$LOG_RTC_B" == "$PRE_B" ]] \
    && ok "A3-① 快照里的 B.runningTaskCount = ${LOG_RTC_B} = 占坑前 DB 读数（快照在 mutate 之前截取）" \
    || bad "A3-① 快照里的 B.runningTaskCount = ${LOG_RTC_B}，占坑前 DB = ${PRE_B}（快照取晚了？）"
  # ② 同一条日志的 selected 是**占坑后**的实体（+1）
  [[ "$SEL_RTC" == "$((PRE_B + 1))" ]] \
    && ok "A3-② 同一日志的 selected.runningTaskCount = ${SEL_RTC} = 占坑前 +1 ⇒ selected 读的是占坑后实体，而快照保持占坑前 ⇒ 两者**在同一份日志里**可区分" \
    || bad "A3-② selected.runningTaskCount = ${SEL_RTC}，期望 $((PRE_B + 1))（占坑前 ${PRE_B} + 1）"
  # ③ DB 侧确认占坑真的发生了（不是"日志写了但没占"）
  [[ "$POST_B" == "$((PRE_B + 1))" ]] \
    && ok "A3-③ 占坑后 DB 里 B.runningTaskCount = ${POST_B}（= 占坑前 ${PRE_B} + 1）⇒ 槽位确实被占（pull 模式不回滚）" \
    || bad "A3-③ 占坑后 DB 里 B.runningTaskCount = ${POST_B}，期望 $((PRE_B + 1))"
  # ④ 快照里的 score 用的是**占坑前**负载算出来的（0.5×2/10=0.100，不是 0.5×3/10=0.150）
  if near "$S_B" 0.100; then
    ok "A3-④ 快照里的评分 0.100 对应占坑前负载 2/10（若在占坑后取会是 0.150）⇒ 排序依据是本轮开始时的负载"
  else
    bad "A3-④ 快照里的评分 ${S_B} 不是 0.100（占坑后会是 0.150）⇒ 无法排除「先占坑再评分」"
  fi
  # ⑤ 快照与占坑互不影响：C（本轮被跳过）的读数保持占坑前值（没被顺手改）
  RTC_C="$(rtc_of "$ADDR_C")"
  [[ "$RTC_C" == "$PRE_C" ]] \
    && ok "A3-⑤ 同轮落选的 C 在快照里的读数 = ${RTC_C} = 占坑前值（本轮占坑只动选中那台）" \
    || bad "A3-⑤ C 在快照里的读数 = ${RTC_C}，占坑前 = ${PRE_C}"
fi

# ── 5. A4：重复派发抑制仍在 ─────────────────────────────────────────────
step "5. A4 重复派发抑制：同一任务（同参）在跑时再次触发 ⇒ 被拒、不会派第二次"
#
# ⚠️ 场景为什么这样造（本轮实测教训，别改成"5 个并发一起打"）：
#   `blockStrategy` 闸门只把 **RUNNING / WAITING** 计入"前一轮还没跑完"，
#   **PENDING 刻意不计入**（`block-strategy-gate.ts` 头注：BullMQ backlog 是常态）。
#   于是对一条**刚建好、还没派发**的任务同时打 5 个触发，5 个请求在闸门看来都是
#   "没有同参执行在跑" ⇒ 真会出现 2×201（本轮实测 409/409/409/201/201）。
#   那不是"重复派发抑制失效"，是**闸门的既定语义**（PENDING 不算在跑）。
#   ⇒ 要确定性验证「同一任务不会被派两次」，就必须让第一次派发**先落到 RUNNING**，
#     再打第二次：此时闸门必然命中 ⇒ 409。
TASK_DED="$(create_glue_task "${PREFIX}dedup" "")"
[[ -n "$TASK_DED" && "$TASK_DED" != *"null"* ]] || { bad "去重任务创建失败：${TASK_DED}"; exit 1; }
psql_q "update tasks set \"blockStrategy\"='discard' where id='${TASK_DED}';" >/dev/null
BS="$(psql_q "select \"blockStrategy\"::text from tasks where id='${TASK_DED}';")"
[[ "$BS" == "discard" ]] && ok "任务 ${PREFIX}dedup 的 blockStrategy=discard（同参在跑即放弃本轮）" || bad "blockStrategy 未落库（实测 '${BS}'）"
set_exec_state a 1 10 0 0
set_exec_state b 1 10 0 0
set_exec_state c 1 10 0 0
SLOT_SUM_PRE="$(psql_q "select sum(\"runningTaskCount\") from executors where \"appName\" like '${PAT}';")"
HTTP_FIRST="$(trigger_task "$TASK_DED")"
[[ "$HTTP_FIRST" == "201" ]] && ok "A4-① 第一次触发被接受（HTTP ${HTTP_FIRST}）" || bad "A4-① 第一次触发返回 ${HTTP_FIRST}（期望 201）"
# 等它真的派发到 RUNNING（闸门只看 RUNNING/WAITING）
for i in $(seq 1 45); do
  ST1="$(psql_q "select status::text from task_executions where \"taskId\"='${TASK_DED}' order by \"createdAt\" desc limit 1;")"
  [[ "$ST1" == "running" ]] && break
  sleep 1
done
[[ "$ST1" == "running" ]]   && ok "A4-② 第一次执行已派发并落 RUNNING（闸门此时必然命中同参执行）"   || bad "A4-② 第一次执行未进入 running（实测 '${ST1}'）⇒ 后续 409 无法归因于闸门"
HTTP_SECOND="$(trigger_task "$TASK_DED")"
SEC_CODE="$(jq -r '.errorCode // "OK"' /tmp/acf-smoke-dispatch-trig.json 2>/dev/null || echo '?')"
echo "    | 第二次触发的 HTTP=${HTTP_SECOND} errorCode=${SEC_CODE}"
[[ "$HTTP_SECOND" == "409" ]]   && ok "A4-③ 第二次触发被拒（HTTP 409）⇒ 同一任务不会被派第二次"   || bad "A4-③ 第二次触发返回 ${HTTP_SECOND}（期望 409）——重复派发抑制可能失效"
# 拒绝码：本场景任务显式 blockStrategy=discard ⇒ 闸门抛
# TASK_BLOCK_STRATEGY_REJECTED（`block-strategy-gate.ts`：「discard：同参在跑即
# 放弃本轮（手动/API 面 409）」）。另一条合法出口是触发闸门的 Redis 短锁 →
# TASK_TRIGGER_CONCURRENT（并发请求抢锁时）。两条都是「同一任务不会被派两次」
# 的实现面 ⇒ 两个都接受，但**必须打印实际是哪一个**（不打印等于没判）。
if [[ "$SEC_CODE" == "TASK_BLOCK_STRATEGY_REJECTED" || "$SEC_CODE" == "TASK_TRIGGER_CONCURRENT" ]]; then
  ok "A4-④ 拒绝码 = ${SEC_CODE}（duplicate-dispatch 的两条合法出口之一）"
else
  bad "A4-④ 拒绝码 = '${SEC_CODE}'（期望 TASK_BLOCK_STRATEGY_REJECTED 或 TASK_TRIGGER_CONCURRENT）"
fi
N_EXEC="$(exec_count_of "$TASK_DED")"
[[ "$N_EXEC" == "1" ]]   && ok "A4-⑤ 该任务只有 1 条执行行（不是 2 条）"   || bad "A4-⑤ 该任务有 ${N_EXEC} 条执行行（期望 1）"
sleep 2
EXEC_DED="$(exec_id_of "$TASK_DED")"
LOG_N_DED="$(api_logs | grep -F 'dispatch.decision' | grep -cF "$EXEC_DED" || true)"
[[ "${LOG_N_DED:-0}" == "1" ]]   && ok "A4-⑥ 该执行只产生 1 条 dispatch.decision（实测 ${LOG_N_DED:-0} 条）⇒ 一次执行只派一次"   || bad "A4-⑥ 该执行产生了 ${LOG_N_DED:-0} 条 dispatch.decision（期望 1）"
SLOT_SUM_POST="$(psql_q "select sum(\"runningTaskCount\") from executors where \"appName\" like '${PAT}';")"
[[ "$SLOT_SUM_POST" == "$((SLOT_SUM_PRE + 1))" ]]   && ok "A4-⑦ 三台槽位总和 ${SLOT_SUM_PRE} → ${SLOT_SUM_POST}（只 +1 ⇒ 只占了一个坑）"   || bad "A4-⑦ 槽位总和 ${SLOT_SUM_PRE} → ${SLOT_SUM_POST}（期望 +1）"

# ── 6. A5-①：PINNED_EXECUTOR_AT_CAPACITY ───────────────────────────────
step "6. A5-① 失败出口「钉定的那台满了」⇒ PINNED_EXECUTOR_AT_CAPACITY"
# 只把 A 塞满（B/C 空闲）⇒ 若失败原因是「全机队没容量」就说明 pinned 专属码丢了
set_exec_state a 10 10 0 0
set_exec_state b 0 10 0 0
set_exec_state c 0 10 0 0
FREE_N="$(psql_q "select count(*) from executors where \"appName\" like '${PAT}' and \"runningTaskCount\" < \"maxConcurrentTasks\";")"
[[ "$FREE_N" == "2" ]] && ok "场景构造：只有 A 满载（10/10），另有 ${FREE_N} 台空闲 ⇒ 失败必须指向「钉定那台」" || bad "场景构造失败：空闲执行器 ${FREE_N} 台（期望 2）"
TASK_PIN="$(create_glue_task "${PREFIX}pin" ",\"executorId\":\"${EXEC_A}\"")"
[[ -n "$TASK_PIN" && "$TASK_PIN" != *"null"* ]] || { bad "pinned 任务创建失败：${TASK_PIN}"; exit 1; }
HTTP_PIN="$(trigger_task "$TASK_PIN")"
OUT_PIN="$(wait_exec "$TASK_PIN")"
ST_PIN="${OUT_PIN%%|*}"; REST="${OUT_PIN#*|}"; ADDR_PIN="${REST%%|*}"; REST="${REST#*|}"; FR_PIN="${REST%%|*}"; ERR_PIN="${REST#*|}"
echo "    | status=${ST_PIN} addr='${ADDR_PIN}' failureReason=${FR_PIN} errorMessage=${ERR_PIN}"
[[ "$ST_PIN" == "failed" ]] && ok "A5①-① 执行落 failed（触发 HTTP ${HTTP_PIN}）" || bad "A5①-① 执行状态 = ${ST_PIN}（期望 failed）"
[[ -z "$ADDR_PIN" ]] && ok "A5①-② 未派发出去（executorAddress 为空）⇒ 失败发生在占坑阶段" || bad "A5①-② executorAddress='${ADDR_PIN}'（期望空）"
grep -q '已达到并发上限' <<<"$ERR_PIN" \
  && ok "A5①-③ 错误文案是 pinned 专属码（含「已达到并发上限」）⇒ 不是通用的「没有可用执行器」" \
  || bad "A5①-③ 错误文案不含「已达到并发上限」（实测：${ERR_PIN}）"
grep -q '指定的固定执行器' <<<"$ERR_PIN" \
  && ok "A5①-④ 文案点名「指定的固定执行器」+ 具体执行器名 ⇒ 运维能定位到 pin 的那台" \
  || bad "A5①-④ 文案未点名固定执行器"

# ── 7. A5-②：NO_DISPATCHABLE_EXECUTOR ─────────────────────────────────
step "7. A5-② 失败出口「全部在线但全部满载」⇒ NO_DISPATCHABLE_EXECUTOR"
set_exec_state a 10 10 0 0
set_exec_state b 10 10 0 0
set_exec_state c 10 10 0 0
ON_N="$(psql_q "select count(*) from executors where \"appName\" like '${PAT}' and status='online';")"
FREE_N="$(psql_q "select count(*) from executors where \"appName\" like '${PAT}' and \"runningTaskCount\" < \"maxConcurrentTasks\";")"
[[ "$ON_N" == "3" && "$FREE_N" == "0" ]] \
  && ok "场景构造：3 台全部在线、0 台有空槽（与 A5-① 的「只满 1 台」不同）" \
  || bad "场景构造失败（在线 ${ON_N} / 空闲 ${FREE_N}）"
TASK_FULL="$(create_glue_task "${PREFIX}full" "")"
HTTP_FULL="$(trigger_task "$TASK_FULL")"
OUT_FULL="$(wait_exec "$TASK_FULL")"
ST_FULL="${OUT_FULL%%|*}"; REST="${OUT_FULL#*|}"; ADDR_FULL="${REST%%|*}"; REST="${REST#*|}"; FR_FULL="${REST%%|*}"; ERR_FULL="${REST#*|}"
echo "    | status=${ST_FULL} addr='${ADDR_FULL}' failureReason=${FR_FULL} errorMessage=${ERR_FULL}"
[[ "$ST_FULL" == "failed" ]] && ok "A5②-① 执行落 failed（触发 HTTP ${HTTP_FULL}）" || bad "A5②-① 执行状态 = ${ST_FULL}（期望 failed）"
[[ -z "$ADDR_FULL" ]] && ok "A5②-② 未派发出去（executorAddress 为空）" || bad "A5②-② executorAddress='${ADDR_FULL}'（期望空）"
grep -q '没有可用的执行器（所有候选执行器都已离线或达到容量上限）' <<<"$ERR_FULL" \
  && ok "A5②-③ 错误文案 = NO_DISPATCHABLE_EXECUTOR 的中文兜底「没有可用的执行器（…离线或达到容量上限）」" \
  || bad "A5②-③ 文案不符（实测：${ERR_FULL}）"
[[ "$FR_FULL" == "executor_offline" ]] \
  && ok "A5②-④ failureReason = executor_offline（与文案同源的分类口径）" \
  || bad "A5②-④ failureReason = ${FR_FULL}（期望 executor_offline）"

# ── 8. A5-③：NO_EXECUTOR_MATCHING_FILTERS ─────────────────────────────
step "8. A5-③ 失败出口「没有在线执行器」⇒ NO_EXECUTOR_MATCHING_FILTERS"
psql_q "update executors set status='offline', \"offlineReason\"='manual' where \"appName\" like '${PAT}';" >/dev/null
OFF_N="$(psql_q "select count(*) from executors where \"appName\" like '${PAT}' and status='offline';")"
[[ "$OFF_N" == "3" ]] && ok "场景构造：3 台全部 offline（候选池为空，与 A5-② 的「在线但满载」不同）" || bad "场景构造失败（offline ${OFF_N} 台）"
TASK_NONE="$(create_glue_task "${PREFIX}none" "")"
HTTP_NONE="$(trigger_task "$TASK_NONE")"
OUT_NONE="$(wait_exec "$TASK_NONE")"
ST_NONE="${OUT_NONE%%|*}"; REST="${OUT_NONE#*|}"; ADDR_NONE="${REST%%|*}"; REST="${REST#*|}"; FR_NONE="${REST%%|*}"; ERR_NONE="${REST#*|}"
echo "    | status=${ST_NONE} addr='${ADDR_NONE}' failureReason=${FR_NONE} errorMessage=${ERR_NONE}"
[[ "$ST_NONE" == "failed" ]] && ok "A5③-① 执行落 failed（触发 HTTP ${HTTP_NONE}）" || bad "A5③-① 执行状态 = ${ST_NONE}（期望 failed）"
grep -q '没有在线执行器匹配所请求的 group/tags/runtime' <<<"$ERR_NONE" \
  && ok "A5③-② 错误文案 = NO_EXECUTOR_MATCHING_FILTERS 的中文兜底（「没有在线执行器匹配…」）" \
  || bad "A5③-② 文案不符（实测：${ERR_NONE}）"
# 三条失败出口的文案必须**两两不同**（否则"分别造出来"只是自我安慰）
if [[ "$ERR_PIN" != "$ERR_FULL" && "$ERR_FULL" != "$ERR_NONE" && "$ERR_PIN" != "$ERR_NONE" ]]; then
  ok "A5-④ 三条失败出口的文案两两不同 ⇒ 确实是三个**独立**的出口，不是同一个出口换了措辞"
else
  bad "A5-④ 失败文案有重合（pin='${ERR_PIN}' full='${ERR_FULL}' none='${ERR_NONE}'）"
fi

# ── 9. 跑后清理 + 本脚本自己的残留四查（DB 侧）──────────────────────────
step "9. 跑后清理（只删本脚本自己造的 smoke-disp-* 数据）"
psql_q "update executors set status='online', \"runningTaskCount\"=0 where \"appName\" like '${PAT}';" >/dev/null
if smoke_clean_tasks "$PREFIX" "本脚本全部任务及其执行行 / 日志行 / 审计行" && clean_own_executor_rows; then
  ok "跑后清理完成（tasks / executors / applications / app_deployments 本前缀残留均 = 0）"
else
  bad "跑后清理失败（不影响可重入：下一次跑的步骤 0a 会再清一次）"
fi

printf '\n=== 场景 8（dispatch 排序与偏好分区）小结：PASS=%d FAIL=%d ===\n' "$PASS" "$FAIL"
[[ "$FAIL" == "0" ]] || exit 1
exit 0
