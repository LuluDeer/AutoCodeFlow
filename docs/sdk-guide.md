# SDK 使用指南

## SDK 矩阵

双 SDK（Node/Python）回调契约已于第九轮对齐：同一 `CallbackItemDto` 请求体、
同一 per-execution token 鉴权链（N23/N26/N27）、同一 enabled/disabled
fail-closed 语义。能力对照如下：

| 能力 | Node.js `@autocodeflow/sdk` | Python `autoflow-sdk` |
|------|------------------------|----------------------|
| 包目录 | `packages/autocodeflow-node-sdk` | `packages/autoflow-sdk` |
| 安装 | `npm install @autocodeflow/sdk` | `pip install autoflow-sdk` |
| 运行时 | Node ≥ 18（executor-node 注入 env） | Python ≥ 3.9（executor-python 注入 env） |
| 执行上下文 | `TaskContext.fromEnv()`（缺 `EXECUTION_ID`/`TASK_ID`/`TASK_NAME` 抛错）；`TaskContext.create(env)` 显式构造 | `TaskContext.from_env()`（缺失变量回落 `"unknown"`）；`AUTOFLOW_*` 归入 `ctx.params`，凭证三件套除外 |
| HTTP 客户端 | `ctx.http` / `new HttpClient(baseURL, token, traceId?, executorAddress?)`（axios；`enabled`/`disabledReason`） | `autoflow_sdk.HttpClient` / `AsyncHttpClient`（httpx，通用请求）+ `ctx.callback`（`CallbackClient`，回调专用） |
| 回调上报 | `ctx.http.post('/api/executions/callback', [item])`，`executorAddress` 自动补齐（N27） | `ctx.report_success()` / `ctx.report_failure(e, failure_reason=...)` / `ctx.callback.report([item])`，`executionId`/`executorAddress` 自动补齐 |
| 回调契约 | `CallbackItemDto`：`executionId` / `status: success\|failed` / `executorAddress` / `logs` / `errorMessage` / `failureReason` / `durationMs` | 同左（字段逐一对齐；`failureReason` 客户端枚举校验） |
| 日志 | `ctx.logger`（`TaskLogger`，结构化，随 `ctx.success()/failure()` 附带进 `TaskResult.logs`） | `ctx.log`（`get_logger(task_name)`，stdout/stderr 由执行器采集） |
| README | [packages/autocodeflow-node-sdk/README.md](../packages/autocodeflow-node-sdk/README.md) | [packages/autoflow-sdk/README.md](../packages/autoflow-sdk/README.md) |
| 发布渠道 | npm（scoped 公开包，`publishConfig.access=public`） | PyPI（`pyproject.toml` 为元数据单一来源） |
| 发布 job | `release.yml → publish-npm`（node 24，secret `NPM_TOKEN`） | `release.yml → publish-pypi`（python 3.12，secret `PYPI_API_TOKEN`） |

### 版本与发布流程

三包（`@autocodeflow/sdk`、`autoflow-sdk`、`autocodeflow-mcp-server`）走
**lockstep** 单版本线（当前 `1.0.1`）。发布只由 push tag `vX.Y.Z` 触发
[.github/workflows/release.yml](../.github/workflows/release.yml)：

1. `version-guard`：校验 tag 与上述各包 `package.json` / `pyproject.toml` /
   `__init__.py` 的 version 完全一致，不一致即 fail（无 `workflow_dispatch`，
   杜绝手动误触发真发布）；
2. `publish-npm` / `publish-pypi` 并行发布（各自先跑 `--dry-run` /
   `python -m build` 结构校验），并经 GitHub
   `environment: release` 人工审批闸门。

**幂等与恢复**：版本号一经发布即不可复用——同版本重发 npm 必报
EP409、PyPI 必回 400（File already exists），发布链无覆盖逻辑。发布
部分失败后的标准恢复路径是修复后 `gh run rerun <run-id> --failed`
（只重跑失败的 publish job，已成功的 job 与 version-guard 不重跑，
审批门需重新 Approve）；仅当需要更换 tag 指向的内容时才删 tag 重打，
且已发布成功的一侧必须 bump 版本换新 tag（详见 release.yml 头注释）。

