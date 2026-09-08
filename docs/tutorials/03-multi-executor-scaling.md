# 教程 03 · 多执行器扩容

> 目标：把执行器从 1 台扩到 2 台，理解平台如何分派任务、如何在应用发布时
> 用灰度策略保护生产。
> 前提：已完成[教程 02](./02-private-registry-deps)；你有 ADMIN 角色账号。

## 0. 平台如何挑执行器

一个任务触发后，调度侧的选择逻辑（默认路径）：

1. **过滤**：runtime 匹配（node 任务 → node 执行器）、在线状态、
   tags/group 路由；
2. **评分**（CORE-05 负载感知）：
   `loadScore = 0.5×负载 + 0.25×CPU + 0.25×内存 + 0.1×长任务惩罚`
   （长任务惩罚来自任务 `estimatedDurationSec` 预估时长；未知按 600s
   缺省）。分最低者胜出——长任务会被倾向派给更空闲的执行器；
3. **例外**：任务配了 `executorId`（pinning）则只派给该执行器；
   `executeMode=broadcast` 则广播到所有匹配执行器。

并发上限由执行器的 `maxConcurrentTasks` 决定（心跳可热更新，1..10000）。

## 1. 注册第二台执行器

生产推荐用一键安装命令（ADMIN-only），有两种入口：

**入口 A：执行器列表页 → 「安装向导」**（`/executors/install`），按向导
填目标服务器信息后复制生成的命令。

**入口 B：API 直接拿命令**：

```bash
# ADMIN 登录后
curl -H "Authorization: Bearer <JWT>" \
  http://<admin>:3105/api/executors/install-cmd
```

返回形如（`cmd` 即安装命令，`secret` 为执行器共享 token）：

```json
{
  "cmd": "curl -fsSL 'http://<admin>:3105/api/executors/install.sh' | bash -s -- --api-url 'http://<admin>:3105' --secret '<EXECUTOR_SECRET>'",
  "token": "<EXECUTOR_SECRET>",
  "adminApiUrl": "http://<admin>:3105"
}
```

到**第二台机器**（Linux，需 systemd 与 Node 24）上执行该命令，可追加参数：

```bash
curl -fsSL 'http://<admin>:3105/api/executors/install.sh' \
  | bash -s -- \
      --api-url 'http://<admin>:3105' \
      --secret '<EXECUTOR_SECRET>' \
      --runtime node \
      --name executor-node-2
```

| 参数 | 说明 |
|------|------|
| `--runtime` | `node` / `python` / `universal` |
| `--name` | 注册名（缺省 `executor-node-<hostname>`） |
| `--port` / `--work-dir` / `--install-dir` | 端口（默认 8002）/任务目录/安装目录 |

脚本细节（下载 artifact 失败回退本地复制、Windows 不支持等）见
[部署指南·执行器安装](../deployment.md)。

**预期结果**：「执行器」页出现新行，状态约 10 秒内变**在线**；
`GET /api/executors` 返回两台。

> 仅想在本机再起一个执行器做实验？直接在 `docker-compose.yml` 复制
> `executor-node` 服务改个名字/端口即可，环境变量同源。

## 2. 验证负载分派

1. 保持执行器 1 的 `maxConcurrentTasks` 较小（执行器详情页可改，或执行器
   侧心跳上报），比如 2；
2. 建一个跑 60 秒的脚本任务（如 `await new Promise(r => setTimeout(r, 60000))`），
   触发 3-4 次；
3. 观察：前 2 次落在执行器 1，第 3 次起落到执行器 2——
   「执行器」页的 `runningTaskCount` / CPU / 内存列实时反映两台的负载。

进阶：给长任务填 `estimatedDurationSec`（如 3600），再混布一个 1 秒任务，
观察长任务是否被派给更空闲的一台（CORE-05 的长任务惩罚生效）。

## 3. 灰度发布应用（DEP-02）

多台执行器的真正价值在**应用部署**：发布新版本时不必一次性全量推送。

平台语义：`POST /api/applications/:id/upgrade-all` 对该应用所有 RUNNING
部署触发升级，请求体可选 `rollout` 灰度策略（**缺省不传 = `all` 全量**，
既有语义不变）：

```json
{ "rollout": { "strategy": "canary", "percentage": 34 } }
```

| 字段 | 取值 | 缺省 | 说明 |
|------|------|------|------|
| `rollout.strategy` | `canary` \| `all` | `all` | canary=分批灰度 |
| `rollout.percentage` | int 1-100 | 50 | 首批台数 = `ceil(N × percentage%)`，至少 1 台、至多 N |

**canary 状态机**：首批心跳确认（宽限窗 120 秒）→ 健康探测（manifest 配了
healthCheck 时逐台探测）→ 任一台通过即提升其余台；首批失败 → 自动回滚已
触发升级的部署（重新部署上一版本）。**注意**：灰度批次是 admin-api 进程内
状态，服务重启即暂停（遗留批次标 failed，需人工重发）；批次硬超时 15 分钟。

操作路径（管理台）：「应用部署」页选择应用 → 「全部升级」时可选灰度策略；
或 API：

```bash
curl -X POST -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"rollout":{"strategy":"canary","percentage":50}}' \
  http://<admin>:3105/api/applications/<appId>/upgrade-all
```

响应额外携带 `rollout: { batchId, strategy, canaryIds, promotedIds }`。

## 4. 容量与隔离的进阶手段

| 手段 | 配置位置 | 效果 |
|------|---------|------|
| 任务 pinning | 任务表单 `executorId` | 指定任务只跑某台（绕过 tags/runtime 过滤） |
| 广播执行 | 任务 `executeMode=broadcast` | 所有匹配执行器各跑一份（与 pinning 互斥） |
| tags/group 路由 | 执行器 `tags`（`PATCH /executors/:id`） | 任务按标签路由到特定执行器池 |
| 并发热更新 | 执行器心跳 `maxConcurrentTasks` | 不重启调整单台容量 |

## 5. 下一步

多台执行器跑起来后，故障面也随之变大——谁在半夜发现执行器掉线？→
[教程 04 · 告警接入值班](./04-alerting-oncall)。
