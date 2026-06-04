# AutoFlow 代码审查报告

> 审查时间：2026-06-04  
> 项目路径：`/home/yongsheng/project/autoflow`  
> 架构：Monorepo — admin-api (NestJS)、admin-web (React/Vite)、executor-node (Node.js)、executor-python (FastAPI)、autoflow-sdk (Python)

**说明：** 本报告基于对实际代码的逐文件完整阅读。已确认正常的实现不列入（含：CORS 白名单、pageSize @Max(100)、Docker 数据库端口不暴露、任务超时控制、synchronize 生产关闭、全局 ThrottlerGuard、僵尸任务自动检测）。

---

## 目录

1. [安全性问题](#1-安全性问题)
2. [错误处理与健壮性](#2-错误处理与健壮性)
3. [任务调度与执行](#3-任务调度与执行)
4. [代码质量与正确性](#4-代码质量与正确性)
5. [前端问题](#5-前端问题)
6. [测试覆盖](#6-测试覆盖)
7. [配置与运维](#7-配置与运维)
8. [问题汇总表](#8-问题汇总表)

---

## 1. 安全性问题

### SEC-01 任务子进程继承宿主机全量环境变量，含 secrets [严重]

**文件：**
- [`apps/executor-python/routers/execute.py` L170](file:///home/yongsheng/project/autoflow/apps/executor-python/routers/execute.py)
- [`apps/executor-node/src/routes/execute.ts` L138](file:///home/yongsheng/project/autoflow/apps/executor-node/src/routes/execute.ts)

两个执行器启动子进程时均传入全量宿主机环境变量：

```python
# executor-python
env = os.environ.copy()  # 复制全量，含 EXECUTOR_SHARED_TOKEN 等 secrets
proc = await asyncio.create_subprocess_exec(*cmd, env=env)
```

```typescript
// executor-node
const env: NodeJS.ProcessEnv = {
  ...process.env,  // 展开全量
  EXECUTION_ID: executionId,
};
```

任务脚本通过 `os.environ` / `process.env` 即可读取 `EXECUTOR_SHARED_TOKEN`、`ADMIN_API_URL` 等，进而伪装执行器或探测内网。

**建议：** 构造子进程 `env` 时只保留白名单变量：
```python
_ALLOWED = {'PATH', 'HOME', 'LANG', 'TZ', 'PYTHONPATH'}
env = {k: v for k, v in os.environ.items() if k in _ALLOWED}
env['EXECUTION_ID'] = req.executionId
# 只注入 AUTOFLOW_* 参数
```

---

### SEC-02 Refresh Token 无持久化与吊销机制 [高危]

**文件：** [`apps/admin-api/src/modules/auth/auth.service.ts`](file:///home/yongsheng/project/autoflow/apps/admin-api/src/modules/auth/auth.service.ts)

`refreshToken()` 仅验证 JWT 签名和 `type` 字段，无任何吊销检查：

```typescript
async refreshToken(token: string) {
  const payload = this.jwtService.verify(token, { secret: refreshSecret });
  if (payload.type !== 'refresh') throw ...;
  // 无吊销检查，旧 token 30 天内永远有效
  return this.generateTokens(user);
}
```

用户登出后旧 Refresh Token 仍可持续换取新 access token，无法强制下线特定会话。

**建议：** 将 Refresh Token 的 `jti`+`userId`+`revokedAt` 持久化到数据库，刷新前查库验证；`/auth/logout` 接口标记 `jti` 为已吊销；可选实现 Token Rotation（用后即废）。

---

### SEC-03 执行器共享静态 Token，无过期与轮换机制 [高危]

**文件：** [`apps/executor-python/auth.py`](file:///home/yongsheng/project/autoflow/apps/executor-python/auth.py)

所有执行器共用同一个静态 `EXECUTOR_SHARED_TOKEN`，无过期时间，无轮换机制。更关键的是：Token 为空时直接放行所有请求（dev 模式）：

```python
_EXECUTOR_SECRET = os.environ.get('EXECUTOR_SHARED_TOKEN') or os.environ.get('EXECUTOR_SECRET') or ''

async def verify_token(...):
    if not _EXECUTOR_SECRET:
        return  # Token 为空时放行所有请求
```

---

### SEC-04 docker-compose.yml 注入 `EXECUTOR_SECRET`，但代码读取 `EXECUTOR_SHARED_TOKEN`，认证实际失效 [高危]

**文件：** [`docker-compose.yml` L50](file:///home/yongsheng/project/autoflow/docker-compose.yml)、[`apps/admin-api/src/config/configuration.ts` L51](file:///home/yongsheng/project/autoflow/apps/admin-api/src/config/configuration.ts)

`docker-compose.yml` 向 admin-api 注入：
```yaml
EXECUTOR_SECRET: ${EXECUTOR_SECRET}
```

而 `configuration.ts` 读取的是：
```typescript
sharedToken: process.env.EXECUTOR_SHARED_TOKEN || ''
```

变量名不一致：compose 注入 `EXECUTOR_SECRET`，代码读 `EXECUTOR_SHARED_TOKEN`，导致生产部署时 `sharedToken` 始终为空，结合 `auth.py` 中「token 为空时放行」的逻辑，**生产环境执行器认证完全失效**。

`configuration.ts` 末尾的生产检查同样检查的是 `EXECUTOR_SECRET` 而非 `EXECUTOR_SHARED_TOKEN`，两处变量名混用。

**建议（5 分钟可修复）：** 统一变量名，二选一：
- 方案 A：`configuration.ts` 改读 `process.env.EXECUTOR_SECRET`
- 方案 B：`docker-compose.yml` 改为 `EXECUTOR_SHARED_TOKEN: ${EXECUTOR_SECRET}`

---

### SEC-05 登录限流未按用户名维度，无账户锁定机制 [中危]

**文件：** [`apps/admin-api/src/modules/auth/auth.controller.ts` L21](file:///home/yongsheng/project/autoflow/apps/admin-api/src/modules/auth/auth.controller.ts)

登录接口限流基于 IP，攻击者可用代理池对同一用户名分布式暴力破解（每 IP 各尝试 5 次）。连续失败不触发账户临时锁定。`/auth/refresh` 无速率限制。

**建议：** 数据库层记录连续失败次数，达阈值后临时锁定账户；为 `/auth/refresh` 添加宽松速率限制。

---

### SEC-06 Swagger UI 在生产环境未关闭 [低危]

**文件：** [`apps/admin-api/src/main.ts` L69](file:///home/yongsheng/project/autoflow/apps/admin-api/src/main.ts)

`SwaggerModule.setup` 无条件执行，生产环境暴露完整 API 文档。

**建议：**
```typescript
if (process.env.NODE_ENV !== 'production') {
  SwaggerModule.setup('api/docs', app, document);
}
```

---

## 2. 错误处理与健壮性

### ERR-01 `task.processor.ts` `finally` 块 save 失败会覆盖原始异常 [高危]

**文件：** [`apps/admin-api/src/modules/task/task.processor.ts` L113](file:///home/yongsheng/project/autoflow/apps/admin-api/src/modules/task/task.processor.ts)

```typescript
} catch (err) {
  exec.status = ExecutionStatus.FAILED;
  throw err;  // 正确：让 Bull 看到失败
} finally {
  exec.endTime = new Date();
  exec.duration = ...;
  await this.execRepo.save(exec);  // 若此处抛出，会覆盖上面的 throw err
}
```

`finally` 中的 `save` 失败会以数据库异常覆盖原始任务错误，Bull 重试策略被混淆，错误信息丢失。

**建议：**
```typescript
} finally {
  exec.endTime = new Date();
  exec.duration = exec.startTime
    ? new Date().getTime() - exec.startTime.getTime()
    : 0;
  try {
    await this.execRepo.save(exec);
  } catch (saveErr) {
    this.logger.error(`Failed to save execution ${exec.id} final state`, saveErr);
  }
}
```

---

### ERR-02 `exec.duration` 在 `startTime` 为 null 时计算出 NaN [中危]

**文件：** [`apps/admin-api/src/modules/task/task.processor.ts` L117](file:///home/yongsheng/project/autoflow/apps/admin-api/src/modules/task/task.processor.ts)

```typescript
exec.duration = exec.endTime.getTime() - exec.startTime.getTime();
// startTime 若为 null（任务在进入 RUNNING 前失败），结果为 NaN
```

NaN 写入数据库的 `int` 列会引发异常或存储为 0/null，影响监控指标。

**建议：** 添加 null guard（见 ERR-01 建议中已合并）。

---

### ERR-03 执行器 `running_count` 并发计数器在极端情况下可泄漏 [中危]

**文件：** [`apps/executor-python/routers/execute.py` L66](file:///home/yongsheng/project/autoflow/apps/executor-python/routers/execute.py)

```python
sched.running_count += 1
try:
    result = await run_task(req)
finally:
    sched.running_count -= 1
```

进程被 `SIGKILL` 强制终止时 `finally` 不保证执行，计数器泄漏导致执行器永久拒绝新任务（误报 429）。容量检查与 `+=1` 之间存在 await 点，理论上可超限。

**建议：** 使用 `asyncio.Semaphore` 替代手动计数器。

---

### ERR-04 执行器回调（心跳）失败无重试 [中危]

**文件：** [`apps/executor-python/scheduler.py` L13](file:///home/yongsheng/project/autoflow/apps/executor-python/scheduler.py)

心跳失败仅打印 `logger.warning`，不重试。admin-api 短暂不可用时任务结果回报丢失，任务状态停留在 `RUNNING`（直到 5 分钟后 `detectLostExecutions` 修复）。

**建议：** 使用 `tenacity` 为心跳和结果回调添加指数退避重试（3 次，间隔 1/2/4s）。

---

## 3. 任务调度与执行

### TASK-01 调度分布式锁基于时间窗口，存在边界竞争和对高频任务的误杀 [中危]

**文件：** [`apps/admin-api/src/modules/scheduler/scheduler.service.ts` L120](file:///home/yongsheng/project/autoflow/apps/admin-api/src/modules/scheduler/scheduler.service.ts)

```typescript
const lockKey = `lock:schedule:${task.id}:${Math.floor(Date.now() / 10000)}`;
const locked = await client.set(lockKey, '1', 'NX', 'PX', 70000);
```

两个问题：
1. **时钟偏差**：两实例时钟偏差跨越 10s 窗口边界时，各自计算出不同 `lockKey`，锁失效，任务重复触发
2. **高频误杀**：触发间隔 < 10s 的任务在同一窗口内只有第一次能获锁，后续触发被跳过

**建议：** 改为数据库原子 CAS 幂等触发：
```sql
UPDATE tasks SET last_trigger_at = NOW()
WHERE id = ? AND status = 'active'
  AND (last_trigger_at IS NULL OR last_trigger_at < NOW() - INTERVAL ? SECOND)
```
只有 UPDATE 影响 1 行时才入队，彻底消除时钟偏差。

---

### TASK-02 `maxRetry` 参数无上限约束，可耗尽队列 [低危]

**文件：** [`apps/admin-api/src/modules/task/task.service.ts` L80](file:///home/yongsheng/project/autoflow/apps/admin-api/src/modules/task/task.service.ts)

```typescript
await this.taskQueue.add('execute', { executionId: exec.id }, { attempts: task.maxRetry });
```

`task.maxRetry` 来自用户输入，若无 `@Max()` 约束，设为极大值会导致失败任务无限占用队列。

**建议：** `CreateTaskDto`/`UpdateTaskDto` 添加 `@Max(10)`；入队时做 `Math.min(task.maxRetry ?? 3, 10)` 保护。

---

### TASK-03 执行日志全量加载进内存，大日志量可致 OOM [中危]

**文件：** [`apps/admin-api/src/modules/task/task.processor.ts` L38](file:///home/yongsheng/project/autoflow/apps/admin-api/src/modules/task/task.processor.ts)

```typescript
const resp = await axios.get(`http://${executorAddress}/api/logs/${exec.id}`, ...);
const lines: string[] = resp.data?.lines ?? [];  // 全量加载到 Node.js heap
```

数十万行日志会占满 Node.js heap，触发 OOM。

**建议：** 执行器 `/api/logs` 接口加分页，admin-api 分页拉取流式插入，不一次性全量加载。

---

## 4. 代码质量与正确性

### CODE-01 `getExecutionLogs` 的 `totalLines` 计算错误，`hasMore` 恒为 false [中危]

**文件：** [`apps/admin-api/src/modules/task/task.service.ts` L116](file:///home/yongsheng/project/autoflow/apps/admin-api/src/modules/task/task.service.ts)

```typescript
return {
  lines: lines.map((r) => r.content),
  totalLines: lines.length + fromLine,  // 错误：本批行数 + 偏移，不是总行数
  hasMore: false,                        // 恒为 false，前端无法增量拉取
};
```

当 `fromLine=100`、本次返回 50 行时，`totalLines`=150，但实际总行数可能是 1000。`hasMore` 恒为 `false`，前端轮询日志永远提前结束。

**建议：**
```typescript
const totalCount = await this.logLineRepo.count({ where: { executionId: execId } });
return {
  lines: lines.map((r) => r.content),
  totalLines: totalCount,
  hasMore: fromLine + lines.length < totalCount,
};
```

---

### CODE-02 executor-node `runningCount` 检查与 increment 之间结构脆弱 [低危]

**文件：** [`apps/executor-node/src/routes/execute.ts` L56](file:///home/yongsheng/project/autoflow/apps/executor-node/src/routes/execute.ts)

容量检查通过后到 `incrementRunning()` 之间若未来被加入 `await`，会引入竞争窗口。与 executor-python 的问题同源，建议同样改为信号量管理。

---

## 5. 前端问题

### FE-01 Access Token 持久化到 `localStorage`，XSS 可直接窃取 [高危]

**文件：** [`apps/admin-web/src/store/auth.ts` L18](file:///home/yongsheng/project/autoflow/apps/admin-web/src/store/auth.ts)

```typescript
export const useAuthStore = create<AuthState>()(
  persist(
    ...,
    // Zustand persist 默认后端是 localStorage
    { name: 'autoflow-auth', partialize: (s) => ({ token: s.token, user: s.user }) },
  ),
);
```

任何 XSS 漏洞（含供应链攻击引入的第三方脚本）均可通过 `JSON.parse(localStorage.getItem('autoflow-auth')).token` 读取 token，实现账户完全接管。

**建议：**
- Access Token 只存内存（从 `partialize` 中移除 `token`），页面刷新通过 Refresh Token 静默续签
- Refresh Token 存在 `httpOnly; Secure; SameSite=Strict` Cookie 中，由后端 `Set-Cookie` 设置

---

### FE-02 缺少全局 React Error Boundary [中危]

**文件：** [`apps/admin-web/src/App.tsx`](file:///home/yongsheng/project/autoflow/apps/admin-web/src/App.tsx)

未配置 Error Boundary，组件渲染抛出的未捕获错误导致整个应用白屏，无降级 UI。

**建议：** 使用 `react-error-boundary` 在根组件处包裹路由。

---

### FE-03 API 客户端无请求超时配置 [低危]

**文件：** [`apps/admin-web/src/api/client.ts`](file:///home/yongsheng/project/autoflow/apps/admin-web/src/api/client.ts)

未配置超时，后端无响应时用户长时间看到 loading 状态。建议配置 15s 超时并展示可操作的错误提示。

---

## 6. 测试覆盖

### TEST-01 关键异常路径缺乏测试 [高危]

项目已有基础测试（`auth.service.spec.ts`、`task.service.spec.ts`、`task.processor.spec.ts`、`executor.service.spec.ts`、executor-python `test_execute.py`），正常流程有覆盖。以下关键场景缺失：

| 场景 | 关联文件 |
|------|----------|
| `finally` 块 save 失败时原始异常仍传播 | `task.processor.spec.ts` |
| 分布式锁下多实例并发触发只执行一次 | `scheduler.service.spec.ts` |
| 执行器心跳失败后重试 | executor-python tests |
| Refresh Token 吊销后无法换取新 token | `auth.service.spec.ts` |
| `running_count` 超限时返回 429 | executor tests |

**建议：** 补充上述场景；CI 配置覆盖率门槛（`branches: 70, lines: 80`）。

---

### TEST-02 executor-python 无子进程环境变量隔离测试 [中危]

**文件：** [`apps/executor-python/tests/test_execute.py`](file:///home/yongsheng/project/autoflow/apps/executor-python/tests/test_execute.py)

现有测试未验证子进程是否无法读取 `EXECUTOR_SHARED_TOKEN`。引入白名单化后，需配套测试证明隔离真正生效。

---

## 7. 配置与运维

### OPS-01 容器无资源限制，恶意任务可耗尽宿主机资源 [中危]

**文件：** [`docker-compose.yml`](file:///home/yongsheng/project/autoflow/docker-compose.yml)

所有容器未配置 `deploy.resources.limits`，失控的执行器任务可打满宿主机 CPU/内存，导致所有服务崩溃。

**建议：**
```yaml
deploy:
  resources:
    limits:
      cpus: '0.5'
      memory: 512M
```
执行器容器建议更严格限制（≤ 256M）。

---

### OPS-02 健康检查端点未验证关键依赖状态 [低危]

**文件：** [`apps/executor-python/routers/health.py`](file:///home/yongsheng/project/autoflow/apps/executor-python/routers/health.py)

`/health` 返回固定 `{ status: 'ok' }`，不验证与 admin-api 的连通性，容器编排系统无法感知执行器真实就绪状态。建议区分 liveness 和 readiness 探针。

---

### OPS-03 缺少跨服务请求追踪（Trace ID）[低危]

任务从触发 → 队列 → 执行器 → 回调的全链路无统一 `traceId`，多服务日志无法关联，故障排查需手动比对时间戳。建议生成 UUID v4 `traceId` 并通过 `X-Trace-Id` header 在链路中传递。

---

## 8. 问题汇总表

| ID | 分类 | 标题 | 严重程度 |
|----|------|------|----------|
| SEC-01 | 安全 | 子进程继承全量环境变量，secrets 可被任务读取 | **严重** |
| SEC-02 | 安全 | Refresh Token 无持久化与吊销，登出后仍有效 | 高危 |
| SEC-03 | 安全 | 执行器共享静态 Token，无过期与轮换 | 高危 |
| SEC-04 | 安全 | compose 注入 `EXECUTOR_SECRET` 但代码读 `EXECUTOR_SHARED_TOKEN`，认证实际失效 | 高危 |
| FE-01 | 安全/前端 | Access Token 持久化到 localStorage，XSS 可窃取 | 高危 |
| ERR-01 | 错误处理 | `finally` save 失败覆盖原始异常，干扰 Bull 重试 | 高危 |
| TEST-01 | 测试 | finally 失败/锁竞争/Token 吊销等关键场景无测试 | 高危 |
| SEC-05 | 安全 | 登录限流未按用户名，无账户锁定 | 中危 |
| ERR-02 | 错误处理 | `exec.duration` 在 startTime 为 null 时计算出 NaN | 中危 |
| ERR-03 | 错误处理 | `running_count` 在极端情况下可泄漏或超限 | 中危 |
| ERR-04 | 错误处理 | 心跳无重试，失败仅 warning，执行器静默失联 | 中危 |
| TASK-01 | 调度 | 分布式锁时间窗口边界竞争，可重复触发或漏触发 | 中危 |
| TASK-03 | 调度 | 执行日志全量加载进内存，大日志可致 OOM | 中危 |
| CODE-01 | 代码质量 | `getExecutionLogs` totalLines 计算错误，hasMore 恒为 false | 中危 |
| FE-02 | 前端 | 缺少全局 React Error Boundary | 中危 |
| TEST-02 | 测试 | 无子进程环境变量隔离的安全边界测试 | 中危 |
| OPS-01 | 运维 | 容器无资源限制 | 中危 |
| SEC-06 | 安全 | Swagger UI 生产环境未关闭 | 低危 |
| TASK-02 | 调度 | maxRetry 无上限约束，可耗尽队列 | 低危 |
| CODE-02 | 代码质量 | executor-node runningCount 检查结构脆弱 | 低危 |
| FE-03 | 前端 | API 客户端无请求超时配置 | 低危 |
| OPS-02 | 运维 | 健康检查不验证依赖状态 | 低危 |
| OPS-03 | 运维 | 缺少跨服务 Trace ID 链路追踪 | 低危 |

**严重：1 · 高危：6 · 中危：10 · 低危：6**

---

## 优先修复建议

**立即处理**

1. **SEC-04**（5 分钟）— 统一 `EXECUTOR_SECRET` / `EXECUTOR_SHARED_TOKEN` 变量名，修复生产环境执行器认证失效
2. **SEC-01**（1 小时）— 子进程 env 白名单化，移除 secrets
3. **ERR-01 + ERR-02**（30 分钟）— `finally` 块 save 用 try/catch 包裹；`duration` 计算加 null guard
4. **CODE-01**（30 分钟）— 修复 `totalLines` 计算和 `hasMore` 判断

**近期处理**

5. **SEC-02** — 实现 Refresh Token 持久化与吊销
6. **FE-01** — Access Token 迁出 localStorage，Refresh Token 改用 httpOnly Cookie
7. **TASK-01** — 分布式锁改为数据库 CAS 幂等触发
8. **ERR-04** — 执行器心跳和回调添加重试逻辑

**计划处理**

9. **TEST-01** — 补充关键异常场景测试，设置 CI 覆盖率门槛
10. **OPS-01** — 为容器添加资源限制
11. **OPS-03** — 接入结构化日志与分布式追踪
