#!/bin/bash

# E-36（DEEP_REVIEW 0ef3bbe）：根级脚本补 -u/pipefail——未定义变量不再静默为空
# （.env 缺键时 PGPASSWORD="" 不致空口令尝试），管道中途失败不再被吞。
set -euo pipefail

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

# E-28（DEEP_REVIEW 0ef3bbe）：docker-compose v1 独立二进制 2023 年起 EOL，现代
# Docker Desktop/Engine 只带 `docker compose` v2 插件。统一 helper：优先 v2 插件，
# 回退 v1 独立二进制（兼容老环境）。脚本内不再硬编码 v1 命令。
compose() {
    if docker compose version &> /dev/null; then
        docker compose "$@"
    elif command -v docker-compose &> /dev/null; then
        docker-compose "$@"
    else
        echo -e "${RED}错误: Docker Compose 未安装（需要 `docker compose` v2 插件或 docker-compose v1）${NC}"
        exit 1
    fi
}

# 设置环境变量
export NODE_ENV="$ENV"

echo -e "${GREEN}========== 开始部署 AutoFlow ==========${NC}"
echo -e "${YELLOW}环境: $ENV${NC}"
echo -e "${YELLOW}构建镜像: $BUILD${NC}"
echo -e "${YELLOW}后台运行: $DETACH${NC}"

# 停止现有服务
echo -e "${YELLOW}停止现有服务...${NC}"
compose down

# 如果需要构建
if [ "$BUILD" = true ]; then
    echo -e "${YELLOW}构建 Docker 镜像...${NC}"
    compose build --no-cache
fi

# 启动服务
echo -e "${YELLOW}启动服务...${NC}"
if [ "$DETACH" = true ]; then
    compose up -d
else
    compose up
fi

# 等待服务启动
echo -e "${YELLOW}等待服务启动...${NC}"
sleep 30

# 检查服务状态
echo -e "${YELLOW}检查服务状态...${NC}"
compose ps

# 检查健康状态
echo -e "${YELLOW}检查健康状态...${NC}"
# E-28（DEEP_REVIEW 0ef3bbe）：健康检查端点统一为 /api/health/live（admin-api
# 全局前缀 api，liveness 端点返回 {"status":"healthy"} JSON）——旧实现打
# /api/health 与 S2 注释声明的 /api/health/live 漂移，现对齐。
if curl -fsS http://localhost:3105/api/health/live | grep -q "healthy"; then
    echo -e "${GREEN}✅ 所有服务启动成功！${NC}"
    echo -e "${GREEN}管理后台: http://localhost${NC}"
    echo -e "${GREEN}API 文档: http://localhost:3105/api/docs${NC}"
else
    echo -e "${RED}❌ 服务启动失败，请检查日志${NC}"
    compose logs admin-api
    exit 1
fi

echo -e "${GREEN}========== AutoFlow 部署完成 ==========${NC}"
