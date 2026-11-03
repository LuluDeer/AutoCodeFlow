#!/usr/bin/env bash
# deploy/gost/enable.sh — 一条命令启用跨网入口（gost 客户端）并跑完连通性验证
#
# 前置：根 .env 里已有
#   GOST_SERVER_ADDR / GOST_SERVER_PORT / GOST_BIND_PORT
#   GOST_USERNAME / GOST_PASSWORD / GOST_DOMAIN
#
# 用法：
#   deploy/gost/enable.sh                 # 起隧道 + 验证
#   deploy/gost/enable.sh --down          # 停隧道（不影响主体服务，也不影响 frpc）
#   deploy/gost/enable.sh --with-frp      # 同时停 frpc（切换完成后的收尾）
#
# 退出码：0 = 隧道已建立且全部验证通过；非 0 = 具体哪步失败（脚本会打印）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

COMPOSE_BASE=(docker compose -p acf --env-file .env
  -f docker-compose.yml -f docker-compose.local.yml
  -f docker-compose.no-executor.yml)

ACTION="up"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --down)     ACTION="down"; shift ;;
    --with-frp) ACTION="with-frp"; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

getenv() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2-; }

# ── 停 gost ────────────────────────────────────────────────────────
if [[ "$ACTION" == "down" || "$ACTION" == "with-frp" ]]; then
  "${COMPOSE_BASE[@]}" -f docker-compose.gost.yml --profile gost stop gost 2>/dev/null || true
  echo "gost 客户端已停止（主体服务未动）"
  if [[ "$ACTION" == "with-frp" ]]; then
    "${COMPOSE_BASE[@]}" -f docker-compose.frp.yml --profile frp stop frpc 2>/dev/null || true
    echo "frpc 也已停止（frps 仍在 VPS 上服务其它客户端）"
  fi
  exit 0
fi

# ── 1. 参数校验 ────────────────────────────────────────────────────
missing=0
for k in GOST_SERVER_ADDR GOST_SERVER_PORT GOST_BIND_PORT GOST_USERNAME GOST_PASSWORD GOST_DOMAIN; do
  v="$(getenv "$k" || true)"
  if [[ -z "$v" ]]; then echo "✘ .env 缺少 $k" >&2; missing=1; fi
done
[[ $missing -eq 0 ]] || { echo "补齐 .env 后重跑" >&2; exit 3; }

SERVER="$(getenv GOST_SERVER_ADDR)"
PORT="$(getenv GOST_SERVER_PORT)"
BIND="$(getenv GOST_BIND_PORT)"
USER="$(getenv GOST_USERNAME)"
PASS="$(getenv GOST_PASSWORD)"
DOMAIN="$(getenv GOST_DOMAIN)"
echo "==> gost 服务端: ${SERVER}:${PORT}   期望它在 VPS 绑 ${BIND}"

# ── 2. 渲染客户端配置（模板占位 → 真实值，密码不落仓库）────────────
LOCAL_CONF="deploy/local/gost-client.yml"
mkdir -p deploy/local
if [[ ! -f "$LOCAL_CONF" ]]; then
  cp deploy/gost/gost-client.yml "$LOCAL_CONF"
  echo "==> 已生成 ${LOCAL_CONF}（首次）"
fi
# 模板里统一用 {{VAR}} 占位。密码可能含 / & | 等 sed 特殊字符，
# 所以用 python 做纯字面量替换，最稳（sed 在此处会把 ${VAR} 之类的值吃掉）。
python3 - "$LOCAL_CONF" "$SERVER" "$PORT" "$BIND" "$DOMAIN" "$PASS" "$USER" <<'PY'
import sys
path, server, port, bind, domain, password, user = sys.argv[1:8]
with open(path, encoding='utf-8') as f:
    s = f.read()
repl = {
    '{{VPS_ADDR}}': server,
    '{{GOST_PORT}}': port,
    '{{BIND_PORT}}': bind,
    '{{ACF_DOMAIN}}': domain,
    '{{CHANGE_ME_STRONG_PASSWORD}}': password,
    '{{CHANGE_ME_USERNAME}}': user,
}
for k, v in repl.items():
    s = s.replace(k, v)
