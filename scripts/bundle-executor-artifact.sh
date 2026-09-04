#!/usr/bin/env bash
# 生成 executor-node 安装 artifact（tar.gz：dist + package.json + 生产 node_modules）。
#
# 用途（R8 / N24 根治）：admin-api 的
#   GET /api/executors/artifact/executor-node.tar.gz
# 从 EXECUTOR_ARTIFACT_DIR（默认 admin-api 进程 <cwd>/artifacts）读取本脚本
# 产物，供目标机 `curl -fsSL .../api/executors/install.sh | bash -s -- ...`
# 一键安装（install.sh 用 --secret 传入的共享 token 作 Bearer 下载）。
#
# 用法:
#   bash scripts/bundle-executor-artifact.sh [--out <dir>]
# 产物默认写到 <repo>/artifacts/executor-node.tar.gz；部署时把该文件放进
# admin-api 的 EXECUTOR_ARTIFACT_DIR（裸机: apps/admin-api/artifacts 或自定义
# 目录 + 环境变量；docker: 挂载卷）。详见 docs/deployment.md「执行器 artifact」。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/apps/executor-node"
OUT_DIR="${EXECUTOR_ARTIFACT_DIR:-$ROOT/artifacts}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT_DIR="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done
OUT="$OUT_DIR/executor-node.tar.gz"

echo "[1/4] 构建 executor-node（tsc → dist/）..."
cd "$SRC"
if [[ ! -d node_modules ]]; then
  npm ci --no-audit --no-fund --silent
fi
npm run build

echo "[2/4] 组装生产 bundle（package.json + dist + npm ci --omit=dev）..."
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/dist"
cp package.json package-lock.json "$STAGE/"
cp -r dist/. "$STAGE/dist/"
cd "$STAGE"
npm ci --omit=dev --no-audit --no-fund --silent

echo "[3/4] 打包 $OUT ..."
mkdir -p "$OUT_DIR"
tar -czf "$OUT" -C "$STAGE" .

echo "[4/4] 完成："
ls -lh "$OUT"
if command -v sha256sum &>/dev/null; then sha256sum "$OUT"; else shasum -a 256 "$OUT"; fi
echo "提示：将产物放入 admin-api 的 EXECUTOR_ARTIFACT_DIR（默认 <cwd>/artifacts）后，"
echo "      GET /api/executors/artifact/executor-node.tar.gz 即可下发。"
