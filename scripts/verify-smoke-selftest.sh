#!/usr/bin/env bash
#
# verify-smoke-selftest.sh —— **「可重入」的有牙证明**：连跑两次同一个脚本，
# 断言**两次都 PASS**。
#
# ## 为什么这是唯一的证明
#
# 「脚本加了跑前清理」是**声明**；「连跑两次都过」是**实测**。
# 只看代码无法排除这些假绿/假红：
#
#   · 跑前清理的 WHERE 写错 ⇒ 第二次跑建任务仍失败（**假红**，脚本本身坏了）；
#   · 跑前清理**范围过大** ⇒ 第二次跑把第一次的证据也删了 ⇒ 断言"靠新建的
#     数据通过"（这是**正确**行为，但若清理越界删了别的脚本的数据就是**危险**）；
#   · 某些断言在脏 DB 上**靠上一次的残留就能通过** ⇒ 单跑一次看不出，
#     只有"跑两次"才暴露（第一次留下残留 → 第二次本该被清理 → 若没被清理，
#     第二次仍过 ⇒ 说明断言不依赖本次产生的数据 ⇒ **假绿**）。
#
# ⇒ 本脚本是**双跑**：run1 → 跑前清理 → run2 → 断言两次都 exit 0。
#
# ## 覆盖策略（时间盒约束）
#
# 真机矩阵的场景 2/3 **必须真等 cron 落点与自然 tick** ⇒ 分钟级。
# 本脚本对**秒级**的场景做**真双跑**（`--double=`，默认
# `r5-dispatch,r5-migration,r5-rollout-claim` —— 三者实测都在 10s 量级），
# 其余脚本做**静态检查**（有没有跑前清理 + 清理是否**验证**（查计数=0））。
# ⚠️ `r5-dispatch` / `r5-rollout-claim` 自分別在第八/第九轮新增，**曾经**
#    因为本脚本的静态检查面是**写死列表**而扫不到 ⇒ 它们即使写了无 WHERE
#    的 `DELETE FROM tasks`，静态关也不会红。见下一条。
#
# ## 静态检查面：**自动发现**（不写死列表）
#
# 静态检查面 = `scripts/verify-smoke-*.sh` ∪ `scripts/verify-smoke-*.mjs`
# **减去**非场景文件（自检器自身 / 被 source 的库 / 统一入口 / 起栈工具）。
# 理由：写死列表时**新增场景会自动漏检且无人报警** —— 而"漏检却报绿"
# 比"误报红"危险得多（方法学 53）。`SH_EXCLUDE` 是唯一的排除名单。
#
# ⚠️ 自动发现必须配一条**下界断言**（`SH_MIN` / `MJS_MIN`）：否则目录改名 /
#    glob 失配会变成**零命中全绿**（本仓反复抓到的形态：什么都没扫到，却报
#    "全部通过"）。下界是"这个仓库此刻至少有几个场景脚本"的**事实登记**，
#    新增场景时应把它一起加一（否则它只是从"漏检"变成"早报红"，比漏检好）。
#
# 静态检查项（对每个 verify-smoke-* 脚本）：
#   ① **有跑前清理**：源码里出现 `smoke_preclean_tasks`（.sh）或
#      `跑前清理` + `DELETE FROM` 前缀删（.mjs）；
#   ② **清理有验证**：源码里出现"残留 = 0"或 count 校验的断言；
#   ③ **清理范围有界**：源码里**不得**出现无 WHERE 的 `DELETE FROM tasks`。
#      （`DELETE FROM tasks` 不带 WHERE ⇒ 会删全表 ⇒ **禁止**。）
#
# 用法：
#   ./scripts/verify-smoke-selftest.sh                  # 静态检查 + 默认三个场景双跑
#   ./scripts/verify-smoke-selftest.sh --static-only    # 只做静态检查（不碰 docker）
#   ./scripts/verify-smoke-selftest.sh --double=r5-migration,r5-retention
#   ./scripts/verify-smoke-selftest.sh --double=r5-dispatch,r5-rollout-claim
#
# 退出码：0 = 全部通过；非 0 = 有失败项。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG_DIR="${ACF_SMOKE_LOG_DIR:-/tmp}"
STATIC_ONLY=0
# 默认双跑集合：三个**秒级**场景（migration ~4s / dispatch ~6-40s / rollout-claim ~12s）。
# ⚠️ 新增/删除双跑场景时同步改这两处：本变量 + `run_twice` 的 case（场景名必须
#    与 `verify-smoke-all.sh` 的场景表逐字一致，否则 case 落到「未知场景」）。
DOUBLE_SCENARIOS="r5-dispatch,r5-migration,r5-rollout-claim"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --static-only) STATIC_ONLY=1 ;;
    --double=*)    DOUBLE_SCENARIOS="${1#*=}" ;;
    -h|--help)
      # 打印文件头的**连续注释块**（到第一行非注释为止）⇒ 头注变长也不会被截断
      awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

