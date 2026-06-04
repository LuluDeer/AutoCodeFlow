# AutoFlow 问题记录与修复追踪

> 本文件由代码审计自动生成，覆盖全部子应用。每修复一项，在状态栏更新。
> 审计时间：2025-06

---

## 优先级说明

- 🔴 Critical — 安全漏洞或可直接导致数据损失/服务中断的 bug
- 🟠 High — 功能 bug 或运行时错误，影响核心流程
- 🟡 Medium — 逻辑缺陷，不立即崩溃但行为不正确
- 🟢 Low — 代码质量、可维护性、缺少测试等改进项

---

## 一、安全类问题

### S-01 🔴 executor /api/execute 端点无认证保护（Node executor）

- **文件**：`apps/executor-node/src/routes/execute.ts`
- **描述**：`POST /api/execute` 路由未加任何认证中间件。任何能访问该端口的人均可提交任意任务在服务器上执行任意代码。`apps/executor-node/src/main.ts` 中 `executorAuthMiddleware` 只保护 `/api/logs` 路由，`/api/execute` 未包含在内。
- **修复建议**：在 `execute` 路由上同样添加 `executorAuthMiddleware`，或将认证中间件提升到 `/api` 前缀级别。

### S-02 🔴 executor /api/execute 端点无认证保护（Python executor）

- **文件**：`apps/executor-python/routers/execute.py` 第 64 行
- **描述**：`@router.post('/execute')` 没有 `Depends(verify_token)`。`/api/logs` 有认证，`/api/execute` 却没有，攻击面一致。
- **修复建议**：为路由加上 `dependencies=[Depends(verify_token)]`。

### S-03 🟠 JWT Secret 默认值不安全

- **文件**：`apps/admin-api/src/config/configuration.ts` 第 7 行
- **描述**：`jwtSecret: process.env.JWT_SECRET || 'autoflow-secret'`，当 `JWT_SECRET` 未设置时退化为已知默认值，可伪造 JWT。
- **修复建议**：去掉默认值；若 `JWT_SECRET` 未设置则在启动时抛出异常拒绝启动。

### S-04 🟠 Executor Shared Token 默认值不安全

- **文件**：`apps/admin-api/src/config/configuration.ts` 第 8 行；`apps/executor-python/auth.py` 第 4 行
- **描述**：`executorSecret: process.env.EXECUTOR_SECRET || ''` 和 Python 侧 `_EXECUTOR_SECRET = ... or ''`，空字符串导致 dev 模式下完全跳过认证，且无任何告警阻止在生产环境沿用。
- **修复建议**：生产环境启动时校验该值非空；开发模式下至少打印明显的 WARNING。

### S-05 🟠 PyPI Registry 默认密码为弱密码

- **文件**：`apps/registry-pypi/main.py` 第 27-28 行
- **描述**：`REGISTRY_PASS = os.getenv("REGISTRY_PASS", "admin123")`，若不设置环境变量则使用极弱的硬编码密码暴露私有包仓库。
- **修复建议**：移除默认值，启动时若 `REGISTRY_PASS` 未设置则拒绝启动。

### S-06 🟠 前端客户端认证检查依赖 localStorage 而非 store

- **文件**：`apps/admin-web/src/router.tsx` 第 16-19 行
- **描述**：`PrivateRoute` 直接读取 `localStorage.getItem('token')` 而非使用 Zustand store。Token 双写到 localStorage（`store/auth.ts` 第 17 行）且 axios interceptor 也直接读 `localStorage`，状态不同步风险存在；更重要的是 token 存放在 localStorage 面临 XSS 盗取风险。
- **修复建议**：统一从 Zustand store 读取；评估是否改用 httpOnly cookie 存储 token。

### S-07 🟠 前端 registry.ts 直接解析 HTML 获取包列表（XSS 风险）

