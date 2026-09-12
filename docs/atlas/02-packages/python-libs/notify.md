# autocodeflow-notify — 通知工具库

> 所属: docs/atlas/02-packages/python-libs · 最后核对: 2026-09-13 · 对应代码: packages/autocodeflow-notify

## 职责

PyPI 包 `autocodeflow-notify`（v0.1.0，Python >= 3.10）：让任务脚本**经由 admin-api 的通知通道发告警**，而不是自己直连企微/钉钉/Slack。渠道配置（Webhook 地址、SMTP 等）都沉淀在 admin-api 的通知配置里，任务代码只挑渠道、发消息——凭据不进任务环境。

依赖（pyproject.toml 核实）：仅 `httpx>=0.25.0`。

## 目录结构与关键文件

```
packages/autocodeflow-notify/
├── pyproject.toml
├── autocodeflow_notify/
│   ├── __init__.py          导出 NotifyClient / NotifyChannel；__version__ = "0.1.0"
│   └── notify.py            全部实现
└── tests/
    ├── conftest.py
    └── test_notify.py
```

## 公开 API 面（源码核实）

### NotifyChannel（str Enum）

```python
class NotifyChannel(str, Enum):
    EMAIL = "email"        # SMTP 邮件
    DINGTALK = "dingtalk"  # 钉钉
    WECOM = "wecom"        # 企业微信
    SLACK = "slack"        # Slack Webhook
    WEBHOOK = "webhook"    # 通用 Webhook（配合 webhook_url）
```

### NotifyClient

```python
NotifyClient(admin_api_url="http://localhost:3105", auth_token=None)

await client.notify(task_name, message, level="info",
                    channels=None, task_id=None, webhook_url=None) -> bool
await client.notify_failure(task_name, error, exec_id="", channels=None, webhook_url=None) -> bool
await client.notify_success(task_name, duration_ms=0, exec_id="", channels=None, webhook_url=None) -> bool
```

- 全部 POST 到 **`{base}/api/notification/send`**（N22：admin-api 路由是单数 `notification`，`NotificationConfigController @Controller("notification")`）。
- 请求体：`title = "[{LEVEL}] {task_name}"`、`content`、`level`，可选 `channels`（枚举值列表）、`taskId`、`webhookUrl`——传了 `webhookUrl` 时服务端会自动追加 webhook 渠道。
- `auth_token` 可选，存在时带 `Authorization: Bearer`。
- **永不抛异常**（返回值语义）：网络异常记 error 日志返回 False；非 2xx（401 token 无效、400 level/channels 非法…）记含状态码与 body 摘要的日志返回 False（R14：非 2xx 不再与成功不可区分）。body 摘要经 `_body_digest`（剥 HTML 标签、压空白、截 200 字符）保持日志单行有界。

### 典型用法

```python
from autocodeflow_notify import NotifyClient, NotifyChannel

client = NotifyClient(admin_api_url="http://localhost:3105", auth_token=token)
ok = await client.notify_failure(
    task_name="daily-report", error="connection refused",
    exec_id=ctx.execution_id, channels=[NotifyChannel.WECOM, NotifyChannel.EMAIL],
)
if not ok:
    ...  # 查执行器日志里 "Notification rejected by admin API" 行
```

## 与其他组件的关系

- **依赖 admin-api**：唯一的外部依赖点是 `POST /api/notification/send`；渠道真正投递（企微/钉钉/Slack Webhook、SMTP nodemailer）发生在 admin-api 通知模块，链路见 [通知链路](../../04-flows/notification-flow.md)。admin-web 可配置各渠道。
- **被依赖**：仅任务脚本；平台级的任务失败自动告警由 admin-api 通知模块直接做，本库用于任务业务逻辑里的**主动**通知（如"同步完成 N 条""余额低于阈值"）。
- 与 CLI/MCP 无交集；不在 lockstep 发布矩阵（[python-libs 总览](README.md)）。

## 常见改动场景

- **加渠道枚举**：先在 admin-api 通知模块支持新渠道值 → `NotifyChannel` 加成员 → `tests/test_notify.py` 补用例（conftest 已备 httpx mock）→ 更新 admin DTO 白名单与本篇（两端要同批改，否则 400）。
- **改失败可见性**：R14 已把非 2xx 变成 `False` + 日志；若要更强信号（如重试或 raise），属于行为变更，需同步 admin-api 侧幂等预期并在测试固化。
- **调整 payload 字段**：以 admin-api 通知发送 DTO 白名单为准（forbidNonWhitelisted 会 400），字段名保持 camelCase（如 `webhookUrl`/`taskId`）。

## 相关文档

- [python-libs 总览](README.md) · [ai](ai.md) · [db](db.md) · [http](http.md)
- [通知链路](../../04-flows/notification-flow.md) · [admin-api](../../01-apps/admin-api/README.md)
