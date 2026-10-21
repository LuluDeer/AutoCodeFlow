#!/usr/bin/env bash
# 在真实 Electron 壳里加载 V2 渲染层（联调 / 验收用，不影响默认启动路径）。
#
#   npm run dev:v2
#
# 环境变量：
#   ACF_V2_PORT=4173             V2 静态服务的端口
#   ACF_E2E_USER_DATA=<dir>      隔离的 userData（缺省 apps/executor-desktop/.v2-harness-userdata）
#   ACF_ELECTRON_SANDBOX=1       Linux 上保留 Electron sandbox（需要 chrome-sandbox 4755）
#
# 做了什么：
#   1) 确保 V2 产物存在（缺失则构建）；
#   2) 准备隔离 userData（首次自动 seed 一条已配置记录 + 4 条执行历史）；
#   3) 构建 V1 主进程并起 V2 静态服务；
#   4) 以 ACF_RENDERER_URL + ACF_OPEN_STATUS 启动 Electron —— 主进程打开真实主窗并加载 V2，
#      preload 桥、sender 闸、导航守卫全部走真实实现。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
v2="$here/../executor-desktop-v2"
port="${ACF_V2_PORT:-4173}"
user_data="${ACF_E2E_USER_DATA:-$here/.v2-harness-userdata}"

if [ ! -f "$v2/dist/index.html" ]; then
  echo "[dev-v2] building V2 renderer..."
  (cd "$v2" && npm run build)
fi

if [ ! -f "$user_data/config.json" ]; then
  echo "[dev-v2] seeding isolated userData at $user_data"
  node "$here/scripts/seed-v2-harness.mjs" "$user_data"
fi

echo "[dev-v2] building desktop main..."
(cd "$here" && npm run build:main)

echo "[dev-v2] serving V2 at http://127.0.0.1:$port"
(cd "$v2" && exec npx vite preview --port "$port" --strictPort) &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
sleep 1

electron_args=()
if [ "$(uname -s)" = "Linux" ] && [ "${ACF_ELECTRON_SANDBOX:-0}" != "1" ]; then
  electron_args+=(--no-sandbox)
fi

echo "[dev-v2] launching Electron (ACF_RENDERER_URL=http://127.0.0.1:$port)"
cd "$here"
ACF_RENDERER_URL="http://127.0.0.1:$port" \
ACF_OPEN_STATUS=1 \
ELECTRON_USER_DATA_DIR="$user_data" \
  npx electron . "${electron_args[@]}"
