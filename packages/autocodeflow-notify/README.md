# autocodeflow-notify

AutoCodeFlow 任务脚本的告警通知库：任务代码经 admin-api 的
`/api/notification/send` 发送告警，支持官方渠道表（PK-12）。

## 特性

- 渠道枚举与服务端对齐：`NotifyChannel`（email / dingtalk / wecom / slack /
  webhook / feishu）镜像 admin-api `notification.service.ts` 的
  `AlertChannel`，单测有枚举全集契约测试防漂移；
- 永不抛异常：`notify()` 返回 `bool`（admin-api 是否 2xx 接受），检查返回值
  即可知道告警是否真正送达；
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
