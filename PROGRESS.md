# AutoFlow 开发进度记录

> 本文件用于记录开发进度，防止中断后丢失上下文。每完成一个阶段自动更新。

## 项目简介

AutoFlow 是一个面向开发者的分布式自动化任务编排平台，类比影刀但面向工程师，支持：

- 中台统一调度与监控（NestJS + React）
- Python / Node.js 执行器，任务隔离运行
- 任务包版本控制（Git + 语义化版本）
- SDK/库版本化生态（私有 npm + PyPI）
- AI 失败分析与处理建议
- 多渠道通知（企微/钉钉/Slack/邮件）

项目参考：xxl-job 项目，项目路径：/home/yongsheng/project/xxl-job

## 技术栈

| 模块              | 技术                                       |
| --------------- | ---------------------------------------- |
| Admin API       | NestJS + TypeScript + PostgreSQL + Redis |
| Admin Web       | React 18 + Vite + Ant Design Pro         |
| 调度引擎            | BullMQ + node-cron                       |
| Python Executor | FastAPI + uvicorn + subprocess           |
| Node Executor   | Node.js + Express + TypeScript           |
| 包仓库             | Verdaccio (npm) + FastAPI PyPI           |
| AI 分析           | OpenAI / Ollama 插件式接入                    |
| 通知              | 插件式：企微/钉钉/Slack/邮件                       |
| 容器化             | Docker Compose                           |

## 目录结构

```
autoflow/
├── apps/
│   ├── admin-api/          # 中台 NestJS API
│   ├── admin-web/          # 中台 React 前端
│   ├── executor-python/    # Python 执行器 Agent
│   ├── executor-node/      # Node.js 执行器 Agent
│   └── registry/           # 包仓库服务
├── packages/
│   ├── autoflow-sdk/       # 基础 SDK（Python）
│   ├── autoflow-http/      # HTTP 封装库
│   ├── autoflow-db/        # 数据库连接库
│   ├── autoflow-notify/    # 通知库
│   └── autoflow-ai/        # AI 分析库
├── infra/
│   ├── docker-compose.yml  # Docker Compose 配置
│   ├── nginx/              # Nginx 配置
│   └── scripts/            # 初始化脚本
└── docs/                   # 文档
```

## 开发阶段

### Phase 1：基础骨架 ✅ 已完成

- [x] 项目目录结构初始化
- [x] Git 仓库初始化
- [x] Admin API (NestJS) 骨架
- [x] Admin Web (React) 骨架
- [x] Python Executor 骨架
- [x] Node Executor 骨架
- [x] Docker Compose 基础配置

### Phase 2：核心调度 ✅ 已完成

- [x] 任务 CRUD（Admin API）
- [x] Cron / 固定间隔 / API 触发
- [x] 执行器注册与心跳
- [x] 任务分发与执行
- [x] 执行日志采集
- [x] 前端任务管理页面（列表/详情/创建/编辑）
- [x] 前端执行器列表页面
- [x] 前端执行详情页面
- [x] 前端用户管理页面
- [x] JWT 认证 + 登录页面
- [x] 用户 CRUD（Admin API）

### Phase 3：虚拟环境 & 版本控制

- [x] Python venv 隔离（uv + 按 task\_id 持久化 venv）
- [x] 任务包 manifest.yaml 解析（Python + Node executor 均支持）
- [x] Node 沙箱隔离（按 task\_id 持久化 node\_modules）
- [x] 任务版本绑定 Git commit（gitRepo/gitBranch/gitCommit 字段 + executor clone/checkout）
- [x] 一键回滚（POST /tasks/:id/rollback + 前端 Modal）

### Phase 4：包生态

- [x] 私有 PyPI 服务（FastAPI PEP 503 + 上传/下载/认证，端口 8003）
- [x] 私有 npm 仓库（Verdaccio 5，端口 4873，@autoflow/\* 私有包）
- [x] autoflow-sdk 基础包（TaskContext/TaskResult/HttpClient/get\_logger）
- [x] 包市场 UI（RegistryPage，PyPI/npm 双 Tab，上传/列表/跳转）
- [x] 包版本管理（PyPI sha256 文件索引 + Verdaccio 版本列表）

