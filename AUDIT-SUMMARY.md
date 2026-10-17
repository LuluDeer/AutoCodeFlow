# AutoCodeFlow 全面审计总结（进行中）

**审计时间**: 2026-10-17  
**已完成**: 6/8 模块  
**已提交修复**: commit 19aa9fb4（3 项测试/门禁缺陷）

## 缺陷统计（已发现）

| 严重度 | 数量 | 已修复 | 待修复 | 分布 |
|--------|------|--------|--------|------|
| **P1-高** | 4 | 0 | 4 | CLI/MCP refresh 404 + pull 模式饥饿 + deploy 备份失败被吞 + deploy rollback 模式错误 |
| **P2-中** | 11 | 0 | 11 | SDK 连接泄漏(3) + 前端竞态(4) + batch 退出码 + staging OOM + 脚本硬编码路径(2) |
| **P3-低** | 4 | 0 | 4 | 熔断器错误掩盖 + 版本漂移 + turbo 孤立配置 + deploy 死代码 |
| **测试/门禁** | 3 | 3 | 0 | python-venv 隔离 + jest 非法键 + qwen 自检腐烂 |
| **总计** | **22** | **3** | **19** |

## 高严重度缺陷（P1）

### 1. CLI/MCP refresh token 404 清空有效凭据
- **影响**: 用户 token 过期后被迫重新登录
- **位置**: acf-cli/src/client.ts:89, mcp-server/src/api.ts:58
- **原因**: 缺 /api 前缀，404 后 clearAuth() 清空全部凭据

### 2. pull 模式 maxConcurrentTasks=1 永久饥饿
- **影响**: 执行器永久无法获取任务
- **位置**: executor-node/src/pull.ts:292, executor-python/scheduler.py:616
- **原因**: 预留槽位后 freeSlots 计算为 0，admin 端不派发任务

### 3. deploy.sh docker 备份失败被吞
- **影响**: 生产迁移前备份失败但继续执行，可能导致无备份下的破坏性变更
- **位置**: deploy.sh:793-795
- **原因**: `return 0` 无条件执行，pg-backup 失败不传播

### 4. deploy.sh rollback 忽略已部署模式
- **影响**: 源码模式部署后 rollback 走 docker 分支，systemd 继续跑新代码，报假成功
- **位置**: deploy.sh:1268-1337
- **原因**: 只读 commit 不读 mode，使用全局默认 docker

## 中严重度缺陷（P2）

**SDK/库（3 项）**
- autoflow-sdk AsyncHttpClient 连接池泄漏
- autoflow-sdk callback 重试丢连接池
- acf task batch --json 部分失败退出码 0

**前端竞态（4 项）**
- ExecutionsPage/TaskListPage/UserManagementPage URL 深链接失效
- audit/index.tsx 筛选按钮与查询不一致
- ApplicationDetailPage 分页竞态
- AgentSessionsPage 轮询与筛选竞态

**基础设施（4 项）**
- docker-compose.staging.yml admin-api 堆/容器限制重叠 OOM
- check-release-hygiene.mjs token 兜底死代码
- verify-config.cjs 硬编码绝对路径
- autocodeflow-node-sdk 熔断器探测错误掩盖

## 低严重度缺陷（P3）

- 根 package.json 版本漂移（1.0.1 vs 1.11.0）
- turbo.json 孤立配置文件
- deploy.sh write_manifest_artifacts 死代码

## 已修复（commit 19aa9fb4）

1. **executor-node/src/python-venv.spec.ts**: 测试隔离缺陷，4 例读真实池
2. **admin-api/package.json**: jest 配置非法键
3. **scripts/*-qwen-*.mjs + CI**: 三个自检脚本腐烂，已修正断言并纳入门禁

## 进行中

- **子代理**: admin-api 核心 + admin-api 安全（2/6）
- **基线测试**: executor-python + admin-web 运行中

## 门禁缺口

- 5 个已实现脚本未入 CI：test:deploy-script, test:private-registry:dispatch, chaos-drill.selftest.sh, audit-verify.selftest.mjs, load-test.selftest.mjs
