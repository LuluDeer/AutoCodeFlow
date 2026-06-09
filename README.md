# AutoCodeFlow

> 企业级分布式任务调度系统

AutoCodeFlow 是一个现代化的分布式任务调度系统，提供可靠的任务调度、执行和监控能力。支持多语言执行器（Node.js/Python）、动态任务管理、实时监控和告警通知。

**AutoCodeFlow** = **Auto**（自动化）+ **Code**（代码）+ **Flow**（工作流）—— 让代码自动化流转，让任务调度更简单、更可靠。

---

## 📋 目录

1. [功能特性](#-功能特性)
2. [架构设计](#-架构设计)
3. [快速开始](#-快速开始)
4. [开发指南](#-开发指南)
5. [任务开发](#-任务开发)
6. [SDK 使用](#-sdk-使用)
7. [API 文档](#-api-文档)
8. [配置说明](#-配置说明)
9. [版本管理](#-版本管理)
10. [部署指南](#-部署指南)
11. [贡献指南](#-贡献指南)

---

## ✨ 功能特性

### 核心功能
- **分布式调度**：支持多实例部署，基于 Redis 实现分布式锁
- **多语言支持**：提供 Node.js 和 Python 执行器
- **灵活的任务类型**：支持 Cron 表达式、固定频率触发
- **任务优先级**：支持任务优先级队列（LOW/NORMAL/HIGH/CRITICAL）
- **阻塞策略**：支持串行执行、丢弃后续、覆盖早期三种策略
- **广播模式**：支持将任务发送到同一分组下的所有执行器

### 可靠性保障
- **优雅关闭**：执行器关闭时等待任务完成（可配置超时）
- **异步回调**：执行结果异步上报，失败自动重试
- **超时控制**：任务执行超时自动终止（支持进程组级别的终止）
- **失败重试**：支持可配置的重试策略（次数、间隔、可重试错误类型）

### 运维能力
- **实时监控**：执行器健康状态、任务执行统计
- **日志管理**：按日期组织的日志文件，自动清理（可配置保留天数）
- **告警通知**：支持邮件、钉钉、企业微信、Slack，支持告警静默策略
- **版本管理**：任务版本快照、回滚、对比功能
- **执行报告**：每日执行统计报告（成功/失败/超时数量、执行时长统计）

### 高可用性
- **多 Admin 支持**：执行器支持配置多个 Admin 地址
- **故障转移**：自动切换到可用的 Admin 节点

### 安全特性
- **用户管理**：完整的用户管理和权限控制
- **JWT 认证**：基于 JWT 的身份认证
- **账户锁定**：登录失败次数限制和账户锁定机制

---

## 🏗️ 架构设计

### 系统架构

AutoFlow 采用经典的分布式调度架构：

```
┌─────────────────────────────────────────────────────────────────┐
│                        管理中台 (Admin Web)                      │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  任务管理 | 执行器管理 | 监控面板 | 告警配置 | 用户管理  │    │
│  └─────────────────────────────────────────────────────────┘    │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP API
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                       调度中心 (Admin API)                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │
│  │  Scheduler  │  │ TaskManager │  │ ExecutorMgr │            │
│  │  (调度服务) │  │  (任务管理) │  │ (执行器管理)│            │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘            │
│         │                │                │                     │
│         ▼                ▼                ▼                     │
│  ┌──────────────────────────────────────────────┐               │
│  │           PostgreSQL + Redis                 │               │
│  │  (任务配置/执行记录)  (分布式锁/消息队列)     │               │
│  └──────────────────────────────────────────────┘               │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP / WebSocket
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  Executor-1   │    │  Executor-2   │    │  Executor-N   │
│  (Node/Python)│    │  (Node/Python)│    │  (Node/Python)│
└───────────────┘    └───────────────┘    └───────────────┘
```

### 组件说明

| 组件 | 角色 | 技术栈 | 说明 |
|------|------|--------|------|
| **管理中台** | 前端管理界面 | React + TypeScript + Ant Design | 提供可视化任务管理、监控和配置能力 |
| **调度中心** | 核心调度服务 | NestJS + TypeScript | 负责任务调度、执行器管理、分布式锁协调 |
| **执行器** | 任务执行节点 | Node.js / Python | 执行具体任务，支持多种运行时 |
| **PostgreSQL** | 持久化存储 | PostgreSQL 15+ | 存储任务配置、执行记录、系统配置 |
| **Redis** | 缓存与队列 | Redis 7+ | 分布式锁、任务队列、心跳检测 |

### 调度机制

1. **任务注册**：通过中台或 API 创建任务，存储到数据库
2. **调度触发**：Scheduler 根据 Cron/FixedRate 规则触发任务
3. **分布式锁**：通过 Redis 保证任务唯一性（同一任务同一时间只执行一次）
4. **任务分发**：将任务发送到执行器（支持负载均衡）
5. **任务执行**：执行器执行任务，支持超时控制和进程隔离
6. **执行反馈**：执行器完成任务后异步回调调度中心
7. **状态更新**：调度中心更新任务执行状态，触发告警（如有）

---

## 🚀 快速开始

### 环境要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | >= 20.x | 后端和前端开发 |
| Python | >= 3.10 | Python 执行器 |
| PostgreSQL | >= 15.0 | 数据库 |
| Redis | >= 7.0 | 缓存和队列 |

### 跨平台支持

| 操作系统 | 支持状态 | 说明 |
|----------|----------|------|
| **Linux** | ✅ 完全支持 | Ubuntu 20.04+, CentOS 7+ |
| **Windows** | ✅ 完全支持 | Windows 10/11 |
| **macOS** | ✅ 完全支持 | macOS 12+ |

### 使用 Docker Compose 启动

```bash
# 启动所有服务
docker-compose up -d

# 查看服务状态
docker-compose ps

# 停止服务
docker-compose down
```

### 手动启动

#### 1. 启动数据库和 Redis

**Linux/macOS:**
```bash
docker run -d -p 5432:5432 -e POSTGRES_DB=autocodeflow -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=password postgres:15
docker run -d -p 6379:6379 redis:7
```

**Windows (PowerShell):**
```powershell
docker run -d -p 5432:5432 -e POSTGRES_DB=autocodeflow -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=password postgres:15
docker run -d -p 6379:6379 redis:7
```

#### 2. 启动 Admin API

**Linux/macOS:**
```bash
cd apps/admin-api
npm install
npm run start:dev
```

**Windows (PowerShell):**
```powershell
cd apps/admin-api
npm install
npm run start:dev
```

#### 3. 启动执行器

**Linux/macOS:**
```bash
# Node.js 执行器
cd apps/executor-node
npm install
npm run start:dev

# Python 执行器
cd apps/executor-python
pip install -r requirements.txt
python main.py
```

**Windows (PowerShell):**
```powershell
cd apps/executor-node
npm install
npm run start:dev

cd apps/executor-python
pip install -r requirements.txt
python main.py
```

#### 4. 启动前端

**Linux/macOS:**
```bash
cd apps/admin-web
npm install
npm run dev
```

**Windows (PowerShell):**
```powershell
cd apps/admin-web
npm install
npm run dev
```

---

## 👩‍💻 开发指南

### 项目结构

```
autoflow/
├── apps/
│   ├── admin-api/          # 后端管理 API
│   │   ├── src/
│   │   │   ├── common/     # 通用组件（常量、装饰器、守卫等）
│   │   │   ├── config/     # 配置管理
│   │   │   ├── migrations/ # 数据库迁移
│   │   │   └── modules/    # 业务模块
│   │   │       ├── task/   # 任务管理（核心）
│   │   │       ├── executor/ # 执行器管理
│   │   │       ├── scheduler/ # 调度服务
│   │   │       ├── notification/ # 告警通知
│   │   │       ├── auth/    # 认证管理
│   │   │       ├── users/   # 用户管理
│   │   │       └── metrics/ # 指标统计
│   ├── admin-web/          # 前端管理界面
│   │   ├── src/
│   │   │   ├── api/        # API 接口封装
│   │   │   ├── components/ # 组件
│   │   │   ├── layouts/    # 布局
│   │   │   ├── pages/      # 页面
│   │   │   └── store/      # 状态管理
│   ├── executor-node/      # Node.js 执行器
│   ├── executor-python/    # Python 执行器
│   └── registry-*/         # 私有包仓库
├── packages/
│   └── autocodeflow-sdk/       # Python SDK
└── infra/                  # 基础设施配置
```

### 开发流程

1. **克隆项目**：
   ```bash
   git clone https://github.com/your-username/AutoCodeFlow.git
   cd autoflow
   ```

2. **安装依赖**：
   ```bash
   # 安装所有子项目依赖
   npm run install-all
   ```

3. **启动开发环境**：
   ```bash
   # 使用开发脚本启动所有服务
   ./start-dev.sh
   ```

4. **运行测试**：
   ```bash
   # 运行后端测试
   cd apps/admin-api
   npm run test

   # 运行执行器测试
   cd apps/executor-node
   npm run test

   # 运行 Python 执行器测试
   cd apps/executor-python
   pytest
   ```

5. **代码检查**：
   ```bash
   cd apps/admin-api
   npm run lint
   ```

---

## 📦 任务开发快速开始

### 方式一：Glue 脚本（在线编辑，最简单）

在管理后台创建任务后，直接在线编辑代码，无需搭建本地项目：

1. 在管理后台 → 任务管理 → 创建任务（选择 runtime: python / javascript / shell）
2. 在任务详情页的「Glue 脚本编辑」卡片中编写代码
3. 点击「保存脚本」即完成开发

```javascript
// Node.js Glue 任务示例
const { AutoFlowContext } = require('@autocodeflow/sdk');
const ctx = AutoFlowContext.fromEnv();

ctx.logger.info(`Task ${ctx.taskId} started`);
const date = ctx.getParam('date', new Date().toISOString());

// Your business logic here...
const result = await fetch(`https://api.example.com/data?date=${date}`);
const data = await result.json();

ctx.logger.info(`Fetched ${data.length} records`);
```

```python
# Python Glue 任务示例
from autoflow_sdk import TaskContext

ctx = TaskContext.from_env()
ctx.log.info(f"Task {ctx.task_id} started")
date = ctx.get_param("date")

# Your business logic here...
import requests
resp = requests.get(f"https://api.example.com/data?date={date}")

ctx.log.info(f"Fetched {len(resp.json())} records")
```

### 方式二：Git 项目（推荐团队协作）

#### 1. 创建项目结构

```
my-app/
├── src/tasks/           # 任务代码目录
│   ├── daily-report.js
│   └── monthly-report.py
├── manifest.json        # 应用清单（部署时自动注册任务）
├── package.json         # Node.js 依赖
├── requirements.txt     # Python 依赖
└── .gitignore
```

#### 2. 编写 manifest.json

```json
{
  "name": "my-app",
  "version": "1.0.0",
  "runtime": "node",
  "tasks": [
    {
      "id": "daily-report",
      "name": "每日报告",
      "entrypoint": "src/tasks/daily-report.js",
      "cron": "0 0 8 * * *",
      "timeout": 300,
      "maxRetry": 3,
      "requirements": ["@autocodeflow/sdk", "axios"]
    },
    {
      "id": "monthly-report",
      "name": "月度报告",
      "entrypoint": "src/tasks/monthly-report.py",
      "cron": "0 0 8 1 * *",
      "timeout": 600,
      "maxRetry": 2,
      "requirements": ["autoflow-sdk", "requests"]
    }
  ]
}
```

#### 3. 编写任务代码

```javascript
// src/tasks/daily-report.js
const { AutoFlowContext } = require('@autocodeflow/sdk');

async function main() {
  // AutoFlowContext.fromEnv() 从环境变量自动读取 executionId/taskId/params
  const ctx = AutoFlowContext.fromEnv();

  ctx.logger.info('开始生成每日报告');

  try {
    // 你的业务逻辑
    const outputPath = ctx.getParam('outputPath', '/tmp/reports');
    ctx.logger.info(`输出路径: ${outputPath}`);

    // 返回成功结果
    console.log(JSON.stringify({ success: true, outputPath }));
    process.exit(0);
  } catch (err) {
    ctx.logger.error(`任务失败: ${err.message}`);
    console.log(JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  }
}

main();
```

```python
# src/tasks/monthly-report.py
import sys
import json
from autoflow_sdk import TaskContext

def main():
    # from_env() 从环境变量自动读取上下文
    ctx = TaskContext.from_env()
    ctx.log.info("开始生成月度报告")

    try:
        # 你的业务逻辑
        output_path = ctx.get_param("outputPath", "/tmp/reports")
        ctx.log.info(f"输出路径: {output_path}")

        print(json.dumps({"success": True, "outputPath": output_path}))
        sys.exit(0)
    except Exception as e:
        ctx.log.error(f"任务失败: {e}")
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
```

#### 4. 部署与自动注册

在管理后台创建 Application（填入 Git 仓库地址），系统会：
1. Clone 仓库
2. 解析 manifest.json
3. 自动注册所有任务
4. 任务自动进入调度队列

或使用 curl：

```bash
curl -X POST http://localhost:3001/api/applications \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "name": "my-app",
    "version": "1.0.0",
    "runtime": "node",
    "gitRepo": "https://github.com/your-org/my-app.git",
    "gitBranch": "main"
  }'
```

### 方式三：手动 API 注册（灵活控制）

```bash
curl -X POST http://localhost:3001/api/tasks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "id": "custom-task",
    "name": "自定义任务",
    "runtime": "node",
    "entrypoint": "task.js",
    "cronExpression": "0 0 8 * * *",
    "timeout": 300,
    "maxRetry": 3,
    "retryDelay": 60,
    "priority": 2,
    "blockStrategy": "serial",
    "executeMode": "single"
  }'
```

---

## 🔄 任务执行生命周期

了解任务执行的全流程有助于排查问题：

```
┌──────────┐    ┌──────────┐    ┌──────────────┐    ┌──────────┐
│ Scheduler │───▶│  Task    │───▶│   Executor   │───▶│ Callback │
│ 触发调度  │    │ Queue   │    │ 执行任务代码  │    │ 结果回写  │
└──────────┘    └──────────┘    └──────────────┘    └──────────┘

1. 调度触发（Scheduler）
   - Cron 表达式到期 或 手动触发
   - 检查阻塞策略（blockStrategy）
   - 生成 executionId 并写入执行记录

2. 任务分发（Task Queue）
   - 根据路由策略选择 Executor
   - 发送 HTTP POST /execute 到目标 Executor
   - 携带 params、gitRepo、requirements 等上下文

3. 执行任务（Executor）
   a. 创建工作目录 /tmp/autocodeflow/tasks/{executionId}/
   b. 如果是 Git 任务：clone 仓库到工作目录
   c. 如果是 Glue 任务：写入 glueSource 到临时文件
   d. 安装依赖（uv pip install / npm install）
   e. 注入环境变量：
      - EXECUTION_ID — 本次执行ID
      - TASK_ID — 任务ID
      - TASK_NAME — 任务名称
      - AUTOFLOW_{PARAM} — 任务参数（params 字段）
   f. 启动子进程执行（python3 entrypoint.py / node entrypoint.js）
   g. 收集 stdout/stderr 作为日志

4. 结果回写（Callback）
   - 执行完成后 POST /api/execution-callback 回写结果
   - 更新执行状态（success/failed）
   - 触发通知（如果启用）
   - 触发失败重试（如果 maxRetry > 0）
```

---

## 🔧 常见问题排查

### 任务代码中的 context/logger 报 undefined/None

**症状**: `context is not defined` 或 `NameError: name 'context' is not defined`

**原因**: 没有使用 `fromEnv()` 工厂方法初始化 context

**解决**:
```javascript
// ❌ 错误：context 不存在
ctx.logger.info('xxx');

// ✅ 正确：从环境变量初始化
const { AutoFlowContext } = require('@autocodeflow/sdk');
const ctx = AutoFlowContext.fromEnv();
ctx.logger.info('xxx');
```

### 依赖安装失败

**症状**: `uv pip install failed` 或 `npm install failed`

**排查**:
1. Python 任务：确保 `requirements` 字段中的包名正确（不是 `requirements.txt` 路径，是包名列表）
2. Node 任务：确保 `requirements` 字段中的包名符合 npm 命名规范
3. 私有包：检查 `PYPI_REGISTRY_URL` / `NPM_REGISTRY_URL` 环境变量是否配置到 Executor

### 任务一直 pending 不执行

1. 检查 Executor 是否在线：管理后台 → 执行器管理
2. 检查任务的 `executorAppName` 是否匹配在线 Executor 的 APP_NAME
3. 如果所有 Executor 的 `runningTaskCount` 达到 `maxConcurrentTasks`，任务会排队等待

### Git 部署后任务未自动注册

1. 确认仓库根目录存在 `manifest.json`
2. 确认 `manifest.json` 中 `tasks` 数组有任务定义
3. 查看 ApplicationService 日志：`docker logs autocodeflow-admin-api-1`

### 版本回滚后代码未还原

版本回滚只恢复任务配置（cron、timeout、params 等），如需回滚代码：
1. 手动更新任务的 `gitCommit` 字段
2. 或通过 `POST /api/applications/webhook` 触发重新部署

### 日志在哪看

1. 管理后台 → 任务 → 执行记录 → 日志
2. Executor 本地日志：`docker logs autocodeflow-executor-python-1`
3. 文件日志（Executor 侧）：`/data/tasks/{executionId}/output.log`

#### 5. 编写工具函数

**`src/utils/helpers.js`**：

```javascript
const axios = require('axios');

async function fetchBusinessData(date) {
  const response = await axios.get('https://api.example.com/data', {
    params: { date }
  });
  return response.data;
}

async function saveReport(report, outputPath) {
  const fs = require('fs');
  const path = require('path');
  
  const fullPath = path.join(outputPath, report.filename);
  await fs.promises.writeFile(fullPath, JSON.stringify(report.data, null, 2));
  return fullPath;
}

module.exports = {
  fetchBusinessData,
  saveReport
};
```

#### 6. 配置文件示例

**`config/default.yaml`**：

```yaml
# 应用配置
app:
  name: my-autocodeflow-app
  version: 1.0.0

# 数据源配置
dataSource:
  apiUrl: https://api.example.com
  timeout: 30000

# 输出配置
output:
  basePath: /data/reports
  format: json

# 日志配置
logging:
  level: info
  format: json
```

#### 7. 部署应用

##### 方式一：通过 Git 部署

```bash
# 提交代码到 Git
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/your-username/my-autocodeflow-app.git
git push -u origin main
```

在 AutoFlow 中配置：

```bash
curl -X POST http://localhost:3001/api/applications \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "name": "my-autocodeflow-app",
    "gitRepo": "https://github.com/your-username/my-autocodeflow-app.git",
    "gitBranch": "main",
    "gitCommit": "HEAD"
  }'
```

##### 方式二：通过文件上传部署

```bash
# 打包应用
zip -r my-autocodeflow-app.zip .

# 上传应用
curl -X POST http://localhost:3001/api/applications/upload \
  -H "Authorization: Bearer <token>" \
  -F "file=@my-autocodeflow-app.zip"
```

#### 8. 注册任务

部署应用后，注册应用中的任务：

```bash
curl -X POST http://localhost:3001/api/tasks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "id": "daily-report",
    "name": "每日报告",
    "applicationId": "my-autocodeflow-app",
    "entrypoint": "src/tasks/daily-report.js",
    "triggerType": "cron",
    "cronExpression": "0 0 8 * * *",
    "timeout": 300,
    "maxRetry": 3
  }'
```

### 创建单个任务

如果只需要创建单个任务，可以直接通过 API 配置：

```bash
curl -X POST http://localhost:3001/api/tasks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "id": "daily-report",
    "name": "每日报告",
    "description": "每天早上8点生成业务报告",
    "runtime": "node",
    "entrypoint": "reports/daily.js",
    "params": {
      "outputPath": "/data/reports"
    },
    "triggerType": "cron",
    "cronExpression": "0 0 8 * * *",
    "timeout": 300,
    "maxRetry": 3,
    "retryDelay": 60,
    "priority": 2,
    "blockStrategy": "serial",
    "executeMode": "single"
  }'
```

#### 2. 编写任务代码

**Node.js 任务示例**：
```javascript
// reports/daily.js
const { AutoFlowContext } = require('@autocodeflow/sdk');

async function handler(event, context) {
  const logger = context.logger;
  const params = context.params;
  
  logger.info('开始生成每日报告');
  
  // 业务逻辑
  const report = await generateReport(params.outputPath);
  
  logger.info(`报告生成完成: ${report.path}`);
  
  return {
    success: true,
    data: {
      reportPath: report.path,
      recordCount: report.count
    }
  };
}

module.exports = { handler };
```

**Python 任务示例**：
```python
# reports/daily.py
from autoflow_sdk import AutoFlowContext

def handler(event, context: AutoFlowContext):
    logger = context.logger
    params = context.params
    
    logger.info("开始生成每日报告")
    
    # 业务逻辑
    report = generate_report(params.get('outputPath'))
    
    logger.info(f"报告生成完成: {report['path']}")
    
    return {
        "success": True,
        "data": {
            "reportPath": report['path'],
            "recordCount": report['count']
        }
    }
```

#### 3. 任务元数据（manifest.json）

```json
{
  "name": "daily-report",
  "version": "1.0.0",
  "description": "每日业务报告生成任务",
  "runtime": "node",
  "entrypoint": "reports/daily.js",
  "env": {
    "NODE_ENV": "production"
  },
  "dependencies": {
    "axios": "^1.0.0",
    "moment": "^2.0.0"
  }
}
```

### 任务触发方式

#### 手动触发
```bash
curl -X POST http://localhost:3001/api/tasks/daily-report/trigger \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "params": {
      "date": "2024-01-01",
      "outputPath": "/data/reports/custom"
    }
  }'
```

#### 定时触发

支持两种定时方式：

1. **Cron 表达式**：
   - 格式：`秒 分 时 日 月 周`
   - 示例：`0 0 8 * * *`（每天早上8点）

2. **固定频率**：
   - 单位：秒
   - 示例：`3600`（每小时执行一次）

#### 依赖触发

任务可以配置依赖其他任务：

```bash
curl -X POST http://localhost:3001/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "id": "weekly-summary",
    "name": "周报汇总",
    "dependencies": {
      "daily-report": "success"
    },
    "triggerType": "cron",
    "cronExpression": "0 0 9 * * 1"
  }'
```

---

## 🧰 SDK 使用

### Python SDK

#### 安装 SDK

```bash
pip install autocodeflow-sdk
```

#### 使用示例

```python
from autoflow_sdk import TaskContext

# 推荐方式：从环境变量自动初始化（executor 自动注入）
ctx = TaskContext.from_env()
ctx.log.info(f"Task {ctx.task_id} started")
date = ctx.get_param("date")

# 手动方式（用于本地测试）
ctx = TaskContext(
    task_id="daily-report",
    execution_id="exec-123",
    task_name="每日报告",
    params={"date": "2024-01-01"}
)
ctx.log.info("任务开始")
output_path = ctx.get_param("outputPath", "/tmp/reports")

# 发送 HTTP 请求
import httpx
# ctx.env 提供任务级环境变量
```

### Node.js SDK

#### 安装 SDK

```bash
npm install @autocodeflow/sdk
```

#### 使用示例

```javascript
const { AutoFlowContext } = require('@autocodeflow/sdk');

// 推荐方式：从环境变量自动初始化（executor 自动注入）
const ctx = AutoFlowContext.fromEnv();
ctx.logger.info(`Task ${ctx.taskId} started`);
const date = ctx.getParam('date');

// 手动方式（用于本地测试）
const ctx2 = new AutoFlowContext({
    executionId: "exec-123",
    taskId: "daily-report",
    params: { outputPath: "/data" }
});

// 使用日志
ctx2.logger.info("任务开始");
ctx2.logger.warn("注意：数据量较大");
ctx2.logger.error("处理失败");

// 发送 HTTP 请求
const response = await ctx2.http.get("https://api.example.com/data");
```

### SDK API 参考

#### AutoFlowContext / TaskContext

| 方法/属性 | 说明 | 示例 |
|-----------|------|------|
| `fromEnv()` | **推荐**：从环境变量初始化上下文 | `AutoFlowContext.fromEnv()` / `TaskContext.from_env()` |
| `params` | 获取任务参数 | `ctx.params.outputPath` |
| `executionId` / `execution_id` | 获取执行ID | `ctx.executionId` |
| `taskId` / `task_id` | 获取任务ID | `ctx.taskId` |
| `logger` / `log` | 获取日志实例 | `ctx.logger.info()` / `ctx.log.info()` |
| `http` | HTTP 客户端 | `ctx.http.get(url)` |
| `getParam(key, default)` / `get_param(key, default)` | 获取参数（带默认值） | `ctx.getParam('date', '2024-01-01')` |

#### AutoFlowLogger

| 方法 | 说明 |
|------|------|
| `debug(message)` | 调试日志 |
| `info(message)` | 信息日志 |
| `warn(message)` | 警告日志 |
| `error(message)` | 错误日志 |

#### AutoFlowHTTP

| 方法 | 说明 |
|------|------|
| `get(url, options)` | GET 请求 |
| `post(url, data, options)` | POST 请求 |
| `put(url, data, options)` | PUT 请求 |
| `delete(url, options)` | DELETE 请求 |

---

## 📊 API 文档

### 认证接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/login` | 用户登录 |
| POST | `/api/auth/logout` | 用户登出 |
| POST | `/api/auth/refresh` | 刷新 Token |

### 任务管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/tasks` | 获取任务列表 |
| POST | `/api/tasks` | 创建任务 |
| GET | `/api/tasks/:id` | 获取任务详情 |
| PUT | `/api/tasks/:id` | 更新任务 |
| DELETE | `/api/tasks/:id` | 删除任务 |
| POST | `/api/tasks/:id/trigger` | 触发任务 |
| GET | `/api/tasks/:id/executions` | 获取执行记录 |
| POST | `/api/tasks/:id/rollback` | 回滚任务版本 |
| GET | `/api/tasks/:id/versions` | 获取任务版本 |

### 执行器管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/executors` | 获取执行器列表 |
| GET | `/api/executors/:id` | 获取执行器详情 |
| DELETE | `/api/executors/:id` | 删除执行器 |
| POST | `/api/executors/:id/offline` | 下线执行器 |

### 指标统计

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/metrics` | 获取系统指标 |
| GET | `/api/metrics/reports` | 获取执行报告 |
| GET | `/api/metrics/today` | 获取今日报告 |

### 告警管理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/alerts/silence` | 添加告警静默 |
| GET | `/api/alerts/silences` | 获取静默列表 |
| DELETE | `/api/alerts/silences/:id` | 删除静默规则 |

### 用户管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/users` | 获取用户列表 |
| POST | `/api/users` | 创建用户 |
| GET | `/api/users/:id` | 获取用户详情 |
| PUT | `/api/users/:id` | 更新用户 |
| DELETE | `/api/users/:id` | 删除用户 |

---

## 🔧 配置说明

### 环境变量

#### Admin API 配置

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `DATABASE_URL` | 数据库连接地址 | `postgresql://admin:password@localhost:5432/autocodeflow` |
| `REDIS_URL` | Redis 连接地址 | `redis://localhost:6379` |
| `JWT_SECRET` | JWT 密钥 | - |
| `JWT_EXPIRES_IN` | JWT 过期时间 | `1h` |
| `PORT` | 服务端口 | `3001` |
| `EXECUTOR_HEARTBEAT_INTERVAL` | 心跳间隔（秒） | `30` |
| `EXECUTOR_HEARTBEAT_TIMEOUT_MULTIPLIER` | 心跳超时倍数 | `3` |

#### Executor Node 配置

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `ADMIN_API_URL` | Admin API 地址 | `http://localhost:3001` |
| `ADMIN_API_URLS` | 多 Admin 地址（逗号分隔） | - |
| `PORT` | 服务端口 | `8002` |
| `MAX_CONCURRENT_TASKS` | 最大并发任务数 | `10` |
| `LOG_RETENTION_DAYS` | 日志保留天数 | `7` |
| `EXECUTOR_ADDRESS` | 执行器地址 | `localhost:8002` |

#### Executor Python 配置

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `ADMIN_API_URL` | Admin API 地址 | `http://localhost:3001` |
| `PORT` | 服务端口 | `8003` |
| `MAX_CONCURRENT_TASKS` | 最大并发任务数 | `10` |

### 配置文件示例

#### `.env` 文件

```env
# Admin API
DATABASE_URL=postgresql://admin:password@localhost:5432/autocodeflow
REDIS_URL=redis://localhost:6379
JWT_SECRET=your-secret-key
PORT=3001

# Executor Node
ADMIN_API_URL=http://localhost:3001
EXECUTOR_ADDRESS=executor-node:8002
MAX_CONCURRENT_TASKS=10
```

---

## 🔄 版本管理

### 任务版本控制

AutoFlow 提供完整的任务版本管理功能：

#### 1. 保存版本

```bash
curl -X POST http://localhost:3001/api/tasks/daily-report/versions \
  -H "Authorization: Bearer <token>" \
  -d '{
    "description": "添加周报汇总功能"
  }'
```

#### 2. 查看版本列表

```bash
curl http://localhost:3001/api/tasks/daily-report/versions \
  -H "Authorization: Bearer <token>"
```

#### 3. 回滚到指定版本

```bash
curl -X POST http://localhost:3001/api/tasks/daily-report/rollback \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "versionId": "version-uuid"
  }'
```

#### 4. 比较版本差异

```bash
curl http://localhost:3001/api/tasks/daily-report/versions/compare \
  -H "Authorization: Bearer <token>" \
  -d '{
    "versionId1": "version-uuid-1",
    "versionId2": "version-uuid-2"
  }'
```

### 版本管理 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/tasks/:id/versions` | 保存版本 |
| GET | `/api/tasks/:id/versions` | 获取版本列表 |
| GET | `/api/tasks/:id/versions/:versionId` | 获取版本详情 |
| DELETE | `/api/tasks/:id/versions/:versionId` | 删除版本 |
| POST | `/api/tasks/:id/rollback` | 回滚到版本 |
| POST | `/api/tasks/:id/versions/compare` | 比较版本 |

### Git 集成

任务支持与 Git 仓库集成：

```bash
curl -X PUT http://localhost:3001/api/tasks/daily-report \
  -H "Content-Type: application/json" \
  -d '{
    "gitRepo": "https://github.com/your-username/tasks.git",
    "gitBranch": "main",
    "gitCommit": "abc123"
  }'
```

---

## 📦 部署指南

### Docker 部署

#### 构建镜像

```bash
# 构建 Admin API
docker build -t autocodeflow-admin-api ./apps/admin-api

# 构建 Admin Web
docker build -t autocodeflow-admin-web ./apps/admin-web

# 构建 Node Executor
docker build -t autocodeflow-executor-node ./apps/executor-node

# 构建 Python Executor
docker build -t autocodeflow-executor-python ./apps/executor-python
```

#### Docker Compose 部署

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: autoflow
      POSTGRES_USER: admin
      POSTGRES_PASSWORD: password
    volumes:
      - postgres-data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  redis:
    image: redis:7
    volumes:
      - redis-data:/data
    ports:
      - "6379:6379"

  admin-api:
    image: autocodeflow-admin-api
    environment:
      DATABASE_URL: postgresql://admin:password@postgres:5432/autocodeflow
      REDIS_URL: redis://redis:6379
      JWT_SECRET: your-secret-key
    depends_on:
      - postgres
      - redis
    ports:
      - "3001:3001"

  admin-web:
    image: autocodeflow-admin-web
    environment:
      REACT_APP_API_URL: http://localhost:3001
    depends_on:
      - admin-api
    ports:
      - "3000:80"

  executor-node:
    image: autocodeflow-executor-node
    environment:
      ADMIN_API_URL: http://admin-api:3001
    depends_on:
      - admin-api

volumes:
  postgres-data:
  redis-data:
```

### Kubernetes 部署

#### 部署示例

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: autocodeflow-admin-api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: autocodeflow-admin-api
  template:
    metadata:
      labels:
        app: autocodeflow-admin-api
    spec:
      containers:
      - name: admin-api
        image: autocodeflow-admin-api:latest
        ports:
        - containerPort: 3001
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: db-secret
              key: database-url
        - name: REDIS_URL
          value: redis://redis:6379
```

---

## 🤝 贡献指南

### 开发流程

1. **Fork 项目**：点击 GitHub 页面的 Fork 按钮
2. **创建分支**：
   ```bash
   git checkout -b feature/xxx
   ```
3. **提交代码**：
   ```bash
   git add .
   git commit -m "feat: xxx"
   ```
4. **推送分支**：
   ```bash
   git push origin feature/xxx
   ```
5. **创建 PR**：在 GitHub 上创建 Pull Request

### 代码规范

- **TypeScript**：使用 ESLint 检查代码风格
- **Python**：使用 Flake8 检查代码风格
- **提交信息**：使用约定式提交格式
  - `feat`: 新功能
  - `fix`: 修复 Bug
  - `docs`: 文档更新
  - `refactor`: 代码重构
  - `test`: 测试更新

### 测试要求

- 新增功能必须编写单元测试
- 代码覆盖率目标：≥ 80%
- 所有测试必须通过

### 代码审查

- PR 必须至少有 1 个审核人批准
- 代码审查关注点：
  - 代码质量和可读性
  - 安全漏洞
  - 性能影响
  - 测试覆盖率

---

## 📝 许可证

MIT License

---

## 📧 联系方式

- **项目地址**：https://github.com/your-username/AutoCodeFlow
- **文档地址**：https://docs.autoflow.io
- **问题反馈**：https://github.com/your-username/AutoCodeFlow/issues

---

**AutoFlow** - 让任务调度更简单、更可靠 ✨