- **文件**：`apps/admin-web/src/api/registry.ts` 第 29-31 行
- **描述**：用正则直接从 PyPI `/simple/` HTML 页面提取包名，若服务端返回恶意 HTML 可能导致 XSS 或数据污染。此外 `listPypiPackages`/`getPypiPackage` 未经过带认证的 axios 客户端，而是用裸 `fetch`，无 CORS 凭证控制。
- **修复建议**：通过后端代理接口返回结构化 JSON；或使用 `DOMParser` + 白名单解析。

### S-08 🟠 Nginx 配置缺少安全响应头和 CSP

- **文件**：`apps/admin-web/nginx.conf`
- **描述**：没有 `Content-Security-Policy`、`X-Frame-Options`、`X-Content-Type-Options`、`Strict-Transport-Security` 等安全响应头，前端面临点击劫持、MIME 嗅探等风险。
- **修复建议**：在 `server` 块中添加标准安全头集合。

### S-09 🟠 Verdaccio 公开访问策略过于宽松

- **文件**：`apps/registry-npm/config.yaml` 第 25-26 行
- **描述**：`'**': access: $all` 允许未认证用户访问所有非 `@autoflow/*` 的 npm 包。虽然是代理到公共 npmjs，但会暴露内部 npm 流量和版本信息。
- **修复建议**：根据安全要求将 `access` 改为 `$authenticated`。

### S-10 🟡 AI Service 将完整错误日志发送给 OpenAI/Ollama

- **文件**：`apps/admin-api/src/modules/ai/ai.service.ts`
- **描述**：`analyzeFailure` 将 `logs`（可能包含环境变量、密码、内部路径）原文发送给外部 AI 接口，存在数据泄露风险。
- **修复建议**：对日志内容做脱敏处理（剔除 env var 格式字符串、长 token 等）后再上传；或提供开关控制是否启用 AI 分析。

### S-11 🟡 admin-api 未配置全局请求体大小限制

- **文件**：`apps/admin-api/src/main.ts`
- **描述**：NestJS 默认 body 限制为 100 KB，但日志回调等接口可能接收大量数据，未显式配置可能被滥用进行 DoS。
- **修复建议**：`app.use(express.json({ limit: '1mb' }))` 或在 NestJS 中配置合适的 `bodyParser` 限制。

---

## 二、运行时 Bug 与功能缺陷

### B-01 🔴 TaskDetailPage 使用了未导入的组件

- **文件**：`apps/admin-web/src/pages/TaskDetailPage.tsx` 第 17-19、56、60-70 行
- **描述**：组件内使用了 `useState`、`Modal`、`Input`、`RollbackOutlined` 但文件顶部完全没有 import。这会导致运行时 `ReferenceError`，回滚功能完全无法使用。
- **修复建议**：添加缺少的 import：`import { useState } from 'react'`；从 antd 导入 `Modal`、`Input`；从 `@ant-design/icons` 导入 `RollbackOutlined`。

### B-02 🟠 users.ts API 客户端引用不存在的导出

- **文件**：`apps/admin-web/src/api/users.ts` 第 1 行
- **描述**：`import { apiClient } from './client'`，但 `client.ts` 只导出 `client`，不存在 `apiClient`。`metrics.ts` 同样有此问题（第 1 行）。这会导致 users 相关所有接口调用时运行时报错。
- **修复建议**：将 `import { apiClient }` 改为 `import { client as apiClient }` 或统一导出名。

### B-03 🟠 执行器 dispatch 选择策略不完善（竞态风险）

- **文件**：`apps/admin-api/src/modules/executor/executor.service.ts`
- **描述**：`dispatch` 方法先 `find` 找出所有在线执行器，再通过 `runningTaskCount < maxConcurrentTasks` 过滤，然后选负载最低的。但 `increment` 操作在 HTTP 请求后才执行，并发任务调度时多个任务可能同时选中同一执行器，超出其并发限制。
- **修复建议**：使用数据库乐观锁或 Redis 原子计数来保证调度的原子性。

### B-04 🟠 scheduler.service 固定频率任务不保证幂等

- **文件**：`apps/admin-api/src/modules/scheduler/scheduler.service.ts`
- **描述**：`scheduleFixedRate` 使用 `setInterval`，若上一次执行还未结束，下一次调度就会再次触发，导致并发执行同一任务。
- **修复建议**：追踪每个任务是否正在执行，若正在执行则跳过本次调度；或改用 BullMQ 队列串行化。

