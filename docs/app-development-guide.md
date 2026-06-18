# AutoCodeFlow · 自动化应用开发指南

> 本文档面向在 AutoCodeFlow 平台上**开发和部署自动化应用**的开发者（人工或 AI agent）。
> 读完本文，你就能独立完成：编写任务脚本 → 注册执行器 → 创建任务 → 发布上线。

---

## 核心概念

```
Application（应用）
  └── Task（任务）               ← 你定义的业务逻辑单元
        └── Execution（执行记录） ← 每次运行的快照和日志

Executor（执行器节点）            ← 实际运行脚本的进程/服务器
  └── manifest.yaml              ← 声明该执行器支持哪些任务
```

**一句话流程**：写脚本 → 放到执行器 → 在平台创建任务 → 配置调度 → 自动跑。

---

## 选择运行时

| 运行时 | 适用场景 |
|--------|----------|
| **Node.js** | HTTP 调用、文件处理、前端自动化、发通知 |
| **Python** | 数据处理、机器学习、爬虫、科学计算 |

两种运行时的执行器都已内置在 `docker-compose.yml`，开箱即用。

---

## 快速上手：5 分钟跑第一个任务

### 1. 确认平台在跑

```bash
docker compose up -d
docker compose ps   # 所有服务 healthy
```

浏览器打开 http://localhost，用 `admin` / `Admin@123456` 登录。

### 2. 在管理后台直接写脚本（最快路径）

1. 左侧菜单 → **应用** → 新建应用
2. 进入应用 → **新建任务**
3. 脚本类型选 `JavaScript`，粘贴：

```javascript
const params = JSON.parse(process.env.TASK_PARAMS || '{}');
const name = params.name || 'World';
console.log(`Hello, ${name}! 时间: ${new Date().toISOString()}`);
return { success: true, greeting: `Hello, ${name}!` };
```

4. 调度方式选 **手动**，保存并启用
5. 点击 **立即触发** → 执行记录 → 看到日志即成功

---

## 正式开发：自定义执行器

当内置执行器满足不了需求时（需要特定依赖、特定环境），部署自己的执行器。

### 目录结构

**Python 执行器：**
```
my-executor/
├── manifest.yaml
├── tasks/
│   ├── task_a.py
│   └── task_b.py
├── requirements.txt
└── Dockerfile          # 容器化部署时需要
```

**Node.js 执行器：**
```
my-executor/
├── manifest.json
├── tasks/
│   ├── taskA.js
│   └── taskB.js
└── package.json
```

### manifest.yaml 编写

```yaml
name: my-executor          # 执行器唯一名称
version: "1.0.0"
runtime: python            # python 或 node
description: "我的自动化执行器"

tasks:
  - name: daily_report
    description: "生成每日报表"
    entry: tasks/daily_report.py   # 入口文件（相对路径）
    timeout: 300                   # 超时秒数，默认 60
    params:
      - name: date
        type: string
        required: false
        default: "today"
        description: "报表日期，格式 YYYY-MM-DD 或 today"
      - name: output_format
        type: string
        required: false
        default: "json"
        enum: ["json", "csv"]

  - name: send_alert
    description: "发送告警通知"
    entry: tasks/send_alert.py
    timeout: 30
    params:
      - name: message
        type: string
        required: true
      - name: channel
        type: string
        required: false
        default: "webhook"
        enum: ["webhook", "email"]
```

### manifest.json 等价格式（Node.js 推荐）

```json
{
  "name": "my-node-executor",
  "version": "1.0.0",
  "runtime": "node",
  "description": "Node.js 通用执行器",
  "tasks": [
    {
      "name": "fetch_and_notify",
      "description": "拉取数据并发送通知",
      "entry": "tasks/fetchAndNotify.js",
      "timeout": 60,
      "params": [
        { "name": "url", "type": "string", "required": true },
        { "name": "webhook", "type": "string", "required": true }
      ]
    }
  ]
}
```

---

## 平台注入的环境变量

每次执行任务时，平台自动注入以下变量，脚本直接读取：

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `TASK_ID` | 任务唯一标识 | `task_abc123` |
| `EXECUTION_ID` | 本次执行记录 ID | `exec_xyz789` |
| `APP_NAME` | 所属应用名称 | `my-app` |
| `ADMIN_API_URL` | Admin API 地址 | `http://admin-api:3105` |
| `TASK_TOKEN` | 回调用临时令牌 | `eyJhbGci...` |
| `TRACE_ID` | 全链路追踪 ID | `abc123def456` |
| `TASK_PARAMS` | 任务参数 JSON 字符串 | `{"key":"value"}` |
| `AUTOFLOW_<KEY>` | 触发时传入的运行时参数 | `AUTOFLOW_DATE=2024-01-01` |

> `TASK_PARAMS` 是任务配置的默认参数；触发时额外传入的参数以 `AUTOFLOW_` 前缀注入，同名时覆盖默认值。

