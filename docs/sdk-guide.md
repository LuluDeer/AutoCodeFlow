# SDK 使用指南

## 概述

AutoCodeFlow 支持 Python 和 Node.js 两种执行器。每个执行器通过 `manifest` 文件声明自身能力，并通过注入的环境变量获取执行上下文。

## 注入的环境变量

执行器运行任务时，平台会自动注入以下环境变量供任务脚本使用：

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `TASK_ID` | 当前任务的唯一标识 | `task_abc123` |
| `EXECUTION_ID` | 本次执行记录的唯一标识 | `exec_xyz789` |
| `APP_NAME` | 所属应用名称 | `my-app` |
| `ADMIN_API_URL` | Admin API 的访问地址 | `http://admin-api:3105` |
| `TASK_TOKEN` | 用于回调 API 的临时认证令牌 | `eyJhbGci...` |
| `TRACE_ID` | 全链路追踪 ID，用于日志关联 | `abc123def456` |
| `TASK_PARAMS` | 任务参数（JSON 字符串） | `{"key": "value"}` |

在脚本中读取示例：

```python
import os, json

task_id = os.environ["TASK_ID"]
execution_id = os.environ["EXECUTION_ID"]
params = json.loads(os.environ.get("TASK_PARAMS", "{}"))
```

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

```bash
pip install requests  # Python 执行器内置依赖，无需单独安装 SDK 包
```

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
    execution_id = os.environ["EXECUTION_ID"]
    trace_id = os.environ["TRACE_ID"]
    params = json.loads(os.environ.get("TASK_PARAMS", "{}"))

    print(f"[{trace_id}] Starting task {task_id}, execution {execution_id}")

    # 从参数中获取配置
    source_url = params["source_url"]
    limit = params.get("limit", 100)

    # 执行业务逻辑
    response = requests.get(source_url, params={"limit": limit}, timeout=30)
    response.raise_for_status()
    data = response.json()

    # 上报中间进度（可选）
    _report_progress(execution_id, 50, "数据拉取完成，开始处理")

    # 处理数据...
    processed = [{"id": item["id"], "value": item["value"]} for item in data]

    print(f"[{trace_id}] Task completed, processed {len(processed)} records")

    # 返回执行结果
    return {
        "success": True,
        "count": len(processed),
        "data": processed[:10],  # 结果摘要，避免过大
    }


def _report_progress(execution_id: str, percent: int, message: str) -> None:
    """向平台上报执行进度（可选）"""
    admin_api_url = os.environ.get("ADMIN_API_URL", "")
    task_token = os.environ.get("TASK_TOKEN", "")
    if not admin_api_url or not task_token:
        return
    try:
        requests.post(
            f"{admin_api_url}/api/executions/{execution_id}/progress",
            json={"percent": percent, "message": message},
            headers={"Authorization": f"Bearer {task_token}"},
            timeout=5,
        )
    except Exception:
        pass  # 进度上报失败不影响任务主流程


if __name__ == "__main__":
    result = main()
    print(json.dumps(result, ensure_ascii=False))
```

### 错误处理示例

```python
import os
import json
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def main() -> dict:
    params = json.loads(os.environ.get("TASK_PARAMS", "{}"))

    try:
        result = do_work(params)
        return {"success": True, "result": result}
    except ValueError as e:
        logger.error("参数错误: %s", e)
        # 抛出异常会被平台捕获，执行状态置为 FAILED
        raise
    except Exception as e:
        logger.exception("任务执行异常")
        raise


def do_work(params: dict) -> dict:
    if "required_field" not in params:
        raise ValueError("缺少必填参数 required_field")
    return {"processed": True}
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
  const executionId = process.env.EXECUTION_ID;
  const traceId = process.env.TRACE_ID;
  const params = JSON.parse(process.env.TASK_PARAMS || '{}');

  console.log(`[${traceId}] Starting task ${taskId}, execution ${executionId}`);

  const { channel, message, recipients } = params;

  if (!channel || !message || !recipients?.length) {
    throw new Error('缺少必填参数: channel, message, recipients');
  }

  // 执行业务逻辑
  const results = await Promise.allSettled(
    recipients.map((recipient) => sendMessage(channel, recipient, message))
  );

  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;

  console.log(`[${traceId}] Done: ${succeeded} succeeded, ${failed} failed`);

  return {
    success: failed === 0,
    total: recipients.length,
    succeeded,
    failed,
  };
}

async function sendMessage(channel, recipient, message) {
  // 根据渠道分发
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
import axios from 'axios';

interface TaskParams {
  inputFile: string;
  outputFormat?: 'json' | 'csv' | 'parquet';
}

interface TaskResult {
  success: boolean;
  outputFile: string;
  rowCount: number;
}

export default async function main(): Promise<TaskResult> {
  const params: TaskParams = JSON.parse(process.env.TASK_PARAMS || '{}');
  const adminApiUrl = process.env.ADMIN_API_URL;
  const taskToken = process.env.TASK_TOKEN;

  const { inputFile, outputFormat = 'json' } = params;

  // 执行数据处理
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

## 执行器注册流程

1. 在管理后台「执行器管理」页面点击「新增执行器」
2. 填写执行器名称、类型（Python/Node）和访问地址
3. 上传或填写 `manifest.yaml` / `manifest.json`
4. 平台自动同步任务定义，执行器注册完成
5. 在任务管理页面可选择该执行器下的任务类型创建任务
