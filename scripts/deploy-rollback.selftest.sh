#!/usr/bin/env bash
#
# deploy.sh「验证失败自动回滚」自检（S6-§6-2，2026-11-01）
#
# ── 为什么需要它 ────────────────────────────────────────────────────
# 自动回滚是本仓 deploy.sh 里唯二的**破坏性动作**（另一个是手动 rollback），
# 而它的失败形态恰好是历史事故的复刻：回滚走错 mode → 报「已回滚」的假成功
# （deploy.sh:1609-1615 有记录）。它只在真部署失败时才被触发，靠人眼抽查等于
# 没有覆盖。这里用「假 curl + 白盒驱动」把整条链路离线跑起来。
#
# ── 覆盖的不变量（任一条被破坏，本自检即转红）──────────────────────
#   ① 只在**验证失败**时回滚；回滚目标是「上一份已知可用 manifest」，不许多退一版；
#   ② 回滚后**必须再验一次** health；二次失败必须如实报「回滚后仍失败」，
#      不许静默、不许渲染成「已回滚，成功」；
#   ③ 开关默认 on，可一键关（--no-auto-rollback / DEPLOY_AUTO_ROLLBACK=off）；
#     关掉后只如实失败，不动任何东西；
#   ④ 全程留证物 .deploy-manifest.failed.json。
#
# ── 手法 ───────────────────────────────────────────────────────────
# 把 deploy.sh 复制进隔离的临时 git 仓库（三个空 commit：c1/c2/c3，HEAD=c3 模拟
# 「已切到新代码」，清单指向 c2=上一次成功、c1=更早），摘掉末尾 `main "$@"` 后
# 白盒调用 verify_phase：重阶段（build/start）与 wait_http 用桩替掉，健康探测
# 走 PATH 前置的假 curl/systemctl/docker —— **绝不碰真网络、真 systemd、真容器**。
# 真跑部署不在本自检范围内。
#
# 用法: bash scripts/deploy-rollback.selftest.sh
#   反证: ST_DEPLOY_SH=/tmp/deploy-no-rollback.sh bash scripts/deploy-rollback.selftest.sh
#         （把 deploy 里自动回滚那一行注释掉，本自检必须转红）
# 退出码: 0=全通过, 1=有失败

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly SCRIPT_DIR ROOT_DIR
# 默认测本仓 deploy.sh；反证（注释掉回滚行）用 ST_DEPLOY_SH 指一份改过的副本。
readonly DEPLOY="${ST_DEPLOY_SH:-${ROOT_DIR}/deploy.sh}"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES + 1)); printf '  ✔ %s\n' "${1}"; }
fail() { FAILURES=$((FAILURES + 1)); printf '  ✘ %s\n' "${1}" >&2; }

assert_contains() { # <测试名> <期望子串> <实际输出>
    local name="${1}" needle="${2}" haystack="${3}"
    if printf '%s' "${haystack}" | grep -qF -- "${needle}"; then
        pass "${name}"
    else
        fail "${name}（期望含: ${needle}；实际: $(printf '%s' "${haystack}" | head -c 300)）"
    fi
}

assert_not_contains() { # <测试名> <禁止子串> <实际输出>
    local name="${1}" needle="${2}" haystack="${3}"
    if printf '%s' "${haystack}" | grep -qF -- "${needle}"; then
        fail "${name}（不该出现: ${needle}）"
    else
        pass "${name}"
    fi
}

assert_eq() { # <测试名> <期望> <实际>
    if [ "${2}" = "${3}" ]; then
        pass "${1}"
    else
        fail "${1}（期望 ${2}，实际 ${3}）"
    fi
}

[ -f "${DEPLOY}" ] || { echo "找不到 deploy.sh: ${DEPLOY}" >&2; exit 1; }

CLEANUP_DIRS=()
cleanup() {
    local d
    for d in ${CLEANUP_DIRS[@]+"${CLEANUP_DIRS[@]}"}; do
        rm -rf "${d}"
    done
}
trap cleanup EXIT

