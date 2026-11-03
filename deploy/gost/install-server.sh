#!/usr/bin/env bash
# deploy/gost/install-server.sh — 在 VPS 上部署 gost 服务端（替代 frps）
#
# ⚠ 本脚本在 **VPS** 上执行，不是本机。
#
# 用法（VPS 上）：
#   1) 复制本文件与 gost-server.yml 到 VPS
#   2) 编辑 gost-server.yml：填密码、确认证书路径
#   3) bash install-server.sh
#
# 它做什么：
#   - 拉起 gost 容器（host 网络，监听 7001）
#   - 用 nginx 已有的 Let's Encrypt 证书（不额外签发）
#   - 做一次自检：确认 127.0.0.1:BIND_PORT 能被连上
#   - **不改 nginx**：切换由你手动改 proxy_pass（见输出提示）
#
# 幂等：重复执行安全。
set -euo pipefail

BIND_PORT="${GOST_BIND_PORT:-40801}"
RELAY_PORT="${GOST_SERVER_PORT:-7001}"
NAME="${GOST_CONTAINER_NAME:-acf-gost}"
IMAGE="gogost/gost:3.3.3"
CERT_DIR="${GOST_CERT_DIR:-/etc/gost/cert}"

if [[ "$(id -u)" != "0" ]]; then
  echo "需要 root（或 sudo）执行" >&2
  exit 1
fi

echo "==> 安装 gost 服务端到本机（${NAME}）"

# ── 1. 证书 ────────────────────────────────────────────────────────
# 复用 nginx 的 Let's Encrypt 证书：只读引用，不复制、不签发。
# 宝塔默认路径：/www/server/panel/vhost/cert/<域名>/fullchain.pem + privkey.pem
if [[ ! -f "${CERT_DIR}/fullchain.pem" || ! -f "${CERT_DIR}/privkey.pem" ]]; then
  echo "✘ 找不到证书：${CERT_DIR}/{fullchain.pem,privkey.pem}" >&2
  echo "  把 nginx 站点用的证书软链到该目录即可，例如：" >&2
  echo "  mkdir -p ${CERT_DIR}" >&2
  echo "  ln -sf /www/server/panel/vhost/cert/<你的域名>/fullchain.pem ${CERT_DIR}/fullchain.pem" >&2
  echo "  ln -sf /www/server/panel/vhost/cert/<你的域名>/privkey.pem  ${CERT_DIR}/privkey.pem" >&2
  exit 2
fi
echo "✔ 证书就位"

# ── 2. 配置 ────────────────────────────────────────────────────────
CFG="/etc/gost/gost-server.yml"
if [[ ! -f "$CFG" ]]; then
  echo "✘ 找不到 $CFG" >&2
  echo "  请把 deploy/gost/gost-server.yml 复制到该位置并填好密码" >&2
  exit 3
fi
grep -q 'CHANGE_ME_STRONG_PASSWORD' "$CFG" && {
  echo "✘ $CFG 里密码还是占位符，请先填好" >&2; exit 4;
}
echo "✔ 配置就位"

# ── 3. 拉镜像并启动 ────────────────────────────────────────────────
echo "==> 拉取 ${IMAGE}"
docker pull "$IMAGE"

echo "==> 启动容器（host 网络）"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --restart unless-stopped \
  --name "$NAME" \
  --network host \
  -v "${CFG}:/etc/gost/gost.yml:ro" \
  -v "${CERT_DIR}:/etc/gost/cert:ro" \
  "$IMAGE" -C /etc/gost/gost.yml >/dev/null

sleep 3
if ! docker ps --filter "name=^${NAME}$" --filter status=running -q | grep -q .; then
  echo "✘ gost 启动失败，日志：" >&2
  docker logs --tail 30 "$NAME" >&2 || true
  exit 5
fi
echo "✔ 容器已启动"

# ── 4. 自检 ────────────────────────────────────────────────────────
echo "==> 自检"
if docker logs "$NAME" 2>&1 | grep -q "listening on \[::\]:${RELAY_PORT}/tcp"; then
  echo "✔ relay 监听 ${RELAY_PORT}"
else
  echo "⚠ 未在日志里看到 relay 监听 ${RELAY_PORT}，手工确认：" >&2
  docker logs --tail 20 "$NAME" >&2
fi

# BIND 端口此刻还没人 bind（要等客户端连上来），所以这里只能检查
# 「客户端能否连到 relay」——由客户端侧验证脚本完成。
if timeout 5 bash -c "cat < /dev/null > /dev/tcp/127.0.0.1/${RELAY_PORT}" 2>/dev/null; then
  echo "✔ 127.0.0.1:${RELAY_PORT} 可连（仅本机可达）"
else
  echo "✘ 127.0.0.1:${RELAY_PORT} 连不上" >&2
  exit 6
fi

cat <<EOF

✔ gost 服务端已就绪。

下一步：
  1) 在内网机器上跑 deploy/gost/enable.sh，确认日志出现
     'bind on 127.0.0.1:${BIND_PORT}/tcp OK'
  2) 确认本机 127.0.0.1:${BIND_PORT} 已被客户端 bind 后，
     在 **nginx 站点配置** 里把：
         proxy_pass http://127.0.0.1:40800;
     改成：
         proxy_pass http://127.0.0.1:${BIND_PORT};
     然后 nginx -t && nginx -s reload
     （宝塔：面板 → 网站 → 配置文件 → 改完保存）
  3) 验证：curl -sS -o /dev/null -w '%{http_code}' https://<你的域名>/api/health
     期望 200
  4) 稳定观察 24h 后，再跑 deploy/gost/enable.sh --with-frp 停掉 frpc，
     最后才考虑停 frps（它上面还有别的客户端，先逐个迁）

回退：把 nginx 的 proxy_pass 改回 40800 并 reload 即可，
      gost 与 frp 并行运行期间两边互不影响。
EOF
