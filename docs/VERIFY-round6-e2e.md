# AutoCodeFlow 第六轮真机 E2E 验证报告（VERIFY-round6-e2e）

- 验证人：第六轮真机验证 agent V
- 日期：2026-09-03
- 代码基线：`develop` 工作树（含全部未提交第六轮改动；验证对象即当前工作树，未做任何 git commit）
- 环境：Docker 26.1.4 + Compose v5.1.1，Linux 宿主（node v24.13.0）
- 隔离方式：宿主端口侦察确认 5432/6379 已被占用（宿主 postgres/redis + metabase:8111、flow2api:8005 容器在跑）。本轮**不使用 compose 编排**，改为一次性容器 + 显式 env 直跑：
  - `acf-r6-postgres`（postgres:16-alpine，宿主 `25432`）、`acf-r6-redis`（redis:7-alpine，宿主 `26379`），全新空卷
  - admin-api：`apps/admin-api` `npx nest build` 后 `node dist/main.js`，宿主 `3105`，日志 `/tmp/acf-r6-admin*.log`
  - executor-node：`apps/executor-node` `npx tsc` 重建后 `node dist/main.js`，宿主 `8002`，日志 `/tmp/acf-r6-exec.log`
- admin-api 启动 env（关键项）：`NODE_ENV=production`、`DB_SYNCHRONIZE=false`、DB/Redis 指向 25432/26379、`JWT_SECRET/JWT_REFRESH_SECRET`（≥32 字符）、`EXECUTOR_SECRET`（≥16 字符）、`INITIAL_ADMIN_PASSWORD`（种子用户名固定 `admin`）、`CORS_ALLOWED_ORIGINS=http://r6verify.local`（生产禁 localhost）、`LOG_STORAGE_DRIVER=db`、`ADMIN_API_URL=http://localhost:3105`
- **本轮与 compose 标准部署的两点差异（如实声明）**：
  1. executor 以宿主进程跑、address=`127.0.0.1:8002`（loopback）。dispatch 侧 F-3 SSRF 守卫默认拦截 loopback（`safe-http.util.ts:129`），故 admin-api 额外设置 `EXECUTOR_ALLOW_PRIVATE_NETWORK=true`。compose 部署中 executor 走内网 DNS 地址，无需该开关（round5/round5v2 已证 private-lan 默认放行）。
  2. 迁移先于起服手动执行（`npm run migration:run` 指向 25432 空库），以独立验证第 6 项；起服后 `migrationsRun=true` 路径亦正常（无报错、无重复执行）。

## 0. 验证项总览

| # | 验证项 | 结果 |
|---|---|---|
| 1 | 迁移链 25/25 + 二次幂等 + `tasks.executorId` 列 | ✅ 通过 |
| 2 | N6 残留节奏抖动修复（TTL=周期−500ms） | ✅ 通过（11/11 gap 全 ≈15.00s，无 30s 级 gap） |
| 3 | CreateTaskDto id UUID 校验（400/409） | ✅ 通过 |
| 4 | 任务级 executor pinning（a 在线派发 / b 幽灵 uuid / b' 离线 / c broadcast 互斥） | ✅ 通过（4 分支全中） |
| 5 | install.sh 承载路由 + install-cmd + 注入校验（N15） | ✅ 通过 |
| 6 | GET /metrics/scheduler 可观测性回归 | ✅ 通过 |

## 1. 迁移链（验证项 1）—— ✅

### 1.1 首跑（空库）

`DB_HOST=localhost DB_PORT=25432 ... npm run migration:run`（`src/data-source.ts`，NODE_ENV=production）：

```
25 migrations are new migrations must be executed.
Migration InitialSchema1717473142678 has been executed successfully.
...（中略 23 条）...
Migration CreateAppDeploymentsTable1788274394055 has been executed successfully.
Migration AddTaskExecutorId1788369816718 has been executed successfully.
exit=0
```

