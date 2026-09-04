# R4-D 跨端契约一致性与测试缺口审计（review_round4_contract.md）

- 审计人：R4-D agent
- 日期：2026-09-02
- 范围：apps/admin-web（Next.js/React→实际 Vite+React）、packages/acf-cli、packages/mcp-server 对照 apps/admin-api 真实 controller/DTO（只读参考）
- 方法：静态逐一对账（调用方 file:line + 被调方 file:line）、`npm run lint`、三端 `npx tsc --noEmit`；未跑全量 jest
- 定级：P0=主流程断裂；P1=特定功能不可用；P2=健壮性/错误处理缺陷；P3=建议
- 关键背景：全局 ValidationPipe `whitelist + forbidNonWhitelisted`（apps/admin-api/src/main.ts:180-188）——**DTO 未声明的 query/body 字段一律 400**，这是本轮多个发现的总根因。

---

## 一、发现列表

### [P0] acf-cli 登录读取 `access_token`，后端返回 `accessToken` —— CLI 登录后所有命令 401
- 证据：
  - 调用方：packages/acf-cli/src/commands/login.ts:31-33 `post<{ access_token: string }>('/auth/login', ...)` → `setToken(data.access_token)`
  - 被调方：apps/admin-api/src/modules/auth/auth.service.ts:139 `return { accessToken, refreshToken }`（generateTokens）
- 运行时后果：登录"成功"提示后，`setToken(undefined)`（conf store 写入 undefined）→ 后续所有请求发送 `Bearer undefined` → 401。**整个 CLI（task/app/executor 全部命令）不可用**。admin-web 不受影响（读 accessToken 正确）。
- confidence: verified（两端代码直接对读；验证方法：`acf login` 后 `acf task list`）
- 建议修复：login.ts 改读 `data.accessToken`（建议同时持久化 refreshToken 以便刷新）。
- 测试影响：CLI 无任何测试（见第五节），补一条 login→list 的契约冒烟即可永久守住。

### [P0] 应用编辑恒 400：前端 PATCH/PUT 带 `name`，`UpdateApplicationDto` 不含 `name`
- 证据：
  - 调用方1：apps/admin-web/src/pages/ApplicationDetailPage.tsx:274-276 `form.validateFields()`（表单含 `name`，见 :288）→ `applicationsApi.update(app.id, values)`
  - 调用方2：apps/admin-web/src/pages/ApplicationListPage.tsx:135（编辑共用弹窗，表单含 `name`，:399）→ `applicationsApi.update(editingApp.id, values)`
  - 被调方：apps/admin-api/src/modules/application/dto/application.dto.ts `UpdateApplicationDto`（description/version/runtime/status/gitRepo/gitBranch/gitCommit/manifest/env/entrypoint/packageUrl/webhookSecret —— **无 name**）；main.ts:186 `forbidNonWhitelisted: true`
- 运行时后果：任何一次"编辑应用"（改名或改任意字段）都会 400 `property name should not exist`，保存失败。应用创建（CreateApplicationDto 有 name）不受影响。
- confidence: verified（代码对读；验证方法：PUT /api/applications/:id 带 {"name":"x"} 观察 400）
- 建议修复：UpdateApplicationDto 增加 `@IsOptional() @IsString() @MaxLength(100) name?`（service.update 的 Object.assign 已支持），或前端编辑提交前剔除 name。
- 测试影响：application.controller.spec 只覆盖 webhook；补 update 白名单用例。

### [P1] 配置历史恒 400：`GET /config/history` 的 `key` 查询参数被 PaginationDto 白名单拒绝
- 证据：
  - 调用方：apps/admin-web/src/api/config.ts:50-51 `getHistory({ key, page, pageSize })`；settings/index.tsx:177 恒传 `key: configKey`
  - 被调方：apps/admin-api/src/modules/config/config.controller.ts:46-48 `getHistory(@Query("key") key?, @Query() pagination?: PaginationDto)` —— PaginationDto（common/dto/pagination.dto.ts）无 `key` 字段，`forbidNonWhitelisted` 对整个 query 对象校验
