# 快速开始（5 分钟上手）

> 本页从 [docs/sdk-guide.md](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/docs/sdk-guide.md)
> 与双 SDK README 提炼。所有 API 均与 SDK 源码逐行核对（ECO-01/ECO-05）。

AutoCodeFlow 的任务脚本由执行器以子进程运行：执行器注入环境变量（任务标识、
触发参数 `AUTOFLOW_*`、回调凭证三件套），脚本按需选用 SDK 读取上下文、
记录日志、主动回调。

## Python（autoflow-sdk）

### 1. 安装

```bash
pip install autoflow-sdk          # 当前 1.1.0，要求 Python ≥ 3.9
# 或仓库内源码：pip install -e packages/autoflow-sdk
```

### 2. 写任务脚本

```python
# tasks/fetch_data.py
from autoflow_sdk import TaskContext

ctx = TaskContext.from_env()                     # 缺失变量回落 "unknown"
ctx.log.info(f"task {ctx.task_id} started, execution={ctx.execution_id}")

source_url = ctx.get_param("source_url")         # AUTOFLOW_SOURCE_URL → params
limit = ctx.get_param("limit", 100)

rows = do_work(source_url, limit)                # 你的业务逻辑

# 主动回调 Admin API（N23 per-execution token）。
# 旧版执行器不注入凭证 → ctx.callback.enabled 为 False，跳过即可，
# 成败终态仍由执行器统一上报。
if ctx.callback.enabled:
    ctx.report_success(summary=f"{rows} rows written", duration_ms=1200)
```

### 3. 本地模拟（无需平台）

```bash
export EXECUTION_ID=exec-local-001
export TASK_ID=demo
export TASK_NAME=演示任务
python tasks/fetch_data.py       # 未注入回调凭证 → 走降级分支
```

完整示例（含失败上报与 `CallbackDisabledError` 降级）见
[examples/callback-report](https://github.com/LuluDeer/AutoCodeFlow/tree/develop/examples/callback-report)。

## Node.js（@autocodeflow/sdk）

### 1. 安装

```bash
npm install @autocodeflow/sdk    # 当前 1.1.0，要求 Node ≥ 18
```

平台任务形态下无需手工安装：entrypoint（打包）任务在
`requirements` 里声明 `["@autocodeflow/sdk"]`，执行器自动安装并注入
`NODE_PATH`。

### 2. 写任务脚本

```ts
// tasks/send_report.ts
import { TaskContext } from '@autocodeflow/sdk';

export default async function main() {
  const ctx = TaskContext.fromEnv();   // 缺 EXECUTION_ID/TASK_ID/TASK_NAME 直接抛错
  ctx.logger.info('task started', { executionId: ctx.executionId });

  const rows = await doWork();

  if (ctx.http.enabled) {              // 能力探测（旧版执行器不注入凭证）
    await ctx.reportSuccess({ summary: `${rows} rows written`, durationMs: 1200 });
  }

  return ctx.success('all done', { rows });   // 构造 TaskResult（自动附带日志）
}
```

### 3. 本地模拟

```bash
export EXECUTION_ID=exec-local-001
export TASK_ID=demo
export TASK_NAME=demo-task
npx tsx tasks/send_report.ts
```

完整示例见
[examples/callback-report-node](https://github.com/LuluDeer/AutoCodeFlow/tree/develop/examples/callback-report-node)。

## 执行器注入的环境变量

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `TASK_ID` | 当前任务的唯一标识 | `task_abc123` |
| `TASK_NAME` | 当前任务名称 | `fetch_data` |
| `EXECUTION_ID` | 本次执行记录的唯一标识 | `exec_xyz789` |
| `AUTOFLOW_<KEY>` | 触发参数，按参数名转大写后注入 | `AUTOFLOW_SOURCE_URL=https://api.example.com` |
| `AUTOFLOW_ADMIN_API_URL` | Admin API 基地址（非机密路由信息，N23 起注入） | `http://admin-api:3105` |
| `AUTOFLOW_CALLBACK_TOKEN` | 本次执行的一次性回调 token（`v1.` HMAC，绑定 executionId、随任务超时+15 分钟宽限过期，N23 起注入） | `v1.<uuid>.<exp>.<hmac>` |
| `AUTOFLOW_EXECUTOR_ADDRESS` | 当前执行器注册地址（非机密路由信息，N27 起注入；SDK 自动填入回调请求） | `executor-node:8002` |

> 触发参数 `{ "source_url": "https://api.example.com", "limit": 100 }` 会注入为
> `AUTOFLOW_SOURCE_URL` 与 `AUTOFLOW_LIMIT`。py SDK 把除凭证三件套外的
> `AUTOFLOW_*` 归一化进 `ctx.params`；node SDK 无此归一化（幂等映射在薄客户端
> 中意义小），直接 `process.env.AUTOFLOW_X` 读取或用示例的 `getParam` 容错模式。

## 下一步

- [Node.js SDK 参考](./sdk-node) / [Python SDK 参考](./sdk-python)
- [能力矩阵](./capability-matrix)：两侧行为差异逐条裁定
- [示例库](./examples)：回调上报、私服依赖完整链路