**25/25 全部执行成功，exit 0**（round5 N1 的三处断点迁移 2691/2693/1788274394054 本轮空库直跑无一失败，第五轮修复持续有效）。

### 1.2 二次跑幂等

```
No migrations are pending
exit=0
```

`select count(*) from migrations;` → **25**。

### 1.3 新列确认

```
column_name | data_type         | is_nullable
------------+-------------------+------------
executorId  | character varying | YES
```

**观察**：列名为带引号 camelCase `"executorId"`（迁移 25 与实体 `@Column({ nullable: true }) executorId` 一致，非任务书预期的 `executor_id` snake_case）——与本 schema 既有列（`taskId`、`executorAddress` 等）命名风格一致，判定为符合设计而非缺陷。迁移体 `ADD COLUMN IF NOT EXISTS` / `DROP COLUMN IF EXISTS` 幂等语义成立（1.2 二次跑佐证）。

## 2. N6 残留节奏抖动修复（验证项 2）—— ✅

### 2.1 修复语义

`scheduler.service.ts:64` `TRIGGER_DEDUP_JITTER_BUFFER_MS = 500`；`computeTriggerDedupTtlMs`（:87-92）fixed_rate → `max(fixedRate*1000 − 500, 1000)`。锁在下一 tick 前必定过期，消除 round5v2 §2.3 的 15s/30s 混合节奏。

### 2.2 真机观测

任务 `r6-n6-fixed-rate-15s`（fixedRate=15、timeoutSeconds=10、glue node 脚本），executor 在线，观察窗 18:58:15 → 19:01:00 UTC（≥3 分钟）。`task_executions.createdAt` 全序列（psql 直查）：

| # | createdAt (UTC) | gap → 下一条 (s) | status |
|---|---|---|---|
| 1 | 18:58:15.014 | 15.000 | success |
| 2 | 18:58:30.014 | 15.000 | success |
| 3 | 18:58:45.014 | 15.001 | success |
| 4 | 18:59:00.015 | 15.000 | success |
| 5 | 18:59:15.015 | 15.001 | success |
| 6 | 18:59:30.016 | 15.001 | success |
| 7 | 18:59:45.017 | 15.000 | success |
| 8 | 19:00:00.017 | 15.000 | success |
| 9 | 19:00:15.017 | 14.999 | success |
| 10 | 19:00:30.016 | 15.001 | success |
| 11 | 19:00:45.017 | 15.000 | success |
| 12 | 19:01:00.017 | — | success |

**判定标准核验**：11 个 gap 全部 ∈ [14.999, 15.001]s，**全部 < 20s、均值 15.000s（∈14-17s）、无任何 30s 级 gap**；12/12 success（触发→入队→派发→执行全链）。对照修复前基线（round5v2 §2.3：32 个 gap 中 15/30 混合、实测频率仅标称 ~55%-100%）——**修复生效，节奏抖动消除**。

### 2.3 锁 TTL 直接采样（佐证缓冲值）

tick 19:02:15.0x 后 1.55s 采样 `lock:task:trigger:1c13788f-...`：

```
12909   （PTTL，ms）
```

12909 + 1550 ≈ 14459 ≈ **14.5s = 15s − 500ms**，与 `TRIGGER_DEDUP_JITTER_BUFFER_MS` 精确吻合（修复前 TTL=15s 整）。

## 3. CreateTaskDto id UUID 校验（验证项 3）—— ✅

| 请求 | 结果 | 响应摘录 |
|---|---|---|
| `POST /api/tasks` `"id":"not-a-uuid"` | **HTTP 400**（非 500） | `{"code":400,"message":"Validation failed","data":["id must be a UUID"]}` |
| `"id":<合法 uuid v4>` 首建 | 201，id 原样落库 | `66143bd0-f1f6-4864-9cbe-965030d1214c` |
| 同 uuid 重复提交 | **HTTP 409** | `{"code":409,"message":"Task with id \"66143bd0-...\" already exists"}` |

