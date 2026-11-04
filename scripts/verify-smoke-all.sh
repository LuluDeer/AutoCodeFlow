#!/usr/bin/env bash
#
# verify-smoke-all.sh —— **真机矩阵统一入口**：串行跑完全部 9 个冒烟脚本。
#
# ## 这是什么
#
# R5（调度/队列/迁移）与 R6（S3 日志后端）两轮共 9 个 `verify-smoke-*` 脚本，
# 此前**没有一个统一入口** ⇒ 「怎么把整套矩阵重跑一遍」这件事没有答案。
# 本脚本就是那个答案：**一条命令跑完全部 7 个场景**，任一失败即停并打印定位信息。
#
# | # | 场景名 | 组 | 被验内容 |
# |---|---|---|---|
# | 1 | `r5-migration` | R5 | 迁移 `1790000000096` 真跑（up / 幂等 / down） |
# | 2 | `r5-firepoint` | R5 | A6b 提前触发并消耗下一个 cron 落点（真等落点） |
# | 3 | `r5-misfire` | R5 | A6 补偿窗口收紧 + warn 级 + 30 分钟限流（等自然 tick） |
# | 4 | `r5-retention` | R5 | X5 retention 真库真删除 |
# | 5 | `r6-s3-write-read` | R6 | S3 写入 + 读取（含超单页上限的长日志分页） |
# | 6 | `r6-s3-retention` | R6 | S3 保留期对象回收 |
# | 7 | `r6-s3-fallback` | R6 | S3 不可用时回退到 DB（真停容器） |
#
# R5 与 R6 用**两套栈**（端口/容器不同）⇒ 本脚本按组**串行**跑、切组时销毁上一套。
# （两组共用 55432/56379/43105 三个端口，所以**必须串行**。）
#
# ## 为什么**不**接进 CI
#
# · 真机矩阵的**前提是 Docker daemon**（CI 的常规 job 多数无 docker-in-docker
#   权限，且真机栈的启动/销毁成本是**分钟级**，不是秒级单测）。
# · 场景 2/3 **必须真等 cron 落点与自然 tick**（`@Cron("0 */5 * * * *")`）⇒
#   单是这两个场景就 ~10 分钟；接进 CI 会把每次 push 的时长拖到不可接受。
# · 真机矩阵验的是**部署形态**（端口、时区、镜像、对象存储），CI 的 e2e job
#   跑在另一种拓扑里 ⇒ 验不到真机矩阵要验的那些面。
# · ⇒ 定位：**本机 / 发版前手工跑**（pre-release checklist 的一个可执行条目）。
#
# ## 前置依赖
#
# | 依赖 | 说明 | 缺了会怎样 |
# |---|---|---|
# | Docker daemon | 必须可 `docker info` | 第 0 步就报「cannot talk to the Docker daemon」 |
# | 宿主工具 | `bash` / `curl` / `jq` / `node ≥18` | 各场景脚本自己报缺哪个 |
# | 镜像 `acf-smoke-admin-api:r5` | **默认自动构建**（`ACF_SMOKE_SKIP_BUILD=1` 可跳过） | 未预拉时构建需几分钟 |
# | 镜像 `docker.1ms.run/rustfs/rustfs:1.0.4` | **不自动拉取**（R6 用） | R6 场景报「rustfs image … not present locally」⇒ `docker pull docker.1ms.run/rustfs/rustfs:1.0.4` |
# | 宿主端口 | 55432 / 56379 / 43105（R5+R6 共用，**串行**故不冲突）/ 59000 / 59001（R6） | 被占时脚本明确报错并给出覆盖变量 |
#
# ## 总耗时（**实测**，本机，2026-11-04，`ACF_SMOKE_SKIP_BUILD=1` 即复用已有镜像）
#
# | 场景 | 实测耗时 | 为什么慢 |
# |---|---|---|
# | r5-migration | **4s** | 全是 DDL/DML |
# | r5-firepoint | **~5.8min** | **必须真等 cron 落点**（每分钟一拍）+ 一次 admin-api 重启 |
# | r5-misfire | **~2.8min** | **必须等自然 tick**（`@Cron("0 */5 * * * *")`）+ 一次重启 |
# | r5-retention | **1s** | 5001 行批量插入 + 真删除 |
# | r6-s3-write-read | **2s** | 2500 行长日志写入 + 分页读回 |
# | r6-s3-retention | **1s** | 造 6 条执行行 + 真回收 |
# | r6-s3-fallback | **9s** | 真停/启 RustFS 容器 |
# | **栈起停（4 次）** | ~40s | 两次 R5 + 两次 R6 的起/停 |
# | **合计** | **~9 分钟**（实测 548s） | 不含首次构建镜像的 2–5 分钟 |
#
# ⇒ **95% 的时间花在两个「必须等」的场景**上（cron 落点 / 自然 tick）——
# 这正是**不接 CI** 的原因（见上）。
#
# ## 失败时怎么定位
#
# · 每一步的**全部输出**落 `/tmp/acf-smoke-<场景名>.log`（覆盖式，非追加）。
# · 失败时脚本打印：**已跑完哪些 / 卡在哪个 / 该步日志路径 / 该步耗时**。
# · 场景名与日志文件名一一对应（见下方 `--list`）。
# · 各场景脚本**自己**会打印逐条 ✓/✗ 与关键输出（DB 查询结果 / 日志原文），
#   所以定位不需要额外工具。
#
# ## 用法
#
#   ./scripts/verify-smoke-all.sh                 # 跑全部
#   ./scripts/verify-smoke-all.sh --list          # 列出场景名
#   ./scripts/verify-smoke-all.sh --only=r5-migration
#   ./scripts/verify-smoke-all.sh --skip=r6-s3-fallback
#   ./scripts/verify-smoke-all.sh --keep-stack    # 跑完不销毁栈（留现场调试）
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG_DIR="${ACF_SMOKE_LOG_DIR:-/tmp}"
KEEP_STACK=0
ONLY=""
SKIP=""

