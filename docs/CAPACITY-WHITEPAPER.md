# AutoCodeFlow 容量白皮书（QA-05 / BUG-19）

> 数据来源：2026-09-12 本机真机压测（脚本化、可复现）。**所有数字都带参数与限定**，
> 原始记录见 `docs/QA-05-capacity-boundaries.md`（§8 四档实测 + §8.2.2 服务端水位）。
> 本文件面向部署者：**怎么估容量、哪里会先顶、顶了调什么**。

## 1. 一句话结论

单实例 admin-api（1 vCPU 量级、PG16 + Redis7 同机）在 glue 轻任务形态下：

- **500 并发在途执行**：100% 成功，p50/p95 = 21/26 ms，429 = 0；
- **1321 任务/分钟完成吞吐**（超 1000 任务/分钟目标 32%）；
- **500 条并发 SSE 长流**（直连与经 nginx 反代两种形态均 100% 建立并保持）；
- **73189 条/分钟回调摄入**（超 10k 目标 7.3×，含 1000 个真实终态推进）。

而服务端水位显示：**CPU 仅 7%（单核）、事件循环延迟峰值 4.9 ms、BullMQ 深度 0，
但 DB 连接池 waiting 峰值 280（池上限 `DB_POOL_SIZE`=20）**。

> **结论：瓶颈是数据库连接池排队，不是 CPU/内存/事件循环。**
> 扩容优先调 `DB_POOL_SIZE`（与 PG `max_connections` 联动）或加实例；单纯加 CPU 无用。
> 注意本结论建立在 glue 轻任务（~20 ms）上——**真实业务任务的时长决定了另一个维度
> （执行器槽位占用时间）**，见 §5 公式。

## 2. 验证口径（先看这里，避免误读）

| 项 | 值 |
|---|---|
| 拓扑 | 单机：PG16 容器 + Redis7 容器 + 1× admin-api + 1× executor-node（反代档另加真实 nginx 容器） |
| 任务形态 | glue 轻任务，`maxRetry=0`，`runtime=shell`，端到端 ~20 ms |
| 服务端限流 | 显式放大到压测量级（`THROTTLE_*`），使测到的是容量而非分域限流 |
| 客户端预算 | `--max-rpm/--write-rpm` 默认压低；提吞吐档必须一并放宽，否则测的是客户端（见 §3 口径注） |
| 未覆盖 | 24h 长稳（BUG-19 未终结）、多主机网络拓扑、真实业务时长分布、PG 磁盘/慢查询、>1000 长连接的 nginx `worker_connections` 调优 |

## 3. 四档目标实测结果

| # | 目标档 | 参数 | 结果 |
|---|---|---|---|
| 1 | 单实例 500 并发执行 | `--count 500 --concurrency 500`，`LT_MAX_CONCURRENT=600` | **500/500（100%）**，p50/p95 21/26 ms，429=0 |
| 2 | 1000 任务/分钟入队 | `--count 2000 --concurrency 300`，`MAX_RPM=24000 / WRITE_RPM=2200` | **2000/2000（100%）**，完成吞吐 **1321 任务/分钟** |
| 3 | SSE 500 连接 | `--scenario sse --count 500 --concurrency 500 --sse-hold 30`，`LT_SSE_MAX_GLOBAL=700` | **500/500（100%）**，hold 30 s 全到期 |
| 3b | **SSE 500 连接经 nginx** | `NGINX_SSE_CONNS=500 npm run test:nginx-sse` | **500/500 建连（1.04 s）**、hold 35 s 后 500/500 存活且有帧、RSS +14 MB |
| 4 | 回调 10k/分钟 | `npm run test:qa05-callback-tier`（1000 真实 RUNNING 执行池，100×100 条批量） | **73189 条/分钟**，批次 100/100 HTTP 成功，DB 核对 1000 条终态 |

**口径注（必须随数字引用）**：load-test 的吞吐是**客户端观测**且受 `--max-rpm/--write-rpm`
预算约束——第 1 档 182 s（≈165 任务/分）是被默认 600/400 预算卡住，不是服务端上限；
放宽预算后同一档升到 1321/分钟，全程 0 错误 0 限流。

