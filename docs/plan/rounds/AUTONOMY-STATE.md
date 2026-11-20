# AUTONOMY-STATE — 状态卡（R286 收尾交接版 · ≤50 行）

**基线**：`7b4e5999`（R284）→ 本轮 **2 个提交**（`f5e8a434` / `0d6a17eb`，4 条认领）· **守卫链 121 段，121/121 = exit 0**
**会话**：第 286 轮 · **流水线：agent 之间直连对话**（首次真跑通）· 任务书 `artifacts/autonomy/R286/brief.md`

## 本轮最重要的变化：**agent 之间直接对话，主会话不居中转述**

`be-assignment-reaper` ↔ `fe-assignment-lag` 用 `send_message` **直连 5–6 轮**，产生 **3 处真实修订**：

1. `round:null` 的语义从「不是轮次制」改为「**未知或无**」，并明确它是**触顶那轮**
   （maxRounds=5 ⇒ 6）—— 这直接决定前端显示「第 N 轮」还是「第 — 轮」。
2. `hours` 被澄清为**查询窗口**而**不是单行阻塞时长** —— 前端差点用它算「已阻塞 X 小时」。
3. **B 发现 A 的反证有洞**：`total ?? 0` 只红 1 条，因为页面层用例 **mock 掉了 loader**、
   `total:null` 是手写进 state 的 ⇒ **绕过了被测代码**。B 补端到端用例；
   **A 据此改了自己的代码**（加装配层真 controller 用例），使同一反证 **1 红 → 2 红**。

## 两条交付

### ① `maxRounds` 触顶的工单永远停在 blocked（P1）

`:1015-1026` 写 `blocked`，而超时扫描 `:1544-1546` **只取** `assigned|in_progress`
⇒ **blocked 被整体豁免**（另一条升级路径 `:1745-1752` 是 blocked→in_progress，那条有兜底）。
**不改状态机**（改回去会让「等人工」信号消失），只补只读可见面
`GET /sop/assignments/lagging?hours=N` + 收件箱第十节 `sopBlocked`。

### ② 推翻「这里该迁移」的错误前提 + 纠正一份**陷阱清单**（P3）

`executor.service.ts:8049` 的 `SUM(status='failed')` **本来就是对的**（同一 SQL 已并列
`timedOut`，前端渲染四格）；并入 `FAILED_EXECUTION_STATUSES` 会让超时**重复计数**、
且「脚本失败」那格再无真值 ⇒ **零行为改动，只补注释**。

⚠️ 更值钱的是：`task-execution.entity.ts` 的「待迁移清单」4 条**全部已过期**
（R283/R285/R281/R284 各修一条）。**它现在是个陷阱** —— 下一个人照它改会把
**正确实现改错**。已逐条改为 ✅ 完成态，并补语义边界：
「本常量回答『哪些 status 等于失败』，**不**回答『某面板某一格该显示什么』」。

## 验证（真实 exit，**级别如实**）

- SOP 域 **21 套 / 334 例**（含**真 PG 集成 19 条断言**：`updatedAt <= :cutoff` 真跑通、
  `limit()` 不污染 `getCount()`、`In(...)` 无 N+1）；前端 inbox 组 **127/127**。
- 守卫链 **121/121 = 0**；`tsc`/`eslint`/`lint:i18n`（3727/3727）/`web-type-drift`（派生 24→25）/
  `size-caps`/`source-text-contracts` 全 0；生成物 i18n **1826/1826**、api-reference 227 路径一致。
- **反证**：状态改 `in_progress` ⇒ **16 红**；`total ?? 0` ⇒ 补装配层后 **2 红**。

## 未结项（如实）

- **`hours` 在 `openapi.json` 被标 `required:true`**（运行期可选）—— 全库 **36/162** 同形，
  根因是 Swagger 对 `@Query(name) x?: string` 的推断。已另派 `guard-query-required` 写分类守卫
  （不能一刀切：`exp`/`sig`/`code`/`state` 是**真必填**）。
- `web-flake-not-reproduced` · `ci-pg-race-unverified` · `release-notice-ops`：不变。
- `LAG_ROW_LIMIT=200` 为服务端常量、不暴露 `limit`；超 200 条需扩契约。

## 下轮第一步（按产品价值排序，建议只取 1 条）

1. **`hours` 等 36 处 query 参数 `required` 标注**（`guard-query-required` 已在跑）：分类守卫 +
   allowlist 带 reason，让这批成为**可见的有主欠账**。
2. `maxRounds` 的 `blocked` **自动处置**（本端点的下一步）：现在只是可见，仍需人工解除。
3. `backlogged` 之外的其它小节文案一致性复核（D2 已覆盖两处，其余未逐条核）。
4. 给「某字段被声明为 UI 的唯一依据」加机械守卫（R279 教训 516 的机械化，仍未做）。

## 方法学（本轮新增 528）

- **528「反证只红一条，先问『是不是被测代码根本没跑到』」**。B 的 `total ?? 0` 只红 1 条，
  而它本应同时打穿 loader 与页面两层 —— 原因是页面层用例 mock 掉了 loader。
  **一个只红一条的反证，可能证明的不是缺陷被覆盖，而是覆盖只停在中间层**。
  判据：改坏被测代码后，**红的那几条必须分布在不同的调用层级上**。