# AutoFlow 代码修复计划

**创建日期**: 2026-06-05  
**状态**: 待执行  
**版本**: v1.0

---

## 目录

1. [修复优先级说明](#修复优先级说明)
2. [平台兼容性修复（P0 - 紧急）](#平台兼容性修复-p0-紧急)
3. [安全性修复（P1 - 高危）](#安全性修复-p1-高危)
4. [功能缺陷修复（P2 - 中危）](#功能缺陷修复-p2-中危)
5. [部署优化（P3 - 低危）](#部署优化-p3-低危)
6. [修复进度追踪](#修复进度追踪)

---

## 修复优先级说明

| 优先级 | 标识 | 说明 | 响应时间 |
|--------|------|------|----------|
| P0 | 🔴 紧急 | 阻止核心功能或存在严重安全漏洞 | 24小时内 |
| P1 | 🟠 高危 | 严重影响功能或存在安全风险 | 48小时内 |
| P2 | 🟡 中危 | 影响部分功能或存在潜在风险 | 7天内 |
| P3 | 🟢 低危 | 优化建议或改进项 | 按需 |

---

## 平台兼容性修复（P0 - 紧急）

### P0-01: 执行器无法回调公网管理后台

**问题描述**: 执行器硬编码使用 Docker 内部地址 `admin-api:3001`，无法在公网环境中回调管理后台。

**影响范围**: 所有需要公网部署的场景

**修复方案**:
1. 在配置中区分内部地址和外部地址
2. 执行器根据运行环境选择正确的回调地址

**涉及文件**:
- [apps/executor-node/src/config.ts](file:///home/yongsheng/project/AutoCodeFlow/apps/executor-node/src/config.ts)
- [apps/executor-python/config.py](file:///home/yongsheng/project/AutoCodeFlow/apps/executor-python/config.py)
- [apps/executor-python/auth.py](file:///home/yongsheng/project/AutoCodeFlow/apps/executor-python/auth.py)

**计划时间**: 2小时

---

### P0-02: 任务分发强制使用 HTTP 协议

**问题描述**: 管理后台向执行器分发任务时硬编码使用 `http://`，公网部署存在安全风险。

**修复方案**:
1. 支持配置协议类型（HTTP/HTTPS）
2. 根据执行器注册地址自动选择协议

**涉及文件**:
- [apps/admin-api/src/modules/executor/executor.service.ts](file:///home/yongsheng/project/AutoCodeFlow/apps/admin-api/src/modules/executor/executor.service.ts)
- [apps/admin-api/src/modules/task/task.processor.ts](file:///home/yongsheng/project/AutoCodeFlow/apps/admin-api/src/modules/task/task.processor.ts)

**计划时间**: 2小时

---

### P0-03: 前端 API 地址不支持多网络切换

**问题描述**: 前端硬编码单一 API 地址，无法在局域网和公网之间切换。

**修复方案**:
1. 配置环境变量支持多个 API 地址
2. 在前端提供网络环境切换功能

**涉及文件**:
- [apps/admin-web/vite.config.ts](file:///home/yongsheng/project/AutoCodeFlow/apps/admin-web/vite.config.ts)
- [apps/admin-web/src/api/client.ts](file:///home/yongsheng/project/AutoCodeFlow/apps/admin-web/src/api/client.ts)

**计划时间**: 3小时

---

## 安全性修复（P1 - 高危）

### P1-01: Executor Token 认证缺陷

**问题描述**: 当 `EXECUTOR_SECRET` 未配置时，生产环境直接放行所有执行器请求。

**修复方案**:
1. 强制要求生产环境配置 `EXECUTOR_SECRET`
2. 在配置验证中增加检查

**涉及文件**:
- [apps/admin-api/src/modules/executor/executor.controller.ts](file:///home/yongsheng/project/AutoCodeFlow/apps/admin-api/src/modules/executor/executor.controller.ts)
- [apps/admin-api/src/config/configuration.ts](file:///home/yongsheng/project/AutoCodeFlow/apps/admin-api/src/config/configuration.ts)

**计划时间**: 1小时

---

### P1-02: 通知 Webhook 无重试机制

**问题描述**: 企微/钉钉/邮件通知发送失败时无重试机制，重要告警可能丢失。

**修复方案**:
1. 添加重试机制（最多3次）
2. 记录通知失败日志

**涉及文件**:
- [apps/admin-api/src/modules/notification/channels/wecom.channel.ts](file:///home/yongsheng/project/AutoCodeFlow/apps/admin-api/src/modules/notification/channels/wecom.channel.ts)
- [apps/admin-api/src/modules/notification/channels/dingtalk.channel.ts](file:///home/yongsheng/project/AutoCodeFlow/apps/admin-api/src/modules/notification/channels/dingtalk.channel.ts)
- [apps/admin-api/src/modules/notification/channels/email.channel.ts](file:///home/yongsheng/project/AutoCodeFlow/apps/admin-api/src/modules/notification/channels/email.channel.ts)
- [apps/admin-api/src/modules/notification/channels/slack.channel.ts](file:///home/yongsheng/project/AutoCodeFlow/apps/admin-api/src/modules/notification/channels/slack.channel.ts)

**计划时间**: 3小时

---

### P1-03: Git URL SSRF 防护不完整

**问题描述**: 虽然阻止了 `file://` 协议，但未阻止内网地址扫描。

**修复方案**:
1. 添加内网地址黑名单（10.x.x.x, 172.16.x.x, 192.168.x.x, localhost）
2. 仅允许白名单域名

**涉及文件**:
- [apps/executor-python/routers/execute.py](file:///home/yongsheng/project/AutoCodeFlow/apps/executor-python/routers/execute.py)
- [apps/executor-node/src/routes/execute.ts](file:///home/yongsheng/project/AutoCodeFlow/apps/executor-node/src/routes/execute.ts)

**计划时间**: 2小时

---

## 功能缺陷修复（P2 - 中危）

### P2-01: 任务依赖链死锁风险

**问题描述**: 任务依赖链无循环依赖检测，可能导致死锁。

**修复方案**:
1. 添加循环依赖检测算法
2. 在创建/更新任务时检查依赖关系

**涉及文件**:
- [apps/admin-api/src/modules/task/task.service.ts](file:///home/yongsheng/project/AutoCodeFlow/apps/admin-api/src/modules/task/task.service.ts)
- [apps/admin-api/src/modules/task/task.processor.ts](file:///home/yongsheng/project/AutoCodeFlow/apps/admin-api/src/modules/task/task.processor.ts)

**计划时间**: 4小时

---

### P2-02: Executor 容量限制竞态条件

**问题描述**: 检查和递增运行任务数不是原子操作，高并发时可能超出限制。

**修复方案**:
1. 使用 Redis 原子操作或数据库事务
2. 确保容量检查和递增在同一事务中

**涉及文件**:
- [apps/executor-node/src/routes/execute.ts](file:///home/yongsheng/project/AutoCodeFlow/apps/executor-node/src/routes/execute.ts)
- [apps/executor-python/routers/execute.py](file:///home/yongsheng/project/AutoCodeFlow/apps/executor-python/routers/execute.py)

**计划时间**: 2小时

---

### P2-03: 任务日志截断丢失关键信息

**问题描述**: 日志超过 10000 字符时只保留末尾，可能丢失开头的错误信息。

**修复方案**:
1. 保留开头和末尾各 5000 字符
2. 中间用省略号连接

**涉及文件**:
- [apps/executor-python/routers/execute.py](file:///home/yongsheng/project/AutoCodeFlow/apps/executor-python/routers/execute.py)
- [apps/executor-node/src/routes/execute.ts](file:///home/yongsheng/project/AutoCodeFlow/apps/executor-node/src/routes/execute.ts)

**计划时间**: 1小时

---

## 部署优化（P3 - 低危）

### P3-01: Docker 网络架构优化

**问题描述**: 当前网络配置不支持混合部署模式（部分在内网，部分在公网）。

**修复方案**:
1. 分离内部网络和外部网络
2. 支持执行器通过不同网络注册

**涉及文件**:
- [docker-compose.yml](file:///home/yongsheng/project/AutoCodeFlow/docker-compose.yml)

**计划时间**: 2小时

---

### P3-02: 健康检查支持 HTTPS

**问题描述**: 健康检查使用 HTTP，生产环境应支持 HTTPS。

**修复方案**:
1. 配置健康检查使用 HTTPS
2. 添加 SSL 证书配置支持

**涉及文件**:
- [docker-compose.yml](file:///home/yongsheng/project/AutoCodeFlow/docker-compose.yml)
- [apps/admin-api/src/main.ts](file:///home/yongsheng/project/AutoCodeFlow/apps/admin-api/src/main.ts)

**计划时间**: 2小时

---

## 修复进度追踪

| 优先级 | 编号 | 问题描述 | 状态 | 负责人 | 预计时间 | 实际时间 |
|--------|------|----------|------|--------|----------|----------|
| P0 | P0-01 | 执行器无法回调公网管理后台 | ✅ 已完成 | - | 2h | 1.5h |
| P0 | P0-02 | 任务分发强制使用 HTTP | ✅ 已完成 | - | 2h | 1.5h |
| P0 | P0-03 | 前端 API 地址不支持多网络切换 | ✅ 已完成 | - | 3h | 2h |
| P1 | P1-01 | Executor Token 认证缺陷 | ✅ 已完成 | - | 1h | 0.5h |
| P1 | P1-02 | 通知 Webhook 无重试机制 | ✅ 已完成 | - | 3h | 2h |
| P1 | P1-03 | Git URL SSRF 防护不完整 | ✅ 已完成 | - | 2h | 1h |
| P2 | P2-01 | 任务依赖链死锁风险 | ✅ 已完成 | - | 4h | 2h |
| P2 | P2-02 | Executor 容量限制竞态条件 | ✅ 已完成 | - | 2h | 1.5h |
| P2 | P2-03 | 任务日志截断丢失关键信息 | ✅ 已完成 | - | 1h | 0.5h |
| P3 | P3-01 | Docker 网络架构优化 | ⏳ 待修复 | - | 2h | - |
| P3 | P3-02 | 健康检查支持 HTTPS | ⏳ 待修复 | - | 2h | - |
| - | - | 跨平台兼容性（Linux/Windows） | ✅ 已完成 | - | - | - |

### 状态说明

- ✅ 已完成
- 🔧 进行中
- ⏳ 待修复
- ❌ 阻塞中

---

## 资源估算

| 阶段 | 任务数 | 总工时 |
|------|--------|--------|
| P0 紧急修复 | 3 | 7小时 |
| P1 高危修复 | 3 | 6小时 |
| P2 中危修复 | 3 | 7小时 |
| P3 低危优化 | 2 | 4小时 |
| **总计** | **11** | **24小时** |

---

## 风险评估

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|----------|
| 网络配置变更影响现有部署 | 高 | 中 | 保持向后兼容，支持原有环境变量 |
| Token 认证修改导致执行器断开 | 中 | 高 | 逐步切换，支持双模式 |
| 依赖检测引入性能问题 | 低 | 中 | 使用高效算法，缓存检测结果 |