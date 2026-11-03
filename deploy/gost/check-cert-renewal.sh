#!/usr/bin/env bash
# deploy/gost/check-cert-renewal.sh — 证书续期后热重载 gost（在 **VPS** 上跑）
#
# ── 为什么必须有这个脚本 ──────────────────────────────────────────────
# gost 是**启动时**把 certFile/keyFile 读进内存的，不像 nginx 支持 reload 重读。
# 而证书由宝塔/acme.sh 自动续期（提前约 30 天），续期后 nginx 自己 reload
# 生效，**gost 不会**——它继续用内存里的旧证书。
#
# 后果：旧证书到期那天，内网客户端 TLS 校验失败 → 整条隧道断 → 域名 502，
# 而且**没有任何预兆**（gost 日志只报握手失败，不说"证书过期"）。
#
# 2026-11-03 初次部署时证书有效期 2026-10-30 ~ 2027-01-28，
# 宝塔约在 2026-12-29 前后续期 → 那天必须让 gost 重新加载证书。
#
# ── 为什么用 SIGHUP 而不是 docker restart（2026-11-03 实测）────────────
# gost 支持 SIGHUP 热重载：cmd/gost/program.go 的 reload() 监听 syscall.SIGHUP
# → reloadConfig() → loader.Load() 重新 BuildDefaultTLSConfig（重读证书）
# → p.run() 重建 service/listener。
# 实测：替换证书文件后 `docker kill --signal=HUP <容器>`，
#       日志出现 "config reloaded"，随后 openssl s_client 看到新证书 CN。
# **隧道不中断**（restart 会断，内网客户端要重连）。
#
# ── 这个脚本做什么 ────────────────────────────────────────────────────
# 比较「证书文件 mtime」与「容器启动时间」：
#   - 证书比容器新 → 说明续过期了，发 SIGHUP 热重载（不带 --dry-run 时）
#   - 证书不比容器新 → 什么都不做（幂等，可安全地每天跑）
#
# 用法（VPS 上）：
#   bash check-cert-renewal.sh              # 检查并按需热重载
#   bash check-cert-renewal.sh --dry-run    # 只报告，不动
#
# 建议加进 crontab（每天凌晨跑一次）：
#   echo '15 4 * * * root /root/deploy/gost/check-cert-renewal.sh >> /var/log/gost-cert-check.log 2>&1' \
#     > /etc/cron.d/gost-cert-check
set -euo pipefail

CONTAINER="${GOST_CONTAINER_NAME:-acf-gost}"
CERT_FILE="${GOST_CERT_FILE:-/www/server/panel/vhost/cert/acf.yskj.cc.cd/fullchain.pem}"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

log() { echo "[$(date '+%F %T')] $*"; }

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  log "✘ 容器 ${CONTAINER} 不存在，退出"
  exit 1
fi

if [[ ! -f "$CERT_FILE" ]]; then
  log "✘ 证书文件不存在：${CERT_FILE}"
  exit 2
fi

CERT_MTIME=$(stat -c %Y "$CERT_FILE")
STARTED_AT=$(docker inspect "$CONTAINER" --format '{{.State.StartedAt}}')
START_EPOCH=$(date -d "$STARTED_AT" +%s)

log "证书 mtime : $(date -d "@${CERT_MTIME}" '+%F %T')"
log "容器启动于 : $(date -d "@${START_EPOCH}" '+%F %T')"

if (( CERT_MTIME > START_EPOCH )); then
  log "⚠ 证书比容器新 —— 说明续过期了，gost 内存里还是旧证书"
  if (( DRY_RUN )); then
    log "（--dry-run）本应执行：docker kill --signal=HUP ${CONTAINER}"
  else
    # SIGHUP 热重载：不断隧道（比 docker restart 安全，内网客户端无需重连）
    log "发送 SIGHUP 热重载 ${CONTAINER} ..."
    docker kill --signal=HUP "$CONTAINER" >/dev/null
    sleep 4
    if docker logs "$CONTAINER" 2>&1 | tail -20 | grep -q 'config reloaded'; then
      log "✔ 已热重载（日志出现 config reloaded），隧道未中断"
    else
      log "⚠ 未在日志里看到 'config reloaded'，请手工确认：docker logs ${CONTAINER} | tail"
    fi
    if ! docker ps --filter "name=^${CONTAINER}$" --filter status=running -q | grep -q .; then
      log "✘ 容器未在运行，请立即检查：docker logs ${CONTAINER}"
      exit 3
    fi
  fi
else
  log "✔ 证书未更新，无需操作"
fi

# 额外：报告证书剩余有效期，方便提前发现续期失败
if command -v openssl >/dev/null 2>&1; then
  NOT_AFTER=$(openssl x509 -in "$CERT_FILE" -noout -enddate 2>/dev/null | cut -d= -f2 || true)
  if [[ -n "$NOT_AFTER" ]]; then
    EXP_EPOCH=$(date -d "$NOT_AFTER" +%s)
    DAYS=$(( (EXP_EPOCH - $(date +%s)) / 86400 ))
    log "证书到期   : ${NOT_AFTER}（剩 ${DAYS} 天）"
    if (( DAYS < 14 )); then
      log "⚠⚠ 剩余不足 14 天，续期可能失败，请检查宝塔 SSL 续期任务"
    fi
  fi
fi