## 4. 服务端水位与瓶颈判定

500 并发档（100% 成功 / p95 26 ms）：

| 指标 | 峰值 | 读法 |
|---|---|---|
| RSS / 堆占用 | 394 MB / 226 MB | 内存充裕 |
| CPU（单核百分比） | **7.03%** | CPU 远未饱和 |
| PG 连接 / Redis 连接 | 21 / 9 | 与池上限一致 |
| **DB 池 active / idle / waiting** | 20 / 20 / **280** | **瓶颈**：池上限 20，280 个请求排队 |
| 事件循环延迟 | 4.9 ms | 健康（<50 ms） |
| BullMQ 队列深度 | 0 | 入队速度未超过消费速度 |
| 调度 tick 时长 | 11.0 ms | 健康 |

> 判定方法：CPU/事件循环/队列深度都低位而 waiting 高位 ⇒ 队列化的资源是 DB 连接。
> 这类瓶颈**横向扩容同样有效**（每个实例有自己的池），但单实例上调 `DB_POOL_SIZE`
> 是更便宜的第一步——前提是 PG `max_connections` 留得下
> （建议 `max_connections ≥ 实例数 × DB_POOL_SIZE × 1.3`，并观察 `pg_stat_activity`）。

## 5. 容量规划（估算公式）

```
并发在途执行上限 ≈ Σ(所有在线执行器 MAX_CONCURRENT_TASKS)        ← 派发侧硬上限
任务完成吞吐上限 ≈ 并发在途上限 / 平均任务时长 × 60               ← 时长决定吞吐
admin-api 可服务并发 ≈ 实例数 × min(DB_POOL_SIZE, PG 剩余连接)     ← DB 是实际闸门
                                         × (1 / 每请求查询次数)
SSE 连接上限     ≈ 实例数 × METRICS_STREAM_MAX_GLOBAL             ← 每实例独立计数
                   与   反代 worker_connections / 2（客户端+上游）
回调条目上限/分  ≈ 源 IP 数 × THROTTLE_CALLBACK_LIMIT × 每请求条数(≤100)
```

三个必须一起看的例子：

1. **要 1000 任务/分钟、平均任务 30 s** ⇒ 需要并发在途 ≈ 500 ⇒
   执行器槽位总数 ≥ 500 × 1.3（余量）≈ 650；admin-api 侧 `DB_POOL_SIZE` ≥
   并发查询数（经验值：并发数 / 10 起步，再按 waiting 调）。
2. **100 台执行器同一出口 IP（NAT）**：回调速率叠加 ⇒
   `THROTTLE_CALLBACK_LIMIT ≥ 台数 × 各自批次数/分钟 × 安全系数`
   （默认 60 是**按 IP** 计的，容易触顶；见 §6）。
3. **Dashboard 300 个页面同时订阅指标流** ⇒ `METRICS_STREAM_MAX_GLOBAL`
   需 ≥ 300/实例数，且反代 `worker_connections` ≥ 2 × 单实例总连接。

## 6. 调参清单（按影响排序）