with open(path, 'w', encoding='utf-8') as f:
    f.write(s)
PY

# 渲染后不允许残留占位符
if grep -q '{{' "$LOCAL_CONF"; then
  echo "✘ 渲染后仍有未替换的占位符：" >&2
  grep -n '{{' "$LOCAL_CONF" >&2
  exit 4
fi

# ── 3. 配置语法预检（容器内 gost 解析，失败不碰线上）───────────────
echo "==> 校验 gost 客户端配置"
docker run --rm --network none \
  -v "$ROOT/$LOCAL_CONF:/etc/gost/gost.yml:ro" \
  gogost/gost:3.3.3 -C /etc/gost/gost.yml -V >/dev/null 2>&1 \
  || { echo "✘ gost 配置无法解析，见 deploy/gost/gost-client.yml" >&2; exit 4; }

# ── 4. 启动 gost 客户端 ────────────────────────────────────────────
echo "==> 启动 gost 客户端"
"${COMPOSE_BASE[@]}" -f docker-compose.gost.yml --profile gost up -d gost

echo "==> 等待隧道建立（最多 60s）"
ok=0
for _ in $(seq 1 30); do
  if docker logs acf-gost-1 2>&1 | grep -q 'bind on '; then ok=1; break; fi
  sleep 2
done
if [[ $ok -ne 1 ]]; then
  echo "✘ 隧道未建立，gost 日志尾部：" >&2
  docker logs --tail 30 acf-gost-1 >&2 || true
  exit 5
fi
echo "✔ 隧道已建立：$(docker logs acf-gost-1 2>&1 | grep -o 'bind on [^"]*' | tail -1)"

# ── 5. 连通性验证 ──────────────────────────────────────────────────
PUBLIC_ORIGIN="$(getenv API_BASE_URL)"
BASE="${PUBLIC_ORIGIN%/}"
echo "==> 验证入口 ${BASE}"

fail=0
code="$(curl -s -o /tmp/acf-gost-health.json -w '%{http_code}' -m 20 "${BASE}/api/health" || true)"
if [[ "$code" == "200" ]] && grep -q '"code":200' /tmp/acf-gost-health.json; then
  echo "✔ /api/health 200"
else
  echo "✘ /api/health 期望 200，实得 ${code}" >&2; fail=1
fi

# /uploads 必须是 401/403，不能是 200 text/html（SPA 回退会伪装成 200）
read -r ucode uct < <(curl -s -o /dev/null -w '%{http_code} %{content_type}' -m 20 \
  "${BASE}/uploads/packages/nonexistent.zip" || true) || true
if [[ "$ucode" == "401" || "$ucode" == "403" ]]; then
  echo "✔ /uploads 鉴权态正确（${ucode}）"
elif [[ "$ucode" == "200" && "$uct" == text/html* ]]; then
  echo "✘ /uploads 被 SPA 回退成 HTML —— 反代改写了路径" >&2; fail=1
else
  echo "✘ /uploads 异常：${ucode} ${uct}" >&2; fail=1
fi

# pull 端点：无 token 应快速 401（长轮询不能被反代拖成 60s）
read -r pcode ptime < <(curl -s -o /tmp/acf-gost-pull.json -w '%{http_code} %{time_total}' -m 20 \
  -X POST "${BASE}/api/executors/pull" -H 'Content-Type: application/json' -d '{}' || true) || true
if [[ "$pcode" == "401" ]]; then
  echo "✔ pull 端点可达（401, ${ptime}s）"
else
  echo "✘ pull 端点期望 401，实得 ${pcode}" >&2; fail=1
fi

if [[ $fail -ne 0 ]]; then
  echo "✘ 有验证项未通过，见上方输出" >&2
  exit 6
fi
echo "✔ 全部通过：跨网 pull 入口 ${BASE} 可用"
echo
echo "⚠ 还没切换 nginx。上线需在 VPS 上把 proxy_pass 从 frps 的 40800"
echo "  改为 gost 的 ${BIND}，reload nginx 后再验证。"
