# API 参考

所有接口基础路径：`http://localhost:3105/api`

交互式文档：`http://localhost:3105/api/docs`（Swagger UI）

## 认证说明

- 需要认证的接口须在请求头携带：`Authorization: Bearer <access_token>`
- Access Token 通过登录接口获取，有效期默认 1 小时
- Token 过期后使用 Refresh Token 接口刷新，无需重新登录

---

## Auth — 认证

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| POST | `/auth/login` | 否 | 用户名密码登录，返回 access_token 和 refresh_token |
| POST | `/auth/refresh` | 否 | 使用 refresh_token 刷新 access_token |
| POST | `/auth/logout` | 是 | 登出，使当前 refresh_token 失效 |
| GET | `/auth/profile` | 是 | 获取当前登录用户信息 |
| PUT | `/auth/password` | 是 | 修改当前用户密码 |

**登录请求示例：**

```json
POST /api/auth/login
{
  "username": "admin",
  "password": "<your_password>"
}
```

**登录响应示例：**

```json
{
  "code": 0,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresIn": 3600
  }
}
```

---

## Applications — 应用管理

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/applications` | 是 | 分页查询应用列表，支持 name/status 过滤 |
| POST | `/applications` | 是 | 创建新应用 |
| GET | `/applications/:id` | 是 | 获取应用详情 |
| PUT | `/applications/:id` | 是 | 更新应用信息 |
| DELETE | `/applications/:id` | 是 | 删除应用（级联删除关联任务） |
| GET | `/applications/:id/tasks` | 是 | 获取应用下的所有任务 |
| GET | `/applications/:id/stats` | 是 | 获取应用执行统计数据 |
| POST | `/applications/webhook` | 是 | CI/CD 触发发版部署 |

**Webhook 发版请求体：**

> ⚠️ webhook 接口的请求体**只接受以下三个字段**，传入其他字段（如 `runtime`、`executorType`、`upgradeStrategy`）会返回 400。

```json
POST /api/applications/webhook
{
  "appName": "my-app",
  "version": "1.2.0",
  "triggerDeploy": true
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `appName` | string | 是 | 应用名称（需与已创建的应用名称完全匹配） |
| `version` | string | 是 | 版本号（语义化版本，如 `1.2.0`） |
| `triggerDeploy` | boolean | 否 | `true` 时立即触发部署，默认 `false` |

**分页查询参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `page` | number | 页码，从 1 开始（默认 1） |
| `pageSize` | number | 每页条数（默认 20，最大 100） |
| `name` | string | 按名称模糊搜索 |
| `status` | string | 按状态过滤：`active` / `inactive` |

---

## Tasks — 任务管理

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/tasks` | 是 | 分页查询任务列表，支持 appId/name/status 过滤 |
| POST | `/tasks` | 是 | 创建任务 |
| GET | `/tasks/:id` | 是 | 获取任务详情（含执行统计） |
| PUT | `/tasks/:id` | 是 | 更新任务配置 |
| DELETE | `/tasks/:id` | 是 | 删除任务 |
| POST | `/tasks/:id/trigger` | 是 | 手动触发任务立即执行 |
| POST | `/tasks/:id/enable` | 是 | 启用任务（允许调度执行） |
| POST | `/tasks/:id/disable` | 是 | 禁用任务（暂停调度） |
| POST | `/tasks/batch-trigger` | 是 | 批量触发多个任务 |

---

## Executors — 执行器管理

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/executors` | 是 | 查询执行器列表（含在线状态） |
| POST | `/executors` | 是 | 注册新执行器 |
| GET | `/executors/:id` | 是 | 获取执行器详情 |
| PUT | `/executors/:id` | 是 | 更新执行器配置 |
| DELETE | `/executors/:id` | 是 | 删除执行器 |
| POST | `/executors/:id/sync` | 是 | 手动同步执行器 manifest |
| GET | `/executors/:id/health` | 是 | 检查执行器健康状态 |
| POST | `/executors/heartbeat` | 否* | 执行器心跳上报（使用执行器专属 Token） |

> *心跳接口使用执行器 Token 认证，非用户 JWT。

---

## Executions — 执行记录

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/executions` | 是 | 分页查询执行记录，支持多维度过滤 |
| GET | `/executions/:id` | 是 | 获取执行记录详情（含日志） |
| GET | `/executions/:id/logs` | 是 | 分页获取执行日志 |
| POST | `/executions/:id/cancel` | 是 | 取消正在执行的任务 |
| POST | `/executions/:id/retry` | 是 | 重试失败的任务 |
| POST | `/executions/callback` | 否* | 执行器批量上报执行最终状态（成功/失败） |

> *执行器回调接口使用执行器 Token 认证，请携带 `Authorization: Bearer <executor_token>`。

**执行记录查询参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `taskId` | string | 按任务 ID 过滤 |
| `appId` | string | 按应用 ID 过滤 |
| `status` | string | `pending` / `running` / `success` / `failed` / `cancelled` |
| `startTime` | ISO8601 | 开始时间范围起点 |
| `endTime` | ISO8601 | 开始时间范围终点 |

---

## Notifications — 通知管理

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/notification` | 是 | 查询通知配置列表 |
| POST | `/notification` | 是 | 创建通知配置（邮件/Webhook 等） |
| GET | `/notification/:id` | 是 | 获取通知配置详情 |
| PUT | `/notification/:id` | 是 | 更新通知配置 |
| DELETE | `/notification/:id` | 是 | 删除通知配置 |
| POST | `/notification/:id/test` | 是 | 发送测试通知 |

---

## Metrics — 监控指标

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/metrics/overview` | 是 | 系统概览数据（任务数、执行数、成功率等） |
| GET | `/metrics/executions` | 是 | 执行趋势图数据（按时间维度聚合） |
| GET | `/metrics/executors` | 是 | 执行器负载和状态统计 |
| GET | `/metrics/tasks/:id` | 是 | 单任务执行历史统计 |
| GET | `/metrics/scheduler` | 是 | 调度器状态与队列监控数据 |

---

## Audit — 审计日志

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/audit/logs` | 是 | 分页查询审计日志 |
| GET | `/audit/logs/:id` | 是 | 获取单条审计日志详情 |

**审计日志查询参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `userId` | string | 按操作用户过滤 |
| `action` | string | 操作类型（CREATE / UPDATE / DELETE / LOGIN 等） |
| `resource` | string | 资源类型（task / executor / application 等） |
| `startTime` | ISO8601 | 时间范围起点 |
| `endTime` | ISO8601 | 时间范围终点 |

---

## Users — 用户管理

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/users` | 是（Admin） | 分页查询用户列表 |
| POST | `/users` | 是（Admin） | 创建新用户 |
| GET | `/users/:id` | 是 | 获取用户详情 |
| PUT | `/users/:id` | 是 | 更新用户信息 |
| DELETE | `/users/:id` | 是（Admin） | 删除用户 |
| PUT | `/users/:id/password` | 是 | 修改指定用户密码 |

---

## Config — 系统配置

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/config` | 是 | 查询所有系统配置项 |
| PUT | `/config/:key` | 是（Admin） | 更新指定配置项 |
| GET | `/config/history` | 是 | 查询配置修改历史 |

---

## ExecutorPackages — 执行器包管理

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/executor-packages` | 是 | 查询执行器包列表 |
| POST | `/executor-packages/upload` | 是 | 上传应用包（multipart/form-data） |
| GET | `/executor-packages/:id` | 是 | 获取包详情 |
| DELETE | `/executor-packages/:id` | 是 | 删除包 |

**上传字段：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `file` | file | 是 | 包文件（zip / tar.gz） |
| `appName` | string | 是 | 关联的应用名称 |
| `version` | string | 是 | 版本号 |
| `executorType` | string | 否 | `node` / `python`，默认 `python` |

---

## Registry — 私有仓库代理

| 方法 | 路径 | 需要认证 | 说明 |
|------|------|:--------:|------|
| GET | `/registry/npm` | 否 | npm 私有仓库访问地址信息 |
| GET | `/registry/pypi` | 否 | PyPI 私有仓库访问地址信息 |

---

## 统一响应格式

所有接口遵循以下响应结构：

```json
{
  "code": 0,
  "message": "success",
  "data": {},
  "traceId": "abc123def456"
}
```

| 字段 | 说明 |
|------|------|
| `code` | 业务状态码，0 表示成功，非 0 表示业务错误 |
| `message` | 状态描述 |
| `data` | 响应数据 |
| `traceId` | 全链路追踪 ID，排查问题时提供给运维 |

**分页响应格式：**

```json
{
  "code": 0,
  "data": {
    "items": [],
    "total": 100,
    "page": 1,
    "pageSize": 20
  }
}
```

## 常见错误码

| 错误码 | HTTP 状态 | 说明 |
|--------|-----------|------|
| `1001` | 401 | 未登录或 Token 已过期 |
| `1002` | 401 | Token 无效 |
| `1003` | 403 | 无权限执行该操作 |
| `1004` | 429 | 请求频率超限 |
| `2001` | 404 | 资源不存在 |
| `2002` | 409 | 资源已存在（名称重复等） |
| `3001` | 400 | 参数校验失败 |
| `5001` | 500 | 服务器内部错误 |
