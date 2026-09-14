.PHONY: help dev install infra-up infra-down build start stop restart clean test lint typecheck db-migrate db-seed logs status

# ── AutoFlow 开发命令入口 ──────────────────────────────────────
# 所有命令均可通过 make <target> 调用

# E-28（DEEP_REVIEW 0ef3bbe）：docker-compose v1 独立二进制 2023 年起 EOL，现代
# Docker 只带 `docker compose` v2 插件。make 解析期探测一次：优先 v2，回退 v1 独立
# 二进制。所有 compose 调用统一走 $(DC)，不再硬编码 v1 命令。
DC := $(shell docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose")

help: ## 显示所有可用命令
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ── 开发环境 ──────────────────────────────────────────────────
dev: ## 启动完整开发环境（基础设施 + 所有服务）
	@echo "==> 启动基础设施（Postgres + Redis）..."
	$(DC) -f infra/docker-compose.yml up -d
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
	$(DC) -f infra/docker-compose.yml up -d
	@echo "==> 基础设施已启动"
	@echo "  Postgres: localhost:5432"
	@echo "  Redis:    localhost:6379"

infra-down: ## 停止基础设施
	$(DC) -f infra/docker-compose.yml down
	@echo "==> 基础设施已停止"

# ── 构建与部署 ──────────────────────────────────────────────
build: ## 构建所有 Docker 镜像
	$(DC) build
	@echo "==> 镜像构建完成"

start: ## 启动完整服务（生产模式）
	$(DC) up -d
	@echo "==> 服务已启动"

stop: ## 停止所有服务
	$(DC) down
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
	$(DC) logs -f --tail=100

status: ## 查看服务运行状态
	$(DC) ps
	@echo ""
	@echo "==> 健康检查端点:"
	# E-28（DEEP_REVIEW 0ef3bbe）：admin-api 全局前缀 api，liveness 端点统一为
	# /api/health/live（旧提示写 /health 恒 404，status 恒报「未运行」）。执行器
	# 两侧仍打自身 /health。
	@echo "  admin-api:       curl -s http://localhost:3105/api/health/live"
	@echo "  executor-python: curl -s http://localhost:8001/health"
	@echo "  executor-node:   curl -s http://localhost:8002/health"

clean: ## 清理构建产物和缓存（不删根 node_modules / 工具缓存）
	# E-30（DEEP_REVIEW 0ef3bbe）：旧实现从仓库根 find -name node_modules -exec rm -rf
	# 会连根 package.json 的 node_modules（npm run test:all/lint:all 的载体）、.zcode
	# 下依赖、docs-site 等全部子项目依赖一起删——"清理构建产物"变成全量重装；
	# `-name dist` 还会误删任何叫 dist 的数据目录。改为只在 apps/* packages/* 下清
	# node_modules/dist/__pycache__，根 node_modules 与 .zcode 不碰。
	find apps packages -name 'node_modules' -type d -prune -exec rm -rf {} +
	find apps packages -name '__pycache__' -type d -prune -exec rm -rf {} +
	find apps packages -name 'dist' -type d -prune -exec rm -rf {} +
	find apps packages -name '.pytest_cache' -type d -prune -exec rm -rf {} +
	find apps packages -name '*.pyc' -delete
	@echo "==> 清理完成"
