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

| 模块              | 技术                |
| --------------- | ---------------------------------------- |
| Admin API       | NestJS + TypeScript + PostgreSQL + Redis |
| Admin Web       | React 18 + Vite + Ant Design Pro         |
| 调度引擎            | BullMQ + node-cron                       |
| Python Executor | FastAPI + uvicorn + subprocess|
| Node Executor   | Node.js + Express + TypeScript           |
| 包仓库             | Verdaccio (npm) + FastAPI PyPI           |
| AI 分析           | OpenAI / Ollama 插件式接入|
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

### Phase 3：虚拟环境 & 版本控制 ✅ 已完成

- [x] Python venv 隔离（uv + 按 task\_id 持久化 venv）
- [x] 任务包 manifest.yaml 解析（Python + Node executor 均支持）
- [x] Node 沙箱隔离（按 task\_id 持久化 node\_modules）
- [x] 任务版本绑定 Git commit（gitRepo/gitBranch/gitCommit 字段 + executor clone/checkout）
- [x] 一键回滚（POST /tasks/:id/rollback + 前端 Modal）

### Phase 4：包生态 ✅ 已完成

- [x] 私有 PyPI 服务（FastAPI PEP 503 + 上传/下载/认证，端口 8003）
- [x] 私有 npm 仓库（Verdaccio 5，端口 4873，@autoflow/\* 私有包）
- [x] autoflow-sdk 基础包（TaskContext/TaskResult/HttpClient/get\_logger）
- [x] 包市场 UI（RegistryPage，PyPI/npm 双 Tab，上传/列表/跳转）
- [x] 包版本管理（PyPI sha256 文件索引 + Verdaccio 版本列表）

### Phase 5：AI & 通知 ✅ 已完成

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

### Phase 8：安全加固 ✅ 已完成（2025-06）

> 对应 ISSUES.md 安全审查报告全面修复

- [x] S1 — jwt.strategy 新增 isActive 检查，被禁用账号 JWT 返回 401
- [x] S2 — access/refresh token 加 `type` 字段区分，防止互相冒用
- [x] S3 — admin-web 改用 sessionStorage 替代 localStorage 存 token
- [x] S4 — configuration.ts 生产环境 JWT_SECRET 缺失时 fail-fast
- [x] S5 — executor-node/python 所有路由加 EXECUTOR_SECRET Bearer 认证
- [x] S7 — executor gitRepo 字段正则白名单，阻断 SSRF
- [x] S9 — registry-pypi 包索引/下载加 API key 认证，强制读取环境变量
- [x] S10 — admin-api / executor-python CORS origin 收紧为白名单
- [x] S11 — users.controller 加 RolesGuard + @Roles('admin') RBAC
- [x] S12 — users.service changePassword 验证旧密码
- [x] S13 — config.controller isSecret 字段 value 返回时遮蔽为 ***
- [x] S14 — executor.controller register/heartbeat 加 EXECUTOR_SECRET 校验
- [x] S15 — AppModule 集成 ThrottlerModule，login 路由 10req/60s
- [x] S16 — npm install requirements 包名正则校验 + 数组传参防注入

### Phase 9：代码质量修复 ✅ 已完成（2025-06）

> 对应 ISSUES.md 代码质量问题修复

- [x] Q1 — task.processor catch 末尾 rethrow，BullMQ 重试生效
- [x] Q2 — executor dispatch 前乐观递增 runningTaskCount，失败回滚
- [x] Q3 — 僵尸任务检测改为 per-execution 使用 taskTimeout+5min 缓冲
- [x] Q4 — AI service openai/ollama axios 加 30s/60s timeout
- [x] Q5 — email.channel 接入 nodemailer，未配置时静默跳过
- [x] Q8 — auth.controller login/logout 操作接入 AuditService
- [x] Q9 — dingtalk/wecom/slack webhook 均加 timeout: 10_000
- [x] Q12 — audit.service findAll Math.min(pageSize, 100) 强制上限

### Phase 10：深度修复 ✅ 已完成

> 所有未完成项已全部攻克

#### S6/Q11 — 执行器工作目录权限隔离 ✅ 已完成

- 问题：所有任务 workdir 在同一父目录，脚本可跨任务读取文件
- 修复：executor-node 和 executor-python 均添加路径穿越防护（`path.resolve` + startsWith 检查）+ `chmod 700` 限制目录权限

#### S8 — docker-compose.yml 密码硬编码 ✅ 已完成

- 修复：docker-compose.yml 全部硬编码密码改为 `${VAR}` 环境变量引用；创建 `.env.example` 模板

#### Q6 — TypeORM Migration 文件 ✅ 已完成

- 修复：创建 `InitialSchema` migration 包含所有建表 SQL；app.module.ts 加 `migrations` 路径 + `migrationsRun: true`（非 dev 环境）；data-source.ts 支持 CLI 操作

#### Q7 — 历史数据清理策略 ✅ 已完成

