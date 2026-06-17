#!/usr/bin/env bash
# 将 executor-node 用 ncc 打包为单文件，放入 executor-desktop/resources/executor-node/
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXECUTOR_SRC="$(cd "${SCRIPT_DIR}/../../executor-node" && pwd)"
DEST="${SCRIPT_DIR}/../resources/executor-node"

echo "[bundle-executor] Source: ${EXECUTOR_SRC}"
echo "[bundle-executor] Output: ${DEST}"

mkdir -p "${DEST}"

# 使用本地安装的 ncc（executor-desktop/node_modules/.bin/ncc）
NCC_BIN="${SCRIPT_DIR}/../node_modules/.bin/ncc"
if [ ! -f "${NCC_BIN}" ]; then
  echo "[bundle-executor] ncc not found, run: npm install in executor-desktop"
  exit 1
fi

# 编译 executor-node（ncc 直接从 TS 入口打包，无需预先 tsc）
cd "${EXECUTOR_SRC}"
"${NCC_BIN}" build src/main.ts -o "${DEST}" --source-map --no-cache

echo "[bundle-executor] Done: ${DEST}/index.js"
