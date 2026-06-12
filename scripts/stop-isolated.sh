#!/bin/bash
# AutoCodeFlow 隔离服务停止脚本

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

stop_services() {
    echo -e "${YELLOW}==> 停止 AutoCodeFlow 服务...${NC}"
    
    # 停止 Admin API
    if [ -f /tmp/autoflow-api.pid ]; then
        API_PID=$(cat /tmp/autoflow-api.pid)
        echo -e "${GREEN}停止 Admin API...${NC}"
        kill $API_PID 2>/dev/null || true
        rm -f /tmp/autoflow-api.pid
    fi
    
    # 停止 Admin Web
    if [ -f /tmp/autoflow-web.pid ]; then
        WEB_PID=$(cat /tmp/autoflow-web.pid)
        echo -e "${GREEN}停止 Admin Web...${NC}"
        kill $WEB_PID 2>/dev/null || true
        rm -f /tmp/autoflow-web.pid
    fi
    
    # 停止隔离的 Redis 服务
    if [ -f /tmp/autoflow-redis.pid ]; then
        REDIS_PID=$(cat /tmp/autoflow-redis.pid)
        echo -e "${GREEN}停止项目 Redis...${NC}"
        kill $REDIS_PID 2>/dev/null || true
        rm -f /tmp/autoflow-redis.pid
    fi
    
    # 清理残留进程
    pkill -f "nest start --watch" 2>/dev/null || true
    pkill -f "vite" 2>/dev/null || true
    
    echo -e "${GREEN}✓ 所有服务已停止${NC}"
    echo -e "${YELLOW}本机 Redis (6379) 和 MySQL (3306) 不受影响${NC}"
}

stop_services