#!/usr/bin/env bash
#
# deploy.sh 自检 —— 纯逻辑回归（不改系统、不起服务、不写 .env）
#
# 为什么需要它：deploy.sh 是本仓唯一会**改动生产主机**的脚本（写 systemd unit、
# 同步源码到 /opt、动数据库）。这类脚本的 bug 代价极高，但传统单测无从下手。
# 本自检走「只测纯判定逻辑 + dry-run 路径」的路线：
#   · 参数解析与校验（非法值必须拒绝，且不能静默回落）
#   · doctor --json 的结构契约（中台 Agent 消费它）
#   · 封闭枚举（restart/logs 不接受任意服务名）
#   · health 退出码闸门（逐项探测含 executor-python，异常汇总 exit 1）
#   · 向后兼容（默认 docker；旧参数仍生效）
#
# 用法: bash scripts/deploy.selftest.sh
# 退出码: 0=全通过, 1=有失败

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly SCRIPT_DIR ROOT_DIR
readonly DEPLOY="$ROOT_DIR/deploy.sh"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES + 1)); printf '  ✔ %s\n' "$1"; }
fail() { FAILURES=$((FAILURES + 1)); printf '  ✘ %s\n' "$1" >&2; }

# assert_contains <测试名> <期望子串> <实际输出>
assert_contains() {
    local name="$1" needle="$2" haystack="$3"
    if printf '%s' "$haystack" | grep -qF -- "$needle"; then
        pass "$name"
    else
        fail "${name}（期望含: ${needle}；实际: $(printf '%s' "$haystack" | head -c 200)）"
    fi
}

# assert_exit <测试名> <期望退出码> <命令...>
assert_exit() {
    local name="$1" expected="$2"; shift 2
    local actual=0
    "$@" >/dev/null 2>&1 || actual=$?
    if [ "$actual" -eq "$expected" ]; then
        pass "${name}（exit=${actual}）"
    else
        fail "${name}（期望 exit=${expected}，实际 exit=${actual}）"
    fi
}

[ -f "$DEPLOY" ] || { echo "找不到 deploy.sh: $DEPLOY" >&2; exit 1; }

printf '\n=== deploy.sh 自检 ===\n\n'

# ── 1. 语法 ────────────────────────────────────────────────────────
printf '── 1. 语法与可执行性 ──\n'
assert_exit "bash -n 语法检查通过" 0 bash -n "$DEPLOY"
if [ -x "$DEPLOY" ]; then pass "具有可执行权限"; else fail "缺少可执行权限（chmod +x）"; fi

# ── 2. 参数校验（非法值必须拒绝）─────────────────────────────────
printf '\n── 2. 参数校验 ──\n'

out="$(bash "$DEPLOY" --mode bogus 2>&1)"; assert_contains "拒绝非法 --mode" "--mode 只能是" "$out"
out="$(bash "$DEPLOY" --env bogus 2>&1)"; assert_contains "拒绝非法 --env" "--env 只能是" "$out"
out="$(bash "$DEPLOY" --nope 2>&1)"; assert_contains "拒绝未知参数" "未知参数" "$out"

# 反证：非法值不得被静默接受（不能出现"部署开始"字样）
out="$(bash "$DEPLOY" --mode bogus --dry-run 2>&1)"
if printf '%s' "$out" | grep -qF "部署完成"; then
    fail "非法 --mode 竟被接受并执行（反证失败）"
else
    pass "非法 --mode 未进入部署流程"
fi

# ── 3. --help ──────────────────────────────────────────────────────
printf '\n── 3. 帮助 ──\n'
out="$(bash "$DEPLOY" --help 2>&1)"
assert_contains "--help 列出子命令" "doctor" "$out"
assert_contains "--help 说明双模" "--mode" "$out"
assert_exit "-h 退出码为 0" 0 bash "$DEPLOY" -h

# ── 4. 向后兼容（关键回归点）─────────────────────────────────────
printf '\n── 4. 向后兼容 ──\n'
# 旧行为：不带 --mode 时必须是 docker
out="$(bash "$DEPLOY" --dry-run --skip-preflight 2>&1)"
assert_contains "默认模式为 docker" "模式: docker" "$out"
# 旧参数 -e/--env 仍生效
out="$(bash "$DEPLOY" --env staging --dry-run --skip-preflight 2>&1)"
assert_contains "旧 --env 参数生效" "环境: staging" "$out"

# ── 5. 封闭枚举（restart/logs 不接受任意服务名）───────────────────
printf '\n── 5. 封闭枚举 ──\n'
out="$(bash "$DEPLOY" restart evil-service 2>&1)"
assert_contains "restart 拒绝任意服务名" "未知组件" "$out"
out="$(bash "$DEPLOY" restart ../../etc/passwd 2>&1)"
assert_contains "restart 拒绝路径穿越" "未知组件" "$out"
out="$(bash "$DEPLOY" restart 2>&1)"
assert_contains "restart 缺参数给用法" "用法" "$out"

# 审计修复：logs 此前无白名单，任意串直透 compose/journalctl
out="$(bash "$DEPLOY" logs evil-service 2>&1)"
assert_contains "logs 拒绝任意服务名" "未知组件" "$out"
out="$(bash "$DEPLOY" logs ../../etc/passwd 2>&1)"
assert_contains "logs 拒绝路径穿越" "未知组件" "$out"
assert_exit "logs 未知组件非零退出" 1 bash "$DEPLOY" logs evil-service