- 运行时后果：设置页"变更历史"抽屉**每次打开都 400**（key 恒传）。后端本意是单独提取 key，但同一 query 对象又被第二个参数校验。
- confidence: verified（NestJS ValidationPipe 标准语义；验证方法：GET /api/config/history?key=x&pageSize=50 → 400 property key should not exist）
- 建议修复：controller 手动取 `page/pageSize`（同 config.findAll 的 @Query("prefix") 模式），或为 history 建 `QueryHistoryDto`（含 key）。
- 测试影响：config.service.spec 已有；补 controller 层 query 校验用例。

### [P1] 审计页搜索恒 400：`GET /audit` 的 action/resource/username/startTime/endTime 均不在 PaginationDto 白名单
- 证据：
  - 调用方：apps/admin-web/src/pages/audit/index.tsx:37-42 传 action/resource/username/startTime/endTime
  - 被调方：apps/admin-api/src/modules/audit/audit.controller.ts:23-32 `findAll(@Query() pagination: PaginationDto, @Query("action")...@Query("userId")...)` —— action/resource/userId/username/startTime/endTime 都不在 PaginationDto（common/dto/pagination.dto.ts）
- 运行时后果：默认列表（仅 page/pageSize）正常；**任一筛选条件一加即 400**。且即便放行，后端 service 也不支持 username/startTime/endTime 过滤（audit.service.ts findAll 只处理 action/resource/userId）——双重契约缺口。
- confidence: verified（同 P1-key 机制）
- 建议修复：建 `AuditQueryDto extends PaginationDto`（action/resource/userId/username/startTime/endTime）并在 service 实现对应过滤。
- 测试影响：audit.controller.spec 存在；补筛选参数用例。

### [P1] 执行器安装向导的 install-script 端点后端不存在 → curl 命令 404
- 证据：
  - 调用方：apps/admin-web/src/api/executor-packages.ts:68-71 `getInstallScriptUrl` 构造 `${base}/executor-packages/${packageId}/install-script?token=`；pages/ExecutorInstallWizardPage.tsx:192、:278-279 生成 `curl -fsSL "$url" | bash`
  - 被调方：apps/admin-api/src/modules/executor-package/executor-package.controller.ts 全文无 `install-script` 路由（仅 install-token/download/push 等）；全局 grep "install-script" 仅命中 admin-web 一处
- 运行时后果：安装向导第 3 步展示的 curl/wget 一键安装命令**必然 404**。佐证：service 注释（executor-package.service.ts:326-327 "one-time install token ... to authorize script download without login"）表明该路由是规划过但未实现——install-token 生成的 token 目前无消费方。
- confidence: verified（路由清单穷举 + 全局 grep）
- 建议修复：实现 `@Public() @Get(":id/install-script")`（校验一次性 install token，输出安装脚本），或前端改为展示 `install-cmd`（GET /executors/install-cmd 已存在）。
- 测试影响：executor-package 模块无任何 spec（见第五节）。

### [P1] 安装向导包列表恒空：`GET /executor-packages/latest` 前端不传 `type`，且期望数组而后端返回单对象/null
- 证据：
  - 调用方：apps/admin-web/src/api/executor-packages.ts:46-47 `listLatest(): client.get('/executor-packages/latest') as Promise<ExecutorPackage[]>`；ExecutorInstallWizardPage.tsx:144-146 `listLatest().then(data => setPackages(Array.isArray(data) ? data : []))`
  - 被调方：apps/admin-api/src/modules/executor-package/executor-package.controller.ts:105-123 `findLatest(@Query("type") type: string, ...)`（Swagger 标注 required）；service.ts:309-322 `andWhere("pkg.type = :type", { type })` 返回 `ExecutorPackage | null`
- 运行时后果：不传 type → `pkg.type = NULL` 恒不匹配 → 返回 null → 前端 `Array.isArray(null)` false → **包列表恒空**，安装向导第 1 步无法选择。即使传了 type，返回也是单对象而非数组。
- confidence: verified
- 建议修复：新增 `GET /executor-packages/latest-all`（按 type/platform 分组返回每种最新的数组），或前端改为拉 `GET /executor-packages?pageSize=100` 自行取最新。
- 测试影响：同上。

