# 开发指南

## 环境要求

| 工具 | 版本要求 | 安装说明 |
|------|----------|----------|
| Node.js | 20.x LTS | https://nodejs.org 或 nvm |
| pnpm | 8.x | `npm install -g pnpm@8` |
| Python | 3.11+ | https://python.org 或 pyenv |
| Docker | 24.0+ | https://docs.docker.com/get-docker/ |
| Docker Compose | 2.20+ | 随 Docker Desktop 附带 |

## 本地启动步骤

### 1. 克隆仓库并安装依赖

```bash
git clone https://github.com/your-org/AutoCodeFlow.git
cd AutoCodeFlow

# 安装 Node.js 依赖（monorepo 根目录）
pnpm install
```

### 2. 配置本地环境变量

```bash
cp .env.example .env
cp apps/admin-api/.env.example apps/admin-api/.env
# 按需修改各 .env 文件中的配置
```

### 3. 启动依赖服务（数据库、Redis）

```bash
# 仅启动基础设施服务，不启动应用
docker compose up -d postgres redis
```

### 4. 执行数据库迁移

```bash
cd apps/admin-api
npm run migration:run
cd ../..
```

### 5. 启动各服务（各开一个终端）

```bash
# 终端 1：Admin API
cd apps/admin-api && npm run start:dev

# 终端 2：Admin Web
cd apps/admin-web && pnpm dev

# 终端 3：Python 执行器
cd apps/executor-python && pip install -r requirements.txt && python main.py

# 终端 4：Node.js 执行器
cd apps/executor-node && npm install && npm run dev
```

## 各服务端口说明

| 服务 | 端口 | 说明 |
|------|------|------|
| admin-api | 3105 | NestJS REST API，含 Swagger 文档 |
| admin-web | 80 (prod) / 5173 (dev) | React 管理后台 |
| executor-python | 8001 | FastAPI Python 执行器 |
| executor-node | 8002 | Express Node.js 执行器 |
| PostgreSQL | 5432 | 主数据库 |
| Redis | 6379 | 缓存与消息队列 |

## 数据库迁移命令

```bash
# 进入 admin-api 目录
cd apps/admin-api

# 运行所有待执行迁移
npm run migration:run

# 生成新迁移文件（根据 Entity 变化自动生成）
npm run migration:generate -- src/migrations/YourMigrationName

# 回滚最后一次迁移
npm run migration:revert

# 查看迁移状态
npm run migration:show
```

迁移文件位于 `apps/admin-api/src/migrations/`，采用时间戳前缀命名，例如 `1717473142678-InitialSchema.ts`。

## 测试命令

```bash
# Admin API 单元测试
cd apps/admin-api
npm run test

# Admin API 单元测试（watch 模式）
npm run test:watch

# Admin API 覆盖率报告
npm run test:cov

# Admin API 端到端测试
npm run test:e2e

# Python 执行器测试
cd apps/executor-python
pytest

# Node.js 执行器测试
cd apps/executor-node
npm test
```

## 代码规范

### TypeScript / JavaScript

- 使用 ESLint + Prettier 进行代码检查和格式化
- 提交前自动运行 lint：`npm run lint`
- 格式化代码：`npm run format`
- 遵循 NestJS 官方最佳实践，模块化组织代码
- 所有公共 API 方法须添加 JSDoc 注释

### Python

- 使用 `black` 格式化代码：`black .`
- 使用 `flake8` 进行代码检查：`flake8 .`
- 类型注解：所有函数签名必须包含类型注解
- 遵循 PEP 8 规范

### Git 提交规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

```
feat: 新增功能
fix: 修复 Bug
docs: 文档变更
refactor: 代码重构（不影响功能）
test: 新增或修改测试
chore: 构建流程或辅助工具变更
```

示例：
```
feat: 新增任务批量执行接口
fix: 修复执行器心跳超时导致的误下线问题
docs: 更新 SDK 使用示例
```

### 分支策略

- `main`：主分支，仅接受经过 Review 的 PR
- `feat/xxx`：功能开发分支
- `fix/xxx`：Bug 修复分支
- `release/x.x.x`：发布分支

## 项目结构

```
AutoCodeFlow/
├── apps/
│   ├── admin-api/          # NestJS 后端 API
│   │   ├── src/
│   │   │   ├── modules/    # 业务模块
│   │   │   ├── common/     # 公共工具、守卫、过滤器
│   │   │   ├── config/     # 配置管理
│   │   │   └── migrations/ # 数据库迁移文件
│   ├── admin-web/          # React 前端
│   ├── executor-python/    # Python 执行器
│   └── executor-node/      # Node.js 执行器
├── docs/                   # 项目文档
├── docker-compose.yml      # 容器编排配置
├── .env.example            # 环境变量模板
└── Makefile                # 常用命令快捷方式
```