> `acf-cli` 暂不发布：npm 上 `acf-cli` 名称已被第三方占用，需先改名
> （如 `@autocodeflow/cli`——勿用 `@autoflow/*`，该 org 已被抢注）再
> 加入发布矩阵。本地演练（不真发布）：
> `npm publish --access public --dry-run`（node 包）、
> `python -m build --wheel`（python 包，产物 `dist/` 已 gitignore）。

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
| `AUTOFLOW_EXECUTOR_ADDRESS` | 当前执行器注册地址（非机密路由信息，N27 起注入；SDK 经 `ctx.executorAddress`（Node）/ `ctx.executor_address`（Python）暴露并自动填入回调请求） | `AUTOFLOW_EXECUTOR_ADDRESS=executor-node:8002` |

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

> 执行结果回调仍由执行器进程统一处理，任务脚本无需自行上报。但自 N23 起，任务脚本可以**安全地主动回调 Admin API**（如 `POST /api/executions/callback` 上报中间进度、或使用 SDK 的回调客户端——Node `ctx.http` / Python `ctx.callback`，见上方 SDK 矩阵）：执行器会注入仅绑定**本次执行**的一次性 token（`AUTOFLOW_CALLBACK_TOKEN`）、Admin API 地址（`AUTOFLOW_ADMIN_API_URL`）与执行器注册地址（`AUTOFLOW_EXECUTOR_ADDRESS`，N27）。该 token 由执行器侧密钥派生 HMAC 签名（优先 `EXECUTION_CALLBACK_SECRET`，其次注册时下发的 per-executor tokenHash，最后执行器共享 token，N26），只能用于本 `executionId` 的回调且随任务超时+15 分钟宽限过期；执行器共享 token 本身依旧绝不进入任务子进程（SEC-01）。旧版执行器不注入这些变量，任务脚本应通过能力探测判断回调是否可用——**分语言判据**（N39，第十轮修正：python `TaskContext` 没有 `ctx.http` 属性，照 Node 写法会直接 `AttributeError`）：Node 用 `ctx.http.enabled`（不可用时原因见 `ctx.http.disabledReason`）；Python 用 `ctx.callback.enabled`（见下方 Python 专节示例）。
>
> **多节点部署约束（N26）**：若各执行器使用独立 `--secret` 安装，per-execution 回调 token 以注册时下发的 tokenHash 为签名密钥，Admin API 按地址回查同一值验签。管理员在后台**轮换执行器 token 后**无需重启执行器：executor-node 在下一次出站请求收到 401 时即时以注册凭证重取并对齐新密钥（R10，默认 ≤30s）；executor-python 自 R11 起同样具备 401 即时自愈（`request_with_self_heal`：出站心跳 401 时立即重取并对齐新 Token 与 tokenHash，重试原心跳恰一次），两端收敛均 ≤ 一个心跳间隔（默认 30s）。窗口期内以旧密钥签发的任务回调 token 会验签失败（401）。若两端都配置了相同的 `EXECUTION_CALLBACK_SECRET`，则始终优先使用该密钥，不受轮换影响。

## 任务级调度策略

平台任务配置支持独立于 manifest 的运行策略，用于覆盖具体任务实例的调度、超时和重试行为：