PASS=0; FAIL=0
ok()  { printf '  ✓ %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  ✗ %s\n' "$*"; FAIL=$((FAIL+1)); }
step(){ printf '\n=== %s ===\n' "$*"; }

# ── 静态检查 ────────────────────────────────────────────────────────────
step "1. 静态检查：每个 verify-smoke-* 脚本都有跑前清理 + 清理有验证 + 范围有界"

# ⚠️ 检查「DELETE FROM tasks 是否带 WHERE」必须**先剥注释** ——
#   否则注释里那句「绝不 `DELETE FROM tasks`」会被当成真的无 WHERE 全表删
#   ⇒ **假红**（本轮实测踩到：4 个脚本全是这个假红）。
#   ⇒ 用一个小状态机剥掉 // 与 /* */ 注释（且不误伤字符串里的 // 与 URL）。
check_unbounded_delete() {
  # $1 = 文件路径；输出：无 WHERE 的 DELETE FROM tasks 的行号（每行一个）；无则无输出
  python3 - "$1" <<'PY' 2>/dev/null
import re, sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()
# .sh 用 `#` 起行注释；.mjs 的 `#` 不是注释（可能是私有字段 #foo）⇒ 按后缀区分
shell_mode = path.endswith(".sh")

# ── 剥注释（状态机：区分字符串 / 行注释 / 块注释）────────────────────────
out = []
i, n = 0, len(src)
while i < n:
    c = src[i]
    # shell 行注释：`#` 必须在行首或前面是空白（避免吃掉 `a#b`）
    if shell_mode and c == "#":
        prev = src[i - 1] if i > 0 else "\n"
        nxt = src[i + 1] if i + 1 < n else "\n"
        if prev in " \t\n" and not nxt.isalnum() and nxt != "_":
            while i < n and src[i] != "\n":
                i += 1
            continue
    if c in ('"', "'", "`"):
        q = c
        out.append(c); i += 1
        while i < n:
            out.append(src[i])
            if src[i] == "\\":
                if i + 1 < n:
                    out.append(src[i + 1]); i += 2; continue
            elif src[i] == q:
                i += 1; break
            i += 1
        continue
    if c == "/" and i + 1 < n and src[i + 1] == "/":
        while i < n and src[i] != "\n":
            i += 1
        continue
    if c == "/" and i + 1 < n and src[i + 1] == "*":
        i += 2
        while i + 1 < n and not (src[i] == "*" and src[i + 1] == "/"):
            i += 1
        i += 2
        continue
    out.append(c); i += 1
code = "".join(out)

# ── 找 DELETE FROM tasks（大小写不敏感、允许多空格）─────────────────────
for m in re.finditer(r"(?i)delete\s+from\s+tasks\b", code):
    tail = code[m.end():]
    stops = [x for x in (tail.find(";"), tail.find("`"), len(tail)) if x >= 0]
    stmt = tail[:min(stops)]
    if not re.search(r"(?i)\bwhere\b", stmt):
        print(code.count("\n", 0, m.start()) + 1)
PY
}

# ── 静态检查面：**自动发现**（不写死列表）───────────────────────────────
#
# 判据 = `scripts/verify-smoke-*.<ext>` **减去** `SH_EXCLUDE` 里的非场景文件。
# 写死列表的失败形态：新增场景**自动落空**且**无人报警**（第八/九轮的
# `r5-dispatch`/`r5-rollout-claim` 就是这么漏的）。
SH_EXCLUDE=(
  verify-smoke-selftest.sh   # 自检器自身（不是场景）
  verify-smoke-common.sh     # 被 source 的库（不是场景）
  verify-smoke-all.sh        # 统一入口（不是场景）
  verify-smoke-stack.sh      # 起栈工具 R5（不是场景）
  verify-smoke-s3-stack.sh   # 起栈工具 R6（不是场景）
)
# 下界：**事实登记**（当前仓库有几个场景脚本），防「glob 失配 ⇒ 零命中全绿」。
SH_MIN=6
MJS_MIN=3

