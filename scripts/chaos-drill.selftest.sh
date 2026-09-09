#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# chaos-drill.sh 纯函数自检 + bash -n 语法检查
#
# 本机无 docker、无法真跑注入演练——验收路径为：
#   1) bash -n 语法检查（drill 与 selftest 自身）
#   2) 以 CHAOS_DRILL_LIBRARY=1 source scripts/chaos-drill.sh（只暴露纯函数、
#      不执行 main），对 场景名解析 / 断言窗口计算 / 日志路径生成 /
#      JSON 取值助手 逐个断言
#
# 用法：bash scripts/chaos-drill.selftest.sh     # 全部通过 rc0，否则 rc1
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail
cd "$(dirname "$0")/.."

DRILL=scripts/chaos-drill.sh
pass=0
fail=0

ok()  { printf '  ok    %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail + 1)); }

assert_eq() { # <got> <want> <label>
  if [[ "$1" == "$2" ]]; then ok "$3"; else bad "$3（got=[$1] want=[$2]）"; fi
}
assert_rc() { # <期望rc:0|非0> <命令...>  —— 对 rc 只判零/非零
  local want="$1"; shift
  if [[ "$want" == "0" ]]; then
    if "$@" >/dev/null 2>&1; then ok "rc0: $*"; else bad "rc0: $*"; fi
  else
    if "$@" >/dev/null 2>&1; then bad "rc非0: $*"; else ok "rc非0: $*"; fi
  fi
}

# library 模式子壳：source drill（不执行 main）后 eval 片段
lib() { CHAOS_DRILL_LIBRARY=1 bash -c 'set -euo pipefail; source "$0"; eval "$1"' "$DRILL" "$1"; }

echo "== 0) library 模式 source 到本进程（供直调纯函数）=="
export CHAOS_DRILL_LIBRARY=1
source "$DRILL"
unset CHAOS_DRILL_LIBRARY

echo "== 1) bash -n 语法 =="
if bash -n "$DRILL" 2>&1; then ok "bash -n $DRILL"; else bad "bash -n $DRILL"; fi
if bash -n scripts/chaos-drill.selftest.sh 2>&1; then
  ok "bash -n scripts/chaos-drill.selftest.sh"
else
  bad "bash -n scripts/chaos-drill.selftest.sh"
fi

echo "== 2) chaos_normalize_scenarios 场景名解析 =="
assert_eq "$(lib 'v="$(chaos_normalize_scenarios A)"; printf %s "$v"')" "a" "单场景大写 A → a"
assert_eq "$(lib 'v="$(chaos_normalize_scenarios "a,b")"; printf %s "$v"')" "a b" "逗号组合 a,b → a b"
assert_eq "$(lib 'v="$(chaos_normalize_scenarios "B, A")"; printf %s "$v"')" "b a" "空格剔除并保序 B, A → b a"
assert_eq "$(lib 'v="$(chaos_normalize_scenarios all)"; printf %s "$v"')" "a b c d" "all 展开 → a b c d"
assert_eq "$(chaos_normalize_scenarios "a,b,a,all")" "a b c d" "混合+all 去重（保序首现）→ a b c d"
assert_eq "$(chaos_normalize_scenarios "d,c,b,a")" "d c b a" "逆序输入保序 → d c b a"
assert_eq "$(lib 'v="$(chaos_normalize_scenarios "a,a,b")"; printf %s "$v"')" "a b" "重复场景去重 a,a,b → a b"
assert_eq "$(lib 'v="$(chaos_normalize_scenarios "")"; printf %s "$v"')" "a b c d" "空串按缺参语义 → all"
lib 'chaos_normalize_scenarios x >/dev/null' \
  && bad "非法场景 x 应 rc=1" || ok "非法场景 x rc=1"
lib 'chaos_normalize_scenarios "a,x" >/dev/null' \
  && bad "混合非法 a,x 应 rc=1" || ok "混合非法 a,x rc=1"

echo "== 3) chaos_log_path 日志路径生成 =="
assert_eq "$(chaos_log_path /tmp/x a 2>/dev/null || true)" "/tmp/x/scenario-a.log" "常规路径"
assert_eq "$(chaos_log_path /tmp/x B 2>/dev/null || true)" "/tmp/x/scenario-b.log" "大写字母归一"
assert_eq "$(chaos_log_path "/tmp/x/" "c" 2>/dev/null || true)" "/tmp/x/scenario-c.log" "尾斜杠归一"
chaos_log_path /tmp/x e >/dev/null 2>&1 \
  && bad "非法场景字母 e 应 rc=1" || ok "非法场景字母 e rc=1"

echo "== 4) 断言窗口计算 =="
assert_eq "$(chaos_offline_poll_budget 150 90 30 30)" "150" "长断网预算=阈值+扫描+缓冲"
assert_eq "$(chaos_offline_poll_budget 90 90 30 30)" "150" "恰好等于阈值视为足够"
assert_eq "$(chaos_offline_poll_budget 89 90 30 30)" "0" "阈值内短断网预算=0"
assert_eq "$(chaos_offline_poll_budget 30 90 30 30)" "0" "30s 断网预算=0（反向断言分支）"
chaos_pause_is_long_enough 150 90 && ok "150s≥90s 判足够" || bad "150s≥90s 判足够"
chaos_pause_is_long_enough 30 90 && bad "30s<90s 应判不足" || ok "30s<90s 判不足"
assert_eq "$(chaos_leader_takeover_budget 30000 15000 15000)" "60" "Leader 接管窗口=TTL+retry+缓冲"
assert_eq "$(chaos_leader_takeover_budget 29999 15000 15000)" "60" "毫秒向上取整"
assert_eq "$(chaos_leader_takeover_budget 1000 0 0)" "1" "最小窗口向上取整=1s"

echo "== 5) JSON 取值助手（无 jq 依赖）=="
assert_eq "$(chaos_extract_json_int '{"queueSize":0,"onlineExecutors":1}' queueSize)" "0" "零值可提取"
assert_eq "$(chaos_extract_json_int '{"a":12,"queueSize":7}' queueSize)" "7" "多键定位"
assert_eq "$(chaos_extract_json_int '"queueSize": 42' queueSize)" "42" "容忍冒号后空格"
assert_eq "$(chaos_extract_json_int '{"other":1}' queueSize)" "" "缺失键输出空串"
chaos_json_has '{"status":"healthy"}' '"status":"healthy"' \
  && ok "json_has 命中" || bad "json_has 命中"
chaos_json_has '{"status":"unhealthy"}' '"status":"healthy"' \
  && bad "json_has 未命中应 rc=1" || ok "json_has 未命中 rc=1"

echo "== 6) library 模式隔离（source 不产生副作用执行）=="
out="$(CHAOS_DRILL_LIBRARY=1 bash -c 'set -euo pipefail; src_out="$(source scripts/chaos-drill.sh)"; printf %s "$src_out"')"
assert_eq "$out" "" "library 模式 source 无输出（main 被跳过）"
out="$(CHAOS_DRILL_LIBRARY=1 bash -c 'set -euo pipefail; source scripts/chaos-drill.sh >/dev/null 2>&1; type -t main')"
assert_eq "$out" "function" "library 模式下 main 仅定义不执行"

echo ""
if (( fail == 0 )); then
  echo "✓ chaos-drill 自检全部通过（$pass 例）"
  exit 0
fi
echo "✗ chaos-drill 自检失败 $fail / $pass 例" >&2
exit 1