# ── 场景表 ────────────────────────────────────────────────────────────────
# 格式： <名字>|<组>|<描述>|<执行函数>
# 组决定用哪套栈（R5 与 R6 的端口/容器不同，但**串行**跑 ⇒ 不冲突）。
SCENARIOS=(
  "r5-migration|R5|迁移 1790000000096 真跑（up / 幂等 / down）|run_r5_migration"
  "r5-firepoint|R5|A6b 提前触发并消耗下一个 cron 落点（真等落点）|run_r5_firepoint"
  "r5-misfire|R5|A6 补偿窗口收紧 + warn 级 + 30 分钟限流（等自然 tick）|run_r5_misfire"
  "r5-retention|R5|X5 retention 真库真删除|run_r5_retention"
  "r5-dispatch|R5|dispatch 候选排序 / 部署偏好分区 / E-2 快照 / 重复派发抑制 / 三条失败出口（真机）|run_r5_dispatch"
  "r5-rollout-claim|R5|灰度 claim 部分唯一索引（23505 / NULL 不受限 / 释放重 claim / 跨应用 / 并发）|run_r5_rollout_claim"
  "r6-s3-write-read|R6|S3 写入路径 + 读取路径（含超单页上限的长日志）|run_r6_write_read"
  "r6-s3-retention|R6|S3 保留期对象回收|run_r6_retention"
  "r6-s3-fallback|R6|S3 不可用时回退到 DB（真停容器）|run_r6_fallback"
)

usage() {
  sed -n '2,50p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --only=*)   ONLY="${1#*=}" ;;
    --skip=*)   SKIP="${1#*=}" ;;
    --keep-stack) KEEP_STACK=1 ;;
    --list)
      printf '可用场景名（--only= / --skip= 用这些）：\n'
      for row in "${SCENARIOS[@]}"; do
        IFS='|' read -r n g d _ <<<"$row"
        printf '  %-20s [%s] %s\n' "$n" "$g" "$d"
      done
      exit 0
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1（--help 看用法）" >&2; exit 2 ;;
  esac
  shift
done

# ── 基础设施 ──────────────────────────────────────────────────────────────
log()  { printf '\n\033[1m[smoke-all] %s\033[0m\n' "$*"; }
die()  { printf '\033[31m[smoke-all] ✗ %s\033[0m\n' "$*" >&2; exit 1; }
step(){ printf '[smoke-all] %s\n' "$*"; }

# 残留检查：容器 / 网络 / 卷（栈名一律 acfsmoke-* 前缀 ⇒ 不会误伤现网）
residual_report() {
  local c n v
  c="$(docker ps -a --filter name=acfsmoke --format '{{.Names}}' 2>/dev/null | tr '\n' ' ')"
  n="$(docker network ls --filter name=acfsmoke --format '{{.Name}}' 2>/dev/null | tr '\n' ' ')"
  v="$(docker volume ls --filter name=acfsmoke --format '{{.Name}}' 2>/dev/null | tr '\n' ' ')"
  RESIDUAL="containers=[${c:- }] networks=[${n:- }] volumes=[${v:- }]"
  if [[ -n "${c// /}" || -n "${n// /}" || -n "${v// /}" ]]; then
    RESIDUAL_OK=0
  else
    RESIDUAL_OK=1
  fi
}

