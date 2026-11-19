# AUTONOMY-STATE — 状态卡（R280 收尾交接版 · ≤50 行）

**基线**：`a594db7d`（R279）→ 本轮 **1 个提交**（`8c9e3510`，3 条认领）· **守卫链 121 段，121/121 = exit 0**
**会话**：第 280 轮 · **产品视角轮**（PM 立项 + 2 路侦察 + 3 个实现切片）· 任务书 `artifacts/autonomy/R280/brief.md`

## 本轮主线：补齐两处「系统做了动作，却假定人会看到」

### ① 升级到人工的 SOP 澄清：三条通道全部失效（已修）

收件箱八小节无一涉及；兜底路径 `blocked → in_progress`（`sop.service.ts:1745-1752`）
⇒ 按 blocked 筛不到；`notifyEscalation` 不传 `taskId` ⇒ 一条 `scope=global` 静默规则
无条件吞掉（外层还 fail-open）。且全仓无跨 SOP 聚合端点。
⇒ 新建 `GET /sop/clarifications/pending`（`total` 独立 `getCount()`、`truncated`/`degraded`、
查询 ≤3 无 N+1、装配缺失 503、路由在 `:id` **之前**）。

**★ 本轮最重要的一件事：我自己的裁决被真机推翻了。**
最初照搬既有终态黑名单 `['completed','failed','cancelled']`，真机上正确待办在 assignment
变 `failed` 后**从列表消失**；而执行器 `agent-host.ts:688-700` 逐字写
「运维在 Admin Web 处理后重派」并以 `failed + outcome=escalated_to_human` 上报
⇒ **`failed` 不是「结束」而是「等人接管」**。黑名单改为只留 `completed`/`cancelled`，
真机对账 2 → **3**。

### ② 同一屏两句互斥的「失败」断言（已修）

趋势曲线**含 timeout**、而「最近失败」只查 `status=FAILED` ⇒ 超时风暴时曲线涨、
卡片说「近期无失败记录」。侦察追加一层：`timeout` **分叉落两桶**
（回调 ⇒ `TIMEOUT`；sweep ⇒ `FAILED`+`failureReason`）⇒ 只数 FAILED 的桶也不纯。
⇒ 实体立唯一事实源 `FAILED_EXECUTION_STATUSES=[FAILED,TIMEOUT]`，
注释列出其余未迁移调用点并标明哪条**已经是对的不要重改**。

## 侦察推翻的假设（写进代码注释）

`maxRounds` 路径（`sop.service.ts:1018-1025`）写 `blocked` 且**停在那儿**，
而超时扫描只扫 `status IN ('assigned','in_progress')` ⇒ 该路径**连自愈都没有**。
比我 brief 里的原判断更严重。

## 验证（真实 exit，**级别如实**）

- **真机（真实进程内集成）**：真 PG16/Redis7 + 真 admin-api + 144 迁移。
  升级澄清五状态矩阵；`limit=1` ⇒ `returned=1/total=3/truncated=true`；
  `limit=9999/abc/-5` 全 200 安全回落。失败口径造 `2 timeout+1 failed+1 killed+1 cancelled`
  ⇒ `/metrics/failures` 返回 3（**killed/cancelled 正确排除**）、`summary.failed=3`（修复前 1）。
  **探针数据已全部清理**。
- 后端 **495 套 / 8349 例** 绿；前端全量 **340 文件 / 2720 例** 绿；守卫链 **121/121 = 0**。
- 生成物：i18n **1810/1810**；新 DTO 改为**合同派生**（手写 126 不变、派生 22 → 23）；
  `check:response-schema` 250/263（棘轮 `--update`，覆盖率上升）。
- **反证**：失败口径改回 `status=FAILED` ⇒ 3 例红；成功率卡再改回 ⇒ 4 例红。

## 未结项（如实）

- `web-flake-not-reproduced`（本轮全量 web 一次即绿，无新增观测）· `ci-pg-race-unverified` ·
  `release-notice-ops`：不变。
- 生产包浏览器 E2E 未跑（前端证据级 = 单测/内存替身 + 静态守卫）。

## 下轮第一步（按产品价值排序，建议只取 1 条）

1. **其余 4 处失败口径未迁移**（已在常量注释登记）：`projects.service.ts:444-445`、
   `failure-reason-aggregate.ts:24`（多含 `KILLED`）、`executor.service.ts:8025`、
   `execution-read.collaborator.ts:551` 深链等值过滤（**点进去列表为空**是最挫败形态）。
   建议**先做深链**：它直接决定「从失败卡片点进去能不能看到那条记录」。
2. **「同一屏 4 个失败数字」的完整统一**（本轮只钉了 metrics 三处）。
3. `maxRounds` 的 `blocked` 无兜底 → 升级后要么同 B 路解除、要么让扫描按 TTL 判 stalled。
   **需产品裁决**（改状态机属破坏性）。
4. `backlogged` 小节统一到 D2 新口径（仍用旧 `3+` 文案）。

## 方法学（本轮新增 517–518）

- **517** 照搬既有定义前，先问那个定义在**这个语境**里指什么 —— `failed` 在 SOP 语境里
  不是「工单结束」而是「谁在等谁」。照搬让错误实现看起来毫无破绽（单测全绿、注释还引了
  「判据来源」），**只有真机造一条数据才暴露**。
- **518** 同一个语义落两个字段值，是「只数某一个值」这类统计的隐形毒药 ——
  `timeout` 分叉落 `TIMEOUT` 与 `FAILED+failureReason` ⇒ 按 `status` 单值过滤的统计
  都不完整且**看上去完全正常**。解法不是逐个修查询，而是先立唯一事实源。