### B-05 🟡 Python executor 日志文件路径拼接错误

- **文件**：`apps/executor-python/routers/execute.py` 第 174 行
- **描述**：`log_file = work_dir / f'{req.executionId}.log'`，日志写在 `work_dir`（即 `<base>/<executionId>/`）下，但 `/api/logs/:execution_id` 读取的路径是 `base / f'{execution_id}.log'`（`logs.py` 第 29 行），少了一级目录，日志读取接口永远返回 404。
- **修复建议**：统一日志路径为 `base / execution_id / f'{execution_id}.log'`，或修改 logs.py 中的路径拼接。

### B-06 🟡 Node executor 任务超时后子进程可能未被杀死

- **文件**：`apps/executor-node/src/routes/execute.ts`
- **描述**：超时逻辑调用 `proc.kill()`，但 `spawn` 以默认方式启动，不是进程组，子进程衍生的子进程不会被一起杀掉，可能产生僵尸进程。
- **修复建议**：使用 `spawn` 的 `detached: true` + `process.kill(-proc.pid)` 杀掉整个进程组，或使用 `tree-kill` 包。

### B-07 🟡 BullMQ 队列处理器注册方式不规范

- **文件**：`apps/admin-api/src/modules/task/task.processor.ts`
- **描述**：`TaskProcessor` 没有使用 `@nestjs/bullmq` 的 `@Processor()` 和 `@OnWorkerEvent()` 装饰器，而是手动创建 Worker 实例。这绕过了 NestJS DI 生命周期，可能导致优雅关闭时 Worker 未正确关闭，连接泄漏。
- **修复建议**：改用 `@nestjs/bullmq` 官方提供的 `@Processor` 装饰器方式注册。

### B-08 🟡 notification 服务 Webhook 失败不上报

- **文件**：`apps/admin-api/src/modules/notification/notification.service.ts`
- **描述**：`notifyFailureWithConfig` 内部 try/catch 吞掉了所有通知渠道的错误，仅打印 warn 日志，任务执行失败的通知悄悄丢失也不会有任何可见反馈。
- **修复建议**：将通知失败记录到审计日志或单独的通知失败表，以便排查。

---

## 三、代码质量与架构问题

### Q-01 🟡 ExecuteRequest 在 executor-python 中定义了两次

- **文件**：`apps/executor-python/routers/execute.py` 第 20-23 行 和 第 58-61 行
- **描述**：文件顶部有一个 try/except 导入 SDK 的 `ExecuteRequest` 并提供 fallback 定义，第 58 行又重新定义了一个同名的 `ExecuteRequest`（覆盖了前者），导致 SDK 集成完全无效，始终使用本地定义。
- **修复建议**：删除第 58-61 行的重复定义，直接使用 SDK 的模型。

### Q-02 🟡 双重 token 存储导致状态不一致

- **文件**：`apps/admin-web/src/store/auth.ts` 第 17 行；`apps/admin-web/src/api/client.ts` 第 11 行
- **描述**：token 同时存储在 Zustand persist（写入 localStorage key `autoflow-auth`）和直接写入 `localStorage.getItem('token')`，两个 key 不同，读写逻辑不统一，可能出现 store 有 token 但 axios 读不到的问题。
- **修复建议**：axios interceptor 改为从 Zustand store 读取 token，不直接访问 localStorage。

### Q-03 🟡 metrics.ts 和 users.ts 使用 .then(r => r.data) 但 client 已经解包

- **文件**：`apps/admin-web/src/api/metrics.ts` 第 39-42 行；`apps/admin-web/src/api/users.ts` 第 27-39 行
- **描述**：axios 响应拦截器 `(res) => res.data` 已将响应解包为 data，`metrics.ts` 再次 `.then(r => r.data)` 会得到 `undefined`。`users.ts` 使用 `apiClient`（不存在的导出）且对响应结构假设也不一致。
- **修复建议**：统一 API 层，移除多余的 `.then(r => r.data)` 调用。

