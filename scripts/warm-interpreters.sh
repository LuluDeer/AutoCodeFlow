#!/usr/bin/env bash
# 解释器预热：在线预下载 / 离线预填常用 Python 版本到执行器缓存池。
#
# 为什么需要（深度评审 P1"首次任务下载延迟 / 批量首次启动"）：
#   - 首次声明某版本的任务会同步等待 `uv python install` 下载完成（最多
#     300s，实测单版本约 13~17s），下载时间计入任务超时预算——部署时预填
#     常用版本可把首次任务延迟降到 0；
#   - 多个版本首次声明时，即使有界并发（默认 2）也仍需排队：N 个版本要
#     ceil(N/2) × 下载时间，预填后不再有首次下载路径。
#
# 用法：
#   scripts/warm-interpreters.sh 3.8 3.9 3.11
#   UV_PYTHON_INSTALL_DIR=/data/interpreters scripts/warm-interpreters.sh 3.11
#
# 环境变量：
#   UV_PYTHON_INSTALL_DIR  解释器池根（缺省用 uv 默认；compose 中两个执行器
#                          均指向 /data/interpreters）
#   UV_PYTHON_INSTALL_MIRROR  内网镜像（可选，与执行器同源注入）
#
# 离线预填（3.7 等在线不可下载版本）步骤见
# docs/design/python-task-upload-and-multiversion/OFFLINE-PROVISIONING.md §5。
set -euo pipefail

POOL_DIR="${UV_PYTHON_INSTALL_DIR:-}"
VERSIONS=("$@")

if [ ${#VERSIONS[@]} -eq 0 ]; then
  echo "usage: $0 <X.Y> [<X.Y> ...]" >&2
  exit 2
fi

if [ -n "$POOL_DIR" ]; then
  export UV_PYTHON_INSTALL_DIR="$POOL_DIR"
  mkdir -p "$POOL_DIR"
fi

for v in "${VERSIONS[@]}"; do
  echo "==> pre-warming Python $v"
  uv python install "$v"
done

echo "done. Pool contents under ${POOL_DIR:-uv default install dir}:"
uv python list --only-installed
