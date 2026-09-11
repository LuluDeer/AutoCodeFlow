# load-test.mjs — AutoFlow 全栈压测工具

Node 原生（零第三方依赖，需 Node >= 18，使用内置 `fetch`）。它是一个**受控、可停止的场景驱动工具**，用于在已启动的全栈上观察调度链路、SSE 长连接和回调入口；它不把命令行中的并发数或 QA-05 目标数当作容量结论。

> **当前实测边界（第一阶段）**：本仓库当前只对脚本语法与纯函数 selftest 做本地验证；未在本次改动中启动 compose，也未完成 500 并发、1000 任务/分钟、SSE 500 连接或回调 10k/分钟的容量验收。以下目标全部是后续真机压测计划，不是已完成结果。

## 1. 当前支持的场景

### 1.1 `tasks`：创建、触发、轮询终态（默认）

流程为：

1. `POST /api/auth/login` 登录取 JWT；
2. `POST /api/tasks` 创建内联 glue 脚本任务；
3. `POST /api/tasks/:id/trigger` 创建 execution；
4. `GET /api/tasks/:id/executions?page=1&pageSize=50` 轮询至 `success/failed/timeout/killed/cancelled` 或单任务超时；
5. 默认软删除任务，或用 `--keep-tasks` 保留任务供复核。

当前 tasks 场景实际只发送 JavaScript glue（`--glue-language javascript`）；Python/shell 参数暂不受支持，避免文档承诺超出实现。`maxRetry=0` 用于隔离压测重复执行判定；stale-recovery/executor-restart 产生的合法 retry 派生行不会被当作重复违规。

```bash
node scripts/load-test.mjs \
  --scenario tasks --count 20 --concurrency 5 \
  --base-url http://localhost:3105

# 按时间派发；--count 与 --duration 同时给出时先到者停止派发
node scripts/load-test.mjs \
  --scenario tasks --duration 120 --concurrency 10
```

### 1.2 `sse`：受控 SSE 长连接

默认连接 `GET /api/metrics/stream`，使用登录 JWT，打开连接后保持 `--sse-hold` 秒，再由客户端主动中止。也可用 `--sse-path /api/executions/stream` 测事件流。该场景只验证建连、持续读取和主动关闭，不伪造事件数量，也不宣称突破服务端槽位上限。

```bash
node scripts/load-test.mjs \
  --scenario sse --count 32 --concurrency 32 \
  --sse-path /api/metrics/stream --sse-hold 30
```

注意：当前 admin-api 默认 SSE 槽位是进程内限制；`/metrics/stream` 默认全局 32，日志流全局默认 64（另有每 execution 限制），`/executions/stream` 复用 metrics 槽位。若要观察更高连接数，必须显式调整服务配置并记录实例数、代理和内存，不得仅凭客户端参数声称支持 500 连接。

### 1.3 `callback`：受控回调入口请求

该场景不会创建伪造 execution，也不会生成或猜测回调凭据。调用方必须提供一个真实存在 execution 对应的 token 和 UUID；工具在发送前校验 UUID v4 与 token 绑定关系。`v1.<executionId>.<expires>.<signature>` token 必须绑定同一 executionId；legacy/shared executor token 必须额外提供 `--callback-executor-address`，否则直接失败：

```bash
export LOAD_TEST_CALLBACK_TOKEN='v1....'  # 或 --callback-token
export LOAD_TEST_CALLBACK_EXECUTION_ID='xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
node scripts/load-test.mjs \
  --scenario callback --count 20 --concurrency 5 \
  --callback-batch-size 10 --callback-rate 40
```

每次请求发送 `1..100` 个相同 execution ID 的 `success|failed` 条目（`--callback-batch-size`），对齐 admin-api 单批上限 100；共享 executor token 还需 `--callback-executor-address`，per-execution `v1.` token 由 token 绑定 execution ID。重复回调可能被业务层按幂等语义接受，因此 callback 场景报告的是入口 HTTP 成功/失败和吞吐，不把重复提交误报为新的执行完成。

## 2. 选项与限速