# ── 6. doctor --json 结构契约 ─────────────────────────────────────
printf '\n── 6. doctor --json 结构契约 ──\n'
json_out="$(bash "$DEPLOY" doctor --json 2>/dev/null || true)"

if [ -z "$json_out" ]; then
    fail "doctor --json 无 stdout 输出"
else
    pass "doctor --json 有输出"

    # JSON 深校验用 **node**（本自检经 `npm run test:deploy-script` 调起，
    # node 是硬前提）。为什么不用 python3：Windows 上 `command -v python3`
    # 会命中 Microsoft Store 的占位 stub——在 PATH 上、`command -v` 判存在、
    # 实跑必败（"Python was not found"），曾有环境下 5 项断言全部假阳。
    json_node() {
        printf '%s' "$json_out" | node -e "$1" 2>/dev/null
    }

    # stdout 必须是纯 JSON（人类可读输出走 stderr）
    if json_node 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{JSON.parse(s);process.exit(0)}catch(e){process.exit(1)}});'; then
        pass "stdout 是合法 JSON（无进度行污染）"
    else
        fail "stdout 不是纯 JSON（有非 JSON 行混入）"
    fi

    # 必需字段
    for field in deployable summary checks; do
        if json_node "let s=\"\";process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);process.exit('$field' in d?0:1)});"; then
            pass "含必需字段: $field"
        else
            fail "缺必需字段: $field"
        fi
    done

    # checks 每项必须有 name/status/detail，status 取值受控
    if json_node "let s=\"\";process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);if(!Array.isArray(d.checks)||d.checks.length===0)process.exit(1);for(const c of d.checks){for(const k of ['name','status','detail'])if(!(k in c))process.exit(1);if(!['ok','warn','fail'].includes(c.status))process.exit(1)}if(!(['fail','warn'].every(k=>k in d.summary)))process.exit(1)});"; then
        pass "checks 项结构合法（name/status/detail + 受控 status）"
    else
        fail "checks 项结构不合法"
    fi

    # deployable 与 summary.fail 必须一致（语义自洽）
    if json_node "let s=\"\";process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);process.exit(d.deployable===(d.summary.fail===0)?0:1)});"; then
        pass "deployable 与 summary.fail 语义一致"
    else
        fail "deployable 与 summary.fail 不一致"
    fi
fi

# ── 7. 生产模式防护 ───────────────────────────────────────────────
printf '\n── 7. 生产模式防护 ──\n'
# 无 --i-know-its-production 时必须拒绝（非 dry-run）
out="$(bash "$DEPLOY" --env production 2>&1 || true)"
assert_contains "生产部署需显式确认" "i-know-its-production" "$out"
# dry-run 下不拦（只打印不落地）
out="$(bash "$DEPLOY" --env production --dry-run --skip-preflight 2>&1 || true)"
if printf '%s' "$out" | grep -qF "i-know-its-production"; then
    fail "dry-run 被生产确认拦截（应放行）"
else
    pass "dry-run 不受生产确认拦截"
fi

# ── 8. 生产配置校验（占位值必须被拒）─────────────────────────────
printf '\n── 8. 生产配置校验 ──\n'
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

# 构造一个「全是占位值」的 .env，复制脚本到临时目录测
cp "$DEPLOY" "$tmp_dir/deploy.sh"
cp "$ROOT_DIR/.env.example" "$tmp_dir/.env.example" 2>/dev/null || true
chmod +x "$tmp_dir/deploy.sh"

# 用占位值 .env（.env.example 原样）→ 生产校验必须失败
cp "$ROOT_DIR/.env.example" "$tmp_dir/.env"
out="$(cd "$tmp_dir" && bash ./deploy.sh --env production --i-know-its-production --skip-preflight --dry-run 2>&1 || true)"
assert_contains "占位密码被拒" "占位值" "$out"

# 用合规值 .env → 生产校验必须通过
{
    printf 'DB_PASSWORD=%s\n' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    printf 'JWT_SECRET=%s\n' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    printf 'JWT_REFRESH_SECRET=%s\n' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    printf 'EXECUTOR_SECRET=%s\n' "$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    printf 'REDIS_PASSWORD=%s\n' "$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    printf 'CORS_ORIGINS=https://acf.example.com\n'
    # OPS-03（2026-10-27 审计轮 #7）：生产守卫会拒绝占位口令，脚本必须同口径校验，
    # 否则"校验通过"、容器随后崩（这正是首部署事故的形态）。
    printf 'INITIAL_ADMIN_PASSWORD=StrongAdminPass2026\n'
} > "$tmp_dir/.env"

out="$(cd "$tmp_dir" && bash ./deploy.sh --env production --i-know-its-production --skip-preflight --dry-run 2>&1 || true)"
if printf '%s' "$out" | grep -qF "生产配置校验通过"; then
    pass "合规配置通过生产校验"
else
    fail "合规配置未通过生产校验（实际: $(printf '%s' "$out" | grep -F '校验' | head -c 200)）"
fi

# CORS 含回环地址且未显式放行 → 必须被拒（口径与 configuration.ts 一致）
sed -i 's|^CORS_ORIGINS=.*|CORS_ORIGINS=http://localhost|' "$tmp_dir/.env"
out="$(cd "$tmp_dir" && bash ./deploy.sh --env production --i-know-its-production --skip-preflight --dry-run 2>&1 || true)"
assert_contains "CORS 含回环地址未放行被拒" "CORS 含回环地址但未显式放行" "$out"

