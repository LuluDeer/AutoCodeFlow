#!/bin/bash

set -e

# ── AutoFlow 开发环境快速启动脚本 ─────────────────────────────
# Usage: ./dev.sh [command]
# Commands:
#   start    - 启动完整开发环境（默认）
#   infra    - 仅启动基础设施
#   stop     - 停止所有服务
#   status   - 查看服务状态
#   clean    - 清理开发环境

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

CMD="${1:-start}"

print_banner() {
  echo -e "${BLUE}"
  echo "  ╔══════════════════════════════════════╗"
  echo "  ║        AutoFlow 开发环境             ║"
  echo "  ╚══════════════════════════════════════╝"
  echo -e "${NC}"
}

check_deps() {
  local missing=()

  command -v node >/dev/null 2>&1 || missing+=("Node.js (https://nodejs.org)")
  command -v npm >/dev/null 2>&1 || missing+=("npm")
  command -v python3 >/dev/null 2>&1 || missing+=("Python 3 (https://python.org)")
  command -v docker >/dev/null 2>&1 || missing+=("Docker (https://docker.com)")

  if [ ${#missing[@]} -gt 0 ]; then
    echo -e "${RED}缺少以下依赖:${NC}"
    for dep in "${missing[@]}"; do
      echo "  - $dep"
    done
    exit 1
  fi
}

setup_env() {
  # 确保 .env 文件存在
  if [ ! -f ".env" ]; then
    echo -e "${YELLOW}创建 .env 文件...${NC}"
    cp .env.example .env
    echo -e "${YELLOW}请编辑 .env 文件填入你的本地配置${NC}"
  fi

  # 确保各子项目的 .env 文件存在
  if [ ! -f "apps/admin-web/.env" ]; then
    cp apps/admin-web/.env.example apps/admin-web/.env 2>/dev/null || true
  fi
  if [ ! -f "apps/executor-python/.env" ]; then
    cp apps/executor-python/.env.example apps/executor-python/.env 2>/dev/null || true
  fi
  if [ ! -f "apps/executor-node/.env" ]; then
    cp apps/executor-node/.env.example apps/executor-node/.env 2>/dev/null || true
  fi
}

case "$CMD" in
  start)
    print_banner
    check_deps
    setup_env

    echo -e "${GREEN}==> 1/4 启动基础设施（Postgres + Redis）...${NC}"
    docker-compose -f infra/docker-compose.yml up -d 2>/dev/null || \
      docker compose -f infra/docker-compose.yml up -d

    echo -e "${YELLOW}等待基础设施就绪...${NC}"
    sleep 3

    echo -e "${GREEN}==> 2/4 安装依赖...${NC}"
    cd apps/admin-api && npm install --silent 2>/dev/null &
    cd apps/admin-web && npm install --silent 2>/dev/null &
    cd apps/executor-python && pip install -q -r requirements.txt 2>/dev/null &
    cd apps/executor-node && npm install --silent 2>/dev/null &
    wait

    echo -e "${GREEN}==> 3/4 运行数据库迁移...${NC}"
    cd apps/admin-api && npm run migration:run 2>/dev/null || echo -e "${YELLOW}迁移可能已是最新${NC}"

    echo -e "${GREEN}==> 4/4 启动开发服务...${NC}"
    echo ""
    echo -e "  ${BLUE}服务地址:${NC}"
    echo -e "    管理后台:      ${GREEN}http://localhost:5173${NC}"
    echo -e "    API 服务:      ${GREEN}http://localhost:3001${NC}"
    echo -e "    API 文档:      ${GREEN}http://localhost:3001/api/docs${NC}"
    echo -e "    Python 执行器: ${GREEN}http://localhost:8001${NC}"
    echo -e "    Node 执行器:   ${GREEN}http://localhost:8002${NC}"
    echo ""
    echo -e "  ${BLUE}默认登录:${NC}"
    echo -e "    用户名: admin"
    echo -e "    密码:   admin123"
    echo ""

    # 并行启动所有开发服务
    (cd apps/admin-api && npm run start:dev) &
    (cd apps/admin-web && npm run dev) &
    (cd apps/executor-python && uvicorn main:app --host 0.0.0.0 --port 8001 --reload) &
    (cd apps/executor-node && npm run dev) &

    echo -e "${YELLOW}按 Ctrl+C 停止所有服务${NC}"
    wait
    ;;

  infra)
    print_banner
    echo -e "${GREEN}启动基础设施...${NC}"
    docker-compose -f infra/docker-compose.yml up -d 2>/dev/null || \
      docker compose -f infra/docker-compose.yml up -d
    echo -e "${GREEN}基础设施已启动${NC}"
    echo "  Postgres: localhost:5432"
    echo "  Redis:    localhost:6379"
    ;;

  stop)
    echo -e "${YELLOW}停止所有服务...${NC}"
    docker-compose -f infra/docker-compose.yml down 2>/dev/null || true
    pkill -f "nest start" 2>/dev/null || true
    pkill -f "vite" 2>/dev/null || true
    pkill -f "uvicorn" 2>/dev/null || true
    echo -e "${GREEN}所有服务已停止${NC}"
    ;;

  status)
    echo -e "${BLUE}===== 基础设施状态 =====${NC}"
    docker-compose -f infra/docker-compose.yml ps 2>/dev/null || true
    echo ""
    echo -e "${BLUE}===== 健康检查 =====${NC}"
    curl -s http://localhost:3001/health 2>/dev/null && echo "" || echo -e "${RED}admin-api 未运行${NC}"
    curl -s http://localhost:8001/health 2>/dev/null && echo "" || echo -e "${RED}executor-python 未运行${NC}"
    curl -s http://localhost:8002/health 2>/dev/null && echo "" || echo -e "${RED}executor-node 未运行${NC}"
    ;;

  clean)
    echo -e "${YELLOW}清理开发环境...${NC}"
    docker-compose -f infra/docker-compose.yml down -v 2>/dev/null || true
    pkill -f "nest start" 2>/dev/null || true
    pkill -f "vite" 2>/dev/null || true
    pkill -f "uvicorn" 2>/dev/null || true
    echo -e "${GREEN}清理完成${NC}"
    ;;

  *)
    echo "Usage: ./dev.sh [start|infra|stop|status|clean]"
    exit 1
    ;;
esac