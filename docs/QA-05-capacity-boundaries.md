# QA-05 / BUG-19 容量与压测边界（第三阶段：本机实跑参考基线）

> **状态（2026-09-11 第十轮更新）**：
> - **第二阶段**：压测编排脚本 `scripts/load-test-stack.sh` 就绪（PG/Redis→admin-api 空库迁移+三档限流显式放大→executor-node 注册 online→load-test.mjs 透传），selftest 26 组全绿。
> - **第三阶段（本机实跑）**：本机（用户授权 ubuntu，单节点：admin-api + 1×executor-node + PG16 + Redis7）完成 **tasks / SSE** 两场景真实实测，找到 2 个真实问题（SSE abort 桥挂死、单 executor 乐观锁冲突居高），数据与发现如下。**标注：本机单节点参考基线，非生产容量结论**——生产形态（多执行器/多实例/反代/持久磁盘）不同，本表数字不得外推。

## 1. 范围与验收关系

QA-05 与 BUG-19 的计划要求包括：单实例 500 并发执行、1000 任务/分钟入队、SSE 500 连接、回调风暴 10k/分钟，并产出容量白皮书和瓶颈定位。第一阶段只收口可重复运行的工具边界：

- `scripts/load-test.mjs` 支持 `tasks`、`sse`、`callback` 三种场景；
- 可配置并发、count/duration、客户端请求/写入速率和 HTTP 超时；
- 对 429 退避、错误分类、终态/重复执行判定、安全停止、p50/p95/吞吐提供统一输出；
- `scripts/load-test.selftest.mjs` 覆盖纯函数边界与失败输入；
- `scripts/load-test.README.md` 记录运行前置、指标解释和未实测目标。

**第一阶段出口不等于容量验收出口。** 容量白皮书、瓶颈定位和目标数字的通过/不通过，需要后续在隔离运行栈和可观测条件满足后另行形成实测记录。

## 2. 运行前置清单

每次真机试验必须把下列值写入实验记录；缺项时只记录工具行为，不下容量结论：

- **全栈 compose**：`docker compose up -d` 后 postgres、redis、admin-api、registry 均健康，admin-api 健康检查可访问；不能只启动 API 后把失败结果当容量结果。
- **账号**：可用管理员账号/密码，密码以当前 `.env` 的 `INITIAL_ADMIN_PASSWORD` 为准；推荐 `LOAD_TEST_USERNAME`/`LOAD_TEST_PASSWORD`，避免把密码放进 shell history。
- **在线 executor**：至少一个 executor 已注册为 `ONLINE`，并确认 runtime/language 匹配；固定 `--executor` 时记录 UUID。无在线 executor 的 tasks 失败属于前置不满足。
- **限流**：记录 `THROTTLE_LIMIT`、`LOGIN_THROTTLE_LIMIT`、OPS 写面、callback 限流、SSE 槽位、`Retry-After` 行为以及 nginx/ingress 超时；客户端限速参数要与服务端限制的关系可解释。
- **资源与观测**：记录 admin-api 实例数、CPU/RSS/event loop、Postgres CPU/连接池/慢查询、Redis/BullMQ 队列深度、executor 数量与 `MAX_CONCURRENT_TASKS`、429/5xx、SSE 活跃槽位、回调认证/业务指标。
- **隔离与收尾**：使用独立压测时间窗/任务命名；默认 tasks 清理为软删除但 executions 留档；中断后检查残留任务、队列 backlog 和 executor running 列表。

## 3. 当前工具可测边界

### 3.1 tasks

默认执行轻量内联 glue 任务：登录 → 创建 → 手动触发 → execution 轮询 → 清理。支持：

```bash
node scripts/load-test.mjs \
  --scenario tasks --count 20 --concurrency 5 \
  --max-rpm 55 --write-rpm 40
```

工具会统计创建/触发失败、终态分布、轮询超时、重复执行违规、合法 retry 派生行、成功率和 p50/p95。默认 `maxRetry=0` 是为了隔离重复执行判定，并不代表生产任务均无重试。

### 3.2 SSE

默认 `GET /api/metrics/stream`，也可指定 `/api/executions/stream`：

```bash
node scripts/load-test.mjs \
  --scenario sse --count 32 --concurrency 32 \
  --sse-path /api/metrics/stream --sse-hold 30
```

场景验证 JWT 建连、读取响应 body、保持时间内连接未提前断开，并在窗口结束主动 abort；不伪造服务端推送量。当前默认 admin-api 配置中 `/metrics/stream` 全局槽位为 32，日志流全局默认 64，`/executions/stream` 复用 metrics 槽位；服务端槽位和实例拓扑必须纳入实验记录。

