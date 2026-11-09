#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# scripts/probe-acf-tunnel.sh — 跨网入口外部哨兵（frp/gost 通用）
#
# 为什么需要它（2026-11-03 的教训）：
#   frp 时代的隧道会「进程活着、隧道已死」——客户端日志一片正常（control
#   连接有心跳，数据面没有），只有从**外部**访问才会撞到 489 字节的 frp 内置
#   404 页。那次故障因此拖了 3 天没人发现。
#   gost 同样没有 dashboard（只有 Prometheus 指标），静默失效只能靠外部探测。
#
# 这个脚本做什么：
#   从**外部**（公网）探测业务入口，连续 N 次失败才判定隧道异常并自愈。
#
# 三层探测信号（关键设计，见下）：
#   L1 HTTPS 公网入口   → 隧道 + 网络 + 应用，全都健康才算通
#   L2 TCP  到 VPS 端口 → 只说明「网络能到 VPS」，与隧道死活无关
#   L3 HTTP  本地应用   → 只说明「应用本身活着」，与隧道死活无关
#
#   ⚠ 只在「L1 失败 且 L2 通 且 L3 通」时才动手重启 gost 客户端。
#      这样能区分三种情况，避免误重启：
#        L1 挂 + L2 通 + L3 通 → 隧道断了   → **该重启**
#        L1 挂 + L2 不通         → 网络/VPS 挂了 → 重启没用，别动
#        L1 挂 + L3 不通         → 应用挂了   → 重启没用，别动
#
# 用法：
#   bash scripts/probe-acf-tunnel.sh              # 探一次（cron 用）
#   bash scripts/probe-acf-tunnel.sh --once       # 同上
#   bash scripts/probe-acf-tunnel.sh --verbose    # 打印每层探测细节
#
# 环境变量（都有合理默认值）：
#   ACF_PUBLIC_URL     公网入口（默认 https://<ACF_DOMAIN>/health）
#   ACF_DOMAIN         域名（默认从根 .env 的 GOST_DOMAIN/FRP_DOMAIN 读）
#   ACF_VPS_ADDR       VPS 地址（默认从 .env 的 GOST_SERVER_ADDR/FRP_SERVER_ADDR 读）
#   ACF_VPS_PORT       VPS 隧道端口（默认 GOST_SERVER_PORT/FRP_SERVER_PORT）
#   ACF_LOCAL_HEALTH   本机应用健康端点（默认 http://127.0.0.1:8088/health）
#   ACF_GOST_CONTAINER gost 客户端容器名（默认 acf-gost-1）
#   ACF_PROBE_TIMEOUT  单次探测超时秒数（默认 15）
#   ACF_FAIL_THRESHOLD 连续失败多少次才动手（默认 3）
#   ACF_STATE_FILE     状态文件（默认 /tmp/acf-tunnel-probe.state）
#
# 退出码：0 = 通（或已成功自愈）；1 = 隧道异常且未自愈；2 = 配置缺失
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERBOSE=0
[[ "${1:-}" == "--verbose" ]] && VERBOSE=1

TIMEOUT="${ACF_PROBE_TIMEOUT:-15}"
THRESHOLD="${ACF_FAIL_THRESHOLD:-3}"
STATE_FILE="${ACF_STATE_FILE:-/tmp/acf-tunnel-probe.state}"
LOG_FILE="${ACF_PROBE_LOG:-/tmp/acf-tunnel-probe.log}"

log() { echo "[$(date '+%F %T')] $*"; }
vlog() { (( VERBOSE )) && log "$@"; return 0; }

# ── 读 .env（不 source，避免执行里面的东西）────────────────────────────
env_get() {
  local key="$1" file="${2:-$ROOT/.env}" val
  [[ -f "$file" ]] || return 0
  val="$(grep -E "^${key}=" "$file" 2>/dev/null | tail -n1 | cut -d= -f2-)"
  printf '%s' "$val"
}

DOMAIN="${ACF_DOMAIN:-$(env_get GOST_DOMAIN)}"
DOMAIN="${DOMAIN:-$(env_get FRP_DOMAIN)}"
PUBLIC_URL="${ACF_PUBLIC_URL:-https://${DOMAIN}/health}"
VPS_ADDR="${ACF_VPS_ADDR:-$(env_get GOST_SERVER_ADDR)}"
VPS_ADDR="${VPS_ADDR:-$(env_get FRP_SERVER_ADDR)}"
VPS_PORT="${ACF_VPS_PORT:-$(env_get GOST_SERVER_PORT)}"
VPS_PORT="${VPS_PORT:-$(env_get FRP_SERVER_PORT)}"
LOCAL_HEALTH="${ACF_LOCAL_HEALTH:-http://127.0.0.1:8088/health}"
GOST_CONTAINER="${ACF_GOST_CONTAINER:-acf-gost-1}"