# 反向：显式 ALLOW_LOOPBACK_CORS=true → 同一份配置必须放行（否则本机试跑永远过不了）
printf 'ALLOW_LOOPBACK_CORS=true\n' >> "$tmp_dir/.env"
out="$(cd "$tmp_dir" && bash ./deploy.sh --env production --i-know-its-production --skip-preflight --dry-run 2>&1 || true)"
if printf '%s' "$out" | grep -qF "生产配置校验通过"; then
    pass "ALLOW_LOOPBACK_CORS=true 时回环 CORS 放行"
else
    fail "ALLOW_LOOPBACK_CORS=true 仍被拒（实际: $(printf '%s' "$out" | grep -F '校验' | head -c 160)）"
fi
sed -i '/^ALLOW_LOOPBACK_CORS=/d' "$tmp_dir/.env"

# INITIAL_ADMIN_PASSWORD 缺失 → 必须被拒（首部署崩溃事故的守门断言）
sed -i '/^INITIAL_ADMIN_PASSWORD=/d' "$tmp_dir/.env"
out="$(cd "$tmp_dir" && bash ./deploy.sh --env production --i-know-its-production --skip-preflight --dry-run 2>&1 || true)"
assert_contains "缺 INITIAL_ADMIN_PASSWORD 被拒" "INITIAL_ADMIN_PASSWORD" "$out"
printf 'INITIAL_ADMIN_PASSWORD=StrongAdminPass2026\n' >> "$tmp_dir/.env"

# ── 9. dry-run 不改系统 ──────────────────────────────────────────
printf '\n── 9. dry-run 安全性 ──\n'
# 复制到临时目录跑完整 dry-run，断言没有产生 .deploy-manifest.json、
# 没有创建 .env（dry-run 的核心承诺）
rm -f "$tmp_dir/.env"
out="$(cd "$tmp_dir" && bash ./deploy.sh --mode source --dry-run 2>&1 || true)"
if [ -f "$tmp_dir/.env" ]; then
    fail "dry-run 竟然创建了 .env"
else
    pass "dry-run 未创建 .env"
fi
if [ -f "$tmp_dir/.deploy-manifest.json" ]; then
    fail "dry-run 竟然写了部署清单"
else
    pass "dry-run 未写部署清单"
fi
case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
        # Windows 原生：预检的「平台」检查项按设计就是 fail（源码模式依赖
        # systemd），dry-run 被预检拦截是**正确行为**而非缺陷。钉住拦截语义，
        # Linux 专属的「走完全部 8 阶段」断言在此环境如实跳过（不造假绿）。
        assert_contains "Windows 上 dry-run 被预检按设计拦截" "预检失败" "$out"
        printf '  (跳过「8 阶段全程」断言：Windows 原生不受支持是预检的预期判定——Linux/WSL 环境仍会校验)\n'
        ;;
    *)
        assert_contains "dry-run 走完全部 8 阶段" "⑧ 验证 Verify" "$out"
        ;;
esac

# ── 10. 迁移前备份 / detached HEAD（审计二轮 B-1/B-5）────────────
printf '\n── 10. 迁移前备份 / detached HEAD ──\n'
# B-1：迁移前备份必须走 compose pg-backup 服务（PG* 由 compose 注入）——旧实现
# 宿主机直跑 pg-backup.sh，其强依赖的 PGHOST/PGUSER/PGPASSWORD/PGDATABASE 四个
# 变量只在 compose 服务 environment 里定义，缺一即失败且 stderr 被 2>/dev/null
# 吞掉 = 默认必失败的静默失败。dry-run 打印的命令里必须出现 pg-backup。
out="$(bash "$DEPLOY" --dry-run --skip-preflight 2>&1 || true)"
assert_contains "迁移前备份走 compose pg-backup 服务" "pg-backup" "$out"
if printf '%s' "$out" | grep -F "pg-backup" | grep -qF "2>/dev/null"; then
    fail "备份命令仍吞 stderr（2>/dev/null）"
else
    pass "备份命令不再吞 stderr"
fi

# P1-6（审计 2026-10-17）：docker 分支的备份退出码必须传播。
# 缺陷现场：run_pre_migration_backup_cmd 的 docker 分支无条件 `return 0`，
# 备份失败被当作成功 → migration_phase 的「生产备份失败即中止」守卫对
# docker 部署完全失效 → 可能在无备份前提下跑破坏性 DDL。
# 断言：函数体里不再出现「compose run ... pg-backup」之后紧跟的裸 return 0。
#
# 注意：本脚本启用了 `set -o pipefail`，而 `awk ... | grep -q` 会在 grep 命中
# 后提前退出、让 awk 吃 SIGPIPE——整条管道因此返回非 0，`if` 判成「没匹配」。
# 故一律先落临时文件再 grep（本文件其它断言也遵循同一写法）。
_func_body="$(mktemp)"
awk '/run_pre_migration_backup_cmd\(\)/,/^}/' "$DEPLOY" > "$_func_body"
if grep -A2 'pg-backup /usr/local/bin/pg-backup.sh' "$_func_body" \
        | grep -qE '^[[:space:]]*return 0[[:space:]]*$'; then
    fail "P1-6：docker 备份失败仍被 return 0 吞掉"