### Q-04 🟡 HttpClient SDK 只提供同步 httpx.Client，不支持 async

- **文件**：`packages/autoflow-sdk/autoflow_sdk/http.py`
- **描述**：`HttpClient` 使用同步 `httpx.Client`，但 executor-python 整体是 async FastAPI 应用。在协程中调用同步 HTTP 请求会阻塞事件循环。
- **修复建议**：提供 `AsyncHttpClient` 使用 `httpx.AsyncClient`，或文档说明需在线程池中调用。

### Q-05 🟡 autoflow-sdk pyproject.toml 依赖版本范围过宽

- **文件**：`packages/autoflow-sdk/pyproject.toml` 第 11-13 行
- **描述**：`httpx>=0.24.0` 和 `pyyaml>=6.0` 使用了开放的下界约束，`setup.py` 也一样，安装时可能拉取未验证的新版本，破坏兼容性。
- **修复建议**：指定上界约束，如 `httpx>=0.24.0,<1.0`；或改用精确版本锁定。

### Q-06 🟡 admin-web package.json 全部使用 ^ 版本范围

- **文件**：`apps/admin-web/package.json`
- **描述**：所有依赖均为 `^` 版本，包括 antd、react-router-dom 等，CI 每次安装可能得到不同版本，破坏可复现性。
- **修复建议**：使用 `package-lock.json` 锁定依赖（已有 lock 文件），CI 中使用 `npm ci` 而非 `npm install`。

### Q-07 🟢 大量使用 `any` 类型

- **文件**：多处，包括 `tasks.ts`（第 13 行 `params?: Record<string, any>`）、`store/auth.ts`（第 7 行 `user: any`）、`TaskFormPage.tsx`（第 18 行 `values: any`）等
- **描述**：过度使用 `any` 放弃了 TypeScript 的类型检查优势，可能掩盖运行时错误。
- **修复建议**：为 API 响应、用户对象等定义具体类型；开启 `noImplicitAny` 编译选项。

### Q-08 🟢 executor-python Dockerfile 以 root 身份运行

- **文件**：`apps/executor-python/Dockerfile`
- **描述**：没有 `USER` 指令，容器以 root 运行，且任务也以 root 执行，容器逃逸风险高。
- **修复建议**：添加 `RUN useradd -m appuser && USER appuser`；考虑使用 seccomp/AppArmor 限制系统调用。

### Q-09 🟢 executor-node Dockerfile 以 root 身份运行

- **文件**：`apps/executor-node/Dockerfile`
- **描述**：同上，无 `USER` 指令。
- **修复建议**：同 Q-08。

### Q-10 🟢 admin-api Dockerfile 以 root 身份运行

- **文件**：`apps/admin-api/Dockerfile`
- **描述**：同上。
- **修复建议**：添加非特权用户。

---

## 四、API 设计与一致性问题

### A-01 🟡 /api/execute 与 /api/logs 路径不一致（Node executor）

- **文件**：`apps/executor-node/src/main.ts` 第 11-12 行
- **描述**：`app.use('/api', executeRouter)` 和 `app.use('/api', logsRouter)` 分别注册，logs 路由路径为 `/logs/:executionId`，而 admin-api 中 `ExecutorService` 调用的 log 拉取路径为 `/api/logs/:executionId`——路径正确，但 executor 注册认证中间件时仅对 `/api/logs` 生效，execute 路由未受保护（见 S-01）。

### A-02 🟡 admin-api 缺少全局请求速率限制

- **文件**：`apps/admin-api/src/main.ts`
- **描述**：整个 API 服务没有配置速率限制（throttler），login 端点可被暴力破解，触发接口可被刷。
- **修复建议**：安装 `@nestjs/throttler`，对 login 等敏感端点配置更严格的速率限制。

### A-03 🟡 任务触发接口返回值不统一

- **文件**：`apps/admin-api/src/modules/task/task.controller.ts`
- **描述**：`trigger` 返回 `{ message, executionId }`，`rollback` 返回 `{ message, executionId, gitCommit }`，其他 CRUD 接口通过 `ResponseInterceptor` 包装，前端需要区别处理。
- **修复建议**：统一所有接口的响应格式。

