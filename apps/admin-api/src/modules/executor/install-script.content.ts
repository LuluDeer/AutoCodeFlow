import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * install.sh 的单一事实源（后端承载副本）：GET /api/executors/install.sh 以此常量
 * 作为 text/plain 响应体下发，供目标机 `curl -fsSL ... | bash -s -- ...` 安装执行器。
 * 内容与仓库根 scripts/install.sh 互为拷贝，修改时请同步两处。
 */
export const INSTALL_SCRIPT = `#!/usr/bin/env bash
# 注意：本脚本与 apps/admin-api/src/modules/executor/install-script.content.ts 互为拷贝（后端经 GET /api/executors/install.sh 下发该副本），修改时请同步两处。
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
case "$RUNTIME" in
  node|python|universal) ;;
  *) die "--runtime 只支持 node | python | universal（收到: $RUNTIME）" ;;
esac

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
    curl -fsSL https://deb.nodesource.com/setup_\${NODE_VERSION}.x | bash -
    apt-get install -y nodejs
  elif check_cmd yum; then
    curl -fsSL https://rpm.nodesource.com/setup_\${NODE_VERSION}.x | bash -
    yum install -y nodejs
  elif check_cmd brew; then
    brew install node@\${NODE_VERSION}
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

# ── 安装执行器代码 ────────────────────────────────────────────────────────────
echo "[3/6] 安装执行器..."
# N24: 旧版此处从 \${ADMIN_API_URL}/static/executor-node.tar.gz 下载，但后端
# 从未承载该静态资源（永远 404 落入本地兜底，形成假承诺）。已删除远程下载
# 分支：本脚本只在项目 checkout 内可用；裸机安装需先经 executor-packages
# API 获取构件。
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
EXECUTOR_SRC="$(dirname "$SCRIPT_DIR")/apps/executor-node"
if [[ -d "$EXECUTOR_SRC" ]]; then
  echo "      从项目目录复制（本地安装）..."
  cp -r "$EXECUTOR_SRC/"* "$INSTALL_DIR/"
else
  echo "      executor-node artifact not bundled in this script; obtain the artifact via executor-packages API or run from a project checkout"
  exit 1
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
cat > "\${INSTALL_DIR}/.env" <<EOF
APP_NAME=\${APP_NAME}
PORT=\${PORT}
EXECUTOR_ADDRESS=\${DETECTED_IP}:\${PORT}
EXECUTOR_ADDRESS_PUBLIC=\${DETECTED_IP}:\${PORT}
ADMIN_API_URL=\${ADMIN_API_URL}
EXECUTOR_SECRET=\${EXECUTOR_SECRET}
WORK_DIR=\${WORK_DIR}
MAX_CONCURRENT_TASKS=10
LOG_RETENTION_DAYS=7
EOF
echo "      配置已写入 \${INSTALL_DIR}/.env"

# ── 注册 systemd 服务 ──────────────────────────────────────────────────────────
echo "[6/6] 注册系统服务..."

# 判断启动命令
if [[ -f "\${INSTALL_DIR}/dist/main.js" ]]; then
  EXEC_CMD="node \${INSTALL_DIR}/dist/main.js"
elif [[ -f "\${INSTALL_DIR}/src/main.ts" ]] && check_cmd npx; then
  EXEC_CMD="npx ts-node \${INSTALL_DIR}/src/main.ts"
else
  EXEC_CMD="node \${INSTALL_DIR}/main.js"
fi

if check_cmd systemctl; then
  cat > "/etc/systemd/system/\${SERVICE_NAME}.service" <<EOF
[Unit]
Description=AutoCodeFlow Executor
After=network.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=\${INSTALL_DIR}
EnvironmentFile=\${INSTALL_DIR}/.env
ExecStart=\${EXEC_CMD}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=\${SERVICE_NAME}

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
    echo "   监听地址: \${DETECTED_IP}:\${PORT}"
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
  nohup $EXEC_CMD > "\${INSTALL_DIR}/executor.log" 2>&1 &
  EXEC_PID=$!
  echo $EXEC_PID > "\${INSTALL_DIR}/executor.pid"
  sleep 2
  if kill -0 $EXEC_PID 2>/dev/null; then
    echo ""
    echo "✅ 执行器已启动（PID: $EXEC_PID）"
    echo "   日志文件: \${INSTALL_DIR}/executor.log"
    echo "   停止: kill \\$(cat \${INSTALL_DIR}/executor.pid)"
  else
    echo "⚠️  执行器启动失败，请检查: \${INSTALL_DIR}/executor.log"
    exit 1
  fi
fi
`;

/**
 * 测试守卫用：校验常量与仓库根 scripts/install.sh 逐字节一致（防两副本漂移）。
 * 构建产物（dist）中仓库根不可达时返回 null，调用方自行跳过。
 */
export function repoInstallScriptOrNull(): string | null {
  try {
    const p = resolve(__dirname, "../../../../../scripts/install.sh");
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
