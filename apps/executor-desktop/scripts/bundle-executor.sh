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

# F-19（DEEP_REVIEW 0ef3bbe）：产物出库后落 sha256 清单（构建产物，随构建刷新）。
# 期望哈希的「权威副本」提交在 ../executor-node-bundle.sha256（CI desktop-bundle-drift
# 离线重打后比对 actual == expected，不一致即红）。此处把本次产物哈希写到产物旁，
# 供打包/可复现校验读取。
if command -v sha256sum &>/dev/null; then
  ( cd "${DEST}" && sha256sum index.js > index.js.sha256 )
else
  ( cd "${DEST}" && shasum -a 256 index.js > index.js.sha256 )
fi
echo "[bundle-executor] F-19: 产物 sha256 已写入 ${DEST}/index.js.sha256"
cat "${DEST}/index.js.sha256"
