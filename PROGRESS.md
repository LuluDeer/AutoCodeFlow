# AutoCodeFlow 开发进度记录

> 本文件用于记录开发进度，防止中断后丢失上下文。每完成一个阶段自动更新。

## 项目简介

AutoCodeFlow 是一个面向开发者的分布式自动化任务编排平台，类比影刀但面向工程师，支持：

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
AutoCodeFlow/
├── apps/
│   ├── admin-api/          # 中台 NestJS API
│   ├── admin-web/          # 中台 React 前端
│   ├── executor-python/    # Python 执行器 Agent
│   ├── executor-node/      # Node.js 执行器 Agent
│   └── registry/           # 包仓库服务
├── packages/
│   ├── autocodeflow-sdk/       # 基础 SDK（Python）
│   ├── autocodeflow-node-sdk/  # Node.js SDK（AutoFlowContext/Logger/HTTP）
│   ├── autocodeflow-http/      # HTTP 封装库
│   ├── autocodeflow-db/        # 数据库连接库
│   ├── autocodeflow-notify/    # 通知库
│   └── autocodeflow-ai/        # AI 分析库
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
- [x] autocodeflow-sdk 基础包（TaskContext/TaskResult/HttpClient/get\_logger）
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

### Phase 8：测试覆盖完善 ✅ 已完成

- [x] task.processor.spec.ts 添加 finally 块 save 失败场景测试
- [x] scheduler.service.spec.ts 添加分布式锁并发场景测试
- [x] executor-python 心跳重试测试（test_scheduler.py）
- [x] auth.service.spec.ts 添加 Refresh Token 吊销测试
- [x] executor 容量限制返回 429 测试
- [x] 子进程环境变量隔离测试（SEC-01）
- [x] 配置 CI 覆盖率门槛（jest 80%/70%，pytest 80%）

### Phase 9：安全加固增强 ✅ 已完成

- [x] 执行器 Token 过期与轮换机制（动态 token，30分钟自动刷新）
- [x] admin-api 添加 /api/executors/token 端点发放动态 token
- [x] executor-python auth.py 支持动态 token 自动刷新
- [x] 心跳验证支持动态 token + 静态 token 双模式

### Phase 10：监控与可观测性优化 ✅ 已完成

- [x] 跨服务请求追踪（Trace ID）—— X-Trace-Id header 在链路中传递
- [x] TraceMiddleware 全局中间件生成和传播 traceId
- [x] TraceService 服务供各模块使用
- [x] executor-python 心跳和执行请求支持 traceId

### Phase 11：高可用与扩展性 ✅ 已完成

- [x] executor-node 动态 Token 支持（与 executor-python 一致）
- [x] 优雅停机机制（SIGTERM/SIGINT 处理，等待任务完成后关闭）
- [x] 离线通知（关闭时向 admin-api 发送 offline 通知）
- [x] 配置热更新端点（POST /api/config/reload）
- [x] Issue1 修复：token 为空时不发送 Authorization 头
- [x] Issue2 修复：uuid 模块移至文件顶部导入

### Phase 12：执行器增强 ✅ 已完成

- [x] 执行器分组与标签功能（分组名/标签数组/描述字段）
- [x] 前端配置热更新管理界面（通过 admin-api 向执行器推送配置）
- [x] 任务超时自动重试机制（BullMQ maxRetry 支持）
- [x] 执行器详情页面（历史任务/性能指标）
  - 后端新增 GET /executors/:id/executions（分页）
  - 后端新增 GET /executors/:id/metrics（7天统计）
- [x] 任务分发支持按分组和标签筛选
- [x] 前端执行器详情页（ExecutorDetailPage）
  - 显示执行器基本信息、分组、标签
  - 显示7天性能指标统计
  - 显示历史任务执行记录
  - 支持编辑执行器元数据
  - 支持配置热更新推送
  - 支持Token轮换
- [x] 前端执行器列表页增强
  - 显示分组和标签列
  - 添加详情跳转按钮
- [x] 前端任务表单增强
  - 添加执行器分组选择
  - 添加执行器标签多选

### Phase 13：功能增强与用户体验优化 ✅ 已完成

- [x] 任务详情页显示执行器分组/标签
- [x] 通知配置管理界面
  - 后端：NotificationConfigController + NotificationConfigService
  - 支持邮件/Slack/钉钉/企业微信渠道配置
  - 支持渠道启用/禁用
  - 支持发送测试通知
- [x] 任务依赖链功能
  - 后端：任务成功后自动触发依赖任务
  - 前端：任务表单支持选择依赖任务
  - 前端：任务详情页显示依赖任务列表

### Phase 14：高级功能增强 ✅ 已完成

- [x] 执行器性能监控增强
  - 新增磁盘使用率、网络延迟、任务统计等扩展指标
  - 前端详情页展示实时资源使用率（CPU/内存/磁盘）图表
  - 前端详情页展示性能统计（成功率、平均耗时等）
- [x] 任务执行历史对比
  - 新增 ExecutionCompare 组件
  - 支持选择多条执行记录进行对比
  - Modal 展示对比表格
- [x] 任务暂停/恢复功能
  - 后端新增 `POST /tasks/:id/pause` 和 `POST /tasks/:id/resume` API
  - 暂停后任务不再被调度，但可手动触发
  - 前端详情页添加暂停/恢复按钮