### [P1] 安装包"下载"按钮 401：`<a href>` 无法携带 JWT，download 路由在 JwtAuthGuard 后
- 证据：
  - 调用方：apps/admin-web/src/api/executor-packages.ts:74-77 `getDownloadUrl` → pages/ExecutorPackagesPage.tsx:173 `<a href={downloadPackageUrl(row.id)} download>`
  - 被调方：apps/admin-api/src/modules/executor-package/executor-package.controller.ts:50 `@UseGuards(JwtAuthGuard)`（类级，download :168-185 无 @Public）；JWT 仅从 Authorization header 提取（apps/admin-api/src/modules/auth/strategies/jwt.strategy.ts:20）
- 运行时后果：浏览器直接 GET 无 Authorization 头 → 401 JSON，下载功能不可用。（/uploads 静态文件有 upload-auth 中间件但该路由走 /api 前缀、不受其覆盖。）
- confidence: verified
- 建议修复：download 支持 `?token=<install-token 或短时 JWT>` 校验（upload-auth.middleware 已有同型逻辑可复用），或前端改用 axios blob 下载。
- 测试影响：同上。

### [P1] SSE 日志流 `?token=` 认证后端不存在 → 实时日志流 401
- 证据：
  - 调用方：apps/admin-web/src/pages/ExecutionDetailPage.tsx:65-66 `new EventSource(url + '?token=' + token)`（EventSource 无法设置 header，故前端用 query 传 JWT）
  - 被调方：apps/admin-api/src/modules/auth/strategies/jwt.strategy.ts:20 仅 `ExtractJwt.fromAuthHeaderAsBearerToken()`；task.controller.ts:590 streamLogs 无 @Public；全局无 query-token 提取/中间件（upload-auth 中间件也不读 query）
- 运行时后果：SSE 建立即 401 → 前端 onerror 直接关闭。执行中的**实时日志推送完全不可用**（结束后仍可通过 GET execution 的 logs 字段/分页 logs 接口查看，故定 P1 而非 P0）。另外把 JWT 放 URL 有落入访问日志的安全隐患。
- confidence: verified（代码对读；验证方法：浏览器打开运行中执行的详情页，Network 中 stream 请求 401）
- 建议修复：为 SSE 路由加 query-token 支持（passport-jwt `fromExtractors([fromUrlQueryParameter('token'), fromAuthHeaderAsBearerToken()])`，仅对 stream 路由启用），或前端改用 fetch+ReadableStream 解析 SSE。
- 测试影响：task.controller.stream-logs.spec 已覆盖并发槽位；补鉴权用例。

### [P1] AI 应用健康分析结果不显示：前端读 `aiAnalysis`，后端返回 `analysis`/`stats.*`
- 证据：
  - 调用方：apps/admin-web/src/api/ai.ts:21-27 `AppHealthReport { taskCount, successRate, avgDuration, failedTasks, aiAnalysis }`；pages/ApplicationDetailPage.tsx:93-97 渲染 `report.aiAnalysis`
  - 被调方：apps/admin-api/src/modules/application/application.service.ts:123-133、202-213 返回 `{ appId, appName, analysis, stats: { totalTasks, avgSuccessRate, avgDuration, criticalTasks } }`
- 运行时后果：分析请求成功但 `report.aiAnalysis` 恒 undefined → **分析结果面板永远空白**（不报错，静默失败，最难发现的一类）。（CLI 的 `acf app analyze` 字段对读正确，不受影响。）
- confidence: verified
- 建议修复：ai.ts 的 AppHealthReport 对齐后端结构（analysis/stats），ApplicationDetailPage 同步改渲染。
- 测试影响：admin-web 无 api 层测试；建议补。

### [P1] 任务手动触发指定执行器 400：`executorId` 不在 TriggerTaskDto 白名单
- 证据：
  - 调用方1：packages/acf-cli/src/commands/tasks.ts:107-109 `post('/tasks/'+id+'/trigger', { executorId: opts.executor })`
  - 调用方2：packages/mcp-server/src/index.ts:123-126 trigger_task body 带 `executorId`
  - 被调方：apps/admin-api/src/modules/task/dto/trigger-task.dto.ts 仅声明 `params`；main.ts:186 forbidNonWhitelisted