# ── 栈管理 ────────────────────────────────────────────────────────────────
R5_ENV="${LOG_DIR}/acf-smoke-env-r5.sh"
R6_ENV="${LOG_DIR}/acf-smoke-env-r6.sh"

stack_up_r5() {
  ACF_SMOKE_ENV_FILE="$R5_ENV" "$ROOT/scripts/verify-smoke-stack.sh" up
}
stack_down_r5() {
  ACF_SMOKE_ENV_FILE="$R5_ENV" "$ROOT/scripts/verify-smoke-stack.sh" down
}
stack_up_r6() {
  ACF_SMOKE_ENV_FILE="$R6_ENV" "$ROOT/scripts/verify-smoke-s3-stack.sh" up
}
stack_down_r6() {
  ACF_SMOKE_ENV_FILE="$R6_ENV" "$ROOT/scripts/verify-smoke-s3-stack.sh" down
}

# 在 admin-api 容器里跑一个 .mjs harness（脚本先 docker cp 进容器）
run_in_container() {
  # $1=脚本名  $2=env 文件  $3..=要透传的**变量名**（不含 =value）
  #
  # ⚠️ 调用方只传**变量名**（如 SMOKE_EXEC_SECRET），**不传 "NAME=$VALUE"**：
  #    若调用方自己写 "$SMOKE_EXEC_SECRET"，那是在**调用方上下文**里展开 ——
  #    而调用方此刻还没 source env 文件 ⇒ `set -u` 下「未绑定的变量」直接
  #    **中止整个 runner**（`set +e` 拦不住 `set -u`）⇒ 失败定位信息全丢。
  #    本轮实测踩过这个坑两次（先在调用方展开、后又改成先 source 再组装，
  #    但调用方那一层的展开依然发生在 source 之前）⇒ 最终形态：**名字进、
  #    值由本函数 source 后自己取**。
  local script="$1" envfile="$2"; shift 2
  # shellcheck disable=SC1090
  source "$envfile"
  local -a envs=()
  local name value
  while [[ $# -gt 0 ]]; do
    name="$1"; shift
    value="${!name:-}"
    [[ -n "$value" ]] || { printf 'run_in_container: 变量 %s 在 %s 里没有值\n' "$name" "$envfile" >&2; return 2; }
    envs+=(-e "${name}=${value}")
  done
  docker cp "$ROOT/scripts/$script" "$SMOKE_API_CONTAINER":/app/ >/dev/null
  docker exec "${envs[@]}" \
    -e DB_HOST="$SMOKE_PG_CONTAINER" -e DB_PORT=5432 \
    -e DB_USERNAME="$SMOKE_PG_USER" -e DB_PASSWORD="$SMOKE_PG_PASSWORD" \
    -e DB_DATABASE="$SMOKE_PG_DB" -e NODE_ENV=production \
    "$SMOKE_API_CONTAINER" node "$script"
}

# ── 各场景实现 ────────────────────────────────────────────────────────────
run_r5_migration() {
  ACF_SMOKE_ENV_FILE="$R5_ENV" "$ROOT/scripts/verify-smoke-migration.sh"
}
run_r5_firepoint() {
  ACF_SMOKE_ENV_FILE="$R5_ENV" "$ROOT/scripts/verify-smoke-firepoint.sh"
}
run_r5_misfire() {
  ACF_SMOKE_ENV_FILE="$R5_ENV" "$ROOT/scripts/verify-smoke-misfire.sh"
}
run_r5_retention() {
  run_in_container verify-smoke-retention.mjs "$R5_ENV"
}
run_r5_dispatch() {
  ACF_SMOKE_ENV_FILE="$R5_ENV" "$ROOT/scripts/verify-smoke-dispatch.sh"
}
run_r5_rollout_claim() {
  ACF_SMOKE_ENV_FILE="$R5_ENV" "$ROOT/scripts/verify-smoke-rollout-claim.sh"
}
run_r6_write_read() {
  # ⚠️ 只传**变量名**；「值」由 run_in_container source env 文件后自己取。
  run_in_container verify-smoke-s3.mjs "$R6_ENV" \
    SMOKE_API_URL SMOKE_EXEC_SECRET SMOKE_ADMIN_PW \
    SMOKE_RUSTFS_ENDPOINT SMOKE_RUSTFS_ACCESS_KEY \
    SMOKE_RUSTFS_SECRET_KEY SMOKE_LOG_BUCKET
}
run_r6_retention() {
  run_in_container verify-smoke-s3-retention.mjs "$R6_ENV" \
    SMOKE_RUSTFS_ENDPOINT SMOKE_RUSTFS_ACCESS_KEY \
    SMOKE_RUSTFS_SECRET_KEY SMOKE_LOG_BUCKET
}
run_r6_fallback() {
  ACF_SMOKE_ENV_FILE="$R6_ENV" "$ROOT/scripts/verify-smoke-s3-fallback.sh"
}

# ── 预检 ──────────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker not found"
docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon (is it running? are you in the docker group?)"
for c in curl jq node; do
  command -v "$c" >/dev/null 2>&1 || die "missing required host tool: $c"
done

# 预检残留：上一次运行被中断（Ctrl-C / 进程被杀）会留下栈 ⇒ 端口被占导致
# 后续步骤直接失败。⇒ 先查、明确报出、并**自动清理**（只删 acfsmoke-* ⇒ 不碰现网）。
residual_report
if [[ "$RESIDUAL_OK" != "1" ]]; then
  step "预检发现残留（上次运行被中断？）：$RESIDUAL"
  step "自动清理残留（只删 acfsmoke-* 前缀，不碰现网 acf-* 栈）"
  docker rm -f $(docker ps -a --filter name=acfsmoke --format '{{.Names}}') >/dev/null 2>&1 || true
  docker network rm $(docker network ls --filter name=acfsmoke --format '{{.Name}}') >/dev/null 2>&1 || true
  docker volume rm $(docker volume ls --filter name=acfsmoke --format '{{.Name}}') >/dev/null 2>&1 || true
  residual_report
  [[ "$RESIDUAL_OK" == "1" ]] \
    && step "残留已清理干净" \
    || die "残留清理不干净：${RESIDUAL}（手工检查后再跑）"
fi

# ── 选场景 ────────────────────────────────────────────────────────────────
SELECTED=()
for row in "${SCENARIOS[@]}"; do
  IFS='|' read -r n g d fn <<<"$row"
  if [[ -n "$ONLY" && "$n" != "$ONLY" ]]; then continue; fi
  if [[ -n "$SKIP" && "$n" == "$SKIP" ]]; then continue; fi
  SELECTED+=("$row")
done
[[ ${#SELECTED[@]} -gt 0 ]] || die "没有匹配的场景（--only=$ONLY --skip=${SKIP}）"

TOTAL=${#SELECTED[@]}
log "真机矩阵启动：$TOTAL 个场景"
step "场景："
for row in "${SELECTED[@]}"; do
  IFS='|' read -r n g d _ <<<"$row"
  printf '          - %s [%s] %s\n' "$n" "$g" "$d"
done

# ── 跑 ────────────────────────────────────────────────────────────────────
DONE=()
FAILED=""
START_ALL=$(date +%s)
STACK_RAISED=""

ensure_stack() {
  # $1 = R5|R6（场景表里是大写 ⇒ 统一小写化后比较）
  local grp="${1,,}"
  [[ "$STACK_RAISED" == "$grp" ]] && return 0
  if [[ -n "$STACK_RAISED" ]]; then
    step "切换栈组：先销毁 $STACK_RAISED 组"
    if [[ "$STACK_RAISED" == "r5" ]]; then stack_down_r5 || true; else stack_down_r6 || true; fi
    STACK_RAISED=""
  fi
  step "起 ${grp^^} 组隔离栈"
  if [[ "$grp" == "r5" ]]; then stack_up_r5; else stack_up_r6; fi
  STACK_RAISED="$grp"
}

cleanup_stacks() {
  if [[ -n "$STACK_RAISED" ]]; then
    step "销毁 $STACK_RAISED 组隔离栈"
    if [[ "$STACK_RAISED" == "r5" ]]; then stack_down_r5 || true; else stack_down_r6 || true; fi
    STACK_RAISED=""
  fi
  # 两个 env 文件都清（即使某个组没跑过）
  rm -f "$R5_ENV" "$R6_ENV"
}

on_failure() {
  # $1 = 场景名  $2 = 日志路径
  FAILED="$1"
  log "失败：场景 '$1'"
  printf '\n\033[31m[smoke-all] ═══ 失败定位 ═══\033[0m\n'
  printf '[smoke-all] 已跑完的场景（%d）：\n' "${#DONE[@]}"
  for n in "${DONE[@]}"; do printf '[smoke-all]   ✓ %s\n' "$n"; done
  printf '[smoke-all] 卡住的场景：\n[smoke-all]   ✗ %s\n' "$FAILED"
  printf '[smoke-all] 该步完整日志：%s\n' "$2"
  printf '[smoke-all] 该步日志尾部（最后 25 行）：\n'
  tail -25 "$2" 2>/dev/null | sed 's/^/[smoke-all]   | /'
  printf '[smoke-all] 该步日志里的 ✗ 行（若有）：\n'
  grep -n '✗' "$2" 2>/dev/null | tail -15 | sed 's/^/[smoke-all]   | /' || true
  if [[ "$KEEP_STACK" == "1" ]]; then
    printf '[smoke-all] （--keep-stack：栈**保留**在现场，栈组 %s）\n' "${STACK_RAISED:-无}"
  else
    cleanup_stacks
  fi
  residual_report
  printf '[smoke-all] 残留：%s\n' "$RESIDUAL"
  exit 1
}

i=0
for row in "${SELECTED[@]}"; do
  IFS='|' read -r name group desc fn <<<"$row"
  i=$((i+1))
  log "[$i/$TOTAL] 场景：$name —— $desc"
  ensure_stack "$group"

  # 每步**前**查残留：确认上一步没留下东西（端口/容器冲突会在这里暴露）
  residual_report
  if [[ "$RESIDUAL_OK" != "1" ]]; then
    step "步骤前残留检查：${RESIDUAL}（继续——可能是本组栈，属正常）"
  fi

  LOGFILE="${LOG_DIR}/acf-smoke-${name}.log"
  STEP_START=$(date +%s)
  # ⚠️ 场景体放**子 shell** 里跑（`( "$fn" ) >log 2>&1`）：
  #    `set -u` 的「未绑定的变量」中止会**杀掉整个 runner**（`set +e` 拦不住
  #    `set -u`）⇒ 那样就拿不到「已跑完哪些 / 卡在哪个 / 日志路径」了。
  #    子 shell 里中止 ⇒ 退出码非 0 ⇒ 父 runner 正常走失败定位路径。
  set +e
  ( "$fn" ) >"$LOGFILE" 2>&1
  RC=$?
  set -e
  STEP_ELAPSED=$(( $(date +%s) - STEP_START ))

  if [[ "$RC" != "0" ]]; then
    printf '[smoke-all] ✗ %s 失败（退出码 %s，耗时 %ss，日志 %s）\n' \
      "$name" "$RC" "$STEP_ELAPSED" "$LOGFILE"
    on_failure "$name" "$LOGFILE"
  fi
  # 成功行也留在日志里（便于回看断言明细）
  grep -E '✓|小结' "$LOGFILE" | tail -4 | sed 's/^/[smoke-all]   | /' || true
  printf '[smoke-all] ✓ %s 通过（耗时 %ss，日志 %s）\n' "$name" "$STEP_ELAPSED" "$LOGFILE"
  DONE+=("$name")

  # 每步**后**查残留：场景脚本自己的清理是否干净（DB/S3 的残留由场景脚本负责，
  # 这里只管**容器/网络/卷**）
  residual_report
  printf '[smoke-all]   步骤后残留：%s\n' "$RESIDUAL"
done

# ── 收尾 ──────────────────────────────────────────────────────────────────
if [[ "$KEEP_STACK" == "1" ]]; then
  step "--keep-stack：栈保留在现场"
else
  cleanup_stacks
fi
TOTAL_ELAPSED=$(( $(date +%s) - START_ALL ))

residual_report
printf '\033[1m[smoke-all] 全部完成：%d/%d PASS（总耗时 %ds ≈ %dmin%02ds）\033[0m\n' \
  "$TOTAL" "$TOTAL" "$TOTAL_ELAPSED" "$((TOTAL_ELAPSED/60))" "$((TOTAL_ELAPSED%60))"
printf '[smoke-all] 已跑完：%s\n' "${DONE[*]}"
printf '[smoke-all] 残留检查：%s\n' "$RESIDUAL"
if [[ "$RESIDUAL_OK" == "1" ]]; then
  printf '\033[32m[smoke-all] ✓ 残留为空（容器 / 网络 / 卷 三查均无输出）\033[0m\n'
else
  printf '\033[33m[smoke-all] ⚠ 残留非空：%s\033[0m\n' "$RESIDUAL"
  exit 1
fi
printf '[smoke-all] 各步日志：%s/acf-smoke-<场景名>.log\n' "$LOG_DIR"
exit 0