### Phase 5：AI & 通知 ✅ 基础已完成

- [x] 通知插件系统（企微/钉钉/邮件 channel）
- [x] 任务失败时发送通知
- [x] AI 失败原因分析（OpenAI/Ollama 接入）
- [x] AI 修复建议（完善 prompt，结构化输出根本原因/详细分析/修复步骤/预防建议）
- [x] Slack 通知渠道（SlackChannel + blocks 格式 + 注入 notification.service）
- [x] 邮件 nodemailer 接入（EmailChannel + configuration.ts email 配置）

### Phase 6：监控 & 可观测性 ✅ 已完成

- [x] 后端 MetricsModule（GET /metrics/summary|trend|executors|failures）
- [x] 前端 DashboardPage（统计卡片 + 折线图 + 执行器状态 + 最近失败）
- [x] recharts 折线图（最近 7 天执行趋势）
- [x] 侧边栏菜单「数据看板」为首页入口
- [x] 30s 自动刷新 summary，15s 刷新执行器状态

### Phase 7：审计日志完善 ✅ 已完成

- [x] 后端 TaskController 接入 AuditService（create/update/delete/trigger/rollback）
- [x] 后端 UsersController 接入 AuditService（create/update/delete）
- [x] 后端 ConfigController 接入 AuditService（upsert/delete）
- [x] TaskModule / UsersModule / SystemConfigModule 导入 AuditModule
- [x] 前端 audit/index.tsx 修复字段对齐（result/detail/data）、简化筛选器

## 最近操作记录

| 时间         | 操作                                                                          | 状态 |
| ---------- | --------------------------------------------------------------------------- | -- |
| Phase 1 启动 | 初始化项目目录、git仓库、技术选型                                                          | ✅  |
| Phase 1 完成 | Admin API / Admin Web / executor-python / executor-node 骨架 + docker-compose | ✅  |
| Phase 2 完成 | 任务CRUD、调度引擎、执行器注册心跳、前端完整页面集、JWT认证、用户管理                                      | ✅  |
| Phase 5 基础 | AI失败分析、企微/钉钉/邮件通知渠道、失败时自动推送通知                                               | ✅  |
| Phase 3 部分 | Python venv隔离(uv)、manifest.yaml解析、Node node\_modules隔离                      | ✅  |
| Phase 7 完成 | 三个 Controller 接入 AuditService，前端审计日志页修复                                     | ✅  |

## 各模块骨架说明

### admin-api

- NestJS + TypeScript，端口 3001
- 模块：executor（注册/心跳）、task、execution、auth、users、notification、ai、scheduler
- TypeORM + PostgreSQL，BullMQ + Redis
- Swagger 文档：/api/docs

### admin-web

- React 18 + Vite + Ant Design，端口 80
- 页面：任务列表/详情/创建编辑、执行详情、执行器列表、用户管理、登录
- React Query 数据获取，Zustand 状态管理

### executor-python

- FastAPI + uvicorn，端口 8001
- 路由：GET /health、POST /api/execute
- 启动时向 admin-api 注册，每 30s 发送心跳（CPU/内存/运行任务数）
- 支持 python/node/shell 三种 runtime

### executor-node

- Express + TypeScript，端口 8002
- 路由：GET /health、POST /api/execute
- 同 python executor 注册/心跳机制
- 支持 node/shell 两种 runtime

### infra/docker-compose.yml

- 包含：postgres:16、redis:7、admin-api、admin-web、executor-python、executor-node
- postgres/redis 带 healthcheck，admin-api 等待 db/redis 就绪后启动

## 恢复上下文指南

如果 AI 中断，重新开始时请：

1. 阅读本文件了解当前进度
2. 查看最近的 git log 了解已提交内容
3. 检查各模块下是否有 README.md 了解该模块状态
4. 继续下一个未完成的 `[ ]` 项（当前：Phase 3 虚拟环境 & 版本控制）