- 运行时后果：CLI `acf task trigger <id> --executor xxx` 与 MCP `trigger_task(executorId=...)` **一律 400**（不指定时 axios/JSON 丢弃 undefined，不受影响）。后端 TaskExecution 本无 pinned-executor 字段，属"接口承诺了不存在的功能"。
- confidence: verified
- 建议修复：要么 DTO 增加 `executorId` 并在调度侧实现 pin，要么 CLI/MCP 删除该参数（避免假承诺）。
- 测试影响：无；补 contract 冒烟可覆盖。

### [P2] CLI/MCP 任务列表 `keyword` 参数 400：ListTasksQueryDto 只有 `name`
- 证据：
  - 调用方1：packages/acf-cli/src/commands/tasks.ts:58 `keyword: opts.keyword`（`-k` 传入时）
  - 调用方2：packages/mcp-server/src/index.ts:86 `keyword`（tool schema 声明了该参数）
  - 被调方：apps/admin-api/src/modules/task/dto/list-tasks-query.dto.ts（page/pageSize/name/status/runtime/triggerType/applicationId，无 keyword）；task.controller.ts:141 `findAll(@Query() p: ListTasksQueryDto)`
- 运行时后果：CLI `acf task list -k foo` 与 MCP `list_tasks(keyword=...)` → 400。不传时正常，故 P2。注意 MCP 的参数描述误导模型调用方（会认为 keyword 可用）。
- confidence: verified
- 建议修复：DTO 加 `keyword` 并映射到 name ILIKE，或 CLI/MCP 改传 `name`。
- 测试影响：contract 冒烟覆盖。

### [P2] CLI `app deployments` 恒显示空表：读 `data.list`，后端返回 `{ data, total }`
- 证据：
  - 调用方：packages/acf-cli/src/commands/apps.ts（deployments 命令）`get<{ list?: Deployment[]; total?: number }>('/app-deployments')` → `data.list ?? []`
  - 被调方：apps/admin-api/src/modules/application/app-deployment.service.ts:46-61 返回 `{ data, total }`（admin-web 的 deploymentsApi.list:85 类型正确）
- 运行时后果：命令执行成功但**永远输出 0 行**。
- confidence: verified
- 建议修复：CLI 改读 `data.data ?? data.list ?? []`。
- 测试影响：CLI 零测试。

### [P2] 设置页配置项 `tag` 字段 400：UpsertConfigDto 无 `tag`，实体也无该列
- 证据：
  - 调用方：apps/admin-web/src/pages/settings/index.tsx:162 `<Form.Item name="tag">` → :119 `configApi.upsert`（payload 含 tag）；api/config.ts:25-32 `UpsertConfigPayload.tag`
  - 被调方：apps/admin-api/src/modules/config/dto/upsert-config.dto.ts（key/value/description/valueType/isSecret，无 tag）；entities/system-config.entity.ts 无 tag 列
- 运行时后果：填写"标签"保存 → 400。另：前端 SystemConfig 接口声明 `tag: string | null`，但后端永不返回该字段（展示恒空）。
- confidence: verified
- 建议修复：若 tag 是需求，则实体+DTO+service 全链路补齐；否则删除前端 tag 表单项。
- 测试影响：config.service.spec 补 upsert 白名单用例。

### [P2] admin-web 客户端对 5xx/网络错误重试所有方法（含 POST）—— 触发类请求可能双发
- 证据：
  - apps/admin-web/src/api/client.ts:119-126 `if (_retryCount < 1 && (!err.response || (status >= 500 && status < 600)))` 不区分 method 重发
- 运行时后果：`POST /tasks/:id/trigger` 等非幂等请求在 502/504/网络抖动时被静默重试 → 可能创建两条执行记录；POST /applications/upload 重试会重复上传。
- confidence: verified（代码逻辑明确；实际双发取决于超时时机）suspected（发生频率）
- 建议修复：仅对 GET 重试；或提供 `config.skipRetry` 供非幂等请求关闭。
- 测试影响：client.ts 无测试。

