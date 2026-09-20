# ADR-016: 执行器控制面 pull 通道（NAT 内执行器的入站推送替代）

- 状态：Accepted（ARCH-33）
- 日期：2026-09-19
- 关联：ADR-015（执行器 pull 模式派发）、ARCH-32（pull 派发落地）、UI-18（入站推送面 UI 门控）、ARCH-31（多实例一致性）、ADR-012（执行器令牌存储）

## 背景：故障现场

生产部署为**公网中台 + 公司内网执行器**拓扑：

- 中台 `154.217.234.30`（公网 VPS，`https://redirct.yskj.cc.cd`）；
- 执行器 `192.168.4.54:8003`、`192.168.3.132:8002`（公司局域网，无公网映射）。

实测证据（2026-09-19）：

| 方向 | 结果 |
|---|---|
| 执行器 → 中台（`ADMIN_API_URL=https://redirct.yskj.cc.cd`） | 通。注册/心跳/回调全正常，`status=online`，心跳滞后 20–32s |
| 中台 → 执行器（`curl http://192.168.4.54:8003/api/health/live`） | **`http_code=000`，5s 超时** |
| `ip route get 192.168.4.54` | `via 154.217.234.1 dev ens17` —— 被丢给公网默认网关，中台无 192.168.x 内网路由 |

直接后果，落库可查：

```
app_deployments a57fa61f-9dab-420a-b1e6-3ebee684963c
  status          = failed
  statusMessage   = Failed to reach executor after 3 attempts: timeout of 30000ms exceeded
  executorAddress = 192.168.4.54:8003
```

**这不是配置笔误或应用缺陷，是网络拓扑不可达。** 部署服务本身逻辑正确（3 次重试退避 1s/2s、30s 超时、SSRF 校验后固定 IP），全部按设计执行了，只是对端无法抵达。

## 问题：pull 旁路只覆盖了任务派发

ARCH-32 / ADR-015 给执行器加了 pull 模式，但**只覆盖 `api/execute` 一条路径**。所有「中台主动拨入执行器」的控制面调用仍是纯 push 硬编码，共用 `getExecutorUrl(address, ...)` 出口：

| 调用点 | 位置 |
|---|---|
| 应用部署 `api/deploy` | `app-deployment.service.ts:1290` |
| 停止 `api/app-stop` | `application.service.ts:536`、`app-deployment.service.ts:1094` |
| 卸载 `api/app-uninstall` | `application.service.ts:557` |
| 配置热更新 `api/config/reload` | `executor.controller.ts:950` |
| kill 通知 `api/executions/:id/kill` | `executor.service.ts:597` |
| 包推送 `api/update-package` | `executor-package.service.ts:512` |
| 日志回填 `GET api/logs/:id` | `task.service.ts:2458`（**读**方向，本 ADR 不覆盖，见「语义边界」） |

`dispatchMode` 在整个 application / 部署模块里**零引用**——部署链路是纯 push 硬编码。UI-18 已把「入站推送面」在 UI 上做了门控（批量 reload-config 剔除 pull 执行器），说明团队清楚 push 对 NAT 执行器不通，但**部署这条路没被纳入**。

## 裁定

**把 pull 通道从「任务派发专用」提升为「执行器传输层」，控制面命令经同一长轮询下发。**

### 1. 命令队列与任务队列分离

新增 Redis List `acf:cmd:{executorId}`（命令），与既有 `acf:pull:{executorId}`（任务）**物理分离**。理由：

- **零回归风险**：任务队列的入队/出队/TTL/单飞语义逐字节不变，pull 派发这条已验收的链路不被触碰；
- **TTL 语义不同**：任务载荷超 `EXECUTOR_PULL_TTL_MS`（15min）丢弃是对的（执行行有 stale sweep 兜底）；控制命令超时丢弃会**静默丢操作**，必须用更长的 TTL + 结果上报兜底；
- **批量语义**：`uninstallAppOnExecutor` 一次要发 stop×N + uninstall×1，同批下发才能保证顺序与原子性。

### 2. 传输选择收敛到单一出口

`ExecutorService` 新增：

```ts
resolveExecutorTransport({ executorId?, address }): Promise<{ mode: 'push' | 'pull'; executor?: Executor }>
enqueueExecutorCommand(executor, type, payload): Promise<string /* commandId */>
```

