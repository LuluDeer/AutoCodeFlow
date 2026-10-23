#!/usr/bin/env bash
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

bash scripts/reset-admin-password.selftest.sh

echo "demo selftest: all checks passed"
