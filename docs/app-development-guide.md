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
const name = process.env.AUTOFLOW_NAME || 'World';
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

每次执行任务时，执行器只向子进程注入任务作用域变量，避免泄露执行器密钥：

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `TASK_ID` | 任务唯一标识 | `task_abc123` |
| `TASK_NAME` | 任务名称 | `daily_report` |
| `EXECUTION_ID` | 本次执行记录 ID | `exec_xyz789` |
| `AUTOFLOW_<KEY>` | 触发时传入的运行时参数 | `AUTOFLOW_DATE=2024-01-01` |

> 任务参数会以 `AUTOFLOW_` 前缀注入环境变量；例如触发参数 `{ "date": "2024-01-01" }` 会变成 `AUTOFLOW_DATE=2024-01-01`。执行结果回调由执行器进程统一处理，任务脚本不需要也不应持有平台回调 token。

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
    task_name    = os.environ.get("TASK_NAME", "")
    execution_id = os.environ["EXECUTION_ID"]

    logger.info("task=%s name=%s execution=%s", task_id, task_name, execution_id)

    # 读取参数：触发参数以 AUTOFLOW_ 前缀注入
    date = os.environ.get("AUTOFLOW_DATE", "today")
    output_format = os.environ.get("AUTOFLOW_OUTPUT_FORMAT", "json")

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

### Python 进度记录（可选）

任务脚本的 stdout/stderr 会被执行器采集并写入执行日志。推荐用结构化日志记录进度，平台会在执行结束后保存日志：

```python
import logging

logger = logging.getLogger(__name__)

def report_progress(percent: int, message: str) -> None:
    """记录任务进度；执行结果回调由执行器统一处理。"""
    logger.info("progress=%s%% %s", percent, message)
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
  const taskName    = process.env.TASK_NAME || '';

  console.log(`task=${taskId} name=${taskName} execution=${executionId}`);

  // 触发参数以 AUTOFLOW_ 前缀注入
  const url     = process.env.AUTOFLOW_URL;
  const webhook = process.env.AUTOFLOW_WEBHOOK;

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

### Node.js 进度记录（可选）

```javascript
function reportProgress(percent, message) {
  // stdout/stderr 会被执行器采集为执行日志；执行结果回调由执行器统一处理。
  console.log(`progress=${percent}% ${message}`);
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
   - `EXECUTOR_SHARED_TOKEN=<与平台一致>`

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

- **任务参数**：在任务配置页或触发弹窗里填写
- **脚本读取**：执行器会将参数以 `AUTOFLOW_<KEY>` 注入环境变量

脚本里推荐的读取方式：

```python
# Python
date = os.environ.get("AUTOFLOW_DATE", "today")
```

```javascript
// Node.js
const date = process.env.AUTOFLOW_DATE || 'today';
```

---

## 本地调试

不需要启动整个平台，直接模拟平台环境跑脚本：

### Python

```bash
export TASK_ID=test-task
export EXECUTION_ID=test-exec-001
export TASK_NAME=daily_report
export AUTOFLOW_DATE=2024-01-01
export AUTOFLOW_OUTPUT_FORMAT=json

python tasks/daily_report.py
```

### Node.js

```bash
export TASK_ID=test-task
export EXECUTION_ID=test-exec-001
export TASK_NAME=fetch_and_notify
export AUTOFLOW_URL=https://example.com

node -e "require('./tasks/taskA').then(r => console.log(r)).catch(console.error)"
```

或者写一个 `.env.dev` 文件配合 `dotenv` 加载，避免每次 export。

---

## 发布上线 Checklist

- [ ] 脚本在本地用模拟环境变量跑通
- [ ] 参数读取逻辑：从 `AUTOFLOW_` 前缀变量读取，并有合理默认值
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
| 执行日志为空 | 脚本没有输出 stdout/stderr | 增加 `print` / `console.log` / logger 输出，执行器会采集为日志 |

---

## 参考文档

- [快速上手](./quickstart.md) — 5 分钟跑起来
- [SDK 详细参考](./sdk-guide.md) — 完整 API 和参数 Schema
- [API 参考](./api-reference.md) — 通过 HTTP API 触发任务、查询执行记录
- [部署指南](./deployment.md) — 生产环境部署
