# autocodeflow-notify

AutoCodeFlow 任务脚本的告警通知库：任务代码经 admin-api 的
`/api/notification/send` 发送告警，支持官方渠道表（PK-12）。

## 特性

- 渠道枚举与服务端对齐：`NotifyChannel`（email / dingtalk / wecom / slack /
  webhook / feishu）镜像 admin-api `notification.service.ts` 的
  `AlertChannel`，单测有枚举全集契约测试防漂移；
- 投递不抛异常：`notify()` 返回 `bool`（admin-api 是否 2xx 接受），检查返回值
  即可知道告警是否真正送达；"为什么没送到"从 `client.last_error`（最近一次传输
  失败的原始异常对象）与 `client.last_status_code`（最近一次响应状态码）读出，
  传输失败的 traceback 同时进日志；
- 参数错误响亮失败（R134-A1）：`channels` 接受 `NotifyChannel` 或等价字符串
  （`"email"`），拼错的渠道名在**任何 I/O 之前**抛 `ValueError` 并列出合法值——
  渠道名拼错是调用方 bug，静默返回 `False` 只会把排障引向网络层；
- 连接池复用：实例级懒初始化 `httpx.AsyncClient` + `trust_env=False`
  （通知出站与回调/HTTP 客户端同一「不走代理」策略，NETOPT-C P3）；
- 按次 webhook：`webhook_url` 参数服务端会自动补 webhook 渠道。

## 安装

```bash
pip install autocodeflow-notify
# 或作为任务依赖（AutoCodeFlow 任务 requirements 字段）：
#   requirements: ["autocodeflow-notify"]
```

## 最小示例

```python
from autocodeflow_notify import NotifyChannel, NotifyClient

async def run():
    async with NotifyClient(admin_api_url="http://localhost:3105") as client:
        ok = await client.notify(
            task_name="daily-report",
            message="Report generation completed",
            level="info",
            channels=[NotifyChannel.WECOM],
        )
        if not ok:
            print("alert not delivered")
```

失败告警（带任务 id，便于中台聚合）：

```python
ok = await client.notify(
    task_name="daily-report",
    message=f"task failed: {error}",
    level="error",
    task_id=task_id,
    webhook_url="https://hooks.example.com/xyz",  # 可选
)
```

## 开发

```bash
pip install -e ".[dev]"
pytest
```
