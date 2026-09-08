# 教程 01 · 第一个定时任务

> 重组自 [docs/tutorials/01-first-scheduled-task.md](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/docs/tutorials/01-first-scheduled-task.md)（DOC-06）。
> 目标：从登录到看到第一个定时任务的执行结果，全程 ≤ 10 分钟。

## 0. 三个核心概念

| 概念 | 是什么 | 在哪看 |
|------|--------|--------|
| **应用** | 任务的分组容器，按业务线/项目划分 | 左侧菜单「应用」 |
| **任务** | 一段会被调度的脚本 + 触发策略 + 重试/超时策略 | 左侧菜单「任务」 |
| **执行器** | 真正运行脚本的工作进程（node/python runtime） | 左侧菜单「执行器」 |

任务创建后由平台调度器按触发策略入队，空闲执行器领取并执行，日志实时回传，
结果落库为**执行记录**。

## 1. 登录

浏览器打开 **http://localhost**：用户名 `admin`，密码为 `.env` 中
`INITIAL_ADMIN_PASSWORD` 的值（默认 `Admin@123456`）。登录后先改密码。

## 2. 建应用

左侧菜单 → **「应用」** → **「新建应用」**，名称填 `demo` → 确认。

## 3. 建任务（两种方式）

### 方式 A：从模板一键创建（推荐，CORE-03）

平台内置 5 个官方任务模板（定时备份 / 健康巡检 / 数据同步 / 日志清理 /
Webhook 探活，与 MCP 侧模板同口径）：

1. 任务列表页点 **「模板」** 按钮
2. 选一个官方模板（如 `scheduled_backup`）→ **「使用此模板」**
3. 表单已预填模板 config，**只需补任务名称**、确认所属应用 → 提交

### 方式 B：从空白表单创建

| 字段 | 填什么 | 说明 |
|------|--------|------|
| 任务名称 | `my-first-cron` | 任意 |
| 所属应用 | `demo` | 刚创建的应用 |
| 调度方式 | `Cron` | 另有 fixed_rate / api / manual |
| Cron 表达式 | `*/5 * * * *` | 每 5 分钟；「Cron 助手」可视化选择 |
| 脚本类型 | `JavaScript` | 对应 node 执行器 |

脚本编辑器输入：

```javascript
const msg = `Hello from AutoCodeFlow! Time: ${new Date().toISOString()}`;
console.log(msg);
return { message: msg, success: true };
```

建议顺手配两条生产习惯用的策略字段（可跳过）：`超时`（超时后执行器杀进程树，
`timeoutAction=kill` 缺省）与 `runbook`（Markdown 排障步骤，FEAT-11）。

点 **「保存并启用」**。

## 4. 手动触发一次（不等调度）

1. 任务详情页 → **「立即执行」**（`POST /api/tasks/:id/trigger`）
2. **「执行记录」** → 最新一条 → 看实时日志

预期：状态绿色 `成功`，日志含 `Hello from AutoCodeFlow!`。等满 5 分钟，
出现第二条 cron 调度的执行——「定时」也验证完毕。

## 5. 看懂执行详情

| 区块 | 内容 |
|------|------|
| 状态/时长 | 成功、失败、超时（TIMEOUT）等终态与耗时 |
| 执行日志 | stdout/stderr 实时流；失败时含错误摘要 |
| 重试链路（CORE-02） | Attempt #N of M 与下次重试时刻 |
| traceId（OBS-01） | 开启 OTEL 后到 Jaeger 查全链路 |

## 6. 失败了怎么办

| 现象 | 排查 |
|------|------|
| 「无可用执行器」 | 执行器页看在线状态；心跳同步约 10-15 秒 |
| 报模块找不到 | 有第三方依赖 → [教程 02](./tutorial-02-private-registry-deps) |
| 一直「运行中」 | 检查是否配了 `timeout` |

## 7. 下一步

[教程 02 · 私服依赖](./tutorial-02-private-registry-deps)。