else
    pass "P1-6：docker 备份退出码如实传播（不再 return 0 吞失败）"
fi

# P1-7（审计 2026-10-17）：rollback 必须从 MANIFEST_PREV 恢复 mode。
# 缺陷现场：只读 gitCommit，MODE 沿用命令行默认（docker）——源码模式部署
# 后回滚会去起容器，systemd 仍跑新代码，报假成功。
awk '/^cmd_rollback\(\)/,/^}/' "$DEPLOY" > "$_func_body"
if grep -q 'prev_mode' "$_func_body"; then
    pass "P1-7：rollback 读取上一次部署的 mode"
else
    fail "P1-7：rollback 未读取 mode（仍按当前默认模式回滚）"
fi
if grep -q 'stop_for_mode_switch' "$_func_body"; then
    pass "P1-7：模式切换前先停掉旧运行时"
else
    fail "P1-7：模式切换未停旧运行时（两套并存）"
fi
rm -f "$_func_body"

# B-5：rollback 遗留的 detached HEAD 必须在部署启动时告警（提示基于该 commit
# 继续 + 如何切回）。构造一个独立 git 仓库并 detach——deploy.sh 以自身所在目录
# 为 ROOT_DIR，所以要把脚本复制进去跑。
tmp_git="$(mktemp -d)"
cp "$DEPLOY" "$tmp_git/deploy.sh"
cp "$ROOT_DIR/.env.example" "$tmp_git/.env.example" 2>/dev/null || true
(
    cd "$tmp_git" && git init -q \
        && git -c user.email=selftest@acf -c user.name=selftest commit -q --allow-empty -m init \
        && git checkout -q --detach HEAD
) >/dev/null 2>&1
out="$(cd "$tmp_git" && bash ./deploy.sh --dry-run --skip-preflight 2>&1 || true)"
assert_contains "detached HEAD 启动告警" "detached HEAD" "$out"
assert_contains "detached HEAD 提示基于该 commit 继续" "基于该 commit 构建" "$out"
rm -rf "$tmp_git"

# 反证：正常分支上不得出现该告警（真仓库自身即分支工作树）
# CI 环境特例：GitHub Actions 在 PR 时可能使用 detached HEAD（合并预览提交），
# 这是 CI 的正常行为，不是 deploy.sh 的 bug——若确实处于 detached HEAD，
# deploy.sh 正确报告它即为预期；本检查只在本地分支工作树（symbolic-ref 成功）
# 时验证告警不误触发。
if git -C "$ROOT_DIR" symbolic-ref --short HEAD >/dev/null 2>&1; then
    # 确认在分支上，检查不应该报 detached HEAD
    out="$(bash "$DEPLOY" --dry-run --skip-preflight 2>&1 || true)"
    if printf '%s' "$out" | grep -qF "detached HEAD"; then
        fail "分支工作树上竟报 detached HEAD（反证失败）"
    else
        pass "分支工作树无 detached HEAD 告警"
    fi
else
    # CI 环境或已处于 detached HEAD，跳过此检查
    pass "分支工作树无 detached HEAD 告警（跳过：当前已是 detached HEAD，无需验证）"
fi

# ── 11. health 闸门 / logs 透传（桩 curl/docker/journalctl，不打真实服务）──
# 覆盖边界：真实 HTTP 探测与真实 compose/journalctl 不在此范围（需真部署）；
# 这里以 PATH 前置的桩命令验证 deploy.sh 的判定与拼装逻辑：探测覆盖面、
# 失败汇总退出码、枚举内组件的透传形态。
printf '\n── 11. health 闸门 / logs 透传 ──\n'
stub_bin="$(mktemp -d)"

# 桩 curl：按 URL 输出模拟的 -w '%{http_code}' 结果（http_code 只消费 stdout，
# 退出码已被调用方 `|| true` 吞掉）。executor-python 实际只有 /health 路由。
cat > "$stub_bin/curl" <<'STUB'
#!/usr/bin/env bash
url="${!#}"
case "$url" in
    */api/health/live)  echo 200 ;;
    */api/health/ready) echo 200 ;;
    *:8002/health)      echo 200 ;;
    *:8001/health)      echo "${STUB_PY_HEALTH:-200}" ;;
    *)                  echo 500 ;;
esac
exit 0
STUB
chmod +x "$stub_bin/curl"

rc=0
out="$(PATH="$stub_bin:$PATH" bash "$DEPLOY" health 2>&1)" || rc=$?
assert_contains "health 探测覆盖 executor-python" "executor-python" "$out"
assert_contains "health 探测覆盖 executor-node" "executor-node" "$out"
if [ "$rc" -eq 0 ]; then
    pass "health 全部 2xx → exit 0"
else
    fail "health 全部 2xx 应 exit 0（实际 exit=${rc}）"
fi

rc=0
out="$(PATH="$stub_bin:$PATH" STUB_PY_HEALTH=500 bash "$DEPLOY" health 2>&1)" || rc=$?
assert_contains "health 异常项人类可读（✘ HTTP 500）" "HTTP 500" "$out"
if [ "$rc" -eq 1 ]; then
    pass "health 有异常 → exit 1（CI/Agent 闸门）"
else
    fail "health 有异常应 exit 1（实际 exit=${rc}）"