### 3.3 callback

callback 场景要求调用方提供真实 execution UUID 和有效 token：

```bash
export LOAD_TEST_CALLBACK_TOKEN='v1....'
export LOAD_TEST_CALLBACK_EXECUTION_ID='xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
node scripts/load-test.mjs \
  --scenario callback --count 20 --concurrency 5 \
  --callback-batch-size 100 --callback-rate 40
```

每个 HTTP 请求最多 100 条，符合 admin-api callback DTO/控制器边界。工具不会生成伪造 execution、猜测 token 或把重复回调伪装成新执行；该场景只能观测入口 HTTP 成功率、错误分类和回调条目吞吐。共享 executor token 还要提供 `--callback-executor-address`；`v1.` token 必须与 execution ID 绑定。

## 4. 指标口径

- **成功率**：tasks = 成功终态任务 / 任务尝试；SSE = 成功保持到期连接 / 连接工作单元；callback = HTTP 成功请求 / 请求工作单元。创建、触发、鉴权、限流、网络或协议失败不会被计入成功。
- **吞吐**：同时报告 attempted 与 completed。completed 只计成功任务、保持到期的 SSE 连接或 HTTP 成功回调条目；失败请求不能计入文档承诺的完成吞吐。两者均除以工具总耗时分钟，受客户端限速、轮询、清理时间和安全停止影响，不是 admin-api 或 executor 的理论极限。
- **tasks p50/p95**：从触发后到观察到终态的 `duration`；若返回行没有有限 duration，使用客户端观测时长。
- **SSE p50/p95**：连接保持/结束时长；另行报告建连 p50/p95。窗口到期是客户端主动关闭，不代表服务端自然结束；hold 到期记录仍保留真实收到 response headers 的 `headerMs`，不会用 hold 时长覆盖建连延迟。
- **callback 延迟**：当前不伪造服务端处理耗时，报告入口成功率/条目吞吐；若需端到端延迟，必须使用真实 execution fixture 并从服务端 trace/时间戳补齐。
- **错误分类**：`auth`、`throttle`、`validation`、`not_found`、`conflict`、`server`、`timeout`、`network`、`cancelled`、`protocol`、`unknown`。这是客户端归一化，必须和服务端日志、Prometheus、DB/Redis 观测交叉核对。
- **429**：报告客户端收到的 HTTP 429（含重试请求），不等于服务端所有限流命中；`Retry-After` 优先，否则指数退避最高 30 秒。
- **清理与安全停止**：收到 SIGINT/SIGTERM 后停止派发，abort 排队限速、在途 HTTP 和轮询等待。tasks 清理使用独立并发 lane（不受压测读写限速影响）和随任务数增长的 60 秒至 1 小时上限超时；每个删除失败进入错误统计，存在未清理任务时结果明确为 FAILED、退出码非零。已派发任务可能仍在服务端运行，必须复核 backlog 和残留 execution。

## 5. 后续目标（全部未实测、未验收）

下面数字是 QA-05 计划目标，不是本阶段结果：

| 目标 | 后续实验要求 | 当前不可声称的内容 |
|---|---|---|
| 单实例 500 并发执行 | 逐级提高在途 execution；记录 executor 并发、BullMQ 深度、PG 池水位、API CPU/RSS、p95/错误 | 工具 `--concurrency 500` 只代表发起目标，不代表单实例能稳定承载 500 |
| 1000 任务/分钟入队 | 独立入队节奏；提高限流前先记录限流配置，拆分 API、DB、Redis 和队列瓶颈 | 客户端默认 40 写请求/分钟不能代表 1000 任务/分钟验收 |
| SSE 500 连接 | 调整并验证 `METRICS_STREAM_MAX_GLOBAL`、日志/SSE 槽位、反代超时、多实例路由和资源水位 | 默认 32/64 进程内槽位不足以支持 500 连接结论 |
| 回调 10k/分钟 | 准备真实 execution fixture/token；按 100 条批次施压并记录 callback 限流、55 MB body 上限、DB 条件更新/幂等和认证指标 | 重复同一 execution 的 callback 场景不等于 10k 个真实完成回调 |
| 容量白皮书/瓶颈定位 | 每一档至少重复运行，保留环境、配置、指标、错误、429/5xx、停止/清理记录，并定位 PG/BullMQ/回调路由/执行器瓶颈 | 在这些证据形成前，BUG-19/QA-05 容量验收仍为未完成 |