### A-04 🟢 /metrics/* 端点无分页，返回全量数据

- **文件**：`apps/admin-api/src/modules/metrics/metrics.service.ts`
- **描述**：`getRecentFailures` 硬编码 `take: 10`，`getDailyTrend` 硬编码最多 30 天，这些值未通过参数暴露，扩展性差。
- **修复建议**：将 `limit`/`days` 等参数通过 query string 暴露。

---

## 五、数据库与性能问题

### D-01 🟡 ExecutionLogLine 实体缺少核心索引

- **文件**：`apps/admin-api/src/modules/task/entities/execution-log-line.entity.ts`
- **描述**：`executionId` 字段没有数据库索引（没有 `@Index()` 装饰器），`fetchAndStoreLogLines` 按 executionId 查询时全表扫描，在日志量大时性能极差。
- **修复建议**：在 `executionId` 字段添加 `@Index()` 装饰器，并生成对应 migration。

### D-02 🟡 TaskExecution 表缺少常用查询索引

- **文件**：`apps/admin-api/src/modules/task/entities/task-execution.entity.ts`
- **描述**：按 `taskId`、`status`、`startTime` 的查询很频繁，但都没有索引。
- **修复建议**：添加 `@Index()` 到 `taskId` 和 `status` 字段。

### D-03 🟡 metrics 查询使用原生 SQL 但参数可信度高

- **文件**：`apps/admin-api/src/modules/metrics/metrics.service.ts`
- **描述**：`getDailyTrend` 使用 TypeORM QueryBuilder 拼接参数，参数经过了类型验证，无明显 SQL 注入风险，但 raw query 部分需注意维护。整体安全，记录为低优先级跟踪。

### D-04 🟢 AuditLog 表 detail 字段使用 jsonb 但无索引

- **文件**：`apps/admin-api/src/modules/audit/entities/audit-log.entity.ts`
- **描述**：`detail` 为 `jsonb` 类型，若未来需要按 detail 内容查询则全表扫描，可预先规划 GIN 索引。

---

## 六、基础设施与容器化问题

### I-01 🟡 docker-compose.yml 暴露不必要的端口到宿主机

- **文件**：`docker-compose.yml` 第 15、30 行
- **描述**：PostgreSQL（5432）和 Redis（6379）端口直接映射到宿主机，生产环境中数据库不应暴露到宿主网络。
- **修复建议**：移除 postgres 和 redis 的 `ports` 配置，让它们只在 Docker 内部网络中通信。

### I-02 🟡 executor 容器 WORK_DIR 使用 /tmp

- **文件**：`docker-compose.yml` 第 87、104 行
- **描述**：`WORK_DIR: /tmp/autoflow/tasks`，`/tmp` 在容器重启后会被清空，任务工作目录、持久化的 venv、node_modules 缓存全部丢失，重启后第一次执行性能极差。
- **修复建议**：挂载持久化 Volume 到工作目录。

### I-03 🟢 缺少 .dockerignore 文件

- **文件**：所有应用目录
- **描述**：没有 `.dockerignore`，构建镜像时会把 `node_modules`、`.git`、测试文件等全部打包，增大镜像体积和构建时间。
- **修复建议**：添加各应用的 `.dockerignore`。

### I-04 🟢 executor-python 用 pip 安装 uv，但 uv 本身也可用于管理依赖

- **文件**：`apps/executor-python/Dockerfile` 第 6 行
- **描述**：`RUN pip install --no-cache-dir uv` 混用 pip 和 uv，建议使用 uv 官方安装方式以获得更稳定的版本控制。
- **修复建议**：使用 `RUN curl -LsSf https://astral.sh/uv/install.sh | sh` 或固定版本安装。

---

## 七、测试覆盖问题

### T-01 🟡 Python executor 完全缺少单元测试

