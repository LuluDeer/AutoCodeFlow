# SDK 使用指南

## 概述

AutoCodeFlow 支持 Python 和 Node.js 两种执行器。每个执行器通过 `manifest` 文件声明自身能力；任务脚本通过执行器注入的环境变量获取执行上下文和触发参数。

## 注入的环境变量

执行器运行任务时，只向子进程注入任务作用域变量，避免泄露执行器密钥：

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `TASK_ID` | 当前任务的唯一标识 | `task_abc123` |
| `TASK_NAME` | 当前任务名称 | `fetch_data` |
| `EXECUTION_ID` | 本次执行记录的唯一标识 | `exec_xyz789` |
| `AUTOFLOW_<KEY>` | 触发参数，按参数名转大写后注入 | `AUTOFLOW_SOURCE_URL=https://api.example.com` |
| `AUTOFLOW_ADMIN_API_URL` | Admin API 基地址（非机密路由信息，N23 起注入） | `AUTOFLOW_ADMIN_API_URL=http://admin-api:3105` |
| `AUTOFLOW_CALLBACK_TOKEN` | 本次执行的一次性回调 token（`v1.` HMAC，绑定 executionId、随 TTL 过期，N23 起注入） | `AUTOFLOW_CALLBACK_TOKEN=v1.<uuid>.<exp>.<hmac>` |
| `AUTOFLOW_EXECUTOR_ADDRESS` | 当前执行器注册地址（非机密路由信息，N27 起注入；SDK 经 `ctx.executorAddress` 暴露并自动填入回调请求） | `AUTOFLOW_EXECUTOR_ADDRESS=executor-node:8002` |

例如触发参数 `{ "source_url": "https://api.example.com", "limit": 100 }` 会注入为：

```bash
AUTOFLOW_SOURCE_URL=https://api.example.com
AUTOFLOW_LIMIT=100
```

在脚本中读取示例：

```python
import os

task_id = os.environ["TASK_ID"]
execution_id = os.environ["EXECUTION_ID"]
source_url = os.environ["AUTOFLOW_SOURCE_URL"]
limit = int(os.environ.get("AUTOFLOW_LIMIT", "100"))
```

> 执行结果回调仍由执行器进程统一处理，任务脚本无需自行上报。但自 N23 起，任务脚本可以**安全地主动回调 Admin API**（如 `POST /api/executions/callback` 上报中间进度、或使用 SDK 的 `ctx.http`）：执行器会注入仅绑定**本次执行**的一次性 token（`AUTOFLOW_CALLBACK_TOKEN`）、Admin API 地址（`AUTOFLOW_ADMIN_API_URL`）与执行器注册地址（`AUTOFLOW_EXECUTOR_ADDRESS`，N27）。该 token 由执行器侧密钥派生 HMAC 签名（优先 `EXECUTION_CALLBACK_SECRET`，其次注册时下发的 per-executor tokenHash，最后执行器共享 token，N26），只能用于本 `executionId` 的回调且随任务超时+15 分钟宽限过期；执行器共享 token 本身依旧绝不进入任务子进程（SEC-01）。旧版执行器不注入这些变量，任务脚本应通过 `ctx.http.enabled` 判断回调能力是否可用。
>
> **多节点部署约束（N26）**：若各执行器使用独立 `--secret` 安装，per-execution 回调 token 以注册时下发的 tokenHash 为签名密钥，Admin API 按地址回查同一值验签。管理员在后台**轮换执行器 token 后**，执行器需重新注册（重启或注册重试）才能拿到新密钥；窗口期内旧密钥签发的任务回调 token 会验签失败（401）。若两端都配置了相同的 `EXECUTION_CALLBACK_SECRET`，则始终优先使用该密钥，不受轮换影响。

## 任务级调度策略

平台任务配置支持独立于 manifest 的运行策略，用于覆盖具体任务实例的调度、超时和重试行为：

| 字段 | 单位/格式 | 说明 |
|------|-----------|------|
| `timeoutSeconds` | 秒 | 推荐字段，任务执行超过该时长后执行器终止进程并上报超时；旧字段 `timeout` 仍兼容 |
| `timezone` | IANA 时区 | 仅 Cron 任务使用，例如 `Asia/Shanghai`、`UTC`；留空使用服务端默认时区 |
| `maxRetry` | 次数 | 最大尝试次数，`1` 表示不重试 |
| `retryDelay` | 秒 | 队列指数退避的起始延迟，`0` 表示不配置 backoff |

Python SDK 同时支持 snake_case 与 API camelCase，并会归一化到 API 字段：