| 变量 | 默认 | 何时调 | 影响 |
|---|---|---|---|
| `DB_POOL_SIZE` | 20 | DB 池 `waiting` 长期 > 0 | 单实例 DB 并发；与 PG `max_connections` 联动 |
| `MAX_CONCURRENT_TASKS`（执行器） | 10 | 派发出现 `at capacity` | 执行器在途上限；按峰值 ×1.3 |
| `THROTTLE_CALLBACK_LIMIT` | 60 /分钟/**IP** | 多执行器同出口 IP | 回调摄入；单 IP 条目上限 = limit × 100 |
| `METRICS_STREAM_MAX_GLOBAL` | 32 | Dashboard 并发订阅多 | 每实例 SSE 全局槽位（超限 503） |
| nginx `worker_connections` | 1024（镜像默认） | >1000 长连接 | <2×连接数即开始拒连（表现为连不上，非应用报错） |
| `THROTTLE_OPS_LIMIT` | 30 /分钟 | 批量运维脚本 | 干预写面（trigger/deploy/rollback）节奏 |
| `EXECUTOR_HEARTBEAT_*` | 见 `.env.example` | 大规模执行器 | 心跳频率↑ ⇒ 回调面压力↑（与上一行联动） |
| `EVENT_OUTBOX_ENABLED` | true | 出站 webhook 一致性 | 关闭=重启丢在途（不推荐） |

## 7. 横向扩容与多实例

- admin-api **无会话粘性**：JWT 自包含，任意实例可服务任意请求；
- 但存在**进程内状态**，多实例一致性由 **ARCH-31 收口**（详见
  `docs/ARCH-MULTI-INSTANCE-MATRIX.md`，其验证清单 5/5 已真机通过）：
  通知静默（读穿刷新，收敛 ≤15 s）、渠道配置（独立表 + 读穿）、灰度批次
  （DB hydration + claim + 租约）、调度 Leader 单点、outbox 行级 claim；
- **SSE 槽位是每实例计数**：总容量 = 实例数 × 上限；某实例满时返回 503，
  客户端应重连（换实例）而非认为服务不可用；
- 回调/心跳按**目标 IP** 限流：多实例部署时注意反代是否把同源请求固定到同一实例。

## 8. 监控与告警（建议阈值）

| 指标 | 建议阈值 | 含义 |
|---|---|---|
| `autoflow_db_pool_waiting_requests` | > 0 持续 1 分钟 | 池排队——提 `DB_POOL_SIZE` 或加实例 |
| `nodejs_eventloop_lag_seconds` | p95 > 0.05 s | 事件循环被阻塞（大 JSON/同步 CPU） |
| `autoflow_queue_depth` | 持续增长 | 消费侧跟不上（执行器不足） |
| `autoflow_sse_streams_rejected_total` | 增长 | 槽位满（调 `METRICS_STREAM_MAX_GLOBAL`） |
| outbox 未投递行数（`dispatchedAt IS NULL`） | 持续增长 | 接收端不可达或积压 |
| 执行器 `runningTaskCount / maxConcurrentTasks` | 长期 > 0.8 | 需要更多执行器 |

## 9. 复现与回归

```bash
# 四档容量（每档 2-5 分钟；脚本自带服务端水位采样，结束打印峰值）
LT_MAX_CONCURRENT=600 bash scripts/load-test-stack.sh --scenario tasks --count 500 --concurrency 500
LT_MAX_CONCURRENT=600 LOAD_TEST_MAX_RPM=24000 LOAD_TEST_WRITE_RPM=2200 \
  bash scripts/load-test-stack.sh --scenario tasks --count 2000 --concurrency 300
LT_SSE_MAX_GLOBAL=700 bash scripts/load-test-stack.sh --scenario sse --count 500 --concurrency 500 --sse-hold 30
npm run test:qa05-callback-tier          # 回调 10k 档（真实 execution 池）

# 反代长流（含 500 并发档；24h 门禁用 NGINX_SOAK_SECONDS=86400）
NGINX_SSE_CONNS=500 npm run test:nginx-sse

# 多实例一致性（真机双实例 + 两个真实执行器）
npm run test:arch31-multi-instance && npm run test:arch31-rollout && npm run test:arch31-outbox
```

## 10. 尚未验证（部署前按需补）

1. **24h 长稳**（BUG-19 未终结）：`NGINX_SOAK_SECONDS=86400 npm run test:nginx-sse`，
   目标环境跑一次，观察 RSS/PG 连接/句柄是否单调增长；
2. **多主机网络拓扑**：本白皮书全部数据为单机多进程；跨主机还需补网络延迟、
   PG 远程连接、反代到多实例的路由分布；
3. **真实业务时长分布**：glue ~20 ms 是吞吐上界形态；长任务下瓶颈会移到
   「执行器槽位 × 时长」（§5 公式）；
4. **>1000 长连接**：需显式调 nginx `worker_connections`/`worker_processes` 后复测；
5. **PG 侧**：慢查询、磁盘 IO、`max_connections` 与池联动的实测。