# ── 驱动模板 ───────────────────────────────────────────────────────
# 白盒驱动：只跑 verify_phase。重阶段与 dump_recent_logs 用桩；wait_http 保留
# 真实语义（live/ready 两个 URL、按 2xx 判定）但不睡 60s —— 单次探测，由假
# curl 决定 503/200。
COMMON_PRELUDE='
MODE="${ST_MODE:-docker}"
DRY_RUN=false
ENV_NAME="development"
READINESS=""
COMPONENTS="admin-web"
ALLOW_DEGRADED=false
build_phase() { printf "[stub] build_phase mode=%s\n" "${MODE}" >&2; }
start_phase() { printf "[stub] start_phase mode=%s\n" "${MODE}" >&2; }
dump_recent_logs() { :; }
wait_http() {
    local url="${1}" label="${2:-URL}" code
    code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "${url}" 2>/dev/null)" || code="000"
    case "${code}" in
        2*|3*) printf "  [stub] %s 就绪（HTTP %s）\n" "${label}" "${code}" >&2; return 0 ;;
    esac
    printf "  [stub] %s 未就绪（HTTP %s）\n" "${label}" "${code}" >&2
    return 1
}
'

# wb_script <repo> <输出脚本名> <追加代码>
wb_script() {
    local repo="${1}" name="${2}" tail_code="${3}"
    grep -v '^main "\$@"$' "${repo}/deploy.sh" > "${repo}/${name}"
    if grep -q '^main "\$@"' "${repo}/${name}"; then
        fail "白盒驱动未挂载（deploy.sh 末尾 main 格式漂移，需修本自检）"
        return 1
    fi
    printf '%s\n' "${tail_code}" >> "${repo}/${name}"
    bash -n "${repo}/${name}" || fail "${name} 白盒副本语法损坏"
}

# ── 场景搭建 ───────────────────────────────────────────────────────
new_case() { # <场景名> [prev-mode] [prev-commit-slot]
    local name="${1}" mode="${2:-docker}" slot="${3:-c2}"
    CASE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/acf-rollback-${name}.XXXXXX")"
    CLEANUP_DIRS+=("${CASE_DIR}")
    REPO="${CASE_DIR}/repo"
    mkdir -p "${REPO}" "${CASE_DIR}/bin"
    cp "${DEPLOY}" "${REPO}/deploy.sh"
    cp "${ROOT_DIR}/.env.example" "${REPO}/.env.example" 2>/dev/null || true

    ( cd "${REPO}" \
        && git init -q \
        && git -c user.email=st@acf -c user.name=st commit -q --allow-empty -m c1 \
        && git -c user.email=st@acf -c user.name=st commit -q --allow-empty -m c2 \
        && git -c user.email=st@acf -c user.name=st commit -q --allow-empty -m c3 ) \
        >/dev/null 2>&1

    C1="$(git -C "${REPO}" rev-parse --short HEAD~2 2>/dev/null || echo '')"
    C2="$(git -C "${REPO}" rev-parse --short HEAD~1 2>/dev/null || echo '')"
    C3="$(git -C "${REPO}" rev-parse --short HEAD 2>/dev/null || echo '')"
    if [ -z "${C1}" ] || [ -z "${C2}" ] || [ -z "${C3}" ] || [ "${C1}" = "${C2}" ]; then
        fail "临时 git 仓库构造失败（c1=${C1} c2=${C2} c3=${C3}）"
        return 1
    fi

    # .deploy-manifest.json      = 上一次**成功**部署（回滚目标）
    # .deploy-manifest.prev.json = 更早一次（原样交给 rollback 会多退一版）
    manifest_commit="${C2}"
    [ "${slot}" = "c3" ] && manifest_commit="${C3}"
    printf '{\n  "mode": "%s",\n  "gitCommit": "%s",\n  "components": "admin-web"\n}\n' \
        "${mode}" "${manifest_commit}" > "${REPO}/.deploy-manifest.json"
    printf '{\n  "mode": "%s",\n  "gitCommit": "%s",\n  "components": "admin-web"\n}\n' \
        "${mode}" "${C1}" > "${REPO}/.deploy-manifest.prev.json"

    write_stubs
    CURL_LOG="${CASE_DIR}/curl.log"
    SYSTEMCTL_LOG="${CASE_DIR}/systemctl.log"
    DOCKER_LOG="${CASE_DIR}/docker.log"
    PROBE="${CASE_DIR}/probe"
    : > "${CURL_LOG}"
    : > "${SYSTEMCTL_LOG}"
    : > "${DOCKER_LOG}"
    printf '0' > "${PROBE}"
}

