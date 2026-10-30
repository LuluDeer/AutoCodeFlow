#!/usr/bin/env bash
# deploy/executor-preflight.sh — 在「准备装执行器的那台机器」上先跑这个
#
# 作用：安装前确认这台机器到中台的链路可用（DNS/TCP/TLS/健康检查/安装脚本/
# 拉取端点），避免装完才发现 404、证书过期、被防火墙拦、反代改写了路径。
#
# 用法：
#   bash executor-preflight.sh https://<ACF_DOMAIN>     # 跨网（pull）
#   bash executor-preflight.sh http://<LAN_IP>:8088   # 局域网（push）
#
# 退出码：0 全部通过；1 有失败项（逐条打印原因）。
# 依赖：bash、curl；TLS 检查额外需要 openssl（缺失只跳过该条）。
set -uo pipefail

BASE="${1:-https://<ACF_DOMAIN>}"
BASE="${BASE%/}"
HOST_PORT="${BASE#*://}"
HOST="${HOST_PORT%%/*}"
HOSTNAME_ONLY="${HOST%%:*}"
PORT=443
[[ "$BASE" == http://* ]] && PORT=80
[[ "$HOST" == *:* ]] && PORT="${HOST##*:}"

fail=0
ok()   { printf '  ✔ %s\n' "$*"; }
bad()  { printf '  ✘ %s\n' "$*" >&2; fail=1; }
warn() { printf '  ⚠ %s\n' "$*" >&2; }
sec()  { printf '\n== %s ==\n' "$*"; }

echo "目标中台: $BASE"

sec "1/6 DNS 解析"
if getent hosts "$HOSTNAME_ONLY" >/dev/null 2>&1; then
  ok "$HOSTNAME_ONLY -> $(getent hosts "$HOSTNAME_ONLY" | awk '{print $1}' | paste -sd, -)"
else
  bad "解析不到 $HOSTNAME_ONLY（检查 DNS / /etc/hosts）"
fi

sec "2/6 TCP 连通 $HOSTNAME_ONLY:$PORT"
if timeout 8 bash -c "exec 3<>/dev/tcp/$HOSTNAME_ONLY/$PORT" 2>/dev/null; then
  ok "TCP 可建连"
else
  bad "TCP 连不上（防火墙 / 安全组 / 端口未放行）"
fi

if [[ "$BASE" == https://* ]]; then
  sec "3/6 TLS 与证书"
  if command -v openssl >/dev/null 2>&1; then
    cert="$(timeout 10 openssl s_client -connect "$HOSTNAME_ONLY:$PORT" -servername "$HOSTNAME_ONLY" </dev/null 2>/dev/null \
      | openssl x509 -noout -subject -enddate 2>/dev/null)"
    if [[ -n "$cert" ]]; then
      ok "$(echo "$cert" | tr '\n' ' ')"
      if echo "$cert" | grep -q 'notAfter'; then
        end="$(echo "$cert" | sed -n 's/.*notAfter=//p')"
        if ! date -d "$end" +%s >/dev/null 2>&1; then
          warn "无法解析证书到期时间：$end"
        elif [[ "$(date -d "$end" +%s)" -lt "$(( $(date +%s) + 7*86400 ))" ]]; then
          bad "证书 7 天内到期（$end）"
        else
          ok "证书有效期充足"
        fi
      fi
    else
      bad "TLS 握手失败（证书/协议不匹配）"
    fi
  else
    warn "未安装 openssl，跳过证书检查"
  fi
else
  sec "3/6 TLS（跳过：http 入口）"
fi

sec "4/6 健康检查 /api/health/ready"
body="$(curl -fsS -m 15 "$BASE/api/health/ready" 2>/dev/null)"
if [[ $? -eq 0 ]] && echo "$body" | grep -q '"status":"ready"'; then
  ok "ready"
else
  bad "未就绪：${body:0:160}"
fi

sec "5/6 安装脚本 /api/executors/install.sh"
tmp_install="$(mktemp)"
if curl -fsS -m 15 "$BASE/api/executors/install.sh" -o "$tmp_install" 2>/dev/null \
   && grep -q 'AutoCodeFlow Executor' "$tmp_install"; then
  ok "install.sh 可下载且内容正确（$(wc -c < "$tmp_install") 字节）"
else
  bad "install.sh 取不到或被反代改写（检查 nginx 是否把 /api 前缀剥掉）"
fi
rm -f "$tmp_install"

sec "6/6 拉取端点 /api/executors/pull"
read -r code t < <(curl -s -o /dev/null -w '%{http_code} %{time_total}' -m 20 \
  -X POST "$BASE/api/executors/pull" -H 'Content-Type: application/json' -d '{}' 2>/dev/null) || true
if [[ "${code:-}" == "401" ]]; then
  ok "端点可达（无 token 401，${t}s）—— 反射代理未拦截 POST"
else
  bad "期望 401，实得 ${code:-timeout}（反代/WAF 可能拦了 POST）"
fi

echo
if [[ $fail -eq 0 ]]; then
  echo "全部通过：可以用下面的命令安装执行器"
  echo "  curl -fsSL '$BASE/api/executors/install.sh' | bash -s -- --api-url '$BASE' --secret '<EXECUTOR_SECRET>'$( [[ "$BASE" == https://* ]] && echo ' --pull' )"
  exit 0
fi
echo "有检查项失败，先修链路再安装（详见上方输出）" >&2
exit 1
