# load-test.mjs — AutoFlow 全栈并发压测工具

Node 原生（零第三方依赖，需 Node >= 18，使用内置 `fetch`），对运行中的全栈做受控并发的任务压测，验证调度核心的正确性与吞吐。

## 它做什么

1. **登录取 JWT**：`POST /api/auth/login`（字段 `username`/`password`，响应 `accessToken`/`refreshToken`）。
2. **并发创建+触发 glue 脚本任务**：`POST /api/tasks`（`glueSource` 内联脚本，无需 git/依赖安装，执行最快且必有终态）→ `POST /api/tasks/:id/trigger`（`triggerType=manual`）。
3. **轮询 executions 至终态**：`GET /api/tasks/:id/executions`，统计成功/失败/超时分布。
4. **重复执行检测**：同一任务若出现 >1 条「非取消终态且非重试派生」的 execution 行，计为调度违规。重试语义判定规则：
   - BullMQ attempts 重试**复用同一行**（`task.processor` 的 claim 把 `FAILED` 留在可认领列表），不产生新行；
   - stale sweep / executor-restart 恢复路径（`ExecutorService.scheduleRetryAfterRecovery`）会新建 PENDING 行且 `retryCount = 原行+1`，或兜底携带 `triggerType ∈ {stale_recovery, executor_restart}`——这些行是合法重试派生，**不计违规**；
   - 仅统计非重试派生的终态行（`success/failed/timeout/killed`），>1 即违规。
5. **打印报告表**：吞吐（任务/分钟）、成功率、p50/p95 耗时、429 计数、违规清单。
6. **退出码**：全部成功且无违规 → `0`；成功率 <100%、发现重复执行或存在轮询超时 → `1`；登录/参数错误 → `2`。可直接用于 CI/巡检。

## 前置条件

- **compose 全栈已启动**：`docker compose up -d`（postgres、redis、admin-api、registry 至少就绪）。
- **至少 1 个执行器在线**（executor-node 或 executor-python，且已注册为 ONLINE）。工具创建的是 `runtime: node` + `glueLanguage: javascript` 的 glue 任务，由在线执行器执行；没有执行器时所有任务会以 `EXECUTOR_OFFLINE` 失败（此时退出码非 0，属预期）。
- 管理员账号可用。compose 缺省 `admin` / `Admin@123456`（`INITIAL_ADMIN_PASSWORD`），可用 `--username/--password` 或 `LOAD_TEST_USERNAME/LOAD_TEST_PASSWORD` 覆盖。

## 用法

```bash
node scripts/load-test.mjs [options]

# 最小示例：默认 localhost:3105，10 个任务、并发 10
node scripts/load-test.mjs

# 20 个任务、并发 5、pin 到指定执行器
node scripts/load-test.mjs --count 20 --concurrency 5 \
  --executor 0d9a6c1e-....-uuid

# 按时长压测 120 秒
node scripts/load-test.mjs --duration 120 --concurrency 10

# 指定地址与账号
node scripts/load-test.mjs --base-url http://10.0.0.5:3105 \
  --username admin --password 'YourStr0ngPass!'
```

### 选项一览

| 选项 | 默认 | 说明 |
|------|------|------|
| `--base-url` | `http://localhost:3105` | admin-api 地址（env `LOAD_TEST_BASE_URL`） |
| `--username` / `--password` | `admin` / `Admin@123456` | 管理员账号（env `LOAD_TEST_USERNAME`/`LOAD_TEST_PASSWORD`） |
| `--concurrency` | `10` | 在途任务并发度 C |
| `--count` | `10` | 共创建+触发的任务数；未给 `--duration` 时用此项 |
| `--duration` | - | 按秒数压测（与 `--count` 同时给出时先到者停） |
| `--max-rpm` | `55` | 工具侧总请求预算/分钟（须低于服务端 `THROTTLE_LIMIT`） |
| `--create-rate` | `40` | 写操作（create/trigger/delete）速率/分钟 |
| `--poll-interval` | `1000` | 轮询 executions 的基础间隔（ms） |
| `--task-timeout` | `180` | 单任务等待终态的超时（秒） |
| `--executor` | - | `executorId` pin：任务只派给该执行器 |
| `--glue-language` | `javascript` | `javascript` \| `python` \| `shell` |
| `--keep-tasks` | 关 | 结束后保留创建的任务（默认软删除，executions 留档） |

## 限流与 429

- admin-api 全局限流默认 **60 req/min**（`THROTTLE_LIMIT`/`THROTTLE_TTL`，见 `apps/admin-api/src/config/configuration.ts`），登录另有 `LOGIN_THROTTLE_LIMIT`（默认 20/min）。
- 工具内置两层客户端限速（`--max-rpm` 总预算、`--create-rate` 写预算），默认值刻意压在 60/min 之下；收到 429 时按 **1s→2s→4s→…→30s 封顶**指数退避（叠加随机抖动，并优先尊重 `Retry-After` 头）。
- **压测前建议调高服务端 `THROTTLE_LIMIT`**（如 `THROTTLE_LIMIT=600` 后重启 admin-api），否则轮询请求会频繁退避，吞吐数字被限流而非调度能力主导。

## 示例输出

```
==== AutoFlow 全栈压测 ====
目标: http://localhost:3105
并发度=10 规模=count=10 maxRpm=55 createRate=40/min glue=javascript
登录成功，JWT 已获取。

清理 10 个压测任务...

==== 压测报告 ====
目标:                http://localhost:3105
规模:                count=10 / 并发度=10
总耗时:              46.21s
任务尝试:            10
  创建成功/失败:     10 / 0
  触发成功/失败:     10 / 0
终态分布:
  success:           10
  failed/timeout:    0
  killed:            0
  cancelled:         0
  轮询超时(未终态):  0
成功率:              100.0%
吞吐:                13.0 任务/分钟
耗时 p50 / p95:      4.12s / 5.87s
重复执行违规任务:    0
重试派生行(不计违):  0
HTTP 请求 / 429:     203 / 0
结论:                PASS
```

## 已知边界

- **不做执行器饱和打满**：创建+触发速率默认压在限流之下（`--create-rate 40/min`），派发侧并发由执行器自身的 `MAX_CONCURRENT_TASKS`（compose 缺省 10）决定——工具不绕过该上限，测的是「调度正确性 + 限流内吞吐」，不是执行器极限容量。
- glue 任务不装依赖、不拉 git，验证的是 调度→派发→回调→终态 全链路；不覆盖依赖安装路径。
- 重复执行判定是**压测窗口内**的行级检测；压测结束后清理任务（软删除）不影响 executions 留档，可在 admin-web 复核。
- 按 `--duration` 模式运行时，报告中的吞吐以「实际尝试的任务数 ÷ 总耗时」计。
- 登录受 `LOGIN_THROTTLE_LIMIT` 限速且失败 5 次会锁账号 15 分钟（SEC-05），密码错误时工具只重试 3 次 429 后放弃，避免触发锁定。

## 自检

```bash
node --check scripts/load-test.mjs          # 语法
node scripts/load-test.selftest.mjs         # 纯函数冒烟（p95/重复判定/退避曲线），退出码 0
```

HTTP 交互逻辑（登录、创建、触发、轮询）需要运行栈，本机无法起全栈时标注为**需运行栈验证**；纯函数部分（`computePercentile`、`classifyExecutions`、`isRetryDerivedExecution`、`nextBackoffDelayMs`、`isTerminalStatus`）已由 `scripts/load-test.selftest.mjs` 用 `node:assert` 全量覆盖。