### [P2] CLI executor 列表字段漂移：`name/hostname/currentLoad` 均不存在于 Executor 实体
- 证据：
  - 调用方：packages/acf-cli/src/commands/executors.ts（Executor 接口 name/hostname/currentLoad/lastHeartbeat/status）
  - 被调方：apps/admin-api/src/modules/executor/entities/executor.entity.ts（appName/address/status/lastHeartbeat/runningTaskCount/cpuUsage…）
- 运行时后果：`acf executor list` 的 Name/Hostname/Load 列恒为 `-`，只有 ID/Status/Heartbeat 有值（渲染侧有 `?? '-'` 兜底，不崩溃）。
- confidence: verified
- 建议修复：CLI 接口对齐实体（appName→Name，address→Hostname，cpuUsage→Load）。
- 测试影响：CLI 零测试。

### [P3] CLI `app versions` Commit 列恒空：读 `gitCommit`，后端返回 `commit`
- 证据：packages/acf-cli/src/commands/apps.ts（versions 命令 `v.gitCommit`） vs apps/admin-api/src/modules/application/app-deployment.service.ts:106-118（返回 `commit`、`deployedAt`、无 `changeNote`）。
- 后果：Commit 列恒 `-`、Note 列恒 `-`；version/时间正常。confidence: verified。建议：CLI 对齐字段名。

### [P3] admin-web 任务列表状态/触发方式筛选含后端不存在的枚举值
- 证据：apps/admin-web/src/pages/TaskListPage.tsx:21-28（statusFilter options 含 `failed`；STATUS_CONFIG 含 `inactive/failed`）vs apps/admin-api/src/modules/task/entities/task.entity.ts TaskStatus 仅 active/paused/deleted、TaskTriggerType 无 `dependency`。
- 后果：选"失败"筛选拉到空列表（不报错，IsString 放行）；Switch 的 disabled 条件永不生效。confidence: verified。建议：选项对齐枚举。

### [P3] MCP `list_tasks`/`list_executions` 的 status 提示值 `disabled` 不存在；CLI/MCP 错误提示丢失后端 message
- 证据：packages/mcp-server/src/index.ts:78（"active | paused | disabled"）；acf-cli 各命令 `e instanceof Error ? e.message : String(e)` → axios 仅抛 "Request failed with status code 400"，后端 envelope message 丢失（admin-web 有 getErrMsg 对应物，CLI 没有）。
- 后果：AI 调用方拿到无效提示；CLI 报错不可诊断。confidence: verified。建议：CLI axios 错误拦截器提取 `err.response?.data?.message`。

### [P3] 拆包启发式的理论误判面
- 证据：admin-web client.ts:96-99 / acf-cli client.ts:33-40 / mcp-server index.ts:54-59 均以 `'data' in body && ('code' in body || 'message' in body)` 判定 envelope。当前所有实体（Task/TaskExecution/Executor/…）均无 data+message 组合，无实际冲突；但任何新实体若同时带 `data` 与 `message` 字段会被错误拆包。
- 后果：潜在（当前无）。confidence: verified（无实害）。建议：拆包判定加 `code` 为 number 的约束（响应拦截器恒写 code:number）。

---

## 二、端点对账完整表

图例：✅=后端存在且方法/参数匹配；⚠️=存在但有契约缺陷（见对应条目）；❌=后端不存在。