判定顺序（**任一不满足即回退 push**）：

1. 能按 `executorId`（优先）或 `address` 定位到执行器行；
2. `executor.dispatchMode === 'pull'`；
3. `executor.protocolVersion >= 2`（见下「协议版本」）。

第 3 条是**正确性必需**而非防御：旧 pull 执行器（协议 v1）会忽略 `commands` 字段，中台却以为已投递——静默丢操作。定位不到行时回退 push，保持存量行为。

### 3. 协议版本 1 → 2

`packages/executor-protocol/protocol.json` 的 `versioning` 段规定：「新增**可选**字段且旧端可忽略时：仍需 bump protocolVersion（让中台知道该执行器不认识新字段，避免向它发送新语义字段）」。

本次新增 pull 响应的可选 `commands` 数组与结果上报端点，正是该条款描述的情形：

- `currentProtocolVersion`: 1 → **2**；
- `supportedMinProtocolVersion`: **保持 1**（旧执行器照常注册，只是收不到控制命令——兼容性红线：不得因缺新字段被剔除）；
- 执行器侧 `PROTOCOL_VERSION` 1 → 2（node `config.ts` / python `config.py`）；
- 中台侧 `PROTOCOL_SUPPORTED_MIN` 保持 1，另设 `PROTOCOL_CONTROL_PLANE_MIN = 2` 作为命令下发的门禁。

### 4. 执行器侧：显式命令类型 + 本地回环

执行器收到命令后，**回环 POST 到自己的既有本地路由**（`http://127.0.0.1:{port}/api/...`，Bearer 用本执行器令牌）。这是 E-1 配置热更新已验证的先例（`pull.ts:122` / `scheduler.py:365`）——apply 逻辑单一事实源，零漂移。

命令类型是**封闭枚举**，路径由执行器按类型构造，**不接受中台下发的自由路径**：

| `type` | 本地路由 | 载荷 |
|---|---|---|
| `deploy` | `POST /api/deploy` | 部署载荷（同 push 路径逐字段） |
| `app-stop` | `POST /api/app-stop` | `{deploymentId}` |
| `app-uninstall` | `POST /api/app-uninstall` | `{appId}` |
| `config-reload` | `POST /api/config/reload` | 配置载荷 |
| `kill-execution` | `POST /api/executions/{id}/kill` | `{executionId}`（路径段由执行器编码） |
| `update-package` | `POST /api/update-package` | 包推送载荷 |

未知类型**拒绝并上报**，不静默丢弃。

> 安全边界说明：这**不扩大**信任面。中台今日就能对 push 执行器发同样的入站 POST，也能给任何 pull 执行器下发含任意脚本的 glue 任务（等价于任意代码执行）。执行器本就完全信任中台。封闭枚举 + 本地回环的意义是**限制误配与内部错误的影响半径**，不是新增授权。

### 5. 容量饱和时仍须取命令

现有 pull 循环只在有空闲槽位时才长轮询（`getRunningCount() < maxConcurrentTasks`，E-01 预留槽位方案）。若沿用，**执行器满载时控制命令永远送不到**——部署、停止、热更新全部静默失效。

修正：pull 请求体新增可选 `freeSlots`。执行器**始终**长轮询：

- `freeSlots > 0`：预留槽位 + 正常取任务（E-01 语义不变）；
- `freeSlots <= 0`：**不**预留、**不**取任务，但仍长轮询等待命令（服务端返回 `task: null` + `commands`）。

服务端在 `freeSlots <= 0` 时跳过任务出队（不消耗队列），命令照常下发。

### 6. 结果上报（可选通道，best-effort）

命令执行后执行器出站上报 `POST /api/executors/command-result`（per-executor 令牌，与心跳同向同源）：

```json
{ "commandId": "...", "address": "...", "type": "deploy",
  "ok": true, "status": 200, "error": null, "durationMs": 1234 }
```

中台记日志 + 写 Redis `acf:cmdres:{commandId}`（TTL 10min，供排障与后续 UI 消费）。上报失败**不影响**命令执行结果。