write_stubs() {
    cat > "${CASE_DIR}/bin/curl" <<'STUB'
#!/usr/bin/env bash
# 假 curl：只把 HTTP 状态码写到 stdout（调用方按 -w '%{http_code}' 消费）。
# ready 端点第 ST_READY_FAIL_TIMES 次之前恒 503（注入「部署后未就绪」）。
url="${!#}"
printf '%s\n' "${url}" >> "${ST_CURL_LOG:-/dev/null}"
case "${url}" in
    */api/health/ready)
        n=0
        if [ -f "${ST_PROBE_FILE:-/dev/null}" ]; then
            n="$(cat "${ST_PROBE_FILE}" 2>/dev/null || echo 0)"
        fi
        case "${n}" in ''|*[!0-9]*) n=0 ;; esac
        n=$((n + 1))
        printf '%s' "${n}" > "${ST_PROBE_FILE:-/dev/null}" 2>/dev/null || true
        if [ "${n}" -le "${ST_READY_FAIL_TIMES:-1}" ]; then
            printf '503'
        else
            printf '200'
        fi
        ;;
    *) printf '200' ;;
esac
STUB
    cat > "${CASE_DIR}/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${ST_SYSTEMCTL_LOG:-/dev/null}"
exit 0
STUB
    cat > "${CASE_DIR}/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${ST_DOCKER_LOG:-/dev/null}"
exit 0
STUB
    chmod +x "${CASE_DIR}/bin/curl" "${CASE_DIR}/bin/systemctl" "${CASE_DIR}/bin/docker"
}

# run_driver <驱动脚本名> <ready 失败次数> [extra env]
run_driver() {
    local script="${1}" ready_fails="${2}"
    RC=0
    OUT="$(cd "${REPO}" && PATH="${CASE_DIR}/bin:${PATH}" \
        ST_MODE="${ST_MODE:-docker}" \
        ST_PROBE_FILE="${PROBE}" \
        ST_READY_FAIL_TIMES="${ready_fails}" \
        ST_CURL_LOG="${CURL_LOG}" \
        ST_SYSTEMCTL_LOG="${SYSTEMCTL_LOG}" \
        ST_DOCKER_LOG="${DOCKER_LOG}" \
        bash "${REPO}/${script}" 2>&1)" || RC=$?
}

git_head() { git -C "${REPO}" rev-parse --short HEAD 2>/dev/null || echo '?'; }
manifest_commit() { # <文件>
    grep -o '"gitCommit": *"[^"]*"' "${1}" 2>/dev/null | cut -d'"' -f4 || true
}

printf '\n=== deploy.sh 验证失败自动回滚 自检 ===\n\n'
printf '被测脚本: %s\n' "${DEPLOY}"

# ── 1. 语法 ────────────────────────────────────────────────────────
printf '\n── 1. 语法 ──\n'
bash -n "${DEPLOY}" && pass "deploy.sh bash -n 通过" || fail "deploy.sh 语法错误"

# ── 2. 核心链路：ready 失败 ⇒ 自动回滚到上一份可用版本 + 回滚后复验 ok ──
printf '\n── 2. 验证失败 ⇒ 自动回滚并复验（真跑 verify_phase）──\n'
new_case happy
wb_script "${REPO}" "wb_verify.sh" "${COMMON_PRELUDE}
verify_phase"
run_driver wb_verify.sh 1

if [ "${RC}" -ne 0 ]; then pass "验证失败 + 回滚成功 ⇒ 退出码非 0（exit=${RC}）"
else fail "验证失败却 exit 0（假成功）"; fi

