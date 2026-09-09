.PHONY: help dev install infra-up infra-down build start stop restart clean test lint typecheck db-migrate db-seed logs status

# ── AutoFlow 开发命令入口 ──────────────────────────────────────
# 所有命令均可通过 make <target> 调用

help: ## 显示所有可用命令
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ── 开发环境 ──────────────────────────────────────────────────
dev: ## 启动完整开发环境（基础设施 + 所有服务）
	@echo "==> 启动基础设施（Postgres + Redis）..."
	docker-compose -f infra/docker-compose.yml up -d
	@echo "==> 等待基础设施就绪..."
	@sleep 5
	@echo "==> 安装依赖..."
	cd apps/admin-api && npm install
	cd apps/admin-web && npm install
	cd apps/executor-python && ([ -d .venv ] || python3 -m venv .venv) && .venv/bin/pip install -r requirements.txt
	cd apps/executor-node && npm install
	@echo "==> 运行数据库迁移..."
	cd apps/admin-api && npm run migration:run
	@echo "==> 启动所有开发服务..."
	@echo "  admin-api:       http://localhost:3105"
	@echo "  admin-web:       http://localhost:5176"
	@echo "  executor-python: http://localhost:8001"
	@echo "  executor-node:   http://localhost:8002"
	@echo "  API Docs:        http://localhost:3105/api/docs"
	cd apps/admin-api && npm run start:dev &
	cd apps/admin-web && npm run dev &
	cd apps/executor-python && .venv/bin/uvicorn main:app --host 0.0.0.0 --port 8001 --reload &
	cd apps/executor-node && npm run dev &
	@wait

install: ## 安装所有项目依赖
	cd apps/admin-api && npm install
	cd apps/admin-web && npm install
	cd apps/executor-python && ([ -d .venv ] || python3 -m venv .venv) && .venv/bin/pip install -r requirements.txt
	cd apps/executor-node && npm install
	@echo "==> 所有依赖安装完成"

# ── 基础设施 ──────────────────────────────────────────────────
infra-up: ## 仅启动基础设施（Postgres + Redis）
	docker-compose -f infra/docker-compose.yml up -d
	@echo "==> 基础设施已启动"
	@echo "  Postgres: localhost:5432"
	@echo "  Redis:    localhost:6379"

infra-down: ## 停止基础设施
	docker-compose -f infra/docker-compose.yml down
	@echo "==> 基础设施已停止"

# ── 构建与部署 ──────────────────────────────────────────────
build: ## 构建所有 Docker 镜像
	docker-compose build
	@echo "==> 镜像构建完成"

start: ## 启动完整服务（生产模式）
	docker-compose up -d
	@echo "==> 服务已启动"

stop: ## 停止所有服务
	docker-compose down
	@echo "==> 服务已停止"

restart: stop start ## 重启所有服务

# ── 代码质量 ──────────────────────────────────────────────────
# ARCH-20: 委托给根 package.json 的统一入口（npm run test:all / typecheck:all /
# lint:all），避免两处命令清单漂移 —— Makefile 仅保留少数高频便捷目标。
test: ## 运行所有测试（等价 npm run test:all，覆盖全部子项目）
	npm run test:all

lint: ## 运行代码检查（等价 npm run lint:all）
	npm run lint:all

typecheck: ## 运行 TypeScript 类型检查（等价 npm run typecheck:all）
	npm run typecheck:all

# ── 数据库 ────────────────────────────────────────────────────
db-migrate: ## 运行数据库迁移
	cd apps/admin-api && npm run migration:run
	@echo "==> 数据库迁移完成"

db-migrate-revert: ## 回滚最后一次迁移
	cd apps/admin-api && npm run migration:revert

demo-seed: ## 造一套演示数据（demo- 前缀任务；需 admin-api 已启动）
	node scripts/demo-seed.mjs

demo-seed-selftest: ## demo-seed 纯函数自检
	node scripts/demo-seed.selftest.mjs

db-migrate-gen: ## 生成新的迁移文件
	cd apps/admin-api && npm run migration:generate

# ── 监控与调试 ────────────────────────────────────────────
logs: ## 查看所有服务日志
	docker-compose logs -f --tail=100

status: ## 查看服务运行状态
	docker-compose ps
	@echo ""
	@echo "==> 健康检查端点:"
	@echo "  admin-api:       curl -s http://localhost:3105/health"
	@echo "  executor-python: curl -s http://localhost:8001/health"
	@echo "  executor-node:   curl -s http://localhost:8002/health"

clean: ## 清理构建产物和缓存
	find . -name 'node_modules' -type d -prune -exec rm -rf {} +
	find . -name '__pycache__' -type d -prune -exec rm -rf {} +
	find . -name 'dist' -type d -prune -exec rm -rf {} +
	find . -name '.pytest_cache' -type d -prune -exec rm -rf {} +
	find . -name '*.pyc' -delete
	@echo "==> 清理完成"