```python
from autoflow_sdk.models import TaskConfig

config = TaskConfig(
    name="weekday-report",
    runtime="python",
    entrypoint="tasks/report.py",
    timeout_seconds=300,
    timezone="Asia/Shanghai",
    max_retry=3,
    retry_delay=15,
)

assert config.timeout == 300
assert config.timeoutSeconds == 300
```

Node/API payload 推荐使用 camelCase：

```json
{
  "timeoutSeconds": 300,
  "timezone": "Asia/Shanghai",
  "maxRetry": 3,
  "retryDelay": 15
}
```

> 注意：SDK HTTP client 的 `timeout` / `timeoutMs` 表示请求超时；任务执行超时请使用 `timeoutSeconds`（或兼容旧字段 `timeout`）。manifest 中的 `timeout` 是任务模板默认值，平台任务配置可按实例覆盖。

## manifest.yaml 格式

`manifest.yaml` 用于向平台声明执行器支持的任务类型和参数结构。

```yaml
# manifest.yaml
name: my-python-executor          # 执行器唯一名称
version: "1.0.0"                  # 版本号
runtime: python                   # 运行时类型：python | node
description: "数据处理执行器"      # 执行器描述

tasks:
  - name: fetch_data              # 任务名称（全局唯一建议加前缀）
    description: "从外部 API 拉取数据并存储"
    entry: tasks/fetch_data.py    # 入口文件路径（相对于执行器根目录）
    timeout: 300                  # 超时秒数（默认 60）
    params:                       # 参数 Schema（JSON Schema 子集）
      - name: source_url
        type: string
        required: true
        description: "数据源 URL"
      - name: limit
        type: integer
        required: false
        default: 100
        description: "最大拉取条数"

  - name: process_data
    description: "清洗并转换数据"
    entry: tasks/process_data.py
    timeout: 600
    params:
      - name: input_file
        type: string
        required: true
      - name: output_format
        type: string
        required: false
        default: "json"
        enum: ["json", "csv", "parquet"]
```

## manifest.json 格式

与 `manifest.yaml` 等价，适用于偏好 JSON 的场景：

```json
{
  "name": "my-node-executor",
  "version": "1.0.0",
  "runtime": "node",
  "description": "Node.js 通用执行器",
  "tasks": [
    {
      "name": "send_notification",
      "description": "发送通知消息",
      "entry": "tasks/sendNotification.js",
      "timeout": 30,
      "params": [
        {
          "name": "channel",
          "type": "string",
          "required": true,
          "description": "通知渠道（email/sms/webhook）",
          "enum": ["email", "sms", "webhook"]
        },
        {
          "name": "message",
          "type": "string",
          "required": true,
          "description": "消息内容"
        },
        {
          "name": "recipients",
          "type": "array",
          "required": true,
          "description": "收件人列表"
        }
      ]
    }
  ]
}
```

## Python SDK 使用示例

### 安装

Python 执行器会直接运行任务脚本；如果任务需要第三方依赖，请在 manifest 的 `requirements` 中声明，或在执行器镜像中预装。

### 基础任务脚本（tasks/fetch_data.py）

```python
import os
import json
import requests
from typing import Any


def main() -> dict[str, Any]:
    """
    任务入口函数，平台调用此函数执行任务。
    返回值会作为执行结果记录到平台。
    """
    # 读取平台注入的上下文
    task_id = os.environ["TASK_ID"]
    task_name = os.environ.get("TASK_NAME", "")
    execution_id = os.environ["EXECUTION_ID"]

    print(f"Starting task={task_id} name={task_name} execution={execution_id}")

    # 从 AUTOFLOW_ 参数中获取配置
    source_url = os.environ["AUTOFLOW_SOURCE_URL"]
    limit = int(os.environ.get("AUTOFLOW_LIMIT", "100"))

    # 执行业务逻辑
    response = requests.get(source_url, params={"limit": limit}, timeout=30)
    response.raise_for_status()
    data = response.json()

    # 记录中间进度（可选）：stdout/stderr 会被执行器采集为执行日志
    print("progress=50% 数据拉取完成，开始处理")

    processed = [{"id": item["id"], "value": item["value"]} for item in data]

    print(f"Task completed, processed {len(processed)} records")

    return {
        "success": True,
        "count": len(processed),
        "data": processed[:10],
    }


if __name__ == "__main__":
    result = main()
    print(json.dumps(result, ensure_ascii=False))
```

### 错误处理示例

```python
import os
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def main() -> dict:
    try:
        result = do_work()
        return {"success": True, "result": result}
    except ValueError as e:
        logger.error("参数错误: %s", e)
        # 抛出异常会被执行器捕获并通过回调将执行状态置为 FAILED
        raise
    except Exception:
        logger.exception("任务执行异常")
        raise


def do_work() -> dict:
    required_field = os.environ.get("AUTOFLOW_REQUIRED_FIELD")
    if not required_field:
        raise ValueError("缺少必填参数 required_field")
    return {"processed": True, "required_field": required_field}
```

