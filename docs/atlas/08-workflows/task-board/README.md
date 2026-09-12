# 任务分配规范（task-board）

> 所属: docs/atlas/08-workflows/task-board · 最后核对: 2026-09-13 · 对应代码: docs/PLAN-CLAIMS.md、AGENT_HANDOFF.md、scripts/check-migrations.mjs

## 一、认领事实源：docs/PLAN-CLAIMS.md

`docs/PLAN-CLAIMS.md` 是多会话并行开发**唯一的认领事实源**。其文件头规则原文要点（以板为准）：

1. **认领**：状态改 `claimed` + 填 Owner（会话唯一名，如 `main-A`）+ 时间 + **文件足迹**（预计要改的文件，供他人避让）。
2. **状态机**：`claimed → in_progress` 开工；完成 `done` + commit hash；放弃/移交改 `unclaimed` 并清空 Owner（备注留交接说明）。
3. **同一时刻一个任务只允许一个 Owner**；文件足迹重叠的任务不要同时开工。
4. **开工前必跑** `git pull --rebase`（工作区干净时）+ `git status` 盘点他人未提交改动——**未提交改动归其作者会话，勿动勿提交**。
5. 会话结束：done 任务在 `AGENT_HANDOFF.md`「状态快照」记一笔，并提交板的最终状态。

**状态字典**：`unclaimed`（待认领）/ `claimed`（已认领排队）/ `in_progress`（进行中）/ `done` / `blocked`（备注写原因）。另有特殊态 `documented/blocked`（如 ARCH-31：盘点/文档完成但实现与验证未完，勿标 done）。

**找任务**：优先看板上 `unclaimed` 行（当前快照见 [../troubleshooting/known-issues.md](../troubleshooting/known-issues.md)）；H2 新任务段（`P0-*`/`FEAT-13+`/`NF-*`/`ARCH-28+`…）详情在 `docs/DEVELOPMENT-PLAN-2026-09H2.md` §10。

## 二、用 atlas 文档树当分工边界

文档树按目录即按"地盘"拆解，**按 `01-apps/`、`02-packages/` 子目录领任务**天然防撞车：

| 想领的方向 | 先读的边界文档 | 典型足迹 |
|---|---|---|
| 后端某模块 | [../../01-apps/admin-api/modules/<模块>.md](../../01-apps/admin-api/) | `apps/admin-api/src/modules/<模块>/**` |
| 前端某页/某面 | [../../01-apps/admin-web/README.md](../../01-apps/admin-web/README.md) | `apps/admin-web/src/pages/**`、`src/api/**` |
| 某个执行器 | [../../01-apps/executors-comparison.md](../../01-apps/executors-comparison.md) | `apps/executor-node/**` 或 `executor-python` / `executor-desktop` |
| 某个可复用包 | [../../02-packages/README.md](../../02-packages/README.md) | `packages/<包>/**`（双 SDK 注意对称足迹，见 [../add-new-sdk-capability.md](../add-new-sdk-capability.md)） |
| 数据层/迁移 | [../../03-data/migrations.md](../../03-data/migrations.md) | 迁移时间戳先登记再建文件（见下） |

文件足迹写到"目录级 + 关键文件名"即可（板上真实示例：`admin-api task 实体/DTO/service + admin-web 表单/详情 + docs/api-reference.md`）。**共享热点文件**（`app.module.ts`、`task.service.ts`、`docs/api-reference.md`、认领板本身）历史上有"小 Edit 避让"惯例：独占新模块/新文件，热点文件只做最小改动并在认领行声明。

## 三、AI 子代理接任务的姿势

1. **先读卡再读码**：从任务卡（[TEMPLATE.md](TEMPLATE.md)）取"涉及文档"链接，按链接先读 atlas 对应篇目——卡上每个链接都指向真实存在的树内文件。
2. **板规则全文过一遍**：`docs/PLAN-CLAIMS.md` 文件头 5 条 + 状态字典（本文件第一节）。
3. **git 卫生**：开工前 `git pull --rebase` + `git status`；他人未提交改动不碰、不 stash 覆盖（板上记录过 stash 事故教训，见 FEAT-20 行）。
4. **迁移要占号**：涉及迁移先在 `docs/PLAN-CLAIMS.md`「迁移时间戳分配表」登记（规则 = 在盘最大 +1），CI `check-migrations` job 会拦截撞号/漏登（`scripts/check-migrations.mjs` + selftest）。
5. **收尾三件套**：测试只增不减跑全绿 → 板上更新状态 + commit hash → `AGENT_HANDOFF.md` 状态快照记一笔。
6. **如实缩水**：做不完的部分在认领行备注里如实声明"剩余 XXX"（板上的既定文风，参见 BUG-19 行），不要标 done 留暗坑。

## 四、一次完整认领的示范动线

以"给后端加一个新端点"为例（各步的板上行号会漂移，认时间戳与任务名）：

1. `git pull --rebase` → `git status` 盘点在途改动；
2. 在 `docs/PLAN-CLAIMS.md` 找到目标行（或按 `docs/DEVELOPMENT-PLAN-2026-09H2.md` §10 的新任务详情开行），状态改 `claimed`，填 Owner/时间/文件足迹；
3. 按卡（[TEMPLATE.md](TEMPLATE.md)）"涉及文档"链接读完再动第一行代码；
4. 涉及迁移 → 分配表先占号（本节第 4 条）；涉及 API → 记得 openapi/types 重导出与 `docs/api-reference.md` 同批（PR 模板「API 变更？」四查，见 `.github/PULL_REQUEST_TEMPLATE.md`）；
5. 测试全绿 → commit（中文 conventional commits，一任务一提交）→ 板行 `done` + commit hash → `AGENT_HANDOFF.md` 快照；
6. 若中途放弃：板行退回 `unclaimed`、清空 Owner、备注写清交接说明（已完成的半成品写明"重放点"）。

## 五、常见违反与代价（板上有真实前科）

| 违反 | 典型代价（板上记录） |
|---|---|
| 不查板直接开工，足迹与他人重叠 | 需 stash 隔离/重放，FEAT-20 行记录过 stash 事故：tracked 改动一度出工作区 |
| 测试"mock 通过"就标 done | CORE-01 协作注记：数字 priority 直写 PG enum 致 e2e 500，事后补 transformer + spec——"mock 不等于能跑"在板上被点名四次 |
| 清单型任务不全量盘点就标 done | UI-16 首轮只覆盖 2 页，后补五批共 13 页（UI-16-B 行） |
| 迁移不登记分配表就建文件 | CI `check-migrations` 红；撞号后要重排时间戳 |

## 相关文档

- [TEMPLATE.md](TEMPLATE.md)（任务卡模板）
- [../troubleshooting/known-issues.md](../troubleshooting/known-issues.md)（当前遗留快照）
- [../add-new-api-module.md](../add-new-api-module.md) / [../add-new-web-page.md](../add-new-web-page.md)（两大最常见任务类型的操作手册）
- 仓库根 `docs/DEVELOPMENT-PLAN-2026-09H2.md`、`docs/feature-dev-workflow.md`、`AGENT_HANDOFF.md`