| 选项 | 默认 | 说明 |
|------|------|------|
| `--scenario` | `tasks` | `tasks`、`sse`、`callback` |
| `--base-url` | `http://localhost:3105` | admin-api 地址（`LOAD_TEST_BASE_URL`） |
| `--username` / `--password` | `admin` / `Admin@123456` | 登录账号（`LOAD_TEST_USERNAME`/`LOAD_TEST_PASSWORD`） |
| `--concurrency` | `10` | 在途工作单元数，不等于服务端容量 |
| `--count` | `10` | 工作单元数；与 `--duration` 同时给出时先到者停止派发 |
| `--duration` | - | 按秒派发，时间到后不再创建新工作单元，但等待在途任务收尾 |
| `--max-rpm` | `55` | 所有压测请求的总预算/分钟（读写均受此约束） |
| `--write-rpm` | `40` | 压测写请求预算/分钟（`--create-rate` 为兼容别名） |
| `--callback-rate` | - | callback 写请求预算/分钟；缺省复用 `--write-rpm` |
| `--request-timeout` | `30` | 单个 HTTP 请求超时（秒） |
| `--poll-interval` | `1000` | tasks 轮询基础间隔（毫秒） |
| `--task-timeout` | `180` | tasks 单 execution 等待终态超时（秒） |
| `--sse-path` | `/api/metrics/stream` | SSE 端点；可改 `/api/executions/stream` |
| `--sse-hold` | `10` | SSE 每条连接保持时间（秒） |
| `--callback-token` | env | callback Bearer token；不在工具内生成 |
| `--callback-execution-id` | env | callback 真实 execution UUID v4，且必须与 `v1.` token 的绑定 ID 相同 |
| `--callback-status` | `success` | `success` 或 `failed` |
| `--callback-batch-size` | `1` | 每请求条目数，范围 `1..100` |
| `--callback-executor-address` | - | legacy/shared token 必填；v1 token 可省略 |
| `--keep-tasks` | 关 | tasks 结束后保留压测任务 |

限速器为客户端滑动窗口：`--max-rpm` 是所有压测请求的总预算，`--write-rpm` 是写请求子预算，一次写请求同时消耗两者；429 优先遵循 `Retry-After`，否则按 1s→2s→4s…30s 封顶退避。收到 `SIGINT`/`SIGTERM` 后停止派发、Abort 在途 HTTP/等待。tasks 清理使用独立并发 lane 和随任务数增长的 60 秒至 1 小时上限超时，不占用压测限速；清理失败进入统计并使结果为 FAILED。安全停止不等于所有已派发 execution 都已终态，需按报告与服务端记录复核。

## 3. 错误分类与报告指标

报告按 `auth`、`throttle`、`validation`、`not_found`、`conflict`、`server`、`timeout`、`network`、`cancelled`、`protocol`、`unknown` 分类，并保留最多 20 条错误样例。分类是客户端观测归一，不替代服务端日志、Prometheus、Postgres/Redis 指标。

- **工作单元/成功率**：tasks 按尝试的任务数统计；SSE 按连接；callback 按 HTTP 请求。创建或触发失败会进入错误分类，不会伪装成成功。
- **吞吐**：同时报告 attempted 吞吐和 completed 吞吐。completed 只计成功任务、保持到期的 SSE 连接或 HTTP 成功回调条目；失败请求绝不计入完成吞吐。两者均除以本次工具生命周期总耗时分钟，受客户端速率预算、轮询、清理和停止时间影响，不是服务端理论极限。
- **p50/p95**：tasks 为 trigger 后到观察到 execution 终态的 `duration`（缺失时用客户端观测时长）；SSE 为连接保持/结束时长，另报告建连 p50/p95；callback 目前不伪造服务端处理耗时，故仅报告入口吞吐和成功率。
- **429**：HTTP 429 次数（含重试触发次数），不是所有限流命中总量；服务端限流配置必须同时记录。
- **重复执行**：tasks 只把同一任务的多个非取消、非 retry-derived 终态行判为违规。
- **退出码**：参数/启动或登录失败为 `2`；场景失败、非零错误、重复执行、轮询超时、安全停止或清理失败为 `1`；tasks 全部成功且无违规并完成清理为 `0`。

## 4. 运行前置与安全边界

运行前必须明确以下条件，并把实际值写入压测记录：

