#!/bin/bash
#
# Static self-check for the demo tooling. No Docker required, safe for CI.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() { echo "✗ $1" >&2; exit 1; }
pass() { echo "✓ $1"; }

bash -n scripts/demo.sh || fail "scripts/demo.sh syntax"
bash -n scripts/reset-admin-password.sh || fail "scripts/reset-admin-password.sh syntax"
bash -n scripts/demo-desktop-gui.sh || fail "scripts/demo-desktop-gui.sh syntax"
bash -n scripts/demo-desktop-agent.sh || fail "scripts/demo-desktop-agent.sh syntax"
bash -n scripts/demo-desktop-agent-diagnose.sh || fail "scripts/demo-desktop-agent-diagnose.sh syntax"
node --check scripts/demo-headless-agent.mjs || fail "scripts/demo-headless-agent.mjs syntax"
node --check scripts/demo-ops-agent.mjs || fail "scripts/demo-ops-agent.mjs syntax"

# ── R463：独立语法检查 demo.sh 内联 verify NODE 脚本 ───────────────────
# 这段内联脚本是 ESM（含 top-level await），只在真跑 demo 时才被 node 解析；
# 一个语法错要等完整 build+seed（几分钟）之后才炸。这里用 awk 抽出同一段
# heredoc 源码写成 .mjs 临时文件，单独 node --check 提前拦住。
# 关键反假绿：提取为空必须 fail —— demo.sh 结构变了 / heredoc 标记改了时，
# 空文件会让 node --check 通过，形成「什么都验不到却全绿」的伪通过。
VERIFY_MJS="$(mktemp "${TMPDIR:-/tmp}/acf-demo-verify.XXXXXX.mjs")"
# R460/R461 的三承诺锚点要 grep 同一份脚本的「去注释」副本。路径先声明，和
# VERIFY_MJS 一起挂在 EXIT 清理链上（trap 到退出才展开，set -u 下也已存在）。
VERIFY_CODE="${VERIFY_MJS%.mjs}.code"
trap 'rm -f "$VERIFY_MJS" "$VERIFY_CODE"' EXIT
awk '/node --input-type=module <<.NODE./{f=1;next} /^NODE$/{f=0} f' scripts/demo.sh >"$VERIFY_MJS"
VERIFY_LINES="$(wc -l <"$VERIFY_MJS")"
[[ -s "$VERIFY_MJS" ]] || fail "提取不到 demo.sh 内联 verify NODE 脚本（heredoc 标记变了？空文件会造成语法检查假绿）"
node --check "$VERIFY_MJS" || fail "scripts/demo.sh 内联 verify NODE 脚本语法错误（ESM node --check 失败）"
pass "scripts/demo.sh 内联 verify NODE 脚本语法检查通过（$VERIFY_LINES 行，ESM）"
# 去掉整行 // 与 * 注释（含块注释引导行）。R460/R461 的字面串必须存在于可执行
# 代码：demo.sh:477 的注释就含 "demo intentional failure"，扫全文会假绿。
grep -vE '^[[:space:]]*(//|\*|/\*)' "$VERIFY_MJS" >"$VERIFY_CODE" || true
[[ -s "$VERIFY_CODE" ]] || fail "去注释后 verify 脚本为空——R460/R461 锚点检查失去意义"
rm -f "$VERIFY_MJS"

# ── 预检门（node ≥18 / curl）：从 demo.sh 抽出同一份函数单独跑 ──────────
# 真栈要 Docker，CI 跑不了 ./scripts/demo.sh，于是「预检到底门不门得住」
# 长期只能靠人读代码。这里用 sed 取 demo.sh 里的函数源码，再用 stub PATH
# 造出「node 太旧」「缺 curl」两种机器。
GATE_SRC="$(sed -n '/^require_node_and_curl() {/,/^}/p' scripts/demo.sh)"
[[ -n "$GATE_SRC" ]] || fail "demo.sh 没有 require_node_and_curl（node/curl 预检）"