- **文件**：`apps/executor-python/`
- **描述**：整个 Python executor 目录没有任何 `*_test.py` 或 `test_*.py` 文件，核心逻辑（路径遍历防护、运行时分发、venv 管理）未经测试。
- **修复建议**：添加 pytest 测试，至少覆盖：路径遍历拒绝、不支持 runtime 返回 400、认证拒绝。

### T-02 🟡 admin-api 大多数模块缺少测试

- **文件**：`apps/admin-api/src/`
- **描述**：仅有 `auth.service.spec.ts`、`executor.service.spec.ts`、`task.processor.spec.ts` 三个测试文件。`TaskService`、`UsersService`、`NotificationService`、`AiService`、`SchedulerService`、`MetricsService`、`ConfigService` 等均无测试。
- **修复建议**：至少为 TaskService（核心调度逻辑）和 NotificationService 补充测试。

### T-03 🟢 前端完全缺少测试

- **文件**：`apps/admin-web/`
- **描述**：没有任何前端测试（无 vitest、jest、playwright 配置），`package.json` 也没有 test 脚本。
- **修复建议**：引入 Vitest + React Testing Library，至少对关键页面组件添加渲染测试。

### T-04 🟢 executor-node 测试仅覆盖 execute 路由，缺少集成测试

- **文件**：`apps/executor-node/src/routes/execute.spec.ts`
- **描述**：现有测试是好的起点，但缺少：日志路由测试、心跳/注册流程测试、git clone 路径的集成测试。

---

## 八、文档与工程规范问题

### E-01 🟢 缺少 README.md

- **文件**：项目根目录
- **描述**：项目根目录没有 README.md，新成员无法快速了解如何启动和开发。PROGRESS.md 填补了部分功能但不是标准入口。
- **修复建议**：添加 README.md，包含架构概览、快速启动步骤、环境变量说明。

### E-02 🟢 缺少 .gitignore

- **文件**：项目根目录
- **描述**：未确认根目录存在 `.gitignore`，可能导致 `node_modules`、`dist`、`.env` 等被误提交。
- **修复建议**：添加涵盖 Node.js、Python、Docker 的 `.gitignore`。

### E-03 🟢 .env.example 缺少部分变量

- **文件**：`.env.example` 和 `apps/admin-api/.env.example`
- **描述**：`docker-compose.yml` 中引用的 `PYPI_API_KEY`、`REGISTRY_USER`、`REGISTRY_PASS` 等变量在根 `.env.example` 中未列出；executor 侧 `EXECUTOR_SHARED_TOKEN` 和 `EXECUTOR_SECRET` 命名不一致（两个不同的环境变量名指向同一个 token）。
- **修复建议**：补全 `.env.example`，统一 token 环境变量名称。

### E-04 🟢 缺少 CI/CD 配置

- **文件**：项目根目录
- **描述**：没有 `.github/workflows/`、`.gitlab-ci.yml` 或任何 CI 配置，没有自动化测试、lint、安全扫描。
- **修复建议**：添加 GitHub Actions（或等效）workflow：lint + test + docker build。

---

## 问题汇总表

