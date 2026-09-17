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

# ---------------------------------------------------------------------------
# python_task_multiversion：可选地把 uv 一并打进客户端。
#
# 为什么是"best-effort"：声明了 runtimeVersion 的任务需要 uv；但**不声明版本
# 的存量任务完全不碰 uv**，所以"没打进 uv"只是能力降级（executor-node 会回退
# 到 PATH 查找），绝不能让整个打包失败——那会把所有存量客户端功能一起拖死。
#
# 开关：ACF_BUNDLE_UV=1（默认 0，不联网、不改动现有产物哈希）。
# 指定本地已下载的 uv：ACF_UV_SOURCE=/path/to/uv（则跳过网络下载）。
# 平台三元组：uv 官方 release 命名是 <triple>.tar.gz / <triple>.zip。
# ---------------------------------------------------------------------------
UV_DEST="${SCRIPT_DIR}/../resources/uv"
if [ "${ACF_BUNDLE_UV:-0}" = "1" ]; then
  echo "[bundle-executor] ACF_BUNDLE_UV=1 → attempting to bundle uv (best-effort)"
  mkdir -p "${UV_DEST}"
  UV_VER="${ACF_UV_VERSION:-0.8.17}"
  case "$(uname -s)" in
    Darwin) UV_OS=apple-darwin ;;
    Linux)  UV_OS=unknown-linux-gnu ;;
    MINGW*|MSYS*|CYGWIN*) UV_OS=pc-windows-msvc ;;
    *) UV_OS="" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) UV_ARCH=x86_64 ;;
    arm64|aarch64) UV_ARCH=aarch64 ;;
    *) UV_ARCH="" ;;
  esac
  if [ -n "${ACF_UV_SOURCE:-}" ] && [ -f "${ACF_UV_SOURCE}" ]; then
    cp -f "${ACF_UV_SOURCE}" "${UV_DEST}/uv"
    chmod +x "${UV_DEST}/uv" 2>/dev/null || true
    echo "[bundle-executor] uv copied from ACF_UV_SOURCE"
  elif [ -n "${UV_OS}" ] && [ -n "${UV_ARCH}" ] && command -v curl &>/dev/null; then
    TRIPLE="${UV_ARCH}-${UV_OS}"
    TMP_UV="$(mktemp -d)"
    if curl -fsSL --max-time 120 \
        "https://github.com/astral-sh/uv/releases/download/${UV_VER}/uv-${TRIPLE}.tar.gz" \
        -o "${TMP_UV}/uv.tar.gz" 2>/dev/null; then
      if tar -xzf "${TMP_UV}/uv.tar.gz" -C "${TMP_UV}" 2>/dev/null; then
        # 官方包内层目录名随版本变化，直接找可执行文件，不写死路径。
        UV_FOUND="$(find "${TMP_UV}" -type f -name 'uv' -o -type f -name 'uv.exe' 2>/dev/null | head -n 1)"
        if [ -n "${UV_FOUND}" ]; then
          cp -f "${UV_FOUND}" "${UV_DEST}/$(basename "${UV_FOUND}")"
          chmod +x "${UV_DEST}/uv" 2>/dev/null || true
          echo "[bundle-executor] uv ${UV_VER} (${TRIPLE}) bundled"
        else
          echo "[bundle-executor] WARN: uv archive contained no uv binary — skipping (build continues)"
        fi
      else
        echo "[bundle-executor] WARN: failed to extract uv archive — skipping (build continues)"
      fi
    else
      echo "[bundle-executor] WARN: could not download uv ${UV_VER} (${TRIPLE}) — skipping (build continues)"
    fi
    rm -rf "${TMP_UV}" 2>/dev/null || true
  else
    echo "[bundle-executor] WARN: cannot determine uv release triple for this host — skipping (build continues)"
  fi
  if [ -f "${UV_DEST}/uv" ] || [ -f "${UV_DEST}/uv.exe" ]; then
    echo "[bundle-executor] uv available at ${UV_DEST}"
  else
    echo "[bundle-executor] uv NOT bundled; executor-node will use PATH lookup at runtime"
  fi
else
  echo "[bundle-executor] uv bundling skipped (set ACF_BUNDLE_UV=1 to enable)"
  echo "[bundle-executor] NOTE: tasks declaring a Python runtimeVersion need uv on PATH,"
  echo "[bundle-executor]       or set UV_BIN / the desktop 'uvPath' setting."
  # Windows 特有陷阱：`npm run build:executor` 里的 bash 常被解析为
  # %LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe（WSL 启动器 shim），
  # 而该 shim **不继承 PowerShell 的环境变量**。于是用户在 PowerShell 里
  # `$env:ACF_BUNDLE_UV='1'` 或写 `ACF_BUNDLE_UV=1 npm run ...` 时，
  # 变量根本到不了这里，脚本静默走"跳过"分支——用户以为打进去了，其实没有。
  # 这里主动探测并给出可执行的修复方式，把静默失败变成显式提示。
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      echo "[bundle-executor] WINDOWS TIP: if you DID set ACF_BUNDLE_UV=1 and still see this,"
      echo "[bundle-executor]   your \`bash\` is likely the WindowsApps WSL shim, which drops"
      echo "[bundle-executor]   the inherited environment. Use Git Bash instead, e.g.:"
      echo "[bundle-executor]     & \"C:\\Program Files\\Git\\bin\\bash.exe\" -c \"ACF_BUNDLE_UV=1 bash scripts/bundle-executor.sh\""
      echo "[bundle-executor]   (see README 'Python 多版本支持（uv）' for details)"
      ;;
  esac
fi

