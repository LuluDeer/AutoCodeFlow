#!/bin/bash

set -e

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
docker-compose -f docker-compose.yml up -d postgres redis

# 等待基础设施启动
echo -e "${YELLOW}等待基础设施启动...${NC}"
sleep 15

# 检查 PostgreSQL 是否就绪
echo -e "${YELLOW}检查 PostgreSQL...${NC}"
if ! docker exec autoflow-postgres-1 pg_isready -U autoflow; then
    echo -e "${RED}PostgreSQL 未就绪，请检查日志${NC}"
    exit 1
fi

# 检查 Redis 是否就绪
echo -e "${YELLOW}检查 Redis...${NC}"
if ! docker exec autoflow-redis-1 redis-cli ping | grep -q PONG; then
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
echo -e "${GREEN}管理后台: http://localhost:5173${NC}"
echo -e "${GREEN}API 服务: http://localhost:3001${NC}"
echo -e "${GREEN}API 文档: http://localhost:3001/api/docs${NC}"

# 等待进程
wait $API_PID $WEB_PID
