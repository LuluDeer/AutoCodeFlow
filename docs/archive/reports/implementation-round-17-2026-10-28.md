# 实施轮 #17（2026-10-28）：三条「数据被摘出缓冲后又被取消 / 又被回传」的静默丢失

> 本轮继续收口审计清单：F3（MCP 脱敏哨兵回传污染）、G2（尾部日志分片）、
> G3（停机回调批次）。三条的共性是**数据已经离开"安全位置"（缓冲/内存队列）
> 但还没落到"安全位置"（网络/磁盘）时被打断或原样回传**，而现场没有任何错误。

## 1. 修了什么

### 1.1 MCP：写面拒绝「脱敏哨兵回传」（F3）

读路径把敏感值写成 `[redacted]`（`redact.ts`），而 agent 的典型工作流是
「`get_task` 读到参数 → 改一个字段 → `update_task` 把参数原样带回」。后端对
`params` **没有任何掩码语义**（只有 `secrets` 的叶子 `******` 表示"保留原值"）：

- `params.API_KEY = "[redacted]"` 会被当成真实值写进 `tasks.params`，下次执行拿
  字面量 `[redacted]` 去认证——失败原因与真实配置毫无关系；
- `secrets` 更糟：`[redacted]` 不是保留哨兵，PATCH 会**覆盖**真实密钥且不可逆。

修法：`findRedactionSentinel`（有界递归、返回首个命中路径）+ 写面守卫
`rejectRedactionSentinel`；`update_task` / `update_application` 发请求前检查整个
body，命中即 `isError:true` + `REDACTION_SENTINEL_IN_PAYLOAD` + 命中路径 + 可执行
下一步；`secrets` 的 `******` 放行（那是后端的"保留"约定，有用例钉住区别）。

### 1.2 executor-python：`flush()` 取消正在发网络的定时 flush → 尾部日志丢失（G2）

`_flush_now()` 在锁内把 `self.chunks` **整体摘走**并清空缓冲，随后逐片
`await _push_chunk(...)`（每片 timeout 5s）。任务结束时的 `flush()` 会
`timer.cancel()` 掉**正在跑这一步**的定时任务 → CancelledError 落在 await 上，
剩余分片随协程销毁；`flush()` 紧接着自己调 `_flush_now()` 看到缓冲已空直接返回。
实测：250 行 / 3 片，取消后**发出 0 行**，且**没有任何丢行 marker**
（`_first_dropped_line` 只覆盖背压丢行）。

修法：CancelledError 时把未发出的分片塞回 `self.chunks` 队首并恢复字节记账，交给
调用方那次 `_flush_now()` 继续发。

### 1.3 executor-python：停机排水超时取消 → 已出队的回调批次不落盘（G3）

`stop_callback_retry_task()` 用 `wait_for(_flush_live_callbacks(), 10s)` 排水，而单批
重试预算是「3 次 × 10s + 退避」——admin 慢/不可达时**必然**超时取消。而
`_flush_live_callbacks` 先把批次 `_drain_live_callback_queue()` 摘走再 await：取消后
这批既没发出也没落盘；同批 N 条终态里只有发起者自己那条由 `_run_and_callback` 的
CancelledError 守卫单独持久化，其余全丢（admin 侧留 RUNNING 到 stale sweep）。

修法：CancelledError 里先 `_persist_failed_callback(batch, url)` 落盘再抛，由既有磁盘
replay 循环接手。

### 1.4 webhook 状态读取失败被当成「未启用」→ 误点即轮换密钥（E4）

`loadWebhookStatus` 旧实现 `.catch(() => setWebhookStatus(null))`：读取失败与
「确实未启用」落到同一个 null。于是**已启用**的任务在 GET 失败时显示「未启用 +
启用按钮」，而后端对已启用任务再次 `POST /webhook/enable` 会**轮换密钥**
（task.controller.ts:980）——误点一次，外部集成方带签名的调用全部 401，UI 全程
没有任何提示。

修法：webhook 状态做成三态（已启用 / 未启用 / **未知**）。未知时 tag 显示
「状态未知」、卡片给出「读取失败」+ 原因 + 重试按钮，并**不渲染启用按钮**，
从 UI 上消除误轮换路径。

### 1.5 部署页 loading 被 3s 轮询抢走序号 → 表格永久转圈（E2）

`fetchAll` 与轮询 `fetchDeployments` 共用 `fetchSeq`，而 fetchAll 只在
`seq === fetchSeq.current` 时才收 loading。于是「翻页请求在飞行中，一次轮询拍
自增了序号」→ 翻页请求的 finally 被判过期 → loading 永真：表格一直转圈、行变灰
不可交互，直到用户再翻页（慢网下请求 ≥3s 几乎必现）。

修法：loading 用独立的 `loadingSeq`（只有 fetchAll 递增），数据写入仍共用
`fetchSeq`。

## 2. 反证（都实测改回旧行为会红）

| 修复 | 反证动作 | 结果 |
|---|---|---|
MCP 哨兵守卫 | 删掉两处 `rejectRedactionSentinel` 调用 | 3 条红（会真的把哨兵写进 params/secrets/env） |
日志分片 | 取消分支改回「直接 raise」 | 日志用例红：只发出 **0/250** 行 |
回调批次 | 取消分支改回「直接 raise」 | 回调用例红：`callbacks/` 下 **0 个文件** |

## 3. 验证矩阵

- `packages/mcp-server`：**8 files / 321 tests**（新增 5 例，仍全部走
  `z.object(shape).parse` 再进 handler）
- `apps/executor-python`：pytest 全绿，覆盖率 **87.52%**（门槛 86%，新增 3 例）
- `apps/admin-web`：**253 files / 2114 tests**（新增 3 例）+ `tsc -b` 0 错；
  i18n key-check 静态键 2803 / zh-en 各 3139 一致
- `packages/mcp-server` `tsc --noEmit` 0 错；`check-docs` 全绿

## 4. 仍开着（下一轮）

- **E1（P1）** 部署页把「当前页 20 行」当全量：升级覆盖面低报（弹窗说 20 台、实际
  50 台）、第 21 台起占用校验失效、翻到全 failed 页时「升级所有」按钮消失。**需要
  后端「本应用覆盖统计」端点或前端全量拉取**，四处派生量必须同源。
- **E3（P2）** SSE 换票失败走共享 axios 拦截器 → 每 3–30s 一条错误 toast，永不停止。
- **E5（P3）** 「最近 1/24 小时」预设渲染期求值，挂机后查的是旧窗口。
- **G1 余项**：`_shutting_down` 已接上，但 `/health` 仍不返回该状态（运维看不到
  "正在排水"）；`G4` config reload 部分生效。
