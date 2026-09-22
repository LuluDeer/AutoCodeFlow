#!/usr/bin/env bash
# 本脚本是安装脚本唯一事实源（E-38）：apps/admin-api/src/modules/executor/install-script.content.ts
# 由 scripts/gen-install-script-content.mjs 在构建期自动生成，后端经 GET /api/executors/install.sh 下发该副本。
# 修改安装脚本请只改本文件，然后跑 npm run gen:install-script（或 prebuild 自动跑）；CI 以 check:install-script-sync 守卫同步。
# AutoCodeFlow Executor 一键安装脚本
# 用法: curl -fsSL https://<admin>/install.sh | bash -s -- --api-url http://admin:3105 --secret mysecret
# 或本地运行: bash install.sh --api-url http://... --secret ...
# NAT/内网（中台无法主动连本机）: 追加 --pull（执行器主动回连中台取任务）
set -euo pipefail

# ── 平台探测（R-02 / windows-findings W-01：本脚本仅支持 Linux）──────────────
# 依赖 systemd 与 POSIX 路径；Windows 原生 / Git-Bash / macOS 均不可用，
# 直接失败并给出手动部署指引，避免跑到 systemctl 一步才炸。
case "$(uname -s)" in
  Linux*) ;;
  *)
    echo "错误：一键安装脚本仅支持 Linux（检测到: $(uname -s)）。" >&2
    echo "Windows 部署请按 docs/deployment.md 的「Windows 手动部署」章节：" >&2
    echo "  1) 安装 Node.js 24.x；2) 配置 .env（ADMIN_API_URL / EXECUTOR_SHARED_TOKEN / WORK_DIR）；" >&2
    echo "  3) node dist/main.js 启动，并用「任务计划程序」替代 systemd。" >&2
    exit 1 ;;
esac

# ── 默认值 ──────────────────────────────────────────────────────────────────
ADMIN_API_URL=""
EXECUTOR_SECRET=""
APP_NAME="executor-node-$(hostname | tr '.' '-')"
PORT="8002"
RUNTIME="node"        # node | python | universal
# P0-9（UX-AUDIT-2026-09-21）：网络模式。push（默认，中台主动连执行器）或
# pull（执行器主动长轮询中台取任务，ADR-016）——**NAT/内网后唯一可用**。
# 此前脚本没有这个开关，内网机器只能手改 .env，而"官方一键安装"装出来的
# 执行器永远是 push：注册成功、列表显示在线，但中台入站 POST 永远到不了它。
PULL_MODE="false"
WORK_DIR="/var/lib/autoflow/tasks"
INSTALL_DIR="/opt/autoflow-executor"
SERVICE_NAME="autoflow-executor"
# E-31（DEEP_REVIEW 0ef3bbe）：旧值 "20" 与本文件头注「安装 Node.js 24.x」矛盾，
# 且 node 20 已入弃用周期（CI ci.yml 全部 setup-node pin 在 24，lockfile 由 npm 11
# 生成、node 20 自带 npm 10 解析行为不同）。统一为 24，与头注/CI 对齐；仍可用环境
# 变量 EXECUTOR_NODE_VERSION 覆盖（如临时回退验证）。
NODE_VERSION="${EXECUTOR_NODE_VERSION:-24}"

# ── 参数解析 ─────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url)   ADMIN_API_URL="$2";   shift 2 ;;
    --secret)    EXECUTOR_SECRET="$2"; shift 2 ;;
    --name)      APP_NAME="$2";        shift 2 ;;
    --port)      PORT="$2";            shift 2 ;;
    --runtime)   RUNTIME="$2";         shift 2 ;;
    --work-dir)  WORK_DIR="$2";        shift 2 ;;
    --install-dir) INSTALL_DIR="$2";  shift 2 ;;
    --pull)      PULL_MODE="true";     shift 1 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$ADMIN_API_URL" || -z "$EXECUTOR_SECRET" ]]; then
  echo "错误：必须提供 --api-url 和 --secret 参数"
  echo "示例: bash install.sh --api-url http://192.168.1.100:3105 --secret your-secret"
  exit 1
fi