## 6. 第一阶段验证结果

已执行：

```bash
node --check scripts/load-test.mjs
node scripts/load-test.selftest.mjs
```

两项均通过。HTTP 场景与容量目标未在本阶段运行；compose 真机数据、容量上限和容量白皮书待后续实验补录。

## 7. 第三阶段实跑记录（本机单节点参考基线，2026-09-11）

### 7.1 编排与前置

运行入口统一为 `bash scripts/load-test-stack.sh <load-test args>`（`SKIP_DOCKER=1` 复用本机 PG/Redis）。栈内显式放大：`THROTTLE_LIMIT/LOGIN_THROTTLE_LIMIT/AUTH_THROTTLE/OPS_THROTTLE=10000`（容量档不把 SEC-09 分域限流当瓶颈，语义不变仅数值抬升）、`METRICS_STREAM_MAX_GLOBAL=128`。

### 7.2 tasks 实测表（glue JS 轻任务，maxRetry=0，client rpm 1200/1000）

| 档位 | 并发 | executor MAX_CONCURRENT | 成功率 | 终态 success/failed | p50/p95 | 尝试/完成吞吐 | 429 | 失败主因 |
|---|---|---|---|---|---|---|---|---|
| count=20 | 5 | 10（默认） | 75% | 15/5 | 17/19ms | 218/164 任务/分 | 0 | 全部 `No available executor (all at capacity or concurrency conflict)` |
| count=100 | 25 | 10（默认） | 40% | 40/60 | 17/32ms | 975/390 任务/分 | 0 | 同上（60 例同因） |
| count=100 | 25 | 40（`LT_MAX_CONCURRENT=40`） | 65% | 65/35 | 18/26ms | 955/621 任务/分 | 0 | 同上（35 例同因） |

- **429 全程 0**：三档限流放大生效，且客户端 rpm 预算远低于服务端，说明瓶颈不在 API 限流。
- **关键瓶颈定位（乐观锁冲突）**：`executor.service.ts` 派发用条件 UPDATE（`runningTaskCount+1` 且 `version=:version` 且 `runningTaskCount < max`）防 TOCTOU。**单个 executor 承接突发并发时，同一版本行的多个并发派发仅一个成功，其余版本冲突 → 全部候选耗尽 → 抛 "No available executor (all at capacity or concurrency conflict)"**。`maxRetry=0`（压测隔离重复执行判定）下这类冲突直接 failed，不重试。
- **增益**：`MAX_CONCURRENT_TASKS` 10→40 使 100@25 档成功率 40%→65%（任务本来就秒级完成，冲突是主要损耗）；但**不降反升的失败数（60→35）说明仍受乐观锁串行化约束**——单执行器场景下这是固有调度语义，不是 executor 处理能力不足。生产缓解方向：多执行器 + 亲和分组摊薄版本行竞争；或业务任务显式 `maxRetry`（按 docs/DEVELOPMENT-PLAN 语义，冲突类错误应可重试而非一次终态失败）。
- **清理与重复执行**：所有档清理成功 100%、重复执行违规 0、轮询超时 0——工具链自身无引入性污染。

### 7.3 SSE 实测

- 修复前（QA-05 实跑抓出）：`--scenario sse`（16 连接/8 并发/hold 15s）**挂死**——`ApiClient.request` 非 stream 路径在 fetch resolve（仅响应头到达）后 finally 拆掉 abort 桥，`child.abort()` 传导不进 fetch 的 body reader，`read()` 永不返回。**修复**（commit 36645c5）：`request()` 增 `stream` 选项，SSE 调用保留桥至调用方读完 body；纯函数 selftest 26 组无回归。
- 修复后（本机）：4 连接/4 并发/hold 8s → **100% 保持至 hold 到期**（p50/p95 连接时长 8.00/8.01s，建连 12/15ms），主动关闭正常。
- **说明**：SSE 槽位默认 32/metrics（本栈放大 128）；500 连接目标仍需要真实多实例 + 反代调优 + 槽位放大共同验证（见 §5），本机单节点数据不构成 500 连接结论。

### 7.4 局限与后续

- **未跑 callback 场景**（需真实 execution + 有效 v1 token fixture，见 README §1.3）与 **SSE 大连接数档**（需先定反代/槽位参数）。
- 本机单节点：admin-api 与 executor 同机，资源水位互相影响，**不能外推生产容量**。
- 未采集 PG/BullMQ/CPU 系列水位到可复用报告（load-test 报告为客户端观测；服务端侧需对接 Prometheus/日志做 §2 要求的水位图）。
