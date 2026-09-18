#!/bin/bash

# E-36（DEEP_REVIEW 0ef3bbe）：根级脚本补 -u/pipefail——未定义变量不再静默为空，
# 管道中途失败不再被吞。
set -euo pipefail

# ⚠ O-5（维护提示）：本脚本与 dev.sh 功能重叠，Makefile 为唯一规范入口
#   （make dev / make infra-up / ...）。本脚本保留为便捷封装，行为如有漂移
#   以 Makefile 为准。

# F-4: docker-compose v1 独立二进制 2023 年 EOL，现代 Docker 只带 `docker compose`
# v2 插件——v2 优先探测，回退 v1（与 Makefile:9 / deploy.sh compose() 同一策略）。
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "错误: 需要 docker compose v2 插件或 docker-compose v1" >&2
  exit 1
fi

# AutoFlow 开发环境启动脚本
# Usage: ./start-dev.sh [options]
# Options:
#   -h, --help           显示帮助信息

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 解析参数
while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            echo "AutoFlow 开发环境启动脚本"
            echo "Usage: ./start-dev.sh [options]"
            echo ""
            echo "Options:"
            echo "  -h, --help           显示帮助信息"
            exit 0
            ;;
        *)
            echo "未知参数: $1"
            exit 1
            ;;
    esac
done

echo -e "${GREEN}========== 启动 AutoFlow 开发环境 ==========${NC}"

# 检查环境变量文件
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}警告: .env 文件不存在，正在复制 .env.example...${NC}"
    cp .env.example .env
fi

# 创建必要的目录
mkdir -p logs
mkdir -p apps/admin-api/dist
mkdir -p apps/admin-web/dist

# 启动基础设施服务（PostgreSQL, Redis）
echo -e "${YELLOW}启动基础设施服务...${NC}"
$DC -f docker-compose.yml up -d postgres redis

# 等待基础设施启动
echo -e "${YELLOW}等待基础设施启动...${NC}"
sleep 15

# 检查 PostgreSQL 是否就绪
# E-17（DEEP_REVIEW 0ef3bbe）：勿硬编码容器名。compose 项目名默认取目录名（AutoCodeFlow
# → autocodeflow-*），容器名随 project 推导；这里按 service 名动态解析容器，新环境不再卡死。
echo -e "${YELLOW}检查 PostgreSQL...${NC}"
POSTGRES_CONTAINER="$($DC -f docker-compose.yml ps -q postgres)"
if ! docker exec "$POSTGRES_CONTAINER" pg_isready -U autoflow; then
    echo -e "${RED}PostgreSQL 未就绪，请检查日志${NC}"
    exit 1
fi

# 检查 Redis 是否就绪
echo -e "${YELLOW}检查 Redis...${NC}"
REDIS_CONTAINER="$($DC -f docker-compose.yml ps -q redis)"
# M-2: redis 已强制 requirepass——从 .env 取密码再 ping，避免 NOAUTH 误报
REDIS_PASSWORD="$(grep -E '^REDIS_PASSWORD=' .env | head -1 | cut -d= -f2- || true)"
if ! docker exec "$REDIS_CONTAINER" redis-cli -a "${REDIS_PASSWORD}" ping 2>/dev/null | grep -q PONG; then
    echo -e "${RED}Redis 未就绪，请检查日志${NC}"
    exit 1
fi

echo -e "${GREEN}基础设施服务就绪${NC}"

# 启动开发服务器
echo -e "${YELLOW}启动开发服务器...${NC}"

# 安装依赖
echo -e "${YELLOW}安装依赖...${NC}"
npm install

# 启动 admin-api
echo -e "${YELLOW}启动 admin-api...${NC}"
cd apps/admin-api && npm run start:dev &
API_PID=$!

# 等待 admin-api 启动
sleep 10

# 启动 admin-web
echo -e "${YELLOW}启动 admin-web...${NC}"
cd ../../apps/admin-web && npm run dev &
WEB_PID=$!

echo -e "${GREEN}========== AutoFlow 开发环境启动完成 ==========${NC}"
echo -e "${GREEN}管理后台: http://localhost:5176${NC}"
echo -e "${GREEN}API 服务: http://localhost:3105${NC}"
echo -e "${GREEN}API 文档: http://localhost:3105/api/docs${NC}"

# 等待进程
wait $API_PID $WEB_PID