DTO `@IsUUID("4") @IsOptional()`（create-task.dto.ts:29）拦截非法 id；重复路径由 `task.service.ts` 预检查 + `isUniqueViolation`(23505) 兜底转 `ConflictException`。round5v2 观察 C（字符串 id 报 500）闭环。

## 4. 任务级 executor pinning（验证项 4）—— ✅

在线 executor：`6b8eb16d-7d1c-4508-a30e-2d7785e189a3`（address `127.0.0.1:8002`，acf-r6-executor）。

### 4.1 a) pin 到在线 executor → manual trigger

- 建任务响应回显 `executorId: 6b8eb16d-...`（新列读写通路正常）
- admin-api 日志：`Dispatching task "r6-pin-online" to executor 127.0.0.1:8002 (runningTasks=1)`
- execution 终态：`status=success, executorAddress=127.0.0.1:8002`（与 pin 目标匹配）

### 4.2 b) pin 到随机不存在 uuid（maxRetry=0）

```
status | failureReason | err
-------+---------------+--------------------------------------------------------------
failed | unknown       | Pinned executor 1fa892d9-927f-44d6-90e7-ef2fc97455c1 not found
```

errorMessage 含 "Pinned executor"；分类落 **UNKNOWN**——与 `executor.service.ts:592-595` 注释一致（"not found" 刻意不匹配 EXECUTOR_OFFLINE 分类器，因该 executor 从未注册，报 offline 是撒谎）。如实记录。

### 4.3 b') pin 到存在但 OFFLINE 的 executor（补测优雅下线分支）

SIGTERM executor（日志 `Sent offline notification to admin-api`，列表转 offline）后再 trigger：

```
status | failureReason    | err
-------+------------------+--------------------------------------------------------------------------
failed | executor_offline | Pinned executor "acf-r6-executor" (6b8eb16d-...) is offline
```

分类正确落 **EXECUTOR_OFFLINE**（消息形状与 `task.processor.ts` 分类器 `/executor.*(offline|unavailable)/` 对齐，executor.service.ts:600-604 注释兑现）。

### 4.4 c) executeMode=broadcast + executorId 同传

`POST /api/tasks` → **HTTP 400**：`"executorId (pinned executor) is mutually exclusive with executeMode=broadcast"`（task.service.ts:107-114 写入边界拒绝）。

## 5. install.sh 承载路由（验证项 5）—— ✅

### 5.1 GET /api/executors/install.sh

```
HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8
Content-Length: 9346
```

- 首行 `#!/usr/bin/env bash` ✅；@Public 无需 JWT ✅
- 落盘与仓库根 `scripts/install.sh` **逐字节一致**（`diff` 无差异，"互为拷贝"承诺成立）
- `bash -n` 语法检查通过

### 5.2 GET /api/executors/install-cmd（JWT）

```json
{"cmd":"curl -fsSL 'http://localhost:3105/api/executors/install.sh' | bash -s -- --api-url 'http://localhost:3105' --secret 'acf-r6-executor-secret-token'",
 "token":"acf-r6-executor-secret-token","adminApiUrl":"http://localhost:3105"}
```

新 curl|bash 形态 ✅，URL 指向本轮承载路由 ✅，值经单引号 shell 转义 ✅。
**观察**：`ADMIN_API_URL` 未设置时 cmd 退化为 `curl -fsSL '/api/executors/install.sh' | bash -s -- --api-url '' ...`（相对路径 + 空 api-url，不可用）。docker-compose.yml:196 已为 admin-api 注入该变量，标准部署不受影响；裸机/手动部署需显式配置——建议文档标注或加启动告警。

### 5.3 N15 参数注入校验（脚本侧）

在 `/tmp/acf-r6-inj` 空目录执行：