if [[ -z "$PUBLIC_URL" || -z "$DOMAIN" ]]; then
  log "✘ 配置缺失：无法确定公网入口（ACF_PUBLIC_URL / ACF_DOMAIN / .env）"
  exit 2
fi

# ── 三层探测 ───────────────────────────────────────────────────────────
# 注意 --noproxy '*'：本机常设 http_proxy，不绕过的话测的是本地代理
# 而不是真实公网链路（2026-11-03 实测本机 http_proxy=127.0.0.1:7897）。
probe_public() {
  curl -sS --noproxy '*' -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$PUBLIC_URL" 2>/dev/null || true
}

probe_vps_tcp() {
  # TCP 层：只说明网络能到 VPS。用 timeout 包裹 /dev/tcp 避免挂死。
  timeout "$TIMEOUT" bash -c "cat < /dev/null > /dev/tcp/${VPS_ADDR}/${VPS_PORT}" 2>/dev/null
}

probe_local_app() {
  curl -sS --noproxy '*' -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$LOCAL_HEALTH" 2>/dev/null || true
}

# ── 单轮探测 ───────────────────────────────────────────────────────────
# 出口码：0=通 1=隧道疑似断 2=网络/VPS不通 3=应用不通
one_round() {
  local l1 l2 l3
  l1="$(probe_public)"
  [[ -z "$l1" ]] && l1="000"

  if [[ "$l1" == "200" ]]; then
    vlog "  L1 公网 ${PUBLIC_URL} → ${l1} ✔"
    return 0
  fi

  # L1 挂了，分辨是谁的锅
  l2="unknown"
  if probe_vps_tcp; then l2="ok"; else l2="fail"; fi
  l3="$(probe_local_app)"
  [[ -z "$l3" ]] && l3="000"

  vlog "  L1 公网 → ${l1} ✘   L2 VPS:${VPS_PORT} → ${l2}   L3 本地应用 → ${l3}"

  if [[ "$l2" == "ok" && "$l3" == "200" ]]; then
    return 1        # 网络通、应用通，只有隧道不通 → 该自愈
  elif [[ "$l2" != "ok" ]]; then
    return 2        # 网络/VPS 挂了，重启没用
  else
    return 3        # 应用挂了，重启没用
  fi
}

# ── 主流程 ─────────────────────────────────────────────────────────────
[[ -f "$STATE_FILE" ]] && read -r CONSEC_FAIL < "$STATE_FILE" || CONSEC_FAIL=0

log "探测 ${PUBLIC_URL}（阈值 ${THRESHOLD} 次连续失败）"
rc=0
one_round || rc=$?

case "$rc" in
  0)
    if [[ "$CONSEC_FAIL" -gt 0 ]]; then
      log "✔ 已恢复（此前连续失败 ${CONSEC_FAIL} 次）"
    else
      vlog "✔ 隧道正常"
    fi
    CONSEC_FAIL=0
    ;;
  1)
    CONSEC_FAIL=$(( CONSEC_FAIL + 1 ))
    log "⚠ 公网不可达（连续第 ${CONSEC_FAIL} 次）——网络与应用均正常，疑似隧道断了"
    if (( CONSEC_FAIL < THRESHOLD )); then
      log "  未达阈值 ${THRESHOLD}，本轮不动作"
    else
      if docker inspect "$GOST_CONTAINER" >/dev/null 2>&1; then
        log "  重启 ${GOST_CONTAINER} 以重建隧道 ..."
        docker restart "$GOST_CONTAINER" >/dev/null 2>&1
        sleep 8
        if one_round; then
          log "✔ 自愈成功，隧道已恢复"
          CONSEC_FAIL=0
        else
          log "✘✘ 自愈失败，重启后仍不通，请人工介入："
          log "    docker logs --tail 50 ${GOST_CONTAINER}"
          log "    docker logs --tail 50 acf-gost   # VPS 侧"
          exit 1
        fi
      else
        log "✘ 容器 ${GOST_CONTAINER} 不存在，无法自愈"
        exit 1
      fi
    fi
    ;;
  2)
    CONSEC_FAIL=0
    log "⚠ 公网不可达，但到 VPS:${VPS_PORT} 也不通 —— 是网络/VPS 的问题，不是隧道"
    log "  不做任何动作（重启隧道无用）。请检查 VPS 与网络。"
    ;;
  3)
    CONSEC_FAIL=0
    log "⚠ 公网不可达，但本地应用也不通 —— 是应用的问题，不是隧道"
    log "  不做任何动作（重启隧道无用）。请检查 admin-web/admin-api。"
    ;;
esac

echo "$CONSEC_FAIL" > "$STATE_FILE"
# 同时留一份带时间戳的日志，便于事后回溯
echo "[$(date '+%F %T')] rc=$rc consecutive_fail=$CONSEC_FAIL url=$PUBLIC_URL" >> "$LOG_FILE"
exit 0
