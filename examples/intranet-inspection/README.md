# 内网巡检示例（批量探测 + 结果汇总回调）

> **受众**：要做批量探测 / 巡检上报的开发者 · **状态**：稳定 · **最后核对**：2026-11-21

演示「批量探测 + 结果汇总回调」类任务：cron 每 6 小时触发 → 并发探测多个
内网目标的 TCP 连通性 → 汇总存活/不可达数量 → 把汇总结果回调给结果汇总系统。
所有目标地址与凭据均为**占位符**，复制配置即可跑通首次成功（探测占位目标
会得到不可达结果，但任务本身成功完成并产出汇总）。

- 任务配置样例：[task.example.json](task.example.json)
- 任务代码：[intranet_inspection.js](intranet_inspection.js)
- runtime：`node`（仅用 Node 内置 `net` 模块，零第三方依赖）

## 场景说明

1. 触发：cron `0 */6 * * *`（每 6 小时），5 段 cron，时区 `Asia/Shanghai`。
2. 批量探测：`params.targets` 列出目标 `host:port`，脚本并发做 TCP 连接探测，
   单目标超时 `timeoutMs` 毫秒。
3. 结果汇总：统计 total / alive / unreachable 及每个目标明细。
4. 汇总回调：把汇总 payload POST 到 `callbackUrl`；示例只打印待上报内容
   （占位 URL 不实际外发），替换为真实端点即可上报。

## 前置条件

- 已部署 AutoCodeFlow admin-api 与至少一个 node runtime 执行器，runner 能访问
  `params.targets` 里的目标地址（真实巡检时通常是内网网段）。
- 已配置 `acf` CLI 指向 admin-api（见下方环境变量），并有创建/触发任务的账号。
- 任务名全局唯一：`task.example.json` 的 `name` 若重名，改一个即可。

## 凭据占位

| 位置 | 占位符 | 真实值注入方式 |
|------|--------|----------------|
| `params.targets` | `HOST_A:PORT_A` / `HOST_B:PORT_B` | 改成真实 `host:port`，或用 `acf task update <id> --body '{"params":{"targets":["10.0.0.1:80"]}}'` |
| `params.callbackUrl` | `https://callback.example.com/...` | 改成真实汇总端点；示例不实际外发 |
| `secrets.INTRANET_SCAN_TOKEN` | `...占位符...` | `acf task update <id> --body '{"secrets":{"INTRANET_SCAN_TOKEN":"真实令牌"}}'` |

secrets 写入后 API 读回恒为 `******`，派发时按原名注入子进程 env；脚本里用
`process.env.INTRANET_SCAN_TOKEN` 读取，别把令牌写进 `params` 或源码。

## 如何创建任务

### 方式一：acf CLI（推荐）

```bash
export ACF_API_URL=http://localhost:3105
export ACF_TOKEN=acf_你的密钥

acf task create --file examples/intranet-inspection/task.example.json
# 输出：Task created: <taskId>
```

### 方式二：curl

```bash
curl -X POST "$ACF_API_URL/api/tasks" \
  -H "Authorization: Bearer $ACF_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @examples/intranet-inspection/task.example.json
```

## 如何看结果

```bash
acf task trigger <taskId> --wait
acf task logs <execId> --tail 200
```

日志里会看到 `[intranet-inspection] callback -> ...`、汇总 `payload` 与一行
`RESULT {"success":true,"total":...,"alive":...,"unreachable":...}`，即首次成功。
占位目标探测结果为不可达属正常现象——任务仍成功产出汇总；换成真实目标后
`alive` 会反映真实连通性。

> 本地直接跑：`node examples/intranet-inspection/intranet_inspection.js`
> （默认探测两个占位目标，约 1 秒超时后输出汇总）。
