# ADR-015: 执行器 pull 模式派发（NAT 回连）

- 状态：Accepted（ARCH-32）
- 日期：2026-09-13
- 关联：DEP-HA-1（多副本部署配方）、ARCH-31（多实例一致性）、ADR-012（执行器令牌存储）

## 背景

任务派发当前是**纯 push**：调度侧（task.processor → ExecutorService.dispatch）选出执行器后，主动向执行器注册的 `address` 发起 HTTP POST（`api/execute`）。执行器因此**必须接受来自中心端的入站连接**。

真实部署中执行器经常位于办公网/厂区网/家庭网的多层 NAT 之后（无公网 IP、不可端口映射）——中心端不可达，push 派发必然失败。用户确认该场景存在（2026-09-13）。

执行器侧既有流量（心跳、回调、artifact 下载、注册）全部是**出站**连接；push 派发是唯一要求入站可达的环节。

## 裁定

**新增 pull 派发模式（长轮询拉取），与 push 并存，按执行器逐台选择**：

1. 执行器以 `EXECUTOR_PULL_MODE=true` 启动并在 register 上报 `dispatchMode: "pull"`（迁移 1790000000019 新列，默认 `push`，存量零影响）。
2. 调度侧**全部既有选择语义不变**——pinning、appName、group/tags、亲和/反亲和、runtime 过滤、CORE-05 loadScore 评分、原子占坑 UPDATE 原样保留。仅传输层分支：占坑成功后，把派发载荷 `{executionId, task, params, traceparent, pushedAt}` LPUSH 到 Redis 队列 `acf:pull:{executorId}`（替代 axios POST）。
3. 执行器空闲时（有可用并发槽位）向中心端 `POST /executors/pull` 发起**长轮询**（服务端 waitMs 钳位默认 25s，内部 500ms 间隔 LPOP），取到载荷即执行，后续回调走既有出站通道，零变化。
4. 过期与兜底：载荷带 `pushedAt`，拉取时超过 `EXECUTOR_PULL_TTL_MS`（默认 15min）即丢弃并 warn；执行器长时间不拉取的 RUNNING 行由**既有 stale sweep** 收敛（失败→重试预算），不新增后台任务。
5. 广播模式（executeMode=broadcast）逐执行器同样入队；pinning 语义不变（pin 到 pull 执行器 = 入队该执行器）。

## 备选与否定理由

- **WebSocket 反向隧道**（执行器出站建立长连接，中心端经连接下发派发）：实时性最好，但与 DEP-HA-1 多副本轮询负载均衡**直接冲突**——连接粘在单个 admin-api 实例上，而派发发生在任意实例，需要「执行器→实例」注册表（Redis pub/sub 转发）或 nginx sticky（与已落地的 resolver 轮询形态打架），引入一整层分布式状态。长轮询每个请求独立，任意副本都能从共享 Redis 取到载荷，天然多实例安全。**拒绝（复杂度不匹配当前收益）**。
- **全局任务池自由认领**（执行器从公共池抢任务）：改变调度语义——loadScore 择优、pinning、broadcast、亲和标签都建立在「中心端选执行器」之上，池化认领等于重写调度层。**拒绝**。
- **SSH 反向隧道 / frp 类网络层方案**：要求执行器侧额外组件与运维，且绕过了平台自身的鉴权/审计面。**拒绝**。

## 语义边界（如实声明）

- pull 执行器占坑成功即 RUNNING（与 push「POST 被接受」同刻度）——执行器长时间不拉取时，行短暂呈现 RUNNING 但实际在队列中，由 stale sweep 兜底收敛；不为此新增 PENDING 子状态。
- `notifyExecutorKill`（admin→执行器的 best-effort 终止通知）对 NAT 内执行器天然不可达——该路径本就 fail-open（warn 不抛出）；执行器自身硬超时仍在，是真正的超时防线。
- pull 端点鉴权与 heartbeat 同源（per-executor/shared token，validateTokenByAddress），限流沿用机器回调面的宽松档（60/min/IP）——长轮询把空闲请求率压到 ~2.4/min/执行器，配额充裕。
- 多实例安全：队列在 Redis（ARCH-31 已共享），任意 admin-api 副本的拉取循环等价。

## 影响

- 存量部署零行为变化（默认 push；不设 EXECUTOR_PULL_MODE 的执行器不受任何影响）。
- NAT 内执行器从此可入网：只要它出站能访问中心端（心跳已要求），即可接收任务。
- 新配置：服务端 `EXECUTOR_PULL_WAIT_MS` / `EXECUTOR_PULL_TTL_MS`；执行器端 `EXECUTOR_PULL_MODE`。