# ── 参数校验 ──────────────────────────────────────────────────────────────────
# 这些值会写入 .env（systemd EnvironmentFile）与 systemd unit，含换行/引号等字符
# 可向其中注入伪造键值对（如改写 EXECUTOR_SECRET），故在任何写操作前做白名单校验。
die() { echo "错误：$1"; exit 1; }

if [[ ! "$PORT" =~ ^[0-9]{1,5}$ ]] || (( 10#$PORT < 1 || 10#$PORT > 65535 )); then
  die "--port 必须是 1-65535 的整数（收到: $PORT）"
fi
if [[ ! "$APP_NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
  die "--name 只允许字母、数字、点、下划线、连字符（不允许空白/斜杠/引号等字符）"
fi
if [[ ! "$WORK_DIR" =~ ^/[A-Za-z0-9._/-]*$ ]]; then
  die "--work-dir 必须是只含字母、数字、点、下划线、连字符与斜杠的绝对路径"
fi
if [[ ! "$INSTALL_DIR" =~ ^/[A-Za-z0-9._/-]*$ ]]; then
  die "--install-dir 必须是只含字母、数字、点、下划线、连字符与斜杠的绝对路径"
fi
case "$RUNTIME" in
  node|python|universal) ;;
  *) die "--runtime 只支持 node | python | universal（收到: $RUNTIME）" ;;
esac

# SEC-INSTALL-01：ADMIN_API_URL / EXECUTOR_SECRET 此前**未做任何校验**就写进
# .env（见下方 heredoc）。二者都会原样落到 systemd EnvironmentFile，含换行的
# 值可注入伪造键值对——例如 secret 里塞 "\nREQUIRE_TOKEN=false" 即可绕过
# E-09/E-25 的 fail-closed 兜底（auth.ts 仅当 REQUIRE_TOKEN === 'true' 才拒
# 绝未认证请求）。伪造成立的原因是 heredoc 会先写出攻击者的键、再写出脚本自己
# 的键，而 EnvironmentFile 取先出现的赋值。
#
# 修法与 executor-node 的 deploy.ts 对齐（该处早有 formatDotenvValue 处理同类
# 问题并有测试）：值一律用双引号包裹并转义 \ " CR LF，键名走白名单。
# URL 额外做协议与字符白名单校验——它还会被写进 .env 与调用链。
# 允许方括号以支撑 IPv6 字面量（http://[::1]:3105）——这是合法配置，
# 漏掉会把真实用户挡在门外。
# 注意写法：bash 的 =~ 里不能用 \[ \] 转义方括号（会被当成字面量反斜杠，
# 导致整个字符类失配、连普通 IPv4 都被拒），必须用 POSIX 形态把 ] 放首位。
if [[ ! "$ADMIN_API_URL" =~ ^https?://[]A-Za-z0-9._:/@%[-]+$ ]]; then
  die "--api-url 必须是 http(s):// 开头的合法地址，且只含字母、数字、点、下划线、连字符、冒号、斜杠、@、%、方括号（IPv6）（收到: $ADMIN_API_URL）"
fi
# secret 不允许换行/回车/引号/反斜杠：既是本次注入的入口，也会让后续
# 转义产生歧义。正常共享密钥不会包含这些字符。
if [[ ! "$EXECUTOR_SECRET" =~ ^[A-Za-z0-9._~+/=-]+$ ]]; then
  die "--secret 只允许字母、数字与 . _ ~ + / = -（不允许空白/换行/引号/反斜杠）"
fi

# dotenv/systemd EnvironmentFile 值的转义：反斜杠 → \\，双引号 → \"，
# CR → \r，LF → \n，并用双引号包裹整体。
dotenv_escape() {
  local v="$1"
  v="${v//\\/\\\\}"
  v="${v//\"/\\\"}"
  v="${v//$'\r'/\\r}"
  v="${v//$'\n'/\\n}"
  printf '"%s"' "$v"
}

ADMIN_API_URL_ESC="$(dotenv_escape "$ADMIN_API_URL")"
EXECUTOR_SECRET_ESC="$(dotenv_escape "$EXECUTOR_SECRET")"
APP_NAME_ESC="$(dotenv_escape "$APP_NAME")"
WORK_DIR_ESC="$(dotenv_escape "$WORK_DIR")"

echo "=== AutoCodeFlow 执行器安装 ==="
echo "Admin API : $ADMIN_API_URL"
echo "App Name  : $APP_NAME"
echo "Port      : $PORT"
echo "Runtime   : $RUNTIME"
echo "Work Dir  : $WORK_DIR"
echo "Install   : $INSTALL_DIR"
echo ""

# ── 系统依赖检测 ──────────────────────────────────────────────────────────────
check_cmd() { command -v "$1" &>/dev/null; }

OS="$(uname -s)"
ARCH="$(uname -m)"
echo "[1/6] 检测系统环境: $OS / $ARCH"

# Node.js
if ! check_cmd node; then
  echo "      安装 Node.js $NODE_VERSION..."
  if check_cmd apt-get; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y nodejs
  elif check_cmd yum; then
    curl -fsSL https://rpm.nodesource.com/setup_${NODE_VERSION}.x | bash -
    yum install -y nodejs
  elif check_cmd brew; then
    brew install node@${NODE_VERSION}
  else
    echo "      无法自动安装 Node.js，请手动安装后重试"
    exit 1
  fi
fi
echo "      Node.js: $(node --version)"

# Python (optional, for python/universal runtime)
if [[ "$RUNTIME" == "python" || "$RUNTIME" == "universal" ]]; then
  if ! check_cmd python3; then
    echo "      安装 Python3..."
    if check_cmd apt-get; then apt-get install -y python3 python3-venv python3-pip;
    elif check_cmd yum; then yum install -y python3;
    fi
  fi
  echo "      Python3: $(python3 --version)"
fi

# git
if ! check_cmd git; then
  echo "      安装 git..."
  if check_cmd apt-get; then apt-get install -y git;
  elif check_cmd yum; then yum install -y git;
  elif check_cmd brew; then brew install git;
  fi
fi
echo "      git: $(git --version)"

# ── 创建目录 ──────────────────────────────────────────────────────────────────
echo "[2/6] 创建安装目录..."
mkdir -p "$INSTALL_DIR" "$WORK_DIR"

# E-09（DEEP_REVIEW 0ef3bbe）：创建专用非 root 用户并 chown 目录——
# 容器部署已是 non-root，裸机 systemd 部署此前以 root 常驻。幂等：
# useradd -r 已存在时静默返回非零 || true。
EXECUTOR_USER="autocodeflow"
if ! id "$EXECUTOR_USER" &>/dev/null; then
  useradd -r -s /usr/sbin/nologin -m -d /var/lib/"$EXECUTOR_USER" "$EXECUTOR_USER" || true
fi
chown -R "$EXECUTOR_USER":"$EXECUTOR_USER" "$INSTALL_DIR" "$WORK_DIR"

# ── 安装执行器代码 ────────────────────────────────────────────────────────────
echo "[3/6] 安装执行器..."
# R8（N24 根治）：真 artifact 通道。后端承载
# GET /api/executors/artifact/executor-node.tar.gz（@Public + 共享 token，
# Bearer 头或 ?token= 均可），产物由 scripts/bundle-executor-artifact.sh 生成
# （dist + package.json + 生产 node_modules），放入 admin-api 的
# EXECUTOR_ARTIFACT_DIR（默认 <cwd>/artifacts）。裸机 curl|bash 不再依赖
# 项目 checkout；下载失败时回退到本地 checkout 副本（开发场景）。
ARTIFACT_URL="${ADMIN_API_URL%/}/api/executors/artifact/executor-node.tar.gz"
TMP_PKG="$(mktemp /tmp/acf-executor-artifact.XXXXXX)"
TMP_HEADERS="$(mktemp /tmp/acf-executor-headers.XXXXXX)"
trap 'rm -f "$TMP_PKG" "$TMP_HEADERS" "${TMP_PKG}.sha256"' EXIT
REMOTE_OK=0
# -D 把响应头落盘，供 E-P2-P6 提取 X-SHA256（跨跳时多个响应头块，取最后一条）。
if curl -fsSL --connect-timeout 10 --retry 2 \
     -H "Authorization: Bearer ${EXECUTOR_SECRET}" \
     -D "$TMP_HEADERS" \
     "$ARTIFACT_URL" -o "$TMP_PKG"; then
  # E-P2-P6（阶段一跨端 sha256 校验）：解压前完整性核对。后端 artifact 下载
  # 路由在响应头下发 X-SHA256（commit c308b988）。响应带该头时，落盘字节必须
  # 与其一致——不符即删除可疑产物并非零退出（绝不静默解压、也不回退本地副本：
  # 损坏/篡改必须显式失败）。无该头（旧后端，或暂未下发该头的
  # /api/executors/artifact 通道）按既有容忍策略放行，仅做后续 tar 结构检查——
  # 这是与旧后端并存的过渡态。
  EXPECTED_SHA="$(grep -i '^X-SHA256:' "$TMP_HEADERS" | tr -d '\r' | awk '{print $2}' | tail -n1 | tr '[:upper:]' '[:lower:]' || true)"
  if [[ -n "$EXPECTED_SHA" ]]; then
    # 对齐 sha256sum -c 约定：校验文件内写 "<hash>  <绝对路径>"（两空格分隔）。
    echo "$EXPECTED_SHA  $TMP_PKG" > "${TMP_PKG}.sha256"
    if ! sha256sum -c "${TMP_PKG}.sha256" >/dev/null 2>&1; then
      ACTUAL_SHA="$(sha256sum "$TMP_PKG" | awk '{print $1}')"
      rm -f "$TMP_PKG"
      echo "错误：执行器 artifact sha256 校验失败（X-SHA256 响应头与落盘字节不符，疑似损坏或被篡改）" >&2
      echo "  期望: $EXPECTED_SHA" >&2
      echo "  实际: $ACTUAL_SHA" >&2
      exit 1
    fi
    echo "      sha256 校验通过（X-SHA256）"
  else
    echo "      响应未下发 X-SHA256 头（旧后端），跳过完整性校验"
  fi
  if tar -tzf "$TMP_PKG" >/dev/null 2>&1; then
    REMOTE_OK=1
  fi
fi
if [[ "$REMOTE_OK" == "1" ]]; then
  echo "      从 Admin API 下载执行器 artifact..."
  tar -xzf "$TMP_PKG" -C "$INSTALL_DIR"
else
  echo "      artifact 下载失败，回退本地 checkout..."
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  EXECUTOR_SRC="$(dirname "$SCRIPT_DIR")/apps/executor-node"
  if [[ -d "$EXECUTOR_SRC" ]]; then
    echo "      从项目目录复制（本地安装）..."
    cp -r "$EXECUTOR_SRC/"* "$INSTALL_DIR/"
  else
    die "无法从 ${ARTIFACT_URL} 下载 artifact（确认 admin-api 已启动，且 EXECUTOR_ARTIFACT_DIR 下有 scripts/bundle-executor-artifact.sh 生成的 executor-node.tar.gz），且本脚本不在项目 checkout 内、无本地副本可回退"
  fi
fi
rm -f "$TMP_PKG" "${TMP_PKG}.sha256"

# ── 安装 npm 依赖 ──────────────────────────────────────────────────────────────
echo "[4/6] 安装 npm 依赖..."
cd "$INSTALL_DIR"
if [[ -d node_modules ]]; then
  echo "      artifact 已含生产依赖，跳过 npm install"
elif [[ -f package.json ]]; then
  # E-P2-P3: npm 9+ 废弃 --production，改 --omit=dev。本地 checkout 无 dist，需
  # devDependencies(typescript) 才能编译；仅 artifact（已有 dist/main.js）省略 dev。
  if [[ -f dist/main.js ]]; then
    npm install --omit=dev --silent
  else
    npm install --silent
  fi
fi

# 编译 TypeScript：仅本地 checkout 回退需要（artifact 自带 dist/main.js）。
# E-P2-P3：旧逻辑只跑 `tsc --noEmit`（不产出）并检测不存在的 tsconfig.build.json，
# 回退安装永远没有 dist。改为按 tsconfig.json 真正 emit（outDir=./dist）；失败即报错。
if [[ ! -f dist/main.js ]] && [[ -f tsconfig.json ]] && check_cmd npx; then
  echo "      本地 checkout：编译 TypeScript 到 dist/..."
  npx tsc -p tsconfig.json
fi

# ── 写入配置文件 ───────────────────────────────────────────────────────────────
echo "[5/6] 写入配置..."
DETECTED_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo '127.0.0.1')"
# SEC-INSTALL-01：所有来自命令行的值一律走 dotenv_escape（转义 + 双引号包裹），
# 绝不再裸插值——裸插值正是本文件此前 .env 注入的根因。
cat > "${INSTALL_DIR}/.env" <<EOF
APP_NAME=${APP_NAME_ESC}
PORT=${PORT}
EXECUTOR_ADDRESS=${DETECTED_IP}:${PORT}
EXECUTOR_ADDRESS_PUBLIC=${DETECTED_IP}:${PORT}
ADMIN_API_URL=${ADMIN_API_URL_ESC}
EXECUTOR_SECRET=${EXECUTOR_SECRET_ESC}
WORK_DIR=${WORK_DIR_ESC}
MAX_CONCURRENT_TASKS=10
LOG_RETENTION_DAYS=7
# E-09/E-25（DEEP_REVIEW 0ef3bbe）：fail-closed——token 未配置时拒绝
# 所有未认证请求（503），而非 dev-mode 静默放行。与容器部署基线对齐。
REQUIRE_TOKEN=true
# P0-9：回连模式开关（--pull 时为 true）。push 模式显式写 false 而非省略——
# 与向导展示的环境变量块保持一致，且语义明确。
EXECUTOR_PULL_MODE=${PULL_MODE}
EOF
# 权限收紧：.env 含共享密钥，不可被同机其他用户读取（systemd 以
# EXECUTOR_USER 运行，root 安装时需要让该用户可读）。
chmod 600 "${INSTALL_DIR}/.env" 2>/dev/null || true
if [[ "$(id -u)" -eq 0 ]] && id "$EXECUTOR_USER" &>/dev/null; then
  chown "$EXECUTOR_USER":"$EXECUTOR_USER" "${INSTALL_DIR}/.env" 2>/dev/null || true
fi
echo "      配置已写入 ${INSTALL_DIR}/.env（权限 600，含共享密钥）"

# ── 注册 systemd 服务 ──────────────────────────────────────────────────────────
echo "[6/6] 注册系统服务..."

# 判断启动命令
if [[ -f "${INSTALL_DIR}/dist/main.js" ]]; then
  EXEC_CMD="node ${INSTALL_DIR}/dist/main.js"
elif [[ -f "${INSTALL_DIR}/src/main.ts" ]] && check_cmd npx; then
  EXEC_CMD="npx ts-node ${INSTALL_DIR}/src/main.ts"
else
  EXEC_CMD="node ${INSTALL_DIR}/main.js"
fi

if check_cmd systemctl; then
  # E-09（DEEP_REVIEW 0ef3bbe）：systemd 沙箱加固——非 root 运行 + 基础
  # 隔离指令，对齐容器部署基线（non-root + no-new-privileges）。
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=AutoCodeFlow Executor
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=${EXECUTOR_USER}
Group=${EXECUTOR_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=${EXEC_CMD}
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${WORK_DIR} ${INSTALL_DIR}
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
  sleep 2

  if systemctl is-active --quiet "$SERVICE_NAME"; then
    echo ""
    echo "✅ 执行器安装成功并已启动！"
    echo "   服务名称: $SERVICE_NAME"
    echo "   监听地址: ${DETECTED_IP}:${PORT}"
    echo "   工作目录: $WORK_DIR"
    echo "   查看日志: journalctl -u $SERVICE_NAME -f"
    echo "   停止服务: systemctl stop $SERVICE_NAME"
  else
    echo "⚠️  服务启动失败，请检查日志: journalctl -u $SERVICE_NAME -n 50"
    exit 1
  fi
else
  # 非 systemd 系统（macOS / WSL 等），直接后台启动
  echo "      非 systemd 系统，直接启动执行器..."
  nohup $EXEC_CMD > "${INSTALL_DIR}/executor.log" 2>&1 &
  EXEC_PID=$!
  echo $EXEC_PID > "${INSTALL_DIR}/executor.pid"
  sleep 2
  if kill -0 $EXEC_PID 2>/dev/null; then
    echo ""
    echo "✅ 执行器已启动（PID: $EXEC_PID）"
    echo "   日志文件: ${INSTALL_DIR}/executor.log"
    echo "   停止: kill \$(cat ${INSTALL_DIR}/executor.pid)"
  else
    echo "⚠️  执行器启动失败，请检查: ${INSTALL_DIR}/executor.log"
    exit 1
  fi
fi