fi

# 桩 docker：记录调用参数（含 `compose version` 探测），模拟 v2 插件路径。
# 日志路径经环境变量传入（桩是独立进程，selftest 的变量对它不可见）。
cat > "$stub_bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${STUB_DOCKER_LOG:-/dev/null}"
exit 0
STUB
chmod +x "$stub_bin/docker"

rm -f "$stub_bin/docker-calls.log"
STUB_DOCKER_LOG="$stub_bin/docker-calls.log" PATH="$stub_bin:$PATH" \
    bash "$DEPLOY" logs admin-api >/dev/null 2>&1 || true
assert_contains "logs admin-api 原样透传 compose" "logs -f --tail=100 admin-api" \
    "$(cat "$stub_bin/docker-calls.log" 2>/dev/null || echo '')"

rm -f "$stub_bin/docker-calls.log"
STUB_DOCKER_LOG="$stub_bin/docker-calls.log" PATH="$stub_bin:$PATH" \
    bash "$DEPLOY" logs all >/dev/null 2>&1 || true
out="$(tail -n1 "$stub_bin/docker-calls.log" 2>/dev/null || echo '')"
if printf '%s' "$out" | grep -qF 'logs -f --tail=100'; then
    pass "logs all 透传为不过滤的 compose logs（不带服务名）"
else
    fail "logs all 应透传 compose logs（实际: ${out}）"
fi

# 桩 journalctl：源码模式 logs all 聚合全部执行器 unit（admin-web=nginx 无 unit）。
# 注：子命令调用不解析 --mode（parse_args 只在首参识别子命令），source 分支
# 经 CLI 不可达（restart 的 source 分支同）——用白盒驱动测：拷贝 deploy.sh、
# 摘掉末尾 main "$@"（防误触发真实部署）、改为直接调 cmd_logs。
cat > "$stub_bin/journalctl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${STUB_JOURNALCTL_LOG:-/dev/null}"
exit 0
STUB
chmod +x "$stub_bin/journalctl"

tmp_logs="$(mktemp -d)"
grep -v '^main "\$@"$' "$DEPLOY" > "$tmp_logs/deploy.sh"
if grep -q '^main "\$@"' "$tmp_logs/deploy.sh"; then
    fail "logs 源码分支白盒驱动未挂载（deploy.sh 末尾格式漂移，需修 selftest）"
else
    bash -n "$tmp_logs/deploy.sh" || fail "白盒拷贝语法损坏"
    printf '\nMODE="source"\ncmd_logs all\n' >> "$tmp_logs/deploy.sh"
    STUB_JOURNALCTL_LOG="$stub_bin/journalctl-calls.log" PATH="$stub_bin:$PATH" \
        bash "$tmp_logs/deploy.sh" >/dev/null 2>&1 || true
    out="$(cat "$stub_bin/journalctl-calls.log" 2>/dev/null || echo '')"
    assert_contains "source logs all 聚合 admin-api unit" "-u acf-admin-api" "$out"
    assert_contains "source logs all 聚合 executor-python unit" "-u acf-executor-python" "$out"
    if printf '%s' "$out" | grep -qF "acf-admin-web"; then
        fail "source logs all 不应含 admin-web（无 systemd unit，对齐 restart all 跳过语义）"
    else
        pass "source logs all 跳过 admin-web"
    fi
fi
rm -rf "$tmp_logs"

rm -rf "$stub_bin"

# ── 12. 部署诚实化：镜像未重建 / 就绪闸门（OPS-04 / OPS-05，2026-10-27）──
# 这两条都属于"部署报告说绿、线上其实不可用"：镜像没重建却报部署完成；
# ready 恒 503 却被吞掉。判据在 deploy.sh 里，这里用白盒驱动（摘掉末尾 main，
# 直接调阶段函数 + 覆写 wait_http）避免真跑容器。
printf '\n── 12. 部署诚实化（镜像未重建 / 就绪闸门）──\n'
# ROOT_DIR / MANIFEST_FILE 在 deploy.sh 里是 readonly（由脚本所在目录推导），
# 所以白盒驱动必须**在临时仓库里跑**（脚本放在 tmp 仓库根，ROOT_DIR 自然是它），
# 再让清单里的 gitCommit 与真实 HEAD 不同 —— 这正是"代码变了但镜像没重建"的形态。
tmp_h="$(mktemp -d)"
cp "$DEPLOY" "$tmp_h/deploy.sh"
cp "$ROOT_DIR/.env.example" "$tmp_h/.env.example" 2>/dev/null || true
printf '{\n  "mode": "docker",\n  "gitCommit": "deadbeef",\n  "components": "admin-api"\n}\n' \
    > "$tmp_h/.deploy-manifest.json"
(
    cd "$tmp_h" && git init -q \
        && git -c user.email=selftest@acf -c user.name=selftest commit -q --allow-empty -m init
) >/dev/null 2>&1

# 12a：dry-run 下只告警（dry-run 的承诺是"只打印不判定"）
out="$(cd "$tmp_h" && bash ./deploy.sh --dry-run --skip-preflight 2>&1 || true)"
assert_contains "镜像未重建（dry-run 告警）" "镜像未重建" "$out"