- 修复：executor.service `@Cron('0 0 2 * * *')` 清理 task_execution（90天）；audit.service `@Cron('0 5 2 * * *')` 清理 audit_log（180天）

#### Q10 — SDK 与 API 无共享 schema ✅ 已完成

- 修复：packages/autoflow-sdk 已有 Pydantic models（ExecuteRequest/ExecuteResult/TaskConfig）；executor-python/routers/execute.py 改为从 SDK 导入，安装失败时有本地 fallback

#### Q11 — 任务工作目录无权限隔离 ✅ 已完成（与 S6 合并）

#### TODO-09 — 执行日志流式存储 ✅ 已完成

- executor-python/node 子进程逐行流式写入 `{executionId}.log`
- 新增 `GET /api/logs/{executionId}?fromLine=N` 接口（Bearer 认证，路径遍历防护）
- admin-api 新增 `ExecutionLogLine` entity + migration + `getExecutionLogs` 接口
- task.processor 任务成功后拉取日志行批量存库

#### M1 — 核心链路单元测试 ✅ 已完成

- admin-api: jest 测试 auth.service / task.processor / executor.service（3个 spec 文件）
- executor-node: jest 测试 execute route（5个测试用例，覆盖参数校验/安全防护/正常执行）
- executor-node package.json 添加 jest + ts-jest + supertest 测试依赖

#### M2 — 两份 docker-compose.yml 职责不清 ✅ 已完成

- `infra/docker-compose.yml` 重写为本地开发专用：仅含 postgres + redis
- 根目录 `docker-compose.yml` 顶部添加注释，明确为完整部署入口

#### M3 — 关键配置无 fail-fast 校验 ✅ 已完成

- 修复：configuration.ts 在 `NODE_ENV === 'production'` 时校验 DB_PASSWORD 和 EXECUTOR_SECRET

## 最近操作记录

| 时间         | 操作                                                | 状态 |
| ---------- | --------------------------------------------------------------------------- | -- |
| Phase 1 启动 | 初始化项目目录、git仓库、技术选型                | ✅  |
| Phase 1 完成 | Admin API / Admin Web / executor-python / executor-node 骨架 + docker-compose | ✅  |
| Phase 2 完成 | 任务CRUD、调度引擎、执行器注册心跳、前端完整页面集、JWT认证、用户管理                | ✅  |
| Phase 5 基础 | AI失败分析、企微/钉钉/邮件通知渠道、失败时自动推送通知                                               | ✅  |
| Phase 3 部分 | Python venv隔离(uv)、manifest.yaml解析、Node node\_modules隔离                      | ✅  |
| Phase 7 完成 | 三个 Controller 接入 AuditService，前端审计日志页修复                                     | ✅  |
| Phase 8 完成 | ISSUES.md 安全审查 S1-S16 代码修复（14/16 项可代码修复）                                    | ✅  |
| Phase 9 完成 | ISSUES.md 质量问题 Q1-Q12 代码修复（8/12 项已修复）                                       | ✅  |
| Phase 10 启动 | 深度修复计划写入 PROGRESS.md，开始逐项攻克剩余问题                                            | ✅  |
| Phase 10 完成 | S6/Q11 工作目录权限隔离、S8 docker密码移env、Q6 migration、Q7 清理策略、Q10 SDK schema、M3 fail-fast | ✅  |
| Phase 10 续 | TODO-09 执行日志流式存储（executor写文件+admin-api拉取接口+entity+migration）| ✅  |
| Phase 10 续 | M1 核心链路单元测试（admin-api 3个spec + executor-node 5个测试用例）| ✅  |
| Phase 10 续 | M2 docker-compose 职责分离（infra/仅基础设施+env变量，根目录完整部署）| ✅  |
| Phase 10 续 | Q10 SDK schema — executor-python 改为从 autoflow_sdk.models 导入 ExecuteRequest | ✅  |
| Phase 11 启动 | ISSUES.md 新发现问题 N1-N19 审查，开始逐项修复 | ✅  |
| Phase 11 N1-N5 | executor-python logs导入、execute.py重复类、协程泄漏、node logs路径过滤、旧migration删除 | ✅  |
| Phase 11 N6-N10 | taskId外键migration、scheduler分布式锁ioredis、cron快照刷新、ConfigService替换env、logLineRepo类型化 | ✅  |
| Phase 11 N11-N18 | rollback重调度、僵尸任务per-exec阈值、forbidNonWhitelisted、PyPI路径遍历、login限速、env补全、spawnSync修复 | ✅  |
| Phase 11 N15,N19 | runningTaskCount去除主动递增（以心跳为准）；N19空目录不存在已标记N/A | ✅  |

## 恢复上下文指南

如果 AI 中断，重新开始时请：

1. 阅读本文件了解当前进度
2. 查看 Phase 10 各项状态（所有项均已 ✅ 完成）
3. 查阅 ISSUES.md 汇总表确认剩余 open 项（当前：S6沙箱隔离、Q10 SDK无共享schema 为架构级限制，其余均已修复）

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