discover_scripts() {
  # $1 = 扩展名（sh / mjs）；输出：非排除项的路径（每行一个）
  local ext="${1:?need ext}" p base x skip
  local -a all=()
  shopt -s nullglob
  all=(scripts/verify-smoke-*."${ext}")
  shopt -u nullglob
  if [[ ${#all[@]} -eq 0 ]]; then
    return 0
  fi
  for p in "${all[@]}"; do
    base="$(basename "$p")"
    skip=0
    for x in "${SH_EXCLUDE[@]}"; do
      [[ "$base" == "$x" ]] && { skip=1; break; }
    done
    [[ "$skip" == "1" ]] || printf '%s\n' "$p"
  done
}

mapfile -t SH_SCRIPTS < <(discover_scripts sh)
mapfile -t MJS_SCRIPTS < <(discover_scripts mjs)

# ⚠️ 下界必须**先**判：它为 0 时下面两个循环什么也不做 ⇒ 若不单独断言，
#    整关会以「PASS=0 FAIL=0」的形态"通过"（零命中全绿）。
if [[ ${#SH_SCRIPTS[@]} -ge "$SH_MIN" ]]; then
  ok "静态检查面下界：自动发现 ${#SH_SCRIPTS[@]} 个 .sh 场景脚本（要求 ≥ ${SH_MIN}）"
else
  bad "静态检查面下界**失守**：只发现 ${#SH_SCRIPTS[@]} 个 .sh 场景脚本（要求 ≥ ${SH_MIN}）⇒ glob/目录可能改名 ⇒ 零命中会变成假绿"
fi
if [[ ${#MJS_SCRIPTS[@]} -ge "$MJS_MIN" ]]; then
  ok "静态检查面下界：自动发现 ${#MJS_SCRIPTS[@]} 个 .mjs 场景脚本（要求 ≥ ${MJS_MIN}）"
else
  bad "静态检查面下界**失守**：只发现 ${#MJS_SCRIPTS[@]} 个 .mjs 场景脚本（要求 ≥ ${MJS_MIN}）⇒ 零命中会变成假绿"
fi
printf '    | .sh 面：%s\n' "${SH_SCRIPTS[*]:-（空）}"
printf '    | .mjs 面：%s\n' "${MJS_SCRIPTS[*]:-（空）}"

for f in "${SH_SCRIPTS[@]}"; do
  [[ -f "$f" ]] || { bad "$f 不存在"; continue; }
  if grep -q 'smoke_preclean_tasks' "$f"; then
    ok "${f}：有跑前清理（smoke_preclean_tasks）"
  else
    bad "${f}：**没有**跑前清理 ⇒ 不可重入"
  fi
  if grep -qE '残留 = 0|残留.*=.*0|清理生效' "$f" || grep -q 'smoke_clean_tasks' "$f"; then
    ok "${f}：清理**有验证**（查计数 = 0）"
  else
    bad "${f}：清理**没有验证**（只删不查 ⇒ 删失败也会当成功）"
  fi
  # ⚠️ 范围有界：不得出现**不带 WHERE** 的 DELETE FROM tasks
  #    （检查器先**剥注释** ⇒ 注释里那句「绝不 DELETE FROM tasks」不会被误判）
  bad_lines="$(check_unbounded_delete "$f")"
  if [[ -n "$bad_lines" ]]; then
    bad "${f}：出现**无 WHERE** 的 DELETE FROM tasks ⇒ 会删全表（禁止）"
    printf '%s\n' "$bad_lines" | sed 's/^/      | 行 /'
  else
    ok "${f}：清理范围有界（DELETE FROM tasks 都带 WHERE 前缀）"
  fi
done

for f in "${MJS_SCRIPTS[@]}"; do
  [[ -f "$f" ]] || { bad "$f 不存在"; continue; }
  if grep -q '跑前清理' "$f"; then
    ok "${f}：有跑前清理"
  else
    bad "${f}：**没有**跑前清理 ⇒ 不可重入"
  fi
  if grep -qE '残留.*=.*0|清理生效|every\(\(n\) => n === 0\)' "$f"; then
    ok "${f}：清理**有验证**（查计数 = 0）"
  else
    bad "${f}：清理**没有验证**"
  fi
  bad_lines="$(check_unbounded_delete "$f")"
  if [[ -n "$bad_lines" ]]; then
    bad "${f}：出现**无 WHERE** 的 DELETE FROM tasks ⇒ 会删全表（禁止）"
    printf '%s\n' "$bad_lines" | sed 's/^/      | 行 /'
  else
    ok "${f}：清理范围有界（DELETE FROM tasks 都带 WHERE 前缀）"
  fi
done

# ── 双跑（真起容器）────────────────────────────────────────────────────
if [[ "$STATIC_ONLY" == "1" ]]; then
  step "2. 双跑自检（--static-only ⇒ 跳过）"
  printf '\n=== 汇总：PASS=%d FAIL=%d ===\n' "$PASS" "$FAIL"
  [[ "$FAIL" == "0" ]] || exit 1
  exit 0
fi

step "2. 双跑自检：连跑两次同一脚本，断言两次都 PASS"

command -v docker >/dev/null 2>&1 || { bad "docker not found"; exit 1; }
docker info >/dev/null 2>&1 || { bad "cannot talk to the Docker daemon"; exit 1; }

# 双跑需要一套已起的栈（脚本自己管栈太重 ⇒ 这里起 R5 栈，跑完销毁）
ENV_FILE="${LOG_DIR}/acf-smoke-env-selftest.sh"
cleanup_stack() {
  ACF_SMOKE_ENV_FILE="$ENV_FILE" "$ROOT/scripts/verify-smoke-stack.sh" down >/dev/null 2>&1 || true
}
trap cleanup_stack EXIT

# 残留预检 + 清理（只删 acfsmoke-* ⇒ 不碰现网 acf-* 栈）
resid="$(docker ps -a --filter name=acfsmoke --format '{{.Names}}' 2>/dev/null | tr '\n' ' ')"
if [[ -n "${resid// /}" ]]; then
  printf '  · 预检发现 acfsmoke-* 残留 ⇒ 自动清理：%s\n' "$resid"
  docker rm -f $(docker ps -a --filter name=acfsmoke --format '{{.Names}}') >/dev/null 2>&1 || true
  docker network rm $(docker network ls --filter name=acfsmoke --format '{{.Name}}') >/dev/null 2>&1 || true
  docker volume rm $(docker volume ls --filter name=acfsmoke --format '{{.Name}}') >/dev/null 2>&1 || true
fi

printf '  · 起 R5 隔离栈（起停也要验：跑前清理之后栈本身也要能重建）\n'
ACF_SMOKE_ENV_FILE="$ENV_FILE" "$ROOT/scripts/verify-smoke-stack.sh" up >/dev/null 2>&1 \
  || { bad "R5 栈起不来 ⇒ 双跑自检无法进行"; exit 1; }
# ⚠️ 必须**自己 source 一遍** env 文件：`verify-smoke-stack.sh up` 是子进程，
#    它写的变量不会流回本脚本的 shell ⇒ 容器内跑 .mjs 时拿不到
#    SMOKE_API_CONTAINER / SMOKE_PG_* （本轮实测：未绑定变量直接中止）。
# shellcheck disable=SC1090
source "$ENV_FILE"
ok "R5 隔离栈已起（${ENV_FILE}）"

run_twice() {
  # $1 = 场景名（必须与 verify-smoke-all.sh 的场景表**逐字**一致）
  local scen="$1"
  local host_script="" mjs=""
  case "$scen" in
    r5-migration)     host_script="scripts/verify-smoke-migration.sh" ;;
    r5-dispatch)      host_script="scripts/verify-smoke-dispatch.sh" ;;
    r5-rollout-claim) host_script="scripts/verify-smoke-rollout-claim.sh" ;;
    r5-retention)     mjs="verify-smoke-retention.mjs" ;;
    *) bad "未知场景 ${scen}（见 verify-smoke-all.sh 的场景表）"; return 1 ;;
  esac
  local log1="${LOG_DIR}/acf-smoke-selftest-${scen}-run1.log"
  local log2="${LOG_DIR}/acf-smoke-selftest-${scen}-run2.log"
  local rc1 rc2 t1 t2

  # 单跑一遍（$1 = 日志路径）；返回该场景的退出码。
  # ⚠️ 调用方必须写成 `if run_once ...; then rc=0; else rc=$?; fi`
  #    —— 直接 `run_once` 在 `set -e` 下失败会**中止整个自检**（拿不到定位信息）。
  run_once() {
    local log="${1:?need log}"
    if [[ -n "$host_script" ]]; then
      # 宿主 bash 场景：靠 env 文件拿栈变量（场景脚本自己 source）
      ACF_SMOKE_ENV_FILE="$ENV_FILE" bash "$ROOT/$host_script" >"$log" 2>&1
    else
      # 容器内 .mjs 场景：**先 copy 进容器**（否则跑的是镜像里的旧副本）
      docker cp "$ROOT/scripts/$mjs" "$SMOKE_API_CONTAINER":/app/ >/dev/null || return 1
      docker exec -e DB_HOST="$SMOKE_PG_CONTAINER" -e DB_PORT=5432 \
        -e DB_USERNAME="$SMOKE_PG_USER" -e DB_PASSWORD="$SMOKE_PG_PASSWORD" \
        -e DB_DATABASE="$SMOKE_PG_DB" -e NODE_ENV=production \
        "$SMOKE_API_CONTAINER" node "$mjs" >"$log" 2>&1
    fi
  }

  printf '  · 场景 %s：第 1 次跑…\n' "$scen"
  t1=$(date +%s)
  if run_once "$log1"; then rc1=0; else rc1=$?; fi
  t1=$(( $(date +%s) - t1 ))

  printf '  · 场景 %s：第 2 次跑（**不清理任何东西** ⇒ 靠脚本自己的跑前清理）…\n' "$scen"
  t2=$(date +%s)
  if run_once "$log2"; then rc2=0; else rc2=$?; fi
  t2=$(( $(date +%s) - t2 ))

  printf '    第 1 次：exit=%s 耗时=%ss 日志=%s\n' "$rc1" "$t1" "$log1"
  printf '    第 2 次：exit=%s 耗时=%ss 日志=%s\n' "$rc2" "$t2" "$log2"

  if [[ "$rc1" == "0" && "$rc2" == "0" ]]; then
    ok "**双跑通过**：$scen 两次都 exit 0（第 1 次 ${t1}s / 第 2 次 ${t2}s）⇒ 可重入"
    return 0
  fi
  bad "**双跑失败**：$scen 第 1 次 exit=$rc1 / 第 2 次 exit=$rc2"
  printf '    第 1 次的 ✗ 行：\n'; grep -n '✗' "$log1" 2>/dev/null | tail -5 | sed 's/^/      | /' || true
  printf '    第 2 次的 ✗ 行：\n'; grep -n '✗' "$log2" 2>/dev/null | tail -5 | sed 's/^/      | /' || true
  return 1
}

IFS=',' read -r -a SCEN_LIST <<<"$DOUBLE_SCENARIOS"
for scen in "${SCEN_LIST[@]}"; do
  [[ -n "$scen" ]] || continue
  run_twice "$scen" || true
done

# ── 残留四查（容器/网络/卷/端口）────────────────────────────────────────
step "3. 残留四查（容器 / 网络 / 卷 / 端口）"
cleanup_stack
trap - EXIT
# ⚠️ 每条都要 `|| true`：grep 无匹配时退出码 = 1，在 `set -e` + `pipefail` 下
#    会**直接中止整个脚本**（本轮实测：残留为空 ⇒ grep 返 1 ⇒ 脚本在打印
#    证据之前就死了 ⇒ 报不出"残留为空"这个结论）。
c="$(docker ps -a --filter name=acfsmoke --format '{{.Names}}' 2>/dev/null | tr '\n' ' ' || true)"
n="$(docker network ls --filter name=acfsmoke --format '{{.Name}}' 2>/dev/null | tr '\n' ' ' || true)"
v="$(docker volume ls --filter name=acfsmoke --format '{{.Name}}' 2>/dev/null | tr '\n' ' ' || true)"
p="$(ss -ltn 2>/dev/null | grep -E ':(55432|56379|43105|59000|59001)\b' | tr '\n' ' ' || true)"
printf '  containers=[%s] networks=[%s] volumes=[%s] ports=[%s]\n' "${c:- }" "${n:- }" "${v:- }" "${p:- }"
if [[ -z "${c// /}" && -z "${n// /}" && -z "${v// /}" && -z "${p// /}" ]]; then
  ok "残留四查全空（容器 / 网络 / 卷 / 端口）"
else
  bad "残留非空：containers=[${c:- }] networks=[${n:- }] volumes=[${v:- }] ports=[${p:- }]"
fi

printf '\n=== 汇总：PASS=%d FAIL=%d ===\n' "$PASS" "$FAIL"
[[ "$FAIL" == "0" ]] || exit 1
exit 0
