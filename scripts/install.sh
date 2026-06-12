#!/usr/bin/env bash
# AutoCodeFlow Executor 一键安装脚本
# 用法: curl -fsSL https://<admin>/install.sh | bash -s -- --api-url http://admin:3105 --secret mysecret
# 或本地运行: bash install.sh --api-url http://... --secret ...
set -euo pipefail

# ── 默认值 ──────────────────────────────────────────────────────────────────
ADMIN_API_URL=""
EXECUTOR_SECRET=""
APP_NAME="executor-node-$(hostname | tr '.' '-')"
PORT="8002"
RUNTIME="node"        # node | python | universal
WORK_DIR="/var/lib/autoflow/tasks"
INSTALL_DIR="/opt/autoflow-executor"
SERVICE_NAME="autoflow-executor"
NODE_VERSION="20"

# ── 参数解析 ─────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url)   ADMIN_API_URL="$2";   shift 2 ;;
    --secret)    EXECUTOR_SECRET="$2"; shift 2 ;;
    --name)      APP_NAME="$2";        shift 2 ;;
    --port)      PORT="$2";            shift 2 ;;
    --runtime)   RUNTIME="$2";         shift 2 ;;
    --work-dir)  WORK_DIR="$2";        shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$ADMIN_API_URL" || -z "$EXECUTOR_SECRET" ]]; then
  echo "错误：必须提供 --api-url 和 --secret 参数"
  echo "示例: bash install.sh --api-url http://192.168.1.100:3105 --secret your-secret"
  exit 1
fi

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

# ── 下载执行器代码 ─────────────────────────────────────────────────────────────
echo "[3/6] 下载执行器..."
# 优先从 admin-api 静态资源下载，fallback 到 git clone
EXECUTOR_PKG_URL="${ADMIN_API_URL}/static/executor-node.tar.gz"
if curl -fsSL --max-time 30 "$EXECUTOR_PKG_URL" -o /tmp/executor-node.tar.gz 2>/dev/null; then
  echo "      从 admin-api 下载安装包..."
  tar -xzf /tmp/executor-node.tar.gz -C "$INSTALL_DIR" --strip-components=1
  rm /tmp/executor-node.tar.gz
else
  echo "      安装包不可用，从项目目录复制（本地安装）..."
  # 本地开发环境：从当前目录查找
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  EXECUTOR_SRC="$(dirname "$SCRIPT_DIR")/apps/executor-node"
  if [[ -d "$EXECUTOR_SRC" ]]; then
    cp -r "$EXECUTOR_SRC/"* "$INSTALL_DIR/"
  else
    echo "      无法找到执行器源码，请检查路径"
    exit 1
  fi
fi

# ── 安装 npm 依赖 ──────────────────────────────────────────────────────────────
echo "[4/6] 安装 npm 依赖..."
cd "$INSTALL_DIR"
if [[ -f package.json ]]; then
  npm install --production --silent
fi

# 编译 TypeScript（如果有 tsconfig）
if [[ -f tsconfig.json ]] && check_cmd npx; then
  npx tsc --noEmit 2>/dev/null || true
  if [[ -f tsconfig.build.json ]]; then
    npx tsc -p tsconfig.build.json 2>/dev/null || true
  fi
fi

# ── 写入配置文件 ───────────────────────────────────────────────────────────────
echo "[5/6] 写入配置..."
DETECTED_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo '127.0.0.1')"
cat > "${INSTALL_DIR}/.env" <<EOF
APP_NAME=${APP_NAME}
PORT=${PORT}
EXECUTOR_ADDRESS=${DETECTED_IP}:${PORT}
EXECUTOR_ADDRESS_PUBLIC=${DETECTED_IP}:${PORT}
ADMIN_API_URL=${ADMIN_API_URL}
EXECUTOR_SECRET=${EXECUTOR_SECRET}
WORK_DIR=${WORK_DIR}
MAX_CONCURRENT_TASKS=10
LOG_RETENTION_DAYS=7
EOF
echo "      配置已写入 ${INSTALL_DIR}/.env"

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
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=AutoCodeFlow Executor
After=network.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=${EXEC_CMD}
Restart=always
RestartSec=5
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
