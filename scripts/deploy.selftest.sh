#!/usr/bin/env bash
#
# deploy.sh 自检 —— 纯逻辑回归（不改系统、不起服务、不写 .env）
#
# 为什么需要它：deploy.sh 是本仓唯一会**改动生产主机**的脚本（写 systemd unit、
# 同步源码到 /opt、动数据库）。这类脚本的 bug 代价极高，但传统单测无从下手。
# 本自检走「只测纯判定逻辑 + dry-run 路径」的路线：
#   · 参数解析与校验（非法值必须拒绝，且不能静默回落）
#   · doctor --json 的结构契约（中台 Agent 消费它）
#   · 封闭枚举（restart 不接受任意服务名）
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

# ── 5. 封闭枚举（restart 不接受任意服务名）───────────────────────
printf '\n── 5. 封闭枚举 ──\n'
out="$(bash "$DEPLOY" restart evil-service 2>&1)"
assert_contains "restart 拒绝任意服务名" "未知组件" "$out"
out="$(bash "$DEPLOY" restart ../../etc/passwd 2>&1)"
assert_contains "restart 拒绝路径穿越" "未知组件" "$out"
out="$(bash "$DEPLOY" restart 2>&1)"
assert_contains "restart 缺参数给用法" "用法" "$out"

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
} > "$tmp_dir/.env"

out="$(cd "$tmp_dir" && bash ./deploy.sh --env production --i-know-its-production --skip-preflight --dry-run 2>&1 || true)"
if printf '%s' "$out" | grep -qF "生产配置校验通过"; then
    pass "合规配置通过生产校验"
else
    fail "合规配置未通过生产校验（实际: $(printf '%s' "$out" | grep -F '校验' | head -c 200)）"
fi

# CORS 含 localhost 必须被拒
sed -i 's|^CORS_ORIGINS=.*|CORS_ORIGINS=http://localhost|' "$tmp_dir/.env"
out="$(cd "$tmp_dir" && bash ./deploy.sh --env production --i-know-its-production --skip-preflight --dry-run 2>&1 || true)"
assert_contains "CORS 含 localhost 被拒" "不得含 localhost" "$out"

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

# ── 汇总 ───────────────────────────────────────────────────────────
printf '\n=== 结果: %d 通过, %d 失败 ===\n\n' "$PASSES" "$FAILURES"
[ "$FAILURES" -eq 0 ] || exit 1