STUB="$(mktemp -d "${TMPDIR:-/tmp}/acf-demo-gate.XXXXXX")"
# 覆盖上面的 EXIT trap 时把 R460/R461 用的去注释副本一并带上，别漏清理。
trap 'rm -rf "$STUB"; rm -f "$VERIFY_CODE"' EXIT
mkdir -p "$STUB/old/bin" "$STUB/new/bin" "$STUB/nocurl/bin"
# stub 的解释器写绝对路径、下面刻意把 PATH 收窄成 stub 目录：系统 PATH 里一直
# 有 curl，「缺 curl」这一态就永远复现不了。
BASH_BIN="$(command -v bash)"
cat >"$STUB/old/bin/node" <<'STUB_OLD'
#!/bin/bash
case "$1" in
  -e) printf '16' ;;
  -v) printf 'v16.20.2\n' ;;
esac
STUB_OLD
cat >"$STUB/new/bin/node" <<'STUB_NEW'
#!/bin/bash
case "$1" in
  -e) printf '24' ;;
  -v) printf 'v24.0.0\n' ;;
esac
STUB_NEW
cat >"$STUB/new/bin/curl" <<'STUB_CURL'
#!/bin/bash
exit 0
STUB_CURL
chmod +x "$STUB/old/bin/node" "$STUB/new/bin/node" "$STUB/new/bin/curl"
# 新 node 但没有 curl 的第三种机器：只放 node，不放 curl。
cp "$STUB/new/bin/node" "$STUB/nocurl/bin/node"
{ printf '%s\n' "$GATE_SRC"; printf 'require_node_and_curl\n'; } >"$STUB/gate.sh"

# ① node 16（有全局 fetch 之前）→ 拒绝，并给出可执行的修复动作
if out="$(PATH="$STUB/old/bin" "$BASH_BIN" "$STUB/gate.sh" 2>&1)"; then
  fail "node 16 未被预检拒绝（verify 段会以裸 ReferenceError 收场）"
fi
grep -q 'too old' <<<"$out" || fail "node 版本门没说明「太旧」：$out"
grep -q 'nvm install 24' <<<"$out" || fail "node 版本门没给可执行修复动作：$out"
pass "node < 18 被预检拒绝并给出修复动作"

# ② node 24 但没有 curl → 拒绝，并指名 curl（否则只会看到「did not become ready」）
if out="$(PATH="$STUB/nocurl/bin" "$BASH_BIN" "$STUB/gate.sh" 2>&1)"; then
  fail "缺 curl 未被预检拒绝"
fi
grep -q 'curl not found' <<<"$out" || fail "缺 curl 时没有明确报错：$out"
pass "缺 curl 被预检拒绝"

# ③ node 24 + curl → 放行（反证：门不是一律拒绝）
PATH="$STUB/new/bin" "$BASH_BIN" "$STUB/gate.sh" >/dev/null 2>&1 \
  || fail "node ≥18 + curl 被预检误拒"
pass "node ≥18 + curl 放行"

# ── seed 计数契约：demo.sh 不得再写死「3 tasks + 3 SOPs」───────────────
grep -q 'ACF_SEED_SUMMARY' scripts/demo-seed.mjs || fail "demo-seed.mjs 不再打印 ACF_SEED_SUMMARY"
grep -q 'ACF_SEED_SUMMARY' scripts/demo.sh || fail "demo.sh 未解析 ACF_SEED_SUMMARY"
if grep -q '3 demo tasks + 3 demo SOPs were seeded' scripts/demo.sh; then
  fail "demo.sh 收尾仍写死「3 demo tasks + 3 demo SOPs were seeded」"
fi
pass "seed 计数走 ACF_SEED_SUMMARY（收尾不再写死条数）"

