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
# python_task_multiversion：把 uv 一并打进客户端。
#
# 为什么本地默认是"best-effort"：声明了 runtimeVersion 的任务需要 uv；但
# **不声明版本的存量任务完全不碰 uv**，所以"没打进 uv"只是能力降级
# （executor-node 会回退到 PATH 查找），不该让本地构建失败——那会把所有存量
# 客户端功能一起拖死。
#
# 但"发布包"不能沿用这个宽容度：见下方 ACF_UV_REQUIRED。
#
# 开关：ACF_BUNDLE_UV=1（默认 0，不联网、不改动现有产物哈希）。
# 指定本地已下载的 uv：ACF_UV_SOURCE=/path/to/uv（则跳过网络下载）。
# 平台三元组：uv 官方 release 命名是 <triple>.tar.gz（Windows 是 .zip）。
#
# ACF_UV_REQUIRED=1（发布流水线用）：**把 best-effort 变成硬要求**。
#   背景（desktop-v1.5.1 实爆）：默认 ACF_BUNDLE_UV=0 + 下载/解压失败只 WARN 且
#   exit 0 的组合，让"没打进 uv"的安装包**照样发布**——全新设备装完只上报
#   runtimes: shell,node，声明 runtimeVersion 的 Python 任务全部不可用。用户
#   侧只看到一条 WARN，拿不到任何"这个包是残的"的信号。
#   所以：本地开发保持 best-effort；**发布**必须 ACF_UV_REQUIRED=1，
#   缺 uv（含"忘开 ACF_BUNDLE_UV"）即 exit 1 拦住发布。
# ---------------------------------------------------------------------------
UV_DEST="${SCRIPT_DIR}/../resources/uv"
UV_REQUIRED="${ACF_UV_REQUIRED:-0}"
UV_OK=0
if [ "${ACF_BUNDLE_UV:-0}" = "1" ]; then
  echo "[bundle-executor] ACF_BUNDLE_UV=1 → attempting to bundle uv (best-effort)"
  mkdir -p "${UV_DEST}"
  # 先清掉可能存在的陈旧产物：否则上一次成功留下的 uv 会让"这次下载失败"
  # 被静默掩盖，打包出的是**旧版本 uv** 却报成功（比缺 uv 更难查）。
  rm -f "${UV_DEST}/uv" "${UV_DEST}/uv.exe" 2>/dev/null || true
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
  # 官网 release 的归档格式随平台不同：Windows 只有 .zip，其余是 .tar.gz。
  # 旧脚本对三平台一律下 .tar.gz —— Windows 分支**必然 404**，即使打开开关
  # 也永远打不进 uv（这是开关之外的第二个独立缺陷）。
  if [ "${UV_OS}" = "pc-windows-msvc" ]; then UV_EXT=zip; UV_BIN_NAME=uv.exe; else UV_EXT=tar.gz; UV_BIN_NAME=uv; fi
  if [ -n "${ACF_UV_SOURCE:-}" ] && [ -f "${ACF_UV_SOURCE}" ]; then
    cp -f "${ACF_UV_SOURCE}" "${UV_DEST}/${UV_BIN_NAME}"
    chmod +x "${UV_DEST}/${UV_BIN_NAME}" 2>/dev/null || true
    echo "[bundle-executor] uv copied from ACF_UV_SOURCE → ${UV_DEST}/${UV_BIN_NAME}"
    UV_OK=1
  elif [ -n "${UV_OS}" ] && [ -n "${UV_ARCH}" ] && command -v curl &>/dev/null; then
    TRIPLE="${UV_ARCH}-${UV_OS}"
    TMP_UV="$(mktemp -d)"
    if curl -fsSL --max-time 300 \
        "https://github.com/astral-sh/uv/releases/download/${UV_VER}/uv-${TRIPLE}.${UV_EXT}" \
        -o "${TMP_UV}/uv.${UV_EXT}" 2>/dev/null; then
      EXTRACTED=0
      if [ "${UV_EXT}" = "zip" ]; then
        # Git Bash / MSYS 自带 unzip；缺失时退回 powershell Expand-Archive。
        if command -v unzip &>/dev/null; then
          unzip -oq "${TMP_UV}/uv.zip" -d "${TMP_UV}" 2>/dev/null && EXTRACTED=1
        elif command -v powershell.exe &>/dev/null; then
          powershell.exe -NoProfile -Command \
            "Expand-Archive -LiteralPath '$(cygpath -w "${TMP_UV}/uv.zip" 2>/dev/null || echo "${TMP_UV}/uv.zip")' -DestinationPath '$(cygpath -w "${TMP_UV}" 2>/dev/null || echo "${TMP_UV}")' -Force" \
            >/dev/null 2>&1 && EXTRACTED=1
        fi
      else
        tar -xzf "${TMP_UV}/uv.tar.gz" -C "${TMP_UV}" 2>/dev/null && EXTRACTED=1
      fi
      if [ "${EXTRACTED}" = "1" ]; then
        # 官方包内层目录名随版本变化，直接找可执行文件，不写死路径。
        UV_FOUND="$(find "${TMP_UV}" -type f \( -name 'uv' -o -name 'uv.exe' \) 2>/dev/null | head -n 1)"
        if [ -n "${UV_FOUND}" ]; then
          cp -f "${UV_FOUND}" "${UV_DEST}/${UV_BIN_NAME}"
          chmod +x "${UV_DEST}/${UV_BIN_NAME}" 2>/dev/null || true
          echo "[bundle-executor] uv ${UV_VER} (${TRIPLE}) bundled"
          UV_OK=1
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
  if [ "${UV_OK}" = "1" ]; then
    echo "[bundle-executor] uv available at ${UV_DEST}/${UV_BIN_NAME}"
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

# ---------------------------------------------------------------------------
# ACF_UV_REQUIRED=1：发布闸。**必须放在整段 uv 逻辑之后**，把上面所有
# "WARN 后继续"的路径统一收敛成一次硬失败——包括"用户根本没开 ACF_BUNDLE_UV"
# 这条最容易漏掉的路径（发布流水线忘设开关，本质上和下载失败一样致命）。
# 缺 uv 的包一旦发布，全新设备就只会上报 runtimes: shell,node，而客户端与
# 平台两侧都不会有任何"这个包是残的"提示。
# ---------------------------------------------------------------------------
if [ "${UV_REQUIRED}" = "1" ]; then
  if [ -f "${UV_DEST}/uv" ] || [ -f "${UV_DEST}/uv.exe" ]; then
    echo "[bundle-executor] ACF_UV_REQUIRED=1 → uv present, release gate passed"
  else
    echo "[bundle-executor] ERROR: ACF_UV_REQUIRED=1 but no uv was bundled." >&2
    echo "[bundle-executor]   Refusing to produce a release installer without uv: fresh devices" >&2
    echo "[bundle-executor]   would register as 'runtimes: shell, node' and every Python task" >&2
    echo "[bundle-executor]   declaring runtimeVersion would fail (desktop-v1.5.1 实爆)." >&2
    echo "[bundle-executor]   Fix one of:" >&2
    echo "[bundle-executor]     - set ACF_BUNDLE_UV=1 (and check network access to github.com)" >&2
    echo "[bundle-executor]     - provide ACF_UV_SOURCE=/path/to/uv(.exe) for an offline build" >&2
    exit 1
  fi
fi