---

## 编写任务脚本

### Python 任务模板

```python
import os
import json
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def main() -> dict:
    """
    任务入口函数。平台调用此函数执行任务。
    - 返回 dict → 记录为执行结果（成功）
    - 抛出异常 → 执行状态置为 FAILED
    """
    # 读取上下文
    task_id      = os.environ["TASK_ID"]
    execution_id = os.environ["EXECUTION_ID"]
    trace_id     = os.environ["TRACE_ID"]
    params       = json.loads(os.environ.get("TASK_PARAMS", "{}"))

    logger.info("[%s] task=%s execution=%s", trace_id, task_id, execution_id)

    # 读取参数（支持运行时覆盖：AUTOFLOW_DATE 覆盖 params["date"]）
    date = os.environ.get("AUTOFLOW_DATE") or params.get("date", "today")
    output_format = params.get("output_format", "json")

    # ── 业务逻辑 ──────────────────────────────────
    result = do_work(date, output_format)
    # ─────────────────────────────────────────────

    logger.info("[%s] done: %s", trace_id, result)
    return {"success": True, **result}


def do_work(date: str, output_format: str) -> dict:
    # 在这里写你的业务逻辑
    return {"date": date, "format": output_format, "rows": 0}


if __name__ == "__main__":
    # 本地调试时直接运行
    print(json.dumps(main(), ensure_ascii=False))
```

### Python 进度上报（可选）

```python
import os
import requests

def report_progress(percent: int, message: str) -> None:
    """向平台上报执行进度，失败不影响主流程。"""
    url   = os.environ.get("ADMIN_API_URL", "")
    token = os.environ.get("TASK_TOKEN", "")
    eid   = os.environ.get("EXECUTION_ID", "")
    if not url or not token:
        return
    try:
        requests.post(
            f"{url}/api/executions/{eid}/progress",
            json={"percent": percent, "message": message},
            headers={"Authorization": f"Bearer {token}"},
            timeout=5,
        )
    except Exception:
        pass
```

### Node.js 任务模板

```javascript
/**
 * 任务入口。module.exports 导出的异步函数。
 * resolve 的值 → 记录为执行结果（成功）
 * reject / throw → 执行状态置为 FAILED
 */
async function main() {
  const taskId      = process.env.TASK_ID;
  const executionId = process.env.EXECUTION_ID;
  const traceId     = process.env.TRACE_ID;
  const params      = JSON.parse(process.env.TASK_PARAMS || '{}');

  console.log(`[${traceId}] task=${taskId} execution=${executionId}`);

  // 运行时参数覆盖默认参数（AUTOFLOW_URL 覆盖 params.url）
  const url     = process.env.AUTOFLOW_URL     || params.url;
  const webhook = process.env.AUTOFLOW_WEBHOOK || params.webhook;

  if (!url) throw new Error('缺少必填参数: url');

  // ── 业务逻辑 ─────────────────────────────────
  const result = await doWork(url, webhook);
  // ─────────────────────────────────────────────

  console.log(`[${traceId}] done`, result);
  return { success: true, ...result };
}

async function doWork(url, webhook) {
  // 在这里写你的业务逻辑
  return { url, fetched: 0 };
}

module.exports = main;
```

### Node.js 进度上报（可选）

```javascript
const axios = require('axios');

async function reportProgress(percent, message) {
  const url   = process.env.ADMIN_API_URL;
  const token = process.env.TASK_TOKEN;
  const eid   = process.env.EXECUTION_ID;
  if (!url || !token) return;
  try {
    await axios.post(
      `${url}/api/executions/${eid}/progress`,
      { percent, message },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
    );
  } catch (_) {
    // 进度上报失败不影响主流程
  }
}
```

---

## 错误处理规范

| 情况 | 做法 |
|------|------|
| 参数缺失/非法 | 抛 `ValueError` / `Error`，message 描述清楚缺了什么 |
| 外部服务超时 | 设合理 timeout，抛异常让平台记录失败，不要无限等待 |
| 可忽略的副作用失败 | try/catch 吞掉，用 `logger.warning` 记录，不影响主结果 |
| 进度上报失败 | 同上，吞掉，不 raise |
| 任务本身业务失败 | 返回 `{"success": false, "reason": "..."}` 或直接抛异常均可 |

> 抛出未捕获异常 → 执行状态 `FAILED`，异常信息自动出现在执行日志里。

---

## 将执行器注册到平台

### 方式 A：使用内置执行器（最简单）

把任务脚本放到对应执行器的 `tasks/` 目录，更新 `manifest.yaml`，重启执行器容器：

```bash
# 将脚本复制进容器
docker compose cp tasks/my_task.py executor-python:/app/tasks/

# 更新 manifest 后重启
docker compose restart executor-python
```

### 方式 B：部署独立执行器容器