# 12b：生产 + 非 dry-run + 代码已变 + 无 --build ⇒ 必须拒绝
wb="$tmp_h/wb_build.sh"
grep -v '^main "\$@"$' "$tmp_h/deploy.sh" > "$wb"
cat >> "$wb" <<WB
MODE="docker"; BUILD=false; DRY_RUN=false; ENV_NAME="production"; ALLOW_STALE_IMAGE=false; IMAGE_STATE=""
build_phase
WB
out="$(cd "$tmp_h" && bash ./wb_build.sh 2>&1 || true)"
assert_contains "生产缺 --build 且代码已变 → 拒绝部署" "没加 --build" "$out"

# 12c：加 --allow-stale-image 后同一场景放行（逃生门可用）
wb2="$tmp_h/wb_build2.sh"
grep -v '^main "\$@"$' "$tmp_h/deploy.sh" > "$wb2"
cat >> "$wb2" <<WB
MODE="docker"; BUILD=false; DRY_RUN=false; ENV_NAME="production"; ALLOW_STALE_IMAGE=true; IMAGE_STATE=""
build_phase
WB
out="$(cd "$tmp_h" && bash ./wb_build2.sh 2>&1 || true)"
assert_contains "逃生门 --allow-stale-image 生效" "已按 --allow-stale-image 放行" "$out"

# 12d：ready 恒 503 ⇒ 默认判部署失败（旧实现是 || true 吞掉）
wb_verify="$tmp_h/wb_verify.sh"
grep -v '^main "\$@"$' "$tmp_h/deploy.sh" > "$wb_verify"
cat >> "$wb_verify" <<'WB'
MODE="docker"; DRY_RUN=false; ENV_NAME="development"; READINESS=""
COMPONENTS="admin-web"; ALLOW_DEGRADED="${ST_TEST_ALLOW_DEGRADED:-false}"
wait_http() { case "$1" in */api/health/ready) return 1 ;; *) return 0 ;; esac; }
dump_recent_logs() { :; }
verify_phase
WB
out="$(cd "$tmp_h" && ST_TEST_ALLOW_DEGRADED=false bash ./wb_verify.sh 2>&1 || true)"
assert_contains "ready 失败默认判部署失败" "部署未通过验证" "$out"

# 12e：--allow-degraded 放行，且清单必须记 readiness=degraded（不再是无声降级）
out="$(cd "$tmp_h" && ST_TEST_ALLOW_DEGRADED=true bash ./wb_verify.sh 2>&1 || true)"
assert_contains "逃生门 --allow-degraded 生效" "验证通过" "$out"
if grep -q '"readiness": "degraded"' "$tmp_h/.deploy-manifest.json"; then
    pass "清单记录 readiness=degraded"
else
    fail "清单未记录 readiness（降级被无声吞掉）"
fi

# 12f：docker 模式不得再起 infra 那一套 PG/Redis（OPS-06）——两套并存时宿主 psql
# 看到的是空库，灾备演练会证明错的对象；就绪等待改由 compose depends_on 承担。
out="$(cd "$tmp_h" && bash ./deploy.sh --mode docker --dry-run --skip-preflight 2>&1 || true)"
if printf '%s' "$out" | grep -qF "infra/docker-compose.yml"; then
    fail "docker 模式仍在启动 infra 栈（两套 PG 并存）"
else
    pass "docker 模式不启动 infra 栈"
fi
# 反向：source 模式必须仍然起 infra 栈（那是它唯一的 PG/Redis 来源）
out="$(cd "$tmp_h" && bash ./deploy.sh --mode source --dry-run --skip-preflight 2>&1 || true)"
assert_contains "source 模式仍启动 infra 栈" "infra/docker-compose.yml" "$out"

# 12g：pg-backup 服务必须挂上恢复脚本，否则 operations.md 的灾备命令照抄即失败（OPS-07）
if grep -q 'pg-restore.sh:/usr/local/bin/pg-restore.sh' "$ROOT_DIR/docker-compose.yml"; then
    pass "pg-backup 服务已挂载 pg-restore.sh"
else
    fail "pg-backup 服务缺 pg-restore.sh 挂载（runbook 命令会 No such file）"
fi

rm -rf "$tmp_h"

# ── 13. 新开关的 CLI 契约（--allow-degraded / --allow-stale-image）──
# 为什么单独一段：这两个开关是「默认从严 + 显式逃生门」的形态，最容易在后续
# 重构里被悄悄删掉（删掉不报错，只是行为回到"永远严格"或"永远宽松"）。
# 断言三件事：① --help 里能查到（运维可发现）；② 参数确实被解析（不是被当成
# 未知参数 die）；③ 拼错时明确报"未知参数"而不是静默忽略。
printf '\n── 13. 新开关的 CLI 契约 ──\n'
help_out="$(bash "$DEPLOY" --help 2>&1 || true)"
assert_contains "--help 列出 --allow-degraded" "allow-degraded" "$help_out"
assert_contains "--help 列出 --allow-stale-image" "allow-stale-image" "$help_out"

# ② 被解析：dry-run 下带这两个开关必须照常走完（不 die "未知参数"）
out="$(bash "$DEPLOY" --dry-run --skip-preflight --allow-degraded --allow-stale-image 2>&1 || true)"
if printf '%s' "$out" | grep -qF "未知参数"; then
    fail "新开关被当成未知参数（CLI 契约破了）"
else
    pass "新开关可被解析（dry-run 不因未知参数中止）"
fi