| 字段 | 单位/格式 | 说明 |
|------|-----------|------|
| `timeoutSeconds` | 秒 | 推荐字段，任务执行超过该时长后执行器终止进程并上报超时；旧字段 `timeout` 仍兼容 |
| `timezone` | IANA 时区 | 仅 Cron 任务使用，例如 `Asia/Shanghai`、`UTC`；留空使用服务端默认时区 |
| `maxRetry` | 次数 | 最大尝试次数，`1` 表示不重试 |
| `retryDelay` | 秒 | 队列指数退避的起始延迟，`0` 表示不配置 backoff |
| `requirements` | 字符串数组 | 任务级依赖声明（W-21）。python runtime → 执行器建 per-task venv 并 `uv pip install`（executor-python）；node runtime → 执行器安装 npm 包（executor-node）。仅 entrypoint（打包）任务生效，glue 脚本任务忽略。空数组/null 表示无额外依赖；拒绝以 `-` 开头的 option 形条目 |

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

### 任务内回调 Admin API（Python SDK，N23 per-execution token）

`autoflow_sdk` 的 `TaskContext.from_env()` 会自动识别执行器注入的
`AUTOFLOW_ADMIN_API_URL` + `AUTOFLOW_CALLBACK_TOKEN` + `AUTOFLOW_EXECUTOR_ADDRESS`
三个变量，将它们暴露为 `ctx.admin_api_url` / `ctx.callback_token` /
`ctx.executor_address` 专用字段（**不会**混入 `ctx.params`，避免任务参数被
凭证与路由信息污染），并提供 `ctx.callback` 回调客户端与
`ctx.report_success()` / `ctx.report_failure()` 便捷方法。

回调凭证齐备时 `ctx.callback.enabled` 为 `True`；旧版执行器（或未注入凭证的
手动运行环境）下客户端处于 disabled 状态，任何上报调用都会抛出
`CallbackDisabledError` 并指明缺失的变量——任务脚本应先用
`ctx.callback.enabled` 判断，再决定是否主动回调。

```python
from autoflow_sdk import TaskContext, CallbackDisabledError


def main() -> dict:
    ctx = TaskContext.from_env()

    if not ctx.callback.enabled:
        # 旧版执行器未注入回调凭证：跳过主动回调，结果仍由执行器统一上报
        ctx.log.warning("callback capability unavailable on this executor")
        return {"ok": True}

    try:
        rows = do_work()
        # 例：向平台回报一次成功回调（POST /api/executions/callback）。
        # executionId / executorAddress 由 SDK 自动补齐；summary 写入 logs 字段。
        ctx.report_success(summary=f"{rows} rows written", duration_ms=1234)
        return {"ok": True, "rows": rows}
    except Exception as e:
        # 失败上报：error 映射为 errorMessage（截断至 4 KB），
        # failure_reason 取 admin-api 的 ExecutionFailureReason 枚举
        # （默认 script_error，可选 timeout / killed / unknown 等）。
        ctx.report_failure(e, failure_reason="script_error")
        raise


if __name__ == "__main__":
    main()
```

回调请求体与 Node SDK 完全一致，遵循 `CallbackItemDto` 字段
（`executionId` / `status: success|failed` / `executorAddress` / `logs` /
`errorMessage` / `failureReason` / `durationMs`）。需要更细粒度控制（如批量
上报或自定义字段）时，可直接使用底层客户端：

```python
ctx.callback.report([
    {"status": "success", "durationMs": 800},
])  # executionId / executorAddress 自动补齐，显式书写的值不会被覆盖
```

> 注意：per-execution token 只对 `POST /api/executions/callback` 的回调鉴权
> 有意义，不能访问其他需要用户 JWT 的管理端点；它绑定单次 execution 且随任务
> 超时+15 分钟宽限过期，任何越权或过期使用都会被 Admin API 拒绝（401，
> fail-closed）。执行器共享 token 本身绝不进入任务子进程（SEC-01）。

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

`@autocodeflow/sdk` 的 `TaskContext.fromEnv()` 会自动识别执行器注入的
`AUTOFLOW_ADMIN_API_URL` + `AUTOFLOW_CALLBACK_TOKEN`，此时 `ctx.http` 直接可用；
token 仅授权对**本次 executionId** 的回调，过期或越权会被 Admin API 拒绝（401）。

```typescript
import { TaskContext } from '@autocodeflow/sdk';

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