### admin-web（src/api/*.ts + 页面直调）
| 调用方 | 路径 | 方法 | 后端 |
|---|---|---|---|
| auth.ts | /auth/login、/auth/refresh、/auth/profile | POST/POST/GET | ✅ |
| users.ts | /users、/users/:id | GET/POST/PATCH/DELETE | ✅ |
| tasks.ts | /tasks、/tasks/:id | GET/POST/PATCH/DELETE | ✅ |
| tasks.ts | /tasks/:id/trigger、/pause、/resume、/rollback | POST | ✅ |
| tasks.ts | /tasks/:id/executions、/tasks/:id/executions/:execId | GET | ✅ |
| tasks.ts | /tasks/:id/glue | PUT | ✅ |
| tasks.ts | /tasks/:id/stats、/tasks/:id/versions、/compare、/versions/:v/rollback、/suggest-schedule | GET/POST | ✅ |
| tasks.ts | /tasks/executions/all | GET | ✅ |
| tasks.ts | /tasks/batch/trigger、/pause、/resume、/delete | POST | ✅ |
| tasks.ts | /tasks/:t/executions/:e/kill、/analyze | POST | ✅ |
| ExecutionDetailPage | /tasks/:t/executions/:e/logs/stream | GET(SSE) | ⚠️ P1（?token= 401） |
| applications.ts | /applications CRUD、/upload、/webhook、/:id/versions、/sync-tasks、/upgrade-all、/rollback/:deploymentId | — | ✅ |
| applications.ts | PUT /applications/:id | PUT | ⚠️ P0（name 白名单 400） |
| applications.ts | /app-deployments、/:id、/applications/:appId/deploy、/:id/upgrade、/:id/stop | — | ✅ |
| executors.ts | /executors、/:id、groups、tags、:id/executions、:id/metrics | — | ✅ |
| executors.ts | PATCH /executors/:id、:id/rotate-token、:id/reload-config、:id/set-offline | — | ✅（body 为内联类型，无校验） |
| executors.ts | /config/executor-shared-token(+/generate) | GET/POST | ✅ |
| executor-packages.ts | GET/POST /executor-packages、/:id、DELETE、deprecate、activate、install-token、:id/push | — | ✅（multipart 字段名已对齐） |
| executor-packages.ts | /executor-packages/latest | GET | ⚠️ P1（缺 type+结构） |
| executor-packages.ts | /executor-packages/:id/download | GET | ⚠️ P1（`<a>` 401） |
| executor-packages.ts | /executor-packages/:id/install-script | GET | ❌ P1（404） |
| config.ts | /config CRUD、/batch、history/:id/rollback | — | ✅ |
| config.ts | /config/history | GET | ⚠️ P1（key 400） |
| config.ts | PUT /config | PUT | ⚠️ P2（tag 400） |
| notifications.ts | /notification/channels(+:key/test)、/notification/test | — | ✅ |
| ai.ts | /ai/config、/ai/test、/applications/:id/analyze、/tasks/:id/suggest-schedule | — | ⚠️ P1（analyze 字段漂移，其余 ✅） |
| metrics.ts | /metrics/summary、trend、executors、failures | GET | ✅ |
| registry.ts | /registry/pypi/packages、npm/packages、pypi/upload | — | ✅（multipart 字段名 content/name/version 对齐） |
| audit/index.tsx | /audit | GET | ⚠️ P1（筛选参数 400） |
| users.ts | /users?page&pageSize | GET | ✅ |

### acf-cli
| 命令 | 路径 | 方法 | 后端 |
|---|---|---|---|
| login | /auth/login | POST | ⚠️ P0（access_token 字段错） |
| task list | /tasks | GET | ⚠️ P2（keyword 400） |
| task get/delete/pause/resume | /tasks/:id(+/pause、/resume) | GET/DELETE/POST | ✅ |
| task trigger | /tasks/:id/trigger | POST | ⚠️ P1（executorId 400） |
| task executions | /tasks/:id/executions | GET | ✅（limit 为内联类型忽略，pageSize 生效） |
| task logs | /tasks/executions/:execId/logs | GET | ✅ |
| task analyze / kill | /tasks/:t/executions/:e/analyze、/kill | POST | ✅ |
| task suggest-schedule、stats | /tasks/:id/suggest-schedule、/stats | POST/GET | ✅ |
| task create/update | POST /tasks、PATCH /tasks/:id | — | ✅ |
| task get（轮询） | /tasks/executions/:execId | GET | ✅ |
| executor list | /executors | GET | ⚠️ P2（字段漂移） |
| app list/get/analyze | /applications… | — | ✅ |
| app deploy | /app-deployments/applications/:id/deploy | POST | ✅ |
| app deployments | /app-deployments | GET | ⚠️ P2（读 list 恒空表） |
| app versions | /applications/:id/versions | GET | ✅（P3 字段漂移） |

