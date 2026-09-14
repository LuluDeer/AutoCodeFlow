#!/bin/bash
# AutoCodeFlow 隔离启动脚本
# 不影响本机已有的 MySQL 和 Redis 服务

# E-36（DEEP_REVIEW 0ef3bbe）：脚本补 -u/pipefail——未定义变量不再静默为空，
# 管道中途失败不再被吞。
set -euo pipefail

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 配置变量
REDIS_PORT=6380
# E-16（DEEP_REVIEW 0ef3bbe）：移除硬编码开发者家目录绝对路径。
# 项目内路径统一由本脚本所在目录反推（脚本位于 <root>/scripts/），
# 保证在任意机器/任意 checkout 位置都能运行。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REDIS_CONF="${PROJECT_ROOT}/config/redis/autoflow-redis.conf"
REDIS_DATA_DIR="${PROJECT_ROOT}/data/redis"
API_DIR="${PROJECT_ROOT}/apps/admin-api"
WEB_DIR="${PROJECT_ROOT}/apps/admin-web"
ENV_FILE="${PROJECT_ROOT}/.env.isolated"

print_banner() {
    echo -e "${GREEN}"
    echo "=========================================="
    echo "    AutoCodeFlow 隔离启动脚本"
    echo "=========================================="
    echo "  - 项目 Redis: 端口 $REDIS_PORT"
    echo "  - 本机 Redis: 端口 6379 (不受影响)"
    echo "  - PostgreSQL: 端口 5432"
    echo "  - 本机 MySQL: 端口 3306 (不受影响)"
    echo "==========================================${NC}"
}

check_deps() {
    echo -e "${YELLOW}==> 检查依赖...${NC}"
    
    if ! command -v redis-server &> /dev/null; then
        echo -e "${RED}错误: redis-server 未安装${NC}"
        exit 1
    fi
    
    if ! command -v psql &> /dev/null; then
        echo -e "${RED}错误: psql 未安装${NC}"
        exit 1
    fi
    
    if ! command -v node &> /dev/null; then
        echo -e "${RED}错误: node 未安装${NC}"
        exit 1
    fi
    
    if ! command -v npm &> /dev/null; then
        echo -e "${RED}错误: npm 未安装${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}✓ 依赖检查通过${NC}"
}

setup_redis() {
    echo -e "${YELLOW}==> 配置隔离 Redis...${NC}"
    
    # 创建数据目录（项目本地目录，无需 sudo / redis 系统用户）
    # E-16（DEEP_REVIEW 0ef3bbe）：原系统级数据目录 + sudo chown 改为项目内 data/redis
    mkdir -p "$REDIS_DATA_DIR"
    
    # 检查端口是否被占用
    if lsof -Pi :$REDIS_PORT -sTCP:LISTEN -t >/dev/null ; then
        echo -e "${YELLOW}警告: 端口 $REDIS_PORT 已被占用，尝试停止现有服务...${NC}"
        pkill -f "redis-server.*$REDIS_PORT" || true
        sleep 2
    fi
    
    # 启动隔离的 Redis 实例
    # E-16（DEEP_REVIEW 0ef3bbe）：在子 shell 内 cd 到项目根，使 redis conf 中的相对
    # dir/logfile/pidfile（./data/redis/...）按项目根解析，不再依赖硬编码绝对路径。
    echo -e "${GREEN}启动隔离 Redis 服务 (端口: $REDIS_PORT)...${NC}"
    ( cd "$PROJECT_ROOT" && exec redis-server "$REDIS_CONF" ) &
    REDIS_PID=$!
    echo $REDIS_PID > /tmp/autoflow-redis.pid
    
    # 等待 Redis 启动
    sleep 2
    if redis-cli -p $REDIS_PORT ping | grep -q PONG; then
        echo -e "${GREEN}✓ Redis 服务启动成功${NC}"
    else
        echo -e "${RED}✗ Redis 服务启动失败${NC}"
        exit 1
    fi
}

check_postgresql() {
    echo -e "${YELLOW}==> 检查 PostgreSQL...${NC}"
    
    # 检查 PostgreSQL 是否运行
    if ! pg_isready -h localhost -p 5432 -q; then
        echo -e "${GREEN}启动 PostgreSQL...${NC}"
        sudo systemctl start postgresql
        sleep 3
    fi
    
    # 检查数据库是否存在
    if ! psql -h localhost -p 5432 -U autoflow -d autoflow -c "SELECT 1" &>/dev/null; then
        echo -e "${YELLOW}创建项目数据库...${NC}"
        sudo -u postgres psql -c "CREATE USER autoflow WITH PASSWORD 'autoflow123';" || true
        sudo -u postgres psql -c "CREATE DATABASE autoflow OWNER autoflow;" || true
        sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE autoflow TO autoflow;" || true
    fi
    
    echo -e "${GREEN}✓ PostgreSQL 检查通过${NC}"
}

install_deps() {
    echo -e "${YELLOW}==> 安装项目依赖...${NC}"
    
    # 安装 API 依赖
    if [ ! -d "$API_DIR/node_modules" ]; then
        echo -e "${GREEN}安装 API 依赖...${NC}"
        cd "$API_DIR" && npm install --silent
    fi
    
    # 安装 Web 依赖
    if [ ! -d "$WEB_DIR/node_modules" ]; then
        echo -e "${GREEN}安装 Web 依赖...${NC}"
        cd "$WEB_DIR" && npm install --silent
    fi
    
    echo -e "${GREEN}✓ 依赖安装完成${NC}"
}

run_migrations() {
    echo -e "${YELLOW}==> 运行数据库迁移...${NC}"
    
    cd "$API_DIR"
    source "$ENV_FILE"
    npm run migration:run 2>/dev/null || echo -e "${YELLOW}迁移可能已是最新${NC}"
    
    echo -e "${GREEN}✓ 数据库迁移完成${NC}"
}

start_services() {
    echo -e "${YELLOW}==> 启动服务...${NC}"
    
    # 启动 API 服务
    echo -e "${GREEN}启动 Admin API (端口: 3105)...${NC}"
    cd "$API_DIR"
    source "$ENV_FILE"
    npm run start:dev &
    API_PID=$!
    echo $API_PID > /tmp/autoflow-api.pid
    
    # 等待 API 启动
    sleep 5
    
    # 启动 Web 服务
    echo -e "${GREEN}启动 Admin Web (端口: 5176)...${NC}"
    cd "$WEB_DIR"
    npm run dev &
    WEB_PID=$!
    echo $WEB_PID > /tmp/autoflow-web.pid
    
    echo -e "\n${GREEN}==========================================${NC}"
    echo -e "${GREEN}所有服务已启动！${NC}"
    echo -e "${GREEN}==========================================${NC}"
    echo -e "${YELLOW}Admin Web: http://localhost:5176${NC}"
    echo -e "${YELLOW}Admin API: http://localhost:3105${NC}"
    echo -e "${YELLOW}项目 Redis: localhost:$REDIS_PORT${NC}"
    echo -e "${GREEN}==========================================${NC}"
    echo -e "${YELLOW}按 Ctrl+C 停止所有服务${NC}"
    
    wait
}

# 主流程
print_banner
check_deps
setup_redis
check_postgresql
install_deps
run_migrations
start_services
