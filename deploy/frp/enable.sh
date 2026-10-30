#!/usr/bin/env bash
# deploy/frp/enable.sh — 一条命令启用跨网入口（frpc）并跑完连通性验证
#
# 前置：根 .env 里已有
#   FRP_SERVER_ADDR / FRP_SERVER_PORT / FRP_TOKEN / FRP_REMOTE_PORT
#   （先用 set-domain.sh 把对外地址切成域名，或手工改）
#
# 用法：
#   deploy/frp/enable.sh                 # 只起隧道 + 验证
#   deploy/frp/enable.sh --domain acf.example.com
#                                        # 先切域名（改 .env + 重建 admin-api）再起隧道
#   deploy/frp/enable.sh --down          # 停隧道（不影响主体服务）
#
# 退出码：0 = 隧道已建立且四项验证全过；非 0 = 具体哪步失败（脚本会打印）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

COMPOSE_BASE=(docker compose -p acf --env-file .env
  -f docker-compose.yml -f docker-compose.local.yml
  -f docker-compose.no-executor.yml)

DOMAIN=""
ACTION="up"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:?--domain 需要值}"; shift 2 ;;
    --down)   ACTION="down"; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

getenv() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2-; }

if [[ "$ACTION" == "down" ]]; then
  "${COMPOSE_BASE[@]}" -f docker-compose.frp.yml --profile frp stop frpc
  echo "frpc 已停止（主体服务未动）"
  exit 0
fi

# ── 1. 切域名（可选）───────────────────────────────────────────────
if [[ -n "$DOMAIN" ]]; then
  bash deploy/frp/set-domain.sh "$DOMAIN"
fi

# ── 2. 参数校验 ────────────────────────────────────────────────────
missing=0
for k in FRP_SERVER_ADDR FRP_SERVER_PORT FRP_TOKEN FRP_REMOTE_PORT; do
  v="$(getenv "$k" || true)"
  if [[ -z "$v" ]]; then echo "✘ .env 缺少 $k" >&2; missing=1; fi
done
[[ $missing -eq 0 ]] || { echo "补齐 .env 后重跑" >&2; exit 3; }

SERVER="$(getenv FRP_SERVER_ADDR)"
PORT="$(getenv FRP_SERVER_PORT)"
REMOTE="$(getenv FRP_REMOTE_PORT)"
echo "==> frps: ${SERVER}:${PORT}  remote_port: ${REMOTE}"

# ── 3. 配置语法预检（容器内 frpc verify，失败不碰线上）───────────────
echo "==> 校验 frpc.toml"
docker run --rm --entrypoint /usr/bin/frpc \
  -e FRP_SERVER_ADDR="$SERVER" -e FRP_SERVER_PORT="$PORT" \
  -e FRP_TOKEN="$(getenv FRP_TOKEN)" -e FRP_REMOTE_PORT="$REMOTE" \
  -v "$ROOT/deploy/frp/frpc.toml:/etc/frp/frpc.toml:ro" \
  fatedier/frpc:v0.71.1 verify -c /etc/frp/frpc.toml

# ── 4. 启动 frpc ───────────────────────────────────────────────────
echo "==> 启动 frpc"
"${COMPOSE_BASE[@]}" -f docker-compose.frp.yml --profile frp up -d frpc

echo "==> 等待隧道建立（最多 60s）"
ok=0
for _ in $(seq 1 30); do
  if docker logs acf-frpc-1 2>&1 | grep -q 'start proxy success'; then ok=1; break; fi
  sleep 2
done
if [[ $ok -ne 1 ]]; then
  echo "✘ 隧道未建立，frpc 日志尾部：" >&2
  docker logs --tail 30 acf-frpc-1 >&2 || true
  exit 4
fi
echo "✔ 隧道已建立"

# ── 5. 四项连通性验证 ──────────────────────────────────────────────
PUBLIC_ORIGIN="$(getenv API_BASE_URL)"
BASE="${PUBLIC_ORIGIN%/}"
echo "==> 验证入口 ${BASE}"

fail=0
code="$(curl -s -o /tmp/acf-frp-health.json -w '%{http_code}' -m 20 "${BASE}/api/health" || true)"
if [[ "$code" == "200" ]] && grep -q '"code":200' /tmp/acf-frp-health.json; then
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
read -r pcode ptime < <(curl -s -o /tmp/acf-frp-pull.json -w '%{http_code} %{time_total}' -m 20 \
  -X POST "${BASE}/api/executors/pull" -H 'Content-Type: application/json' -d '{}' || true) || true
if [[ "$pcode" == "401" ]]; then
  echo "✔ pull 端点可达（401, ${ptime}s）"
else
  echo "✘ pull 端点期望 401，实得 ${pcode}" >&2; fail=1
fi

# 域名解析（早发现 DNS 还没指过来）
if [[ "$BASE" == https://* ]]; then
  host="${BASE#https://}"; host="${host%%/*}"
  if getent hosts "$host" >/dev/null 2>&1; then
    echo "✔ 域名解析：$(getent hosts "$host" | awk '{print $1}' | head -n1)"
  else
    echo "⚠ 域名 ${host} 在本机解析不到（DNS 未生效？执行器侧同样会受影响）" >&2
  fi
fi

if [[ $fail -ne 0 ]]; then
  echo "✘ 有验证项未通过，见上方输出" >&2
  exit 5
fi
echo "✔ 全部通过：跨网 pull 入口 ${BASE} 可用"
echo "   跨网执行器安装：curl -fsSL '${BASE}/api/executors/install.sh' | bash -s -- --api-url '${BASE}' --secret \"\$(grep -E '^EXECUTOR_SECRET=' .env | cut -d= -f2)\" --pull"