### mcp-server
| Tool | 路径 | 方法 | 后端 |
|---|---|---|---|
| list_tasks | /tasks | GET | ⚠️ P2（keyword 400） |
| get_task | /tasks/:id | GET | ✅ |
| trigger_task | /tasks/:id/trigger | POST | ⚠️ P1（executorId 400） |
| list_executions | /tasks/executions/all | GET | ✅ |
| get_execution / get_execution_logs | /tasks/executions/:id(+/logs) | GET | ✅ |
| analyze_execution / kill_execution | /tasks/:t/executions/:e/analyze、/kill | POST | ✅ |
| get_execution_stats / suggest_schedule | /tasks/:id/stats、/suggest-schedule | GET/POST | ✅ |
| pause_task / resume_task | /tasks/:id/pause、/resume | POST | ✅ |
| list_applications / get_application / analyze_application | /applications… | — | ✅ |
| deploy_application | /app-deployments/applications/:id/deploy | POST | ✅ |
| list_deployments | /app-deployments | GET | ✅（透传 JSON，无字段假设） |
| list_executors | /executors | GET | ✅ |

---

## 三、已核实无问题的检查项

1. **envelope 拆包对称性**：admin-api ResponseInterceptor（common/interceptors/response.interceptor.ts）恒包 `{code,message,data}`；admin-web/CLI/MCP 三端拆包逻辑一致且对非 envelope（空 body/''）安全降级；@Res 手写响应（SSE、download）绕过拦截器，不会被误包。204 响应 Express 不发 body，三端均不崩。
2. **admin-web 登录/刷新链路**：`POST /auth/login`、`POST /auth/refresh`（body `{refreshToken}` 对齐 RefreshTokenDto）、401 刷新重放、并发刷新去重均正确（client.ts:63-118）；仅 `res.user` 缺失（后端 login 不返回 user，MainLayout 用户名/角色显示降级，不影响鉴权）→ P3 级。
3. **任务表单 → CreateTaskDto**：TaskFormPage 提交的全部字段（name/runtime/entrypoint/triggerType/cronExpression/fixedRate/timeout/maxRetry/retryDelay/executeMode/executorAppName/Group/Tags/params 等）均在 CreateTaskDto 白名单内；triggerType 枚举值 manual/cron/fixed_rate 与后端一致。
4. **executor 上传 multipart**：字段名 file/name/version/type/platform/description 与 FileInterceptor("file")+CreateExecutorPackageDto 完全对齐（第三轮修复已验证保持）；applications upload（name/runtime/file）与 pypi upload（name/version/content）同样对齐。
5. **分页结构**：`paginate()` 同时返回 `list` 与 `items` 别名 → admin-web（items）、CLI（list）、users 页（list）三方均兼容；app-deployments `{data,total}`、config history `{data,total}`、executor executions `{total,items}` 前端类型均正确（仅 CLI deployments 例外，见 P2）。
6. **executor.version → executorVersion 改名**：admin-web Executor 接口与 ExecutorDetailPage 已全部使用 executorVersion；CLI/MCP 无残留旧字段读取（CLI 漂移的是 name/hostname/currentLoad，属另一问题）。
7. **Pause/Resume/kill/analyze 返回值**：pause/resume 返回 Task 实体（CLI 读 t.status 正确）、kill 返回 `{success,message}`、analyze 返回含 aiAnalysis 的 execution —— 三端使用均匹配。
8. **registry 响应形状**：`{packages:[...]}` 与前端 `resp.packages ?? []` 对齐；trend 的 days 由后端手动 parse 并夹紧 1..90，无 DTO 400 风险。
9. **静态检查**：admin-web `npm run lint`：**0 errors / 5 warnings**（3×react-refresh/only-export-components：main.tsx、router.tsx；2×react-hooks/exhaustive-deps：ExecutorListPage.tsx:77）；admin-web / acf-cli / mcp-server 三端 `tsc --noEmit` 全部通过（0 错误）。
10. **CLI `task logs --tail`**：totalLines/lines/hasMore 与后端 getExecutionLogs 返回结构完全匹配；logs 兼容路由 `GET /tasks/executions/:execId(+/logs)` 存在且行为正确。

