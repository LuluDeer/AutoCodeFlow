#!/bin/bash

set -e

# AutoFlow 部署脚本
# Usage: ./deploy.sh [options]
# Options:
#   -e, --env <env>      指定环境 (development|staging|production)，默认 development
#   -b, --build          重新构建镜像
#   -d, --detach         后台运行
#   -h, --help           显示帮助信息

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 默认参数
ENV="development"
BUILD=false
DETACH=true

# 解析参数
while [[ $# -gt 0 ]]; do
    case "$1" in
        -e|--env)
            ENV="$2"
            shift 2
            ;;
        -b|--build)
            BUILD=true
            shift
            ;;
        -d|--detach)
            DETACH=true
            shift
            ;;
        --no-detach)
            DETACH=false
            shift
            ;;
        -h|--help)
            echo "AutoFlow 部署脚本"
            echo "Usage: ./deploy.sh [options]"
            echo ""
            echo "Options:"
            echo "  -e, --env <env>      指定环境 (development|staging|production)，默认 development"
            echo "  -b, --build          重新构建镜像"
            echo "  -d, --detach         后台运行（默认）"
            echo "  --no-detach          前台运行"
            echo "  -h, --help           显示帮助信息"
            exit 0
            ;;
        *)
            echo "未知参数: $1"
            exit 1
            ;;
    esac
done

# 检查环境变量文件
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}警告: .env 文件不存在，正在复制 .env.example...${NC}"
    cp .env.example .env
    echo -e "${GREEN}.env 文件已创建，请编辑 .env 文件配置环境变量${NC}"
    exit 1
fi

# 检查 Docker 和 Docker Compose
if ! command -v docker &> /dev/null; then
    echo -e "${RED}错误: Docker 未安装，请先安装 Docker${NC}"
    exit 1
fi

if ! command -v docker-compose &> /dev/null; then
    echo -e "${RED}错误: Docker Compose 未安装，请先安装 Docker Compose${NC}"
    exit 1
fi

# 设置环境变量
export NODE_ENV="$ENV"

echo -e "${GREEN}========== 开始部署 AutoFlow ==========${NC}"
echo -e "${YELLOW}环境: $ENV${NC}"
echo -e "${YELLOW}构建镜像: $BUILD${NC}"
echo -e "${YELLOW}后台运行: $DETACH${NC}"

# 停止现有服务
echo -e "${YELLOW}停止现有服务...${NC}"
docker-compose down

# 如果需要构建
if [ "$BUILD" = true ]; then
    echo -e "${YELLOW}构建 Docker 镜像...${NC}"
    docker-compose build --no-cache
fi

# 启动服务
echo -e "${YELLOW}启动服务...${NC}"
if [ "$DETACH" = true ]; then
    docker-compose up -d
else
    docker-compose up
fi

# 等待服务启动
echo -e "${YELLOW}等待服务启动...${NC}"
sleep 30

# 检查服务状态
echo -e "${YELLOW}检查服务状态...${NC}"
docker-compose ps

# 检查健康状态
echo -e "${YELLOW}检查健康状态...${NC}"
if curl -s http://localhost:3105/health | grep -q "healthy"; then
    echo -e "${GREEN}✅ 所有服务启动成功！${NC}"
    echo -e "${GREEN}管理后台: http://localhost${NC}"
    echo -e "${GREEN}API 文档: http://localhost:3105/api/docs${NC}"
else
    echo -e "${RED}❌ 服务启动失败，请检查日志${NC}"
    docker-compose logs admin-api
    exit 1
fi

echo -e "${GREEN}========== AutoFlow 部署完成 ==========${NC}"