| ID | 严重性 | 模块 | 标题 | 状态 |
|---|---|---|---|---|
| S-01 | 🔴 Critical | executor-node | /api/execute 无认证 | **fixed** |
| S-02 | 🔴 Critical | executor-python | /api/execute 无认证 | **fixed** |
| S-03 | 🟠 High | admin-api | JWT Secret 弱默认值 | **fixed** |
| S-04 | 🟠 High | admin-api/executor | Executor Token 空默认值 | **fixed** |
| S-05 | 🟠 High | registry-pypi | 硬编码弱密码 | **fixed** |
| S-06 | 🟠 High | admin-web | 前端认证读 localStorage | **fixed** |
| S-07 | 🟠 High | admin-web | registry 裸 HTML 解析 XSS 风险 | **fixed** |
| S-08 | 🟠 High | admin-web | Nginx 缺安全响应头 | **fixed** |
| S-09 | 🟠 High | registry-npm | Verdaccio 访问策略宽松 | **fixed** |
| S-10 | 🟡 Medium | admin-api | AI 日志数据泄露 | **fixed** |
| S-11 | 🟡 Medium | admin-api | 缺全局请求体限制 | **fixed** |
| B-01 | 🔴 Critical | admin-web | TaskDetailPage 缺少 import | **fixed** |
| B-02 | 🔴 Critical | admin-web | users/metrics 引用不存在的 apiClient | **fixed** |
| B-03 | 🟠 High | admin-api | 执行器调度竞态 | **fixed** |
| B-04 | 🟠 High | admin-api | 固定频率任务无幂等保护 | **fixed** |
| B-05 | 🟡 Medium | executor-python | 日志文件路径不一致 | **fixed** |
| B-06 | 🟡 Medium | executor-node | 超时后子进程未完全杀死 | **fixed** |
| B-07 | 🟡 Medium | admin-api | BullMQ Worker 注册方式不规范 | **fixed** |
| B-08 | 🟡 Medium | admin-api | 通知失败静默丢弃 | **fixed** |
| Q-01 | 🟡 Medium | executor-python | ExecuteRequest 双重定义 | **fixed** |
| Q-02 | 🟡 Medium | admin-web | Token 双重存储状态不一致 | **fixed** |
| Q-03 | 🟡 Medium | admin-web | 响应解包双重 .data | **fixed** |
| Q-04 | 🟡 Medium | autoflow-sdk | HttpClient 不支持 async | **fixed** |
| Q-05 | 🟡 Medium | autoflow-sdk | 依赖版本范围过宽 | N/A (packages 目录不存在) |
| Q-06 | 🟡 Medium | admin-web | package.json 使用 ^ 版本 | N/A (Vite 前端标准实践，可接受) |
| Q-07 | 🟢 Low | admin-web/admin-api | 大量 any 类型 | **fixed** |
| Q-08 | 🟢 Low | executor-python | Dockerfile root 用户运行 | **fixed** |
| Q-09 | 🟢 Low | executor-node | Dockerfile root 用户运行 | **fixed** |
| Q-10 | 🟢 Low | admin-api | Dockerfile root 用户运行 | **fixed** |
| A-01 | 🟡 Medium | admin-api | 路由路径不一致 | open |
| A-02 | 🟡 Medium | admin-api | 缺全局速率限制 | **fixed** |
| A-03 | 🟡 Medium | admin-api | 触发接口响应格式不统一 | open |
| A-04 | 🟢 Low | admin-api | metrics 无分页参数 | N/A (聚合查询，不适用分页) |
| D-01 | 🟡 Medium | admin-api | ExecutionLogLine 缺 executionId 索引 | **fixed** |
| D-02 | 🟡 Medium | admin-api | TaskExecution 缺常用查询索引 | **fixed** |
| D-03 | 🟢 Low | admin-api | metrics 原生 SQL 维护性 | **fixed** |
| D-04 | 🟢 Low | admin-api | AuditLog detail jsonb 无 GIN 索引 | **fixed** |
| I-01 | 🟡 Medium | infra | DB/Redis 端口暴露到宿主 | **fixed** |
| I-02 | 🟡 Medium | infra | executor WORK_DIR 用 /tmp | **fixed** |
| I-03 | 🟢 Low | infra | 缺 .dockerignore | **fixed** |
| I-04 | 🟢 Low | executor-python | pip 安装 uv 不规范 | open (低优先级，当前方案可用) |
| T-01 | 🟡 Medium | executor-python | 完全缺少测试 | **fixed** |
| T-02 | 🟡 Medium | admin-api | 大多数模块缺少测试 | open |
| T-03 | 🟢 Low | admin-web | 完全缺少测试 | open |
| T-04 | 🟢 Low | executor-node | 测试覆盖不足 | open |
| E-01 | 🟢 Low | 项目 | 缺少 README.md | open |
| E-02 | 🟢 Low | 项目 | 缺少 .gitignore | **fixed** |
| E-03 | 🟢 Low | 项目 | .env.example 不完整 | **fixed** |
| E-04 | 🟢 Low | 项目 | 缺少 CI/CD 配置 | open |