```
bash install.sh --api-url http://127.0.0.1:3105 --secret test-secret --name $'evil\nEXECUTOR_SECRET=pwned'
错误：--name 只允许字母、数字、点、下划线、连字符（不允许空白/斜杠/引号等字符）
exit=1
```

**exit 1、目录零文件落盘、`/opt/autoflow-executor` 未创建**——校验位于一切写操作之前，换行注入伪造 `EXECUTOR_SECRET=` 键值对的路径被阻断。脚本内另有 `--port`（1-65535 整数）、`--work-dir`（绝对路径白名单字符）、`--runtime`（枚举）三重校验（install-script.content.ts:47-63），本轮以 --name 实证拦截行为。

## 6. 调度可观测性回归（验证项 6）—— ✅

`GET /api/metrics/scheduler`（JWT）→ 200，结构完整（N6 改动未破坏）：

```json
{"counters":{"ticks":3,"triggersClaimed":2,"triggersSkippedLockHeld":0,"triggersFailed":0,...},
 "derived":{"avgTickDurationMs":4,"tickRatePerSec":0.0253,...},
 "queue":{"waiting":0,"active":0,"delayed":0,"failed":0,"completed":2},
 "scheduler":{"healthy":true,"isLeader":true,"activeTimers":1,"totalScheduledTasks":1,...}}
```

计数与真机行为自洽：观察窗内 `triggersClaimed` 随 tick 递增、`triggersSkippedLockHeld=0`（修复后不再出现锁窗口吞 tick）；重启后 `activeTimers=1/totalScheduledTasks=1` 证明 fixed_rate 定时器经 reload 正确恢复。

## 7. 遗留观察（不判失败）

1. **install-cmd 对 `ADMIN_API_URL` 的硬依赖**（§5.2）：未配置时生成不可用命令，compose 已覆盖，建议加 dev 兜底或启动告警。
2. **`"executorId"` 列命名**为 camelCase 带引号（§1.3），与任务书预期的 `executor_id` 不同，但与全库既有风格一致。
3. **pinned-not-found 落 UNKNOWN**（§4.2）：属设计内行为（代码注释明示），但运维视角 "Pinned executor ... not found" 与 offline 同样常见于误删执行器场景，未来可考虑新增 `EXECUTOR_NOT_FOUND` 分类。
4. **宿主 loopback executor 需 `EXECUTOR_ALLOW_PRIVATE_NETWORK=true`**（§0 差异 1）：SSRF 守卫按预期拦截 loopback，本轮为验证 pinning 全链而显式放行；生产 compose 部署无需该开关。
5. admin-api 重启后 leader 在 ~30s 后 acquired（03:02:33 启动 → 03:03:03 acquired，15s 重试周期 + 锁残余 TTL），与 round5v2 N3 修复语义一致，非回归。

## 8. 结论

第六轮全部 6 项真机改动**验证通过**：N6 残留节奏抖动修复效果决定性（gap 全 15.000±0.001s，锁 TTL 实测 14.5s）；DTO id 校验 400/409 闭环 round5v2 观察 C；executor pinning 四分支（在线派发/幽灵 UNKNOWN/离线 EXECUTOR_OFFLINE/broadcast 互斥 400）语义全部按代码注释兑现；install.sh 承载路由与仓库脚本逐字节一致且注入校验有效；/metrics/scheduler 无回归；迁移链 25/25 空库直跑 + 幂等，round5 N1 修复持续成立。

## 9. 环境清理确认

- [x] `docker rm -f acf-r6-postgres acf-r6-redis`（含数据卷）
- [x] kill admin-api（pid 1407335/1407337）与 executor-node（pid 1402181，SIGTERM 优雅下线）全部 node 进程
- [x] `docker ps` / `ps` 过滤确认无 acf-r6 残留；未触碰 metabase/flow2api 等他人容器
- [x] 仓库除本报告外零改动，未执行任何 git commit；临时文件均在 /tmp（acf-r6-* 前缀）