# ③ 拼错 → 明确报未知参数（防"写了但不生效"）
out="$(bash "$DEPLOY" --dry-run --skip-preflight --allow-degrade 2>&1 || true)"
assert_contains "开关拼错时明确报未知参数" "未知参数" "$out"

# ── 14. 首部署自举的真实行为（OPS-03，白盒跑 config_phase）──
# 这段是**真跑**而不是读源码：在 tmp 目录复制一份 deploy.sh（ROOT_DIR 由脚本
# 位置推导，天然指向 tmp）+ .env.example，摘掉末尾 main 后直接调 config_phase。
# 它验证的正是那次首部署事故的三条：①管理员口令真的生成并打印（只打印一次）；
# ②非生产自动写 ALLOW_LOOPBACK_CORS；③生产缺真实域名**当场 fail-fast**，
# 而不是让容器 crash-loop 到 ⑧ 验证阶段才暴露（那时 doctor 还是绿的）。
printf '\n── 14. 首部署自举（config_phase 白盒）──\n'
tmp_boot="$(mktemp -d)"
cp "$DEPLOY" "$tmp_boot/deploy.sh"
cp "$ROOT_DIR/.env.example" "$tmp_boot/.env.example" 2>/dev/null || true

# 14a：staging 全新目录 → 生成口令 + 写 ALLOW_LOOPBACK_CORS
grep -v '^main "\$@"$' "$tmp_boot/deploy.sh" > "$tmp_boot/wb_staging.sh"
cat >> "$tmp_boot/wb_staging.sh" <<'WB'
ENV_NAME="staging"
DRY_RUN=false
config_phase
WB
out="$(cd "$tmp_boot" && bash ./wb_staging.sh 2>&1 || true)"
assert_contains "staging 首部署打印管理员初始口令" "管理员初始口令" "$out"
if grep -qE '^INITIAL_ADMIN_PASSWORD=.{8,}' "$tmp_boot/.env" 2>/dev/null; then
    pass "INITIAL_ADMIN_PASSWORD 已写入 .env（长度合规）"
else
    fail "INITIAL_ADMIN_PASSWORD 未写入 .env（首部署会崩在 admin-api 的生产守卫）"
fi
if grep -qE '^ALLOW_LOOPBACK_CORS=true$' "$tmp_boot/.env" 2>/dev/null; then
    pass "非生产自动写 ALLOW_LOOPBACK_CORS=true"
else
    fail "非生产未写 ALLOW_LOOPBACK_CORS（compose 默认 localhost CORS 会被生产守卫打死）"
fi

# 14b：production + 缺真实域名 → 必须 fail-fast（不是崩到 ⑧）
rm -f "$tmp_boot/.env"
grep -v '^main "\$@"$' "$tmp_boot/deploy.sh" > "$tmp_boot/wb_prod.sh"
cat >> "$tmp_boot/wb_prod.sh" <<'WB'
ENV_NAME="production"
DRY_RUN=false
config_phase
WB
out="$(cd "$tmp_boot" && bash ./wb_prod.sh 2>&1 || true)"
assert_contains "生产缺真实域名当场拒绝" "生产部署需要真实域名" "$out"

rm -rf "$tmp_boot"

# ── 15. 部署形态参数（DEPLOY-OVERLAY-01）──
# 这两个参数修的是两个**都不会报错**的生产坑：
#   ① 项目名不符 → 在旁边新建一整套平行容器，旧栈照跑，deploy 却报"成功"；
#   ② 缺覆盖层 → 把本机 executor 容器也起起来，与真实执行器抢注册面。
# 判据必须落到**展开后的 compose argv**（只断言"参数被接受"会漏掉拼错的
# 覆盖层名之类）。这里白盒 source dc_args，直接看它拼出什么。
printf '\n── 15. 部署形态参数（--project / --overlay）──\n'

# 只摘 dc_args 函数体（不内联整个脚本）：deploy.sh 顶部有 set -u +
# BASH_SOURCE 取 SCRIPT_DIR，整段内联进 bash -c 会因 BASH_SOURCE 未绑定而炸
# ——那与「参数拼错了吗」毫无关系，属断言 harness 自身的假红。
extract_dc_args() {
    sed -n '/^dc_args()/,/^}/p' "$DEPLOY"
}

# 15a：默认形态——不带 -p，只叠根 compose（向后兼容：老命令行为逐字节不变）
wb_out="$(ROOT_TEST=1 bash -c '
    ROOT_DIR="'"$ROOT_DIR"'"
    die() { return 1; }
    '"$(extract_dc_args)"'
    COMPOSE_PROJECT=""; COMPOSE_OVERLAYS=""
    dc_args
' 2>&1)"
if printf '%s' "$wb_out" | grep -q '^-p$'; then
    fail "默认形态不应带 -p（旧命令必须零行为变化）"
else
    pass "默认形态不带 -p（向后兼容）"
fi
assert_contains "默认形态仍叠根 compose" "docker-compose.yml" "$wb_out"
assert_contains "默认形态显式指根 .env（PG initdb 缺口令的老坑）" ".env" "$wb_out"

# 15b：生产形态——-p acf 前置，覆盖层按序全部展开
wb_out="$(ROOT_TEST=1 bash -c '
    ROOT_DIR="'"$ROOT_DIR"'"
    die() { return 1; }
    '"$(extract_dc_args)"'
    COMPOSE_PROJECT="acf"
    COMPOSE_OVERLAYS="docker-compose.local.yml,docker-compose.no-executor.yml,docker-compose.frp.yml"
    dc_args
