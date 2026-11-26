#!/usr/bin/env bash
#
# verify-e2e-migration-readiness.selftest.sh —— 守卫的「有牙」自检（外壳范式照抄
# scripts/verify-smoke-selftest.sh / check-shell-multibyte-var 的自检纪律）。
#
# 不连真库：用一个假 pg stub（临时目录、600 权限、trap 删）替掉 node 的 pg 驱动，
# 再用可控的 ACF_E2E_MIG_CODE_COUNT 固定代码迁移数，跑**真守卫子进程**，逐例断言
# 退出码 + 关键文本（不是只测函数，避免「函数绿、CLI 红」漏检）。
#
# 用例：
#   ① 台账数 == 代码数 ⇒ exit 0 + 就绪文案
#   ② 台账少一个 ⇒ exit 1 + 点名库名 / 两个数字 / 处置命令
#   ③ 台账多一个 ⇒ exit 1 + 点名（双向差异都红，不是只会单向）
#   ④ DB 连不上 ⇒ 非 0 + 可读报错，且不出现栈帧（非 stack trace）
#
# 用法：bash scripts/verify-e2e-migration-readiness.selftest.sh
# 退出码：0 = 全部通过；非 0 = 有失败项。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"
GUARD="${ROOT}/scripts/verify-e2e-migration-readiness.sh"

TMP="$(mktemp -d 2>/dev/null || echo "/tmp/acf-e2e-mig-selftest-$$")"
mkdir -p "${TMP}"
trap 'rm -rf "${TMP}"' EXIT

# 假 pg：Client.connect/query/end 三方法，query 只认 SELECT ... FROM migrations。
STUB="${TMP}/fake-pg.cjs"
cat > "${STUB}" <<'STUB'
const count = Number(process.env.ACF_FAKE_PG_COUNT || 0);
const fail = process.env.ACF_FAKE_PG_FAIL === "1";
class Client {
  async connect() {
    if (fail) throw new Error("connect ECONNREFUSED 127.0.0.1:5432 (fake stub)");
  }
  async query(sql) {
    if (!/FROM migrations/i.test(sql)) throw new Error("unexpected SQL: " + sql);
    return { rows: [{ n: count }] };
  }
  async end() {}
}
module.exports = { Client };
STUB
chmod 600 "${STUB}"

PASS=0; FAIL=0
ok()  { printf '  ✓ %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  ✗ %s\n' "$*"; FAIL=$((FAIL+1)); }
step(){ printf '\n=== %s ===\n' "$*"; }

# $1 = 日志路径；其余由调用方的 FAKE_COUNT / CODE / DBNAME / FAKE_FAIL 注入。
run_guard() {
  ACF_E2E_MIG_PG_STUB="${STUB}" \
  ACF_FAKE_PG_COUNT="${FAKE_COUNT}" \
  ACF_FAKE_PG_FAIL="${FAKE_FAIL:-0}" \
  ACF_E2E_MIG_CODE_COUNT="${CODE}" \
  DB_DATABASE="${DBNAME}" \
    bash "${GUARD}" >"$1" 2>&1
}

# ── ① 相等 ⇒ 0 ─────────────────────────────────────────────────────────────
step "1. 台账数 == 代码数 ⇒ exit 0 + 就绪文案"
FAKE_COUNT=3; CODE=3; DBNAME="autoflow_test"; FAKE_FAIL=0
LOG="${TMP}/case-equal.log"
if run_guard "${LOG}"; then rc=0; else rc=$?; fi
if [[ "${rc}" -eq 0 ]] && grep -q '两数一致，可安全跑 e2e' "${LOG}"; then
  ok "相等 ⇒ exit 0，且打印就绪文案"
else
  bad "相等用例失败：rc=${rc}"
  sed 's/^/    | /' "${LOG}"
fi

# ── ② 少一个 ⇒ 1 且点名 ────────────────────────────────────────────────────
step "2. 台账少一个 ⇒ exit 1 + 点名库名 / 两数 / 处置命令"
FAKE_COUNT=2; CODE=3; DBNAME="autoflow_stale"; FAKE_FAIL=0
LOG="${TMP}/case-behind.log"
if run_guard "${LOG}"; then rc=0; else rc=$?; fi
if [[ "${rc}" -eq 1 ]] \
  && grep -q 'autoflow_stale' "${LOG}" \
  && grep -q '台账 2 行' "${LOG}" \
  && grep -q '代码迁移 3 个' "${LOG}" \
  && grep -q 'npm run migration:run' "${LOG}"; then
  ok "少一个 ⇒ exit 1，点名库名 / 台账 2 行 / 代码 3 个 / 处置命令"
else
  bad "少一个用例失败：rc=${rc}"
  sed 's/^/    | /' "${LOG}"
fi

# ── ③ 多一个 ⇒ 1（双向差异都红）────────────────────────────────────────────
step "3. 台账多一个 ⇒ exit 1（不是只会单向报红）"
FAKE_COUNT=4; CODE=3; DBNAME="autoflow_test"; FAKE_FAIL=0
LOG="${TMP}/case-ahead.log"
if run_guard "${LOG}"; then rc=0; else rc=$?; fi
if [[ "${rc}" -eq 1 ]] && grep -q '台账 4 行' "${LOG}" && grep -q '代码迁移 3 个' "${LOG}"; then
  ok "多一个 ⇒ exit 1，且点名台账 4 行 / 代码 3 个"
else
  bad "多一个用例失败：rc=${rc}"
  sed 's/^/    | /' "${LOG}"
fi

# ── ④ DB 连不上 ⇒ 可读报错非栈 ─────────────────────────────────────────────
step "4. DB 连不上 ⇒ 非 0 + 可读报错（无栈帧）"
FAKE_COUNT=0; CODE=3; DBNAME="autoflow_test"; FAKE_FAIL=1
LOG="${TMP}/case-unreachable.log"
if run_guard "${LOG}"; then rc=0; else rc=$?; fi
if [[ "${rc}" -ne 0 ]] \
  && grep -q 'DB_QUERY_ERROR' "${LOG}" \
  && grep -q '读取 e2e 目标库' "${LOG}" \
  && ! grep -q '    at ' "${LOG}" \
  && ! grep -q '^Error:' "${LOG}"; then
  ok "DB 连不上 ⇒ exit=${rc}，报错可读且无栈帧"
else
  bad "DB 连不上用例失败：rc=${rc}"
  sed 's/^/    | /' "${LOG}"
fi

printf '\n=== 自检汇总：PASS=%d FAIL=%d ===\n' "${PASS}" "${FAIL}"
[[ "${FAIL}" -eq 0 ]] || exit 1
exit 0