---

## 四、lint / tsc 现状汇总

| 检查 | 结果 |
|---|---|
| admin-web `npm run lint` | 0 errors, 5 warnings（react-refresh×3、react-hooks/exhaustive-deps×2） |
| admin-web `tsc --noEmit` | 通过 |
| acf-cli `tsc --noEmit` | 通过 |
| mcp-server `tsc --noEmit` | 通过 |

（注：三端 tsc 全绿恰说明**纯类型层对不出的契约断裂**——如 query 白名单 400、运行时字段漂移——必须靠契约测试兜底。）

---

## 五、测试缺口与最小补测清单（按风险排序）

现状盘点：admin-api 37 个 spec（task 服务/处理器/批量/回调/SSE 槽位、scheduler 含 leader election、log-retention、s3-log-storage、upload-auth 中间件、auth controller+service、executor、notification、application（仅 webhook）、users、metrics、audit、config、health、ai、entities/migrations/configuration/cors/redis-lock 等）；**executor-package 模块与 registry 模块 0 spec**；admin-web 仅 auth.store 一条测试；acf-cli 与 mcp-server **零测试**；executor-python 44 tests（admin_api URL 构造 8、registration 1、scheduler 6、config_reload 4、execute 12、auth 3、logs 5、health 5）。

| 优先级 | 缺口 | 建议最小补测 |
|---|---|---|
| 1 | **跨端契约冒烟（本轮 8 个 400/404 全部属此类）** | admin-api 起一个 supertest e2e：以真实 JWT 遍历 admin-web/CLI/MCP 实际发出的 请求组合（含 query 多传字段、body 多传字段、`?token=` SSE、install-script、latest、audit 筛选、config history），断言非 4xx。一个文件即可守住所有 forbidNonWhitelisted 回归。 |
| 2 | executor-package 模块 0 覆盖 | service 级 spec：create 校验（扩展名+ZIP magic）、generateInstallToken TTL、findLatest(type) 行为、push-result 回调鉴权与 pushHistory 截断。 |
| 3 | auth 全链路 | 现有 16 个 service 用例补 e2e：login→refresh 轮换（旧 token 失效）→logout 撤销→旧 refresh 重放 401。 |
| 4 | application upload 端点 | controller spec：非 .zip 拒绝、magic number 校验、name 必填、重复 name 幂等 upsert（webhook 已覆盖，upload 未覆盖）。 |
| 5 | admin-web client.ts | vitest：envelope 拆包、401→refresh→重放、5xx 重试（并覆盖 P2 的 POST 重试修复）、错误 message 提取。 |
| 6 | acf-cli / mcp-server | vitest 最小集：login 字段读取、unwrap 函数、每命令的 path/method 快照（防漂移）。 |
| 7 | registry 模块 0 覆盖 | pypi index 解析（parsePypiIndex）、npm 代理失败降级 `{packages:[]}`、upload 扩展名白名单。 |
| 8 | registry（executor-python）| 44 测试未覆盖：heartbeat 上报失败降级、包下载 checksum 校验-切换-回滚、push-result 上报、graceful shutdown（POST /executors/offline）。 |

---

## 六、汇总

- P0：2（acf-cli 登录字段错 → CLI 全不可用；应用编辑恒 400）
- P1：7（config history 恒 400、audit 筛选恒 400、install-script 404、latest 结构/参数错、包下载 401、SSE ?token= 401、AI 分析字段漂移、trigger executorId 400 —— 其中 trigger executorId 计入 P1，合计 8 项见正文）
- P2：6（keyword 400、CLI deployments 空表、config tag 400、POST 重试双发、CLI executor 字段漂移等）
- P3：4（versions 字段、枚举筛选选项、MCP 提示值、拆包启发式）
- lint：0 errors / 5 warnings；三端 tsc 全绿。