SEED_STAT_SRC="$(sed -n '/^seed_stat() {/,/^}/p' scripts/demo.sh)"
[[ -n "$SEED_STAT_SRC" ]] || fail "demo.sh 没有 seed_stat 解析函数"
SEED_LOG="$STUB/seed.log"
printf '%s\n' 'ACF_SEED_SUMMARY {"tasks":3,"tasksFailed":0,"expectedTasks":3,"sops":2,"sopFailed":1,"sopSkipped":0,"expectedSops":3}' >"$SEED_LOG"
{ printf '%s\n' "$SEED_STAT_SRC";
  printf '%s\n' 'printf "%s/%s/%s/%s" "$(seed_stat tasks)" "$(seed_stat sops)" "$(seed_stat sopFailed)" "$(seed_stat expectedSops)"';
} >"$STUB/seed-stat.sh"
got="$(SEED_LOG="$SEED_LOG" bash "$STUB/seed-stat.sh")"
[[ "$got" == "3/2/1/3" ]] \
  || fail "seed_stat 解析错误：得到 '$got'（期望 3/2/1/3；tasks 不得误匹配 tasksFailed）"
pass "seed 计数解析（tasks≠tasksFailed，失败数如实取出）"

# ── desktop demo 三脚本：必须先判 tsc 依赖，不许走 npx 联网 ─────────────
for f in scripts/demo-desktop-gui.sh scripts/demo-desktop-agent.sh scripts/demo-desktop-agent-diagnose.sh; do
  grep -q 'apps/executor-desktop/node_modules/typescript' "$f" \
    || fail "$f 没有预检 apps/executor-desktop/node_modules/typescript（干净克隆必走 npx 联网拉 tsc）"
  grep -q 'npm --prefix apps/executor-desktop install' "$f" \
    || fail "$f 依赖缺失时没有给出修复命令"
  if grep -q 'npx tsc -p tsconfig.selftest.json' "$f"; then
    fail "$f 仍用 npx 构建 dist-selftest（依赖缺失时会联网下载）"
  fi
done
pass "desktop demo 三脚本预检 tsc 依赖并给修复命令"

HELP="$(./scripts/demo.sh --help)"
grep -q 'One-command demo for AutoCodeFlow' <<<"$HELP" || fail "demo --help is missing the description"
grep -q -- '--reset' <<<"$HELP" || fail "demo --help is missing --reset"
grep -q -- '--build' <<<"$HELP" || fail "demo --help is missing --build"
pass "demo --help documents the supported flags"

# The demo compose override must keep the UI off :80 and replace .env with
# .env.demo. These are the two properties that make the demo safe to run next
# to an existing deployment.
grep -q 'ACF_DEMO_WEB_PORT' docker-compose.demo.yml || fail "demo compose has no configurable web port"
grep -q 'env_file: !override' docker-compose.demo.yml || fail "demo compose does not isolate env_file"
grep -q '.env.demo' .gitignore || fail ".env.demo is not gitignored"
pass "demo compose isolates ports/env and .env.demo is ignored"

# P1-1（生产报告 2026-10-22）：compose 把每个执行器的对外地址改成 ${VAR:?} 必填。
# demo 生成的 .env.demo 必须带这两键，并且复用旧文件时要能就地补齐 —— 否则
# 「10 分钟首个成功」的第一步就死在插值错误上（本守卫是那次回归的钉子）。
grep -q 'EXECUTOR_NODE_PUBLIC_ADDRESS=executor-node:8002' scripts/demo.sh \
  || fail "demo.sh does not emit EXECUTOR_NODE_PUBLIC_ADDRESS"
grep -q 'EXECUTOR_PYTHON_PUBLIC_ADDRESS=executor-python:8001' scripts/demo.sh \
  || fail "demo.sh does not emit EXECUTOR_PYTHON_PUBLIC_ADDRESS"
grep -q 'ensure_env_key EXECUTOR_NODE_PUBLIC_ADDRESS' scripts/demo.sh \
  || fail "demo.sh does not backfill EXECUTOR_NODE_PUBLIC_ADDRESS for old .env.demo"
grep -q 'ensure_env_key EXECUTOR_PYTHON_PUBLIC_ADDRESS' scripts/demo.sh \
  || fail "demo.sh does not backfill EXECUTOR_PYTHON_PUBLIC_ADDRESS for old .env.demo"
pass "demo .env.demo covers the required per-executor public addresses"