- [x] 批量操作功能
  - 后端新增批量触发/暂停/恢复/删除 API
  - 前端任务列表页支持多选
  - 批量操作按钮在有选中项时显示

### Phase 15：应用管理与代码完善 ✅ 已完成

- [x] Application 实体创建（name/version/runtime/gitRepo/gitBranch/gitCommit/manifest/env）
- [x] 数据库迁移（AddApplicationAndTaskFields）
- [x] Application CRUD + Git Webhook 自动部署
- [x] manifest.json 自动解析注册任务（syncTasksFromManifest）
- [x] 任务-应用关联（applicationId + @OneToMany）
- [x] 版本回滚支持代码回退（gitCommit）
- [x] SDK 接口一致性统一（fromEnv/from_env 自动初始化）
- [x] CreateTaskDto/UpdateApplicationDto 字段补全
- [x] ApplicationController sync-tasks 端点
- [x] 前端 ApplicationDetailPage（应用详情/Manifest/关联任务/SyncTasks）
- [x] 前端 ApplicationListPage 名称点击跳转详情
- [x] executor-python/.env.example
- [x] executor-node/.env.example 补全

### Phase 18：Bug 修复与安全加固 ✅ 已完成

- [x] executor.controller.ts `timingSafeEqual` 长度不匹配崩溃修复（长度不等时直接拒绝）
- [x] notification.service.ts `sendAll` 空实现修复（实际分发到全部渠道）
- [x] autocodeflow-node-sdk 5/5 单元测试通过

### Phase 16：调度增强与开发体验 ✅ 已完成

- [x] 广播执行模式（ExecuteMode.BROADCAST）
  - ExecutorService.dispatchBroadcast() 并行派发到所有执行器
  - TaskProcessor 自动识别广播模式
- [x] 调度器健康检查端点（GET /tasks/scheduler/stats）
- [x] 前端 Dashboard 调度器状态卡片（定时器/Cron/调度总数/运行时长）
- [x] 前端 tasksApi.schedulerStats() 方法
- [x] Makefile 统一开发命令入口（15+ 命令）
- [x] dev.sh 快速开发启动脚本（start/infra/stop/status/clean）
- [x] .pre-commit-config.yaml 代码质量钩子
- [x] admin-web/.env.example

## 最近操作记录

| 时间         | 操作                                                | 状态 |
| ---------- | --------------------------------------------------------------------------- | -- |
| Phase 1 启动 | 初始化项目目录、git仓库、技术选型                | ✅  |
| Phase 1 完成 | Admin API / Admin Web / executor-python / executor-node 骨架 + docker-compose | ✅  |
| Phase 2 完成 | 任务CRUD、调度引擎、执行器注册心跳、前端完整页面集、JWT认证、用户管理                | ✅  |
| Phase 5 基础 | AI失败分析、企微/钉钉/邮件通知渠道、失败时自动推送通知                                               | ✅  |
| Phase 3 部分 | Python venv隔离(uv)、manifest.yaml解析、Node node\_modules隔离                      | ✅  |
| Phase 7 完成 | 三个 Controller 接入 AuditService，前端审计日志页修复                                     | ✅  |
| Phase 17 完成 | E2E 集成测试（auth/tasks/executors）+ jest-e2e.json + test:e2e 脚本 + docs 四份文档 | ✅  |
| Phase 18 完成 | Bug 修复：timingSafeEqual 崩溃、signal handler 闭包；Node.js SDK 完整实现并通过 5/5 单元测试 | ✅  |
| Phase 19 完成 | 新增测试覆盖：registry-pypi 21/21、autoflow-sdk-node 16/16、Python packages 36/36 全部通过 | ✅  |
| Phase 20 完成 | autoflow-sdk Python 包 61/61 测试全部通过；修复 AsyncHttpClient 代理兼容性（trust_env=False）；升级 TaskConfig 到 Pydantic V2 ConfigDict | ✅  |
| Phase 21 完成 | 全量验证所有 Python 包测试：autocodeflow-http 11/11、autocodeflow-notify 7/7、autocodeflow-db 8/8、autocodeflow-ai 10/10，共 36 个测试全部通过 | ✅  |
| Phase 22 完成 | autoflow-sdk-node 补齐 logger/http/admin 三个测试文件，4 个 suite 共 43 个测试全部通过 | ✅  |

## 恢复上下文指南

如果 AI 中断，重新开始时请：

1. 阅读本文件了解当前进度
2. 当前最高完成阶段：Phase 22（autoflow-sdk-node 补齐测试，全部通过）
3. 所有 CODE_REVIEW.md 审查项均已修复（4.1 getExecutorUrl 已为 public；5.2 Python 超时进程组级别终止已实现；6.4 signal handler 已改用 functools.partial；task.service.ts 循环依赖检测 Bug 修复 Object.keys→Object.values）
4. admin-api 全量 18 suites 214/214 测试全部通过

## 各模块骨架说明

### admin-api

- NestJS + TypeScript，端口 3105
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
| Phase 17 | E2E 集成测试 | admin-api test/ 目录：helpers/app.helper.ts、auth.e2e-spec.ts、tasks.e2e-spec.ts、executors.e2e-spec.ts、jest-e2e.json；package.json 添加 test:e2e 脚本 | ✅ |