1. 编写 `Dockerfile`：

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
# 执行器进程由平台侧的 executor-python 基础镜像接管，
# 这里只需保证依赖和脚本在 /app 下即可
```

2. 在 `docker-compose.yml` 加入你的执行器服务，挂载到 executor-python 同网络
3. 设置环境变量：
   - `ADMIN_API_URL=http://admin-api:3105`
   - `EXECUTOR_SECRET=<与平台一致>`

### 方式 C：在管理后台手动注册

1. 左侧菜单 → **执行器** → **新增执行器**
2. 填写名称、类型（Python/Node）、访问地址
3. 上传或粘贴 `manifest.yaml` 内容
4. 保存 → 平台自动同步任务定义

---

## 在平台创建并配置任务

### 调度方式

| 方式 | 说明 | 示例 |
|------|------|------|
| **Cron** | 定时执行 | `0 9 * * 1-5`（工作日早 9 点）|
| **手动** | 仅通过触发按钮或 API 执行 | 适合按需任务 |
| **事件** | 由外部 Webhook 触发 | 适合流水线集成 |

### 常用 Cron 表达式

```
*/5 * * * *      每 5 分钟
0 * * * *        每小时整点
0 9 * * *        每天 09:00
0 9 * * 1-5      工作日 09:00
0 0 * * 0        每周日零点
0 0 1 * *        每月 1 日零点
```

### 默认参数 vs 运行时参数

- **默认参数**：在任务配置页的「参数」栏填写，每次执行都用这组值（可被覆盖）
- **运行时参数**：触发时在弹窗里填写，以 `AUTOFLOW_<KEY>` 注入，覆盖同名默认参数

脚本里推荐的读取方式：

```python
# Python：优先读运行时参数，fallback 到默认参数
date = os.environ.get("AUTOFLOW_DATE") or params.get("date", "today")
```

```javascript
// Node.js
const date = process.env.AUTOFLOW_DATE || params.date || 'today';
```

---

## 本地调试

不需要启动整个平台，直接模拟平台环境跑脚本：

### Python

```bash
export TASK_ID=test-task
export EXECUTION_ID=test-exec-001
export TRACE_ID=trace-001
export TASK_PARAMS='{"date":"2024-01-01","output_format":"json"}'
export ADMIN_API_URL=http://localhost:3105
export TASK_TOKEN=dev-token

python tasks/daily_report.py
```

### Node.js

```bash
export TASK_ID=test-task
export EXECUTION_ID=test-exec-001
export TRACE_ID=trace-001
export TASK_PARAMS='{"url":"https://example.com"}'

node -e "require('./tasks/taskA').then(r => console.log(r)).catch(console.error)"
```

或者写一个 `.env.dev` 文件配合 `dotenv` 加载，避免每次 export。

---

## 发布上线 Checklist

- [ ] 脚本在本地用模拟环境变量跑通
- [ ] 参数读取逻辑：`AUTOFLOW_` 前缀覆盖 `TASK_PARAMS`，并有合理默认值
- [ ] 超时时间合理（`timeout` 字段 ≥ 脚本实际最长耗时 × 1.5）
- [ ] 所有外部请求都有 `timeout` 参数，不会无限阻塞
- [ ] 异常都有明确的错误信息，便于排查
- [ ] `manifest.yaml` 已更新，`entry` 路径正确
- [ ] 执行器已重启（manifest 变更后必须重启）
- [ ] 在平台手动触发一次，执行记录状态为「成功」
- [ ] Cron 表达式用「Cron 助手」验证过
- [ ] 任务已启用（状态为「运行中」）

---

## 常见问题

| 症状 | 原因 | 解决 |
|------|------|------|
| 触发后「无可用执行器」 | 执行器未在线或心跳未同步 | `docker compose ps executor-node`，等 15 秒再试 |
| 执行状态 FAILED，日志显示 KeyError | 脚本读了不存在的环境变量 | 用 `.get()` 并给默认值，或在 manifest 加 `required: true` |
| 脚本超时 | timeout 设置太小 | 调大 manifest 里的 `timeout` 字段，重启执行器 |
| 运行时参数没生效 | 没读 `AUTOFLOW_` 前缀变量 | 脚本里加 `os.environ.get("AUTOFLOW_KEY")` 的读取逻辑 |
| manifest 改了没生效 | 没重启执行器 | `docker compose restart executor-python` |
| 进度条不更新 | `TASK_TOKEN` 或 `ADMIN_API_URL` 为空 | 检查环境变量注入，进度上报失败不影响执行结果 |

---

## 参考文档

- [快速上手](./quickstart.md) — 5 分钟跑起来
- [SDK 详细参考](./sdk-guide.md) — 完整 API 和参数 Schema
- [API 参考](./api-reference.md) — 通过 HTTP API 触发任务、查询执行记录
- [部署指南](./deployment.md) — 生产环境部署