# 通用回归：compose 里每个 ${VAR:?} 必填项，demo 生成的 .env.demo 都必须给值。
# 只钉两个变量名不如钉住这条规则——P1-1 就是这么把 demo 第一步弄挂的。
REQUIRED_VARS="$(sed 's/#.*//' docker-compose.yml | grep -oE '\$\{[A-Z_]+:\?' | sed 's/\${//;s/:?//' | sort -u)"
while read -r v; do
  [[ -z "$v" ]] && continue
  grep -qE "^$v=" scripts/demo.sh || fail "demo.sh does not provide required compose variable $v"
done <<<"$REQUIRED_VARS"
pass "demo .env.demo covers every required compose variable"

# ── R461：demo verify 必须验证「零代码从模板运行」路径 ──────────────────
# 产品第三句承诺的引导语「use template → run it」此前无任何演示数据支撑。
# R461 让 verify 用官方 webhook_ping 模板 instantiate → 触发 → success。
# R473（P2-3）：锚点只在 R463 抽出的**去注释可执行代码**里找；注释里出现相同字面串
# 不算绿（demo.sh:477 就有一条含 "demo intentional failure" 的注释曾造成假绿）。
# 每个锚点还必须有配套 throw new Error —— 断言无牙就是死代码。
assert_anchor() {
  local anchor="$1" teeth="$2" what="$3"
  grep -qF -- "$anchor" "$VERIFY_CODE" \
    || fail "${what}：去注释后的 verify 代码里找不到「${anchor}」（断言被删或移进注释？）"
  grep -qF -- "$teeth" "$VERIFY_CODE" \
    || fail "${what}：找不到配套的 throw new Error 断言「${teeth}」（锚点可能是死代码）"
}
assert_anchor 'task-templates' 'throw new Error("官方模板 webhook_ping 不存在' \
  "demo.sh verify 未访问模板端点（模板引导死路）"
assert_anchor '/instantiate' 'throw new Error("模板 instantiate 未返回任务 id' \
  "demo.sh verify 未实例化模板"
assert_anchor '零代码路径可用' 'throw new Error(`模板实例化的任务未成功' \
  "demo.sh verify 未确认模板任务运行成功"
pass "demo verify checks zero-code template path (instantiate → run → success)"

# ── R460：demo verify 必须验证「失败可诊断」而不只是 success ────────────
# 产品承诺后半句是「愿意把第二件事交给它」——失败要能诊断。R460 之前 verify
# 只验 demo-hello-fixed success，从不验 demo-fragile 的失败样本是否可解释。
# 同样只认去注释代码里的锚点 + 配套 throw，注释里的字面串不再算绿。
assert_anchor 'failureReason' 'throw new Error(`失败样本缺少有效 failureReason' \
  "demo.sh verify 未断言 failureReason（失败可诊断缺口）"
assert_anchor 'demo intentional failure' 'throw new Error(`失败样本日志缺原始错误' \
  "demo.sh verify 未断言日志含原始错误"
assert_anchor '/executions/${bad.executionId}/logs' 'throw new Error(`失败样本日志缺原始错误' \
  "demo.sh verify 未读日志端点（原始错误在 logs 不在 errorMessage）"
pass "demo verify checks failure diagnosis (failureReason + logs原始错误)"
rm -f "$VERIFY_CODE"

# ── R458：未加引号 heredoc 的注释里禁止反引号 ──────────────────────────
# demo.sh 的 .env.demo 用未加引号的 <<EOF 生成（需要 $var 展开生成密钥）。
# 未加引号的 heredoc 里反引号会触发命令替换——曾有一条注释写
#   `--profile rustfs`，shell 尝试执行 "profile rustfs"，报 --profile: 未找到命令。
# 注释不该有副作用；这条守卫提取 <<EOF 区段的注释行，禁止出现反引号。
HEREDOC_COMMENTS="$(sed -n '/<<EOF$/,/^EOF$/p' scripts/demo.sh | grep '^\s*#' || true)"
if grep -q '`' <<<"$HEREDOC_COMMENTS"; then
  fail "demo.sh 的 <<EOF heredoc 注释含反引号——会触发命令替换（见 R458）"
fi
pass "demo .env.demo heredoc comments contain no backticks (no command substitution)"

bash scripts/reset-admin-password.selftest.sh

echo "demo selftest: all checks passed"