if [ -f "${REPO}/.deploy-manifest.failed.json" ]; then
    pass "留证物 .deploy-manifest.failed.json"
else
    fail "缺 .deploy-manifest.failed.json（无证物）"
fi

assert_contains "回滚后再验一次并报 ok" "回滚后 health=ok" "${OUT}"
assert_contains "输出明确「已回滚到」" "已回滚到" "${OUT}"

assert_eq "回滚目标 = 上一次成功部署（不是再往前一份）" "${C2}" "$(git_head)"
assert_eq "清单 gitCommit 指回回滚目标" "${C2}" "$(manifest_commit "${REPO}/.deploy-manifest.json")"
assert_eq "manifest 指回 prev 的 gitCommit" \
    "$(manifest_commit "${REPO}/.deploy-manifest.prev.json")" \
    "$(manifest_commit "${REPO}/.deploy-manifest.json")"
assert_eq "失败清单记录失败版本（新代码 c3）" "${C3}" \
    "$(grep -o '"failedCommit": *"[^"]*"' "${REPO}/.deploy-manifest.failed.json" | cut -d'"' -f4)"
assert_eq "失败清单记录回滚目标 c2" "${C2}" \
    "$(grep -o '"rollbackTarget": *"[^"]*"' "${REPO}/.deploy-manifest.failed.json" | cut -d'"' -f4)"

if [ -s "${CURL_LOG}" ]; then pass "健康探测走的是假 curl（未碰真网络）"
else fail "假 curl 未被调用（探测面可能打到了真服务）"; fi
if [ -s "${SYSTEMCTL_LOG}" ]; then fail "docker 模式竟调了 systemctl"; else pass "docker 模式未碰 systemd"; fi

# ── 3. 反证：回滚后仍失败必须如实上报，不许假成功 ──────────────────
printf '\n── 3. 回滚后也失败 ⇒ 如实报二次失败 ──\n'
new_case rollback-also-fails
wb_script "${REPO}" "wb_verify.sh" "${COMMON_PRELUDE}
verify_phase"
run_driver wb_verify.sh 99

if [ "${RC}" -ne 0 ]; then pass "回滚后仍失败 ⇒ 退出码非 0（exit=${RC}）"
else fail "回滚后仍失败却 exit 0"; fi
assert_contains "如实报「回滚后仍失败」" "回滚后仍失败" "${OUT}"
assert_not_contains "不出现「回滚后 health=ok」（不假成功）" "回滚后 health=ok" "${OUT}"
assert_not_contains "不出现「已回滚到」（未渲染成回滚成功）" "已回滚到" "${OUT}"

# ── 4. 开关：关掉后只如实失败，不动任何东西 ────────────────────────
printf '\n── 4. 开关（一键关）──\n'
new_case switch-off
wb_script "${REPO}" "wb_no_rollback.sh" "${COMMON_PRELUDE}
DEPLOY_AUTO_ROLLBACK=false
verify_phase"
run_driver wb_no_rollback.sh 1

if [ "${RC}" -ne 0 ]; then pass "关开关后仍非零退出" ; else fail "关开关后 exit 0"; fi
assert_contains "明说自动回滚已关闭" "自动回滚已关闭" "${OUT}"
assert_not_contains "关开关后不出现回滚动作" "已回滚到" "${OUT}"
assert_eq "关开关后 HEAD 未被改动" "${C3}" "$(git_head)"
if [ -f "${REPO}/.deploy-manifest.failed.json" ]; then
    pass "关开关后仍留失败证物"
    assert_contains "失败清单记录 autoRollback=false" '"autoRollback": false' \
        "$(cat "${REPO}/.deploy-manifest.failed.json")"
else
    fail "关开关后缺失败证物"
fi

# ── 5. 无上一份清单（首次部署就失败）⇒ 不假装回滚过 ────────────────
printf '\n── 5. 无可回滚记录 ⇒ 如实拒绝 ──\n'
new_case no-prev
rm -f "${REPO}/.deploy-manifest.json" "${REPO}/.deploy-manifest.prev.json"
wb_script "${REPO}" "wb_verify.sh" "${COMMON_PRELUDE}
verify_phase"
run_driver wb_verify.sh 1

if [ "${RC}" -ne 0 ]; then pass "无可回滚记录 ⇒ 非零退出"; else fail "无可回滚记录却 exit 0"; fi
assert_contains "明确报「没有可回滚的上一次部署记录」" "没有可回滚的上一次部署记录" "${OUT}"
assert_eq "无可回滚记录时 HEAD 未改动" "${C3}" "$(git_head)"

# ── 6. MODE 对齐：source 运行不得回落成 docker 默认模式 ────────────
printf '\n── 6. 回滚复用同一次运行的 MODE（不得回落默认 docker）──\n'
new_case source-mode source
ST_MODE=source
wb_script "${REPO}" "wb_verify.sh" "${COMMON_PRELUDE}
verify_phase"
run_driver wb_verify.sh 1
ST_MODE=""

if [ "${RC}" -ne 0 ]; then pass "source 模式验证失败 ⇒ 非零退出"; else fail "source 模式却 exit 0"; fi
assert_contains "source 模式回滚成功" "已回滚到" "${OUT}"
assert_contains "回滚走的是 source 分支（build/start 收到 mode=source）" "mode=source" "${OUT}"
assert_eq "source 模式回滚到 c2" "${C2}" "$(git_head)"
if [ -s "${DOCKER_LOG}" ]; then
    fail "source 模式回滚竟调用了 docker/compose（正是历史事故形态）: $(head -n1 "${DOCKER_LOG}")"
else
    pass "source 模式回滚未碰 docker/compose"
fi

# ── 7. CLI / 环境变量契约 ──────────────────────────────────────────
printf '\n── 7. 开关的 CLI 与环境变量契约 ──\n'
help_out="$(bash "${DEPLOY}" --help 2>&1 || true)"
assert_contains "--help 列出 --no-auto-rollback" "no-auto-rollback" "${help_out}"

new_case probe
wb_script "${REPO}" "probe_default.sh" 'printf "VALUE=%s\n" "${DEPLOY_AUTO_ROLLBACK}"'
wb_script "${REPO}" "probe_flag.sh" 'parse_args --no-auto-rollback
printf "VALUE=%s\n" "${DEPLOY_AUTO_ROLLBACK}"'
wb_script "${REPO}" "probe_typo.sh" 'parse_args --no-auto-rollb
printf "VALUE=%s\n" "${DEPLOY_AUTO_ROLLBACK}"'

out_default="$(cd "${REPO}" && bash "${REPO}/probe_default.sh" 2>&1 || true)"
assert_contains "默认 on" "VALUE=true" "${out_default}"

out_env_off="$(cd "${REPO}" && DEPLOY_AUTO_ROLLBACK=off bash "${REPO}/probe_default.sh" 2>&1 || true)"
assert_contains "DEPLOY_AUTO_ROLLBACK=off 关掉" "VALUE=false" "${out_env_off}"

out_env_upper="$(cd "${REPO}" && DEPLOY_AUTO_ROLLBACK=FALSE bash "${REPO}/probe_default.sh" 2>&1 || true)"
assert_contains "环境变量大小写不敏感" "VALUE=false" "${out_env_upper}"

out_env_on="$(cd "${REPO}" && DEPLOY_AUTO_ROLLBACK=on bash "${REPO}/probe_default.sh" 2>&1 || true)"
assert_contains "显式 on 仍是 on" "VALUE=true" "${out_env_on}"

out_flag="$(cd "${REPO}" && bash "${REPO}/probe_flag.sh" 2>&1 || true)"
assert_contains "--no-auto-rollback 生效" "VALUE=false" "${out_flag}"

out_typo="$(cd "${REPO}" && bash "${REPO}/probe_typo.sh" 2>&1 || true)"
assert_contains "开关拼错 → 明确报未知参数" "未知参数" "${out_typo}"

# ── 汇总 ───────────────────────────────────────────────────────────
printf '\n=== 结果: %d 通过, %d 失败 ===\n\n' "${PASSES}" "${FAILURES}"
[ "${FAILURES}" -eq 0 ] || exit 1