' 2>&1)"
mapfile -t wb_lines <<< "$wb_out"
if [ "${wb_lines[0]:-}" = "-p" ] && [ "${wb_lines[1]:-}" = "acf" ]; then
    pass "生产形态 -p acf 出现在 argv 最前（compose 要求全局参数在子命令之前）"
else
    fail "生产形态 -p acf 位置不对（实际首两行: ${wb_lines[0]:-} ${wb_lines[1]:-}）"
fi
for layer in docker-compose.local.yml docker-compose.no-executor.yml docker-compose.frp.yml; do
    assert_contains "覆盖层已展开: $layer" "$layer" "$wb_out"
done

# 15c：覆盖层拼错 → 必须当面报错，不得静默少叠一层
wb_out="$(ROOT_TEST=1 bash -c '
    ROOT_DIR="'"$ROOT_DIR"'"
    die() { echo "DIE: $*"; return 1; }
    '"$(extract_dc_args)"'
    COMPOSE_PROJECT=""
    COMPOSE_OVERLAYS="docker-compose.typo.yml"
    dc_args || true
' 2>&1)"
assert_contains "覆盖层拼错 → 明确报错（不静默少叠）" "覆盖层不存在" "$wb_out"

# 15d：源码模式拒绝这两个参数（避免"加了但没生效"）
out="$(bash "$DEPLOY" --mode source --dry-run --skip-preflight --project acf 2>&1 || true)"
assert_contains "源码模式传 --project → 明确拒绝" "只适用于 --mode docker" "$out"
out="$(bash "$DEPLOY" --mode source --dry-run --skip-preflight \
        --overlay docker-compose.local.yml 2>&1 || true)"
assert_contains "源码模式传 --overlay → 明确拒绝" "只适用于 --mode docker" "$out"

# 15e：项目名字符集闸（大写/空格会被 compose 自行归一化，与既有 acf-* 对不上）
out="$(bash "$DEPLOY" --mode docker --dry-run --skip-preflight --project ACF 2>&1 || true)"
assert_contains "项目名含大写 → 拒绝（防归一化后对不上既有容器）" "只能用小写字母" "$out"

# 15f：no-executor 覆盖层下，health 不得把"本机没执行器"误报成故障。
# 判据落在 executors_excluded_by_overlay + component_enabled 的组合上：只看
# 参数被接受是不够的，真正会咬人的是 health 探 127.0.0.1:8001/8002 恒 000。
# （真跑 health 需要真栈，这里白盒断言判定函数本身。）
wb_out="$(bash -c '
    '"$(sed -n '/^executors_excluded_by_overlay()/,/^}/p' "$DEPLOY")"'
    '"$(sed -n '/^component_enabled()/,/^}/p' "$DEPLOY")"'
    '"$(sed -n '/^resolve_components()/,/^}/p' "$DEPLOY")"'
    NODE_COMPONENTS="admin-api admin-web executor-node"
    PYTHON_COMPONENTS="executor-python"
    COMPONENTS=""
    COMPOSE_OVERLAYS="docker-compose.no-executor.yml"
    for t in executor-node executor-python admin-api; do
        if component_enabled "$t"; then echo "$t=enabled"; else echo "$t=disabled"; fi
    done
' 2>&1)"
assert_contains "no-executor 覆盖层 → 本机 executor-node 视为未启用" "executor-node=disabled" "$wb_out"
assert_contains "no-executor 覆盖层 → 本机 executor-python 视为未启用" "executor-python=disabled" "$wb_out"
assert_contains "no-executor 覆盖层不影响 admin-api" "admin-api=enabled" "$wb_out"

# 反向：不带该覆盖层时执行器仍视为启用（默认行为零变化）
wb_out="$(bash -c '
    '"$(sed -n '/^executors_excluded_by_overlay()/,/^}/p' "$DEPLOY")"'
    '"$(sed -n '/^component_enabled()/,/^}/p' "$DEPLOY")"'
    '"$(sed -n '/^resolve_components()/,/^}/p' "$DEPLOY")"'
    NODE_COMPONENTS="admin-api admin-web executor-node"
    PYTHON_COMPONENTS="executor-python"
    COMPONENTS=""
    COMPOSE_OVERLAYS="docker-compose.local.yml"
    for t in executor-node executor-python; do
        if component_enabled "$t"; then echo "$t=enabled"; else echo "$t=disabled"; fi
    done
' 2>&1)"
assert_contains "不叠 no-executor 时 executor-node 仍启用（默认零变化）" "executor-node=enabled" "$wb_out"
assert_contains "不叠 no-executor 时 executor-python 仍启用（默认零变化）" "executor-python=enabled" "$wb_out"

# 15g：--help 必须列出两个新参数（否则等于没人知道它们存在）
out="$(bash "$DEPLOY" --help 2>&1 || true)"
assert_contains "--help 列出 --project" "--project" "$out"
assert_contains "--help 列出 --overlay" "--overlay" "$out"

# ── 汇总 ───────────────────────────────────────────────────────────
printf '\n=== 结果: %d 通过, %d 失败 ===\n\n' "$PASSES" "$FAILURES"
[ "$FAILURES" -eq 0 ] || exit 1