1. **compose 全栈就绪**：至少 `docker compose up -d` 后 postgres、redis、admin-api、registry 健康；`GET /api/health` 或项目既有健康检查通过。只启动 admin-api 而没有 PG/Redis 不能作为容量数据。
2. **账号与权限**：管理员账号可登录，密码以 `.env` 的 `INITIAL_ADMIN_PASSWORD` 为准；优先使用环境变量传密，不把真实密码写入命令历史或日志。callback 场景另需真实 execution UUID 和有效 token。
3. **在线 executor**：tasks 需要至少一个 `ONLINE` executor，且 runtime/language 匹配；固定 `--executor` 时必须确认该 UUID 在线。没有 executor 的失败只能归为前置失败，不能解读为调度容量。
4. **限流与代理**：先记录 admin-api 的 `THROTTLE_LIMIT`、`LOGIN_THROTTLE_LIMIT`、OPS/callback 分域限流、SSE 槽位和 nginx/ingress 超时；客户端 `--max-rpm`/`--write-rpm`/`--callback-rate` 应低于服务端限制，除非实验明确是在测限流策略。
5. **观测面**：容量实验至少同时记录 admin-api 实例数/CPU/RSS、Node event loop、Postgres CPU/连接池/慢查询、Redis/BullMQ 队列深度、executor 在线数/`MAX_CONCURRENT_TASKS`、429/5xx、SSE 活跃槽位和回调认证/业务指标。缺任一关键水位时只能标注“工具运行结果”，不能下容量结论。
6. **隔离与清理**：使用独立压测命名空间/时间窗；tasks 默认软删除但 executions 留档，`--keep-tasks` 仅用于复核。中止或网络断开后检查残留任务、队列和执行器，避免下一轮污染。

## 5. 当前可测边界与后续目标

### 当前可测（工具能力，不代表已经实测）

| 场景 | 当前能做什么 | 当前限制 |
|---|---|---|
| tasks | 可配置 count/duration/concurrency、创建/触发/终态轮询、429 退避、重复执行判定、清理 | 只创建轻量 glue 任务；默认客户端限速远低于大规模入队目标；不采集服务端资源水位 |
| SSE | 受控保持并主动关闭 `/metrics/stream` 或 `/executions/stream`，统计建连/连接结果 | 受服务端进程内槽位、代理超时和实例拓扑约束；不制造 500 条连接的验收结论 |
| callback | 使用调用方真实 token/UUID，以 1..100 条/请求施压回调入口 | 不生成 token/执行记录；重复同一 execution 主要用于入口/幂等观测，不等同 10k 个真实执行回调 |

### 后续 QA-05/BUG-19 目标（未实测、未验收）

以下数字来自 `docs/DEVELOPMENT-PLAN-2026-09H2.md` §7 QA-05，仅作为实验设计目标：

- 单实例 **500 并发执行**：需逐级递增并发，确认 executor `MAX_CONCURRENT_TASKS`、BullMQ、PG 连接池和 admin-api CPU/RSS 水位；脚本并发参数不是容量承诺。
- **1000 任务/分钟入队**：需用专门入队节奏与足够高但可解释的服务端限流，区分 API 限流瓶颈与队列/数据库瓶颈。
- **SSE 500 连接**：需先调整/验证 `METRICS_STREAM_MAX_GLOBAL`、日志/SSE 槽位、反向代理和多实例粘性/共享状态；当前默认槽位不足以支持该目标。
- **回调风暴 10k/分钟**：需使用受控、可回放的真实 execution fixture/token 批次，按 100 条上限分批，观测 `55mb` body 上限、callback 限流、DB 更新和幂等；当前 callback 场景只接受调用方提供凭据。
- **容量白皮书与瓶颈定位**：需每一档至少重复运行并保存环境、配置、成功率、p50/p95、吞吐、429/5xx、PG/Redis/BullMQ/executor 水位和停止/清理记录；在此之前 BUG-19/QA-05 的容量验收保持未完成。

## 6. 自检与验证状态

```bash
node --check scripts/load-test.mjs
node scripts/load-test.selftest.mjs
```

本次阶段收口已验证脚本语法和纯函数自检；HTTP 场景需要按上述前置在运行栈执行。自检覆盖百分位边界、终态/重复判定、退避、错误分类、envelope 解包、场景参数边界和 callback 批量上限。