**这不是唯一的收敛路径**：`deploy` 的终态仍由既有 `/api/app-deployments/heartbeat` 收敛，`update-package` 仍由既有 `/api/executor-packages/push-result` 收敛。结果上报覆盖的是这两条之外没有回执通道的命令（`config-reload` / `app-stop` / `app-uninstall` / `kill-execution`）。

## 语义边界（如实声明）

- **投递语义从「同步」变为「异步」**。push 时调用点能拿到执行器的 HTTP 响应体；pull 时只能拿到「已入队」。
  - `deploy`：**零语义损失**——行本就在 `pushDeployToExecutor` 里进入 `DEPLOYING`，终态由心跳收敛，与 push 路径同刻度。
  - `stop` / `uninstall` / `kill`：**零语义损失**——这三条本就是 best-effort（失败只 warn，不改变调用方结果）。
  - `config-reload`：**有损失**——UI 从「已应用」变为「已下发」。返回体显式带 `queued: true` + `commandId`，前端文案据此区分，不谎报成功。
  - `update-package`：**有损失**——逐台结果从同步返回变为 `queued: true`；终态仍由既有 push-result 回调收敛。
- **executor-python 不支持 4 类命令**。`/api/deploy`、`/api/app-stop`、`/api/app-uninstall`、`/api/update-package` 是 **executor-node 独有**路由（`protocol.json` 的 `executorNodeOnly` 段已登记，python 无对应 router）。对 python 执行器下发这些命令会得到本地 404，执行器上报 `unsupported`。**这是既有能力缺口，不是本 ADR 引入的回归**——今日对 python 执行器 push `/api/deploy` 同样是 404。
- **`GET api/logs/:id` 日志回填不在本 ADR 范围**。它是**读**方向（中台取执行器日志），pull 通道是单向下发，无法承载响应体。NAT 执行器的日志回填仍不可用；执行器终态回调已带日志尾部，属既有降级路径。
- **多实例安全**：命令队列在共享 Redis（ARCH-31），任意 admin-api 副本入队、任意副本应答长轮询，无实例亲和。
- **命令 TTL**：`EXECUTOR_CMD_TTL_MS`（默认 30min）——长于任务载荷（15min），因为静默丢控制命令比丢任务更严重（丢任务有 stale sweep，丢命令没有任何兜底）。超 TTL 丢弃并 warn。

## 备选与否定理由

- **复用任务队列 + `kind` 判别字段**：改动小，但会污染已验收的 pull 派发链路（FIFO 顺序、TTL 语义、单条出队语义都要改），且无法批量下发 stop+uninstall。**拒绝**。
- **WebSocket 反向隧道**：与 ADR-015 同因否决——连接粘在单实例上与 DEP-HA-1 多副本轮询冲突，需引入实例注册表或 sticky。**拒绝**。
- **中台侧建反向代理 / frp / SSH -R 隧道**：ADR-015 已否决（要求执行器侧额外组件与运维，且绕过平台自身鉴权/审计面）。本次故障是同一拓扑的第二次印证，维持原判——**根治必须在应用层，不在网络层**。
- **执行器定时拉取全量「待办命令」REST 端点（无长轮询）**：实现更简单，但命令下发的时延从 ≤500ms 退化到轮询周期（秒级到分钟级），且新增一条轮询流量。既有长轮询通道已经建立，扩展它更经济。**拒绝**。
- **中台把执行器注册地址改写成其出站源 IP（NAT 穿透猜测）**：执行器出站经 NAT 后源 IP 是中台看到的地址，但那是 NAT 设备地址且端口不固定，回连必然失败。**拒绝**。

## 影响

- 存量部署**零行为变化**：默认 push；不设 `EXECUTOR_PULL_MODE` 的执行器不受任何影响；协议 v1 的 pull 执行器回退 push（行为与今日一致）。
- NAT 内执行器从此可接收**全部控制面命令**，不再只有任务派发。
- 新配置：服务端 `EXECUTOR_CMD_TTL_MS`（默认 1800000）；执行器端无新配置（复用 `EXECUTOR_PULL_MODE`）。
- 升级顺序**无约束**：中台先升级 → 旧执行器回退 push（行为不变）；执行器先升级 → 上报协议 v2，中台未升级时忽略该字段（行为不变）。两侧都升级后才启用命令通道。