## Node.js SDK 使用示例

### 基础任务脚本（tasks/sendNotification.js）

```javascript
const axios = require('axios');

/**
 * 任务入口函数，平台以 module.exports 方式调用。
 * 返回 Promise，resolve 的值作为执行结果。
 */
async function main() {
  // 读取平台注入的上下文
  const taskId = process.env.TASK_ID;
  const taskName = process.env.TASK_NAME || '';
  const executionId = process.env.EXECUTION_ID;

  console.log(`Starting task=${taskId} name=${taskName} execution=${executionId}`);

  const channel = process.env.AUTOFLOW_CHANNEL;
  const message = process.env.AUTOFLOW_MESSAGE;
  const recipients = (process.env.AUTOFLOW_RECIPIENTS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (!channel || !message || !recipients.length) {
    throw new Error('缺少必填参数: channel, message, recipients');
  }

  const results = await Promise.allSettled(
    recipients.map((recipient) => sendMessage(channel, recipient, message))
  );

  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;

  console.log(`progress=100% Done: ${succeeded} succeeded, ${failed} failed`);

  return {
    success: failed === 0,
    total: recipients.length,
    succeeded,
    failed,
  };
}

async function sendMessage(channel, recipient, message) {
  switch (channel) {
    case 'webhook':
      await axios.post(recipient, { message }, { timeout: 10000 });
      break;
    case 'email':
      // 调用邮件服务...
      break;
    default:
      throw new Error(`不支持的渠道: ${channel}`);
  }
}

module.exports = main;
```

### 使用 TypeScript（tasks/processData.ts）

```typescript
interface TaskResult {
  success: boolean;
  outputFile: string;
  rowCount: number;
}

export default async function main(): Promise<TaskResult> {
  const inputFile = process.env.AUTOFLOW_INPUT_FILE;
  const outputFormat = process.env.AUTOFLOW_OUTPUT_FORMAT || 'json';

  if (!inputFile) {
    throw new Error('缺少必填参数: input_file');
  }

  const outputFile = await processFile(inputFile, outputFormat);

  return {
    success: true,
    outputFile,
    rowCount: 1000,
  };
}

async function processFile(input: string, format: string): Promise<string> {
  // 实际处理逻辑...
  return `output.${format}`;
}
```

### 任务内回调 Admin API（N23，per-execution token）

`@autoflow/sdk` 的 `TaskContext.fromEnv()` 会自动识别执行器注入的
`AUTOFLOW_ADMIN_API_URL` + `AUTOFLOW_CALLBACK_TOKEN`，此时 `ctx.http` 直接可用；
token 仅授权对**本次 executionId** 的回调，过期或越权会被 Admin API 拒绝（401）。

```typescript
import { TaskContext } from '@autoflow/sdk';

export default async function main() {
  const ctx = TaskContext.fromEnv();

  if (!ctx.http.enabled) {
    // 旧版执行器未注入回调凭证：跳过主动回调，结果仍由执行器统一上报
    ctx.logger.warn('callback capability unavailable on this executor');
    return { ok: true };
  }

  // 例：向平台回报一次执行结果回调。请求体每条必须携带本 execution 的
  // executionId（服务端按 token 绑定的 executionId 校验）；executorAddress
  // 由 ctx.http 自动用执行器注入的 AUTOFLOW_EXECUTOR_ADDRESS 补齐，
  // 无需硬编码（N27）——手写时请用 ctx.executorAddress，地址随部署
  // 变化，硬编码必然在重注册后 mismatch。
  await ctx.http.post('/api/executions/callback', [
    {
      executionId: ctx.executionId,
      status: 'success',
      durationMs: 1234,
    },
  ]);

  // 显式书写同样可行：
  // await ctx.http.post('/api/executions/callback', [
  //   {
  //     executionId: ctx.executionId,
  //     status: 'success',
  //     executorAddress: ctx.executorAddress,
  //     durationMs: 1234,
  //   },
  // ]);

  return ctx.success('callback delivered');
}
```

> 注意：per-execution token 只对 `POST /api/executions/callback` 的回调鉴权有意义，
> 不能访问其他需要用户 JWT 的管理端点；也不要将其持久化或跨执行复用——它绑定
> 单次 execution 且会过期，任何越权使用都会 fail-closed。

## 执行器注册流程

1. 在管理后台「执行器管理」页面点击「新增执行器」
2. 填写执行器名称、类型（Python/Node）和访问地址
3. 上传或填写 `manifest.yaml` / `manifest.json`
4. 平台自动同步任务定义，执行器注册完成
5. 在任务管理页面可选择该执行器下的任务类型创建任务
