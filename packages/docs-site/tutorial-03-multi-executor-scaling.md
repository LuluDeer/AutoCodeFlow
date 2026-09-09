# 教程 03 · 多执行器扩容

> 重组自 [docs/tutorials/03-multi-executor-scaling.md](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/docs/tutorials/03-multi-executor-scaling.md)（DOC-06）。
> 目标：把执行器从 1 台扩到 2 台，理解分派逻辑与灰度发布。

## 0. 平台如何挑执行器

1. **过滤**：runtime 匹配、在线状态、tags/group 路由；
2. **评分**（CORE-05 负载感知）：
   `loadScore = 0.5×负载 + 0.25×CPU + 0.25×内存 + 0.1×长任务惩罚`
   （长任务惩罚来自任务 `estimatedDurationSec`，未知按 600s 缺省）；
   分最低者胜出；
3. **例外**：任务 `executorId`（pinning）只派给该台；`executeMode=broadcast`
   广播所有匹配执行器。

并发上限由执行器 `maxConcurrentTasks` 决定（心跳热更新，1..10000）。

## 1. 注册第二台执行器

**入口 A**：执行器列表页 → 「安装向导」（`/executors/install`，ADMIN-only）。

**入口 B**：API 拿命令：

```bash
curl -H "Authorization: Bearer <JWT>" \
  http://<admin>:3105/api/executors/install-cmd
# 返回 { cmd, token, adminApiUrl }；cmd 即一键安装命令
```

到第二台机器（Linux + systemd + Node 24）执行，可追加参数：

```bash
curl -fsSL 'http://<admin>:3105/api/executors/install.sh' \
  | bash -s -- \
      --api-url 'http://<admin>:3105' \
      --secret '<EXECUTOR_SECRET>' \
      --runtime node \
      --name executor-node-2
```

`--runtime` 支持 `node`/`python`/`universal`。预期：「执行器」页约 10 秒内
出现新的在线行。脚本细节见
[部署指南](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/docs/deployment.md)。

## 2. 验证负载分派

1. 把执行器 1 的 `maxConcurrentTasks` 调小（如 2）；
2. 建一个跑 60 秒的任务，触发 3-4 次；
3. 观察：前 2 次落在执行器 1，之后落到执行器 2（两台的
   `runningTaskCount`/CPU/内存实时反映）。

进阶：给长任务填 `estimatedDurationSec`（如 3600），混布 1 秒任务，
观察长任务倾向派给更空闲的一台（CORE-05 长任务惩罚生效）。

## 3. 灰度发布应用（DEP-02）

`POST /api/applications/:id/upgrade-all` 对所有 RUNNING 部署触发升级，
可选 `rollout` 灰度策略（**缺省不传 = `all` 全量**，既有语义不变）：

```json
{ "rollout": { "strategy": "canary", "percentage": 34 } }
```

| 字段 | 取值 | 缺省 | 说明 |
|------|------|------|------|
| `rollout.strategy` | `canary` \| `all` | `all` | canary=分批灰度 |
| `rollout.percentage` | int 1-100 | 50 | 首批台数 = `ceil(N × percentage%)`，至少 1 台、至多 N |

**canary 状态机**：首批心跳确认（宽限窗 120 秒）→ 健康探测 → 任一台通过即
提升其余台；首批失败自动回滚已触发升级的部署（重新部署上一版本）。
**注意**：批次是 admin-api 进程内状态，服务重启即暂停（遗留批次标 failed
需人工重发）；批次硬超时 15 分钟。契约详见
[API 参考·Rollout](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/docs/api-reference.md)。

## 4. 容量与隔离的进阶手段

| 手段 | 配置位置 | 效果 |
|------|---------|------|
| 任务 pinning | 任务表单 `executorId` | 只跑某台（绕过 tags/runtime 过滤） |
| 广播执行 | 任务 `executeMode=broadcast` | 所有匹配执行器各跑一份（与 pinning 互斥） |
| tags/group 路由 | 执行器 `tags`（`PATCH /executors/:id`） | 按标签路由到特定执行器池 |
| 并发热更新 | 心跳 `maxConcurrentTasks` | 不重启调整单台容量 |

## 5. 下一步

[教程 04 · 告警接入值班](./tutorial-04-alerting-oncall)。
