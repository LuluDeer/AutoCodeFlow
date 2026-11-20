# AUTONOMY-STATE — 状态卡（R284 收尾交接版 · ≤50 行）

**基线**：`3db0f367`（R283）→ 本轮 **2 个提交**（`7f089625` / `4a78d3b2`，3 条认领）· **守卫链 121 段，121/121 = exit 0**
**会话**：第 284 轮 · **流水线并行 3 切片**（首次）· 任务书 `artifacts/autonomy/R284/brief.md`

## 本轮模式变了：一次并行 3 个独立切片

上一轮（R283）单个修复从开始到落地耗 2 小时，原因**不在 agent 慢**，而在主会话的集成环节：
手改 agent 写好的测试（拆坏→回退→丢版本）≈40min、为 0.1 的 `branchDensity` 试 5 种写法 ≈30min、
`STC` 行号 → prettier → TS lib → 再漂 逐层踩 ≈40min。**这三类门槛只要在派任务时写进任务书就不存在。**

本轮起：**任务书预置门槛**（`size-caps` 顶格只能重签不能硬压、`STC-*` 按行号锚定需同步、
先 `eslint --fix` 再改 STC、不要跑 `swagger:export`）→ 3 个切片并行 → 主会话只做集成。

## 本轮三条（都是「缺省把『不知道』渲染成『什么都没有』」的同族）

### ① 告警被静默规则吞掉后**零痕迹**（P1）

7 处「被静默 ⇒ 只 `logger.debug` 早退」，而 `LOG_LEVEL` **默认 info** ⇒ 默认部署下**那行 debug 不输出**。
一条没填 `durationMinutes` 的 `scope=global` 静默可**永久吞掉全部告警**，运营按「这次没失败」写复盘。

修法：审计 `notification.silenced`（含 `silence.endTime:null` = 永久生效，正是现场形态）
+ 指标 `autoflow_notification_silenced_total{level}`。
⚠️ **刻意不并入 `delivery_total` 的 result 枚举**：那四值是**扇出之后**的投递结果，
静默在**扇出之前**（零渠道零尝试）——塞 `skipped`/`failure` 都会**伪造事实**。
⚠️ **刻意不登记 `critical`**：7 写点都没有 CRITICAL 调用，登记只会造出一条永 0 假序列。
`isSilenced` 语义与签名**逐字不变**。

### ② 日志「已按保留期清理」显示成空白（P2）

日志留 30 天、执行行留 90 天 ⇒ 翻 31~90 天前的执行，日志区空 `<pre>` 而唯一文案说「切日志级别」
⇒ 用户读成「没输出/采集坏了」，**复盘写『没有证据』而真相是证据已删**。

修法：`logsPurged: boolean|null` + `logsPurgedAt`；三态 **已清理 / 真没输出 / 判不出来**。
⚠️ 读侧保留期读不到 ⇒ `null`（不猜 30），而清理 job 回落 30 ——
**删除必须猜，判断不必**，这个不对称是安全的。**未加迁移**（读侧推导）。

### ③ 常量撞名消歧（P3，纯改名）

后端 `FAILED_EXECUTION_STATUSES`（2 值）与前端**同名**常量（3 值含 `killed`）同名不同值。
前端改名 `FAILURE_REASON_BUCKET_STATUSES`；**取值未动**（含 killed 是刻意口径）。

## 验证（真实 exit，**级别如实**）

- 通知/指标 **27 套 / 535 例**；任务域 **78 套 / 1758 例**；api 全量 **495 套 / 8381 例**；
  web 全量 **344 文件 / 2772 例**；守卫链 **121/121 = 0**。
- **反证全由主会话亲验**（不采信自述）：改 audit action 名 ⇒ 3 failed/379 passed；
  去掉 purged 分支 ⇒ 前后端各 1 红。
- 两处文档欠账主会话补齐：`audit.md`（83→84 action）、`observability/README.md`（新指标行）。
  ⚠️ `check:metric-docs --update` 也能绿，但会把**基线欠账 0→1** —— 切片主动拒绝，未用。

## 未结项（如实）

- `web-flake-not-reproduced`（本轮全量未复现）· `ci-pg-race-unverified` · `release-notice-ops`：不变。
- `LOG_RETENTION_DAYS` 读侧 null vs 清理侧回落 30 的**不对称**：已写进交接，**未裁决**。

## 下轮第一步（按产品价值排序，建议只取 1 条）

1. **`executor.service.ts:8025` 执行器 7 日面板**仍 `SUM(status='failed')` 单值
   （10 timeout 时显示「失败 0」而「其他 10」）——R280 立的唯一事实源**最后一块未迁移**。
   零裁决、成本低。
2. **`backlogged` 小节统一到 D2 新口径**（仍用旧 `3+` 文案）。
3. `maxRounds` 的 `blocked` 无服务端兜底（`sop.service.ts:1018-1025` 写 blocked 且
   超时扫描只扫 `assigned|in_progress`）—— 改状态机属**破坏性**，需产品裁决。
4. **给「某字段被声明为 UI 的唯一依据」加机械守卫**（R279 教训 516 的机械化）。

## 方法学（本轮新增 525–526）

- **525** 「什么都没发生」和「有意抑制了」在日志上是同一件事，除非为后者留证 ——
  `logger.debug` + 默认 info 档 = 一个**永远不可查**的抑制动作；这类缺陷的所有单测都会绿
  （它们直接调 `isSilenced()`，根本没走到「被吞之后」）。判据必须是**可查的产物**（审计行、指标），
  而不是「函数返回了 true」。
- **526** 保留期不对称本身不是缺陷，但「被删掉」与「从来没有」必须是两句话 ——
  只有两态时，用户必然把「已删」读成「没有」，而那是**不可自愈的误判**。